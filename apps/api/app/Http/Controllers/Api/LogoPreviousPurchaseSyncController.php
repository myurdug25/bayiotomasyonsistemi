<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Integration\SyncLogoPreviousPurchasesRequest;
use App\Models\Customer;
use App\Services\Products\EryazPreviousPurchaseHistoryService;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

class LogoPreviousPurchaseSyncController extends Controller
{
    public function sync(SyncLogoPreviousPurchasesRequest $request): JsonResponse
    {
        $validated = $request->validated();
        $dealerId = isset($validated['dealer_id']) ? (int) $validated['dealer_id'] : null;
        $receivedCount = count($validated['records']);
        $records = collect($validated['records'])
            ->keyBy(fn (array $record): string => trim((string) $record['external_ref']))
            ->values()
            ->all();

        foreach (array_chunk($records, 500) as $chunk) {
            $now = now();
            $rows = [];
            $customerMap = $this->resolveCustomersForCodes($dealerId, array_map(
                fn (array $record): string => trim((string) $record['customer_code']),
                $chunk,
            ));

            foreach ($chunk as $record) {
                $sourceCustomerCode = trim((string) $record['customer_code']);
                $customer = $customerMap[$this->normalizeCodeKey($sourceCustomerCode)] ?? null;
                $customerCode = $customer instanceof Customer ? (string) $customer->code : $sourceCustomerCode;
                $productCode = trim((string) $record['product_code']);

                $rows[] = [
                    'dealer_id' => $dealerId,
                    'customer_id' => $customer?->id,
                    'product_id' => null,
                    'customer_code' => $customerCode,
                    'product_code' => $productCode,
                    'source_database' => isset($record['source_database']) ? trim((string) $record['source_database']) : null,
                    'external_ref' => trim((string) $record['external_ref']),
                    'purchase_date' => isset($record['date']) ? Carbon::parse($record['date'])->toDateString() : null,
                    'description' => isset($record['description']) ? mb_substr(trim((string) $record['description']), 0, 255) : null,
                    'document_no' => isset($record['document_no']) ? mb_substr(trim((string) $record['document_no']), 0, 64) : null,
                    'quantity' => round((float) ($record['quantity'] ?? 0), 4),
                    'unit' => isset($record['unit']) ? mb_substr(trim((string) $record['unit']), 0, 16) : 'AD',
                    'unit_price' => round((float) ($record['unit_price'] ?? 0), 4),
                    'net_price' => round((float) ($record['net_price'] ?? 0), 4),
                    'discounts' => json_encode(array_values(array_map(
                        fn (mixed $value): float => round((float) $value, 4),
                        (array) ($record['discounts'] ?? [])
                    )), JSON_THROW_ON_ERROR),
                    'gross_total' => round((float) ($record['gross_total'] ?? 0), 4),
                    'net_total' => round((float) ($record['net_total'] ?? 0), 4),
                    'synced_at' => $now,
                    'created_at' => $now,
                    'updated_at' => $now,
                ];

                foreach ([10, 25, 50, 100] as $limit) {
                    Cache::forget(EryazPreviousPurchaseHistoryService::cacheKey($sourceCustomerCode, $productCode, $limit));
                    Cache::forget(EryazPreviousPurchaseHistoryService::cacheKey($customerCode, $productCode, $limit));
                }
            }

            DB::table('product_previous_purchases')->upsert(
                $rows,
                ['external_ref'],
                [
                    'dealer_id',
                    'customer_id',
                    'product_id',
                    'customer_code',
                    'product_code',
                    'source_database',
                    'purchase_date',
                    'description',
                    'document_no',
                    'quantity',
                    'unit',
                    'unit_price',
                    'net_price',
                    'discounts',
                    'gross_total',
                    'net_total',
                    'synced_at',
                    'updated_at',
                ],
            );
        }

        return response()->json([
            'received' => $receivedCount,
            'synced' => count($records),
        ]);
    }

    /**
     * @param  list<string>  $codes
     * @return array<string, Customer>
     */
    private function resolveCustomersForCodes(?int $dealerId, array $codes): array
    {
        $normalizedCodes = collect($codes)
            ->map(fn (string $code): string => trim($code))
            ->filter()
            ->unique()
            ->values()
            ->all();

        if ($normalizedCodes === []) {
            return [];
        }

        $customers = Customer::query()
            ->when($dealerId !== null, fn ($query) => $query->where('dealer_id', $dealerId))
            ->get(['id', 'dealer_id', 'code', 'meta']);

        $codeSet = array_fill_keys(array_map(fn (string $code): string => $this->normalizeCodeKey($code), $normalizedCodes), true);
        $directMatches = [];
        $aliasCandidates = [];

        foreach ($customers as $customer) {
            $customerCodeKey = $this->normalizeCodeKey((string) $customer->code);
            if (isset($codeSet[$customerCodeKey])) {
                $directMatches[$customerCodeKey] = $customer;
            }

            foreach ($this->eryazAliasValues($customer) as $alias) {
                $aliasKey = $this->normalizeCodeKey($alias);
                if (! isset($codeSet[$aliasKey])) {
                    continue;
                }

                $aliasCandidates[$aliasKey] ??= [];
                $aliasCandidates[$aliasKey][$customer->id] = $customer;
            }
        }

        foreach ($aliasCandidates as $aliasKey => $matches) {
            if (! isset($directMatches[$aliasKey]) && count($matches) === 1) {
                $directMatches[$aliasKey] = array_values($matches)[0];
            }
        }

        return $directMatches;
    }

    /**
     * @return list<string>
     */
    private function eryazAliasValues(Customer $customer): array
    {
        return collect([
            data_get($customer->meta, 'integrations.logo.payload.raw.DEFINITION2'),
            data_get($customer->meta, 'integrations.logo.payload.raw.DEFINITION2_'),
            data_get($customer->meta, 'integrations.logo.payload.DEFINITION2'),
            data_get($customer->meta, 'integrations.logo.payload.DEFINITION2_'),
        ])
            ->map(fn ($value): string => trim((string) ($value ?? '')))
            ->filter()
            ->unique()
            ->values()
            ->all();
    }

    private function normalizeCodeKey(string $code): string
    {
        return mb_strtoupper(trim($code));
    }
}
