<?php

namespace Tests\Feature;

use App\Models\Collection;
use App\Models\Customer;
use App\Models\Dealer;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class LogoCustomerExportApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config([
            'integrations.logo.customer_sync_key' => 'test-sync-key',
        ]);
    }

    public function test_logo_customer_pending_requires_valid_integration_key(): void
    {
        $response = $this->getJson('/api/integrations/logo/customers/pending');

        $response
            ->assertUnauthorized()
            ->assertJsonPath('message', 'Unauthorized integration request.');
    }

    public function test_logo_customer_pending_returns_only_exportable_records(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO',
            'name' => 'Logo Dealer',
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'code' => 'CR-B2B-001',
            'name' => 'B2B Cari',
            'is_active' => true,
            'meta' => [
                'address' => 'Adres 1',
            ],
        ]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'sync_status' => 'failed',
            'sync_error' => 'Logo offline',
            'code' => 'CR-B2B-002',
            'name' => 'B2B Cari 2',
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1001',
            'sync_status' => 'synced',
            'code' => 'CR-LOGO-001',
            'name' => 'Logo Cari',
            'is_active' => true,
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/customers/pending?limit=10');

        $response
            ->assertOk()
            ->assertJsonPath('received', 2)
            ->assertJsonPath('records.0.customer_code', 'CR-B2B-001')
            ->assertJsonPath('records.0.export_key', 'B2B-CUST-1')
            ->assertJsonPath('records.0.address', 'Adres 1')
            ->assertJsonPath('records.0.logo.document_type', 'customer_card')
            ->assertJsonPath('records.0.logo.card_type', 3)
            ->assertJsonPath('records.0.logo.target_tables.0', 'CLCARD')
            ->assertJsonPath('records.1.customer_code', 'CR-B2B-002')
            ->assertJsonPath('records.1.sync_status', 'failed');
    }

    public function test_logo_customer_pending_prioritizes_fresh_pending_customers_before_failed_retries(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO',
            'name' => 'Logo Dealer',
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'sync_status' => 'failed',
            'sync_error' => 'Logo offline',
            'code' => 'CR-FAILED-OLD',
            'name' => 'Eski Hatali Cari',
            'is_active' => true,
            'updated_at' => now()->addMinutes(5),
        ]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'code' => 'CR-PENDING-OLD',
            'name' => 'Eski Bekleyen Cari',
            'is_active' => true,
            'updated_at' => now()->subMinute(),
        ]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'code' => 'CR-PENDING-NEW',
            'name' => 'Yeni Bekleyen Cari',
            'is_active' => true,
            'updated_at' => now(),
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/customers/pending?limit=3');

        $response
            ->assertOk()
            ->assertJsonPath('records.0.customer_code', 'CR-PENDING-NEW')
            ->assertJsonPath('records.1.customer_code', 'CR-PENDING-OLD')
            ->assertJsonPath('records.2.customer_code', 'CR-FAILED-OLD');
    }

    public function test_logo_customer_ack_updates_sync_status_and_logo_metadata(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO',
            'name' => 'Logo Dealer',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'code' => 'CR-B2B-001',
            'name' => 'B2B Cari',
            'is_active' => true,
            'meta' => [
                'legacy' => 'keep',
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'specode' => 'F1',
                            'cyphcode' => '120-MERKEZ',
                        ],
                    ],
                ],
            ],
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/customers/ack', [
                'records' => [
                    [
                        'customer_id' => $customer->id,
                        'status' => 'synced',
                        'external_ref' => '1001',
                        'meta' => [
                            'logo_code' => '120.01.0001',
                        ],
                    ],
                ],
            ]);

        $response
            ->assertOk()
            ->assertJsonPath('summary.received', 1)
            ->assertJsonPath('summary.synced', 1)
            ->assertJsonPath('summary.failed', 0)
            ->assertJsonPath('summary.skipped', 0);

        $customer->refresh();

        $this->assertSame('b2b', $customer->source_system);
        $this->assertSame('1001', $customer->source_reference);
        $this->assertSame('synced', $customer->sync_status);
        $this->assertNull($customer->sync_error);
        $this->assertSame('keep', $customer->meta['legacy']);
        $this->assertSame('1001', $customer->meta['integrations']['logo']['external_ref']);
        $this->assertSame('F1', $customer->meta['integrations']['logo']['payload']['specode']);
        $this->assertSame('120-MERKEZ', $customer->meta['integrations']['logo']['payload']['cyphcode']);
        $this->assertSame('120.01.0001', $customer->meta['integrations']['logo']['payload']['logo_code']);
        $this->assertNotNull($customer->last_synced_at);

        $this->assertDatabaseHas('integration_sync_states', [
            'system' => 'logo',
            'domain' => 'customers-write',
            'direction' => 'outbound',
            'entity_type' => Customer::class,
            'entity_id' => $customer->id,
            'external_ref' => '1001',
            'status' => 'synced',
        ]);
    }

    public function test_logo_customer_ack_marks_existing_b2b_collections_pending_after_customer_is_exported(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO',
            'name' => 'Logo Dealer',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'source_reference' => null,
            'sync_status' => 'pending',
            'code' => 'CR-B2B-003',
            'name' => 'B2B Cari 3',
            'is_active' => true,
        ]);

        $collection = Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'source_reference' => null,
            'sync_status' => null,
            'date' => '2026-04-15',
            'collection_date' => '2026-04-15',
            'method' => 'transfer',
            'amount' => 875,
            'currency' => 'TRY',
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/customers/ack', [
                'records' => [
                    [
                        'customer_id' => $customer->id,
                        'status' => 'synced',
                        'external_ref' => '1003',
                    ],
                ],
            ])
            ->assertOk()
            ->assertJsonPath('summary.synced', 1);

        $collection->refresh();

        $this->assertSame('pending', $collection->sync_status);
        $this->assertNull($collection->sync_error);
    }
}
