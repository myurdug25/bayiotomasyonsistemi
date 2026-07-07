<?php

namespace App\Services\Pos;

use App\Models\Collection;
use App\Models\IntegrationSyncState;
use App\Models\PosExpense;
use App\Models\PosPayment;
use App\Models\PosSale;
use App\Models\PosSession;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\DB;

class DayEndReportService
{
    public function __construct(private readonly PosExpenseService $posExpenseService) {}

    /**
     * @param  array<string, mixed>  $filters
     * @return array<string, mixed>
     */
    public function build(User $user, array $filters): array
    {
        return DB::transaction(function () use ($user, $filters): array {
            $salesBaseQuery = PosSale::query();
            $this->applySaleFilters($salesBaseQuery, $user, $filters);

            $expenseBaseQuery = PosExpense::query();
            $this->posExpenseService->applyFilters($expenseBaseQuery, $user, $filters);

            $paidSalesQuery = (clone $salesBaseQuery)->where('status', 'paid');
            $cancelledSalesQuery = (clone $salesBaseQuery)->where('status', 'cancelled');

            $paidCount = (clone $paidSalesQuery)->count();
            $cancelledCount = (clone $cancelledSalesQuery)->count();

            $vatTotalPaid = (float) ((clone $paidSalesQuery)->sum('vat_total') ?? 0);
            $vatTotalCancelled = (float) ((clone $cancelledSalesQuery)->sum('vat_total') ?? 0);
            $grandTotalPaid = (float) ((clone $paidSalesQuery)->sum('grand_total') ?? 0);
            $grandTotalCancelled = (float) ((clone $cancelledSalesQuery)->sum('grand_total') ?? 0);

            $documentRows = (clone $paidSalesQuery)
                ->selectRaw('document_type, COUNT(*) as total_count')
                ->groupBy('document_type')
                ->pluck('total_count', 'document_type');

            $paymentsByMethodRows = PosPayment::query()
                ->selectRaw('method, COUNT(*) as payment_count, COALESCE(SUM(amount), 0) as total_amount')
                ->whereHas('posSale', function (Builder $query) use ($user, $filters) {
                    $this->applySaleFilters($query, $user, $filters);
                    $query->where('status', 'paid');
                })
                ->groupBy('method')
                ->get()
                ->keyBy('method');

            $manualCollectionsQuery = Collection::query();
            $this->applyPointCollectionFilters($manualCollectionsQuery, $user, $filters);

            $manualCollectionRows = (clone $manualCollectionsQuery)
                ->get(['method', 'amount', 'reference_fields'])
                ->groupBy(fn (Collection $collection): string => $this->resolveCollectionReportBucket($collection))
                ->map(fn ($items): object => (object) [
                    'payment_count' => $items->count(),
                    'total_amount' => $items->sum(fn (Collection $collection): float => (float) $collection->amount),
                ]);

            $recentPaidSaleModels = (clone $paidSalesQuery)
                ->with([
                    'customer:id,code,name',
                    'payments:id,pos_sale_id,method,amount',
                    'createdBy:id,name',
                    'createdBy.roles:id,slug',
                    'posSession.cashbox:id,code,name',
                    'items.product:id,sku,name,meta',
                ])
                ->latest('id')
                ->limit(80)
                ->get();
            $saleRows = $recentPaidSaleModels
                ->map(function (PosSale $sale): array {
                    $primaryPayment = $sale->payments
                        ->sortByDesc(fn (PosPayment $payment): float => (float) $payment->amount)
                        ->first();
                    $paymentMethod = in_array((string) $sale->sale_type, ['cash', 'card', 'transfer'], true)
                        ? (string) $sale->sale_type
                        : (string) ($primaryPayment?->method ?? 'cash');
                    $createdByRoleSlugs = $sale->createdBy?->roles
                        ->pluck('slug')
                        ->map(fn ($slug): string => (string) $slug)
                        ->values()
                        ->all() ?? [];
                    $isWarehouseSale = in_array('warehouse', $createdByRoleSlugs, true);
                    $dayEndBucket = $this->resolveSaleReportBucket(
                        sale: $sale,
                        paymentMethod: $paymentMethod,
                        createdByRoleSlugs: $createdByRoleSlugs,
                        isWarehouseSale: $isWarehouseSale
                    );

                    return [
                        'id' => $sale->id,
                        'receipt_no' => $sale->receipt_no,
                        'customer_code' => $sale->customer?->code,
                        'customer_name' => $sale->customer?->name,
                        'sale_type' => $sale->sale_type,
                        'document_type' => $sale->document_type,
                        'payment_method' => $paymentMethod,
                        'day_end_bucket' => $dayEndBucket,
                        'is_warehouse_sale' => $isWarehouseSale,
                        'grand_total' => number_format((float) $sale->grand_total, 2, '.', ''),
                        'created_by_name' => $sale->createdBy?->name,
                        'warehouse_name' => $this->saleWarehouseName($sale),
                        'items' => $sale->items
                            ->map(fn ($item): array => [
                                'product_code' => $item->product?->sku,
                                'product_name' => $item->product?->name,
                                'quantity' => number_format((float) $item->qty, 3, '.', ''),
                                'unit_price' => number_format((float) $item->unit_price, 2, '.', ''),
                                'line_total' => number_format((float) $item->line_total, 2, '.', ''),
                                'warehouse_name' => $this->saleWarehouseName($sale),
                            ])
                            ->values()
                            ->all(),
                        'created_at' => $sale->created_at?->toIso8601String(),
                    ];
                })
                ->values();
            $normalSaleRows = $saleRows
                ->filter(
                    fn (array $row): bool => (string) ($row['day_end_bucket'] ?? 'normal') === 'normal'
                )
                ->values();
            $cashSaleRows = $saleRows
                ->filter(
                    fn (array $row): bool => (string) ($row['day_end_bucket'] ?? '') === 'cash'
                )
                ->values();
            $cardSaleRows = $saleRows
                ->filter(
                    fn (array $row): bool => (string) ($row['day_end_bucket'] ?? '') === 'card'
                )
                ->values();

            $recentCollectionRows = (clone $manualCollectionsQuery)
                ->with(['customer:id,code,name'])
                ->latest('id')
                ->limit(80)
                ->get()
                ->map(function (Collection $collection): array {
                    return [
                        'id' => $collection->id,
                        'reference_no' => $collection->reference_no,
                        'customer_code' => $collection->customer?->code,
                        'customer_name' => $collection->customer?->name,
                        'method' => $collection->method,
                        'collection_channel' => data_get($collection->reference_fields, 'collection_channel'),
                        'day_end_bucket' => $this->resolveCollectionReportBucket($collection),
                        'amount' => number_format((float) $collection->amount, 2, '.', ''),
                        'date' => optional($collection->date ?? $collection->collection_date)->toDateString(),
                        'created_at' => $collection->created_at?->toIso8601String(),
                    ];
                })
                ->values();

            $totalsByMethod = collect(['cash', 'card', 'transfer', 'check', 'note', 'factory_cc'])
                ->map(function (string $method) use ($paymentsByMethodRows, $manualCollectionRows): array {
                    $paymentRow = in_array($method, ['cash', 'card', 'transfer'], true)
                        ? $paymentsByMethodRows->get($method)
                        : null;
                    $collectionRow = $manualCollectionRows->get($method);

                    return [
                        'method' => $method,
                        'payment_count' => (int) ($paymentRow?->payment_count ?? 0) + (int) ($collectionRow?->payment_count ?? 0),
                        'total_amount' => number_format(
                            (float) ($paymentRow?->total_amount ?? 0) + (float) ($collectionRow?->total_amount ?? 0),
                            2,
                            '.',
                            ''
                        ),
                    ];
                })
                ->values()
                ->all();

            $cashTotal = (float) (collect($totalsByMethod)->firstWhere('method', 'cash')['total_amount'] ?? 0);
            $expenseCount = (clone $expenseBaseQuery)->count();
            $expenseTotal = (float) ((clone $expenseBaseQuery)->sum('amount') ?? 0);
            $expenseCategories = (clone $expenseBaseQuery)
                ->selectRaw('category, COUNT(*) as expense_count, COALESCE(SUM(amount), 0) as total_amount')
                ->groupBy('category')
                ->orderByDesc('total_amount')
                ->get()
                ->map(fn ($row): array => [
                    'category' => (string) $row->category,
                    'expense_count' => (int) $row->expense_count,
                    'total_amount' => number_format((float) $row->total_amount, 2, '.', ''),
                ])
                ->values()
                ->all();
            $recentExpenseModels = (clone $expenseBaseQuery)
                ->with(['posSession.cashbox', 'createdBy'])
                ->orderByDesc('expense_date')
                ->orderByDesc('id')
                ->limit(10)
                ->get();
            $recentExpenseSyncStates = $this->syncStatesForEntities(
                'pos-expenses',
                PosExpense::class,
                $recentExpenseModels->pluck('id')->all()
            );
            $recentExpenses = $recentExpenseModels
                ->map(function (PosExpense $expense) use ($recentExpenseSyncStates): array {
                    $syncState = $recentExpenseSyncStates->get((int) $expense->id);

                    return [
                        'id' => $expense->id,
                        'pos_session_id' => $expense->pos_session_id,
                        'expense_date' => optional($expense->expense_date)->toDateString(),
                        'category' => $expense->category,
                        'amount' => number_format((float) $expense->amount, 2, '.', ''),
                        'currency' => $expense->currency,
                        'note' => $expense->note,
                        'cashbox' => [
                            'id' => $expense->posSession?->cashbox?->id,
                            'code' => $expense->posSession?->cashbox?->code,
                            'name' => $expense->posSession?->cashbox?->name,
                        ],
                        'created_by' => [
                            'id' => $expense->createdBy?->id,
                            'name' => $expense->createdBy?->name,
                        ],
                        'logo_sync_status' => $syncState?->status,
                        'logo_sync_error' => $syncState?->last_error,
                        'logo_external_ref' => $syncState?->external_ref,
                        'logo_last_synced_at' => $syncState?->last_synced_at?->toIso8601String(),
                        'created_at' => $expense->created_at?->toIso8601String(),
                    ];
                })
                ->values()
                ->all();

            $deliverySaleIds = (clone $paidSalesQuery)
                ->where('document_type', 'delivery')
                ->pluck('id')
                ->all();
            $expenseIds = (clone $expenseBaseQuery)->pluck('id')->all();

            $session = null;
            $expectedCash = null;
            if (! empty($filters['pos_session_id'])) {
                $sessionModel = PosSession::query()
                    ->with(['cashbox', 'openedBy'])
                    ->find((int) $filters['pos_session_id']);

                if ($sessionModel !== null) {
                    $session = [
                        'id' => $sessionModel->id,
                        'status' => $sessionModel->status,
                        'opened_at' => $sessionModel->opened_at,
                        'closed_at' => $sessionModel->closed_at,
                        'opening_cash' => number_format((float) $sessionModel->opening_cash, 2, '.', ''),
                        'closing_cash_counted' => $sessionModel->closing_cash_counted !== null
                            ? number_format((float) $sessionModel->closing_cash_counted, 2, '.', '')
                            : null,
                        'cashbox' => [
                            'id' => $sessionModel->cashbox?->id,
                            'code' => $sessionModel->cashbox?->code,
                            'name' => $sessionModel->cashbox?->name,
                        ],
                        'opened_by' => [
                            'id' => $sessionModel->openedBy?->id,
                            'name' => $sessionModel->openedBy?->name,
                        ],
                    ];
                    $expectedCash = (float) $sessionModel->opening_cash + $cashTotal - $expenseTotal;
                }
            }

            return [
                'filters' => [
                    'pos_session_id' => $filters['pos_session_id'] ?? null,
                    'cashbox_id' => $filters['cashbox_id'] ?? null,
                    'date' => $filters['date'] ?? null,
                    'date_from' => $filters['date_from'] ?? null,
                    'date_to' => $filters['date_to'] ?? null,
                ],
                'session' => $session,
                'summary' => [
                    'sale_count' => $paidCount + $cancelledCount,
                    'paid_count' => $paidCount,
                    'cancelled_count' => $cancelledCount,
                    'document_count' => [
                        'invoice' => (int) ($documentRows['invoice'] ?? 0),
                        'delivery' => (int) ($documentRows['delivery'] ?? 0),
                    ],
                    'cash_total' => number_format($cashTotal, 2, '.', ''),
                    'vat_total' => number_format($vatTotalPaid, 2, '.', ''),
                    'vat_total_cancelled' => number_format($vatTotalCancelled, 2, '.', ''),
                    'grand_total' => number_format($grandTotalPaid, 2, '.', ''),
                    'grand_total_cancelled' => number_format($grandTotalCancelled, 2, '.', ''),
                    'expense_count' => $expenseCount,
                    'expense_total' => number_format($expenseTotal, 2, '.', ''),
                    'expected_cash' => $expectedCash !== null ? number_format($expectedCash, 2, '.', '') : null,
                    'net_total' => number_format($grandTotalPaid - $grandTotalCancelled, 2, '.', ''),
                ],
                'totals_by_method' => $totalsByMethod,
                'expenses' => [
                    'count' => $expenseCount,
                    'total_amount' => number_format($expenseTotal, 2, '.', ''),
                    'by_category' => $expenseCategories,
                    'recent' => $recentExpenses,
                ],
                'report_tables' => [
                    'normal_sales' => $normalSaleRows->all(),
                    'cash_sales' => $cashSaleRows->all(),
                    'card_sales' => $cardSaleRows->all(),
                    'cash_collections' => $recentCollectionRows->where('day_end_bucket', 'cash')->values()->all(),
                    'card_collections' => $recentCollectionRows->where('day_end_bucket', 'card')->values()->all(),
                    'transfer_collections' => $recentCollectionRows->where('day_end_bucket', 'transfer')->values()->all(),
                    'check_collections' => $recentCollectionRows->where('day_end_bucket', 'check')->values()->all(),
                    'note_collections' => $recentCollectionRows->where('day_end_bucket', 'note')->values()->all(),
                    'factory_card_collections' => $recentCollectionRows->where('day_end_bucket', 'factory_cc')->values()->all(),
                ],
                'cancelled' => [
                    'count' => $cancelledCount,
                    'total_amount' => number_format($grandTotalCancelled, 2, '.', ''),
                ],
                'logo_sync' => [
                    'sales' => $this->logoStateSummary('pos-sales', PosSale::class, $deliverySaleIds),
                    'expenses' => $this->logoStateSummary('pos-expenses', PosExpense::class, $expenseIds),
                    'collections' => $this->collectionSyncSummary(clone $manualCollectionsQuery),
                ],
                'generated_at' => now()->toIso8601String(),
            ];
        }, 2);
    }

    private function resolveCollectionReportBucket(Collection $collection): string
    {
        $method = (string) $collection->method;
        $channel = (string) data_get($collection->reference_fields, 'collection_channel', '');

        if ($method === 'cc' && $channel === 'factory') {
            return 'factory_cc';
        }

        return match ($method) {
            'cash' => 'cash',
            'cc' => 'card',
            'transfer' => 'transfer',
            'check' => 'check',
            'note' => 'note',
            default => 'other',
        };
    }

    /**
     * @param  list<string>  $createdByRoleSlugs
     */
    private function resolveSaleReportBucket(
        PosSale $sale,
        string $paymentMethod,
        array $createdByRoleSlugs,
        bool $isWarehouseSale
    ): string {
        if ($isWarehouseSale) {
            return 'normal';
        }

        $pointDefaultBucket = $this->pointDefaultCustomerBucket(
            $sale->customer?->code,
            $sale->customer?->name
        );

        if ($pointDefaultBucket !== null) {
            return $pointDefaultBucket;
        }

        if ($this->isPointSaleContext($sale, $createdByRoleSlugs)) {
            return 'normal';
        }

        return in_array($paymentMethod, ['cash', 'card'], true) ? $paymentMethod : 'normal';
    }

    private function saleWarehouseName(PosSale $sale): ?string
    {
        $cashboxName = $sale->posSession?->cashbox?->name;
        if (is_string($cashboxName) && trim($cashboxName) !== '') {
            return trim($cashboxName);
        }

        $cashboxCode = $sale->posSession?->cashbox?->code;

        return is_string($cashboxCode) && trim($cashboxCode) !== '' ? trim($cashboxCode) : null;
    }

    /**
     * @param  list<string>  $createdByRoleSlugs
     */
    private function isPointSaleContext(PosSale $sale, array $createdByRoleSlugs): bool
    {
        if (in_array('point', $createdByRoleSlugs, true)) {
            return true;
        }

        $cashboxText = $this->normalizeReportText(
            ($sale->posSession?->cashbox?->code ?? '').' '.($sale->posSession?->cashbox?->name ?? '')
        );

        return str_contains($cashboxText, 'POINT')
            || str_contains($cashboxText, 'BATUM')
            || str_contains($cashboxText, 'ERZURUM');
    }

    private function pointDefaultCustomerBucket(?string $customerCode, ?string $customerName): ?string
    {
        $text = $this->normalizeReportText(($customerCode ?? '').' '.($customerName ?? ''));

        if ($text === '') {
            return null;
        }

        $looksLikePointDefault = str_contains($text, 'POINT')
            || str_contains($text, 'PERAKENDE')
            || str_contains($text, 'BATUM')
            || str_contains($text, 'ERZURUM');

        if (! $looksLikePointDefault || ! str_contains($text, 'SATIS')) {
            return null;
        }

        if (str_contains($text, 'KREDI') && str_contains($text, 'KART')) {
            return 'card';
        }

        if (str_contains($text, 'NAKIT')) {
            return 'cash';
        }

        return null;
    }

    private function normalizeReportText(string $value): string
    {
        $normalized = mb_strtoupper(trim($value), 'UTF-8');

        return strtr($normalized, [
            'Ç' => 'C',
            'Ğ' => 'G',
            'İ' => 'I',
            'Ö' => 'O',
            'Ş' => 'S',
            'Ü' => 'U',
        ]);
    }

    /**
     * @param  Builder<PosSale>  $query
     * @param  array<string, mixed>  $filters
     * @return Builder<PosSale>
     */
    public function applySaleFilters(Builder $query, User $user, array $filters): Builder
    {
        if (! $user->hasRole('admin')) {
            $query->whereHas('posSession.openedBy', fn (Builder $q) => $q->where('dealer_id', $user->dealer_id));

            if ($user->hasAnyRole(['cashier', 'point']) && ! $user->hasRole('dealer_admin')) {
                $query->whereHas('posSession', fn (Builder $q) => $q->where('opened_by', $user->id));
            }
        }

        if (! empty($filters['pos_session_id'])) {
            $query->where('pos_session_id', (int) $filters['pos_session_id']);
        }

        if (! empty($filters['cashbox_id'])) {
            $query->whereHas('posSession', fn (Builder $q) => $q->where('cashbox_id', (int) $filters['cashbox_id']));
        }

        if (! empty($filters['date'])) {
            $query->whereDate('created_at', (string) $filters['date']);
        } else {
            if (! empty($filters['date_from'])) {
                $query->whereDate('created_at', '>=', (string) $filters['date_from']);
            }

            if (! empty($filters['date_to'])) {
                $query->whereDate('created_at', '<=', (string) $filters['date_to']);
            }
        }

        return $query;
    }

    /**
     * @param  Builder<Collection>  $query
     * @param  array<string, mixed>  $filters
     * @return Builder<Collection>
     */
    private function applyPointCollectionFilters(Builder $query, User $user, array $filters): Builder
    {
        $dateCol = DB::connection()->getDriverName() === 'mysql' ? '`date`' : '"date"';
        $dateColumn = "COALESCE({$dateCol}, collection_date)";

        $query->where(function (Builder $scope) use ($filters): void {
            $scope->where('meta->source', 'point_collection');

            if (! empty($filters['pos_session_id'])) {
                $scope->orWhere('meta->pos_session_id', (int) $filters['pos_session_id']);
            }

            if (! empty($filters['cashbox_id'])) {
                $scope->orWhere('meta->cashbox_id', (int) $filters['cashbox_id']);
            }
        });
        $query->where(function (Builder $scope): void {
            $scope
                ->whereNull('meta->source')
                ->orWhere('meta->source', '!=', 'pos_sale');
        });

        if (! $user->hasRole('admin')) {
            $query->where('dealer_id', $user->dealer_id);

            if ($user->hasAnyRole(['cashier', 'point']) && ! $user->hasRole('dealer_admin')) {
                $query->where('collected_by_user_id', $user->id);
            }
        }

        if (! empty($filters['pos_session_id'])) {
            $query->where('meta->pos_session_id', (int) $filters['pos_session_id']);
        }

        if (! empty($filters['cashbox_id'])) {
            $query->where('meta->cashbox_id', (int) $filters['cashbox_id']);
        }

        if (! empty($filters['date'])) {
            $query->whereRaw("DATE({$dateColumn}) = ?", [(string) $filters['date']]);
        } else {
            if (! empty($filters['date_from'])) {
                $query->whereRaw("DATE({$dateColumn}) >= ?", [(string) $filters['date_from']]);
            }

            if (! empty($filters['date_to'])) {
                $query->whereRaw("DATE({$dateColumn}) <= ?", [(string) $filters['date_to']]);
            }
        }

        return $query;
    }

    /**
     * @param  array<int, int|string>  $entityIds
     * @return \Illuminate\Support\Collection<int, IntegrationSyncState>
     */
    private function syncStatesForEntities(string $domain, string $entityClass, array $entityIds): \Illuminate\Support\Collection
    {
        $ids = collect($entityIds)
            ->filter(fn ($id) => is_numeric($id))
            ->map(fn ($id) => (int) $id)
            ->unique()
            ->values();

        if ($ids->isEmpty()) {
            return collect();
        }

        return IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', $domain)
            ->where('direction', 'outbound')
            ->where('entity_type', $entityClass)
            ->whereIn('entity_id', $ids->all())
            ->latest('id')
            ->get()
            ->unique('entity_id')
            ->keyBy(fn (IntegrationSyncState $state) => (int) $state->entity_id);
    }

    /**
     * @param  array<int, int|string>  $entityIds
     * @return array<string, int>
     */
    private function logoStateSummary(string $domain, string $entityClass, array $entityIds): array
    {
        $ids = collect($entityIds)
            ->filter(fn ($id) => is_numeric($id))
            ->map(fn ($id) => (int) $id)
            ->unique()
            ->values();

        $summary = $this->emptyLogoSyncSummary($ids->count());

        if ($ids->isEmpty()) {
            return $summary;
        }

        $rows = IntegrationSyncState::query()
            ->selectRaw('status, COUNT(*) as total_count')
            ->where('system', 'logo')
            ->where('domain', $domain)
            ->where('direction', 'outbound')
            ->where('entity_type', $entityClass)
            ->whereIn('entity_id', $ids->all())
            ->groupBy('status')
            ->pluck('total_count', 'status');

        $tracked = 0;
        foreach ($rows as $status => $count) {
            $count = (int) $count;
            $tracked += $count;
            $this->addLogoSyncCount($summary, is_string($status) ? $status : null, $count);
        }

        $summary['missing'] = max(0, $summary['total'] - $tracked);

        return $summary;
    }

    /**
     * @param  Builder<Collection>  $query
     * @return array<string, int>
     */
    private function collectionSyncSummary(Builder $query): array
    {
        $summary = $this->emptyLogoSyncSummary((clone $query)->count());

        if ($summary['total'] === 0) {
            return $summary;
        }

        $rows = (clone $query)
            ->selectRaw('sync_status, COUNT(*) as total_count')
            ->groupBy('sync_status')
            ->pluck('total_count', 'sync_status');

        foreach ($rows as $status => $count) {
            $this->addLogoSyncCount($summary, is_string($status) ? $status : null, (int) $count);
        }

        return $summary;
    }

    /**
     * @return array<string, int>
     */
    private function emptyLogoSyncSummary(int $total = 0): array
    {
        return [
            'total' => $total,
            'queued' => 0,
            'processing' => 0,
            'synced' => 0,
            'failed' => 0,
            'missing' => 0,
        ];
    }

    /**
     * @param  array<string, int>  $summary
     */
    private function addLogoSyncCount(array &$summary, ?string $status, int $count): void
    {
        match ($status) {
            'queued', 'pending' => $summary['queued'] += $count,
            'processing' => $summary['processing'] += $count,
            'synced' => $summary['synced'] += $count,
            'failed' => $summary['failed'] += $count,
            default => $summary['missing'] += $count,
        };
    }
}
