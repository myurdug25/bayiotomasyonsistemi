<?php

namespace Tests\Feature;

use App\Models\Brand;
use App\Models\Category;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\Product;
use App\Models\ProductCodeAlias;
use App\Models\Role;
use App\Models\User;
use App\Services\Meilisearch\ProductSearchService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\TestCase;

class ProductMetaFiltersApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config()->set('cache.stores.redis', ['driver' => 'array']);
        config()->set('meilisearch.enabled', false);
        Cache::flush();
    }

    public function test_filter_options_include_meta_kod_groups_from_active_products(): void
    {
        $context = $this->createSalesContext();

        $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'FLT-KOD2-YAG',
            name: 'Meta Filter Test Yag',
            stock: 12,
            listPrice: 125.00,
            meta: [
                'kod1' => 'FILTRE',
                'kod2' => 'YAG',
                'kod3' => 'SPIN-ON',
                'stok_turu' => 'T',
            ]
        );

        $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'FLT-KOD2-YAKIT',
            name: 'Meta Filter Test Yakit',
            stock: 9,
            listPrice: 199.00,
            meta: [
                'kod1' => 'FILTRE',
                'kod2' => 'YAKIT',
                'kod3' => 'ELEMENT',
                'stok_turu' => 'T',
            ]
        );

        $this->actingAs($context['user']);

        $response = $this->getJson('/api/products/filter-options');

        $response->assertOk();
        $response->assertJsonPath('meta.kod1.0', 'FILTRE');
        $response->assertJsonPath('meta.kod2.0', 'YAG');
        $response->assertJsonPath('meta.kod2.1', 'YAKIT');
        $response->assertJsonPath('meta.kod3.0', 'ELEMENT');
        $response->assertJsonPath('meta.kod3.1', 'SPIN-ON');
        $this->assertContains('Meta Test Brand', $response->json('meta.specode5'));
        $response->assertJsonPath('meta.stok_turu.0', 'T');
    }

    public function test_products_search_filters_marka_by_visible_brand_name(): void
    {
        $context = $this->createSalesContext();

        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'BRAND-FILTER-001',
            name: 'Visible Brand Filter Product',
            stock: 7,
            listPrice: 185.00,
            meta: [
                'kod2' => 'DETAY-1',
                'kod3' => 'DETAY-2',
            ]
        );

        $otherBrand = Brand::query()->create([
            'name' => 'Other Visible Brand',
            'slug' => 'other-visible-brand',
            'is_active' => true,
        ]);

        $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $otherBrand,
            category: $context['category'],
            sku: 'BRAND-FILTER-OTHER',
            name: 'Other Visible Brand Product',
            stock: 5,
            listPrice: 195.00,
            meta: [
                'kod2' => 'DETAY-1',
                'kod3' => 'DETAY-2',
            ]
        );

        $this->actingAs($context['user']);

        $optionsResponse = $this->getJson('/api/products/filter-options');
        $optionsResponse->assertOk();
        $this->assertContains('Meta Test Brand', $optionsResponse->json('meta.specode5'));
        $this->assertContains('Other Visible Brand', $optionsResponse->json('meta.specode5'));

        $searchResponse = $this->getJson('/api/products/search?limit=20&sort=stock_desc&specode5=Meta%20Test%20Brand');
        $searchResponse->assertOk();
        $searchResponse->assertJsonCount(1, 'data');
        $searchResponse->assertJsonPath('data.0.id', $product->id);
    }

    public function test_products_search_filters_by_kod2_value(): void
    {
        $context = $this->createSalesContext();

        $productYag = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'FLT-ONLY-YAG',
            name: 'Meta Search Yag Product',
            stock: 15,
            listPrice: 155.00,
            meta: [
                'kod1' => 'FILTRE',
                'kod2' => 'YAG',
                'kod3' => 'SPIN-ON',
                'stok_turu' => 'T',
            ]
        );

        $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'FLT-NON-YAG',
            name: 'Meta Search Yakit Product',
            stock: 20,
            listPrice: 255.00,
            meta: [
                'kod1' => 'FILTRE',
                'kod2' => 'YAKIT',
                'kod3' => 'ELEMENT',
                'stok_turu' => 'T',
            ]
        );

        $this->actingAs($context['user']);

        $response = $this->getJson('/api/products/search?limit=20&sort=stock_desc&kod2=YAG');
        $response->assertOk();
        $response->assertJsonCount(1, 'data');
        $response->assertJsonPath('data.0.id', $productYag->id);
        $response->assertJsonPath('data.0.meta.kod2', 'YAG');
    }

    public function test_products_search_includes_open_cart_quantity_from_all_draft_carts(): void
    {
        $context = $this->createSalesContext();

        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'OPEN-CART-QTY-001',
            name: 'Open Cart Quantity Product',
            stock: 80,
            listPrice: 180.00,
            meta: [
                'kod2' => 'SEPET',
                'kod3' => 'TOPLAM',
            ]
        );

        $customerId = (int) Customer::query()
            ->where('dealer_id', $context['dealer']->id)
            ->value('id');
        $otherUser = User::factory()->create([
            'dealer_id' => $context['dealer']->id,
            'is_active' => true,
        ]);

        $draftCartA = DB::table('carts')->insertGetId([
            'dealer_id' => $context['dealer']->id,
            'customer_id' => $customerId,
            'user_id' => $context['user']->id,
            'status' => 'draft',
            'currency' => 'TRY',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        $draftCartB = DB::table('carts')->insertGetId([
            'dealer_id' => $context['dealer']->id,
            'customer_id' => $customerId,
            'user_id' => $otherUser->id,
            'status' => 'draft',
            'currency' => 'TRY',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        $orderedCart = DB::table('carts')->insertGetId([
            'dealer_id' => $context['dealer']->id,
            'customer_id' => $customerId,
            'user_id' => $otherUser->id,
            'status' => 'ordered',
            'currency' => 'TRY',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        foreach ([[$draftCartA, 14], [$draftCartB, 50], [$orderedCart, 99]] as [$cartId, $quantity]) {
            DB::table('cart_items')->insert([
                'cart_id' => $cartId,
                'product_id' => $product->id,
                'quantity' => $quantity,
                'unit_net_price' => 180.00,
                'currency' => 'TRY',
                'discount_rate' => 0,
                'vat_rate' => 20.00,
                'line_total' => 180.00 * $quantity,
                'created_at' => now(),
                'updated_at' => now(),
            ]);
        }

        $this->actingAs($context['user']);

        $response = $this->getJson('/api/products/search?limit=20&q=OPEN-CART-QTY-001');

        $response->assertOk();
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.open_cart_quantity', 64);
    }

    public function test_products_search_reads_logo_payload_brand_special_codes_and_shelf_address(): void
    {
        $context = $this->createSalesContext();

        $product = Product::withoutEvents(function () use ($context): Product {
            return Product::query()->create([
                'brand_id' => null,
                'category_id' => $context['category']->id,
                'sku' => 'PAYLOAD-ONLY-001',
                'oem_code' => 'OEM-PAYLOAD-001',
                'name' => 'Payload Only Oil Filter',
                'unit' => 'adet',
                'vat_rate' => 20.00,
                'is_active' => true,
                'meta' => [
                    'integrations' => [
                        'logo' => [
                            'synced_at' => now()->toIso8601String(),
                            'external_ref' => 'LOGO-PAYLOAD-001',
                            'payload' => [
                                'logo_name2' => 'Aciklama 2 Oil Filter',
                                'kod3' => 'SPINON',
                                'specode4' => 'E',
                                'specode5' => 'BOSCH',
                                'raw' => [
                                    'RAF_BILGILERI' => 'RAF-GENEL',
                                    'RAF25' => 'RAF-25-A1',
                                ],
                                'logo_stock' => [
                                    'warehouses' => [
                                        [
                                            'warehouse_code' => '1',
                                            'shelf_key' => '25',
                                            'branch' => 'Erzurum',
                                            'available_total' => 7,
                                        ],
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ]);
        });

        DB::table('stock_summary')->insert([
            'product_id' => $product->id,
            'available_total' => 7,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);

        DB::table('base_prices')->insert([
            'price_list_id' => (int) $context['dealer']->price_list_id,
            'product_id' => $product->id,
            'list_price' => 135.45,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($context['user']);

        $response = $this->getJson('/api/products/search?limit=20&sort=stock_desc&kod3=SPINON');

        $response->assertOk();
        $response->assertJsonCount(1, 'data');
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.name', 'Aciklama 2 Oil Filter');
        $response->assertJsonPath('data.0.brand.name', 'BOSCH');
        $response->assertJsonPath('data.0.meta.kod3', 'SPINON');
        $response->assertJsonPath('data.0.meta.specode4', 'E');
        $response->assertJsonPath('data.0.meta.specode5', 'BOSCH');
        $response->assertJsonPath('data.0.shelf_address', 'RAF-GENEL');
        $response->assertJsonPath('data.0.stock_locations.0.shelf_address', 'RAF-25-A1');
    }

    public function test_products_search_uses_logo_raw_name3_as_description_two_for_existing_payloads(): void
    {
        $context = $this->createSalesContext();

        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'RAW-NAME3-001',
            name: 'Aciklama 1 Yag Filtresi',
            stock: 5,
            listPrice: 210.00,
            meta: [
                'integrations' => [
                    'logo' => [
                        'synced_at' => now()->toIso8601String(),
                        'external_ref' => 'RAW-NAME3-001',
                        'payload' => [
                            'raw' => [
                                'NAME' => 'Aciklama 1 Yag Filtresi',
                                'NAME3' => 'Aciklama 2 Arac Uygulama Bilgisi',
                            ],
                        ],
                    ],
                ],
            ]
        );

        $this->actingAs($context['user']);

        $response = $this->getJson('/api/products/search?limit=20&sort=stock_desc&q=RAW-NAME3-001');

        $response->assertOk();
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.name', 'Aciklama 2 Arac Uygulama Bilgisi');
    }

    public function test_filter_options_include_logo_raw_special_codes_and_search_filters_them(): void
    {
        $context = $this->createSalesContext();

        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'RAW-FILTER-001',
            name: 'Raw Logo Filter Product',
            stock: 11,
            listPrice: 145.00,
            meta: [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'raw' => [
                                'KOD2' => 'HAM-YAG',
                                'KOD3' => 'HAM-SPINON',
                                'SPECODE4' => 'E',
                                'SPECODE5' => 'HAM-MARKA',
                            ],
                        ],
                    ],
                ],
            ]
        );

        $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'RAW-FILTER-OTHER',
            name: 'Other Raw Logo Filter Product',
            stock: 8,
            listPrice: 155.00,
            meta: [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'raw' => [
                                'KOD2' => 'HAM-HAVA',
                                'KOD3' => 'HAM-ELEMENT',
                                'SPECODE4' => 'E',
                                'SPECODE5' => 'HAM-DIGER',
                            ],
                        ],
                    ],
                ],
            ]
        );

        $this->actingAs($context['user']);

        $optionsResponse = $this->getJson('/api/products/filter-options');

        $optionsResponse->assertOk();
        $this->assertContains('HAM-HAVA', $optionsResponse->json('meta.kod2'));
        $this->assertContains('HAM-YAG', $optionsResponse->json('meta.kod2'));
        $this->assertContains('HAM-ELEMENT', $optionsResponse->json('meta.kod3'));
        $this->assertContains('HAM-SPINON', $optionsResponse->json('meta.kod3'));
        $this->assertContains('HAM-DIGER', $optionsResponse->json('meta.specode5'));
        $this->assertContains('HAM-MARKA', $optionsResponse->json('meta.specode5'));

        $searchResponse = $this->getJson('/api/products/search?limit=20&sort=stock_desc&kod2=HAM-YAG');

        $searchResponse->assertOk();
        $searchResponse->assertJsonCount(1, 'data');
        $searchResponse->assertJsonPath('data.0.id', $product->id);
        $searchResponse->assertJsonPath('data.0.meta.kod2', 'HAM-YAG');
    }

    public function test_admin_search_sees_all_logo_warehouse_stock_locations(): void
    {
        $context = $this->createSalesContext();
        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'STOCK-ALL-001',
            name: 'All Branch Stock Product',
            stock: 15,
            listPrice: 210.00,
            meta: [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'logo_stock' => [
                                'warehouses' => [
                                    [
                                        'warehouse_code' => 'ERZ',
                                        'warehouse_name' => 'ERZURUM',
                                        'available_total' => 8,
                                        'shelf_address' => 'D.12',
                                    ],
                                    [
                                        'warehouse_code' => 'SMS',
                                        'warehouse_name' => 'SAMSUN',
                                        'available_total' => 7,
                                        'shelf_address' => 'A11.3',
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ]
        );

        $adminRole = Role::query()->firstOrCreate(
            ['slug' => 'admin'],
            ['name' => 'Admin']
        );
        $admin = User::factory()->create([
            'dealer_id' => $context['dealer']->id,
            'is_active' => true,
        ]);
        $admin->roles()->sync([$adminRole->id]);

        $this->actingAs($admin);

        $response = $this->getJson('/api/products/search?limit=20&sort=stock_desc&q=STOCK-ALL-001');

        $response->assertOk();
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.available_total', 15);
        $response->assertJsonCount(2, 'data.0.stock_locations');
        $response->assertJsonPath('data.0.stock_locations.0.branch', 'ERZURUM');
        $response->assertJsonPath('data.0.stock_locations.0.stock', 8);
        $response->assertJsonPath('data.0.stock_locations.1.branch', 'SAMSUN');
        $response->assertJsonPath('data.0.stock_locations.1.stock', 7);
    }

    public function test_products_search_filters_logo_warehouse_stock_locations_by_feature_permissions(): void
    {
        $context = $this->createSalesContext();
        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'STOCK-FEATURE-001',
            name: 'Feature Scoped Stock Product',
            stock: 21,
            listPrice: 210.00,
            meta: [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'logo_stock' => [
                                'warehouses' => [
                                    [
                                        'warehouse_code' => '1',
                                        'warehouse_name' => 'ERZURUM DEPO',
                                        'available_total' => 8,
                                    ],
                                    [
                                        'warehouse_code' => '3',
                                        'warehouse_name' => 'SAMSUN DEPO',
                                        'available_total' => 7,
                                    ],
                                    [
                                        'warehouse_code' => '4',
                                        'warehouse_name' => 'BATUM DEPO',
                                        'available_total' => 6,
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ]
        );

        $dealerAdminRole = Role::query()->firstOrCreate(
            ['slug' => 'dealer_admin'],
            ['name' => 'Dealer Admin']
        );
        $dealerAdmin = User::factory()->create([
            'dealer_id' => $context['dealer']->id,
            'is_active' => true,
            'menu_permissions' => ['search'],
            'feature_permissions' => ['search.stock', 'search.stock.warehouse.samsun'],
        ]);
        $dealerAdmin->roles()->sync([$dealerAdminRole->id]);

        $this->actingAs($dealerAdmin);

        $response = $this->getJson('/api/products/search?limit=20&sort=stock_desc&q=STOCK-FEATURE-001');

        $response->assertOk();
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.available_total', 7);
        $response->assertJsonCount(1, 'data.0.stock_locations');
        $response->assertJsonPath('data.0.stock_locations.0.branch', 'SAMSUN DEPO');
        $response->assertJsonPath('data.0.stock_locations.0.stock', 7);
    }

    public function test_point_user_sees_erzurum_depo_and_point_stock_with_shelf_addresses(): void
    {
        $context = $this->createSalesContext();
        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'STOCK-POINT-ERZ-001',
            name: 'Point Erzurum Stock Product',
            stock: 17,
            listPrice: 210.00,
            meta: [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'raw' => [
                                'RAF25' => 'A42.4',
                                'RAF250' => 'B1.3',
                            ],
                            'logo_stock' => [
                                'warehouses' => [
                                    [
                                        'warehouse_code' => '1',
                                        'available_total' => 8,
                                        'shelf_key' => '25',
                                    ],
                                    [
                                        'warehouse_code' => '0',
                                        'available_total' => 2,
                                        'shelf_key' => '250',
                                    ],
                                    [
                                        'warehouse_code' => '3',
                                        'warehouse_name' => 'SAMSUN DEPO',
                                        'available_total' => 7,
                                        'shelf_key' => '55',
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ]
        );

        $pointRole = Role::query()->firstOrCreate(
            ['slug' => 'point'],
            ['name' => 'Point']
        );
        $pointUser = User::factory()->create([
            'dealer_id' => $context['dealer']->id,
            'is_active' => true,
            'branch_code' => 'ERZURUM',
            'branch_name' => 'ERZURUM MERKEZ ŞUBESİ',
            'menu_permissions' => ['search'],
            'feature_permissions' => [
                'search.stock',
                'search.stock.warehouse.erzurum_depo',
                'search.stock.warehouse.erzurum_point',
            ],
        ]);
        $pointUser->roles()->sync([$pointRole->id]);

        $this->actingAs($pointUser);

        $response = $this->getJson('/api/products/search?limit=20&sort=stock_desc&q=STOCK-POINT-ERZ-001');

        $response->assertOk();
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.available_total', 10);
        $response->assertJsonCount(2, 'data.0.stock_locations');
        $response->assertJsonPath('data.0.stock_locations.0.warehouse_code', '1');
        $response->assertJsonPath('data.0.stock_locations.0.stock', 8);
        $response->assertJsonPath('data.0.stock_locations.0.shelf_address', 'A42.4');
        $response->assertJsonPath('data.0.stock_locations.1.warehouse_code', '0');
        $response->assertJsonPath('data.0.stock_locations.1.stock', 2);
        $response->assertJsonPath('data.0.stock_locations.1.shelf_address', 'B1.3');
    }

    public function test_batum_user_sees_batum_logo_warehouse_stock(): void
    {
        $context = $this->createSalesContext();
        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'STOCK-BATUM-001',
            name: 'Batum Stock Product',
            stock: 17,
            listPrice: 210.00,
            meta: [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'logo_stock' => [
                                'warehouses' => [
                                    [
                                        'warehouse_code' => '1',
                                        'warehouse_name' => 'ERZURUM DEPO',
                                        'available_total' => 8,
                                    ],
                                    [
                                        'warehouse_code' => '4',
                                        'warehouse_name' => 'BATUM DEPO',
                                        'available_total' => 6,
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ]
        );

        $pointRole = Role::query()->firstOrCreate(
            ['slug' => 'point'],
            ['name' => 'Point']
        );
        $batumUser = User::factory()->create([
            'username' => 'batum',
            'dealer_id' => $context['dealer']->id,
            'is_active' => true,
            'branch_code' => 'BATUM',
            'branch_name' => 'Batum',
            'menu_permissions' => ['search'],
            'feature_permissions' => [
                'search.stock',
                'search.stock.warehouse.erzurum_depo',
            ],
        ]);
        $batumUser->roles()->sync([$pointRole->id]);

        $this->actingAs($batumUser);

        $response = $this->getJson('/api/products/search?limit=20&sort=stock_desc&q=STOCK-BATUM-001');

        $response->assertOk();
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.available_total', 6);
        $response->assertJsonCount(1, 'data.0.stock_locations');
        $response->assertJsonPath('data.0.stock_locations.0.warehouse_code', '4');
        $response->assertJsonPath('data.0.stock_locations.0.branch', 'BATUM DEPO');
        $response->assertJsonPath('data.0.stock_locations.0.stock', 6);

        $missingBatumProduct = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'STOCK-BATUM-MISSING-001',
            name: 'Batum Missing Stock Product',
            stock: 8,
            listPrice: 210.00,
            meta: [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'logo_stock' => [
                                'warehouses' => [
                                    [
                                        'warehouse_code' => '1',
                                        'warehouse_name' => 'ERZURUM DEPO',
                                        'available_total' => 8,
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ]
        );

        $missingResponse = $this->getJson('/api/products/search?limit=20&sort=stock_desc&q=STOCK-BATUM-MISSING-001');

        $missingResponse->assertOk();
        $missingResponse->assertJsonPath('data.0.id', $missingBatumProduct->id);
        $missingResponse->assertJsonPath('data.0.available_total', 0);
        $missingResponse->assertJsonCount(1, 'data.0.stock_locations');
        $missingResponse->assertJsonPath('data.0.stock_locations.0.warehouse_code', '4');
        $missingResponse->assertJsonPath('data.0.stock_locations.0.branch', 'BATUM DEPO');
        $missingResponse->assertJsonPath('data.0.stock_locations.0.stock', 0);
    }

    public function test_salesperson_with_selected_customer_sees_only_customer_branch_stock(): void
    {
        $context = $this->createSalesContext();
        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'STOCK-SCOPE-001',
            name: 'Scoped Branch Stock Product',
            stock: 18,
            listPrice: 245.00,
            meta: [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'logo_stock' => [
                                'warehouses' => [
                                    [
                                        'warehouse_code' => 'ERZ',
                                        'warehouse_name' => 'ERZURUM',
                                        'available_total' => 9,
                                        'shelf_address' => 'D.12',
                                    ],
                                    [
                                        'warehouse_code' => 'TRB',
                                        'warehouse_name' => 'TRABZON',
                                        'available_total' => 4,
                                        'shelf_address' => 'A26.6',
                                    ],
                                    [
                                        'warehouse_code' => 'SMS',
                                        'warehouse_name' => 'SAMSUN',
                                        'available_total' => 5,
                                        'shelf_address' => 'C3.3',
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ]
        );

        $selectedCustomer = Customer::query()->create([
            'dealer_id' => $context['dealer']->id,
            'code' => 'TRB-CUST-001',
            'name' => 'Trabzon Customer',
            'branch_code' => 'TRB',
            'branch_name' => 'TRABZON',
            'is_active' => true,
        ]);
        $context['user']->forceFill(['selected_customer_id' => $selectedCustomer->id])->save();

        $this->actingAs($context['user']);

        $response = $this->getJson('/api/products/search?limit=20&sort=stock_desc&q=STOCK-SCOPE-001');

        $response->assertOk();
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.available_total', 4);
        $response->assertJsonCount(1, 'data.0.stock_locations');
        $response->assertJsonPath('data.0.stock_locations.0.branch', 'TRABZON');
        $response->assertJsonPath('data.0.stock_locations.0.warehouse_code', 'TRB');
        $response->assertJsonPath('data.0.stock_locations.0.stock', 4);
        $response->assertJsonPath('data.0.stock_locations.0.shelf_address', 'A26.6');
    }

    public function test_products_search_returns_products_by_brand_name_and_applies_sort(): void
    {
        $context = $this->createSalesContext();

        $brand = Brand::query()->create([
            'name' => 'Wunder Filter',
            'slug' => 'wunder-filter',
            'is_active' => true,
        ]);

        $cheapProduct = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $brand,
            category: $context['category'],
            sku: 'BRAND-CHEAP-001',
            name: 'Oil Element',
            stock: 8,
            listPrice: 120.00,
            meta: [
                'kod1' => 'FILTRE',
                'kod2' => 'YAG',
                'kod3' => 'ELEMENT',
                'stok_turu' => 'T',
            ]
        );

        $expensiveProduct = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $brand,
            category: $context['category'],
            sku: 'BRAND-EXPENSIVE-001',
            name: 'Air Element',
            stock: 14,
            listPrice: 360.00,
            meta: [
                'kod1' => 'FILTRE',
                'kod2' => 'HAVA',
                'kod3' => 'ELEMENT',
                'stok_turu' => 'T',
            ]
        );

        $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'OTHER-BRAND-001',
            name: 'Wunder Named Non Brand Product',
            stock: 20,
            listPrice: 90.00,
            meta: [
                'kod1' => 'FILTRE',
                'kod2' => 'YAKIT',
                'kod3' => 'ELEMENT',
                'stok_turu' => 'T',
            ]
        );

        $this->actingAs($context['user']);

        $response = $this->getJson('/api/products/search?limit=20&q=Wunder%20Filter&sort=price_asc');

        $response->assertOk();
        $response->assertJsonCount(2, 'data');
        $response->assertJsonPath('data.0.id', $cheapProduct->id);
        $response->assertJsonPath('data.1.id', $expensiveProduct->id);
        $response->assertJsonPath('data.0.brand.name', 'Wunder Filter');
        $response->assertJsonPath('data.1.brand.name', 'Wunder Filter');
    }

    public function test_products_search_returns_product_by_competitor_code_alias(): void
    {
        $context = $this->createSalesContext();

        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'PWS-3A760',
            name: 'Muadil Kod Test Product',
            stock: 15,
            listPrice: 155.00,
            meta: [
                'kod1' => 'FILTRE',
                'kod2' => 'HAVA',
                'kod3' => 'YUVARLAK',
                'stok_turu' => 'T',
            ]
        );

        ProductCodeAlias::query()->create([
            'product_id' => $product->id,
            'code' => 'WH760',
            'normalized_code' => 'WH760',
            'code_type' => 'competitor',
            'brand_name' => 'WUNDER',
            'source' => 'logo',
        ]);

        $this->actingAs($context['user']);

        $response = $this->getJson('/api/products/search?limit=20&sort=stock_desc&q=WH760');

        $response->assertOk();
        $response->assertJsonCount(1, 'data');
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.sku', 'PWS-3A760');
    }

    public function test_products_search_matches_stock_code_with_or_without_spaces(): void
    {
        $context = $this->createSalesContext();

        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'WY 403',
            name: 'Space Separated Stock Code Product',
            stock: 12,
            listPrice: 175.00,
            meta: [
                'kod1' => 'FILTRE',
                'kod2' => 'YAG',
                'kod3' => 'ELEMENT',
                'stok_turu' => 'T',
            ]
        );

        $this->actingAs($context['user']);

        $compactResponse = $this->getJson('/api/products/search?limit=20&sort=stock_desc&q=wy403');

        $compactResponse->assertOk();
        $compactResponse->assertJsonCount(1, 'data');
        $compactResponse->assertJsonPath('data.0.id', $product->id);
        $compactResponse->assertJsonPath('data.0.sku', 'WY 403');

        $spacedResponse = $this->getJson('/api/products/search?limit=20&sort=stock_desc&q=wy%20403');

        $spacedResponse->assertOk();
        $spacedResponse->assertJsonCount(1, 'data');
        $spacedResponse->assertJsonPath('data.0.id', $product->id);
    }

    public function test_code_like_product_search_avoids_global_cold_visibility_scans(): void
    {
        $context = $this->createSalesContext();

        $visibleProduct = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'CS 0040',
            name: 'Visible Code Search Product',
            stock: 12,
            listPrice: 175.00,
            meta: [
                'specode4' => 'E',
            ]
        );

        $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'CS 0040 HIDDEN',
            name: 'Hidden Equivalent Product',
            stock: 8,
            listPrice: 165.00,
            meta: [
                'specode4' => 'H',
            ]
        );

        Cache::flush();
        $queries = [];
        DB::listen(function ($query) use (&$queries): void {
            $queries[] = $query->sql;
        });

        $this->actingAs($context['user']);

        $response = $this->getJson('/api/products/search?limit=20&q=cs0040');

        $response->assertOk();
        $response->assertJsonPath('data.0.id', $visibleProduct->id);
        $response->assertJsonPath('search_backend', 'db_code_fast');

        $globalLogoMarkerCounts = array_values(array_filter(
            $queries,
            fn (string $sql): bool => str_contains($sql, 'count(*) as aggregate')
                && str_contains($sql, 'from "products"')
                && ! str_contains($sql, '"products"."id" in')
        ));
        $globalSpecialCodeScans = array_values(array_filter(
            $queries,
            fn (string $sql): bool => str_contains($sql, 'select "products"."id" from "products"')
                && str_contains($sql, 'JSON_EXTRACT(products.meta')
                && str_contains($sql, 'specode4')
                && ! str_contains($sql, '"products"."id" in')
        ));

        $this->assertSame([], $globalLogoMarkerCounts, implode("\n", $globalLogoMarkerCounts));
        $this->assertSame([], $globalSpecialCodeScans, implode("\n", $globalSpecialCodeScans));
    }

    public function test_products_search_resolves_package_quantity_from_logo_units(): void
    {
        $context = $this->createSalesContext();

        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'PKG-LOGO-001',
            name: 'Logo Package Quantity Product',
            stock: 8,
            listPrice: 145.00,
            meta: [
                'kod1' => 'FILTRE',
                'kod2' => 'YAG',
                'kod3' => 'ELEMENT',
                'stok_turu' => 'T',
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'logo_units' => [
                                'units' => [
                                    [
                                        'code' => 'ADET',
                                        'name' => 'Adet',
                                        'main_unit' => 1,
                                        'convfact1' => 1,
                                        'convfact2' => 1,
                                    ],
                                    [
                                        'code' => 'PK',
                                        'name' => 'Paket',
                                        'main_unit' => 0,
                                        'convfact1' => 1,
                                        'convfact2' => 24,
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ]
        );

        $this->actingAs($context['user']);

        $response = $this->getJson('/api/products/search?limit=20&sort=stock_desc&q=PKG-LOGO-001');

        $response->assertOk();
        $response->assertJsonCount(1, 'data');
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.package_quantity', '24');
    }

    public function test_code_like_product_search_uses_normalized_database_path_when_meili_is_enabled(): void
    {
        config()->set('meilisearch.enabled', true);

        $this->mock(ProductSearchService::class, function ($mock): void {
            $mock->shouldNotReceive('shouldAttemptSearch');
            $mock->shouldNotReceive('searchProductIds');
        });

        $context = $this->createSalesContext();

        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'WY 403',
            name: 'Meili Bypass Stock Code Product',
            stock: 10,
            listPrice: 210.00,
            meta: [
                'kod1' => 'FILTRE',
                'kod2' => 'YAG',
                'kod3' => 'ELEMENT',
                'stok_turu' => 'T',
            ]
        );

        $this->actingAs($context['user']);

        $response = $this->getJson('/api/products/search?limit=20&q=wy403');

        $response->assertOk();
        $response->assertJsonCount(1, 'data');
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.sku', 'WY 403');
        $response->assertJsonPath('search_backend', 'db_code_fast');
    }

    public function test_products_search_limits_exact_code_lookup_to_same_logo_group(): void
    {
        $context = $this->createSalesContext();

        $matchedProduct = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'PWS-70800',
            name: 'Group Matched Product',
            stock: 15,
            listPrice: 155.00,
            meta: [
                'category_code' => 'W75/3x',
                'kod1' => 'FILTRE',
                'kod2' => 'YAG',
                'kod3' => 'SPIN-ON',
            ]
        );

        $sameGroupProduct = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'BOS-0451103336',
            name: 'Same Logo Group Equivalent',
            stock: 8,
            listPrice: 185.00,
            meta: [
                'category_code' => 'W75/3x',
                'kod1' => 'FILTRE',
                'kod2' => 'YAG',
                'kod3' => 'SPIN-ON',
            ]
        );

        $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'OTHER-3A302',
            name: '3A302 Other Logo Group',
            stock: 20,
            listPrice: 255.00,
            meta: [
                'category_code' => 'OTHER-GROUP',
                'kod1' => 'FILTRE',
                'kod2' => 'YAG',
                'kod3' => 'SPIN-ON',
            ]
        );

        ProductCodeAlias::query()->create([
            'product_id' => $matchedProduct->id,
            'code' => '3A302',
            'normalized_code' => '3A302',
            'code_type' => 'competitor',
            'brand_name' => 'TEST',
            'source' => 'logo',
        ]);

        $this->actingAs($context['user']);

        $response = $this->getJson('/api/products/search?limit=20&page=1&q=3A302');

        $response->assertOk();
        $response->assertJsonCount(2, 'data');
        $this->assertEqualsCanonicalizing(
            [$matchedProduct->id, $sameGroupProduct->id],
            collect($response->json('data'))->pluck('id')->all()
        );
    }

    public function test_products_search_hides_h_special_code_until_all_products_is_requested(): void
    {
        $context = $this->createSalesContext();

        $visibleProduct = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'PWS-E-VISIBLE',
            name: 'Ana Urun',
            stock: 10,
            listPrice: 100.00,
            meta: ['specode4' => 'E']
        );

        $hiddenEquivalent = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'PWS-H-EQUIVALENT',
            name: 'Muadil Urun',
            stock: 8,
            listPrice: 90.00,
            meta: ['specode4' => 'H']
        );

        ProductCodeAlias::query()->create([
            'product_id' => $hiddenEquivalent->id,
            'code' => 'MUADIL-H-001',
            'normalized_code' => 'MUADILH001',
            'code_type' => 'competitor',
            'brand_name' => 'MUADIL',
            'source' => 'logo',
        ]);

        $this->actingAs($context['user']);

        $defaultResponse = $this->getJson('/api/products/search?limit=20&sort=stock_desc');
        $defaultResponse->assertOk();
        $this->assertSame([$visibleProduct->id], collect($defaultResponse->json('data'))->pluck('id')->all());

        $defaultAliasResponse = $this->getJson('/api/products/search?limit=20&sort=stock_desc&q=MUADIL-H-001');
        $defaultAliasResponse->assertOk();
        $defaultAliasResponse->assertJsonCount(0, 'data');

        $allProductsResponse = $this->getJson('/api/products/search?limit=20&sort=stock_desc&include_equivalents=1');
        $allProductsResponse->assertOk();
        $this->assertEqualsCanonicalizing(
            [$visibleProduct->id, $hiddenEquivalent->id],
            collect($allProductsResponse->json('data'))->pluck('id')->all()
        );

        $allAliasResponse = $this->getJson('/api/products/search?limit=20&sort=stock_desc&q=MUADIL-H-001&include_equivalents=1');
        $allAliasResponse->assertOk();
        $allAliasResponse->assertJsonCount(1, 'data');
        $allAliasResponse->assertJsonPath('data.0.id', $hiddenEquivalent->id);

        $explicitHiddenFilterResponse = $this->getJson('/api/products/search?limit=20&sort=stock_desc&specode4=H');
        $explicitHiddenFilterResponse->assertOk();
        $explicitHiddenFilterResponse->assertJsonCount(1, 'data');
        $explicitHiddenFilterResponse->assertJsonPath('data.0.id', $hiddenEquivalent->id);
    }

    public function test_products_search_returns_logo_image_url_when_meta_contains_image_blob(): void
    {
        $context = $this->createSalesContext();

        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'FLT-IMG-001',
            name: 'Logo Resimli Urun',
            stock: 4,
            listPrice: 210.00,
            meta: [
                'integrations' => [
                    'logo' => [
                        'synced_at' => now()->toIso8601String(),
                        'external_ref' => 'IMG-001',
                        'payload' => [
                            'raw' => [
                                'IMAGE' => 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=',
                            ],
                        ],
                    ],
                ],
            ]
        );

        $this->actingAs($context['user']);

        $response = $this->getJson('/api/products/search?limit=20&sort=stock_desc&q=FLT-IMG-001');

        $response->assertOk();
        $response->assertJsonCount(1, 'data');
        $response->assertJsonPath('data.0.id', $product->id);
        $this->assertStringStartsWith('data:image/', (string) $response->json('data.0.image_data_url'));

        $imageUrl = (string) $response->json('data.0.image_url');
        $this->assertStringStartsWith('/api/products/'.$product->id.'/image?w=192&v=', $imageUrl);

        $imageResponse = $this->get($imageUrl);
        $imageResponse->assertOk();
        $this->assertStringStartsWith('image/', (string) $imageResponse->headers->get('Content-Type'));
        $this->assertNotEmpty($imageResponse->getContent());
    }

    public function test_products_search_extracts_image_payload_when_logo_blob_has_binary_prefix(): void
    {
        $context = $this->createSalesContext();
        $pngPayload = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=';
        $wrappedPayload = base64_encode('LOGO-BINARY-PREFIX'.base64_decode($pngPayload));

        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'FLT-IMG-WRAPPED',
            name: 'Logo Wrapped Image Product',
            stock: 4,
            listPrice: 210.00,
            meta: [
                'integrations' => [
                    'logo' => [
                        'synced_at' => now()->toIso8601String(),
                        'external_ref' => 'IMG-WRAPPED',
                        'payload' => [
                            'raw' => [
                                'LDATA' => $wrappedPayload,
                            ],
                        ],
                    ],
                ],
            ]
        );

        $this->actingAs($context['user']);

        $response = $this->getJson('/api/products/search?limit=20&sort=stock_desc&q=FLT-IMG-WRAPPED');

        $response->assertOk();
        $response->assertJsonPath('data.0.id', $product->id);
        $this->assertStringStartsWith('data:image/', (string) $response->json('data.0.image_data_url'));

        $imageUrl = (string) $response->json('data.0.image_url');
        $this->assertStringStartsWith('/api/products/'.$product->id.'/image?w=192&v=', $imageUrl);

        $imageResponse = $this->get($imageUrl);
        $imageResponse->assertOk();
        $this->assertStringStartsWith('image/', (string) $imageResponse->headers->get('Content-Type'));
        $this->assertNotEmpty($imageResponse->getContent());
    }

    public function test_products_search_returns_logo_image_url_when_meta_contains_remote_image_path(): void
    {
        $context = $this->createSalesContext();

        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'FLT-IMG-URL',
            name: 'Logo Remote Image Product',
            stock: 4,
            listPrice: 210.00,
            meta: [
                'integrations' => [
                    'logo' => [
                        'synced_at' => now()->toIso8601String(),
                        'external_ref' => 'IMG-URL',
                        'payload' => [
                            'raw' => [
                                'IMAGE_URL' => 'https://cdn.example.test/products/flt-img-url.jpg',
                            ],
                        ],
                    ],
                ],
            ]
        );

        $this->actingAs($context['user']);

        $response = $this->getJson('/api/products/search?limit=20&sort=stock_desc&q=FLT-IMG-URL');

        $response->assertOk();
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.image_url', 'https://cdn.example.test/products/flt-img-url.jpg');

        $imageResponse = $this->get('/api/products/'.$product->id.'/image?w=192');
        $imageResponse->assertRedirect('https://cdn.example.test/products/flt-img-url.jpg');
    }

    public function test_products_search_returns_logo_description_from_payload_when_product_description_missing(): void
    {
        $context = $this->createSalesContext();

        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'FLT-DES-001',
            name: 'Logo Description Product',
            stock: 5,
            listPrice: 199.00,
            meta: [
                'integrations' => [
                    'logo' => [
                        'synced_at' => now()->toIso8601String(),
                        'external_ref' => 'DESC-001',
                        'payload' => [
                            'raw' => [
                                'DESCRIPTION' => 'Logo kaynak detay metni',
                            ],
                        ],
                    ],
                ],
            ]
        );

        $this->actingAs($context['user']);

        $response = $this->getJson('/api/products/search?limit=20&sort=stock_desc&q=FLT-DES-001');

        $response->assertOk();
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.description', 'Logo kaynak detay metni');
    }

    public function test_warehouse_user_with_search_menu_can_use_product_search(): void
    {
        $context = $this->createSalesContext();

        $warehouseRole = Role::query()->firstOrCreate(
            ['slug' => 'warehouse'],
            ['name' => 'Warehouse']
        );
        $warehouseUser = User::factory()->create([
            'dealer_id' => $context['dealer']->id,
            'is_active' => true,
            'menu_permissions' => ['warehouse', 'search'],
        ]);
        $warehouseUser->roles()->sync([$warehouseRole->id]);

        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'WAREHOUSE-SEARCH-001',
            name: 'Warehouse Search Visible Product',
            stock: 9,
            listPrice: 210.00,
            meta: [
                'kod2' => 'DEPO',
            ]
        );

        $this->actingAs($warehouseUser);

        $this->getJson('/api/products/filter-options')->assertOk();

        $response = $this->getJson('/api/products/search?limit=20&q=WAREHOUSE-SEARCH-001');

        $response->assertOk();
        $response->assertJsonPath('data.0.id', $product->id);
    }

    public function test_batum_user_sees_logo_currency_as_lari_in_product_search(): void
    {
        $context = $this->createSalesContext();
        $context['user']->forceFill([
            'branch_code' => 'BATUM',
            'region_code' => 'BATUM',
        ])->save();

        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'BATUM-LARI-001',
            name: 'Batum Lari Product',
            stock: 10,
            listPrice: 250.00,
            meta: [
                'kod2' => 'BATUM',
                'kod3' => 'LARI',
            ]
        );

        DB::table('base_prices')
            ->where('product_id', $product->id)
            ->update(['currency' => '160']);

        $this->actingAs($context['user']);

        $response = $this->getJson('/api/products/search?limit=20&q=BATUM-LARI-001');

        $response->assertOk();
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.net_price', '14.71');
        $response->assertJsonPath('data.0.list_price', '14.71');
        $response->assertJsonPath('data.0.currency', 'GEL');
    }

    public function test_products_search_returns_logo_synced_at_for_dynamic_freshness_badge(): void
    {
        $context = $this->createSalesContext();
        $syncedAt = '2026-06-23T02:41:12+03:00';

        $product = $this->createProductWithMeta(
            dealer: $context['dealer'],
            brand: $context['brand'],
            category: $context['category'],
            sku: 'LOGO-FRESH-001',
            name: 'Logo Fresh Product',
            stock: 10,
            listPrice: 250.00,
            meta: [
                'integrations' => [
                    'logo' => [
                        'synced_at' => $syncedAt,
                        'external_ref' => 'LOGO-FRESH-001',
                    ],
                ],
            ]
        );

        $this->actingAs($context['user']);

        $response = $this->getJson('/api/products/search?limit=20&q=LOGO-FRESH-001');

        $response->assertOk();
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.logo_synced_at', $syncedAt);
    }

    /**
     * @return array{dealer: Dealer, user: User, brand: Brand, category: Category}
     */
    private function createSalesContext(): array
    {
        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');

        $dealer = Dealer::query()->create([
            'code' => 'DLR-META-'.Str::upper(Str::random(4)),
            'name' => 'Meta Test Dealer',
            'price_list_id' => $priceListId > 0 ? $priceListId : null,
            'is_active' => true,
        ]);

        $role = Role::query()->firstOrCreate(
            ['slug' => 'salesperson'],
            ['name' => 'Salesperson']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'is_active' => true,
        ]);
        $user->roles()->sync([$role->id]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'CR-'.Str::upper(Str::random(6)),
            'name' => 'Meta Test Customer',
            'is_active' => true,
        ]);

        $brand = Brand::query()->create([
            'name' => 'Meta Test Brand',
            'slug' => 'meta-test-brand',
            'is_active' => true,
        ]);

        $category = Category::query()->create([
            'name' => 'Meta Test Category',
            'slug' => 'meta-test-category',
            'is_active' => true,
        ]);

        return [
            'dealer' => $dealer,
            'user' => $user,
            'brand' => $brand,
            'category' => $category,
        ];
    }

    /**
     * @param  array<string, mixed>  $meta
     */
    private function createProductWithMeta(
        Dealer $dealer,
        Brand $brand,
        Category $category,
        string $sku,
        string $name,
        int $stock,
        float $listPrice,
        array $meta
    ): Product {
        $meta = array_replace_recursive([
            'specode4' => 'E',
            'integrations' => [
                'logo' => [
                    'synced_at' => now()->toIso8601String(),
                    'external_ref' => 'LOGO-'.$sku,
                ],
            ],
        ], $meta);

        $product = Product::withoutEvents(function () use ($brand, $category, $sku, $name, $meta): Product {
            return Product::query()->create([
                'brand_id' => $brand->id,
                'category_id' => $category->id,
                'sku' => $sku,
                'oem_code' => 'OEM-'.Str::upper(Str::random(6)),
                'name' => $name,
                'unit' => 'adet',
                'vat_rate' => 20.00,
                'is_active' => true,
                'meta' => $meta,
            ]);
        });

        DB::table('stock_summary')->insert([
            'product_id' => $product->id,
            'available_total' => $stock,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);

        $priceListId = (int) ($dealer->price_list_id ?? DB::table('price_lists')->where('code', 'A')->value('id'));
        if ($priceListId > 0) {
            DB::table('base_prices')->insert([
                'price_list_id' => $priceListId,
                'product_id' => $product->id,
                'list_price' => $listPrice,
                'currency' => 'TRY',
                'updated_at' => now(),
            ]);
        }

        return $product;
    }
}
