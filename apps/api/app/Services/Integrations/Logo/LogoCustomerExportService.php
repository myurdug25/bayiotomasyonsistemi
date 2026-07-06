<?php

namespace App\Services\Integrations\Logo;

use App\Models\Collection;
use App\Models\Customer;
use App\Models\Dealer;
use App\Services\Integrations\IntegrationSyncStateService;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class LogoCustomerExportService
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

        $query = Customer::query()
            ->where('source_system', 'b2b')
            ->whereIn('sync_status', $statuses)
            ->orderByRaw("CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END")
            ->orderByDesc('updated_at')
            ->orderByDesc('id')
            ->limit($limit);

        if ($dealer) {
            $query->where('dealer_id', $dealer->id);
        }

        $customers = $query->get();

        return [
            'received' => $customers->count(),
            'filters' => [
                'dealer_id' => $dealer?->id,
                'statuses' => $statuses,
                'limit' => $limit,
            ],
            'records' => $customers
                ->map(fn (Customer $customer): array => $this->transformCustomer($customer))
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
                $customer = Customer::query()->find((int) $record['customer_id']);

                if (! $customer) {
                    throw ValidationException::withMessages([
                        "records.$index.customer_id" => ['Gonderilen cari kaydi bulunamadi.'],
                    ]);
                }

                $status = (string) $record['status'];
                $externalReference = $this->nullableString($record['external_ref'] ?? null);
                $error = $this->nullableString($record['error'] ?? null);
                $syncTimestamp = now();
                $meta = is_array($customer->meta) ? $customer->meta : [];

                Arr::set($meta, 'integrations.logo.acknowledged_at', $syncTimestamp->toIso8601String());

                if ($externalReference !== null) {
                    Arr::set($meta, 'integrations.logo.external_ref', $externalReference);
                }

                if (! empty($record['meta']) && is_array($record['meta'])) {
                    $existingLogoPayload = Arr::get($meta, 'integrations.logo.payload', []);
                    Arr::set(
                        $meta,
                        'integrations.logo.payload',
                        array_replace_recursive(
                            is_array($existingLogoPayload) ? $existingLogoPayload : [],
                            $record['meta']
                        )
                    );
                }

                if ($status === 'failed' && $error !== null) {
                    Arr::set($meta, 'integrations.logo.last_error', $error);
                }

                $customer->fill([
                    'source_reference' => $status === 'synced'
                        ? ($externalReference ?? $customer->source_reference)
                        : $customer->source_reference,
                    'sync_status' => $status,
                    'sync_error' => $status === 'failed' ? $error : null,
                    'last_synced_at' => $syncTimestamp,
                    'meta' => $meta,
                ])->save();

                $this->syncState->record(
                    system: 'logo',
                    domain: 'customers',
                    direction: 'outbound',
                    entity: $customer,
                    externalRef: $externalReference ?? $customer->source_reference,
                    status: $status,
                    error: $status === 'failed' ? $error : null,
                    meta: ['acknowledged' => true],
                    payload: $record,
                    syncedAt: $syncTimestamp,
                );

                $this->syncState->record(
                    system: 'logo',
                    domain: 'customers-write',
                    direction: 'outbound',
                    entity: $customer,
                    externalRef: $externalReference ?? $customer->source_reference,
                    status: $status,
                    error: $status === 'failed' ? $error : null,
                    meta: [
                        'acknowledged' => true,
                        'reconciled_from' => 'customers',
                    ],
                    payload: $record,
                    syncedAt: $syncTimestamp,
                );

                if ($status === 'synced' && $customer->source_reference !== null) {
                    Collection::query()
                        ->where('customer_id', $customer->id)
                        ->where('source_system', 'b2b')
                        ->whereNull('sync_status')
                        ->update([
                            'sync_status' => 'pending',
                            'sync_error' => null,
                        ]);
                }

                $summary[$status]++;
            }
        });

        return $summary;
    }

    /**
     * @return array<string, mixed>
     */
    private function transformCustomer(Customer $customer): array
    {
        $meta = is_array($customer->meta) ? $customer->meta : [];
        $logoPayload = data_get($meta, 'integrations.logo.payload');
        $logoRaw = is_array(data_get($logoPayload, 'raw')) ? data_get($logoPayload, 'raw') : [];

        return [
            'customer_id' => $customer->id,
            'export_key' => 'B2B-CUST-'.$customer->id,
            'dealer_id' => $customer->dealer_id,
            'customer_code' => $customer->code,
            'name' => $customer->name,
            'contact_name' => $customer->contact_name,
            'email' => $customer->email,
            'phone' => $customer->phone,
            'city' => $customer->city,
            'district' => $customer->district,
            'tax_office' => $customer->tax_office,
            'tax_number' => $customer->tax_number,
            'credit_limit' => number_format((float) $customer->credit_limit, 2, '.', ''),
            'is_active' => (bool) $customer->is_active,
            'address' => $meta['address'] ?? $meta['full_address'] ?? null,
            'iban' => $meta['iban'] ?? null,
            'card_type' => data_get($logoPayload, 'cardtype') ?? data_get($logoRaw, 'CARDTYPE') ?? 3,
            'specode' => data_get($logoPayload, 'specode') ?? data_get($logoRaw, 'SPECODE'),
            'specode2' => data_get($logoPayload, 'specode2') ?? data_get($logoRaw, 'SPECODE2'),
            'specode3' => data_get($logoPayload, 'specode3') ?? data_get($logoRaw, 'SPECODE3'),
            'specode4' => data_get($logoPayload, 'specode4') ?? data_get($logoRaw, 'SPECODE4'),
            'specode5' => data_get($logoPayload, 'specode5') ?? data_get($logoRaw, 'SPECODE5'),
            'cyphcode' => data_get($logoPayload, 'cyphcode') ?? data_get($logoRaw, 'CYPHCODE'),
            'customer_kind' => data_get($logoPayload, 'customer_kind'),
            'e_collection_note' => data_get($logoPayload, 'e_collection_note'),
            'postcode' => data_get($logoPayload, 'postcode') ?? data_get($logoRaw, 'POSTCODE'),
            'country' => data_get($logoPayload, 'country') ?? data_get($logoRaw, 'COUNTRY'),
            'country_code' => data_get($logoPayload, 'country_code') ?? data_get($logoRaw, 'COUNTRYCODE'),
            'city_code' => data_get($logoPayload, 'city_code') ?? data_get($logoRaw, 'CITYCODE'),
            'town_code' => data_get($logoPayload, 'town_code') ?? data_get($logoRaw, 'TOWNCODE'),
            'trading_group' => data_get($logoPayload, 'trading_group') ?? data_get($logoRaw, 'TRADINGGRP'),
            'payment_ref' => data_get($logoPayload, 'payment_ref') ?? data_get($logoRaw, 'PAYMENTREF'),
            'discount_rate' => data_get($logoPayload, 'discount_rate') ?? data_get($logoRaw, 'DISCRATE'),
            'blocked' => data_get($logoPayload, 'blocked') ?? data_get($logoRaw, 'BLOCKED'),
            'delivery_method' => data_get($logoPayload, 'delivery_method') ?? data_get($logoRaw, 'DELIVERYMETHOD'),
            'delivery_firm' => data_get($logoPayload, 'delivery_firm') ?? data_get($logoRaw, 'DELIVERYFIRM'),
            'currency_code' => data_get($logoPayload, 'currency_code') ?? data_get($logoRaw, 'CCURRENCY'),
            'phone_2' => data_get($logoPayload, 'phone_2') ?? data_get($logoRaw, 'TELNRS2'),
            'fax' => data_get($logoPayload, 'fax') ?? data_get($logoRaw, 'FAXNR'),
            'website' => data_get($logoPayload, 'website') ?? data_get($logoRaw, 'WEBADDR'),
            'bank_branches' => data_get($logoPayload, 'bank_branches'),
            'bank_accounts' => data_get($logoPayload, 'bank_accounts'),
            'logo' => [
                'document_type' => 'customer_card',
                'document_label' => 'Cari Hesap Karti',
                'card_type' => data_get($logoPayload, 'cardtype') ?? data_get($logoRaw, 'CARDTYPE') ?? 3,
                'card_label' => '(AS) Alici + Satici',
                'target_tables' => ['CLCARD'],
            ],
            'sync_status' => $customer->sync_status,
            'sync_error' => $customer->sync_error,
            'meta' => [
                'created_at' => optional($customer->created_at)?->toIso8601String(),
                'updated_at' => optional($customer->updated_at)?->toIso8601String(),
                'customer_card_request' => $meta['customer_card_request'] ?? null,
                'logo_external_ref' => data_get($meta, 'integrations.logo.external_ref'),
                'logo' => $logoPayload,
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
