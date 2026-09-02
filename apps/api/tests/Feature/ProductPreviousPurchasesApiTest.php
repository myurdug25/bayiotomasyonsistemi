<?php

namespace Tests\Feature;

use App\Models\Customer;
use App\Models\Dealer;
use App\Models\Product;
use App\Models\ProductPreviousPurchase;
use App\Models\Role;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class ProductPreviousPurchasesApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_previous_purchases_endpoint_returns_eryaz_history_for_accessible_customer(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-PREV-001',
            'name' => 'Previous Purchase Dealer',
            'is_active' => true,
        ]);
        $user = $this->createUserWithRole('salesperson', $dealer);
        $customer = $this->createCustomer($dealer, $user, '120-25-263');
        $product = $this->createProduct('CS0040');
        ProductPreviousPurchase::query()->create([
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'customer_code' => '120-25-263',
            'product_code' => 'SMP-CS0040',
            'source_database' => 'GUCSAAS2026',
            'external_ref' => 'GUCSAAS2026|120-25-263|SMP-CS0040|FT-0002|2026-08-12',
            'purchase_date' => '2026-08-12',
            'description' => 'Son alım',
            'document_no' => 'FT-0002',
            'quantity' => 5,
            'unit' => 'AD',
            'unit_price' => 230,
            'net_price' => 210.90,
            'discounts' => [10, 5],
            'gross_total' => 1150,
            'net_total' => 1054.50,
            'synced_at' => now(),
        ]);
        ProductPreviousPurchase::query()->create([
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'customer_code' => '120-25-263',
            'product_code' => 'SMP-CS0040',
            'source_database' => 'GUCSAAS2025',
            'external_ref' => 'GUCSAAS2025|120-25-263|SMP-CS0040|FT-0001|2025-03-10',
            'purchase_date' => '2025-03-10',
            'description' => 'Eski alım',
            'document_no' => 'FT-0001',
            'quantity' => 3,
            'unit' => 'AD',
            'unit_price' => 225,
            'net_price' => 210.90,
            'discounts' => [],
            'gross_total' => 675,
            'net_total' => 632.70,
            'synced_at' => now(),
        ]);
        $this->actingAs($user);

        $response = $this->getJson("/api/products/{$product->sku}/previous-purchases?customer_id={$customer->id}");

        $response->assertOk()
            ->assertJsonPath('customer_code', '120-25-263')
            ->assertJsonPath('product_code', 'CS0040')
            ->assertJsonPath('summary.purchase_count', 2)
            ->assertJsonPath('summary.last_net_price', 210.90)
            ->assertJsonPath('summary.total_quantity', 8)
            ->assertJsonPath('items.0.document_no', 'FT-0002')
            ->assertJsonPath('items.0.discounts.0', 10);
    }

    public function test_previous_purchases_endpoint_rejects_customer_outside_user_scope(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-PREV-002',
            'name' => 'Previous Purchase Dealer 2',
            'is_active' => true,
        ]);
        $user = $this->createUserWithRole('salesperson', $dealer);
        $visibleCustomer = $this->createCustomer($dealer, $user, '120-25-263');
        $hiddenCustomer = $this->createCustomer($dealer, null, '120-25-999');
        $product = $this->createProduct('CS0041');

        $this->actingAs($user);

        $this->getJson("/api/products/{$product->sku}/previous-purchases?customer_id={$hiddenCustomer->id}")
            ->assertForbidden();

        $this->assertTrue($user->canAccessCustomer($visibleCustomer));
        $this->assertFalse($user->canAccessCustomer($hiddenCustomer));
    }

    public function test_previous_purchases_query_endpoint_accepts_product_codes_with_slashes(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-PREV-004',
            'name' => 'Previous Purchase Dealer 4',
            'is_active' => true,
        ]);
        $user = $this->createUserWithRole('salesperson', $dealer);
        $customer = $this->createCustomer($dealer, $user, '120-25-264');
        $product = $this->createProduct('3A 555/1');

        ProductPreviousPurchase::query()->create([
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'customer_code' => '120-25-264',
            'product_code' => 'PWS-3A555/1',
            'source_database' => 'GUCSAAS2026',
            'external_ref' => 'GUCSAAS2026|120-25-264|PWS-3A555/1|FT-SLASH|2026-08-12',
            'purchase_date' => '2026-08-12',
            'description' => 'Slash kodlu alım',
            'document_no' => 'FT-SLASH',
            'quantity' => 2,
            'unit' => 'AD',
            'unit_price' => 100,
            'net_price' => 90,
            'discounts' => [],
            'gross_total' => 200,
            'net_total' => 180,
            'synced_at' => now(),
        ]);

        $this->actingAs($user);

        $this->getJson('/api/products/previous-purchases?customer_id='.$customer->id.'&product_code='.rawurlencode('3A 555/1'))
            ->assertOk()
            ->assertJsonPath('product_code', '3A 555/1')
            ->assertJsonPath('summary.purchase_count', 1)
            ->assertJsonPath('items.0.document_no', 'FT-SLASH');
    }

    public function test_admin_search_stock_visibility_is_not_limited_by_selected_customer_branch(): void
    {
        $admin = $this->createUserWithRole('admin', Dealer::query()->create([
            'code' => 'DLR-PREV-005',
            'name' => 'Previous Purchase Dealer 5',
            'is_active' => true,
        ]));
        $customer = $this->createCustomer($admin->dealer, $admin, '120-25-265');
        $customer->forceFill([
            'branch_code' => 'ERZURUM',
            'branch_name' => 'Erzurum',
        ])->save();
        $admin->forceFill(['selected_customer_id' => $customer->id])->save();

        $controller = app(\App\Http\Controllers\Api\ProductSearchController::class);
        $method = new \ReflectionMethod($controller, 'resolveStockVisibilityScope');
        $method->setAccessible(true);

        $this->assertNull($method->invoke($controller, $admin, $customer->id));
    }

    public function test_logo_previous_purchases_sync_upserts_rows_from_windows_bridge(): void
    {
        config(['integrations.logo.previous_purchase_sync_key' => 'prev-secret']);

        $dealer = Dealer::query()->create([
            'code' => 'DLR-PREV-003',
            'name' => 'Previous Purchase Dealer 3',
            'is_active' => true,
        ]);
        $customer = $this->createCustomer($dealer, null, '120-25-263');
        $product = $this->createProduct('CS0040');

        $payload = [
            'dealer_id' => $dealer->id,
            'records' => [
                [
                    'customer_code' => '120-25-263',
                    'product_code' => 'CS0040',
                    'source_database' => 'GUCSAAS2026',
                    'external_ref' => 'GUCSAAS2026|120-25-263|CS0040|FT-0002|2026-08-12',
                    'date' => '2026-08-12',
                    'description' => 'Son alım',
                    'document_no' => 'FT-0002',
                    'quantity' => 5,
                    'unit' => 'AD',
                    'unit_price' => 230,
                    'net_price' => 210.90,
                    'discounts' => [10, 5],
                    'gross_total' => 1150,
                    'net_total' => 1054.50,
                ],
                [
                    'customer_code' => '120-25-263',
                    'product_code' => 'CS0040',
                    'source_database' => 'GUCSAAS2026',
                    'external_ref' => 'GUCSAAS2026|120-25-263|CS0040|FT-0002|2026-08-12',
                    'date' => '2026-08-12',
                    'description' => 'Aynı satır tekrar geldi',
                    'document_no' => 'FT-0002',
                    'quantity' => 6,
                    'unit' => 'AD',
                    'unit_price' => 230,
                    'net_price' => 210.90,
                    'discounts' => [10, 5],
                    'gross_total' => 1380,
                    'net_total' => 1265.40,
                ],
            ],
        ];

        $this->postJson('/api/integrations/logo/previous-purchases/sync', $payload, [
            'X-Integration-Key' => 'prev-secret',
        ])->assertOk()
            ->assertJsonPath('received', 2)
            ->assertJsonPath('synced', 1);

        $this->assertDatabaseHas('product_previous_purchases', [
            'customer_code' => '120-25-263',
            'product_code' => 'CS0040',
            'external_ref' => 'GUCSAAS2026|120-25-263|CS0040|FT-0002|2026-08-12',
        ]);

        $syncedPurchase = ProductPreviousPurchase::query()->first();
        $this->assertSame('6.0000', $syncedPurchase?->quantity);
        $this->assertSame($customer->id, $syncedPurchase?->customer_id);
        $this->assertNull($syncedPurchase?->product_id);

        $this->postJson('/api/integrations/logo/previous-purchases/sync', [
            ...$payload,
            'records' => [[...$payload['records'][0], 'quantity' => 7, 'net_total' => 1476.30]],
        ], [
            'X-Integration-Key' => 'prev-secret',
        ])->assertOk()
            ->assertJsonPath('synced', 1);

        $this->assertSame(1, ProductPreviousPurchase::query()->count());
        $this->assertSame('7.0000', ProductPreviousPurchase::query()->first()?->quantity);
        $this->assertNotNull($customer);
        $this->assertNotNull($product);
    }

    public function test_logo_previous_purchases_sync_maps_eryaz_customer_code_from_logo_definition2(): void
    {
        config(['integrations.logo.previous_purchase_sync_key' => 'prev-secret']);

        $dealer = Dealer::query()->create([
            'code' => 'DLR-PREV-ERYAZ',
            'name' => 'Previous Purchase Eryaz Dealer',
            'is_active' => true,
        ]);
        $customer = $this->createCustomer($dealer, null, '120-36-076');
        $customer->forceFill([
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'raw' => [
                                'DEFINITION2' => '120-36-024',
                            ],
                        ],
                    ],
                ],
            ],
        ])->save();
        $product = $this->createProduct('CS0040');

        $this->postJson('/api/integrations/logo/previous-purchases/sync', [
            'dealer_id' => $dealer->id,
            'records' => [
                [
                    'customer_code' => '120-36-024',
                    'product_code' => 'CS0040',
                    'source_database' => 'GUCSAAS2026',
                    'external_ref' => 'GUCSAAS2026|120-36-024|CS0040|FT-ERYAZ|2026-08-12',
                    'date' => '2026-08-12',
                    'description' => 'Eryaz kodlu alım',
                    'document_no' => 'FT-ERYAZ',
                    'quantity' => 2,
                    'unit' => 'AD',
                    'unit_price' => 100,
                    'net_price' => 90,
                    'discounts' => [],
                    'gross_total' => 200,
                    'net_total' => 180,
                ],
            ],
        ], [
            'X-Integration-Key' => 'prev-secret',
        ])->assertOk()
            ->assertJsonPath('synced', 1);

        $this->assertDatabaseHas('product_previous_purchases', [
            'customer_id' => $customer->id,
            'customer_code' => '120-36-076',
            'product_code' => 'CS0040',
            'external_ref' => 'GUCSAAS2026|120-36-024|CS0040|FT-ERYAZ|2026-08-12',
        ]);

        $user = $this->createUserWithRole('salesperson', $dealer);
        $user->forceFill(['selected_customer_id' => $customer->id])->save();
        $customer->forceFill(['salesperson_user_id' => $user->id])->save();

        $this->actingAs($user)
            ->getJson("/api/products/{$product->sku}/previous-purchases?customer_id={$customer->id}")
            ->assertOk()
            ->assertJsonPath('customer_code', '120-36-076')
            ->assertJsonPath('summary.purchase_count', 1)
            ->assertJsonPath('items.0.document_no', 'FT-ERYAZ');
    }

    private function createUserWithRole(string $roleSlug, Dealer $dealer): User
    {
        $role = Role::query()->firstOrCreate(
            ['slug' => $roleSlug],
            ['name' => Str::headline(str_replace('_', ' ', $roleSlug))]
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'menu_permissions' => ['search'],
            'is_active' => true,
        ]);
        $user->roles()->sync([$role->id]);

        return $user;
    }

    private function createCustomer(Dealer $dealer, ?User $assignedUser, string $code): Customer
    {
        return Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => $code,
            'name' => "Customer {$code}",
            'salesperson_user_id' => $assignedUser?->id,
            'is_active' => true,
        ]);
    }

    private function createProduct(string $sku): Product
    {
        return Product::withoutEvents(fn (): Product => Product::query()->create([
            'sku' => $sku,
            'oem_code' => 'OEM-'.$sku,
            'name' => 'Previous Purchase Product '.$sku,
            'vat_rate' => 20,
            'is_active' => true,
        ]));
    }
}
