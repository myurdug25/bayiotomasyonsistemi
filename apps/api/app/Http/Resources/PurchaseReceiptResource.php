<?php

namespace App\Http\Resources;

use App\Models\IntegrationSyncState;
use App\Models\Product;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Support\Arr;
use Illuminate\Support\Str;

class PurchaseReceiptResource extends JsonResource
{
    private const WAREHOUSE_NAMES = [
        '0' => 'ERZURUM POINT',
        '1' => 'ERZURUM DEPO',
        '2' => 'TRABZON DEPO',
        '3' => 'SAMSUN DEPO',
        '4' => 'BATUM DEPO',
    ];

    private const WAREHOUSE_RAF_COLUMNS = [
        '0' => 'RAF250',
        '1' => 'RAF250',
        '2' => 'RAF61',
        '3' => 'RAF55',
        '4' => 'RAF995',
    ];

    /** @var array<string, Product|null> */
    private static array $productCache = [];

    public function toArray(Request $request): array
    {
        $isWarehouseTransfer = str_starts_with((string) $this->note, 'Depolar arasi transfer:');
        $targetWarehouse = $this->resolveTargetWarehouse();

        $syncState = $isWarehouseTransfer
            ? IntegrationSyncState::query()
                ->where('system', 'logo')
                ->where('domain', 'warehouse-transfers')
                ->where('direction', 'outbound')
                ->where('meta->purchase_receipt_id', (int) $this->id)
                ->orderByDesc('id')
                ->first()
            : IntegrationSyncState::query()
                ->where('system', 'logo')
                ->where('domain', 'purchase-receipts')
                ->where('direction', 'outbound')
                ->where('entity_type', $this->resource::class)
                ->where('entity_id', (int) $this->id)
                ->first();

        return [
            'id' => $this->id,
            'receipt_no' => $this->receipt_no,
            'document_no' => $this->document_no,
            'supplier_name' => $this->supplier_name,
            'warehouse_code' => $this->warehouse_code,
            'warehouse_name' => $this->warehouse_name,
            'received_at' => optional($this->received_at)?->toDateString(),
            'note' => $this->note,
            'status' => $this->status,
            'logo_sync_status' => $syncState?->status,
            'logo_sync_error' => $syncState?->last_error,
            'logo_external_ref' => $syncState?->external_ref,
            'logo_last_synced_at' => $syncState?->last_synced_at,
            'items' => $this->items->map(function ($item) use ($targetWarehouse): array {
                $product = $this->resolveProduct($item->product_code);
                $meta = is_array($product?->meta) ? $product->meta : [];
                $currentStock = $this->resolveWarehouseStock($meta, $targetWarehouse['code']);
                $acceptedQuantity = (int) $item->accepted_quantity;

                return [
                    'id' => $item->id,
                    'product_code' => $item->product_code,
                    'product_name' => $item->product_name,
                    'expected_quantity' => (int) $item->expected_quantity,
                    'accepted_quantity' => $acceptedQuantity,
                    'note' => $item->note,
                    'warehouse_code' => $targetWarehouse['code'],
                    'warehouse_name' => $targetWarehouse['name'],
                    'shelf_address' => $this->resolveWarehouseShelfAddress($meta, $targetWarehouse['code']),
                    'current_stock' => $currentStock,
                    'new_total_stock' => $currentStock === null ? null : $currentStock + $acceptedQuantity,
                ];
            })->values()->all(),
        ];
    }

    /**
     * @return array{code:string,name:string}
     */
    private function resolveTargetWarehouse(): array
    {
        $rawCode = $this->stringOrNull($this->warehouse_code);
        $rawName = $this->normalizeWarehouseText($this->warehouse_name);

        if ($rawCode !== null && isset(self::WAREHOUSE_NAMES[$rawCode])) {
            return ['code' => $rawCode, 'name' => self::WAREHOUSE_NAMES[$rawCode]];
        }

        $code = match (true) {
            str_contains($rawName, 'BATUM') => '4',
            str_contains($rawName, 'SAMSUN') => '3',
            str_contains($rawName, 'TRABZON') => '2',
            str_contains($rawName, 'POINT') => '0',
            default => '1',
        };

        return ['code' => $code, 'name' => self::WAREHOUSE_NAMES[$code]];
    }

    private function resolveProduct(?string $productCode): ?Product
    {
        $normalizedCode = $this->normalizeProductCode($productCode);
        if ($normalizedCode === '') {
            return null;
        }

        if (array_key_exists($normalizedCode, self::$productCache)) {
            return self::$productCache[$normalizedCode];
        }

        $variants = array_values(array_unique(array_filter([
            $this->stringOrNull($productCode),
            preg_replace('/\s+/u', '', (string) $productCode),
            preg_replace('/^([A-Za-z]+)(\d.*)$/u', '$1 $2', preg_replace('/\s+/u', '', (string) $productCode) ?? ''),
        ])));

        $product = Product::query()
            ->whereIn('sku', $variants)
            ->orWhere(function ($query) use ($variants): void {
                foreach ($variants as $variant) {
                    $query->orWhere('sku', 'like', $variant);
                }
            })
            ->first();

        return self::$productCache[$normalizedCode] = $product;
    }

    private function resolveWarehouseStock(array $meta, string $warehouseCode): ?int
    {
        $warehouse = $this->warehousePayload($meta, $warehouseCode);
        if ($warehouse === null) {
            return null;
        }

        return $this->firstIntegerValue($warehouse, [
            'available_total',
            'available',
            'onhand_total',
            'onhand',
            'fiili_stok',
            'stock',
            'quantity',
            'qty',
        ]);
    }

    private function resolveWarehouseShelfAddress(array $meta, string $warehouseCode): ?string
    {
        $warehouse = $this->warehousePayload($meta, $warehouseCode);
        $rafColumn = self::WAREHOUSE_RAF_COLUMNS[$warehouseCode] ?? null;
        $rafCandidates = $this->rafFieldCandidates($rafColumn);

        if ($warehouse !== null) {
            $value = $this->firstCaseInsensitiveString($warehouse, array_merge($rafCandidates, [
                'shelf_address',
                'raf_address',
                'raf_adresi',
                'shelf',
                'raf',
                'location',
                'location_code',
            ]));

            if ($value !== null) {
                return $value;
            }
        }

        if ($rafColumn !== null) {
            $paths = [];
            foreach ($rafCandidates as $candidate) {
                $paths[] = $candidate;
                $paths[] = "integrations.logo.payload.{$candidate}";
                $paths[] = "integrations.logo.payload.raw.{$candidate}";
                $paths[] = "integrations.logo.payload.logo_product.{$candidate}";
                $paths[] = "integrations.logo.product_card.{$candidate}";
                $paths[] = "logo_product.{$candidate}";
                $paths[] = "raw.{$candidate}";
            }

            $value = $this->firstCaseInsensitiveString($meta, $paths);
            if ($value !== null) {
                return $value;
            }

            foreach ($rafCandidates as $candidate) {
                $value = $this->recursiveStringByKey($meta, $candidate);
                if ($value !== null) {
                    return $value;
                }
            }
        }

        return null;
    }

    private function warehousePayload(array $meta, string $warehouseCode): ?array
    {
        $warehouses = Arr::get($meta, 'integrations.logo.payload.logo_stock.warehouses');
        if (! is_array($warehouses)) {
            return null;
        }

        foreach ($warehouses as $warehouse) {
            if (! is_array($warehouse)) {
                continue;
            }

            $code = $this->stringOrNull($warehouse['warehouse_code'] ?? $warehouse['code'] ?? $warehouse['invenno'] ?? $warehouse['warehouse_no'] ?? null);
            if ($code === $warehouseCode) {
                return $warehouse;
            }
        }

        return null;
    }

    /**
     * @return list<string>
     */
    private function rafFieldCandidates(?string $rafColumn): array
    {
        if ($rafColumn === null) {
            return [];
        }

        $suffix = preg_replace('/\D+/', '', $rafColumn) ?? '';
        $candidates = [$rafColumn];

        if ($suffix !== '') {
            $candidates = array_merge($candidates, [
                "RAF{$suffix}",
                "RAF_{$suffix}",
                "RAFADRESI{$suffix}",
                "RAF_ADRESI_{$suffix}",
                "RAF_BILGISI{$suffix}",
                "RAF_BILGISI_{$suffix}",
                "RAF_BILGILERI{$suffix}",
                "RAF_BILGILERI_{$suffix}",
                "SHELF_ADDRESS{$suffix}",
                "LOCATION{$suffix}",
                "LOCATION_CODE{$suffix}",
            ]);
        }

        return array_values(array_unique($candidates));
    }

    /**
     * @param  list<string>  $paths
     */
    private function firstCaseInsensitiveString(array $source, array $paths): ?string
    {
        foreach ($paths as $path) {
            $parts = explode('.', $path);
            $value = $source;

            foreach ($parts as $part) {
                if (! is_array($value)) {
                    $value = null;
                    break;
                }

                $matchedKey = null;
                foreach (array_keys($value) as $key) {
                    if (Str::lower((string) $key) === Str::lower($part)) {
                        $matchedKey = $key;
                        break;
                    }
                }

                if ($matchedKey === null) {
                    $value = null;
                    break;
                }

                $value = $value[$matchedKey];
            }

            $string = $this->stringOrNull($value);
            if ($string !== null) {
                return $string;
            }
        }

        return null;
    }

    private function recursiveStringByKey(array $source, string $targetKey): ?string
    {
        $target = Str::lower($targetKey);

        foreach ($source as $key => $value) {
            if (Str::lower((string) $key) === $target) {
                $string = $this->stringOrNull($value);
                if ($string !== null) {
                    return $string;
                }
            }

            if (is_array($value)) {
                $string = $this->recursiveStringByKey($value, $targetKey);
                if ($string !== null) {
                    return $string;
                }
            }
        }

        return null;
    }

    /**
     * @param  list<string>  $keys
     */
    private function firstIntegerValue(array $source, array $keys): ?int
    {
        foreach ($keys as $key) {
            $value = $source[$key] ?? null;
            if (is_numeric($value)) {
                return max(0, (int) $value);
            }
        }

        return null;
    }

    private function normalizeProductCode(?string $value): string
    {
        $value = Str::upper((string) $value);

        return preg_replace('/[^\p{L}\p{N}]+/u', '', $value) ?? '';
    }

    private function normalizeWarehouseText(?string $value): string
    {
        $value = Str::upper((string) $value);
        $value = str_replace(['İ', 'ı'], ['I', 'I'], $value);

        return preg_replace('/[^\p{L}\p{N}]+/u', ' ', $value) ?? '';
    }

    private function stringOrNull(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $string = trim((string) $value);

        return $string === '' ? null : $string;
    }
}
