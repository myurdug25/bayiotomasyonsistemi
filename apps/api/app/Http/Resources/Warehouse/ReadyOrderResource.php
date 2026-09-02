<?php

namespace App\Http\Resources\Warehouse;

use App\Models\IntegrationSyncState;
use App\Models\LedgerEntry;
use App\Models\User;
use App\Models\Warehouse;
use App\Support\Warehouse\WarehouseBranchResolver;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Support\Collection;
use Illuminate\Support\Str;

class ReadyOrderResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        $items = $this->whenLoaded('items');
        $itemCount = $items instanceof Collection ? $items->count() : 0;
        $totalQuantity = 0;
        $stockCoveredQuantity = 0;
        $lowStockCount = 0;
        $missingStockCount = 0;
        $stockUpdatedAt = null;
        $logoWarehouses = [];

        if ($items instanceof Collection) {
            foreach ($items as $item) {
                $quantity = (int) $item->quantity;
                $available = (int) ($item->product?->stockSummary?->available_total ?? 0);
                $totalQuantity += $quantity;
                $stockCoveredQuantity += min($quantity, max(0, $available));

                if ($available <= 0) {
                    $missingStockCount++;
                } elseif ($available < $quantity) {
                    $lowStockCount++;
                }

                $candidate = $item->product?->stockSummary?->updated_at;
                if ($candidate !== null && ($stockUpdatedAt === null || $candidate->gt($stockUpdatedAt))) {
                    $stockUpdatedAt = $candidate;
                }

                $this->collectLogoWarehouses($logoWarehouses, is_array($item->product?->meta) ? $item->product->meta : [], $quantity);
            }
        }

        $invoice = $this->invoiceLedgerEntry();
        $invoiceMeta = is_array($invoice?->meta) ? $invoice->meta : [];
        $orderSyncMeta = $this->orderLogoSyncMeta();
        $transferSyncMeta = $this->orderWarehouseTransferMeta();
        $isDepotTransfer = $this->nullableString(data_get($transferSyncMeta, 'document_type')) === 'warehouse_transfer';
        $checkoutSummary = $this->checkoutSummaryFromMeta($invoiceMeta)
            ?? $this->checkoutSummaryFromMeta($orderSyncMeta);
        $salesPriceType = $this->nullableString(data_get($invoiceMeta, 'sales_price_type'))
            ?? $this->nullableString(data_get($orderSyncMeta, 'sales_price_type'));
        if ($isDepotTransfer) {
            $checkoutSummary = null;
            $salesPriceType = null;
        }
        $paymentMethod = $this->nullableString(data_get($invoiceMeta, 'payment_method'))
            ?? $this->nullableString(data_get($orderSyncMeta, 'payment_method'));
        $createdBy = $this->user;
        $createdByRoleSlugs = $this->userRoleSlugs($createdBy);
        $isCreatedByWarehouseUser = in_array('warehouse', $createdByRoleSlugs, true)
            || in_array('point', $createdByRoleSlugs, true);
        $fallbackTargetWarehouse = $this->targetWarehouseForContext(
            $createdBy,
            $isCreatedByWarehouseUser ? null : $this->customer,
            $isCreatedByWarehouseUser ? null : $this->cart?->shipping_method
        );
        $transferSourceWarehouseCode = $this->nullableString(data_get($transferSyncMeta, 'transfer_source_warehouse_code'));
        $transferSourceWarehouseName = $this->nullableString(data_get($transferSyncMeta, 'transfer_source_warehouse_name'));
        $transferTargetWarehouseCode = $this->nullableString(data_get($transferSyncMeta, 'transfer_target_warehouse_code'));
        $transferTargetWarehouseName = $this->nullableString(data_get($transferSyncMeta, 'transfer_target_warehouse_name'));
        $storedTargetWarehouseCode = $this->nullableString(data_get($invoiceMeta, 'target_warehouse_code'))
            ?? $this->nullableString(data_get($orderSyncMeta, 'target_warehouse_code'));
        $storedTargetWarehouseName = $this->nullableString(data_get($invoiceMeta, 'target_warehouse_name'))
            ?? $this->nullableString(data_get($orderSyncMeta, 'target_warehouse_name'));
        $storedTargetWarehouseReason = $this->nullableString(data_get($invoiceMeta, 'target_warehouse_reason'))
            ?? $this->nullableString(data_get($orderSyncMeta, 'target_warehouse_reason'));
        $fallbackTargetWarehouseCode = $this->nullableString(data_get($fallbackTargetWarehouse, 'code'));
        $fallbackTargetWarehouseName = $this->nullableString(data_get($fallbackTargetWarehouse, 'name'));
        $fallbackTargetWarehouseReason = $this->nullableString(data_get($fallbackTargetWarehouse, 'reason'));

        $targetWarehouseCode = ($isDepotTransfer ? $transferTargetWarehouseCode : null)
            ?? ($isCreatedByWarehouseUser ? $storedTargetWarehouseCode : $fallbackTargetWarehouseCode)
            ?? ($isCreatedByWarehouseUser ? $fallbackTargetWarehouseCode : $storedTargetWarehouseCode);
        $targetWarehouseName = ($isDepotTransfer ? $transferTargetWarehouseName : null)
            ?? ($isCreatedByWarehouseUser ? $storedTargetWarehouseName : $fallbackTargetWarehouseName)
            ?? ($isCreatedByWarehouseUser ? $fallbackTargetWarehouseName : $storedTargetWarehouseName);
        $targetWarehouseReason = ($isCreatedByWarehouseUser ? $storedTargetWarehouseReason : $fallbackTargetWarehouseReason)
            ?? ($isCreatedByWarehouseUser ? $fallbackTargetWarehouseReason : $storedTargetWarehouseReason);
        $sourcePanel = $this->nullableString(data_get($invoiceMeta, 'source_panel'))
            ?? $this->resolveSourcePanel($createdByRoleSlugs);
        $salesperson = $this->resolveSalesperson($createdBy, $createdByRoleSlugs);
        $salespersonId = $salesperson?->id;
        $salespersonName = $salesperson?->name;

        if ($createdBy instanceof User && in_array('customer', $createdByRoleSlugs, true)) {
            $salespersonId = $createdBy->id;
            $salespersonName = $this->customer?->name ?? $createdBy->name;
        }

        $preferredWarehouseCode = ($isDepotTransfer ? $transferSourceWarehouseCode : null)
            ?? $targetWarehouseCode
            ?? $this->preferredWarehouseCode($this->note ?? $this->cart?->order_note ?? $this->cart?->note);

        return [
            'id' => $this->id,
            'order_no' => $this->order_no,
            'dealer_id' => $this->dealer_id,
            'customer_id' => $this->customer_id,
            'status' => $this->status,
            'ordered_at' => $this->ordered_at,
            'approved_at' => $this->approved_at,
            'currency' => $this->currency,
            'grand_total' => number_format((float) $this->grand_total, 2, '.', ''),
            'customer' => [
                'id' => $this->customer?->id,
                'code' => $this->customer?->code,
                'title' => $this->customer?->name,
            ],
            'created_by' => [
                'id' => $createdBy?->id,
                'name' => $createdBy?->name,
                'role_slugs' => $createdByRoleSlugs,
            ],
            'salesperson' => [
                'id' => $isDepotTransfer ? null : $salespersonId,
                'name' => $isDepotTransfer ? null : $salespersonName,
            ],
            'origin' => [
                'source' => $this->nullableString(data_get($invoiceMeta, 'source')) ?? 'order_checkout',
                'source_label' => $isDepotTransfer
                    ? 'Depolar Arası Transfer'
                    : ($this->nullableString(data_get($invoiceMeta, 'source_label')) ?? 'Sipariş faturası'),
                'panel' => $sourcePanel,
                'panel_label' => $this->nullableString(data_get($invoiceMeta, 'source_panel_label'))
                    ?? $this->sourcePanelLabel($sourcePanel),
                'warehouse_dispatch' => (bool) (data_get($invoiceMeta, 'warehouse_dispatch') ?? true),
                'checkout_summary' => $checkoutSummary,
                'sales_price_type' => $salesPriceType,
                'sales_price_type_label' => $this->salesPriceTypeLabel($salesPriceType),
                'payment_method' => $paymentMethod,
                'target_warehouse_code' => $targetWarehouseCode,
                'target_warehouse_name' => $targetWarehouseName,
                'target_warehouse_reason' => $targetWarehouseReason,
                'shipping_method' => $this->cart?->shipping_method,
                'note' => $this->note ?? $this->cart?->order_note ?? $this->cart?->note,
                'document_type' => $isDepotTransfer ? 'warehouse_transfer' : null,
                'document_label' => $isDepotTransfer ? 'DEPO TRANSFERİ' : null,
                'transfer_status' => $this->nullableString(data_get($transferSyncMeta, 'transfer_status')),
                'transfer_source_warehouse_code' => $transferSourceWarehouseCode,
                'transfer_source_warehouse_name' => $transferSourceWarehouseName,
                'transfer_target_warehouse_code' => $transferTargetWarehouseCode,
                'transfer_target_warehouse_name' => $transferTargetWarehouseName,
            ],
            'invoice' => [
                'id' => $invoice?->id,
                'reference_no' => $invoice?->reference_no ?? $this->order_no,
                'description' => $invoice?->description,
                'created_at' => $invoice?->created_at,
                'created_by' => [
                    'id' => $invoice?->createdBy?->id ?? $createdBy?->id,
                    'name' => $invoice?->createdBy?->name ?? $createdBy?->name,
                ],
            ],
            'items_summary' => [
                'item_count' => $itemCount,
                'total_quantity' => $totalQuantity,
            ],
            'logo_stock_summary' => [
                'source' => 'logo',
                'stock_covered_quantity' => $stockCoveredQuantity,
                'missing_quantity' => max(0, $totalQuantity - $stockCoveredQuantity),
                'low_stock_count' => $lowStockCount,
                'missing_stock_count' => $missingStockCount,
                'updated_at' => $stockUpdatedAt?->toIso8601String(),
            ],
            'logo_warehouse_options' => $this->formatLogoWarehouses($logoWarehouses),
            'preferred_warehouse_code' => $preferredWarehouseCode,
            'shipment' => $this->latestActiveShipment === null ? null : [
                'id' => $this->latestActiveShipment->id,
                'status' => $this->latestActiveShipment->status,
            ],
        ];
    }

    private function preferredWarehouseCode(?string $note): ?string
    {
        if ($note === null || preg_match('/Depo transfer:.*?Kod:\s*([A-Za-z0-9_-]+)/ui', $note, $matches) !== 1) {
            return null;
        }

        return trim((string) ($matches[1] ?? '')) ?: null;
    }

    /**
     * @return array{code:string,name:string,reason:string}|null
     */
    private function targetWarehouseForContext(?User $user, mixed $customer, ?string $shippingMethod): ?array
    {
        return app(WarehouseBranchResolver::class)->targetWarehouse($user, $customer, $shippingMethod);
    }

    private function normalizeBranchCode(mixed $value): ?string
    {
        $normalized = preg_replace('/[^A-Z0-9]+/', '', Str::upper(Str::ascii(trim((string) $value)))) ?? '';

        if ($normalized === '') {
            return null;
        }

        if (str_contains($normalized, 'TRABZON')) {
            return 'TRABZON';
        }

        if (str_contains($normalized, 'SAMSUN')) {
            return 'SAMSUN';
        }

        if (str_contains($normalized, 'ERZURUM') || str_starts_with($normalized, 'ERZ')) {
            return 'ERZURUM';
        }

        if (str_contains($normalized, 'BATUM')) {
            return 'BATUM';
        }

        return $normalized;
    }

    private function branchCodeFromUserIdentity(?User $user): ?string
    {
        if (! $user instanceof User) {
            return null;
        }

        $identity = preg_replace('/[^A-Z0-9]+/', '', Str::upper(Str::ascii(implode(' ', array_filter([
            $user->username,
            $user->email,
            $user->name,
        ]))))) ?? '';

        if ($identity === '') {
            return null;
        }

        $explicit = [
            'TRABZONPOINT' => 'TRABZON',
            'TRABZONDEPO' => 'TRABZON',
            'SAMSUNPOINT' => 'SAMSUN',
            'SAMSUNDEPO' => 'SAMSUN',
            'ERZURUMMERKEZ' => 'ERZURUM',
            'MUDURERZURUM' => 'ERZURUM',
            'AHMETARAC' => 'ERZURUM',
            'ERZDEPO' => 'ERZURUM',
            'BATUM' => 'BATUM',
        ];

        foreach ($explicit as $needle => $branch) {
            if (str_contains($identity, $needle)) {
                return $branch;
            }
        }

        return $this->normalizeBranchCode($identity);
    }

    /**
     * @param  array<string, mixed>  $meta
     * @return array{mode: string, code: string, label: string}|null
     */
    private function checkoutSummaryFromMeta(array $meta): ?array
    {
        $summary = data_get($meta, 'checkout_summary');

        if (is_array($summary)) {
            $mode = trim((string) ($summary['mode'] ?? ''));
            $code = trim((string) ($summary['code'] ?? ''));
            $label = trim((string) ($summary['label'] ?? ''));

            if ($mode !== '' && $code !== '') {
                return [
                    'mode' => $mode,
                    'code' => $code,
                    'label' => $label !== '' ? $label : $code,
                ];
            }
        }

        $mode = $this->consistentItemCheckoutSummaryMode($meta)
            ?? trim((string) data_get($meta, 'checkout_summary_mode', ''));

        return match ($mode) {
            'excluded' => ['mode' => 'excluded', 'code' => '2-0', 'label' => '2 - 0'],
            'included' => ['mode' => 'included', 'code' => '3-B', 'label' => '3 - B'],
            'detailed' => ['mode' => 'detailed', 'code' => '1-F', 'label' => '1 - F'],
            default => null,
        };
    }

    /**
     * If every selected/order item was explicitly assigned the same VAT display
     * mode, that row-level choice is more accurate than the stale global mode.
     *
     * @param  array<string, mixed>  $meta
     */
    private function consistentItemCheckoutSummaryMode(array $meta): ?string
    {
        $itemModes = data_get($meta, 'item_checkout_summary_modes');

        if (! is_array($itemModes) || $itemModes === []) {
            return null;
        }

        $modes = collect($itemModes)
            ->map(fn (mixed $mode): string => trim((string) $mode))
            ->filter(fn (string $mode): bool => in_array($mode, ['detailed', 'excluded', 'included'], true))
            ->unique()
            ->values();

        return $modes->count() === 1 ? $modes->first() : null;
    }

    private function salesPriceTypeLabel(?string $value): ?string
    {
        $normalized = mb_strtolower(trim((string) $value), 'UTF-8');

        return match ($normalized) {
            'bank_transfer', 'transfer', 'havale', 'havale/eft', 'havale / eft' => 'Havale / EFT',
            'cash', 'nakit' => 'Nakit',
            'single_payment', 'tek çekim', 'tek cekim' => 'Tek Çekim',
            default => $value,
        };
    }

    /**
     * @return array<string, mixed>
     */
    private function orderLogoSyncMeta(): array
    {
        $state = IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'orders')
            ->where('direction', 'outbound')
            ->where('entity_type', $this->resource::class)
            ->where('entity_id', (int) $this->id)
            ->first();

        return is_array($state?->meta) ? $state->meta : [];
    }

    /**
     * @return array<string, mixed>
     */
    private function orderWarehouseTransferMeta(): array
    {
        $state = IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'warehouse-transfer-orders')
            ->where('direction', 'outbound')
            ->where('entity_type', $this->resource::class)
            ->where('entity_id', (int) $this->id)
            ->latest('id')
            ->first();

        return is_array($state?->meta) ? $state->meta : [];
    }

    /**
     * @param  array<string, array<string, mixed>>  $logoWarehouses
     * @param  array<string, mixed>  $meta
     */
    private function collectLogoWarehouses(array &$logoWarehouses, array $meta, int $quantity): void
    {
        $warehouses = data_get($meta, 'integrations.logo.payload.logo_stock.warehouses');
        if (! is_array($warehouses)) {
            return;
        }

        foreach ($warehouses as $warehouse) {
            if (! is_array($warehouse)) {
                continue;
            }

            $code = $this->firstArrayScalar($warehouse, [
                'warehouse_code',
                'branch_code',
                'code',
                'invenno',
                'warehouse_no',
            ]);
            $name = $this->firstArrayScalar($warehouse, [
                'warehouse_name',
                'branch_name',
                'name',
                'depo_adi',
                'ambar_adi',
                'branch',
            ]);

            $key = $code ?? $name;
            if ($key === null) {
                continue;
            }

            $available = $this->firstIntegerValue($warehouse, [
                'available_total',
                'available',
                'onhand_total',
                'onhand',
                'stock',
                'quantity',
            ]) ?? 0;

            $normalizedKey = trim((string) $key);
            if (! isset($logoWarehouses[$normalizedKey])) {
                $logoWarehouses[$normalizedKey] = [
                    'warehouse_code' => $code,
                    'warehouse_name' => $name ?? ($code !== null ? "Logo Ambar {$code}" : 'Logo Ambar'),
                    'available_total' => 0,
                    'stock_covered_quantity' => 0,
                    'order_quantity' => 0,
                    'item_count' => 0,
                ];
            }

            $logoWarehouses[$normalizedKey]['available_total'] = (int) $logoWarehouses[$normalizedKey]['available_total'] + max(0, $available);
            $logoWarehouses[$normalizedKey]['stock_covered_quantity'] =
                (int) $logoWarehouses[$normalizedKey]['stock_covered_quantity'] + min($quantity, max(0, $available));
            $logoWarehouses[$normalizedKey]['order_quantity'] = (int) $logoWarehouses[$normalizedKey]['order_quantity'] + $quantity;
            $logoWarehouses[$normalizedKey]['item_count'] = (int) $logoWarehouses[$normalizedKey]['item_count'] + 1;
        }
    }

    /**
     * @param  array<string, array<string, mixed>>  $logoWarehouses
     * @return list<array<string, mixed>>
     */
    private function formatLogoWarehouses(array $logoWarehouses): array
    {
        if ($logoWarehouses === []) {
            return [];
        }

        $localWarehouses = Warehouse::query()
            ->get(['id', 'code', 'name', 'is_active'])
            ->keyBy('code');

        return collect($logoWarehouses)
            ->filter(fn (array $warehouse): bool => $this->isShipmentWarehouseOption(
                $warehouse['warehouse_code'] !== null ? (string) $warehouse['warehouse_code'] : null,
                $warehouse['warehouse_name'] !== null ? (string) $warehouse['warehouse_name'] : null,
            ))
            ->map(function (array $warehouse) use ($localWarehouses): array {
                $code = $warehouse['warehouse_code'] !== null ? (string) $warehouse['warehouse_code'] : null;
                $orderQuantity = (int) $warehouse['order_quantity'];
                $coveredQuantity = (int) $warehouse['stock_covered_quantity'];
                $localWarehouse = $code !== null ? $localWarehouses->get($code) : null;

                return [
                    'warehouse_id' => $localWarehouse?->id,
                    'warehouse_code' => $code,
                    'warehouse_name' => (string) $warehouse['warehouse_name'],
                    'available_total' => (int) $warehouse['available_total'],
                    'stock_covered_quantity' => $coveredQuantity,
                    'missing_quantity' => max(0, $orderQuantity - $coveredQuantity),
                    'order_quantity' => $orderQuantity,
                    'item_count' => (int) $warehouse['item_count'],
                    'is_active' => $localWarehouse?->is_active ?? true,
                ];
            })
            ->sortBy([
                ['missing_quantity', 'asc'],
                ['available_total', 'desc'],
                ['warehouse_code', 'asc'],
            ])
            ->values()
            ->all();
    }

    private function isShipmentWarehouseOption(?string $code, ?string $name): bool
    {
        $normalizedCode = trim((string) $code);
        $normalizedName = mb_strtolower(trim((string) $name), 'UTF-8');

        if (in_array($normalizedCode, ['0', '4'], true)) {
            return false;
        }

        foreach (['point', 'batum', 'batumi', 'sevkiyat'] as $blockedNeedle) {
            if ($normalizedName !== '' && str_contains($normalizedName, $blockedNeedle)) {
                return false;
            }
        }

        if (in_array($normalizedCode, ['1', '2', '3'], true)) {
            return true;
        }

        return str_contains($normalizedName, 'erzurum depo')
            || str_contains($normalizedName, 'trabzon depo')
            || str_contains($normalizedName, 'samsun depo');
    }

    /**
     * @param  array<string, mixed>  $source
     * @param  list<string>  $keys
     */
    private function firstArrayScalar(array $source, array $keys): ?string
    {
        foreach ($keys as $key) {
            $value = $source[$key] ?? null;
            if (is_scalar($value) && trim((string) $value) !== '') {
                return trim((string) $value);
            }
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $source
     * @param  list<string>  $keys
     */
    private function firstIntegerValue(array $source, array $keys): ?int
    {
        foreach ($keys as $key) {
            $value = $source[$key] ?? null;
            if (is_numeric($value)) {
                return (int) $value;
            }
        }

        return null;
    }

    private function invoiceLedgerEntry(): ?LedgerEntry
    {
        if (! $this->resource->relationLoaded('ledgerEntries')) {
            return null;
        }

        return $this->ledgerEntries
            ->first(fn (LedgerEntry $entry): bool => (string) $entry->type === 'invoice');
    }

    /**
     * @return list<string>
     */
    private function userRoleSlugs(?User $user): array
    {
        if (! $user instanceof User || ! $user->relationLoaded('roles')) {
            return [];
        }

        return $user->roles
            ->pluck('slug')
            ->map(fn ($slug): string => (string) $slug)
            ->values()
            ->all();
    }

    /**
     * @param  list<string>  $roleSlugs
     */
    private function resolveSourcePanel(array $roleSlugs): string
    {
        if (in_array('salesperson', $roleSlugs, true)) {
            return 'salesperson';
        }

        if (in_array('point', $roleSlugs, true)) {
            return 'point';
        }

        if (in_array('dealer_admin', $roleSlugs, true)) {
            return 'dealer_admin';
        }

        if (in_array('admin', $roleSlugs, true)) {
            return 'admin';
        }

        if (in_array('warehouse', $roleSlugs, true)) {
            return 'warehouse';
        }

        return 'b2b';
    }

    private function sourcePanelLabel(string $panel): string
    {
        return match ($panel) {
            'salesperson' => 'Plasiyer Paneli',
            'point' => 'Point/Bayi Paneli',
            'dealer_admin' => 'Bayi Yönetici Paneli',
            'admin' => 'Admin Paneli',
            'warehouse' => 'Depo Paneli',
            default => 'B2B Paneli',
        };
    }

    /**
     * @param  list<string>  $roleSlugs
     */
    private function resolveSalesperson(?User $createdBy, array $roleSlugs): ?User
    {
        if ($createdBy instanceof User && in_array('salesperson', $roleSlugs, true)) {
            return $createdBy;
        }

        return $this->customer?->salesperson;
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
