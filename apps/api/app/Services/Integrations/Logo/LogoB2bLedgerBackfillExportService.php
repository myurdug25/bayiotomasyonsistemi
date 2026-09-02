<?php

namespace App\Services\Integrations\Logo;

use App\Models\Dealer;
use App\Models\IntegrationSyncState;
use App\Models\LedgerEntry;
use App\Services\Integrations\IntegrationSyncStateService;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class LogoB2bLedgerBackfillExportService
{
    public const DOMAIN = 'b2b-ledger-backfill';

    public function __construct(
        private readonly IntegrationSyncStateService $syncState
    ) {}

    /**
     * @param  array<string, mixed>  $filters
     * @return array<string, mixed>
     */
    public function pending(array $filters): array
    {
        $dealer = $this->resolveDealer(
            $filters['dealer_id'] ?? null,
            $filters['dealer_code'] ?? null,
        );
        $customerCode = $this->nullableString($filters['customer_code'] ?? null);
        $limit = min((int) ($filters['limit'] ?? 100), 500);

        $query = LedgerEntry::query()
            ->with('customer:id,dealer_id,source_system,source_reference,code,name')
            ->effectiveForCustomerBalance()
            ->where('source_system', 'b2b')
            ->whereNull('collection_id')
            ->where(function (Builder $query): void {
                $query
                    ->whereNull('order_id')
                    ->orWhere('meta->source', 'return_request');
            })
            ->whereHas('customer', function (Builder $query) use ($customerCode): void {
                $query
                    ->where(function (Builder $customerQuery): void {
                        $customerQuery
                            ->whereNotNull('source_reference')
                            ->orWhere('source_system', 'logo');
                    })
                    ->when($customerCode !== null, fn (Builder $q) => $q->where('code', $customerCode));
            })
            ->where(function (Builder $query): void {
                $query
                    ->whereRaw('COALESCE(debit, 0) <> 0')
                    ->orWhereRaw('COALESCE(credit, 0) <> 0')
                    ->orWhereRaw('COALESCE(amount, 0) <> 0');
            })
            ->whereNotExists(function ($subquery): void {
                $subquery
                    ->selectRaw('1')
                    ->from('integration_sync_states as logo_b2b_ledger_backfill_states')
                    ->whereColumn('logo_b2b_ledger_backfill_states.entity_id', 'ledger_entries.id')
                    ->where('logo_b2b_ledger_backfill_states.entity_type', LedgerEntry::class)
                    ->where('logo_b2b_ledger_backfill_states.system', 'logo')
                    ->where('logo_b2b_ledger_backfill_states.domain', self::DOMAIN)
                    ->where('logo_b2b_ledger_backfill_states.direction', 'outbound')
                    ->where('logo_b2b_ledger_backfill_states.status', 'synced');
            })
            ->orderBy('date')
            ->orderBy('id');

        if ($dealer) {
            $query->where('dealer_id', $dealer->id);
        }

        $entries = $query
            ->limit($limit)
            ->get();

        return [
            'received' => $entries->count(),
            'filters' => [
                'dealer_id' => $dealer?->id,
                'customer_code' => $customerCode,
                'limit' => $limit,
            ],
            'records' => $entries
                ->map(fn (LedgerEntry $entry): array => $this->transformLedgerEntry($entry))
                ->values()
                ->all(),
        ];
    }

    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, int>
     */
    public function acknowledge(array $payload): array
    {
        $summary = [
            'received' => count($payload['records'] ?? []),
            'synced' => 0,
            'failed' => 0,
            'skipped' => 0,
        ];

        DB::transaction(function () use ($payload, &$summary): void {
            foreach ((array) ($payload['records'] ?? []) as $index => $record) {
                $entry = LedgerEntry::query()->find((int) $record['ledger_entry_id']);

                if (! $entry) {
                    throw ValidationException::withMessages([
                        "records.$index.ledger_entry_id" => ['Gonderilen cari hareket kaydi bulunamadi.'],
                    ]);
                }

                $status = (string) $record['status'];
                $externalReference = $this->nullableString($record['external_ref'] ?? null);
                $error = $this->nullableString($record['error'] ?? null);
                $syncedAt = now();
                $meta = is_array($entry->meta) ? $entry->meta : [];

                Arr::set($meta, 'integrations.logo.b2b_ledger_backfill_acknowledged_at', $syncedAt->toIso8601String());

                if ($externalReference !== null) {
                    Arr::set($meta, 'integrations.logo.b2b_ledger_backfill_external_ref', $externalReference);
                }

                if (! empty($record['meta']) && is_array($record['meta'])) {
                    Arr::set($meta, 'integrations.logo.b2b_ledger_backfill_payload', $record['meta']);
                }

                if ($status === 'failed' && $error !== null) {
                    Arr::set($meta, 'integrations.logo.b2b_ledger_backfill_last_error', $error);
                }

                $entry->fill([
                    'source_reference' => $externalReference ?? $entry->source_reference,
                    'last_synced_at' => $syncedAt,
                    'meta' => $meta,
                ])->save();

                $this->syncState->record(
                    system: 'logo',
                    domain: self::DOMAIN,
                    direction: 'outbound',
                    entity: $entry,
                    externalRef: $externalReference ?? $entry->source_reference,
                    status: $status,
                    error: $status === 'failed' ? $error : null,
                    meta: ['acknowledged' => true],
                    payload: $record,
                    syncedAt: $syncedAt,
                );

                $summary[$status]++;
            }
        });

        return $summary;
    }

    /**
     * @return array<string, mixed>
     */
    private function transformLedgerEntry(LedgerEntry $entry): array
    {
        $customer = $entry->customer;
        $sign = (float) $entry->debit > 0 ? 0 : 1;
        $amount = $sign === 0
            ? (float) $entry->debit
            : (float) ($entry->credit ?: $entry->amount);

        if ($amount < 0) {
            $amount = abs($amount);
        }

        return [
            'ledger_entry_id' => $entry->id,
            'export_key' => 'B2B-LEDGER-'.$entry->id,
            'dealer_id' => $entry->dealer_id,
            'customer_id' => $entry->customer_id,
            'customer_code' => $customer?->code,
            'customer_name' => $customer?->name,
            'customer_external_ref' => $customer?->source_reference,
            'date' => optional($entry->date ?? $entry->entry_date)?->toDateString(),
            'type' => $entry->type ?? $entry->entry_type,
            'sign' => $sign,
            'amount' => number_format($amount, 2, '.', ''),
            'currency' => strtoupper((string) ($entry->currency ?: 'TRY')),
            'reference_no' => $entry->reference_no,
            'description' => $entry->description,
            'meta' => [
                'source_system' => $entry->source_system,
                'source_reference' => $entry->source_reference,
                'created_at' => optional($entry->created_at)?->toIso8601String(),
                'updated_at' => optional($entry->updated_at)?->toIso8601String(),
            ],
        ];
    }

    private function resolveDealer(mixed $dealerId, mixed $dealerCode): ?Dealer
    {
        if ($dealerId !== null && $dealerId !== '') {
            return Dealer::query()->find((int) $dealerId);
        }

        $normalizedDealerCode = $this->nullableString($dealerCode);
        if ($normalizedDealerCode !== null) {
            return Dealer::query()
                ->where('code', $normalizedDealerCode)
                ->first();
        }

        return null;
    }

    private function nullableString(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $normalized = trim((string) $value);

        return $normalized === '' ? null : $normalized;
    }
}
