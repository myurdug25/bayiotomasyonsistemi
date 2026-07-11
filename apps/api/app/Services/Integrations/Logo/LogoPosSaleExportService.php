<?php

namespace App\Services\Integrations\Logo;

use App\Models\Dealer;
use App\Models\IntegrationSyncState;
use App\Models\PosSale;
use App\Models\PosSaleItem;
use App\Services\Integrations\IntegrationSyncStateService;
use Illuminate\Support\Collection;
use Illuminate\Validation\ValidationException;

class LogoPosSaleExportService
{
    private const ERZURUM_POINT_CURRENCY = 'TRY';

    private const BATUM_POINT_CURRENCY = 'GEL';

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

        $statuses = collect((array) ($filters['statuses'] ?? ['queued', 'failed']))
            ->filter(fn ($status) => in_array($status, ['queued', 'failed'], true))
            ->values()
            ->all();

        if ($statuses === []) {
            $statuses = ['queued', 'failed'];
        }

        $limit = min((int) ($filters['limit'] ?? 100), 500);

        $states = IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'pos-sales')
            ->where('direction', 'outbound')
            ->where('entity_type', PosSale::class)
            ->whereIn('status', $statuses)
            ->orderBy('id')
            ->limit($limit)
            ->get();

        $sales = PosSale::query()
            ->with([
                'customer:id,dealer_id,source_system,source_reference,code,name',
                'items.product:id,sku,oem_code,name,unit,vat_rate,meta',
                'payments',
                'posSession.cashbox',
                'posSession.openedBy:id,name,username,email,branch_code,branch_name,region_code',
                'createdBy:id,name,username,email,branch_code,branch_name,region_code',
            ])
            ->whereIn('id', $states->pluck('entity_id')->map(fn ($id) => (int) $id)->all())
            ->where('status', 'paid')
            ->whereIn('document_type', ['delivery', 'invoice'])
            ->get()
            ->keyBy('id');

        $records = $states
            ->map(function (IntegrationSyncState $state) use ($sales, $dealer): ?array {
                $sale = $sales->get((int) $state->entity_id);

                if (! $sale instanceof PosSale) {
                    return null;
                }

                if ($dealer instanceof Dealer && (int) $sale->customer?->dealer_id !== (int) $dealer->id) {
                    return null;
                }

                return $this->transformSale($sale, $state);
            })
            ->filter()
            ->values();

        return [
            'received' => $records->count(),
            'filters' => [
                'dealer_id' => $dealer?->id,
                'statuses' => $statuses,
                'limit' => $limit,
            ],
            'records' => $records->all(),
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

        foreach ((array) ($payload['records'] ?? []) as $index => $record) {
            $sale = PosSale::query()->with('customer:id,dealer_id')->find((int) $record['pos_sale_id']);

            if (! $sale instanceof PosSale) {
                throw ValidationException::withMessages([
                    "records.$index.pos_sale_id" => ['Gonderilen POS satis kaydi bulunamadi.'],
                ]);
            }

            $status = (string) $record['status'];
            $externalReference = $this->nullableString($record['external_ref'] ?? null);
            $error = $this->nullableString($record['error'] ?? null);

            $this->syncState->record(
                system: 'logo',
                domain: 'pos-sales',
                direction: 'outbound',
                entity: $sale,
                externalRef: $externalReference,
                status: $status,
                error: $status === 'failed' ? $error : null,
                meta: [
                    'acknowledged' => true,
                    'export_key' => 'B2B-POSSALE-'.$sale->id,
                    'payload' => is_array($record['meta'] ?? null) ? $record['meta'] : [],
                ],
                payload: $record,
                syncedAt: now(),
            );

            $summary[$status]++;
        }

        return $summary;
    }

    /**
     * @return array<string, mixed>
     */
    private function transformSale(PosSale $sale, IntegrationSyncState $state): array
    {
        $customer = $sale->customer;
        $cashbox = $sale->posSession?->cashbox;
        $cashboxPayload = $this->normalizeCashboxPayload($cashbox?->id, $cashbox?->code, $cashbox?->name);
        $currency = $this->pointCurrency($cashboxPayload['code'] ?? $cashbox?->code, $cashboxPayload['name'] ?? $cashbox?->name);

        return [
            'pos_sale_id' => $sale->id,
            'export_key' => 'B2B-POSSALE-'.$sale->id,
            'dealer_id' => $customer?->dealer_id,
            'customer_id' => $sale->customer_id,
            'customer_code' => $customer?->code,
            'customer_external_ref' => $customer?->source_reference,
            'receipt_no' => $sale->receipt_no,
            'date' => optional($sale->created_at)?->toDateString(),
            'sale_type' => $sale->sale_type,
            'document_type' => $sale->document_type,
            'subtotal' => number_format((float) $sale->subtotal, 2, '.', ''),
            'discount_total' => number_format((float) $sale->discount_total, 2, '.', ''),
            'vat_total' => number_format((float) $sale->vat_total, 2, '.', ''),
            'grand_total' => number_format((float) $sale->grand_total, 2, '.', ''),
            'currency' => $currency,
            'cashbox_id' => $cashboxPayload['id'] ?? null,
            'cashbox_code' => $cashboxPayload['code'] ?? null,
            'cashbox_name' => $cashboxPayload['name'] ?? null,
            'logo' => $this->logoPayload($sale),
            'sync_status' => $state->status,
            'sync_error' => $state->last_error,
            'items' => $this->transformItems($sale->items),
            'payments' => $sale->payments
                ->map(fn ($payment): array => [
                    'method' => $payment->method,
                    'amount' => number_format((float) $payment->amount, 2, '.', ''),
                    'currency' => $currency,
                    'meta' => $payment->meta_json ?? [],
                ])
                ->values()
                ->all(),
            'meta' => [
                'created_at' => optional($sale->created_at)?->toIso8601String(),
                'updated_at' => optional($sale->updated_at)?->toIso8601String(),
                'logo_external_ref' => $state->external_ref,
                'cashbox' => $cashboxPayload,
            ],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function logoPayload(PosSale $sale): array
    {
        $pointWarehouseNo = $this->pointWarehouseNo($sale);

        $payload = [
            'branch' => data_get($sale->meta_json, 'integrations.logo.branch') ?? $pointWarehouseNo,
            'department' => data_get($sale->meta_json, 'integrations.logo.department'),
            'source_index' => data_get($sale->meta_json, 'integrations.logo.source_index') ?? $pointWarehouseNo,
            'warehouse_no' => data_get($sale->meta_json, 'integrations.logo.warehouse_no') ?? $pointWarehouseNo,
        ];

        if ($sale->document_type === 'delivery') {
            return array_filter([
                ...$payload,
                'document_target' => 'sales_dispatch_note',
                'document_label' => 'Satış İrsaliyesi',
                'trcode' => 8,
                'stock_trcode' => 8,
                'iocode' => 4,
                'target_tables' => ['STFICHE', 'STLINE'],
            ], fn ($value): bool => $value !== null);
        }

        return array_filter([
            ...$payload,
            'document_target' => 'sales_invoice',
            'document_label' => 'Satış Faturası',
            'trcode' => 8,
            'invoice_trcode' => 8,
            'stock_trcode' => 8,
            'iocode' => 4,
            'target_tables' => ['INVOICE', 'STFICHE', 'STLINE'],
        ], fn ($value): bool => $value !== null);
    }

    /**
     * @param  Collection<int, PosSaleItem>  $items
     * @return list<array<string, mixed>>
     */
    private function transformItems(Collection $items): array
    {
        return $items
            ->map(function ($item): array {
                $product = $item->product;
                $productMeta = is_array($product?->meta) ? $product->meta : [];

                return [
                    'product_id' => $item->product_id,
                    'product_code' => $product?->sku,
                    'product_oem_code' => $product?->oem_code,
                    'product_external_ref' => data_get($productMeta, 'integrations.logo.external_ref'),
                    'product_name' => $product?->name,
                    'unit' => $product?->unit,
                    'qty' => number_format((float) $item->qty, 3, '.', ''),
                    'unit_price' => number_format((float) $item->unit_price, 2, '.', ''),
                    'vat_rate' => number_format((float) $item->vat_rate, 2, '.', ''),
                    'line_total' => number_format((float) $item->line_total, 2, '.', ''),
                    'logo' => [
                        'stock_ref' => data_get($productMeta, 'integrations.logo.external_ref'),
                        'unitset_ref' => data_get($productMeta, 'integrations.logo.payload.unitset_ref')
                            ?? data_get($productMeta, 'integrations.logo.payload.raw.UNITSETREF'),
                        'uom_ref' => data_get($productMeta, 'integrations.logo.payload.logo_price.uomref')
                            ?? data_get($productMeta, 'integrations.logo.payload.raw.UOMREF'),
                        'vat_included' => data_get($productMeta, 'integrations.logo.payload.logo_price.incvat'),
                        'warehouse_totals' => data_get($productMeta, 'integrations.logo.payload.logo_stock.warehouses'),
                        'raw' => data_get($productMeta, 'integrations.logo.payload.raw'),
                    ],
                    'meta' => [
                        'logo' => data_get($productMeta, 'integrations.logo.payload'),
                    ],
                ];
            })
            ->values()
            ->all();
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

        $value = trim((string) $value);

        return $value === '' ? null : $value;
    }

    /**
     * @return array{id:int|null,code:?string,name:?string}|null
     */
    private function normalizeCashboxPayload(mixed $id, mixed $code, mixed $name): ?array
    {
        $normalizedCode = $this->nullableString($code);
        $normalizedName = $this->nullableString($name);

        if ($normalizedCode === null && $normalizedName === null && $id === null) {
            return null;
        }

        $isLocalPointCashbox = $this->isLocalPointCashboxCode($normalizedCode);

        if ($isLocalPointCashbox) {
            $normalizedCode = $this->pointLogoCashboxCode($normalizedCode, $normalizedName) ?? $normalizedCode;
            $normalizedName = $this->pointLogoCashboxName($normalizedCode, $normalizedName) ?? $normalizedName;
        }

        return [
            'id' => $isLocalPointCashbox ? null : (is_numeric($id) ? (int) $id : null),
            'code' => $normalizedCode,
            'name' => $normalizedName,
        ];
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

    private function pointCurrency(?string $code, ?string $name): string
    {
        return $this->isBatumCashbox($code, $name) ? self::BATUM_POINT_CURRENCY : self::ERZURUM_POINT_CURRENCY;
    }

    private function isBatumCashbox(?string $code, ?string $name): bool
    {
        $haystack = mb_strtoupper(trim(($code ?? '').' '.($name ?? '')), 'UTF-8');
        $normalizedCode = mb_strtoupper(trim((string) $code), 'UTF-8');
        $batumCashboxCode = mb_strtoupper(trim((string) config('integrations.pos.batum_point_cashbox_code')), 'UTF-8');

        return str_contains($haystack, 'BATUM')
            || ($batumCashboxCode !== '' && $normalizedCode === $batumCashboxCode);
    }

    private function pointWarehouseNo(PosSale $sale): int
    {
        $sale->loadMissing('posSession.cashbox', 'posSession.openedBy', 'createdBy');

        $cashbox = $sale->posSession?->cashbox;
        $user = $sale->posSession?->openedBy ?? $sale->createdBy;

        if ($this->isBatumCashbox($cashbox?->code, $cashbox?->name)) {
            return $this->configuredPointWarehouseNo('batum_point_warehouse_no', 4);
        }

        $haystack = mb_strtoupper(trim(implode(' ', array_filter([
            $cashbox?->code,
            $cashbox?->name,
            $user?->username,
            $user?->email,
            $user?->name,
            $user?->branch_code,
            $user?->branch_name,
            $user?->region_code,
        ], fn ($value): bool => is_scalar($value) && trim((string) $value) !== ''))), 'UTF-8');

        if (str_contains($haystack, 'BATUM')) {
            return $this->configuredPointWarehouseNo('batum_point_warehouse_no', 4);
        }

        if (str_contains($haystack, 'TRABZON')) {
            return $this->configuredPointWarehouseNo('trabzon_point_warehouse_no', 2);
        }

        if (str_contains($haystack, 'SAMSUN')) {
            return $this->configuredPointWarehouseNo('samsun_point_warehouse_no', 3);
        }

        return $this->configuredPointWarehouseNo('erzurum_point_warehouse_no', $this->configuredPointWarehouseNo('point_warehouse_no', 0));
    }

    private function configuredPointWarehouseNo(string $key, int $fallback): int
    {
        $value = config('integrations.pos.'.$key);

        return is_numeric($value) ? (int) $value : $fallback;
    }
}
