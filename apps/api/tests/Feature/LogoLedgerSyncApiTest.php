<?php

namespace Tests\Feature;

use App\Models\Collection;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\LedgerEntry;
use App\Models\Role;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class LogoLedgerSyncApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config([
            'integrations.logo.ledger_sync_key' => 'test-sync-key',
        ]);
    }

    public function test_logo_ledger_sync_requires_valid_integration_key(): void
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
            'name' => 'Test Cari',
            'is_active' => true,
        ]);

        $response = $this->postJson('/api/integrations/logo/ledger/sync', [
            'dealer_id' => $dealer->id,
            'records' => [
                [
                    'customer_external_ref' => $customer->source_reference,
                    'external_ref' => 'LEDGER-1001',
                    'date' => '2026-04-10',
                    'type' => 'invoice',
                    'debit' => 1250.50,
                ],
            ],
        ]);

        $response
            ->assertUnauthorized()
            ->assertJsonPath('message', 'Unauthorized integration request.');
    }

    public function test_logo_ledger_sync_upserts_entries_and_recalculates_balances(): void
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
            'name' => 'Test Cari',
            'is_active' => true,
        ]);

        $existingEntry = LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'LEDGER-1001',
            'date' => '2026-04-10',
            'type' => 'invoice',
            'debit' => 1000,
            'credit' => 0,
            'balance_after' => 1000,
            'entry_date' => '2026-04-10',
            'entry_type' => 'debit',
            'amount' => 1000,
            'currency' => 'TRY',
            'reference_no' => 'FAT-001',
            'description' => 'Eski fatura',
            'meta' => [
                'legacy' => 'keep',
            ],
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/ledger/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'customer_external_ref' => $customer->source_reference,
                        'external_ref' => 'LEDGER-1001',
                        'date' => '2026-04-10',
                        'type' => 'invoice',
                        'debit' => 1250.50,
                        'currency' => 'TRY',
                        'reference_no' => 'FAT-001',
                        'description' => 'Guncel fatura',
                        'meta' => [
                            'logo_module' => 'sales',
                        ],
                    ],
                    [
                        'customer_code' => $customer->code,
                        'external_ref' => 'LEDGER-1002',
                        'date' => '2026-04-11',
                        'type' => 'payment',
                        'credit' => 250.50,
                        'currency' => 'TRY',
                        'reference_no' => 'TAH-001',
                        'description' => 'Tahsilat',
                        'meta' => [
                            'raw' => [
                                'TRCODE' => 21,
                                'BANK_NAME' => 'Akbank',
                                'IBAN' => 'TR100000000000000000000001',
                            ],
                        ],
                    ],
                ],
            ]);

        $response
            ->assertOk()
            ->assertJsonPath('summary.received', 2)
            ->assertJsonPath('summary.created', 1)
            ->assertJsonPath('summary.updated', 1)
            ->assertJsonPath('summary.skipped', 0)
            ->assertJsonPath('summary.balances_recalculated', 1);

        $existingEntry->refresh();

        $this->assertSame('logo', $existingEntry->source_system);
        $this->assertSame('LEDGER-1001', $existingEntry->source_reference);
        $this->assertSame('1250.50', $existingEntry->debit);
        $this->assertSame('keep', $existingEntry->meta['legacy']);
        $this->assertSame('sales', $existingEntry->meta['integrations']['logo']['payload']['logo_module']);
        $this->assertNotNull($existingEntry->last_synced_at);
        $this->assertSame('1250.50', $existingEntry->balance_after);

        $newEntry = LedgerEntry::query()
            ->where('source_reference', 'LEDGER-1002')
            ->firstOrFail();

        $this->assertSame('payment', $newEntry->type);
        $this->assertSame('250.50', $newEntry->credit);
        $this->assertSame('1000.00', $newEntry->balance_after);

        $collection = Collection::query()
            ->where('source_system', 'logo')
            ->where('source_reference', 'LEDGER-1002')
            ->firstOrFail();

        $this->assertSame($customer->id, $collection->customer_id);
        $this->assertSame('transfer', $collection->method);
        $this->assertSame('250.50', $collection->amount);
        $this->assertSame('TAH-001', $collection->reference_no);
        $this->assertSame('Tahsilat', $collection->note);
        $this->assertSame('synced', $collection->sync_status);
        $this->assertSame('Akbank', $collection->reference_fields['bank_name']);
        $this->assertSame('TR100000000000000000000001', $collection->reference_fields['iban']);
        $this->assertSame($collection->id, $newEntry->collection_id);

        $this->assertDatabaseHas('integration_sync_states', [
            'system' => 'logo',
            'domain' => 'ledger',
            'direction' => 'inbound',
            'entity_type' => LedgerEntry::class,
            'entity_id' => $newEntry->id,
            'external_ref' => 'LEDGER-1002',
            'status' => 'synced',
        ]);

        $this->assertDatabaseHas('integration_sync_states', [
            'system' => 'logo',
            'domain' => 'collections',
            'direction' => 'inbound',
            'entity_type' => Collection::class,
            'entity_id' => $collection->id,
            'external_ref' => 'LEDGER-1002',
            'status' => 'synced',
        ]);
    }

    public function test_logo_ledger_sync_does_not_create_collection_for_non_payment_entries(): void
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
            'name' => 'Test Cari',
            'is_active' => true,
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/ledger/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'customer_external_ref' => $customer->source_reference,
                        'external_ref' => 'LEDGER-INV-1001',
                        'date' => '2026-04-10',
                        'type' => 'invoice',
                        'debit' => 1250.50,
                        'currency' => 'TRY',
                        'reference_no' => 'FAT-001',
                        'description' => 'Logo fatura hareketi',
                    ],
                ],
            ])
            ->assertOk();

        $this->assertDatabaseMissing('collections', [
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'LEDGER-INV-1001',
        ]);
    }

    public function test_logo_ledger_sync_reconciles_provisional_shipment_invoice_instead_of_creating_duplicate_debt(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-RECONCILE',
            'name' => 'Reconcile Dealer',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1672',
            'code' => '120-00-086',
            'name' => 'Murat Market',
            'is_active' => true,
        ]);

        $provisional = LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'INVOICE-41',
            'date' => '2026-07-06',
            'type' => 'invoice',
            'debit' => 4519.92,
            'credit' => 0,
            'balance_after' => 4519.92,
            'entry_date' => '2026-07-06',
            'entry_type' => 'debit',
            'amount' => 4519.92,
            'currency' => 'TRY',
            'reference_no' => 'SHP-20260706134502-ONTS',
            'description' => 'Logo sevkiyat faturasi SHP-20260706134502-ONTS',
            'meta' => [
                'source' => 'logo_shipment_invoice',
                'shipment_id' => 40,
                'shipment_no' => 'SHP-20260706134502-ONTS',
                'order_no' => 'ORD-20260706134456-D36N',
            ],
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/ledger/sync', [
                'dealer_id' => $dealer->id,
                'records' => [[
                    'customer_external_ref' => $customer->source_reference,
                    'external_ref' => '159',
                    'date' => '2026-07-06',
                    'type' => 'debit',
                    'debit' => 4519.92,
                    'credit' => 0,
                    'currency' => 'TRY',
                    'reference_no' => 'F0000001269699785',
                    'description' => 'SHP-20260706134502-ONTS',
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('summary.created', 0)
            ->assertJsonPath('summary.updated', 1)
            ->assertJsonPath('summary.duplicates_removed', 0);

        $this->assertSame(1, LedgerEntry::query()->where('customer_id', $customer->id)->count());

        $provisional->refresh();
        $this->assertSame('159', $provisional->source_reference);
        $this->assertSame('invoice', $provisional->type);
        $this->assertSame('F0000001269699785', $provisional->reference_no);
        $this->assertSame('logo_ledger', data_get($provisional->meta, 'source'));
        $this->assertSame(40, data_get($provisional->meta, 'shipment_id'));
        $this->assertNotNull(data_get($provisional->meta, 'provisional_reconciled_at'));
    }

    public function test_logo_ledger_sync_removes_existing_exact_shipment_invoice_duplicate(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-RECONCILE-OLD',
            'name' => 'Reconcile Existing Dealer',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1673',
            'code' => '120-00-087',
            'name' => 'Existing Duplicate Cari',
            'is_active' => true,
        ]);

        $provisional = LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'INVOICE-42',
            'date' => '2026-07-06',
            'type' => 'invoice',
            'debit' => 7914,
            'credit' => 0,
            'balance_after' => 7914,
            'entry_date' => '2026-07-06',
            'entry_type' => 'debit',
            'amount' => 7914,
            'currency' => 'TRY',
            'reference_no' => 'SHP-EXISTING-DUPLICATE',
            'description' => 'Logo sevkiyat faturasi SHP-EXISTING-DUPLICATE',
            'meta' => [
                'source' => 'logo_shipment_invoice',
                'shipment_id' => 42,
                'shipment_no' => 'SHP-EXISTING-DUPLICATE',
                'order_no' => 'ORD-EXISTING-DUPLICATE',
            ],
        ]);

        $authoritative = LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => '160',
            'date' => '2026-07-06',
            'type' => 'debit',
            'debit' => 7914,
            'credit' => 0,
            'balance_after' => 15828,
            'entry_date' => '2026-07-06',
            'entry_type' => 'debit',
            'amount' => 7914,
            'currency' => 'TRY',
            'reference_no' => 'F0000000000000160',
            'description' => 'SHP-EXISTING-DUPLICATE',
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'external_ref' => '160',
                    ],
                ],
            ],
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/ledger/sync', [
                'dealer_id' => $dealer->id,
                'records' => [[
                    'customer_external_ref' => $customer->source_reference,
                    'external_ref' => '160',
                    'date' => '2026-07-06',
                    'type' => 'debit',
                    'debit' => 7914,
                    'credit' => 0,
                    'currency' => 'TRY',
                    'reference_no' => 'F0000000000000160',
                    'description' => 'SHP-EXISTING-DUPLICATE',
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('summary.duplicates_removed', 1);

        $this->assertDatabaseMissing('ledger_entries', ['id' => $provisional->id]);

        $authoritative->refresh();
        $this->assertSame('invoice', $authoritative->type);
        $this->assertSame('logo_ledger', data_get($authoritative->meta, 'source'));
        $this->assertSame(42, data_get($authoritative->meta, 'shipment_id'));
        $this->assertSame('7914.00', $authoritative->balance_after);
    }

    public function test_logo_ledger_sync_links_existing_b2b_collection_instead_of_creating_duplicate_logo_collection(): void
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
            'name' => 'Test Cari',
            'is_active' => true,
        ]);

        $existingCollection = Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'source_reference' => 'KSLINES-17',
            'sync_status' => 'synced',
            'date' => '2026-04-10',
            'collection_date' => '2026-04-10',
            'method' => 'cash',
            'amount' => 250.50,
            'currency' => 'TRY',
            'reference_no' => 'TAH-001',
            'note' => 'B2B tahsilat',
            'meta' => [
                'source' => 'customer_collection',
            ],
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/ledger/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'customer_external_ref' => $customer->source_reference,
                        'external_ref' => 'CLFLINE-1002',
                        'date' => '2026-04-11',
                        'type' => 'payment',
                        'credit' => 250.50,
                        'currency' => 'TRY',
                        'reference_no' => 'TAH-001',
                        'description' => 'Tahsilat',
                        'meta' => [
                            'raw' => [
                                'SPECODE' => 'B2B-COL-'.$existingCollection->id,
                            ],
                        ],
                    ],
                ],
            ])
            ->assertOk();

        $this->assertDatabaseMissing('collections', [
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'CLFLINE-1002',
        ]);

        $newEntry = LedgerEntry::query()
            ->where('source_reference', 'CLFLINE-1002')
            ->firstOrFail();

        $this->assertSame($existingCollection->id, $newEntry->collection_id);
    }

    public function test_logo_ledger_sync_reuses_existing_b2b_collection_ledger_from_reference_text(): void
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
            'name' => 'Test Cari',
            'is_active' => true,
        ]);

        $existingCollection = Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'source_reference' => null,
            'sync_status' => 'synced',
            'date' => '2026-05-01',
            'collection_date' => '2026-05-01',
            'method' => 'cash',
            'amount' => 5000,
            'currency' => 'TRY',
            'reference_no' => null,
            'note' => 'test',
        ]);

        $existingLedgerEntry = LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'source_reference' => null,
            'date' => '2026-05-01',
            'type' => 'payment',
            'debit' => 0,
            'credit' => 5000,
            'balance_after' => -5000,
            'entry_date' => '2026-05-01',
            'entry_type' => 'credit',
            'amount' => 5000,
            'currency' => 'TRY',
            'reference_no' => null,
            'description' => 'test',
            'collection_id' => $existingCollection->id,
            'meta' => [
                'source' => 'customer_collection',
            ],
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/ledger/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'customer_external_ref' => $customer->source_reference,
                        'external_ref' => 'CLFLINE-5000',
                        'date' => '2026-05-01',
                        'type' => 'credit',
                        'credit' => 5000,
                        'currency' => 'TRY',
                        'reference_no' => '00000000B2B-COL-'.$existingCollection->id,
                        'description' => 'test',
                    ],
                ],
            ])
            ->assertOk()
            ->assertJsonPath('summary.created', 0)
            ->assertJsonPath('summary.updated', 1);

        $this->assertSame(1, LedgerEntry::query()->where('collection_id', $existingCollection->id)->count());

        $existingLedgerEntry->refresh();
        $this->assertSame('logo', $existingLedgerEntry->source_system);
        $this->assertSame('CLFLINE-5000', $existingLedgerEntry->source_reference);
        $this->assertSame('payment', $existingLedgerEntry->type);
        $this->assertSame('5000.00', $existingLedgerEntry->credit);
        $this->assertSame('-5000.00', $existingLedgerEntry->balance_after);
        $this->assertSame('CLFLINE-5000', $existingLedgerEntry->meta['integrations']['logo']['external_ref']);
    }

    public function test_customer_ledger_hides_legacy_logo_echo_for_b2b_collection(): void
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
            'name' => 'Test Cari',
            'is_active' => true,
        ]);

        $collection = Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'synced',
            'date' => '2026-05-01',
            'collection_date' => '2026-05-01',
            'method' => 'cash',
            'amount' => 5000,
            'currency' => 'TRY',
            'note' => 'test',
        ]);

        $b2bLedgerEntry = LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'date' => '2026-05-01',
            'type' => 'payment',
            'debit' => 0,
            'credit' => 5000,
            'balance_after' => -5000,
            'entry_date' => '2026-05-01',
            'entry_type' => 'credit',
            'amount' => 5000,
            'currency' => 'TRY',
            'description' => 'test',
            'collection_id' => $collection->id,
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'CLFLINE-5000',
            'date' => '2026-05-01',
            'type' => 'credit',
            'debit' => 0,
            'credit' => 5000,
            'balance_after' => -10000,
            'entry_date' => '2026-05-01',
            'entry_type' => 'credit',
            'amount' => 5000,
            'currency' => 'TRY',
            'reference_no' => '00000000B2B-COL-'.$collection->id,
            'description' => 'test',
            'collection_id' => $collection->id,
        ]);

        $adminRole = Role::query()->firstOrCreate(
            ['slug' => 'admin'],
            ['name' => 'Admin']
        );
        $admin = User::factory()->create([
            'is_active' => true,
        ]);
        $admin->roles()->sync([$adminRole->id]);

        $this
            ->actingAs($admin)
            ->getJson("/api/customers/{$customer->id}/ledger")
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $b2bLedgerEntry->id)
            ->assertJsonPath('data.0.credit', '5000.00')
            ->assertJsonPath('data.0.balance_after', '-5000.00');
    }

    public function test_customer_ledger_can_exclude_invoice_rows_for_collection_screen(): void
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
            'name' => 'Test Cari',
            'is_active' => true,
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'date' => '2026-05-01',
            'type' => 'invoice',
            'debit' => 778.79,
            'credit' => 0,
            'balance_after' => 778.79,
            'entry_date' => '2026-05-01',
            'entry_type' => 'debit',
            'amount' => 778.79,
            'currency' => 'TRY',
            'reference_no' => 'ORD-20260501120814-EZ83',
            'description' => 'Invoice created from order ORD-20260501120814-EZ83',
        ]);

        $paymentEntry = LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'date' => '2026-05-01',
            'type' => 'payment',
            'debit' => 0,
            'credit' => 5000,
            'balance_after' => -4221.21,
            'entry_date' => '2026-05-01',
            'entry_type' => 'credit',
            'amount' => 5000,
            'currency' => 'TRY',
            'description' => 'test',
        ]);

        $adminRole = Role::query()->firstOrCreate(
            ['slug' => 'admin'],
            ['name' => 'Admin']
        );
        $admin = User::factory()->create([
            'is_active' => true,
        ]);
        $admin->roles()->sync([$adminRole->id]);

        $this
            ->actingAs($admin)
            ->getJson("/api/customers/{$customer->id}/ledger")
            ->assertOk()
            ->assertJsonCount(2, 'data');

        $this
            ->actingAs($admin)
            ->getJson("/api/customers/{$customer->id}/ledger?exclude_types[]=invoice")
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $paymentEntry->id)
            ->assertJsonPath('data.0.type', 'payment')
            ->assertJsonPath('data.0.credit', '5000.00')
            ->assertJsonPath('data.0.balance_after', '-5000.00');
    }
}
