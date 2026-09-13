<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserHasMenuPermission;
use App\Models\Cart;
use App\Models\Collection as CollectionModel;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\IntegrationSyncState;
use App\Models\LedgerEntry;
use App\Models\Order;
use App\Models\OrderItem;
use App\Models\Product;
use App\Models\PurchaseReceipt;
use App\Models\Role;
use App\Models\Shipment;
use App\Models\ShipmentItem;
use App\Models\StockMovement;
use App\Models\StockSummary;
use App\Models\User;
use App\Models\Warehouse;
use App\Services\Integrations\Logo\LogoShipmentExportService;
use App\Services\Integrations\Logo\LogoWarehouseTransferExportService;
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
        $this->assertSame('SAMSUN DEPO', $options[3]['warehouse_name']);
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
        $this->assertSame('ERZURUM POINT', $options[0]['warehouse_name']);
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
        $salesperson->forceFill([
            'name' => 'Ahmet Plasiyer',
            'branch_code' => 'TRABZON',
            'branch_name' => 'Trabzon',
        ])->save();
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
            ->assertJsonPath('warehouse_options.0.warehouse_name', 'ERZURUM DEPO')
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

        $stockAfterOrder = StockSummary::query()->findOrFail($product->id);
        $this->assertSame(20, (int) $stockAfterOrder->available_total);
        $this->assertSame(2, (int) $stockAfterOrder->reserved_total);

        $this->assertDatabaseMissing('ledger_entries', [
            'order_id' => $orderResponse->json('order.id'),
            'type' => 'invoice',
        ]);

        $this
            ->getJson('/api/customers/'.$customer->id.'/ledger')
            ->assertOk()
            ->assertJsonCount(0, 'data')
            ->assertJsonPath('summary.total_debit', '0.00')
            ->assertJsonPath('summary.total_credit', '0.00')
            ->assertJsonPath('summary.balance', '0.00')
            ->assertJsonPath('summary.total_count', 0);

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
            ->assertJsonPath('data.0.origin.shipping_method', 'kargo')
            ->assertJsonPath('data.0.origin.target_warehouse_code', '1')
            ->assertJsonPath('data.0.origin.target_warehouse_name', 'ERZURUM DEPO')
            ->assertJsonPath('data.0.preferred_warehouse_code', '1')
            ->assertJsonPath('data.0.origin.source', 'order_checkout')
            ->assertJsonPath('data.0.origin.note', $orderNote)
            ->assertJsonPath('data.0.invoice.reference_no', $orderResponse->json('order.order_no'));
    }

    public function test_salesperson_checkout_allows_selected_customer_explicit_two_zero_sale_type(): void
    {
        $dealer = $this->createDealer('DLR-SP-2ZERO');
        $salesperson = $this->createUserWithRole('salesperson', $dealer);

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $salesperson->id,
            'code' => '120-25-2ZERO',
            'name' => 'Two Zero Customer',
            'is_active' => true,
        ]);

        $customerRole = Role::query()->firstOrCreate(
            ['slug' => 'customer'],
            ['name' => 'Customer']
        );
        $customerUser = User::factory()->create([
            'dealer_id' => $dealer->id,
            'selected_customer_id' => $customer->id,
            'customer_scope' => 'assigned',
            'username' => $customer->code,
            'feature_permissions' => [
                'cart.sale_type.detailed',
                'cart.sale_type.excluded',
                'cart.sale_type.included',
            ],
            'is_active' => true,
        ]);
        $customerUser->roles()->sync([$customerRole->id]);

        $product = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'SKU-SP-2ZERO',
                'oem_code' => 'OEM-SP-2ZERO',
                'name' => 'Two Zero Product',
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
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($salesperson);

        $cartResponse = $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 1,
            'shipping_method' => 'depo_teslim',
        ])->assertOk();

        $this->postJson('/api/orders', [
            'cart_id' => $cartResponse->json('cart.id'),
            'customer_id' => $customer->id,
            'checkout_summary_mode' => 'excluded',
        ])
            ->assertCreated()
            ->assertJsonPath('order.status', 'approved');
    }

    public function test_e_invoice_logo_customer_rejects_non_detailed_checkout_summary_mode(): void
    {
        $dealer = $this->createDealer('DLR-SP-EINV');
        $salesperson = $this->createUserWithRole('salesperson', $dealer);

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $salesperson->id,
            'code' => '120-61-031',
            'name' => 'E-Fatura Customer',
            'is_active' => true,
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'e_invoice_user' => true,
                            'raw' => [
                                'EINVOICE' => 1,
                            ],
                        ],
                    ],
                ],
            ],
        ]);

        $product = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'SKU-SP-EINV',
                'oem_code' => 'OEM-SP-EINV',
                'name' => 'E Invoice Product',
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
            'currency' => 'TRY',
            'updated_at' => now(),
        ]);

        $this->actingAs($salesperson);

        $cartResponse = $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 1,
            'shipping_method' => 'depo_teslim',
        ])->assertOk();

        $this->postJson('/api/orders', [
            'cart_id' => $cartResponse->json('cart.id'),
            'customer_id' => $customer->id,
            'checkout_summary_mode' => 'excluded',
        ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['checkout_summary_mode']);

        $this->postJson('/api/orders', [
            'cart_id' => $cartResponse->json('cart.id'),
            'customer_id' => $customer->id,
            'checkout_summary_mode' => 'detailed',
        ])
            ->assertCreated()
            ->assertJsonPath('order.status', 'approved');
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

    public function test_order_detail_uses_target_warehouse_logo_stock_for_warehouse_print(): void
    {
        $dealer = $this->createDealer('DLR-WH-PRINT-TRABZON');
        $salesperson = $this->createUserWithRole('salesperson', $dealer);
        $salesperson->forceFill([
            'branch_code' => 'TRABZON',
            'branch_name' => 'Trabzon',
        ])->save();
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $salesperson, [
            'order_no' => 'ORD-WH-PRINT-TRABZON',
            'sku' => 'SKU-WH-PRINT-TRABZON',
            'quantity' => 5,
            'stock_available' => 500,
        ]);

        $ctx['product']->forceFill([
            'meta' => [
                'shelf_address' => 'GENEL-RAF',
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'raw' => [
                                'RAF25' => 'ERZ-RAF-25',
                                'RAF61' => 'TRB-RAF-61',
                            ],
                            'logo_stock' => [
                                'warehouses' => [
                                    [
                                        'warehouse_code' => '1',
                                        'warehouse_name' => 'ERZURUM DEPO',
                                        'available_total' => 369,
                                        'shelf_key' => '25',
                                    ],
                                    [
                                        'warehouse_code' => '2',
                                        'warehouse_name' => 'TRABZON DEPO',
                                        'available_total' => 254,
                                        'shelf_key' => '61',
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
            ->assertJsonPath('order.origin.target_warehouse_code', '2')
            ->assertJsonPath('order.origin.target_warehouse_name', 'TRABZON DEPO')
            ->assertJsonPath('order.items.0.shelf_address', 'TRB-RAF-61')
            ->assertJsonPath('order.items.0.logo_stock.print_warehouse_code', '2')
            ->assertJsonPath('order.items.0.logo_stock.print_warehouse_name', 'TRABZON DEPO')
            ->assertJsonPath('order.items.0.logo_stock.print_warehouse_available_total', 254)
            ->assertJsonPath('order.items.0.logo_stock.erzurum_depo_available_total', 369);
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

    public function test_e_invoice_logo_customer_rejects_two_zero_and_three_b_warehouse_shipment_finalize(): void
    {
        $dealer = $this->createDealer('DLR-WH-SHIP-EINV');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        foreach (['excluded', 'included'] as $mode) {
            $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
                'order_no' => 'ORD-WH-SHIP-EINV-'.Str::upper($mode),
                'sku' => 'SKU-WH-SHIP-EINV-'.Str::upper($mode),
                'quantity' => 1,
                'stock_available' => 20,
                'stock_reserved' => 0,
            ]);

            $ctx['customer']->forceFill([
                'meta' => [
                    'integrations' => [
                        'logo' => [
                            'payload' => [
                                'e_invoice_user' => false,
                                'raw' => ['ACCEPTEINV' => 1],
                            ],
                        ],
                    ],
                ],
            ])->save();

            IntegrationSyncState::query()->create([
                'system' => 'logo',
                'domain' => 'orders',
                'direction' => 'outbound',
                'entity_type' => Order::class,
                'entity_id' => $ctx['order']->id,
                'dealer_id' => $dealer->id,
                'customer_id' => $ctx['customer']->id,
                'status' => 'queued',
                'sync_key' => 'ORD-WH-SHIP-EINV-'.$mode,
                'meta' => [
                    'checkout_summary_mode' => $mode,
                    'target_warehouse_code' => $ctx['warehouse']->code,
                    'target_warehouse_name' => $ctx['warehouse']->name,
                ],
                'payload' => [],
            ]);

            $shipmentId = (int) $this->postJson('/api/warehouse/shipments', [
                'order_id' => $ctx['order']->id,
                'warehouse_id' => $ctx['warehouse']->id,
            ])
                ->assertCreated()
                ->json('data.shipment.id');

            $this->postJson("/api/warehouse/shipments/{$shipmentId}/scan", [
                'barcode' => $ctx['product']->sku,
                'qty' => 1,
            ])->assertOk();

            $this->postJson("/api/warehouse/shipments/{$shipmentId}/finalize")
                ->assertUnprocessable()
                ->assertJsonValidationErrors(['checkout_summary_mode']);
        }
    }

    public function test_shipment_detail_matches_selected_warehouse_by_name_without_falling_back_to_total_stock(): void
    {
        $dealer = $this->createDealer('DLR-WH-SHIP-ERZ-NAME');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-WH-SHIP-ERZ-NAME',
            'sku' => '9F 1320',
            'quantity' => 42,
            'stock_available' => 54,
            'stock_reserved' => 0,
            'warehouse_code' => 'ERZ-LOCAL',
            'product_meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'logo_stock' => [
                                'warehouses' => [
                                    [
                                        'warehouse_code' => '0',
                                        'warehouse_name' => 'ERZURUM POINT',
                                        'available_total' => 13,
                                    ],
                                    [
                                        'warehouse_code' => '1',
                                        'warehouse_name' => 'ERZURUM DEPO',
                                        'available_total' => 41,
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ],
        ]);

        $ctx['warehouse']->forceFill(['name' => 'Erzurum Depo'])->save();

        $shipmentId = (int) $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
            'warehouse_name' => 'ERZURUM DEPO',
        ])
            ->assertCreated()
            ->assertJsonPath('data.remaining_items.0.logo_stock.available_total', 41)
            ->json('data.shipment.id');

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/scan", [
            'barcode' => $ctx['product']->sku,
            'qty' => 42,
        ])
            ->assertOk()
            ->assertJsonPath('data.shipment.status', 'picking')
            ->assertJsonPath('data.shipped_items.0.shipped_qty', 41)
            ->assertJsonPath('data.remaining_items.0.remaining_qty', 1)
            ->assertJsonPath('data.remaining_items.0.logo_stock.available_total', 41);
    }

    public function test_shipment_uses_assigned_warehouse_staff_location_over_auto_stock_choice(): void
    {
        $dealer = $this->createDealer('DLR-WH-SHIP-STAFF-LOC');
        $admin = $this->createUserWithRole('admin', $dealer);
        $erzurumWarehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $erzurumWarehouseUser->forceFill(['name' => 'ERZURUM DEPO'])->save();
        $this->actingAs($admin);

        $ctx = $this->createApprovedOrderContext($dealer, $admin, [
            'order_no' => 'ORD-WH-SHIP-STAFF-LOC',
            'sku' => '9F 1320 STAFF',
            'quantity' => 42,
            'stock_available' => 154,
            'stock_reserved' => 0,
            'warehouse_code' => '2',
            'product_meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'logo_stock' => [
                                'warehouses' => [
                                    [
                                        'warehouse_code' => '1',
                                        'warehouse_name' => null,
                                        'available_total' => 41,
                                    ],
                                    [
                                        'warehouse_code' => '2',
                                        'warehouse_name' => null,
                                        'available_total' => 54,
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ],
        ]);

        Warehouse::query()->firstOrCreate(
            ['code' => '1'],
            ['name' => 'ERZURUM DEPO', 'is_active' => true]
        );

        $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
            'warehouse_code' => '2',
            'warehouse_name' => 'TRABZON DEPO',
            'assigned_user_id' => $erzurumWarehouseUser->id,
        ])
            ->assertCreated()
            ->assertJsonPath('data.shipment.warehouse.code', '1')
            ->assertJsonPath('data.shipment.warehouse.name', 'ERZURUM DEPO')
            ->assertJsonPath('data.remaining_items.0.logo_stock.available_total', 41);
    }

    public function test_reopening_unpicked_shipment_updates_it_to_the_requested_warehouse(): void
    {
        $dealer = $this->createDealer('DLR-WH-SHIP-REASSIGN');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-WH-SHIP-REASSIGN',
            'sku' => 'SKU-WH-SHIP-REASSIGN',
            'quantity' => 5,
            'warehouse_code' => '0',
        ]);
        $erzurumWarehouse = Warehouse::query()->create([
            'code' => '1',
            'name' => 'ERZURUM DEPO',
            'is_active' => true,
        ]);

        $firstResponse = $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
        ])->assertCreated();

        $shipmentId = (int) $firstResponse->json('data.shipment.id');

        $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $erzurumWarehouse->id,
            'warehouse_code' => '1',
        ])
            ->assertCreated()
            ->assertJsonPath('data.shipment.id', $shipmentId)
            ->assertJsonPath('data.shipment.warehouse.id', $erzurumWarehouse->id)
            ->assertJsonPath('data.shipment.warehouse.code', '1');

        $this->assertDatabaseHas('shipments', [
            'id' => $shipmentId,
            'warehouse_id' => $erzurumWarehouse->id,
        ]);
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

        $this->assertDatabaseMissing('ledger_entries', [
            'order_id' => $orderResponse->json('order.id'),
            'type' => 'invoice',
        ]);
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
            ->assertJsonPath('data.0.collection_method', 'transfer')
            ->assertJsonPath('data.0.collection_method_label', 'Havale / EFT')
            ->assertJsonPath('summary.total_credit', '250.00')
            ->assertJsonPath('summary.total_count', 1);
    }

    public function test_customer_ledger_hides_legacy_order_checkout_balance_rows(): void
    {
        $dealer = $this->createDealer('DLR-LEDGER-PROVISIONAL');
        $salesperson = $this->createUserWithRole('salesperson', $dealer);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $salesperson->id,
            'code' => 'CR-LEDGER-PROVISIONAL',
            'name' => 'Provisional Ledger Customer',
            'is_active' => true,
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'date' => now()->toDateString(),
            'type' => 'invoice',
            'debit' => 600,
            'credit' => 0,
            'balance_after' => 600,
            'entry_date' => now()->toDateString(),
            'entry_type' => 'debit',
            'amount' => 600,
            'currency' => 'TRY',
            'reference_no' => 'ORDER-PROVISIONAL',
            'meta' => ['source' => 'order_checkout'],
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'logo',
            'source_reference' => 'LOGO-INVOICE-REAL',
            'date' => now()->toDateString(),
            'type' => 'invoice',
            'debit' => 300,
            'credit' => 0,
            'balance_after' => 300,
            'entry_date' => now()->toDateString(),
            'entry_type' => 'debit',
            'amount' => 300,
            'currency' => 'TRY',
            'reference_no' => 'LOGO-INVOICE-REAL',
            'meta' => ['source' => 'logo_shipment_invoice'],
        ]);

        $this->actingAs($salesperson)
            ->getJson("/api/customers/{$customer->id}/ledger")
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.reference_no', 'LOGO-INVOICE-REAL')
            ->assertJsonPath('data.0.transaction_type', 'invoice')
            ->assertJsonPath('data.0.transaction_type_label', 'Fatura')
            ->assertJsonPath('data.0.document_no', 'LOGO-INVOICE-REAL')
            ->assertJsonPath('summary.total_debit', '300.00')
            ->assertJsonPath('summary.balance', '300.00');
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

    public function test_invoice_print_share_link_opens_without_login_when_signed(): void
    {
        $dealer = $this->createDealer('DLR-INV-SHARE');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-INV-SHARE',
            'customer_name' => 'WhatsApp Fatura Cari',
        ]);

        $shipment = Shipment::query()->create([
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
            'shipment_no' => 'SHP-INV-SHARE',
            'status' => 'shipped',
            'created_by' => $warehouseUser->id,
        ]);

        ShipmentItem::query()->create([
            'shipment_id' => $shipment->id,
            'order_item_id' => $ctx['orderItem']->id,
            'product_id' => $ctx['product']->id,
            'ordered_qty' => 2,
            'shipped_qty' => 2,
            'unit_price' => 100,
            'vat_rate' => 20,
            'line_total_shipped' => 200,
        ]);

        $shareResponse = $this->postJson('/api/warehouse/shipments/'.$shipment->id.'/print/invoice/share-link');

        $shareUrl = $shareResponse
            ->assertOk()
            ->assertJsonStructure(['url', 'expires_at'])
            ->json('url');

        $this->assertIsString($shareUrl);
        $this->assertStringContainsString('/api/public/warehouse/shipments/'.$shipment->id.'/print/invoice', $shareUrl);

        auth()->forgetGuards();

        $this->get($shareUrl)
            ->assertOk()
            ->assertHeader('content-type', 'text/html; charset=UTF-8')
            ->assertSee('WhatsApp Fatura Cari')
            ->assertSee('SHP-INV-SHARE');
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

    public function test_trabzon_salesperson_order_defaults_to_trabzon_depo(): void
    {
        $dealer = $this->createDealer('DLR-WH-BRANCH-TRABZON');
        $salesperson = $this->createUserWithRole('salesperson', $dealer);
        $salesperson->forceFill([
            'username' => 'trabzon.point',
            'branch_code' => null,
            'branch_name' => null,
        ])->save();
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        Warehouse::query()->firstOrCreate(['code' => '2'], ['name' => 'TRABZON DEPO', 'is_active' => true]);

        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $salesperson, [
            'order_no' => 'ORD-WH-BRANCH-TRABZON',
        ]);

        $this->getJson('/api/warehouse/orders/ready?q=ORD-WH-BRANCH-TRABZON')
            ->assertOk()
            ->assertJsonPath('data.0.origin.target_warehouse_code', '2')
            ->assertJsonPath('data.0.origin.target_warehouse_name', 'TRABZON DEPO')
            ->assertJsonPath('data.0.preferred_warehouse_code', '2');

        $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
        ])
            ->assertCreated()
            ->assertJsonPath('data.shipment.warehouse.code', '2')
            ->assertJsonPath('data.shipment.warehouse.name', 'TRABZON DEPO');
    }

    public function test_samsun_salesperson_kargo_order_defaults_to_erzurum_depo(): void
    {
        $dealer = $this->createDealer('DLR-WH-BRANCH-SAMSUN-KARGO');
        $salesperson = $this->createUserWithRole('salesperson', $dealer);
        $salesperson->forceFill([
            'username' => 'samsun.point',
            'branch_code' => null,
            'branch_name' => null,
        ])->save();
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        Warehouse::query()->firstOrCreate(['code' => '1'], ['name' => 'ERZURUM DEPO', 'is_active' => true]);

        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $salesperson, [
            'order_no' => 'ORD-WH-BRANCH-SAMSUN-KARGO',
        ]);
        $cart = Cart::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $ctx['customer']->id,
            'user_id' => $salesperson->id,
            'status' => 'ordered',
            'shipping_method' => 'kargo',
            'currency' => 'TRY',
        ]);
        $ctx['order']->forceFill(['cart_id' => $cart->id])->save();

        $this->getJson('/api/warehouse/orders/ready?q=ORD-WH-BRANCH-SAMSUN-KARGO')
            ->assertOk()
            ->assertJsonPath('data.0.origin.target_warehouse_code', '1')
            ->assertJsonPath('data.0.origin.target_warehouse_name', 'ERZURUM DEPO')
            ->assertJsonPath('data.0.origin.target_warehouse_reason', 'SAMSUN_KARGO_TO_ERZURUM')
            ->assertJsonPath('data.0.preferred_warehouse_code', '1');

        $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_code' => '2',
            'warehouse_name' => 'TRABZON DEPO',
        ])
            ->assertCreated()
            ->assertJsonPath('data.shipment.warehouse.code', '1')
            ->assertJsonPath('data.shipment.warehouse.name', 'ERZURUM DEPO');
    }

    public function test_ahmet_arac_identity_overrides_wrong_branch_and_targets_erzurum_depo(): void
    {
        $dealer = $this->createDealer('DLR-WH-BRANCH-AHMET');
        $salesperson = $this->createUserWithRole('salesperson', $dealer);
        $salesperson->forceFill([
            'name' => 'AHMET ARAÇ',
            'username' => 'ahmet.arac',
            'email' => 'ahmet.arac@example.test',
            'branch_code' => 'TRABZON',
            'branch_name' => 'Trabzon',
        ])->save();
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        Warehouse::query()->firstOrCreate(['code' => '1'], ['name' => 'ERZURUM DEPO', 'is_active' => true]);

        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $salesperson, [
            'order_no' => 'ORD-WH-BRANCH-AHMET',
        ]);
        $ctx['customer']->forceFill([
            'code' => '120-00-087',
            // Eski müşteri kaydı yanlışlıkla Batum işaretli olsa bile gerçek
            // bağlı plasiyerin Erzurum kimliği sipariş hedefini belirlemelidir.
            'branch_code' => 'BATUM',
            'branch_name' => 'Batum',
            'salesperson_user_id' => $salesperson->id,
        ])->save();

        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'orders',
            'entity_type' => Order::class,
            'entity_id' => $ctx['order']->id,
            'direction' => 'outbound',
            'status' => 'pending',
            'sync_key' => 'ORD-WH-BRANCH-AHMET',
            'meta' => [
                'target_warehouse_code' => '2',
                'target_warehouse_name' => 'TRABZON DEPO',
            ],
            'payload' => [],
        ]);

        $this->getJson('/api/warehouse/orders/ready?q=ORD-WH-BRANCH-AHMET')
            ->assertOk()
            ->assertJsonPath('data.0.origin.target_warehouse_code', '1')
            ->assertJsonPath('data.0.origin.target_warehouse_name', 'ERZURUM DEPO')
            ->assertJsonPath('data.0.preferred_warehouse_code', '1');

        $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
        ])
            ->assertCreated()
            ->assertJsonPath('data.shipment.warehouse.code', '1')
            ->assertJsonPath('data.shipment.warehouse.name', 'ERZURUM DEPO');
    }

    public function test_customer_user_order_uses_customers_own_branch_for_warehouse(): void
    {
        $dealer = $this->createDealer('DLR-WH-BRANCH-CUSTOMER-SP');
        $salesperson = $this->createUserWithRole('salesperson', $dealer);
        $salesperson->forceFill([
            'name' => 'TRABZON PLASİYER',
            'username' => 'trabzon.plasiyer',
            'branch_code' => 'TRABZON',
            'branch_name' => 'Trabzon',
        ])->save();
        $customerUser = $this->createUserWithRole('customer', $dealer);
        $customerUser->forceFill([
            'name' => 'OTO TEST MÜŞTERİ',
            'username' => 'oto.test',
            'branch_code' => 'ERZURUM',
            'branch_name' => 'Erzurum',
        ])->save();
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        Warehouse::query()->firstOrCreate(['code' => '1'], ['name' => 'ERZURUM DEPO', 'is_active' => true]);

        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $customerUser, [
            'order_no' => 'ORD-WH-BRANCH-CUSTOMER-SP',
        ]);
        $ctx['customer']->forceFill([
            'salesperson_user_id' => $salesperson->id,
            'branch_code' => 'ERZURUM',
            'branch_name' => 'Erzurum',
        ])->save();

        $this->getJson('/api/warehouse/orders/ready?q=ORD-WH-BRANCH-CUSTOMER-SP')
            ->assertOk()
            ->assertJsonPath('data.0.origin.target_warehouse_code', '1')
            ->assertJsonPath('data.0.origin.target_warehouse_name', 'ERZURUM DEPO')
            ->assertJsonPath('data.0.preferred_warehouse_code', '1');

        $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
        ])
            ->assertCreated()
            ->assertJsonPath('data.shipment.warehouse.code', '1')
            ->assertJsonPath('data.shipment.warehouse.name', 'ERZURUM DEPO');
    }

    public function test_assigned_trabzon_warehouse_staff_is_rejected_for_erzurum_salesperson_order(): void
    {
        $dealer = $this->createDealer('DLR-WH-BRANCH-ASSIGNED-STAFF');
        $salesperson = $this->createUserWithRole('salesperson', $dealer);
        $salesperson->forceFill([
            'name' => 'AHMET ARAÇ',
            'username' => 'ahmet.arac',
            'branch_code' => 'ERZURUM',
            'branch_name' => 'Erzurum',
        ])->save();
        $trabzonWarehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $trabzonWarehouseUser->forceFill([
            'name' => 'TRABZON DEPO',
            'username' => 'trabzon.depo',
            'branch_code' => 'TRABZON',
            'branch_name' => 'Trabzon',
            'menu_permissions' => ['cart', 'warehouse'],
            'feature_permissions' => ['cart.warehouse_transfer'],
        ])->save();
        $actor = $this->createUserWithRole('warehouse', $dealer);
        Warehouse::query()->firstOrCreate(['code' => '1'], ['name' => 'ERZURUM DEPO', 'is_active' => true]);
        Warehouse::query()->firstOrCreate(['code' => '2'], ['name' => 'TRABZON DEPO', 'is_active' => true]);

        $this->actingAs($actor);

        $ctx = $this->createApprovedOrderContext($dealer, $salesperson, [
            'order_no' => 'ORD-WH-BRANCH-ASSIGNED-STAFF',
        ]);
        $ctx['customer']->forceFill([
            'salesperson_user_id' => $salesperson->id,
        ])->save();

        $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_code' => '2',
            'warehouse_name' => 'TRABZON DEPO',
            'assigned_user_id' => $trabzonWarehouseUser->id,
        ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['assigned_user_id']);

        $this->assertDatabaseMissing('shipments', [
            'order_id' => $ctx['order']->id,
        ]);
    }

    public function test_warehouse_ready_list_is_scoped_to_logged_in_warehouse_branch(): void
    {
        $dealer = $this->createDealer('DLR-WH-BRANCH-SCOPE');

        $erzurumSalesperson = $this->createUserWithRole('salesperson', $dealer);
        $erzurumSalesperson->forceFill([
            'name' => 'AHMET ARAÇ',
            'username' => 'ahmet.arac',
            'branch_code' => 'ERZURUM',
            'branch_name' => 'Erzurum',
        ])->save();

        $trabzonSalesperson = $this->createUserWithRole('salesperson', $dealer);
        $trabzonSalesperson->forceFill([
            'name' => 'TRABZON POINT',
            'username' => 'trabzon.point',
            'branch_code' => 'TRABZON',
            'branch_name' => 'Trabzon',
        ])->save();

        $erzurumWarehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $erzurumWarehouseUser->forceFill([
            'name' => 'ERZURUM DEPO',
            'username' => 'erz.depo',
            'branch_code' => 'ERZURUM',
            'branch_name' => 'Erzurum',
        ])->save();

        $trabzonWarehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $trabzonWarehouseUser->forceFill([
            'name' => 'TRABZON DEPO',
            'username' => 'trabzon.depo',
            'branch_code' => 'TRABZON',
            'branch_name' => 'Trabzon',
        ])->save();

        Warehouse::query()->firstOrCreate(['code' => '1'], ['name' => 'ERZURUM DEPO', 'is_active' => true]);
        Warehouse::query()->firstOrCreate(['code' => '2'], ['name' => 'TRABZON DEPO', 'is_active' => true]);

        $erzurumOrder = $this->createApprovedOrderContext($dealer, $erzurumSalesperson, [
            'order_no' => 'ORD-WH-SCOPE-ERZURUM',
        ]);
        $trabzonOrder = $this->createApprovedOrderContext($dealer, $trabzonSalesperson, [
            'order_no' => 'ORD-WH-SCOPE-TRABZON',
        ]);

        $this->actingAs($erzurumWarehouseUser);

        $this->getJson('/api/warehouse/orders/ready?q=ORD-WH-SCOPE&limit=50')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $erzurumOrder['order']->id)
            ->assertJsonPath('data.0.preferred_warehouse_code', '1');

        $this->actingAs($trabzonWarehouseUser);

        $this->getJson('/api/warehouse/orders/ready?q=ORD-WH-SCOPE&limit=50')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $trabzonOrder['order']->id)
            ->assertJsonPath('data.0.preferred_warehouse_code', '2');
    }

    public function test_warehouse_created_normal_order_stays_in_creator_warehouse_even_if_customer_salesperson_differs(): void
    {
        $dealer = $this->createDealer('DLR-WH-CREATOR-SCOPE');

        $erzurumSalesperson = $this->createUserWithRole('salesperson', $dealer);
        $erzurumSalesperson->forceFill([
            'name' => 'AHMET ARAÇ',
            'username' => 'ahmet.arac',
            'branch_code' => 'ERZURUM',
            'branch_name' => 'Erzurum',
        ])->save();

        $erzurumWarehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $erzurumWarehouseUser->forceFill([
            'name' => 'ERZURUM DEPO',
            'username' => 'erz.depo',
            'branch_code' => 'ERZURUM',
            'branch_name' => 'Erzurum',
        ])->save();

        $trabzonWarehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $trabzonWarehouseUser->forceFill([
            'name' => 'TRABZON DEPO',
            'username' => 'trabzon.depo',
            'branch_code' => 'TRABZON',
            'branch_name' => 'Trabzon',
        ])->save();

        Warehouse::query()->firstOrCreate(['code' => '1'], ['name' => 'ERZURUM DEPO', 'is_active' => true]);
        Warehouse::query()->firstOrCreate(['code' => '2'], ['name' => 'TRABZON DEPO', 'is_active' => true]);

        $ctx = $this->createApprovedOrderContext($dealer, $trabzonWarehouseUser, [
            'order_no' => 'ORD-WH-CREATOR-TRABZON',
        ]);

        $ctx['customer']->forceFill([
            'salesperson_user_id' => $erzurumSalesperson->id,
            'branch_code' => 'ERZURUM',
            'branch_name' => 'Erzurum',
        ])->save();

        $this->actingAs($trabzonWarehouseUser);

        $this->getJson('/api/warehouse/orders/ready?q=ORD-WH-CREATOR&limit=50')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $ctx['order']->id)
            ->assertJsonPath('data.0.preferred_warehouse_code', '2');

        $this->actingAs($erzurumWarehouseUser);

        $this->getJson('/api/warehouse/orders/ready?q=ORD-WH-CREATOR&limit=50')
            ->assertOk()
            ->assertJsonCount(0, 'data');
    }

    public function test_depot_transfer_keeps_requesting_and_source_warehouses_distinct_for_logo_payload(): void
    {
        $this->withoutMiddleware(EnsureUserHasMenuPermission::class);

        $dealer = $this->createDealer('DLR-WH-TRANSFER-META');
        $trabzonWarehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $trabzonWarehouseUser->forceFill([
            'name' => 'TRABZON DEPO',
            'username' => 'trabzon.depo',
            'branch_code' => 'TRABZON',
            'branch_name' => 'Trabzon',
        ])->save();

        Warehouse::query()->firstOrCreate(['code' => '1'], ['name' => 'ERZURUM DEPO', 'is_active' => true]);
        Warehouse::query()->firstOrCreate(['code' => '2'], ['name' => 'TRABZON DEPO', 'is_active' => true]);

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $trabzonWarehouseUser->id,
            'code' => 'TRB-TRANSFER-CARI',
            'name' => 'Trabzon Depo Transfer Carisi',
            'branch_code' => 'TRABZON',
            'branch_name' => 'Trabzon',
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'SKU-WH-TRF-META',
                'oem_code' => 'OEM-WH-TRF-META',
                'name' => 'Warehouse Transfer Meta Product',
                'vat_rate' => 20,
                'is_active' => true,
                'meta' => [
                    'integrations' => [
                        'logo' => [
                            'external_ref' => 13941,
                            'payload' => [
                                'raw' => ['LOGICALREF' => 13941],
                                'logo_stock' => [
                                    'warehouses' => [
                                        [
                                            'warehouse_code' => '1',
                                            'warehouse_name' => 'ERZURUM DEPO',
                                            'available_total' => 20,
                                        ],
                                        [
                                            'warehouse_code' => '2',
                                            'warehouse_name' => 'TRABZON DEPO',
                                            'available_total' => 3,
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

        $this->actingAs($trabzonWarehouseUser);

        $cartId = (int) $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 2,
            'warehouse_transfer' => false,
        ])
            ->assertOk()
            ->json('cart.id');

        DB::table('cart_items')
            ->where('cart_id', $cartId)
            ->where('product_id', $product->id)
            ->update([
                'unit_net_price' => 1283.50,
                'line_total' => 2567.00,
                'currency' => 'TRY',
            ]);
        DB::table('base_prices')
            ->where('price_list_id', $priceListId)
            ->where('product_id', $product->id)
            ->update(['list_price' => 1496.25, 'updated_at' => now()]);

        $orderId = (int) $this->postJson('/api/orders', [
            'cart_id' => $cartId,
            'customer_id' => $customer->id,
            'checkout_summary_mode' => 'included',
            'warehouse_transfer_request' => true,
            'transfer_target_warehouse_code' => '1',
            'transfer_target_warehouse_name' => 'ERZURUM DEPO',
        ])
            ->assertCreated()
            ->json('order.id');
        $orderNo = Order::query()->whereKey($orderId)->value('order_no');
        $order = Order::query()->with('items')->findOrFail($orderId);

        $this->assertSame('2567.00', (string) $order->subtotal);
        $this->assertSame('0.00', (string) $order->tax_total);
        $this->assertSame('2567.00', (string) $order->grand_total);
        $this->assertSame('2567.00', (string) $order->items->sole()->line_total);
        $this->assertSame('1283.50', (string) $order->items->sole()->unit_net_price);

        $state = IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'warehouse-transfer-orders')
            ->where('entity_type', Order::class)
            ->where('entity_id', $orderId)
            ->firstOrFail();

        $this->assertSame('warehouse_transfer', data_get($state->meta, 'document_type'));
        $this->assertSame('1', data_get($state->meta, 'transfer_source_warehouse_code'));
        $this->assertSame('ERZURUM DEPO', data_get($state->meta, 'transfer_source_warehouse_name'));
        $this->assertSame('2', data_get($state->meta, 'transfer_target_warehouse_code'));
        $this->assertSame('TRABZON DEPO', data_get($state->meta, 'transfer_target_warehouse_name'));
        $this->assertSame('2', data_get($state->meta, 'target_warehouse_code'));

        $this
            ->getJson('/api/warehouse/orders/ready?q='.$orderNo)
            ->assertOk()
            ->assertJsonCount(0, 'data');

        $erzurumWarehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $erzurumWarehouseUser->forceFill([
            'name' => 'ERZURUM DEPO',
            'username' => 'erz.depo',
            'branch_code' => 'ERZURUM',
            'branch_name' => 'Erzurum',
            'menu_permissions' => ['cart', 'warehouse'],
        ])->save();

        $this
            ->actingAs($erzurumWarehouseUser)
            ->getJson('/api/warehouse/orders/ready?q='.$orderNo)
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.preferred_warehouse_code', '1')
            ->assertJsonPath('data.0.origin.target_warehouse_code', '2');

        $shipmentId = (int) $this->postJson('/api/warehouse/shipments', [
            'order_id' => $orderId,
            'warehouse_code' => '1',
            'warehouse_name' => 'ERZURUM DEPO',
        ])->assertCreated()->json('data.shipment.id');

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/scan", [
            'barcode' => $product->sku,
            'qty' => 2,
        ])->assertOk();

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/finalize")
            ->assertOk()
            ->assertJsonPath('data.shipment.status', 'shipped');

        $transferService = app(LogoWarehouseTransferExportService::class);
        $shipmentStage = $transferService->pending([]);
        $this->assertSame('shipment', data_get($shipmentStage, 'records.0.transfer_stage'));
        $this->assertSame('1', data_get($shipmentStage, 'records.0.stock_source_warehouse_code'));
        $this->assertSame('5', data_get($shipmentStage, 'records.0.stock_target_warehouse_code'));
        $this->assertSame(2, data_get($shipmentStage, 'records.0.items.0.shipped_qty'));

        $receipt = PurchaseReceipt::query()
            ->with('items')
            ->where('document_no', Shipment::query()->findOrFail($shipmentId)->shipment_no)
            ->where('status', 'draft')
            ->firstOrFail();

        $this->actingAs($trabzonWarehouseUser)
            ->postJson("/api/purchase-receipts/{$receipt->id}/approve", [
                'items' => [[
                    'id' => $receipt->items->sole()->id,
                    'accepted_quantity' => 1,
                ]],
            ])
            ->assertOk();

        $shipmentState = IntegrationSyncState::query()
            ->where('domain', 'warehouse-transfers')
            ->where('entity_type', Shipment::class)
            ->where('entity_id', $shipmentId)
            ->firstOrFail();
        $this->assertSame('shipment', data_get($shipmentState->meta, 'transfer_stage'));
        $this->assertSame('acceptance', data_get($shipmentState->meta, 'pending_acceptance.meta.transfer_stage'));

        $transferService->acknowledge([
            'records' => [[
                'shipment_id' => $shipmentId,
                'status' => 'synced',
                'external_ref' => 'LOGO-WH-SHIP-1',
                'meta' => ['export_key' => data_get($shipmentState->meta, 'export_key')],
            ]],
        ]);

        $acceptanceStage = $transferService->pending([]);
        $this->assertSame('acceptance', data_get($acceptanceStage, 'records.0.transfer_stage'));
        $this->assertSame('5', data_get($acceptanceStage, 'records.0.stock_source_warehouse_code'));
        $this->assertSame('2', data_get($acceptanceStage, 'records.0.stock_target_warehouse_code'));
        $this->assertSame(1, data_get($acceptanceStage, 'records.0.items.0.shipped_qty'));

        $this->assertDatabaseHas('purchase_receipts', [
            'document_no' => $receipt->document_no,
            'status' => 'draft',
        ]);
        $remainingReceipt = PurchaseReceipt::query()
            ->with('items')
            ->where('document_no', $receipt->document_no)
            ->where('status', 'draft')
            ->firstOrFail();
        $this->assertSame(1, (int) $remainingReceipt->items->sole()->expected_quantity);
        $this->assertSame(1, (int) $remainingReceipt->items->sole()->accepted_quantity);
    }

    public function test_erzurum_hizlisatis_can_request_transfer_from_erzurum_depo_to_erzurum_point(): void
    {
        $this->withoutMiddleware(EnsureUserHasMenuPermission::class);

        $dealer = $this->createDealer('DLR-WH-ERZ-POINT-TRANSFER');
        $pointUser = $this->createUserWithRole('point', $dealer);
        $pointUser->forceFill([
            'name' => 'ERZURUM HIZLI SATIŞ',
            'username' => 'erzurum.hizlisatis',
            'branch_code' => 'ERZURUM',
            'branch_name' => 'Erzurum Point',
            'menu_permissions' => ['cart', 'warehouse', 'mal-kabul', 'pos'],
            'feature_permissions' => ['cart.warehouse_transfer'],
        ])->save();

        Warehouse::query()->firstOrCreate(['code' => '0'], ['name' => 'ERZURUM POINT', 'is_active' => true]);
        Warehouse::query()->firstOrCreate(['code' => '1'], ['name' => 'ERZURUM DEPO', 'is_active' => true]);

        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');
        $dealer->update(['price_list_id' => $priceListId]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $pointUser->id,
            'code' => 'ERZ-POINT-SIPARIS',
            'name' => 'ERZURUM POINT (SİPARİŞ)',
            'branch_code' => 'ERZURUM',
            'branch_name' => 'Erzurum Point',
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'CS0040-ERZ-POINT-TRANSFER',
                'oem_code' => 'CS0040',
                'name' => 'CS0040 Erzurum Point Transfer',
                'vat_rate' => 20,
                'is_active' => true,
                'meta' => [
                    'integrations' => [
                        'logo' => [
                            'external_ref' => 24040,
                            'payload' => [
                                'raw' => ['LOGICALREF' => 24040],
                                'logo_stock' => [
                                    'warehouses' => [
                                        [
                                            'warehouse_code' => '0',
                                            'warehouse_name' => 'ERZURUM POINT',
                                            'available_total' => 1,
                                        ],
                                        [
                                            'warehouse_code' => '1',
                                            'warehouse_name' => 'ERZURUM DEPO',
                                            'available_total' => 25,
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
            'available_total' => 25,
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

        $this->actingAs($pointUser);

        $cartId = (int) $this->postJson('/api/cart/items', [
            'customer_id' => $customer->id,
            'product_id' => $product->id,
            'quantity' => 5,
            'warehouse_transfer' => false,
        ])
            ->assertOk()
            ->json('cart.id');

        $orderId = (int) $this->postJson('/api/orders', [
            'cart_id' => $cartId,
            'customer_id' => $customer->id,
            'checkout_summary_mode' => 'excluded',
            'warehouse_transfer_request' => true,
            'transfer_target_warehouse_code' => '1',
            'transfer_target_warehouse_name' => 'ERZURUM DEPO',
        ])
            ->assertCreated()
            ->json('order.id');

        $state = IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'warehouse-transfer-orders')
            ->where('entity_type', Order::class)
            ->where('entity_id', $orderId)
            ->firstOrFail();

        $this->assertSame('warehouse_transfer', data_get($state->meta, 'document_type'));
        $this->assertSame('1', data_get($state->meta, 'transfer_source_warehouse_code'));
        $this->assertSame('ERZURUM DEPO', data_get($state->meta, 'transfer_source_warehouse_name'));
        $this->assertSame('0', data_get($state->meta, 'transfer_target_warehouse_code'));
        $this->assertSame('ERZURUM POINT', data_get($state->meta, 'transfer_target_warehouse_name'));

        $this->getJson('/api/warehouse/orders/ready?q='.Order::query()->whereKey($orderId)->value('order_no'))
            ->assertOk();
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
            ->assertJsonPath('order.items.0.logo_stock.available_total', 20)
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
            'debit' => '240.00',
            'amount' => '240.00',
            'balance_after' => '240.00',
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

    public function test_warehouse_staff_endpoint_includes_active_batum_operational_account(): void
    {
        $dealer = $this->createDealer('DLR-WH-STAFF-BATUM');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $batumUser = $this->createUserWithRole('point', $dealer);
        $batumUser->forceFill([
            'username' => 'batum',
            'name' => 'BATUM B2B VE HIZLI SATIŞ',
            'branch_code' => 'BATUM',
            'region_code' => 'BATUM',
            'is_active' => true,
        ])->save();

        $this->actingAs($warehouseUser);

        $this->getJson('/api/warehouse/staff')
            ->assertOk()
            ->assertJsonFragment([
                'id' => $batumUser->id,
                'name' => 'BATUM B2B VE HIZLI SATIŞ',
            ]);
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

    public function test_create_shipment_uses_discounted_order_line_unit_price(): void
    {
        $dealer = $this->createDealer('DLR-WH-NET-001');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-WH-NET-001',
            'quantity' => 20,
            'unit_net_price' => 134.73,
            'line_total' => 1077.84,
        ]);

        $response = $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
        ]);

        $response
            ->assertCreated()
            ->assertJsonPath('data.remaining_items.0.unit_price', '53.89');

        $this->assertDatabaseHas('shipment_items', [
            'order_item_id' => $ctx['orderItem']->id,
            'ordered_qty' => 20,
            'unit_price' => '53.89',
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

    public function test_finalize_does_not_decrement_physical_stock_before_logo_sync(): void
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
        $this->assertSame(5, (int) $stock->available_total);
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

    public function test_finalize_rechecks_current_stock_and_keeps_new_shortage_as_balance(): void
    {
        $dealer = $this->createDealer('DLR-FIN-LIVE-STOCK-CAP');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);
        $this->actingAs($warehouseUser);

        $ctx = $this->createApprovedOrderContext($dealer, $warehouseUser, [
            'order_no' => 'ORD-FIN-LIVE-STOCK-CAP',
            'quantity' => 3,
            'stock_available' => 3,
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
            ->assertJsonPath('data.shipped_items.0.shipped_qty', 3);

        StockSummary::query()
            ->whereKey($ctx['product']->id)
            ->update(['available_total' => 2]);

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/finalize")
            ->assertOk()
            ->assertJsonPath('data.shipment.status', 'partially_shipped')
            ->assertJsonPath('data.shipment.order.status', 'balance')
            ->assertJsonPath('data.totals.shipped_qty_total', 2)
            ->assertJsonPath('data.totals.remaining_qty_total', 1);

        $this->assertDatabaseHas('shipment_items', [
            'shipment_id' => $shipmentId,
            'product_id' => $ctx['product']->id,
            'ordered_qty' => 3,
            'shipped_qty' => 2,
            'line_total_shipped' => '200.00',
        ]);

        $this->assertDatabaseHas('order_items', [
            'id' => $ctx['orderItem']->id,
            'quantity' => 3,
            'shipped_qty' => 2,
        ]);

        $this->assertDatabaseHas('stock_movements', [
            'product_id' => $ctx['product']->id,
            'type' => 'out',
            'source' => 'shipment',
            'source_id' => $shipmentId,
            'qty' => '2.000',
        ]);
    }

    public function test_salesperson_order_seven_with_stock_five_lists_only_two_as_balance(): void
    {
        $dealer = $this->createDealer('DLR-FIN-BALANCE-TWO');
        $salesperson = $this->createUserWithRole('salesperson', $dealer);
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);

        $ctx = $this->createApprovedOrderContext($dealer, $salesperson, [
            'order_no' => 'ORD-FIN-BALANCE-TWO',
            'quantity' => 7,
            'stock_available' => 5,
            'stock_reserved' => 0,
        ]);
        $ctx['customer']->forceFill([
            'salesperson_user_id' => $salesperson->id,
            'source_system' => 'logo',
        ])->save();

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $ctx['customer']->id,
            'order_id' => $ctx['order']->id,
            'date' => now()->toDateString(),
            'type' => 'invoice',
            'debit' => 840,
            'credit' => 0,
            'balance_after' => 840,
            'entry_date' => now()->toDateString(),
            'entry_type' => 'debit',
            'amount' => 840,
            'currency' => 'TRY',
            'reference_no' => 'ORD-FIN-BALANCE-TWO',
        ]);

        $this->actingAs($warehouseUser);

        $shipmentId = (int) $this->postJson('/api/warehouse/shipments', [
            'order_id' => $ctx['order']->id,
            'warehouse_id' => $ctx['warehouse']->id,
        ])->json('data.shipment.id');

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/scan", [
            'barcode' => $ctx['product']->sku,
            'qty' => 7,
        ])
            ->assertOk()
            ->assertJsonPath('data.shipped_items.0.shipped_qty', 5)
            ->assertJsonPath('data.remaining_items.0.remaining_qty', 2);

        $this->postJson("/api/warehouse/shipments/{$shipmentId}/finalize")
            ->assertOk()
            ->assertJsonPath('data.shipment.order.status', 'balance')
            ->assertJsonPath('data.totals.shipped_qty_total', 5)
            ->assertJsonPath('data.totals.remaining_qty_total', 2);

        $this->assertDatabaseHas('ledger_entries', [
            'order_id' => $ctx['order']->id,
            'type' => 'invoice',
            'debit' => '840.00',
            'amount' => '840.00',
        ]);

        $this->actingAs($salesperson);

        $this->getJson('/api/reports/order-balances?customer_id='.$ctx['customer']->id.'&statuses=balance')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.order_no', 'ORD-FIN-BALANCE-TWO')
            ->assertJsonMissingPath('data.0.order_quantity')
            ->assertJsonMissingPath('data.0.shipped_quantity')
            ->assertJsonPath('data.0.remaining_quantity', 2);
    }

    public function test_finalize_rechecks_but_does_not_decrement_warehouse_stock_before_logo_sync(): void
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
            2,
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
        $this->assertDatabaseHas('ledger_entries', [
            'customer_id' => $ctx['customer']->id,
            'order_id' => $ctx['order']->id,
            'source_system' => 'logo',
            'source_reference' => 'INVOICE-12345',
            'type' => 'invoice',
            'debit' => '120.00',
            'amount' => '120.00',
        ]);

        app(LogoShipmentExportService::class)->acknowledge([
            'records' => [[
                'shipment_id' => $shipmentId,
                'status' => 'synced',
                'external_ref' => 'INVOICE-12345',
            ]],
        ]);

        $this->assertSame(
            1,
            LedgerEntry::query()
                ->where('source_system', 'logo')
                ->where('source_reference', 'INVOICE-12345')
                ->count()
        );
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

        $subtotal = (float) ($overrides['line_total'] ?? ($quantity * $unitNetPrice));
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
