<?php

namespace Tests\Feature;

use App\Models\Cashbox;
use App\Models\Collection;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\LedgerEntry;
use App\Models\User;
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

    public function test_duplicate_cscard_failure_is_not_blindly_retried(): void
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

        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'failed',
            'sync_error' => "Cannot insert duplicate key row in object 'dbo.LG_003_01_CSCARD' with unique index 'I003_01_CSCARD_I2'.",
            'date' => '2026-07-31',
            'collection_date' => '2026-07-31',
            'method' => 'check',
            'amount' => 100,
            'currency' => 'TRY',
        ]);

        $this->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/collections/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('received', 0)
            ->assertJsonCount(0, 'records');
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

    public function test_logo_collection_pending_includes_customer_title_and_salesperson_code_for_logo_write(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-SALESPERSON',
            'name' => 'Salesperson Dealer',
            'is_active' => true,
        ]);
        $salesperson = User::query()->create([
            'dealer_id' => $dealer->id,
            'name' => 'Ahmet Arac',
            'username' => 'AHMET.ARAC',
            'logo_customer_specode4' => 'A',
            'email' => 'ahmet@example.test',
            'password' => 'password',
            'is_active' => true,
        ]);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $salesperson->id,
            'source_system' => 'logo',
            'source_reference' => '1001',
            'code' => 'CR-SALESPERSON',
            'name' => 'Logo Unvanli Cari',
            'is_active' => true,
        ]);

        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'date' => '2026-08-25',
            'collection_date' => '2026-08-25',
            'method' => 'cash',
            'amount' => 2000,
            'currency' => 'TRY',
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/collections/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('records.0.customer_name', 'Logo Unvanli Cari')
            ->assertJsonPath('records.0.salesperson_code', 'A')
            ->assertJsonPath('records.0.salesperson.username', 'AHMET.ARAC')
            ->assertJsonPath('records.0.salesperson.logo_code', 'A')
            ->assertJsonPath('records.0.logo.salesperson_code', 'A');
    }

    public function test_logo_collection_salesperson_uses_collector_before_customer_salesperson(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-COLLECTOR',
            'name' => 'Collector Dealer',
            'is_active' => true,
        ]);
        $customerSalesperson = User::query()->create([
            'dealer_id' => $dealer->id,
            'name' => 'Cari Plasiyer',
            'username' => 'CARI.PLASIYER',
            'logo_customer_specode4' => 'C',
            'email' => 'cari-plasiyer@example.test',
            'password' => 'password',
            'is_active' => true,
        ]);
        $collector = User::query()->create([
            'dealer_id' => $dealer->id,
            'name' => 'Ahmet Arac',
            'username' => 'AHMET.ARAC',
            'logo_customer_specode4' => 'A',
            'email' => 'collector-ahmet@example.test',
            'password' => 'password',
            'is_active' => true,
        ]);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $customerSalesperson->id,
            'source_system' => 'logo',
            'source_reference' => '1002',
            'code' => 'CR-COLLECTOR',
            'name' => 'Collector Customer',
            'is_active' => true,
        ]);

        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'collected_by_user_id' => $collector->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'date' => '2026-08-26',
            'collection_date' => '2026-08-26',
            'method' => 'cash',
            'amount' => 456,
            'currency' => 'TRY',
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/collections/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('records.0.salesperson_code', 'A')
            ->assertJsonPath('records.0.salesperson.username', 'AHMET.ARAC')
            ->assertJsonPath('records.0.salesperson.logo_code', 'A')
            ->assertJsonPath('records.0.logo.salesperson_code', 'A');
    }

    public function test_logo_collection_salesperson_falls_back_to_customer_when_actor_has_multiple_logo_codes(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-MANAGER',
            'name' => 'Manager Dealer',
            'is_active' => true,
        ]);
        $customerSalesperson = User::query()->create([
            'dealer_id' => $dealer->id,
            'name' => 'Ahmet Arac',
            'username' => 'AHMET.ARAC',
            'logo_customer_specode4' => 'A',
            'email' => 'assigned-ahmet@example.test',
            'password' => 'password',
            'is_active' => true,
        ]);
        $manager = User::query()->create([
            'dealer_id' => $dealer->id,
            'name' => 'Erzurum Mudur',
            'username' => 'MUDUR.ERZURUM',
            'logo_customer_specode4' => 'A,B,C,D',
            'email' => 'manager@example.test',
            'password' => 'password',
            'is_active' => true,
        ]);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $customerSalesperson->id,
            'source_system' => 'logo',
            'source_reference' => '1003',
            'code' => 'CR-MANAGER',
            'name' => 'Manager Customer',
            'is_active' => true,
        ]);

        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'created_by_user_id' => $manager->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'date' => '2026-08-26',
            'collection_date' => '2026-08-26',
            'method' => 'check',
            'amount' => 1222.22,
            'currency' => 'TRY',
            'reference_fields' => [
                'check_no' => '6235353',
                'due_date' => '2026-12-12',
            ],
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/collections/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('records.0.salesperson_code', 'A')
            ->assertJsonPath('records.0.salesperson.username', 'AHMET.ARAC')
            ->assertJsonPath('records.0.salesperson.logo_code', 'A')
            ->assertJsonPath('records.0.logo.salesperson_code', 'A');
    }

    public function test_note_export_always_uses_a_logo_safe_portfolio_number(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-NOTE-PORTFOLIO',
            'name' => 'Note Portfolio Dealer',
            'is_active' => true,
        ]);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1009',
            'code' => 'CR-NOTE-PORTFOLIO',
            'name' => 'Note Portfolio Customer',
            'is_active' => true,
        ]);
        $collection = Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'date' => '2026-07-27',
            'collection_date' => '2026-07-27',
            'method' => 'note',
            'amount' => 900,
            'currency' => 'TRY',
            'reference_no' => 'B2B-COL-192-20260',
            'reference_fields' => [
                'note_no' => 'B2B-COL-192-20260',
                'due_date' => '2026-10-27',
            ],
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/collections/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('received', 1);

        $portfolioNo = (string) $response->json('records.0.reference_fields.portfolio_no');

        $this->assertLessThanOrEqual(16, strlen($portfolioNo));
        $this->assertSame('B2B-COL-192-20260', $response->json('records.0.reference_fields.note_no'));
        $this->assertSame('B2B-COL-192-20260', $response->json('records.0.logo.document_no'));
        $this->assertSame($collection->id, $response->json('records.0.collection_id'));
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

    public function test_logo_collection_pending_maps_main_pos_cashbox_to_logo_point_cashbox(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-MAIN-POS',
            'name' => 'Main POS Dealer',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1001',
            'code' => 'CR-MAIN-POS',
            'name' => 'Main POS Cari',
            'is_active' => true,
        ]);

        $cashbox = Cashbox::query()->create([
            'code' => 'MAIN-POS',
            'name' => 'Ana POS Kasasi',
            'is_active' => true,
        ]);

        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'date' => '2026-07-06',
            'collection_date' => '2026-07-06',
            'method' => 'cash',
            'amount' => 161.68,
            'currency' => 'TRY',
            'meta' => [
                'source' => 'pos_sale',
                'cashbox_id' => $cashbox->id,
            ],
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/collections/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('records.0.cashbox_id', $cashbox->id)
            ->assertJsonPath('records.0.cashbox_code', '100.01.007')
            ->assertJsonPath('records.0.cashbox_name', 'ERZURUM POINT KASASI')
            ->assertJsonPath('records.0.meta.cashbox.code', '100.01.007');
    }

    public function test_logo_collection_pending_routes_physical_pos_to_customer_credit_card_fiche(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POS-COL',
            'name' => 'Physical POS Collection Dealer',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1001',
            'code' => 'CR-POS-COL',
            'name' => 'Physical POS Cari',
            'is_active' => true,
        ]);

        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'date' => '2026-07-15',
            'collection_date' => '2026-07-15',
            'method' => 'cc',
            'amount' => 500,
            'currency' => 'TRY',
            'reference_fields' => [
                'collection_channel' => 'physical_pos',
                'pos_bank' => 'ziraat',
                'bank_name' => 'Ziraat Bankası',
                'bank_logo_code' => 'ZRT',
            ],
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/collections/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('records.0.method', 'cc')
            ->assertJsonPath('records.0.reference_fields.bank_logo_code', 'ZRT')
            ->assertJsonPath('records.0.logo.bank_code', 'ZRT')
            ->assertJsonPath('records.0.logo.target_tables.0', 'CLFICHE')
            ->assertJsonPath('records.0.logo.target_tables.1', 'CLFLINE')
            ->assertJsonPath('records.0.logo.target_tables.2', 'PAYTRANS')
            ->assertJsonMissingPath('records.0.logo.target_tables.3');
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

    public function test_failed_collection_uses_backoff_before_it_is_returned_again(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO-RETRY',
            'name' => 'Logo Retry Dealer',
            'is_active' => true,
        ]);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1002',
            'code' => 'CR-RETRY',
            'name' => 'Logo Retry Cari',
            'is_active' => true,
        ]);
        $collection = Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'date' => '2026-07-01',
            'collection_date' => '2026-07-01',
            'method' => 'cash',
            'amount' => 100,
            'currency' => 'TRY',
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/collections/ack', [
                'records' => [[
                    'collection_id' => $collection->id,
                    'status' => 'failed',
                    'error' => 'temporary Logo lock',
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('summary.failed', 1);

        $collection->refresh();
        $this->assertSame(1, $collection->meta['integrations']['logo']['retry']['attempt_count']);
        $this->assertNotNull($collection->meta['integrations']['logo']['retry']['next_retry_at']);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/collections/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('received', 0);

        $meta = $collection->meta;
        $meta['integrations']['logo']['retry']['next_retry_at'] = now()->subSecond()->toIso8601String();
        $collection->forceFill(['meta' => $meta])->save();

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/collections/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('received', 1)
            ->assertJsonPath('records.0.collection_id', $collection->id);
    }
}
