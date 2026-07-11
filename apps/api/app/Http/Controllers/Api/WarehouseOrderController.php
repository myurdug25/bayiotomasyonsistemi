<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Warehouse\ReadyOrdersRequest;
use App\Http\Resources\Warehouse\ReadyOrderResource;
use App\Models\Order;
use App\Models\StockSummary;
use App\Support\Warehouse\WarehouseBranchResolver;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class WarehouseOrderController extends Controller
{
    public function ready(ReadyOrdersRequest $request): JsonResponse
    {
        $user = $request->user();
        $validated = $request->validated();
        $limit = min((int) ($validated['limit'] ?? 25), 50);
        $q = trim((string) ($validated['q'] ?? ''));

        $query = Order::query()
            ->with([
                'cart:id,shipping_method,is_warehouse_transfer,note,order_note',
                'customer:id,code,name,salesperson_user_id,branch_code,branch_name',
                'customer.salesperson:id,name,username,email,branch_code,branch_name',
                'ledgerEntries' => fn ($ledgerQuery) => $ledgerQuery
                    ->select([
                        'id',
                        'order_id',
                        'type',
                        'reference_no',
                        'description',
                        'created_by_user_id',
                        'meta',
                        'created_at',
                    ])
                    ->where('type', 'invoice')
                    ->orderByDesc('id'),
                'ledgerEntries.createdBy:id,name',
                'items:id,order_id,product_id,quantity,shipped_qty',
                'items.product:id,sku,name,meta',
                'items.product.stockSummary:product_id,available_total,reserved_total,updated_at',
                'latestActiveShipment' => fn ($shipmentQuery) => $shipmentQuery
                    ->select(['shipments.id', 'shipments.order_id', 'shipments.status']),
                'user:id,name,username,email,branch_code,branch_name',
                'user.roles:id,slug,name',
            ])
            ->select([
                'id',
                'order_no',
                'dealer_id',
                'customer_id',
                'user_id',
                'cart_id',
                'status',
                'currency',
                'grand_total',
                'ordered_at',
                'approved_at',
                'note',
                'created_at',
            ])
            ->whereIn('status', ['approved', 'picking', 'packed']);

        if (! $user->hasRole('admin')) {
            $query->where('dealer_id', $user->dealer_id);
        } elseif (! empty($validated['dealer_id'])) {
            $query->where('dealer_id', (int) $validated['dealer_id']);
        }

        if ($user->hasRole('warehouse') && ! $user->hasRole('admin')) {
            $targetWarehouse = app(WarehouseBranchResolver::class)->targetWarehouse($user);
            $targetWarehouseCode = trim((string) ($targetWarehouse['code'] ?? ''));

            if (in_array($targetWarehouseCode, ['1', '2', '3'], true)) {
                $this->applyReadyOrderWarehouseScope($query, $targetWarehouseCode);
            }
        }

        if (! empty($validated['customer_id'])) {
            $query->where('customer_id', (int) $validated['customer_id']);
        }

        if (! empty($validated['salesperson_user_id'])) {
            $salespersonUserId = (int) $validated['salesperson_user_id'];

            $query->where(function (Builder $builder) use ($salespersonUserId): void {
                $builder
                    ->whereHas('customer', function (Builder $customerQuery) use ($salespersonUserId): void {
                        $customerQuery->where('salesperson_user_id', $salespersonUserId);
                    })
                    ->orWhereHas('user', function (Builder $userQuery) use ($salespersonUserId): void {
                        $userQuery
                            ->where('id', $salespersonUserId)
                            ->whereHas('roles', function (Builder $roleQuery): void {
                                $roleQuery->where('slug', 'salesperson');
                            });
                    });
            });
        }

        if (! empty($validated['date'])) {
            $query->whereDate('approved_at', (string) $validated['date']);
        } else {
            if (! empty($validated['date_from'])) {
                $query->whereDate('approved_at', '>=', (string) $validated['date_from']);
            }

            if (! empty($validated['date_to'])) {
                $query->whereDate('approved_at', '<=', (string) $validated['date_to']);
            }
        }

        if ($q !== '') {
            $query->where(function (Builder $builder) use ($q): void {
                if (ctype_digit($q)) {
                    $builder->whereKey((int) $q)
                        ->orWhereLike('order_no', "%{$q}%", caseSensitive: false);
                } else {
                    $builder->whereLike('order_no', "%{$q}%", caseSensitive: false);
                }

                $builder->orWhereHas('customer', function (Builder $customerQuery) use ($q): void {
                    $customerQuery
                        ->whereLike('code', "%{$q}%", caseSensitive: false)
                        ->orWhereLike('name', "%{$q}%", caseSensitive: false);
                });
            });
        }

        $orders = $query
            ->orderByDesc('approved_at')
            ->orderByDesc('id')
            ->cursorPaginate(
                perPage: $limit,
                columns: ['*'],
                cursorName: 'cursor',
                cursor: $validated['cursor'] ?? null
            );

        return response()->json([
            'data' => ReadyOrderResource::collection(collect($orders->items()))->resolve(),
            'next_cursor' => $orders->nextCursor()?->encode(),
            'prev_cursor' => $orders->previousCursor()?->encode(),
            'limit' => $limit,
        ]);
    }

    public function bulkCancel(Request $request): JsonResponse
    {
        $user = $request->user();
        $validated = $request->validate([
            'order_ids' => ['required', 'array', 'min:1', 'max:100'],
            'order_ids.*' => ['integer', 'min:1'],
        ]);

        $orderIds = collect($validated['order_ids'])
            ->map(fn ($id): int => (int) $id)
            ->unique()
            ->values();

        $cancelled = DB::transaction(function () use ($orderIds, $user): int {
            $orders = Order::query()
                ->with(['items:id,order_id,product_id,quantity,shipped_qty'])
                ->whereIn('id', $orderIds)
                ->whereIn('status', ['approved', 'picking', 'packed'])
                ->lockForUpdate()
                ->get();

            if (! $user->hasRole('admin')) {
                $orders = $orders->filter(fn (Order $order): bool => (int) $order->dealer_id === (int) $user->dealer_id)->values();
            }

            if ($orders->isEmpty()) {
                throw ValidationException::withMessages([
                    'order_ids' => ['Silinebilir sevkiyat siparişi bulunamadı.'],
                ]);
            }

            $stockSummaries = StockSummary::query()
                ->whereIn('product_id', $orders->flatMap->items->pluck('product_id')->unique()->values())
                ->lockForUpdate()
                ->get()
                ->keyBy('product_id');

            foreach ($orders as $order) {
                foreach ($order->items as $item) {
                    $stock = $stockSummaries->get($item->product_id);
                    if (! $stock instanceof StockSummary) {
                        continue;
                    }

                    $reservedQuantity = max(0, (int) $item->quantity - (int) $item->shipped_qty);
                    if ($reservedQuantity <= 0) {
                        continue;
                    }

                    $stock->reserved_total = max(0, (int) $stock->reserved_total - $reservedQuantity);
                    $stock->updated_at = now();
                    $stock->save();
                }

                $order->status = 'cancelled';
                $order->save();
            }

            return $orders->count();
        });

        return response()->json([
            'message' => "{$cancelled} sipariş silindi.",
            'cancelled' => $cancelled,
        ]);
    }

    private function applyReadyOrderWarehouseScope(Builder $query, string $warehouseCode): void
    {
        $query->where(function (Builder $builder) use ($warehouseCode): void {
            if ($warehouseCode === '1') {
                $this->whereOrderBranch($builder, ['ERZURUM']);
                $builder->orWhere(function (Builder $cargoBuilder): void {
                    $this->whereShippingMethod($cargoBuilder, 'kargo');
                    $this->whereOrderBranch($cargoBuilder, ['TRABZON', 'SAMSUN']);
                });

                return;
            }

            if ($warehouseCode === '2') {
                $this->whereOrderBranch($builder, ['TRABZON']);
                $this->whereNotShippingMethod($builder, 'kargo');

                return;
            }

            if ($warehouseCode === '3') {
                $this->whereOrderBranch($builder, ['SAMSUN']);
                $this->whereNotShippingMethod($builder, 'kargo');
            }
        });
    }

    /**
     * Customer salesperson is authoritative. If a customer has no salesperson,
     * fall back to the user who created the order when that user is a salesperson.
     *
     * @param  list<string>  $branches
     */
    private function whereOrderBranch(Builder $query, array $branches): void
    {
        $query->where(function (Builder $branchBuilder) use ($branches): void {
            $branchBuilder
                ->whereHas('customer.salesperson', function (Builder $salespersonQuery) use ($branches): void {
                    $this->whereUserBranch($salespersonQuery, $branches);
                })
                ->orWhere(function (Builder $fallbackBuilder) use ($branches): void {
                    $fallbackBuilder
                        ->where(function (Builder $missingSalespersonQuery): void {
                            $missingSalespersonQuery
                                ->whereDoesntHave('customer')
                                ->orWhereHas('customer', function (Builder $customerQuery): void {
                                    $customerQuery->whereNull('salesperson_user_id');
                                });
                        })
                        ->whereHas('user', function (Builder $userQuery) use ($branches): void {
                            $userQuery
                                ->whereHas('roles', fn (Builder $roleQuery): Builder => $roleQuery->where('slug', 'salesperson'));
                            $this->whereUserBranch($userQuery, $branches);
                        });
                });
        });
    }

    /**
     * @param  list<string>  $branches
     */
    private function whereUserBranch(Builder $query, array $branches): void
    {
        $branchNeedles = collect($branches)
            ->map(fn (string $branch): string => mb_strtolower($branch, 'UTF-8'))
            ->values()
            ->all();

        $explicitUsernames = [
            'ERZURUM' => ['ahmet.arac', 'erzurum.merkez', 'mudur.erzurum', 'erz.depo', 'erzurum.depo'],
            'TRABZON' => ['trabzon.point', 'trabzon.depo'],
            'SAMSUN' => ['samsun.point', 'samsun.depo'],
        ];

        $usernames = collect($branches)
            ->flatMap(fn (string $branch): array => $explicitUsernames[$branch] ?? [])
            ->values()
            ->all();

        $query->where(function (Builder $userBranchQuery) use ($branchNeedles, $usernames): void {
            foreach ($branchNeedles as $needle) {
                $userBranchQuery
                    ->orWhereRaw('LOWER(COALESCE(branch_code, ?)) LIKE ?', ['', "%{$needle}%"])
                    ->orWhereRaw('LOWER(COALESCE(branch_name, ?)) LIKE ?', ['', "%{$needle}%"]);
            }

            if ($usernames !== []) {
                $userBranchQuery->orWhereIn('username', $usernames);
            }
        });
    }

    private function whereShippingMethod(Builder $query, string $method): void
    {
        $query->whereHas('cart', function (Builder $cartQuery) use ($method): void {
            $cartQuery->whereRaw('LOWER(COALESCE(shipping_method, ?)) = ?', ['', mb_strtolower($method, 'UTF-8')]);
        });
    }

    private function whereNotShippingMethod(Builder $query, string $method): void
    {
        $query->where(function (Builder $methodQuery) use ($method): void {
            $methodQuery
                ->whereDoesntHave('cart')
                ->orWhereHas('cart', function (Builder $cartQuery) use ($method): void {
                    $cartQuery->whereRaw('LOWER(COALESCE(shipping_method, ?)) <> ?', ['', mb_strtolower($method, 'UTF-8')]);
                });
        });
    }
}
