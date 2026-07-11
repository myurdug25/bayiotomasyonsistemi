<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\IntegrationSyncState;
use App\Models\Product;
use App\Models\ProductCodeAlias;
use App\Models\User;
use App\Support\Warehouse\WarehouseBranchResolver;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class WarehouseShelfController extends Controller
{
    private const WAREHOUSES = [
        '0' => 'ERZURUM POINT',
        '1' => 'ERZURUM DEPO',
        '2' => 'TRABZON DEPO',
        '3' => 'SAMSUN DEPO',
        '4' => 'BATUM DEPO',
    ];

    private const WAREHOUSE_RAF_COLUMNS = [
        '0' => 'RAF250',
        '1' => 'RAF25',
        '2' => 'RAF61',
        '3' => 'RAF55',
        '4' => 'RAF995',
    ];

    public function __construct(private readonly WarehouseBranchResolver $branchResolver) {}

    public function index(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'q' => ['nullable', 'string', 'max:120'],
            'warehouse_code' => ['nullable', 'string', Rule::in(array_keys(self::WAREHOUSES))],
            'limit' => ['nullable', 'integer', 'min:1', 'max:80'],
        ]);

        $user = $request->user();
        $warehouseCode = $this->resolveRequestedWarehouseCode($user, $validated['warehouse_code'] ?? null);
        $queryText = trim((string) ($validated['q'] ?? ''));
        $limit = (int) ($validated['limit'] ?? 40);

        $productsQuery = Product::query()
            ->with(['brand:id,name', 'codeAliases:id,product_id,code,code_type,brand_name,source'])
            ->where('is_active', true)
            ->orderBy('sku')
            ->limit($limit);

        if ($queryText !== '') {
            $productsQuery->where(function (Builder $query) use ($queryText): void {
                $like = '%'.$queryText.'%';
                $query
                    ->where('sku', 'like', $like)
                    ->orWhere('name', 'like', $like)
                    ->orWhere('oem_code', 'like', $like)
                    ->orWhereHas('codeAliases', fn (Builder $aliasQuery) => $aliasQuery->where('code', 'like', $like));

                $this->orWhereMetaTextLike($query, $queryText);
            });
        }

        $products = $productsQuery
            ->get()
            ->map(fn (Product $product): array => $this->mapProduct($product, $warehouseCode))
            ->values();

        return response()->json([
            'data' => $products,
            'warehouse' => [
                'code' => $warehouseCode,
                'name' => self::WAREHOUSES[$warehouseCode] ?? 'DEPO',
                'editable' => $this->canManageWarehouse($user, $warehouseCode),
            ],
        ]);
    }

    public function update(Request $request, Product $product): JsonResponse
    {
        $validated = $request->validate([
            'warehouse_code' => ['required', 'string', Rule::in(array_keys(self::WAREHOUSES))],
            'shelf_address' => ['nullable', 'string', 'max:80'],
        ]);

        $user = $request->user();
        $warehouseCode = (string) $validated['warehouse_code'];

        abort_unless($this->canManageWarehouse($user, $warehouseCode), 403, 'Bu raf adresini düzenleme yetkiniz yok.');

        $shelfAddress = trim((string) ($validated['shelf_address'] ?? ''));
        $shelfAddress = $shelfAddress === '' ? null : $shelfAddress;

        DB::transaction(function () use ($product, $user, $warehouseCode, $shelfAddress): void {
            $meta = $this->withShelfAddress($product->meta ?? [], $warehouseCode, $shelfAddress);

            Arr::set($meta, 'integrations.logo.shelf_update_pending_at', now()->toIso8601String());
            Arr::set($meta, 'integrations.logo.shelf_update_user_id', $user?->id);

            $product->forceFill(['meta' => $meta])->save();

            $payload = [
                'export_key' => "B2B-PRODUCT-SHELF-{$product->id}-{$warehouseCode}",
                'product_id' => (int) $product->id,
                'product_code' => (string) $product->sku,
                'product_external_ref' => $this->stringOrNull(Arr::get($meta, 'integrations.logo.external_ref')),
                'warehouse_code' => $warehouseCode,
                'warehouse_name' => self::WAREHOUSES[$warehouseCode] ?? null,
                'shelf_address' => $shelfAddress,
                'oem_code' => $this->stringOrNull($product->oem_code),
                'requested_by_user_id' => $user?->id,
                'requested_at' => now()->toIso8601String(),
            ];

            IntegrationSyncState::query()->updateOrCreate(
                [
                    'system' => 'logo',
                    'domain' => 'product-shelves',
                    'direction' => 'outbound',
                    'entity_type' => Product::class,
                    'entity_id' => (int) $product->id,
                ],
                [
                    'dealer_id' => is_numeric($user?->dealer_id) ? (int) $user->dealer_id : null,
                    'customer_id' => null,
                    'external_ref' => null,
                    'status' => 'queued',
                    'last_error' => null,
                    'last_synced_at' => null,
                    'payload_hash' => hash('sha256', json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: ''),
                    'meta' => $payload,
                ]
            );
        });

        $fresh = Product::query()
            ->with(['brand:id,name', 'codeAliases:id,product_id,code,code_type,brand_name,source'])
            ->findOrFail($product->id);

        return response()->json([
            'data' => $this->mapProduct($fresh, $warehouseCode),
            'message' => 'Raf adresi kaydedildi ve Logo güncelleme kuyruğuna alındı.',
        ]);
    }

    private function resolveRequestedWarehouseCode(?User $user, ?string $requestedCode): string
    {
        if ($requestedCode !== null && $this->canManageWarehouse($user, $requestedCode)) {
            return $requestedCode;
        }

        $branchCode = $this->branchResolver->resolveBranchCode($user);
        if ($branchCode === 'BATUM') {
            return '4';
        }

        $target = $this->branchResolver->targetWarehouse($user);
        $targetCode = $this->stringOrNull($target['code'] ?? null);

        return in_array($targetCode, array_keys(self::WAREHOUSES), true) ? $targetCode : '1';
    }

    private function canManageWarehouse(?User $user, string $warehouseCode): bool
    {
        if (! $user instanceof User) {
            return false;
        }

        if ($user->hasAnyRole(['admin', 'dealer_admin'])) {
            return true;
        }

        $branchCode = $this->branchResolver->resolveBranchCode($user);

        return match ($branchCode) {
            'ERZURUM' => in_array($warehouseCode, ['0', '1'], true),
            'TRABZON' => $warehouseCode === '2',
            'SAMSUN' => $warehouseCode === '3',
            'BATUM' => $warehouseCode === '4',
            default => false,
        };
    }

    private function mapProduct(Product $product, string $warehouseCode): array
    {
        $aliases = $product->codeAliases instanceof \Illuminate\Support\Collection
            ? $product->codeAliases
            : collect();

        $competitorCodes = $aliases
            ->filter(fn (ProductCodeAlias $alias): bool => in_array((string) $alias->code_type, ['competitor', 'rakip', 'muadil', 'substitute', 'oem'], true))
            ->pluck('code')
            ->filter()
            ->unique()
            ->values()
            ->all();

        $meta = $product->meta ?? [];

        return [
            'id' => (int) $product->id,
            'product_code' => (string) $product->sku,
            'product_name' => (string) $product->name,
            'brand' => $product->brand?->name,
            'oem' => $this->stringOrNull($product->oem_code)
                ?? $this->firstString($meta, ['oem', 'oem_code', 'integrations.logo.payload.oem', 'integrations.logo.payload.oem_code']),
            'competitor_codes' => $competitorCodes,
            'warehouse_code' => $warehouseCode,
            'warehouse_name' => self::WAREHOUSES[$warehouseCode] ?? 'DEPO',
            'shelf_address' => $this->resolveShelfAddress($meta, $warehouseCode),
            'editable' => true,
            'logo_ref' => $this->stringOrNull(Arr::get($meta, 'integrations.logo.external_ref')),
        ];
    }

    /**
     * @param  array<string, mixed>  $meta
     */
    private function resolveShelfAddress(array $meta, string $warehouseCode): ?string
    {
        $rafColumn = self::WAREHOUSE_RAF_COLUMNS[$warehouseCode] ?? null;
        $warehouses = Arr::get($meta, 'integrations.logo.payload.logo_stock.warehouses');
        if (is_array($warehouses)) {
            foreach ($warehouses as $warehouse) {
                if (! is_array($warehouse)) {
                    continue;
                }

                $code = $this->stringOrNull($warehouse['warehouse_code'] ?? $warehouse['code'] ?? $warehouse['invenno'] ?? null);
                if ($code !== $warehouseCode) {
                    continue;
                }

                $value = $this->firstString($warehouse, ['shelf_address', 'raf_address', 'raf_adresi', 'shelf', 'raf']);
                if ($value !== null) {
                    return $value;
                }

                if ($rafColumn !== null) {
                    $value = $this->firstCaseInsensitiveString($warehouse, [$rafColumn]);
                    if ($value !== null) {
                        return $value;
                    }
                }
            }
        }

        if ($rafColumn !== null) {
            $value = $this->firstCaseInsensitiveString($meta, [
                $rafColumn,
                "integrations.logo.payload.{$rafColumn}",
                "integrations.logo.payload.raw.{$rafColumn}",
                "integrations.logo.payload.logo_product.{$rafColumn}",
                "integrations.logo.product_card.{$rafColumn}",
                "logo_product.{$rafColumn}",
                "raw.{$rafColumn}",
            ]);

            if ($value !== null) {
                return $value;
            }

            $value = $this->recursiveStringByKey($meta, $rafColumn);
            if ($value !== null) {
                return $value;
            }
        }

        if ($warehouseCode !== '1') {
            return null;
        }

        return $this->firstString($meta, [
            'shelf_address',
            'raf_address',
            'raf_adresi',
            'integrations.logo.payload.shelf_address',
            'integrations.logo.payload.raf_address',
            'integrations.logo.payload.raf_adresi',
        ]);
    }

    /**
     * @param  array<string, mixed>  $meta
     * @return array<string, mixed>
     */
    private function withShelfAddress(array $meta, string $warehouseCode, ?string $shelfAddress): array
    {
        $rafColumn = self::WAREHOUSE_RAF_COLUMNS[$warehouseCode] ?? null;
        $warehouses = Arr::get($meta, 'integrations.logo.payload.logo_stock.warehouses');
        $warehouses = is_array($warehouses) ? array_values($warehouses) : [];
        $found = false;

        foreach ($warehouses as $index => $warehouse) {
            if (! is_array($warehouse)) {
                continue;
            }

            $code = $this->stringOrNull($warehouse['warehouse_code'] ?? $warehouse['code'] ?? $warehouse['invenno'] ?? null);
            if ($code !== $warehouseCode) {
                continue;
            }

            $warehouse['warehouse_code'] = $warehouseCode;
            $warehouse['warehouse_name'] = self::WAREHOUSES[$warehouseCode] ?? ($warehouse['warehouse_name'] ?? null);
            $warehouse['shelf_address'] = $shelfAddress;
            $warehouse['raf_adresi'] = $shelfAddress;
            if ($rafColumn !== null) {
                $warehouse[$rafColumn] = $shelfAddress;
            }
            $warehouses[$index] = $warehouse;
            $found = true;
            break;
        }

        if (! $found) {
            $warehouses[] = [
                'warehouse_code' => $warehouseCode,
                'warehouse_name' => self::WAREHOUSES[$warehouseCode] ?? null,
                'shelf_address' => $shelfAddress,
                'raf_adresi' => $shelfAddress,
            ];

            if ($rafColumn !== null) {
                $warehouses[array_key_last($warehouses)][$rafColumn] = $shelfAddress;
            }
        }

        Arr::set($meta, 'integrations.logo.payload.logo_stock.warehouses', $warehouses);

        if ($rafColumn !== null) {
            Arr::set($meta, "integrations.logo.payload.{$rafColumn}", $shelfAddress);
            Arr::set($meta, "integrations.logo.payload.raw.{$rafColumn}", $shelfAddress);
            $meta[$rafColumn] = $shelfAddress;
        }

        if ($warehouseCode === '1') {
            Arr::set($meta, 'integrations.logo.payload.shelf_address', $shelfAddress);
            Arr::set($meta, 'integrations.logo.payload.raf_adresi', $shelfAddress);
            $meta['shelf_address'] = $shelfAddress;
            $meta['raf_adresi'] = $shelfAddress;
        }

        return $meta;
    }

    private function orWhereMetaTextLike(Builder $query, string $search): void
    {
        $driver = DB::connection()->getDriverName();
        $needle = '%'.mb_strtolower($search, 'UTF-8').'%';

        if ($driver === 'pgsql') {
            $query->orWhereRaw('LOWER(CAST(meta AS TEXT)) LIKE ?', [$needle]);
            return;
        }

        $query->orWhereRaw('LOWER(CAST(meta AS CHAR)) LIKE ?', [$needle]);
    }

    /**
     * @param  array<string, mixed>  $source
     * @param  list<string>  $paths
     */
    private function firstString(array $source, array $paths): ?string
    {
        foreach ($paths as $path) {
            $value = $this->stringOrNull(Arr::get($source, $path));
            if ($value !== null) {
                return $value;
            }
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $source
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

    /**
     * @param  array<string, mixed>  $source
     */
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

    private function stringOrNull(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $string = trim((string) $value);

        return $string === '' ? null : $string;
    }
}
