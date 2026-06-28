<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Customer\CustomerLedgerIndexRequest;
use App\Http\Resources\LedgerEntryResource;
use App\Models\Customer;
use App\Models\LedgerEntry;
use App\Models\User;
use App\Support\Pricing\DisplayCurrency;
use Illuminate\Support\Collection;

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
                fn ($q) => $q->where('type', $type)
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
        $dateCol = \Illuminate\Support\Facades\DB::connection()->getDriverName() === 'mysql' ? '`date`' : '"date"';
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
