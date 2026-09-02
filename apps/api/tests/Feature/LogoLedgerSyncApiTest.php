<?php

namespace Tests\Feature;

use App\Models\Collection;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\LedgerEntry;
use App\Models\Order;
use App\Models\Role;
use App\Models\User;
use App\Http\Resources\LedgerEntryResource;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
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

    public function test_logo_ledger_sync_maps_eryaz_customer_code_from_logo_definition2(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO-ERYAZ',
            'name' => 'Logo Eryaz Dealer',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '2001',
            'code' => '120-36-076',
            'name' => 'ERK MAKINA',
            'is_active' => true,
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
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/ledger/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'customer_code' => '120-36-024',
                        'external_ref' => 'ERYAZLED|GUCSAAS2026|120-36-024|CH-1',
                        'date' => '2026-08-26',
                        'type' => 'payment',
                        'credit' => 250,
                        'currency' => 'TRY',
                        'reference_no' => 'CH-1',
                        'description' => 'Eryaz eski kodlu tahsilat',
                    ],
                ],
            ])
            ->assertOk()
            ->assertJsonPath('summary.created', 1)
            ->assertJsonPath('summary.failed', 0);

        $this->assertDatabaseHas('ledger_entries', [
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'ERYAZLED|GUCSAAS2026|120-36-024|CH-1',
            'type' => 'payment',
            'credit' => '250.00',
        ]);
    }

    public function test_logo_invoice_fallback_does_not_duplicate_matching_ledger_document(): void
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

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/ledger/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'customer_external_ref' => $customer->source_reference,
                        'external_ref' => 'INVOICE-9001',
                        'date' => '2026-08-25',
                        'type' => 'invoice',
                        'debit' => 2000,
                        'currency' => 'TRY',
                        'reference_no' => 'FAT-9001',
                        'description' => 'FAT-9001',
                        'meta' => [
                            'logo_source' => 'invoice_fallback',
                            'raw' => [
                                'LOGICALREF' => 9001,
                                'FICHENO' => 'FAT-9001',
                            ],
                        ],
                    ],
                    [
                        'customer_external_ref' => $customer->source_reference,
                        'external_ref' => 'LEDGER-7771',
                        'date' => '2026-08-25',
                        'type' => 'invoice',
                        'debit' => 2000,
                        'currency' => 'TRY',
                        'reference_no' => 'FAT-9001',
                        'description' => 'FAT-9001',
                        'meta' => [
                            'logo_table' => 'LG_003_01_CLFLINE',
                            'raw' => [
                                'LOGICALREF' => 7771,
                                'FICHENO' => 'FAT-9001',
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
            ->assertJsonPath('summary.balances_recalculated', 1);

        $this->assertSame(1, LedgerEntry::query()
            ->where('customer_id', $customer->id)
            ->where('reference_no', 'FAT-9001')
            ->count());

        $entry = LedgerEntry::query()
            ->where('customer_id', $customer->id)
            ->where('reference_no', 'FAT-9001')
            ->firstOrFail();

        $this->assertSame('INVOICE-9001', $entry->source_reference);
        $this->assertSame('2000.00', $entry->debit);
        $this->assertTrue((bool) data_get($entry->meta, 'integrations.logo.matched_by_document'));
        $this->assertContains('LEDGER-7771', data_get($entry->meta, 'integrations.logo.alternate_external_refs'));
    }

    public function test_logo_invoice_fallback_lines_are_exposed_on_customer_ledger_detail(): void
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
                'records' => [[
                    'customer_external_ref' => $customer->source_reference,
                    'external_ref' => 'INVOICE-9101',
                    'date' => '2026-08-25',
                    'type' => 'invoice',
                    'debit' => 2400,
                    'currency' => 'TRY',
                    'reference_no' => 'FAT-9101',
                    'description' => 'Logo fatura FAT-9101',
                    'meta' => [
                        'logo_source' => 'invoice_fallback',
                        'logo_invoice_ref' => 9101,
                        'logo_invoice_trcode' => 8,
                        'logo_document_kind' => 'sales_invoice',
                        'logo_invoice_lines' => [[
                            'logo_line_ref' => 7001,
                            'line_no' => 1,
                            'product_code' => 'CS0040',
                            'product_name' => 'CLIO 1.4 - 1.5DCI',
                            'quantity' => 5,
                            'unit' => 'ADET',
                            'unit_price' => 400,
                            'discount_total' => 0,
                            'vat_rate' => 20,
                            'vat_amount' => 400,
                            'line_total' => 2400,
                        ]],
                    ],
                ]],
            ])
            ->assertOk();

        $adminRole = Role::query()->firstOrCreate(['slug' => 'admin'], ['name' => 'Admin']);
        $admin = User::factory()->create(['is_active' => true]);
        $admin->roles()->sync([$adminRole->id]);

        $this
            ->actingAs($admin)
            ->getJson("/api/customers/{$customer->id}/ledger")
            ->assertOk()
            ->assertJsonPath('data.0.reference_no', 'FAT-9101')
            ->assertJsonPath('data.0.transaction_type', 'invoice')
            ->assertJsonPath('data.0.logo_invoice_detail.invoice_ref', '9101')
            ->assertJsonPath('data.0.logo_invoice_detail.lines.0.product_code', 'CS0040')
            ->assertJsonPath('data.0.logo_invoice_detail.lines.0.quantity', '5.00')
            ->assertJsonPath('data.0.logo_invoice_detail.lines.0.line_total', '2400.00');
    }

    public function test_logo_sales_return_invoice_trcode_is_classified_as_return(): void
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
                'records' => [[
                    'customer_external_ref' => $customer->source_reference,
                    'external_ref' => 'INVOICE-RETURN-9102',
                    'date' => '2026-08-25',
                    'type' => 'invoice',
                    'credit' => 600,
                    'currency' => 'TRY',
                    'reference_no' => 'IAD-9102',
                    'description' => 'Logo iade faturasi IAD-9102',
                    'meta' => [
                        'logo_source' => 'invoice_fallback',
                        'logo_invoice_ref' => 9102,
                        'logo_invoice_trcode' => 3,
                        'logo_document_kind' => 'sales_return_invoice',
                    ],
                ]],
            ])
            ->assertOk();

        $entry = LedgerEntry::query()
            ->where('source_reference', 'INVOICE-RETURN-9102')
            ->firstOrFail();

        $this->assertSame('credit', $entry->type);
        $this->assertSame('600.00', $entry->credit);

        $adminRole = Role::query()->firstOrCreate(['slug' => 'admin'], ['name' => 'Admin']);
        $admin = User::factory()->create(['is_active' => true]);
        $admin->roles()->sync([$adminRole->id]);

        $this
            ->actingAs($admin)
            ->getJson("/api/customers/{$customer->id}/ledger")
            ->assertOk()
            ->assertJsonPath('data.0.transaction_type', 'return')
            ->assertJsonPath('data.0.transaction_type_label', 'İade');
    }

    public function test_customer_ledger_defaults_to_2026_date_range(): void
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
            'source_system' => 'logo',
            'source_reference' => 'LEDGER-2025',
            'date' => '2025-12-31',
            'type' => 'invoice',
            'debit' => 100,
            'credit' => 0,
            'balance_after' => 100,
            'entry_date' => '2025-12-31',
            'entry_type' => 'debit',
            'amount' => 100,
            'currency' => 'TRY',
            'reference_no' => 'FAT-2025',
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'LEDGER-2026',
            'date' => '2026-01-01',
            'type' => 'invoice',
            'debit' => 200,
            'credit' => 0,
            'balance_after' => 300,
            'entry_date' => '2026-01-01',
            'entry_type' => 'debit',
            'amount' => 200,
            'currency' => 'TRY',
            'reference_no' => 'FAT-2026',
        ]);

        $adminRole = Role::query()->firstOrCreate(['slug' => 'admin'], ['name' => 'Admin']);
        $admin = User::factory()->create(['is_active' => true]);
        $admin->roles()->sync([$adminRole->id]);

        $this
            ->actingAs($admin)
            ->getJson("/api/customers/{$customer->id}/ledger")
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.reference_no', 'FAT-2026');

        $this
            ->actingAs($admin)
            ->getJson("/api/customers/{$customer->id}/ledger?date_from=2025-01-01&date_to=2025-12-31")
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.reference_no', 'FAT-2025');
    }

    public function test_customer_ledger_displays_open_orders_without_balance_effect(): void
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
            'code' => 'CR-ORDER-BALANCE',
            'name' => 'Order Balance Test Cari',
            'is_active' => true,
        ]);

        $adminRole = Role::query()->firstOrCreate(['slug' => 'admin'], ['name' => 'Admin']);
        $admin = User::factory()->create([
            'dealer_id' => $dealer->id,
            'is_active' => true,
        ]);
        $admin->roles()->sync([$adminRole->id]);

        $order = Order::query()->create([
            'order_no' => 'ORD-BALANCE-001',
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'user_id' => $admin->id,
            'status' => 'approved',
            'currency' => 'TRY',
            'subtotal' => 10000,
            'discount_total' => 0,
            'tax_total' => 0,
            'grand_total' => 10000,
            'ordered_at' => '2026-02-01 10:00:00',
            'approved_at' => '2026-02-01 10:05:00',
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'order_id' => $order->id,
            'source_system' => 'b2b',
            'source_reference' => $order->order_no,
            'date' => '2026-02-01',
            'type' => 'debit',
            'debit' => 10000,
            'credit' => 0,
            'balance_after' => 10000,
            'entry_date' => '2026-02-01',
            'entry_type' => 'debit',
            'amount' => 10000,
            'currency' => 'TRY',
            'reference_no' => $order->order_no,
            'description' => 'Legacy open order debt row',
            'meta' => [
                'source' => 'order_visibility',
                'order_no' => $order->order_no,
                'order_total' => '10000.00',
            ],
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'LOGO-INVOICE-001',
            'date' => '2026-02-02',
            'type' => 'invoice',
            'debit' => 300,
            'credit' => 0,
            'balance_after' => 300,
            'entry_date' => '2026-02-02',
            'entry_type' => 'debit',
            'amount' => 300,
            'currency' => 'TRY',
            'reference_no' => 'FAT-ORDER-001',
            'description' => 'Logo invoice',
        ]);

        $this
            ->actingAs($admin)
            ->getJson("/api/customers/{$customer->id}/ledger?date_from=2026-01-01&date_to=2026-12-31")
            ->assertOk()
            ->assertJsonCount(2, 'data')
            ->assertJsonPath('summary.total_debit', '300.00')
            ->assertJsonPath('summary.total_credit', '0.00')
            ->assertJsonPath('summary.balance', '300.00')
            ->assertJsonPath('summary.total_count', 2);

        $this->assertDatabaseHas('ledger_entries', [
            'order_id' => $order->id,
            'type' => 'debit',
            'debit' => 0,
            'credit' => 0,
            'amount' => 0,
        ]);

        $this
            ->actingAs($admin)
            ->getJson('/api/customers?q=CR-ORDER-BALANCE&limit=5')
            ->assertOk()
            ->assertJsonPath('data.0.balance_summary.total_due', '300.00')
            ->assertJsonPath('data.0.balance_summary.order_due', '10000.00');
    }

    public function test_logo_ledger_sync_skips_unmatched_customers_without_blocking_valid_records(): void
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

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/ledger/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'customer_code' => $customer->code,
                        'external_ref' => 'LEDGER-VALID-1001',
                        'date' => '2026-07-08',
                        'type' => 'invoice',
                        'debit' => 500,
                        'currency' => 'TRY',
                        'reference_no' => 'FAT-VALID',
                        'description' => 'Gecerli fatura',
                    ],
                    [
                        'customer_code' => 'CR-MISSING',
                        'external_ref' => 'LEDGER-MISSING-1001',
                        'date' => '2026-07-08',
                        'type' => 'invoice',
                        'debit' => 750,
                        'currency' => 'TRY',
                        'reference_no' => 'FAT-MISSING',
                        'description' => 'B2B carisi olmayan fatura',
                    ],
                ],
            ]);

        $response
            ->assertOk()
            ->assertJsonPath('summary.received', 2)
            ->assertJsonPath('summary.created', 1)
            ->assertJsonPath('summary.failed', 1)
            ->assertJsonPath('summary.balances_recalculated', 1);

        $this->assertDatabaseHas('ledger_entries', [
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'LEDGER-VALID-1001',
            'debit' => '500.00',
        ]);

        $this->assertDatabaseMissing('ledger_entries', [
            'source_reference' => 'LEDGER-MISSING-1001',
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

    public function test_logo_ledger_sync_preserves_linked_b2b_collection_methods_for_all_payment_channels(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-COL-METHODS',
            'name' => 'Collection Method Dealer',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => 'COL-METHOD-CUSTOMER',
            'code' => '120-25-777',
            'name' => 'Collection Method Cari',
            'is_active' => true,
        ]);

        $cases = [
            'cash' => [
                'method' => 'cash',
                'reference_fields' => [],
                'label' => 'Nakit',
                'description' => 'NA0001 Collection Method Cari',
            ],
            'physical_pos' => [
                'method' => 'cc',
                'reference_fields' => ['collection_channel' => 'physical_pos'],
                'label' => 'Fiziksel POS',
                'description' => 'FP0001 Collection Method Cari',
            ],
            'factory_pos' => [
                'method' => 'cc',
                'reference_fields' => [
                    'collection_channel' => 'factory',
                    'factory_customer_code' => '120-61-006',
                ],
                'label' => 'Fabrika Kart Çekimi',
                'description' => 'FBC0001 Collection Method Cari',
            ],
            'transfer' => [
                'method' => 'transfer',
                'reference_fields' => ['bank_code' => 'ziraat_bankasi'],
                'label' => 'Havale / EFT',
                'description' => 'HE0001 Collection Method Cari',
            ],
        ];

        foreach ($cases as $key => $case) {
            $collection = Collection::query()->create([
                'dealer_id' => $dealer->id,
                'customer_id' => $customer->id,
                'source_system' => 'b2b',
                'sync_status' => 'synced',
                'date' => '2026-08-26',
                'collection_date' => '2026-08-26',
                'method' => $case['method'],
                'amount' => 10,
                'currency' => 'TRY',
                'reference_no' => strtoupper($key).'-001',
                'reference_fields' => $case['reference_fields'],
                'note' => $case['description'],
            ]);

            LedgerEntry::query()->create([
                'dealer_id' => $dealer->id,
                'customer_id' => $customer->id,
                'source_system' => 'logo',
                'source_reference' => "CLFLINE-{$key}",
                'date' => '2026-08-26',
                'type' => 'payment',
                'debit' => 0,
                'credit' => 10,
                'balance_after' => -10,
                'entry_date' => '2026-08-26',
                'entry_type' => 'credit',
                'amount' => 10,
                'currency' => 'TRY',
                'reference_no' => strtoupper($key).'-001',
                'description' => $case['description'],
                'collection_id' => $collection->id,
            ]);
        }

        $records = collect(array_keys($cases))
            ->map(function (string $key) use ($customer, $cases): array {
                return [
                    'customer_external_ref' => $customer->source_reference,
                    'external_ref' => "CLFLINE-{$key}",
                    'date' => '2026-08-26',
                    'type' => 'credit',
                    'credit' => 10,
                    'currency' => 'TRY',
                    'reference_no' => strtoupper($key).'-001',
                    'description' => $cases[$key]['description'],
                    'meta' => [
                        'raw' => [
                            'MODULENR' => 5,
                            'TRCODE' => $key === 'factory_pos' ? 5 : 70,
                            'LINEEXP' => '00000000B2B-COL-'.Collection::query()
                                ->where('note', $cases[$key]['description'])
                                ->value('id'),
                        ],
                    ],
                ];
            })
            ->all();

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/ledger/sync', [
                'dealer_id' => $dealer->id,
                'records' => $records,
            ])
            ->assertOk()
            ->assertJsonPath('summary.updated', count($cases));

        foreach ($cases as $key => $case) {
            $entry = LedgerEntry::query()
                ->where('source_reference', "CLFLINE-{$key}")
                ->with('collection')
                ->firstOrFail();

            $this->assertSame('payment', $entry->type, "{$key} tahsilat tipi iade/alacak olarak ezilmemeli.");
            $this->assertSame($case['label'], (new LedgerEntryResource($entry))->toArray(new Request)['collection_method_label']);
            $this->assertSame('Tahsilat', (new LedgerEntryResource($entry))->toArray(new Request)['transaction_type_label']);
        }
    }

    public function test_logo_ledger_sync_matches_b2b_factory_collection_by_document_code_when_logo_has_no_collection_id(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-FBC-DOC',
            'name' => 'Factory Collection Dealer',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => 'FBC-DOC-CUSTOMER',
            'code' => '120-00-087',
            'name' => 'DENEME2 MURAT',
            'is_active' => true,
        ]);

        $collection = Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'synced',
            'date' => '2026-08-26',
            'collection_date' => '2026-08-26',
            'method' => 'cc',
            'amount' => 11.11,
            'currency' => 'TRY',
            'reference_no' => 'FBC0038',
            'reference_fields' => [
                'collection_channel' => 'factory',
                'factory_customer_code' => '120-61-006',
            ],
            'note' => 'FBC0038 DENEME2 MURAT',
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'CLFLINE-FBC0038',
            'date' => '2026-08-26',
            'type' => 'credit',
            'debit' => 0,
            'credit' => 11.11,
            'balance_after' => -47679.76,
            'entry_date' => '2026-08-26',
            'entry_type' => 'credit',
            'amount' => 11.11,
            'currency' => 'TRY',
            'reference_no' => '20260826140140000',
            'description' => 'FBC0038 DENEME2 MURAT',
            'collection_id' => null,
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/ledger/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'customer_external_ref' => $customer->source_reference,
                        'external_ref' => 'CLFLINE-FBC0038',
                        'date' => '2026-08-26',
                        'type' => 'credit',
                        'credit' => 11.11,
                        'balance_after' => -47679.76,
                        'currency' => 'TRY',
                        'reference_no' => '20260826140140000',
                        'description' => 'FBC0038 DENEME2 MURAT',
                        'meta' => [
                            'raw' => [
                                'MODULENR' => 5,
                                'TRCODE' => 5,
                                'TRANNO' => '20260826140140000',
                                'DOCODE' => 'FBC0038',
                                'LINEEXP' => 'FBC0038 DENEME2 MURAT',
                            ],
                        ],
                    ],
                ],
            ])
            ->assertOk()
            ->assertJsonPath('summary.updated', 1);

        $entry = LedgerEntry::query()
            ->where('source_reference', 'CLFLINE-FBC0038')
            ->with('collection')
            ->firstOrFail();

        $this->assertSame($collection->id, $entry->collection_id);
        $this->assertSame('payment', $entry->type);
        $this->assertSame('Fabrika Kart Çekimi', (new LedgerEntryResource($entry))->toArray(new Request)['collection_method_label']);
        $this->assertSame('Tahsilat', (new LedgerEntryResource($entry))->toArray(new Request)['transaction_type_label']);
    }

    public function test_logo_ledger_sync_classifies_manual_virman_credit_as_payment(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-MANUAL-VIRMAN',
            'name' => 'Manual Virman Dealer',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => 'MANUAL-VIRMAN-CUSTOMER',
            'code' => '120-25-262',
            'name' => 'OTO POLAT LEVENT POLAT',
            'is_active' => true,
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/ledger/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'customer_external_ref' => $customer->source_reference,
                        'external_ref' => 'CLFLINE-MANUAL-VIRMAN-CREDIT',
                        'date' => '2026-08-26',
                        'type' => 'credit',
                        'debit' => 0,
                        'credit' => 1222.22,
                        'balance_after' => -1222.22,
                        'currency' => 'TRY',
                        'reference_no' => '00000003',
                        'description' => 'Logo manuel virman',
                        'meta' => [
                            'raw' => [
                                'MODULENR' => 5,
                                'TRCODE' => 5,
                                'TRANNO' => '00000003',
                                'DOCODE' => '00000003',
                                'LINEEXP' => 'Logo manuel virman',
                            ],
                        ],
                    ],
                ],
            ])
            ->assertOk()
            ->assertJsonPath('summary.created', 1);

        $entry = LedgerEntry::query()
            ->where('source_reference', 'CLFLINE-MANUAL-VIRMAN-CREDIT')
            ->firstOrFail();

        $this->assertSame('payment', $entry->type);
        $this->assertSame('Tahsilat', (new LedgerEntryResource($entry))->toArray(new Request)['transaction_type_label']);
    }

    public function test_logo_ledger_sync_matches_unique_b2b_cash_collection_by_date_amount_when_document_code_is_missing(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-CASH-DOC',
            'name' => 'Cash Collection Dealer',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => 'CASH-DOC-CUSTOMER',
            'code' => '120-00-087',
            'name' => 'DENEME2 MURAT',
            'is_active' => true,
        ]);

        $collection = Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'synced',
            'date' => '2026-08-26',
            'collection_date' => '2026-08-26',
            'method' => 'cash',
            'amount' => 11.11,
            'currency' => 'TRY',
            'reference_no' => null,
            'reference_fields' => [],
            'note' => 'DENEME2 MURAT NAKİT',
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'CLFLINE-CASH-NO-DOC',
            'date' => '2026-08-26',
            'type' => 'credit',
            'debit' => 0,
            'credit' => 11.11,
            'balance_after' => -47679.76,
            'entry_date' => '2026-08-26',
            'entry_type' => 'credit',
            'amount' => 11.11,
            'currency' => 'TRY',
            'reference_no' => '20260826150140000',
            'description' => 'NAKIT TAHSILAT',
            'collection_id' => null,
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/ledger/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'customer_external_ref' => $customer->source_reference,
                        'external_ref' => 'CLFLINE-CASH-NO-DOC',
                        'date' => '2026-08-26',
                        'type' => 'credit',
                        'credit' => 11.11,
                        'balance_after' => -47679.76,
                        'currency' => 'TRY',
                        'reference_no' => '20260826150140000',
                        'description' => 'NAKIT TAHSILAT',
                        'meta' => [
                            'raw' => [
                                'MODULENR' => 10,
                                'TRCODE' => 1,
                                'TRANNO' => '20260826150140000',
                                'LINEEXP' => 'NAKIT TAHSILAT',
                            ],
                        ],
                    ],
                ],
            ])
            ->assertOk()
            ->assertJsonPath('summary.updated', 1);

        $entry = LedgerEntry::query()
            ->where('source_reference', 'CLFLINE-CASH-NO-DOC')
            ->with('collection')
            ->firstOrFail();

        $this->assertSame($collection->id, $entry->collection_id);
        $this->assertSame('payment', $entry->type);
        $this->assertSame('Nakit', (new LedgerEntryResource($entry))->toArray(new Request)['collection_method_label']);
        $this->assertSame('Tahsilat', (new LedgerEntryResource($entry))->toArray(new Request)['transaction_type_label']);
    }

    public function test_logo_ledger_sync_matches_b2b_cash_collection_from_existing_ledger_echo(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-CASH-ECHO',
            'name' => 'Cash Echo Dealer',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => 'CASH-ECHO-CUSTOMER',
            'code' => '120-00-087',
            'name' => 'DENEME2 MURAT',
            'is_active' => true,
        ]);

        $collection = Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'synced',
            'date' => '2026-08-26',
            'collection_date' => '2026-08-26',
            'method' => 'cash',
            'amount' => 100,
            'currency' => 'TRY',
            'reference_no' => null,
            'reference_fields' => [],
            'note' => null,
        ]);

        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'synced',
            'date' => '2026-08-26',
            'collection_date' => '2026-08-26',
            'method' => 'cash',
            'amount' => 100,
            'currency' => 'TRY',
            'reference_no' => null,
            'reference_fields' => [],
            'note' => null,
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'source_reference' => null,
            'date' => '2026-08-26',
            'type' => 'payment',
            'debit' => 0,
            'credit' => 100,
            'balance_after' => -100,
            'entry_date' => '2026-08-26',
            'entry_type' => 'credit',
            'amount' => 100,
            'currency' => 'TRY',
            'reference_no' => null,
            'description' => 'DENEME2 MURAT NAKİT',
            'collection_id' => $collection->id,
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'CLFLINE-CASH-ECHO',
            'date' => '2026-08-26',
            'type' => 'credit',
            'debit' => 0,
            'credit' => 100,
            'balance_after' => -29282.85,
            'entry_date' => '2026-08-26',
            'entry_type' => 'credit',
            'amount' => 100,
            'currency' => 'TRY',
            'reference_no' => '20260826085614000',
            'description' => 'DENEME2 MURAT NAKİT',
            'collection_id' => null,
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/ledger/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'customer_external_ref' => $customer->source_reference,
                        'external_ref' => 'CLFLINE-CASH-ECHO',
                        'date' => '2026-08-26',
                        'type' => 'credit',
                        'credit' => 100,
                        'balance_after' => -29282.85,
                        'currency' => 'TRY',
                        'reference_no' => '20260826085614000',
                        'description' => 'DENEME2 MURAT NAKİT',
                        'meta' => [
                            'raw' => [
                                'MODULENR' => 10,
                                'TRCODE' => 1,
                                'TRANNO' => '20260826085614000',
                                'LINEEXP' => 'DENEME2 MURAT NAKİT',
                            ],
                        ],
                    ],
                ],
            ])
            ->assertOk()
            ->assertJsonPath('summary.updated', 1);

        $entry = LedgerEntry::query()
            ->where('source_reference', 'CLFLINE-CASH-ECHO')
            ->with('collection')
            ->firstOrFail();

        $this->assertSame($collection->id, $entry->collection_id);
        $this->assertSame('payment', $entry->type);
        $this->assertSame('Nakit', (new LedgerEntryResource($entry))->toArray(new Request)['collection_method_label']);
        $this->assertSame('Tahsilat', (new LedgerEntryResource($entry))->toArray(new Request)['transaction_type_label']);
    }

    public function test_logo_cash_collection_raw_codes_are_classified_as_payment_even_without_b2b_collection_match(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-CASH-RAW',
            'name' => 'Cash Raw Dealer',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => 'CASH-RAW-CUSTOMER',
            'code' => '120-00-087',
            'name' => 'DENEME2 MURAT',
            'is_active' => true,
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'CLFLINE-CASH-RAW',
            'date' => '2026-08-26',
            'type' => 'credit',
            'debit' => 0,
            'credit' => 100,
            'balance_after' => -29282.85,
            'entry_date' => '2026-08-26',
            'entry_type' => 'credit',
            'amount' => 100,
            'currency' => 'TRY',
            'reference_no' => '20260826085614000',
            'description' => 'DENEME2 MURAT NAKİT',
            'collection_id' => null,
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/ledger/sync', [
                'dealer_id' => $dealer->id,
                'records' => [
                    [
                        'customer_external_ref' => $customer->source_reference,
                        'external_ref' => 'CLFLINE-CASH-RAW',
                        'date' => '2026-08-26',
                        'type' => 'credit',
                        'credit' => 100,
                        'balance_after' => -29282.85,
                        'currency' => 'TRY',
                        'reference_no' => '20260826085614000',
                        'description' => 'DENEME2 MURAT NAKİT',
                        'meta' => [
                            'raw' => [
                                'MODULENR' => 10,
                                'TRCODE' => 1,
                                'TRANNO' => '20260826085614000',
                                'LINEEXP' => 'DENEME2 MURAT NAKİT',
                            ],
                        ],
                    ],
                ],
            ])
            ->assertOk()
            ->assertJsonPath('summary.updated', 1);

        $entry = LedgerEntry::query()
            ->where('source_reference', 'CLFLINE-CASH-RAW')
            ->firstOrFail();

        $this->assertSame('payment', $entry->type);
        $this->assertSame('Tahsilat', (new LedgerEntryResource($entry))->toArray(new Request)['transaction_type_label']);
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

    public function test_customer_ledger_hides_b2b_collection_row_when_authoritative_logo_echo_has_no_collection_link(): void
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
            'source_reference' => 'CLFLINE-5000',
            'sync_status' => 'synced',
            'date' => '2026-05-01',
            'collection_date' => '2026-05-01',
            'method' => 'cash',
            'amount' => 5000,
            'currency' => 'TRY',
            'note' => 'test',
        ]);

        LedgerEntry::query()->create([
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

        $logoLedgerEntry = LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => '5000',
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
            ->assertJsonPath('data.0.id', $logoLedgerEntry->id)
            ->assertJsonPath('data.0.credit', '5000.00')
            ->assertJsonPath('summary.balance', '-5000.00');
    }

    public function test_customer_ledger_hides_backfilled_b2b_row_when_logo_echo_matches_source_reference(): void
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
            'source_reference' => 'CLFLINE-6000',
            'date' => '2026-05-01',
            'type' => 'credit',
            'debit' => 0,
            'credit' => 5000,
            'balance_after' => -5000,
            'entry_date' => '2026-05-01',
            'entry_type' => 'credit',
            'amount' => 5000,
            'currency' => 'TRY',
            'reference_no' => 'RET-1',
            'description' => 'İade',
            'meta' => ['source' => 'return_request'],
        ]);

        $logoLedgerEntry = LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => '6000',
            'date' => '2026-05-01',
            'type' => 'credit',
            'debit' => 0,
            'credit' => 5000,
            'balance_after' => -10000,
            'entry_date' => '2026-05-01',
            'entry_type' => 'credit',
            'amount' => 5000,
            'currency' => 'TRY',
            'reference_no' => 'RET-1',
            'description' => 'İade',
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
            ->assertJsonPath('data.0.id', $logoLedgerEntry->id)
            ->assertJsonPath('summary.balance', '-5000.00');
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

    public function test_logo_note_entry_is_mirrored_as_note_instead_of_cheque(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-NOTE',
            'name' => 'Senet Dealer',
            'is_active' => true,
        ]);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => 'NOTE-CUSTOMER',
            'code' => '120-25-900',
            'name' => 'Senet Cari',
            'is_active' => true,
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/ledger/sync', [
                'dealer_id' => $dealer->id,
                'records' => [[
                    'customer_external_ref' => $customer->source_reference,
                    'external_ref' => 'NOTE-LEDGER-1',
                    'date' => '2026-07-26',
                    'type' => 'payment',
                    'credit' => 250,
                    'currency' => 'TRY',
                    'reference_no' => 'SNT-001',
                    'description' => 'Senet Girişi',
                    'meta' => [
                        'raw' => ['TRCODE' => 62],
                    ],
                ]],
            ])
            ->assertOk();

        $this->assertDatabaseHas('collections', [
            'customer_id' => $customer->id,
            'method' => 'note',
            'reference_no' => 'SNT-001',
        ]);
    }

    public function test_logo_raw_codes_reclassify_existing_incoming_transfer_credit_rows_as_payments(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-HAVALE',
            'name' => 'Havale Dealer',
            'is_active' => true,
        ]);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => 'HAVALE-CUSTOMER',
            'code' => '120-25-901',
            'name' => 'Havale Cari',
            'is_active' => true,
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'CLFLINE-HAVALE-1',
            'date' => '2026-08-25',
            'type' => 'credit',
            'debit' => 0,
            'credit' => 1000,
            'balance_after' => -1000,
            'entry_date' => '2026-08-25',
            'entry_type' => 'credit',
            'amount' => 1000,
            'currency' => 'TRY',
            'reference_no' => 'HAV-001',
            'description' => 'Eski iade alacak gibi görünen havale',
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/ledger/sync', [
                'dealer_id' => $dealer->id,
                'records' => [[
                    'customer_external_ref' => $customer->source_reference,
                    'external_ref' => 'CLFLINE-HAVALE-1',
                    'date' => '2026-08-25',
                    'type' => 'credit',
                    'credit' => 1000,
                    'currency' => 'TRY',
                    'reference_no' => 'HAV-001',
                    'description' => 'Gelen Havale',
                    'meta' => [
                        'raw' => [
                            'MODULENR' => 7,
                            'TRCODE' => 20,
                            'SIGN' => 1,
                            'BANK_NAME' => 'Ziraat',
                        ],
                    ],
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('summary.updated', 1);

        $entry = LedgerEntry::query()
            ->where('source_reference', 'CLFLINE-HAVALE-1')
            ->firstOrFail();

        $this->assertSame('payment', $entry->type);
        $this->assertSame('1000.00', $entry->credit);
        $this->assertSame('-1000.00', $entry->balance_after);

        $this->assertDatabaseHas('collections', [
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'CLFLINE-HAVALE-1',
            'method' => 'transfer',
            'amount' => '1000.00',
        ]);
    }
}
