<?php

namespace Tests\Feature;

use App\Models\Brand;
use App\Models\Collection;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\IntegrationSyncState;
use App\Models\Order;
use App\Models\OrderItem;
use App\Models\Product;
use App\Models\Role;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Tests\TestCase;

class ReportEndpointsApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_customer_balances_returns_aging_0_30_31_60_60_plus(): void
    {
        $dealer = $this->createDealer('DLR-RPT-CB');
        $user = $this->createUserWithRole('salesperson', $dealer);
        $customer = $this->createCustomer($dealer, 'CB-001', 'Cari A', [
            'salesperson_user_id' => $user->id,
        ]);
        $asOfDate = Carbon::create(2026, 3, 1)->toDateString();

        $this->insertLedgerDebit($dealer->id, $customer->id, 100.00, Carbon::parse($asOfDate)->subDays(10)->toDateString());
        $this->insertLedgerDebit($dealer->id, $customer->id, 200.00, Carbon::parse($asOfDate)->subDays(40)->toDateString());
        $this->insertLedgerDebit($dealer->id, $customer->id, 300.00, Carbon::parse($asOfDate)->subDays(75)->toDateString());

        $this->actingAs($user);

        $response = $this->getJson('/api/reports/customer-balances?date_to='.$asOfDate.'&per_page=10');

        $response
            ->assertOk()
            ->assertJsonPath('report', 'customer_balances')
            ->assertJsonPath('summary.customer_count', 1)
            ->assertJsonPath('summary.balance_total', '600.00')
            ->assertJsonPath('summary.aging_totals.0_30', '100.00')
            ->assertJsonPath('summary.aging_totals.31_60', '200.00')
            ->assertJsonPath('summary.aging_totals.60_plus', '300.00')
            ->assertJsonPath('data.0.customer_id', $customer->id)
            ->assertJsonPath('data.0.balance', '600.00')
            ->assertJsonPath('data.0.aging.0_30', '100.00')
            ->assertJsonPath('data.0.aging.31_60', '200.00')
            ->assertJsonPath('data.0.aging.60_plus', '300.00');
    }

    public function test_customer_balance_report_can_be_filtered_by_customer_id(): void
    {
        $dealer = $this->createDealer('DLR-RPT-CB-FILTER');
        $user = $this->createUserWithRole('salesperson', $dealer);
        $customerA = $this->createCustomer($dealer, 'CBF-001', 'Cari Filtre A', [
            'salesperson_user_id' => $user->id,
        ]);
        $customerB = $this->createCustomer($dealer, 'CBF-002', 'Cari Filtre B', [
            'salesperson_user_id' => $user->id,
        ]);
        $asOfDate = Carbon::create(2026, 3, 1)->toDateString();

        $this->insertLedgerDebit($dealer->id, $customerA->id, 120.00, Carbon::parse($asOfDate)->subDays(10)->toDateString());
        $this->insertLedgerDebit($dealer->id, $customerB->id, 280.00, Carbon::parse($asOfDate)->subDays(10)->toDateString());

        $this->actingAs($user);

        $response = $this->getJson('/api/reports/customer-balances?date_to='.$asOfDate.'&customer_id='.$customerB->id.'&per_page=10');

        $response
            ->assertOk()
            ->assertJsonPath('filters.customer_id', $customerB->id)
            ->assertJsonPath('summary.customer_count', 1)
            ->assertJsonPath('summary.balance_total', '280.00')
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.customer_id', $customerB->id);
    }

    public function test_order_balances_returns_open_orders_summary_and_status_breakdown(): void
    {
        $dealer = $this->createDealer('DLR-RPT-OB');
        $user = $this->createUserWithRole('salesperson', $dealer);
        $customerA = $this->createCustomer($dealer, 'OB-001', 'Musteri A', [
            'salesperson_user_id' => $user->id,
        ]);
        $customerB = $this->createCustomer($dealer, 'OB-002', 'Musteri B', [
            'salesperson_user_id' => $user->id,
        ]);

        $this->createOrderWithItem($dealer, $customerA, $user, [
            'order_no' => 'ORD-OPEN-001',
            'status' => 'pending',
            'ordered_at' => '2026-02-10 10:00:00',
            'line_total' => 100.00,
            'tax_rate' => 20,
        ]);
        $syncedOrder = Order::query()->where('order_no', 'ORD-OPEN-001')->firstOrFail();
        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'orders',
            'direction' => 'outbound',
            'entity_type' => Order::class,
            'entity_id' => $syncedOrder->id,
            'dealer_id' => $dealer->id,
            'customer_id' => $customerA->id,
            'external_ref' => 'LOGO-ORD-001',
            'status' => 'synced',
            'last_synced_at' => Carbon::parse('2026-02-10 10:05:00'),
        ]);

        $this->createOrderWithItem($dealer, $customerB, $user, [
            'order_no' => 'ORD-OPEN-002',
            'status' => 'approved',
            'ordered_at' => '2026-02-11 11:00:00',
            'line_total' => 50.00,
            'tax_rate' => 20,
        ]);

        $this->createOrderWithItem($dealer, $customerB, $user, [
            'order_no' => 'ORD-CLOSED-001',
            'status' => 'completed',
            'ordered_at' => '2026-02-12 12:00:00',
            'line_total' => 999.00,
            'tax_rate' => 20,
        ]);

        $this->actingAs($user);

        $response = $this->getJson('/api/reports/order-balances?date_from=2026-02-01&date_to=2026-02-28&per_page=50');

        $response
            ->assertOk()
            ->assertJsonPath('report', 'order_balances')
            ->assertJsonPath('summary.open_order_count', 2)
            ->assertJsonPath('summary.open_subtotal', '150.00')
            ->assertJsonPath('summary.open_grand_total', '180.00')
            ->assertJsonCount(2, 'data')
            ->assertJsonFragment(['status' => 'pending'])
            ->assertJsonFragment(['logo_sync_status' => 'synced'])
            ->assertJsonFragment(['logo_external_ref' => 'LOGO-ORD-001'])
            ->assertJsonFragment(['status' => 'approved']);
    }

    public function test_order_balances_can_filter_orders_with_remaining_quantity_balance(): void
    {
        $dealer = $this->createDealer('DLR-RPT-OB-BAL');
        $user = $this->createUserWithRole('salesperson', $dealer);
        $customer = $this->createCustomer($dealer, 'OBB-001', 'Bakiye Musteri', [
            'salesperson_user_id' => $user->id,
        ]);

        $this->createOrderWithItem($dealer, $customer, $user, [
            'order_no' => 'ORD-BALANCE-001',
            'status' => 'picking',
            'ordered_at' => '2026-02-13 10:00:00',
            'quantity' => 5,
            'shipped_qty' => 4,
            'line_total' => 500.00,
        ]);

        $this->createOrderWithItem($dealer, $customer, $user, [
            'order_no' => 'ORD-BALANCE-FULL',
            'status' => 'packed',
            'ordered_at' => '2026-02-13 11:00:00',
            'quantity' => 5,
            'shipped_qty' => 5,
            'line_total' => 500.00,
        ]);

        $this->createOrderWithItem($dealer, $customer, $user, [
            'order_no' => 'ORD-BALANCE-CLOSED',
            'status' => 'completed',
            'ordered_at' => '2026-02-13 12:00:00',
            'quantity' => 5,
            'shipped_qty' => 4,
            'line_total' => 500.00,
        ]);

        $this->actingAs($user);

        $response = $this->getJson('/api/reports/order-balances?statuses=balance&per_page=50');

        $response
            ->assertOk()
            ->assertJsonPath('filters.statuses.0', 'balance')
            ->assertJsonPath('summary.open_order_count', 1)
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.order_no', 'ORD-BALANCE-001')
            ->assertJsonPath('data.0.status', 'picking')
            ->assertJsonMissingPath('data.0.order_quantity')
            ->assertJsonMissingPath('data.0.shipped_quantity')
            ->assertJsonPath('data.0.remaining_quantity', 1);
    }

    public function test_sales_report_supports_product_brand_and_customer_breakdowns(): void
    {
        $dealer = $this->createDealer('DLR-RPT-SLS');
        $user = $this->createUserWithRole('salesperson', $dealer);
        $customerA = $this->createCustomer($dealer, 'SL-001', 'Servis A', [
            'salesperson_user_id' => $user->id,
        ]);
        $customerB = $this->createCustomer($dealer, 'SL-002', 'Servis B', [
            'salesperson_user_id' => $user->id,
        ]);

        $brandA = Brand::query()->create(['name' => 'Brand A', 'slug' => 'brand-a']);
        $brandB = Brand::query()->create(['name' => 'Brand B', 'slug' => 'brand-b']);

        $productA = Product::withoutEvents(function () use ($brandA): Product {
            return Product::query()->create([
                'sku' => 'SKU-SLS-A',
                'oem_code' => 'OEM-SLS-A',
                'name' => 'Urun A',
                'brand_id' => $brandA->id,
                'vat_rate' => 20,
                'is_active' => true,
            ]);
        });

        $productB = Product::withoutEvents(function () use ($brandB): Product {
            return Product::query()->create([
                'sku' => 'SKU-SLS-B',
                'oem_code' => 'OEM-SLS-B',
                'name' => 'Urun B',
                'brand_id' => $brandB->id,
                'vat_rate' => 10,
                'is_active' => true,
            ]);
        });

        $orderA = $this->createOrder($dealer, $customerA, $user, [
            'order_no' => 'ORD-SLS-001',
            'status' => 'approved',
            'ordered_at' => '2026-02-15 10:00:00',
        ]);

        $orderB = $this->createOrder($dealer, $customerB, $user, [
            'order_no' => 'ORD-SLS-002',
            'status' => 'completed',
            'ordered_at' => '2026-02-16 10:00:00',
        ]);

        OrderItem::query()->create([
            'order_id' => $orderA->id,
            'product_id' => $productA->id,
            'quantity' => 3,
            'shipped_qty' => 3,
            'unit_net_price' => 100.00,
            'discount_rate' => 0,
            'tax_rate' => 20,
            'line_total' => 300.00,
            'currency' => 'TRY',
        ]);

        OrderItem::query()->create([
            'order_id' => $orderB->id,
            'product_id' => $productB->id,
            'quantity' => 2,
            'shipped_qty' => 2,
            'unit_net_price' => 50.00,
            'discount_rate' => 0,
            'tax_rate' => 10,
            'line_total' => 100.00,
            'currency' => 'TRY',
        ]);

        $this->actingAs($user);

        $baseUrl = '/api/reports/sales?date_from=2026-02-01&date_to=2026-02-28&per_page=50';

        $productResponse = $this->getJson($baseUrl.'&breakdown=product');
        $productResponse
            ->assertOk()
            ->assertJsonPath('report', 'sales')
            ->assertJsonPath('summary.order_count', 2)
            ->assertJsonPath('summary.quantity_total', 5)
            ->assertJsonPath('summary.net_total', '400.00')
            ->assertJsonPath('summary.tax_total', '70.00')
            ->assertJsonCount(2, 'data');

        $brandResponse = $this->getJson($baseUrl.'&breakdown=brand');
        $brandResponse
            ->assertOk()
            ->assertJsonCount(2, 'data')
            ->assertJsonFragment(['name' => 'Brand A'])
            ->assertJsonFragment(['name' => 'Brand B']);

        $customerResponse = $this->getJson($baseUrl.'&breakdown=customer');
        $customerResponse
            ->assertOk()
            ->assertJsonCount(2, 'data')
            ->assertJsonFragment(['code' => 'SL-001'])
            ->assertJsonFragment(['code' => 'SL-002']);

        $filteredResponse = $this->getJson($baseUrl.'&breakdown=product&customer_id='.$customerA->id);
        $filteredResponse
            ->assertOk()
            ->assertJsonPath('filters.customer_id', $customerA->id)
            ->assertJsonPath('summary.order_count', 1)
            ->assertJsonPath('summary.quantity_total', 3)
            ->assertJsonPath('summary.net_total', '300.00')
            ->assertJsonCount(1, 'data')
            ->assertJsonFragment(['name' => 'Urun A']);
    }

    public function test_collection_report_returns_factory_collector_customer_and_monthly_breakdowns(): void
    {
        $dealer = $this->createDealer('DLR-RPT-COL');
        $admin = $this->createUserWithRole('admin');
        $collector = $this->createUserWithRole('salesperson', $dealer);
        $idleCollector = $this->createUserWithRole('salesperson', $dealer);
        $customer = $this->createCustomer($dealer, 'COL-001', 'Tahsilat Carisi', [
            'salesperson_user_id' => $collector->id,
        ]);

        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'date' => '2026-06-03',
            'collection_date' => '2026-06-03',
            'collected_by_user_id' => $collector->id,
            'created_by_user_id' => $collector->id,
            'method' => 'cash',
            'amount' => 200,
            'currency' => 'TRY',
        ]);
        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'date' => '2026-06-04',
            'collection_date' => '2026-06-04',
            'collected_by_user_id' => $collector->id,
            'created_by_user_id' => $collector->id,
            'method' => 'cc',
            'amount' => 300,
            'currency' => 'TRY',
            'reference_fields' => ['collection_channel' => 'factory'],
        ]);

        $this->actingAs($admin)
            ->getJson('/api/reports/collections?dealer_id='.$dealer->id.'&date_from=2026-06-01&date_to=2026-06-30&top=10')
            ->assertOk()
            ->assertJsonPath('summary.collection_total', '500.00')
            ->assertJsonPath('method_breakdown.0.method', 'cash')
            ->assertJsonPath('method_breakdown.0.total', '200.00')
            ->assertJsonPath('method_breakdown.2.method', 'factory_cc')
            ->assertJsonPath('method_breakdown.2.total', '300.00')
            ->assertJsonPath('collector_breakdown.0.user_id', $collector->id)
            ->assertJsonPath('collector_breakdown.0.total', '500.00')
            ->assertJsonPath('collector_breakdown.0.factory_card_total', '300.00')
            ->assertJsonPath('collector_breakdown.1.user_id', $idleCollector->id)
            ->assertJsonPath('collector_breakdown.1.total', '0.00')
            ->assertJsonCount(2, 'collector_options')
            ->assertJsonPath('customer_breakdown.0.customer_id', $customer->id)
            ->assertJsonPath('customer_breakdown.0.total', '500.00')
            ->assertJsonPath('monthly_breakdown.0.month', '2026-06')
            ->assertJsonPath('monthly_breakdown.0.average', '250.00')
            ->assertJsonPath('data.0.collector.id', $collector->id)
            ->assertJsonPath('data.0.collector.name', $collector->name)
            ->assertJsonPath('data.0.customer.id', $customer->id);

        $this->getJson(
            '/api/reports/collections?dealer_id='.$dealer->id.'&date_from=2026-06-01&date_to=2026-06-30'
            .'&collector_id='.$collector->id
            .'&method=factory_cc'
        )
            ->assertOk()
            ->assertJsonPath('filters.collector_id', $collector->id)
            ->assertJsonPath('filters.method', 'factory_cc')
            ->assertJsonPath('summary.collection_count', 1)
            ->assertJsonPath('summary.collection_total', '300.00')
            ->assertJsonPath('data.0.method', 'factory_cc')
            ->assertJsonPath('data.0.amount', '300.00');
    }

    public function test_admin_without_dealer_context_reads_all_dealers(): void
    {
        $dealer = $this->createDealer('DLR-RPT-ADM');
        $secondDealer = $this->createDealer('DLR-RPT-ADM-2');
        $admin = $this->createUserWithRole('admin');
        $customer = $this->createCustomer($dealer, 'ADM-001', 'Admin Musteri');
        $secondCustomer = $this->createCustomer($secondDealer, 'ADM-002', 'Admin Musteri 2');
        $asOfDate = Carbon::create(2026, 3, 1)->toDateString();

        $this->insertLedgerDebit($dealer->id, $customer->id, 275.00, Carbon::parse($asOfDate)->subDays(15)->toDateString());
        $this->insertLedgerDebit($secondDealer->id, $secondCustomer->id, 125.00, Carbon::parse($asOfDate)->subDays(12)->toDateString());

        $this->actingAs($admin);

        $response = $this->getJson('/api/reports/customer-balances?date_to='.$asOfDate.'&per_page=10');

        $response
            ->assertOk()
            ->assertJsonPath('filters.dealer_id', null)
            ->assertJsonPath('summary.customer_count', 2)
            ->assertJsonPath('summary.balance_total', '400.00')
            ->assertJsonFragment(['customer_id' => $customer->id])
            ->assertJsonFragment(['customer_id' => $secondCustomer->id]);
    }

    public function test_admin_prefers_selected_customer_dealer_context_when_present(): void
    {
        $fallbackDealer = $this->createDealer('DLR-RPT-FALLBACK');
        $selectedDealer = $this->createDealer('DLR-RPT-SELECTED');
        $selectedCustomer = $this->createCustomer($selectedDealer, 'ADM-002', 'Secili Musteri');
        $admin = $this->createUserWithRole('admin');
        $admin->forceFill(['selected_customer_id' => $selectedCustomer->id])->save();
        $asOfDate = Carbon::create(2026, 3, 1)->toDateString();

        $this->insertLedgerDebit($fallbackDealer->id, $this->createCustomer($fallbackDealer, 'ADM-003', 'Fallback Musteri')->id, 90.00, Carbon::parse($asOfDate)->subDays(10)->toDateString());
        $this->insertLedgerDebit($selectedDealer->id, $selectedCustomer->id, 410.00, Carbon::parse($asOfDate)->subDays(12)->toDateString());

        $this->actingAs($admin);

        $response = $this->getJson('/api/reports/customer-balances?date_to='.$asOfDate.'&per_page=10');

        $response
            ->assertOk()
            ->assertJsonPath('filters.dealer_id', $selectedDealer->id)
            ->assertJsonPath('summary.customer_count', 1)
            ->assertJsonPath('summary.balance_total', '410.00')
            ->assertJsonPath('data.0.customer_id', $selectedCustomer->id);
    }

    public function test_branch_scoped_user_customer_balance_report_only_includes_own_branch(): void
    {
        $dealer = $this->createDealer('DLR-RPT-BR');
        $user = $this->createUserWithRole('dealer_admin', $dealer, [
            'customer_scope' => 'branch',
            'region_code' => 'KARADENIZ',
            'branch_code' => 'TRABZON',
        ]);
        $trabzonCustomer = $this->createCustomer($dealer, 'BR-001', 'Trabzon Cari', [
            'region_code' => 'KARADENIZ',
            'branch_code' => 'TRABZON',
        ]);
        $this->createCustomer($dealer, 'BR-002', 'Samsun Cari', [
            'region_code' => 'KARADENIZ',
            'branch_code' => 'SAMSUN',
        ]);
        $asOfDate = Carbon::create(2026, 3, 1)->toDateString();

        $this->insertLedgerDebit($dealer->id, $trabzonCustomer->id, 175.00, Carbon::parse($asOfDate)->subDays(8)->toDateString());
        $this->insertLedgerDebit($dealer->id, Customer::query()->where('code', 'BR-002')->value('id'), 240.00, Carbon::parse($asOfDate)->subDays(5)->toDateString());

        $this->actingAs($user);

        $this->getJson('/api/reports/customer-balances?date_to='.$asOfDate.'&per_page=10')
            ->assertOk()
            ->assertJsonPath('summary.customer_count', 1)
            ->assertJsonPath('summary.balance_total', '175.00')
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.customer_id', $trabzonCustomer->id);
    }

    public function test_logo_dashboard_reports_bidirectional_sync_state_and_latest_sync(): void
    {
        Http::fake([
            'www.tcmb.gov.tr/*' => Http::response('', 500),
        ]);

        $dealer = $this->createDealer('DLR-RPT-LOGO');
        $admin = $this->createUserWithRole('admin');
        $customer = $this->createCustomer($dealer, 'LOGO-001', 'Logo Cari');
        $inboundSyncedAt = Carbon::parse('2026-02-15 10:00:00');
        $outboundSyncedAt = Carbon::parse('2026-02-15 10:05:00');

        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'customers',
            'direction' => 'inbound',
            'entity_type' => Customer::class,
            'entity_id' => $customer->id,
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'external_ref' => 'LOGO-CUSTOMER-001',
            'status' => 'synced',
            'last_synced_at' => $inboundSyncedAt,
        ]);

        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'customers',
            'direction' => 'inbound',
            'entity_type' => Customer::class,
            'entity_id' => $customer->id + 100,
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'external_ref' => 'LOGO-CUSTOMER-ERR',
            'status' => 'failed',
            'last_error' => 'Logo cari okuma hatasi',
            'last_synced_at' => null,
            'updated_at' => Carbon::parse('2026-02-15 10:03:00'),
        ]);

        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'pos-sales',
            'direction' => 'outbound',
            'entity_type' => Customer::class,
            'entity_id' => $customer->id,
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'external_ref' => 'LOGO-POS-001',
            'status' => 'synced',
            'last_synced_at' => $outboundSyncedAt,
        ]);

        $this->actingAs($admin);

        $response = $this->getJson('/api/reports/logo-dashboard?date_from=2026-02-01&date_to=2026-02-28');

        $response
            ->assertOk()
            ->assertJsonPath('summary.logo_last_synced_at', $outboundSyncedAt->toJSON())
            ->assertJsonFragment([
                'domain' => 'customers',
                'direction' => 'inbound',
                'records' => 2,
                'synced_records' => 1,
                'failed_records' => 1,
                'pending_records' => 0,
                'latest_status' => 'failed',
                'last_error' => 'Logo cari okuma hatasi',
                'last_synced_at' => $inboundSyncedAt->toJSON(),
            ])
            ->assertJsonFragment([
                'domain' => 'pos-sales',
                'direction' => 'outbound',
                'records' => 1,
                'synced_records' => 1,
                'failed_records' => 0,
                'pending_records' => 0,
                'latest_status' => 'synced',
                'last_synced_at' => $outboundSyncedAt->toJSON(),
            ]);
    }

    public function test_logo_dashboard_counts_products_with_logo_integration_refs(): void
    {
        Http::fake([
            'www.tcmb.gov.tr/*' => Http::response('', 500),
        ]);

        $admin = $this->createUserWithRole('admin');
        $syncedProduct = $this->createProduct('LOGO-SYNCED', [
            'integrations' => [
                'logo' => [
                    'synced_at' => '2026-02-15T10:00:00Z',
                ],
            ],
        ]);
        $externalRefProduct = $this->createProduct('LOGO-EXT', [
            'integrations' => [
                'logo' => [
                    'external_ref' => 'LOGO-EXT-001',
                ],
            ],
        ]);
        $logicalRefProduct = $this->createProduct('LOGO-LOGICAL', [
            'integrations' => [
                'logo' => [
                    'logical_ref' => 12345,
                ],
            ],
        ]);
        $this->createProduct('LOCAL-ONLY', []);

        DB::table('stock_summary')->insert([
            [
                'product_id' => $syncedProduct->id,
                'available_total' => 4,
                'reserved_total' => 0,
                'updated_at' => now(),
            ],
            [
                'product_id' => $logicalRefProduct->id,
                'available_total' => 9,
                'reserved_total' => 0,
                'updated_at' => now(),
            ],
            [
                'product_id' => $externalRefProduct->id,
                'available_total' => 0,
                'reserved_total' => 0,
                'updated_at' => now(),
            ],
        ]);

        $this->actingAs($admin);

        $response = $this->getJson('/api/reports/logo-dashboard?date_from=2026-02-01&date_to=2026-02-28');

        $response
            ->assertOk()
            ->assertJsonPath('summary.logo_products_total', 3)
            ->assertJsonPath('summary.logo_stocked_products_total', 2)
            ->assertJsonFragment([
                'key' => 'products-inbound',
                'title' => 'Ürün okuma',
                'flow' => 'Logo -> B2B',
                'status' => 'warning',
                'expected_count' => 3,
                'synced_count' => 0,
                'missing_count' => 3,
            ])
            ->assertJsonFragment([
                'key' => 'products-shelf',
                'title' => 'Ürün raf adresleri',
                'flow' => 'Logo -> B2B',
                'status' => 'warning',
                'expected_count' => 3,
                'synced_count' => 0,
                'missing_count' => 3,
            ]);
    }

    public function test_logo_dashboard_does_not_treat_non_location_logo_fields_as_shelf_addresses(): void
    {
        Http::fake([
            'www.tcmb.gov.tr/*' => Http::response('', 500),
        ]);
        Cache::flush();

        $admin = $this->createUserWithRole('admin');
        $this->createProduct('LOGO-NO-RAF', [
            'integrations' => [
                'logo' => [
                    'synced_at' => '2026-02-15T10:00:00Z',
                    'payload' => [
                        'raw' => [
                            'SHELFLIFE' => '0',
                            'SHELFDATE' => '0',
                            'DRAFTOFFERBRWS' => '0',
                        ],
                    ],
                ],
            ],
        ]);
        $this->createProduct('LOGO-RAF', [
            'integrations' => [
                'logo' => [
                    'synced_at' => '2026-02-15T10:00:00Z',
                    'payload' => [
                        'raw' => [
                            'RAF25' => 'D.12',
                        ],
                    ],
                ],
            ],
        ]);
        $this->createProduct('LOGO-ZERO-RAF', [
            'integrations' => [
                'logo' => [
                    'synced_at' => '2026-02-15T10:00:00Z',
                    'payload' => [
                        'raw' => [
                            'RAF25' => '0',
                        ],
                    ],
                ],
            ],
        ]);

        $this->actingAs($admin);

        $response = $this->getJson('/api/reports/logo-dashboard?date_from=2026-02-01&date_to=2026-02-28');

        $response
            ->assertOk()
            ->assertJsonFragment([
                'key' => 'products-shelf',
                'title' => 'Ürün raf adresleri',
                'flow' => 'Logo -> B2B',
                'status' => 'warning',
                'expected_count' => 3,
                'synced_count' => 1,
                'missing_count' => 2,
            ]);
    }

    private function createDealer(string $code): Dealer
    {
        return Dealer::query()->create([
            'code' => $code,
            'name' => 'Dealer '.$code,
            'is_active' => true,
        ]);
    }

    private function createUserWithRole(string $roleSlug, ?Dealer $dealer = null, array $overrides = []): User
    {
        $role = Role::query()->firstOrCreate(
            ['slug' => $roleSlug],
            ['name' => Str::headline(str_replace('_', ' ', $roleSlug))]
        );

        $user = User::factory()->create(array_merge([
            'dealer_id' => $dealer?->id,
            'customer_scope' => $roleSlug === 'salesperson' ? 'assigned' : 'dealer',
            'region_code' => null,
            'branch_code' => null,
            'is_active' => true,
        ], $overrides));

        $user->roles()->sync([$role->id]);

        return $user;
    }

    private function createCustomer(Dealer $dealer, string $code, string $name, array $overrides = []): Customer
    {
        return Customer::query()->create(array_merge([
            'dealer_id' => $dealer->id,
            'code' => $code,
            'name' => $name,
            'source_system' => 'logo',
            'is_active' => true,
        ], $overrides));
    }

    /**
     * @param  array<string, mixed>  $meta
     */
    private function createProduct(string $sku, array $meta): Product
    {
        return Product::query()->create([
            'sku' => $sku,
            'name' => 'Product '.$sku,
            'oem_code' => null,
            'is_active' => true,
            'meta' => $meta,
        ]);
    }

    private function insertLedgerDebit(int $dealerId, int $customerId, float $amount, string $date): void
    {
        DB::table('ledger_entries')->insert([
            'dealer_id' => $dealerId,
            'customer_id' => $customerId,
            'entry_date' => $date,
            'entry_type' => 'debit',
            'amount' => $amount,
            'currency' => 'TRY',
            'date' => $date,
            'type' => 'invoice',
            'debit' => $amount,
            'credit' => 0,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    /**
     * @param  array<string, mixed>  $overrides
     */
    private function createOrderWithItem(Dealer $dealer, Customer $customer, User $user, array $overrides = []): void
    {
        $order = $this->createOrder($dealer, $customer, $user, $overrides);

        $product = Product::withoutEvents(function () use ($overrides): Product {
            return Product::query()->create([
                'sku' => (string) ($overrides['sku'] ?? ('SKU-'.Str::upper(Str::random(6)))),
                'oem_code' => (string) ($overrides['oem_code'] ?? ('OEM-'.Str::upper(Str::random(6)))),
                'name' => (string) ($overrides['product_name'] ?? 'Order Product'),
                'vat_rate' => (float) ($overrides['tax_rate'] ?? 20),
                'is_active' => true,
            ]);
        });

        $quantity = (int) ($overrides['quantity'] ?? 1);
        $lineTotal = (float) ($overrides['line_total'] ?? 100);

        OrderItem::query()->create([
            'order_id' => $order->id,
            'product_id' => $product->id,
            'quantity' => $quantity,
            'shipped_qty' => (int) ($overrides['shipped_qty'] ?? $quantity),
            'unit_net_price' => $lineTotal / max(1, $quantity),
            'discount_rate' => 0,
            'tax_rate' => (float) ($overrides['tax_rate'] ?? 20),
            'line_total' => $lineTotal,
            'currency' => 'TRY',
        ]);
    }

    /**
     * @param  array<string, mixed>  $overrides
     */
    private function createOrder(Dealer $dealer, Customer $customer, User $user, array $overrides = []): Order
    {
        $subtotal = (float) ($overrides['line_total'] ?? 100.00);
        $taxRate = (float) ($overrides['tax_rate'] ?? 20);
        $taxTotal = round($subtotal * ($taxRate / 100), 2);

        return Order::query()->create([
            'order_no' => (string) ($overrides['order_no'] ?? ('ORD-'.Str::upper(Str::random(8)))),
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'user_id' => $user->id,
            'status' => (string) ($overrides['status'] ?? 'pending'),
            'currency' => 'TRY',
            'subtotal' => $subtotal,
            'discount_total' => 0,
            'tax_total' => $taxTotal,
            'grand_total' => $subtotal + $taxTotal,
            'ordered_at' => $overrides['ordered_at'] ?? now(),
            'approved_at' => null,
        ]);
    }
}
