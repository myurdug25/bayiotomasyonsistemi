<?php

namespace Tests\Feature;

use App\Models\Collection as CollectionModel;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\IntegrationSyncState;
use App\Models\LedgerEntry;
use App\Models\Order;
use App\Models\OrderItem;
use App\Models\Product;
use App\Models\Role;
use App\Models\Shipment;
use App\Models\ShipmentItem;
use App\Models\StockMovement;
use App\Models\StockSummary;
use App\Models\User;
use App\Models\Warehouse;
use App\Support\Warehouse\CartWarehouseOptions;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Tests\TestCase;

class WarehouseShipmentApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_cart_warehouse_options_fall_back_to_operational_warehouses_when_local_rows_are_empty(): void
    {
        Warehouse::query()->delete();

        $options = app(CartWarehouseOptions::class)->forCartItems(collect());

        $this->assertSame(['0', '1', '2', '3', '4'], array_column($options, 'warehouse_code'));
        $this->assertSame('ERZURUM POINT', $options[0]['warehouse_name']);
        $this->assertSame('BATUM DEPO', $options[4]['warehouse_name']);
    }

    public function test_cart_warehouse_options_ignore_single_placeholder_warehouse(): void
    {
        Warehouse::query()->create([
            'code' => '1',
            'name' => 'Varsayılan depo',
            'is_active' => true,
        ]);

        $options = app(CartWarehouseOptions::class)->forCartItems(collect());

        $this->assertSame(['0', '1', '2', '3', '4'], array_column($options, 'warehouse_code'));
        $this->assertSame('ERZURUM DEPO', $options[1]['warehouse_name']);
    }

    public function test_salesperson_cannot_access_warehouse_endpoints(): void
    {
        $dealer = $this->createDealer('DLR-SP-001');
        $user = $this->createUserWithRole('salesperson', $dealer);

        $this->actingAs($user);

        $response = $this->getJson('/api/warehouse/orders/ready');

        $response->assertForbidden();
    }

    public function test_salesperson_checkout_is_sent_to_ready_orders_queue(): void
    {
        $dealer = $this->createDealer('DLR-SP-READY');
        $salesperson = $this->createUserWithRole('salesperson', $dealer);
        $salesperson->forceFill(['name' => 'Ahmet Plasiyer'])->save();
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        Warehouse::query()->create([
            'code' => '1',
            'name' => 'Erzurum Depo',
            'is_active' => true,
        ]);

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $salesperson->id,
            'code' => 'CR-SP-READY',
            'name' => 'Salesperson Ready Customer',
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'SKU-SP-READY',
                'oem_code' => 'OEM-SP-READY',
                'name' => 'Salesperson Ready Product',
                'vat_rate' => 20,
                'is_active' => true,
                'meta' => [
                    'integrations' => [
                        'logo' => [
                            'payload' => [
                                'logo_stock' => [
                                    'warehouses' => [
                                        [
                                            'warehouse_code' => '1',
                                            'warehouse_name' => 'Erzurum Depo',
                                            'available_total' => 12,
                                        ],
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ]);
        });

        StockSummary::query()->create([
            'product_id' => $product->id,
            'available_total' => 20,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 100.00,
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($salesperson);
        $orderNote = 'Müşteri teslimattan önce aransın.';

        $cartResponse = $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 2,
            'shipping_method' => 'kargo',
            'warehouse_transfer' => false,
            'order_note' => $orderNote,
        ]);

        $cartResponse
            ->assertOk()
            ->assertJsonPath('cart.warehouse_transfer', true)
            ->assertJsonPath('warehouse_options.0.warehouse_code', '1')
            ->assertJsonPath('warehouse_options.0.warehouse_name', 'Erzurum Depo')
            ->assertJsonPath('warehouse_options.0.available_total', 12)
            ->assertJsonPath('warehouse_options.0.missing_quantity', 0);

        $orderResponse = $this->postJson('/api/orders', [
            'cart_id' => $cartResponse->json('cart.id'),
            'customer_id' => $customer->id,
            'checkout_summary_mode' => 'included',
        ]);

        $orderResponse
            ->assertCreated()
            ->assertJsonPath('order.status', 'approved')
            ->assertJsonPath('order.note', $orderNote);

        $invoiceEntry = LedgerEntry::query()
            ->where('order_id', $orderResponse->json('order.id'))
            ->where('type', 'invoice')
            ->firstOrFail();

        $this->assertSame('order_checkout', $invoiceEntry->meta['source']);
        $this->assertSame('salesperson', $invoiceEntry->meta['source_panel']);
        $this->assertTrue((bool) $invoiceEntry->meta['warehouse_dispatch']);
        $this->assertSame('3-B', $invoiceEntry->meta['checkout_summary']['code']);
        $this->assertSame('3 - B', $invoiceEntry->meta['checkout_summary']['label']);

        $this
            ->getJson('/api/customers/'.$customer->id.'/ledger')
            ->assertOk()
            ->assertJsonPath('data.0.checkout_summary.code', '3-B')
            ->assertJsonPath('data.0.checkout_summary.label', '3 - B')
            ->assertJsonPath('summary.total_debit', '240.00')
            ->assertJsonPath('summary.total_credit', '0.00')
            ->assertJsonPath('summary.balance', '240.00')
            ->assertJsonPath('summary.total_count', 1);

        $this
            ->getJson('/api/orders/'.$orderResponse->json('order.id'))
            ->assertOk()
            ->assertJsonPath('order.note', $orderNote);

        $this
            ->actingAs($warehouseUser)
            ->getJson('/api/warehouse/orders/ready?q='.$orderResponse->json('order.order_no'))
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $orderResponse->json('order.id'))
            ->assertJsonPath('data.0.order_no', $orderResponse->json('order.order_no'))
            ->assertJsonPath('data.0.created_by.id', $salesperson->id)
            ->assertJsonPath('data.0.salesperson.id', $salesperson->id)
            ->assertJsonPath('data.0.salesperson.name', 'Ahmet Plasiyer')
            ->assertJsonPath('data.0.origin.panel', 'salesperson')
            ->assertJsonPath('data.0.origin.panel_label', 'Plasiyer Paneli')
            ->assertJsonPath('data.0.origin.source', 'order_checkout')
            ->assertJsonPath('data.0.origin.note', $orderNote)
            ->assertJsonPath('data.0.invoice.reference_no', $orderResponse->json('order.order_no'));
    }

    public function test_order_detail_uses_erzurum_depo_logo_shelf_address_for_warehouse_print(): void
    {
        $dealer = $this->createDealer('DLR-WH-PRINT-RAF');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-WH-PRINT-RAF',
            'sku' => 'SKU-WH-PRINT-RAF',
            'quantity' => 2,
            'stock_available' => 20,
        ]);

        $ctx['product']->forceFill([
            'meta' => [
                'shelf_address' => 'GENEL-RAF',
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'raw' => [
                                'RAF25' => 'ERZ-RAF-25',
                                'RAF55' => 'SAMSUN-RAF-55',
                            ],
                            'logo_stock' => [
                                'warehouses' => [
                                    [
                                        'warehouse_code' => '3',
                                        'warehouse_name' => 'SAMSUN DEPO',
                                        'available_total' => 4,
                                        'shelf_key' => '55',
                                    ],
                                    [
                                        'warehouse_code' => '1',
                                        'warehouse_name' => 'ERZURUM DEPO',
                                        'available_total' => 13,
                                        'shelf_key' => '25',
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ],
        ])->save();

        $this
            ->getJson('/api/orders/'.$ctx['order']->id)
            ->assertOk()
            ->assertJsonPath('order.items.0.logo_stock.erzurum_depo_available_total', 13)
            ->assertJsonPath('order.items.0.shelf_address', 'ERZ-RAF-25');
    }

    public function test_shipment_detail_uses_selected_warehouse_logo_stock_for_available_total(): void
    {
        $dealer = $this->createDealer('DLR-WH-SHIP-ERZ-STOCK');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-WH-SHIP-ERZ-STOCK',
            'sku' => 'SKU-WH-SHIP-ERZ-STOCK',
            'quantity' => 5,
            'stock_available' => 20,
            'stock_reserved' => 0,
            'warehouse_code' => '1',
        ]);

        $ctx['product']->forceFill([
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'logo_stock' => [
                                'warehouses' => [
                                    [
                                        'warehouse_code' => '0',
                                        'warehouse_name' => 'ERZURUM POINT',
                                        'available_total' => 20,
                                    ],
                                    [
                                        'warehouse_code' => '1',
                                        'warehouse_name' => 'ERZURUM DEPO',
                                        'available_total' => 4,
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ],
        ])->save();

        $shipmentId = (int) $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
        ])
            ->assertCreated()
            ->assertJsonPath('data.remaining_items.0.logo_stock.available_total', 4)
            ->json('data.shipment.id');

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/scan", [
            'barcode' => $ctx['product']->sku,
            'qty' => 5,
        ])
            ->assertOk()
            ->assertJsonPath('data.shipment.status', 'picking')
            ->assertJsonPath('data.shipped_items.0.shipped_qty', 4)
            ->assertJsonPath('data.remaining_items.0.remaining_qty', 1)
            ->assertJsonPath('data.remaining_items.0.logo_stock.available_total', 4);
    }

    public function test_batum_checkout_does_not_write_checkout_summary_mode(): void
    {
        $dealer = $this->createDealer('DLR-BATUM-SUMMARY');
        $salesperson = $this->createUserWithRole('salesperson', $dealer);
        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $salesperson->id,
            'code' => '120-00-003',
            'name' => 'BATUM DEPO (sipariş)',
            'branch_code' => 'BATUM',
            'branch_name' => 'BATUM',
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'SKU-BATUM-SUMMARY',
                'oem_code' => 'OEM-BATUM-SUMMARY',
                'name' => 'Batum Summary Product',
                'vat_rate' => 20,
                'is_active' => true,
            ]);
        });

        StockSummary::query()->create([
            'product_id' => $product->id,
            'available_total' => 20,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);

        DB::table('base_prices')->insert([
            'price_list_id' => $priceListId,
            'product_id' => $product->id,
            'list_price' => 100.00,
            'currency' => 'GEL',
            'updated_at' => now(),
        ]);

        $this->actingAs($salesperson);

        $cartResponse = $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 1,
            'shipping_method' => 'depo_teslim',
            'warehouse_transfer' => false,
        ]);

        $cartResponse->assertOk();

        $orderResponse = $this->postJson('/api/orders', [
            'cart_id' => $cartResponse->json('cart.id'),
            'customer_id' => $customer->id,
            'checkout_summary_mode' => 'included',
        ]);

        $orderResponse->assertCreated();

        $invoiceEntry = LedgerEntry::query()
            ->where('order_id', $orderResponse->json('order.id'))
            ->where('type', 'invoice')
            ->firstOrFail();

        $this->assertNull($invoiceEntry->meta['checkout_summary']);
    }

    public function test_customer_ledger_can_filter_by_collection_method(): void
    {
        $dealer = $this->createDealer('DLR-LEDGER-METHOD');
        $salesperson = $this->createUserWithRole('salesperson', $dealer);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $salesperson->id,
            'code' => 'CR-LEDGER-METHOD',
            'name' => 'Ledger Method Customer',
            'is_active' => true,
        ]);

        $cashCollection = CollectionModel::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'date' => now()->toDateString(),
            'collection_date' => now()->toDateString(),
            'method' => 'cash',
            'amount' => 100,
            'currency' => 'TRY',
        ]);
        $transferCollection = CollectionModel::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'date' => now()->toDateString(),
            'collection_date' => now()->toDateString(),
            'method' => 'transfer',
            'amount' => 250,
            'currency' => 'TRY',
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'collection_id' => $cashCollection->id,
            'date' => now()->toDateString(),
            'type' => 'payment',
            'debit' => 0,
            'credit' => 100,
            'balance_after' => -100,
            'entry_date' => now()->toDateString(),
            'entry_type' => 'credit',
            'amount' => 100,
            'currency' => 'TRY',
            'reference_no' => 'CASH-001',
        ]);
        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'collection_id' => $transferCollection->id,
            'date' => now()->toDateString(),
            'type' => 'payment',
            'debit' => 0,
            'credit' => 250,
            'balance_after' => -350,
            'entry_date' => now()->toDateString(),
            'entry_type' => 'credit',
            'amount' => 250,
            'currency' => 'TRY',
            'reference_no' => 'TRF-001',
        ]);

        $this
            ->actingAs($salesperson)
            ->getJson('/api/customers/'.$customer->id.'/ledger?collection_method=transfer')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.reference_no', 'TRF-001')
            ->assertJsonPath('summary.total_credit', '250.00')
            ->assertJsonPath('summary.total_count', 1);
    }

    public function test_packing_slip_print_returns_html(): void
    {
        $dealer = $this->createDealer('DLR-PRN-001');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-PRN-001',
        ]);

        $shipment = Shipment::query()->create([
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
            'shipment_no' => 'SHP-PRN-001',
            'status' => 'draft',
            'created_by' => $warehouseUser->id,
        ]);

        ShipmentItem::query()->create([
            'shipment_id' => $shipment->id,
            'order_item_id' => $ctx['orderItem']->id,
            'product_id' => $ctx['product']->id,
            'ordered_qty' => 2,
            'shipped_qty' => 1,
            'unit_price' => 150,
            'vat_rate' => 20,
            'line_total_shipped' => 150,
        ]);

        $response = $this->get('/api/warehouse/shipments/'.$shipment->id.'/print/packing-slip');

        $response
            ->assertOk()
            ->assertHeader('content-type', 'text/html; charset=UTF-8')
            ->assertSee('Sevkiyat Toplama Fişi')
            ->assertSee('SHP-PRN-001');
    }

    public function test_label_print_returns_large_shipping_label(): void
    {
        $dealer = $this->createDealer('DLR-LBL-001');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-LBL-001',
            'customer_name' => 'Tekmil Otomotiv Bilal Tekmil',
        ]);

        $ctx['customer']->forceFill([
            'phone' => null,
            'city' => null,
            'district' => null,
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'raw' => [
                                'ADDR1' => 'Yeni San. Sitesi G Blok No:7',
                                'CITY' => 'Erzurum',
                                'TOWN' => 'Horasan',
                                'TELNRS1' => '05326229277',
                            ],
                        ],
                    ],
                ],
            ],
        ])->save();

        $shipment = Shipment::query()->create([
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
            'shipment_no' => 'SHP-LBL-001',
            'status' => 'draft',
            'created_by' => $warehouseUser->id,
        ]);

        $response = $this->get('/api/warehouse/shipments/'.$shipment->id.'/print/label?package_no=1&package_total=2&desi=3&ship_time=5.06.2026%2010:58:31');

        $response
            ->assertOk()
            ->assertHeader('content-type', 'text/html; charset=UTF-8')
            ->assertSee('Kargo Etiketi')
            ->assertSee('SHP-LBL-001')
            ->assertSee('TEKMİL OTOMOTİV BİLAL TEKMİL')
            ->assertSee('YENİ SAN. SİTESİ G BLOK NO:7')
            ->assertSee('HORASAN/ERZURUM/HORASAN')
            ->assertSee('05326229277')
            ->assertSee('Sevkiyat')
            ->assertSee('Sipariş')
            ->assertSee('ORD-LBL-001')
            ->assertSee('5.06.2026 10:58:31')
            ->assertDontSee('3 Desi')
            ->assertDontSee('Koli No: 1/2');
    }

    public function test_salesperson_cannot_access_print_endpoints(): void
    {
        $dealer = $this->createDealer('DLR-PRN-002');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-PRN-002',
        ]);

        $shipment = Shipment::query()->create([
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
            'shipment_no' => 'SHP-PRN-002',
            'status' => 'draft',
            'created_by' => $warehouseUser->id,
        ]);

        $salesperson = $this->createUserWithRole('salesperson', $dealer);
        $this->actingAs($salesperson);

        $response = $this->get('/api/warehouse/shipments/'.$shipment->id.'/print/packing-slip');

        $response->assertForbidden();
    }

    public function test_ready_orders_returns_only_approved_orders_in_scope(): void
    {
        $dealer = $this->createDealer('DLR-WH-001');
        $otherDealer = $this->createDealer('DLR-WH-002');

        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $inScopeApproved = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-READY-001',
        ]);

        $outOfScopeApproved = $this->createApprovedOrderContext($otherDealer, $this->createUserWithRole('dealer_admin', $otherDealer), [
            'order_no' => 'ORD-READY-002',
        ]);

        Order::query()->whereKey($outOfScopeApproved['order']->id)->update(['status' => 'approved']);

        $draftOrder = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-DRAFT-001',
            'status' => 'draft',
        ]);

        $response = $this->getJson('/api/warehouse/orders/ready?q=READY&limit=50');

        $response
            ->assertOk()
            ->assertJsonPath('limit', 50)
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $inScopeApproved['order']->id)
            ->assertJsonPath('data.0.order_no', 'ORD-READY-001');

        $this->assertNotSame($draftOrder['order']->id, $inScopeApproved['order']->id);
    }

    public function test_ready_orders_can_be_found_by_printed_order_barcode_id(): void
    {
        $dealer = $this->createDealer('DLR-WH-BARCODE');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-BARCODE-LOOKUP',
            'customer_code' => 'SCAN-CUSTOMER',
            'customer_name' => 'Barcode Lookup Customer',
        ]);

        $response = $this->getJson('/api/warehouse/orders/ready?q='.$ctx['order']->id);

        $response
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $ctx['order']->id)
            ->assertJsonPath('data.0.order_no', 'ORD-BARCODE-LOOKUP');
    }

    public function test_ready_order_preserves_checkout_warehouse_selection(): void
    {
        $dealer = $this->createDealer('DLR-WH-PREFERRED');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-WH-PREFERRED',
            'note' => 'Cari hesap · Depo transfer: ERZURUM DEPO · Kod: 1',
        ]);

        $this->getJson('/api/warehouse/orders/ready?q=ORD-WH-PREFERRED')
            ->assertOk()
            ->assertJsonPath('data.0.id', $ctx['order']->id)
            ->assertJsonPath('data.0.preferred_warehouse_code', '1');
    }

    public function test_shipped_order_is_hidden_from_ready_list(): void
    {
        $dealer = $this->createDealer('DLR-WH-SHIPPED');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-WH-SHIPPED',
            'status' => 'shipped',
        ]);

        $shipment = Shipment::query()->create([
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
            'shipment_no' => 'SHP-WH-SHIPPED',
            'status' => 'shipped',
            'created_by' => $warehouseUser->id,
        ]);

        $this->getJson('/api/warehouse/orders/ready?q=ORD-WH-SHIPPED')
            ->assertOk()
            ->assertJsonCount(0, 'data');
    }

    public function test_warehouse_user_can_view_order_detail_in_scope(): void
    {
        $dealer = $this->createDealer('DLR-WH-DET-001');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-WH-DETAIL-001',
        ]);

        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'orders',
            'direction' => 'outbound',
            'entity_type' => Order::class,
            'entity_id' => $ctx['order']->id,
            'dealer_id' => $dealer->id,
            'customer_id' => $ctx['customer']->id,
            'status' => 'synced',
            'external_ref' => 'ORFICHE-WH-DETAIL-001',
        ]);

        $response = $this->getJson('/api/orders/'.$ctx['order']->id);

        $response
            ->assertOk()
            ->assertJsonPath('order.id', $ctx['order']->id)
            ->assertJsonPath('order.order_no', 'ORD-WH-DETAIL-001')
            ->assertJsonPath('order.logo_sync_status', 'synced')
            ->assertJsonPath('order.logo_external_ref', 'ORFICHE-WH-DETAIL-001')
            ->assertJsonPath('order.items.0.product_id', $ctx['product']->id);
    }

    public function test_warehouse_user_can_update_ready_order_item_quantity(): void
    {
        $dealer = $this->createDealer('DLR-WH-QTY-001');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-WH-QTY-001',
            'quantity' => 2,
            'unit_net_price' => 100,
            'stock_available' => 20,
            'stock_reserved' => 5,
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $ctx['customer']->id,
            'order_id' => $ctx['order']->id,
            'date' => now()->toDateString(),
            'type' => 'invoice',
            'debit' => 240,
            'credit' => 0,
            'balance_after' => 240,
            'entry_date' => now()->toDateString(),
            'entry_type' => 'debit',
            'amount' => 240,
            'currency' => 'TRY',
            'reference_no' => 'ORD-WH-QTY-001',
        ]);

        $response = $this->patchJson(
            "/api/warehouse/orders/{$ctx['order']->id}/items/{$ctx['orderItem']->id}",
            ['quantity' => 4]
        );

        $response
            ->assertOk()
            ->assertJsonPath('order.items.0.quantity', 4)
            ->assertJsonPath('order.items.0.line_total', '400.00')
            ->assertJsonPath('order.subtotal', '400.00')
            ->assertJsonPath('order.tax_total', '80.00')
            ->assertJsonPath('order.grand_total', '480.00')
            ->assertJsonPath('order.items.0.logo_stock.available_total', 18)
            ->assertJsonPath('order.items.0.logo_stock.reserved_total', 7);

        $this->assertDatabaseHas('order_items', [
            'id' => $ctx['orderItem']->id,
            'quantity' => 4,
            'line_total' => '400.00',
        ]);

        $this->assertDatabaseHas('orders', [
            'id' => $ctx['order']->id,
            'subtotal' => '400.00',
            'tax_total' => '80.00',
            'grand_total' => '480.00',
        ]);

        $this->assertDatabaseHas('ledger_entries', [
            'order_id' => $ctx['order']->id,
            'type' => 'invoice',
            'debit' => '480.00',
            'amount' => '480.00',
            'balance_after' => '480.00',
        ]);

        $this->getJson('/api/warehouse/orders/ready?q=ORD-WH-QTY-001')
            ->assertOk()
            ->assertJsonPath('data.0.items_summary.total_quantity', 4)
            ->assertJsonPath('data.0.grand_total', '480.00');
    }

    public function test_warehouse_order_item_quantity_cannot_drop_below_picked_quantity(): void
    {
        $dealer = $this->createDealer('DLR-WH-QTY-002');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-WH-QTY-002',
            'quantity' => 3,
            'unit_net_price' => 100,
        ]);

        $shipment = Shipment::query()->create([
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
            'shipment_no' => 'SHP-WH-QTY-002',
            'status' => 'picking',
            'created_by' => $warehouseUser->id,
        ]);

        ShipmentItem::query()->create([
            'shipment_id' => $shipment->id,
            'order_item_id' => $ctx['orderItem']->id,
            'product_id' => $ctx['product']->id,
            'ordered_qty' => 3,
            'shipped_qty' => 2,
            'unit_price' => 100,
            'vat_rate' => 20,
            'line_total_shipped' => 200,
        ]);

        $this->patchJson(
            "/api/warehouse/orders/{$ctx['order']->id}/items/{$ctx['orderItem']->id}",
            ['quantity' => 1]
        )
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['quantity']);

        $this->assertDatabaseHas('order_items', [
            'id' => $ctx['orderItem']->id,
            'quantity' => 3,
        ]);
    }

    public function test_warehouse_staff_endpoint_returns_active_warehouse_users_in_scope(): void
    {
        $dealer = $this->createDealer('DLR-WH-STAFF-001');
        $otherDealer = $this->createDealer('DLR-WH-STAFF-002');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $warehouseUser->forceFill(['name' => 'Aktif Depocu'])->save();
        $inactiveWarehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $inactiveWarehouseUser->forceFill(['name' => 'Pasif Depocu', 'is_active' => false])->save();
        $otherWarehouseUser = $this->createUserWithRole('warehouse', $otherDealer);
        $otherWarehouseUser->forceFill(['name' => 'Baska Bayi Depocu'])->save();
        $salesperson = $this->createUserWithRole('salesperson', $dealer);
        $salesperson->forceFill(['name' => 'Plasiyer Degil'])->save();

        $this->actingAs($warehouseUser);

        $response = $this->getJson('/api/warehouse/staff');

        $response
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $warehouseUser->id)
            ->assertJsonPath('data.0.name', 'Aktif Depocu');
    }

    public function test_create_shipment_can_assign_selected_warehouse_user(): void
    {
        $dealer = $this->createDealer('DLR-WH-ASSIGN-001');
        $actor = $this->createUserWithRole('warehouse', $dealer);
        $assignedWarehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $assignedWarehouseUser->forceFill(['name' => 'Secilen Depocu'])->save();
        $this->actingAs($actor);

        $ctx = $this->createApprovedOrderContext($dealer, $actor, [
            'order_no' => 'ORD-WH-ASSIGN-001',
        ]);

        $response = $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
            'assigned_user_id' => $assignedWarehouseUser->id,
        ]);

        $response
            ->assertCreated()
            ->assertJsonPath('data.shipment.status', 'draft');

        $this->assertDatabaseHas('shipments', [
            'id' => $response->json('data.shipment.id'),
            'created_by' => $assignedWarehouseUser->id,
        ]);
    }

    public function test_create_shipment_falls_back_to_warehouse_code_when_sent_id_is_missing(): void
    {
        $dealer = $this->createDealer('DLR-WH-CODE-001');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-WH-CODE-001',
        ]);

        $response = $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => 999999,
            'warehouse_code' => '1',
            'warehouse_name' => 'Varsayılan depo',
        ]);

        $response
            ->assertCreated()
            ->assertJsonPath('data.shipment.status', 'draft')
            ->assertJsonPath('data.shipment.warehouse.code', '1');

        $this->assertDatabaseHas('warehouses', [
            'code' => '1',
            'name' => 'Varsayılan depo',
            'is_active' => true,
        ]);
    }

    public function test_open_draft_shipment_resyncs_when_order_item_changes(): void
    {
        $dealer = $this->createDealer('DLR-WH-DYN-001');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-WH-DYN-001',
            'sku' => 'SKU-DYN-OLD',
            'product_name' => 'Old Shipment Product',
            'quantity' => 2,
            'unit_net_price' => 100,
        ]);

        $createResponse = $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
        ]);

        $createResponse
            ->assertCreated()
            ->assertJsonPath('data.remaining_items.0.sku', 'SKU-DYN-OLD')
            ->assertJsonPath('data.remaining_items.0.unit_price', '100.00');

        $shipmentId = (int) $createResponse->json('data.shipment.id');

        $replacementProduct = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'SKU-DYN-NEW',
                'oem_code' => 'OEM-DYN-NEW',
                'name' => 'New Dynamic Product',
                'vat_rate' => 10,
                'is_active' => true,
                'meta' => ['barcode' => 'BC-DYN-NEW'],
            ]);
        });

        StockSummary::query()->create([
            'product_id' => $replacementProduct->id,
            'available_total' => 13,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);

        $ctx['orderItem']->forceFill([
            'product_id' => $replacementProduct->id,
            'quantity' => 3,
            'unit_net_price' => 275,
            'tax_rate' => 10,
            'line_total' => 825,
        ])->save();

        $ctx['order']->forceFill([
            'subtotal' => 825,
            'tax_total' => 82.50,
            'grand_total' => 907.50,
        ])->save();

        $syncResponse = $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
        ]);

        $syncResponse
            ->assertCreated()
            ->assertJsonPath('data.shipment.id', $shipmentId)
            ->assertJsonPath('data.shipment.order.grand_total', '907.50')
            ->assertJsonPath('data.remaining_items.0.sku', 'SKU-DYN-NEW')
            ->assertJsonPath('data.remaining_items.0.name', 'New Dynamic Product')
            ->assertJsonPath('data.remaining_items.0.ordered_qty', 3)
            ->assertJsonPath('data.remaining_items.0.unit_price', '275.00')
            ->assertJsonPath('data.remaining_items.0.vat_rate', '10.00');

        $this->assertDatabaseMissing('shipment_items', [
            'shipment_id' => $shipmentId,
            'product_id' => $ctx['product']->id,
        ]);
    }

    public function test_open_shipment_can_add_order_item_product(): void
    {
        $dealer = $this->createDealer('DLR-WH-ADD-001');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-WH-ADD-001',
            'quantity' => 1,
            'unit_net_price' => 100,
        ]);

        $newProduct = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'SKU-WH-ADD',
                'oem_code' => 'OEM-WH-ADD',
                'name' => 'Added Shipment Product',
                'vat_rate' => 20,
                'is_active' => true,
                'meta' => ['barcode' => 'BC-WH-ADD'],
            ]);
        });

        StockSummary::query()->create([
            'product_id' => $newProduct->id,
            'available_total' => 11,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);

        $createResponse = $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
        ]);

        $shipmentId = (int) $createResponse->json('data.shipment.id');

        $response = $this->postJson("/api/warehouse/shipments/{$shipmentId}/add-item", [
            'product_id' => $newProduct->id,
            'quantity' => 3,
            'unit_net_price' => 50,
            'tax_rate' => 20,
        ]);

        $response
            ->assertOk()
            ->assertJsonPath('data.message', 'Ürün siparişe eklendi.')
            ->assertJsonPath('data.totals.ordered_qty_total', 4)
            ->assertJsonPath('data.shipment.order.grand_total', '300.00');

        $this->assertDatabaseHas('order_items', [
            'order_id' => $ctx['order']->id,
            'product_id' => $newProduct->id,
            'quantity' => 3,
            'unit_net_price' => '50.00',
            'line_total' => '150.00',
        ]);

        $this->assertDatabaseHas('shipment_items', [
            'shipment_id' => $shipmentId,
            'product_id' => $newProduct->id,
            'ordered_qty' => 3,
            'shipped_qty' => 0,
        ]);
    }

    public function test_open_shipment_can_update_item_quantity(): void
    {
        $dealer = $this->createDealer('DLR-WH-QTY-003');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-WH-QTY-003',
            'quantity' => 2,
            'unit_net_price' => 80,
            'tax_rate' => 10,
        ]);

        $createResponse = $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
        ]);

        $shipmentId = (int) $createResponse->json('data.shipment.id');
        $shipmentItemId = (int) $createResponse->json('data.remaining_items.0.id');

        $response = $this->patchJson("/api/warehouse/shipments/{$shipmentId}/items/{$shipmentItemId}/quantity", [
            'quantity' => 5,
        ]);

        $response
            ->assertOk()
            ->assertJsonPath('data.message', 'Sipariş miktarı güncellendi.')
            ->assertJsonPath('data.remaining_items.0.ordered_qty', 5)
            ->assertJsonPath('data.remaining_items.0.remaining_qty', 5)
            ->assertJsonPath('data.shipment.order.grand_total', '440.00');

        $this->assertDatabaseHas('order_items', [
            'id' => $ctx['orderItem']->id,
            'quantity' => 5,
            'line_total' => '400.00',
        ]);

        $this->assertDatabaseHas('shipment_items', [
            'id' => $shipmentItemId,
            'ordered_qty' => 5,
        ]);
    }

    public function test_deleting_last_shipment_item_cancels_shipment_and_returns_order_to_list(): void
    {
        $dealer = $this->createDealer('DLR-WH-LAST-ITEM');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-WH-LAST-ITEM',
            'quantity' => 1,
        ]);

        $createResponse = $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
        ])->assertCreated();

        $shipmentId = (int) $createResponse->json('data.shipment.id');
        $shipmentItemId = (int) $createResponse->json('data.remaining_items.0.id');

        $this->deleteJson("/api/warehouse/shipments/{$shipmentId}/items/{$shipmentItemId}")
            ->assertOk()
            ->assertJsonPath('data.shipment.status', 'cancelled');

        $this->assertDatabaseHas('orders', [
            'id' => $ctx['order']->id,
            'status' => 'approved',
        ]);

        $this->getJson('/api/warehouse/orders/ready?q=ORD-WH-LAST-ITEM')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $ctx['order']->id)
            ->assertJsonPath('data.0.shipment', null);
    }

    public function test_can_create_scan_and_finalize_shipment(): void
    {
        $dealer = $this->createDealer('DLR-FIN-001');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-FIN-001',
            'quantity' => 2,
            'unit_net_price' => 150,
        ]);

        $createResponse = $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
        ]);

        $createResponse
            ->assertCreated()
            ->assertJsonPath('data.shipment.status', 'draft');

        $shipmentId = (int) $createResponse->json('data.shipment.id');

        $scanResponse = $this->postJson("/api/warehouse/shipments/{$shipmentId}/scan", [
            'barcode' => $ctx['product']->sku,
            'qty' => 2,
        ]);

        $scanResponse
            ->assertOk()
            ->assertJsonPath('data.shipment.status', 'packed')
            ->assertJsonPath('data.totals.shipped_qty_total', 2)
            ->assertJsonPath('data.message', 'Barkod okutuldu.');

        $finalizeResponse = $this->postJson("/api/warehouse/shipments/{$shipmentId}/finalize", [
            'carrier_name' => 'Yurtici Kargo',
            'tracking_no' => 'TRK-001',
            'note' => 'Test finalization',
        ]);

        $finalizeResponse
            ->assertOk()
            ->assertJsonPath('data.shipment.status', 'shipped')
            ->assertJsonPath('data.shipment.logo_sync_status', 'queued')
            ->assertJsonPath('data.shipment.order.status', 'shipped')
            ->assertJsonCount(0, 'data.shipped_items')
            ->assertJsonPath('data.message', 'Sevkiyat finalize edildi.');

        $stock = StockSummary::query()->findOrFail($ctx['product']->id);
        $stock->refresh();

        $this->assertSame(20, (int) $stock->available_total);
        $this->assertSame(3, (int) $stock->reserved_total);

        $orderItem = OrderItem::query()->findOrFail($ctx['orderItem']->id);
        $this->assertSame(2, (int) $orderItem->shipped_qty);

        $this->assertDatabaseHas('stock_movements', [
            'product_id' => $ctx['product']->id,
            'type' => 'out',
            'source' => 'shipment',
            'source_id' => $shipmentId,
        ]);
    }

    public function test_finalize_uses_available_stock_when_reserved_stock_is_missing(): void
    {
        $dealer = $this->createDealer('DLR-FIN-RESERVE-GAP');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-FIN-RESERVE-GAP',
            'quantity' => 2,
            'stock_available' => 5,
            'stock_reserved' => 0,
        ]);

        $shipmentId = (int) $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
        ])->json('data.shipment.id');

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/scan", [
            'barcode' => $ctx['product']->sku,
            'qty' => 2,
        ])->assertOk();

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/finalize")
            ->assertOk()
            ->assertJsonPath('data.shipment.status', 'shipped');

        $stock = StockSummary::query()->findOrFail($ctx['product']->id);
        $this->assertSame(3, (int) $stock->available_total);
        $this->assertSame(0, (int) $stock->reserved_total);
    }

    public function test_finalize_invoices_available_stock_and_marks_remainder_as_balance(): void
    {
        $dealer = $this->createDealer('DLR-FIN-INCOMPLETE');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-FIN-INCOMPLETE',
            'quantity' => 3,
            'stock_available' => 2,
            'stock_reserved' => 0,
        ]);

        $shipmentId = (int) $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
        ])->json('data.shipment.id');

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/scan", [
            'barcode' => $ctx['product']->sku,
            'qty' => 3,
        ])
            ->assertOk()
            ->assertJsonPath('data.shipped_items.0.shipped_qty', 2)
            ->assertJsonPath('data.remaining_items.0.remaining_qty', 1);

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/finalize")
            ->assertOk()
            ->assertJsonPath('data.shipment.status', 'partially_shipped')
            ->assertJsonPath('data.shipment.order.status', 'balance')
            ->assertJsonPath('data.totals.shipped_qty_total', 2)
            ->assertJsonPath('data.totals.remaining_qty_total', 1);

        $this->assertDatabaseHas('shipments', [
            'id' => $shipmentId,
            'status' => 'partially_shipped',
        ]);
        $this->assertDatabaseHas('orders', [
            'id' => $ctx['order']->id,
            'status' => 'balance',
        ]);
        $this->assertDatabaseHas('stock_movements', [
            'source' => 'shipment',
            'source_id' => $shipmentId,
            'qty' => '2.000',
        ]);

        $this->getJson('/api/warehouse/orders/ready?q=ORD-FIN-INCOMPLETE')
            ->assertOk()
            ->assertJsonCount(0, 'data');
    }

    public function test_finalize_rechecks_and_decrements_selected_warehouse_stock(): void
    {
        $dealer = $this->createDealer('DLR-FIN-WAREHOUSE-STOCK');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-FIN-WAREHOUSE-STOCK',
            'quantity' => 2,
            'stock_available' => 12,
            'stock_reserved' => 2,
            'warehouse_code' => '0',
            'product_meta' => [
                'barcode' => 'BC-FIN-WAREHOUSE-STOCK',
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'logo_stock' => [
                                'warehouses' => [
                                    [
                                        'warehouse_code' => '0',
                                        'warehouse_name' => 'ERZURUM POINT',
                                        'available_total' => 2,
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ],
        ]);

        $shipmentId = (int) $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
        ])->json('data.shipment.id');

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/scan", [
            'barcode' => $ctx['product']->sku,
            'qty' => 2,
        ])->assertOk();

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/finalize")
            ->assertOk()
            ->assertJsonPath('data.shipment.status', 'shipped');

        $ctx['product']->refresh();
        $this->assertSame(
            0,
            (int) data_get(
                $ctx['product']->meta,
                'integrations.logo.payload.logo_stock.warehouses.0.available_total'
            )
        );

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/cancel")
            ->assertOk()
            ->assertJsonPath('data.shipment.status', 'cancelled');

        $ctx['product']->refresh();
        $this->assertSame(
            2,
            (int) data_get(
                $ctx['product']->meta,
                'integrations.logo.payload.logo_stock.warehouses.0.available_total'
            )
        );
    }

    public function test_scan_caps_full_row_pick_to_available_stock_and_keeps_remainder(): void
    {
        $dealer = $this->createDealer('DLR-WH-STOCK-CAP');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-WH-STOCK-CAP',
            'quantity' => 5,
            'stock_available' => 4,
            'stock_reserved' => 0,
        ]);

        $shipmentId = (int) $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
        ])->json('data.shipment.id');

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/scan", [
            'barcode' => $ctx['product']->sku,
            'qty' => 5,
        ])
            ->assertOk()
            ->assertJsonPath('data.shipment.status', 'picking')
            ->assertJsonPath('data.shipped_items.0.shipped_qty', 4)
            ->assertJsonPath('data.shipped_items.0.remaining_qty', 1)
            ->assertJsonPath('data.remaining_items.0.remaining_qty', 1)
            ->assertJsonPath('data.totals.shipped_qty_total', 4)
            ->assertJsonPath('data.totals.remaining_qty_total', 1);

        $this->assertDatabaseHas('shipment_items', [
            'shipment_id' => $shipmentId,
            'product_id' => $ctx['product']->id,
            'ordered_qty' => 5,
            'shipped_qty' => 4,
        ]);
    }

    public function test_finalize_shipment_can_export_invoice_to_logo_immediately(): void
    {
        config()->set('integrations.logo.shipments.immediate_export.enabled', true);
        config()->set('integrations.logo.shipments.immediate_export.url', 'https://logo-bridge.test/shipments/export');
        config()->set('integrations.logo.shipments.immediate_export.token', 'test-token');

        Http::fake([
            'https://logo-bridge.test/shipments/export' => Http::response([
                'status' => 'synced',
                'external_ref' => 'INVOICE-12345',
                'meta' => [
                    'invoice_ref' => 12345,
                    'clfline_ref' => 67890,
                ],
            ]),
        ]);

        $dealer = $this->createDealer('DLR-LOGO-NOW');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-LOGO-NOW',
            'quantity' => 1,
            'unit_net_price' => 100,
            'customer_code' => '120-25-011',
            'customer_name' => 'Favori Yag',
        ]);

        $shipmentId = (int) $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
        ])->json('data.shipment.id');

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/scan", [
            'barcode' => $ctx['product']->sku,
            'qty' => 1,
        ])->assertOk();

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/finalize")
            ->assertOk()
            ->assertJsonPath('data.shipment.logo_sync_status', 'synced')
            ->assertJsonPath('data.shipment.logo_external_ref', 'INVOICE-12345')
            ->assertJsonPath('data.message', 'Sevkiyat finalize edildi ve Logo faturasi aktarildi.');

        Http::assertSent(function ($request): bool {
            $payload = $request->data();
            $shipment = Shipment::query()->findOrFail((int) data_get($payload, 'record.shipment_id'));

            return $request->url() === 'https://logo-bridge.test/shipments/export'
                && $request->hasHeader('Authorization', 'Bearer test-token')
                && data_get($payload, 'record.shipment_id') !== null
                && data_get($payload, 'record.export_key') === $shipment->logoExportKey()
                && data_get($payload, 'record.logo.document_type') === 'wholesale_sales_invoice'
                && data_get($payload, 'record.logo.ledger_trcode') === 38;
        });

        $this->assertDatabaseHas('integration_sync_states', [
            'system' => 'logo',
            'domain' => 'warehouse-shipments',
            'direction' => 'outbound',
            'entity_type' => Shipment::class,
            'entity_id' => $shipmentId,
            'status' => 'synced',
            'external_ref' => 'INVOICE-12345',
        ]);
    }

    public function test_cancel_after_finalize_reverses_stock_and_marks_cancelled(): void
    {
        $dealer = $this->createDealer('DLR-CAN-001');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-CAN-001',
            'quantity' => 2,
            'unit_net_price' => 100,
            'stock_available' => 25,
            'stock_reserved' => 8,
        ]);

        $shipmentId = (int) $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
        ])->json('data.shipment.id');

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/scan", [
            'barcode' => $ctx['product']->sku,
            'qty' => 2,
        ])->assertOk();

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/finalize", [
            'carrier_name' => 'MNG',
        ])->assertOk();

        $cancelResponse = $this->postJson("/api/warehouse/shipments/{$shipmentId}/cancel", [
            'note' => 'Yanlis okutma',
        ]);

        $cancelResponse
            ->assertOk()
            ->assertJsonPath('data.shipment.status', 'cancelled')
            ->assertJsonPath('data.message', 'Sevkiyat iptal edildi.');

        $stock = StockSummary::query()->findOrFail($ctx['product']->id);
        $this->assertSame(25, (int) $stock->available_total);
        $this->assertSame(8, (int) $stock->reserved_total);

        $orderItem = OrderItem::query()->findOrFail($ctx['orderItem']->id);
        $this->assertSame(0, (int) $orderItem->shipped_qty);

        $order = Order::query()->findOrFail($ctx['order']->id);
        $this->assertSame('approved', $order->status);

        $movementCount = StockMovement::query()
            ->where('source', 'shipment')
            ->where('source_id', $shipmentId)
            ->count();

        $this->assertSame(2, $movementCount);
    }

    /**
     * @param  array<string, mixed>  $overrides
     * @return array{order: Order, orderItem: OrderItem, customer: Customer, product: Product, warehouse: Warehouse}
     */
    private function createApprovedOrderContext(Dealer $dealer, User $createdBy, array $overrides = []): array
    {
        $quantity = (int) ($overrides['quantity'] ?? 2);
        $unitNetPrice = (float) ($overrides['unit_net_price'] ?? 100);
        $vatRate = (float) ($overrides['tax_rate'] ?? 20);
        $status = (string) ($overrides['status'] ?? 'approved');

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => (string) ($overrides['customer_code'] ?? ('CR-'.Str::upper(Str::random(5)))),
            'name' => (string) ($overrides['customer_name'] ?? 'Warehouse Test Customer'),
            'phone' => '5550000000',
            'city' => 'Erzurum',
            'district' => 'Yakutiye',
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function () use ($overrides, $vatRate): Product {
            return Product::query()->create([
                'sku' => (string) ($overrides['sku'] ?? ('SKU-'.Str::upper(Str::random(6)))),
                'oem_code' => (string) ($overrides['oem_code'] ?? ('OEM-'.Str::upper(Str::random(6)))),
                'name' => (string) ($overrides['product_name'] ?? 'Warehouse Test Product'),
                'vat_rate' => $vatRate,
                'is_active' => true,
                'meta' => $overrides['product_meta'] ?? [
                    'barcode' => (string) ($overrides['barcode'] ?? ('BC-'.Str::upper(Str::random(8)))),
                ],
            ]);
        });

        $subtotal = $quantity * $unitNetPrice;
        $vatTotal = $subtotal * ($vatRate / 100);

        $order = Order::query()->create([
            'order_no' => (string) ($overrides['order_no'] ?? ('ORD-'.Str::upper(Str::random(6)))),
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'user_id' => $createdBy->id,
            'status' => $status,
            'currency' => 'TRY',
            'subtotal' => $subtotal,
            'discount_total' => 0,
            'tax_total' => $vatTotal,
            'grand_total' => $subtotal + $vatTotal,
            'ordered_at' => Carbon::now()->subMinute(),
            'approved_at' => $status === 'approved' ? Carbon::now() : null,
            'note' => (string) ($overrides['note'] ?? 'Warehouse order test'),
        ]);

        $orderItem = OrderItem::query()->create([
            'order_id' => $order->id,
            'product_id' => $product->id,
            'quantity' => $quantity,
            'shipped_qty' => 0,
            'unit_net_price' => $unitNetPrice,
            'discount_rate' => 0,
            'tax_rate' => $vatRate,
            'line_total' => $subtotal,
            'currency' => 'TRY',
        ]);

        StockSummary::query()->create([
            'product_id' => $product->id,
            'available_total' => (int) ($overrides['stock_available'] ?? 20),
            'reserved_total' => (int) ($overrides['stock_reserved'] ?? 5),
            'updated_at' => now(),
        ]);

        $warehouse = Warehouse::query()->firstOrCreate(
            ['code' => (string) ($overrides['warehouse_code'] ?? 'WH-001')],
            ['name' => 'Ana Depo', 'is_active' => true]
        );

        return [
            'order' => $order,
            'orderItem' => $orderItem,
            'customer' => $customer,
            'product' => $product,
            'warehouse' => $warehouse,
        ];
    }

    private function createDealer(string $code): Dealer
    {
        return Dealer::query()->create([
            'code' => $code,
            'name' => 'Dealer '.$code,
            'is_active' => true,
        ]);
    }

    private function createUserWithRole(string $roleSlug, ?Dealer $dealer = null): User
    {
        $role = Role::query()->firstOrCreate(
            ['slug' => $roleSlug],
            ['name' => Str::headline(str_replace('_', ' ', $roleSlug))]
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer?->id,
            'is_active' => true,
        ]);

        $user->roles()->sync([$role->id]);

        return $user;
    }
}
