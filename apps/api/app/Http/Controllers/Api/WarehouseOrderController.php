<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Warehouse\ReadyOrdersRequest;
use App\Http\Resources\Warehouse\ReadyOrderResource;
use App\Models\Order;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;

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
                'customer:id,code,name,salesperson_user_id',
                'customer.salesperson:id,name',
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
                'user:id,name',
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
                        ->orWhere('order_no', 'ilike', "%{$q}%");
                } else {
                    $builder->where('order_no', 'ilike', "%{$q}%");
                }

                $builder->orWhereHas('customer', function (Builder $customerQuery) use ($q): void {
                    $customerQuery
                        ->where('code', 'ilike', "%{$q}%")
                        ->orWhere('name', 'ilike', "%{$q}%");
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
}
