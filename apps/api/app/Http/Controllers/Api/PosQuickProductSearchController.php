<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Pos\QuickSearchPosProductsRequest;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\PriceList;
use App\Models\Product;
use App\Models\ProductCodeAlias;
use App\Models\User;
use App\Support\CustomerFeaturePermissions;
use App\Support\Pricing\DealerNetPriceExpression;
use App\Support\Pricing\DisplayCurrency;
use App\Support\Products\ProductCodeNormalizer;
use Illuminate\Cache\Repository as CacheRepository;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;
use Symfony\Component\HttpFoundation\Response;

class PosQuickProductSearchController extends Controller
{
    /**
     * @var list<string>
     */
    private const LOGO_CODE_SEARCH_PATHS = [
        'products.meta->integrations->logo->payload->raw->CODE',
        'products.meta->integrations->logo->payload->raw->CODE_',
        'products.meta->integrations->logo->payload->raw->ITEMCODE',
        'products.meta->integrations->logo->payload->raw->ITEM_CODE',
        'products.meta->integrations->logo->payload->raw->STOKKODU',
        'products.meta->integrations->logo->payload->raw->STOK_KODU',
        'products.meta->integrations->logo->payload->raw->PRODUCERCODE',
        'products.meta->integrations->logo->payload->raw->PRODUCER_CODE',
        'products.meta->integrations->logo->payload->raw->OEMCODE',
        'products.meta->integrations->logo->payload->raw->OEM_CODE',
        'products.meta->integrations->logo->payload->raw->BARCODE',
        'products.meta->integrations->logo->payload->raw->BARCODE1',
        'products.meta->integrations->logo->payload->raw->EAN13',
    ];

    public function __invoke(QuickSearchPosProductsRequest $request): JsonResponse
    {
        $validated = $request->validated();
        $limit = min((int) ($validated['limit'] ?? 20), 20);
        $search = trim((string) $validated['q']);
        $codeOnly = (bool) ($validated['code_only'] ?? false);

        $dealerContext = $this->resolveDealerContext($request->user(), $validated);
        if ($dealerContext === null) {
            return response()->json([
                'message' => 'dealer_id is required for users without an assigned dealer.',
            ], Response::HTTP_UNPROCESSABLE_ENTITY);
        }

        $dealerId = $dealerContext['dealer_id'];
        $priceListId = $dealerContext['price_list_id'];
        $netPriceSql = DealerNetPriceExpression::sql();

        $query = Product::query()
            ->select([
                'products.id',
                'products.sku',
                'products.oem_code',
                'products.name',
                'products.brand_id',
                'products.meta',
                'brands.name as brand_name',
            ])
            ->selectRaw("{$netPriceSql} as net_price")
            ->selectRaw("COALESCE(dpo.currency, bp.currency, 'TRY') as currency")
            ->selectRaw('COALESCE(ss.available_total, 0) as available_total')
            ->leftJoin('brands', 'brands.id', '=', 'products.brand_id')
            ->leftJoin('stock_summary as ss', 'ss.product_id', '=', 'products.id')
            ->leftJoin('base_prices as bp', function ($join) use ($priceListId) {
                $join->on('bp.product_id', '=', 'products.id')
                    ->where('bp.price_list_id', '=', $priceListId);
            })
            ->leftJoin('price_lists as pl', function ($join) use ($priceListId) {
                $join->on('pl.id', '=', 'bp.price_list_id')
                    ->where('pl.id', '=', $priceListId);
            })
            ->leftJoin('dealer_price_overrides as dpo', function ($join) use ($dealerId) {
                $join->on('dpo.product_id', '=', 'products.id')
                    ->where('dpo.dealer_id', '=', $dealerId);
            })
            ->where('products.is_active', true)
            ->where(function (Builder $builder): void {
                $this->applyLogoProductFilter($builder);
            });

        $escaped = $this->escapeLike($search);
        $prefix = $escaped.'%';
        $contains = '%'.$escaped.'%';
        $normalizedSearch = ProductCodeNormalizer::normalize($search);

        if ($this->isLikelyProductCodeSearch($search)) {
            $exactProductIds = $codeOnly
                ? $this->resolveDirectProductCodeIds($search, $normalizedSearch, $limit)
                : $this->resolveExactProductCodeIds($search, $normalizedSearch, $limit);
            if ($exactProductIds !== []) {
                $exactQuery = clone $query;
                $exactItems = $exactQuery
                    ->whereIn('products.id', $exactProductIds)
                    ->orderByRaw($this->productIdOrderSql($exactProductIds), $exactProductIds)
                    ->limit($limit)
                    ->get();

                if ($exactItems->isNotEmpty()) {
                    $cache = $this->cacheStore();

                    $stockScope = $this->resolveStockVisibilityScope($request->user());

                    return response()->json([
                        'data' => $this->mapProducts($exactItems, $cache, $dealerId, $request->user(), $stockScope),
                        'limit' => $limit,
                        'search_backend' => 'pos_quick',
                    ]);
                }
            }

            if ($codeOnly) {
                $cache = $this->cacheStore();
                $stockScope = $this->resolveStockVisibilityScope($request->user());

                return response()->json([
                    'data' => $this->mapProducts(collect(), $cache, $dealerId, $request->user(), $stockScope),
                    'limit' => $limit,
                    'search_backend' => 'pos_quick',
                ]);
            }

            $exactMatchGroupCodes = $this->shouldResolveExactCodeMatchGroups($search, $normalizedSearch)
                ? $this->resolveExactCodeMatchGroupCodes($search, $normalizedSearch)
                : [];

            if ($exactMatchGroupCodes !== []) {
                $groupProductIds = $this->matchingGroupProductIds($exactMatchGroupCodes, $limit, $search, $normalizedSearch);

                if ($groupProductIds !== []) {
                    $groupQuery = clone $query;
                    $groupItems = $groupQuery
                        ->whereIn('products.id', $groupProductIds)
                        ->orderByRaw($this->productIdOrderSql($groupProductIds), $groupProductIds)
                        ->limit($limit)
                        ->get();

                    if ($groupItems->isNotEmpty()) {
                        $cache = $this->cacheStore();
                        $stockScope = $this->resolveStockVisibilityScope($request->user());

                        return response()->json([
                            'data' => $this->mapProducts($groupItems, $cache, $dealerId, $request->user(), $stockScope),
                            'limit' => $limit,
                            'search_backend' => 'pos_quick',
                        ]);
                    }
                }
            }

            $fastQuery = clone $query;
            $this->applyFastProductCodeSearchConstraint($fastQuery, $search, $prefix, $normalizedSearch);
            $this->applyFastProductCodeRanking($fastQuery, $search, $prefix, $normalizedSearch);

            $fastItems = $fastQuery->limit($limit)->get();

            if ($fastItems->isNotEmpty()) {
                $cache = $this->cacheStore();

                $stockScope = $this->resolveStockVisibilityScope($request->user());

                return response()->json([
                    'data' => $this->mapProducts($fastItems, $cache, $dealerId, $request->user(), $stockScope),
                    'limit' => $limit,
                    'search_backend' => 'pos_quick',
                ]);
            }
        }

        $query->where(function (Builder $builder) use ($prefix, $contains, $normalizedSearch) {
            $builder
                ->whereLike('products.sku', $prefix, caseSensitive: false)
                ->orWhereLike('products.oem_code', $prefix, caseSensitive: false)
                ->orWhereLike('products.sku', $contains, caseSensitive: false)
                ->orWhereLike('products.oem_code', $contains, caseSensitive: false)
                ->orWhereLike('products.name', $contains, caseSensitive: false);

            $this->applyNormalizedProductCodeSearchConstraint($builder, $normalizedSearch);
            $this->applyCodeAliasSearchConstraint($builder, $normalizedSearch);
            $this->applyLogoPayloadCodeSearchConstraint($builder, $contains);
        });

        $case = 'CASE '
            .'WHEN products.sku = ? THEN 0 '
            .'WHEN products.oem_code = ? THEN 1 ';
        $bindings = [$search, $search];

        if ($normalizedSearch !== null) {
            $case .= 'WHEN '.$this->normalizedProductCodeSql('products.sku').' = ? THEN 2 '
                .'WHEN '.$this->normalizedProductCodeSql('products.oem_code').' = ? THEN 3 ';
            $bindings[] = $normalizedSearch;
            $bindings[] = $normalizedSearch;

            $case .= 'WHEN EXISTS ('
                .'SELECT 1 FROM product_code_aliases pca_exact '
                .'WHERE pca_exact.product_id = products.id '
                .'AND pca_exact.normalized_code = ?'
                .') THEN 4 ';
            $bindings[] = $normalizedSearch;
        }

        $case .= 'WHEN products.sku LIKE ? THEN 5 '
            .'WHEN products.oem_code LIKE ? THEN 6 ';
        $bindings[] = $prefix;
        $bindings[] = $prefix;

        if ($normalizedSearch !== null) {
            $case .= 'WHEN '.$this->normalizedProductCodeSql('products.sku').' LIKE ? THEN 7 '
                .'WHEN '.$this->normalizedProductCodeSql('products.oem_code').' LIKE ? THEN 8 ';
            $bindings[] = $normalizedSearch.'%';
            $bindings[] = $normalizedSearch.'%';

            $case .= 'WHEN EXISTS ('
                .'SELECT 1 FROM product_code_aliases pca_prefix '
                .'WHERE pca_prefix.product_id = products.id '
                .'AND pca_prefix.normalized_code LIKE ?'
                .') THEN 9 ';
            $bindings[] = $normalizedSearch.'%';
        }

        $case .= 'WHEN products.sku LIKE ? THEN 10 '
            .'WHEN products.oem_code LIKE ? THEN 11 ';
        $bindings[] = $contains;
        $bindings[] = $contains;

        if ($normalizedSearch !== null) {
            $case .= 'WHEN '.$this->normalizedProductCodeSql('products.sku').' LIKE ? THEN 12 '
                .'WHEN '.$this->normalizedProductCodeSql('products.oem_code').' LIKE ? THEN 13 ';
            $bindings[] = '%'.$normalizedSearch.'%';
            $bindings[] = '%'.$normalizedSearch.'%';

            $case .= 'WHEN '.$this->normalizedProductCodeSql('products.name').' LIKE ? THEN 14 ';
            $bindings[] = '%'.$normalizedSearch.'%';
        }

        $case .= 'WHEN products.name LIKE ? THEN 15 ';
        $bindings[] = $contains;

        if ($normalizedSearch !== null) {
            $case .= 'WHEN EXISTS ('
                .'SELECT 1 FROM product_code_aliases pca_contains '
                .'WHERE pca_contains.product_id = products.id '
                .'AND pca_contains.normalized_code LIKE ?'
                .') THEN 16 ';
            $bindings[] = '%'.$normalizedSearch.'%';
        }

        $case .= 'ELSE 17 END';

        $query->orderByRaw($case, $bindings)
            ->orderBy('products.id', 'desc');

        $items = $query->limit($limit)->get();
        $cache = $this->cacheStore();
        $stockScope = $this->resolveStockVisibilityScope($request->user());

        return response()->json([
            'data' => $this->mapProducts($items, $cache, $dealerId, $request->user(), $stockScope),
            'limit' => $limit,
            'search_backend' => 'pos_quick',
        ]);
    }

    /**
     * @param  array<string, mixed>  $validated
     * @return array<string, int>|null
     */
    private function resolveDealerContext($user, array $validated): ?array
    {
        $dealerId = null;

        if ($user->dealer_id !== null) {
            $dealerId = (int) $user->dealer_id;
        }

        if ($dealerId === null && $user->hasRole('admin') && ! empty($validated['dealer_id'])) {
            $dealerId = (int) $validated['dealer_id'];
        }

        if ($dealerId === null && $user->hasRole('admin') && $user->selected_customer_id !== null) {
            $dealerId = Customer::query()
                ->whereKey((int) $user->selected_customer_id)
                ->value('dealer_id');
            $dealerId = $dealerId !== null ? (int) $dealerId : null;
        }

        if ($dealerId === null) {
            return null;
        }

        $dealer = Dealer::query()
            ->select(['id', 'price_list_id'])
            ->find($dealerId);

        if (! $dealer) {
            return null;
        }

        $priceListId = $dealer->price_list_id !== null
            ? (int) $dealer->price_list_id
            : $this->defaultPriceListId();

        if ($priceListId === null) {
            return null;
        }

        return [
            'dealer_id' => (int) $dealer->id,
            'price_list_id' => $priceListId,
        ];
    }

    /**
     * @param  Collection<int, mixed>  $items
     * @return Collection<int, array<string, mixed>>
     */
    private function mapProducts(Collection $items, CacheRepository $cache, int $dealerId, User $user, ?array $stockScope): Collection
    {
        $productIds = $items
            ->pluck('id')
            ->map(fn ($id) => (int) $id)
            ->all();

        $competitorCodesByProduct = ProductCodeAlias::query()
            ->select(['product_id', 'code', 'code_type', 'brand_name', 'source'])
            ->whereIn('product_id', $productIds)
            ->whereIn('code_type', ['competitor', 'equivalent'])
            ->orderBy('brand_name')
            ->orderBy('code')
            ->get()
            ->groupBy('product_id');

        return $items->map(function ($item) use ($cache, $dealerId, $competitorCodesByProduct, $user, $stockScope) {
            $sourceCurrency = (string) ($item->currency ?? 'TRY');
            $meta = is_array($item->meta) ? $item->meta : [];
            $availableTotal = (int) $item->available_total;
            $rawNetPrice = $this->resolveHotPrice(
                cache: $cache,
                dealerId: $dealerId,
                productId: (int) $item->id,
                fallbackPrice: $item->net_price
            );

            return [
                'id' => (int) $item->id,
                'sku' => $item->sku,
                'oem' => $item->oem_code,
                'name' => $item->name,
                'brand' => [
                    'id' => $item->brand_id !== null ? (int) $item->brand_id : null,
                    'name' => $item->brand_name,
                ],
                'net_price' => DisplayCurrency::formatPrice($rawNetPrice, $sourceCurrency, $user),
                'currency' => DisplayCurrency::normalize($sourceCurrency, $user),
                'available_total' => $this->resolveVisibleAvailableTotal($meta, $availableTotal, $stockScope),
                'stock_locations' => $this->resolveStockLocations($meta, $availableTotal, $stockScope),
                'shelf_address' => $this->resolveShelfAddress($meta),
                'competitor_codes' => ($competitorCodesByProduct->get((int) $item->id) ?? collect())
                    ->map(fn (ProductCodeAlias $alias): array => [
                        'code' => $alias->code,
                        'type' => $alias->code_type,
                        'brand_name' => $alias->brand_name,
                        'source' => $alias->source,
                    ])
                    ->values()
                    ->all(),
            ];
        })->values();
    }

    /**
     * @return array{codes:list<string>,names:list<string>}|null
     */
    private function resolveStockVisibilityScope($user): ?array
    {
        if ($user->hasAnyRole(['admin', 'moderator'])) {
            return null;
        }

        $userScope = $this->resolveUserSpecificStockVisibilityScope($user);
        if ($userScope !== null) {
            return $userScope;
        }

        $permissions = CustomerFeaturePermissions::forUser($user);
        if (! in_array('search.stock', $permissions, true)) {
            return [
                'codes' => [],
                'names' => [],
            ];
        }

        $warehouseDefinitions = CustomerFeaturePermissions::stockWarehouseDefinitions();
        $warehouseKeys = array_map(
            fn (array $definition): string => $definition['key'],
            $warehouseDefinitions
        );
        $selectedWarehouseKeys = array_values(array_intersect($permissions, $warehouseKeys));

        if ($selectedWarehouseKeys === []) {
            return null;
        }

        $selectedLookup = array_flip($selectedWarehouseKeys);
        $codes = [];
        $names = [];

        foreach ($warehouseDefinitions as $warehouse) {
            if (! isset($selectedLookup[$warehouse['key']])) {
                continue;
            }

            foreach ($warehouse['codes'] as $code) {
                $normalizedCode = $this->normalizeScopeText($code);
                if ($normalizedCode !== null) {
                    $codes[] = $normalizedCode;
                }
            }

            foreach ($warehouse['names'] as $name) {
                $normalizedName = $this->normalizeScopeText($name);
                if ($normalizedName !== null) {
                    $names[] = $normalizedName;
                }
            }
        }

        return [
            'codes' => array_values(array_unique($codes)),
            'names' => array_values(array_unique($names)),
        ];
    }

    /**
     * @return array{codes:list<string>,names:list<string>}|null
     */
    private function resolveUserSpecificStockVisibilityScope($user): ?array
    {
        $warehouseKeys = match ($this->normalizeScopeText($user->username)) {
            'ERZURUM.HIZLISATIS' => [
                'search.stock.warehouse.erzurum_point',
            ],
            'AHMET.ARAC',
            'HUSEYIN.OZGUNEY',
            'MEHMET.AKSOY' => [
                'search.stock.warehouse.erzurum_depo',
            ],
            'BATUM' => [
                'search.stock.warehouse.erzurum_depo',
                'search.stock.warehouse.batum',
            ],
            default => [],
        };

        if ($warehouseKeys === []) {
            return null;
        }

        $selectedLookup = array_flip($warehouseKeys);
        $codes = [];
        $names = [];

        foreach (CustomerFeaturePermissions::stockWarehouseDefinitions() as $warehouse) {
            if (! isset($selectedLookup[$warehouse['key']])) {
                continue;
            }

            foreach ($warehouse['codes'] as $code) {
                $normalizedCode = $this->normalizeScopeText($code);
                if ($normalizedCode !== null) {
                    $codes[] = $normalizedCode;
                }
            }

            foreach ($warehouse['names'] as $name) {
                $normalizedName = $this->normalizeScopeText($name);
                if ($normalizedName !== null) {
                    $names[] = $normalizedName;
                }
            }
        }

        return [
            'codes' => array_values(array_unique($codes)),
            'names' => array_values(array_unique($names)),
        ];
    }

    private function normalizeScopeText(mixed $value): ?string
    {
        if (! is_scalar($value)) {
            return null;
        }

        $normalized = trim((string) $value);
        if ($normalized === '') {
            return null;
        }

        return mb_strtoupper($normalized, 'UTF-8');
    }

    private function resolveVisibleAvailableTotal(array $meta, int $availableTotal, ?array $stockScope): int
    {
        if ($stockScope === null) {
            return max(0, $availableTotal);
        }

        $locations = $this->resolveStockLocations($meta, $availableTotal, $stockScope);

        return max(0, array_sum(array_map(fn (array $location): int => max(0, (int) $location['stock']), $locations)));
    }

    /**
     * @return list<array{branch:string,warehouse_code:?string,stock:int,shelf_address:?string}>
     */
    private function resolveStockLocations(array $meta, int $availableTotal, ?array $stockScope = null): array
    {
        $warehouses = data_get($meta, 'integrations.logo.payload.logo_stock.warehouses');
        $generalShelfAddress = $this->resolveShelfAddress($meta);
        $locations = [];

        if (is_array($warehouses)) {
            foreach ($warehouses as $warehouse) {
                if (! is_array($warehouse)) {
                    continue;
                }

                $stock = $this->firstIntegerValue($warehouse, [
                    'available_total',
                    'available',
                    'onhand_total',
                    'onhand',
                    'stock',
                    'quantity',
                ]);
                $warehouseCode = $this->firstArrayScalar($warehouse, [
                    'warehouse_code',
                    'branch_code',
                    'code',
                    'invenno',
                    'warehouse_no',
                ]);
                $branch = $this->firstArrayScalar($warehouse, [
                    'branch_name',
                    'warehouse_name',
                    'name',
                    'depo_adi',
                    'ambar_adi',
                    'branch',
                ]);

                if ($branch === null) {
                    $branch = $warehouseCode !== null ? "Şube {$warehouseCode}" : 'Genel';
                }

                if (! $this->stockLocationVisible($branch, $warehouseCode, $stockScope)) {
                    continue;
                }

                $locations[] = [
                    'branch' => $branch,
                    'warehouse_code' => $warehouseCode,
                    'stock' => max(0, $stock ?? 0),
                    'shelf_address' => $this->resolveWarehouseShelfAddress($meta, $warehouse, $warehouseCode) ?? $generalShelfAddress,
                ];
            }
        }

        if ($locations === [] && $stockScope === null) {
            $locations[] = [
                'branch' => 'Genel',
                'warehouse_code' => null,
                'stock' => $availableTotal,
                'shelf_address' => $generalShelfAddress,
            ];
        }

        return $locations;
    }

    private function resolveShelfAddress(array $meta): ?string
    {
        return $this->firstMetaScalar($meta, [
            'shelf_address',
            'raf_address',
            'raf_adresi',
            'raf_bilgisi',
            'shelf',
            'raf',
            'location',
            'integrations.logo.payload.shelf_address',
            'integrations.logo.payload.raf_address',
            'integrations.logo.payload.raf_adresi',
            'integrations.logo.payload.raw.RAF',
            'integrations.logo.payload.raw.RAFADRESI',
            'integrations.logo.payload.raw.RAF_ADRESI',
            'integrations.logo.payload.raw.SHELF_ADDRESS',
            'integrations.logo.payload.raw.LOCATION',
        ]);
    }

    private function resolveWarehouseShelfAddress(array $meta, array $warehouse, ?string $warehouseCode): ?string
    {
        $direct = $this->resolveShelfAddress($warehouse);
        if ($direct !== null) {
            return $direct;
        }

        $raw = data_get($meta, 'integrations.logo.payload.raw', []);
        if (! is_array($raw)) {
            return null;
        }

        $keys = array_filter([
            $warehouseCode,
            $warehouse['invenno'] ?? null,
            $warehouse['warehouse_no'] ?? null,
        ], fn ($value): bool => is_scalar($value) && trim((string) $value) !== '');

        foreach ($keys as $key) {
            $normalizedKey = trim((string) $key);
            foreach ([
                "RAF{$normalizedKey}",
                "RAF_{$normalizedKey}",
                "RAFADRESI{$normalizedKey}",
                "RAF_ADRESI_{$normalizedKey}",
                "SHELF_ADDRESS{$normalizedKey}",
                "LOCATION{$normalizedKey}",
                "LOCATION_CODE{$normalizedKey}",
            ] as $field) {
                $candidate = $raw[$field] ?? null;
                if (is_scalar($candidate) && trim((string) $candidate) !== '') {
                    return trim((string) $candidate);
                }
            }
        }

        return null;
    }

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

    private function firstMetaScalar(array $meta, array $paths): ?string
    {
        foreach ($paths as $path) {
            $value = data_get($meta, $path);
            if (is_scalar($value) && trim((string) $value) !== '') {
                return trim((string) $value);
            }
        }

        return null;
    }

    private function stockLocationVisible(string $branch, ?string $warehouseCode, ?array $stockScope): bool
    {
        if ($stockScope === null) {
            return true;
        }

        return $this->stockLocationMatchesScope($branch, $warehouseCode, $stockScope);
    }

    private function stockLocationMatchesScope(string $branch, ?string $warehouseCode, array $stockScope): bool
    {
        $codes = $stockScope['codes'] ?? [];
        $names = $stockScope['names'] ?? [];

        $normalizedCode = $warehouseCode !== null ? $this->normalizeScopeText($warehouseCode) : null;
        if ($normalizedCode !== null && in_array($normalizedCode, $codes, true)) {
            return true;
        }

        $normalizedBranch = $this->normalizeScopeText($branch);

        return $normalizedBranch !== null && in_array($normalizedBranch, $names, true);
    }

    private function resolveHotPrice(
        CacheRepository $cache,
        int $dealerId,
        int $productId,
        mixed $fallbackPrice
    ): ?string {
        if ($fallbackPrice !== null) {
            $key = "price:dealer:{$dealerId}:product:{$productId}";
            $normalized = number_format((float) $fallbackPrice, 2, '.', '');
            $cache->put($key, $normalized, now()->addMinutes(5));

            return $normalized;
        }

        $key = "price:dealer:{$dealerId}:product:{$productId}";
        $cachedPrice = $cache->get($key);

        if ($cachedPrice !== null) {
            return (string) $cachedPrice;
        }

        return null;
    }

    private function defaultPriceListId(): ?int
    {
        $priceListId = PriceList::query()
            ->where('code', 'A')
            ->value('id');

        if ($priceListId !== null) {
            return (int) $priceListId;
        }

        $first = PriceList::query()->value('id');

        return $first !== null ? (int) $first : null;
    }

    private function escapeLike(string $value): string
    {
        return addcslashes($value, '\\\\%_');
    }

    /**
     * @return list<int>
     */
    private function resolveDirectProductCodeIds(string $search, ?string $normalizedSearch, int $limit): array
    {
        $lookupValues = $this->directProductCodeLookupValues($search, $normalizedSearch);

        if ($lookupValues === []) {
            return [];
        }

        $ids = Product::query()
            ->select('products.id')
            ->where('products.is_active', true)
            ->where(function (Builder $builder) use ($lookupValues): void {
                $builder
                    ->whereIn('products.sku', $lookupValues)
                    ->orWhereIn('products.oem_code', $lookupValues);
            })
            ->limit($limit)
            ->pluck('products.id')
            ->map(fn ($id) => (int) $id)
            ->all();

        return array_values(array_unique($ids));
    }

    /**
     * @return list<string>
     */
    private function directProductCodeLookupValues(string $search, ?string $normalizedSearch): array
    {
        $values = [];
        $trimmed = trim($search);

        foreach ([$trimmed, mb_strtoupper($trimmed, 'UTF-8'), $normalizedSearch] as $value) {
            if (is_string($value) && trim($value) !== '') {
                $values[] = trim($value);
            }
        }

        if ($normalizedSearch !== null && preg_match('/^[A-Z0-9]+$/', $normalizedSearch) === 1) {
            if (preg_match('/^([A-Z]+)([0-9].*)$/', $normalizedSearch, $matches) === 1) {
                $values[] = $matches[1].' '.$matches[2];
                $values[] = $matches[1].'-'.$matches[2];
            }

            $length = strlen($normalizedSearch);
            for ($prefixLength = 2; $prefixLength <= min(4, $length - 2); $prefixLength++) {
                $prefix = substr($normalizedSearch, 0, $prefixLength);
                $suffix = substr($normalizedSearch, $prefixLength);

                if (preg_match('/[0-9]/', $suffix) !== 1) {
                    continue;
                }

                $values[] = $prefix.' '.$suffix;
                $values[] = $prefix.'-'.$suffix;
            }
        }

        return collect($values)
            ->map(fn (string $value): string => trim($value))
            ->filter(fn (string $value): bool => $value !== '')
            ->unique(fn (string $value): string => mb_strtoupper($value, 'UTF-8'))
            ->values()
            ->all();
    }

    /**
     * @return list<int>
     */
    private function resolveExactProductCodeIds(string $search, ?string $normalizedSearch, int $limit): array
    {
        $ids = Product::query()
            ->select('products.id')
            ->where('products.is_active', true)
            ->where(function (Builder $builder): void {
                $this->applyLogoProductFilter($builder);
            })
            ->where(function (Builder $builder) use ($search, $normalizedSearch): void {
                $builder
                    ->where('products.sku', $search)
                    ->orWhere('products.oem_code', $search);

                if ($normalizedSearch !== null && $normalizedSearch !== $search) {
                    $builder
                        ->orWhere('products.sku', $normalizedSearch)
                        ->orWhere('products.oem_code', $normalizedSearch);
                }
            })
            ->limit($limit)
            ->pluck('products.id')
            ->map(fn ($id) => (int) $id)
            ->all();

        if ($normalizedSearch !== null && count($ids) < $limit) {
            $aliasIds = ProductCodeAlias::query()
                ->where('normalized_code', $normalizedSearch)
                ->limit($limit - count($ids))
                ->pluck('product_id')
                ->map(fn ($id) => (int) $id)
                ->all();

            $ids = [...$ids, ...$aliasIds];
        }

        return array_values(array_unique($ids));
    }

    /**
     * @return list<string>
     */
    private function resolveExactCodeMatchGroupCodes(string $search, ?string $normalizedSearch): array
    {
        if ($normalizedSearch === null || mb_strlen($normalizedSearch, 'UTF-8') < 4) {
            return [];
        }

        $aliasProductIds = ProductCodeAlias::query()
            ->where('normalized_code', $normalizedSearch)
            ->limit(120)
            ->pluck('product_id')
            ->map(fn ($id) => (int) $id)
            ->all();

        $products = Product::query()
            ->select(['products.id', 'products.sku', 'products.oem_code', 'products.meta'])
            ->where('products.is_active', true)
            ->where(function (Builder $query): void {
                $this->applyLogoProductFilter($query);
            })
            ->where(function (Builder $query) use ($search, $normalizedSearch, $aliasProductIds): void {
                $query
                    ->where('products.sku', $search)
                    ->orWhere('products.oem_code', $search)
                    ->orWhereRaw($this->normalizedProductCodeSql('products.sku').' = ?', [$normalizedSearch])
                    ->orWhereRaw($this->normalizedProductCodeSql('products.oem_code').' = ?', [$normalizedSearch]);

                if ($aliasProductIds !== []) {
                    $query->orWhereIn('products.id', $aliasProductIds);
                }
            });

        $this->applyPointProductVisibility($products);

        return $products
            ->limit(80)
            ->get()
            ->map(fn (Product $product): ?string => $this->resolveProductGroupCode($this->productMeta($product)))
            ->filter()
            ->unique(fn (string $groupCode): string => mb_strtoupper($groupCode, 'UTF-8'))
            ->values()
            ->all();
    }

    private function shouldResolveExactCodeMatchGroups(string $search, ?string $normalizedSearch): bool
    {
        if ($normalizedSearch === null || mb_strlen($normalizedSearch, 'UTF-8') < 4) {
            return false;
        }

        $trimmed = trim($search);

        return preg_match('/^[\\pL\\pN._\\-\\/]+$/u', $trimmed) === 1
            && preg_match('/[\\pN._\\-\\/]/u', $trimmed) === 1;
    }

    /**
     * @param  list<string>  $groupCodes
     * @return list<int>
     */
    private function matchingGroupProductIds(array $groupCodes, int $limit, string $search, ?string $normalizedSearch): array
    {
        $lookupCodes = collect($groupCodes)
            ->map(fn (string $groupCode): string => trim($groupCode))
            ->filter()
            ->flatMap(fn (string $groupCode): array => [
                $groupCode,
                mb_strtoupper($groupCode, 'UTF-8'),
            ])
            ->unique()
            ->values()
            ->all();

        if ($lookupCodes === []) {
            return [];
        }

        $query = Product::query()
            ->select('products.id')
            ->where('products.is_active', true)
            ->where(function (Builder $query): void {
                $this->applyLogoProductFilter($query);
            })
            ->where(function (Builder $query) use ($lookupCodes): void {
                $query
                    ->whereIn('products.meta->category_code', $lookupCodes)
                    ->orWhereIn('products.meta->group_code', $lookupCodes)
                    ->orWhereIn('products.meta->grup_kodu', $lookupCodes)
                    ->orWhereIn('products.meta->integrations->logo->payload->category_code', $lookupCodes)
                    ->orWhereIn('products.meta->integrations->logo->payload->group_code', $lookupCodes)
                    ->orWhereIn('products.meta->integrations->logo->payload->grup_kodu', $lookupCodes)
                    ->orWhereIn('products.meta->integrations->logo->payload->raw->STGRPCODE', $lookupCodes)
                    ->orWhereIn('products.meta->integrations->logo->payload->raw->GRPCODE', $lookupCodes);
            });

        $this->applyPointProductVisibility($query);

        $priorityProductIds = $this->resolveNormalizedProductCodeIds($search, $normalizedSearch, $limit);
        $case = 'CASE '
            .'WHEN products.sku = ? THEN 0 '
            .'WHEN products.oem_code = ? THEN 1 ';
        $bindings = [$search, $search];

        if ($normalizedSearch !== null) {
            $case .= 'WHEN '.$this->normalizedProductCodeSql('products.sku').' = ? THEN 2 '
                .'WHEN '.$this->normalizedProductCodeSql('products.oem_code').' = ? THEN 3 '
                .'WHEN EXISTS ('
                .'SELECT 1 FROM product_code_aliases pca_exact '
                .'WHERE pca_exact.product_id = products.id '
                .'AND pca_exact.normalized_code = ?'
                .') THEN 4 ';
            $bindings[] = $normalizedSearch;
            $bindings[] = $normalizedSearch;
            $bindings[] = $normalizedSearch;
        }

        $case .= 'ELSE 5 END';

        $groupProductIds = $query
            ->orderByRaw($case, $bindings)
            ->orderByDesc('products.id')
            ->limit($limit)
            ->pluck('products.id')
            ->map(fn ($id) => (int) $id)
            ->all();

        return collect([...$priorityProductIds, ...$groupProductIds])
            ->unique()
            ->take($limit)
            ->values()
            ->all();
    }

    /**
     * @return list<int>
     */
    private function resolveNormalizedProductCodeIds(string $search, ?string $normalizedSearch, int $limit): array
    {
        if ($normalizedSearch === null) {
            return [];
        }

        $query = Product::query()
            ->select('products.id')
            ->where('products.is_active', true)
            ->where(function (Builder $query): void {
                $this->applyLogoProductFilter($query);
            })
            ->where(function (Builder $query) use ($search, $normalizedSearch): void {
                $query
                    ->where('products.sku', $search)
                    ->orWhere('products.oem_code', $search)
                    ->orWhereRaw($this->normalizedProductCodeSql('products.sku').' = ?', [$normalizedSearch])
                    ->orWhereRaw($this->normalizedProductCodeSql('products.oem_code').' = ?', [$normalizedSearch])
                    ->orWhereExists(function ($aliasQuery) use ($normalizedSearch): void {
                        $aliasQuery->selectRaw('1')
                            ->from('product_code_aliases as pca')
                            ->whereColumn('pca.product_id', 'products.id')
                            ->where('pca.normalized_code', $normalizedSearch);
                    });
            });

        $this->applyPointProductVisibility($query);

        return $query
            ->orderByRaw($this->productCodePrioritySql($search, $normalizedSearch), [
                $search,
                $search,
                $normalizedSearch,
                $normalizedSearch,
                $normalizedSearch,
            ])
            ->orderByDesc('products.id')
            ->limit($limit)
            ->pluck('products.id')
            ->map(fn ($id) => (int) $id)
            ->all();
    }

    private function productCodePrioritySql(string $search, ?string $normalizedSearch): string
    {
        return 'CASE '
            .'WHEN products.sku = ? THEN 0 '
            .'WHEN products.oem_code = ? THEN 1 '
            .'WHEN '.$this->normalizedProductCodeSql('products.sku').' = ? THEN 2 '
            .'WHEN '.$this->normalizedProductCodeSql('products.oem_code').' = ? THEN 3 '
            .'WHEN EXISTS ('
            .'SELECT 1 FROM product_code_aliases pca_exact '
            .'WHERE pca_exact.product_id = products.id '
            .'AND pca_exact.normalized_code = ?'
            .') THEN 4 '
            .'ELSE 5 END';
    }

    private function applyPointProductVisibility(Builder $query): void
    {
        $allowedCodes = ['E'];

        $query->where(function (Builder $visibilityQuery) use ($allowedCodes): void {
            $visibilityQuery
                ->whereIn('products.meta->specode4', $allowedCodes)
                ->orWhereIn('products.meta->integrations->logo->payload->specode4', $allowedCodes)
                ->orWhereIn('products.meta->integrations->logo->payload->raw->SPECODE4', $allowedCodes);
        });
    }

    /**
     * @return array<string, mixed>
     */
    private function productMeta(mixed $item): array
    {
        $meta = $item->meta ?? null;

        if (is_array($meta)) {
            return $meta;
        }

        if (is_string($meta) && $meta !== '') {
            $decoded = json_decode($meta, true);

            return is_array($decoded) ? $decoded : [];
        }

        return [];
    }

    private function resolveProductGroupCode(array $meta): ?string
    {
        return $this->firstMetaScalar($meta, [
            'category_code',
            'group_code',
            'grup_kodu',
            'integrations.logo.payload.category_code',
            'integrations.logo.payload.group_code',
            'integrations.logo.payload.grup_kodu',
            'integrations.logo.payload.raw.STGRPCODE',
            'integrations.logo.payload.raw.GRPCODE',
        ]);
    }

    /**
     * @param  list<int>  $productIds
     */
    private function productIdOrderSql(array $productIds): string
    {
        $case = 'CASE products.id ';

        foreach ($productIds as $index => $_productId) {
            $case .= 'WHEN ? THEN '.$index.' ';
        }

        return $case.'ELSE '.count($productIds).' END';
    }

    private function applyCodeAliasSearchConstraint(Builder $builder, ?string $normalizedSearch): void
    {
        if ($normalizedSearch === null) {
            return;
        }

        $builder->orWhereExists(function ($query) use ($normalizedSearch): void {
            $query->selectRaw('1')
                ->from('product_code_aliases as pca')
                ->whereColumn('pca.product_id', 'products.id')
                ->where(function ($aliasQuery) use ($normalizedSearch): void {
                    $aliasQuery
                        ->where('pca.normalized_code', $normalizedSearch)
                        ->orWhereLike('pca.normalized_code', $normalizedSearch.'%', caseSensitive: false)
                        ->orWhereLike('pca.normalized_code', '%'.$normalizedSearch.'%', caseSensitive: false);
                });
        });
    }

    private function applyFastProductCodeSearchConstraint(
        Builder $builder,
        string $search,
        string $prefix,
        ?string $normalizedSearch
    ): void {
        $builder->where(function (Builder $codeQuery) use ($search, $prefix, $normalizedSearch): void {
            $codeQuery
                ->where('products.sku', $search)
                ->orWhere('products.oem_code', $search)
                ->orWhereLike('products.sku', $prefix, caseSensitive: false)
                ->orWhereLike('products.oem_code', $prefix, caseSensitive: false);

            if ($normalizedSearch !== null) {
                $normalizedPrefix = $normalizedSearch.'%';

                $codeQuery
                    ->orWhere('products.sku', $normalizedSearch)
                    ->orWhere('products.oem_code', $normalizedSearch)
                    ->orWhereLike('products.sku', $normalizedPrefix, caseSensitive: false)
                    ->orWhereLike('products.oem_code', $normalizedPrefix, caseSensitive: false)
                    ->orWhereExists(function ($query) use ($normalizedSearch): void {
                        $query->selectRaw('1')
                            ->from('product_code_aliases as pca')
                            ->whereColumn('pca.product_id', 'products.id')
                            ->where(function ($aliasQuery) use ($normalizedSearch): void {
                                $aliasQuery
                                    ->where('pca.normalized_code', $normalizedSearch)
                                    ->orWhereLike('pca.normalized_code', $normalizedSearch.'%', caseSensitive: false);
                            });
                    });
            }
        });
    }

    private function applyFastProductCodeRanking(
        Builder $builder,
        string $search,
        string $prefix,
        ?string $normalizedSearch
    ): void {
        $case = 'CASE '
            .'WHEN products.sku = ? THEN 0 '
            .'WHEN products.oem_code = ? THEN 1 ';
        $bindings = [$search, $search];

        if ($normalizedSearch !== null) {
            $case .= 'WHEN EXISTS ('
                .'SELECT 1 FROM product_code_aliases pca_exact '
                .'WHERE pca_exact.product_id = products.id '
                .'AND pca_exact.normalized_code = ?'
                .') THEN 2 ';
            $bindings[] = $normalizedSearch;

            $case .= 'WHEN products.sku = ? THEN 3 '
                .'WHEN products.oem_code = ? THEN 4 ';
            $bindings[] = $normalizedSearch;
            $bindings[] = $normalizedSearch;
        }

        $case .= 'WHEN products.sku LIKE ? THEN 5 '
            .'WHEN products.oem_code LIKE ? THEN 6 ';
        $bindings[] = $prefix;
        $bindings[] = $prefix;

        if ($normalizedSearch !== null) {
            $case .= 'WHEN products.sku LIKE ? THEN 7 '
                .'WHEN products.oem_code LIKE ? THEN 8 ';
            $bindings[] = $normalizedSearch.'%';
            $bindings[] = $normalizedSearch.'%';

            $case .= 'WHEN EXISTS ('
                .'SELECT 1 FROM product_code_aliases pca_prefix '
                .'WHERE pca_prefix.product_id = products.id '
                .'AND pca_prefix.normalized_code LIKE ?'
                .') THEN 9 ';
            $bindings[] = $normalizedSearch.'%';
        }

        $case .= 'ELSE 10 END';

        $builder->orderByRaw($case, $bindings)
            ->orderBy('products.id', 'desc');
    }

    private function applyNormalizedProductCodeSearchConstraint(Builder $builder, ?string $normalizedSearch): void
    {
        if ($normalizedSearch === null) {
            return;
        }

        $builder
            ->orWhereRaw($this->normalizedProductCodeSql('products.sku').' LIKE ?', [$normalizedSearch.'%'])
            ->orWhereRaw($this->normalizedProductCodeSql('products.oem_code').' LIKE ?', [$normalizedSearch.'%'])
            ->orWhereRaw($this->normalizedProductCodeSql('products.sku').' LIKE ?', ['%'.$normalizedSearch.'%'])
            ->orWhereRaw($this->normalizedProductCodeSql('products.oem_code').' LIKE ?', ['%'.$normalizedSearch.'%'])
            ->orWhereRaw($this->normalizedProductCodeSql('products.name').' LIKE ?', [$normalizedSearch.'%'])
            ->orWhereRaw($this->normalizedProductCodeSql('products.name').' LIKE ?', ['%'.$normalizedSearch.'%']);
    }

    private function applyLogoPayloadCodeSearchConstraint(Builder $builder, string $contains): void
    {
        foreach (self::LOGO_CODE_SEARCH_PATHS as $path) {
            $builder->orWhereLike($path, $contains, caseSensitive: false);
        }
    }

    private function applyLogoPayloadCodePrefixSearchConstraint(Builder $builder, string $search, string $prefix): void
    {
        foreach (self::LOGO_CODE_SEARCH_PATHS as $path) {
            $builder
                ->orWhere($path, $search)
                ->orWhereLike($path, $prefix, caseSensitive: false);
        }
    }

    private function isLikelyProductCodeSearch(string $search): bool
    {
        return preg_match('/[0-9\\-_.\\/]/', $search) === 1;
    }

    private function normalizedProductCodeSql(string $column): string
    {
        return "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(UPPER({$column}), ' ', ''), '-', ''), '.', ''), '/', ''), '_', '')";
    }

    private function applyLogoProductFilter(Builder $query): void
    {
        $query
            ->whereNotNull('products.meta->integrations->logo->synced_at')
            ->orWhereNotNull('products.meta->integrations->logo->external_ref')
            ->orWhereNotNull('products.meta->integrations->logo->logical_ref');
    }

    private function cacheStore(): CacheRepository
    {
        return Cache::store((string) config('cache.default', 'file'));
    }
}
