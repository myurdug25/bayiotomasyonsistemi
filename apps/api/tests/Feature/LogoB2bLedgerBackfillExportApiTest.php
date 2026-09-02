<?php

namespace Tests\Feature;

use App\Models\Collection;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\IntegrationSyncState;
use App\Models\LedgerEntry;
use App\Models\Order;
use App\Services\Integrations\Logo\LogoB2bLedgerBackfillExportService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class LogoB2bLedgerBackfillExportApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config([
            'integrations.logo.collection_sync_key' => 'test-sync-key',
        ]);
    }

    public function test_pending_returns_only_b2b_accounting_ledger_rows_without_logo_backfill(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR',
            'name' => 'Dealer',
            'is_active' => true,
        ]);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1674',
            'code' => '120-00-087',
            'name' => 'DENEME2 MURAT',
            'is_active' => true,
        ]);
        $collection = Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'synced',
            'source_reference' => 'CLFLINE-1',
            'date' => '2026-08-26',
            'collection_date' => '2026-08-26',
            'method' => 'cash',
            'amount' => 20,
            'currency' => 'TRY',
        ]);

        $candidate = LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'date' => '2026-08-26',
            'type' => 'debit',
            'debit' => 100,
            'credit' => 0,
            'balance_after' => 100,
            'entry_date' => '2026-08-26',
            'entry_type' => 'debit',
            'amount' => 100,
            'currency' => 'TRY',
            'reference_no' => 'LEG-100',
            'description' => 'Eski B2B hareket',
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'collection_id' => $collection->id,
            'date' => '2026-08-26',
            'type' => 'payment',
            'debit' => 0,
            'credit' => 20,
            'balance_after' => 80,
            'entry_date' => '2026-08-26',
            'entry_type' => 'credit',
            'amount' => 20,
            'currency' => 'TRY',
        ]);
        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => '700',
            'date' => '2026-08-26',
            'type' => 'invoice',
            'debit' => 50,
            'credit' => 0,
            'balance_after' => 130,
            'entry_date' => '2026-08-26',
            'entry_type' => 'debit',
            'amount' => 50,
            'currency' => 'TRY',
        ]);
        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'date' => '2026-08-26',
            'type' => 'debit',
            'debit' => 10,
            'credit' => 0,
            'balance_after' => 140,
            'entry_date' => '2026-08-26',
            'entry_type' => 'debit',
            'amount' => 10,
            'currency' => 'TRY',
            'meta' => ['source' => 'order_visibility'],
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/b2b-ledger-backfill/pending?customer_code=120-00-087&limit=10');

        $response
            ->assertOk()
            ->assertJsonPath('received', 1)
            ->assertJsonPath('records.0.ledger_entry_id', $candidate->id)
            ->assertJsonPath('records.0.customer_code', '120-00-087')
            ->assertJsonPath('records.0.customer_external_ref', '1674')
            ->assertJsonPath('records.0.sign', 0)
            ->assertJsonPath('records.0.amount', '100.00')
            ->assertJsonPath('records.0.export_key', 'B2B-LEDGER-'.$candidate->id);
    }

    public function test_ack_marks_backfilled_ledger_entry_and_prevents_retry(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR',
            'name' => 'Dealer',
            'is_active' => true,
        ]);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1674',
            'code' => '120-00-087',
            'name' => 'DENEME2 MURAT',
            'is_active' => true,
        ]);
        $entry = LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'date' => '2026-08-26',
            'type' => 'credit',
            'debit' => 0,
            'credit' => 71,
            'balance_after' => -71,
            'entry_date' => '2026-08-26',
            'entry_type' => 'credit',
            'amount' => 71,
            'currency' => 'TRY',
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/b2b-ledger-backfill/ack', [
                'records' => [[
                    'ledger_entry_id' => $entry->id,
                    'status' => 'synced',
                    'external_ref' => 'CLFLINE-900',
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('summary.synced', 1);

        $entry->refresh();

        $this->assertSame('CLFLINE-900', $entry->source_reference);
        $this->assertSame('CLFLINE-900', $entry->meta['integrations']['logo']['b2b_ledger_backfill_external_ref']);
        $this->assertDatabaseHas('integration_sync_states', [
            'system' => 'logo',
            'domain' => LogoB2bLedgerBackfillExportService::DOMAIN,
            'direction' => 'outbound',
            'entity_type' => LedgerEntry::class,
            'entity_id' => $entry->id,
            'status' => 'synced',
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/b2b-ledger-backfill/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('received', 0);
    }

    public function test_pending_includes_b2b_return_request_ledger_rows_linked_to_orders(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR',
            'name' => 'Dealer',
            'is_active' => true,
        ]);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1674',
            'code' => '120-00-087',
            'name' => 'DENEME2 MURAT',
            'is_active' => true,
        ]);
        $order = Order::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'order_no' => 'ORD-RETURN-1',
            'status' => 'completed',
            'currency' => 'TRY',
            'subtotal' => 100,
            'discount_total' => 0,
            'tax_total' => 20,
            'grand_total' => 120,
            'ordered_at' => '2026-08-26 10:00:00',
        ]);

        $returnLedgerEntry = LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'order_id' => $order->id,
            'date' => '2026-08-26',
            'type' => 'credit',
            'debit' => 0,
            'credit' => 120,
            'balance_after' => -120,
            'entry_date' => '2026-08-26',
            'entry_type' => 'credit',
            'amount' => 120,
            'currency' => 'TRY',
            'reference_no' => 'RET-1',
            'description' => 'İade · ORD-RETURN-1',
            'meta' => [
                'source' => 'return_request',
                'return_request_no' => 'RET-1',
            ],
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/b2b-ledger-backfill/pending?customer_code=120-00-087&limit=10')
            ->assertOk()
            ->assertJsonPath('received', 1)
            ->assertJsonPath('records.0.ledger_entry_id', $returnLedgerEntry->id)
            ->assertJsonPath('records.0.sign', 1)
            ->assertJsonPath('records.0.amount', '120.00');
    }
}
