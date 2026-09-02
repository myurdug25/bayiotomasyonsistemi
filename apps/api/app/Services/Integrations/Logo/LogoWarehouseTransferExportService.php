<?php

namespace App\Services\Integrations\Logo;

use App\Models\Dealer;
use App\Models\IntegrationSyncState;
use App\Models\PurchaseReceipt;
use App\Models\Shipment;
use App\Models\ShipmentItem;
use App\Services\Integrations\IntegrationSyncStateService;
use Illuminate\Support\Collection;
use Illuminate\Validation\ValidationException;

class LogoWarehouseTransferExportService
{
    public function __construct(
        private readonly IntegrationSyncStateService $syncState,
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
            ->where('domain', 'warehouse-transfers')
            ->where('direction', 'outbound')
            ->where('entity_type', Shipment::class)
            ->whereIn('status', $statuses)
            ->orderBy('id')
            ->limit($limit)
            ->get();

        $shipments = Shipment::query()
            ->with([
                'order.dealer:id,code,name',
                'order.customer:id,dealer_id,code,name',
                'warehouse:id,code,name',
                'createdBy:id,name',
                'items.product:id,sku,oem_code,name,unit,vat_rate,meta',
            ])
            ->whereIn('id', $states->pluck('entity_id')->map(fn ($id) => (int) $id)->all())
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
     * Mal kabul, sevkiyat Logo'ya aktarilmadan once onaylanirsa ayni
     * IntegrationSyncState satirindaki sevkiyat asamasini ezmemelidir.
     * Once kaynak stok hareketi tamamlanir, ardindan hedef stok hareketi
     * ayni kuyruk kaydi uzerinden sirali olarak devreye alinir.
     *
     * @param  array<string, mixed>  $meta
     * @param  array<string, mixed>  $payload
     */
    public function queueAcceptance(Shipment $shipment, array $meta, array $payload): IntegrationSyncState
    {
        $currentState = IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'warehouse-transfers')
            ->where('direction', 'outbound')
            ->where('entity_type', Shipment::class)
            ->where('entity_id', (int) $shipment->id)
            ->lockForUpdate()
            ->first();

        if ($this->shouldDeferAcceptance($currentState)) {
            $currentMeta = is_array($currentState->meta) ? $currentState->meta : [];
            $currentState->meta = [
                ...$currentMeta,
                'pending_acceptance' => [
                    'meta' => $meta,
                    'payload' => $payload,
                ],
            ];
            $currentState->save();

            return $currentState;
        }

        return $this->recordAcceptance($shipment, $meta, $payload);
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
                    "records.$index.shipment_id" => ['Gonderilen depo transfer kaydi bulunamadi.'],
                ]);
            }

            $status = (string) $record['status'];
            $externalReference = $this->nullableString($record['external_ref'] ?? null);
            $error = $this->nullableString($record['error'] ?? null);
            $ackMeta = is_array($record['meta'] ?? null) ? $record['meta'] : [];
            $ackExportKey = $this->nullableString($ackMeta['export_key'] ?? null);
            $currentStateQuery = IntegrationSyncState::query()
                ->where('system', 'logo')
                ->where('domain', 'warehouse-transfers')
                ->where('direction', 'outbound')
                ->where('entity_type', Shipment::class)
                ->where('entity_id', (int) $shipment->id);

            if ($ackExportKey !== null) {
                $currentStateQuery->where('meta->export_key', $ackExportKey);
            }

            $currentState = $currentStateQuery
                ->orderByDesc('id')
                ->first();
            $currentMeta = is_array($currentState?->meta) ? $currentState->meta : [];
            $purchaseReceiptId = (int) ($currentMeta['purchase_receipt_id'] ?? 0);
            $transferStage = $this->nullableString($currentMeta['transfer_stage'] ?? null);

            $this->syncState->record(
                system: 'logo',
                domain: 'warehouse-transfers',
                direction: 'outbound',
                entity: $shipment,
                externalRef: $externalReference,
                status: $status,
                error: $status === 'failed' ? $error : null,
                meta: [
                    'acknowledged' => true,
                    'export_key' => $this->nullableString($currentMeta['export_key'] ?? null)
                        ?? $ackExportKey
                        ?? 'B2B-WHTRANS-'.$shipment->id,
                    'transfer_stage' => $transferStage,
                    'purchase_receipt_id' => $purchaseReceiptId > 0 ? $purchaseReceiptId : null,
                    'payload' => $ackMeta,
                ],
                payload: $record,
                syncedAt: now(),
            );

            if ($status === 'synced') {
                $pendingAcceptance = is_array($currentMeta['pending_acceptance'] ?? null)
                    ? $currentMeta['pending_acceptance']
                    : null;
                $pendingMeta = is_array($pendingAcceptance['meta'] ?? null)
                    ? $pendingAcceptance['meta']
                    : null;
                $pendingPayload = is_array($pendingAcceptance['payload'] ?? null)
                    ? $pendingAcceptance['payload']
                    : null;

                if ($pendingMeta !== null && $pendingPayload !== null) {
                    $this->recordAcceptance($shipment, $pendingMeta, $pendingPayload);
                }
            }

            if ($purchaseReceiptId > 0 && $transferStage === 'acceptance') {
                PurchaseReceipt::query()
                    ->whereKey($purchaseReceiptId)
                    ->update([
                        'status' => $status === 'synced' ? 'synced' : 'failed',
                        'updated_at' => now(),
                    ]);
            }

            $summary[$status]++;
        }

        return $summary;
    }

    private function shouldDeferAcceptance(?IntegrationSyncState $state): bool
    {
        if (! $state instanceof IntegrationSyncState) {
            return false;
        }

        $meta = is_array($state->meta) ? $state->meta : [];

        return in_array(($meta['transfer_stage'] ?? null), ['shipment', 'acceptance'], true)
            && $state->status !== 'synced';
    }

    /**
     * @param  array<string, mixed>  $meta
     * @param  array<string, mixed>  $payload
     */
    private function recordAcceptance(Shipment $shipment, array $meta, array $payload): IntegrationSyncState
    {
        $state = $this->syncState->record(
            system: 'logo',
            domain: 'warehouse-transfers',
            direction: 'outbound',
            entity: $shipment,
            externalRef: null,
            status: 'queued',
            error: null,
            meta: $meta,
            payload: $payload,
        );

        // record() normalde ayni entity'nin metadata'sini birlestirir. Burada
        // onceki shipment anahtarlari acceptance asamasina sizmasin; Windows
        // exporter yalnizca hedef stok hareketini kesin olarak gorsun.
        $state->forceFill([
            'external_ref' => null,
            'status' => 'queued',
            'last_error' => null,
            'meta' => $meta,
        ])->save();

        return $state;
    }

    /**
     * @return array<string, mixed>
     */
    private function transformShipment(Shipment $shipment, IntegrationSyncState $state): array
    {
        $order = $shipment->order;
        $stateMeta = is_array($state->meta) ? $state->meta : [];
        $checkoutSummaryMode = $this->nullableString(data_get($stateMeta, 'checkout_summary_mode'))
            ?? $this->nullableString(data_get($order?->meta, 'checkout_summary_mode'));
        $shipmentWarehouseCode = $this->nullableString($shipment->warehouse?->code);
        $shipmentWarehouseName = $this->nullableString($shipment->warehouse?->name);
        [$sourceDepotCode, $sourceDepotName] = $this->resolveTransferSourceDepot(
            $shipmentWarehouseCode,
            $shipmentWarehouseName,
            $stateMeta,
        );
        $finalTargetCode = $this->nullableString(data_get($stateMeta, 'transfer_target_warehouse_code'));
        $finalTargetName = $this->nullableString(data_get($stateMeta, 'transfer_target_warehouse_name'));
        $transferStage = $this->nullableString(data_get($stateMeta, 'transfer_stage')) ?? 'shipment';
        $isAcceptanceStage = $transferStage === 'acceptance';
        $acceptedQuantities = null;

        if ($isAcceptanceStage) {
            $purchaseReceiptId = (int) (data_get($stateMeta, 'purchase_receipt_id') ?? 0);
            $purchaseReceipt = $purchaseReceiptId > 0
                ? PurchaseReceipt::query()
                    ->with('items:id,purchase_receipt_id,product_code,accepted_quantity')
                    ->select(['id', 'warehouse_code', 'warehouse_name'])
                    ->find($purchaseReceiptId)
                : null;

            if ($purchaseReceipt instanceof PurchaseReceipt) {
                $finalTargetCode = $this->nullableString($purchaseReceipt->warehouse_code) ?? $finalTargetCode;
                $finalTargetName = $this->nullableString($purchaseReceipt->warehouse_name) ?? $finalTargetName;
                $acceptedQuantities = $purchaseReceipt->items
                    ->groupBy(fn ($item): string => $this->normalizedProductCode($item->product_code))
                    ->map(fn (Collection $items): int => (int) $items->sum('accepted_quantity'))
                    ->all();
            }
        }

        $sourceTransit = $this->transitWarehouseForSource($sourceDepotCode, $sourceDepotName);
        $targetTransit = $this->transitWarehouseForSource($finalTargetCode, $finalTargetName);

        [
            $stockSourceWarehouseCode,
            $stockSourceWarehouseName,
            $stockTargetWarehouseCode,
            $stockTargetWarehouseName,
        ] = $this->stockMovementWarehousesForStage(
            $isAcceptanceStage,
            $sourceDepotCode,
            $sourceDepotName,
            $sourceTransit['code'] ?? $sourceDepotCode,
            $sourceTransit['name'] ?? $sourceDepotName,
            $finalTargetCode,
            $finalTargetName,
        );

        // STFICHE/STLINE ve stok toplamları aynı gerçek depo bacağını kullanır:
        // sevkiyat kaynak depodan sevkiyat ambarına, mal kabul ise sevkiyat
        // ambarından nihai hedef depoya hareket eder. Böylece Logo'nun fiili
        // stok görünümü ile B2B stok yenilemesi birbirinden ayrışmaz.
        $sourceWarehouseCode = $stockSourceWarehouseCode;
        $sourceWarehouseName = $stockSourceWarehouseName;
        $targetWarehouseCode = $stockTargetWarehouseCode;
        $targetWarehouseName = $stockTargetWarehouseName;

        $logoDocument = [
            'document_type' => 'warehouse_transfer',
            'document_label' => '(25) Ambar Fişi',
            'stock_trcode' => 25,
            'target_tables' => ['STFICHE', 'STLINE'],
        ];

        return [
            'shipment_id' => $shipment->id,
            'warehouse_transfer_id' => $shipment->id,
            'export_key' => $this->nullableString(data_get($stateMeta, 'export_key')) ?? 'B2B-WHTRANS-'.$shipment->id,
            'dealer_id' => $order?->dealer_id,
            'dealer_code' => $order?->dealer?->code,
            'order_id' => $shipment->order_id,
            'order_no' => $order?->order_no,
            'transfer_no' => $isAcceptanceStage
                ? ($this->nullableString(data_get($stateMeta, 'purchase_receipt_no')) ?? $shipment->shipment_no)
                : $shipment->shipment_no,
            'transfer_stage' => $isAcceptanceStage ? 'acceptance' : $transferStage,
            'transfer_date' => optional($shipment->shipped_at ?? $shipment->updated_at)?->toDateString(),
            'status' => $shipment->status,
            'source_warehouse_code' => $sourceWarehouseCode,
            'source_warehouse_name' => $sourceWarehouseName,
            'target_warehouse_code' => $targetWarehouseCode,
            'target_warehouse_name' => $targetWarehouseName,
            'final_target_warehouse_code' => $finalTargetCode,
            'final_target_warehouse_name' => $finalTargetName,
            'stock_source_warehouse_code' => $stockSourceWarehouseCode,
            'stock_source_warehouse_name' => $stockSourceWarehouseName,
            'stock_target_warehouse_code' => $stockTargetWarehouseCode,
            'stock_target_warehouse_name' => $stockTargetWarehouseName,
            'requesting_customer_code' => $order?->customer?->code,
            'requesting_customer_title' => $order?->customer?->name,
            'items' => $this->transformShipmentItems(
                $shipment->items,
                $checkoutSummaryMode,
                $acceptedQuantities,
            ),
            'logo' => $logoDocument,
            'meta' => [
                'created_at' => optional($shipment->created_at)?->toIso8601String(),
                'updated_at' => optional($shipment->updated_at)?->toIso8601String(),
                'logo_external_ref' => $state->external_ref,
                'logo' => $logoDocument,
                'source_state_meta' => $stateMeta,
            ],
        ];
    }

    /**
     * @param  Collection<int, ShipmentItem>  $items
     * @return list<array<string, mixed>>
     */
    private function transformShipmentItems(
        Collection $items,
        ?string $checkoutSummaryMode,
        ?array $acceptedQuantities = null,
    ): array
    {
        $remainingAccepted = $acceptedQuantities;

        return $items
            ->filter(fn ($item): bool => (int) $item->shipped_qty > 0)
            ->map(function ($item) use ($checkoutSummaryMode, &$remainingAccepted): ?array {
                $product = $item->product;
                $productMeta = is_array($product?->meta) ? $product->meta : [];
                $logoPayload = data_get($productMeta, 'integrations.logo.payload');
                $shippedQuantity = max(1, (int) $item->shipped_qty);
                $quantity = $shippedQuantity;

                if (is_array($remainingAccepted)) {
                    $productCode = $this->normalizedProductCode($product?->sku);
                    $availableAccepted = max(0, (int) ($remainingAccepted[$productCode] ?? 0));
                    $quantity = min($shippedQuantity, $availableAccepted);
                    $remainingAccepted[$productCode] = max(0, $availableAccepted - $quantity);

                    if ($quantity <= 0) {
                        return null;
                    }
                }

                $lineTotal = (float) $item->line_total_shipped;
                $vatRate = max(0.0, (float) $item->vat_rate);
                $fullLogoLineTotal = $this->transferLineTotalForLogo($lineTotal, $vatRate, $checkoutSummaryMode);
                $logoUnitPrice = round($fullLogoLineTotal / $shippedQuantity, 2);
                $logoLineTotal = round($logoUnitPrice * $quantity, 2);

                return [
                    'shipment_item_id' => $item->id,
                    'product_id' => $item->product_id,
                    'product_code' => $product?->sku,
                    'product_oem_code' => $product?->oem_code,
                    'product_external_ref' => data_get($productMeta, 'integrations.logo.external_ref'),
                    'product_name' => $product?->name,
                    'unit' => $product?->unit,
                    'shipped_qty' => $quantity,
                    'unit_price' => $this->money($logoUnitPrice),
                    'line_total' => $this->money($logoLineTotal),
                    'source_unit_price' => $this->money($item->unit_price),
                    'source_line_total' => $this->money($lineTotal),
                    'vat_rate' => $this->money($vatRate),
                    'checkout_summary_mode' => $checkoutSummaryMode,
                    'logo' => [
                        'stock_ref' => data_get($productMeta, 'integrations.logo.external_ref'),
                        'unitset_ref' => data_get($logoPayload, 'unitset_ref') ?? data_get($logoPayload, 'raw.UNITSETREF'),
                        'uom_ref' => data_get($logoPayload, 'logo_price.uomref') ?? data_get($logoPayload, 'raw.UOMREF'),
                        'raw' => data_get($logoPayload, 'raw'),
                    ],
                ];
            })
            ->filter()
            ->values()
            ->all();
    }

    private function normalizedProductCode(mixed $value): string
    {
        return mb_strtoupper(trim((string) $value), 'UTF-8');
    }

    private function transferLineTotalForLogo(float $lineTotal, float $vatRate, ?string $checkoutSummaryMode): float
    {
        unset($vatRate, $checkoutSummaryMode);

        // Depolar arası transfer satış değildir; Logo ambar fişine cart/transfer
        // satırındaki KDV'siz transfer tutarı birebir taşınır.
        return round($lineTotal, 2);
    }

    /**
     * Depolar arasi transferi Logo'nun gercek iki ambar bacagina boler.
     * Sevkiyat: kaynak depo -> kaynak sevkiyat ambari.
     * Mal kabul: kaynak sevkiyat ambari -> nihai hedef depo.
     *
     * @return array{0: ?string, 1: ?string, 2: ?string, 3: ?string}
     */
    private function stockMovementWarehousesForStage(
        bool $isAcceptanceStage,
        ?string $sourceWarehouseCode,
        ?string $sourceWarehouseName,
        ?string $transitWarehouseCode,
        ?string $transitWarehouseName,
        ?string $targetWarehouseCode,
        ?string $targetWarehouseName,
    ): array {
        if ($isAcceptanceStage) {
            return [
                $transitWarehouseCode,
                $transitWarehouseName,
                $targetWarehouseCode,
                $targetWarehouseName,
            ];
        }

        return [
            $sourceWarehouseCode,
            $sourceWarehouseName,
            $transitWarehouseCode,
            $transitWarehouseName,
        ];
    }

    /**
     * Sevkiyat modeli operasyon/gecis ambarini tasiyabilir. Depolar arasi
     * transferde fiili stok hareketinin kaynagi siparis meta verisindeki
     * gercek transfer deposudur; meta yoksa eski sevkiyat ambarina donulur.
     *
     * @param  array<string, mixed>  $stateMeta
     * @return array{0: ?string, 1: ?string}
     */
    private function resolveTransferSourceDepot(
        ?string $shipmentWarehouseCode,
        ?string $shipmentWarehouseName,
        array $stateMeta,
    ): array {
        $metaCode = $this->nullableString(data_get($stateMeta, 'transfer_source_warehouse_code'));
        $metaName = $this->nullableString(data_get($stateMeta, 'transfer_source_warehouse_name'));

        return [
            $metaCode ?? $shipmentWarehouseCode,
            $metaName ?? $shipmentWarehouseName,
        ];
    }

    /**
     * Logo fişinde şubeler arası yolda olan mal için çıkış sevkiyat ambarı
     * gösterilir. Fiili stok etkisi ayrı payload alanlarıyla yönetilir.
     *
     * @return array{code: ?string, name: ?string}
     */
    private function transitWarehouseForSource(?string $warehouseCode, ?string $warehouseName): array
    {
        $normalized = mb_strtoupper(trim(($warehouseCode ?? '').' '.($warehouseName ?? '')), 'UTF-8');

        if ($warehouseCode === '0' || str_contains($normalized, 'POINT')) {
            return ['code' => $warehouseCode, 'name' => $warehouseName];
        }

        if ($warehouseCode === '1' || str_contains($normalized, 'ERZURUM')) {
            return ['code' => '5', 'name' => 'ERZURUM SEVKIYAT'];
        }

        if ($warehouseCode === '2' || str_contains($normalized, 'TRABZON')) {
            return ['code' => '6', 'name' => 'TRABZON SEVKIYAT'];
        }

        if ($warehouseCode === '3' || str_contains($normalized, 'SAMSUN')) {
            return ['code' => '7', 'name' => 'SAMSUN SEVKIYAT'];
        }

        if ($warehouseCode === '4' || str_contains($normalized, 'BATUM')) {
            return ['code' => '8', 'name' => 'BATUM SEVKIYAT'];
        }

        return ['code' => $warehouseCode, 'name' => $warehouseName];
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
