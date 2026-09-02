<?php

namespace App\Services\Pos;

use App\Models\Collection;
use App\Models\Customer;
use App\Models\IntegrationSyncState;
use App\Models\PosExpense;
use App\Models\PosPayment;
use App\Models\PosSale;
use App\Models\PosSession;
use App\Models\User;
use App\Services\Integrations\IntegrationSyncStateService;
use App\Support\MenuPermissions;
use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class DayEndReportService
{
    public function __construct(
        private readonly PosExpenseService $posExpenseService,
        private readonly IntegrationSyncStateService $syncState,
    ) {}

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
                            ->map(function ($item) use ($sale): array {
                                $vatMultiplier = 1 + ((float) $item->vat_rate / 100);

                                return [
                                    'product_code' => $item->product?->sku,
                                    'product_name' => $item->product?->name,
                                    'quantity' => number_format((float) $item->qty, 3, '.', ''),
                                    'unit_price' => number_format((float) $item->unit_price, 2, '.', ''),
                                    'line_total' => number_format((float) $item->line_total, 2, '.', ''),
                                    'unit_price_vat_included' => number_format((float) $item->unit_price * $vatMultiplier, 2, '.', ''),
                                    'line_total_vat_included' => number_format((float) $item->line_total * $vatMultiplier, 2, '.', ''),
                                    'warehouse_name' => $this->saleWarehouseName($sale),
                                ];
                            })
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
                ->map(function (string $method) use ($cashSaleRows, $cardSaleRows, $manualCollectionRows): array {
                    $saleRowsForMethod = match ($method) {
                        'cash' => $cashSaleRows,
                        'card' => $cardSaleRows,
                        default => collect(),
                    };
                    $collectionRow = $manualCollectionRows->get($method);

                    return [
                        'method' => $method,
                        'payment_count' => $saleRowsForMethod->count() + (int) ($collectionRow?->payment_count ?? 0),
                        'total_amount' => number_format(
                            $saleRowsForMethod->sum(fn (array $row): float => (float) ($row['grand_total'] ?? 0))
                                + (float) ($collectionRow?->total_amount ?? 0),
                            2,
                            '.',
                            ''
                        ),
                    ];
                })
                ->values()
                ->all();

            $cashTotal = (float) (collect($totalsByMethod)->firstWhere('method', 'cash')['total_amount'] ?? 0);
            $allExpenseModels = (clone $expenseBaseQuery)
                ->with(['posSession.cashbox', 'createdBy'])
                ->orderByDesc('expense_date')
                ->orderByDesc('id')
                ->get();
            $bankDepositCandidates = $allExpenseModels
                ->filter(fn (PosExpense $expense): bool => $this->isCashToBankTransfer($expense))
                ->values();
            $bankDepositSyncStates = $this->syncStatesForEntities(
                'pos-expenses',
                PosExpense::class,
                $bankDepositCandidates->pluck('id')->all()
            );
            $bankDepositModels = $bankDepositCandidates
                ->filter(function (PosExpense $expense) use ($bankDepositSyncStates): bool {
                    $syncState = $bankDepositSyncStates->get((int) $expense->id);

                    return $this->isVerifiedLogoBankTransfer($syncState);
                })
                ->values();
            $normalExpenseModels = $allExpenseModels
                ->reject(fn (PosExpense $expense): bool => $this->isCashToBankTransfer($expense))
                ->values();
            $cashExpenseModels = $normalExpenseModels
                ->reject(fn (PosExpense $expense): bool => $this->isBankFundedExpense($expense))
                ->values();
            $bankExpenseModels = $normalExpenseModels
                ->filter(fn (PosExpense $expense): bool => $this->isBankFundedExpense($expense))
                ->values();

            $expenseCount = $normalExpenseModels->count();
            $expenseTotal = (float) $normalExpenseModels->sum(fn (PosExpense $expense): float => (float) $expense->amount);
            $cashExpenseTotal = (float) $cashExpenseModels->sum(fn (PosExpense $expense): float => (float) $expense->amount);
            $bankExpenseTotal = (float) $bankExpenseModels->sum(fn (PosExpense $expense): float => (float) $expense->amount);
            $bankDepositTotal = (float) $bankDepositModels->sum(fn (PosExpense $expense): float => (float) $expense->amount);
            $expenseCategories = $normalExpenseModels
                ->groupBy(fn (PosExpense $expense): string => (string) $expense->category)
                ->map(fn ($items, string $category): array => [
                    'category' => $category,
                    'expense_count' => $items->count(),
                    'total_amount' => number_format(
                        (float) $items->sum(fn (PosExpense $expense): float => (float) $expense->amount),
                        2,
                        '.',
                        ''
                    ),
                ])
                ->sortByDesc(fn (array $row): float => (float) $row['total_amount'])
                ->values()
                ->all();
            $recentExpenseModels = $normalExpenseModels;
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
                    $expectedCash = (float) $sessionModel->opening_cash
                        + $cashTotal
                        - $cashExpenseTotal
                        - $bankDepositTotal;
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
                    'cash_expense_total' => number_format($cashExpenseTotal, 2, '.', ''),
                    'bank_expense_total' => number_format($bankExpenseTotal, 2, '.', ''),
                    'bank_deposit_total' => number_format($bankDepositTotal, 2, '.', ''),
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

    /**
     * @param  array<string, mixed>  $filters
     * @return array<string, mixed>
     */
    public function save(User $user, array $filters): array
    {
        return DB::transaction(function () use ($user, $filters): array {
            $report = $this->build($user, $filters);
            $sessionId = (int) data_get($report, 'session.id', 0);

            $session = $sessionId > 0
                ? PosSession::query()
                    ->with(['cashbox', 'openedBy'])
                    ->find($sessionId)
                : null;

            if ($session === null && ! empty($filters['cashbox_id'])) {
                $session = PosSession::query()
                    ->with(['cashbox', 'openedBy'])
                    ->where('cashbox_id', (int) $filters['cashbox_id'])
                    ->when(! empty($filters['date']), fn (Builder $query) => $query->whereDate('opened_at', '<=', (string) $filters['date']))
                    ->orderByRaw("CASE WHEN status = 'open' THEN 0 ELSE 1 END")
                    ->latest('id')
                    ->first();
            }

            if ($session === null) {
                throw ValidationException::withMessages([
                    'pos_session_id' => ['Gün sonu kaydı için açık POS oturumu bulunamadı.'],
                ]);
            }

            $tables = (array) ($report['report_tables'] ?? []);
            $cashSalesAmount = $this->sumReportRows((array) ($tables['cash_sales'] ?? []), 'grand_total');
            $cardSalesAmount = $this->sumReportRows((array) ($tables['card_sales'] ?? []), 'grand_total');
            $cashCollectionAmount = $this->sumReportRows((array) ($tables['cash_collections'] ?? []), 'amount');
            $cardCollectionAmount = $this->sumReportRows((array) ($tables['card_collections'] ?? []), 'amount');
            $paymentTotals = $this->paymentTotalsForExport($user, $filters);

            if (
                DB::connection()->getDriverName() === 'sqlite'
                && ! empty($filters['pos_session_id'])
                && $cashSalesAmount <= 0
                && $cardSalesAmount <= 0
                && (float) ($paymentTotals['cash'] ?? 0) <= 0
                && (float) ($paymentTotals['card'] ?? 0) <= 0
            ) {
                $paymentTotals = $this->paymentTotalsForExport($user, $this->sessionOnlyPaymentFilters($filters));
            }

            $paymentCashAmount = (float) ($paymentTotals['cash'] ?? 0);
            $paymentCardAmount = (float) ($paymentTotals['card'] ?? 0);
            $cashAmount = $paymentCashAmount > 0 ? $paymentCashAmount : $cashSalesAmount;
            $cardAmount = $paymentCardAmount > 0 ? $paymentCardAmount : $cardSalesAmount;
            $reportDate = (string) ($filters['date'] ?? now()->toDateString());
            $exportKey = 'B2B-POSDAYEND-'.$session->id.'-'.$reportDate;
            $status = ($cashAmount > 0 || $cardAmount > 0) ? 'queued' : 'synced';
            $cashboxPayload = $this->cashboxPayloadForExport($session, $user);
            $cashboxLabel = $this->normalizeReportText(trim((string) ($cashboxPayload['code'] ?? '').' '.(string) ($cashboxPayload['name'] ?? '')));
            $cashSaleCustomer = $this->saleCustomerPayloadForExport((array) ($tables['cash_sales'] ?? []));
            $cardSaleCustomer = $this->saleCustomerPayloadForExport((array) ($tables['card_sales'] ?? []));
            if ($cashAmount > 0 && $cashSaleCustomer['code'] === null && $cashSaleCustomer['name'] === null) {
                $cashSaleCustomer = $this->defaultPointSaleCustomerPayload($session, $user, 'cash');
            }
            if ($cardAmount > 0 && $cardSaleCustomer['code'] === null && $cardSaleCustomer['name'] === null) {
                $cardSaleCustomer = $this->defaultPointSaleCustomerPayload($session, $user, 'card');
            }

            $payload = [
                'export_key' => $exportKey,
                'pos_session_id' => $session->id,
                'date' => $reportDate,
                'cash_amount' => number_format($cashAmount, 2, '.', ''),
                'card_amount' => number_format($cardAmount, 2, '.', ''),
                'currency' => str_contains($cashboxLabel, 'BATUM') ? 'GEL' : 'TRY',
                'cashbox_code' => $cashboxPayload['code'],
                'cashbox_name' => $cashboxPayload['name'],
                'opened_by_user_id' => $session->opened_by,
                'opened_by_name' => $session->openedBy?->name,
                'cash_sale_customer_code' => $cashSaleCustomer['code'],
                'cash_sale_customer_name' => $cashSaleCustomer['name'],
                'card_sale_customer_code' => $cardSaleCustomer['code'],
                'card_sale_customer_name' => $cardSaleCustomer['name'],
                'cash_sale_customer' => $cashSaleCustomer,
                'card_sale_customer' => $cardSaleCustomer,
                'totals' => [
                    'normal_sales' => $this->sumReportRows((array) ($tables['normal_sales'] ?? []), 'grand_total'),
                    'cash_sales' => $cashSalesAmount,
                    'card_sales' => $cardSalesAmount,
                    'cash_collections' => $cashCollectionAmount,
                    'card_collections' => $cardCollectionAmount,
                    'expenses' => (float) data_get($report, 'summary.expense_total', 0),
                ],
                'accounting_totals' => [
                    'cash_sales' => $cashAmount,
                    'card_sales' => $cardAmount,
                    'cash_collections_report_only' => $cashCollectionAmount,
                    'card_collections_report_only' => $cardCollectionAmount,
                    'expenses_report_only' => (float) data_get($report, 'summary.expense_total', 0),
                ],
                'logo_rule' => 'cash_sales_and_card_sales_only_collections_report_only',
            ];

            $state = $this->syncState->record(
                system: 'logo',
                domain: 'pos-day-ends',
                direction: 'outbound',
                entity: $session,
                externalRef: null,
                status: $status,
                meta: [
                    'export_key' => $exportKey,
                    'payload' => $payload,
                ],
                payload: $payload,
            );

            $report['day_end_export'] = [
                'status' => $state->status,
                'cash_amount' => number_format($cashAmount, 2, '.', ''),
                'card_amount' => number_format($cardAmount, 2, '.', ''),
                'external_ref' => $state->external_ref,
                'last_error' => $state->last_error,
            ];

            return $report;
        }, 2);
    }

    /**
     * @param  array<int, array<string, mixed>>  $rows
     */
    private function sumReportRows(array $rows, string $preferredColumn): float
    {
        return collect($rows)->sum(function (array $row) use ($preferredColumn): float {
            $value = $row[$preferredColumn] ?? $row['total'] ?? $row['amount'] ?? 0;

            return is_numeric($value) ? (float) $value : 0.0;
        });
    }

    /**
     * @param  array<string, mixed>  $filters
     * @return array{cash:float,card:float}
     */
    private function paymentTotalsForExport(User $user, array $filters): array
    {
        $rows = PosPayment::query()
            ->selectRaw('method, COALESCE(SUM(amount), 0) as total_amount')
            ->whereIn('method', ['cash', 'card'])
            ->whereHas('posSale', function (Builder $query) use ($user, $filters): void {
                $this->applySaleFilters($query, $user, $filters);
                $query->where('status', 'paid');
            })
            ->groupBy('method')
            ->pluck('total_amount', 'method');

        return [
            'cash' => (float) ($rows['cash'] ?? 0),
            'card' => (float) ($rows['card'] ?? 0),
        ];
    }

    /**
     * @param  array<string, mixed>  $filters
     * @return array<string, mixed>
     */
    private function sessionOnlyPaymentFilters(array $filters): array
    {
        unset($filters['date'], $filters['date_from'], $filters['date_to'], $filters['cashbox_id']);

        return $filters;
    }

    /**
     * @return array{code:?string,name:?string}
     */
    private function cashboxPayloadForExport(PosSession $session, User $currentUser): array
    {
        $openedBy = $session->openedBy instanceof User ? $session->openedBy : null;
        $code = $this->nullableString($openedBy?->logo_cashbox_code)
            ?? $this->nullableString($currentUser->logo_cashbox_code)
            ?? $this->nullableString($session->cashbox?->code);
        $name = $this->nullableString($openedBy?->logo_cashbox_name)
            ?? $this->nullableString($currentUser->logo_cashbox_name)
            ?? $this->nullableString($session->cashbox?->name);

        return [
            'code' => $code,
            'name' => $name,
        ];
    }

    /**
     * @param  array<int, array<string, mixed>>  $rows
     * @return array{code:?string,name:?string}
     */
    private function saleCustomerPayloadForExport(array $rows): array
    {
        foreach ($rows as $row) {
            $code = $this->nullableString($row['customer_code'] ?? null);
            $name = $this->nullableString($row['customer_name'] ?? null);

            if ($code !== null || $name !== null) {
                return [
                    'code' => $code,
                    'name' => $name,
                ];
            }
        }

        return [
            'code' => null,
            'name' => null,
        ];
    }

    /**
     * @return array{code:?string,name:?string}
     */
    private function defaultPointSaleCustomerPayload(PosSession $session, User $currentUser, string $method): array
    {
        $cashbox = $this->cashboxPayloadForExport($session, $currentUser);
        $cashboxText = $this->normalizeReportText(trim(($cashbox['code'] ?? '').' '.($cashbox['name'] ?? '')));

        $expectedName = match (true) {
            str_contains($cashboxText, 'BATUM') => $method === 'cash'
                ? 'BATUM PERAKENDE NAKIT SATIS'
                : 'BATUM PERAKENDE KREDI KARTI SATIS',
            str_contains($cashboxText, 'TRABZON') => $method === 'cash'
                ? 'TRABZON POINT PERAKENDE NAKIT SATIS'
                : 'TRABZON POINT PERAKENDE KREDI KARTI SATIS',
            str_contains($cashboxText, 'SAMSUN') => $method === 'cash'
                ? 'SAMSUN DEPO NAKIT SATIS'
                : 'SAMSUN DEPO KREDI KARTI SATIS',
            str_contains($cashboxText, 'ERZURUM'), str_contains($cashboxText, 'POINT') => $method === 'cash'
                ? 'ERZURUM POINT NAKIT SATIS'
                : 'ERZURUM POINT KREDI KARTI SATIS',
            default => null,
        };

        if ($expectedName === null) {
            return ['code' => null, 'name' => null];
        }

        $customer = Customer::query()
            ->when($currentUser->dealer_id !== null, fn (Builder $query) => $query->where('dealer_id', $currentUser->dealer_id))
            ->where('is_active', true)
            ->get(['code', 'name'])
            ->first(fn (Customer $customer): bool => $this->normalizeReportText((string) $customer->name) === $expectedName);

        return [
            'code' => $this->nullableString($customer?->code),
            'name' => $this->nullableString($customer?->name),
        ];
    }

    private function nullableString(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $value = trim((string) $value);

        return $value === '' ? null : $value;
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

    private function isCashToBankTransfer(PosExpense $expense): bool
    {
        if (
            (string) data_get($expense->meta, 'operation_type') === 'cash_to_bank'
            || filter_var(data_get($expense->meta, 'bank_transfer_mode', false), FILTER_VALIDATE_BOOL)
        ) {
            return true;
        }

        $accountCode = data_get($expense->meta, 'logo_expense_account_code')
            ?? data_get($expense->meta, 'integrations.logo.account_code');
        $accountName = data_get($expense->meta, 'logo_expense_account_name')
            ?? data_get($expense->meta, 'integrations.logo.account_name');
        $normalizedCode = preg_replace(
            '/[^0-9A-ZÇĞİÖŞÜ]+/u',
            '',
            mb_strtoupper((string) $accountCode, 'UTF-8')
        ) ?? '';
        $label = mb_strtoupper(trim(implode(' ', array_filter([
            $expense->category,
            $accountName,
        ]))), 'UTF-8');

        $isLegacyBatumPosAccount = in_array($normalizedCode, ['10800001', '10800002'], true)
            && str_contains($label, 'POS HESABI')
            && str_contains($label, 'BATUM');
        $isLegacyFarukGeorgiaBank = in_array($normalizedCode, ['05', '10800003'], true)
            && str_contains($label, 'FARUK')
            && str_contains($label, 'GEORGIA');

        return $isLegacyBatumPosAccount || $isLegacyFarukGeorgiaBank;
    }

    private function isVerifiedLogoBankTransfer(?IntegrationSyncState $syncState): bool
    {
        if ($syncState === null || (string) $syncState->status !== 'synced') {
            return false;
        }

        // Kasa -> banka aktarımı ancak Logo tarafında gerçek BNFLINE hareketi
        // oluşturulup dış referansa yazıldıysa eldeki nakitten düşülür.
        // Böylece queued/failed kayıtlar ve eski yanlış "synced" onayları
        // kasa bakiyesini eksiltmez.
        return str_contains(
            mb_strtoupper((string) $syncState->external_ref, 'UTF-8'),
            'BNFLINE'
        );
    }

    private function isBankFundedExpense(PosExpense $expense): bool
    {
        return ! $this->isCashToBankTransfer($expense)
            && (string) data_get($expense->meta, 'payment_source_type', 'cash') === 'bank';
    }

    private function resolveSaleReportBucket(
        PosSale $sale,
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

        // POS'ta yalnızca şubelerin özel perakende nakit/kredi kartı carileri
        // kasa veya kart satışıdır. Diğer bütün müşteriler ödeme yöntemi ne
        // olursa olsun cari satış olarak raporlanır.
        return 'normal';
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

        $customerBuckets = [
            'cash' => [
                'BATUM PERAKENDE NAKIT SATIS',
                'ERZURUM POINT NAKIT SATIS',
                'TRABZON POINT PERAKENDE NAKIT SATIS',
                'SAMSUN DEPO NAKIT SATIS',
            ],
            'card' => [
                'BATUM PERAKENDE KREDI KARTI SATIS',
                'ERZURUM POINT KREDI KARTI SATIS',
                'TRABZON POINT PERAKENDE KREDI KARTI SATIS',
                'SAMSUN DEPO KREDI KARTI SATIS',
            ],
        ];

        foreach ($customerBuckets as $bucket => $customerNames) {
            foreach ($customerNames as $customerName) {
                if (str_contains($text, $customerName)) {
                    return $bucket;
                }
            }
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

            if ($this->usesUserScopedCashbox($user)) {
                $query->whereHas('posSession', fn (Builder $q) => $q->where('opened_by', $user->id));
            }
        }

        if (! empty($filters['pos_session_id'])) {
            $query->where('pos_session_id', (int) $filters['pos_session_id']);
        }

        if (! empty($filters['cashbox_id'])) {
            $query->whereHas('posSession', fn (Builder $q) => $q->where('cashbox_id', (int) $filters['cashbox_id']));
        }

        $this->applyCreatedAtLocalDateFilters($query, $filters);

        return $query;
    }

    /**
     * @param  Builder<PosSale>  $query
     * @param  array<string, mixed>  $filters
     */
    private function applyCreatedAtLocalDateFilters(Builder $query, array $filters): void
    {
        $timezone = 'Europe/Istanbul';

        if (! empty($filters['date'])) {
            $start = CarbonImmutable::parse((string) $filters['date'], $timezone)
                ->startOfDay()
                ->utc();
            $end = CarbonImmutable::parse((string) $filters['date'], $timezone)
                ->endOfDay()
                ->utc();

            $query->whereBetween('created_at', [$start, $end]);

            return;
        }

        if (! empty($filters['date_from'])) {
            $start = CarbonImmutable::parse((string) $filters['date_from'], $timezone)
                ->startOfDay()
                ->utc();

            $query->where('created_at', '>=', $start);
        }

        if (! empty($filters['date_to'])) {
            $end = CarbonImmutable::parse((string) $filters['date_to'], $timezone)
                ->endOfDay()
                ->utc();

            $query->where('created_at', '<=', $end);
        }
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

            if ($this->usesUserScopedCashbox($user)) {
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

    private function usesUserScopedCashbox(User $user): bool
    {
        if ($user->hasRole('admin')) {
            return false;
        }

        $hasPosMenu = in_array('pos', MenuPermissions::forUser($user), true);
        $hasOwnLogoCashbox = $this->nullableString($user->logo_cashbox_code) !== null;

        if ($user->hasRole('dealer_admin')) {
            return $hasPosMenu && $hasOwnLogoCashbox;
        }

        return $user->hasAnyRole(['cashier', 'point']) || $hasPosMenu;
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
