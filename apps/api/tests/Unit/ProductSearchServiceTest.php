<?php

namespace Tests\Unit;

use App\Models\Product;
use App\Services\Meilisearch\ProductSearchService;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use ReflectionMethod;
use Tests\TestCase;

class ProductSearchServiceTest extends TestCase
{
    public function test_index_settings_do_not_apply_typo_tolerance_to_product_codes(): void
    {
        config()->set('meilisearch.enabled', true);
        config()->set('meilisearch.host', 'http://meili.test');
        config()->set('meilisearch.key', 'test-key');
        config()->set('meilisearch.products_index', 'products');

        Http::fake([
            'http://meili.test/indexes/products' => Http::response(['uid' => 'products'], 200),
            'http://meili.test/indexes/products/settings' => Http::response(['taskUid' => 1], 202),
        ]);

        app(ProductSearchService::class)->ensureIndex();

        Http::assertSent(function (Request $request): bool {
            if ($request->method() !== 'PATCH' || ! str_ends_with($request->url(), '/indexes/products/settings')) {
                return false;
            }

            return $request['typoTolerance']['minWordSizeForTypos'] === [
                'oneTypo' => 8,
                'twoTypos' => 12,
            ] && $request['typoTolerance']['disableOnAttributes'] === [
                'sku',
                'oem',
                'code_aliases',
                'search_text',
            ];
        });
    }

    public function test_search_text_contains_normalized_logo_name_fields(): void
    {
        $product = new Product([
            'sku' => 'PWS-OIL-010',
            'name' => 'MADENİ YAĞ',
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'raw' => [
                                'NAME3' => '10W-40 EXTRA SL/CF SEMI SYNTHETIC',
                                'SPECODE5' => 'POWERSAOIL',
                            ],
                        ],
                    ],
                ],
            ],
        ]);

        $method = new ReflectionMethod(ProductSearchService::class, 'buildSearchText');
        $searchText = (string) $method->invoke(app(ProductSearchService::class), $product);

        $this->assertStringContainsString('10W40EXTRASLCFSEMISYNTHETIC', $searchText);
        $this->assertStringContainsString('POWERSAOIL', $searchText);
    }
}
