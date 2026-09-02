<?php

namespace Tests\Feature;

use App\Models\Customer;
use App\Models\Dealer;
use App\Models\Role;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class UserContextApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_context_endpoints_are_registered(): void
    {
        $this->assertTrue($this->hasRoute('GET', 'api/context'));
        $this->assertTrue($this->hasRoute('POST', 'api/context/customer'));
    }

    public function test_salesperson_can_set_and_get_context_customer_in_own_dealer_scope(): void
    {
        $dealer = $this->createDealer('DLR-CTX-A');
        $user = $this->createUserWithRole('salesperson', $dealer);
        $customer = $this->createCustomer($dealer, 'CTX-CUST-A', $user);

        $this->actingAs($user);

        $this->postJson('/api/context/customer', [
            'customer_id' => $customer->id,
        ])->assertOk()
            ->assertJsonPath('context.customer.id', $customer->id)
            ->assertJsonPath('context.customer.code', $customer->code);

        $this->assertDatabaseHas('users', [
            'id' => $user->id,
            'selected_customer_id' => $customer->id,
        ]);

        $this->getJson('/api/context')
            ->assertOk()
            ->assertJsonPath('context.customer.id', $customer->id)
            ->assertJsonPath('context.customer.code', $customer->code)
            ->assertJsonPath('context.customer.title', $customer->name)
            ->assertJsonPath('context.customer.name', $customer->name)
            ->assertJsonPath('context.customer.tax_office', $customer->tax_office)
            ->assertJsonPath('context.customer.tax_number', $customer->tax_number)
            ->assertJsonPath('context.customer.address', 'Test adresi')
            ->assertJsonPath('context.customer.iban', 'TR000000000000000000000001')
            ->assertJsonPath('context.customer.meta.address', 'Test adresi')
            ->assertJsonPath('context.customer.meta.iban', 'TR000000000000000000000001')
            ->assertJsonPath('context.customer.source_system', null)
            ->assertJsonPath('context.customer.is_active', true)
            ->assertJsonPath('context.customer.last_synced_at', null);
    }

    public function test_context_customer_includes_linked_customer_user_sale_type_permissions(): void
    {
        $dealer = $this->createDealer('DLR-CTX-SALE-TYPES');
        $salesperson = $this->createUserWithRole('salesperson', $dealer);
        $customer = $this->createCustomer($dealer, '120-25-777', $salesperson);
        $this->createUserWithRole('customer', $dealer, [
            'selected_customer_id' => $customer->id,
            'customer_scope' => 'assigned',
            'username' => $customer->code,
            'feature_permissions' => [
                'cart.sale_type.detailed',
                'cart.sale_type.excluded',
                'cart.sale_type.included',
            ],
        ]);

        $this->actingAs($salesperson);

        $this->postJson('/api/context/customer', [
            'customer_id' => $customer->id,
        ])->assertOk()
            ->assertJsonPath('context.customer.customer_user_feature_permissions', [
                'cart.sale_type.detailed',
                'cart.sale_type.excluded',
                'cart.sale_type.included',
            ]);

        $this->getJson('/api/context')
            ->assertOk()
            ->assertJsonPath('context.customer.customer_user_feature_permissions', [
                'cart.sale_type.detailed',
                'cart.sale_type.excluded',
                'cart.sale_type.included',
            ]);
    }

    public function test_context_exposes_the_real_branch_manager_name(): void
    {
        $dealer = $this->createDealer('DLR-CTX-MGR');
        $manager = $this->createUserWithRole('dealer_admin', $dealer, [
            'username' => 'mudur.erzurum',
            'name' => 'Mehmet Erzurum Müdürü',
            'phone' => '05550001122',
        ]);
        $customer = $this->createCustomer($dealer, 'CTX-CUST-MGR', null, [
            'branch_code' => 'ERZURUM',
        ]);
        $user = $this->createUserWithRole('customer', $dealer, [
            'selected_customer_id' => $customer->id,
            'customer_scope' => 'assigned',
        ]);

        $this->actingAs($user)
            ->getJson('/api/context')
            ->assertOk()
            ->assertJsonPath('context.customer.meta.manager_name', $manager->name)
            ->assertJsonPath('context.customer.meta.manager_phone', $manager->phone);
    }

    public function test_context_resolves_erzurum_manager_from_salesperson_when_customer_branch_is_blank(): void
    {
        $dealer = $this->createDealer('DLR-CTX-MGR-SP');
        $manager = $this->createUserWithRole('dealer_admin', $dealer, [
            'username' => 'mudur.erzurum',
            'name' => 'Mehmet Erzurum Müdürü',
            'phone' => '05550001122',
        ]);
        $salesperson = $this->createUserWithRole('salesperson', $dealer, [
            'username' => 'huseyin.ozguney',
            'name' => 'Hüseyin Özgüney',
            'branch_code' => null,
            'branch_name' => null,
            'region_code' => null,
            'region_name' => null,
        ]);
        $customer = $this->createCustomer($dealer, '120-04-017', $salesperson, [
            'city' => null,
            'branch_code' => null,
            'branch_name' => null,
            'region_code' => null,
            'region_name' => null,
        ]);
        $user = $this->createUserWithRole('customer', $dealer, [
            'username' => '120-04-017',
            'selected_customer_id' => $customer->id,
            'customer_scope' => 'assigned',
            'menu_permissions' => ['cart'],
        ]);

        $this->actingAs($user)
            ->getJson('/api/context')
            ->assertOk()
            ->assertJsonPath('context.customer.salesperson.name', $salesperson->name)
            ->assertJsonPath('context.customer.meta.manager_name', $manager->name)
            ->assertJsonPath('context.customer.meta.manager_phone', $manager->phone);
    }

    public function test_customer_with_cart_menu_can_load_locked_context_and_cart(): void
    {
        $dealer = $this->createDealer('DLR-CTX-CUSTOMER-CART');
        $salesperson = $this->createUserWithRole('salesperson', $dealer, [
            'username' => 'huseyin.ozguney',
            'name' => 'Hüseyin Özgüney',
        ]);
        $customer = $this->createCustomer($dealer, '120-04-017', $salesperson);
        $user = $this->createUserWithRole('customer', $dealer, [
            'username' => '120-04-017',
            'selected_customer_id' => $customer->id,
            'customer_scope' => 'assigned',
            'menu_permissions' => ['cart'],
        ]);

        $this->actingAs($user)
            ->getJson('/api/context')
            ->assertOk()
            ->assertJsonPath('context.customer.id', $customer->id);

        $this->getJson('/api/cart?customer_id='.$customer->id)
            ->assertOk()
            ->assertJsonPath('cart', null);

        $this->getJson('/api/finance-definitions?type=shipping_rule')
            ->assertOk()
            ->assertJsonStructure(['data']);
    }

    public function test_point_user_with_only_pos_menu_can_read_context(): void
    {
        $dealer = $this->createDealer('DLR-CTX-POINT');
        $user = $this->createUserWithRole('point', $dealer, [
            'username' => 'trabzon.point',
            'menu_permissions' => ['pos'],
        ]);

        $this->actingAs($user)
            ->getJson('/api/context')
            ->assertOk()
            ->assertJsonPath('context.customer', null);
    }

    public function test_user_cannot_select_customer_outside_own_dealer_scope(): void
    {
        $dealerA = $this->createDealer('DLR-CTX-OWN');
        $dealerB = $this->createDealer('DLR-CTX-OTHER');

        $user = $this->createUserWithRole('salesperson', $dealerA);
        $otherDealerCustomer = $this->createCustomer($dealerB, 'CTX-CUST-OTHER');

        $this->actingAs($user);

        $this->postJson('/api/context/customer', [
            'customer_id' => $otherDealerCustomer->id,
        ])->assertForbidden();

        $this->assertDatabaseHas('users', [
            'id' => $user->id,
            'selected_customer_id' => null,
        ]);
    }

    public function test_salesperson_cannot_select_unassigned_customer_in_own_dealer_scope(): void
    {
        $dealer = $this->createDealer('DLR-CTX-SEL');
        $user = $this->createUserWithRole('salesperson', $dealer);
        $customer = $this->createCustomer($dealer, 'CTX-CUST-SEL', null);

        $this->actingAs($user);

        $this->postJson('/api/context/customer', [
            'customer_id' => $customer->id,
        ])->assertForbidden();

        $this->assertDatabaseHas('users', [
            'id' => $user->id,
            'selected_customer_id' => null,
        ]);
    }

    public function test_salesperson_cannot_select_customer_outside_logo_specode4_filter(): void
    {
        $dealer = $this->createDealer('DLR-CTX-SP4');
        $user = $this->createUserWithRole('salesperson', $dealer, [
            'logo_customer_specode4' => 'A',
        ]);
        $customer = $this->createCustomer($dealer, 'CTX-CUST-SP4', null, [
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'specode4' => 'B',
                        ],
                    ],
                ],
            ],
        ]);

        $this->actingAs($user);

        $this->postJson('/api/context/customer', [
            'customer_id' => $customer->id,
        ])->assertForbidden();

        $this->assertDatabaseHas('users', [
            'id' => $user->id,
            'selected_customer_id' => null,
        ]);
    }

    public function test_salesperson_lists_logo_customer_matching_specode4_even_when_not_assigned(): void
    {
        $dealer = $this->createDealer('DLR-CTX-SP4-LIST');
        $user = $this->createUserWithRole('salesperson', $dealer, [
            'logo_customer_specode4' => 'A',
        ]);
        $this->createCustomer($dealer, 'CTX-CUST-SP4-LIST-HIDDEN', $user, [
            'source_system' => 'logo',
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'specode4' => 'B',
                        ],
                    ],
                ],
            ],
        ]);

        $visibleCustomer = $this->createCustomer($dealer, 'CTX-CUST-SP4-LIST-A', null, [
            'source_system' => 'logo',
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'specode4' => 'A',
                        ],
                    ],
                ],
            ],
        ]);

        $this->actingAs($user);

        $this->getJson('/api/customers?limit=50&selection_mode=1')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $visibleCustomer->id)
            ->assertJsonPath('total_count', 1);
    }

    public function test_salesperson_cannot_select_assigned_logo_customer_when_specode4_differs(): void
    {
        $dealer = $this->createDealer('DLR-CTX-SP4-ASSIGNED');
        $user = $this->createUserWithRole('salesperson', $dealer, [
            'logo_customer_specode4' => 'A',
        ]);
        $customer = $this->createCustomer($dealer, 'CTX-CUST-SP4-ASSIGNED', $user, [
            'source_system' => 'logo',
            'source_reference' => '1672',
            'sync_status' => 'synced',
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'specode' => 'F1',
                            'specode4' => null,
                        ],
                    ],
                ],
            ],
        ]);

        $this->actingAs($user);

        $this->postJson('/api/context/customer', [
            'customer_id' => $customer->id,
        ])->assertForbidden();

        $this->assertDatabaseHas('users', [
            'id' => $user->id,
            'selected_customer_id' => null,
        ]);
    }

    public function test_show_context_clears_stale_out_of_scope_selected_customer(): void
    {
        $dealerA = $this->createDealer('DLR-CTX-ST-A');
        $dealerB = $this->createDealer('DLR-CTX-ST-B');

        $user = $this->createUserWithRole('salesperson', $dealerA);
        $foreignCustomer = $this->createCustomer($dealerB, 'CTX-CUST-ST-B');

        $user->forceFill([
            'selected_customer_id' => $foreignCustomer->id,
        ])->save();

        $this->actingAs($user);

        $this->getJson('/api/context')
            ->assertOk()
            ->assertJsonPath('context.customer', null);

        $this->assertDatabaseHas('users', [
            'id' => $user->id,
            'selected_customer_id' => null,
        ]);
    }

    public function test_batum_user_can_select_batum_depot_order_customer_without_logo_specode_match(): void
    {
        $dealer = $this->createDealer('DLR-CTX-BATUM');
        $user = $this->createUserWithRole('point', $dealer, [
            'username' => 'batum',
            'name' => 'BATUM B2B VE HIZLI SATIŞ',
            'branch_code' => 'BATUM',
            'branch_name' => 'Batum',
            'customer_scope' => 'branch',
            'logo_customer_specode4' => 'K',
            'menu_permissions' => ['customers', 'cart'],
        ]);
        $customer = $this->createCustomer($dealer, '130-00-000', null, [
            'name' => 'BATUM DEPO (SIPARIS)',
            'city' => 'BATUMI',
            'district' => 'BATUMI',
            'branch_code' => null,
            'branch_name' => null,
            'source_system' => 'logo',
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'raw' => [
                                'CITY' => 'BATUMI',
                                'TOWN' => 'BATUMI',
                            ],
                        ],
                    ],
                ],
            ],
        ]);

        $this->actingAs($user);

        $this->postJson('/api/context/customer', [
            'customer_id' => $customer->id,
        ])->assertOk()
            ->assertJsonPath('context.customer.id', $customer->id)
            ->assertJsonPath('context.customer.code', '130-00-000');

        $this->assertDatabaseHas('users', [
            'id' => $user->id,
            'selected_customer_id' => $customer->id,
        ]);
    }

    public function test_context_endpoints_require_authentication(): void
    {
        $this->getJson('/api/context')->assertUnauthorized();

        $this->postJson('/api/context/customer', [
            'customer_id' => 1,
        ])->assertUnauthorized();
    }

    public function test_context_endpoints_return_401_json_for_plain_api_requests_without_json_accept_header(): void
    {
        $this->get('/api/context')
            ->assertUnauthorized()
            ->assertJsonPath('message', 'Unauthenticated.');

        $this->post('/api/context/customer', [
            'customer_id' => 1,
        ])->assertUnauthorized()
            ->assertJsonPath('message', 'Unauthenticated.');
    }

    private function hasRoute(string $method, string $uri): bool
    {
        $routes = app('router')->getRoutes()->getRoutesByMethod()[$method] ?? [];

        foreach ($routes as $route) {
            if ($route->uri() === $uri) {
                return true;
            }
        }

        return false;
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
            'is_active' => true,
        ], $overrides));

        $user->roles()->sync([$role->id]);

        return $user;
    }

    private function createCustomer(Dealer $dealer, string $code, ?User $salesperson = null, array $overrides = []): Customer
    {
        return Customer::query()->create(array_merge([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $salesperson?->id,
            'code' => $code,
            'name' => 'Customer '.$code,
            'contact_name' => 'Yetkili '.$code,
            'phone' => '05550000000',
            'city' => 'ERZURUM',
            'district' => 'MERKEZ',
            'tax_office' => 'ERZURUM',
            'tax_number' => '1234567890',
            'credit_limit' => 50000,
            'meta' => [
                'address' => 'Test adresi',
                'iban' => 'TR000000000000000000000001',
            ],
            'is_active' => true,
        ], $overrides));
    }
}
