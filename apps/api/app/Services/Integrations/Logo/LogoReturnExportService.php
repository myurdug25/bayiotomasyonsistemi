<?php

namespace App\Services\Integrations\Logo;

use App\Models\Dealer;
use App\Models\IntegrationSyncState;
use App\Models\ReturnRequest;
use App\Services\Integrations\IntegrationSyncStateService;
use Illuminate\Validation\ValidationException;

class LogoReturnExportService
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
            ->where('domain', 'returns')
            ->where('direction', 'outbound')
            ->where('entity_type', ReturnRequest::class)
            ->whereIn('status', $statuses)
            ->orderBy('id')
            ->limit($limit)
            ->get();

        $returns = ReturnRequest::query()
            ->with([
                'dealer:id,code,name',
                'customer:id,dealer_id,source_system,source_reference,code,name,city,district,phone,tax_office,tax_number,meta',
                'order:id,order_no,ordered_at,currency,grand_total',
                'orderItem.product:id,sku,oem_code,name,unit,vat_rate,meta',
                'requestedBy:id,name',
                'reviewedBy:id,name',
            ])
            ->whereIn('id', $states->pluck('entity_id')->map(fn ($id) => (int) $id)->all())
            ->whereIn('status', [ReturnRequest::STATUS_APPROVED, ReturnRequest::STATUS_COMPLETED])
            ->get()
            ->keyBy('id');

        $records = $states
            ->map(function (IntegrationSyncState $state) use ($returns, $dealer): ?array {
                $returnRequest = $returns->get((int) $state->entity_id);

                if (! $returnRequest instanceof ReturnRequest) {
                    return null;
                }

                if ($dealer instanceof Dealer && (int) $returnRequest->dealer_id !== (int) $dealer->id) {
                    return null;
                }

                return $this->transformReturn($returnRequest, $state);
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
            $returnRequest = ReturnRequest::query()->find((int) $record['return_request_id']);

            if (! $returnRequest instanceof ReturnRequest) {
                throw ValidationException::withMessages([
                    "records.$index.return_request_id" => ['Gonderilen iade kaydi bulunamadi.'],
                ]);
            }

            $status = (string) $record['status'];
            $externalReference = $this->nullableString($record['external_ref'] ?? null);
            $error = $this->nullableString($record['error'] ?? null);

            $this->syncState->record(
                system: 'logo',
                domain: 'returns',
                direction: 'outbound',
                entity: $returnRequest,
                externalRef: $externalReference,
                status: $status,
                error: $status === 'failed' ? $error : null,
                meta: [
                    'acknowledged' => true,
                    'export_key' => 'B2B-RETURN-'.$returnRequest->id,
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
    private function transformReturn(ReturnRequest $returnRequest, IntegrationSyncState $state): array
    {
        $customer = $returnRequest->customer;
        $customerMeta = is_array($customer?->meta) ? $customer->meta : [];
        $productSnapshot = is_array($returnRequest->product_snapshot) ? $returnRequest->product_snapshot : [];
        $orderSnapshot = is_array($returnRequest->order_snapshot) ? $returnRequest->order_snapshot : [];
        $warehouseCode = $this->nullableString($orderSnapshot['warehouse_code'] ?? null);
        $warehouseName = $this->nullableString($orderSnapshot['warehouse_name'] ?? null);
        $orderItem = $returnRequest->orderItem;
        $product = $orderItem?->product;
        $productMeta = is_array($product?->meta) ? $product->meta : [];
        $logoPayload = data_get($productMeta, 'integrations.logo.payload');
        $quantity = (int) $returnRequest->quantity;
        $lineTotal = (float) $returnRequest->unit_price * $quantity;
        $vatRate = $this->money($product?->vat_rate ?? $orderItem?->tax_rate ?? 0);

        return [
            'return_request_id' => $returnRequest->id,
            'export_key' => 'B2B-RETURN-'.$returnRequest->id,
            'dealer_id' => $returnRequest->dealer_id,
            'dealer_code' => $returnRequest->dealer?->code,
            'customer_id' => $returnRequest->customer_id,
            'customer_code' => $customer?->code ?? ($orderSnapshot['customer_code'] ?? null),
            'customer_external_ref' => $customer?->source_reference,
            'customer_title' => $customer?->name ?? ($orderSnapshot['customer_name'] ?? null),
            'order_id' => $returnRequest->order_id,
            'order_no' => $returnRequest->order?->order_no ?? ($orderSnapshot['order_no'] ?? null),
            'order_item_id' => $returnRequest->order_item_id,
            'request_no' => $returnRequest->request_no,
            'warehouse_code' => $warehouseCode,
            'warehouse_name' => $warehouseName,
            'return_date' => optional($returnRequest->reviewed_at ?? $returnRequest->created_at)?->toDateString(),
            'request_type' => $returnRequest->request_type,
            'status' => $returnRequest->status,
            'reason_code' => $returnRequest->reason_code,
            'reason_note' => $returnRequest->reason_note,
            'resolution_note' => $returnRequest->resolution_note,
            'quantity' => $quantity,
            'unit_price' => $this->money($returnRequest->unit_price),
            'currency' => strtoupper((string) $returnRequest->currency),
            'line_total' => $this->money($lineTotal),
            'product_id' => $product?->id ?? ($productSnapshot['product_id'] ?? null),
            'product_code' => $product?->sku ?? ($productSnapshot['sku'] ?? null),
            'product_oem_code' => $product?->oem_code,
            'product_external_ref' => data_get($productMeta, 'integrations.logo.external_ref'),
            'product_name' => $product?->name ?? ($productSnapshot['name'] ?? null),
            'unit' => $product?->unit,
            'vat_rate' => $vatRate,
            'items' => [
                [
                    'return_request_id' => $returnRequest->id,
                    'order_item_id' => $returnRequest->order_item_id,
                    'product_id' => $product?->id ?? ($productSnapshot['product_id'] ?? null),
                    'product_code' => $product?->sku ?? ($productSnapshot['sku'] ?? null),
                    'product_oem_code' => $product?->oem_code,
                    'product_external_ref' => data_get($productMeta, 'integrations.logo.external_ref'),
                    'product_name' => $product?->name ?? ($productSnapshot['name'] ?? null),
                    'unit' => $product?->unit,
                    'quantity' => $quantity,
                    'unit_price' => $this->money($returnRequest->unit_price),
                    'vat_rate' => $vatRate,
                    'line_total' => $this->money($lineTotal),
                    'logo' => [
                        'stock_ref' => data_get($productMeta, 'integrations.logo.external_ref'),
                        'unitset_ref' => data_get($logoPayload, 'unitset_ref') ?? data_get($logoPayload, 'raw.UNITSETREF'),
                        'uom_ref' => data_get($logoPayload, 'logo_price.uomref') ?? data_get($logoPayload, 'raw.UOMREF'),
                        'raw' => data_get($logoPayload, 'raw'),
                    ],
                ],
            ],
            'sync_status' => $state->status,
            'sync_error' => $state->last_error,
            'requested_by_user_id' => $returnRequest->requested_by_user_id,
            'requested_by_name' => $returnRequest->requestedBy?->name,
            'reviewed_by_user_id' => $returnRequest->reviewed_by_user_id,
            'reviewed_by_name' => $returnRequest->reviewedBy?->name,
            'customer' => [
                'city' => $customer?->city,
                'district' => $customer?->district,
                'phone' => $customer?->phone,
                'tax_office' => $customer?->tax_office,
                'tax_number' => $customer?->tax_number,
                'address' => data_get($customerMeta, 'address') ?? data_get($customerMeta, 'full_address'),
                'logo' => data_get($customerMeta, 'integrations.logo.payload'),
            ],
            'logo' => [
                'document_type' => 'wholesale_sales_return_invoice',
                'document_label' => '(03) Toptan Satış İade Faturası',
                'invoice_trcode' => 3,
                'stock_trcode' => 3,
                'stock_iocode' => 1,
                'invoice_grpcode' => 2,
                'stock_grpcode' => 2,
                'warehouse_code' => $warehouseCode,
                'warehouse_name' => $warehouseName,
                'target_tables' => ['INVOICE', 'STFICHE', 'STLINE'],
                'stock_ref' => data_get($productMeta, 'integrations.logo.external_ref'),
                'unitset_ref' => data_get($logoPayload, 'unitset_ref') ?? data_get($logoPayload, 'raw.UNITSETREF'),
                'uom_ref' => data_get($logoPayload, 'logo_price.uomref') ?? data_get($logoPayload, 'raw.UOMREF'),
                'raw' => data_get($logoPayload, 'raw'),
            ],
            'meta' => [
                'created_at' => optional($returnRequest->created_at)?->toIso8601String(),
                'updated_at' => optional($returnRequest->updated_at)?->toIso8601String(),
                'reviewed_at' => optional($returnRequest->reviewed_at)?->toIso8601String(),
                'logo_external_ref' => $state->external_ref,
                'product_snapshot' => $productSnapshot,
                'order_snapshot' => $orderSnapshot,
                'logo' => [
                    'document_type' => 'wholesale_sales_return_invoice',
                    'document_label' => '(03) Toptan Satış İade Faturası',
                    'invoice_trcode' => 3,
                    'stock_trcode' => 3,
                    'stock_iocode' => 1,
                    'warehouse_code' => $warehouseCode,
                    'warehouse_name' => $warehouseName,
                    'target_tables' => ['INVOICE', 'STFICHE', 'STLINE'],
                ],
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

    private function money(mixed $value): string
    {
        return number_format((float) $value, 2, '.', '');
    }

    private function nullableString(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $value = trim((string) $value);

        return $value === '' ? null : $value;
    }
}
