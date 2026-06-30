<?php

namespace App\Services\Integrations\Logo;

use App\Models\Cashbox;
use App\Models\Collection;
use App\Models\Customer;
use Illuminate\Support\Str;

class LogoWriteEventFactory
{
    /**
     * @return array<string, mixed>
     */
    public function customerCreate(Customer $customer): array
    {
        return $this->buildEnvelope(
            eventType: 'logo.customer.create',
            entityType: 'customer',
            entityId: (int) $customer->getKey(),
            dealerId: $customer->dealer_id,
            idempotencyKey: 'B2B-CUST-CREATE-'.$customer->id,
            payload: $this->customerPayload($customer),
        );
    }

    /**
     * @return array<string, mixed>
     */
    public function customerUpdate(Customer $customer): array
    {
        $payload = $this->customerPayload($customer);
        $payloadHash = $this->hashPayload($payload);

        return $this->buildEnvelope(
            eventType: 'logo.customer.update',
            entityType: 'customer',
            entityId: (int) $customer->getKey(),
            dealerId: $customer->dealer_id,
            idempotencyKey: 'B2B-CUST-UPDATE-'.$customer->id.'-'.substr($payloadHash, 0, 12),
            payload: $payload,
        );
    }

    /**
     * @return array<string, mixed>
     */
    public function collectionCreate(Collection $collection): array
    {
        return $this->buildEnvelope(
            eventType: 'logo.collection.create',
            entityType: 'collection',
            entityId: (int) $collection->getKey(),
            dealerId: $collection->dealer_id,
            idempotencyKey: $collection->logoExportKey().'-CREATE',
            payload: $this->collectionPayload($collection),
        );
    }

    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    private function buildEnvelope(
        string $eventType,
        string $entityType,
        int $entityId,
        ?int $dealerId,
        string $idempotencyKey,
        array $payload,
    ): array {
        return [
            'event_id' => (string) Str::uuid(),
            'event_type' => $eventType,
            'routing_key' => $eventType,
            'exchange' => (string) config('integrations.logo.write.exchange', 'powersa.logo'),
            'occurred_at' => now()->toIso8601String(),
            'dealer_id' => $dealerId,
            'entity_type' => $entityType,
            'entity_id' => $entityId,
            'idempotency_key' => $idempotencyKey,
            'payload' => $payload,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function customerPayload(Customer $customer): array
    {
        $meta = is_array($customer->meta) ? $customer->meta : [];

        return [
            'customer_id' => $customer->id,
            'export_key' => 'B2B-CUST-'.$customer->id,
            'dealer_id' => $customer->dealer_id,
            'salesperson_user_id' => $customer->salesperson_user_id,
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
            'region_code' => $customer->region_code,
            'region_name' => $customer->region_name,
            'branch_code' => $customer->branch_code,
            'branch_name' => $customer->branch_name,
            'source_system' => $customer->source_system,
            'source_reference' => $customer->source_reference,
            'sync_status' => $customer->sync_status,
            'meta' => $meta,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function collectionPayload(Collection $collection): array
    {
        $collection->loadMissing('customer:id,dealer_id,source_system,source_reference,code,name');

        $customer = $collection->customer;
        $meta = is_array($collection->meta) ? $collection->meta : [];
        $cashbox = $this->resolveCashboxPayload($meta);

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
            'source_system' => $collection->source_system,
            'source_reference' => $collection->source_reference,
            'sync_status' => $collection->sync_status,
            'meta' => array_replace_recursive($meta, [
                'cashbox' => $cashbox,
            ]),
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
            'code' => $this->normalizeCashboxCode($cashbox->code),
            'name' => $this->normalizeCashboxName($cashbox->code, $cashbox->name),
        ];
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    private function hashPayload(array $payload): string
    {
        return hash(
            'sha256',
            (string) json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
        );
    }

    private function nullableString(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $normalized = trim((string) $value);

        return $normalized === '' ? null : $normalized;
    }

    private function normalizeCashboxCode(mixed $code): ?string
    {
        $normalizedCode = $this->nullableString($code);

        if ($this->isLocalPointCashboxCode($normalizedCode)) {
            return $this->nullableString(config('integrations.pos.point_cashbox_code')) ?? $normalizedCode;
        }

        return $normalizedCode;
    }

    private function normalizeCashboxName(mixed $code, mixed $name): ?string
    {
        $normalizedName = $this->nullableString($name);

        if ($this->isLocalPointCashboxCode($this->nullableString($code))) {
            return $this->nullableString(config('integrations.pos.point_cashbox_name')) ?? $normalizedName;
        }

        return $normalizedName;
    }

    private function isLocalPointCashboxCode(?string $code): bool
    {
        return $code !== null && str_starts_with($code, 'POINT-');
    }
}
