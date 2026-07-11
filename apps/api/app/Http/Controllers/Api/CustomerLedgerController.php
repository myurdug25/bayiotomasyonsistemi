<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Customer\CustomerLedgerIndexRequest;
use App\Http\Resources\LedgerEntryResource;
use App\Models\Customer;
use App\Models\LedgerEntry;
use App\Models\Order;
use App\Models\User;
use App\Support\Pricing\DisplayCurrency;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

class CustomerLedgerController extends Controller
{
    public function index(CustomerLedgerIndexRequest $request, Customer $customer)
    {
        $this->authorize('viewLedger', $customer);

        $validated = $request->validated();
        $perPage = min((int) ($validated['per_page'] ?? 25), 50);
        $dateFrom = $validated['date_from'] ?? $validated['from_date'] ?? null;
        $dateTo = $validated['date_to'] ?? $validated['to_date'] ?? null;
        $excludedTypes = array_values(array_filter(
            $validated['exclude_types'] ?? [],
            static fn ($type): bool => is_string($type) && $type !== ''
        ));

        $this->ensureOpenOrderLedgerRows($customer);

        $baseQuery = $this->ledgerQuery(
            customer: $customer,
            dateFrom: $dateFrom,
            dateTo: $dateTo,
            type: $validated['type'] ?? null,
            collectionMethod: $validated['collection_method'] ?? null,
            excludedTypes: $excludedTypes
        );
        $summary = $this->ledgerSummary(clone $baseQuery, $request->user());

        $entries = (clone $baseQuery)
            ->with([
                'collection',
                'order:id,order_no,cart_id',
                'order.cart:id,shipping_method',
            ])
            ->orderByDesc('date')
            ->orderByDesc('id')
            ->paginate($perPage)
            ->withQueryString();

        $this->applyEffectiveBalances($entries->getCollection(), (int) $customer->id, $excludedTypes);

        return LedgerEntryResource::collection($entries)->additional([
            'customer_id' => $customer->id,
            'summary' => $summary,
        ]);
    }

    /**
     * @param  array<int, string>  $excludedTypes
     */
    private function ledgerQuery(Customer $customer, ?string $dateFrom, ?string $dateTo, ?string $type, ?string $collectionMethod, array $excludedTypes)
    {
        return $customer->ledgerEntries()
            ->effectiveForCustomerBalance()
            ->when(
                ! empty($dateFrom),
                fn ($q) => $q->whereDate('date', '>=', $dateFrom)
            )
            ->when(
                ! empty($dateTo),
                fn ($q) => $q->whereDate('date', '<=', $dateTo)
            )
            ->when(
                ! empty($type),
                fn ($q) => $type === 'order'
                    ? $q->where('meta->source', 'order_visibility')
                    : $q->where('type', $type)
            )
            ->when(
                ! empty($collectionMethod),
                fn ($q) => $this->applyCollectionMethodFilter($q, (string) $collectionMethod)
            )
            ->when(
                $excludedTypes !== [],
                fn ($q) => $q->whereNotIn('type', $excludedTypes)
            );
    }

    private function applyCollectionMethodFilter($query, string $method)
    {
        return $query
            ->where('type', 'payment')
            ->whereHas('collection', function ($collectionQuery) use ($method): void {
                if ($method === 'factory_cc') {
                    $collectionQuery
                        ->where('method', 'cc')
                        ->where('reference_fields->collection_channel', 'factory');

                    return;
                }

                if ($method === 'check') {
                    $collectionQuery->whereIn('method', ['check', 'note']);

                    return;
                }

                if ($method === 'cc') {
                    $collectionQuery
                        ->where('method', 'cc')
                        ->where(function ($query): void {
                            $query
                                ->whereNull('reference_fields->collection_channel')
                                ->orWhere('reference_fields->collection_channel', '!=', 'factory');
                        });

                    return;
                }

                $collectionQuery->where('method', $method);
            });
    }

    private function ensureOpenOrderLedgerRows(Customer $customer): void
    {
        Order::query()
            ->where('customer_id', $customer->id)
            ->whereIn('status', ['approved', 'partially_shipped', 'picking', 'packed'])
            ->whereDoesntHave('ledgerEntries', function ($query): void {
                $query->where('meta->source', 'order_visibility');
            })
            ->whereDoesntHave('ledgerEntries', function ($query): void {
                $query->where('type', 'invoice');
            })
            ->select([
                'id',
                'dealer_id',
                'customer_id',
                'user_id',
                'order_no',
                'currency',
                'grand_total',
                'ordered_at',
                'approved_at',
                'created_at',
            ])
            ->orderBy('id')
            ->chunkById(100, function ($orders): void {
                foreach ($orders as $order) {
                    $date = optional($order->approved_at ?? $order->ordered_at ?? $order->created_at)?->toDateString()
                        ?? now()->toDateString();

                    LedgerEntry::query()->updateOrCreate(
                        [
                            'order_id' => $order->id,
                            'type' => 'debit',
                            'source_system' => 'b2b',
                            'source_reference' => $order->order_no,
                        ],
                        [
                            'dealer_id' => $order->dealer_id,
                            'customer_id' => $order->customer_id,
                            'date' => $date,
                            'debit' => number_format((float) $order->grand_total, 2, '.', ''),
                            'credit' => 0,
                            'balance_after' => 0,
                            'entry_date' => $date,
                            'entry_type' => 'debit',
                            'amount' => number_format((float) $order->grand_total, 2, '.', ''),
                            'currency' => $order->currency ?: 'TRY',
                            'reference_no' => $order->order_no,
                            'description' => 'Onaylı / bakiye sipariş '.$order->order_no,
                            'created_by_user_id' => $order->user_id,
                            'meta' => [
                                'source' => 'order_visibility',
                                'source_label' => 'Sipariş',
                                'order_no' => $order->order_no,
                                'order_total' => number_format((float) $order->grand_total, 2, '.', ''),
                            ],
                        ]
                    );
                }
            });
    }

    /**
     * @return array{total_debit: string, total_credit: string, balance: string, total_count: int, currency: string}
     */
    private function ledgerSummary($query, ?User $user): array
    {
        $summary = (clone $query)
            ->selectRaw('COUNT(*) as total_count')
            ->selectRaw("COALESCE(SUM(COALESCE(debit, CASE WHEN entry_type = 'debit' THEN amount ELSE 0 END)), 0) as total_debit")
            ->selectRaw("COALESCE(SUM(COALESCE(credit, CASE WHEN entry_type = 'credit' THEN amount ELSE 0 END)), 0) as total_credit")
            ->first();

        $currency = $this->displayCurrency((string) ((clone $query)
            ->orderByDesc('date')
            ->orderByDesc('id')
            ->value('currency') ?? 'TRY'), $user);
        $totalDebit = (float) ($summary?->total_debit ?? 0);
        $totalCredit = (float) ($summary?->total_credit ?? 0);

        return [
            'total_debit' => number_format($totalDebit, 2, '.', ''),
            'total_credit' => number_format($totalCredit, 2, '.', ''),
            'balance' => number_format($totalDebit - $totalCredit, 2, '.', ''),
            'total_count' => (int) ($summary?->total_count ?? 0),
            'currency' => $currency,
        ];
    }

    /**
     * @param  Collection<int, LedgerEntry>  $entries
     * @param  array<int, string>  $excludedTypes
     */
    private function applyEffectiveBalances(Collection $entries, int $customerId, array $excludedTypes = []): void
    {
        foreach ($entries as $entry) {
            $entryDate = $entry->date?->toDateString() ?? $entry->entry_date?->toDateString();

            if ($entryDate === null) {
                continue;
            }

            $entry->forceFill([
                'balance_after' => number_format(
                    $this->effectiveBalanceAfter($customerId, $entryDate, (int) $entry->id, $excludedTypes),
                    2,
                    '.',
                    ''
                ),
            ]);
        }
    }

    /**
     * @param  array<int, string>  $excludedTypes
     */
    private function effectiveBalanceAfter(int $customerId, string $entryDate, int $entryId, array $excludedTypes = []): float
    {
        $dateCol = DB::connection()->getDriverName() === 'mysql' ? '`date`' : '"date"';
        $entryDateExpression = "DATE(COALESCE({$dateCol}, entry_date))";

        return (float) (LedgerEntry::query()
            ->effectiveForCustomerBalance()
            ->where('customer_id', $customerId)
            ->when(
                $excludedTypes !== [],
                fn ($q) => $q->whereNotIn('type', $excludedTypes)
            )
            ->where(function ($query) use ($entryDateExpression, $entryDate, $entryId): void {
                $query
                    ->whereRaw("{$entryDateExpression} < ?", [$entryDate])
                    ->orWhere(function ($query) use ($entryDateExpression, $entryDate, $entryId): void {
                        $query
                            ->whereRaw("{$entryDateExpression} = ?", [$entryDate])
                            ->where('id', '<=', $entryId);
                    });
            })
            ->selectRaw(
                "COALESCE(SUM(COALESCE(debit, CASE WHEN entry_type = 'debit' THEN amount ELSE 0 END) - COALESCE(credit, CASE WHEN entry_type = 'credit' THEN amount ELSE 0 END)), 0) as balance"
            )
            ->value('balance') ?? 0);
    }

    private function displayCurrency(string $currency, ?User $user): string
    {
        $normalized = strtoupper(trim($currency));

        if ($normalized === 'GEL' && ! DisplayCurrency::usesLariPricing($user)) {
            return 'TRY';
        }

        return DisplayCurrency::normalize($normalized, $user);
    }
}
