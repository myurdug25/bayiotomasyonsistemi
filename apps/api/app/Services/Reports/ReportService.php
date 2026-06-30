<?php

namespace App\Services\Reports;

use App\Models\Collection as CollectionModel;
use App\Models\Customer;
use App\Models\LedgerEntry;
use App\Models\Order;
use App\Models\User;
use App\Services\Customers\CustomerAccessScopeService;
use Illuminate\Contracts\Pagination\LengthAwarePaginator;
use Illuminate\Database\Eloquent\Builder as EloquentBuilder;
use Illuminate\Database\Query\Builder as QueryBuilder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class ReportService
{
    public function __construct(
        private readonly CustomerAccessScopeService $customerAccessScope
    ) {}

    public const KEY_CUSTOMER_BALANCES = 'customer_balances';

    public const KEY_ORDER_BALANCES = 'order_balances';

    public const KEY_COLLECTIONS = 'collections';

    public const KEY_SALES = 'sales';

    /**
     * @param  array<string, mixed>  $filters
     * @return array<string, mixed>
     */
    public function generate(string $reportKey, array $filters, User $user): array
    {
        return match ($reportKey) {
            self::KEY_CUSTOMER_BALANCES => $this->customerBalances($filters, $user),
            self::KEY_ORDER_BALANCES => $this->orderBalances($filters, $user),
            self::KEY_COLLECTIONS => $this->collections($filters, $user),
            self::KEY_SALES => $this->sales($filters, $user),
            default => throw ValidationException::withMessages([
                'report_key' => ["Unsupported report key: {$reportKey}"],
            ]),
        };
    }

    /**
     * Cari Rapor Durumları: current balance + aging buckets.
     *
     * @param  array<string, mixed>  $filters
     * @return array<string, mixed>
     */
    public function customerBalances(array $filters, User $user): array
    {
        $dealerId = $this->resolveDealerIdOrFail($user, $filters['dealer_id'] ?? null);
        $perPage = min((int) ($filters['per_page'] ?? 25), 100);
        $asOfDate = Carbon::parse((string) ($filters['date_to'] ?? now()->toDateString()))->toDateString();
        $dateCol = DB::connection()->getDriverName() === 'mysql' ? '`date`' : '"date"';
        $entryDateExpr = "COALESCE({$dateCol}, entry_date)";
        $ageDaysSql = $this->ageInDaysSql($entryDateExpr);

        $ledgerAggregate = LedgerEntry::query()
            ->effectiveForCustomerBalance()
            ->select('customer_id')
            ->selectRaw('COALESCE(SUM(COALESCE(debit, 0) - COALESCE(credit, 0)), 0) as balance')
            ->selectRaw("MAX({$entryDateExpr}) as last_movement_date")
            ->selectRaw(
                "COALESCE(SUM(CASE WHEN {$ageDaysSql} BETWEEN 0 AND 30 THEN (COALESCE(debit, 0) - COALESCE(credit, 0)) ELSE 0 END), 0) as aging_0_30",
                [$asOfDate]
            )
            ->selectRaw(
                "COALESCE(SUM(CASE WHEN {$ageDaysSql} BETWEEN 31 AND 60 THEN (COALESCE(debit, 0) - COALESCE(credit, 0)) ELSE 0 END), 0) as aging_31_60",
                [$asOfDate]
            )
            ->selectRaw(
                "COALESCE(SUM(CASE WHEN {$ageDaysSql} >= 61 THEN (COALESCE(debit, 0) - COALESCE(credit, 0)) ELSE 0 END), 0) as aging_60_plus",
                [$asOfDate]
            )
            ->when($dealerId !== null, fn (EloquentBuilder $query) => $query->where('dealer_id', $dealerId))
            ->when(
                ! empty($filters['customer_id']),
                fn (EloquentBuilder $query) => $query->where('customer_id', (int) $filters['customer_id'])
            )
            ->whereRaw("DATE({$entryDateExpr}) <= ?", [$asOfDate])
            ->groupBy('customer_id');

        $query = Customer::query()
            ->select([
                'customers.id',
                'customers.dealer_id',
                'customers.code',
                'customers.name',
                'customers.city',
                'customers.district',
                'customers.phone',
            ])
            ->selectRaw('COALESCE(ledger.balance, 0) as balance')
            ->selectRaw('ledger.last_movement_date as last_movement_date')
            ->selectRaw('COALESCE(ledger.aging_0_30, 0) as aging_0_30')
            ->selectRaw('COALESCE(ledger.aging_31_60, 0) as aging_31_60')
            ->selectRaw('COALESCE(ledger.aging_60_plus, 0) as aging_60_plus')
            ->leftJoinSub($ledgerAggregate, 'ledger', function ($join) {
                $join->on('ledger.customer_id', '=', 'customers.id');
            })
            ->when($dealerId !== null, fn (EloquentBuilder $query) => $query->where('customers.dealer_id', $dealerId))
            ->where('customers.source_system', 'logo')
            ->when(
                ! empty($filters['customer_id']),
                fn (EloquentBuilder $q) => $q->where('customers.id', (int) $filters['customer_id'])
            )
            ->when(! empty($filters['q']), function (EloquentBuilder $q) use ($filters): void {
                $search = trim((string) $filters['q']);
                $q->where(function (EloquentBuilder $inner) use ($search): void {
                    $inner->where('customers.code', 'like', "{$search}%")
                        ->orWhere('customers.name', 'like', "%{$search}%")
                        ->orWhere('customers.phone', 'like', "%{$search}%");
                });
            })
            ->when(
                array_key_exists('has_balance', $filters),
                fn (EloquentBuilder $q) => (bool) $filters['has_balance']
                    ? $q->whereRaw('COALESCE(ledger.balance, 0) <> 0')
                    : $q->whereRaw('COALESCE(ledger.balance, 0) = 0')
            )
            ->when(
                isset($filters['min_balance']),
                fn (EloquentBuilder $q) => $q->whereRaw('COALESCE(ledger.balance, 0) >= ?', [(float) $filters['min_balance']])
            )
            ->when(
                isset($filters['max_balance']),
                fn (EloquentBuilder $q) => $q->whereRaw('COALESCE(ledger.balance, 0) <= ?', [(float) $filters['max_balance']])
            );

        $this->customerAccessScope->applyToCustomerQuery($query, $user, 'customers');

        $summary = $this->summarizeCustomerBalanceQuery($query);
        $paginator = (clone $query)
            ->orderByDesc('balance')
            ->orderBy('customers.id')
            ->paginate($perPage)
            ->withQueryString();

        $data = collect($paginator->items())
            ->map(function ($row): array {
                $aging0_30 = max((float) $row->aging_0_30, 0);
                $aging31_60 = max((float) $row->aging_31_60, 0);
                $aging60Plus = max((float) $row->aging_60_plus, 0);

                return [
                    'customer_id' => (int) $row->id,
                    'dealer_id' => (int) $row->dealer_id,
                    'code' => $row->code,
                    'title' => $row->name,
                    'city' => $row->city,
                    'district' => $row->district,
                    'phone' => $row->phone,
                    'balance' => $this->money($row->balance),
                    'aging' => [
                        '0_30' => $this->money($aging0_30),
                        '31_60' => $this->money($aging31_60),
                        '60_plus' => $this->money($aging60Plus),
                    ],
                    'overdue_total' => $this->money($aging31_60 + $aging60Plus),
                    'last_movement_date' => $row->last_movement_date,
                ];
            })
            ->values();

        return [
            'report' => self::KEY_CUSTOMER_BALANCES,
            'filters' => [
                'dealer_id' => $dealerId,
                'customer_id' => isset($filters['customer_id']) ? (int) $filters['customer_id'] : null,
                'date_to' => $asOfDate,
            ],
            'summary' => $summary,
            'data' => $data,
            'meta' => $this->meta($paginator),
        ];
    }

    /**
     * Sipariş Bakiye Durumları: open orders totals + breakdown.
     *
     * @param  array<string, mixed>  $filters
     * @return array<string, mixed>
     */
    public function orderBalances(array $filters, User $user): array
    {
        $dealerId = $this->resolveDealerIdOrFail($user, $filters['dealer_id'] ?? null);
        $perPage = min((int) ($filters['per_page'] ?? 25), 100);

        $base = $this->buildOpenOrdersBaseQuery($dealerId, $filters, $user);

        $summary = (clone $base)
            ->reorder()
            ->selectRaw('COUNT(*) as open_order_count')
            ->selectRaw('COALESCE(SUM(orders.subtotal), 0) as open_subtotal')
            ->selectRaw('COALESCE(SUM(orders.grand_total), 0) as open_grand_total')
            ->first();

        $statusBreakdown = (clone $base)
            ->reorder()
            ->select('orders.status')
            ->selectRaw('COUNT(*) as order_count')
            ->selectRaw('COALESCE(SUM(orders.grand_total), 0) as total')
            ->groupBy('orders.status')
            ->orderByDesc('total')
            ->get()
            ->map(fn ($row) => [
                'status' => $row->status,
                'order_count' => (int) $row->order_count,
                'total' => $this->money($row->total),
            ])
            ->values();

        $paginator = (clone $base)
            ->select([
                'orders.id',
                'orders.order_no',
                'orders.status',
                'orders.customer_id',
                'customers.code as customer_code',
                'customers.name as customer_title',
                'orders.currency',
                'orders.subtotal',
                'orders.grand_total',
                'orders.ordered_at',
                'logo_order_sync.status as logo_sync_status',
                'logo_order_sync.last_error as logo_sync_error',
                'logo_order_sync.external_ref as logo_external_ref',
                'logo_order_sync.last_synced_at as logo_last_synced_at',
            ])
            ->selectSub(
                DB::table('order_items')
                    ->selectRaw('COALESCE(SUM(quantity), 0)')
                    ->whereColumn('order_items.order_id', 'orders.id'),
                'order_quantity'
            )
            ->selectSub(
                DB::table('order_items')
                    ->selectRaw('COALESCE(SUM(shipped_qty), 0)')
                    ->whereColumn('order_items.order_id', 'orders.id'),
                'shipped_quantity'
            )
            ->selectSub(
                DB::table('order_items')
                    ->selectRaw('COALESCE(SUM(CASE WHEN quantity > COALESCE(shipped_qty, 0) THEN quantity - COALESCE(shipped_qty, 0) ELSE 0 END), 0)')
                    ->whereColumn('order_items.order_id', 'orders.id'),
                'remaining_quantity'
            )
            ->orderByDesc('orders.ordered_at')
            ->orderByDesc('orders.id')
            ->paginate($perPage)
            ->withQueryString();

        $orderIds = collect($paginator->items())->pluck('id')->map(fn ($id) => (int) $id)->values();
        $logoStockByOrder = $this->buildOrderLogoStockSummaries($orderIds);

        $data = collect($paginator->items())
            ->map(function ($row) use ($logoStockByOrder): array {
                $orderId = (int) $row->id;

                return [
                    'order_id' => $orderId,
                    'order_no' => $row->order_no,
                    'status' => $row->status,
                    'customer' => [
                        'id' => (int) $row->customer_id,
                        'code' => $row->customer_code,
                        'title' => $row->customer_title,
                    ],
                    'currency' => $row->currency,
                    'subtotal' => $this->money($row->subtotal),
                    'grand_total' => $this->money($row->grand_total),
                    'order_quantity' => (int) $row->order_quantity,
                    'shipped_quantity' => (int) $row->shipped_quantity,
                    'remaining_quantity' => (int) $row->remaining_quantity,
                    'ordered_at' => $row->ordered_at,
                    'logo_sync_status' => $row->logo_sync_status,
                    'logo_sync_error' => $row->logo_sync_error,
                    'logo_external_ref' => $row->logo_external_ref,
                    'logo_last_synced_at' => $row->logo_last_synced_at,
                    'logo_stock_summary' => $logoStockByOrder->get($orderId, $this->emptyLogoStockSummary()),
                ];
            })
            ->values();

        return [
            'report' => self::KEY_ORDER_BALANCES,
            'filters' => [
                'dealer_id' => $dealerId,
                'date_from' => $filters['date_from'] ?? null,
                'date_to' => $filters['date_to'] ?? null,
                'statuses' => $filters['statuses'] ?? null,
            ],
            'summary' => [
                'open_order_count' => (int) ($summary?->open_order_count ?? 0),
                'open_subtotal' => $this->money($summary?->open_subtotal),
                'open_grand_total' => $this->money($summary?->open_grand_total),
                'logo_stock_missing_count' => $data->sum(
                    fn (array $row): int => (int) data_get($row, 'logo_stock_summary.missing_stock_count', 0)
                ),
                'logo_stock_missing_quantity' => $data->sum(
                    fn (array $row): int => (int) data_get($row, 'logo_stock_summary.missing_quantity', 0)
                ),
            ],
            'status_breakdown' => $statusBreakdown,
            'data' => $data,
            'meta' => $this->meta($paginator),
        ];
    }

    /**
     * @param  Collection<int, int>  $orderIds
     * @return Collection<int, array<string, mixed>>
     */
    private function buildOrderLogoStockSummaries(Collection $orderIds): Collection
    {
        if ($orderIds->isEmpty()) {
            return collect();
        }

        return Order::query()
            ->whereIn('id', $orderIds)
            ->with([
                'items:id,order_id,product_id,quantity',
                'items.product:id',
                'items.product.stockSummary:product_id,available_total,reserved_total,updated_at',
            ])
            ->get()
            ->mapWithKeys(fn (Order $order): array => [
                (int) $order->id => $this->buildOrderLogoStockSummary($order),
            ]);
    }

    /**
     * @return array<string, mixed>
     */
    private function buildOrderLogoStockSummary(Order $order): array
    {
        $requiredByProduct = $order->items
            ->groupBy('product_id')
            ->map(fn ($items): int => (int) $items->sum('quantity'));

        $stockByProduct = $order->items
            ->keyBy('product_id')
            ->map(fn ($item): array => [
                'available_total' => (int) ($item->product?->stockSummary?->available_total ?? 0),
                'updated_at' => $item->product?->stockSummary?->updated_at,
            ]);

        $summary = $this->emptyLogoStockSummary();
        $latestUpdatedAt = null;

        foreach ($requiredByProduct as $productId => $requiredQuantity) {
            $stock = $stockByProduct->get($productId, ['available_total' => 0, 'updated_at' => null]);
            $available = (int) ($stock['available_total'] ?? 0);
            $missing = max(0, $requiredQuantity - $available);

            $summary['total_quantity'] += $requiredQuantity;
            $summary['stock_covered_quantity'] += min($available, $requiredQuantity);
            $summary['missing_quantity'] += $missing;

            if ($available <= 0) {
                $summary['missing_stock_count']++;
            } elseif ($missing > 0) {
                $summary['low_stock_count']++;
            }

            $updatedAt = $stock['updated_at'] ?? null;
            if ($updatedAt instanceof Carbon && ($latestUpdatedAt === null || $updatedAt->gt($latestUpdatedAt))) {
                $latestUpdatedAt = $updatedAt;
            }
        }

        $summary['updated_at'] = $latestUpdatedAt?->toIso8601String();

        return $summary;
    }

    /**
     * @return array<string, mixed>
     */
    private function emptyLogoStockSummary(): array
    {
        return [
            'source' => 'logo',
            'total_quantity' => 0,
            'stock_covered_quantity' => 0,
            'missing_quantity' => 0,
            'low_stock_count' => 0,
            'missing_stock_count' => 0,
            'updated_at' => null,
        ];
    }

    /**
     * Tahsilat Raporu: date range + method breakdown.
     *
     * @param  array<string, mixed>  $filters
     * @return array<string, mixed>
     */
    public function collections(array $filters, User $user): array
    {
        $dealerId = $this->resolveDealerIdOrFail($user, $filters['dealer_id'] ?? null);
        $perPage = min((int) ($filters['per_page'] ?? 25), 100);
        $dateCol = DB::connection()->getDriverName() === 'mysql' ? '`date`' : '"date"';
        $collectionDateExpr = "COALESCE(collections.{$dateCol}, collections.collection_date)";

        $base = CollectionModel::query()
            ->join('customers', 'customers.id', '=', 'collections.customer_id')
            ->when($dealerId !== null, fn (EloquentBuilder $query) => $query->where('collections.dealer_id', $dealerId))
            ->where('customers.source_system', 'logo')
            ->when(
                ! empty($filters['date_from']),
                fn (EloquentBuilder $q) => $q->whereRaw("DATE({$collectionDateExpr}) >= ?", [$filters['date_from']])
            )
            ->when(
                ! empty($filters['date_to']),
                fn (EloquentBuilder $q) => $q->whereRaw("DATE({$collectionDateExpr}) <= ?", [$filters['date_to']])
            )
            ->when(
                ! empty($filters['method']),
                fn (EloquentBuilder $q) => $q->where('collections.method', (string) $filters['method'])
            )
            ->when(
                ! empty($filters['customer_id']),
                fn (EloquentBuilder $q) => $q->where('collections.customer_id', (int) $filters['customer_id'])
            );

        $this->customerAccessScope->applyToCustomerOwnedQuery($base, $user, 'collections.customer_id');

        $summary = (clone $base)
            ->reorder()
            ->selectRaw('COUNT(*) as collection_count')
            ->selectRaw('COALESCE(SUM(collections.amount), 0) as collection_total')
            ->first();

        $methodBreakdown = (clone $base)
            ->reorder()
            ->select('collections.method')
            ->selectRaw('COUNT(*) as collection_count')
            ->selectRaw('COALESCE(SUM(collections.amount), 0) as total')
            ->groupBy('collections.method')
            ->orderByDesc('total')
            ->get()
            ->keyBy('method');

        $methods = collect(['cash', 'transfer', 'check', 'note', 'cc'])
            ->map(function (string $method) use ($methodBreakdown): array {
                $row = $methodBreakdown->get($method);

                return [
                    'method' => $method,
                    'collection_count' => (int) ($row?->collection_count ?? 0),
                    'total' => $this->money($row?->total),
                ];
            })
            ->values();

        $dailyBreakdown = (clone $base)
            ->reorder()
            ->selectRaw("DATE({$collectionDateExpr}) as report_date")
            ->selectRaw('COUNT(*) as collection_count')
            ->selectRaw('COALESCE(SUM(collections.amount), 0) as total')
            ->groupBy('report_date')
            ->orderBy('report_date')
            ->get()
            ->map(fn ($row) => [
                'date' => $row->report_date,
                'collection_count' => (int) $row->collection_count,
                'total' => $this->money($row->total),
            ])
            ->values();

        $paginator = (clone $base)
            ->select([
                'collections.id',
                'collections.customer_id',
                'customers.code as customer_code',
                'customers.name as customer_title',
                'collections.method',
                'collections.currency',
                'collections.amount',
                'collections.reference_no',
                'collections.note',
            ])
            ->selectRaw("DATE({$collectionDateExpr}) as collection_date")
            ->orderByRaw("{$collectionDateExpr} DESC")
            ->orderByDesc('collections.id')
            ->paginate($perPage)
            ->withQueryString();

        $data = collect($paginator->items())
            ->map(fn ($row) => [
                'collection_id' => (int) $row->id,
                'customer' => [
                    'id' => (int) $row->customer_id,
                    'code' => $row->customer_code,
                    'title' => $row->customer_title,
                ],
                'date' => $row->collection_date,
                'method' => $row->method,
                'currency' => $row->currency,
                'amount' => $this->money($row->amount),
                'reference_no' => $row->reference_no,
                'note' => $row->note,
            ])
            ->values();

        return [
            'report' => self::KEY_COLLECTIONS,
            'filters' => [
                'dealer_id' => $dealerId,
                'date_from' => $filters['date_from'] ?? null,
                'date_to' => $filters['date_to'] ?? null,
                'method' => $filters['method'] ?? null,
            ],
            'summary' => [
                'collection_count' => (int) ($summary?->collection_count ?? 0),
                'collection_total' => $this->money($summary?->collection_total),
            ],
            'method_breakdown' => $methods,
            'daily_breakdown' => $dailyBreakdown,
            'data' => $data,
            'meta' => $this->meta($paginator),
        ];
    }

    /**
     * Satış Raporu: date range + product/brand/customer breakdown.
     *
     * @param  array<string, mixed>  $filters
     * @return array<string, mixed>
     */
    public function sales(array $filters, User $user): array
    {
        $dealerId = $this->resolveDealerIdOrFail($user, $filters['dealer_id'] ?? null);
        $perPage = min((int) ($filters['per_page'] ?? 25), 100);
        $breakdown = (string) ($filters['breakdown'] ?? 'product');

        $base = DB::table('order_items as oi')
            ->join('orders', 'orders.id', '=', 'oi.order_id')
            ->join('products', 'products.id', '=', 'oi.product_id')
            ->leftJoin('brands', 'brands.id', '=', 'products.brand_id')
            ->join('customers', 'customers.id', '=', 'orders.customer_id')
            ->when($dealerId !== null, fn (QueryBuilder $query) => $query->where('orders.dealer_id', $dealerId))
            ->where('customers.source_system', 'logo')
            ->when(
                ! empty($filters['customer_id']),
                fn (QueryBuilder $q) => $q->where('orders.customer_id', (int) $filters['customer_id'])
            )
            ->when(
                ! empty($filters['date_from']),
                fn (QueryBuilder $q) => $q->whereDate('orders.ordered_at', '>=', (string) $filters['date_from'])
            )
            ->when(
                ! empty($filters['date_to']),
                fn (QueryBuilder $q) => $q->whereDate('orders.ordered_at', '<=', (string) $filters['date_to'])
            );

        $this->customerAccessScope->applyToCustomerOwnedQuery($base, $user, 'orders.customer_id');

        if (! empty($filters['statuses']) && is_array($filters['statuses'])) {
            $base->whereIn('orders.status', $filters['statuses']);
        } else {
            $base->whereRaw('LOWER(orders.status) <> ?', ['cancelled']);
        }

        $summary = (clone $base)
            ->selectRaw('COUNT(DISTINCT orders.id) as order_count')
            ->selectRaw('COALESCE(SUM(oi.quantity), 0) as quantity_total')
            ->selectRaw('COALESCE(SUM(oi.line_total), 0) as net_total')
            ->selectRaw('COALESCE(SUM((oi.line_total * oi.tax_rate) / 100), 0) as tax_total')
            ->first();

        $breakdownQuery = match ($breakdown) {
            'brand' => $this->brandSalesBreakdownQuery($base, $filters),
            'customer' => $this->customerSalesBreakdownQuery($base, $filters),
            default => $this->productSalesBreakdownQuery($base, $filters),
        };

        $paginator = $breakdownQuery
            ->orderByDesc('net_total')
            ->paginate($perPage)
            ->withQueryString();

        $data = collect($paginator->items())
            ->map(function ($row) use ($breakdown): array {
                if ($breakdown === 'brand') {
                    return [
                        'brand' => [
                            'id' => $row->brand_id !== null ? (int) $row->brand_id : null,
                            'name' => $row->brand_name,
                        ],
                        'order_count' => (int) $row->order_count,
                        'quantity_total' => (int) $row->quantity_total,
                        'net_total' => $this->money($row->net_total),
                        'tax_total' => $this->money($row->tax_total),
                    ];
                }

                if ($breakdown === 'customer') {
                    return [
                        'customer' => [
                            'id' => (int) $row->customer_id,
                            'code' => $row->customer_code,
                            'title' => $row->customer_title,
                        ],
                        'order_count' => (int) $row->order_count,
                        'quantity_total' => (int) $row->quantity_total,
                        'net_total' => $this->money($row->net_total),
                        'tax_total' => $this->money($row->tax_total),
                    ];
                }

                return [
                    'product' => [
                        'id' => (int) $row->product_id,
                        'sku' => $row->sku,
                        'oem' => $row->oem_code,
                        'name' => $row->product_name,
                        'brand' => $row->brand_name,
                    ],
                    'order_count' => (int) $row->order_count,
                    'quantity_total' => (int) $row->quantity_total,
                    'net_total' => $this->money($row->net_total),
                    'tax_total' => $this->money($row->tax_total),
                ];
            })
            ->values();

        return [
            'report' => self::KEY_SALES,
            'filters' => [
                'dealer_id' => $dealerId,
                'customer_id' => isset($filters['customer_id']) ? (int) $filters['customer_id'] : null,
                'date_from' => $filters['date_from'] ?? null,
                'date_to' => $filters['date_to'] ?? null,
                'breakdown' => $breakdown,
                'statuses' => $filters['statuses'] ?? null,
            ],
            'summary' => [
                'order_count' => (int) ($summary?->order_count ?? 0),
                'quantity_total' => (int) ($summary?->quantity_total ?? 0),
                'net_total' => $this->money($summary?->net_total),
                'tax_total' => $this->money($summary?->tax_total),
            ],
            'data' => $data,
            'meta' => $this->meta($paginator),
        ];
    }

    /**
     * @param  array<string, mixed>  $filters
     */
    private function buildOpenOrdersBaseQuery(?int $dealerId, array $filters, User $user): EloquentBuilder
    {
        $closedStatuses = (array) config('reports.order_closed_statuses', ['completed', 'cancelled', 'delivered']);
        $lowerClosed = collect($closedStatuses)->map(fn ($status) => strtolower((string) $status))->values()->all();

        $query = Order::query()
            ->join('customers', 'customers.id', '=', 'orders.customer_id')
            ->leftJoin('integration_sync_states as logo_order_sync', function ($join): void {
                $join->on('logo_order_sync.entity_id', '=', 'orders.id')
                    ->where('logo_order_sync.system', 'logo')
                    ->where('logo_order_sync.domain', 'orders')
                    ->where('logo_order_sync.direction', 'outbound')
                    ->where('logo_order_sync.entity_type', Order::class);
            })
            ->when($dealerId !== null, fn (EloquentBuilder $query) => $query->where('orders.dealer_id', $dealerId))
            ->where('customers.source_system', 'logo')
            ->when(
                ! empty($filters['date_from']),
                fn (EloquentBuilder $q) => $q->whereDate('orders.ordered_at', '>=', (string) $filters['date_from'])
            )
            ->when(
                ! empty($filters['date_to']),
                fn (EloquentBuilder $q) => $q->whereDate('orders.ordered_at', '<=', (string) $filters['date_to'])
            )
            ->when(
                ! empty($filters['customer_id']),
                fn (EloquentBuilder $q) => $q->where('orders.customer_id', (int) $filters['customer_id'])
            )
            ->when(
                ! empty($filters['q']),
                function (EloquentBuilder $q) use ($filters): void {
                    $search = trim((string) $filters['q']);
                    $q->where(function (EloquentBuilder $inner) use ($search): void {
                        $inner->where('orders.order_no', 'like', "%{$search}%")
                            ->orWhere('customers.code', 'like', "{$search}%")
                            ->orWhere('customers.name', 'like', "%{$search}%");
                    });
                }
            );

        $this->customerAccessScope->applyToCustomerOwnedQuery($query, $user, 'orders.customer_id');

        $statuses = collect(is_array($filters['statuses'] ?? null) ? $filters['statuses'] : [])
            ->map(fn ($status) => strtolower(trim((string) $status)))
            ->filter()
            ->values();
        $balanceFilterEnabled = $statuses->contains('balance');
        $statusFilters = $statuses
            ->reject(fn (string $status): bool => $status === 'balance')
            ->values()
            ->all();

        if ($statusFilters !== []) {
            $query->whereIn('orders.status', $statusFilters);
        } elseif ($lowerClosed !== []) {
            $placeholders = implode(', ', array_fill(0, count($lowerClosed), '?'));
            $query->whereRaw("LOWER(orders.status) NOT IN ({$placeholders})", $lowerClosed);
        }

        if ($balanceFilterEnabled) {
            $query->whereHas('items', function (EloquentBuilder $itemQuery): void {
                $itemQuery->whereColumn('order_items.quantity', '>', 'order_items.shipped_qty');
            });
        }

        return $query;
    }

    /**
     * @param  array<string, mixed>  $filters
     */
    private function productSalesBreakdownQuery(QueryBuilder $base, array $filters): QueryBuilder
    {
        return (clone $base)
            ->when(
                ! empty($filters['q']),
                function (QueryBuilder $q) use ($filters): void {
                    $search = trim((string) $filters['q']);
                    $q->where(function (QueryBuilder $inner) use ($search): void {
                        $inner->where('products.sku', 'like', "%{$search}%")
                            ->orWhere('products.oem_code', 'like', "%{$search}%")
                            ->orWhere('products.name', 'like', "%{$search}%");
                    });
                }
            )
            ->select([
                'products.id as product_id',
                'products.sku',
                'products.oem_code',
                'products.name as product_name',
                'brands.name as brand_name',
            ])
            ->selectRaw('COUNT(DISTINCT orders.id) as order_count')
            ->selectRaw('COALESCE(SUM(oi.quantity), 0) as quantity_total')
            ->selectRaw('COALESCE(SUM(oi.line_total), 0) as net_total')
            ->selectRaw('COALESCE(SUM((oi.line_total * oi.tax_rate) / 100), 0) as tax_total')
            ->groupBy('products.id', 'products.sku', 'products.oem_code', 'products.name', 'brands.name');
    }

    /**
     * @param  array<string, mixed>  $filters
     */
    private function brandSalesBreakdownQuery(QueryBuilder $base, array $filters): QueryBuilder
    {
        return (clone $base)
            ->when(
                ! empty($filters['q']),
                fn (QueryBuilder $q) => $q->where('brands.name', 'like', '%'.trim((string) $filters['q']).'%')
            )
            ->select([
                'brands.id as brand_id',
                'brands.name as brand_name',
            ])
            ->selectRaw('COUNT(DISTINCT orders.id) as order_count')
            ->selectRaw('COALESCE(SUM(oi.quantity), 0) as quantity_total')
            ->selectRaw('COALESCE(SUM(oi.line_total), 0) as net_total')
            ->selectRaw('COALESCE(SUM((oi.line_total * oi.tax_rate) / 100), 0) as tax_total')
            ->groupBy('brands.id', 'brands.name');
    }

    /**
     * @param  array<string, mixed>  $filters
     */
    private function customerSalesBreakdownQuery(QueryBuilder $base, array $filters): QueryBuilder
    {
        return (clone $base)
            ->when(
                ! empty($filters['q']),
                function (QueryBuilder $q) use ($filters): void {
                    $search = trim((string) $filters['q']);
                    $q->where(function (QueryBuilder $inner) use ($search): void {
                        $inner->where('customers.code', 'like', "{$search}%")
                            ->orWhere('customers.name', 'like', "%{$search}%");
                    });
                }
            )
            ->select([
                'customers.id as customer_id',
                'customers.code as customer_code',
                'customers.name as customer_title',
            ])
            ->selectRaw('COUNT(DISTINCT orders.id) as order_count')
            ->selectRaw('COALESCE(SUM(oi.quantity), 0) as quantity_total')
            ->selectRaw('COALESCE(SUM(oi.line_total), 0) as net_total')
            ->selectRaw('COALESCE(SUM((oi.line_total * oi.tax_rate) / 100), 0) as tax_total')
            ->groupBy('customers.id', 'customers.code', 'customers.name');
    }

    private function summarizeCustomerBalanceQuery(EloquentBuilder $baseQuery): array
    {
        $summaryQuery = clone $baseQuery;
        $summaryQuery->reorder();

        $row = DB::query()
            ->fromSub($summaryQuery->toBase(), 'rows')
            ->selectRaw('COUNT(*) as customer_count')
            ->selectRaw('COALESCE(SUM(balance), 0) as balance_total')
            ->selectRaw('COALESCE(SUM(CASE WHEN aging_0_30 > 0 THEN aging_0_30 ELSE 0 END), 0) as aging_0_30_total')
            ->selectRaw('COALESCE(SUM(CASE WHEN aging_31_60 > 0 THEN aging_31_60 ELSE 0 END), 0) as aging_31_60_total')
            ->selectRaw('COALESCE(SUM(CASE WHEN aging_60_plus > 0 THEN aging_60_plus ELSE 0 END), 0) as aging_60_plus_total')
            ->first();

        return [
            'customer_count' => (int) ($row?->customer_count ?? 0),
            'balance_total' => $this->money($row?->balance_total),
            'aging_totals' => [
                '0_30' => $this->money($row?->aging_0_30_total),
                '31_60' => $this->money($row?->aging_31_60_total),
                '60_plus' => $this->money($row?->aging_60_plus_total),
            ],
        ];
    }

    private function ageInDaysSql(string $dateExpr): string
    {
        $driver = DB::connection()->getDriverName();

        if ($driver === 'sqlite') {
            return "CAST((julianday(?) - julianday(DATE({$dateExpr}))) AS INTEGER)";
        }

        if ($driver === 'pgsql') {
            return "CAST(? AS DATE) - DATE({$dateExpr})";
        }

        return "DATEDIFF(?, {$dateExpr})";
    }

    /**
     * @param  int|string|null  $requestedDealerId
     */
    private function resolveDealerIdOrFail(User $user, $requestedDealerId): ?int
    {
        if ($user->dealer_id !== null) {
            return (int) $user->dealer_id;
        }

        if ($user->hasRole('admin')) {
            if ($requestedDealerId !== null && $requestedDealerId !== '') {
                return (int) $requestedDealerId;
            }

            if ($user->selected_customer_id !== null) {
                $dealerId = Customer::query()
                    ->whereKey((int) $user->selected_customer_id)
                    ->value('dealer_id');

                if ($dealerId !== null) {
                    return (int) $dealerId;
                }
            }

            return null;
        }

        throw ValidationException::withMessages([
            'dealer_id' => ['dealer_id is required for users without assigned dealer context.'],
        ]);
    }

    private function money(mixed $value): string
    {
        return number_format((float) ($value ?? 0), 2, '.', '');
    }

    /**
     * @return array<string, int|null>
     */
    private function meta(LengthAwarePaginator $paginator): array
    {
        return [
            'current_page' => $paginator->currentPage(),
            'last_page' => $paginator->lastPage(),
            'per_page' => $paginator->perPage(),
            'total' => $paginator->total(),
        ];
    }
}
