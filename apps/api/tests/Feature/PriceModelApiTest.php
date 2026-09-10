<?php

namespace Tests\Feature;

use App\Models\Campaign;
use App\Models\CampaignProduct;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\LedgerEntry;
use App\Models\Product;
use App\Models\ProductCampaignPrice;
use App\Models\ProductCodeAlias;
use App\Models\Role;
use App\Models\StockSummary;
use App\Models\User;
use App\Support\Products\ProductSearchCacheRevision;
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

    public function test_search_and_cart_use_selected_customers_logo_f_price_group(): void
    {
        $dealer = $this->createDealer('DLR-PRC-F3');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [$customer, $product] = $this->createCustomerAndProduct($dealer, $user);

        $defaultPriceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $f3PriceListId = (int) DB::table('price_lists')->insertGetId([
            'code' => 'F3',
            'name' => 'Logo F3',
            'discount_rate' => 0,
            'is_active' => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $dealer->update(['price_list_id' => $defaultPriceListId]);
        $customer->update([
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'specode2' => 'F3',
                        ],
                    ],
                ],
            ],
        ]);

        DB::table('base_prices')->insert([
            [
                'price_list_id' => $defaultPriceListId,
                'product_id' => $product->id,
                'list_price' => 112.69,
                'currency' => 'TRY',
                'updated_at' => now(),
            ],
            [
                'price_list_id' => $f3PriceListId,
                'product_id' => $product->id,
                'list_price' => 210.90,
                'currency' => 'TRY',
                'updated_at' => now(),
            ],
        ]);

        $this->actingAs($user);

        $this->getJson("/api/products/search?q={$product->sku}&limit=20&customer_id={$customer->id}")
            ->assertOk()
            ->assertJsonPath('data.0.id', $product->id)
            ->assertJsonPath('data.0.net_price', '210.90')
            ->assertJsonPath('data.0.list_price', '421.80');

        $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 1,
        ])->assertOk()
            ->assertJsonPath('items.0.unit_price', '210.90');
    }

    public function test_products_search_returns_logo_price_cards_for_hover(): void
    {
        $dealer = $this->createDealer('DLR-PRC-CARDS');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [, $product] = $this->createCustomerAndProduct($dealer, $user);

        $aPriceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $f1PriceListId = (int) DB::table('price_lists')->insertGetId([
            'code' => 'F1',
            'name' => 'Logo F1 Usta',
            'discount_rate' => 0,
            'is_active' => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        $retailPriceListId = (int) DB::table('price_lists')->insertGetId([
            'code' => 'PRK',
            'name' => 'Logo Perakende',
            'discount_rate' => 0,
            'is_active' => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $dealer->update(['price_list_id' => $aPriceListId]);
        DB::table('base_prices')->insert([
            [
                'price_list_id' => $aPriceListId,
                'product_id' => $product->id,
                'list_price' => 101.88,
                'currency' => 'TRY',
                'updated_at' => now(),
            ],
            [
                'price_list_id' => $f1PriceListId,
                'product_id' => $product->id,
                'list_price' => 166.06,
                'currency' => 'TRY',
                'updated_at' => now(),
            ],
            [
                'price_list_id' => $retailPriceListId,
                'product_id' => $product->id,
                'list_price' => 193.57,
                'currency' => 'TRY',
                'updated_at' => now(),
            ],
        ]);

        $this->actingAs($user);

        $this->getJson('/api/products/search?limit=20&q='.$product->sku)
            ->assertOk()
            ->assertJsonPath('data.0.price_cards.0.code', 'F1')
            ->assertJsonPath('data.0.price_cards.0.label', 'Usta Satış')
            ->assertJsonPath('data.0.price_cards.0.price', '166.06')
            ->assertJsonPath('data.0.price_cards.1.code', 'PRK')
            ->assertJsonPath('data.0.price_cards.1.label', 'Perakende Satış')
            ->assertJsonPath('data.0.price_cards.1.price', '193.57');
    }

    public function test_batum_price_cards_follow_updated_exchange_multiplier_after_cache_refresh(): void
    {
        $dealer = $this->createDealer('DLR-PRC-BATUM-CARDS');
        $dealer->forceFill([
            'meta' => [
                'system_settings' => [
                    'batum_exchange_rate' => '20.0000',
                    'batum_exchange_multiplier' => '0.0500',
                ],
            ],
        ])->save();
        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'branch_code' => 'BATUM',
            'region_code' => 'BATUM',
            'menu_permissions' => ['search'],
        ])->save();
        [, $product] = $this->createCustomerAndProduct($dealer);

        $aPriceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $f1PriceListId = (int) DB::table('price_lists')->insertGetId([
            'code' => 'F1',
            'name' => 'Logo F1 Usta',
            'discount_rate' => 0,
            'is_active' => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        $dealer->update(['price_list_id' => $aPriceListId]);
        DB::table('base_prices')->insert([
            [
                'price_list_id' => $aPriceListId,
                'product_id' => $product->id,
                'list_price' => 100.00,
                'currency' => 'TRY',
                'updated_at' => now(),
            ],
            [
                'price_list_id' => $f1PriceListId,
                'product_id' => $product->id,
                'list_price' => 100.00,
                'currency' => 'TRY',
                'updated_at' => now(),
            ],
        ]);

        $this->actingAs($user);

        $this->getJson('/api/products/search?limit=20&q='.$product->sku)
            ->assertOk()
            ->assertJsonPath('data.0.price_cards.0.price', '5.00')
            ->assertJsonPath('data.0.price_cards.0.currency', 'GEL');

        $dealer->forceFill([
            'meta' => [
                'system_settings' => [
                    'batum_exchange_rate' => '10.0000',
                    'batum_exchange_multiplier' => '0.1000',
                ],
            ],
        ])->save();
        ProductSearchCacheRevision::bump();

        $this->getJson('/api/products/search?limit=20&q='.$product->sku)
            ->assertOk()
            ->assertJsonPath('data.0.price_cards.0.price', '10.00')
            ->assertJsonPath('data.0.price_cards.0.currency', 'GEL');
    }

    public function test_customer_login_can_only_checkout_with_one_f_even_when_extra_sale_types_are_assigned(): void
    {
        $dealer = $this->createDealer('DLR-PRC-CUST-1F');
        [$customer, $product] = $this->createCustomerAndProduct($dealer);
        $customerUser = $this->createUserWithRole('customer', $dealer);
        $customerUser->forceFill([
            'selected_customer_id' => $customer->id,
            'customer_scope' => 'assigned',
            'menu_permissions' => ['cart', 'orders'],
            'feature_permissions' => [
                'cart.view',
                'cart.checkout',
                'cart.sale_type.detailed',
                'cart.sale_type.excluded',
                'cart.sale_type.included',
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

        $this->actingAs($customerUser);
        $cartResponse = $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 1,
        ])->assertOk();

        $this->postJson('/api/orders', [
            'cart_id' => $cartResponse->json('cart.id'),
            'customer_id' => $customer->id,
            'checkout_summary_mode' => 'excluded',
        ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['checkout_summary_mode']);
    }

    public function test_customer_price_group_falls_back_to_dealer_price_until_grouped_product_price_is_synced(): void
    {
        $dealer = $this->createDealer('DLR-PRC-F3-FALLBACK');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [$customer, $product] = $this->createCustomerAndProduct($dealer, $user);

        $defaultPriceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        DB::table('price_lists')->insert([
            'code' => 'F3',
            'name' => 'Logo F3',
            'discount_rate' => 0,
            'is_active' => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $dealer->update(['price_list_id' => $defaultPriceListId]);
        $customer->update([
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'specode' => 'F3',
                        ],
                    ],
                ],
            ],
        ]);

        DB::table('base_prices')->insert([
            'price_list_id' => $defaultPriceListId,
            'product_id' => $product->id,
            'list_price' => 112.69,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $this->getJson("/api/products/search?q={$product->sku}&limit=20&customer_id={$customer->id}")
            ->assertOk()
            ->assertJsonPath('data.0.id', $product->id)
            ->assertJsonPath('data.0.net_price', '112.69')
            ->assertJsonPath('data.0.list_price', '225.38');

        $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 1,
        ])->assertOk()
            ->assertJsonPath('items.0.unit_price', '112.69');
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

        $this->getJson('/api/products/search?limit=20&q='.$product->sku.'&customer_id='.$customer->id)
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

    public function test_logo_group_campaign_matches_new_customer_price_group_metadata(): void
    {
        $dealer = $this->createDealer('DLR-CAMPAIGN-PRICE-GROUP');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [$customer, $product] = $this->createCustomerAndProduct($dealer, $user);
        $customer->update([
            'meta' => [
                'price_group' => 'F1',
                'price_list_code' => 'F1',
            ],
        ]);

        $campaign = Campaign::query()->create([
            'source_reference' => 'LOGO-CAMPAIGN-F1-NEW-CUSTOMER',
            'code' => 'F1-NEW-CUSTOMER',
            'name' => 'F1 Yeni Cari Kampanyasi',
            'customer_group' => 'F1',
            'target_quantity' => 1,
            'discount_percent' => 10,
            'group_field' => 'price_group',
            'is_active' => true,
        ]);
        CampaignProduct::query()->create([
            'campaign_id' => $campaign->id,
            'product_id' => $product->id,
            'product_sku' => $product->sku,
        ]);

        $this->actingAs($user);

        $this->getJson("/api/customers/{$customer->id}/campaign-progress")
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.code', 'F1-NEW-CUSTOMER');
    }

    public function test_logo_group_campaign_does_not_match_stale_product_id_linked_from_code_alias(): void
    {
        $dealer = $this->createDealer('DLR-CAMPAIGN-ALIAS');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [$customer, $product] = $this->createCustomerAndProduct($dealer, $user);
        $customer->update(['meta' => ['price_group' => 'F12']]);

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);
        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 100,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);
        ProductCodeAlias::query()->create([
            'product_id' => $product->id,
            'code' => 'PWS-OIL-016',
            'normalized_code' => 'PWSOIL016',
            'code_type' => 'other',
            'source' => 'logo',
        ]);
        $campaign = Campaign::query()->create([
            'source_reference' => 'LOGO-CAMPAIGN-F12-ALIAS',
            'code' => 'F12-ALIAS',
            'name' => 'F12 Alias Kampanyasi',
            'customer_group' => 'F12',
            'target_quantity' => 5,
            'discount_percent' => 10,
            'group_field' => 'specode',
            'is_active' => true,
        ]);
        CampaignProduct::query()->create([
            'campaign_id' => $campaign->id,
            'product_id' => $product->id,
            'product_sku' => 'PWS-OIL-016',
        ]);

        $this->actingAs($user);

        $this->getJson('/api/products/search?limit=20&q='.$product->sku.'&customer_id='.$customer->id)
            ->assertOk()
            ->assertJsonPath('data.0.id', $product->id)
            ->assertJsonCount(0, 'data.0.campaigns');

        $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 5,
            'campaign_key' => 'F12-ALIAS',
        ])->assertUnprocessable()
            ->assertJsonValidationErrors(['campaign_key']);
    }

    public function test_logo_campaign_price_tiers_are_limited_to_matching_customer_price_group(): void
    {
        $dealer = $this->createDealer('DLR-CAMPAIGN-PRICE-TIER-GROUP');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [$f1Customer, $product] = $this->createCustomerAndProduct($dealer, $user);
        $f1Customer->update(['meta' => ['price_group' => 'F1']]);

        $f2Customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $user->id,
            'code' => 'CR-CAMPAIGN-TIER-F2',
            'name' => 'F2 Campaign Tier Customer',
            'is_active' => true,
            'meta' => ['price_group' => 'F2'],
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

        ProductCampaignPrice::query()->create([
            'product_id' => $product->id,
            'source_reference' => 'LOGO-F1-TIER-1',
            'campaign_key' => 'logo:f1-tier-price',
            'name' => 'F1 Logo Fiyat Kampanyasi',
            'condition' => 'p1>4',
            'min_quantity' => 5,
            'unit_price' => 166.06,
            'currency' => 'TRY',
            'priority' => 1,
            'starts_at' => today()->subDay(),
            'ends_at' => today()->addMonth(),
            'is_active' => true,
            'meta' => ['price_group' => 'F1'],
        ]);

        $this->actingAs($user);

        $this->getJson('/api/products/search?limit=20&q='.$product->sku.'&customer_id='.$f1Customer->id)
            ->assertOk()
            ->assertJsonPath('data.0.campaigns.0.name', 'F1 Logo Fiyat Kampanyasi');

        $this->getJson('/api/products/search?limit=20&q='.$product->sku.'&customer_id='.$f2Customer->id)
            ->assertOk()
            ->assertJsonCount(0, 'data.0.campaigns');

        $this->postJson('/api/cart/items', [
            'customer_id' => $f2Customer->id,
            'product_id' => $product->id,
            'quantity' => 5,
            'campaign_key' => 'logo:f1-tier-price',
        ])->assertUnprocessable()
            ->assertJsonValidationErrors(['campaign_key']);
    }

    public function test_batum_customer_matches_f12_logo_special_price_campaign(): void
    {
        $dealer = $this->createDealer('DLR-BATUM-F12-CAMPAIGN');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [, $product] = $this->createCustomerAndProduct($dealer, $user);
        $f12PriceListId = (int) DB::table('price_lists')->insertGetId([
            'code' => 'F12',
            'name' => 'Logo F12',
            'discount_rate' => 0,
            'is_active' => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        $dealer->update(['price_list_id' => $f12PriceListId]);

        DB::table('base_prices')->insert([
            'price_list_id' => $f12PriceListId,
            'product_id' => $product->id,
            'list_price' => 164.06,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $batumCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $user->id,
            'code' => '120-00-031',
            'name' => 'Batum F12 Customer',
            'is_active' => true,
            'meta' => [],
        ]);

        $otherCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $user->id,
            'code' => '120-61-031',
            'name' => 'Other Customer',
            'is_active' => true,
            'meta' => ['price_group' => 'F1'],
        ]);

        ProductCampaignPrice::query()->create([
            'product_id' => $product->id,
            'source_reference' => 'LOGO-F12-SPECIAL-1',
            'campaign_key' => 'logo:price:f12:batum-special',
            'name' => 'Batum Size Özel Fiyat',
            'condition' => null,
            'min_quantity' => 1,
            'unit_price' => 164.06,
            'currency' => 'TRY',
            'priority' => 1,
            'starts_at' => today()->subDay(),
            'ends_at' => today()->addMonth(),
            'is_active' => true,
            'meta' => ['price_group' => 'F12'],
        ]);

        $this->actingAs($user);

        $this->getJson('/api/products/search?limit=20&q='.$product->sku.'&customer_id='.$batumCustomer->id)
            ->assertOk()
            ->assertJsonPath('data.0.campaigns.0.name', 'Batum Size Özel Fiyat')
            ->assertJsonPath('data.0.campaigns.0.tiers.0.min_quantity', 1)
            ->assertJsonPath('data.0.campaigns.0.tiers.0.unit_price', '9.19')
            ->assertJsonPath('data.0.campaigns.0.tiers.0.currency', 'GEL');

        $this->getJson('/api/products/search?limit=20&q='.$product->sku.'&customer_id='.$otherCustomer->id)
            ->assertOk()
            ->assertJsonCount(0, 'data.0.campaigns');

        $this->postJson('/api/cart/items', [
            'customer_id' => $batumCustomer->id,
            'product_id' => $product->id,
            'quantity' => 1,
            'campaign_key' => 'logo:price:f12:batum-special',
        ])->assertOk()
            ->assertJsonPath('items.0.unit_price', '9.19')
            ->assertJsonPath('items.0.campaign_key', 'logo:price:f12:batum-special');
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

    public function test_logo_campaign_sync_does_not_link_products_by_code_alias(): void
    {
        config()->set('integrations.logo.product_sync_key', 'campaign-test-key');

        $dealer = $this->createDealer('DLR-CAMPAIGN-SYNC-ALIAS');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [, $product] = $this->createCustomerAndProduct($dealer, $user);
        ProductCodeAlias::query()->create([
            'product_id' => $product->id,
            'code' => 'PWS-OIL-016',
            'normalized_code' => 'PWSOIL016',
            'code_type' => 'other',
            'source' => 'logo',
        ]);

        $this->withHeader('X-Integration-Key', 'campaign-test-key')
            ->postJson('/api/integrations/logo/campaigns/sync', ['campaigns' => [[
                'source_reference' => 'SYNC-ALIAS-1',
                'code' => 'F12-ALIAS',
                'name' => 'F12 Alias Kampanyasi',
                'customer_group' => 'F12',
                'target_quantity' => 5,
                'discount_percent' => 10,
                'is_active' => true,
                'products' => ['PWS-OIL-016'],
            ]]])
            ->assertOk();

        $this->assertDatabaseHas('campaign_products', [
            'product_sku' => 'PWS-OIL-016',
            'product_id' => null,
        ]);
    }

    public function test_logo_campaign_sync_accepts_passive_snapshot_without_products_and_deactivates_campaign(): void
    {
        config()->set('integrations.logo.product_sync_key', 'campaign-test-key');

        $campaign = Campaign::query()->create([
            'source_reference' => 'SYNC-PASSIVE-1',
            'code' => 'F1-PASSIVE',
            'name' => 'F1 Passive Test',
            'customer_group' => 'F1',
            'target_quantity' => 1,
            'discount_percent' => 10,
            'is_active' => true,
        ]);

        $this->withHeader('X-Integration-Key', 'campaign-test-key')
            ->postJson('/api/integrations/logo/campaigns/sync', ['campaigns' => [[
                'source_reference' => 'SYNC-PASSIVE-1',
                'code' => 'F1-PASSIVE',
                'name' => 'F1 Passive Test',
                'customer_group' => 'F1',
                'target_quantity' => 1,
                'discount_percent' => 10,
                'is_active' => false,
                'products' => [],
            ]]])
            ->assertOk()
            ->assertJsonPath('synced', 1)
            ->assertJsonPath('deactivated', 1);

        $this->assertFalse($campaign->refresh()->is_active);
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

    public function test_order_is_blocked_when_overdue_open_account_exceeds_logo_risk_limit(): void
    {
        $dealer = $this->createDealer('DLR-RISK-001');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [$customer, $product] = $this->createCustomerAndProduct($dealer, $user);
        $customer->forceFill([
            'credit_limit' => 50000,
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'payment_term_days' => 40,
                            'open_account_risk_limit' => 50000,
                            'raw' => [
                                'PAYMENT_CODE' => '40',
                                'RISKLIMIT' => '50000',
                            ],
                        ],
                    ],
                ],
            ],
        ])->save();

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'RISK-OLD-INVOICE',
            'date' => now()->subDays(45)->toDateString(),
            'type' => 'invoice',
            'debit' => 49000,
            'credit' => 0,
            'balance_after' => 49000,
            'entry_date' => now()->subDays(45)->toDateString(),
            'entry_type' => 'debit',
            'amount' => 49000,
            'currency' => 'TRY',
            'reference_no' => 'RISK-OLD-INVOICE',
            'description' => 'Vadesi gecmis acik hesap',
        ]);

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 2000.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $cartResponse = $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 1,
        ])->assertOk();

        $this->postJson('/api/orders', [
            'cart_id' => $cartResponse->json('cart.id'),
        ])->assertUnprocessable()
            ->assertJsonValidationErrors(['customer_id']);
    }

    public function test_order_is_blocked_when_zero_day_payment_term_order_exceeds_logo_risk_limit(): void
    {
        $dealer = $this->createDealer('DLR-RISK-ZERO');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [$customer, $product] = $this->createCustomerAndProduct($dealer, $user);
        $customer->forceFill([
            'credit_limit' => 0,
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'payment_term_days' => 0,
                            'raw' => [
                                'PAYMENT_CODE' => '0',
                                'OPEN_ACCOUNT_RISK_LIMIT' => '50000',
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
            'list_price' => 58000.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $cartResponse = $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 1,
        ])->assertOk();

        $this->postJson('/api/orders', [
            'cart_id' => $cartResponse->json('cart.id'),
        ])->assertUnprocessable()
            ->assertJsonValidationErrors(['customer_id']);
    }

    public function test_order_is_allowed_when_overdue_open_account_stays_within_logo_risk_limit(): void
    {
        $dealer = $this->createDealer('DLR-RISK-002');
        $user = $this->createUserWithRole('salesperson', $dealer);
        [$customer, $product] = $this->createCustomerAndProduct($dealer, $user);
        $customer->forceFill([
            'credit_limit' => 50000,
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'payment_term_days' => 40,
                        ],
                    ],
                ],
            ],
        ])->save();

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'RISK-SMALL-INVOICE',
            'date' => now()->subDays(45)->toDateString(),
            'type' => 'invoice',
            'debit' => 49000,
            'credit' => 0,
            'balance_after' => 49000,
            'entry_date' => now()->subDays(45)->toDateString(),
            'entry_type' => 'debit',
            'amount' => 49000,
            'currency' => 'TRY',
            'reference_no' => 'RISK-SMALL-INVOICE',
            'description' => 'Vadesi gecmis acik hesap',
        ]);

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 500.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $cartResponse = $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 1,
        ])->assertOk();

        $this->postJson('/api/orders', [
            'cart_id' => $cartResponse->json('cart.id'),
        ])->assertCreated()
            ->assertJsonPath('order.customer.id', $customer->id);
    }

    public function test_admin_order_is_approved_for_the_selected_customers_branch_warehouse(): void
    {
        $dealer = $this->createDealer('DLR-ADMIN-WAREHOUSE');
        $admin = $this->createUserWithRole('admin', $dealer);
        $salesperson = $this->createUserWithRole('salesperson', $dealer);
        $salesperson->forceFill([
            'username' => 'trabzon.salesperson',
            'branch_code' => 'TRABZON',
            'branch_name' => 'Trabzon',
        ])->save();
        [$customer, $product] = $this->createCustomerAndProduct($dealer, $salesperson);
        $customer->forceFill([
            'branch_code' => 'TRABZON',
            'branch_name' => 'Trabzon',
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

        $this->actingAs($admin);
        $cart = $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 1,
            'shipping_method' => 'depo_teslim',
        ])->assertOk();

        $order = $this->postJson('/api/orders', [
            'cart_id' => $cart->json('cart.id'),
            'customer_id' => $customer->id,
        ])
            ->assertCreated()
            ->assertJsonPath('order.status', 'approved');

        $this->getJson('/api/warehouse/orders/ready?q='.$order->json('order.order_no'))
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.origin.target_warehouse_code', '2')
            ->assertJsonPath('data.0.origin.target_warehouse_name', 'TRABZON DEPO');
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
            ->assertJsonPath('items.0.unit_price', '6.91')
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
            ->assertJsonPath('data.0.net_price', '9.52')
            ->assertJsonPath('data.0.list_price', '19.04')
            ->assertJsonPath('data.0.currency', 'GEL');
    }

    public function test_admin_selected_batum_customer_search_uses_custom_exchange_multiplier(): void
    {
        $dealer = $this->createDealer('DLR-PRC-BATUM-ADMIN');
        $dealer->forceFill([
            'meta' => [
                'system_settings' => [
                    'batum_exchange_rate' => '10.0000',
                    'batum_exchange_multiplier' => '0.1000',
                ],
            ],
        ])->save();
        $admin = $this->createUserWithRole('admin', null, [
            'menu_permissions' => ['search'],
        ]);
        [$customer, $product] = $this->createCustomerAndProduct($dealer);
        $customer->forceFill([
            'code' => '120-00-777',
            'branch_code' => null,
            'region_code' => null,
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

        $this->actingAs($admin);

        $this->getJson('/api/products/search?q='.$product->sku.'&limit=20&customer_id='.$customer->id)
            ->assertOk()
            ->assertJsonPath('data.0.id', $product->id)
            ->assertJsonPath('data.0.net_price', '10.00')
            ->assertJsonPath('data.0.list_price', '20.00')
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
