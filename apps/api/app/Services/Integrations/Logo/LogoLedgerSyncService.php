<?php

namespace App\Services\Integrations\Logo;

use App\Models\Collection;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\LedgerEntry;
use App\Services\Integrations\IntegrationSyncStateService;
use Illuminate\Support\Arr;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

class LogoLedgerSyncService
{
    public function __construct(
        private readonly IntegrationSyncStateService $syncState
    ) {}

    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, int>
     */
    public function sync(array $payload): array
    {
        $defaultDealer = $this->resolveDealer(
            $payload['dealer_id'] ?? null,
            $payload['dealer_code'] ?? null,
        );

        $summary = [
            'received' => count($payload['records'] ?? []),
            'created' => 0,
            'updated' => 0,
            'skipped' => 0,
            'failed' => 0,
            'duplicates_removed' => 0,
            'balances_recalculated' => 0,
        ];

        DB::transaction(function () use ($payload, $defaultDealer, &$summary): void {
            $affectedCustomerIds = [];

            foreach ((array) ($payload['records'] ?? []) as $index => $record) {
                $dealer = $this->resolveDealer(
                    $record['dealer_id'] ?? null,
                    $record['dealer_code'] ?? null,
                    $defaultDealer,
                );

                if (! $dealer) {
                    $summary['failed']++;

                    continue;
                }

                try {
                    $customer = $this->resolveCustomer(
                        $dealer,
                        $record['customer_code'] ?? null,
                        $record['customer_external_ref'] ?? null,
                        $index,
                    );
                } catch (ValidationException) {
                    $summary['failed']++;

                    continue;
                }

                $debit = $this->normalizeMoney($record['debit'] ?? 0);
                $credit = $this->normalizeMoney($record['credit'] ?? 0);
                $linkedB2bCollection = $this->resolveLinkedB2bCollection($customer, $record);
                $entry = $this->findLedgerEntry(
                    $customer,
                    (string) $record['external_ref'],
                );
                $matchedProvisionalShipmentInvoice = false;

                if (! $entry && $linkedB2bCollection) {
                    $entry = $this->findLedgerEntryForLinkedB2bCollection($customer, $linkedB2bCollection);
                }

                if (! $entry && ! $linkedB2bCollection && $debit > 0) {
                    $entry = $this->findProvisionalShipmentInvoice($customer, $record, $debit);
                    $matchedProvisionalShipmentInvoice = $entry instanceof LedgerEntry;
                }

                $matchedLogoDocumentLedger = false;
                if (! $entry && ! $linkedB2bCollection && ($debit > 0 || $credit > 0)) {
                    $entry = $this->findExistingLogoLedgerByDocument($customer, $record, $debit, $credit);
                    $matchedLogoDocumentLedger = $entry instanceof LedgerEntry;
                }

                $mappedType = $this->resolveLedgerType($record, $debit, $credit);
                $legacyEntryType = $debit > 0 ? 'debit' : 'credit';
                $legacyAmount = $debit > 0 ? $debit : $credit;
                $providedBalance = array_key_exists('balance_after', $record) && is_numeric($record['balance_after'])
                    ? $this->normalizeMoney($record['balance_after'])
                    : null;

                $linkedB2bCollectionPayment = $linkedB2bCollection
                    && $credit > 0;

                $attributes = [
                    'dealer_id' => $dealer->id,
                    'customer_id' => $customer->id,
                    'source_system' => 'logo',
                    'source_reference' => $matchedLogoDocumentLedger && $entry
                        ? (string) $entry->source_reference
                        : (string) $record['external_ref'],
                    'last_synced_at' => now(),
                    'order_id' => $entry?->order_id,
                    'collection_id' => $linkedB2bCollection?->id,
                    'date' => (string) $record['date'],
                    'type' => $matchedProvisionalShipmentInvoice
                        ? 'invoice'
                        : ($linkedB2bCollectionPayment ? 'payment' : $mappedType),
                    'debit' => number_format($debit, 2, '.', ''),
                    'credit' => number_format($credit, 2, '.', ''),
                    'balance_after' => $providedBalance !== null
                        ? number_format($providedBalance, 2, '.', '')
                        : ($entry?->balance_after ?? 0),
                    'entry_date' => (string) $record['date'],
                    'entry_type' => $legacyEntryType,
                    'amount' => number_format($legacyAmount, 2, '.', ''),
                    'currency' => strtoupper((string) ($record['currency'] ?? 'TRY')),
                    'reference_no' => $this->nullableString($record['reference_no'] ?? null),
                    'description' => $linkedB2bCollectionPayment && $entry
                        ? ($entry->description ?: $this->nullableString($record['description'] ?? null))
                        : $this->nullableString($record['description'] ?? null),
                    'created_by_user_id' => $entry?->created_by_user_id,
                    'meta' => $this->buildMeta(
                        $entry,
                        $record,
                        $matchedProvisionalShipmentInvoice,
                        $matchedLogoDocumentLedger,
                    ),
                ];

                if ($entry) {
                    $entry->fill($attributes)->save();
                    $ledgerEntry = $entry;
                    $summary['updated']++;
                } else {
                    $ledgerEntry = LedgerEntry::query()->create($attributes);
                    $summary['created']++;
                }

                $this->syncState->record(
                    system: 'logo',
                    domain: 'ledger',
                    direction: 'inbound',
                    entity: $ledgerEntry,
                    externalRef: (string) $record['external_ref'],
                    status: 'synced',
                    meta: [
                        'operation' => $ledgerEntry->wasRecentlyCreated ? 'created' : 'updated',
                        'type' => $mappedType,
                    ],
                    payload: $record,
                );

                $this->syncCollectionMirrorForRecord($dealer, $customer, $ledgerEntry, $record);
                $affectedCustomerIds[$customer->id] = $customer->id;
            }

            $duplicates = $this->reconcileDuplicateShipmentInvoices();
            $summary['duplicates_removed'] = $duplicates['removed'];
            foreach ($duplicates['customer_ids'] as $customerId) {
                $affectedCustomerIds[$customerId] = $customerId;
            }

            $summary['balances_recalculated'] = $this->recalculateBalances(array_values($affectedCustomerIds));
        });

        return $summary;
    }

    /**
     * @return array{scanned:int,created:int,updated:int,skipped:int}
     */
    public function backfillCollections(?int $customerId = null): array
    {
        $summary = [
            'scanned' => 0,
            'created' => 0,
            'updated' => 0,
            'skipped' => 0,
        ];

        LedgerEntry::query()
            ->with([
                'dealer:id',
                'customer:id,dealer_id,source_system,source_reference,code,name',
            ])
            ->where('source_system', 'logo')
            ->where('type', 'payment')
            ->where('credit', '>', 0)
            ->when($customerId !== null, fn ($query) => $query->where('customer_id', $customerId))
            ->orderBy('id')
            ->chunkById(200, function ($entries) use (&$summary): void {
                foreach ($entries as $entry) {
                    $summary['scanned']++;

                    $dealer = $entry->dealer;
                    $customer = $entry->customer;

                    if (! $dealer || ! $customer) {
                        $summary['skipped']++;

                        continue;
                    }

                    $status = $this->syncCollectionMirrorForLedgerEntry($dealer, $customer, $entry);
                    $summary[$status]++;
                }
            });

        return $summary;
    }

    private function resolveDealer(
        mixed $dealerId,
        mixed $dealerCode,
        ?Dealer $fallback = null,
    ): ?Dealer {
        if ($dealerId !== null && $dealerId !== '') {
            return Dealer::query()->find((int) $dealerId);
        }

        $normalizedDealerCode = $this->nullableString($dealerCode);
        if ($normalizedDealerCode !== null) {
            return Dealer::query()
                ->where('code', $normalizedDealerCode)
                ->first();
        }

        return $fallback;
    }

    private function resolveCustomer(
        Dealer $dealer,
        mixed $customerCode,
        mixed $customerExternalReference,
        int $index,
    ): Customer {
        $normalizedExternalReference = $this->nullableString($customerExternalReference);
        if ($normalizedExternalReference !== null) {
            $customer = Customer::query()
                ->where('dealer_id', $dealer->id)
                ->where('source_system', 'logo')
                ->where('source_reference', $normalizedExternalReference)
                ->first();

            if ($customer) {
                return $customer;
            }
        }

        $normalizedCustomerCode = $this->nullableString($customerCode);
        if ($normalizedCustomerCode !== null) {
            $customer = Customer::query()
                ->where('dealer_id', $dealer->id)
                ->where('code', $normalizedCustomerCode)
                ->first();

            if ($customer) {
                return $customer;
            }

            $customer = $this->resolveCustomerByEryazAlias($dealer, $normalizedCustomerCode);
            if ($customer) {
                return $customer;
            }
        }

        throw ValidationException::withMessages([
            "records.$index.customer_code" => ['Cari hareket icin eslesen musteri bulunamadi.'],
        ]);
    }

    private function resolveCustomerByEryazAlias(Dealer $dealer, string $eryazCustomerCode): ?Customer
    {
        $matches = Customer::query()
            ->where('dealer_id', $dealer->id)
            ->where(function ($query) use ($eryazCustomerCode): void {
                $query
                    ->where('meta->integrations->logo->payload->raw->DEFINITION2', $eryazCustomerCode)
                    ->orWhere('meta->integrations->logo->payload->raw->DEFINITION2_', $eryazCustomerCode)
                    ->orWhere('meta->integrations->logo->payload->DEFINITION2', $eryazCustomerCode)
                    ->orWhere('meta->integrations->logo->payload->DEFINITION2_', $eryazCustomerCode);
            })
            ->limit(2)
            ->get();

        return $matches->count() === 1 ? $matches->first() : null;
    }

    private function findLedgerEntry(Customer $customer, string $externalReference): ?LedgerEntry
    {
        return LedgerEntry::query()
            ->where('customer_id', $customer->id)
            ->where('source_system', 'logo')
            ->where('source_reference', $externalReference)
            ->first();
    }

    private function findLedgerEntryForLinkedB2bCollection(Customer $customer, Collection $collection): ?LedgerEntry
    {
        return LedgerEntry::query()
            ->where('customer_id', $customer->id)
            ->where('collection_id', $collection->id)
            ->orderByRaw("CASE WHEN source_system = 'b2b' THEN 0 ELSE 1 END")
            ->orderBy('id')
            ->first();
    }

    /**
     * @param  array<string, mixed>  $record
     */
    private function findProvisionalShipmentInvoice(Customer $customer, array $record, float $debit): ?LedgerEntry
    {
        $documentCandidates = collect([
            $record['description'] ?? null,
            $record['reference_no'] ?? null,
            data_get($record, 'meta.raw.LINEEXP'),
            data_get($record, 'meta.raw.FICHENO'),
        ])
            ->map(fn ($value) => $this->nullableString($value))
            ->filter()
            ->unique()
            ->values()
            ->all();

        if ($documentCandidates === []) {
            return null;
        }

        return LedgerEntry::query()
            ->where('customer_id', $customer->id)
            ->where('source_system', 'logo')
            ->where('meta->source', 'logo_shipment_invoice')
            ->whereDate('date', (string) $record['date'])
            ->where('debit', number_format($debit, 2, '.', ''))
            ->where(function ($query) use ($documentCandidates): void {
                $query
                    ->whereIn('reference_no', $documentCandidates)
                    ->orWhereIn('description', $documentCandidates);
            })
            ->orderBy('id')
            ->first();
    }

    /**
     * @param  array<string, mixed>  $record
     */
    private function findExistingLogoLedgerByDocument(
        Customer $customer,
        array $record,
        float $debit,
        float $credit,
    ): ?LedgerEntry {
        $documentCandidates = collect([
            $record['reference_no'] ?? null,
            $record['description'] ?? null,
            data_get($record, 'meta.raw.FICHENO'),
            data_get($record, 'meta.raw.DOCODE'),
            data_get($record, 'meta.raw.GENEXP1'),
            data_get($record, 'meta.raw.LINEEXP'),
        ])
            ->map(fn ($value) => $this->nullableString($value))
            ->filter()
            ->unique()
            ->values()
            ->all();

        if ($documentCandidates === []) {
            return null;
        }

        $amountColumn = $debit > 0 ? 'debit' : 'credit';
        $amount = $debit > 0 ? $debit : $credit;

        if ($amount <= 0) {
            return null;
        }

        return LedgerEntry::query()
            ->where('customer_id', $customer->id)
            ->where('source_system', 'logo')
            ->whereDate('date', (string) $record['date'])
            ->where($amountColumn, number_format($amount, 2, '.', ''))
            ->where(function ($query) use ($documentCandidates): void {
                $query
                    ->whereIn('reference_no', $documentCandidates)
                    ->orWhereIn('description', $documentCandidates);
            })
            ->orderBy('id')
            ->first();
    }

    /**
     * @return array{removed:int,customer_ids:list<int>}
     */
    private function reconcileDuplicateShipmentInvoices(): array
    {
        $removed = 0;
        $customerIds = [];

        LedgerEntry::query()
            ->where('source_system', 'logo')
            ->where('meta->source', 'logo_shipment_invoice')
            ->orderBy('id')
            ->get()
            ->each(function (LedgerEntry $provisional) use (&$removed, &$customerIds): void {
                $shipmentNo = $this->nullableString(data_get($provisional->meta, 'shipment_no'))
                    ?? $this->nullableString($provisional->reference_no);

                if ($shipmentNo === null) {
                    return;
                }

                $authoritative = LedgerEntry::query()
                    ->where('customer_id', $provisional->customer_id)
                    ->where('source_system', 'logo')
                    ->where('id', '!=', $provisional->id)
                    ->whereDate('date', optional($provisional->date)->toDateString())
                    ->where('debit', $provisional->debit)
                    ->where(function ($query) use ($shipmentNo): void {
                        $query
                            ->where('description', $shipmentNo)
                            ->orWhere('reference_no', $shipmentNo);
                    })
                    ->orderBy('id')
                    ->first();

                if (! $authoritative instanceof LedgerEntry) {
                    return;
                }

                $provisionalMeta = is_array($provisional->meta) ? $provisional->meta : [];
                $authoritativeMeta = is_array($authoritative->meta) ? $authoritative->meta : [];
                $mergedMeta = array_replace_recursive($provisionalMeta, $authoritativeMeta);
                Arr::set($mergedMeta, 'source', 'logo_ledger');
                Arr::set($mergedMeta, 'provisional_reconciled_at', now()->toIso8601String());

                $authoritative->forceFill([
                    'order_id' => $authoritative->order_id ?? $provisional->order_id,
                    'type' => 'invoice',
                    'meta' => $mergedMeta,
                ])->save();

                $customerIds[(int) $provisional->customer_id] = (int) $provisional->customer_id;
                $provisional->delete();
                $removed++;
            });

        return [
            'removed' => $removed,
            'customer_ids' => array_values($customerIds),
        ];
    }

    /**
     * @param  array<string, mixed>  $record
     * @return 'created'|'updated'|'skipped'
     */
    private function syncCollectionMirrorForRecord(
        Dealer $dealer,
        Customer $customer,
        LedgerEntry $ledgerEntry,
        array $record,
    ): string {
        if (! $this->shouldMirrorCollection($record, $ledgerEntry)) {
            return 'skipped';
        }

        return $this->upsertCollectionMirror($dealer, $customer, $ledgerEntry, $record);
    }

    /**
     * @return 'created'|'updated'|'skipped'
     */
    private function syncCollectionMirrorForLedgerEntry(
        Dealer $dealer,
        Customer $customer,
        LedgerEntry $ledgerEntry,
    ): string {
        if (! $this->shouldMirrorLedgerEntry($ledgerEntry)) {
            return 'skipped';
        }

        return $this->upsertCollectionMirror($dealer, $customer, $ledgerEntry, [
            'external_ref' => $ledgerEntry->source_reference,
            'date' => optional($ledgerEntry->date)->toDateString() ?? optional($ledgerEntry->entry_date)->toDateString(),
            'type' => $ledgerEntry->type,
            'debit' => $ledgerEntry->debit,
            'credit' => $ledgerEntry->credit,
            'currency' => $ledgerEntry->currency,
            'reference_no' => $ledgerEntry->reference_no,
            'description' => $ledgerEntry->description,
            'meta' => is_array(data_get($ledgerEntry->meta, 'integrations.logo.payload'))
                ? data_get($ledgerEntry->meta, 'integrations.logo.payload')
                : null,
        ]);
    }

    /**
     * @param  array<string, mixed>  $record
     * @return 'created'|'updated'|'skipped'
     */
    private function upsertCollectionMirror(
        Dealer $dealer,
        Customer $customer,
        LedgerEntry $ledgerEntry,
        array $record,
    ): string {
        $existingB2bCollection = $this->resolveLinkedB2bCollection($customer, $record);
        if ($existingB2bCollection) {
            if ($ledgerEntry->collection_id !== $existingB2bCollection->id) {
                $ledgerEntry->forceFill([
                    'collection_id' => $existingB2bCollection->id,
                ])->save();
            }

            return 'updated';
        }

        $externalReference = $this->nullableString($record['external_ref'] ?? null);
        if ($externalReference === null) {
            return 'skipped';
        }

        $collection = Collection::query()->firstOrNew([
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => $externalReference,
        ]);

        $wasRecentlyCreated = ! $collection->exists;
        $method = $this->resolveCollectionMethod($record, $ledgerEntry);
        $referenceFields = $this->buildCollectionReferenceFields($record, $method);
        $payloadMeta = is_array($record['meta'] ?? null) ? $record['meta'] : [];
        $meta = is_array($collection->meta) ? $collection->meta : [];

        Arr::set($meta, 'source', 'logo_ledger_sync');
        Arr::set($meta, 'reference_fields', $referenceFields);
        Arr::set($meta, 'ledger_entry_id', $ledgerEntry->id);
        Arr::set($meta, 'integrations.logo.synced_at', now()->toIso8601String());
        Arr::set($meta, 'integrations.logo.external_ref', $externalReference);

        if ($payloadMeta !== []) {
            Arr::set($meta, 'integrations.logo.payload', $payloadMeta);
        }

        $collection->fill([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => $externalReference,
            'sync_status' => 'synced',
            'sync_error' => null,
            'last_synced_at' => now(),
            'collected_by_user_id' => null,
            'created_by_user_id' => null,
            'date' => (string) $record['date'],
            'collection_date' => (string) $record['date'],
            'method' => $method,
            'amount' => number_format($this->normalizeMoney($record['credit'] ?? 0), 2, '.', ''),
            'currency' => strtoupper((string) ($record['currency'] ?? 'TRY')),
            'reference_no' => $this->nullableString($record['reference_no'] ?? null),
            'reference_fields' => $referenceFields,
            'note' => $this->nullableString($record['description'] ?? null),
            'meta' => $meta,
        ]);

        $collection->save();

        $this->syncState->record(
            system: 'logo',
            domain: 'collections',
            direction: 'inbound',
            entity: $collection,
            externalRef: $externalReference,
            status: 'synced',
            meta: [
                'operation' => $wasRecentlyCreated ? 'created' : 'updated',
                'mirrored_from' => 'ledger',
                'ledger_entry_id' => $ledgerEntry->id,
            ],
            payload: $record,
        );

        if ($ledgerEntry->collection_id !== $collection->id) {
            $ledgerEntry->forceFill([
                'collection_id' => $collection->id,
            ])->save();
        }

        return $wasRecentlyCreated ? 'created' : 'updated';
    }

    /**
     * @param  array<string, mixed>  $record
     */
    private function resolveLinkedB2bCollection(Customer $customer, array $record): ?Collection
    {
        $raw = $this->extractRawMeta($record);
        $candidateValues = [
            $this->readRawValue($raw, ['SPECODE', 'specode']),
            $this->readRawValue($raw, ['SOURCE_REFERENCE', 'source_reference']),
            $this->readRawValue($raw, ['FICHENO', 'ficheno', 'DOCODE', 'docode', 'LINEEXP', 'lineexp']),
            $record['reference_no'] ?? null,
            $record['description'] ?? null,
            $record['external_ref'] ?? null,
        ];

        $collectionId = null;
        foreach ($candidateValues as $value) {
            $candidate = $this->nullableString($value);

            if ($candidate !== null && preg_match('/B2B-COL-(\d+)/i', $candidate, $matches)) {
                $collectionId = (int) $matches[1];
                break;
            }
        }

        if ($collectionId === null) {
            return $this->resolveLinkedB2bCollectionByDocument($customer, $record);
        }

        return Collection::query()
            ->whereKey($collectionId)
            ->where('customer_id', $customer->id)
            ->where('source_system', 'b2b')
            ->first();
    }

    /**
     * @param  array<string, mixed>  $record
     */
    private function resolveLinkedB2bCollectionByDocument(Customer $customer, array $record): ?Collection
    {
        $credit = $this->normalizeMoney($record['credit'] ?? 0);
        if ($credit <= 0) {
            return null;
        }

        $candidates = $this->collectionDocumentCandidates($record);
        if ($candidates === []) {
            return null;
        }

        $date = $this->normalizeOptionalDate($record['date'] ?? null);
        $amount = number_format($credit, 2, '.', '');

        $documentMatch = Collection::query()
            ->where('customer_id', $customer->id)
            ->where('source_system', 'b2b')
            ->where('amount', $amount)
            ->when($date !== null, function ($query) use ($date) {
                $query->where(function ($dateQuery) use ($date) {
                    $dateQuery
                        ->whereDate('date', $date)
                        ->orWhereDate('collection_date', $date);
                });
            })
            ->where(function ($query) use ($candidates) {
                $query
                    ->whereIn('reference_no', $candidates)
                    ->orWhereIn('note', $candidates);

                foreach ($candidates as $candidate) {
                    $query
                        ->orWhere('note', 'like', $candidate.' %')
                        ->orWhere('note', 'like', $candidate.'-%')
                        ->orWhere('note', 'like', $candidate.'/%');
                }
            })
            ->orderByDesc('id')
            ->first();

        if ($documentMatch instanceof Collection) {
            return $documentMatch;
        }

        $ledgerEchoMatch = $this->resolveLinkedB2bCollectionFromLedgerEcho($customer, $date, $amount, $candidates);
        if ($ledgerEchoMatch instanceof Collection) {
            return $ledgerEchoMatch;
        }

        return $this->resolveUniqueB2bCashCollectionByAmountAndDate($customer, $date, $amount);
    }

    /**
     * @param  list<string>  $candidates
     */
    private function resolveLinkedB2bCollectionFromLedgerEcho(
        Customer $customer,
        ?string $date,
        string $amount,
        array $candidates,
    ): ?Collection {
        if ($date === null || $candidates === []) {
            return null;
        }

        $matches = LedgerEntry::query()
            ->with('collection')
            ->where('customer_id', $customer->id)
            ->where('source_system', 'b2b')
            ->where('type', 'payment')
            ->where('credit', $amount)
            ->whereDate('date', $date)
            ->whereNotNull('collection_id')
            ->where(function ($query) use ($candidates) {
                $query
                    ->whereIn('reference_no', $candidates)
                    ->orWhereIn('description', $candidates);
            })
            ->whereHas('collection', function ($query) use ($amount) {
                $query
                    ->where('source_system', 'b2b')
                    ->where('method', 'cash')
                    ->where('amount', $amount);
            })
            ->orderByDesc('id')
            ->limit(2)
            ->get();

        if ($matches->count() !== 1) {
            return null;
        }

        $collection = $matches->first()?->collection;

        return $collection instanceof Collection ? $collection : null;
    }

    private function resolveUniqueB2bCashCollectionByAmountAndDate(Customer $customer, ?string $date, string $amount): ?Collection
    {
        if ($date === null) {
            return null;
        }

        $matches = Collection::query()
            ->where('customer_id', $customer->id)
            ->where('source_system', 'b2b')
            ->where('method', 'cash')
            ->where('amount', $amount)
            ->where(function ($dateQuery) use ($date) {
                $dateQuery
                    ->whereDate('date', $date)
                    ->orWhereDate('collection_date', $date);
            })
            ->orderByDesc('id')
            ->limit(2)
            ->get();

        return $matches->count() === 1 ? $matches->first() : null;
    }

    /**
     * @param  array<string, mixed>  $record
     * @return list<string>
     */
    private function collectionDocumentCandidates(array $record): array
    {
        $raw = $this->extractRawMeta($record);
        $values = [
            $record['reference_no'] ?? null,
            $record['description'] ?? null,
            $record['external_ref'] ?? null,
            $this->readRawValue($raw, ['FICHENO', 'ficheno']),
            $this->readRawValue($raw, ['DOCODE', 'docode']),
            $this->readRawValue($raw, ['TRANNO', 'tranno']),
            $this->readRawValue($raw, ['LINEEXP', 'lineexp']),
            $this->readRawValue($raw, ['SOURCE_REFERENCE', 'source_reference']),
        ];

        $candidates = [];
        foreach ($values as $value) {
            $normalized = $this->nullableString($value);
            if ($normalized === null) {
                continue;
            }

            $candidates[] = $normalized;

            if (preg_match_all('/\b[A-Z]{1,8}[-]?\d{2,20}\b/i', $normalized, $matches)) {
                foreach ($matches[0] as $match) {
                    $candidates[] = $match;
                }
            }
        }

        return collect($candidates)
            ->map(fn (string $candidate) => $this->nullableString($candidate))
            ->filter()
            ->unique()
            ->values()
            ->all();
    }

    /**
     * @param  array<string, mixed>  $record
     * @return array<string, mixed>
     */
    private function buildMeta(
        ?LedgerEntry $entry,
        array $record,
        bool $matchedProvisionalShipmentInvoice = false,
        bool $matchedLogoDocumentLedger = false,
    ): array {
        $meta = is_array($entry?->meta) ? $entry->meta : [];

        if ($matchedProvisionalShipmentInvoice) {
            Arr::set($meta, 'source', 'logo_ledger');
            Arr::set($meta, 'provisional_reconciled_at', now()->toIso8601String());
        }

        Arr::set($meta, 'integrations.logo.synced_at', now()->toIso8601String());
        Arr::set($meta, 'integrations.logo.external_ref', (string) $record['external_ref']);

        if ($matchedLogoDocumentLedger && $entry instanceof LedgerEntry) {
            $alternateRefs = collect(data_get($meta, 'integrations.logo.alternate_external_refs', []))
                ->push((string) $record['external_ref'])
                ->filter()
                ->unique()
                ->values()
                ->all();

            Arr::set($meta, 'integrations.logo.matched_by_document', true);
            Arr::set($meta, 'integrations.logo.alternate_external_refs', $alternateRefs);
        }

        if (! empty($record['meta']) && is_array($record['meta'])) {
            Arr::set($meta, 'integrations.logo.payload', $record['meta']);
        }

        return $meta;
    }

    /**
     * @param  array<string, mixed>  $record
     */
    private function resolveLedgerType(array $record, float $debit, float $credit): string
    {
        $raw = $this->extractRawMeta($record);
        $trcode = $this->readRawValue($raw, ['TRCODE', 'trcode'])
            ?? data_get($record, 'meta.logo_invoice_trcode');
        $trcodeValue = is_numeric($trcode) ? (int) $trcode : null;
        $module = $this->readRawValue($raw, ['MODULENR', 'MODULE_NR', 'MODULE', 'modulenr']);
        $moduleValue = is_numeric($module) ? (int) $module : null;
        $logoSource = trim((string) data_get($record, 'meta.logo_source'));

        if ($logoSource === 'invoice_fallback' || data_get($record, 'meta.logo_invoice_ref') !== null || $moduleValue === 4) {
            if (in_array($trcodeValue, [2, 3], true)) {
                return 'credit';
            }

            if (in_array($trcodeValue, [7, 8, 9], true)) {
                return 'invoice';
            }
        }

        if (in_array($trcodeValue, [20, 21, 61, 62, 63, 71, 73], true)) {
            return 'payment';
        }

        if ($moduleValue === 5 && $trcodeValue === 5) {
            return $credit > 0 ? 'payment' : 'debit';
        }

        if ($moduleValue === 10 && $trcodeValue === 1 && $credit > 0) {
            return 'payment';
        }

        $type = trim((string) ($record['type'] ?? ''));

        if (in_array($type, ['invoice', 'payment', 'credit', 'debit'], true)) {
            return $type;
        }

        return $debit > 0 ? 'invoice' : ($credit > 0 ? 'payment' : 'debit');
    }

    /**
     * @param  array<string, mixed>  $record
     */
    private function shouldMirrorCollection(array $record, LedgerEntry $ledgerEntry): bool
    {
        return $ledgerEntry->type === 'payment'
            && $this->normalizeMoney($record['credit'] ?? 0) > 0;
    }

    private function shouldMirrorLedgerEntry(LedgerEntry $ledgerEntry): bool
    {
        return $ledgerEntry->source_system === 'logo'
            && $ledgerEntry->type === 'payment'
            && (float) $ledgerEntry->credit > 0;
    }

    /**
     * @param  array<string, mixed>  $record
     */
    private function resolveCollectionMethod(array $record, LedgerEntry $ledgerEntry): string
    {
        $raw = $this->extractRawMeta($record);
        $trcode = $this->readRawValue($raw, ['TRCODE', 'trcode']);
        $trcodeValue = is_numeric($trcode) ? (int) $trcode : null;

        if (in_array($trcodeValue, [20, 21], true)) {
            return 'transfer';
        }

        if (in_array($trcodeValue, [61, 63], true)) {
            return 'check';
        }

        if (in_array($trcodeValue, [62, 71, 73], true)) {
            return 'note';
        }

        $searchText = Str::of(implode(' ', array_filter([
            (string) ($record['description'] ?? ''),
            (string) ($record['reference_no'] ?? ''),
            (string) data_get($record, 'meta.type', ''),
            (string) data_get($ledgerEntry->meta, 'integrations.logo.payload.type', ''),
            (string) $this->readRawValue($raw, ['LINEEXP', 'lineexp', 'TYPE', 'type', 'TRX_TYPE', 'trx_type']),
        ])))
            ->ascii()
            ->lower()
            ->value();

        if (str_contains($searchText, 'havale') || str_contains($searchText, 'transfer') || str_contains($searchText, 'eft')) {
            return 'transfer';
        }

        if (str_contains($searchText, 'senet') || str_contains($searchText, 'note')) {
            return 'note';
        }

        if (str_contains($searchText, 'cek') || str_contains($searchText, 'check')) {
            return 'check';
        }

        if (str_contains($searchText, 'kart') || str_contains($searchText, 'kredi kart') || str_contains($searchText, 'pos')) {
            return 'cc';
        }

        return 'cash';
    }

    /**
     * @param  array<string, mixed>  $record
     * @return array<string, string>
     */
    private function buildCollectionReferenceFields(array $record, string $method): array
    {
        $raw = $this->extractRawMeta($record);
        $referenceNo = $this->nullableString($record['reference_no'] ?? null);
        $fields = [];

        if ($method === 'transfer') {
            $fields['bank_name'] = $this->nullableString($this->readRawValue($raw, ['BANK_NAME', 'BANKA', 'BANK', 'BANKNAME']));
            $fields['transfer_no'] = $referenceNo;
            $fields['iban'] = $this->nullableString($this->readRawValue($raw, ['IBAN', 'BANK_IBAN']));
        }

        if ($method === 'check') {
            $fields['bank_name'] = $this->nullableString($this->readRawValue($raw, ['BANK_NAME', 'BANKA', 'BANK', 'BANKNAME']));
            $fields['check_no'] = $referenceNo;
            $fields['due_date'] = $this->normalizeOptionalDate(
                $this->readRawValue($raw, ['DUE_DATE', 'DUEDATE', 'VADE', 'duedate'])
            );
        }

        if ($method === 'note') {
            $fields['note_no'] = $referenceNo;
            $fields['due_date'] = $this->normalizeOptionalDate(
                $this->readRawValue($raw, ['DUE_DATE', 'DUEDATE', 'VADE', 'duedate'])
            );
        }

        if ($method === 'cc') {
            $fields['auth_code'] = $referenceNo;
            $fields['card_holder'] = $this->nullableString($this->readRawValue($raw, ['CARD_HOLDER', 'CARDHOLDER']));
            $fields['masked_pan'] = $this->nullableString($this->readRawValue($raw, ['MASKED_PAN', 'MASKEDPAN', 'CARD_NO']));
        }

        return collect($fields)
            ->filter(fn ($value) => $value !== null && $value !== '')
            ->map(fn ($value) => (string) $value)
            ->all();
    }

    /**
     * @param  array<string, mixed>  $record
     * @return array<string, mixed>
     */
    private function extractRawMeta(array $record): array
    {
        $meta = is_array($record['meta'] ?? null) ? $record['meta'] : [];

        return is_array($meta['raw'] ?? null) ? $meta['raw'] : [];
    }

    /**
     * @param  array<string, mixed>  $raw
     */
    private function readRawValue(array $raw, array $aliases): mixed
    {
        foreach ($aliases as $alias) {
            foreach ($raw as $key => $value) {
                if (strtoupper((string) $key) === strtoupper($alias)) {
                    return $value;
                }
            }
        }

        return null;
    }

    /**
     * @param  list<int>  $customerIds
     */
    private function recalculateBalances(array $customerIds): int
    {
        foreach ($customerIds as $customerId) {
            $runningBalance = 0.0;

            $entries = LedgerEntry::query()
                ->effectiveForCustomerBalance()
                ->where('customer_id', $customerId)
                ->orderBy('date')
                ->orderBy('id')
                ->get([
                    'id',
                    'debit',
                    'credit',
                    'entry_type',
                    'amount',
                ]);

            foreach ($entries as $entry) {
                $debit = $entry->debit !== null
                    ? (float) $entry->debit
                    : ($entry->entry_type === 'debit' ? (float) $entry->amount : 0.0);
                $credit = $entry->credit !== null
                    ? (float) $entry->credit
                    : ($entry->entry_type === 'credit' ? (float) $entry->amount : 0.0);

                $runningBalance += $debit - $credit;

                LedgerEntry::query()
                    ->whereKey($entry->id)
                    ->update([
                        'balance_after' => number_format($runningBalance, 2, '.', ''),
                    ]);
            }
        }

        return count($customerIds);
    }

    private function nullableString(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $normalized = trim((string) $value);

        return $normalized === '' ? null : $normalized;
    }

    private function normalizeOptionalDate(mixed $value): ?string
    {
        $normalized = $this->nullableString($value);
        if ($normalized === null) {
            return null;
        }

        try {
            return Carbon::parse($normalized)->toDateString();
        } catch (\Throwable) {
            return null;
        }
    }

    private function normalizeMoney(mixed $value): float
    {
        return round((float) $value, 2);
    }
}
