<?php

namespace Tests\Feature;

use App\Models\Cashbox;
use App\Models\Collection;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\LedgerEntry;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class LogoCollectionExportApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config([
            'integrations.logo.collection_sync_key' => 'test-sync-key',
        ]);
    }

    public function test_logo_collection_pending_requires_valid_integration_key(): void
    {
        $response = $this->getJson('/api/integrations/logo/collections/pending');

        $response
            ->assertUnauthorized()
            ->assertJsonPath('message', 'Unauthorized integration request.');
    }

    public function test_logo_collection_pending_returns_only_exportable_records(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO',
            'name' => 'Logo Dealer',
            'is_active' => true,
        ]);

        $logoCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1001',
            'code' => 'CR-1001',
            'name' => 'Logo Cari',
            'is_active' => true,
        ]);

        $cashbox = Cashbox::query()->create([
            'code' => '100.01.002',
            'name' => 'Ahmet Arac Kasasi',
            'is_active' => true,
        ]);

        $localCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => null,
            'source_reference' => null,
            'code' => 'CR-LOCAL',
            'name' => 'Lokal Cari',
            'is_active' => true,
        ]);

        $exportableCollection = Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $logoCustomer->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'date' => '2026-04-10',
            'collection_date' => '2026-04-10',
            'method' => 'transfer',
            'amount' => 500,
            'currency' => 'TRY',
            'reference_no' => 'TRF-001',
            'reference_fields' => [
                'transfer_no' => 'TRF-001',
            ],
            'meta' => [
                'cashbox_id' => $cashbox->id,
            ],
        ]);

        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $logoCustomer->id,
            'source_system' => 'b2b',
            'sync_status' => 'failed',
            'sync_error' => 'Logo offline',
            'date' => '2026-04-11',
            'collection_date' => '2026-04-11',
            'method' => 'cash',
            'amount' => 250,
            'currency' => 'TRY',
        ]);

        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $logoCustomer->id,
            'source_system' => 'b2b',
            'sync_status' => 'synced',
            'date' => '2026-04-12',
            'collection_date' => '2026-04-12',
            'method' => 'cash',
            'amount' => 125,
            'currency' => 'TRY',
        ]);

        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $localCustomer->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'date' => '2026-04-13',
            'collection_date' => '2026-04-13',
            'method' => 'cash',
            'amount' => 999,
            'currency' => 'TRY',
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/collections/pending?limit=10');

        $response
            ->assertOk()
            ->assertJsonPath('received', 2)
            ->assertJsonPath('records.0.collection_id', 1)
            ->assertJsonPath('records.0.customer_code', 'CR-1001')
            ->assertJsonPath('records.0.customer_external_ref', '1001')
            ->assertJsonPath('records.0.export_key', $exportableCollection->logoExportKey())
            ->assertJsonPath('records.0.cashbox_id', $cashbox->id)
            ->assertJsonPath('records.0.cashbox_code', '100.01.002')
            ->assertJsonPath('records.0.cashbox_name', 'Ahmet Arac Kasasi')
            ->assertJsonPath('records.0.meta.cashbox.code', '100.01.002')
            ->assertJsonPath('records.1.collection_id', 2)
            ->assertJsonPath('records.1.sync_status', 'failed');
    }

    public function test_logo_collection_pending_supports_customer_code_fallback_when_external_ref_is_missing(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO',
            'name' => 'Logo Dealer',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => null,
            'sync_status' => 'synced',
            'code' => 'CR-1002',
            'name' => 'Logo Cari Refsiz',
            'is_active' => true,
        ]);

        $collection = Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'date' => '2026-04-14',
            'collection_date' => '2026-04-14',
            'method' => 'cash',
            'amount' => 350,
            'currency' => 'TRY',
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/collections/pending?limit=10');

        $response
            ->assertOk()
            ->assertJsonPath('received', 1)
            ->assertJsonPath('records.0.customer_code', 'CR-1002')
            ->assertJsonPath('records.0.customer_external_ref', null)
            ->assertJsonPath('records.0.export_key', $collection->logoExportKey());
    }

    public function test_logo_collection_pending_maps_local_point_cashbox_to_logo_cashbox(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO',
            'name' => 'Logo Dealer',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1001',
            'code' => 'CR-1001',
            'name' => 'Logo Cari',
            'is_active' => true,
        ]);

        $cashbox = Cashbox::query()->create([
            'code' => 'POINT-30',
            'name' => 'Erzurum Hizli Satis Kasasi',
            'is_active' => true,
        ]);

        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'date' => '2026-06-03',
            'collection_date' => '2026-06-03',
            'method' => 'cash',
            'amount' => 100,
            'currency' => 'TRY',
            'meta' => [
                'cashbox_id' => $cashbox->id,
            ],
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/collections/pending?limit=10');

        $response
            ->assertOk()
            ->assertJsonPath('records.0.cashbox_id', $cashbox->id)
            ->assertJsonPath('records.0.cashbox_code', '100.01.007')
            ->assertJsonPath('records.0.cashbox_name', 'ERZURUM POINT KASASI')
            ->assertJsonPath('records.0.meta.cashbox.code', '100.01.007');
    }

    public function test_logo_collection_ack_updates_sync_status_and_logo_metadata(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO',
            'name' => 'Logo Dealer',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1001',
            'code' => 'CR-1001',
            'name' => 'Logo Cari',
            'is_active' => true,
        ]);

        $collection = Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'date' => '2026-04-10',
            'collection_date' => '2026-04-10',
            'method' => 'transfer',
            'amount' => 500,
            'currency' => 'TRY',
            'meta' => [
                'legacy' => 'keep',
            ],
        ]);

        $ledgerEntry = LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'collection_id' => $collection->id,
            'date' => '2026-04-10',
            'type' => 'payment',
            'debit' => 0,
            'credit' => 500,
            'balance_after' => -500,
            'entry_date' => '2026-04-10',
            'entry_type' => 'credit',
            'amount' => 500,
            'currency' => 'TRY',
            'meta' => [
                'legacy' => 'keep',
            ],
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/collections/ack', [
                'records' => [
                    [
                        'collection_id' => $collection->id,
                        'status' => 'synced',
                        'external_ref' => 'CLFICHE-5001',
                        'meta' => [
                            'logo_fiche_no' => 'THS-001',
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

        $collection->refresh();
        $ledgerEntry->refresh();

        $this->assertSame('synced', $collection->sync_status);
        $this->assertSame('CLFICHE-5001', $collection->source_reference);
        $this->assertSame('keep', $collection->meta['legacy']);
        $this->assertSame('THS-001', $collection->meta['integrations']['logo']['payload']['logo_fiche_no']);
        $this->assertSame('CLFICHE-5001', $collection->meta['integrations']['logo']['external_ref']);
        $this->assertNotNull($collection->last_synced_at);
        $this->assertSame('keep', $ledgerEntry->meta['legacy']);
        $this->assertSame('CLFICHE-5001', $ledgerEntry->meta['integrations']['logo']['collection_external_ref']);
        $this->assertNotNull($ledgerEntry->last_synced_at);

        $this->assertDatabaseHas('integration_sync_states', [
            'system' => 'logo',
            'domain' => 'collections',
            'direction' => 'outbound',
            'entity_type' => Collection::class,
            'entity_id' => $collection->id,
            'external_ref' => 'CLFICHE-5001',
            'status' => 'synced',
        ]);

        $this->assertDatabaseHas('integration_sync_states', [
            'system' => 'logo',
            'domain' => 'collections-write',
            'direction' => 'outbound',
            'entity_type' => Collection::class,
            'entity_id' => $collection->id,
            'external_ref' => 'CLFICHE-5001',
            'status' => 'synced',
        ]);
    }
}
