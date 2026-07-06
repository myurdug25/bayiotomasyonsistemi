<?php

namespace Tests\Feature;

use App\Models\Campaign;
use App\Models\CampaignProduct;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\Product;
use App\Models\ProductCampaignPrice;
use App\Models\Role;
use App\Models\StockSummary;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;
use Tests\TestCase;

class PriceModelApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config()->set('cache.stores.redis', ['driver' => 'array']);
        config()->set('meilisearch.enabled', false);
    }

    public function test_cart_item_requires_new_price_model_rows_when_legacy_table_is_absent(): void
    {
        $this->assertFalse(Schema::hasTable('dealer_product_price'));

        $dealer = $this->createDealer('DLR-PRC-001');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [$customer, $product] = $this->createCustomerAndProduct($dealer, $user);

        $this->actingAs($user);

        $response = $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 2,
        ]);

        $response
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['product_id'])
            ->assertJsonPath('errors.product_id.0', 'Bu ürün için fiyat gelmemiş. Logo fiyat senkronunu çalıştırın.');
    }

    public function test_cart_item_uses_base_price_from_assigned_price_list(): void
    {
        $dealer = $this->createDealer('DLR-PRC-002');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [$customer, $product] = $this->createCustomerAndProduct($dealer, $user);

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 123.45,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 1,
        ])->assertOk()
            ->assertJsonPath('items.0.unit_price', '123.45');
    }

    public function test_logo_campaign_uses_single_price_for_nine_and_ten_plus_price_for_ten(): void
    {
        $dealer = $this->createDealer('DLR-CAMPAIGN-001');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [$customer, $product] = $this->createCustomerAndProduct($dealer, $user);
        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 80,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        foreach ([
            ['ref' => '78284', 'min' => 1, 'price' => 63.06, 'condition' => null],
            ['ref' => '78355', 'min' => 10, 'price' => 52.49, 'condition' => 'p1>9'],
        ] as $tier) {
            ProductCampaignPrice::query()->create([
                'product_id' => $product->id,
                'source_reference' => $tier['ref'],
                'campaign_key' => 'logo:pws filtre kampanyası',
                'name' => 'PWS FİLTRE KAMPANYASI',
                'condition' => $tier['condition'],
                'min_quantity' => $tier['min'],
                'unit_price' => $tier['price'],
                'currency' => 'TRY',
                'priority' => 1,
                'starts_at' => today()->subDay(),
                'ends_at' => today()->addMonth(),
                'is_active' => true,
            ]);
        }

        $this->actingAs($user);

        $this->getJson('/api/products/search?limit=20&q='.$product->sku)
            ->assertOk()
            ->assertJsonPath('data.0.campaigns.0.name', 'PWS FİLTRE KAMPANYASI')
            ->assertJsonPath('data.0.campaigns.0.tiers.0.min_quantity', 1)
            ->assertJsonPath('data.0.campaigns.0.tiers.1.min_quantity', 10);

        $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 9,
            'campaign_key' => 'logo:pws filtre kampanyası',
        ])->assertOk()
            ->assertJsonPath('items.0.unit_price', '63.06')
            ->assertJsonPath('items.0.campaign_key', 'logo:pws filtre kampanyası');

        $cartResponse = $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 10,
            'campaign_key' => 'logo:pws filtre kampanyası',
        ]);

        $cartResponse->assertOk()
            ->assertJsonPath('items.0.unit_price', '52.49')
            ->assertJsonPath('items.0.line_total', '524.90');

        $orderResponse = $this->postJson('/api/orders', [
            'cart_id' => $cartResponse->json('cart.id'),
        ])->assertCreated();

        $this->assertDatabaseHas('order_items', [
            'order_id' => $orderResponse->json('order.id'),
            'product_id' => $product->id,
            'campaign_key' => 'logo:pws filtre kampanyası',
            'quantity' => 10,
            'unit_net_price' => 52.49,
        ]);
    }

    public function test_logo_group_campaign_is_limited_to_matching_customer_and_applies_discount(): void
    {
        $dealer = $this->createDealer('DLR-CAMPAIGN-GROUP');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [$f1Customer, $product] = $this->createCustomerAndProduct($dealer, $user);
        $f1Customer->update([
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'specode' => 'SERVIS',
                            'specode2' => 'F1',
                        ],
                    ],
                ],
            ],
        ]);

        $f2Customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $user->id,
            'code' => 'CR-CAMPAIGN-F2',
            'name' => 'F2 Campaign Customer',
            'is_active' => true,
            'meta' => ['specode' => 'F2'],
        ]);

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);
        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 100,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $campaign = Campaign::query()->create([
            'source_reference' => 'LOGO-CAMPAIGN-F1-5',
            'code' => 'F1-5',
            'name' => 'F1 5 Adet Kampanyasi',
            'customer_group' => 'F1',
            'target_quantity' => 5,
            'discount_percent' => 10,
            'group_field' => 'specode',
            'is_active' => true,
        ]);
        CampaignProduct::query()->create([
            'campaign_id' => $campaign->id,
            'product_id' => $product->id,
            'product_sku' => $product->sku,
        ]);

        $this->actingAs($user);

        $this->postJson('/api/cart/items', [
            'customer_id' => $f1Customer->id,
            'product_id' => $product->id,
            'quantity' => 5,
            'campaign_key' => 'F1-5',
        ])->assertOk()
            ->assertJsonPath('items.0.unit_price', '100.00')
            ->assertJsonPath('items.0.discount_rate', '10.00')
            ->assertJsonPath('items.0.line_total', '450.00')
            ->assertJsonPath('items.0.campaign_key', 'F1-5');

        $this->getJson("/api/customers/{$f1Customer->id}/campaign-progress")
            ->assertOk()
            ->assertJsonPath('data.0.code', 'F1-5')
            ->assertJsonPath('data.0.cart_quantity', 5)
            ->assertJsonPath('data.0.is_completed', true);

        $this->postJson('/api/cart/items', [
            'customer_id' => $f2Customer->id,
            'product_id' => $product->id,
            'quantity' => 5,
            'campaign_key' => 'F1-5',
        ])->assertUnprocessable()
            ->assertJsonValidationErrors(['campaign_key']);

        $this->getJson("/api/customers/{$f2Customer->id}/campaign-progress")
            ->assertOk()
            ->assertJsonCount(0, 'data');
    }

    public function test_logo_campaign_sync_requires_integration_key(): void
    {
        config()->set('integrations.logo.product_sync_key', 'campaign-test-key');

        $payload = ['campaigns' => [[
            'source_reference' => 'SYNC-SECURITY-1',
            'code' => 'F1-SYNC',
            'name' => 'F1 Sync Test',
            'customer_group' => 'F1',
            'target_quantity' => 5,
            'discount_percent' => 10,
            'is_active' => true,
            'products' => ['SYNC-SKU-1'],
        ]]];

        $this->postJson('/api/integrations/logo/campaigns/sync', $payload)
            ->assertUnauthorized();

        $this->withHeader('X-Integration-Key', 'campaign-test-key')
            ->postJson('/api/integrations/logo/campaigns/sync', $payload)
            ->assertOk()
            ->assertJsonPath('synced', 1);

        $payload['campaigns'][0]['products'] = [123];

        $this->withHeader('X-Integration-Key', 'campaign-test-key')
            ->postJson('/api/integrations/logo/campaigns/sync', $payload)
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['campaigns.0.products']);
    }

    public function test_cart_item_allows_zero_stock_when_price_exists(): void
    {
        $dealer = $this->createDealer('DLR-PRC-ZERO-STOCK');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [$customer, $product] = $this->createCustomerAndProduct($dealer, $user);
        StockSummary::query()
            ->where('product_id', $product->id)
            ->update(['available_total' => 0]);

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 123.45,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 3,
        ])->assertOk()
            ->assertJsonPath('items.0.quantity', 3)
            ->assertJsonPath('items.0.available_total', 0)
            ->assertJsonPath('items.0.unit_price', '123.45');
    }

    public function test_point_user_with_cart_order_permissions_can_submit_product_search_order(): void
    {
        $dealer = $this->createDealer('DLR-PRC-POINT-ORDER');
        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'branch_code' => 'BATUM',
            'region_code' => 'BATUM',
            'menu_permissions' => ['search', 'cart', 'orders'],
        ])->save();
        [$customer, $product] = $this->createCustomerAndProduct($dealer);

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 170.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $cartResponse = $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 2,
        ]);

        $cartResponse
            ->assertOk()
            ->assertJsonPath('cart.customer_id', $customer->id)
            ->assertJsonPath('items.0.product_id', $product->id)
            ->assertJsonPath('items.0.quantity', 2);

        $this->postJson('/api/orders', [
            'cart_id' => $cartResponse->json('cart.id'),
        ])->assertCreated()
            ->assertJsonPath('order.customer.id', $customer->id)
            ->assertJsonPath('order.status', 'pending');
    }

    public function test_point_user_can_submit_zero_stock_cart_when_price_exists(): void
    {
        $dealer = $this->createDealer('DLR-PRC-POINT-ZERO-STOCK');
        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'branch_code' => 'BATUM',
            'region_code' => 'BATUM',
            'menu_permissions' => ['search', 'cart'],
            'feature_permissions' => ['search.add_to_cart', 'cart.view', 'cart.checkout'],
        ])->save();
        [$customer, $product] = $this->createCustomerAndProduct($dealer);

        StockSummary::query()
            ->where('product_id', $product->id)
            ->update(['available_total' => 0, 'reserved_total' => 0]);

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 170.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $cartResponse = $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 2,
            'warehouse_transfer' => true,
        ]);

        $cartResponse
            ->assertOk()
            ->assertJsonPath('items.0.available_total', 0)
            ->assertJsonPath('items.0.quantity', 2);

        $this->postJson('/api/orders', [
            'cart_id' => $cartResponse->json('cart.id'),
        ])->assertCreated()
            ->assertJsonPath('order.customer.id', $customer->id)
            ->assertJsonPath('order.status', 'approved');

        $this->assertDatabaseHas('stock_summary', [
            'product_id' => $product->id,
            'available_total' => 0,
            'reserved_total' => 0,
        ]);
    }

    public function test_batum_cart_item_converts_try_price_to_lari(): void
    {
        $dealer = $this->createDealer('DLR-PRC-BATUM');
        $user = $this->createUserWithRole('salesperson', $dealer);
        $user->forceFill([
            'branch_code' => 'BATUM',
            'region_code' => 'BATUM',
        ])->save();
        [$customer, $product] = $this->createCustomerAndProduct($dealer);
        $customer->forceFill([
            'salesperson_user_id' => $user->id,
            'branch_code' => 'BATUM',
            'region_code' => 'BATUM',
        ])->save();

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 123.45,
            'currency' => '160',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 1,
        ])->assertOk()
            ->assertJsonPath('cart.currency', 'GEL')
            ->assertJsonPath('items.0.unit_price', '7.26')
            ->assertJsonPath('items.0.currency', 'GEL');
    }

    public function test_batum_products_search_converts_try_price_to_lari(): void
    {
        $dealer = $this->createDealer('DLR-PRC-BATUM-SEARCH');
        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'branch_code' => 'BATUM',
            'region_code' => 'BATUM',
            'menu_permissions' => ['search'],
        ])->save();
        [, $product] = $this->createCustomerAndProduct($dealer);
        $product->forceFill([
            'sku' => 'CS0040',
            'meta' => [
                'specode4' => 'E',
                'integrations' => [
                    'logo' => [
                        'synced_at' => now()->toIso8601String(),
                        'external_ref' => 'CS0040',
                        'payload' => [
                            'raw' => [
                                'SPECODE4' => 'E',
                            ],
                        ],
                    ],
                ],
            ],
        ])->save();

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 170.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $this->getJson('/api/products/search?q=cs0040&limit=20')
            ->assertOk()
            ->assertJsonPath('data.0.id', $product->id)
            ->assertJsonPath('data.0.net_price', '10.00')
            ->assertJsonPath('data.0.list_price', '10.00')
            ->assertJsonPath('data.0.currency', 'GEL');
    }

    public function test_cart_item_prefers_dealer_override_over_base_price(): void
    {
        $dealer = $this->createDealer('DLR-PRC-003');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [$customer, $product] = $this->createCustomerAndProduct($dealer, $user);

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 100.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        DB::table('dealer_price_overrides')->insert([
            'dealer_id' => $dealer->id,
            'product_id' => $product->id,
            'net_price' => 147.90,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 1,
        ])->assertOk()
            ->assertJsonPath('items.0.unit_price', '147.90');
    }

    public function test_cart_response_includes_logo_integration_readiness_summary(): void
    {
        $dealer = $this->createDealer('DLR-PRC-CART-LOGO');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [$customer, $product] = $this->createCustomerAndProduct($dealer, $user);

        $customer->forceFill([
            'source_system' => 'logo',
            'source_reference' => 'CUST-LOGO-REF',
            'last_synced_at' => '2026-06-22 20:30:00',
        ])->save();

        $product->forceFill([
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'synced_at' => '2026-06-22T21:10:00+03:00',
                        'external_ref' => 'ITEM-LOGO-REF',
                        'payload' => [
                            'raw' => [
                                'SPECODE4' => 'E',
                            ],
                        ],
                    ],
                ],
            ],
        ])->save();

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 100.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $cartResponse = $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 2,
        ]);

        $cartResponse
            ->assertOk()
            ->assertJsonPath('logo_integration.customer_ready', true)
            ->assertJsonPath('logo_integration.items_total', 1)
            ->assertJsonPath('logo_integration.items_ready', 1)
            ->assertJsonPath('logo_integration.items_missing', 0)
            ->assertJsonPath('logo_integration.order_will_queue', true)
            ->assertJsonPath('logo_integration.latest_product_synced_at', '2026-06-22T21:10:00+03:00')
            ->assertJsonPath('logo_integration.customer_last_synced_at', '2026-06-22T20:30:00.000000Z');

        $this->getJson('/api/cart?customer_id='.$customer->id)
            ->assertOk()
            ->assertJsonPath('logo_integration.order_will_queue', true)
            ->assertJsonPath('logo_integration.items_ready', 1);
    }

    public function test_products_search_applies_price_list_discount_rate_over_base_price(): void
    {
        $dealer = $this->createDealer('DLR-PRC-004');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [, $product] = $this->createCustomerAndProduct($dealer);

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        DB::table('price_lists')->where('id', $priceListId)->update([
            'discount_rate' => 10,
            'updated_at' => now(),
        ]);

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 200.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $response = $this->getJson('/api/products/search?limit=20&sort=stock_desc');
        $response->assertOk();
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.net_price', '180.00');
    }

    public function test_products_search_prefers_dealer_override_over_price_list_discount_rate(): void
    {
        $dealer = $this->createDealer('DLR-PRC-005');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [, $product] = $this->createCustomerAndProduct($dealer);

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        DB::table('price_lists')->where('id', $priceListId)->update([
            'discount_rate' => 10,
            'updated_at' => now(),
        ]);

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 200.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        DB::table('dealer_price_overrides')->insert([
            'dealer_id' => $dealer->id,
            'product_id' => $product->id,
            'net_price' => 133.33,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $response = $this->getJson('/api/products/search?limit=20&sort=stock_desc');
        $response->assertOk();
        $response->assertJsonPath('data.0.id', $product->id);
        $response->assertJsonPath('data.0.net_price', '133.33');
    }

    private function createDealer(string $code): Dealer
    {
        return Dealer::query()->create([
            'code' => $code,
            'name' => 'Dealer '.$code,
            'is_active' => true,
        ]);
    }

    private function createUserWithRole(string $roleSlug, ?Dealer $dealer = null): User
    {
        $role = Role::query()->firstOrCreate(
            ['slug' => $roleSlug],
            ['name' => Str::headline(str_replace('_', ' ', $roleSlug))]
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer?->id,
            'is_active' => true,
        ]);

        $user->roles()->sync([$role->id]);

        return $user;
    }

    /**
     * @return array{0: Customer, 1: Product}
     */
    private function createCustomerAndProduct(Dealer $dealer, ?User $assignedUser = null): array
    {
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'CR-'.Str::upper(Str::random(6)),
            'name' => 'Price Test Customer',
            'salesperson_user_id' => $assignedUser?->id,
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'SKU-'.Str::upper(Str::random(6)),
                'oem_code' => 'OEM-'.Str::upper(Str::random(6)),
                'name' => 'Price Test Product',
                'vat_rate' => 20,
                'is_active' => true,
                'meta' => [
                    'specode4' => 'E',
                    'integrations' => [
                        'logo' => [
                            'synced_at' => now()->toIso8601String(),
                            'external_ref' => 'PRICE-TEST',
                            'payload' => [
                                'raw' => [
                                    'SPECODE4' => 'E',
                                ],
                            ],
                        ],
                    ],
                ],
            ]);
        });

        StockSummary::query()->create([
            'product_id' => $product->id,
            'available_total' => 100,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);

        return [$customer, $product];
    }
}
