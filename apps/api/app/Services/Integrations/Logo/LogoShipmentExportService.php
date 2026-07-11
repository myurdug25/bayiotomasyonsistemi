<?php

namespace App\Services\Integrations\Logo;

use App\Models\Dealer;
use App\Models\IntegrationSyncState;
use App\Models\LedgerEntry;
use App\Models\Shipment;
use App\Models\ShipmentItem;
use App\Services\Integrations\IntegrationSyncStateService;
use App\Services\Ledger\LedgerWriter;
use Illuminate\Support\Collection;
use Illuminate\Validation\ValidationException;

class LogoShipmentExportService
{
    public function __construct(
        private readonly IntegrationSyncStateService $syncState,
        private readonly LedgerWriter $ledgerWriter,
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
            ->where('domain', 'warehouse-shipments')
            ->where('direction', 'outbound')
            ->where('entity_type', Shipment::class)
            ->whereIn('status', $statuses)
            ->orderBy('id')
            ->limit($limit)
            ->get();

        $shipments = Shipment::query()
            ->with([
                'order.dealer:id,code,name',
                'order.customer:id,dealer_id,source_system,source_reference,code,name,city,district,phone,tax_office,tax_number,meta',
                'order.cart:id,shipping_method,note,order_note',
                'warehouse:id,code,name',
                'createdBy:id,name',
                'items.orderItem:id,order_id,quantity,unit_net_price,discount_rate,tax_rate,line_total,currency',
                'items.product:id,sku,oem_code,name,unit,vat_rate,meta',
            ])
            ->whereIn('id', $states->pluck('entity_id')->map(fn ($id) => (int) $id)->all())
            ->whereIn('status', ['shipped', 'partially_shipped'])
            ->get()
            ->keyBy('id');

        $records = $states
            ->map(function (IntegrationSyncState $state) use ($shipments, $dealer): ?array {
                $shipment = $shipments->get((int) $state->entity_id);

                if (! $shipment instanceof Shipment) {
                    return null;
                }

                if ($dealer instanceof Dealer && (int) $shipment->order?->dealer_id !== (int) $dealer->id) {
                    return null;
                }

                return $this->transformShipment($shipment, $state);
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
            $shipment = Shipment::query()->find((int) $record['shipment_id']);

            if (! $shipment instanceof Shipment) {
                throw ValidationException::withMessages([
                    "records.$index.shipment_id" => ['Gonderilen sevkiyat kaydi bulunamadi.'],
                ]);
            }

            $status = (string) $record['status'];
            $externalReference = $this->nullableString($record['external_ref'] ?? null);
            $error = $this->nullableString($record['error'] ?? null);

            $this->syncState->record(
                system: 'logo',
                domain: 'warehouse-shipments',
                direction: 'outbound',
                entity: $shipment,
                externalRef: $externalReference,
                status: $status,
                error: $status === 'failed' ? $error : null,
                meta: [
                    'acknowledged' => true,
                    'export_key' => $shipment->logoExportKey(),
                    'payload' => is_array($record['meta'] ?? null) ? $record['meta'] : [],
                ],
                payload: $record,
                syncedAt: now(),
            );

            if ($status === 'synced') {
                $this->recordShipmentInvoice($shipment, $externalReference);
            }

            $summary[$status]++;
        }

        return $summary;
    }

    private function recordShipmentInvoice(Shipment $shipment, ?string $externalReference): LedgerEntry
    {
        $shipment->loadMissing(['order', 'items']);
        $order = $shipment->order;

        if (! $order) {
            throw ValidationException::withMessages([
                'shipment' => ['Faturaya baglanacak siparis bulunamadi.'],
            ]);
        }

        $sourceReference = $externalReference ?? $shipment->logoExportKey();
        $existing = LedgerEntry::query()
            ->where('customer_id', $order->customer_id)
            ->where('source_system', 'logo')
            ->where('source_reference', $sourceReference)
            ->first();

        if ($existing instanceof LedgerEntry) {
            return $existing;
        }

        $totals = $this->shipmentTotals($shipment->items);
        $invoiceDate = optional($shipment->shipped_at ?? $shipment->updated_at)?->toDateString()
            ?? now()->toDateString();
        $orderSyncMeta = $this->orderSyncMeta($order);

        return $this->ledgerWriter->write([
            'dealer_id' => $order->dealer_id,
            'customer_id' => $order->customer_id,
            'source_system' => 'logo',
            'source_reference' => $sourceReference,
            'last_synced_at' => now(),
            'order_id' => $order->id,
            'date' => $invoiceDate,
            'type' => 'invoice',
            'debit' => $totals['grand_total'],
            'credit' => 0,
            'currency' => $order->currency,
            'reference_no' => $shipment->shipment_no,
            'description' => 'Logo sevkiyat faturasi '.$shipment->shipment_no,
            'created_by_user_id' => $shipment->created_by,
            'meta' => [
                'source' => 'logo_shipment_invoice',
                'source_label' => 'Sevkiyat faturasi',
                'shipment_id' => $shipment->id,
                'shipment_no' => $shipment->shipment_no,
                'order_no' => $order->order_no,
                'export_key' => $shipment->logoExportKey(),
                'checkout_summary_mode' => $this->nullableString(data_get($orderSyncMeta, 'checkout_summary_mode')),
                'payment_method' => $this->nullableString(data_get($orderSyncMeta, 'payment_method')),
                'sales_price_type' => $this->nullableString(data_get($orderSyncMeta, 'sales_price_type')),
            ],
        ]);
    }

    /**
     * @return array<string, mixed>
     */
    private function orderSyncMeta($order): array
    {
        if (! $order) {
            return [];
        }

        $state = IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'orders')
            ->where('direction', 'outbound')
            ->where('entity_type', $order::class)
            ->where('entity_id', (int) $order->id)
            ->latest('id')
            ->first();

        return is_array($state?->meta) ? $state->meta : [];
    }

    /**
     * @return array<string, mixed>|null
     */
    public function recordForShipment(Shipment $shipment): ?array
    {
        $state = IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'warehouse-shipments')
            ->where('direction', 'outbound')
            ->where('entity_type', Shipment::class)
            ->where('entity_id', (int) $shipment->getKey())
            ->first();

        if (! $state instanceof IntegrationSyncState) {
            return null;
        }

        $model = Shipment::query()
            ->with([
                'order.dealer:id,code,name',
                'order.customer:id,dealer_id,source_system,source_reference,code,name,city,district,phone,tax_office,tax_number,meta',
                'order.cart:id,shipping_method,note,order_note',
                'warehouse:id,code,name',
                'createdBy:id,name',
                'items.orderItem:id,order_id,quantity,unit_net_price,discount_rate,tax_rate,line_total,currency',
                'items.product:id,sku,oem_code,name,unit,vat_rate,meta',
            ])
            ->whereKey($shipment->getKey())
            ->whereIn('status', ['shipped', 'partially_shipped'])
            ->first();

        if (! $model instanceof Shipment) {
            return null;
        }

        return $this->transformShipment($model, $state);
    }

    /**
     * @return array<string, mixed>
     */
    private function transformShipment(Shipment $shipment, IntegrationSyncState $state): array
    {
        $order = $shipment->order;
        $customer = $order?->customer;
        $customerMeta = is_array($customer?->meta) ? $customer->meta : [];
        $totals = $this->shipmentTotals($shipment->items);
        $orderSyncMeta = $this->orderSyncMeta($order);
        $logoDocument = [
            'document_type' => 'wholesale_sales_invoice',
            'document_label' => '(08) Toptan Satış Faturası',
            'invoice_trcode' => 8,
            'stock_trcode' => 8,
            'stock_iocode' => 4,
            'ledger_modulenr' => 4,
            'ledger_trcode' => 38,
            'target_tables' => ['INVOICE', 'STFICHE', 'STLINE', 'CLFLINE'],
            'order_export_key' => $order?->logoExportKey(),
        ];

        return [
            'shipment_id' => $shipment->id,
            'export_key' => $shipment->logoExportKey(),
            'dealer_id' => $order?->dealer_id,
            'dealer_code' => $order?->dealer?->code,
            'order_id' => $shipment->order_id,
            'order_no' => $order?->order_no,
            'customer_id' => $order?->customer_id,
            'customer_code' => $customer?->code,
            'customer_external_ref' => $customer?->source_reference,
            'customer_title' => $customer?->name,
            'shipment_no' => $shipment->shipment_no,
            'shipment_date' => optional($shipment->shipped_at ?? $shipment->updated_at)?->toDateString(),
            'status' => $shipment->status,
            'warehouse_id' => $shipment->warehouse_id,
            'warehouse_code' => $shipment->warehouse?->code,
            'warehouse_name' => $shipment->warehouse?->name,
            'carrier_name' => $shipment->carrier_name,
            'tracking_no' => $shipment->tracking_no,
            'note' => $shipment->note,
            'checkout_summary_mode' => $this->nullableString(data_get($orderSyncMeta, 'checkout_summary_mode')),
            'payment_method' => $this->nullableString(data_get($orderSyncMeta, 'payment_method')),
            'sales_price_type' => $this->nullableString(data_get($orderSyncMeta, 'sales_price_type')),
            'subtotal' => $this->money($totals['subtotal']),
            'vat_total' => $this->money($totals['vat_total']),
            'grand_total' => $this->money($totals['grand_total']),
            'created_by_user_id' => $shipment->created_by,
            'created_by_name' => $shipment->createdBy?->name,
            'sync_status' => $state->status,
            'sync_error' => $state->last_error,
            'items' => $this->transformShipmentItems($shipment->items),
            'customer' => [
                'city' => $customer?->city,
                'district' => $customer?->district,
                'phone' => $customer?->phone,
                'tax_office' => $customer?->tax_office,
                'tax_number' => $customer?->tax_number,
                'address' => data_get($customerMeta, 'address') ?? data_get($customerMeta, 'full_address'),
                'logo' => data_get($customerMeta, 'integrations.logo.payload'),
            ],
            'logo' => $logoDocument,
            'meta' => [
                'created_at' => optional($shipment->created_at)?->toIso8601String(),
                'updated_at' => optional($shipment->updated_at)?->toIso8601String(),
                'logo_external_ref' => $state->external_ref,
                'logo' => $logoDocument,
                'checkout_summary_mode' => $this->nullableString(data_get($orderSyncMeta, 'checkout_summary_mode')),
                'payment_method' => $this->nullableString(data_get($orderSyncMeta, 'payment_method')),
                'sales_price_type' => $this->nullableString(data_get($orderSyncMeta, 'sales_price_type')),
            ],
        ];
    }

    /**
     * @param  Collection<int, ShipmentItem>  $items
     * @return list<array<string, mixed>>
     */
    private function transformShipmentItems(Collection $items): array
    {
        return $items
            ->filter(fn ($item): bool => (int) $item->shipped_qty > 0)
            ->map(function ($item): array {
                $product = $item->product;
                $productMeta = is_array($product?->meta) ? $product->meta : [];
                $logoPayload = data_get($productMeta, 'integrations.logo.payload');

                return [
                    'shipment_item_id' => $item->id,
                    'order_item_id' => $item->order_item_id,
                    'product_id' => $item->product_id,
                    'product_code' => $product?->sku,
                    'product_oem_code' => $product?->oem_code,
                    'product_external_ref' => data_get($productMeta, 'integrations.logo.external_ref'),
                    'product_name' => $product?->name,
                    'unit' => $product?->unit,
                    'ordered_qty' => (int) $item->ordered_qty,
                    'shipped_qty' => (int) $item->shipped_qty,
                    'unit_price' => $this->money($item->unit_price),
                    'vat_rate' => $this->money($item->vat_rate),
                    'line_total' => $this->money($item->line_total_shipped),
                    'logo' => [
                        'stock_ref' => data_get($productMeta, 'integrations.logo.external_ref'),
                        'unitset_ref' => data_get($logoPayload, 'unitset_ref') ?? data_get($logoPayload, 'raw.UNITSETREF'),
                        'uom_ref' => data_get($logoPayload, 'logo_price.uomref') ?? data_get($logoPayload, 'raw.UOMREF'),
                        'warehouse_totals' => data_get($logoPayload, 'logo_stock.warehouses'),
                        'raw' => data_get($logoPayload, 'raw'),
                    ],
                ];
            })
            ->values()
            ->all();
    }

    /**
     * @param  Collection<int, ShipmentItem>  $items
     * @return array{subtotal:float,vat_total:float,grand_total:float}
     */
    private function shipmentTotals(Collection $items): array
    {
        $subtotal = 0.0;
        $vatTotal = 0.0;

        foreach ($items as $item) {
            $line = (float) $item->line_total_shipped;
            $subtotal += $line;
            $vatTotal += $line * ((float) $item->vat_rate / 100);
        }

        return [
            'subtotal' => $subtotal,
            'vat_total' => $vatTotal,
            'grand_total' => $subtotal + $vatTotal,
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
