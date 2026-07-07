<?php

namespace Tests\Feature;

use App\Models\Customer;
use App\Models\Dealer;
use App\Models\Role;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class CustomerIndexApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_customer_index_returns_total_count_for_visible_customers(): void
    {
        $dealerA = Dealer::query()->create([
            'code' => 'DLR-COUNT-A',
            'name' => 'Dealer A',
            'is_active' => true,
        ]);

        $dealerB = Dealer::query()->create([
            'code' => 'DLR-COUNT-B',
            'name' => 'Dealer B',
            'is_active' => true,
        ]);

        $salesRole = Role::query()->firstOrCreate(
            ['slug' => 'salesperson'],
            ['name' => 'Salesperson']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealerA->id,
            'is_active' => true,
        ]);
        $user->roles()->sync([$salesRole->id]);

        Customer::query()->create([
            'dealer_id' => $dealerA->id,
            'salesperson_user_id' => $user->id,
            'code' => 'CR-'.Str::upper(Str::random(6)),
            'name' => 'Dealer A Customer 1',
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $dealerA->id,
            'salesperson_user_id' => $user->id,
            'code' => 'CR-'.Str::upper(Str::random(6)),
            'name' => 'Dealer A Customer 2',
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $dealerB->id,
            'code' => 'CR-'.Str::upper(Str::random(6)),
            'name' => 'Dealer B Customer 1',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $response = $this->getJson('/api/customers?limit=1');

        $response->assertOk();
        $response->assertJsonPath('limit', 1);
        $response->assertJsonPath('total_count', 2);
        $response->assertJsonCount(1, 'data');
    }

    public function test_point_user_can_list_customers_from_customer_page_route(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-CUSTOMERS',
            'name' => 'Point Customer Dealer',
            'is_active' => true,
        ]);

        $otherDealer = Dealer::query()->create([
            'code' => 'DLR-POINT-OTHER',
            'name' => 'Point Other Dealer',
            'is_active' => true,
        ]);

        $pointRole = Role::query()->firstOrCreate(
            ['slug' => 'point'],
            ['name' => 'Point']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'customer_scope' => 'dealer',
            'menu_permissions' => ['customers'],
            'is_active' => true,
        ]);
        $user->roles()->sync([$pointRole->id]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'code' => 'POINT-CUSTOMER-1',
            'name' => 'Point Customer Visible',
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $otherDealer->id,
            'source_system' => 'logo',
            'code' => 'POINT-CUSTOMER-2',
            'name' => 'Point Customer Hidden',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->getJson('/api/customers?source_system=logo&q=POINT-CUSTOMER&limit=10')
            ->assertOk()
            ->assertJsonPath('total_count', 1)
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.code', 'POINT-CUSTOMER-1');
    }

    public function test_customer_index_summary_count_skips_listing_rows(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-SUMMARY-COUNT',
            'name' => 'Summary Count Dealer',
            'is_active' => true,
        ]);

        $role = Role::query()->firstOrCreate(
            ['slug' => 'admin'],
            ['name' => 'Admin']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'is_active' => true,
        ]);
        $user->roles()->sync([$role->id]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'code' => 'SUM-COUNT-1',
            'name' => 'Summary Count 1',
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'code' => 'SUM-COUNT-2',
            'name' => 'Summary Count 2',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->getJson('/api/customers?summary=count&source_system=logo&limit=1')
            ->assertOk()
            ->assertJsonPath('total_count', 1)
            ->assertJsonPath('next_cursor', null)
            ->assertJsonCount(0, 'data');
    }

    public function test_customer_index_prioritizes_logo_records_and_uses_logo_balance_fallback(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO-FILTER',
            'name' => 'Logo Dealer',
            'is_active' => true,
        ]);

        $salesRole = Role::query()->firstOrCreate(
            ['slug' => 'salesperson'],
            ['name' => 'Salesperson']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'is_active' => true,
        ]);
        $user->roles()->sync([$salesRole->id]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $user->id,
            'code' => 'ZZZ-MANUAL',
            'name' => 'Manual Cari',
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $user->id,
            'source_system' => 'logo',
            'source_reference' => '1001',
            'code' => '0000000000000001',
            'name' => 'Deneme Cari',
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'financials' => [
                            'total_due' => '2450.75',
                            'order_due' => '810.25',
                            'currency' => 'TRY',
                        ],
                    ],
                ],
            ],
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $response = $this->getJson('/api/customers?limit=10');

        $response->assertOk();
        $response->assertJsonPath('data.0.code', '0000000000000001');
        $response->assertJsonPath('data.0.source_system', 'logo');
        $response->assertJsonPath('data.0.balance_source', 'logo');
        $response->assertJsonPath('data.0.balance_summary.total_due', '2450.75');
        $response->assertJsonPath('data.0.balance_summary.order_due', '810.25');
    }

    public function test_customer_index_shows_new_pending_b2b_customer_before_logo_records(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-NEW-CUSTOMER',
            'name' => 'New Customer Dealer',
            'is_active' => true,
        ]);

        $salesRole = Role::query()->firstOrCreate(
            ['slug' => 'salesperson'],
            ['name' => 'Salesperson']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'logo_customer_specode4' => 'A',
            'is_active' => true,
        ]);
        $user->roles()->sync([$salesRole->id]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $user->id,
            'source_system' => 'logo',
            'code' => '0000000000000001',
            'name' => 'Existing Logo Customer',
            'is_active' => true,
        ]);

        $pendingCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $user->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'code' => 'NEW-PENDING-CUSTOMER',
            'name' => 'New Pending Customer',
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => User::factory()->create(['dealer_id' => $dealer->id])->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'code' => 'OTHER-PENDING-CUSTOMER',
            'name' => 'Other Pending Customer',
            'is_active' => true,
        ]);

        $this->actingAs($user)
            ->getJson('/api/customers?limit=10')
            ->assertOk()
            ->assertJsonCount(2, 'data')
            ->assertJsonPath('data.0.id', $pendingCustomer->id)
            ->assertJsonPath('data.0.source_system', 'b2b');

        $pendingCustomer->forceFill(['sync_status' => 'synced'])->save();

        $this->getJson('/api/customers?limit=10')
            ->assertOk()
            ->assertJsonPath('data.0.id', $pendingCustomer->id)
            ->assertJsonPath('data.0.source_system', 'b2b');
    }

    public function test_customer_index_returns_logo_contact_fields_from_payload_fallbacks(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO-CONTACT',
            'name' => 'Logo Contact Dealer',
            'is_active' => true,
        ]);

        $salesRole = Role::query()->firstOrCreate(
            ['slug' => 'salesperson'],
            ['name' => 'Salesperson']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'is_active' => true,
        ]);
        $user->roles()->sync([$salesRole->id]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $user->id,
            'source_system' => 'logo',
            'source_reference' => '9001',
            'code' => 'LOGO-CONTACT',
            'name' => 'Logo Contact Cari',
            'phone' => null,
            'city' => null,
            'district' => null,
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'raw' => [
                                'TELNRS1' => '02125550101',
                                'CITY' => 'Ankara',
                                'TOWN' => 'Cankaya',
                            ],
                        ],
                    ],
                ],
            ],
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->getJson('/api/customers?limit=10')
            ->assertOk()
            ->assertJsonPath('data.0.code', 'LOGO-CONTACT')
            ->assertJsonPath('data.0.phone', '02125550101')
            ->assertJsonPath('data.0.city', 'Ankara')
            ->assertJsonPath('data.0.district', 'Cankaya');
    }

    public function test_branch_scoped_user_only_counts_own_branch_customers(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-BRANCH-CNT',
            'name' => 'Branch Dealer',
            'is_active' => true,
        ]);

        $role = Role::query()->firstOrCreate(
            ['slug' => 'dealer_admin'],
            ['name' => 'Dealer Admin']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'customer_scope' => 'branch',
            'region_code' => 'KARADENIZ',
            'branch_code' => 'TRABZON',
            'is_active' => true,
        ]);
        $user->roles()->sync([$role->id]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'region_code' => 'KARADENIZ',
            'branch_code' => 'TRABZON',
            'code' => 'CR-TRABZON',
            'name' => 'Trabzon Customer',
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'region_code' => 'KARADENIZ',
            'branch_code' => 'SAMSUN',
            'code' => 'CR-SAMSUN',
            'name' => 'Samsun Customer',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->getJson('/api/customers?limit=50')
            ->assertOk()
            ->assertJsonPath('total_count', 1)
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.code', 'CR-TRABZON');
    }

    public function test_batum_branch_point_user_only_sees_logo_batum_customers(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-BATUM-LOGO',
            'name' => 'Batum Logo Dealer',
            'is_active' => true,
        ]);

        $pointRole = Role::query()->firstOrCreate(
            ['slug' => 'point'],
            ['name' => 'Point']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'customer_scope' => 'branch',
            'branch_code' => 'BATUM',
            'is_active' => true,
        ]);
        $user->roles()->sync([$pointRole->id]);

        $batumCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'code' => '120-00-014',
            'name' => 'Vondernet Ekspres',
            'branch_code' => null,
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'financials' => [
                            'total_due' => '1250.50',
                            'order_due' => '75.25',
                            'currency' => 'TRY',
                        ],
                        'payload' => [
                            'cyphcode' => '120-BATUM',
                            'raw' => [
                                'CITY' => 'BATUMI',
                                'TOWN' => 'BATUMI',
                            ],
                        ],
                    ],
                ],
            ],
            'is_active' => true,
        ]);

        $nonBatumUnassigned = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'code' => '120-00-999',
            'name' => 'Other Unassigned Logo',
            'branch_code' => null,
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'raw' => [
                                'CITY' => 'TRABZON',
                                'TOWN' => 'TRABZON',
                            ],
                        ],
                    ],
                ],
            ],
            'is_active' => true,
        ]);

        $batmanCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'code' => '120-00-998',
            'name' => 'Batman Logo',
            'branch_code' => null,
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'raw' => [
                                'CITY' => 'BATMAN',
                                'TOWN' => 'BATMAN',
                            ],
                        ],
                    ],
                ],
            ],
            'is_active' => true,
        ]);

        $this->assertTrue($user->canAccessCustomer($batumCustomer));
        $this->assertFalse($user->canAccessCustomer($nonBatumUnassigned));
        $this->assertFalse($user->canAccessCustomer($batmanCustomer));

        $this->actingAs($user);

        $this->getJson('/api/customers?source_system=logo&limit=50')
            ->assertOk()
            ->assertJsonPath('total_count', 1)
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.code', '120-00-014')
            ->assertJsonPath('data.0.balance_summary.total_due', '1250.50')
            ->assertJsonPath('data.0.balance_summary.order_due', '75.25')
            ->assertJsonPath('data.0.balance_summary.currency', 'GEL');
    }

    public function test_salesperson_selection_mode_uses_assigned_scope_without_logo_filter(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-SEL-LOGO',
            'name' => 'Selection Dealer',
            'is_active' => true,
        ]);

        $otherDealer = Dealer::query()->create([
            'code' => 'DLR-SEL-OTHER',
            'name' => 'Other Dealer',
            'is_active' => true,
        ]);

        $salesRole = Role::query()->firstOrCreate(
            ['slug' => 'salesperson'],
            ['name' => 'Salesperson']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'selected_customer_id' => null,
            'is_active' => true,
        ]);
        $user->roles()->sync([$salesRole->id]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $user->id,
            'source_system' => 'logo',
            'code' => 'LOGO-001',
            'name' => 'Logo Cari 1',
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => null,
            'source_system' => 'logo',
            'code' => 'LOGO-002',
            'name' => 'Logo Cari 2',
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $otherDealer->id,
            'salesperson_user_id' => null,
            'source_system' => 'logo',
            'code' => 'LOGO-OTHER',
            'name' => 'Other Dealer Cari',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->getJson('/api/customers?limit=50&selection_mode=1')
            ->assertOk()
            ->assertJsonPath('total_count', 1)
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.code', 'LOGO-001');
    }

    public function test_salesperson_selection_mode_uses_logo_specode4_filter_over_assigned_scope(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-SEL-SP4',
            'name' => 'Selection Specode Dealer',
            'is_active' => true,
        ]);

        $salesRole = Role::query()->firstOrCreate(
            ['slug' => 'salesperson'],
            ['name' => 'Salesperson']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'logo_customer_specode4' => 'A',
            'selected_customer_id' => null,
            'is_active' => true,
        ]);
        $user->roles()->sync([$salesRole->id]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => null,
            'source_system' => 'logo',
            'code' => 'LOGO-A',
            'name' => 'Logo Cari A',
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'specode4' => 'A',
                        ],
                    ],
                ],
            ],
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => null,
            'source_system' => 'logo',
            'code' => 'LOGO-A-LOWER',
            'name' => 'Logo Cari A Lower',
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'raw' => [
                                'SPECODE4' => 'a',
                            ],
                        ],
                    ],
                ],
            ],
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $user->id,
            'source_system' => 'logo',
            'code' => 'LOGO-B',
            'name' => 'Logo Cari B',
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'specode4' => 'B',
                        ],
                    ],
                ],
            ],
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->getJson('/api/customers?limit=50&selection_mode=1')
            ->assertOk()
            ->assertJsonPath('total_count', 2)
            ->assertJsonCount(2, 'data')
            ->assertJsonPath('data.0.code', 'LOGO-A')
            ->assertJsonPath('data.1.code', 'LOGO-A-LOWER');
    }

    public function test_salesperson_normal_index_uses_logo_specode4_filter_over_assigned_scope(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-IDX-SP4',
            'name' => 'Index Specode Dealer',
            'is_active' => true,
        ]);

        $salesRole = Role::query()->firstOrCreate(
            ['slug' => 'salesperson'],
            ['name' => 'Salesperson']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'logo_customer_specode4' => 'A',
            'selected_customer_id' => null,
            'is_active' => true,
        ]);
        $user->roles()->sync([$salesRole->id]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => null,
            'source_system' => 'logo',
            'code' => 'LOGO-A-NORMAL',
            'name' => 'Logo Cari A Normal',
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'specode4' => 'A',
                        ],
                    ],
                ],
            ],
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $user->id,
            'source_system' => 'logo',
            'code' => 'LOGO-B-ASSIGNED',
            'name' => 'Logo Cari B Assigned',
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'specode4' => 'B',
                        ],
                    ],
                ],
            ],
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->getJson('/api/customers?limit=50')
            ->assertOk()
            ->assertJsonPath('total_count', 1)
            ->assertJsonCount(1, 'data')
            ->assertJsonFragment(['code' => 'LOGO-A-NORMAL'])
            ->assertJsonMissing(['code' => 'LOGO-B-ASSIGNED']);
    }

    public function test_point_user_uses_logo_specode4_filter_before_branch_scope(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-SP4',
            'name' => 'Point Specode Dealer',
            'is_active' => true,
        ]);

        $pointRole = Role::query()->firstOrCreate(
            ['slug' => 'point'],
            ['name' => 'Point']
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'customer_scope' => 'branch',
            'branch_code' => 'ERZURUM',
            'logo_customer_specode4' => 'D',
            'is_active' => true,
        ]);
        $user->roles()->sync([$pointRole->id]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'code' => 'POINT-D',
            'name' => 'Point D',
            'branch_code' => null,
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'raw' => [
                                'SPECODE4' => 'D',
                            ],
                        ],
                    ],
                ],
            ],
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'code' => 'POINT-K',
            'name' => 'Point K',
            'branch_code' => null,
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'raw' => [
                                'SPECODE4' => 'K',
                            ],
                        ],
                    ],
                ],
            ],
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->getJson('/api/pos/customers?limit=50')
            ->assertOk()
            ->assertJsonPath('total_count', 1)
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.code', 'POINT-D');
    }
}
