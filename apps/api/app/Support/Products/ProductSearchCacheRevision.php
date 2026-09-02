<?php

namespace App\Support\Products;

use Illuminate\Contracts\Cache\Repository;
use Illuminate\Support\Facades\Cache;

final class ProductSearchCacheRevision
{
    private const KEY = 'products:search-data-revision';

    public static function current(): string
    {
        return (string) self::store()->get(self::KEY, '1');
    }

    public static function bump(): string
    {
        $revision = sprintf('%.6F', microtime(true));
        self::store()->forever(self::KEY, $revision);

        return $revision;
    }

    private static function store(): Repository
    {
        return Cache::store((string) config('cache.default', 'file'));
    }
}
