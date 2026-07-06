<?php

namespace Tests\Feature;

use App\Models\Customer;
use App\Models\Dealer;
use App\Models\Role;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class LogoCustomerSyncApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_logo_customer_sync_requires_valid_integration_key(): void
    {
        config(['integrations.logo.customer_sync_key' => 'test-sync-key']);

        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO',
            'name' => 'Logo Dealer',
            'is_active' => true,
        ]);

        $response = $this->postJson('/api/integrations/logo/customers/sync', [
            'dealer_id' => $dealer->id,
            'records' => [
                [
                    'external_ref' => '1001',
                    'code' => 'CR-1001',
                    'name' => 'Test Cari',
                ],
            ],
        ]);

        $response
            ->assertUnauthorized()
            ->assertJsonPath('message', 'Unauthorized integration request.');
    }

    public function test_logo_customer_sync_backfills_existing_records_and_creates_new_records(): void
    {
        config(['integrations.logo.customer_sync_key' => 'test-sync-key']);

        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO',
            'name' => 'Logo Dealer',
            'is_active' => true,
        ]);

        $salesperson = User::factory()->create([
            'dealer_id' => $dealer->id,
            'email' => 'sales@dealer.test',
            'is_active' => true,
        ]);

        $existingCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'CR-1001',
            'name' => 'Eski Unvan',
            'phone' => '000',
            'meta' => [
                'legacy' => 'keep',
            ],
            'is_active' => true,
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/customers/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'external_ref' => '1001',
                        'code' => 'CR-1001',
                        'name' => 'Yeni Unvan',
                        'phone' => '05320000000',
                        'city' => 'Istanbul',
                        'district' => 'Umraniye',
                        'tax_office' => 'Umraniye',
                        'tax_number' => '1234567890',
                        'credit_limit' => 125000.50,
                        'balance_due' => 2450.75,
                        'order_due' => 810.25,
                        'currency' => 'TRY',
                        'address' => 'Adres 1',
                        'iban' => 'TR00 0000 0000 0000 0000 0000 00',
                        'salesperson_email' => $salesperson->email,
                        'meta' => [
                            'logo_firm_no' => 1,
                            'specode' => 'VIP',
                            'raw' => [
                                'LOGICALREF' => 1001,
                                'CODE' => 'CR-1001',
                                'SPECODE' => 'VIP',
                            ],
                        ],
                    ],
                    [
                        'external_ref' => '1002',
                        'code' => 'CR-1002',
                        'name' => 'Yeni Cari',
                        'phone' => '05321111111',
                        'is_active' => false,
                    ],
                ],
            ]);

        $response
            ->assertOk()
            ->assertJsonPath('summary.received', 2)
            ->assertJsonPath('summary.created', 1)
            ->assertJsonPath('summary.updated', 1)
            ->assertJsonPath('summary.skipped', 0);

        $existingCustomer->refresh();

        $this->assertSame('Yeni Unvan', $existingCustomer->name);
        $this->assertSame('05320000000', $existingCustomer->phone);
        $this->assertSame('Istanbul', $existingCustomer->city);
        $this->assertSame('Umraniye', $existingCustomer->district);
        $this->assertSame('logo', $existingCustomer->source_system);
        $this->assertSame('1001', $existingCustomer->source_reference);
        $this->assertSame('synced', $existingCustomer->sync_status);
        $this->assertSame($salesperson->id, $existingCustomer->salesperson_user_id);
        $this->assertSame('Adres 1', $existingCustomer->meta['address']);
        $this->assertSame('TR00 0000 0000 0000 0000 0000 00', $existingCustomer->meta['iban']);
        $this->assertSame('keep', $existingCustomer->meta['legacy']);
        $this->assertSame(1, $existingCustomer->meta['integrations']['logo']['payload']['logo_firm_no']);
        $this->assertSame('VIP', $existingCustomer->meta['integrations']['logo']['payload']['specode']);
        $this->assertSame('CR-1001', $existingCustomer->meta['integrations']['logo']['payload']['raw']['CODE']);
        $this->assertSame('2450.75', $existingCustomer->meta['integrations']['logo']['financials']['total_due']);
        $this->assertSame('810.25', $existingCustomer->meta['integrations']['logo']['financials']['order_due']);
        $this->assertSame('TRY', $existingCustomer->meta['integrations']['logo']['financials']['currency']);
        $this->assertNotNull($existingCustomer->last_synced_at);

        $this->assertDatabaseHas('customers', [
            'dealer_id' => $dealer->id,
            'code' => 'CR-1002',
            'source_system' => 'logo',
            'source_reference' => '1002',
            'sync_status' => 'synced',
            'name' => 'Yeni Cari',
            'is_active' => false,
        ]);

        $this->assertDatabaseHas('integration_sync_states', [
            'system' => 'logo',
            'domain' => 'customers',
            'direction' => 'inbound',
            'entity_type' => Customer::class,
            'entity_id' => $existingCustomer->id,
            'external_ref' => '1001',
            'status' => 'synced',
        ]);

        $this->assertDatabaseHas('integration_sync_events', [
            'system' => 'logo',
            'domain' => 'customers',
            'direction' => 'inbound',
            'entity_type' => Customer::class,
            'entity_id' => $existingCustomer->id,
            'external_ref' => '1001',
            'status' => 'synced',
        ]);
    }

    public function test_logo_customer_sync_matches_exported_b2b_customer_by_source_reference(): void
    {
        config(['integrations.logo.customer_sync_key' => 'test-sync-key']);

        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO',
            'name' => 'Logo Dealer',
            'is_active' => true,
        ]);

        $existingCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'source_reference' => '2001',
            'sync_status' => 'synced',
            'code' => 'CR-B2B-2001',
            'name' => 'B2B Cari',
            'is_active' => true,
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/customers/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'external_ref' => '2001',
                        'code' => 'CR-B2B-2001',
                        'name' => 'Logo Cariya Donustu',
                    ],
                ],
            ]);

        $response
            ->assertOk()
            ->assertJsonPath('summary.received', 1)
            ->assertJsonPath('summary.created', 0)
            ->assertJsonPath('summary.updated', 1);

        $existingCustomer->refresh();

        $this->assertSame('logo', $existingCustomer->source_system);
        $this->assertSame('2001', $existingCustomer->source_reference);
        $this->assertSame('Logo Cariya Donustu', $existingCustomer->name);
        $this->assertSame(1, Customer::query()->count());
    }

    public function test_logo_customer_sync_matches_exported_b2b_customer_by_logo_metadata_external_reference(): void
    {
        config(['integrations.logo.customer_sync_key' => 'test-sync-key']);

        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO',
            'name' => 'Logo Dealer',
            'is_active' => true,
        ]);

        $existingCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'source_reference' => null,
            'sync_status' => 'synced',
            'code' => 'CR-B2B-TEMP',
            'name' => 'B2B Gecici Cari',
            'is_active' => true,
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'external_ref' => '2002',
                    ],
                ],
            ],
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/customers/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'external_ref' => '2002',
                        'code' => 'CR-LOGO-2002',
                        'name' => 'Logo Geri Cekilen Cari',
                    ],
                ],
            ]);

        $response
            ->assertOk()
            ->assertJsonPath('summary.created', 0)
            ->assertJsonPath('summary.updated', 1);

        $existingCustomer->refresh();

        $this->assertSame('logo', $existingCustomer->source_system);
        $this->assertSame('2002', $existingCustomer->source_reference);
        $this->assertSame('CR-LOGO-2002', $existingCustomer->code);
        $this->assertSame('Logo Geri Cekilen Cari', $existingCustomer->name);
        $this->assertSame(1, Customer::query()->count());
    }

    public function test_logo_customer_sync_updates_existing_code_when_external_reference_changes(): void
    {
        config(['integrations.logo.customer_sync_key' => 'test-sync-key']);

        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO',
            'name' => 'Logo Dealer',
            'is_active' => true,
        ]);

        $existingCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '43',
            'sync_status' => 'synced',
            'code' => '120-00-023',
            'name' => 'Eski Cari',
            'is_active' => true,
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/customers/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'external_ref' => '1043',
                        'code' => ' 120-00-023 ',
                        'name' => 'Logo Guncel Cari',
                    ],
                ],
            ]);

        $response
            ->assertOk()
            ->assertJsonPath('summary.created', 0)
            ->assertJsonPath('summary.updated', 1);

        $existingCustomer->refresh();

        $this->assertSame('1043', $existingCustomer->source_reference);
        $this->assertSame('120-00-023', $existingCustomer->code);
        $this->assertSame('Logo Guncel Cari', $existingCustomer->name);
        $this->assertSame(1, Customer::query()->count());
    }

    public function test_logo_customer_sync_reads_contact_fields_from_logo_raw_payload_when_flat_fields_are_missing(): void
    {
        config(['integrations.logo.customer_sync_key' => 'test-sync-key']);

        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO',
            'name' => 'Logo Dealer',
            'is_active' => true,
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/customers/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'external_ref' => '5001',
                        'code' => 'CR-RAW-001',
                        'name' => 'Raw Alanli Cari',
                        'meta' => [
                            'raw' => [
                                'TELNRS1' => '02125550101',
                                'CITY' => 'Ankara',
                                'TOWN' => 'Cankaya',
                            ],
                        ],
                    ],
                ],
            ]);

        $response
            ->assertOk()
            ->assertJsonPath('summary.created', 1);

        $this->assertDatabaseHas('customers', [
            'dealer_id' => $dealer->id,
            'code' => 'CR-RAW-001',
            'phone' => '02125550101',
            'city' => 'Ankara',
            'district' => 'Cankaya',
        ]);
    }

    public function test_logo_customer_sync_assigns_salesperson_from_logo_specode4(): void
    {
        config(['integrations.logo.customer_sync_key' => 'test-sync-key']);

        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO',
            'name' => 'Logo Dealer',
            'is_active' => true,
        ]);

        $salespersonRole = Role::query()->firstOrCreate(
            ['slug' => 'salesperson'],
            ['name' => 'Salesperson']
        );

        $salesperson = User::factory()->create([
            'dealer_id' => $dealer->id,
            'logo_customer_specode4' => 'A',
            'is_active' => true,
        ]);
        $salesperson->roles()->attach($salespersonRole);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/customers/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'external_ref' => '3001',
                        'code' => 'CR-A-001',
                        'name' => 'A Plasiyer Cari',
                        'meta' => [
                            'specode4' => 'A',
                            'raw' => [
                                'SPECODE4' => 'A',
                            ],
                        ],
                    ],
                ],
            ]);

        $response
            ->assertOk()
            ->assertJsonPath('summary.created', 1);

        $this->assertDatabaseHas('customers', [
            'dealer_id' => $dealer->id,
            'code' => 'CR-A-001',
            'salesperson_user_id' => $salesperson->id,
        ]);
    }

    public function test_logo_customer_sync_assigns_salesperson_from_multiple_logo_specode4_values(): void
    {
        config(['integrations.logo.customer_sync_key' => 'test-sync-key']);

        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO-MULTI',
            'name' => 'Logo Multi Dealer',
            'is_active' => true,
        ]);

        $salespersonRole = Role::query()->firstOrCreate(
            ['slug' => 'salesperson'],
            ['name' => 'Salesperson']
        );

        $salesperson = User::factory()->create([
            'dealer_id' => $dealer->id,
            'logo_customer_specode4' => 'A,D',
            'is_active' => true,
        ]);
        $salesperson->roles()->attach($salespersonRole);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/customers/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'external_ref' => '3002',
                        'code' => 'CR-D-001',
                        'name' => 'D Plasiyer Cari',
                        'meta' => [
                            'specode4' => 'D',
                            'raw' => [
                                'SPECODE4' => 'D',
                            ],
                        ],
                    ],
                ],
            ]);

        $response
            ->assertOk()
            ->assertJsonPath('summary.created', 1);

        $this->assertDatabaseHas('customers', [
            'dealer_id' => $dealer->id,
            'code' => 'CR-D-001',
            'salesperson_user_id' => $salesperson->id,
        ]);
    }
}
