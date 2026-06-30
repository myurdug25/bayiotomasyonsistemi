<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Catalog\CatalogProductsRequest;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\PriceList;
use App\Models\Product;
use App\Models\User;
use App\Support\Pricing\DealerNetPriceExpression;
use App\Support\Pricing\DisplayCurrency;
use Illuminate\Cache\Repository as CacheRepository;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;
use Symfony\Component\HttpFoundation\Response;

class CatalogController extends Controller
{
    public function newProducts(CatalogProductsRequest $request): JsonResponse
    {
        $validated = $request->validated();
        $limit = min((int) ($validated['limit'] ?? 20), 50);
        $dealerContext = $this->resolveDealerContext($request->user(), $validated);

        if ($dealerContext === null) {
            return response()->json([
                'message' => 'dealer_id is required for users without an assigned dealer.',
            ], Response::HTTP_UNPROCESSABLE_ENTITY);
        }

        $query = $this->baseProductQuery($dealerContext['dealer_id'], $dealerContext['price_list_id'])
            ->addSelect('products.created_at')
            ->orderByDesc('products.created_at')
            ->orderByDesc('products.id');

        if (! empty($validated['days'])) {
            $query->where('products.created_at', '>=', now()->subDays((int) $validated['days']));
        }

        $paginator = $query->cursorPaginate(
            perPage: $limit,
            columns: ['*'],
            cursorName: 'cursor',
            cursor: $validated['cursor'] ?? null
        );

        return response()->json([
            'data' => $this->mapProducts(
                items: collect($paginator->items()),
                cache: $this->cacheStore(),
                dealerId: $dealerContext['dealer_id'],
                user: $request->user(),
                includeCreatedAt: true
            ),
            'next_cursor' => $paginator->nextCursor()?->encode(),
            'prev_cursor' => $paginator->previousCursor()?->encode(),
            'limit' => $limit,
            'catalog' => 'new-products',
        ]);
    }

    public function hotProducts(CatalogProductsRequest $request): JsonResponse
    {
        $validated = $request->validated();
        $limit = min((int) ($validated['limit'] ?? 20), 50);
        $dealerContext = $this->resolveDealerContext($request->user(), $validated);

        if ($dealerContext === null) {
            return response()->json([
                'message' => 'dealer_id is required for users without an assigned dealer.',
            ], Response::HTTP_UNPROCESSABLE_ENTITY);
        }

        $query = $this->baseProductQuery($dealerContext['dealer_id'], $dealerContext['price_list_id'])
            ->join('hot_products as hp', 'hp.product_id', '=', 'products.id')
            ->addSelect('hp.rank as hot_rank')
            ->orderBy('hp.rank')
            ->orderBy('products.id');

        $paginator = $query->cursorPaginate(
            perPage: $limit,
            columns: ['*'],
            cursorName: 'cursor',
            cursor: $validated['cursor'] ?? null
        );

        return response()->json([
            'data' => $this->mapProducts(
                items: collect($paginator->items()),
                cache: $this->cacheStore(),
                dealerId: $dealerContext['dealer_id'],
                user: $request->user(),
                includeHotRank: true
            ),
            'next_cursor' => $paginator->nextCursor()?->encode(),
            'prev_cursor' => $paginator->previousCursor()?->encode(),
            'limit' => $limit,
            'catalog' => 'hot-products',
        ]);
    }

    private function baseProductQuery(int $dealerId, int $priceListId): Builder
    {
        $netPriceSql = DealerNetPriceExpression::sql();

        return Product::query()
            ->select([
                'products.id',
                'products.sku',
                'products.oem_code',
                'products.name',
                'products.brand_id',
                'brands.name as brand_name',
            ])
            ->selectRaw("{$netPriceSql} as net_price")
            ->selectRaw('bp.list_price as list_price')
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
    }

    /**
     * @param  Collection<int, mixed>  $items
     * @return Collection<int, array<string, mixed>>
     */
    private function mapProducts(
        Collection $items,
        CacheRepository $cache,
        int $dealerId,
        User $user,
        bool $includeCreatedAt = false,
        bool $includeHotRank = false
    ): Collection {
        return $items->map(function ($item) use ($cache, $dealerId, $user, $includeCreatedAt, $includeHotRank) {
            $sourceCurrency = (string) ($item->currency ?? 'TRY');
            $rawNetPrice = $this->resolveHotPrice(
                cache: $cache,
                dealerId: $dealerId,
                productId: (int) $item->id,
                fallbackPrice: $item->net_price
            );
            $rawListPrice = $item->list_price !== null ? number_format((float) $item->list_price, 2, '.', '') : $rawNetPrice;

            $payload = [
                'id' => (int) $item->id,
                'sku' => $item->sku,
                'oem' => $item->oem_code,
                'name' => $item->name,
                'brand' => [
                    'id' => $item->brand_id !== null ? (int) $item->brand_id : null,
                    'name' => $item->brand_name,
                ],
                'net_price' => DisplayCurrency::formatPrice($rawNetPrice, $sourceCurrency, $user),
                'list_price' => DisplayCurrency::formatPrice($rawListPrice, $sourceCurrency, $user),
                'currency' => DisplayCurrency::normalize($sourceCurrency, $user),
                'available_total' => max(0, (int) $item->available_total),
            ];

            if ($includeCreatedAt) {
                $payload['created_at'] = $item->created_at;
            }

            if ($includeHotRank) {
                $payload['rank'] = isset($item->hot_rank) ? (int) $item->hot_rank : null;
            }

            return $payload;
        })->values();
    }

    /**
     * @param  array<string, mixed>  $validated
     * @return array{dealer_id:int, price_list_id:int}|null
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
        $id = PriceList::query()
            ->where('code', 'A')
            ->value('id');

        return $id !== null ? (int) $id : null;
    }

    private function cacheStore(): CacheRepository
    {
        return Cache::store((string) config('cache.default', 'file'));
    }

    private function applyLogoProductFilter(Builder $query): void
    {
        $query
            ->whereNotNull('products.meta->integrations->logo->synced_at')
            ->orWhereNotNull('products.meta->integrations->logo->external_ref')
            ->orWhereNotNull('products.meta->integrations->logo->logical_ref');
    }
}
