<?php

namespace Tests\Feature;

use App\Models\Brand;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\Role;
use App\Models\User;
use Database\Seeders\RoleSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;
use Tests\TestCase;

class CustomerUserApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_admin_can_list_customers_and_create_customer_login(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-CUSR-001');
        $admin = $this->createUserWithRole('admin');
        $customer = $this->createCustomer($dealer, '120-25-999', 'Erzurum Test Cari');

        $this->actingAs($admin);

        $this->getJson('/api/customer-users?q=120-25&limit=10')
            ->assertOk()
            ->assertJsonPath('total_count', 1)
            ->assertJsonPath('data.0.code', '120-25-999')
            ->assertJsonPath('data.0.name', 'Erzurum Test Cari')
            ->assertJsonPath('data.0.username', '120-25-999')
            ->assertJsonPath('data.0.user', null);

        $this->postJson("/api/customer-users/{$customer->id}", [
            'password' => '250250',
        ])
            ->assertCreated()
            ->assertJsonPath('data.code', '120-25-999')
            ->assertJsonPath('data.username', '120-25-999')
            ->assertJsonPath('data.user.username', '120-25-999')
            ->assertJsonPath('data.user.is_active', true)
            ->assertJsonPath('data.user.menu_permissions', ['dashboard', 'notes', 'search', 'catalogs', 'cart', 'orders', 'ledger'])
            ->assertJsonPath('data.user.feature_permissions.0', 'dashboard.summary');

        $createdUser = User::query()
            ->where('username', '120-25-999')
            ->firstOrFail();

        $this->assertNotContains('cart.payment.show', $createdUser->feature_permissions);
        $this->assertSame(
            [],
            array_values(array_filter(
                $createdUser->feature_permissions,
                fn (string $permission): bool => str_starts_with($permission, 'cart.sale_type.')
            ))
        );
        $this->assertTrue(Hash::check('250250', $createdUser->password));
        $this->assertSame($dealer->id, $createdUser->dealer_id);
        $this->assertSame($customer->id, $createdUser->selected_customer_id);
        $this->assertTrue($createdUser->roles()->where('slug', 'customer')->exists());
    }

    public function test_customer_login_preserves_own_selected_customer(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-CUSR-LOGIN');
        $customer = $this->createCustomer($dealer, '120-25-100', 'Login Cari');
        $user = $this->createUserWithRole('customer', $dealer, [
            'selected_customer_id' => $customer->id,
            'customer_scope' => 'assigned',
            'username' => '120-25-100',
            'password' => '250250',
            'menu_permissions' => ['dashboard', 'search', 'catalogs', 'cart', 'orders', 'ledger'],
            'feature_permissions' => ['search.prices', 'search.add_to_cart'],
        ]);

        $this->withHeaders($this->spaHeaders())->postJson('/api/login', [
            'username' => $user->username,
            'password' => '250250',
        ])
            ->assertOk()
            ->assertJsonPath('user.username', '120-25-100')
            ->assertJsonPath('user.selected_customer_id', $customer->id)
            ->assertJsonPath('user.selected_customer.code', $customer->code)
            ->assertJsonPath('user.menu_permissions', ['dashboard', 'search', 'catalogs', 'cart', 'orders', 'ledger'])
            ->assertJsonPath('user.feature_permissions', ['search.prices', 'search.add_to_cart']);

        $this->assertSame($customer->id, $user->fresh()->selected_customer_id);
    }

    public function test_customer_user_password_can_be_reset_for_existing_customer_user(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-CUSR-RST');
        $admin = $this->createUserWithRole('admin');
        $customer = $this->createCustomer($dealer, '120-61-777', 'Trabzon Cari');
        $customerUser = $this->createUserWithRole('customer', $dealer, [
            'selected_customer_id' => $customer->id,
            'customer_scope' => 'assigned',
            'username' => '120-61-777',
            'password' => 'oldpass',
        ]);

        $this->actingAs($admin);

        $this->postJson("/api/customer-users/{$customer->id}", [
            'password' => 'newpass',
        ])
            ->assertCreated()
            ->assertJsonPath('data.user.id', $customerUser->id)
            ->assertJsonPath('data.user.username', '120-61-777');

        $this->assertTrue(Hash::check('newpass', $customerUser->fresh()->password));
    }

    public function test_customer_user_permissions_and_discount_can_be_saved(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-CUSR-PERM');
        $admin = $this->createUserWithRole('admin');
        $customer = $this->createCustomer($dealer, '120-25-555', 'Yetki Cari');

        $this->actingAs($admin);

        $this->postJson("/api/customer-users/{$customer->id}", [
            'password' => '250250',
            'menu_permissions' => ['dashboard', 'search', 'cart'],
            'feature_permissions' => ['dashboard.summary', 'search.prices', 'cart.checkout'],
            'special_discount_rate' => 10,
        ])
            ->assertCreated()
            ->assertJsonPath('data.special_discount_rate', '10.00')
            ->assertJsonPath('data.user.menu_permissions', ['dashboard', 'search', 'cart'])
            ->assertJsonPath('data.user.feature_permissions', ['dashboard.summary', 'search.prices', 'cart.checkout']);

        $createdUser = User::query()
            ->where('username', '120-25-555')
            ->firstOrFail();

        $this->assertSame(['dashboard', 'search', 'cart'], $createdUser->menu_permissions);
        $this->assertSame(['dashboard.summary', 'search.prices', 'cart.checkout'], $createdUser->feature_permissions);
        $this->assertSame('10.00', $customer->fresh()->meta['special_discount_rate']);
    }

    public function test_customer_user_sale_type_two_zero_permission_stays_explicitly_disabled_after_login(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-CUSR-2ZERO');
        $admin = $this->createUserWithRole('admin');
        $customer = $this->createCustomer($dealer, '120-25-561', 'Iki Sifir Yetki Cari');

        $this->actingAs($admin)
            ->postJson("/api/customer-users/{$customer->id}", [
                'password' => '250250',
                'menu_permissions' => ['cart'],
                'feature_permissions' => ['cart.view', 'cart.checkout'],
            ])
            ->assertCreated()
            ->assertJsonPath('data.user.feature_permissions', ['cart.view', 'cart.checkout'])
            ->assertJsonMissingPath('data.user.feature_permissions.2')
            ->assertJsonPath('data.user.permissions_updated_at', fn ($value) => is_string($value) && $value !== '');

        $customerUser = User::query()->where('username', '120-25-561')->firstOrFail();

        $this->assertSame(['cart.view', 'cart.checkout'], $customerUser->feature_permissions);
        $this->assertNotContains('cart.sale_type.excluded', $customerUser->feature_permissions);
        $this->assertNotNull($customerUser->permissions_updated_at);

        $this->actingAs($customerUser)
            ->getJson('/api/me')
            ->assertOk()
            ->assertJsonPath('user.feature_permissions', ['cart.view', 'cart.checkout'])
            ->assertJsonPath('user.permissions_updated_at', fn ($value) => is_string($value) && $value !== '');
    }

    public function test_customer_user_can_save_all_operational_menu_permissions_and_clear_them(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-CUSR-MENU');
        $admin = $this->createUserWithRole('admin');
        $customer = $this->createCustomer($dealer, '120-25-558', 'Menü Yetki Cari');

        $this->actingAs($admin)
            ->postJson("/api/customer-users/{$customer->id}", [
                'password' => '250250',
                'menu_permissions' => [
                    'dashboard',
                    'customer-complaints',
                    'collections',
                    'returns',
                    'pos',
                    'warehouse',
                ],
            ])
            ->assertCreated()
            ->assertJsonPath('data.user.menu_permissions', [
                'dashboard',
                'customer-complaints',
                'collections',
                'returns',
                'pos',
                'warehouse',
            ]);

        $this->actingAs($admin)
            ->postJson("/api/customer-users/{$customer->id}", [
                'menu_permissions' => [],
            ])
            ->assertCreated()
            ->assertJsonPath('data.user.menu_permissions', []);

        $this->assertSame(
            [],
            User::query()->where('username', '120-25-558')->firstOrFail()->menu_permissions
        );
    }

    public function test_customer_menu_options_include_operational_pages_but_exclude_user_management(): void
    {
        $this->seed(RoleSeeder::class);

        $admin = $this->createUserWithRole('admin');

        $response = $this->actingAs($admin)->getJson('/api/customer-users');

        $response->assertOk();
        $keys = collect($response->json('menu_permissions'))->pluck('key')->all();

        $this->assertContains('customer-complaints', $keys);
        $this->assertContains('collections', $keys);
        $this->assertContains('pos', $keys);
        $this->assertContains('warehouse', $keys);
        $this->assertNotContains('moderator', $keys);
        $this->assertNotContains('customer-users', $keys);
    }

    public function test_customer_menu_permission_can_satisfy_a_menu_protected_role_gate(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-CUSR-ROLE');
        $customer = $this->createCustomer($dealer, '120-25-559', 'Tahsilat Yetki Cari');
        $customerUser = $this->createUserWithRole('customer', $dealer, [
            'selected_customer_id' => $customer->id,
            'customer_scope' => 'assigned',
            'menu_permissions' => ['collections'],
        ]);

        $this->actingAs($customerUser)
            ->getJson('/api/finance-definitions')
            ->assertOk();

        $this->actingAs($customerUser)
            ->getJson("/api/customers/{$customer->id}/collections")
            ->assertOk();
    }

    public function test_cart_payment_area_permission_does_not_restrict_collections(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-CUSR-PAY');
        $customer = $this->createCustomer($dealer, '120-25-560', 'Ödeme Yetki Cari');
        $customerUser = $this->createUserWithRole('customer', $dealer, [
            'selected_customer_id' => $customer->id,
            'customer_scope' => 'assigned',
            'menu_permissions' => ['collections', 'cart'],
            'feature_permissions' => [],
        ]);

        $this->actingAs($customerUser)
            ->postJson("/api/customers/{$customer->id}/collections", [
                'method' => 'cash',
                'amount' => 100,
            ])
            ->assertCreated();
    }

    public function test_customer_brand_visibility_and_discount_chain_can_be_saved(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-CUSR-BRAND');
        $admin = $this->createUserWithRole('admin');
        $customer = $this->createCustomer($dealer, '120-25-556', 'Marka Yetki Cari');
        $brand = Brand::query()->create([
            'name' => 'Castrol',
            'slug' => 'castrol',
            'is_active' => true,
        ]);

        $this->actingAs($admin)
            ->postJson("/api/customer-users/{$customer->id}", [
                'password' => '250250',
                'allowed_brand_ids' => [$brand->id],
                'brand_discounts' => [[
                    'brand_id' => $brand->id,
                    'discount_1' => 10,
                    'discount_2' => 5,
                    'discount_3' => 3,
                ]],
                'feature_permissions' => [
                    'search.campaigns',
                    'cart.payment.show',
                ],
            ])
            ->assertCreated()
            ->assertJsonPath('data.allowed_brand_ids.0', $brand->id)
            ->assertJsonPath('data.brand_discounts.0.discount_1', '10.00')
            ->assertJsonPath('data.user.feature_permissions.0', 'search.campaigns');

        $settings = $customer->fresh()->meta['customer_user'];
        $this->assertSame([$brand->id], $settings['allowed_brand_ids']);
        $this->assertSame('5.00', $settings['brand_discounts'][0]['discount_2']);
    }

    public function test_inactive_customer_login_is_blocked_after_thirty_days(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-CUSR-IDLE');
        $customer = $this->createCustomer($dealer, '120-25-557', 'Pasif Cari');
        $user = $this->createUserWithRole('customer', $dealer, [
            'selected_customer_id' => $customer->id,
            'username' => '120-25-557',
            'password' => '250250',
            'last_activity_at' => now()->subDays(31),
        ]);

        $this->withHeaders($this->spaHeaders())->postJson('/api/login', [
            'username' => $user->username,
            'password' => '250250',
        ])
            ->assertForbidden()
            ->assertJsonPath(
                'message',
                'Hesabınız pasif duruma alınmıştır. Lütfen mağaza ile iletişime geçiniz.'
            );

        $this->assertFalse((bool) $user->fresh()->is_active);
    }

    private function createDealer(string $code): Dealer
    {
        return Dealer::query()->create([
            'code' => $code,
            'name' => 'Dealer '.$code,
            'is_active' => true,
        ]);
    }

    private function createCustomer(Dealer $dealer, string $code, string $name): Customer
    {
        return Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'code' => $code,
            'name' => $name,
            'phone' => '05550000000',
            'city' => 'ERZURUM',
            'district' => 'MERKEZ',
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
            'customer_scope' => $roleSlug === 'customer' ? 'assigned' : 'dealer',
            'is_active' => true,
        ], $overrides));

        $user->roles()->sync([$role->id]);

        return $user;
    }

    /**
     * @return array<string, string>
     */
    private function spaHeaders(): array
    {
        return [
            'Origin' => 'http://localhost:3000',
            'Referer' => 'http://localhost:3000/login',
            'Accept' => 'application/json',
        ];
    }
}
