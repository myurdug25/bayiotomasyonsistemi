<?php

namespace App\Services\Integrations\Logo;

use App\Models\Cashbox;
use App\Models\Collection;
use App\Models\Dealer;
use App\Services\Integrations\IntegrationSyncStateService;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class LogoCollectionExportService
{
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

        $statuses = collect((array) ($filters['statuses'] ?? ['pending', 'failed']))
            ->filter(fn ($status) => in_array($status, ['pending', 'failed'], true))
            ->values()
            ->all();

        if ($statuses === []) {
            $statuses = ['pending', 'failed'];
        }

        $limit = min((int) ($filters['limit'] ?? 100), 500);

        $query = Collection::query()
            ->with(['customer:id,dealer_id,source_system,source_reference,code,name'])
            ->where('source_system', 'b2b')
            ->whereIn('sync_status', $statuses)
            ->whereHas('customer', function ($q): void {
                $q->where(function ($customerQuery): void {
                    $customerQuery
                        ->whereNotNull('source_reference')
                        ->orWhere('source_system', 'logo')
                        ->orWhere(function ($b2bQuery): void {
                            $b2bQuery
                                ->where('source_system', 'b2b')
                                ->where('sync_status', 'synced');
                        });
                });
            })
            ->orderBy('date')
            ->orderBy('id')
            ->limit($limit);

        if ($dealer) {
            $query->where('dealer_id', $dealer->id);
        }

        $collections = $query->get();

        return [
            'received' => $collections->count(),
            'filters' => [
                'dealer_id' => $dealer?->id,
                'statuses' => $statuses,
                'limit' => $limit,
            ],
            'records' => $collections
                ->map(fn (Collection $collection): array => $this->transformCollection($collection))
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
                $collection = Collection::query()
                    ->with('ledgerEntries:id,collection_id,meta,last_synced_at')
                    ->find((int) $record['collection_id']);

                if (! $collection) {
                    throw ValidationException::withMessages([
                        "records.$index.collection_id" => ['Gonderilen tahsilat kaydi bulunamadi.'],
                    ]);
                }

                $status = (string) $record['status'];
                $externalReference = $this->nullableString($record['external_ref'] ?? null);
                $error = $this->nullableString($record['error'] ?? null);
                $syncTimestamp = now();
                $meta = is_array($collection->meta) ? $collection->meta : [];

                Arr::set($meta, 'integrations.logo.acknowledged_at', $syncTimestamp->toIso8601String());

                if ($externalReference !== null) {
                    Arr::set($meta, 'integrations.logo.external_ref', $externalReference);
                }

                if (! empty($record['meta']) && is_array($record['meta'])) {
                    Arr::set($meta, 'integrations.logo.payload', $record['meta']);
                }

                if ($status === 'failed' && $error !== null) {
                    Arr::set($meta, 'integrations.logo.last_error', $error);
                }

                $collection->fill([
                    'sync_status' => $status,
                    'sync_error' => $status === 'failed' ? $error : null,
                    'last_synced_at' => $syncTimestamp,
                    'source_reference' => $externalReference ?? $collection->source_reference,
                    'meta' => $meta,
                ])->save();

                $this->syncState->record(
                    system: 'logo',
                    domain: 'collections',
                    direction: 'outbound',
                    entity: $collection,
                    externalRef: $externalReference ?? $collection->source_reference,
                    status: $status,
                    error: $status === 'failed' ? $error : null,
                    meta: ['acknowledged' => true],
                    payload: $record,
                    syncedAt: $syncTimestamp,
                );

                $this->syncState->record(
                    system: 'logo',
                    domain: 'collections-write',
                    direction: 'outbound',
                    entity: $collection,
                    externalRef: $externalReference ?? $collection->source_reference,
                    status: $status,
                    error: $status === 'failed' ? $error : null,
                    meta: [
                        'acknowledged' => true,
                        'reconciled_from' => 'collections',
                    ],
                    payload: $record,
                    syncedAt: $syncTimestamp,
                );

                foreach ($collection->ledgerEntries as $ledgerEntry) {
                    $ledgerMeta = is_array($ledgerEntry->meta) ? $ledgerEntry->meta : [];
                    Arr::set($ledgerMeta, 'integrations.logo.collection_acknowledged_at', $syncTimestamp->toIso8601String());

                    if ($externalReference !== null) {
                        Arr::set($ledgerMeta, 'integrations.logo.collection_external_ref', $externalReference);
                    }

                    if ($status === 'failed' && $error !== null) {
                        Arr::set($ledgerMeta, 'integrations.logo.collection_last_error', $error);
                    }

                    $ledgerEntry->fill([
                        'last_synced_at' => $syncTimestamp,
                        'meta' => $ledgerMeta,
                    ])->save();
                }

                $summary[$status]++;
            }
        });

        return $summary;
    }

    /**
     * @return array<string, mixed>
     */
    private function transformCollection(Collection $collection): array
    {
        $customer = $collection->customer;
        $meta = is_array($collection->meta) ? $collection->meta : [];
        $cashbox = $this->resolveCashboxPayload($meta);
        $logoDefaults = is_array(data_get($meta, 'integrations.logo.defaults'))
            ? data_get($meta, 'integrations.logo.defaults')
            : [];

        return [
            'collection_id' => $collection->id,
            'export_key' => $collection->logoExportKey(),
            'dealer_id' => $collection->dealer_id,
            'customer_id' => $collection->customer_id,
            'customer_code' => $customer?->code,
            'customer_external_ref' => $customer?->source_reference,
            'date' => optional($collection->date ?? $collection->collection_date)?->toDateString(),
            'method' => $collection->method,
            'amount' => number_format((float) $collection->amount, 2, '.', ''),
            'currency' => strtoupper((string) $collection->currency),
            'reference_no' => $collection->reference_no,
            'reference_fields' => $collection->reference_fields ?? [],
            'note' => $collection->note,
            'cashbox_id' => $cashbox['id'] ?? null,
            'cashbox_code' => $cashbox['code'] ?? null,
            'cashbox_name' => $cashbox['name'] ?? null,
            'logo' => [
                'trcode' => data_get($logoDefaults, 'trcode'),
                'modulenr' => data_get($logoDefaults, 'modulenr'),
                'sign' => data_get($logoDefaults, 'sign', 1),
                'branch' => data_get($logoDefaults, 'branch'),
                'department' => data_get($logoDefaults, 'department'),
                'trading_group' => data_get($logoDefaults, 'trading_group'),
                'trrate' => data_get($logoDefaults, 'trrate'),
                'report_rate' => data_get($logoDefaults, 'report_rate'),
                'docode' => data_get($logoDefaults, 'docode') ?? $collection->reference_no,
                'trans_no' => data_get($logoDefaults, 'trans_no') ?? $collection->reference_no,
                'source_fref' => data_get($logoDefaults, 'source_fref'),
                'paydef_ref' => data_get($logoDefaults, 'paydef_ref'),
                'target_tables' => ['KSLINES', 'CLFLINE', 'PAYTRANS'],
            ],
            'sync_status' => $collection->sync_status,
            'sync_error' => $collection->sync_error,
            'meta' => [
                'created_at' => optional($collection->created_at)?->toIso8601String(),
                'updated_at' => optional($collection->updated_at)?->toIso8601String(),
                'logo_external_ref' => data_get($meta, 'integrations.logo.external_ref'),
                'cashbox' => $cashbox,
            ],
        ];
    }

    /**
     * @param  array<string, mixed>  $meta
     * @return array{id:int,code:?string,name:?string}|null
     */
    private function resolveCashboxPayload(array $meta): ?array
    {
        $cashboxId = data_get($meta, 'cashbox_id');

        if (! is_numeric($cashboxId)) {
            return null;
        }

        $cashbox = Cashbox::query()->find((int) $cashboxId);

        if (! $cashbox) {
            return [
                'id' => (int) $cashboxId,
                'code' => null,
                'name' => null,
            ];
        }

        return [
            'id' => (int) $cashbox->id,
            'code' => $this->normalizeCashboxCode($cashbox->code, $cashbox->name),
            'name' => $this->normalizeCashboxName($cashbox->code, $cashbox->name),
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

    private function normalizeCashboxCode(mixed $code, mixed $name = null): ?string
    {
        $normalizedCode = $this->nullableString($code);
        $normalizedName = $this->nullableString($name);

        if ($this->isLocalPointCashboxCode($normalizedCode)) {
            return $this->pointLogoCashboxCode($normalizedCode, $normalizedName) ?? $normalizedCode;
        }

        return $normalizedCode;
    }

    private function normalizeCashboxName(mixed $code, mixed $name): ?string
    {
        $normalizedName = $this->nullableString($name);

        if ($this->isLocalPointCashboxCode($this->nullableString($code))) {
            return $this->pointLogoCashboxName($this->nullableString($code), $normalizedName) ?? $normalizedName;
        }

        return $normalizedName;
    }

    private function isLocalPointCashboxCode(?string $code): bool
    {
        return $code !== null && str_starts_with($code, 'POINT-');
    }

    private function pointLogoCashboxCode(?string $code, ?string $name): ?string
    {
        if ($this->isBatumCashbox($code, $name)) {
            return $this->nullableString(config('integrations.pos.batum_point_cashbox_code'));
        }

        return $this->nullableString(config('integrations.pos.erzurum_point_cashbox_code'))
            ?? $this->nullableString(config('integrations.pos.point_cashbox_code'));
    }

    private function pointLogoCashboxName(?string $code, ?string $name): ?string
    {
        if ($this->isBatumCashbox($code, $name)) {
            return $this->nullableString(config('integrations.pos.batum_point_cashbox_name'));
        }

        return $this->nullableString(config('integrations.pos.erzurum_point_cashbox_name'))
            ?? $this->nullableString(config('integrations.pos.point_cashbox_name'));
    }

    private function isBatumCashbox(?string $code, ?string $name): bool
    {
        $haystack = mb_strtoupper(trim(($code ?? '').' '.($name ?? '')), 'UTF-8');

        return str_contains($haystack, 'BATUM');
    }
}
