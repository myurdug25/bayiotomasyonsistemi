<?php

namespace App\Support\Warehouse;

use App\Models\Warehouse;
use Illuminate\Support\Collection;

class CartWarehouseOptions
{
    private const DEFAULT_WAREHOUSES = [
        ['code' => '0', 'name' => 'ERZURUM POINT'],
        ['code' => '1', 'name' => 'ERZURUM DEPO'],
        ['code' => '2', 'name' => 'TRABZON DEPO'],
        ['code' => '3', 'name' => 'SAMSUN DEPO'],
        ['code' => '4', 'name' => 'BATUM DEPO'],
    ];

    private const WAREHOUSE_NAME_BY_CODE = [
        '0' => 'ERZURUM POINT',
        '1' => 'ERZURUM DEPO',
        '2' => 'TRABZON DEPO',
        '3' => 'SAMSUN DEPO',
        '4' => 'BATUM DEPO',
    ];

    /**
     * @param  Collection<int, mixed>  $items
     * @return list<array<string, mixed>>
     */
    public function forCartItems(Collection $items): array
    {
        $logoWarehouses = [];

        foreach ($items as $item) {
            $quantity = (int) ($item->quantity ?? 0);
            $meta = $item->product?->meta;

            if ($quantity <= 0 || ! is_array($meta)) {
                continue;
            }

            $this->collectLogoWarehouses($logoWarehouses, $meta, $quantity);
        }

        if ($logoWarehouses === []) {
            return $this->localWarehouseOptions();
        }

        $localWarehouses = Warehouse::query()
            ->get(['id', 'code', 'name', 'is_active'])
            ->keyBy('code');

        $shipmentWarehouses = collect($logoWarehouses)
            ->filter(fn (array $warehouse): bool => $this->isTransferWarehouseOption(
                $warehouse['warehouse_code'] !== null ? (string) $warehouse['warehouse_code'] : null,
                $warehouse['warehouse_name'] !== null ? (string) $warehouse['warehouse_name'] : null,
            ));

        if ($shipmentWarehouses->isEmpty()) {
            return $this->localWarehouseOptions();
        }

        return $shipmentWarehouses
            ->map(function (array $warehouse) use ($localWarehouses): array {
                $code = $warehouse['warehouse_code'] !== null ? (string) $warehouse['warehouse_code'] : null;
                $orderQuantity = (int) $warehouse['order_quantity'];
                $coveredQuantity = (int) $warehouse['stock_covered_quantity'];
                $localWarehouse = $code !== null ? $localWarehouses->get($code) : null;

                return [
                    'warehouse_id' => $localWarehouse?->id,
                    'warehouse_code' => $code,
                    'warehouse_name' => $this->displayWarehouseName($code, $warehouse['warehouse_name'] ?? null),
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
                    'warehouse_name' => $this->displayWarehouseName($code, $name),
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
     * @return list<array<string, mixed>>
     */
    private function localWarehouseOptions(): array
    {
        $warehouses = Warehouse::query()
            ->where('is_active', true)
            ->orderBy('code')
            ->get(['id', 'code', 'name', 'is_active']);

        if ($this->shouldUseDefaultWarehouses($warehouses)) {
            return $this->defaultWarehouseOptions();
        }

        return $warehouses
            ->filter(fn (Warehouse $warehouse): bool => $this->isTransferWarehouseOption($warehouse->code, $warehouse->name))
            ->map(fn (Warehouse $warehouse): array => [
                'warehouse_id' => (int) $warehouse->id,
                'warehouse_code' => $warehouse->code,
                'warehouse_name' => $this->displayWarehouseName($warehouse->code, $warehouse->name),
                'available_total' => 0,
                'stock_covered_quantity' => 0,
                'missing_quantity' => 0,
                'order_quantity' => 0,
                'item_count' => 0,
                'is_active' => (bool) $warehouse->is_active,
            ])
            ->values()
            ->all();
    }

    private function isTransferWarehouseOption(?string $code, ?string $name): bool
    {
        $normalizedCode = trim((string) $code);
        $normalizedName = mb_strtolower(trim((string) $name), 'UTF-8');

        foreach (['sevkiyat'] as $blockedNeedle) {
            if ($normalizedName !== '' && str_contains($normalizedName, $blockedNeedle)) {
                return false;
            }
        }

        if (array_key_exists($normalizedCode, self::WAREHOUSE_NAME_BY_CODE)) {
            return true;
        }

        return str_contains($normalizedName, 'erzurum point')
            || str_contains($normalizedName, 'erzurum depo')
            || str_contains($normalizedName, 'trabzon depo')
            || str_contains($normalizedName, 'samsun depo')
            || str_contains($normalizedName, 'batum depo')
            || str_contains($normalizedName, 'batumi depo');
    }

    /**
     * @param  Collection<int, Warehouse>  $warehouses
     */
    private function shouldUseDefaultWarehouses(Collection $warehouses): bool
    {
        if ($warehouses->isEmpty()) {
            return true;
        }

        $defaultCodes = collect(self::DEFAULT_WAREHOUSES)->pluck('code');
        $matchedDefaultCodes = $warehouses
            ->pluck('code')
            ->map(fn ($code): string => trim((string) $code))
            ->intersect($defaultCodes)
            ->unique()
            ->count();

        return $matchedDefaultCodes < 2;
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function defaultWarehouseOptions(): array
    {
        return collect(self::DEFAULT_WAREHOUSES)
            ->map(fn (array $warehouse): array => [
                'warehouse_id' => null,
                'warehouse_code' => $warehouse['code'],
                'warehouse_name' => $this->displayWarehouseName($warehouse['code'], $warehouse['name']),
                'available_total' => 0,
                'stock_covered_quantity' => 0,
                'missing_quantity' => 0,
                'order_quantity' => 0,
                'item_count' => 0,
                'is_active' => true,
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
                return (int) round((float) $value);
            }
        }

        return null;
    }

    private function displayWarehouseName(?string $code, mixed $name): string
    {
        $normalizedCode = trim((string) $code);
        if (array_key_exists($normalizedCode, self::WAREHOUSE_NAME_BY_CODE)) {
            return self::WAREHOUSE_NAME_BY_CODE[$normalizedCode];
        }

        $normalizedName = is_scalar($name) ? trim((string) $name) : '';
        if ($normalizedName !== '' && ! preg_match('/^logo\s+ambar\s+\d+$/i', $normalizedName)) {
            return mb_strtoupper($normalizedName, 'UTF-8');
        }

        return $normalizedCode !== '' ? "LOGO AMBAR {$normalizedCode}" : 'LOGO AMBAR';
    }
}
