<?php

namespace Tests\Feature;

use App\Models\Brand;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\Product;
use App\Models\ProductCodeAlias;
use App\Models\Role;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\TestCase;

class PosQuickProductSearchApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_point_user_with_pos_menu_can_use_shared_product_search_endpoint(): void
    {
        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');

        $dealer = Dealer::query()->create([
            'code' => 'DLR-POS-PERM-'.Str::upper(Str::random(4)),
            'name' => 'POS Permission Test Dealer',
            'price_list_id' => $priceListId > 0 ? $priceListId : null,
            'is_active' => true,
        ]);

        $role = Role::query()->firstOrCreate(
            ['slug' => 'point'],
            ['name' => 'Point']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'menu_permissions' => ['pos'],
            'is_active' => true,
        ]);
        $user->roles()->sync([$role->id]);

        $this->actingAs($user)
            ->getJson('/api/products/search?q=POS-PERMISSION-PROBE&limit=5')
            ->assertOk()
            ->assertJsonPath('data', []);
    }

    public function test_pos_quick_search_returns_product_by_competitor_code_alias(): void
    {
        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');

        $dealer = Dealer::query()->create([
            'code' => 'DLR-POS-'.Str::upper(Str::random(4)),
            'name' => 'POS Test Dealer',
            'price_list_id' => $priceListId > 0 ? $priceListId : null,
            'is_active' => true,
        ]);

        $role = Role::query()->firstOrCreate(
            ['slug' => 'cashier'],
            ['name' => 'Cashier']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'is_active' => true,
        ]);
        $user->roles()->sync([$role->id]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'CR-'.Str::upper(Str::random(6)),
            'name' => 'POS Search Customer',
            'is_active' => true,
        ]);

        $brand = Brand::query()->create([
            'name' => 'POS Search Brand',
            'slug' => 'pos-search-brand',
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function () use ($brand): Product {
            return Product::query()->create([
                'brand_id' => $brand->id,
                'sku' => 'PWS-3A760',
                'oem_code' => '3A760',
                'name' => 'POS Quick Search Test Product',
                'unit' => 'adet',
                'vat_rate' => 20.00,
                'is_active' => true,
                'meta' => [
                    'integrations' => [
                        'logo' => [
                            'synced_at' => now()->toIso8601String(),
                            'external_ref' => '1001',
                        ],
                    ],
                ],
            ]);
        });

        ProductCodeAlias::query()->create([
            'product_id' => $product->id,
            'code' => 'WH760',
            'normalized_code' => 'WH760',
            'code_type' => 'competitor',
            'brand_name' => 'WUNDER',
            'source' => 'logo',
        ]);

        DB::table('stock_summary')->insert([
            'product_id' => $product->id,
            'available_total' => 9,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 155.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $response = $this->getJson('/api/pos/products/quick-search?q=WH760&limit=5');

        $response->assertOk();
        $response->assertJsonCount(1, 'data');
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.sku', 'PWS-3A760');
    }

    public function test_pos_quick_search_returns_logo_product_without_stock_by_default(): void
    {
        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');

        $dealer = Dealer::query()->create([
            'code' => 'DLR-POS-'.Str::upper(Str::random(4)),
            'name' => 'POS Test Dealer',
            'price_list_id' => $priceListId > 0 ? $priceListId : null,
            'is_active' => true,
        ]);

        $role = Role::query()->firstOrCreate(
            ['slug' => 'cashier'],
            ['name' => 'Cashier']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'is_active' => true,
        ]);
        $user->roles()->sync([$role->id]);

        $brand = Brand::query()->create([
            'name' => 'POS Logo Brand',
            'slug' => 'pos-logo-brand',
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function () use ($brand): Product {
            return Product::query()->create([
                'brand_id' => $brand->id,
                'sku' => 'CS0040',
                'oem_code' => null,
                'name' => 'Logo Synced Product Without Stock',
                'unit' => 'adet',
                'vat_rate' => 20.00,
                'is_active' => true,
                'meta' => [
                    'integrations' => [
                        'logo' => [
                            'synced_at' => now()->toIso8601String(),
                            'external_ref' => '1002',
                        ],
                    ],
                ],
            ]);
        });

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 420.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $response = $this->getJson('/api/pos/products/quick-search?q=CS%200040&limit=5');

        $response->assertOk();
        $response->assertJsonCount(1, 'data');
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.sku', 'CS0040');
        $response->assertJsonPath('data.0.available_total', 0);

        $legacyStockParamResponse = $this->getJson('/api/pos/products/quick-search?q=CS%200040&limit=5&in_stock=1');

        $legacyStockParamResponse->assertOk();
        $legacyStockParamResponse->assertJsonCount(1, 'data');
        $legacyStockParamResponse->assertJsonPath('data.0.id', $product->id);

        $partialCodeResponse = $this->getJson('/api/pos/products/quick-search?q=0040&limit=5');

        $partialCodeResponse->assertOk();
        $partialCodeResponse->assertJsonCount(1, 'data');
        $partialCodeResponse->assertJsonPath('data.0.id', $product->id);
    }

    public function test_pos_quick_search_matches_compact_query_against_separated_product_name(): void
    {
        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');

        $dealer = Dealer::query()->create([
            'code' => 'DLR-POS-OIL-'.Str::upper(Str::random(4)),
            'name' => 'POS Oil Dealer',
            'price_list_id' => $priceListId > 0 ? $priceListId : null,
            'is_active' => true,
        ]);

        $role = Role::query()->firstOrCreate(
            ['slug' => 'point'],
            ['name' => 'Point']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'is_active' => true,
        ]);
        $user->roles()->sync([$role->id]);

        $brand = Brand::query()->create([
            'name' => 'POS Oil Brand',
            'slug' => 'pos-oil-brand',
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function () use ($brand): Product {
            return Product::query()->create([
                'brand_id' => $brand->id,
                'sku' => 'PWS-OIL-010',
                'oem_code' => null,
                'name' => '10W-40 EXTRA SL/CF SEMI SYNTHETIC',
                'unit' => 'adet',
                'vat_rate' => 20.00,
                'is_active' => true,
                'meta' => [
                    'integrations' => [
                        'logo' => [
                            'synced_at' => now()->toIso8601String(),
                            'external_ref' => 'OIL-010',
                        ],
                    ],
                ],
            ]);
        });

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 170.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $response = $this->getJson('/api/pos/products/quick-search?q=10w40&limit=5');

        $response->assertOk();
        $response->assertJsonCount(1, 'data');
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.sku', 'PWS-OIL-010');
    }

    public function test_pos_quick_search_exact_code_uses_product_search_group_scope(): void
    {
        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');

        $dealer = Dealer::query()->create([
            'code' => 'DLR-POS-'.Str::upper(Str::random(4)),
            'name' => 'POS Test Dealer',
            'price_list_id' => $priceListId > 0 ? $priceListId : null,
            'is_active' => true,
        ]);

        $role = Role::query()->firstOrCreate(
            ['slug' => 'cashier'],
            ['name' => 'Cashier']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'is_active' => true,
        ]);
        $user->roles()->sync([$role->id]);

        $brand = Brand::query()->create([
            'name' => 'POS Group Brand',
            'slug' => 'pos-group-brand',
            'is_active' => true,
        ]);

        $mainProduct = $this->createLogoProduct($brand->id, 'CS 0040', 'CLIO 1.4', 'CLIO-GROUP', 'E');
        $sameGroupProduct = $this->createLogoProduct($brand->id, '7O 800', 'CLIO 1.4', 'CLIO-GROUP', 'E');
        $sameGroupSecondProduct = $this->createLogoProduct($brand->id, '0451103336', 'CLIO 1.4', 'CLIO-GROUP', 'E');
        $equivalentProduct = $this->createLogoProduct($brand->id, 'W 75/3', 'CLIO 1.4', 'CLIO-GROUP', 'H');

        foreach ([$mainProduct, $sameGroupProduct, $sameGroupSecondProduct, $equivalentProduct] as $product) {
            DB::table('base_prices')->insert([
                'price_list_id' => $priceListId,
                'product_id' => $product->id,
                'list_price' => 100.00,
                'currency' => 'TRY',
                'updated_at' => now(),
            ]);
        }

        $this->actingAs($user);

        $response = $this->getJson('/api/pos/products/quick-search?q=cs0040&limit=10');

        $response->assertOk();
        $response->assertJsonCount(3, 'data');
        $response->assertJsonMissing(['id' => $equivalentProduct->id]);

        $ids = collect($response->json('data'))->pluck('id')->all();
        $this->assertSame($mainProduct->id, $ids[0]);
        $this->assertContains($mainProduct->id, $ids);
        $this->assertContains($sameGroupProduct->id, $ids);
        $this->assertContains($sameGroupSecondProduct->id, $ids);
    }

    public function test_pos_quick_search_finds_logo_product_by_raw_logo_stock_code(): void
    {
        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');

        $dealer = Dealer::query()->create([
            'code' => 'DLR-POS-'.Str::upper(Str::random(4)),
            'name' => 'POS Test Dealer',
            'price_list_id' => $priceListId > 0 ? $priceListId : null,
            'is_active' => true,
        ]);

        $role = Role::query()->firstOrCreate(
            ['slug' => 'cashier'],
            ['name' => 'Cashier']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'is_active' => true,
        ]);
        $user->roles()->sync([$role->id]);

        $brand = Brand::query()->create([
            'name' => 'POS Raw Logo Brand',
            'slug' => 'pos-raw-logo-brand',
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function () use ($brand): Product {
            return Product::query()->create([
                'brand_id' => $brand->id,
                'sku' => 'PWS-PRIMARY-001',
                'oem_code' => null,
                'name' => 'Raw Logo Stock Code Product',
                'unit' => 'adet',
                'vat_rate' => 20.00,
                'is_active' => true,
                'meta' => [
                    'integrations' => [
                        'logo' => [
                            'synced_at' => now()->toIso8601String(),
                            'external_ref' => '1003',
                            'payload' => [
                                'raw' => [
                                    'STOKKODU' => 'LG-STK-7788',
                                ],
                            ],
                        ],
                    ],
                ],
            ]);
        });

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 510.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $response = $this->getJson('/api/pos/products/quick-search?q=LG-STK-7788&limit=5');

        $response->assertOk();
        $response->assertJsonCount(1, 'data');
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.sku', 'PWS-PRIMARY-001');
    }

    public function test_pos_quick_search_returns_logo_warehouse_stock_locations(): void
    {
        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');

        $dealer = Dealer::query()->create([
            'code' => 'DLR-POS-'.Str::upper(Str::random(4)),
            'name' => 'POS Test Dealer',
            'price_list_id' => $priceListId > 0 ? $priceListId : null,
            'is_active' => true,
        ]);

        $role = Role::query()->firstOrCreate(
            ['slug' => 'point'],
            ['name' => 'Point']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'is_active' => true,
            'feature_permissions' => [
                'search.stock',
                'search.stock.warehouse.erzurum_depo',
                'search.stock.warehouse.batum',
            ],
        ]);
        $user->roles()->sync([$role->id]);

        $brand = Brand::query()->create([
            'name' => 'POS Logo Stock Brand',
            'slug' => 'pos-logo-stock-brand',
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function () use ($brand): Product {
            return Product::query()->create([
                'brand_id' => $brand->id,
                'sku' => 'CS0040',
                'oem_code' => null,
                'name' => 'Logo Warehouse Stock Product',
                'unit' => 'adet',
                'vat_rate' => 20.00,
                'is_active' => true,
                'meta' => [
                    'integrations' => [
                        'logo' => [
                            'synced_at' => now()->toIso8601String(),
                            'external_ref' => '1004',
                            'payload' => [
                                'logo_stock' => [
                                    'warehouses' => [
                                        [
                                            'warehouse_code' => '1',
                                            'warehouse_name' => 'ERZURUM DEPO',
                                            'available_total' => 7,
                                            'shelf_address' => 'D.12',
                                        ],
                                        [
                                            'warehouse_code' => '4',
                                            'warehouse_name' => 'BATUM DEPO',
                                            'available_total' => 3,
                                            'shelf_address' => 'B.4',
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
            'available_total' => 10,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 170.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $response = $this->getJson('/api/pos/products/quick-search?q=CS0040&limit=5');

        $response->assertOk();
        $response->assertJsonPath('data.0.available_total', 10);
        $response->assertJsonPath('data.0.stock_locations.0.branch', 'ERZURUM DEPO');
        $response->assertJsonPath('data.0.stock_locations.0.stock', 7);
        $response->assertJsonPath('data.0.stock_locations.0.shelf_address', 'D.12');
        $response->assertJsonPath('data.0.stock_locations.1.branch', 'BATUM DEPO');
        $response->assertJsonPath('data.0.stock_locations.1.stock', 3);
        $response->assertJsonPath('data.0.stock_locations.1.shelf_address', 'B.4');
    }

    public function test_erzurum_hizlisatis_search_shows_point_and_depo_but_pos_uses_only_point(): void
    {
        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POS-ERZ-POINT-'.Str::upper(Str::random(4)),
            'name' => 'POS Erzurum Point Dealer',
            'price_list_id' => $priceListId > 0 ? $priceListId : null,
            'is_active' => true,
        ]);
        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'username' => 'erzurum.hizlisatis',
            'branch_code' => 'ERZURUM',
            'branch_name' => 'Erzurum',
            'is_active' => true,
        ]);
        $user->roles()->sync([
            Role::query()->firstOrCreate(['slug' => 'point'], ['name' => 'Point'])->id,
        ]);
        $brand = Brand::query()->create([
            'name' => 'POS Erzurum Point Brand',
            'slug' => 'pos-erzurum-point-brand',
            'is_active' => true,
        ]);
        $product = $this->createLogoProduct($brand->id, 'CS0040-POINT', 'Erzurum Point Stock Product', 'POINT-GROUP', 'E');
        $meta = $product->meta;
        data_set($meta, 'integrations.logo.payload.logo_stock.warehouses', [
            [
                'warehouse_code' => '0',
                'warehouse_name' => 'ERZURUM POINT',
                'available_total' => 8,
                'shelf_address' => 'LEGACY-POINT',
            ],
            [
                'warehouse_code' => '1',
                'warehouse_name' => 'ERZURUM DEPO',
                'available_total' => 99,
                'shelf_address' => 'WRONG-DEPO',
            ],
        ]);
        data_set($meta, 'integrations.logo.payload.raw.RAF250', 'POINT-RAF-250');
        $product->forceFill(['meta' => $meta])->saveQuietly();

        DB::table('stock_summary')->insert([
            'product_id' => $product->id,
            'available_total' => 107,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);
        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 210.90,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user)
            ->getJson('/api/products/search?q=CS0040-POINT&limit=5')
            ->assertOk()
            ->assertJsonPath('data.0.available_total', 107)
            ->assertJsonCount(2, 'data.0.stock_locations')
            ->assertJsonPath('data.0.stock_locations.0.branch', 'ERZURUM POINT')
            ->assertJsonPath('data.0.stock_locations.0.stock', 8)
            ->assertJsonPath('data.0.stock_locations.0.shelf_address', 'POINT-RAF-250')
            ->assertJsonPath('data.0.stock_locations.1.branch', 'ERZURUM DEPO')
            ->assertJsonPath('data.0.stock_locations.1.stock', 99);

        $this->actingAs($user)
            ->getJson('/api/pos/products/quick-search?q=CS0040-POINT&limit=5&code_only=1')
            ->assertOk()
            ->assertJsonPath('data.0.available_total', 8)
            ->assertJsonCount(1, 'data.0.stock_locations')
            ->assertJsonPath('data.0.stock_locations.0.branch', 'ERZURUM POINT')
            ->assertJsonPath('data.0.stock_locations.0.shelf_address', 'POINT-RAF-250');
    }

    public function test_pos_customer_selection_payload_includes_dealer_id_for_admin_context(): void
    {
        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');

        $dealer = Dealer::query()->create([
            'code' => 'DLR-POS-CUSTOMER-'.Str::upper(Str::random(4)),
            'name' => 'POS Customer Dealer',
            'price_list_id' => $priceListId > 0 ? $priceListId : null,
            'is_active' => true,
        ]);

        $role = Role::query()->firstOrCreate(
            ['slug' => 'admin'],
            ['name' => 'Admin']
        );

        $user = User::factory()->create([
            'dealer_id' => null,
            'is_active' => true,
        ]);
        $user->roles()->sync([$role->id]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'POS-DEALER-CTX',
            'name' => 'POS Dealer Context Customer',
            'source_system' => 'logo',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $response = $this->getJson('/api/pos/customers?q=POS-DEALER-CTX&source_system=logo&limit=5');

        $response->assertOk();
        $response->assertJsonPath('data.0.id', $customer->id);
        $response->assertJsonPath('data.0.dealer_id', $dealer->id);
    }

    public function test_admin_pos_quick_search_uses_selected_customer_dealer_context(): void
    {
        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');

        $dealer = Dealer::query()->create([
            'code' => 'DLR-POS-ADMIN-'.Str::upper(Str::random(4)),
            'name' => 'POS Admin Dealer',
            'price_list_id' => $priceListId > 0 ? $priceListId : null,
            'is_active' => true,
        ]);

        $role = Role::query()->firstOrCreate(
            ['slug' => 'admin'],
            ['name' => 'Admin']
        );

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'POS-ADMIN-CUSTOMER',
            'name' => 'POS Admin Context Customer',
            'is_active' => true,
        ]);

        $user = User::factory()->create([
            'dealer_id' => null,
            'selected_customer_id' => $customer->id,
            'is_active' => true,
        ]);
        $user->roles()->sync([$role->id]);

        $brand = Brand::query()->create([
            'name' => 'POS Admin Brand',
            'slug' => 'pos-admin-brand',
            'is_active' => true,
        ]);

        $product = $this->createLogoProduct($brand->id, 'ADM-1401', 'Admin Context Product', 'ADMIN-GROUP', 'D');

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 210.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $response = $this->getJson('/api/pos/products/quick-search?q=ADM-1401&limit=5&code_only=1');

        $response->assertOk();
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.sku', 'ADM-1401');
    }

    public function test_admin_pos_quick_search_uses_selected_customer_branch_stock_only(): void
    {
        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POS-STOCK-'.Str::upper(Str::random(4)),
            'name' => 'POS Stock Scope Dealer',
            'price_list_id' => $priceListId > 0 ? $priceListId : null,
            'is_active' => true,
        ]);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => '120-00-001',
            'name' => 'Batum Customer',
            'is_active' => true,
        ]);
        $admin = User::factory()->create([
            'dealer_id' => null,
            'selected_customer_id' => $customer->id,
            'is_active' => true,
        ]);
        $admin->roles()->sync([
            Role::query()->firstOrCreate(['slug' => 'admin'], ['name' => 'Admin'])->id,
        ]);
        $brand = Brand::query()->create([
            'name' => 'POS Branch Stock Brand',
            'slug' => 'pos-branch-stock-brand',
            'is_active' => true,
        ]);
        $product = $this->createLogoProduct($brand->id, 'BRANCH-1401', 'Branch Stock Product', 'BRANCH-GROUP', 'E');
        $meta = $product->meta;
        data_set($meta, 'integrations.logo.payload.logo_stock.warehouses', [
            [
                'warehouse_code' => '1',
                'warehouse_name' => 'ERZURUM DEPO',
                'available_total' => 120,
                'shelf_address' => 'E.1',
            ],
            [
                'warehouse_code' => '4',
                'warehouse_name' => 'BATUM DEPO',
                'available_total' => 7,
                'shelf_address' => 'B.4',
            ],
        ]);
        data_set($meta, 'integrations.logo.payload.raw.RAF995', 'BATUM-RAF-995');
        $product->forceFill(['meta' => $meta])->saveQuietly();
        DB::table('stock_summary')->insert([
            'product_id' => $product->id,
            'available_total' => 127,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);
        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 210.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($admin)
            ->getJson('/api/pos/products/quick-search?q=BRANCH-1401&limit=5&code_only=1')
            ->assertOk()
            ->assertJsonPath('data.0.available_total', 7)
            ->assertJsonCount(1, 'data.0.stock_locations')
            ->assertJsonPath('data.0.stock_locations.0.branch', 'BATUM DEPO')
            ->assertJsonPath('data.0.stock_locations.0.shelf_address', 'BATUM-RAF-995');
    }

    public function test_admin_pos_quick_search_explicit_customer_overrides_stale_session_customer(): void
    {
        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POS-SWITCH-'.Str::upper(Str::random(4)),
            'name' => 'POS Switch Dealer',
            'price_list_id' => $priceListId > 0 ? $priceListId : null,
            'is_active' => true,
        ]);
        $staleCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => '120-25-001',
            'name' => 'Erzurum Stale Customer',
            'branch_code' => 'ERZURUM',
            'is_active' => true,
        ]);
        $batumCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => '120-00-002',
            'name' => 'Batum Requested Customer',
            'branch_code' => 'BATUM',
            'is_active' => true,
        ]);
        $admin = User::factory()->create([
            'dealer_id' => null,
            'selected_customer_id' => $staleCustomer->id,
            'is_active' => true,
        ]);
        $admin->roles()->sync([
            Role::query()->firstOrCreate(['slug' => 'admin'], ['name' => 'Admin'])->id,
        ]);
        $brand = Brand::query()->create([
            'name' => 'POS Switch Brand',
            'slug' => 'pos-switch-brand',
            'is_active' => true,
        ]);
        $product = $this->createLogoProduct($brand->id, 'SWITCH-1401', 'Switch Stock Product', 'SWITCH-GROUP', 'E');
        $meta = $product->meta;
        data_set($meta, 'integrations.logo.payload.logo_stock.warehouses', [
            [
                'warehouse_code' => '1',
                'warehouse_name' => 'ERZURUM DEPO',
                'available_total' => 120,
                'shelf_address' => 'E.1',
            ],
            [
                'warehouse_code' => '4',
                'warehouse_name' => 'BATUM DEPO',
                'available_total' => 9,
                'shelf_address' => 'B.4',
            ],
        ]);
        data_set($meta, 'integrations.logo.payload.raw.RAF995', 'BATUM-RAF-995');
        $product->forceFill(['meta' => $meta])->saveQuietly();
        DB::table('stock_summary')->insert([
            'product_id' => $product->id,
            'available_total' => 129,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);
        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 210.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($admin)
            ->getJson('/api/pos/products/quick-search?q=SWITCH-1401&limit=5&code_only=1&customer_id='.$batumCustomer->id)
            ->assertOk()
            ->assertJsonPath('data.0.available_total', 9)
            ->assertJsonCount(1, 'data.0.stock_locations')
            ->assertJsonPath('data.0.stock_locations.0.branch', 'BATUM DEPO')
            ->assertJsonPath('data.0.stock_locations.0.shelf_address', 'BATUM-RAF-995');
    }

    public function test_admin_shared_pos_search_uses_trabzon_and_samsun_customer_stock_scope(): void
    {
        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POS-TRB-SAM-'.Str::upper(Str::random(4)),
            'name' => 'POS Trabzon Samsun Scope Dealer',
            'price_list_id' => $priceListId > 0 ? $priceListId : null,
            'is_active' => true,
        ]);
        $staleCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => '120-25-901',
            'name' => 'Erzurum Stale Customer',
            'branch_code' => 'ERZURUM',
            'is_active' => true,
        ]);
        $trabzonCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => '120-61-901',
            'name' => 'Trabzon Requested Customer',
            'is_active' => true,
        ]);
        $samsunCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => '120-55-901',
            'name' => 'Samsun Requested Customer',
            'is_active' => true,
        ]);
        $admin = User::factory()->create([
            'dealer_id' => null,
            'selected_customer_id' => $staleCustomer->id,
            'is_active' => true,
        ]);
        $admin->roles()->sync([
            Role::query()->firstOrCreate(['slug' => 'admin'], ['name' => 'Admin'])->id,
        ]);
        $brand = Brand::query()->create([
            'name' => 'POS Shared Branch Scope Brand',
            'slug' => 'pos-shared-branch-scope-brand',
            'is_active' => true,
        ]);
        $product = $this->createLogoProduct(
            $brand->id,
            'SHARED-BRANCH-1401',
            'Shared Branch Stock Product',
            'SHARED-BRANCH-GROUP',
            'E'
        );
        $meta = $product->meta;
        data_set($meta, 'integrations.logo.payload.logo_stock.warehouses', [
            [
                'warehouse_code' => '1',
                'warehouse_name' => 'ERZURUM DEPO',
                'available_total' => 120,
                'shelf_address' => 'E.1',
            ],
            [
                'warehouse_code' => '2',
                'warehouse_name' => 'TRABZON DEPO',
                'available_total' => 61,
                'shelf_address' => 'T.61',
            ],
            [
                'warehouse_code' => '3',
                'warehouse_name' => 'SAMSUN DEPO',
                'available_total' => 55,
                'shelf_address' => 'S.55',
            ],
        ]);
        // Logo's warehouse rows can retain the same legacy/general shelf.
        // Admin POS must use the selected customer's branch-specific RAF field.
        data_set($meta, 'integrations.logo.payload.raw.RAF61', 'TRABZON-RAF-61');
        data_set($meta, 'integrations.logo.payload.raw.raf55', 'SAMSUN-RAF-55');
        $product->forceFill(['meta' => $meta])->saveQuietly();
        DB::table('stock_summary')->insert([
            'product_id' => $product->id,
            'available_total' => 236,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);
        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 210.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($admin)
            ->getJson('/api/products/search?q=SHARED-BRANCH-1401&limit=5&customer_id='.$trabzonCustomer->id)
            ->assertOk()
            ->assertJsonPath('data.0.available_total', 61)
            ->assertJsonCount(1, 'data.0.stock_locations')
            ->assertJsonPath('data.0.stock_locations.0.branch', 'TRABZON DEPO')
            ->assertJsonPath('data.0.stock_locations.0.shelf_address', 'T.61');

        $this->actingAs($admin)
            ->getJson('/api/pos/products/quick-search?q=SHARED-BRANCH-1401&limit=5&code_only=1&customer_id='.$trabzonCustomer->id)
            ->assertOk()
            ->assertJsonPath('data.0.available_total', 61)
            ->assertJsonCount(1, 'data.0.stock_locations')
            ->assertJsonPath('data.0.stock_locations.0.branch', 'TRABZON DEPO')
            ->assertJsonPath('data.0.stock_locations.0.shelf_address', 'TRABZON-RAF-61');

        $this->actingAs($admin)
            ->getJson('/api/products/search?q=SHARED-BRANCH-1401&limit=5&customer_id='.$samsunCustomer->id)
            ->assertOk()
            ->assertJsonPath('data.0.available_total', 55)
            ->assertJsonCount(1, 'data.0.stock_locations')
            ->assertJsonPath('data.0.stock_locations.0.branch', 'SAMSUN DEPO')
            ->assertJsonPath('data.0.stock_locations.0.shelf_address', 'S.55');

        $this->actingAs($admin)
            ->getJson('/api/pos/products/quick-search?q=SHARED-BRANCH-1401&limit=5&code_only=1&customer_id='.$samsunCustomer->id)
            ->assertOk()
            ->assertJsonPath('data.0.available_total', 55)
            ->assertJsonCount(1, 'data.0.stock_locations')
            ->assertJsonPath('data.0.stock_locations.0.branch', 'SAMSUN DEPO')
            ->assertJsonPath('data.0.stock_locations.0.shelf_address', 'SAMSUN-RAF-55');
    }

    private function createLogoProduct(int $brandId, string $sku, string $name, string $groupCode, string $specode4): Product
    {
        return Product::withoutEvents(function () use ($brandId, $sku, $name, $groupCode, $specode4): Product {
            return Product::query()->create([
                'brand_id' => $brandId,
                'sku' => $sku,
                'oem_code' => null,
                'name' => $name,
                'unit' => 'adet',
                'vat_rate' => 20.00,
                'is_active' => true,
                'meta' => [
                    'specode4' => $specode4,
                    'category_code' => $groupCode,
                    'integrations' => [
                        'logo' => [
                            'synced_at' => now()->toIso8601String(),
                            'external_ref' => 'LOGO-'.$sku,
                            'payload' => [
                                'category_code' => $groupCode,
                                'raw' => [
                                    'SPECODE4' => $specode4,
                                    'STGRPCODE' => $groupCode,
                                ],
                            ],
                        ],
                    ],
                ],
            ]);
        });
    }
}
