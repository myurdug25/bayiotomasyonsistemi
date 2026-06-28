<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Order\CreateOrderRequest;
use App\Http\Requests\Order\ListOrdersRequest;
use App\Http\Requests\Warehouse\UpdateWarehouseOrderItemRequest;
use App\Http\Resources\Order\OrderListItemResource;
use App\Models\Cart;
use App\Models\Customer;
use App\Models\IntegrationSyncState;
use App\Models\LedgerEntry;
use App\Models\Order;
use App\Models\OrderItem;
use App\Models\OrderStatusHistory;
use App\Models\StockSummary;
use App\Models\User;
use App\Services\Customers\CustomerAccessScopeService;
use App\Services\Integrations\IntegrationSyncStateService;
use App\Services\Ledger\LedgerWriter;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\Response;

class OrderController extends Controller
{
    public function index(ListOrdersRequest $request, CustomerAccessScopeService $customerAccessScope): JsonResponse
    {
        $user = $request->user();
        $this->ensureOrderRole($user);

        $validated = $request->validated();
        $limit = min((int) ($validated['limit'] ?? 25), 50);
        $q = trim((string) ($validated['q'] ?? ''));
        $statuses = is_array($validated['statuses'] ?? null) ? $validated['statuses'] : [];

        $query = Order::query()
            ->select([
                'id',
                'order_no',
                'dealer_id',
                'customer_id',
                'status',
                'currency',
                'subtotal',
                'discount_total',
                'tax_total',
                'grand_total',
                'ordered_at',
                'approved_at',
                'created_at',
            ])
            ->with([
                'customer:id,code,name',
                'latestStatusHistory',
                'latestStatusHistory.changedBy:id,name',
            ])
            ->withCount('items')
            ->withCount('statusHistory as status_timeline_count')
            ->withSum('items as total_quantity', 'quantity')
            ->withSum('items as shipped_quantity', 'shipped_qty');

        if (! $user->hasRole('admin')) {
            if ($user->dealer_id === null) {
                abort(Response::HTTP_FORBIDDEN, 'User has no dealer scope.');
            }

            $query->where('dealer_id', (int) $user->dealer_id);
        } elseif (! empty($validated['dealer_id'])) {
            $query->where('dealer_id', (int) $validated['dealer_id']);
        }

        $customerAccessScope->applyToCustomerOwnedQuery($query, $user, 'customer_id');

        if (! empty($validated['customer_id'])) {
            $query->where('customer_id', (int) $validated['customer_id']);
        }

        if (! empty($validated['date'])) {
            $query->whereDate('ordered_at', (string) $validated['date']);
        } else {
            if (! empty($validated['date_from'])) {
                $query->whereDate('ordered_at', '>=', (string) $validated['date_from']);
            }

            if (! empty($validated['date_to'])) {
                $query->whereDate('ordered_at', '<=', (string) $validated['date_to']);
            }
        }

        if ($statuses !== []) {
            $query->whereIn('status', $statuses);
        }

        if ($q !== '') {
            $query->where(function (Builder $builder) use ($q): void {
                $builder->where('order_no', 'ilike', "%{$q}%")
                    ->orWhereHas('customer', function (Builder $customerQuery) use ($q): void {
                        $customerQuery
                            ->where('code', 'ilike', "{$q}%")
                            ->orWhere('name', 'ilike', "%{$q}%");
                    });
            });
        }

        $orders = $query
            ->orderByDesc('ordered_at')
            ->orderByDesc('id')
            ->cursorPaginate(
                perPage: $limit,
                columns: ['*'],
                cursorName: 'cursor',
                cursor: $validated['cursor'] ?? null
            );

        $rows = collect($orders->items())
            ->map(fn (Order $order) => (new OrderListItemResource($order))->toArray($request))
            ->values();

        return response()->json([
            'data' => $rows,
            'next_cursor' => $orders->nextCursor()?->encode(),
            'prev_cursor' => $orders->previousCursor()?->encode(),
            'limit' => $limit,
            'summary' => $this->buildOrderListSummary($rows),
        ]);
    }

    public function show(Order $order): JsonResponse
    {
        $user = request()->user();
        $this->ensureCanViewOrderDetail($user, $order);

        $order->loadMissing([
            'dealer',
            'customer.salesperson:id,name',
            'cart:id,shipping_method,note,order_note',
            'ledgerEntries' => fn ($ledgerQuery) => $ledgerQuery
                ->where('type', 'invoice')
                ->orderByDesc('id')
                ->with('createdBy:id,name'),
            'user:id,name',
            'user.roles:id,slug,name',
            'items.product.brand',
            'items.product.stockSummary',
            'items.product.codeAliases',
            'statusHistory.changedBy',
        ]);

        return response()->json($this->serializeOrderDetail($order));
    }

    public function updateWarehouseItem(UpdateWarehouseOrderItemRequest $request, Order $order, OrderItem $item): JsonResponse
    {
        $user = $request->user();
        $this->ensureCanViewOrderDetail($user, $order);

        if ((int) $item->order_id !== (int) $order->id) {
            abort(Response::HTTP_NOT_FOUND);
        }

        $quantity = (int) $request->integer('quantity');

        $updatedOrder = DB::transaction(function () use ($order, $item, $quantity): Order {
            /** @var Order $lockedOrder */
            $lockedOrder = Order::query()
                ->with(['items', 'ledgerEntries'])
                ->lockForUpdate()
                ->findOrFail($order->id);

            if (! in_array($lockedOrder->status, ['approved', 'picking', 'packed'], true)) {
                throw ValidationException::withMessages([
                    'order' => ['Bu durumdaki siparis depoda duzenlenemez.'],
                ]);
            }

            /** @var OrderItem $lockedItem */
            $lockedItem = OrderItem::query()
                ->where('order_id', $lockedOrder->id)
                ->lockForUpdate()
                ->findOrFail($item->id);

            $oldQuantity = (int) $lockedItem->quantity;
            if ($quantity === $oldQuantity) {
                return $this->freshOrderDetailModel($lockedOrder);
            }

            $pickedQuantity = (int) DB::table('shipment_items')
                ->join('shipments', 'shipments.id', '=', 'shipment_items.shipment_id')
                ->where('shipment_items.order_item_id', $lockedItem->id)
                ->whereNotIn('shipments.status', ['cancelled'])
                ->sum('shipment_items.shipped_qty');

            $shippedQuantity = max((int) $lockedItem->shipped_qty, $pickedQuantity);
            if ($quantity < $shippedQuantity) {
                throw ValidationException::withMessages([
                    'quantity' => ["Yeni adet sevk/okutma miktarinin altina dusmez. Minimum {$shippedQuantity}."],
                ]);
            }

            $delta = $quantity - $oldQuantity;
            $stock = StockSummary::query()
                ->where('product_id', $lockedItem->product_id)
                ->lockForUpdate()
                ->first();

            if ($delta > 0) {
                if (! $stock instanceof StockSummary || (int) $stock->available_total < $delta) {
                    throw ValidationException::withMessages([
                        'quantity' => ['Bu artış için yeterli stok yok.'],
                    ]);
                }

                $stock->available_total = (int) $stock->available_total - $delta;
                $stock->reserved_total = (int) $stock->reserved_total + $delta;
                $stock->updated_at = now();
                $stock->save();
            } elseif ($delta < 0 && $stock instanceof StockSummary) {
                $releasedQuantity = abs($delta);
                $stock->available_total = (int) $stock->available_total + $releasedQuantity;
                $stock->reserved_total = max(0, (int) $stock->reserved_total - $releasedQuantity);
                $stock->updated_at = now();
                $stock->save();
            }

            $lineUnitCents = $oldQuantity > 0
                ? (int) round($this->toCents($lockedItem->line_total) / $oldQuantity)
                : $this->toCents($lockedItem->unit_net_price);
            $lockedItem->quantity = $quantity;
            $lockedItem->line_total = $this->fromCents($lineUnitCents * $quantity);
            $lockedItem->save();

            $activeShipmentItemIds = DB::table('shipment_items')
                ->join('shipments', 'shipments.id', '=', 'shipment_items.shipment_id')
                ->where('shipment_items.order_item_id', $lockedItem->id)
                ->whereNotIn('shipments.status', ['cancelled', 'shipped', 'partially_shipped'])
                ->pluck('shipment_items.id');

            if ($activeShipmentItemIds->isNotEmpty()) {
                DB::table('shipment_items')
                    ->whereIn('id', $activeShipmentItemIds)
                    ->update(['ordered_qty' => $quantity]);
            }

            $this->recalculateOrderTotals($lockedOrder);
            $this->syncOrderInvoiceLedger($lockedOrder);

            return $this->freshOrderDetailModel($lockedOrder);
        });

        return response()->json($this->serializeOrderDetail($updatedOrder));
    }

    public function store(
        CreateOrderRequest $request,
        LedgerWriter $ledgerWriter,
        IntegrationSyncStateService $syncState
    ): JsonResponse {
        $user = $request->user();
        $this->ensureOrderRole($user);

        $validated = $request->validated();
        $dealerId = $this->resolveDealerId(
            user: $user,
            requestedDealerId: $validated['dealer_id'] ?? null,
            customerId: isset($validated['customer_id']) ? (int) $validated['customer_id'] : ($user->selected_customer_id !== null ? (int) $user->selected_customer_id : null),
            cartId: isset($validated['cart_id']) ? (int) $validated['cart_id'] : null
        );
        if ($dealerId === null) {
            return response()->json([
                'message' => 'dealer_id is required for admin users without dealer assignment.',
            ], Response::HTTP_UNPROCESSABLE_ENTITY);
        }

        $forceWarehouseTransfer = $user->hasRole('salesperson');

        $order = DB::transaction(function () use ($validated, $dealerId, $user, $ledgerWriter, $syncState, $forceWarehouseTransfer) {
            $cart = $this->resolveDraftCartForOrder($user, $dealerId, $validated);
            $cart->loadMissing('customer');
            $items = $cart->items()->with('product')->lockForUpdate()->get();

            if ($items->isEmpty()) {
                throw ValidationException::withMessages([
                    'cart' => ['Cannot create order from an empty cart.'],
                ]);
            }

            $stocks = StockSummary::query()
                ->whereIn('product_id', $items->pluck('product_id')->unique()->values())
                ->lockForUpdate()
                ->get()
                ->keyBy('product_id');

            foreach ($items as $item) {
                /** @var StockSummary $stock */
                $stock = $stocks->get($item->product_id);
                if (! $stock instanceof StockSummary) {
                    continue;
                }

                $reservedQuantity = min((int) $stock->available_total, (int) $item->quantity);
                if ($reservedQuantity <= 0) {
                    continue;
                }

                $stock->available_total -= $reservedQuantity;
                $stock->reserved_total += $reservedQuantity;
                $stock->updated_at = now();
                $stock->save();
            }

            $subtotalCents = 0;
            $discountTotalCents = 0;
            $taxTotalCents = 0;

            foreach ($items as $item) {
                $lineCents = $this->toCents($item->line_total);
                $grossCents = $this->toCents((float) $item->unit_net_price * $item->quantity);
                $taxRate = (float) ($item->vat_rate ?? $item->product?->vat_rate ?? 0);
                $taxCents = (int) round($grossCents * ($taxRate / 100));

                $subtotalCents += $lineCents;
                $discountTotalCents += max(0, $grossCents - $lineCents);
                $taxTotalCents += $taxCents;
            }

            $subtotal = $this->fromCents($subtotalCents);
            $discountTotal = $this->fromCents($discountTotalCents);
            $taxTotal = $this->fromCents($taxTotalCents);
            $grandTotal = $this->fromCents($subtotalCents + $taxTotalCents);
            $isWarehouseTransfer = $forceWarehouseTransfer || (bool) $cart->is_warehouse_transfer;
            $initialStatus = $isWarehouseTransfer ? 'approved' : 'pending';
            $orderNote = $this->resolveOrderNote($validated['note'] ?? null, $cart->order_note, $cart->note);
            $checkoutSummary = $this->isBatumCustomer($cart->customer)
                ? null
                : $this->checkoutSummaryMeta($validated['checkout_summary_mode'] ?? null);
            $timestamp = now();

            $order = Order::create([
                'order_no' => $this->generateOrderNo(),
                'dealer_id' => $cart->dealer_id,
                'customer_id' => $cart->customer_id,
                'user_id' => $user->id,
                'cart_id' => $cart->id,
                'status' => $initialStatus,
                'currency' => $cart->currency,
                'subtotal' => $subtotal,
                'discount_total' => $discountTotal,
                'tax_total' => $taxTotal,
                'grand_total' => $grandTotal,
                'ordered_at' => $timestamp,
                'approved_at' => $isWarehouseTransfer ? $timestamp : null,
                'note' => $orderNote,
            ]);

            foreach ($items as $item) {
                OrderItem::create([
                    'order_id' => $order->id,
                    'product_id' => $item->product_id,
                    'vehicle_id' => null,
                    'quantity' => $item->quantity,
                    'unit_net_price' => $item->unit_net_price,
                    'discount_rate' => $item->discount_rate,
                    'tax_rate' => $item->vat_rate ?? $item->product?->vat_rate ?? 0,
                    'line_total' => $item->line_total,
                    'currency' => $item->currency,
                ]);
            }

            OrderStatusHistory::create([
                'order_id' => $order->id,
                'status' => $initialStatus,
                'changed_by_user_id' => $user->id,
                'note' => $isWarehouseTransfer
                    ? 'Order created from draft cart and sent to warehouse queue.'
                    : 'Order created from draft cart.',
                'created_at' => $timestamp,
            ]);

            $sourcePanel = $this->resolveSourcePanel($user);

            $ledgerWriter->write([
                'dealer_id' => $order->dealer_id,
                'customer_id' => $order->customer_id,
                'order_id' => $order->id,
                'collection_id' => null,
                'date' => now()->toDateString(),
                'type' => 'invoice',
                'debit' => $order->grand_total,
                'credit' => 0,
                'currency' => $order->currency,
                'reference_no' => $order->order_no,
                'description' => 'Invoice created from order '.$order->order_no,
                'created_by_user_id' => $user->id,
                'meta' => [
                    'source' => 'order_checkout',
                    'source_label' => 'Sipariş faturası',
                    'source_panel' => $sourcePanel,
                    'source_panel_label' => $this->sourcePanelLabel($sourcePanel),
                    'warehouse_dispatch' => $isWarehouseTransfer,
                    'checkout_summary' => $checkoutSummary,
                    'order_no' => $order->order_no,
                    'cart_id' => $cart->id,
                    'shipping_method' => $cart->shipping_method,
                    'created_by' => [
                        'id' => $user->id,
                        'name' => $user->name,
                        'role_slugs' => $this->userRoleSlugs($user),
                    ],
                    'salesperson' => $user->hasRole('salesperson')
                        ? [
                            'id' => $user->id,
                            'name' => $user->name,
                        ]
                        : null,
                ],
            ]);

            $cart->status = 'ordered';
            $cart->save();

            $syncState->record(
                system: 'logo',
                domain: 'orders',
                direction: 'outbound',
                entity: $order,
                externalRef: null,
                status: 'queued',
                error: null,
                meta: [
                    'export_key' => 'B2B-ORDER-'.$order->id,
                    'order_no' => $order->order_no,
                    'status' => $order->status,
                    'source_panel' => $sourcePanel,
                ],
                payload: [
                    'order_id' => $order->id,
                    'order_no' => $order->order_no,
                    'grand_total' => $order->grand_total,
                ],
            );

            return $order->fresh([
                'dealer',
                'customer',
                'cart:id,shipping_method',
                'user:id,name',
                'items.product.brand',
                'items.product.stockSummary',
                'items.product.codeAliases',
                'statusHistory.changedBy',
            ]);
        });

        return response()->json($this->serializeOrderDetail($order), Response::HTTP_CREATED);
    }

    /**
     * @param  Collection<int, array<string, mixed>>  $rows
     * @return array<string, mixed>
     */
    private function buildOrderListSummary(Collection $rows): array
    {
        $subtotalCents = 0;
        $discountCents = 0;
        $taxCents = 0;
        $grandTotalCents = 0;
        $itemCount = 0;
        $totalQuantity = 0;
        $shippedQuantity = 0;
        $remainingQuantity = 0;
        $timelineEvents = 0;
        $latestTimelineEventAt = null;

        foreach ($rows as $row) {
            $subtotalCents += $this->toCents((string) ($row['subtotal'] ?? 0));
            $discountCents += $this->toCents((string) ($row['discount_total'] ?? 0));
            $taxCents += $this->toCents((string) ($row['tax_total'] ?? 0));
            $grandTotalCents += $this->toCents((string) ($row['grand_total'] ?? 0));
            $itemCount += (int) ($row['item_count'] ?? 0);
            $totalQuantity += (int) ($row['total_quantity'] ?? 0);
            $shippedQuantity += (int) ($row['shipped_quantity'] ?? 0);
            $remainingQuantity += (int) ($row['remaining_quantity'] ?? 0);
            $timelineEvents += (int) data_get($row, 'status_timeline_summary.total_events', 0);

            $candidateTimelineDate = data_get($row, 'status_timeline_summary.last_event.created_at');
            if (is_string($candidateTimelineDate) && $candidateTimelineDate !== '') {
                if ($latestTimelineEventAt === null || strtotime($candidateTimelineDate) > strtotime($latestTimelineEventAt)) {
                    $latestTimelineEventAt = $candidateTimelineDate;
                }
            }
        }

        $statusBreakdown = $rows
            ->groupBy('status')
            ->map(function (Collection $statusRows, string $status): array {
                $totalCents = $statusRows->sum(
                    fn (array $row) => $this->toCents((string) ($row['grand_total'] ?? 0))
                );

                return [
                    'status' => $status,
                    'order_count' => $statusRows->count(),
                    'grand_total' => $this->fromCents((int) $totalCents),
                ];
            })
            ->values()
            ->sortByDesc('order_count')
            ->values();

        return [
            'totals' => [
                'order_count' => $rows->count(),
                'currency' => (string) ($rows->first()['currency'] ?? 'TRY'),
                'subtotal' => $this->fromCents($subtotalCents),
                'discount_total' => $this->fromCents($discountCents),
                'tax_total' => $this->fromCents($taxCents),
                'grand_total' => $this->fromCents($grandTotalCents),
                'item_count' => $itemCount,
                'total_quantity' => $totalQuantity,
                'shipped_quantity' => $shippedQuantity,
                'remaining_quantity' => $remainingQuantity,
            ],
            'status_breakdown' => $statusBreakdown,
            'status_timeline_summary' => [
                'total_events' => $timelineEvents,
                'orders_with_events' => $rows->filter(
                    fn (array $row) => (int) data_get($row, 'status_timeline_summary.total_events', 0) > 0
                )->count(),
                'latest_event_at' => $latestTimelineEventAt,
            ],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function serializeOrderDetail(Order $order): array
    {
        $invoice = $this->invoiceLedgerEntry($order);
        $logoSyncState = $this->logoSyncState('orders', Order::class, (int) $order->id);
        $invoiceMeta = is_array($invoice?->meta) ? $invoice->meta : [];
        $createdByRoleSlugs = $order->user instanceof User ? $this->userRoleSlugs($order->user) : [];
        $sourcePanel = $this->nullableString(data_get($invoiceMeta, 'source_panel'))
            ?? $this->resolveSourcePanelFromRoleSlugs($createdByRoleSlugs);
        $salesperson = $this->resolveOrderSalesperson($order, $createdByRoleSlugs);

        return [
            'order' => [
                'id' => $order->id,
                'order_no' => $order->order_no,
                'status' => $order->status,
                'dealer_id' => $order->dealer_id,
                'customer_id' => $order->customer_id,
                'currency' => $order->currency,
                'subtotal' => $order->subtotal,
                'discount_total' => $order->discount_total,
                'tax_total' => $order->tax_total,
                'grand_total' => $order->grand_total,
                'ordered_at' => $order->ordered_at,
                'logo_sync_status' => $logoSyncState?->status,
                'logo_sync_error' => $logoSyncState?->last_error,
                'logo_external_ref' => $logoSyncState?->external_ref,
                'logo_last_synced_at' => $logoSyncState?->last_synced_at,
                'shipping_method' => $order->cart?->shipping_method,
                'note' => $order->note,
                'created_by' => [
                    'id' => $order->user?->id,
                    'name' => $order->user?->name,
                    'role_slugs' => $createdByRoleSlugs,
                ],
                'salesperson' => [
                    'id' => $salesperson?->id,
                    'name' => $salesperson?->name,
                ],
                'origin' => [
                    'source' => $this->nullableString(data_get($invoiceMeta, 'source')) ?? 'order_checkout',
                    'source_label' => $this->nullableString(data_get($invoiceMeta, 'source_label')) ?? 'Sipariş faturası',
                    'panel' => $sourcePanel,
                    'panel_label' => $this->nullableString(data_get($invoiceMeta, 'source_panel_label'))
                        ?? $this->sourcePanelLabel($sourcePanel),
                    'warehouse_dispatch' => (bool) (data_get($invoiceMeta, 'warehouse_dispatch') ?? true),
                    'checkout_summary' => is_array(data_get($invoiceMeta, 'checkout_summary'))
                        ? data_get($invoiceMeta, 'checkout_summary')
                        : null,
                    'shipping_method' => $order->cart?->shipping_method,
                    'note' => $order->note ?? $order->cart?->order_note ?? $order->cart?->note,
                ],
                'invoice' => [
                    'id' => $invoice?->id,
                    'reference_no' => $invoice?->reference_no ?? $order->order_no,
                    'description' => $invoice?->description,
                    'created_at' => $invoice?->created_at,
                    'created_by' => [
                        'id' => $invoice?->createdBy?->id ?? $order->user?->id,
                        'name' => $invoice?->createdBy?->name ?? $order->user?->name,
                    ],
                ],
                'customer' => [
                    'id' => $order->customer?->id,
                    'code' => $order->customer?->code,
                    'title' => $order->customer?->name,
                    'address' => data_get($order->customer?->meta, 'address'),
                    'city' => $order->customer?->city,
                    'district' => $order->customer?->district,
                    'phone' => $order->customer?->phone,
                    'tax_office' => $order->customer?->tax_office,
                    'tax_number' => $order->customer?->tax_number,
                ],
                'items' => $order->items->map(fn ($item) => [
                    'id' => $item->id,
                    'product_id' => $item->product_id,
                    'sku' => $item->product?->sku,
                    'name' => $item->product?->name,
                    'brand' => $item->product?->brand?->name,
                    'quantity' => $item->quantity,
                    'unit_net_price' => $item->unit_net_price,
                    'tax_rate' => $item->tax_rate,
                    'line_total' => $item->line_total,
                    'currency' => $item->currency,
                    'barcode' => $this->resolveProductBarcode($item),
                    'shelf_address' => $this->resolveProductLogoWarehouseShelfAddress($item, '1')
                        ?? $this->resolveProductShelfAddress($item->product?->meta),
                    'logo_stock' => [
                        'available_total' => $this->resolveProductLogoStockTotal($item),
                        'erzurum_depo_available_total' => $this->resolveProductLogoWarehouseStockTotal($item, '1'),
                        'reserved_total' => $this->resolveProductReservedStockTotal($item),
                        'updated_at' => $this->resolveProductLogoStockUpdatedAt($item),
                    ],
                ])->values(),
            ],
            'status_timeline' => $order->statusHistory->map(fn ($entry) => [
                'id' => $entry->id,
                'status' => $entry->status,
                'note' => $entry->note,
                'changed_by' => [
                    'id' => $entry->changedBy?->id,
                    'name' => $entry->changedBy?->name,
                ],
                'created_at' => $entry->created_at,
            ])->values(),
        ];
    }

    private function resolveOrderNote(mixed ...$candidates): ?string
    {
        foreach ($candidates as $candidate) {
            if (! is_scalar($candidate)) {
                continue;
            }

            $note = trim((string) $candidate);

            if ($note !== '') {
                return $note;
            }
        }

        return null;
    }

    private function resolveProductBarcode($item): ?string
    {
        $product = $item?->product;
        if (! $product) {
            return null;
        }

        $aliases = $product->codeAliases ?? null;
        if (! is_iterable($aliases)) {
            return $this->nullableString($product->sku);
        }

        $firstAlias = null;
        foreach ($aliases as $alias) {
            if (! is_object($alias)) {
                continue;
            }

            $code = $this->nullableString($alias->code ?? null);
            if ($code === null) {
                continue;
            }

            if ($firstAlias === null) {
                $firstAlias = $code;
            }

            $source = $this->nullableString(is_array($alias->meta ?? null) ? data_get($alias->meta, 'source') : null);
            if ($source === 'logo_unit_barcode') {
                return $code;
            }
        }

        return $firstAlias;
    }

    private function resolveProductShelfAddress(mixed $meta): ?string
    {
        if (! is_array($meta)) {
            return null;
        }

        $shelfAddress = $this->firstMetaScalar($meta, [
            'shelf_address',
            'raf_address',
            'raf_adresi',
            'raf_bilgisi',
            'raf_bilgileri',
            'shelf',
            'raf',
            'location',
            'location_code',
            'integrations.logo.payload.shelf_address',
            'integrations.logo.payload.shelfaddress',
            'integrations.logo.payload.shelf_addr',
            'integrations.logo.payload.raf_address',
            'integrations.logo.payload.raf_adresi',
            'integrations.logo.payload.rafadresi',
            'integrations.logo.payload.raf_bilgisi',
            'integrations.logo.payload.rafbilgisi',
            'integrations.logo.payload.raf_bilgileri',
            'integrations.logo.payload.rafbilgileri',
            'integrations.logo.payload.shelf',
            'integrations.logo.payload.raf',
            'integrations.logo.payload.location',
            'integrations.logo.payload.location_code',
            'integrations.logo.payload.raw.SHELF_ADDRESS',
            'integrations.logo.payload.raw.SHELFADDRESS',
            'integrations.logo.payload.raw.SHELF_ADDR',
            'integrations.logo.payload.raw.RAF_ADDRESS',
            'integrations.logo.payload.raw.RAF_ADRESI',
            'integrations.logo.payload.raw.RAFADRESI',
            'integrations.logo.payload.raw.RAF_BILGISI',
            'integrations.logo.payload.raw.RAFBILGISI',
            'integrations.logo.payload.raw.RAF_BILGILERI',
            'integrations.logo.payload.raw.RAFBILGILERI',
            'integrations.logo.payload.raw.SHELF',
            'integrations.logo.payload.raw.RAF',
            'integrations.logo.payload.raw.LOCATION',
            'integrations.logo.payload.raw.LOCATION_CODE',
            'integrations.logo.payload.raw.LOCATIONCODE',
        ]);

        if ($shelfAddress !== null) {
            return $shelfAddress;
        }

        $warehouses = data_get($meta, 'integrations.logo.payload.logo_stock.warehouses');
        if (is_array($warehouses)) {
            foreach ($warehouses as $warehouse) {
                if (! is_array($warehouse)) {
                    continue;
                }

                $warehouseCode = $this->firstArrayScalar($warehouse, [
                    'warehouse_code',
                    'branch_code',
                    'code',
                    'invenno',
                    'warehouse_no',
                ]);
                $warehouseShelf = $this->resolveOrderShelfAddressFromWarehouse($meta, $warehouse, $warehouseCode);
                if ($warehouseShelf !== null) {
                    return $warehouseShelf;
                }
            }
        }

        $stockLocations = data_get($meta, 'integrations.logo.payload.stock_locations');
        if (is_array($stockLocations)) {
            foreach ($stockLocations as $location) {
                if (! is_array($location)) {
                    continue;
                }

                $locationShelf = $this->firstArrayScalar($location, [
                    'shelf_address',
                    'raf_address',
                    'raf_adresi',
                    'raf_bilgisi',
                    'raf_bilgileri',
                    'shelf',
                    'raf',
                    'location',
                    'location_code',
                ]);

                if ($locationShelf !== null) {
                    return $locationShelf;
                }
            }
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $meta
     * @param  array<string, mixed>  $warehouse
     */
    private function resolveOrderShelfAddressFromWarehouse(array $meta, array $warehouse, ?string $warehouseCode = null): ?string
    {
        $direct = $this->firstMetaScalar($warehouse, [
            'shelf_address',
            'raf_address',
            'raf_adresi',
            'raf_bilgisi',
            'raf_bilgileri',
            'shelf',
            'raf',
            'location',
            'location_code',
        ]);

        if ($direct !== null) {
            return $direct;
        }

        $raw = data_get($meta, 'integrations.logo.payload.raw', []);
        if (! is_array($raw)) {
            return null;
        }

        $keys = array_filter([
            $warehouseCode,
            $warehouse['shelf_key'] ?? null,
            $warehouse['invenno'] ?? null,
            $warehouse['warehouse_no'] ?? null,
        ], static fn (mixed $value): bool => is_scalar($value) && trim((string) $value) !== '');

        foreach ($keys as $key) {
            $normalized = trim((string) $key);

            foreach ([
                "RAF{$normalized}",
                "RAF_{$normalized}",
                "raf{$normalized}",
                "raf_{$normalized}",
                "RAFADRESI{$normalized}",
                "RAF_ADRESI_{$normalized}",
                "RAF_BILGISI{$normalized}",
                "RAF_BILGISI_{$normalized}",
                "RAF_BILGILERI{$normalized}",
                "RAF_BILGILERI_{$normalized}",
                "SHELF_ADDRESS{$normalized}",
                "LOCATION{$normalized}",
                "LOCATION_CODE{$normalized}",
            ] as $field) {
                $candidate = $raw[$field] ?? null;
                if (is_scalar($candidate)) {
                    $normalizedCandidate = trim((string) $candidate);
                    if ($normalizedCandidate !== '') {
                        return $normalizedCandidate;
                    }
                }
            }
        }

        return null;
    }

    private function resolveProductLogoWarehouseShelfAddress($item, string $warehouseCode): ?string
    {
        $meta = is_array($item?->product?->meta) ? $item->product->meta : [];
        $warehouses = data_get($meta, 'integrations.logo.payload.logo_stock.warehouses');

        if (! is_array($warehouses)) {
            return null;
        }

        foreach ($warehouses as $warehouse) {
            if (! is_array($warehouse)) {
                continue;
            }

            $code = $this->firstArrayScalar($warehouse, [
                'warehouse_code',
                'branch_code',
                'code',
                'invenno',
                'warehouse_no',
            ]);

            if ($code !== $warehouseCode) {
                continue;
            }

            return $this->resolveOrderShelfAddressFromWarehouse($meta, $warehouse, $code);
        }

        return null;
    }

    private function resolveProductLogoStockTotal($item): int
    {
        $summary = $item?->product?->stockSummary;
        if ($summary !== null) {
            return (int) ($summary->available_total ?? 0);
        }

        $meta = is_array($item?->product?->meta) ? $item->product->meta : [];
        $payload = data_get($meta, 'integrations.logo.payload.logo_stock');

        if (! is_array($payload)) {
            return 0;
        }

        return $this->firstIntegerValue(
            $payload,
            ['available_total', 'available', 'stock', 'quantity', 'onhand_total', 'onhand']
        );
    }

    private function resolveProductLogoWarehouseStockTotal($item, string $warehouseCode): int
    {
        $meta = is_array($item?->product?->meta) ? $item->product->meta : [];
        $warehouses = data_get($meta, 'integrations.logo.payload.logo_stock.warehouses');

        if (! is_array($warehouses)) {
            return $this->resolveProductLogoStockTotal($item);
        }

        foreach ($warehouses as $warehouse) {
            if (! is_array($warehouse)) {
                continue;
            }

            $code = $this->firstArrayScalar($warehouse, [
                'warehouse_code',
                'branch_code',
                'code',
                'invenno',
                'warehouse_no',
            ]);

            if ($code !== $warehouseCode) {
                continue;
            }

            return $this->firstIntegerValue($warehouse, [
                'available_total',
                'available',
                'onhand_total',
                'onhand',
                'stock',
                'quantity',
            ]);
        }

        return 0;
    }

    private function resolveProductReservedStockTotal($item): int
    {
        $summary = $item?->product?->stockSummary;
        if ($summary !== null) {
            return (int) ($summary->reserved_total ?? 0);
        }

        $meta = is_array($item?->product?->meta) ? $item->product->meta : [];
        $payload = data_get($meta, 'integrations.logo.payload.logo_stock');

        if (! is_array($payload)) {
            return 0;
        }

        return $this->firstIntegerValue(
            $payload,
            ['reserved_total', 'reserved', 'stock_reserved', 'onhand_reserved']
        );
    }

    private function resolveProductLogoStockUpdatedAt($item): ?string
    {
        $summary = $item?->product?->stockSummary;
        if ($summary !== null) {
            return $summary->updated_at?->toIso8601String();
        }

        $meta = is_array($item?->product?->meta) ? $item->product->meta : [];
        $rawUpdatedAt = data_get($meta, 'integrations.logo.payload.logo_stock.updated_at');

        return is_scalar($rawUpdatedAt) ? (string) $rawUpdatedAt : null;
    }

    /**
     * @param  array<string, mixed>  $meta
     * @param  list<string>  $paths
     */
    private function firstMetaScalar(array $meta, array $paths): ?string
    {
        foreach ($paths as $path) {
            $value = data_get($meta, $path);
            if (is_scalar($value)) {
                $normalized = trim((string) $value);
                if ($normalized !== '') {
                    return $normalized;
                }
            }
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $source
     * @param  list<string>  $keys
     */
    private function firstIntegerValue(array $source, array $keys): int
    {
        foreach ($keys as $key) {
            $value = $source[$key] ?? null;
            if (is_numeric($value)) {
                return (int) $value;
            }
        }

        return 0;
    }

    /**
     * @param  array<string, mixed>  $source
     * @param  list<string>  $keys
     */
    private function firstArrayScalar(array $source, array $keys): ?string
    {
        foreach ($keys as $key) {
            $value = $source[$key] ?? null;

            if (is_scalar($value)) {
                $normalized = trim((string) $value);
                if ($normalized !== '') {
                    return $normalized;
                }
            }
        }

        return null;
    }

    private function resolveSourcePanel(User $user): string
    {
        return $this->resolveSourcePanelFromRoleSlugs($this->userRoleSlugs($user));
    }

    /**
     * @param  list<string>  $roleSlugs
     */
    private function resolveSourcePanelFromRoleSlugs(array $roleSlugs): string
    {
        if (in_array('salesperson', $roleSlugs, true)) {
            return 'salesperson';
        }

        if (in_array('point', $roleSlugs, true)) {
            return 'point';
        }

        if (in_array('dealer_admin', $roleSlugs, true)) {
            return 'dealer_admin';
        }

        if (in_array('admin', $roleSlugs, true)) {
            return 'admin';
        }

        if (in_array('warehouse', $roleSlugs, true)) {
            return 'warehouse';
        }

        return 'b2b';
    }

    private function sourcePanelLabel(string $panel): string
    {
        return match ($panel) {
            'salesperson' => 'Plasiyer Paneli',
            'point' => 'Point/Bayi Paneli',
            'dealer_admin' => 'Bayi Yönetici Paneli',
            'admin' => 'Admin Paneli',
            'warehouse' => 'Depo Paneli',
            default => 'B2B Paneli',
        };
    }

    /**
     * @return list<string>
     */
    private function userRoleSlugs(User $user): array
    {
        return $user->roles()
            ->pluck('slug')
            ->map(fn ($slug): string => (string) $slug)
            ->values()
            ->all();
    }

    private function invoiceLedgerEntry(Order $order): ?LedgerEntry
    {
        if ($order->relationLoaded('ledgerEntries')) {
            return $order->ledgerEntries
                ->first(fn (LedgerEntry $entry): bool => (string) $entry->type === 'invoice');
        }

        return LedgerEntry::query()
            ->with('createdBy:id,name')
            ->where('order_id', $order->id)
            ->where('type', 'invoice')
            ->latest('id')
            ->first();
    }

    private function recalculateOrderTotals(Order $order): void
    {
        $items = OrderItem::query()
            ->where('order_id', $order->id)
            ->get();

        $subtotalCents = 0;
        $discountTotalCents = 0;
        $taxTotalCents = 0;

        foreach ($items as $item) {
            $quantity = (int) $item->quantity;
            $lineCents = $this->toCents($item->line_total);
            $grossCents = $this->toCents((float) $item->unit_net_price * $quantity);
            $taxRate = (float) $item->tax_rate;

            $subtotalCents += $lineCents;
            $discountTotalCents += max(0, $grossCents - $lineCents);
            $taxTotalCents += (int) round($lineCents * ($taxRate / 100));
        }

        $order->subtotal = $this->fromCents($subtotalCents);
        $order->discount_total = $this->fromCents($discountTotalCents);
        $order->tax_total = $this->fromCents($taxTotalCents);
        $order->grand_total = $this->fromCents($subtotalCents + $taxTotalCents);
        $order->save();
    }

    private function syncOrderInvoiceLedger(Order $order): void
    {
        $invoice = LedgerEntry::query()
            ->where('order_id', $order->id)
            ->where('type', 'invoice')
            ->lockForUpdate()
            ->latest('id')
            ->first();

        if (! $invoice instanceof LedgerEntry) {
            return;
        }

        $oldDebitCents = $this->toCents($invoice->debit ?? $invoice->amount ?? 0);
        $newDebitCents = $this->toCents($order->grand_total);
        $deltaCents = $newDebitCents - $oldDebitCents;

        $invoice->debit = $order->grand_total;
        $invoice->amount = $order->grand_total;
        if ($invoice->balance_after !== null) {
            $invoice->balance_after = $this->fromCents($this->toCents($invoice->balance_after) + $deltaCents);
        }
        $invoice->save();

        if ($deltaCents === 0) {
            return;
        }

        $ledgerDate = $invoice->date ?? $invoice->entry_date;
        $followingEntries = LedgerEntry::query()
            ->where('customer_id', $invoice->customer_id)
            ->where('id', '!=', $invoice->id)
            ->whereNotNull('balance_after')
            ->where(function (Builder $query) use ($invoice, $ledgerDate): void {
                if ($ledgerDate !== null) {
                    $query
                        ->whereDate('date', '>', $ledgerDate)
                        ->orWhere(function (Builder $sameDateQuery) use ($invoice, $ledgerDate): void {
                            $sameDateQuery
                                ->whereDate('date', $ledgerDate)
                                ->where('id', '>', $invoice->id);
                        });

                    return;
                }

                $query->where('id', '>', $invoice->id);
            })
            ->get();

        foreach ($followingEntries as $entry) {
            $entry->balance_after = $this->fromCents($this->toCents($entry->balance_after) + $deltaCents);
            $entry->save();
        }
    }

    private function freshOrderDetailModel(Order $order): Order
    {
        return $order->fresh([
            'dealer',
            'customer.salesperson:id,name',
            'cart:id,shipping_method,note,order_note',
            'ledgerEntries' => fn ($ledgerQuery) => $ledgerQuery
                ->where('type', 'invoice')
                ->orderByDesc('id')
                ->with('createdBy:id,name'),
            'user:id,name',
            'user.roles:id,slug,name',
            'items.product.brand',
            'items.product.stockSummary',
            'items.product.codeAliases',
            'statusHistory.changedBy',
        ]);
    }

    /**
     * @return array{mode: string, code: string, label: string}
     */
    private function checkoutSummaryMeta(?string $mode): array
    {
        return match ($mode) {
            'excluded' => [
                'mode' => 'excluded',
                'code' => '2-O',
                'label' => '2 - O',
            ],
            'included' => [
                'mode' => 'included',
                'code' => '3-B',
                'label' => '3 - B',
            ],
            default => [
                'mode' => 'detailed',
                'code' => '1-F',
                'label' => '1 - F',
            ],
        };
    }

    private function isBatumCustomer(?Customer $customer): bool
    {
        if (! $customer instanceof Customer) {
            return false;
        }

        if (str_starts_with(trim((string) $customer->code), '120-00-')) {
            return true;
        }

        foreach ([
            $customer->branch_code,
            $customer->branch_name,
            $customer->region_code,
            $customer->region_name,
            $customer->name,
        ] as $value) {
            if (str_contains(mb_strtoupper(trim((string) $value), 'UTF-8'), 'BATUM')) {
                return true;
            }
        }

        return false;
    }

    private function logoSyncState(string $domain, string $entityType, int $entityId): ?IntegrationSyncState
    {
        return IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', $domain)
            ->where('direction', 'outbound')
            ->where('entity_type', $entityType)
            ->where('entity_id', $entityId)
            ->latest('id')
            ->first();
    }

    /**
     * @param  list<string>  $createdByRoleSlugs
     */
    private function resolveOrderSalesperson(Order $order, array $createdByRoleSlugs): ?User
    {
        if ($order->user instanceof User && in_array('salesperson', $createdByRoleSlugs, true)) {
            return $order->user;
        }

        return $order->customer?->salesperson;
    }

    private function nullableString(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $normalized = trim((string) $value);

        return $normalized === '' ? null : $normalized;
    }

    /**
     * @param  array<string, mixed>  $validated
     */
    private function resolveDraftCartForOrder(User $user, int $dealerId, array $validated): Cart
    {
        $query = Cart::query()
            ->where('status', 'draft')
            ->where('dealer_id', $dealerId)
            ->where('user_id', $user->id)
            ->lockForUpdate();

        if (! empty($validated['cart_id'])) {
            $query->whereKey((int) $validated['cart_id']);
        }

        if (! empty($validated['customer_id'])) {
            $query->where('customer_id', (int) $validated['customer_id']);
        }

        $cart = $query->latest('id')->first();

        if ($cart === null) {
            throw ValidationException::withMessages([
                'cart' => ['No draft cart found for this user/dealer context.'],
            ]);
        }

        return $cart;
    }

    private function generateOrderNo(): string
    {
        do {
            $candidate = 'ORD-'.now()->format('YmdHis').'-'.Str::upper(Str::random(4));
            $exists = Order::query()->where('order_no', $candidate)->exists();
        } while ($exists);

        return $candidate;
    }

    /**
     * @param  int|string|null  $requestedDealerId
     */
    private function resolveDealerId(
        User $user,
        $requestedDealerId,
        ?int $customerId = null,
        ?int $cartId = null
    ): ?int {
        if ($user->dealer_id !== null) {
            return (int) $user->dealer_id;
        }

        if ($user->hasRole('admin') && $requestedDealerId !== null) {
            return (int) $requestedDealerId;
        }

        if ($user->hasRole('admin') && $customerId !== null) {
            $dealerId = Customer::query()
                ->whereKey($customerId)
                ->value('dealer_id');

            if ($dealerId !== null) {
                return (int) $dealerId;
            }
        }

        if ($user->hasRole('admin') && $cartId !== null) {
            $dealerId = Cart::query()
                ->whereKey($cartId)
                ->value('dealer_id');

            return $dealerId !== null ? (int) $dealerId : null;
        }

        return null;
    }

    private function ensureOrderRole(User $user): void
    {
        if (! $user->hasAnyRole(['admin', 'dealer_admin', 'salesperson', 'cashier', 'point', 'customer', 'warehouse'])) {
            abort(Response::HTTP_FORBIDDEN, 'You are not allowed to access cart/order flow.');
        }
    }

    private function ensureCanViewOrder(User $user, Order $order): void
    {
        if ($user->hasRole('admin')) {
            return;
        }

        $customer = Customer::query()->find((int) $order->customer_id);

        if (! $customer instanceof Customer) {
            abort(Response::HTTP_FORBIDDEN, 'Order customer is missing.');
        }

        if ($user->dealer_id === null || (int) $user->dealer_id !== (int) $order->dealer_id) {
            abort(Response::HTTP_FORBIDDEN, 'You can only access orders for your dealer.');
        }

        if (! $user->canAccessCustomer($customer)) {
            abort(Response::HTTP_FORBIDDEN, 'You can only access orders for customers in your scope.');
        }
    }

    private function ensureCanViewOrderDetail(User $user, Order $order): void
    {
        if (! $user->hasAnyRole(['admin', 'dealer_admin', 'salesperson', 'cashier', 'point', 'warehouse', 'customer'])) {
            abort(Response::HTTP_FORBIDDEN, 'You are not allowed to access order detail.');
        }

        $this->ensureCanViewOrder($user, $order);
    }

    /**
     * @param  float|string|int  $amount
     */
    private function toCents($amount): int
    {
        return (int) round(((float) $amount) * 100);
    }

    private function fromCents(int $cents): string
    {
        return number_format($cents / 100, 2, '.', '');
    }
}
