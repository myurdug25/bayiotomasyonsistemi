<?php

namespace Tests\Unit;

use App\Support\Products\ProductSearchCacheRevision;
use Illuminate\Support\Facades\Cache;
use Tests\TestCase;

class ProductSearchCacheRevisionTest extends TestCase
{
    public function test_bump_changes_the_revision_used_by_search_cache_keys(): void
    {
        Cache::store((string) config('cache.default', 'file'))
            ->forget('products:search-data-revision');

        $before = ProductSearchCacheRevision::current();
        $after = ProductSearchCacheRevision::bump();

        $this->assertNotSame($before, $after);
        $this->assertSame($after, ProductSearchCacheRevision::current());
    }
}
