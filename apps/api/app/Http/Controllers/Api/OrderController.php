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
use App\Models\ReturnRequest;
use App\Models\StockSummary;
use App\Models\User;
use App\Services\Customers\CustomerAccessScopeService;
use App\Services\Integrations\IntegrationSyncStateService;
use App\Services\Notifications\UserNotificationService;
use App\Services\Orders\CustomerOrderRiskGuard;
use App\Services\Orders\ShippingChargeService;
use App\Services\Users\UserPermissionService;
use App\Support\Cart\CheckoutNoteCleaner;
use App\Support\Pricing\DealerNetPriceExpression;
use App\Support\Pricing\DisplayCurrency;
use App\Support\Warehouse\WarehouseBranchResolver;
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
                'cart_id',
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
                'cart:id,shipping_method',
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
            $queryStatuses = $statuses;
            if (in_array('balance', $statuses, true)) {
                $queryStatuses[] = 'partially_shipped';
            }
            $query->whereIn('status', array_values(array_unique($queryStatuses)));
        }

        if ($q !== '') {
            $query->where(function (Builder $builder) use ($q): void {
                $builder->whereLike('order_no', "%{$q}%", caseSensitive: false)
                    ->orWhereHas('customer', function (Builder $customerQuery) use ($q): void {
                        $customerQuery
                            ->whereLike('code', "{$q}%", caseSensitive: false)
                            ->orWhereLike('name', "%{$q}%", caseSensitive: false);
                    })
                    ->orWhereHas('items.product', function (Builder $productQuery) use ($q): void {
                        $productQuery
                            ->whereLike('sku', "%{$q}%", caseSensitive: false)
                            ->orWhereLike('name', "%{$q}%", caseSensitive: false)
                            ->orWhereLike('oem_code', "%{$q}%", caseSensitive: false)
                            ->orWhereHas('codeAliases', function (Builder $aliasQuery) use ($q): void {
                                $aliasQuery
                                    ->whereLike('code', "%{$q}%", caseSensitive: false)
                                    ->orWhereLike('brand_name', "%{$q}%", caseSensitive: false);
                            });
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
            'customer.salesperson:id,name,username,email,branch_code,branch_name',
            'cart:id,shipping_method,note,order_note',
            'ledgerEntries' => fn ($ledgerQuery) => $ledgerQuery
                ->where('type', 'invoice')
                ->orderByDesc('id')
                ->with('createdBy:id,name'),
            'user:id,name,username,email,branch_code,branch_name',
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
                $freeQuantity = $stock instanceof StockSummary
                    ? max(0, (int) $stock->available_total - max(0, (int) $stock->reserved_total))
                    : 0;

                if (! $stock instanceof StockSummary || $freeQuantity < $delta) {
                    throw ValidationException::withMessages([
                        'quantity' => ['Bu artış için yeterli stok yok.'],
                    ]);
                }

                $stock->reserved_total = (int) $stock->reserved_total + $delta;
                $stock->updated_at = now();
                $stock->save();
            } elseif ($delta < 0 && $stock instanceof StockSummary) {
                $releasedQuantity = abs($delta);
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

            return $this->freshOrderDetailModel($lockedOrder);
        });

        return response()->json($this->serializeOrderDetail($updatedOrder));
    }

    public function store(
        CreateOrderRequest $request,
        IntegrationSyncStateService $syncState,
        UserNotificationService $notifications,
        ShippingChargeService $shippingCharges,
        CustomerOrderRiskGuard $riskGuard
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

        $order = DB::transaction(function () use ($validated, $dealerId, $user, $syncState, $forceWarehouseTransfer, $shippingCharges, $riskGuard) {
            $cart = $this->resolveDraftCartForOrder($user, $dealerId, $validated);
            $cart->loadMissing('customer.salesperson');
            $items = $cart->items()->with('product')->lockForUpdate()->get();
            $selectedProductIds = collect($validated['selected_product_ids'] ?? [])
                ->map(fn ($value): int => (int) $value)
                ->filter(fn (int $value): bool => $value > 0)
                ->unique()
                ->values();

            if ($items->isEmpty()) {
                throw ValidationException::withMessages([
                    'cart' => ['Cannot create order from an empty cart.'],
                ]);
            }

            if ($selectedProductIds->isNotEmpty()) {
                $items = $items
                    ->filter(fn ($item): bool => $selectedProductIds->contains((int) $item->product_id))
                    ->values();

                if ($items->isEmpty()) {
                    throw ValidationException::withMessages([
                        'selected_product_ids' => ['Seçili ürünler sepette bulunamadı.'],
                    ]);
                }
            }

            $stocks = StockSummary::query()
                ->whereIn('product_id', $items->pluck('product_id')->unique()->values())
                ->lockForUpdate()
                ->get()
                ->keyBy('product_id');

            $subtotalCents = 0;
            $discountTotalCents = 0;
            $taxTotalCents = 0;
            $requestedCheckoutSummaryMode = array_key_exists('checkout_summary_mode', $validated)
                ? $this->normalizeCheckoutSummaryMode($validated['checkout_summary_mode'])
                : null;
            $requestedItemCheckoutSummaryModes = $this->normalizeItemCheckoutSummaryModes($validated['item_checkout_summary_modes'] ?? []);
            $checkoutSummaryMode = $requestedCheckoutSummaryMode ?? 'detailed';
            $itemCheckoutSummaryModes = $requestedItemCheckoutSummaryModes;
            $paymentMethod = $this->nullableString($validated['payment_method'] ?? null);
            $salesPriceType = $this->nullableString($validated['sales_price_type'] ?? null);
            $isWarehouseTransfer = $forceWarehouseTransfer || (bool) $cart->is_warehouse_transfer;
            $isDepotTransferRequest = (bool) ($validated['warehouse_transfer_request'] ?? false);
            if (! $isDepotTransferRequest) {
                $this->ensureCustomerAccountUsesDetailedMode(
                    $user,
                    $requestedCheckoutSummaryMode,
                    $requestedItemCheckoutSummaryModes
                );
                [$checkoutSummaryMode, $itemCheckoutSummaryModes] = $this->normalizeCheckoutSummaryModesForCheckout(
                    $user,
                    $cart->customer,
                    $checkoutSummaryMode,
                    $itemCheckoutSummaryModes
                );
                $this->ensureAllowedCheckoutSummaryModes($user, $cart->customer, $checkoutSummaryMode, $itemCheckoutSummaryModes);
                $this->ensureLogoEInvoiceCustomerUsesDetailedMode(
                    $cart->customer,
                    $requestedCheckoutSummaryMode ?? $checkoutSummaryMode,
                    $requestedItemCheckoutSummaryModes
                );
            }
            if ($isDepotTransferRequest && ! $this->canCreateDepotTransfer($user)) {
                throw ValidationException::withMessages([
                    'warehouse_transfer_request' => ['Depolar arası transfer için depocu yetkisi gerekir.'],
                ]);
            }
            $requestingWarehouse = $isDepotTransferRequest
                ? $this->resolveDepotTransferRequestingWarehouse($user, $cart->customer, $cart->shipping_method)
                : null;
            $sourceWarehouse = $isDepotTransferRequest
                ? $this->resolveTransferTargetWarehouse($validated, $requestingWarehouse)
                : null;
            $targetWarehouse = $isDepotTransferRequest
                ? $requestingWarehouse
                : $this->resolveOrderTargetWarehouseForCheckout($user, $cart->customer, $cart->shipping_method, $validated);
            $orderItemRows = [];

            foreach ($items as $item) {
                /** @var StockSummary $stock */
                $stock = $stocks->get($item->product_id);
                $availableQuantity = 0;
                $reservedQuantity = 0;

                if ($stock instanceof StockSummary) {
                    $availableQuantity = max(0, (int) $stock->available_total);
                    $freeQuantity = max(0, $availableQuantity - max(0, (int) $stock->reserved_total));
                    $reservedQuantity = min($freeQuantity, (int) $item->quantity);
                    if ((int) $stock->available_total !== $availableQuantity) {
                        $stock->available_total = $availableQuantity;
                        $stock->updated_at = now();
                        $stock->save();
                    }

                    if ($reservedQuantity > 0) {
                        $stock->reserved_total += $reservedQuantity;
                        $stock->updated_at = now();
                        $stock->save();
                    }
                }

                $quantity = (int) $item->quantity;
                $itemCheckoutSummaryMode = $itemCheckoutSummaryModes[(string) $item->product_id] ?? $checkoutSummaryMode;
                $taxAsSeparateLine = ! $isDepotTransferRequest && $itemCheckoutSummaryMode === 'detailed';
                $pricesIncludeTax = ! $isDepotTransferRequest && $itemCheckoutSummaryMode === 'included';
                // A warehouse transfer is not a sale. The cart row is the
                // authoritative commercial snapshot and must not be repriced
                // with the current product/customer price at checkout time.
                $lineCents = $this->toCents($this->cartItemLineTotal($item));
                $unitNetPrice = $quantity > 0
                    ? $this->fromCents((int) round($lineCents / $quantity))
                    : round((float) $item->unit_net_price, 2);
                $lineCurrency = (string) $item->currency;
                $grossCents = $this->toCents($unitNetPrice * $quantity);
                $sourceTaxRate = $isDepotTransferRequest ? 0.0 : (float) ($item->vat_rate ?? $item->product?->vat_rate ?? 0);
                $lineTaxCents = $isDepotTransferRequest ? 0 : (int) round($lineCents * ($sourceTaxRate / 100));
                $grossTaxCents = $isDepotTransferRequest ? 0 : (int) round($grossCents * ($sourceTaxRate / 100));
                $orderLineCents = $pricesIncludeTax ? $lineCents + $lineTaxCents : $lineCents;
                $orderGrossCents = $pricesIncludeTax ? $grossCents + $grossTaxCents : $grossCents;
                $orderUnitCents = $quantity > 0
                    ? (int) round($orderLineCents / $quantity)
                    : $lineCents;
                $orderTaxRate = $taxAsSeparateLine ? $sourceTaxRate : 0.0;
                $orderTaxCents = $taxAsSeparateLine ? $lineTaxCents : 0;

                $subtotalCents += $orderLineCents;
                $discountTotalCents += max(0, $orderGrossCents - $orderLineCents);
                $taxTotalCents += $orderTaxCents;
                $orderItemRows[] = [
                    'product_id' => $item->product_id,
                    'quantity' => $quantity,
                    'unit_net_price' => $this->fromCents($orderUnitCents),
                    'discount_rate' => $isDepotTransferRequest ? 0 : $item->discount_rate,
                    'tax_rate' => $orderTaxRate,
                    'line_total' => $this->fromCents($orderLineCents),
                    'currency' => $lineCurrency,
                    'campaign_key' => $isDepotTransferRequest ? null : $item->campaign_key,
                    'checkout_summary_mode' => $itemCheckoutSummaryMode,
                ];

            }

            $subtotal = $this->fromCents($subtotalCents);
            $discountTotal = $this->fromCents($discountTotalCents);
            $taxTotal = $this->fromCents($taxTotalCents);
            $calculatedGrandTotalCents = $subtotalCents + $taxTotalCents;
            $shippingCharge = $shippingCharges->resolve(
                $cart->shipping_method,
                $this->fromCents($calculatedGrandTotalCents),
                $isDepotTransferRequest
            );
            $shippingFeeCents = $this->toCents($shippingCharge['amount']);
            $submittedCheckoutGrandTotalCents = (! $isDepotTransferRequest && array_key_exists('checkout_grand_total', $validated))
                ? max(0, $this->toCents($validated['checkout_grand_total']))
                : null;
            $submittedShippingFeeCents = min(
                $submittedCheckoutGrandTotalCents ?? 0,
                max(0, $this->toCents($validated['shipping_fee_amount'] ?? 0))
            );
            $checkoutBaseGrandTotalCents = $submittedCheckoutGrandTotalCents !== null
                ? max(0, $submittedCheckoutGrandTotalCents - $submittedShippingFeeCents)
                : $calculatedGrandTotalCents;
            $checkoutGrandTotalCents = $checkoutBaseGrandTotalCents + $shippingFeeCents;
            $grandTotal = $this->fromCents($checkoutGrandTotalCents);
            if (! $isDepotTransferRequest && $cart->customer instanceof Customer) {
                $riskGuard->assertCanPlaceOrder($cart->customer, $grandTotal);
            }
            if ($checkoutBaseGrandTotalCents < $calculatedGrandTotalCents) {
                $discountTotal = $this->fromCents(
                    $discountTotalCents + ($calculatedGrandTotalCents - $checkoutBaseGrandTotalCents)
                );
            }
            $sourcePanel = $this->resolveSourcePanel($user);
            $autoApproveWarehouseCheckout = in_array($sourcePanel, ['warehouse', 'point'], true);
            $autoApproveCustomerCheckout = $this->isCustomerCheckoutUser($user);
            $autoApproveAdminCheckout = $user->hasAnyRole(['admin', 'dealer_admin']);
            $initialStatus = ($isWarehouseTransfer || $autoApproveWarehouseCheckout || $autoApproveCustomerCheckout || $autoApproveAdminCheckout) ? 'approved' : 'pending';
            $orderNote = CheckoutNoteCleaner::clean(
                $this->resolveOrderNote($validated['note'] ?? null, $cart->order_note, $cart->note)
            );
            $transferSourceWarehouse = $isDepotTransferRequest ? $sourceWarehouse : null;
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
                'approved_at' => $initialStatus === 'approved' ? $timestamp : null,
                'note' => $orderNote,
            ]);

            foreach ($orderItemRows as $itemRow) {
                OrderItem::create([
                    'order_id' => $order->id,
                    'product_id' => $itemRow['product_id'],
                    'vehicle_id' => null,
                    'quantity' => $itemRow['quantity'],
                    'unit_net_price' => $itemRow['unit_net_price'],
                    'discount_rate' => $itemRow['discount_rate'],
                    'tax_rate' => $itemRow['tax_rate'],
                    'line_total' => $itemRow['line_total'],
                    'currency' => $itemRow['currency'],
                    'campaign_key' => $itemRow['campaign_key'],
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

            $cart->status = 'ordered';
            $cart->items()
                ->whereIn('product_id', $items->pluck('product_id')->unique()->values())
                ->delete();
            if ($cart->items()->exists()) {
                $cart->status = 'draft';
            }
            $cart->save();

            $baseSyncMeta = [
                'export_key' => 'B2B-ORDER-'.$order->id,
                'order_no' => $order->order_no,
                'status' => $order->status,
                'source_panel' => $sourcePanel,
                'checkout_summary_mode' => $isDepotTransferRequest ? 'excluded' : $checkoutSummaryMode,
                'item_checkout_summary_modes' => $itemCheckoutSummaryModes,
                'payment_method' => $isDepotTransferRequest ? null : $paymentMethod,
                'sales_price_type' => $isDepotTransferRequest ? null : $salesPriceType,
                'checkout_grand_total' => $isDepotTransferRequest || $checkoutGrandTotalCents === null
                    ? null
                    : $this->fromCents($checkoutGrandTotalCents),
                'shipping_fee_amount' => $this->fromCents($shippingFeeCents),
                'shipping_fee_applied' => $shippingCharge['applied'],
                'shipping_rules' => [
                    'cargo_limit' => $shippingCharge['cargo_limit'],
                    'cargo_fee' => $shippingCharge['cargo_fee'],
                    'bus_fee' => $shippingCharge['bus_fee'],
                ],
                'shipping_method' => $cart->shipping_method,
                'target_warehouse_code' => $targetWarehouse['code'] ?? null,
                'target_warehouse_name' => $targetWarehouse['name'] ?? null,
                'target_warehouse_reason' => $targetWarehouse['reason'] ?? null,
            ];
            $baseSyncPayload = [
                'order_id' => $order->id,
                'order_no' => $order->order_no,
                'grand_total' => $order->grand_total,
                'checkout_summary_mode' => $isDepotTransferRequest ? 'excluded' : $checkoutSummaryMode,
                'item_checkout_summary_modes' => $itemCheckoutSummaryModes,
                'payment_method' => $isDepotTransferRequest ? null : $paymentMethod,
                'sales_price_type' => $isDepotTransferRequest ? null : $salesPriceType,
                'checkout_grand_total' => $isDepotTransferRequest || $checkoutGrandTotalCents === null
                    ? null
                    : $this->fromCents($checkoutGrandTotalCents),
                'shipping_fee_amount' => $this->fromCents($shippingFeeCents),
                'shipping_fee_applied' => $shippingCharge['applied'],
                'shipping_rules' => [
                    'cargo_limit' => $shippingCharge['cargo_limit'],
                    'cargo_fee' => $shippingCharge['cargo_fee'],
                    'bus_fee' => $shippingCharge['bus_fee'],
                ],
                'shipping_method' => $cart->shipping_method,
                'target_warehouse_code' => $targetWarehouse['code'] ?? null,
                'target_warehouse_name' => $targetWarehouse['name'] ?? null,
                'target_warehouse_reason' => $targetWarehouse['reason'] ?? null,
            ];

            if ($isDepotTransferRequest) {
                $syncState->record(
                    system: 'logo',
                    domain: 'warehouse-transfer-orders',
                    direction: 'outbound',
                    entity: $order,
                    externalRef: null,
                    status: 'queued',
                    error: null,
                    meta: [
                        ...$baseSyncMeta,
                        'document_type' => 'warehouse_transfer',
                        'document_label' => 'Depolar Arası Transfer Talebi',
                        'transfer_status' => 'Talep Oluşturuldu',
                        'transfer_source_warehouse_code' => $transferSourceWarehouse['code'] ?? null,
                        'transfer_source_warehouse_name' => $transferSourceWarehouse['name'] ?? null,
                        'transfer_target_warehouse_code' => $targetWarehouse['code'] ?? null,
                        'transfer_target_warehouse_name' => $targetWarehouse['name'] ?? null,
                    ],
                    payload: [
                        ...$baseSyncPayload,
                        'document_type' => 'warehouse_transfer',
                        'document_label' => 'Depolar Arası Transfer Talebi',
                        'transfer_source_warehouse_code' => $transferSourceWarehouse['code'] ?? null,
                        'transfer_source_warehouse_name' => $transferSourceWarehouse['name'] ?? null,
                        'transfer_target_warehouse_code' => $targetWarehouse['code'] ?? null,
                        'transfer_target_warehouse_name' => $targetWarehouse['name'] ?? null,
                    ],
                );
            } else {
                $syncState->record(
                    system: 'logo',
                    domain: 'orders',
                    direction: 'outbound',
                    entity: $order,
                    externalRef: null,
                    status: 'queued',
                    error: null,
                    meta: $baseSyncMeta,
                    payload: $baseSyncPayload,
                );
            }

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

        $this->notifyOrderCreated($notifications, $order);

        return response()->json($this->serializeOrderDetail($order), Response::HTTP_CREATED);
    }

    private function notifyOrderCreated(UserNotificationService $notifications, Order $order): void
    {
        $state = IntegrationSyncState::query()
            ->where('system', 'logo')
            ->whereIn('domain', ['warehouse-transfer-orders', 'orders'])
            ->where('direction', 'outbound')
            ->where('entity_type', Order::class)
            ->where('entity_id', (int) $order->id)
            ->orderByDesc('id')
            ->first();

        $meta = is_array($state?->meta) ? $state->meta : [];
        $isTransfer = (string) data_get($meta, 'document_type') === 'warehouse_transfer';
        $warehouseCode = $isTransfer
            ? data_get($meta, 'transfer_source_warehouse_code')
            : data_get($meta, 'target_warehouse_code');
        $warehouseName = $isTransfer
            ? data_get($meta, 'transfer_source_warehouse_name')
            : data_get($meta, 'target_warehouse_name');
        $customerName = $order->customer?->name ?? 'Yeni müşteri';

        $notifications->notifyBranch(
            dealerId: $order->dealer_id !== null ? (int) $order->dealer_id : null,
            warehouseCode: $warehouseCode,
            warehouseName: $warehouseName,
            type: $isTransfer ? 'warehouse_transfer_request' : 'warehouse_order',
            title: $isTransfer ? 'Yeni Depo Transfer Talebi' : 'Yeni Sipariş',
            body: $isTransfer
                ? sprintf('%s sizden ürün talep etti. Sipariş: %s', data_get($meta, 'transfer_target_warehouse_name', $customerName), $order->order_no)
                : sprintf('%s için hazırlanması gereken yeni sipariş geldi. Sipariş: %s', $customerName, $order->order_no),
            url: '/warehouse',
            meta: [
                'order_id' => $order->id,
                'order_no' => $order->order_no,
                'is_warehouse_transfer' => $isTransfer,
            ],
            permissionKeys: ['warehouse']
        );
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
        $orderSyncMeta = is_array($logoSyncState?->meta) ? $logoSyncState->meta : [];
        $createdByRoleSlugs = $order->user instanceof User ? $this->userRoleSlugs($order->user) : [];
        $sourcePanel = $this->nullableString(data_get($invoiceMeta, 'source_panel'))
            ?? $this->resolveSourcePanelFromRoleSlugs($createdByRoleSlugs);
        $salesperson = $this->resolveOrderSalesperson($order, $createdByRoleSlugs);
        $printWarehouse = $this->resolveOrderPrintWarehouse($order, $invoiceMeta, $orderSyncMeta);
        $printWarehouseCode = (string) $printWarehouse['code'];
        $printWarehouseName = $this->nullableString($printWarehouse['name'] ?? null);

        return [
            'order' => [
                'id' => $order->id,
                'order_no' => $order->order_no,
                'status' => $order->status === 'partially_shipped' ? 'balance' : $order->status,
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
                    'sales_price_type' => $this->nullableString(data_get($invoiceMeta, 'sales_price_type'))
                        ?? $this->nullableString(data_get($orderSyncMeta, 'sales_price_type')),
                    'payment_method' => $this->nullableString(data_get($invoiceMeta, 'payment_method'))
                        ?? $this->nullableString(data_get($orderSyncMeta, 'payment_method')),
                    'shipping_method' => $order->cart?->shipping_method,
                    'target_warehouse_code' => $printWarehouseCode,
                    'target_warehouse_name' => $printWarehouseName,
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
                'items' => $order->items->map(function ($item) use ($printWarehouseCode, $printWarehouseName) {
                    $returnedQuantity = $this->resolveReturnedQuantity($item);
                    $returnableQuantity = $this->resolveReturnableQuantity($item, $returnedQuantity);
                    $printWarehouseAvailableTotal = $this->resolveProductLogoWarehouseStockTotal($item, $printWarehouseCode);

                    return [
                        'id' => $item->id,
                        'product_id' => $item->product_id,
                        'sku' => $item->product?->sku,
                        'name' => $item->product?->name,
                        'brand' => $item->product?->brand?->name,
                        'quantity' => $item->quantity,
                        'shipped_qty' => $item->shipped_qty,
                        'remaining_quantity' => max(0, (int) $item->quantity - (int) $item->shipped_qty),
                        'returned_quantity' => $returnedQuantity,
                        'returnable_quantity' => $returnableQuantity,
                        'unit_net_price' => $item->unit_net_price,
                        'tax_rate' => $item->tax_rate,
                        'line_total' => $item->line_total,
                        'currency' => $item->currency,
                        'barcode' => $this->resolveProductBarcode($item),
                        'shelf_address' => $this->resolveProductLogoWarehouseShelfAddress($item, $printWarehouseCode)
                            ?? $this->resolveProductLogoWarehouseShelfAddress($item, '1')
                            ?? $this->resolveProductShelfAddress($item->product?->meta),
                        'logo_stock' => [
                            'available_total' => $this->resolveProductLogoStockTotal($item),
                            'erzurum_depo_available_total' => $this->resolveProductLogoWarehouseStockTotal($item, '1'),
                            'print_warehouse_code' => $printWarehouseCode,
                            'print_warehouse_name' => $printWarehouseName,
                            'print_warehouse_available_total' => $printWarehouseAvailableTotal,
                            'reserved_total' => $this->resolveProductReservedStockTotal($item),
                            'updated_at' => $this->resolveProductLogoStockUpdatedAt($item),
                        ],
                    ];
                })->values(),
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

    /**
     * @param  array<string, mixed>  $invoiceMeta
     * @param  array<string, mixed>  $orderSyncMeta
     * @return array{code:string,name:string|null}
     */
    private function resolveOrderPrintWarehouse(Order $order, array $invoiceMeta, array $orderSyncMeta): array
    {
        $metaCode = $this->nullableString(data_get($invoiceMeta, 'target_warehouse_code'))
            ?? $this->nullableString(data_get($orderSyncMeta, 'target_warehouse_code'));
        $metaName = $this->nullableString(data_get($invoiceMeta, 'target_warehouse_name'))
            ?? $this->nullableString(data_get($orderSyncMeta, 'target_warehouse_name'));

        if ($metaCode !== null) {
            return [
                'code' => $metaCode,
                'name' => $metaName,
            ];
        }

        $resolved = app(WarehouseBranchResolver::class)->targetWarehouse(
            $order->user,
            $order->customer,
            $order->cart?->shipping_method
        );

        return [
            'code' => (string) ($resolved['code'] ?? '1'),
            'name' => $metaName ?? $this->nullableString($resolved['name'] ?? null),
        ];
    }

    private function normalizeCheckoutSummaryMode(mixed $value): string
    {
        return match ((string) $value) {
            'excluded', 'included' => (string) $value,
            default => 'detailed',
        };
    }

    /**
     * @param  array<string, string>  $itemModes
     */
    private function ensureLogoEInvoiceCustomerUsesDetailedMode(?Customer $customer, string $mode, array $itemModes): void
    {
        if (! $customer instanceof Customer || ! $this->customerRequiresLogoDetailedInvoice($customer)) {
            return;
        }

        if ($mode !== 'detailed' || in_array('excluded', $itemModes, true) || in_array('included', $itemModes, true)) {
            throw ValidationException::withMessages([
                'checkout_summary_mode' => ['Logo e-Fatura kullanıcısı carilerde sadece 1-F fatura kesilebilir.'],
            ]);
        }
    }

    private function customerRequiresLogoDetailedInvoice(Customer $customer): bool
    {
        $meta = is_array($customer->meta) ? $customer->meta : [];

        foreach ($this->logoEInvoiceUserPaths() as $path) {
            $value = data_get($meta, $path);

            if ($value !== null && $this->truthyLogoFlag($value)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @return list<string>
     */
    private function logoEInvoiceUserPaths(): array
    {
        return [
            'integrations.logo.payload.e_invoice_user',
            'integrations.logo.payload.e_invoice',
            'integrations.logo.payload.e_fatura',
            'integrations.logo.payload.raw.EINVOICE',
            'integrations.logo.payload.raw.EINVOICEUSER',
            'integrations.logo.payload.raw.EINVOICE_USER',
            'integrations.logo.payload.raw.ACCEPTEINV',
            'integrations.logo.payload.raw.EFATURA',
            'integrations.logo.payload.raw.E_FATURA',
        ];
    }

    private function truthyLogoFlag(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }

        if (is_int($value) || is_float($value)) {
            return (float) $value !== 0.0;
        }

        $normalized = trim((string) $value);
        if ($normalized === '') {
            return false;
        }

        return in_array(mb_strtoupper($normalized, 'UTF-8'), [
            '1',
            'TRUE',
            'YES',
            'EVET',
            'E',
            'ON',
            'AKTIF',
            'AKTİF',
        ], true);
    }

    /**
     * @param  array<string, string>  $itemModes
     */
    private function ensureAllowedCheckoutSummaryModes(User $user, ?Customer $customer, string $mode, array $itemModes): void
    {
        $allowedModes = $this->checkoutSummaryModesForOrder($user, $customer);

        if (! in_array($mode, $allowedModes, true)) {
            throw ValidationException::withMessages([
                'checkout_summary_mode' => ['Bu kullanıcı için seçilen satış tipi yetkisi yok.'],
            ]);
        }

        foreach ($itemModes as $itemMode) {
            if (! in_array($itemMode, $allowedModes, true)) {
                throw ValidationException::withMessages([
                    'item_checkout_summary_modes' => ['Bu kullanıcı için seçilen ürün satış tipi yetkisi yok.'],
                ]);
            }
        }
    }

    /**
     * @param  array<string, string>  $itemModes
     */
    private function ensureCustomerAccountUsesDetailedMode(User $user, ?string $mode, array $itemModes): void
    {
        if (! $user->hasRole('customer')) {
            return;
        }

        if ($mode !== null && $mode !== 'detailed') {
            throw ValidationException::withMessages([
                'checkout_summary_mode' => ['Müşteri hesabından sadece 1-F satış tipiyle sipariş gönderilebilir.'],
            ]);
        }

        foreach ($itemModes as $itemMode) {
            if ($itemMode !== 'detailed') {
                throw ValidationException::withMessages([
                    'item_checkout_summary_modes' => ['Müşteri hesabından sadece 1-F satış tipiyle sipariş gönderilebilir.'],
                ]);
            }
        }
    }

    /**
     * @param  array<string, string>  $itemModes
     * @return array{0:string,1:array<string,string>}
     */
    private function normalizeCheckoutSummaryModesForCheckout(User $user, ?Customer $customer, string $mode, array $itemModes): array
    {
        $allowedModes = $this->checkoutSummaryModesForOrder($user, $customer);

        if ($allowedModes === []) {
            $allowedModes = ['detailed'];
        }

        $fallbackMode = $allowedModes[0] ?? 'detailed';
        if (! in_array($mode, $allowedModes, true)) {
            $mode = $fallbackMode;
        }

        foreach ($itemModes as $productId => $itemMode) {
            if (! in_array($itemMode, $allowedModes, true)) {
                $itemModes[$productId] = $mode;
            }
        }

        return [$mode, $itemModes];
    }

    /**
     * @return list<string>
     */
    private function checkoutSummaryModesForOrder(User $user, ?Customer $customer): array
    {
        if ($user->hasRole('customer')) {
            return ['detailed'];
        }

        if ($customer instanceof Customer) {
            $customerUser = $this->customerUserForCustomer($customer);

            if ($customerUser instanceof User && $this->hasExplicitCheckoutSummaryModePermissions($customerUser)) {
                return app(UserPermissionService::class)->checkoutSummaryModes($customerUser);
            }
        }

        if ($user->hasRole('salesperson')) {
            return ['detailed', 'included'];
        }

        $modes = app(UserPermissionService::class)->checkoutSummaryModes($user);

        return $modes === [] ? ['detailed'] : $modes;
    }

    private function isCustomerCheckoutUser(User $user): bool
    {
        return $user->hasRole('customer')
            || ($user->selected_customer_id !== null && ! $user->hasAnyRole(['salesperson', 'warehouse', 'point', 'admin', 'dealer_admin']));
    }

    private function customerUserForCustomer(Customer $customer): ?User
    {
        $username = $this->usernameFromCustomerCode($customer->code);

        return User::query()
            ->select(['id', 'selected_customer_id', 'username', 'feature_permissions'])
            ->whereHas('roles', fn (Builder $query) => $query->where('slug', 'customer'))
            ->where(function (Builder $query) use ($customer, $username): void {
                $query->where('selected_customer_id', $customer->id);

                if ($username !== '') {
                    $query->orWhereRaw('LOWER(username) = ?', [$username]);
                }
            })
            ->orderByRaw('CASE WHEN selected_customer_id = ? THEN 0 ELSE 1 END', [$customer->id])
            ->first();
    }

    private function hasExplicitCheckoutSummaryModePermissions(User $user): bool
    {
        $permissions = is_array($user->feature_permissions) ? $user->feature_permissions : [];
        $permissionSet = array_flip($permissions);

        return isset($permissionSet['cart.sale_type.detailed'])
            || isset($permissionSet['cart.sale_type.excluded'])
            || isset($permissionSet['cart.sale_type.included']);
    }

    private function usernameFromCustomerCode(?string $code): string
    {
        $username = mb_strtolower(trim((string) $code));
        $username = preg_replace('/\s+/', '-', $username) ?? '';
        $username = preg_replace('/[^a-z0-9._-]+/', '-', $username) ?? '';
        $username = trim($username, '.-_');

        return $username;
    }

    /**
     * Transfer satış değildir; sepet satırı kampanyalı oluşturulmuş olsa bile
     * depolar arası transfer baz/net fiyatla ve KDV/iskonto olmadan taşınır.
     *
     * @return array{net_price:string,currency:string}|null
     */
    private function resolveBaseUnitPrice(int $dealerId, int $productId, User $user): ?array
    {
        $netPriceSql = DealerNetPriceExpression::sql();

        $price = DB::table('dealers as d')
            ->leftJoin('price_lists as pl', 'pl.id', '=', 'd.price_list_id')
            ->leftJoin('dealer_price_overrides as dpo', function ($join) use ($productId): void {
                $join->on('dpo.dealer_id', '=', 'd.id')
                    ->where('dpo.product_id', '=', $productId);
            })
            ->leftJoin('base_prices as bp', function ($join) use ($productId): void {
                $join->on('bp.price_list_id', '=', 'd.price_list_id')
                    ->where('bp.product_id', '=', $productId);
            })
            ->where('d.id', $dealerId)
            ->selectRaw("{$netPriceSql} as net_price")
            ->selectRaw("COALESCE(dpo.currency, bp.currency, 'TRY') as currency")
            ->first();

        if ($price === null || $price->net_price === null) {
            return null;
        }

        $currency = (string) $price->currency;
        $netPrice = number_format((float) $price->net_price, 2, '.', '');

        return [
            'net_price' => DisplayCurrency::formatPrice($netPrice, $currency, $user) ?? $netPrice,
            'currency' => DisplayCurrency::normalize($currency, $user),
        ];
    }

    /**
     * @return array<string, string>
     */
    private function normalizeItemCheckoutSummaryModes(mixed $value): array
    {
        if (! is_array($value)) {
            return [];
        }

        $modes = [];
        foreach ($value as $productId => $mode) {
            $productKey = trim((string) $productId);
            if ($productKey === '' || ! ctype_digit($productKey)) {
                continue;
            }

            $modes[$productKey] = $this->normalizeCheckoutSummaryMode($mode);
        }

        return $modes;
    }

    private function resolveReturnedQuantity(OrderItem $item): int
    {
        return (int) ReturnRequest::query()
            ->where('order_item_id', (int) $item->id)
            ->where('status', '!=', ReturnRequest::STATUS_REJECTED)
            ->sum('quantity');
    }

    private function resolveReturnableQuantity(OrderItem $item, int $returnedQuantity): int
    {
        $baseQuantity = (int) $item->shipped_qty;

        if ($baseQuantity <= 0) {
            $baseQuantity = (int) $item->quantity;
        }

        return max(0, $baseQuantity - $returnedQuantity);
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

    /**
     * @return array{code:string,name:string,reason:string}|null
     */
    private function resolveTargetWarehouseForCheckout(User $user, ?Customer $customer, ?string $shippingMethod): ?array
    {
        return app(WarehouseBranchResolver::class)->targetWarehouse($user, $customer, $shippingMethod);
    }

    /**
     * Depocu normal cari satışı yapıyorsa sipariş kendi deposuna düşer.
     * Cari/plasiyer bölgesi sadece plasiyer ve müşteri kullanıcı akışlarında belirleyici olur.
     *
     * @return array{code:string,name:string,reason:string}|null
     */
    private function resolveOrderTargetWarehouseForCheckout(User $user, ?Customer $customer, ?string $shippingMethod, array $validated = []): ?array
    {
        $explicitShippingWarehouse = $this->resolveShippingTargetWarehouse($validated);
        if ($explicitShippingWarehouse !== null && mb_strtolower(trim((string) $shippingMethod), 'UTF-8') === 'kargo') {
            return $explicitShippingWarehouse;
        }

        if ($user->hasAnyRole(['warehouse', 'point']) && ! $user->hasRole('admin')) {
            return $this->resolveTargetWarehouseForCheckout($user, null, null);
        }

        return $this->resolveTargetWarehouseForCheckout($user, $customer, $shippingMethod);
    }

    /**
     * @param  array<string, mixed>  $validated
     * @return array{code:string,name:string,reason:string}|null
     */
    private function resolveShippingTargetWarehouse(array $validated): ?array
    {
        $targetCode = $this->nullableString($validated['shipping_target_warehouse_code'] ?? null);
        $targetName = $this->nullableString($validated['shipping_target_warehouse_name'] ?? null);

        if ($targetCode === null && $targetName === null) {
            return null;
        }

        $allowed = [
            '1' => 'ERZURUM DEPO',
            '2' => 'TRABZON DEPO',
            '3' => 'SAMSUN DEPO',
        ];

        if ($targetCode !== null && isset($allowed[$targetCode])) {
            return [
                'code' => $targetCode,
                'name' => $allowed[$targetCode],
                'reason' => 'SHIPPING_KARGO_SELECTED',
            ];
        }

        $normalizedName = preg_replace('/[^A-Z0-9]+/', '', mb_strtoupper(trim((string) $targetName), 'UTF-8')) ?? '';
        foreach ($allowed as $code => $name) {
            $normalizedAllowedName = preg_replace('/[^A-Z0-9]+/', '', mb_strtoupper($name, 'UTF-8')) ?? '';
            if ($normalizedName !== '' && str_contains($normalizedName, $normalizedAllowedName)) {
                return [
                    'code' => $code,
                    'name' => $name,
                    'reason' => 'SHIPPING_KARGO_SELECTED',
                ];
            }
        }

        return null;
    }

    /**
     * Depolar arası transferde "talep eden / mal kabul yapacak" depo tek kaynak olmalı.
     * Önce giriş yapan depocunun bölgesini kullanırız; generic/eksik hesaplarda seçili
     * depo carisinin bölgesine düşerek Erzurum Point gibi sessiz yanlış hedef üretmeyiz.
     *
     * @return array{code:string,name:string,reason:string}|null
     */
    private function resolveDepotTransferRequestingWarehouse(User $user, ?Customer $customer, ?string $shippingMethod): ?array
    {
        $userWarehouse = $this->resolveTargetWarehouseForCheckout($user, null, null);
        if ($userWarehouse !== null) {
            return $userWarehouse;
        }

        return $this->resolveTargetWarehouseForCheckout($user, $customer, $shippingMethod);
    }

    /**
     * @param  array<string, mixed>  $validated
     * @param  array{code:string,name:string,reason:string}|null  $sourceWarehouse
     * @return array{code:string,name:string}
     */
    private function resolveTransferTargetWarehouse(array $validated, ?array $sourceWarehouse): array
    {
        $targetCode = $this->nullableString($validated['transfer_target_warehouse_code'] ?? null);
        $targetName = $this->nullableString($validated['transfer_target_warehouse_name'] ?? null);

        if ($targetCode === null && $targetName === null) {
            throw ValidationException::withMessages([
                'transfer_target_warehouse_code' => ['Depolar arasi transfer icin hedef depo secilmelidir.'],
            ]);
        }

        $sourceCode = $this->nullableString($sourceWarehouse['code'] ?? null);
        if ($targetCode !== null && $sourceCode !== null && $targetCode === $sourceCode) {
            throw ValidationException::withMessages([
                'transfer_target_warehouse_code' => ['Kullanici kendi deposuna transfer talebi olusturamaz. Farkli depo secin.'],
            ]);
        }

        if ($sourceCode === null) {
            throw ValidationException::withMessages([
                'transfer_source_warehouse_code' => ['Depolar arasi transfer icin kullanicinin kaynak deposu bulunamadi.'],
            ]);
        }

        return [
            'code' => $targetCode ?? '',
            'name' => $targetName ?? ($targetCode !== null ? "Logo Ambar {$targetCode}" : 'Logo Ambar'),
        ];
    }

    private function normalizeBranchCode(mixed $value): ?string
    {
        $normalized = preg_replace('/[^A-Z0-9]+/', '', Str::upper(Str::ascii(trim((string) $value)))) ?? '';

        if ($normalized === '') {
            return null;
        }

        if (str_contains($normalized, 'TRABZON')) {
            return 'TRABZON';
        }

        if (str_contains($normalized, 'SAMSUN')) {
            return 'SAMSUN';
        }

        if (str_contains($normalized, 'ERZURUM') || str_starts_with($normalized, 'ERZ')) {
            return 'ERZURUM';
        }

        if (str_contains($normalized, 'BATUM')) {
            return 'BATUM';
        }

        return $normalized;
    }

    private function branchCodeFromUserIdentity(User $user): ?string
    {
        $identity = preg_replace('/[^A-Z0-9]+/', '', Str::upper(Str::ascii(implode(' ', array_filter([
            $user->username,
            $user->email,
            $user->name,
        ]))))) ?? '';

        if ($identity === '') {
            return null;
        }

        $explicit = [
            'TRABZONPOINT' => 'TRABZON',
            'TRABZONDEPO' => 'TRABZON',
            'SAMSUNPOINT' => 'SAMSUN',
            'SAMSUNDEPO' => 'SAMSUN',
            'ERZURUMMERKEZ' => 'ERZURUM',
            'MUDURERZURUM' => 'ERZURUM',
            'AHMETARAC' => 'ERZURUM',
            'ERZDEPO' => 'ERZURUM',
            'BATUM' => 'BATUM',
        ];

        foreach ($explicit as $needle => $branch) {
            if (str_contains($identity, $needle)) {
                return $branch;
            }
        }

        return $this->normalizeBranchCode($identity);
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

    private function canCreateDepotTransfer(User $user): bool
    {
        $featurePermissions = is_array($user->feature_permissions) ? $user->feature_permissions : [];

        return $user->hasAnyRole(['warehouse', 'point'])
            || in_array('cart.warehouse_transfer', $featurePermissions, true);
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
            $meta = is_array($customer->meta) ? $customer->meta : [];
            if (($meta['system_purpose'] ?? null) === 'warehouse_transfer') {
                return;
            }

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

    private function cartItemLineTotal($item): float
    {
        $storedLineTotal = (float) ($item->line_total ?? 0);
        if ($storedLineTotal > 0) {
            return round($storedLineTotal, 2);
        }

        $quantity = max(1, (int) $item->quantity);
        $unitPrice = round((float) $item->unit_net_price, 2);
        $gross = $unitPrice * $quantity;

        if (
            $item->campaign_key !== null
            && trim((string) $item->campaign_key) !== ''
            && (float) $item->discount_rate <= 0
        ) {
            return round($gross, 2);
        }

        $discountRate = max(0.0, (float) $item->discount_rate);

        return round($gross - ($gross * ($discountRate / 100)), 2);
    }
}
