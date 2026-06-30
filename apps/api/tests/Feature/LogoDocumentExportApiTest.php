<?php

namespace Tests\Feature;

use App\Models\Customer;
use App\Models\Dealer;
use App\Models\IntegrationSyncState;
use App\Models\Order;
use App\Models\OrderItem;
use App\Models\Product;
use App\Models\ReturnRequest;
use App\Models\Shipment;
use App\Models\ShipmentItem;
use App\Models\User;
use App\Models\Warehouse;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class LogoDocumentExportApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config([
            'integrations.logo.order_sync_key' => 'doc-sync-key',
            'integrations.logo.shipment_sync_key' => 'doc-sync-key',
            'integrations.logo.return_sync_key' => 'doc-sync-key',
        ]);
    }

    public function test_logo_document_pending_endpoints_return_queued_records(): void
    {
        [$dealer, $customer, $user, $product] = $this->createDocumentFixture();

        $order = Order::query()->create([
            'order_no' => 'ORD-DOC-001',
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'user_id' => $user->id,
            'status' => 'approved',
            'currency' => 'TRY',
            'subtotal' => 100,
            'discount_total' => 0,
            'tax_total' => 20,
            'grand_total' => 120,
            'ordered_at' => '2026-04-01 10:00:00',
        ]);

        $orderItem = OrderItem::query()->create([
            'order_id' => $order->id,
            'product_id' => $product->id,
            'quantity' => 2,
            'shipped_qty' => 0,
            'unit_net_price' => 50,
            'discount_rate' => 0,
            'tax_rate' => 20,
            'line_total' => 100,
            'currency' => 'TRY',
        ]);

        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'orders',
            'direction' => 'outbound',
            'entity_type' => Order::class,
            'entity_id' => $order->id,
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'status' => 'queued',
            'meta' => ['export_key' => 'B2B-ORDER-'.$order->id],
        ]);

        $warehouse = Warehouse::query()->create([
            'code' => '01',
            'name' => 'Ana Depo',
            'is_active' => true,
        ]);

        $shipment = Shipment::query()->create([
            'order_id' => $order->id,
            'warehouse_id' => $warehouse->id,
            'shipment_no' => 'SHP-DOC-001',
            'status' => 'shipped',
            'shipped_at' => '2026-04-02 10:00:00',
            'created_by' => $user->id,
        ]);

        ShipmentItem::query()->create([
            'shipment_id' => $shipment->id,
            'order_item_id' => $orderItem->id,
            'product_id' => $product->id,
            'ordered_qty' => 2,
            'shipped_qty' => 2,
            'unit_price' => 50,
            'vat_rate' => 20,
            'line_total_shipped' => 100,
        ]);

        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'warehouse-shipments',
            'direction' => 'outbound',
            'entity_type' => Shipment::class,
            'entity_id' => $shipment->id,
            'status' => 'queued',
            'meta' => ['export_key' => $shipment->logoExportKey()],
        ]);

        $returnRequest = ReturnRequest::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'order_id' => $order->id,
            'order_item_id' => $orderItem->id,
            'requested_by_user_id' => $user->id,
            'reviewed_by_user_id' => $user->id,
            'request_no' => 'RET-DOC-001',
            'request_type' => ReturnRequest::TYPE_RETURN,
            'status' => ReturnRequest::STATUS_APPROVED,
            'reason_code' => 'wrong_part',
            'quantity' => 1,
            'unit_price' => 50,
            'currency' => 'TRY',
            'product_snapshot' => ['product_id' => $product->id, 'sku' => $product->sku],
            'order_snapshot' => ['order_no' => $order->order_no, 'customer_code' => $customer->code],
            'reviewed_at' => '2026-04-03 10:00:00',
        ]);

        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'returns',
            'direction' => 'outbound',
            'entity_type' => ReturnRequest::class,
            'entity_id' => $returnRequest->id,
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'status' => 'queued',
            'meta' => ['export_key' => 'B2B-RETURN-'.$returnRequest->id],
        ]);

        $scrapReturnRequest = ReturnRequest::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'order_id' => $order->id,
            'order_item_id' => $orderItem->id,
            'requested_by_user_id' => $user->id,
            'reviewed_by_user_id' => $user->id,
            'request_no' => 'RET-SCRAP-001',
            'request_type' => ReturnRequest::TYPE_DAMAGED,
            'status' => ReturnRequest::STATUS_APPROVED,
            'reason_code' => 'damaged_in_transit',
            'quantity' => 1,
            'unit_price' => 50,
            'currency' => 'TRY',
            'product_snapshot' => ['product_id' => $product->id, 'sku' => $product->sku],
            'order_snapshot' => ['order_no' => $order->order_no, 'customer_code' => $customer->code],
            'reviewed_at' => '2026-04-04 10:00:00',
        ]);

        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'return-scraps',
            'direction' => 'outbound',
            'entity_type' => ReturnRequest::class,
            'entity_id' => $scrapReturnRequest->id,
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'status' => 'queued',
            'meta' => ['export_key' => 'B2B-RETURN-SCRAP-'.$scrapReturnRequest->id],
        ]);

        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'returns',
            'direction' => 'outbound',
            'entity_type' => ReturnRequest::class,
            'entity_id' => $scrapReturnRequest->id,
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'status' => 'queued',
            'meta' => ['export_key' => 'B2B-RETURN-'.$scrapReturnRequest->id],
        ]);

        $this
            ->withHeader('X-Integration-Key', 'doc-sync-key')
            ->getJson('/api/integrations/logo/orders/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('received', 1)
            ->assertJsonPath('records.0.order_id', $order->id)
            ->assertJsonPath('records.0.customer_external_ref', '1001')
            ->assertJsonPath('records.0.items.0.logo.unitset_ref', '55');

        $this
            ->withHeader('X-Integration-Key', 'doc-sync-key')
            ->getJson('/api/integrations/logo/shipments/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('received', 1)
            ->assertJsonPath('records.0.shipment_id', $shipment->id)
            ->assertJsonPath('records.0.export_key', 'B2B-SHIP-SHP-DOC-001')
            ->assertJsonPath('records.0.warehouse_code', '01')
            ->assertJsonPath('records.0.items.0.shipped_qty', 2)
            ->assertJsonPath('records.0.logo.document_type', 'wholesale_sales_invoice')
            ->assertJsonPath('records.0.logo.invoice_trcode', 8)
            ->assertJsonPath('records.0.logo.ledger_trcode', 38)
            ->assertJsonPath('records.0.logo.target_tables', ['INVOICE', 'STFICHE', 'STLINE', 'CLFLINE']);

        $this
            ->withHeader('X-Integration-Key', 'doc-sync-key')
            ->getJson('/api/integrations/logo/returns/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('received', 2)
            ->assertJsonPath('records.0.return_request_id', $returnRequest->id)
            ->assertJsonPath('records.0.product_external_ref', '9001')
            ->assertJsonPath('records.0.logo.document_type', 'wholesale_sales_return_invoice')
            ->assertJsonPath('records.0.logo.invoice_trcode', 3)
            ->assertJsonPath('records.0.logo.stock_iocode', 1)
            ->assertJsonPath('records.0.logo.unitset_ref', '55')
            ->assertJsonPath('records.1.return_request_id', $scrapReturnRequest->id)
            ->assertJsonPath('records.1.request_type', ReturnRequest::TYPE_DAMAGED)
            ->assertJsonPath('records.1.logo.document_type', 'wholesale_sales_return_invoice');

        $this
            ->withHeader('X-Integration-Key', 'doc-sync-key')
            ->getJson('/api/integrations/logo/return-scraps/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('received', 1)
            ->assertJsonPath('records.0.return_request_id', $scrapReturnRequest->id)
            ->assertJsonPath('records.0.document_no', 'CR-DOC')
            ->assertJsonPath('records.0.logo.document_type', 'fire_fiche')
            ->assertJsonPath('records.0.logo.trcode', 11)
            ->assertJsonPath('records.0.items.0.quantity', 1)
            ->assertJsonPath('records.0.items.0.logo.unitset_ref', '55');
    }

    public function test_logo_order_ack_updates_sync_state(): void
    {
        [$dealer, $customer, $user] = $this->createDocumentFixture();

        $order = Order::query()->create([
            'order_no' => 'ORD-DOC-ACK',
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'user_id' => $user->id,
            'status' => 'pending',
            'currency' => 'TRY',
            'subtotal' => 10,
            'discount_total' => 0,
            'tax_total' => 2,
            'grand_total' => 12,
            'ordered_at' => '2026-04-01 10:00:00',
        ]);

        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'orders',
            'direction' => 'outbound',
            'entity_type' => Order::class,
            'entity_id' => $order->id,
            'status' => 'queued',
        ]);

        $this
            ->withHeader('X-Integration-Key', 'doc-sync-key')
            ->postJson('/api/integrations/logo/orders/ack', [
                'records' => [
                    [
                        'order_id' => $order->id,
                        'status' => 'synced',
                        'external_ref' => 'ORFICHE-7001',
                    ],
                ],
            ])
            ->assertOk()
            ->assertJsonPath('summary.synced', 1);

        $this->assertDatabaseHas('integration_sync_states', [
            'domain' => 'orders',
            'entity_type' => Order::class,
            'entity_id' => $order->id,
            'status' => 'synced',
            'external_ref' => 'ORFICHE-7001',
        ]);
    }

    /**
     * @return array{0:Dealer,1:Customer,2:User,3?:Product}
     */
    private function createDocumentFixture(): array
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-DOC',
            'name' => 'Logo Document Dealer',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1001',
            'code' => 'CR-DOC',
            'name' => 'Logo Cari',
            'is_active' => true,
            'meta' => [
                'address' => 'Test adres',
                'integrations' => [
                    'logo' => [
                        'external_ref' => '1001',
                        'payload' => [
                            'raw' => ['LOGICALREF' => 1001],
                        ],
                    ],
                ],
            ],
        ]);

        $user = User::query()->create([
            'dealer_id' => $dealer->id,
            'name' => 'Logo User',
            'email' => 'logo-doc@example.com',
            'password' => 'secret',
        ]);

        $product = Product::query()->create([
            'sku' => 'SKU-DOC',
            'oem_code' => 'OEM-DOC',
            'name' => 'Logo Urun',
            'unit' => 'ADET',
            'vat_rate' => 20,
            'is_active' => true,
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'external_ref' => '9001',
                        'payload' => [
                            'unitset_ref' => '55',
                            'logo_price' => ['uomref' => '77', 'incvat' => 0],
                            'raw' => ['LOGICALREF' => 9001, 'UNITSETREF' => 55],
                        ],
                    ],
                ],
            ],
        ]);

        return [$dealer, $customer, $user, $product];
    }
}
