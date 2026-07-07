<?php

namespace App\Services\Meilisearch;

use App\Models\Product;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use RuntimeException;
use Throwable;

class ProductSearchService
{
    private const SEARCH_UNAVAILABLE_CACHE_KEY = 'meilisearch:products:search-unavailable';

    private bool $indexEnsured = false;

    public function isEnabled(): bool
    {
        return (bool) config('meilisearch.enabled', true)
            && (string) config('meilisearch.host', '') !== '';
    }

    public function shouldAttemptSearch(): bool
    {
        if (! $this->isEnabled()) {
            return false;
        }

        return ! (bool) Cache::store((string) config('cache.default', 'file'))
            ->get(self::SEARCH_UNAVAILABLE_CACHE_KEY, false);
    }

    public function markSearchUnavailable(Throwable $_exception): void
    {
        Cache::store((string) config('cache.default', 'file'))
            ->put(self::SEARCH_UNAVAILABLE_CACHE_KEY, true, now()->addSeconds(30));
    }

    /**
     * @return array{ids:list<int>, estimated_total:int}
     */
    public function searchProductIds(string $query, array $filters = [], int $limit = 50, int $offset = 0): array
    {
        if (! $this->isEnabled()) {
            throw new RuntimeException('Meilisearch is disabled.');
        }

        $response = $this->client()->post($this->indexPath('/search'), [
            'q' => $query,
            'offset' => max(0, $offset),
            'limit' => max(1, min(250, $limit)),
            'attributesToRetrieve' => ['id'],
            'filter' => $this->buildFilterExpression($filters),
        ]);

        if (! $response->successful()) {
            throw new RuntimeException('Meilisearch query failed: '.$response->body());
        }

        $json = $response->json();
        $hits = $json['hits'] ?? [];

        return [
            'ids' => collect($hits)
                ->pluck('id')
                ->map(fn ($id) => (int) $id)
                ->values()
                ->all(),
            'estimated_total' => (int) ($json['estimatedTotalHits'] ?? 0),
        ];
    }

    public function upsertProductById(int $productId): void
    {
        $product = Product::query()
            ->with(['brand:id,name', 'category:id,name', 'codeAliases:id,product_id,code'])
            ->find($productId);

        if ($product === null) {
            $this->deleteProductById($productId);

            return;
        }

        $this->upsertProducts(collect([$product]));
    }

    public function upsertProducts(Collection $products): void
    {
        if (! $this->isEnabled() || $products->isEmpty()) {
            return;
        }

        $this->ensureIndex();

        $documents = $products->map(fn (Product $product) => [
            'id' => (int) $product->id,
            'sku' => (string) $product->sku,
            'oem' => $product->oem_code,
            'code_aliases' => $product->codeAliases
                ->pluck('code')
                ->filter()
                ->values()
                ->all(),
            'name' => (string) $product->name,
            'brand' => $product->brand?->name,
            'category' => $product->category?->name,
            'brand_id' => $product->brand_id !== null ? (int) $product->brand_id : null,
            'category_id' => $product->category_id !== null ? (int) $product->category_id : null,
            'is_active' => (bool) $product->is_active,
        ])->values()->all();

        $response = $this->client()->post($this->indexPath('/documents'), $documents);

        if (! $response->successful()) {
            throw new RuntimeException('Meilisearch upsert failed: '.$response->body());
        }
    }

    public function deleteProductById(int $productId): void
    {
        if (! $this->isEnabled()) {
            return;
        }

        $this->ensureIndex();

        $response = $this->client()->delete($this->indexPath('/documents/'.(int) $productId));

        if (! $response->successful()) {
            throw new RuntimeException('Meilisearch delete failed: '.$response->body());
        }
    }

    public function reindexAll(?int $chunkSize = null): void
    {
        if (! $this->isEnabled()) {
            return;
        }

        $this->ensureIndex();

        $chunk = $chunkSize ?? (int) config('meilisearch.batch_size', 500);

        Product::query()
            ->with(['brand:id,name', 'category:id,name', 'codeAliases:id,product_id,code'])
            ->orderBy('id')
            ->chunkById($chunk, function (Collection $products) {
                $this->upsertProducts($products);
            });
    }

    public function ensureIndex(): void
    {
        if ($this->indexEnsured) {
            return;
        }

        $uid = (string) config('meilisearch.products_index', 'products');

        $check = $this->client()->get('/indexes/'.urlencode($uid));

        if ($check->status() === 404) {
            $create = $this->client()->post('/indexes', [
                'uid' => $uid,
                'primaryKey' => 'id',
            ]);

            if (! $create->successful()) {
                throw new RuntimeException('Meilisearch index create failed: '.$create->body());
            }
        } elseif (! $check->successful()) {
            throw new RuntimeException('Meilisearch index check failed: '.$check->body());
        }

        $settings = $this->client()->patch($this->indexPath('/settings'), [
            'searchableAttributes' => ['sku', 'oem', 'code_aliases', 'name', 'brand', 'category'],
            'filterableAttributes' => ['brand_id', 'category_id', 'is_active'],
            'sortableAttributes' => ['id'],
            'typoTolerance' => ['enabled' => true],
        ]);

        if (! $settings->successful()) {
            throw new RuntimeException('Meilisearch settings update failed: '.$settings->body());
        }

        $this->indexEnsured = true;
    }

    private function client(): PendingRequest
    {
        $request = Http::baseUrl((string) config('meilisearch.host'))
            ->acceptJson()
            ->timeout((int) config('meilisearch.timeout', 3));

        $key = (string) config('meilisearch.key', '');
        if ($key !== '') {
            $request = $request->withToken($key);
        }

        return $request;
    }

    private function indexPath(string $suffix = ''): string
    {
        $uid = urlencode((string) config('meilisearch.products_index', 'products'));

        return '/indexes/'.$uid.$suffix;
    }

    /**
     * @param  array<string, mixed>  $filters
     * @return list<string>
     */
    private function buildFilterExpression(array $filters): array
    {
        $rules = ['is_active = true'];

        if (! empty($filters['brand_id'])) {
            $rules[] = 'brand_id = '.(int) $filters['brand_id'];
        }

        if (! empty($filters['category_id'])) {
            $rules[] = 'category_id = '.(int) $filters['category_id'];
        }

        return $rules;
    }
}
