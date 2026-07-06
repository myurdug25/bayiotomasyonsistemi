<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Product\SearchProductsRequest;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\OrderItem;
use App\Models\PriceList;
use App\Models\Product;
use App\Models\ProductCodeAlias;
use App\Models\User;
use App\Models\VehicleProduct;
use App\Services\Meilisearch\ProductSearchService;
use App\Services\Pricing\ProductCampaignPricing;
use App\Support\CustomerFeaturePermissions;
use App\Support\Pricing\DealerNetPriceExpression;
use App\Support\Pricing\DisplayCurrency;
use App\Support\Products\ProductCodeNormalizer;
use App\Support\Products\ProductImageDataUrl;
use Illuminate\Cache\Repository as CacheRepository;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;

class ProductSearchController extends Controller
{
    private const SEARCH_RESPONSE_CACHE_TTL_SECONDS = 120;

    private const SEARCH_RELATED_CACHE_TTL_SECONDS = 90;

    private const SEARCH_RESPONSE_CACHE_VERSION = 9;

    public function __invoke(
        SearchProductsRequest $request,
        ProductSearchService $meili
    ): JsonResponse {
        $validated = $request->validated();
        $limit = min((int) ($validated['limit'] ?? 20), 50);
        $dealerContext = $this->resolveDealerContext($request->user(), $validated);

        if ($dealerContext === null) {
            return response()->json([
                'message' => 'dealer_id is required for users without an assigned dealer.',
            ], Response::HTTP_UNPROCESSABLE_ENTITY);
        }

        $dealerId = $dealerContext['dealer_id'];
        $priceListId = $dealerContext['price_list_id'];
        $stockScope = $this->resolveStockVisibilityScope($request->user());
        $selectedCustomerId = $request->user()->selected_customer_id !== null
            ? (int) $request->user()->selected_customer_id
            : null;

        $fitmentProductIds = $this->fitmentProductIds($validated['vehicle_id'] ?? null);
        if ($fitmentProductIds !== null && $fitmentProductIds === []) {
            return response()->json([
                'data' => [],
                'next_cursor' => null,
                'prev_cursor' => null,
                'limit' => $limit,
                'total_count' => 0,
                'current_page' => (int) ($validated['page'] ?? 1),
                'total_pages' => 1,
                'search_backend' => 'db',
            ]);
        }

        $searchQuery = trim((string) ($validated['q'] ?? ''));
        $inStock = $request->boolean('in_stock');
        $includeEquivalents = $request->boolean('include_equivalents');
        $normalizedSearch = ProductCodeNormalizer::normalize($searchQuery);
        $isLikelyProductCodeSearch = $this->isLikelyProductCodeSearch($searchQuery);
        $shouldResolveExactMatchGroups = $this->shouldResolveExactCodeMatchGroups($searchQuery, $normalizedSearch);
        $exactMatchGroupCodes = [];
        $canUseMeili = $searchQuery !== ''
            && ! isset($validated['sort'])
            && ! $this->shouldUseDatabaseForPunctuationInsensitiveSearch($searchQuery);

        // For short, code-like queries, prefer Meili first to avoid the heavier DB-only search path.
        if ($canUseMeili) {
            try {
                if ($meili->shouldAttemptSearch()) {
                    $meiliExactMatchGroupCodes = ($isLikelyProductCodeSearch && $shouldResolveExactMatchGroups && $includeEquivalents)
                        ? $this->resolveExactCodeMatchGroupCodes($searchQuery, $normalizedSearch, $includeEquivalents)
                        : [];

                    return $this->searchUsingMeili(
                        validated: $validated,
                        q: $searchQuery,
                        dealerId: $dealerId,
                        selectedCustomerId: $selectedCustomerId,
                        priceListId: $priceListId,
                        stockScope: $stockScope,
                        user: $request->user(),
                        fitmentProductIds: $fitmentProductIds,
                        inStock: $inStock,
                        includeEquivalents: $includeEquivalents,
                        exactMatchGroupCodes: $meiliExactMatchGroupCodes,
                        limit: $limit,
                        meili: $meili
                    );
                }
            } catch (\Throwable $exception) {
                $meili->markSearchUnavailable($exception);
                report($exception);
            }
        }

        if ($shouldResolveExactMatchGroups) {
            $exactMatchGroupCodes = $this->resolveExactCodeMatchGroupCodes($searchQuery, $normalizedSearch, $includeEquivalents);
        }
        $databaseSearchBackend = $searchQuery === ''
            ? 'db'
            : ($isLikelyProductCodeSearch ? 'db_code_fast' : 'db_fallback');

        return $this->searchUsingDatabase(
            validated: $validated,
            dealerId: $dealerId,
            selectedCustomerId: $selectedCustomerId,
            priceListId: $priceListId,
            stockScope: $stockScope,
            user: $request->user(),
            fitmentProductIds: $fitmentProductIds,
            inStock: $inStock,
            includeEquivalents: $includeEquivalents,
            exactMatchGroupCodes: $exactMatchGroupCodes,
            limit: $limit,
            searchBackend: $databaseSearchBackend
        );
    }

    /**
     * @param  array<string, mixed>  $validated
     * @param  list<int>|null  $fitmentProductIds
     */
    private function searchUsingMeili(
        array $validated,
        string $q,
        int $dealerId,
        ?int $selectedCustomerId,
        int $priceListId,
        ?array $stockScope,
        User $user,
        ?array $fitmentProductIds,
        bool $inStock,
        bool $includeEquivalents,
        array $exactMatchGroupCodes,
        int $limit,
        ProductSearchService $meili
    ): JsonResponse {
        $cache = $this->cacheStore();
        $cacheKey = $this->buildSearchResponseCacheKey(
            validated: $validated,
            dealerId: $dealerId,
            selectedCustomerId: $selectedCustomerId,
            priceListId: $priceListId,
            stockScope: $stockScope,
            limit: $limit,
            searchBackend: 'meili'
        );
        $cachedResponse = $cache->get($cacheKey);
        if (is_array($cachedResponse)) {
            return response()->json($cachedResponse);
        }

        $offset = $this->decodeOffsetCursor($validated['cursor'] ?? null);
        if (isset($validated['page'])) {
            $offset = max(0, ((int) $validated['page'] - 1) * $limit);
        }
        $scanOffset = $offset;
        $batchSize = max(80, min(250, $limit * 4));

        $collectedIds = [];
        $seen = [];
        $estimatedTotal = 0;

        for ($iteration = 0; $iteration < 20 && count($collectedIds) < $limit; $iteration++) {
            $result = $meili->searchProductIds(
                query: $q,
                filters: [
                    'brand_id' => $validated['brand_id'] ?? null,
                    'category_id' => $validated['category_id'] ?? null,
                ],
                limit: $batchSize,
                offset: $scanOffset
            );

            $batchIds = $result['ids'];
            $estimatedTotal = max($estimatedTotal, (int) $result['estimated_total']);

            if ($batchIds === []) {
                break;
            }

            $scanOffset += count($batchIds);

            $filteredIds = $this->filterMeiliBatchIds(
                ids: $batchIds,
                validated: $validated,
                fitmentProductIds: $fitmentProductIds,
                inStock: $inStock,
                includeEquivalents: $includeEquivalents,
                exactMatchGroupCodes: $exactMatchGroupCodes
            );

            foreach ($filteredIds as $id) {
                if (isset($seen[$id])) {
                    continue;
                }

                $seen[$id] = true;
                $collectedIds[] = $id;

                if (count($collectedIds) >= $limit) {
                    break;
                }
            }

            if (count($batchIds) < $batchSize) {
                break;
            }
        }

        if ($collectedIds === []) {
            $payload = [
                'data' => [],
                'next_cursor' => $scanOffset < $estimatedTotal ? $this->encodeOffsetCursor($scanOffset) : null,
                'prev_cursor' => $offset > 0 ? $this->encodeOffsetCursor(max(0, $offset - $limit)) : null,
                'limit' => $limit,
                'total_count' => $estimatedTotal,
                'current_page' => (int) floor($offset / $limit) + 1,
                'total_pages' => max(1, (int) ceil($estimatedTotal / $limit)),
                'search_backend' => 'meili',
            ];

            $cache->put($cacheKey, $payload, now()->addSeconds(self::SEARCH_RESPONSE_CACHE_TTL_SECONDS));

            return response()->json($payload);
        }

        $query = $this->baseProductQuery($dealerId, $priceListId, preferInlineLogoFilter: true)
            ->whereIn('products.id', $collectedIds);

        $this->applyNonTextFilters(
            query: $query,
            validated: $validated,
            fitmentProductIds: $fitmentProductIds,
            inStock: $inStock,
            includeEquivalents: $includeEquivalents,
            preferInlineSpecialCodeVisibility: true
        );
        $this->applyProductGroupCodeScope($query, $exactMatchGroupCodes);

        $this->applyIdSequenceOrder($query, $collectedIds);

        $items = $query->get();
        $payload = [
            'data' => $this->mapProducts($items, $cache, $dealerId, $stockScope, $selectedCustomerId, $user),
            'next_cursor' => $scanOffset < $estimatedTotal ? $this->encodeOffsetCursor($scanOffset) : null,
            'prev_cursor' => $offset > 0 ? $this->encodeOffsetCursor(max(0, $offset - $limit)) : null,
            'limit' => $limit,
            'total_count' => $estimatedTotal,
            'current_page' => (int) floor($offset / $limit) + 1,
            'total_pages' => max(1, (int) ceil($estimatedTotal / $limit)),
            'search_backend' => 'meili',
        ];

        $cache->put($cacheKey, $payload, now()->addSeconds(self::SEARCH_RESPONSE_CACHE_TTL_SECONDS));

        return response()->json($payload);
    }

    /**
     * @param  array<string, mixed>  $validated
     * @param  list<int>|null  $fitmentProductIds
     */
    private function searchUsingDatabase(
        array $validated,
        int $dealerId,
        ?int $selectedCustomerId,
        int $priceListId,
        ?array $stockScope,
        User $user,
        ?array $fitmentProductIds,
        bool $inStock,
        bool $includeEquivalents,
        array $exactMatchGroupCodes,
        int $limit,
        string $searchBackend
    ): JsonResponse {
        $cache = $this->cacheStore();
        $cacheKey = $this->buildSearchResponseCacheKey(
            validated: $validated,
            dealerId: $dealerId,
            selectedCustomerId: $selectedCustomerId,
            priceListId: $priceListId,
            stockScope: $stockScope,
            limit: $limit,
            searchBackend: $searchBackend
        );

        $cachedResponse = $cache->get($cacheKey);
        if (is_array($cachedResponse)) {
            return response()->json($cachedResponse);
        }

        $preferInlineLogoFilter = $searchBackend === 'db_code_fast';
        $preferInlineSpecialCodeVisibility = false;
        $query = $this->baseProductQuery($dealerId, $priceListId, preferInlineLogoFilter: $preferInlineLogoFilter);

        if (! empty($validated['q'])) {
            $search = trim((string) $validated['q']);
            $normalizedSearch = ProductCodeNormalizer::normalize($search);
            $shouldSearchCodeAliases = $this->isLikelyProductCodeSearch($search);

            try {
                if ($exactMatchGroupCodes !== []) {
                    $matchingProductIds = $this->matchingGroupProductIds($exactMatchGroupCodes, $includeEquivalents, 500);
                    $preferInlineSpecialCodeVisibility = true;

                    if ($matchingProductIds === []) {
                        $query->whereRaw('1 = 0');
                    } else {
                        $query->whereIn('products.id', $matchingProductIds);
                        $this->applyIdSequenceOrder($query, $matchingProductIds);
                    }
                } elseif ($shouldSearchCodeAliases) {
                    $matchingProductIds = $this->matchingFastProductCodeProductIds($search, $normalizedSearch, 500);
                    $preferInlineSpecialCodeVisibility = true;

                    if ($matchingProductIds === []) {
                        $query->whereRaw('1 = 0');
                    } else {
                        $query->whereIn('products.id', $matchingProductIds);
                        $this->applyIdSequenceOrder($query, $matchingProductIds);
                    }
                } elseif ($this->canUseProductFullTextSearch($search)) {
                    $booleanSearch = $this->toBooleanFullTextSearch($search);
                    $matchingProductIds = $this->matchingFullTextProductIds($search, $booleanSearch, 500);
                    $preferInlineSpecialCodeVisibility = true;

                    if ($matchingProductIds === []) {
                        $query->whereRaw('1 = 0');
                    } else {
                        $query->whereIn('products.id', $matchingProductIds);
                        $this->applyIdSequenceOrder($query, $matchingProductIds);
                    }
                } else {
                    $this->applyLooseProductTextSearchConstraint($query, $search);

                    $this->applyTextSearchRanking($query, $search, $normalizedSearch, false);
                }
            } catch (\Throwable $exception) {
                report($exception);

                $preferInlineSpecialCodeVisibility = false;
                $query = $this->baseProductQuery($dealerId, $priceListId, preferInlineLogoFilter: $preferInlineLogoFilter);
                $this->applyLooseProductTextSearchConstraint($query, $search);
            }

            if ($exactMatchGroupCodes !== [] || $shouldSearchCodeAliases) {
                $this->applyTextSearchRanking($query, $search, $normalizedSearch, $shouldSearchCodeAliases);
            }
        }

        $this->applyNonTextFilters(
            query: $query,
            validated: $validated,
            fitmentProductIds: $fitmentProductIds,
            inStock: $inStock,
            includeEquivalents: $includeEquivalents,
            preferInlineSpecialCodeVisibility: $preferInlineSpecialCodeVisibility
        );

        $this->applySort($query, $validated['sort'] ?? null);

        if (isset($validated['page'])) {
            $page = max(1, (int) $validated['page']);
            $total = (clone $query)->toBase()->getCountForPagination();
            $items = $query->forPage($page, $limit)->get();

            $payload = [
                'data' => $this->mapProducts($items, $cache, $dealerId, $stockScope, $selectedCustomerId, $user),
                'next_cursor' => $page * $limit < $total ? $this->encodeOffsetCursor($page * $limit) : null,
                'prev_cursor' => $page > 1 ? $this->encodeOffsetCursor(max(0, ($page - 2) * $limit)) : null,
                'limit' => $limit,
                'total_count' => $total,
                'current_page' => $page,
                'total_pages' => max(1, (int) ceil($total / $limit)),
                'search_backend' => $searchBackend,
            ];

            $cache->put($cacheKey, $payload, now()->addSeconds(self::SEARCH_RESPONSE_CACHE_TTL_SECONDS));

            return response()->json($payload);
        }

        $cursor = $searchBackend === 'db_fallback' ? null : ($validated['cursor'] ?? null);

        $paginator = $query->cursorPaginate(
            perPage: $limit,
            columns: ['*'],
            cursorName: 'cursor',
            cursor: $cursor
        );

        $payload = [
            'data' => $this->mapProducts(collect($paginator->items()), $cache, $dealerId, $stockScope, $selectedCustomerId, $user),
            'next_cursor' => $paginator->nextCursor()?->encode(),
            'prev_cursor' => $paginator->previousCursor()?->encode(),
            'limit' => $limit,
            'total_count' => null,
            'search_backend' => $searchBackend,
        ];

        $cache->put($cacheKey, $payload, now()->addSeconds(self::SEARCH_RESPONSE_CACHE_TTL_SECONDS));

        return response()->json($payload);
    }

    private function buildSearchResponseCacheKey(
        array $validated,
        int $dealerId,
        ?int $selectedCustomerId,
        int $priceListId,
        ?array $stockScope,
        int $limit,
        string $searchBackend
    ): string {
        $cachePayload = [
            'q' => trim((string) ($validated['q'] ?? '')),
            'brand_id' => isset($validated['brand_id']) ? (int) $validated['brand_id'] : null,
            'category_id' => isset($validated['category_id']) ? (int) $validated['category_id'] : null,
            'kod1' => isset($validated['kod1']) ? (string) $validated['kod1'] : null,
            'kod2' => isset($validated['kod2']) ? (string) $validated['kod2'] : null,
            'kod3' => isset($validated['kod3']) ? (string) $validated['kod3'] : null,
            'specode4' => isset($validated['specode4']) ? (string) $validated['specode4'] : null,
            'specode5' => isset($validated['specode5']) ? (string) $validated['specode5'] : null,
            'stok_turu' => isset($validated['stok_turu']) ? (string) $validated['stok_turu'] : null,
            'vehicle_id' => isset($validated['vehicle_id']) ? (int) $validated['vehicle_id'] : null,
            'dealer_id' => isset($validated['dealer_id']) ? (int) $validated['dealer_id'] : null,
            'in_stock' => (bool) ($validated['in_stock'] ?? false),
            'include_equivalents' => (bool) ($validated['include_equivalents'] ?? false),
            'sort' => $validated['sort'] ?? null,
            'cursor' => $validated['cursor'] ?? null,
            'page' => isset($validated['page']) ? (int) $validated['page'] : null,
            'limit' => $limit,
            'dealer_id_effective' => $dealerId,
            'price_list_id' => $priceListId,
            'selected_customer_id' => $selectedCustomerId,
            'stock_scope' => $this->normalizeStockScopeForCache($stockScope),
            'backend' => $searchBackend,
            'v' => self::SEARCH_RESPONSE_CACHE_VERSION,
        ];

        $fingerprint = json_encode($cachePayload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '';

        return 'products:search-response:v'.self::SEARCH_RESPONSE_CACHE_VERSION.':'.md5($fingerprint);
    }

    /**
     * @return array<string, mixed>
     */
    private function normalizeStockScopeForCache(?array $stockScope): array
    {
        if ($stockScope === null) {
            return [];
        }

        $scope = $stockScope;

        if (isset($scope['codes']) && is_array($scope['codes'])) {
            $scope['codes'] = array_values(array_unique(array_map('strval', $scope['codes'])));
            sort($scope['codes'], SORT_STRING);
        }

        if (isset($scope['names']) && is_array($scope['names'])) {
            $scope['names'] = array_values(array_unique(array_map('strval', $scope['names'])));
            sort($scope['names'], SORT_STRING);
        }

        return $scope;
    }

    private function baseProductQuery(int $dealerId, int $priceListId, bool $preferInlineLogoFilter = false): Builder
    {
        $netPriceSql = DealerNetPriceExpression::sql();

        return Product::query()
            ->select([
                'products.id',
                'products.sku',
                'products.oem_code',
                'products.description',
                'products.name',
                'products.vat_rate',
                'products.brand_id',
                'brands.name as brand_name',
                'products.category_id',
                'categories.name as category_name',
                'products.updated_at',
                'products.meta->kod1 as meta_kod1',
                'products.meta->kod2 as meta_kod2',
                'products.meta->kod3 as meta_kod3',
                'products.meta->stok_turu as meta_stok_turu',
            ])
            ->selectRaw($this->productSearchMetaSelectSql().' as meta')
            ->selectRaw($this->productHasEmbeddedImageSql().' as has_embedded_image')
            ->selectRaw("{$netPriceSql} as net_price")
            ->selectRaw('bp.list_price as list_price')
            ->selectRaw("COALESCE(dpo.currency, bp.currency, 'TRY') as currency")
            ->selectRaw('COALESCE(ss.available_total, 0) as available_total')
            ->leftJoin('brands', 'brands.id', '=', 'products.brand_id')
            ->leftJoin('categories', 'categories.id', '=', 'products.category_id')
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
            ->where(function (Builder $query) use ($preferInlineLogoFilter): void {
                $this->applyLogoProductFilter($query, preferInline: $preferInlineLogoFilter);
            });
    }

    /**
     * @param  array<string, mixed>  $validated
     * @param  list<int>|null  $fitmentProductIds
     */
    private function applyNonTextFilters(
        Builder $query,
        array $validated,
        ?array $fitmentProductIds,
        bool $inStock,
        bool $includeEquivalents,
        bool $preferInlineSpecialCodeVisibility = false
    ): void {
        if (! empty($validated['brand_id'])) {
            $query->where('products.brand_id', (int) $validated['brand_id']);
        }

        if (! empty($validated['category_id'])) {
            $query->where('products.category_id', (int) $validated['category_id']);
        }

        if (! empty($validated['kod1'])) {
            $this->applyMetaValueFilter($query, 'kod1', trim((string) $validated['kod1']));
        }

        if (! empty($validated['kod2'])) {
            $this->applyMetaValueFilter($query, 'kod2', trim((string) $validated['kod2']));
        }

        if (! empty($validated['kod3'])) {
            $this->applyMetaValueFilter($query, 'kod3', trim((string) $validated['kod3']));
        }

        if (! empty($validated['specode4'])) {
            $this->applyMetaValueFilter($query, 'specode4', trim((string) $validated['specode4']));
        }

        if (! empty($validated['specode5'])) {
            $this->applyMetaValueFilter($query, 'specode5', trim((string) $validated['specode5']));
        }

        if (! empty($validated['stok_turu'])) {
            $this->applyMetaValueFilter($query, 'stok_turu', trim((string) $validated['stok_turu']));
        }

        if ($fitmentProductIds !== null) {
            $query->whereIn('products.id', $fitmentProductIds);
        }

        if ($inStock) {
            $query->where('ss.available_total', '>', 0);
        }

        if (empty($validated['specode4'])) {
            $this->applyProductSpecialCodeVisibility($query, $includeEquivalents, preferInline: $preferInlineSpecialCodeVisibility);
        }
    }

    /**
     * @return list<string>
     */
    private function resolveExactCodeMatchGroupCodes(
        string $search,
        ?string $normalizedSearch,
        bool $includeEquivalents
    ): array {
        if ($normalizedSearch === null || mb_strlen($normalizedSearch, 'UTF-8') < 4) {
            return [];
        }

        $cacheKey = 'products:exact-code-groups:v1:'.md5(mb_strtolower($search, 'UTF-8').':'.$normalizedSearch.':'.($includeEquivalents ? '1' : '0'));

        return $this->cacheStore()->remember($cacheKey, now()->addMinutes(10), function () use ($search, $normalizedSearch, $includeEquivalents): array {
            $aliasProductIds = $this->matchingExactCodeAliasProductIds($normalizedSearch, 120);

            $products = Product::query()
                ->select(['products.id', 'products.sku', 'products.oem_code', 'products.meta'])
                ->where('products.is_active', true)
                ->where(function (Builder $query): void {
                    $this->applyLogoProductFilter($query, preferInline: true);
                })
                ->where(function (Builder $query) use ($search, $normalizedSearch, $aliasProductIds): void {
                    $query
                        ->where('products.sku', $search)
                        ->orWhere('products.oem_code', $search);

                    if ($normalizedSearch !== null) {
                        $query
                            ->orWhereRaw($this->normalizedProductCodeSql('products.sku').' = ?', [$normalizedSearch])
                            ->orWhereRaw($this->normalizedProductCodeSql('products.oem_code').' = ?', [$normalizedSearch]);
                    }

                    if ($aliasProductIds !== []) {
                        $query->orWhereIn('products.id', $aliasProductIds);
                    }
                });

            $this->applyProductSpecialCodeVisibility($products, $includeEquivalents, preferInline: true);

            return $products
                ->limit(80)
                ->get()
                ->map(fn (Product $product): ?string => $this->resolveProductGroupCode($this->productMeta($product)))
                ->filter()
                ->unique(fn (string $groupCode): string => mb_strtoupper($groupCode, 'UTF-8'))
                ->values()
                ->all();
        });
    }

    private function shouldResolveExactCodeMatchGroups(string $search, ?string $normalizedSearch): bool
    {
        if ($normalizedSearch === null || mb_strlen($normalizedSearch, 'UTF-8') < 4) {
            return false;
        }

        // Only exact-looking stock/OEM codes need the group scan; product names and brands do not.
        $trimmed = trim($search);

        return preg_match('/^[\\pL\\pN._\\-\\/\\s]+$/u', $trimmed) === 1
            && preg_match('/[\\pN._\\-\\/]/u', $trimmed) === 1;
    }

    /**
     * @param  list<string>  $groupCodes
     */
    private function applyProductGroupCodeScope(Builder $query, array $groupCodes): void
    {
        if ($groupCodes === []) {
            return;
        }

        $query->where(function (Builder $groupQuery) use ($groupCodes): void {
            $groupQuery
                ->whereIn('products.meta->category_code', $groupCodes)
                ->orWhereIn('products.meta->integrations->logo->payload->category_code', $groupCodes)
                ->orWhereIn('products.meta->integrations->logo->payload->raw->STGRPCODE', $groupCodes)
                ->orWhereIn('products.meta->integrations->logo->payload->raw->GRPCODE', $groupCodes);
        });
    }

    /**
     * @param  list<string>  $groupCodes
     * @return list<int>
     */
    private function matchingGroupProductIds(array $groupCodes, bool $includeEquivalents, int $limit): array
    {
        if ($groupCodes === []) {
            return [];
        }

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

        $cacheKey = 'products:group-product-ids:v2:'.md5(json_encode($lookupCodes).':'.$limit.':'.($includeEquivalents ? '1' : '0'));

        return $this->cacheStore()->remember(
            $cacheKey,
            now()->addMinutes(10),
            function () use ($lookupCodes, $includeEquivalents, $limit): array {
                $query = Product::query()
                    ->select('products.id')
                    ->where('products.is_active', true)
                    ->where(function (Builder $query): void {
                        $this->applyLogoProductFilter($query, preferInline: true);
                    })
                    ->where(function (Builder $query) use ($lookupCodes): void {
                        $query
                            ->whereIn('products.meta->category_code', $lookupCodes)
                            ->orWhereIn('products.meta->integrations->logo->payload->category_code', $lookupCodes)
                            ->orWhereIn('products.meta->integrations->logo->payload->raw->STGRPCODE', $lookupCodes)
                            ->orWhereIn('products.meta->integrations->logo->payload->raw->GRPCODE', $lookupCodes);
                    });

                $this->applyProductSpecialCodeVisibility($query, $includeEquivalents, preferInline: true);

                return $query
                    ->orderByDesc('products.id')
                    ->limit($limit)
                    ->pluck('products.id')
                    ->map(fn ($id): int => (int) $id)
                    ->all();
            }
        );
    }

    private function applySort(Builder $query, ?string $sort): void
    {
        $netPriceSql = DealerNetPriceExpression::sql();

        if ($sort === 'price_asc') {
            $query->orderByRaw("{$netPriceSql} IS NULL ASC")
                ->orderByRaw("{$netPriceSql} ASC")
                ->orderBy('products.id', 'asc');

            return;
        }

        if ($sort === 'price_desc') {
            $query->orderByRaw("{$netPriceSql} IS NULL ASC")
                ->orderByRaw("{$netPriceSql} DESC")
                ->orderBy('products.id', 'desc');

            return;
        }

        if ($sort === 'stock_desc') {
            $query->orderBy('ss.available_total', 'desc')->orderBy('products.id', 'desc');

            return;
        }

        $query->orderBy('products.id', 'desc');
    }

    private function applyTextSearchRanking(
        Builder $query,
        string $search,
        ?string $normalizedSearch,
        bool $includeCodeAliasRanking
    ): void {
        $escapedSearch = $this->escapeLike($search);
        $prefix = $escapedSearch.'%';
        $contains = '%'.$escapedSearch.'%';

        $case = 'CASE '
            .'WHEN products.sku = ? THEN 0 '
            .'WHEN products.oem_code = ? THEN 1 ';
        $bindings = [$search, $search];

        $canRankCodeAliases = $includeCodeAliasRanking
            && $normalizedSearch !== null
            && mb_strlen($normalizedSearch, 'UTF-8') >= 4;

        if ($canRankCodeAliases) {
            $case .= 'WHEN EXISTS ('
                .'SELECT 1 FROM product_code_aliases pca_exact '
                .'WHERE pca_exact.product_id = products.id '
                .'AND pca_exact.normalized_code = ?'
                .') THEN 2 ';
            $bindings[] = $normalizedSearch;
        }

        $case .= 'WHEN products.sku LIKE ? THEN 3 '
            .'WHEN products.oem_code LIKE ? THEN 4 ';
        $bindings[] = $prefix;
        $bindings[] = $prefix;

        if ($canRankCodeAliases) {
            $case .= 'WHEN EXISTS ('
                .'SELECT 1 FROM product_code_aliases pca_prefix '
                .'WHERE pca_prefix.product_id = products.id '
                .'AND pca_prefix.normalized_code LIKE ?'
                .') THEN 5 ';
            $bindings[] = $normalizedSearch.'%';
        }

        $case .= 'WHEN brands.name LIKE ? THEN 6 '
            .'WHEN products.name LIKE ? THEN 7 ';
        $bindings[] = $contains;
        $bindings[] = $contains;

        $compactSearch = $this->compactProductSearchToken($search);
        if (mb_strlen($compactSearch, 'UTF-8') >= 2) {
            $compactContains = '%'.$this->escapeLike($compactSearch).'%';
            $case .= 'WHEN '.$this->normalizedProductCodeSql('brands.name').' LIKE ? THEN 8 '
                .'WHEN '.$this->normalizedProductCodeSql('products.name').' LIKE ? THEN 8 ';
            $bindings[] = $compactContains;
            $bindings[] = $compactContains;
        }

        $case .= 'ELSE 9 END';

        $query->orderByRaw($case, $bindings);
    }

    private function applyLooseProductTextSearchConstraint(Builder $builder, string $search): void
    {
        $escapedSearch = $this->escapeLike($search);
        $contains = '%'.$escapedSearch.'%';

        $builder->where(function (Builder $searchQuery) use ($search, $contains): void {
            $searchQuery
                ->whereLike('products.name', $contains, caseSensitive: false)
                ->orWhereLike('products.oem_code', $contains, caseSensitive: false)
                ->orWhereLike('products.sku', $contains, caseSensitive: false)
                ->orWhereLike('brands.name', $contains, caseSensitive: false);

            $this->applyKeywordProductTextSearchOr($searchQuery, $search);
        });
    }

    private function applyKeywordProductTextSearchOr(Builder $builder, string $search): void
    {
        $tokens = $this->productSearchKeywordTokens($search);
        if ($tokens === []) {
            return;
        }

        $builder->orWhere(function (Builder $keywordQuery) use ($tokens): void {
            foreach ($tokens as $token) {
                $keywordQuery->where(function (Builder $tokenQuery) use ($token): void {
                    $rawContains = '%'.$this->escapeLike($token['raw']).'%';
                    $compactContains = '%'.$this->escapeLike($token['compact']).'%';

                    $tokenQuery
                        ->whereLike('products.name', $rawContains, caseSensitive: false)
                        ->orWhereLike('products.oem_code', $rawContains, caseSensitive: false)
                        ->orWhereLike('products.sku', $rawContains, caseSensitive: false)
                        ->orWhereLike('brands.name', $rawContains, caseSensitive: false);

                    if (mb_strlen($token['compact'], 'UTF-8') >= 2) {
                        $tokenQuery
                            ->orWhereRaw($this->normalizedProductCodeSql('products.name').' LIKE ?', [$compactContains])
                            ->orWhereRaw($this->normalizedProductCodeSql('products.oem_code').' LIKE ?', [$compactContains])
                            ->orWhereRaw($this->normalizedProductCodeSql('products.sku').' LIKE ?', [$compactContains])
                            ->orWhereRaw($this->normalizedProductCodeSql('brands.name').' LIKE ?', [$compactContains]);
                    }
                });
            }
        });
    }

    private function canUseProductFullTextSearch(string $search): bool
    {
        if (mb_strlen(trim($search), 'UTF-8') < 4 || $this->toBooleanFullTextSearch($search) === '') {
            return false;
        }

        if (DB::connection()->getDriverName() !== 'mysql') {
            return false;
        }

        return (bool) $this->cacheStore()->remember(
            'products:search-fulltext-index:available:v1',
            now()->addMinutes(10),
            function (): bool {
                return DB::table('information_schema.statistics')
                    ->where('table_schema', DB::getDatabaseName())
                    ->where('table_name', 'products')
                    ->where('index_name', 'products_search_fulltext')
                    ->exists();
            }
        );
    }

    private function toBooleanFullTextSearch(string $search): string
    {
        $tokens = preg_split('/[^\pL\pN]+/u', mb_strtolower($search, 'UTF-8')) ?: [];

        return collect($tokens)
            ->map(fn (string $token): string => trim($token))
            ->filter(fn (string $token): bool => mb_strlen($token, 'UTF-8') >= 2)
            ->map(function (string $token): string {
                $clean = preg_replace('/[+\-><()~*"@]+/', '', $token) ?? '';

                return $clean !== '' ? '+'.$clean.'*' : '';
            })
            ->filter()
            ->take(8)
            ->implode(' ');
    }

    /**
     * @return list<int>
     */
    private function matchingFullTextProductIds(string $search, string $booleanSearch, int $limit): array
    {
        if ($booleanSearch === '' || DB::connection()->getDriverName() !== 'mysql') {
            return [];
        }

        $cacheKey = 'products:fulltext-prefetch:v1:'.md5(mb_strtolower($search, 'UTF-8').':'.$booleanSearch.':'.$limit);

        return $this->cacheStore()->remember(
            $cacheKey,
            now()->addMinutes(10),
            function () use ($search, $booleanSearch, $limit): array {
                $escapedSearch = $this->escapeLike($search);
                $contains = '%'.$escapedSearch.'%';

                return Product::query()
                    ->select('products.id')
                    ->selectRaw('MATCH(products.sku, products.oem_code, products.name) AGAINST (? IN BOOLEAN MODE) as search_score', [$booleanSearch])
                    ->leftJoin('brands', 'brands.id', '=', 'products.brand_id')
                    ->where('products.is_active', true)
                    ->where(function (Builder $builder) use ($booleanSearch, $contains): void {
                        $builder
                            ->whereRaw('MATCH(products.sku, products.oem_code, products.name) AGAINST (? IN BOOLEAN MODE)', [$booleanSearch])
                            ->orWhereLike('brands.name', $contains, caseSensitive: false);
                    })
                    ->orderByDesc('search_score')
                    ->orderByDesc('products.id')
                    ->limit($limit)
                    ->pluck('products.id')
                    ->map(fn ($id): int => (int) $id)
                    ->all();
            }
        );
    }

    /**
     * @param  list<int>  $ids
     */
    private function filterMeiliBatchIds(
        array $ids,
        array $validated,
        ?array $fitmentProductIds,
        bool $inStock,
        bool $includeEquivalents,
        array $exactMatchGroupCodes
    ): array {
        if ($ids === []) {
            return [];
        }

        $query = Product::query()
            ->select('products.id')
            ->whereIn('products.id', $ids)
            ->where('products.is_active', true)
            ->where(function (Builder $query): void {
                $this->applyLogoProductFilter($query, preferInline: true);
            });

        if (! empty($validated['brand_id'])) {
            $query->where('products.brand_id', (int) $validated['brand_id']);
        }

        if (! empty($validated['category_id'])) {
            $query->where('products.category_id', (int) $validated['category_id']);
        }

        if (! empty($validated['kod1'])) {
            $this->applyMetaValueFilter($query, 'kod1', trim((string) $validated['kod1']));
        }

        if (! empty($validated['kod2'])) {
            $this->applyMetaValueFilter($query, 'kod2', trim((string) $validated['kod2']));
        }

        if (! empty($validated['kod3'])) {
            $this->applyMetaValueFilter($query, 'kod3', trim((string) $validated['kod3']));
        }

        if (! empty($validated['specode4'])) {
            $this->applyMetaValueFilter($query, 'specode4', trim((string) $validated['specode4']));
        }

        if (! empty($validated['specode5'])) {
            $this->applyMetaValueFilter($query, 'specode5', trim((string) $validated['specode5']));
        }

        if (! empty($validated['stok_turu'])) {
            $this->applyMetaValueFilter($query, 'stok_turu', trim((string) $validated['stok_turu']));
        }

        if ($fitmentProductIds !== null) {
            $query->whereIn('products.id', $fitmentProductIds);
        }

        if ($inStock) {
            $query->leftJoin('stock_summary as ss', 'ss.product_id', '=', 'products.id')
                ->where('ss.available_total', '>', 0);
        }

        if (empty($validated['specode4'])) {
            $this->applyProductSpecialCodeVisibility($query, $includeEquivalents, preferInline: true);
        }
        $this->applyProductGroupCodeScope($query, $exactMatchGroupCodes);

        $allowed = $query->pluck('products.id')
            ->map(fn ($id) => (int) $id)
            ->all();

        $allowedMap = array_flip($allowed);

        $ordered = [];
        foreach ($ids as $id) {
            $intId = (int) $id;
            if (isset($allowedMap[$intId])) {
                $ordered[] = $intId;
            }
        }

        return $ordered;
    }

    /**
     * @param  Collection<int, mixed>  $items
     * @return Collection<int, array<string, mixed>>
     */
    private function mapProducts(
        Collection $items,
        CacheRepository $cache,
        int $dealerId,
        ?array $stockScope,
        ?int $selectedCustomerId,
        User $user
    ): Collection {
        $productIds = $items
            ->pluck('id')
            ->map(fn ($id) => (int) $id)
            ->all();

        $competitorCodesByProduct = $this->competitorCodesByProduct($productIds, $cache);
        $openCartQuantityByProduct = $this->openCartQuantityByProduct($productIds, $dealerId, $cache);
        $previousPurchasesByProduct = $this->previousPurchasesByProduct($productIds, $selectedCustomerId, $cache);
        $vehicleFitmentsByProduct = $this->vehicleFitmentsByProduct($productIds, $cache);
        $specialDiscountRate = $this->customerSpecialDiscountRate($selectedCustomerId);
        $campaignsByProduct = app(ProductCampaignPricing::class)->forProducts($productIds, $user, $selectedCustomerId);

        return $items->map(function ($item) use ($cache, $dealerId, $stockScope, $competitorCodesByProduct, $openCartQuantityByProduct, $previousPurchasesByProduct, $vehicleFitmentsByProduct, $specialDiscountRate, $campaignsByProduct, $user) {
            $meta = $this->productMeta($item);
            $sourceCurrency = (string) ($item->currency ?? 'TRY');
            $rawNetPrice = $this->resolveHotPrice(
                cache: $cache,
                dealerId: $dealerId,
                productId: (int) $item->id,
                fallbackPrice: $item->net_price
            );
            $rawListPrice = $item->list_price !== null ? number_format((float) $item->list_price, 2, '.', '') : $rawNetPrice;
            $rawSpecialDiscountedPrice = $this->applySpecialDiscount($rawNetPrice, $specialDiscountRate);
            $imageUrl = $this->productImageUrl($item, $meta);
            $imageDataUrl = ProductImageDataUrl::fromMeta($meta);

            return [
                'id' => (int) $item->id,
                'sku' => $item->sku,
                'oem' => $item->oem_code,
                'name' => $this->resolveProductDisplayName($item, $meta),
                'description' => $this->resolveProductDescription($item, $meta),
                'type_name' => $this->resolveProductTypeName($item, $meta),
                'image_url' => $imageUrl,
                'image_data_url' => $imageDataUrl !== null && $imageDataUrl !== $imageUrl ? $imageDataUrl : null,
                'logo_synced_at' => data_get($meta, 'integrations.logo.synced_at'),
                'brand' => [
                    'id' => $item->brand_id !== null ? (int) $item->brand_id : null,
                    'name' => $this->resolveProductBrandName($item, $meta),
                ],
                'category' => [
                    'id' => $item->category_id !== null ? (int) $item->category_id : null,
                    'name' => $item->category_name,
                ],
                'meta' => [
                    'kod1' => $this->resolveProductMetaValue($meta, 'kod1'),
                    'kod2' => $this->resolveProductMetaValue($meta, 'kod2'),
                    'kod3' => $this->resolveProductMetaValue($meta, 'kod3'),
                    'specode4' => $this->resolveProductMetaValue($meta, 'specode4'),
                    'specode5' => $this->resolveProductMetaValue($meta, 'specode5'),
                    'stok_turu' => $this->resolveProductMetaValue($meta, 'stok_turu'),
                ],
                'net_price' => DisplayCurrency::formatPrice($rawNetPrice, $sourceCurrency, $user),
                'list_price' => DisplayCurrency::formatPrice($rawListPrice, $sourceCurrency, $user),
                'currency' => DisplayCurrency::normalize($sourceCurrency, $user),
                'special_discount_rate' => $specialDiscountRate !== null ? number_format($specialDiscountRate, 2, '.', '') : null,
                'special_discounted_price' => DisplayCurrency::formatPrice($rawSpecialDiscountedPrice, $sourceCurrency, $user),
                'campaigns' => $campaignsByProduct->get((int) $item->id, []),
                'vat_rate' => $item->vat_rate !== null ? number_format((float) $item->vat_rate, 2, '.', '') : null,
                'available_total' => $this->resolveVisibleAvailableTotal($meta, (int) $item->available_total, $stockScope),
                'open_cart_quantity' => (int) ($openCartQuantityByProduct->get((int) $item->id) ?? 0),
                'package_quantity' => $this->resolvePackageQuantity($meta),
                'stock_locations' => $this->resolveStockLocations($meta, (int) $item->available_total, $stockScope),
                'shelf_address' => $this->resolveShelfAddress($meta),
                'previous_purchase' => $previousPurchasesByProduct->get((int) $item->id),
                'vehicle_fitments' => $vehicleFitmentsByProduct->get((int) $item->id, collect())->values()->all(),
                'competitor_codes' => ($competitorCodesByProduct->get((int) $item->id) ?? collect())
                    ->map(fn (mixed $alias): array => [
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

    private function customerSpecialDiscountRate(?int $selectedCustomerId): ?float
    {
        if ($selectedCustomerId === null) {
            return null;
        }

        $customer = Customer::query()
            ->select(['id', 'meta'])
            ->find($selectedCustomerId);

        if (! $customer instanceof Customer) {
            return null;
        }

        $rate = data_get($customer->meta, 'special_discount_rate');

        if (! is_numeric($rate)) {
            return null;
        }

        $normalizedRate = max(0.0, min(100.0, (float) $rate));

        return $normalizedRate > 0 ? $normalizedRate : null;
    }

    private function applySpecialDiscount(?string $netPrice, ?float $specialDiscountRate): ?string
    {
        if ($netPrice === null || $specialDiscountRate === null) {
            return null;
        }

        return number_format((float) $netPrice * (1 - ($specialDiscountRate / 100)), 2, '.', '');
    }

    /**
     * @param  list<int>  $productIds
     * @return Collection<int, int>
     */
    private function openCartQuantityByProduct(
        array $productIds,
        int $dealerId,
        ?CacheRepository $cache = null
    ): Collection {
        if ($productIds === []) {
            return collect();
        }

        $cacheStore = $cache ?? $this->cacheStore();
        $cacheKey = $this->productsListCacheKey('open-cart', $productIds, (string) $dealerId);

        return $cacheStore->remember($cacheKey, now()->addSeconds(self::SEARCH_RELATED_CACHE_TTL_SECONDS), function () use ($productIds, $dealerId): Collection {
            return DB::table('cart_items')
                ->join('carts', 'carts.id', '=', 'cart_items.cart_id')
                ->select('cart_items.product_id')
                ->selectRaw('COALESCE(SUM(cart_items.quantity), 0) as open_cart_quantity')
                ->where('carts.status', 'draft')
                ->where('carts.dealer_id', $dealerId)
                ->whereIn('cart_items.product_id', $productIds)
                ->groupBy('cart_items.product_id')
                ->pluck('open_cart_quantity', 'cart_items.product_id')
                ->map(fn (mixed $quantity): int => (int) $quantity);
        });
    }

    /**
     * @param  list<int>  $productIds
     * @return Collection<int, Collection<int, mixed>>
     */
    private function competitorCodesByProduct(array $productIds, ?CacheRepository $cache = null): Collection
    {
        if ($productIds === []) {
            return collect();
        }

        $perProductLimit = 24;
        $cacheStore = $cache ?? $this->cacheStore();
        $cacheKey = $this->productsListCacheKey('competitor-codes', $productIds);

        return $cacheStore->remember($cacheKey, now()->addSeconds(self::SEARCH_RELATED_CACHE_TTL_SECONDS), function () use ($productIds, $perProductLimit): Collection {
            return ProductCodeAlias::query()
                ->select(['product_id', 'code', 'code_type', 'brand_name', 'source'])
                ->whereIn('product_id', $productIds)
                ->whereIn('code_type', ['competitor', 'equivalent'])
                ->orderBy('product_id')
                ->orderBy('brand_name')
                ->orderBy('code')
                ->get()
                ->groupBy(fn (ProductCodeAlias $alias): int => (int) $alias->product_id)
                ->map(fn (Collection $aliases): Collection => $aliases->take($perProductLimit)->values());
        });
    }

    /**
     * @param  list<int>  $productIds
     * @return Collection<int, array<string, mixed>>
     */
    private function previousPurchasesByProduct(array $productIds, ?int $selectedCustomerId, ?CacheRepository $cache = null): Collection
    {
        if ($selectedCustomerId === null || $productIds === []) {
            return collect();
        }

        $cacheStore = $cache ?? $this->cacheStore();
        $cacheKey = $this->productsListCacheKey('previous-purchases', $productIds, (string) $selectedCustomerId);

        return $cacheStore->remember($cacheKey, now()->addSeconds(self::SEARCH_RELATED_CACHE_TTL_SECONDS), function () use ($productIds, $selectedCustomerId): Collection {
            return OrderItem::query()
                ->select([
                    'order_items.product_id',
                    'order_items.order_id',
                    'order_items.quantity',
                    'order_items.unit_net_price',
                    'order_items.discount_rate',
                    'order_items.tax_rate',
                    'order_items.line_total',
                    'order_items.currency',
                    'orders.order_no as previous_order_no',
                    'orders.status as previous_order_status',
                    'orders.ordered_at as previous_ordered_at',
                ])
                ->join('orders', 'orders.id', '=', 'order_items.order_id')
                ->leftJoin('ledger_entries as previous_invoice_entries', function ($join) {
                    $join->on('previous_invoice_entries.order_id', '=', 'orders.id')
                        ->where('previous_invoice_entries.type', '=', 'invoice');
                })
                ->selectRaw('COALESCE(previous_invoice_entries.reference_no, orders.order_no) as previous_invoice_no')
                ->where('orders.customer_id', $selectedCustomerId)
                ->whereIn('order_items.product_id', $productIds)
                ->whereNotIn('orders.status', ['draft', 'cancelled', 'canceled'])
                ->orderByDesc('orders.ordered_at')
                ->orderByDesc('order_items.created_at')
                ->get()
                ->unique('product_id')
                ->mapWithKeys(fn (OrderItem $item): array => [
                    (int) $item->product_id => [
                        'order_id' => (int) $item->order_id,
                        'order_no' => $item->previous_order_no,
                        'invoice_no' => $item->previous_invoice_no,
                        'status' => $item->previous_order_status,
                        'quantity' => (int) $item->quantity,
                        'unit_net_price' => $item->unit_net_price !== null ? number_format((float) $item->unit_net_price, 2, '.', '') : null,
                        'discount_rate' => $item->discount_rate !== null ? number_format((float) $item->discount_rate, 2, '.', '') : null,
                        'tax_rate' => $item->tax_rate !== null ? number_format((float) $item->tax_rate, 2, '.', '') : null,
                        'line_total' => $item->line_total !== null ? number_format((float) $item->line_total, 2, '.', '') : null,
                        'currency' => $item->currency,
                        'ordered_at' => $item->previous_ordered_at !== null ? substr((string) $item->previous_ordered_at, 0, 10) : null,
                    ],
                ]);
        });
    }

    /**
     * @param  list<int>  $productIds
     * @return Collection<int, Collection<int, array<string, mixed>>>
     */
    private function vehicleFitmentsByProduct(array $productIds, ?CacheRepository $cache = null): Collection
    {
        if ($productIds === []) {
            return collect();
        }

        $cacheStore = $cache ?? $this->cacheStore();
        $cacheKey = $this->productsListCacheKey('vehicle-fitments', $productIds);

        return $cacheStore->remember($cacheKey, now()->addSeconds(self::SEARCH_RELATED_CACHE_TTL_SECONDS), function () use ($productIds): Collection {
            return VehicleProduct::query()
                ->with(['vehicle:id,make,model,trim,engine,fuel_type,year_from,year_to'])
                ->whereIn('product_id', $productIds)
                ->orderBy('product_id')
                ->orderBy('position')
                ->limit(count($productIds) * 12)
                ->get()
                ->map(function (VehicleProduct $fitment): array {
                    $vehicle = $fitment->vehicle;

                    return [
                        'product_id' => (int) $fitment->product_id,
                        'vehicle_id' => $fitment->vehicle_id !== null ? (int) $fitment->vehicle_id : null,
                        'make' => $vehicle?->make,
                        'model' => $vehicle?->model,
                        'trim' => $vehicle?->trim,
                        'engine' => $vehicle?->engine,
                        'fuel_type' => $vehicle?->fuel_type,
                        'year_from' => $vehicle?->year_from !== null ? (int) $vehicle->year_from : null,
                        'year_to' => $vehicle?->year_to !== null ? (int) $vehicle->year_to : null,
                        'position' => $fitment->position,
                        'fitment_note' => $fitment->fitment_note,
                    ];
                })
                ->groupBy(fn (array $fitment): int => (int) ($fitment['product_id'] ?? 0));
        });
    }

    /**
     * @return list<string>
     */
    private function productsListCacheKey(string $namespace, array $productIds, string ...$parts): string
    {
        $sortedIds = $productIds;
        sort($sortedIds, SORT_NUMERIC);
        $hashedIds = md5(json_encode(array_values(array_unique(array_map('intval', $sortedIds)))));

        if ($parts === []) {
            return "products:search-extra:{$namespace}:{$hashedIds}";
        }

        return "products:search-extra:{$namespace}:{$hashedIds}:".md5(implode('|', $parts));
    }

    private function productImageUrl(mixed $item, array $meta): ?string
    {
        $imageUrl = ProductImageDataUrl::urlFromMeta($meta);
        if ($imageUrl !== null) {
            return $imageUrl;
        }

        $hasEmbeddedImage = (int) ($item->has_embedded_image ?? 0) === 1;

        if (! $hasEmbeddedImage && ProductImageDataUrl::imageFromMeta($meta) === null) {
            return null;
        }

        $version = $item->updated_at?->getTimestamp() ?? time();

        return '/api/products/'.(int) $item->id.'/image?w=192&v='.$version;
    }

    private function productSearchMetaSelectSql(): string
    {
        if (DB::connection()->getDriverName() !== 'mysql') {
            return 'products.meta';
        }

        $paths = $this->logoImagePayloadPaths();
        $quotedPaths = array_map(static fn (string $path): string => "'{$path}'", $paths);

        return 'JSON_REMOVE(products.meta, '.implode(', ', $quotedPaths).')';
    }

    private function productHasEmbeddedImageSql(): string
    {
        if (DB::connection()->getDriverName() !== 'mysql') {
            return '0';
        }

        return "JSON_CONTAINS_PATH(products.meta, 'one', ".implode(', ', array_map(
            static fn (string $path): string => "'{$path}'",
            $this->logoImagePayloadPaths()
        )).')';
    }

    /**
     * @return list<string>
     */
    private function logoImagePayloadPaths(): array
    {
        return [
            '$.integrations.logo.payload.raw.IMAGE',
            '$.integrations.logo.payload.raw.IMAGE1',
            '$.integrations.logo.payload.raw.IMAGE2',
            '$.integrations.logo.payload.raw.IMAGE3',
            '$.integrations.logo.payload.raw.IMAGE4',
            '$.integrations.logo.payload.raw.IMAGE5',
            '$.integrations.logo.payload.raw.IMAGE_1',
            '$.integrations.logo.payload.raw.IMAGE_2',
            '$.integrations.logo.payload.raw.IMAGE_3',
            '$.integrations.logo.payload.raw.PICTURE',
            '$.integrations.logo.payload.raw.PICTURE1',
            '$.integrations.logo.payload.raw.PICTURE2',
            '$.integrations.logo.payload.raw.PICTURE_1',
            '$.integrations.logo.payload.raw.PICTURE_2',
            '$.integrations.logo.payload.raw.PHOTO',
            '$.integrations.logo.payload.raw.PHOTO1',
            '$.integrations.logo.payload.raw.PHOTO2',
            '$.integrations.logo.payload.raw.PHOTO_1',
            '$.integrations.logo.payload.raw.PHOTO_2',
            '$.integrations.logo.payload.raw.RESIM',
            '$.integrations.logo.payload.raw.RESIM1',
            '$.integrations.logo.payload.raw.RESIM2',
            '$.integrations.logo.payload.raw.RESIM_1',
            '$.integrations.logo.payload.raw.RESIM_2',
            '$.integrations.logo.payload.raw.RESIM_BLOB',
            '$.integrations.logo.payload.raw.RESIM_DOSYASI',
            '$.integrations.logo.payload.raw.RESIMDOSYASI',
            '$.integrations.logo.payload.raw.RESIMYOLU',
            '$.integrations.logo.payload.raw.RESIM_YOLU',
            '$.integrations.logo.payload.raw.LDATA',
            '$.integrations.logo.payload.raw.DATA',
            '$.integrations.logo.payload.raw.BLOB',
            '$.integrations.logo.payload.raw.DOC_DATA',
            '$.integrations.logo.payload.raw.DOCUMENTDATA',
        ];
    }

    /**
     * @param  list<int>  $ids
     */
    private function applyIdSequenceOrder(Builder $query, array $ids): void
    {
        $case = 'CASE products.id ';
        foreach ($ids as $position => $id) {
            $case .= 'WHEN '.(int) $id.' THEN '.(int) $position.' ';
        }

        $case .= 'ELSE '.count($ids).' END';
        $query->orderByRaw($case);
    }

    private function applyLogoProductFilter(Builder $query, bool $preferInline = false): void
    {
        if (! $preferInline && $this->allActiveProductsHaveLogoMarker()) {
            return;
        }

        $this->applyInlineLogoProductFilter($query);
    }

    private function applyInlineLogoProductFilter(Builder $query): void
    {
        $query->where(function (Builder $logoQuery): void {
            $logoQuery
                ->whereNotNull('products.meta->integrations->logo->synced_at')
                ->orWhereNotNull('products.meta->integrations->logo->external_ref')
                ->orWhereNotNull('products.meta->integrations->logo->logical_ref');
        });
    }

    private function applyProductSpecialCodeVisibility(Builder $query, bool $includeEquivalents, bool $preferInline = false): void
    {
        if ($preferInline) {
            $this->applyInlineProductSpecialCodeVisibility($query, $includeEquivalents);

            return;
        }

        $productIds = $this->cachedSpecialCodeVisibilityProductIds($includeEquivalents);

        if ($productIds === []) {
            $query->whereRaw('1 = 0');

            return;
        }

        $query->whereIn('products.id', $productIds);
    }

    private function applyInlineProductSpecialCodeVisibility(Builder $query, bool $includeEquivalents): void
    {
        $paths = $this->metaValuePaths('specode4');
        if ($paths === []) {
            $query->whereRaw('1 = 0');

            return;
        }

        $allowedCodes = $includeEquivalents ? ['E', 'H'] : ['E'];

        $query->where(function (Builder $specialCodeQuery) use ($paths, $allowedCodes): void {
            foreach ($paths as $path) {
                $placeholders = implode(',', array_fill(0, count($allowedCodes), '?'));
                $specialCodeQuery->orWhereRaw(
                    $this->normalizedJsonValueSql('products.meta', $path).' in ('.$placeholders.')',
                    $allowedCodes
                );
            }
        });
    }

    private function allActiveProductsHaveLogoMarker(): bool
    {
        return (bool) $this->cacheStore()->remember(
            'products:all-active-logo-marked:v1',
            now()->addMinutes(10),
            function (): bool {
                $activeCount = Product::query()
                    ->where('products.is_active', true)
                    ->count();

                if ($activeCount === 0) {
                    return false;
                }

                $logoCount = Product::query()
                    ->where('products.is_active', true)
                    ->where(function (Builder $query): void {
                        $query
                            ->whereNotNull('products.meta->integrations->logo->synced_at')
                            ->orWhereNotNull('products.meta->integrations->logo->external_ref')
                            ->orWhereNotNull('products.meta->integrations->logo->logical_ref');
                    })
                    ->count();

                return $activeCount === $logoCount;
            }
        );
    }

    /**
     * @return list<int>
     */
    private function cachedSpecialCodeVisibilityProductIds(bool $includeEquivalents): array
    {
        $allowedCodes = $includeEquivalents ? ['E', 'H'] : ['E'];
        $cacheKey = 'products:special-code-visibility:v1:'.($includeEquivalents ? 'equivalents' : 'default');

        return $this->cacheStore()->remember(
            $cacheKey,
            now()->addMinutes(30),
            function () use ($allowedCodes): array {
                $paths = $this->metaValuePaths('specode4');

                return Product::query()
                    ->select('products.id')
                    ->where('products.is_active', true)
                    ->whereNotNull('products.meta')
                    ->where(function (Builder $query): void {
                        $this->applyLogoProductFilter($query);
                    })
                    ->where(function (Builder $query) use ($paths, $allowedCodes): void {
                        foreach ($paths as $path) {
                            $placeholders = implode(',', array_fill(0, count($allowedCodes), '?'));
                            $query->orWhereRaw(
                                $this->normalizedJsonValueSql('products.meta', $path).' in ('.$placeholders.')',
                                $allowedCodes
                            );
                        }
                    })
                    ->pluck('products.id')
                    ->map(fn ($id): int => (int) $id)
                    ->all();
            }
        );
    }

    private function applyMetaValueFilter(Builder $query, string $key, string $value): void
    {
        if (in_array($key, ['kod2', 'kod3'], true)) {
            $productIds = $this->cachedMetaFilterProductIds($key, $value);

            if ($productIds === []) {
                $query->whereRaw('1 = 0');

                return;
            }

            $query->whereIn('products.id', $productIds);

            return;
        }

        $paths = $this->metaValuePaths($key);
        if ($paths === []) {
            return;
        }

        $query->where(function (Builder $metaQuery) use ($key, $paths, $value): void {
            $normalizedValue = mb_strtoupper(trim($value), 'UTF-8');

            foreach ($paths as $path) {
                $metaQuery
                    ->orWhere($this->metaValueSqlPath($path), $value)
                    ->orWhereRaw(
                        $this->normalizedJsonValueSql('products.meta', $path).' = ?',
                        [$normalizedValue]
                    );

                if ($key === 'specode5') {
                    $metaQuery->orWhereRaw(
                        $this->normalizedJsonValueSql('products.meta', $path).' LIKE ?',
                        ['%'.$normalizedValue.'%']
                    );
                }
            }

            if ($key === 'specode5') {
                $metaQuery->orWhereHas(
                    'brand',
                    fn (Builder $brandQuery) => $brandQuery
                        ->whereRaw('UPPER(TRIM(name)) = ?', [$normalizedValue])
                        ->orWhereRaw('UPPER(TRIM(name)) LIKE ?', ['%'.$normalizedValue.'%'])
                );
            }
        });
    }

    /**
     * @return list<int>
     */
    private function cachedMetaFilterProductIds(string $key, string $value): array
    {
        $index = $this->cachedMetaFilterIndex($key);
        $normalizedValue = $this->normalizeMetaFilterValue($value);

        return $index[$normalizedValue] ?? [];
    }

    /**
     * @return array<string, list<int>>
     */
    private function cachedMetaFilterIndex(string $key): array
    {
        if (! in_array($key, ['kod2', 'kod3'], true)) {
            return [];
        }

        return $this->cacheStore()->remember(
            "products:meta-filter-index:v1:{$key}",
            now()->addMinutes(10),
            function () use ($key): array {
                $paths = $this->metaValuePaths($key);
                if ($paths === []) {
                    return [];
                }

                $index = [];

                Product::query()
                    ->select(['products.id', 'products.meta'])
                    ->where('products.is_active', true)
                    ->whereNotNull('products.meta')
                    ->where(function (Builder $query): void {
                        $this->applyLogoProductFilter($query);
                    })
                    ->chunkById(1000, function (Collection $products) use (&$index, $paths): void {
                        foreach ($products as $product) {
                            $meta = $this->productMeta($product);
                            $value = $this->firstMetaScalar($meta, $paths);
                            if ($value === null) {
                                continue;
                            }

                            $normalizedValue = $this->normalizeMetaFilterValue($value);
                            if ($normalizedValue === '') {
                                continue;
                            }

                            $index[$normalizedValue][] = (int) $product->id;
                        }
                    }, 'products.id', 'id');

                return $index;
            }
        );
    }

    private function normalizeMetaFilterValue(string $value): string
    {
        return mb_strtoupper(trim($value), 'UTF-8');
    }

    /**
     * @param  array<string, mixed>  $validated
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

        if ($dealerId === null && $user->hasRole('admin')) {
            $dealerId = Dealer::query()
                ->where('is_active', true)
                ->orderBy('id')
                ->value('id');
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

        $scopes = [];
        $customer = null;
        if (! $user->hasAnyRole(['dealer_admin', 'warehouse']) && $user->selected_customer_id !== null) {
            $customer = Customer::query()
                ->select(['id', 'branch_code', 'branch_name'])
                ->find((int) $user->selected_customer_id);
        }

        if (! $user->hasAnyRole(['dealer_admin', 'warehouse'])) {
            $branchScopeValues = array_filter([
                $customer?->branch_code,
                $user->branch_code,
                $customer?->branch_name,
                $user->branch_name,
            ]);
            $codes = array_values(array_filter([
                $this->normalizeScopeText($customer?->branch_code),
                $this->normalizeScopeText($user->branch_code),
            ]));
            $warehouseAliases = $this->warehouseAliasesForBranchScope($branchScopeValues);
            $codes = array_values(array_unique(array_merge($codes, $warehouseAliases['codes'])));
            $branchCodesAsNames = array_values(array_filter(
                $codes,
                fn (string $code): bool => ! is_numeric($code)
            ));
            $names = array_values(array_filter([
                $this->normalizeScopeText($customer?->branch_name),
                $this->normalizeScopeText($user->branch_name),
                ...$branchCodesAsNames,
                ...$warehouseAliases['names'],
            ]));

            if ($codes !== [] || $names !== []) {
                $scopes[] = [
                    'codes' => array_values(array_unique($codes)),
                    'names' => array_values(array_unique($names)),
                ];
            }
        }

        $featureScope = $this->resolveFeatureStockVisibilityScope($user);
        if ($featureScope !== null) {
            $scopes[] = $featureScope;
        }

        if ($scopes === []) {
            return null;
        }

        if (count($scopes) === 1) {
            return $scopes[0];
        }

        return ['sets' => $scopes];
    }

    /**
     * @return array{codes:list<string>,names:list<string>}|null
     */
    private function resolveFeatureStockVisibilityScope($user): ?array
    {
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
    private function resolveUserSpecificStockVisibilityScope(User $user): ?array
    {
        $warehouseKeys = match ($this->normalizeScopeText($user->username)) {
            'ERZURUM.HIZLISATIS' => [
                'search.stock.warehouse.erzurum_point',
                'search.stock.warehouse.erzurum_depo',
            ],
            'AHMET.ARAC',
            'HUSEYIN.OZGUNEY',
            'MEHMET.AKSOY' => [
                'search.stock.warehouse.erzurum_depo',
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

    /**
     * @param  array<int, mixed>  $branchScopeValues
     * @return array{codes:list<string>,names:list<string>}
     */
    private function warehouseAliasesForBranchScope(array $branchScopeValues): array
    {
        $branchWarehouseKeys = [
            'ERZURUM' => [
                'search.stock.warehouse.erzurum_depo',
                'search.stock.warehouse.erzurum_point',
            ],
            'TRABZON' => ['search.stock.warehouse.trabzon'],
            'SAMSUN' => ['search.stock.warehouse.samsun'],
            'BATUM' => ['search.stock.warehouse.batum'],
        ];
        $matchedWarehouseKeys = [];

        foreach ($branchScopeValues as $value) {
            $normalized = $this->normalizeScopeText($value);
            if ($normalized === null) {
                continue;
            }

            $matchText = $this->normalizeScopeMatchText($normalized);
            foreach ($branchWarehouseKeys as $branchKey => $warehouseKeys) {
                if ($this->scopeTextContainsToken($matchText, $branchKey)) {
                    foreach ($warehouseKeys as $warehouseKey) {
                        $matchedWarehouseKeys[$warehouseKey] = true;
                    }
                }
            }
        }

        if ($matchedWarehouseKeys === []) {
            return ['codes' => [], 'names' => []];
        }

        $codes = [];
        $names = [];
        foreach (CustomerFeaturePermissions::stockWarehouseDefinitions() as $warehouse) {
            if (! isset($matchedWarehouseKeys[$warehouse['key']])) {
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

    /**
     * @return list<int>|null
     */
    private function fitmentProductIds(?int $vehicleId): ?array
    {
        if ($vehicleId === null) {
            return null;
        }

        return $this->cacheStore()->remember(
            "fitment:{$vehicleId}",
            now()->addMinutes(10),
            fn () => VehicleProduct::query()
                ->where('vehicle_id', $vehicleId)
                ->orderBy('product_id')
                ->pluck('product_id')
                ->map(fn ($id) => (int) $id)
                ->all()
        );
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
            try {
                $cache->put($key, $normalized, now()->addMinutes(5));
            } catch (\Throwable) {
                // Search results must remain available when the optional price cache is unavailable.
            }

            return $normalized;
        }

        $key = "price:dealer:{$dealerId}:product:{$productId}";
        try {
            $cachedPrice = $cache->get($key);
        } catch (\Throwable) {
            return null;
        }

        if ($cachedPrice !== null) {
            return (string) $cachedPrice;
        }

        return null;
    }

    private function normalizeMetaValue(mixed $value): ?string
    {
        if (! is_scalar($value)) {
            return null;
        }

        $normalized = trim((string) $value);

        return $normalized === '' ? null : $normalized;
    }

    private function resolveProductBrandName(mixed $item, array $meta): ?string
    {
        return $this->firstMetaScalar($meta, [
            'specode5',
            'integrations.logo.payload.specode5',
            'integrations.logo.payload.raw.SPECODE5',
        ])
            ?? $this->normalizeMetaValue($item->brand_name ?? null)
            ?? $this->firstMetaScalar($meta, [
                'brand_name',
                'brand_code',
                'integrations.logo.payload.brand_name',
                'integrations.logo.payload.brand_code',
                'integrations.logo.payload.raw.BRANDNAME',
                'integrations.logo.payload.raw.MARKNAME',
                'integrations.logo.payload.raw.MARKA',
                'integrations.logo.payload.raw.MARK',
                'integrations.logo.payload.raw.MARKCODE',
            ]);
    }

    private function resolveProductMetaValue(array $meta, string $key): ?string
    {
        return $this->firstMetaScalar($meta, $this->metaValuePaths($key));
    }

    private function resolveProductDisplayName(mixed $item, array $meta): string
    {
        return $this->firstMetaScalar($meta, [
            'integrations.logo.payload.logo_name2',
            'integrations.logo.payload.name2',
            'integrations.logo.payload.description2',
            'integrations.logo.payload.raw.NAME3',
            'integrations.logo.payload.raw.NAME_3',
            'integrations.logo.payload.raw.DEFINITION3',
            'integrations.logo.payload.raw.DEFINITION3_',
            'integrations.logo.payload.raw.DEFINITION_3',
            'integrations.logo.payload.raw.DEFINITION_3_',
            'integrations.logo.payload.raw.DESCRIPTION3',
            'integrations.logo.payload.raw.DESCRIPTION_3',
            'integrations.logo.payload.raw.DESC3',
            'integrations.logo.payload.raw.NAME2',
            'integrations.logo.payload.raw.NAME_2',
            'integrations.logo.payload.raw.DEFINITION2',
            'integrations.logo.payload.raw.DEFINITION2_',
            'integrations.logo.payload.raw.DEFINITION_2',
            'integrations.logo.payload.raw.DEFINITION_2_',
            'integrations.logo.payload.raw.DESCRIPTION2',
            'integrations.logo.payload.raw.DESCRIPTION_2',
            'integrations.logo.payload.raw.DESC2',
        ])
            ?? $this->normalizeMetaValue($item->name ?? null)
            ?? (string) $item->sku;
    }

    private function resolveProductDescription(mixed $item, array $meta): ?string
    {
        return $this->normalizeMetaValue($item->description)
            ?? $this->firstMetaScalar($meta, [
                'description',
                'integrations.logo.payload.description',
                'integrations.logo.payload.description1',
                'integrations.logo.payload.description2',
                'integrations.logo.payload.description3',
                'integrations.logo.payload.raw.DESCRIPTION',
                'integrations.logo.payload.raw.DESCRIPTION1',
                'integrations.logo.payload.raw.DESCRIPTION_1',
                'integrations.logo.payload.raw.DESCRIPTION2',
                'integrations.logo.payload.raw.DESCRIPTION_2',
                'integrations.logo.payload.raw.DESCRIPTION3',
                'integrations.logo.payload.raw.DESCRIPTION_3',
                'integrations.logo.payload.raw.DEFINITION',
                'integrations.logo.payload.raw.DEFINITION1',
                'integrations.logo.payload.raw.DEFINITION1_',
                'integrations.logo.payload.raw.DEFINITION_1',
                'integrations.logo.payload.raw.DEFINITION_1_',
                'integrations.logo.payload.raw.DEFINITION2',
                'integrations.logo.payload.raw.DEFINITION_2',
                'integrations.logo.payload.raw.DEFINITION_2_',
                'integrations.logo.payload.raw.DEFINITION3',
                'integrations.logo.payload.raw.DEFINITION_3',
                'integrations.logo.payload.raw.DEFINITION_3_',
                'integrations.logo.payload.raw.DESC',
                'integrations.logo.payload.raw.DESC1',
                'integrations.logo.payload.raw.DESC2',
                'integrations.logo.payload.raw.DESC3',
                'integrations.logo.payload.raw.DEFINITION',
            ]);
    }

    private function resolveProductTypeName(mixed $item, array $meta): ?string
    {
        return $this->firstMetaScalar($meta, [
            'integrations.logo.payload.logo_name',
            'integrations.logo.payload.name',
            'integrations.logo.payload.description',
            'integrations.logo.payload.description1',
            'integrations.logo.payload.raw.NAME',
            'integrations.logo.payload.raw.NAME1',
            'integrations.logo.payload.raw.NAME_1',
            'integrations.logo.payload.raw.DEFINITION',
            'integrations.logo.payload.raw.DEFINITION1',
            'integrations.logo.payload.raw.DEFINITION1_',
            'integrations.logo.payload.raw.DEFINITION_1',
            'integrations.logo.payload.raw.DEFINITION_1_',
            'integrations.logo.payload.raw.DESCRIPTION',
            'integrations.logo.payload.raw.DESCRIPTION1',
            'integrations.logo.payload.raw.DESCRIPTION_1',
            'integrations.logo.payload.raw.DESC',
            'integrations.logo.payload.raw.DESC1',
        ]);
    }

    /**
     * @return list<string>
     */
    private function metaValuePaths(string $key): array
    {
        return match ($key) {
            'kod1' => [
                'kod1',
                'specode',
                'integrations.logo.payload.kod1',
                'integrations.logo.payload.specode',
                'integrations.logo.payload.raw.KOD1',
                'integrations.logo.payload.raw.SPECODE',
            ],
            'kod2' => [
                'kod2',
                'specode2',
                'integrations.logo.payload.kod2',
                'integrations.logo.payload.specode2',
                'integrations.logo.payload.raw.KOD2',
                'integrations.logo.payload.raw.SPECODE2',
            ],
            'kod3' => [
                'kod3',
                'specode3',
                'integrations.logo.payload.kod3',
                'integrations.logo.payload.specode3',
                'integrations.logo.payload.raw.KOD3',
                'integrations.logo.payload.raw.SPECODE3',
            ],
            'specode4' => [
                'specode4',
                'integrations.logo.payload.specode4',
                'integrations.logo.payload.raw.SPECODE4',
            ],
            'specode5' => [
                'specode5',
                'brand_name',
                'brand_code',
                'integrations.logo.payload.specode5',
                'integrations.logo.payload.brand_name',
                'integrations.logo.payload.brand_code',
                'integrations.logo.payload.raw.SPECODE5',
                'integrations.logo.payload.raw.BRANDNAME',
                'integrations.logo.payload.raw.MARKNAME',
                'integrations.logo.payload.raw.MARKA',
                'integrations.logo.payload.raw.MARK',
                'integrations.logo.payload.raw.MARKCODE',
            ],
            'stok_turu' => [
                'stok_turu',
                'integrations.logo.payload.stok_turu',
                'integrations.logo.payload.raw.STOK_TURU',
                'integrations.logo.payload.raw.STOKTURU',
                'integrations.logo.payload.raw.CARDTYPE',
            ],
            default => [],
        };
    }

    /**
     * @return list<string>
     */
    private function metaValueSqlPath(string $path): string
    {
        return 'products.meta->'.str_replace('.', '->', $path);
    }

    private function quoteJsonPath(string $path): string
    {
        return "'$.".str_replace("'", "\\'", $path)."'";
    }

    private function normalizedJsonValueSql(string $column, string $path): string
    {
        $driver = DB::connection()->getDriverName();

        if ($driver === 'pgsql') {
            $pgPath = str_replace('.', ',', $path);
            $expression = sprintf("%s#>>'{%s}'", $column, $pgPath);
        } else {
            $expression = sprintf('JSON_EXTRACT(%s, %s)', $column, $this->quoteJsonPath($path));

            if ($driver !== 'sqlite') {
                $expression = sprintf('JSON_UNQUOTE(%s)', $expression);
            }
        }

        return sprintf('UPPER(TRIM(%s))', $expression);
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

    private function resolvePackageQuantity(array $meta): ?string
    {
        $direct = $this->firstMetaScalar($meta, [
            'package_quantity',
            'koli_adeti',
            'koli_adet',
            'koli_adedi',
            'koli_ici',
            'koli_ici_adet',
            'koli_ici_miktar',
            'koli',
            'box_quantity',
            'box_qty',
            'units_per_box',
            'pack_quantity',
            'pack_qty',
            'integrations.logo.payload.package_quantity',
            'integrations.logo.payload.koli_adeti',
            'integrations.logo.payload.koli_adet',
            'integrations.logo.payload.koli_adedi',
            'integrations.logo.payload.koli_ici',
            'integrations.logo.payload.koli_ici_adet',
            'integrations.logo.payload.koli_ici_miktar',
            'integrations.logo.payload.box_quantity',
            'integrations.logo.payload.box_qty',
            'integrations.logo.payload.units_per_box',
            'integrations.logo.payload.pack_quantity',
            'integrations.logo.payload.pack_qty',
            'integrations.logo.payload.raw.PACKAGE_QUANTITY',
            'integrations.logo.payload.raw.PACKAGE_QTY',
            'integrations.logo.payload.raw.KOLI_ADETI',
            'integrations.logo.payload.raw.KOLI',
            'integrations.logo.payload.raw.KOLI_ADET',
            'integrations.logo.payload.raw.KOLI_ADEDI',
            'integrations.logo.payload.raw.KOLI_ICI',
            'integrations.logo.payload.raw.KOLIICI',
            'integrations.logo.payload.raw.KOLI_ICI_ADET',
            'integrations.logo.payload.raw.KOLIICIADET',
            'integrations.logo.payload.raw.KOLI_ICI_MIKTAR',
            'integrations.logo.payload.raw.KOLIICIMIKTAR',
            'integrations.logo.payload.raw.KUTU_ADETI',
            'integrations.logo.payload.raw.KUTU_ICI',
            'integrations.logo.payload.raw.BOX_QUANTITY',
            'integrations.logo.payload.raw.BOX_QTY',
            'integrations.logo.payload.raw.UNITS_PER_BOX',
            'integrations.logo.payload.raw.PACK',
            'integrations.logo.payload.raw.PACK_QTY',
        ]);

        if ($direct !== null) {
            return $this->formatPackageQuantityValue($direct);
        }

        $raw = data_get($meta, 'integrations.logo.payload.raw', []);
        if (is_array($raw)) {
            foreach ($raw as $key => $value) {
                if (! is_scalar($key) || ! is_scalar($value)) {
                    continue;
                }

                $normalizedKey = mb_strtoupper((string) $key, 'UTF-8');
                $looksLikePackageField =
                    (str_contains($normalizedKey, 'KOLI') || str_contains($normalizedKey, 'KOLİ') || str_contains($normalizedKey, 'KUTU') || str_contains($normalizedKey, 'BOX') || str_contains($normalizedKey, 'PACK'))
                    && (str_contains($normalizedKey, 'ADET') || str_contains($normalizedKey, 'QTY') || str_contains($normalizedKey, 'QUANTITY') || str_contains($normalizedKey, 'ICI') || str_contains($normalizedKey, 'İÇİ'));

                if (! $looksLikePackageField) {
                    continue;
                }

                $formatted = $this->formatPackageQuantityValue($value);
                if ($formatted !== null) {
                    return $formatted;
                }
            }
        }

        $units = data_get($meta, 'integrations.logo.payload.logo_units.units');
        if (! is_array($units)) {
            return null;
        }

        foreach ($units as $unit) {
            if (! is_array($unit)) {
                continue;
            }

            $label = mb_strtoupper((string) (($unit['code'] ?? '').' '.($unit['name'] ?? '').' '.($unit['unitset_code'] ?? '').' '.($unit['unitset_name'] ?? '')), 'UTF-8');
            if (! $this->isPackageUnitLabel($label)) {
                continue;
            }

            $convFact1 = $this->numericMetaValue($unit['convfact1'] ?? null);
            $convFact2 = $this->numericMetaValue($unit['convfact2'] ?? null);
            if ($convFact2 > 0) {
                $quantity = $convFact1 > 0 ? $convFact2 / $convFact1 : $convFact2;

                return $this->formatPackageQuantityValue($quantity);
            }

            if ($convFact1 > 1) {
                return $this->formatPackageQuantityValue($convFact1);
            }
        }

        return null;
    }

    private function isPackageUnitLabel(string $label): bool
    {
        foreach (['KOLI', 'KOLİ', 'COLI', 'COLİ', 'KUTU', 'BOX', 'PACK', 'PAKET', 'CARTON', 'PK'] as $token) {
            if (preg_match('/(^|[^A-ZÇĞİÖŞÜ0-9])'.preg_quote($token, '/').'([^A-ZÇĞİÖŞÜ0-9]|$)/u', $label) === 1) {
                return true;
            }
        }

        return false;
    }

    private function numericMetaValue(mixed $value): float
    {
        if (is_int($value) || is_float($value)) {
            return (float) $value;
        }

        if (is_string($value)) {
            $normalized = str_replace(',', '.', trim($value));
            if (is_numeric($normalized)) {
                return (float) $normalized;
            }
        }

        return 0.0;
    }

    private function formatPackageQuantityValue(mixed $value): ?string
    {
        $numeric = $this->numericMetaValue($value);
        if ($numeric <= 0) {
            return null;
        }

        return rtrim(rtrim(number_format($numeric, 3, '.', ''), '0'), '.');
    }

    /**
     * @return list<array{branch:string, stock:int, shelf_address:?string}>
     */
    private function resolveVisibleAvailableTotal(array $meta, int $availableTotal, ?array $stockScope): int
    {
        if ($stockScope === null) {
            return max(0, $availableTotal);
        }

        $locations = $this->resolveStockLocations($meta, $availableTotal, $stockScope);

        return max(0, array_sum(array_map(fn (array $location): int => max(0, (int) $location['stock']), $locations)));
    }

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
            $warehouse['shelf_key'] ?? null,
            $warehouse['invenno'] ?? null,
            $warehouse['warehouse_no'] ?? null,
        ], fn ($value): bool => is_scalar($value) && trim((string) $value) !== '');

        foreach ($keys as $key) {
            $normalizedKey = trim((string) $key);
            foreach ([
                "RAF{$normalizedKey}",
                "RAF_{$normalizedKey}",
                "raf{$normalizedKey}",
                "raf_{$normalizedKey}",
                "RAFADRESI{$normalizedKey}",
                "RAF_ADRESI_{$normalizedKey}",
                "RAF_BILGISI{$normalizedKey}",
                "RAF_BILGISI_{$normalizedKey}",
                "RAF_BILGILERI{$normalizedKey}",
                "RAF_BILGILERI_{$normalizedKey}",
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

    private function stockLocationVisible(string $branch, ?string $warehouseCode, ?array $stockScope): bool
    {
        if ($stockScope === null) {
            return true;
        }

        if (isset($stockScope['sets']) && is_array($stockScope['sets'])) {
            foreach ($stockScope['sets'] as $scope) {
                if (! is_array($scope) || ! $this->stockLocationMatchesScope($branch, $warehouseCode, $scope)) {
                    return false;
                }
            }

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
        if ($normalizedBranch === null) {
            return false;
        }

        foreach ($names as $name) {
            if ($this->stockScopeNameMatchesBranch($normalizedBranch, $name)) {
                return true;
            }
        }

        return false;
    }

    private function stockScopeNameMatchesBranch(string $normalizedBranch, mixed $scopeName): bool
    {
        $normalizedName = $this->normalizeScopeText($scopeName);
        if ($normalizedName === null) {
            return false;
        }

        $branchText = $this->normalizeScopeMatchText($normalizedBranch);
        $nameText = $this->normalizeScopeMatchText($normalizedName);

        return $branchText === $nameText
            || ($nameText !== '' && str_starts_with($branchText, $nameText.' '));
    }

    private function scopeTextContainsToken(string $text, string $token): bool
    {
        return (bool) preg_match(
            '/(?:^|\s)'.preg_quote($token, '/').'(?:\s|$)/u',
            $text
        );
    }

    private function normalizeScopeMatchText(string $value): string
    {
        $normalized = preg_replace('/[^\p{L}\p{N}]+/u', ' ', $value) ?? $value;
        $normalized = preg_replace('/\s+/u', ' ', $normalized) ?? $normalized;

        return trim($normalized);
    }

    private function resolveShelfAddress(array $meta): ?string
    {
        return $this->firstMetaScalar($meta, [
            'shelf_address',
            'SHELF_ADDRESS',
            'SHELFADDRESS',
            'SHELF_ADDR',
            'raf_address',
            'RAF_ADDRESS',
            'raf_adresi',
            'RAF_ADRESI',
            'RAFADRESI',
            'raf_bilgisi',
            'RAF_BILGISI',
            'RAFBILGISI',
            'raf_bilgileri',
            'RAF_BILGILERI',
            'RAFBILGILERI',
            'shelf',
            'SHELF',
            'raf',
            'RAF',
            'location',
            'LOCATION',
            'location_code',
            'LOCATION_CODE',
            'LOCATIONCODE',
            'integrations.logo.payload.shelf_address',
            'integrations.logo.payload.shelfaddress',
            'integrations.logo.payload.shelf_addr',
            'integrations.logo.payload.raf_address',
            'integrations.logo.payload.raf_adresi',
            'integrations.logo.payload.rafadresi',
            'integrations.logo.payload.raf_bilgisi',
            'integrations.logo.payload.rafbilgisi',
            'integrations.logo.payload.raf_bilgileri',
            'integrations.logo.payload.rafbilgileri',
            'integrations.logo.payload.shelf',
            'integrations.logo.payload.raf',
            'integrations.logo.payload.location',
            'integrations.logo.payload.location_code',
            'integrations.logo.payload.raw.SHELF_ADDRESS',
            'integrations.logo.payload.raw.SHELFADDRESS',
            'integrations.logo.payload.raw.SHELF_ADDR',
            'integrations.logo.payload.raw.RAF_ADDRESS',
            'integrations.logo.payload.raw.RAF_ADRESI',
            'integrations.logo.payload.raw.RAFADRESI',
            'integrations.logo.payload.raw.RAF_BILGISI',
            'integrations.logo.payload.raw.RAFBILGISI',
            'integrations.logo.payload.raw.RAF_BILGILERI',
            'integrations.logo.payload.raw.RAFBILGILERI',
            'integrations.logo.payload.raw.SHELF',
            'integrations.logo.payload.raw.RAF',
            'integrations.logo.payload.raw.LOCATION',
            'integrations.logo.payload.raw.LOCATION_CODE',
            'integrations.logo.payload.raw.LOCATIONCODE',
        ]);
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
     * @param  list<string>  $paths
     */
    private function firstMetaScalar(array $meta, array $paths): ?string
    {
        foreach ($paths as $path) {
            $value = data_get($meta, $path);

            if (is_scalar($value)) {
                $normalized = trim((string) $value);
                if ($normalized !== '') {
                    return $normalized;
                }
            }
        }

        return null;
    }

    /**
     * @param  list<string>  $keys
     */
    private function firstArrayScalar(array $source, array $keys): ?string
    {
        foreach ($keys as $key) {
            $value = $source[$key] ?? null;
            if (is_scalar($value)) {
                $normalized = trim((string) $value);
                if ($normalized !== '') {
                    return $normalized;
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
                return (int) $value;
            }
        }

        return null;
    }

    private function decodeOffsetCursor(?string $cursor): int
    {
        if ($cursor === null || $cursor === '') {
            return 0;
        }

        $decoded = base64_decode($cursor, true);
        if ($decoded === false || ! ctype_digit($decoded)) {
            return 0;
        }

        return max(0, (int) $decoded);
    }

    private function encodeOffsetCursor(int $offset): string
    {
        return base64_encode((string) max(0, $offset));
    }

    /**
     * @return list<int>
     */
    private function matchingFastProductCodeProductIds(string $search, ?string $normalizedSearch, int $limit): array
    {
        $search = trim($search);
        if ($search === '') {
            return [];
        }

        $normalizedSearch = $normalizedSearch !== null && $normalizedSearch !== '' ? $normalizedSearch : null;
        $limit = max(1, $limit);
        $cacheKey = 'products:fast-code-product-ids:v1:'.md5(mb_strtolower($search, 'UTF-8').':'.($normalizedSearch ?? '').':'.$limit);

        return $this->cacheStore()->remember(
            $cacheKey,
            now()->addMinutes(10),
            function () use ($search, $normalizedSearch, $limit): array {
                $ids = [];
                $appendIds = function (array $productIds) use (&$ids, $limit): void {
                    foreach ($productIds as $productId) {
                        $id = (int) $productId;
                        if ($id <= 0 || in_array($id, $ids, true)) {
                            continue;
                        }

                        $ids[] = $id;
                        if (count($ids) >= $limit) {
                            return;
                        }
                    }
                };
                $appendProductQuery = function (callable $scope) use (&$ids, $limit, $appendIds): void {
                    $remaining = $limit - count($ids);
                    if ($remaining <= 0) {
                        return;
                    }

                    $query = Product::query()
                        ->select('products.id')
                        ->where('products.is_active', true)
                        ->where(function (Builder $query): void {
                            $this->applyLogoProductFilter($query, preferInline: true);
                        });

                    $scope($query);

                    $appendIds(
                        $query
                            ->limit($remaining)
                            ->pluck('products.id')
                            ->map(fn ($id): int => (int) $id)
                            ->all()
                    );
                };

                $exactValues = array_values(array_unique(array_filter(
                    [$search, $normalizedSearch],
                    fn (?string $value): bool => $value !== null && trim($value) !== ''
                )));

                $appendProductQuery(function (Builder $query) use ($exactValues): void {
                    $query->where(function (Builder $codeQuery) use ($exactValues): void {
                        $codeQuery
                            ->whereIn('products.sku', $exactValues)
                            ->orWhereIn('products.oem_code', $exactValues);
                    });
                });

                $prefixValues = array_map(fn (string $value): string => $this->escapeLike($value).'%', $exactValues);
                $appendProductQuery(function (Builder $query) use ($prefixValues): void {
                    $query->where(function (Builder $codeQuery) use ($prefixValues): void {
                        foreach ($prefixValues as $index => $prefix) {
                            $method = $index === 0 ? 'whereLike' : 'orWhereLike';
                            $codeQuery->{$method}('products.sku', $prefix, caseSensitive: false)
                                ->orWhereLike('products.oem_code', $prefix, caseSensitive: false);
                        }
                    });
                });

                if ($normalizedSearch !== null) {
                    $escapedNormalizedSearch = $this->escapeLike($normalizedSearch);
                    $appendProductQuery(function (Builder $query) use ($normalizedSearch): void {
                        $query->where(function (Builder $codeQuery) use ($normalizedSearch): void {
                            $codeQuery
                                ->whereRaw($this->normalizedProductCodeSql('products.sku').' = ?', [$normalizedSearch])
                                ->orWhereRaw($this->normalizedProductCodeSql('products.oem_code').' = ?', [$normalizedSearch]);
                        });
                    });

                    $appendProductQuery(function (Builder $query) use ($escapedNormalizedSearch): void {
                        $query->where(function (Builder $codeQuery) use ($escapedNormalizedSearch): void {
                            $codeQuery
                                ->whereRaw($this->normalizedProductCodeSql('products.sku').' LIKE ?', [$escapedNormalizedSearch.'%'])
                                ->orWhereRaw($this->normalizedProductCodeSql('products.oem_code').' LIKE ?', [$escapedNormalizedSearch.'%']);
                        });
                    });

                    if (mb_strlen($normalizedSearch, 'UTF-8') <= 4) {
                        $appendProductQuery(function (Builder $query) use ($escapedNormalizedSearch): void {
                            $query->where(function (Builder $codeQuery) use ($escapedNormalizedSearch): void {
                                $codeQuery
                                    ->whereRaw($this->normalizedProductCodeSql('products.sku').' LIKE ?', ['%'.$escapedNormalizedSearch.'%'])
                                    ->orWhereRaw($this->normalizedProductCodeSql('products.oem_code').' LIKE ?', ['%'.$escapedNormalizedSearch.'%']);
                            });
                        });
                    }

                    $appendIds($this->matchingCodeAliasProductIds($normalizedSearch, $limit));
                }

                return array_values($ids);
            }
        );
    }

    /**
     * @return list<int>
     */
    private function matchingExactCodeAliasProductIds(?string $normalizedSearch, int $limit): array
    {
        if ($normalizedSearch === null || mb_strlen($normalizedSearch, 'UTF-8') < 4) {
            return [];
        }

        $cacheKey = 'products:code-alias-exact:v1:'.md5($normalizedSearch.':'.$limit);

        return $this->cacheStore()->remember(
            $cacheKey,
            now()->addMinutes(10),
            fn (): array => ProductCodeAlias::query()
                ->where('normalized_code', $normalizedSearch)
                ->limit($limit)
                ->pluck('product_id')
                ->map(fn ($id): int => (int) $id)
                ->unique()
                ->values()
                ->all()
        );
    }

    /**
     * @return list<int>
     */
    private function matchingCodeAliasProductIds(?string $normalizedSearch, int $limit): array
    {
        if ($normalizedSearch === null || mb_strlen($normalizedSearch, 'UTF-8') < 4) {
            return [];
        }

        $cacheKey = 'products:code-alias-prefix:v1:'.md5($normalizedSearch.':'.$limit);

        return $this->cacheStore()->remember(
            $cacheKey,
            now()->addMinutes(10),
            fn (): array => ProductCodeAlias::query()
                ->where(function (Builder $query) use ($normalizedSearch): void {
                    $query
                        ->where('normalized_code', $normalizedSearch)
                        ->orWhereLike('normalized_code', $normalizedSearch.'%', caseSensitive: false);
                })
                ->orderByRaw('normalized_code = ? DESC', [$normalizedSearch])
                ->orderBy('normalized_code')
                ->limit($limit)
                ->pluck('product_id')
                ->map(fn ($id): int => (int) $id)
                ->unique()
                ->values()
                ->all()
        );
    }

    private function isLikelyProductCodeSearch(string $search): bool
    {
        return preg_match('/[0-9\\-_.\\/]/', $search) === 1;
    }

    private function shouldUseDatabaseForPunctuationInsensitiveSearch(string $search): bool
    {
        if (! $this->isLikelyProductCodeSearch($search)) {
            return false;
        }

        return mb_strlen($this->compactProductSearchToken($search), 'UTF-8') >= 3;
    }

    /**
     * @return list<array{raw: string, compact: string}>
     */
    private function productSearchKeywordTokens(string $search): array
    {
        $rawTokens = preg_split('/\\s+/u', trim($search)) ?: [];
        $tokens = [];
        $seen = [];

        foreach ($rawTokens as $rawToken) {
            $rawToken = trim($rawToken);
            if ($rawToken === '') {
                continue;
            }

            $compact = $this->compactProductSearchToken($rawToken);
            if (mb_strlen($rawToken, 'UTF-8') < 2 && mb_strlen($compact, 'UTF-8') < 2) {
                continue;
            }

            $key = $compact !== '' ? $compact : mb_strtoupper($rawToken, 'UTF-8');
            if (isset($seen[$key])) {
                continue;
            }

            $seen[$key] = true;
            $tokens[] = [
                'raw' => $rawToken,
                'compact' => $compact,
            ];

            if (count($tokens) >= 8) {
                break;
            }
        }

        return $tokens;
    }

    private function compactProductSearchToken(string $value): string
    {
        $compact = preg_replace('/[^\\pL\\pN]+/u', '', $value) ?? '';

        return mb_strtoupper($compact, 'UTF-8');
    }

    private function normalizedProductCodeSql(string $column): string
    {
        return "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(UPPER({$column}), ' ', ''), '-', ''), '.', ''), '/', ''), '_', '')";
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

    private function escapeLike(string $value): string
    {
        return addcslashes($value, '\\%_');
    }

    private function defaultPriceListId(): ?int
    {
        $id = PriceList::query()
            ->where('code', 'A')
            ->value('id');

        return $id !== null ? (int) $id : null;
    }

    private function cacheStore(): CacheRepository
    {
        return Cache::store((string) config('cache.default', 'file'));
    }
}
