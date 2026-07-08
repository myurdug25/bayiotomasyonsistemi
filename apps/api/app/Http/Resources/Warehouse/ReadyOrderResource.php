<?php

namespace App\Http\Resources\Warehouse;

use App\Models\LedgerEntry;
use App\Models\User;
use App\Models\Warehouse;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Support\Collection;

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
        $checkoutSummary = $this->checkoutSummaryFromMeta($invoiceMeta);
        $createdBy = $this->user;
        $createdByRoleSlugs = $this->userRoleSlugs($createdBy);
        $sourcePanel = $this->nullableString(data_get($invoiceMeta, 'source_panel'))
            ?? $this->resolveSourcePanel($createdByRoleSlugs);
        $salesperson = $this->resolveSalesperson($createdBy, $createdByRoleSlugs);
        $preferredWarehouseCode = $this->preferredWarehouseCode(
            $this->note ?? $this->cart?->order_note ?? $this->cart?->note
        );

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
                'id' => $salesperson?->id,
                'name' => $salesperson?->name,
            ],
            'origin' => [
                'source' => $this->nullableString(data_get($invoiceMeta, 'source')) ?? 'order_checkout',
                'source_label' => $this->nullableString(data_get($invoiceMeta, 'source_label')) ?? 'Sipariş faturası',
                'panel' => $sourcePanel,
                'panel_label' => $this->nullableString(data_get($invoiceMeta, 'source_panel_label'))
                    ?? $this->sourcePanelLabel($sourcePanel),
                'warehouse_dispatch' => (bool) (data_get($invoiceMeta, 'warehouse_dispatch') ?? true),
                'checkout_summary' => $checkoutSummary,
                'shipping_method' => $this->cart?->shipping_method,
                'note' => $this->note ?? $this->cart?->order_note ?? $this->cart?->note,
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

        $mode = trim((string) data_get($meta, 'checkout_summary_mode', ''));

        return match ($mode) {
            'excluded' => ['mode' => 'excluded', 'code' => '2-0', 'label' => '2 - 0'],
            'included' => ['mode' => 'included', 'code' => '3-B', 'label' => '3 - B'],
            'detailed' => ['mode' => 'detailed', 'code' => '1-F', 'label' => '1 - F'],
            default => ['mode' => 'detailed', 'code' => '1-F', 'label' => '1 - F'],
        };
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
