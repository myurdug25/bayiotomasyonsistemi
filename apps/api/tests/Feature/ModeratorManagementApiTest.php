<?php

namespace Tests\Feature;

use App\Models\BasePrice;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\Order;
use App\Models\OrderItem;
use App\Models\PriceList;
use App\Models\Product;
use App\Models\Role;
use App\Models\StockSummary;
use App\Models\User;
use App\Support\MenuPermissions;
use App\Support\Products\ProductSearchCacheRevision;
use Database\Seeders\RoleSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;
use Tests\TestCase;

class ModeratorManagementApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_global_admin_can_update_complaint_recipient_for_all_dealers(): void
    {
        $this->seed(RoleSeeder::class);

        $firstDealer = $this->createDealer('DLR-MAIL-001');
        $secondDealer = $this->createDealer('DLR-MAIL-002');
        $admin = $this->createUserWithRole('admin', null, [
            'menu_permissions' => ['moderator'],
        ]);

        $this->actingAs($admin)
            ->patchJson('/api/moderator/system-settings', [
                'complaint_mail_to' => 'farukcelik@gucsa.com.tr',
            ])
            ->assertOk()
            ->assertJsonPath('system_settings.complaint_mail_to', 'farukcelik@gucsa.com.tr');

        $this->assertSame(
            'farukcelik@gucsa.com.tr',
            data_get($firstDealer->fresh()->meta, 'system_settings.complaint_mail_to')
        );
        $this->assertSame(
            'farukcelik@gucsa.com.tr',
            data_get($secondDealer->fresh()->meta, 'system_settings.complaint_mail_to')
        );
    }

    public function test_global_admin_can_update_batum_exchange_rate_for_all_dealers(): void
    {
        $this->seed(RoleSeeder::class);

        $firstDealer = $this->createDealer('DLR-BATUM-RATE-001');
        $secondDealer = $this->createDealer('DLR-BATUM-RATE-002');
        $admin = $this->createUserWithRole('admin', null, [
            'menu_permissions' => ['moderator'],
        ]);

        $this->actingAs($admin)
            ->patchJson('/api/moderator/system-settings', [
                'complaint_mail_to' => 'farukcelik@gucsa.com.tr',
                'batum_exchange_rate' => '17,8571',
                'batum_exchange_multiplier' => '0,056',
            ])
            ->assertOk()
            ->assertJsonPath('system_settings.complaint_mail_to', 'farukcelik@gucsa.com.tr')
            ->assertJsonPath('system_settings.batum_exchange_rate', '17.8571')
            ->assertJsonPath('system_settings.batum_exchange_multiplier', '0.0560');

        $this->assertSame(
            '17.8571',
            data_get($firstDealer->fresh()->meta, 'system_settings.batum_exchange_rate')
        );
        $this->assertSame(
            '0.0560',
            data_get($firstDealer->fresh()->meta, 'system_settings.batum_exchange_multiplier')
        );
        $this->assertSame(
            '17.8571',
            data_get($secondDealer->fresh()->meta, 'system_settings.batum_exchange_rate')
        );
        $this->assertSame(
            '0.0560',
            data_get($secondDealer->fresh()->meta, 'system_settings.batum_exchange_multiplier')
        );

        $this->getJson('/api/moderator/overview')
            ->assertOk()
            ->assertJsonPath('system_settings.batum_exchange_rate', '17.8571')
            ->assertJsonPath('system_settings.batum_exchange_multiplier', '0.0560');
    }

    public function test_updating_batum_exchange_settings_refreshes_product_search_prices(): void
    {
        $this->seed(RoleSeeder::class);

        $this->createDealer('DLR-BATUM-CACHE-001');
        $admin = $this->createUserWithRole('admin', null, [
            'menu_permissions' => ['moderator'],
        ]);
        $before = ProductSearchCacheRevision::current();

        $this->actingAs($admin)
            ->patchJson('/api/moderator/system-settings', [
                'batum_exchange_rate' => '15,3846',
                'batum_exchange_multiplier' => '0,065',
            ])
            ->assertOk();

        $this->assertNotSame($before, ProductSearchCacheRevision::current());
    }

    public function test_global_admin_can_update_batum_exchange_settings_without_complaint_recipient(): void
    {
        $this->seed(RoleSeeder::class);

        $firstDealer = $this->createDealer('DLR-BATUM-RATE-ONLY-001');
        $secondDealer = $this->createDealer('DLR-BATUM-RATE-ONLY-002');
        $admin = $this->createUserWithRole('admin', null, [
            'menu_permissions' => ['moderator'],
        ]);

        $this->actingAs($admin)
            ->patchJson('/api/moderator/system-settings', [
                'batum_exchange_rate' => '17,8571',
                'batum_exchange_multiplier' => '0,056',
            ])
            ->assertOk()
            ->assertJsonPath('system_settings.batum_exchange_rate', '17.8571')
            ->assertJsonPath('system_settings.batum_exchange_multiplier', '0.0560');

        $this->assertSame(
            '17.8571',
            data_get($firstDealer->fresh()->meta, 'system_settings.batum_exchange_rate')
        );
        $this->assertSame(
            '0.0560',
            data_get($firstDealer->fresh()->meta, 'system_settings.batum_exchange_multiplier')
        );
        $this->assertSame(
            '17.8571',
            data_get($secondDealer->fresh()->meta, 'system_settings.batum_exchange_rate')
        );
        $this->assertSame(
            '0.0560',
            data_get($secondDealer->fresh()->meta, 'system_settings.batum_exchange_multiplier')
        );
    }

    public function test_global_admin_can_save_batum_exchange_values_when_rate_and_multiplier_are_entered_reversed(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-BATUM-REVERSED-001');
        $admin = $this->createUserWithRole('admin', null, [
            'menu_permissions' => ['moderator'],
        ]);

        $this->actingAs($admin)
            ->patchJson('/api/moderator/system-settings', [
                'batum_exchange_rate' => '0,065',
                'batum_exchange_multiplier' => '15,3846',
            ])
            ->assertOk()
            ->assertJsonPath('system_settings.batum_exchange_rate', '15.3846')
            ->assertJsonPath('system_settings.batum_exchange_multiplier', '0.0650');

        $this->assertSame(
            '15.3846',
            data_get($dealer->fresh()->meta, 'system_settings.batum_exchange_rate')
        );
        $this->assertSame(
            '0.0650',
            data_get($dealer->fresh()->meta, 'system_settings.batum_exchange_multiplier')
        );
    }

    public function test_moderator_can_read_overview_and_manage_users_and_customers(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-MOD-001');
        $moderator = $this->createUserWithRole('moderator');
        $salesperson = $this->createUserWithRole('salesperson', $dealer);
        $customer = $this->createCustomer($dealer, 'MOD-CUST-001', 'Mod Test Cari', $salesperson);

        $this->actingAs($moderator);

        $this->getJson('/api/moderator/overview')
            ->assertOk()
            ->assertJsonPath('summary.users_total', 2)
            ->assertJsonPath('summary.customers_total', 1)
            ->assertJsonPath('summary.salespeople_total', 1)
            ->assertJsonPath('summary.assigned_customers_total', 1)
            ->assertJsonFragment([
                'slug' => 'salesperson',
            ])
            ->assertJsonFragment([
                'code' => $dealer->code,
                'name' => $dealer->name,
            ])
            ->assertJsonFragment([
                'code' => $customer->code,
                'name' => $customer->name,
            ]);

        $userResponse = $this->postJson('/api/moderator/users', [
            'dealer_id' => $dealer->id,
            'customer_scope' => 'branch',
            'region_code' => 'KARADENIZ',
            'branch_code' => 'TRABZON',
            'name' => 'Yeni Point',
            'username' => 'point.yeni',
            'email' => 'new-point@example.test',
            'phone' => '05320000001',
            'password' => 'PointUser@2026',
            'role_slugs' => ['point'],
            'menu_permissions' => ['pos'],
            'is_active' => true,
        ]);

        $createdUserId = (int) $userResponse->json('data.id');

        $userResponse
            ->assertCreated()
            ->assertJsonPath('data.name', 'Yeni Point')
            ->assertJsonPath('data.dealer.id', $dealer->id)
            ->assertJsonPath('data.roles.0.slug', 'point')
            ->assertJsonPath('data.customer_scope', 'branch')
            ->assertJsonPath('data.region_code', 'KARADENIZ')
            ->assertJsonPath('data.branch_code', 'TRABZON');

        $customerResponse = $this->postJson('/api/moderator/customers', [
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $salesperson->id,
            'region_code' => 'KARADENIZ',
            'branch_code' => 'TRABZON',
            'code' => 'MOD-CUST-002',
            'name' => 'Mod Yeni Cari',
            'contact_name' => 'Ayşe Test',
            'phone' => '05320000002',
            'city' => 'Erzurum',
            'district' => 'Yakutiye',
            'tax_number' => '1234567890',
            'special_discount_rate' => 12.5,
            'address' => 'Merkez Mah.',
            'iban' => 'TR110000000000000000000001',
            'is_active' => true,
        ]);

        $createdCustomerId = (int) $customerResponse->json('data.id');

        $customerResponse
            ->assertCreated()
            ->assertJsonPath('data.code', 'MOD-CUST-002')
            ->assertJsonPath('data.source_system', 'b2b')
            ->assertJsonPath('data.sync_status', 'pending')
            ->assertJsonPath('data.salesperson.id', $salesperson->id)
            ->assertJsonPath('data.region_code', 'KARADENIZ')
            ->assertJsonPath('data.branch_code', 'TRABZON')
            ->assertJsonPath('data.special_discount_rate', '12.50')
            ->assertJsonPath('data.address', 'Merkez Mah.')
            ->assertJsonPath('data.iban', 'TR110000000000000000000001')
            ->assertJsonPath('customer.address', 'Merkez Mah.')
            ->assertJsonPath('customer.iban', 'TR110000000000000000000001')
            ->assertJsonPath('customer.special_discount_rate', '12.50')
            ->assertJsonPath('customer.meta.address', 'Merkez Mah.')
            ->assertJsonPath('customer.meta.iban', 'TR110000000000000000000001')
            ->assertJsonPath('customer.meta.special_discount_rate', '12.50');

        $this->patchJson("/api/moderator/users/{$createdUserId}", [
            'dealer_id' => $dealer->id,
            'customer_scope' => 'region',
            'region_code' => 'DOGU-KARADENIZ',
            'name' => 'Yeni Point Güncel',
            'role_slugs' => ['point'],
            'menu_permissions' => ['pos'],
        ])
            ->assertOk()
            ->assertJsonPath('data.name', 'Yeni Point Güncel')
            ->assertJsonPath('data.roles.0.slug', 'point')
            ->assertJsonPath('data.menu_permissions.0', 'pos')
            ->assertJsonPath('data.customer_scope', 'region')
            ->assertJsonPath('data.region_code', 'DOGU-KARADENIZ');

        $this->postJson("/api/moderator/users/{$createdUserId}/reset-password", [
            'password' => 'PointReset@2026',
        ])
            ->assertOk();

        $this->assertTrue(
            Hash::check('PointReset@2026', User::query()->findOrFail($createdUserId)->password)
        );

        $this->patchJson("/api/moderator/customers/{$createdCustomerId}", [
            'salesperson_user_id' => null,
            'branch_code' => 'SAMSUN',
            'name' => 'Mod Yeni Cari Güncel',
            'special_discount_rate' => 7.25,
        ])
            ->assertOk()
            ->assertJsonPath('data.name', 'Mod Yeni Cari Güncel')
            ->assertJsonPath('data.salesperson.id', null)
            ->assertJsonPath('data.branch_code', 'SAMSUN')
            ->assertJsonPath('data.special_discount_rate', '7.25');

        $this->deleteJson("/api/moderator/users/{$createdUserId}")
            ->assertOk()
            ->assertJsonPath('message', 'Kullanıcı silindi.');

        $this->assertDatabaseMissing('users', [
            'id' => $createdUserId,
        ]);
    }

    public function test_moderator_can_create_user_with_explicit_role_selection(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-MOD-ROLE');
        $moderator = $this->createUserWithRole('moderator');

        $this->actingAs($moderator);

        $this->postJson('/api/moderator/users', [
            'dealer_id' => $dealer->id,
            'customer_scope' => 'assigned',
            'branch_code' => 'ERZURUM',
            'name' => 'Role Selected Salesperson',
            'username' => 'role.selected.sales',
            'password' => 'SalesRole@2026',
            'role_slugs' => ['salesperson'],
            'menu_permissions' => ['dashboard', 'search'],
            'is_active' => true,
        ])
            ->assertCreated()
            ->assertJsonPath('data.roles.0.slug', 'salesperson')
            ->assertJsonPath('data.customer_scope', 'assigned')
            ->assertJsonPath('data.menu_permissions', ['dashboard', 'search']);
    }

    public function test_moderator_can_update_user_password_from_edit_payload_with_six_character_password(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-MOD-EDIT-PASS');
        $moderator = $this->createUserWithRole('moderator');
        $pointUser = $this->createUserWithRole('point', $dealer, [
            'username' => 'edit.pass.point',
            'password' => 'old-pass',
            'menu_permissions' => ['dashboard', 'search'],
        ]);

        $this->actingAs($moderator);

        $this->patchJson("/api/moderator/users/{$pointUser->id}", [
            'dealer_id' => $dealer->id,
            'customer_scope' => 'dealer',
            'name' => $pointUser->name,
            'username' => $pointUser->username,
            'password' => 'abc123',
            'role_slugs' => ['point'],
            'menu_permissions' => ['dashboard', 'search'],
            'is_active' => true,
        ])->assertOk();

        $this->assertTrue(Hash::check('abc123', $pointUser->fresh()->password));
    }

    public function test_moderator_can_reset_user_password_with_six_character_password(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-MOD-RESET-PASS');
        $moderator = $this->createUserWithRole('moderator');
        $pointUser = $this->createUserWithRole('point', $dealer, [
            'username' => 'reset.pass.point',
            'password' => 'old-pass',
            'menu_permissions' => ['dashboard', 'search'],
        ]);

        $this->actingAs($moderator);

        $this->postJson("/api/moderator/users/{$pointUser->id}/reset-password", [
            'password' => '123456',
        ])->assertOk();

        $this->assertTrue(Hash::check('123456', $pointUser->fresh()->password));
    }

    public function test_moderator_overview_can_skip_or_limit_customer_payload_without_changing_summary(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-MOD-LIMIT');
        $moderator = $this->createUserWithRole('moderator');

        $this->createCustomer($dealer, 'MOD-LIMIT-001', 'Birinci Cari');
        $this->createCustomer($dealer, 'MOD-LIMIT-002', 'Ikinci Cari');
        $this->createCustomer($dealer, 'MOD-LIMIT-003', 'Ucuncu Cari', null, [
            'is_active' => false,
        ]);

        $this->actingAs($moderator);

        $this->getJson('/api/moderator/overview?include_customers=0')
            ->assertOk()
            ->assertJsonCount(0, 'customers')
            ->assertJsonPath('summary.customers_total', 3)
            ->assertJsonPath('summary.active_customers_total', 2)
            ->assertJsonPath('summary.unassigned_customers_total', 3);

        $this->getJson('/api/moderator/overview?customer_limit=2')
            ->assertOk()
            ->assertJsonCount(2, 'customers')
            ->assertJsonPath('summary.customers_total', 3)
            ->assertJsonPath('summary.active_customers_total', 2)
            ->assertJsonPath('summary.unassigned_customers_total', 3);

        $this->getJson('/api/moderator/overview?customer_q=Ucuncu')
            ->assertOk()
            ->assertJsonCount(1, 'customers')
            ->assertJsonPath('customers.0.code', 'MOD-LIMIT-003')
            ->assertJsonPath('summary.customers_total', 3);
    }

    public function test_salesperson_sees_only_assigned_customers(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-MOD-002');
        $salesA = $this->createUserWithRole('salesperson', $dealer);
        $salesB = $this->createUserWithRole('salesperson', $dealer);

        $visibleCustomer = $this->createCustomer($dealer, 'MOD-VIS-001', 'Gorunen Cari', $salesA);
        $this->createCustomer($dealer, 'MOD-HID-001', 'Gorunmeyen Cari', $salesB);
        $this->createCustomer($dealer, 'MOD-HID-002', 'Atanmamis Cari');

        $this->actingAs($salesA);

        $this->getJson('/api/customers?limit=50')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $visibleCustomer->id)
            ->assertJsonPath('total_count', 1);
    }

    public function test_admin_update_preserves_admin_role_for_admin_user(): void
    {
        $this->seed(RoleSeeder::class);

        $admin = $this->createUserWithRole('admin');
        $manager = $this->createUserWithRole('admin', null, [
            'username' => 'mudur.test',
            'menu_permissions' => MenuPermissions::keys(),
        ]);

        $this->actingAs($admin);

        $this->patchJson("/api/moderator/users/{$manager->id}", [
            'name' => 'Mudur Test Guncel',
            'menu_permissions' => ['dashboard', 'orders', 'moderator'],
        ])
            ->assertOk()
            ->assertJsonPath('data.name', 'Mudur Test Guncel')
            ->assertJsonPath('data.roles.0.slug', 'admin')
            ->assertJsonPath('data.menu_permissions', ['dashboard', 'orders', 'moderator']);

        $this->assertTrue($manager->fresh()->roles()->where('slug', 'admin')->exists());
    }

    public function test_moderator_can_save_explicit_empty_feature_permissions(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-MOD-FEATURE');
        $moderator = $this->createUserWithRole('moderator');
        $pointUser = $this->createUserWithRole('point', $dealer, [
            'username' => 'feature.point',
            'menu_permissions' => ['search', 'pos'],
            'feature_permissions' => [
                'search.stock',
                'search.stock.warehouse.erzurum_depo',
                'search.stock.warehouse.batum',
            ],
        ]);

        $this->actingAs($moderator);

        $this->patchJson("/api/moderator/users/{$pointUser->id}", [
            'dealer_id' => $dealer->id,
            'name' => $pointUser->name,
            'username' => $pointUser->username,
            'role_slugs' => ['point'],
            'menu_permissions' => ['search', 'pos'],
            'feature_permissions' => [],
            'is_active' => true,
        ])
            ->assertOk()
            ->assertJsonPath('data.feature_permissions', []);

        $this->assertSame([], $pointUser->fresh()->feature_permissions);
        $this->assertNotNull($pointUser->fresh()->permissions_updated_at);
    }

    public function test_branch_scoped_user_sees_only_customers_in_own_branch(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-MOD-004');
        $branchUser = $this->createUserWithRole('dealer_admin', $dealer, [
            'customer_scope' => 'branch',
            'region_code' => 'KARADENIZ',
            'branch_code' => 'TRABZON',
        ]);

        $visibleCustomer = $this->createCustomer($dealer, 'MOD-BR-001', 'Trabzon Cari', null, [
            'region_code' => 'KARADENIZ',
            'branch_code' => 'TRABZON',
        ]);
        $this->createCustomer($dealer, 'MOD-BR-002', 'Samsun Cari', null, [
            'region_code' => 'KARADENIZ',
            'branch_code' => 'SAMSUN',
        ]);

        $this->actingAs($branchUser);

        $this->getJson('/api/customers?limit=50')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $visibleCustomer->id);
    }

    public function test_salesperson_cannot_view_order_of_customer_assigned_to_another_salesperson(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-MOD-003');
        $salesA = $this->createUserWithRole('salesperson', $dealer);
        $salesB = $this->createUserWithRole('salesperson', $dealer);
        $customer = $this->createCustomer($dealer, 'MOD-ORD-001', 'Siparis Cari', $salesB);
        $order = $this->createOrder($dealer, $salesB, $customer, 'ORD-MOD-001');

        $this->actingAs($salesA);

        $this->getJson('/api/orders?limit=50')
            ->assertOk()
            ->assertJsonCount(0, 'data');

        $this->getJson("/api/orders/{$order->id}")
            ->assertForbidden();
    }

    public function test_cart_item_uses_customer_special_discount_when_no_manual_discount_is_sent(): void
    {
        $this->seed(RoleSeeder::class);

        $priceList = PriceList::query()->create([
            'code' => 'TEST',
            'name' => 'Test Liste',
            'discount_rate' => 0,
            'is_active' => true,
        ]);
        $dealer = $this->createDealer('DLR-MOD-DISC');
        $dealer->forceFill(['price_list_id' => $priceList->id])->save();
        $user = $this->createUserWithRole('dealer_admin', $dealer);
        $customer = $this->createCustomer($dealer, 'MOD-DISC-001', 'Iskontolu Cari', null, [
            'meta' => [
                'special_discount_rate' => '15.00',
            ],
        ]);
        $product = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'DISC-SKU',
                'oem_code' => 'DISC-OEM',
                'name' => 'Discount Product',
                'vat_rate' => 20,
                'is_active' => true,
            ]);
        });

        BasePrice::query()->create([
            'price_list_id' => $priceList->id,
            'product_id' => $product->id,
            'list_price' => 100,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);
        StockSummary::query()->create([
            'product_id' => $product->id,
            'available_total' => 20,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 2,
        ])
            ->assertOk()
            ->assertJsonPath('items.0.unit_net_price', '100.00')
            ->assertJsonPath('items.0.discount_rate', '15.00')
            ->assertJsonPath('items.0.line_total', '170.00')
            ->assertJsonPath('totals.discount_total', '30.00')
            ->assertJsonPath('totals.net_total', '170.00');
    }

    private function createDealer(string $code): Dealer
    {
        return Dealer::query()->create([
            'code' => $code,
            'name' => 'Dealer '.$code,
            'is_active' => true,
        ]);
    }

    private function createUserWithRole(string $roleSlug, ?Dealer $dealer = null, array $overrides = []): User
    {
        $role = Role::query()->firstOrCreate(
            ['slug' => $roleSlug],
            ['name' => Str::headline(str_replace('_', ' ', $roleSlug))]
        );

        $user = User::factory()->create(array_merge([
            'dealer_id' => $dealer?->id,
            'selected_customer_id' => null,
            'customer_scope' => $roleSlug === 'salesperson' ? 'assigned' : 'dealer',
            'region_code' => null,
            'branch_code' => null,
            'is_active' => true,
        ], $overrides));

        $user->roles()->sync([$role->id]);

        return $user;
    }

    private function createCustomer(
        Dealer $dealer,
        string $code,
        string $name,
        ?User $salesperson = null,
        array $overrides = []
    ): Customer {
        return Customer::query()->create(array_merge([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $salesperson?->id,
            'source_system' => 'logo',
            'code' => $code,
            'name' => $name,
            'contact_name' => 'Yetkili '.$name,
            'phone' => '05320000000',
            'city' => 'ERZURUM',
            'district' => 'YAKUTIYE',
            'tax_office' => 'ERZURUM',
            'tax_number' => '1234567890',
            'credit_limit' => 50000,
            'is_active' => true,
            'meta' => [
                'address' => 'Test adres',
                'iban' => 'TR000000000000000000000001',
            ],
        ], $overrides));
    }

    private function createOrder(Dealer $dealer, User $user, Customer $customer, string $orderNo): Order
    {
        $product = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'MOD-ORD-SKU',
                'oem_code' => 'MOD-ORD-OEM',
                'name' => 'Moderator Order Product',
                'vat_rate' => 20,
                'is_active' => true,
            ]);
        });

        $order = Order::query()->create([
            'order_no' => $orderNo,
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'user_id' => $user->id,
            'status' => 'approved',
            'currency' => 'TRY',
            'subtotal' => 100,
            'discount_total' => 0,
            'tax_total' => 20,
            'grand_total' => 120,
            'ordered_at' => now()->subHour(),
            'approved_at' => now()->subMinutes(30),
        ]);

        OrderItem::query()->create([
            'order_id' => $order->id,
            'product_id' => $product->id,
            'quantity' => 1,
            'shipped_qty' => 0,
            'unit_net_price' => 100,
            'discount_rate' => 0,
            'tax_rate' => 20,
            'line_total' => 100,
            'currency' => 'TRY',
        ]);

        return $order;
    }
}
