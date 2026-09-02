<?php

namespace Tests\Feature;

use App\Models\Cashbox;
use App\Models\Collection;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\FinanceDefinition;
use App\Models\IntegrationSyncState;
use App\Models\LedgerEntry;
use App\Models\PosExpense;
use App\Models\PosPayment;
use App\Models\PosSale;
use App\Models\PosSaleItem;
use App\Models\PosSession;
use App\Models\Product;
use App\Models\Role;
use App\Models\User;
use Database\Seeders\PosPointCustomerSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\TestCase;

class PointPosAccessApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_point_user_can_list_pos_customers_in_own_dealer_scope(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-'.Str::upper(Str::random(4)),
            'name' => 'Point Dealer',
            'is_active' => true,
        ]);

        $otherDealer = Dealer::query()->create([
            'code' => 'DLR-OTHER-'.Str::upper(Str::random(4)),
            'name' => 'Other Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);

        $visibleCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'POINT-NAKIT',
            'name' => 'Point Nakit Cari',
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $otherDealer->id,
            'code' => 'POINT-KART',
            'name' => 'Other Dealer Customer',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->getJson('/api/pos/customers?q=POINT&limit=10')
            ->assertOk()
            ->assertJsonPath('data.0.id', $visibleCustomer->id)
            ->assertJsonCount(1, 'data');
    }

    public function test_warehouse_user_with_pos_menu_can_list_pos_customers(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-WH-POS-'.Str::upper(Str::random(4)),
            'name' => 'Warehouse Pos Dealer',
            'is_active' => true,
        ]);

        $otherDealer = Dealer::query()->create([
            'code' => 'DLR-OTHER-'.Str::upper(Str::random(4)),
            'name' => 'Other Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('warehouse', $dealer);
        $user->forceFill([
            'menu_permissions' => ['warehouse', 'pos'],
        ])->save();

        $visibleCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'WH-POS-NAKIT',
            'name' => 'Depo Hızlı Satış Cari',
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $otherDealer->id,
            'code' => 'WH-POS-DIS',
            'name' => 'Diğer Depo Cari',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->getJson('/api/pos/customers?q=WH-POS&limit=10')
            ->assertOk()
            ->assertJsonPath('data.0.id', $visibleCustomer->id)
            ->assertJsonCount(1, 'data');
    }

    public function test_point_branch_user_can_list_unassigned_logo_customers_for_pos(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-'.Str::upper(Str::random(4)),
            'name' => 'Point Dealer',
            'is_active' => true,
        ]);

        $otherDealer = Dealer::query()->create([
            'code' => 'DLR-OTHER-'.Str::upper(Str::random(4)),
            'name' => 'Other Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer, [
            'customer_scope' => 'branch',
            'branch_code' => 'ERZURUM',
        ]);

        $visibleLogoCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'code' => '120-25-020',
            'name' => 'POLAT KARDEŞLER YAVUZ POLAT',
            'branch_code' => null,
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'code' => 'B2B-POLAT',
            'name' => 'B2B POLAT',
            'branch_code' => null,
            'is_active' => true,
        ]);

        Customer::query()->create([
            'dealer_id' => $otherDealer->id,
            'source_system' => 'logo',
            'code' => '120-25-021',
            'name' => 'OTHER POLAT',
            'branch_code' => null,
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->getJson('/api/pos/customers?source_system=logo&q=polat&limit=10')
            ->assertOk()
            ->assertJsonPath('total_count', 1)
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $visibleLogoCustomer->id);
    }

    public function test_point_user_can_open_read_and_close_pos_session(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-'.Str::upper(Str::random(4)),
            'name' => 'Point Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'menu_permissions' => ['pos', 'pos-expenses', 'pos-day-end', 'delivery-notes'],
        ])->save();

        $cashbox = Cashbox::query()->create([
            'code' => 'CB-'.Str::upper(Str::random(3)),
            'name' => 'Point Kasa',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->postJson('/api/pos/sessions/open', [
            'cashbox_id' => $cashbox->id,
            'opening_cash' => 250,
        ])
            ->assertCreated()
            ->assertJsonPath('data.status', 'open');

        $this->getJson('/api/pos/sessions/current')
            ->assertOk()
            ->assertJsonPath('data.cashbox.id', $cashbox->id)
            ->assertJsonPath('data.status', 'open');

        $this->postJson('/api/pos/sessions/close', [
            'cashbox_id' => $cashbox->id,
            'closing_cash_counted' => 250,
        ])
            ->assertOk()
            ->assertJsonPath('data.status', 'closed');
    }

    public function test_closing_pos_session_queues_paid_sales_for_logo_export(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-'.Str::upper(Str::random(4)),
            'name' => 'Point Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'menu_permissions' => ['pos', 'pos-expenses', 'pos-day-end', 'delivery-notes'],
        ])->save();

        $cashbox = Cashbox::query()->create([
            'code' => 'POINT-'.$user->id,
            'name' => 'Erzurum Point Kasa',
            'is_active' => true,
        ]);

        $session = PosSession::query()->create([
            'cashbox_id' => $cashbox->id,
            'opened_by' => $user->id,
            'opened_at' => now(),
            'opening_cash' => 0,
            'status' => 'open',
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1001',
            'code' => '120-POS-DAY-END',
            'name' => 'POS Gün Sonu Cari',
            'is_active' => true,
        ]);

        $sale = PosSale::query()->create([
            'pos_session_id' => $session->id,
            'customer_id' => $customer->id,
            'sale_type' => 'cash',
            'document_type' => 'delivery',
            'receipt_no' => 'POS-DAY-END-001',
            'subtotal' => '100.00',
            'discount_total' => '0.00',
            'vat_total' => '20.00',
            'grand_total' => '120.00',
            'status' => 'paid',
            'created_by' => $user->id,
        ]);

        $this->assertDatabaseMissing('integration_sync_states', [
            'system' => 'logo',
            'domain' => 'pos-sales',
            'direction' => 'outbound',
            'entity_type' => PosSale::class,
            'entity_id' => $sale->id,
        ]);

        $this->actingAs($user);

        $this->postJson('/api/pos/sessions/close', [
            'cashbox_id' => $cashbox->id,
            'closing_cash_counted' => 120,
        ])
            ->assertOk()
            ->assertJsonPath('data.status', 'closed');

        $this->assertDatabaseHas('integration_sync_states', [
            'system' => 'logo',
            'domain' => 'pos-sales',
            'direction' => 'outbound',
            'entity_type' => PosSale::class,
            'entity_id' => $sale->id,
            'status' => 'queued',
        ]);

        $this->assertDatabaseHas('integration_sync_events', [
            'system' => 'logo',
            'domain' => 'pos-sales',
            'direction' => 'outbound',
            'entity_type' => PosSale::class,
            'entity_id' => $sale->id,
            'status' => 'queued',
        ]);
    }

    public function test_delivery_note_list_can_search_by_receipt_or_customer(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-DELIVERY-'.Str::upper(Str::random(4)),
            'name' => 'Delivery Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'menu_permissions' => ['pos', 'delivery-notes'],
        ])->save();

        $cashbox = Cashbox::query()->create([
            'code' => 'POINT-'.$user->id,
            'name' => 'Point Kasa',
            'is_active' => true,
        ]);

        $session = PosSession::query()->create([
            'cashbox_id' => $cashbox->id,
            'opened_by' => $user->id,
            'opened_at' => now(),
            'opening_cash' => 0,
            'status' => 'open',
        ]);

        $matchingCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'DLV-SPECIAL-CARI',
            'name' => 'Ozel Irsaliye Cari',
            'is_active' => true,
        ]);

        $otherCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'DLV-OTHER',
            'name' => 'Baska Cari',
            'is_active' => true,
        ]);

        PosSale::query()->create([
            'pos_session_id' => $session->id,
            'customer_id' => $matchingCustomer->id,
            'sale_type' => 'cash',
            'document_type' => 'delivery',
            'receipt_no' => 'IRS-SPECIAL-001',
            'subtotal' => '100.00',
            'discount_total' => '0.00',
            'vat_total' => '0.00',
            'grand_total' => '100.00',
            'status' => 'paid',
            'created_by' => $user->id,
        ]);

        PosSale::query()->create([
            'pos_session_id' => $session->id,
            'customer_id' => $otherCustomer->id,
            'sale_type' => 'cash',
            'document_type' => 'delivery',
            'receipt_no' => 'IRS-OTHER-001',
            'subtotal' => '200.00',
            'discount_total' => '0.00',
            'vat_total' => '0.00',
            'grand_total' => '200.00',
            'status' => 'paid',
            'created_by' => $user->id,
        ]);

        $this->actingAs($user);

        $this->getJson('/api/pos/sales?document_type=delivery&q=Ozel%20Irsaliye&limit=10')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.receipt_no', 'IRS-SPECIAL-001')
            ->assertJsonPath('data.0.customer.code', 'DLV-SPECIAL-CARI');

        $this->getJson('/api/pos/sales?document_type=delivery&q=IRS-OTHER&limit=10')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.receipt_no', 'IRS-OTHER-001');
    }

    public function test_delivery_note_list_is_limited_to_non_admin_branch_scope(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-DLV-SCOPE-'.Str::upper(Str::random(4)),
            'name' => 'Delivery Scope Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'menu_permissions' => ['pos', 'delivery-notes'],
            'customer_scope' => 'branch',
            'branch_code' => 'TRABZON',
        ])->save();

        $cashbox = Cashbox::query()->create([
            'code' => 'DLV-SCOPE-'.$user->id,
            'name' => 'Delivery Scope Cashbox',
            'is_active' => true,
        ]);
        $session = PosSession::query()->create([
            'cashbox_id' => $cashbox->id,
            'opened_by' => $user->id,
            'opened_at' => now(),
            'opening_cash' => 0,
            'status' => 'open',
        ]);

        $trabzonCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => '120-61-901',
            'name' => 'Trabzon Delivery Customer',
            'branch_code' => 'TRABZON',
            'is_active' => true,
        ]);
        $samsunCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => '120-55-901',
            'name' => 'Samsun Delivery Customer',
            'branch_code' => 'SAMSUN',
            'is_active' => true,
        ]);

        foreach ([
            [$trabzonCustomer, 'IRS-TRABZON-SCOPE'],
            [$samsunCustomer, 'IRS-SAMSUN-SCOPE'],
        ] as [$customer, $receiptNo]) {
            PosSale::query()->create([
                'pos_session_id' => $session->id,
                'customer_id' => $customer->id,
                'sale_type' => 'cash',
                'document_type' => 'delivery',
                'receipt_no' => $receiptNo,
                'subtotal' => '100.00',
                'discount_total' => '0.00',
                'vat_total' => '0.00',
                'grand_total' => '100.00',
                'status' => 'paid',
                'created_by' => $user->id,
            ]);
        }

        $this->actingAs($user)
            ->getJson('/api/pos/sales?document_type=delivery&limit=10')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.receipt_no', 'IRS-TRABZON-SCOPE')
            ->assertJsonMissing(['receipt_no' => 'IRS-SAMSUN-SCOPE']);

        $admin = $this->createUserWithRole('admin');

        $this->actingAs($admin)
            ->getJson('/api/pos/sales?document_type=delivery&limit=10')
            ->assertOk()
            ->assertJsonFragment(['receipt_no' => 'IRS-TRABZON-SCOPE'])
            ->assertJsonFragment(['receipt_no' => 'IRS-SAMSUN-SCOPE']);
    }

    public function test_point_delivery_balance_sums_only_paid_delivery_notes_in_user_scope(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-BALANCE-'.Str::upper(Str::random(4)),
            'name' => 'Balance Dealer',
            'is_active' => true,
        ]);
        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill(['menu_permissions' => ['pos', 'delivery-notes']])->save();
        $cashbox = Cashbox::query()->create([
            'code' => 'POINT-BALANCE-'.$user->id,
            'name' => 'Balance Kasa',
            'is_active' => true,
        ]);
        $session = PosSession::query()->create([
            'cashbox_id' => $cashbox->id,
            'opened_by' => $user->id,
            'opened_at' => now(),
            'opening_cash' => 0,
            'status' => 'open',
        ]);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'DLV-BALANCE',
            'name' => 'Irsaliye Bakiye Cari',
            'is_active' => true,
        ]);

        foreach ([
            ['delivery', 'paid', '125.25'],
            ['delivery', 'paid', '74.75'],
            ['delivery', 'cancelled', '500.00'],
            ['invoice', 'paid', '900.00'],
        ] as $index => [$documentType, $status, $amount]) {
            PosSale::query()->create([
                'pos_session_id' => $session->id,
                'customer_id' => $customer->id,
                'sale_type' => 'cash',
                'document_type' => $documentType,
                'receipt_no' => 'BALANCE-'.($index + 1),
                'subtotal' => $amount,
                'discount_total' => '0.00',
                'vat_total' => '0.00',
                'grand_total' => $amount,
                'status' => $status,
                'created_by' => $user->id,
            ]);
        }

        $this->actingAs($user)
            ->getJson('/api/pos/sales/delivery-balance?customer_id='.$customer->id)
            ->assertOk()
            ->assertJsonPath('data.count', 2)
            ->assertJsonPath('data.amount', '200.00');

        $this->getJson('/api/pos/sales/delivery-balance')
            ->assertOk()
            ->assertJsonPath('data.count', 0)
            ->assertJsonPath('data.amount', '0.00');
    }

    public function test_point_delivery_balance_prefers_latest_logo_unbilled_total(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-LOGO-BALANCE',
            'name' => 'Logo Balance Dealer',
            'is_active' => true,
        ]);
        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill(['branch_code' => 'TRABZON'])->save();
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '4567',
            'code' => 'LOGO-BALANCE-CUSTOMER',
            'name' => 'Logo Balance Customer',
            'is_active' => true,
        ]);

        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'pos-delivery-balances',
            'direction' => 'inbound',
            'entity_type' => 'logo-customer-warehouse-2',
            'entity_id' => 4567,
            'dealer_id' => $dealer->id,
            'external_ref' => 'WAREHOUSE-2-CUSTOMER-4567',
            'status' => 'synced',
            'last_synced_at' => now(),
            'meta' => ['warehouse_no' => 2, 'customer_ref' => 4567, 'count' => 3, 'amount' => '456.78'],
        ]);

        $this->actingAs($user)
            ->getJson('/api/pos/sales/delivery-balance?customer_id='.$customer->id)
            ->assertOk()
            ->assertJsonPath('data.count', 3)
            ->assertJsonPath('data.amount', '456.78')
            ->assertJsonPath('data.source', 'logo');
    }

    public function test_logo_can_sync_unbilled_pos_delivery_balances(): void
    {
        config(['integrations.logo.pos_sale_sync_key' => 'test-pos-sale-key']);

        $this->withHeader('X-Integration-Key', 'test-pos-sale-key')
            ->postJson('/api/integrations/logo/pos-delivery-balances/sync', [
                'dealer_id' => 12,
                'records' => [
                    ['warehouse_no' => 0, 'count' => 2, 'amount' => 100.50],
                    ['warehouse_no' => 4, 'customer_ref' => 9876, 'count' => 1, 'amount' => 75.25],
                ],
            ])
            ->assertOk()
            ->assertJsonPath('received', 2)
            ->assertJsonPath('synced', 2);

        $this->assertDatabaseHas('integration_sync_states', [
            'system' => 'logo',
            'domain' => 'pos-delivery-balances',
            'direction' => 'inbound',
            'entity_type' => 'logo-customer-warehouse-4',
            'entity_id' => 9876,
            'dealer_id' => 12,
            'status' => 'synced',
        ]);
    }

    public function test_point_user_can_open_pos_session_without_sending_cashbox_id(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-'.Str::upper(Str::random(4)),
            'name' => 'Point Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);

        $this->actingAs($user);

        $this->postJson('/api/pos/sessions/open', [
            'opening_cash' => 0,
        ])
            ->assertCreated()
            ->assertJsonPath('data.status', 'open')
            ->assertJsonPath('data.cashbox.code', 'POINT-'.$user->id);
    }

    public function test_point_user_can_open_pos_session_with_user_logo_cashbox(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-'.Str::upper(Str::random(4)),
            'name' => 'Point Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'logo_cashbox_code' => '100.01.002',
            'logo_cashbox_name' => 'Ahmet Arac Kasasi',
        ])->save();

        $this->actingAs($user);

        $this->postJson('/api/pos/sessions/open', [
            'opening_cash' => 0,
        ])
            ->assertCreated()
            ->assertJsonPath('data.status', 'open')
            ->assertJsonPath('data.cashbox.code', '100.01.002')
            ->assertJsonPath('data.cashbox.name', 'Ahmet Arac Kasasi');
    }

    public function test_pos_point_customer_seeder_creates_anonymous_customer_for_point_dealer(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-'.Str::upper(Str::random(4)),
            'name' => 'Point Dealer',
            'is_active' => true,
        ]);

        $this->createUserWithRole('point', $dealer);

        $this->seed(PosPointCustomerSeeder::class);

        $customer = Customer::query()
            ->where('dealer_id', $dealer->id)
            ->where('code', 'POINT-CARISI-OLMAYAN')
            ->first();

        $this->assertNotNull($customer);
        $this->assertSame('CARİSİ OLMAYAN HIZLI SATIŞ', $customer->name);
        $this->assertTrue((bool) data_get($customer->meta, 'anonymous_sale'));
    }

    public function test_point_user_can_record_pos_expense_and_see_it_in_day_end_report(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-'.Str::upper(Str::random(4)),
            'name' => 'Point Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'menu_permissions' => ['pos', 'pos-expenses', 'pos-day-end', 'delivery-notes'],
        ])->save();

        $cashbox = Cashbox::query()->create([
            'code' => 'CB-'.Str::upper(Str::random(3)),
            'name' => 'Point Kasa',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $openResponse = $this->postJson('/api/pos/sessions/open', [
            'cashbox_id' => $cashbox->id,
            'opening_cash' => 500,
        ])->assertCreated();

        $sessionId = (int) $openResponse->json('data.id');
        $categoryId = FinanceDefinition::query()
            ->where('type', 'expense_category')
            ->where('code', 'fuel')
            ->value('id');

        $this->postJson('/api/pos/expenses', [
            'pos_session_id' => $sessionId,
            'finance_definition_id' => $categoryId,
            'amount' => 125.50,
            'category' => 'fuel',
            'note' => 'Acil sevkiyat',
        ])
            ->assertCreated()
            ->assertJsonPath('data.category', 'Yakıt')
            ->assertJsonPath('data.amount', '125.50')
            ->assertJsonPath('data.currency', 'TRY');

        $this->getJson('/api/pos/reports/day-end?pos_session_id='.$sessionId)
            ->assertOk()
            ->assertJsonPath('data.summary.expense_count', 1)
            ->assertJsonPath('data.summary.expense_total', '125.50')
            ->assertJsonPath('data.summary.expected_cash', '374.50')
            ->assertJsonPath('data.expenses.by_category.0.category', 'Yakıt');

        $expense = PosExpense::query()->latest('id')->firstOrFail();

        $this->assertDatabaseHas('integration_sync_states', [
            'domain' => 'pos-expenses',
            'entity_type' => PosExpense::class,
            'entity_id' => $expense->id,
            'status' => 'queued',
        ]);

        config(['integrations.logo.pos_expense_sync_key' => 'test-pos-expense-key']);

        $this
            ->withHeader('X-Integration-Key', 'test-pos-expense-key')
            ->getJson('/api/integrations/logo/pos-expenses/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('records.0.pos_expense_id', $expense->id)
            ->assertJsonPath('records.0.category', 'Yakıt')
            ->assertJsonPath('records.0.amount', '125.50')
            ->assertJsonPath('records.0.currency', 'TRY')
            ->assertJsonPath('records.0.cashbox_code', $cashbox->code)
            ->assertJsonPath('records.0.logo.account_code', '760.25.027');
    }

    public function test_batum_point_user_records_pos_expense_in_gel(): void
    {
        config(['integrations.logo.pos_expense_sync_key' => 'test-pos-expense-key']);

        $dealer = Dealer::query()->create([
            'code' => 'DLR-BATUM-EXPENSE-'.Str::upper(Str::random(4)),
            'name' => 'Batum Expense Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'branch_code' => 'BATUM',
            'region_code' => 'BATUM',
            'menu_permissions' => ['pos', 'pos-expenses', 'pos-day-end', 'delivery-notes'],
        ])->save();

        $cashbox = Cashbox::query()->create([
            'code' => '100.01.002',
            'name' => 'BATUM B2B VE HIZLI SATIS Kasasi',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $openResponse = $this->postJson('/api/pos/sessions/open', [
            'cashbox_id' => $cashbox->id,
            'opening_cash' => 0,
        ])->assertCreated();

        $sessionId = (int) $openResponse->json('data.id');
        $categoryId = FinanceDefinition::query()
            ->where('type', 'expense_category')
            ->where('code', 'marketing')
            ->value('id');

        $this->postJson('/api/pos/expenses', [
            'pos_session_id' => $sessionId,
            'finance_definition_id' => $categoryId,
            'amount' => 25,
            'category' => 'marketing',
            'note' => 'Batum masraf',
            'meta' => [
                'payment_source_type' => 'cash',
                'operation_type' => 'expense',
            ],
        ])
            ->assertCreated()
            ->assertJsonPath('data.currency', 'GEL');

        $this->postJson('/api/pos/expenses', [
            'pos_session_id' => $sessionId,
            'finance_definition_id' => $categoryId,
            'amount' => 10,
            'category' => 'marketing',
            'note' => 'Bankadan odenen Batum masrafi',
            'meta' => [
                'payment_source_type' => 'bank',
                'payment_source_logo_code' => '108-00-001',
                'payment_source_name' => 'BANK OF GEORGIA BATUM',
                'operation_type' => 'expense',
            ],
        ])->assertCreated();

        $bankTransferResponse = $this->postJson('/api/pos/expenses', [
            'pos_session_id' => $sessionId,
            'finance_definition_id' => $categoryId,
            'amount' => 100,
            'category' => 'BANK OF GEORGIA BATUM',
            'note' => 'Kasadan bankaya yatirilan',
            'meta' => [
                'payment_source_type' => 'cash',
                'bank_account_logo_code' => '108-00-001',
                'bank_account_name' => 'BANK OF GEORGIA BATUM',
                'operation_type' => 'cash_to_bank',
                'bank_transfer_mode' => true,
            ],
        ])->assertCreated();

        $farukTransferResponse = $this->postJson('/api/pos/expenses', [
            'pos_session_id' => $sessionId,
            'finance_definition_id' => $categoryId,
            'amount' => 50,
            'category' => 'FARUK CELIK GEORGIA BANK',
            'note' => 'Faruk Celik hesabina yatirilan',
            'meta' => [
                'payment_source_type' => 'cash',
                'bank_account_logo_code' => '05',
                'bank_account_name' => 'FARUK CELIK GEORGIA BANK',
                'operation_type' => 'cash_to_bank',
                'bank_transfer_mode' => true,
            ],
        ])->assertCreated();

        $legacyResponse = $this->postJson('/api/pos/expenses', [
            'pos_session_id' => $sessionId,
            'finance_definition_id' => $categoryId,
            'amount' => 75,
            'category' => 'POS HESABI GEORGIA BATUM',
            'note' => 'Eski format banka para cikisi',
            'meta' => [
                'payment_source_type' => 'cash',
                'operation_type' => 'expense',
            ],
        ])->assertCreated();

        $legacyExpense = PosExpense::query()->findOrFail((int) $legacyResponse->json('data.id'));
        $legacyMeta = is_array($legacyExpense->meta) ? $legacyExpense->meta : [];
        $legacyMeta['operation_type'] = 'expense';
        $legacyMeta['bank_transfer_mode'] = false;
        $legacyMeta['logo_expense_account_code'] = '108-00-001';
        $legacyMeta['logo_expense_account_name'] = 'POS HESABI GEORGIA BATUM';
        unset(
            $legacyMeta['bank_account_code'],
            $legacyMeta['bank_account_name'],
            $legacyMeta['bank_account_logo_code']
        );
        $legacyExpense->forceFill([
            'category' => 'POS HESABI GEORGIA BATUM',
            'meta' => $legacyMeta,
        ])->save();

        $legacyFarukResponse = $this->postJson('/api/pos/expenses', [
            'pos_session_id' => $sessionId,
            'finance_definition_id' => $categoryId,
            'amount' => 25,
            'category' => 'FARUK CELIK GEORGIA BANK',
            'note' => 'Eski format Faruk banka para cikisi',
            'meta' => [
                'payment_source_type' => 'cash',
                'operation_type' => 'expense',
            ],
        ])->assertCreated();

        $legacyFarukExpense = PosExpense::query()->findOrFail((int) $legacyFarukResponse->json('data.id'));
        $legacyFarukMeta = is_array($legacyFarukExpense->meta) ? $legacyFarukExpense->meta : [];
        $legacyFarukMeta['operation_type'] = 'expense';
        $legacyFarukMeta['bank_transfer_mode'] = false;
        $legacyFarukMeta['logo_expense_account_code'] = '05';
        $legacyFarukMeta['logo_expense_account_name'] = 'FARUK CELIK GEORGIA BANK';
        unset(
            $legacyFarukMeta['bank_account_code'],
            $legacyFarukMeta['bank_account_name'],
            $legacyFarukMeta['bank_account_logo_code']
        );
        $legacyFarukExpense->forceFill([
            'category' => 'FARUK CELIK GEORGIA BANK',
            'meta' => $legacyFarukMeta,
        ])->save();

        $this
            ->withHeader('X-Integration-Key', 'test-pos-expense-key')
            ->getJson('/api/integrations/logo/pos-expenses/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('records.0.cashbox_code', config('integrations.pos.batum_point_cashbox_code'))
            ->assertJsonPath('records.0.cashbox_name', config('integrations.pos.batum_point_cashbox_name'))
            ->assertJsonPath('records.1.payment_source_logo_code', '03')
            ->assertJsonPath('records.1.bank_account_logo_code', '03')
            ->assertJsonPath('records.2.bank_account_logo_code', '03')
            ->assertJsonPath('records.2.bank_transfer_mode', true)
            ->assertJsonPath('records.3.bank_account_logo_code', '05')
            ->assertJsonPath('records.3.bank_account_name', 'FARUK CELIK GEORGIA BANK')
            ->assertJsonPath('records.3.bank_transfer_mode', true)
            ->assertJsonPath('records.4.operation_type', 'cash_to_bank')
            ->assertJsonPath('records.4.bank_transfer_mode', true)
            ->assertJsonPath('records.4.bank_account_logo_code', '03')
            ->assertJsonPath('records.4.meta.legacy_bank_transfer_inferred', true)
            ->assertJsonPath('records.5.operation_type', 'cash_to_bank')
            ->assertJsonPath('records.5.bank_transfer_mode', true)
            ->assertJsonPath('records.5.bank_account_logo_code', '05')
            ->assertJsonPath('records.5.meta.legacy_bank_transfer_inferred', true);

        foreach ([
            [(int) $bankTransferResponse->json('data.id'), 'synced', 'KSLINES-100-BNFLINE-200'],
            [(int) $farukTransferResponse->json('data.id'), 'failed', null],
            [(int) $legacyResponse->json('data.id'), 'synced', 'KSLINES-101-BNFLINE-201'],
            [(int) $legacyFarukResponse->json('data.id'), 'failed', null],
        ] as [$expenseId, $status, $externalRef]) {
            IntegrationSyncState::query()->updateOrCreate([
                'system' => 'logo',
                'domain' => 'pos-expenses',
                'direction' => 'outbound',
                'entity_type' => PosExpense::class,
                'entity_id' => $expenseId,
            ], [
                'dealer_id' => $dealer->id,
                'external_ref' => $externalRef,
                'status' => $status,
                'last_error' => $status === 'failed' ? 'Logo bank account could not be resolved.' : null,
            ]);
        }

        $this->getJson('/api/pos/reports/day-end?pos_session_id='.$sessionId)
            ->assertOk()
            ->assertJsonPath('data.summary.expense_count', 2)
            ->assertJsonPath('data.summary.expense_total', '35.00')
            ->assertJsonPath('data.summary.cash_expense_total', '25.00')
            ->assertJsonPath('data.summary.bank_expense_total', '10.00')
            ->assertJsonPath('data.summary.bank_deposit_total', '175.00')
            ->assertJsonPath('data.summary.expected_cash', '-200.00');
    }

    public function test_logo_pos_expense_sync_imports_batum_cashbox_expenses_into_current_session(): void
    {
        config(['integrations.logo.pos_expense_sync_key' => 'test-pos-expense-key']);

        $dealer = Dealer::query()->create([
            'code' => 'DLR-BATUM-EXP-'.Str::upper(Str::random(4)),
            'name' => 'Batum Expense Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'menu_permissions' => ['pos', 'pos-expenses', 'pos-day-end'],
            'branch_code' => 'BATUM',
            'region_code' => 'BATUM',
            'logo_cashbox_code' => '100.01.002',
            'logo_cashbox_name' => 'BATUM B2B VE HIZLI SATIS Kasasi',
        ])->save();

        $cashbox = Cashbox::query()->create([
            'code' => '100.01.002',
            'name' => 'BATUM B2B VE HIZLI SATIS Kasasi',
            'is_active' => true,
        ]);

        $session = PosSession::query()->create([
            'cashbox_id' => $cashbox->id,
            'opened_by' => $user->id,
            'opened_at' => now(),
            'opening_cash' => 0,
            'status' => 'open',
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-pos-expense-key')
            ->postJson('/api/integrations/logo/pos-expenses/sync', [
                'dealer_code' => $dealer->code,
                'cashbox_code' => '100.01.002',
                'records' => [
                    [
                        'external_ref' => 'KSLINES-9981',
                        'expense_date' => '2026-06-05',
                        'category' => 'Yakit',
                        'amount' => 75.25,
                        'currency' => 'GEL',
                        'note' => 'Logo yakit masrafi',
                        'reference_no' => 'M-9981',
                    ],
                ],
            ])
            ->assertOk()
            ->assertJsonPath('summary.created', 1)
            ->assertJsonPath('summary.updated', 0);

        $expense = PosExpense::query()->firstOrFail();
        $this->assertSame($session->id, $expense->pos_session_id);
        $this->assertSame('logo', data_get($expense->meta, 'source_system'));

        $this->actingAs($user);

        $this->getJson('/api/pos/expenses?pos_session_id='.$session->id.'&cashbox_id='.$cashbox->id)
            ->assertOk()
            ->assertJsonPath('data.0.category', 'Yakit')
            ->assertJsonPath('data.0.amount', '75.25')
            ->assertJsonPath('data.0.source_system', 'logo')
            ->assertJsonPath('data.0.source_label', 'Logo kaydı')
            ->assertJsonPath('data.0.logo_sync_status', 'synced')
            ->assertJsonPath('data.0.logo_external_ref', 'KSLINES-9981');

        $this->getJson('/api/pos/reports/day-end?pos_session_id='.$session->id)
            ->assertOk()
            ->assertJsonPath('data.summary.expense_count', 1)
            ->assertJsonPath('data.summary.expense_total', '75.25');
    }

    public function test_warehouse_user_with_pos_menu_can_record_expense_and_read_day_end(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-WH-POS-'.Str::upper(Str::random(4)),
            'name' => 'Warehouse Pos Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('warehouse', $dealer);
        $user->forceFill([
            'menu_permissions' => ['warehouse', 'pos', 'pos-expenses', 'pos-day-end'],
        ])->save();

        $cashbox = Cashbox::query()->create([
            'code' => 'WH-CB-'.Str::upper(Str::random(3)),
            'name' => 'Depo Kasa',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $openResponse = $this->postJson('/api/pos/sessions/open', [
            'cashbox_id' => $cashbox->id,
            'opening_cash' => 300,
        ])->assertCreated();

        $sessionId = (int) $openResponse->json('data.id');
        $categoryId = FinanceDefinition::query()
            ->where('type', 'expense_category')
            ->where('code', 'marketing')
            ->value('id');

        $this->postJson('/api/pos/expenses', [
            'pos_session_id' => $sessionId,
            'finance_definition_id' => $categoryId,
            'amount' => 45,
            'category' => 'marketing',
            'note' => 'Depo masrafı',
        ])
            ->assertCreated()
            ->assertJsonPath('data.category', 'Pazarlama')
            ->assertJsonPath('data.amount', '45.00');

        $this->getJson('/api/pos/reports/day-end?pos_session_id='.$sessionId)
            ->assertOk()
            ->assertJsonPath('data.summary.expense_count', 1)
            ->assertJsonPath('data.summary.expense_total', '45.00');
    }

    public function test_pos_menu_user_without_cashbox_uses_own_session_scope(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-WH-POS-OWN-'.Str::upper(Str::random(4)),
            'name' => 'Warehouse Own Pos Dealer',
            'is_active' => true,
        ]);

        $otherUser = $this->createUserWithRole('point', $dealer);
        $otherCashbox = Cashbox::query()->create([
            'code' => 'POINT-'.$otherUser->id,
            'name' => 'Other Point Kasasi',
            'is_active' => true,
        ]);
        PosSession::query()->create([
            'cashbox_id' => $otherCashbox->id,
            'opened_by' => $otherUser->id,
            'opened_at' => now()->subHour(),
            'opening_cash' => 0,
            'status' => 'open',
        ]);

        $user = $this->createUserWithRole('warehouse', $dealer);
        $user->forceFill([
            'menu_permissions' => ['warehouse', 'pos', 'pos-expenses', 'pos-day-end'],
        ])->save();

        $this->actingAs($user);

        $this->getJson('/api/pos/sessions/current')
            ->assertOk()
            ->assertJsonPath('data', null);

        $this->postJson('/api/pos/sessions/open', [
            'opening_cash' => 0,
        ])
            ->assertCreated()
            ->assertJsonPath('data.status', 'open')
            ->assertJsonPath('data.cashbox.code', 'POINT-'.$user->id)
            ->assertJsonPath('data.opened_by.id', $user->id);
    }

    public function test_admin_can_list_open_pos_sessions_for_day_end_branch_selection(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-DAY-END-ADMIN-'.Str::upper(Str::random(4)),
            'name' => 'Day End Admin Dealer',
            'is_active' => true,
        ]);

        $admin = $this->createUserWithRole('admin');
        $admin->forceFill([
            'menu_permissions' => ['pos', 'pos-day-end'],
        ])->save();

        $erzurumUser = $this->createUserWithRole('point', $dealer);
        $erzurumUser->forceFill([
            'branch_code' => 'ERZURUM',
            'logo_cashbox_code' => 'POINT-ERZURUM',
            'logo_cashbox_name' => 'ERZURUM HIZLI SATIS Kasasi',
        ])->save();
        $batumUser = $this->createUserWithRole('point', $dealer);
        $batumUser->forceFill([
            'branch_code' => 'BATUM',
            'logo_cashbox_code' => 'POINT-BATUM',
            'logo_cashbox_name' => 'BATUM B2B VE HIZLI SATIS Kasasi',
        ])->save();

        $erzurumCashbox = Cashbox::query()->create([
            'code' => 'POINT-ERZURUM',
            'name' => 'ERZURUM HIZLI SATIS Kasasi',
            'is_active' => true,
        ]);
        $batumCashbox = Cashbox::query()->create([
            'code' => 'POINT-BATUM',
            'name' => 'BATUM B2B VE HIZLI SATIS Kasasi',
            'is_active' => true,
        ]);

        PosSession::query()->create([
            'cashbox_id' => $erzurumCashbox->id,
            'opened_by' => $erzurumUser->id,
            'opened_at' => now()->subMinutes(10),
            'opening_cash' => 100,
            'status' => 'open',
        ]);
        PosSession::query()->create([
            'cashbox_id' => $batumCashbox->id,
            'opened_by' => $batumUser->id,
            'opened_at' => now()->subMinutes(5),
            'opening_cash' => 200,
            'status' => 'open',
        ]);

        $this->actingAs($admin);

        $this->getJson('/api/pos/sessions/current?all=1')
            ->assertOk()
            ->assertJsonCount(2, 'data')
            ->assertJsonPath('data.0.cashbox.code', 'POINT-BATUM')
            ->assertJsonPath('data.0.opened_by.branch_code', 'BATUM')
            ->assertJsonPath('data.1.cashbox.code', 'POINT-ERZURUM')
            ->assertJsonPath('data.1.opened_by.branch_code', 'ERZURUM');
    }

    public function test_admin_current_pos_session_does_not_default_to_other_branch_session(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-ADMIN-CURRENT-'.Str::upper(Str::random(4)),
            'name' => 'Admin Current Dealer',
            'is_active' => true,
        ]);

        $admin = $this->createUserWithRole('admin');
        $admin->forceFill([
            'menu_permissions' => ['pos', 'pos-expenses', 'pos-day-end'],
        ])->save();

        $batumUser = $this->createUserWithRole('point', $dealer);
        $batumUser->forceFill([
            'branch_code' => 'BATUM',
            'region_code' => 'BATUM',
            'logo_cashbox_code' => 'POINT-BATUM',
            'logo_cashbox_name' => 'BATUM B2B VE HIZLI SATIS Kasasi',
        ])->save();

        $batumCashbox = Cashbox::query()->create([
            'code' => 'POINT-BATUM',
            'name' => 'BATUM B2B VE HIZLI SATIS Kasasi',
            'is_active' => true,
        ]);

        PosSession::query()->create([
            'cashbox_id' => $batumCashbox->id,
            'opened_by' => $batumUser->id,
            'opened_at' => now(),
            'opening_cash' => 0,
            'status' => 'open',
        ]);

        $this->actingAs($admin);

        $this->getJson('/api/pos/sessions/current')
            ->assertOk()
            ->assertJsonPath('data', null);

        $this->getJson('/api/pos/sessions/current?all=1')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.cashbox.code', 'POINT-BATUM');
    }

    public function test_admin_open_pos_session_without_cashbox_uses_main_pos_cashbox(): void
    {
        $admin = $this->createUserWithRole('admin');
        $admin->forceFill([
            'menu_permissions' => ['pos', 'pos-expenses', 'pos-day-end'],
        ])->save();

        Cashbox::query()->create([
            'code' => 'POINT-BATUM',
            'name' => 'BATUM B2B VE HIZLI SATIS Kasasi',
            'is_active' => true,
        ]);

        $this->actingAs($admin);

        $this->postJson('/api/pos/sessions/open', [
            'opening_cash' => 0,
        ])
            ->assertCreated()
            ->assertJsonPath('data.status', 'open')
            ->assertJsonPath('data.cashbox.code', 'MAIN-POS')
            ->assertJsonPath('data.opened_by.id', $admin->id);
    }

    public function test_point_user_can_collect_customer_payment_and_it_reflects_in_day_end(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-'.Str::upper(Str::random(4)),
            'name' => 'Point Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'menu_permissions' => ['pos', 'pos-day-end', 'delivery-notes'],
        ])->save();

        $cashbox = Cashbox::query()->create([
            'code' => 'CB-'.Str::upper(Str::random(3)),
            'name' => 'Point Kasa',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'CR-'.Str::upper(Str::random(5)),
            'name' => 'Tahsilat Cari',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $openResponse = $this->postJson('/api/pos/sessions/open', [
            'cashbox_id' => $cashbox->id,
            'opening_cash' => 500,
        ])->assertCreated();

        $sessionId = (int) $openResponse->json('data.id');

        $this->postJson("/api/customers/{$customer->id}/collections", [
            'method' => 'cash',
            'amount' => 200,
            'note' => 'Cari ödeme',
            'meta' => [
                'source' => 'point_collection',
                'pos_session_id' => $sessionId,
                'cashbox_id' => $cashbox->id,
            ],
        ])
            ->assertCreated()
            ->assertJsonPath('collection.method', 'cash')
            ->assertJsonPath('collection.amount', '200.00');

        $this->getJson('/api/pos/reports/day-end?pos_session_id='.$sessionId)
            ->assertOk()
            ->assertJsonPath('data.summary.expected_cash', '700.00')
            ->assertJsonPath('data.totals_by_method.0.method', 'cash')
            ->assertJsonPath('data.totals_by_method.0.total_amount', '200.00');
    }

    public function test_closing_day_end_queues_session_customer_collections_for_logo_cashbox(): void
    {
        config(['integrations.logo.collection_sync_key' => 'test-sync-key']);

        $dealer = Dealer::query()->create([
            'code' => 'DLR-DAY-END-COL-'.Str::upper(Str::random(4)),
            'name' => 'Day End Collection Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'menu_permissions' => ['pos', 'pos-day-end', 'delivery-notes'],
        ])->save();

        $cashbox = Cashbox::query()->create([
            'code' => 'POINT-CASHBOX',
            'name' => 'Erzurum Hızlı Satış Kasası',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'source_reference' => '120-25-900',
            'sync_status' => 'synced',
            'code' => '120-25-900',
            'name' => 'Logo Tahsilat Cari',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $openResponse = $this->postJson('/api/pos/sessions/open', [
            'cashbox_id' => $cashbox->id,
            'opening_cash' => 0,
        ])->assertCreated();

        $sessionId = (int) $openResponse->json('data.id');

        $this->postJson("/api/customers/{$customer->id}/collections", [
            'method' => 'cash',
            'amount' => 320,
            'note' => 'Gün sonu tahsilatı',
            'meta' => [
                'source' => 'point_collection',
                'pos_session_id' => $sessionId,
                'cashbox_id' => $cashbox->id,
            ],
        ])
            ->assertCreated()
            ->assertJsonPath('collection.sync_status', 'draft');

        $collection = Collection::query()->latest('id')->firstOrFail();

        $this->postJson('/api/pos/sessions/close', [
            'cashbox_id' => $cashbox->id,
            'closing_cash_counted' => 320,
        ])->assertOk();

        $this->assertDatabaseHas('collections', [
            'id' => $collection->id,
            'sync_status' => 'pending',
        ]);

        $this->assertDatabaseHas('integration_sync_states', [
            'system' => 'logo',
            'domain' => 'collections-write',
            'entity_type' => Collection::class,
            'entity_id' => $collection->id,
            'status' => 'queued',
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/collections/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('records.0.collection_id', $collection->id)
            ->assertJsonPath('records.0.cashbox_id', $cashbox->id)
            ->assertJsonPath('records.0.cashbox_code', config('integrations.pos.erzurum_point_cashbox_code'));
    }

    public function test_point_day_end_includes_session_linked_customer_collection_without_source_tag(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-'.Str::upper(Str::random(4)),
            'name' => 'Point Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'menu_permissions' => ['pos', 'pos-day-end', 'delivery-notes'],
        ])->save();

        $cashbox = Cashbox::query()->create([
            'code' => 'CB-'.Str::upper(Str::random(3)),
            'name' => 'Point Kasa',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'CR-'.Str::upper(Str::random(5)),
            'name' => 'Tahsilat Cari',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $openResponse = $this->postJson('/api/pos/sessions/open', [
            'cashbox_id' => $cashbox->id,
            'opening_cash' => 100,
        ])->assertCreated();

        $sessionId = (int) $openResponse->json('data.id');

        $this->postJson("/api/customers/{$customer->id}/collections", [
            'method' => 'cc',
            'amount' => 75,
            'currency' => 'GEL',
            'reference_fields' => [
                'pos_bank' => 'yapi_kredi',
                'pos_payment_type' => 'pesin',
            ],
            'meta' => [
                'pos_session_id' => $sessionId,
                'cashbox_id' => $cashbox->id,
            ],
        ])
            ->assertCreated()
            ->assertJsonPath('collection.method', 'cc')
            ->assertJsonPath('collection.amount', '75.00');

        $this->getJson('/api/pos/reports/day-end?pos_session_id='.$sessionId)
            ->assertOk()
            ->assertJsonPath('data.totals_by_method.1.method', 'card')
            ->assertJsonPath('data.totals_by_method.1.total_amount', '75.00')
            ->assertJsonPath('data.report_tables.card_collections.0.customer_name', 'Tahsilat Cari')
            ->assertJsonPath('data.report_tables.card_collections.0.amount', '75.00');
    }

    public function test_point_day_end_keeps_pos_sale_payments_out_of_collection_panels(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-DAY-END-'.Str::upper(Str::random(4)),
            'name' => 'Point Day End Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'menu_permissions' => ['pos', 'pos-day-end', 'delivery-notes'],
        ])->save();

        $cashbox = Cashbox::query()->create([
            'code' => 'POINT-'.$user->id,
            'name' => 'Erzurum Hızlı Satış Kasası',
            'is_active' => true,
        ]);

        $cashCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1001',
            'code' => 'POINT-NAKIT',
            'name' => 'ERZURUM POINT NAKIT SATIS',
            'is_active' => true,
        ]);

        $cardCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1002',
            'code' => 'POINT-KREDI-KARTI',
            'name' => 'ERZURUM POINT KREDI KARTI SATIS',
            'is_active' => true,
        ]);

        $normalCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1003',
            'code' => 'NORMAL-CARI',
            'name' => 'ABC OTOMOTIV',
            'is_active' => true,
        ]);

        $collectionCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'CR-TAHSILAT',
            'name' => 'Tahsilat Cari',
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'POS-DAY-END-001',
                'name' => 'POS Day End Product',
                'unit' => 'adet',
                'vat_rate' => 20,
                'is_active' => true,
            ]);
        });

        DB::table('stock_summary')->insert([
            'product_id' => $product->id,
            'available_total' => 5,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $openResponse = $this->postJson('/api/pos/sessions/open', [
            'cashbox_id' => $cashbox->id,
            'opening_cash' => 0,
        ])->assertCreated();

        $sessionId = (int) $openResponse->json('data.id');

        foreach ([
            ['customer' => $cashCustomer, 'sale_type' => 'cash', 'receipt_no' => 'POS-CASH-001', 'amount' => 100],
            ['customer' => $cardCustomer, 'sale_type' => 'card', 'receipt_no' => 'POS-CARD-001', 'amount' => 200],
            ['customer' => $normalCustomer, 'sale_type' => 'cash', 'receipt_no' => 'POS-NORMAL-001', 'amount' => 300],
        ] as $salePayload) {
            $this->postJson('/api/pos/sales', [
                'pos_session_id' => $sessionId,
                'customer_id' => $salePayload['customer']->id,
                'sale_type' => $salePayload['sale_type'],
                'document_type' => 'delivery',
                'receipt_no' => $salePayload['receipt_no'],
                'items' => [
                    [
                        'product_id' => $product->id,
                        'qty' => 1,
                        'unit_price' => $salePayload['amount'] / 1.2,
                        'vat_rate' => 20,
                    ],
                ],
                'payments' => [
                    [
                        'method' => $salePayload['sale_type'],
                        'amount' => $salePayload['amount'],
                    ],
                ],
            ])->assertCreated();
        }

        $this->postJson("/api/customers/{$collectionCustomer->id}/collections", [
            'method' => 'cash',
            'amount' => 50,
            'note' => 'Cari ödeme',
            'meta' => [
                'source' => 'point_collection',
                'pos_session_id' => $sessionId,
                'cashbox_id' => $cashbox->id,
            ],
        ])->assertCreated();

        $this->getJson('/api/pos/reports/day-end?pos_session_id='.$sessionId)
            ->assertOk()
            ->assertJsonCount(1, 'data.report_tables.cash_sales')
            ->assertJsonPath('data.report_tables.cash_sales.0.customer_name', 'ERZURUM POINT NAKIT SATIS')
            ->assertJsonPath('data.report_tables.cash_sales.0.grand_total', '100.00')
            ->assertJsonCount(1, 'data.report_tables.card_sales')
            ->assertJsonPath('data.report_tables.card_sales.0.customer_name', 'ERZURUM POINT KREDI KARTI SATIS')
            ->assertJsonPath('data.report_tables.card_sales.0.grand_total', '200.00')
            ->assertJsonCount(1, 'data.report_tables.normal_sales')
            ->assertJsonPath('data.report_tables.normal_sales.0.customer_name', 'ABC OTOMOTIV')
            ->assertJsonPath('data.report_tables.normal_sales.0.grand_total', '300.00')
            ->assertJsonCount(1, 'data.report_tables.cash_collections')
            ->assertJsonPath('data.report_tables.cash_collections.0.customer_name', 'Tahsilat Cari')
            ->assertJsonPath('data.report_tables.cash_collections.0.amount', '50.00')
            ->assertJsonCount(0, 'data.report_tables.card_collections')
            ->assertJsonPath('data.totals_by_method.0.method', 'cash')
            ->assertJsonPath('data.totals_by_method.0.total_amount', '150.00')
            ->assertJsonPath('data.totals_by_method.1.method', 'card')
            ->assertJsonPath('data.totals_by_method.1.total_amount', '200.00');
    }

    public function test_point_day_end_classifies_only_branch_retail_customers_as_cash_or_card(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POS-BUCKETS-'.Str::upper(Str::random(4)),
            'name' => 'POS Bucket Dealer',
            'is_active' => true,
        ]);
        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'menu_permissions' => ['pos', 'pos-day-end'],
        ])->save();
        $cashbox = Cashbox::query()->create([
            'code' => 'BUCKET-CASHBOX-'.$user->id,
            'name' => 'Bucket Test Cashbox',
            'is_active' => true,
        ]);
        $session = PosSession::query()->create([
            'cashbox_id' => $cashbox->id,
            'opened_by' => $user->id,
            'opened_at' => now(),
            'opening_cash' => 0,
            'status' => 'open',
        ]);

        $customers = [
            ['BATUM PERAKENDE NAKIT SATIS', 'cash'],
            ['BATUM PERAKENDE KREDI KARTI SATIS', 'card'],
            ['ERZURUM POINT NAKIT SATIS', 'cash'],
            ['ERZURUM POINT KREDI KARTI SATIS', 'card'],
            ['TRABZON POINT PERAKENDE NAKIT SATIS', 'cash'],
            ['TRABZON POINT PERAKENDE KREDI KARTI SATIS', 'card'],
            ['SAMSUN DEPO NAKIT SATIS', 'cash'],
            ['SAMSUN DEPO KREDI KARTI SATIS', 'card'],
            ['FAVORI YAG NORMAL MUSTERI', 'normal'],
        ];

        foreach ($customers as $index => [$name, $expectedBucket]) {
            $customer = Customer::query()->create([
                'dealer_id' => $dealer->id,
                'code' => 'BUCKET-'.($index + 1),
                'name' => $name,
                'is_active' => true,
            ]);
            $saleType = $expectedBucket === 'card' ? 'card' : 'cash';

            PosSale::query()->create([
                'pos_session_id' => $session->id,
                'customer_id' => $customer->id,
                'sale_type' => $saleType,
                'document_type' => 'delivery',
                'receipt_no' => 'BUCKET-SALE-'.($index + 1),
                'subtotal' => '10.00',
                'discount_total' => '0.00',
                'vat_total' => '2.00',
                'grand_total' => '12.00',
                'status' => 'paid',
                'created_by' => $user->id,
            ]);
        }

        $this->actingAs($user)
            ->getJson('/api/pos/reports/day-end?pos_session_id='.$session->id)
            ->assertOk()
            ->assertJsonCount(4, 'data.report_tables.cash_sales')
            ->assertJsonCount(4, 'data.report_tables.card_sales')
            ->assertJsonCount(1, 'data.report_tables.normal_sales')
            ->assertJsonPath('data.report_tables.normal_sales.0.customer_name', 'FAVORI YAG NORMAL MUSTERI');
    }

    public function test_point_day_end_save_queues_cash_and_card_pos_payments_with_user_logo_cashbox(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-DAY-END-SAVE-'.Str::upper(Str::random(4)),
            'name' => 'Point Day End Save Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'menu_permissions' => ['pos', 'pos-day-end', 'delivery-notes'],
            'logo_cashbox_code' => '100.01.007',
            'logo_cashbox_name' => 'ERZURUM POINT KASASI',
        ])->save();

        $cashbox = Cashbox::query()->create([
            'code' => 'WRONG-CASHBOX',
            'name' => 'Session Cashbox Should Not Win',
            'is_active' => true,
        ]);

        $cashCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'POINT-SAVE-NAKIT',
            'name' => 'ERZURUM POINT NAKIT SATIS',
            'is_active' => true,
        ]);

        $cardCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'POINT-SAVE-KART',
            'name' => 'ERZURUM POINT KREDI KARTI SATIS',
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'POS-DAY-END-SAVE-001',
                'name' => 'POS Day End Save Product',
                'unit' => 'adet',
                'vat_rate' => 20,
                'is_active' => true,
            ]);
        });

        DB::table('stock_summary')->insert([
            'product_id' => $product->id,
            'available_total' => 10,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $openResponse = $this->postJson('/api/pos/sessions/open', [
            'cashbox_id' => $cashbox->id,
            'opening_cash' => 0,
        ])->assertCreated();

        $sessionId = (int) $openResponse->json('data.id');

        foreach ([
            ['customer' => $cashCustomer, 'sale_type' => 'cash', 'receipt_no' => 'POS-DAY-END-CASH', 'amount' => 120],
            ['customer' => $cardCustomer, 'sale_type' => 'card', 'receipt_no' => 'POS-DAY-END-CARD', 'amount' => 240],
        ] as $salePayload) {
            $this->postJson('/api/pos/sales', [
                'pos_session_id' => $sessionId,
                'customer_id' => $salePayload['customer']->id,
                'sale_type' => $salePayload['sale_type'],
                'document_type' => 'invoice',
                'receipt_no' => $salePayload['receipt_no'],
                'items' => [
                    [
                        'product_id' => $product->id,
                        'qty' => 1,
                        'unit_price' => $salePayload['amount'] / 1.2,
                        'vat_rate' => 20,
                    ],
                ],
                'payments' => [
                    [
                        'method' => $salePayload['sale_type'],
                        'amount' => $salePayload['amount'],
                    ],
                ],
            ])->assertCreated();
        }

        $collectionCustomer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'POINT-SAVE-TAHSILAT',
            'name' => 'Tahsilat Cari',
            'is_active' => true,
        ]);

        $this->postJson("/api/customers/{$collectionCustomer->id}/collections", [
            'method' => 'cash',
            'amount' => 30,
            'note' => 'Gün sonu tekrar yazılmayacak tahsilat',
            'meta' => [
                'source' => 'point_collection',
                'pos_session_id' => $sessionId,
                'cashbox_id' => $cashbox->id,
            ],
        ])->assertCreated();

        $this->postJson('/api/pos/reports/day-end/save?pos_session_id='.$sessionId.'&date='.now()->toDateString())
            ->assertOk()
            ->assertJsonPath('data.day_end_export.status', 'queued')
            ->assertJsonPath('data.day_end_export.cash_amount', '120.00')
            ->assertJsonPath('data.day_end_export.card_amount', '240.00');

        $state = IntegrationSyncState::query()
            ->where('domain', 'pos-day-ends')
            ->where('entity_type', PosSession::class)
            ->where('entity_id', $sessionId)
            ->firstOrFail();

        $this->assertSame('queued', $state->status);
        $this->assertSame('120.00', data_get($state->meta, 'payload.cash_amount'));
        $this->assertSame('240.00', data_get($state->meta, 'payload.card_amount'));
        $this->assertSame('100.01.007', data_get($state->meta, 'payload.cashbox_code'));
        $this->assertSame('ERZURUM POINT KASASI', data_get($state->meta, 'payload.cashbox_name'));
        $this->assertEquals(30.0, data_get($state->meta, 'payload.totals.cash_collections'));
        $this->assertEquals(30.0, data_get($state->meta, 'payload.accounting_totals.cash_collections_report_only'));
        $this->assertSame('POINT-SAVE-NAKIT', data_get($state->meta, 'payload.cash_sale_customer_code'));
        $this->assertSame('ERZURUM POINT NAKIT SATIS', data_get($state->meta, 'payload.cash_sale_customer_name'));
        $this->assertSame('POINT-SAVE-KART', data_get($state->meta, 'payload.card_sale_customer_code'));
        $this->assertSame('ERZURUM POINT KREDI KARTI SATIS', data_get($state->meta, 'payload.card_sale_customer_name'));
    }

    public function test_pos_menu_alone_does_not_allow_expenses_or_day_end_report(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-'.Str::upper(Str::random(4)),
            'name' => 'Point Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'menu_permissions' => ['pos', 'delivery-notes'],
        ])->save();

        $cashbox = Cashbox::query()->create([
            'code' => 'CB-'.Str::upper(Str::random(3)),
            'name' => 'Point Kasa',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $openResponse = $this->postJson('/api/pos/sessions/open', [
            'cashbox_id' => $cashbox->id,
            'opening_cash' => 500,
        ])->assertCreated();

        $sessionId = (int) $openResponse->json('data.id');

        $this->postJson('/api/pos/expenses', [
            'pos_session_id' => $sessionId,
            'amount' => 125.50,
            'category' => 'Kargo',
        ])->assertForbidden();

        $this->getJson('/api/pos/reports/day-end?pos_session_id='.$sessionId)
            ->assertForbidden();
    }

    public function test_collection_for_exported_b2b_customer_is_queued_for_logo_after_send(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-'.Str::upper(Str::random(4)),
            'name' => 'Point Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'source_reference' => '1001',
            'sync_status' => 'synced',
            'code' => 'CR-'.Str::upper(Str::random(5)),
            'name' => 'Exported B2B Cari',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->postJson("/api/customers/{$customer->id}/collections", [
            'method' => 'cash',
            'amount' => 150,
            'note' => 'Cari ödeme',
        ])
            ->assertCreated()
            ->assertJsonPath('collection.sync_status', 'draft');

        $collection = Collection::query()->latest('id')->firstOrFail();

        $this->postJson("/api/customers/{$customer->id}/collections/{$collection->id}/send")
            ->assertOk()
            ->assertJsonPath('collection.sync_status', 'pending')
            ->assertJsonPath('message', 'Tahsilat Logo’ya gönderiliyor.');
    }

    public function test_salesperson_collection_is_exported_with_matching_logo_cashbox(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-SP-'.Str::upper(Str::random(4)),
            'name' => 'Salesperson Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('salesperson', $dealer);
        $user->forceFill([
            'name' => 'Ahmet',
            'logo_cashbox_code' => '100.02.003',
            'logo_cashbox_name' => 'AHMET ARAÇ KASASI',
        ])->save();

        $cashbox = Cashbox::query()->create([
            'code' => '100.02.003',
            'name' => 'AHMET ARAÇ KASASI',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $user->id,
            'source_system' => 'b2b',
            'source_reference' => '120-25-003',
            'sync_status' => 'synced',
            'code' => '120-25-003',
            'name' => 'Logo Plasiyer Cari',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->postJson("/api/customers/{$customer->id}/collections", [
            'method' => 'cash',
            'amount' => 5000,
            'note' => 'B2B plasiyer tahsilatı',
        ])
            ->assertCreated()
            ->assertJsonPath('collection.sync_status', 'draft')
            ->assertJsonPath('collection.meta.cashbox_id', $cashbox->id)
            ->assertJsonPath('collection.meta.cashbox.code', '100.02.003');

        $collection = Collection::query()->latest('id')->firstOrFail();

        $this->assertSame($cashbox->id, $collection->meta['cashbox_id']);

        $this->postJson("/api/customers/{$customer->id}/collections/{$collection->id}/send")
            ->assertOk()
            ->assertJsonPath('collection.sync_status', 'pending');

        $ledgerEntry = LedgerEntry::query()
            ->where('collection_id', $collection->id)
            ->firstOrFail();

        $this->assertSame($cashbox->id, $ledgerEntry->meta['cashbox_id']);

        config(['integrations.logo.collection_sync_key' => 'test-sync-key']);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/collections/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('records.0.collection_id', $collection->id)
            ->assertJsonPath('records.0.cashbox_id', $cashbox->id)
            ->assertJsonPath('records.0.cashbox_code', '100.02.003')
            ->assertJsonPath('records.0.cashbox_name', 'AHMET ARAÇ KASASI');
    }

    public function test_pos_invoice_payment_for_exported_customer_is_marked_pending_for_logo_export_with_cashbox(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-'.Str::upper(Str::random(4)),
            'name' => 'Point Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);

        $cashbox = Cashbox::query()->create([
            'code' => '100.01.002',
            'name' => 'Ahmet Arac Kasasi',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'source_reference' => '120-25-002',
            'sync_status' => 'synced',
            'code' => '120-25-002',
            'name' => 'Logo Cari',
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'POS-TEST-001',
                'name' => 'POS Test Product',
                'unit' => 'adet',
                'vat_rate' => 0,
                'is_active' => true,
            ]);
        });

        DB::table('stock_summary')->insert([
            'product_id' => $product->id,
            'available_total' => 5,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $openResponse = $this->postJson('/api/pos/sessions/open', [
            'cashbox_id' => $cashbox->id,
            'opening_cash' => 0,
        ])->assertCreated();

        $sessionId = (int) $openResponse->json('data.id');

        $this->postJson('/api/pos/sales', [
            'pos_session_id' => $sessionId,
            'customer_id' => $customer->id,
            'sale_type' => 'cash',
            'document_type' => 'invoice',
            'receipt_no' => 'POS-EXPORT-001',
            'items' => [
                [
                    'product_id' => $product->id,
                    'qty' => 1,
                    'unit_price' => 100,
                    'vat_rate' => 0,
                ],
            ],
            'payments' => [
                [
                    'method' => 'cash',
                    'amount' => 100,
                    'meta_json' => [
                        'cash_received' => 100,
                    ],
                ],
            ],
        ])->assertCreated();

        $sale = PosSale::query()->latest('id')->firstOrFail();
        $collection = Collection::query()->latest('id')->firstOrFail();

        $this->assertSame('b2b', $collection->source_system);
        $this->assertSame('pending', $collection->sync_status);
        $this->assertSame('GEL', $collection->currency);
        $this->assertSame('pos_sale', $collection->meta['source']);
        $this->assertSame($sessionId, $collection->meta['pos_session_id']);
        $this->assertSame($cashbox->id, $collection->meta['cashbox_id']);

        $this->assertDatabaseHas('ledger_entries', [
            'customer_id' => $customer->id,
            'type' => 'invoice',
            'currency' => 'GEL',
            'reference_no' => 'POS-EXPORT-001',
        ]);

        $this->assertDatabaseHas('ledger_entries', [
            'customer_id' => $customer->id,
            'type' => 'payment',
            'currency' => 'GEL',
            'reference_no' => 'POS-EXPORT-001',
        ]);

        $this->assertDatabaseHas('integration_sync_events', [
            'domain' => 'collections-write',
            'entity_type' => Collection::class,
            'entity_id' => $collection->id,
            'status' => 'queued',
        ]);

        $this->assertDatabaseHas('integration_sync_states', [
            'domain' => 'pos-sales',
            'entity_type' => PosSale::class,
            'entity_id' => $sale->id,
            'status' => 'queued',
        ]);

        config(['integrations.logo.collection_sync_key' => 'test-sync-key']);

        $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->getJson('/api/integrations/logo/collections/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('records.0.collection_id', $collection->id)
            ->assertJsonPath('records.0.cashbox_code', '100.01.002');

        config(['integrations.logo.pos_sale_sync_key' => 'test-pos-sale-key']);

        $this
            ->withHeader('X-Integration-Key', 'test-pos-sale-key')
            ->getJson('/api/integrations/logo/pos-sales/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('records.0.pos_sale_id', $sale->id)
            ->assertJsonPath('records.0.receipt_no', 'POS-EXPORT-001')
            ->assertJsonPath('records.0.currency', 'GEL')
            ->assertJsonPath('records.0.payments.0.currency', 'GEL')
            ->assertJsonPath('records.0.cashbox_code', '100.01.002')
            ->assertJsonPath('records.0.items.0.product_code', 'POS-TEST-001');
    }

    public function test_pos_delivery_creates_only_sales_dispatch_export_without_customer_ledger_or_collection(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-DELIVERY-'.Str::upper(Str::random(4)),
            'name' => 'Delivery Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);

        $cashbox = Cashbox::query()->create([
            'code' => '100.01.002',
            'name' => 'Ahmet Arac Kasasi',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'source_reference' => '120-25-002',
            'sync_status' => 'synced',
            'code' => '120-25-002',
            'name' => 'Logo Cari',
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'POS-DELIVERY-001',
                'name' => 'POS Delivery Product',
                'unit' => 'adet',
                'vat_rate' => 0,
                'is_active' => true,
            ]);
        });

        DB::table('stock_summary')->insert([
            'product_id' => $product->id,
            'available_total' => 5,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        $openResponse = $this->postJson('/api/pos/sessions/open', [
            'cashbox_id' => $cashbox->id,
            'opening_cash' => 0,
        ])->assertCreated();

        $this->postJson('/api/pos/sales', [
            'pos_session_id' => (int) $openResponse->json('data.id'),
            'customer_id' => $customer->id,
            'sale_type' => 'cash',
            'document_type' => 'delivery',
            'receipt_no' => 'POS-DELIVERY-ONLY-001',
            'items' => [
                [
                    'product_id' => $product->id,
                    'qty' => 1,
                    'unit_price' => 100,
                    'vat_rate' => 0,
                ],
            ],
            'payments' => [
                [
                    'method' => 'cash',
                    'amount' => 100,
                    'meta_json' => [
                        'cash_received' => 100,
                    ],
                ],
            ],
        ])->assertCreated();

        $sale = PosSale::query()->latest('id')->firstOrFail();

        $this->assertDatabaseMissing('ledger_entries', [
            'customer_id' => $customer->id,
            'reference_no' => 'POS-DELIVERY-ONLY-001',
        ]);

        $this->assertDatabaseMissing('collections', [
            'customer_id' => $customer->id,
            'reference_no' => 'POS-DELIVERY-ONLY-001',
        ]);

        $this->assertDatabaseMissing('integration_sync_events', [
            'domain' => 'collections-write',
            'entity_type' => Collection::class,
            'status' => 'queued',
        ]);

        $this->assertDatabaseHas('integration_sync_states', [
            'domain' => 'pos-sales',
            'entity_type' => PosSale::class,
            'entity_id' => $sale->id,
            'status' => 'queued',
        ]);

        config(['integrations.logo.pos_sale_sync_key' => 'test-pos-sale-key']);

        $this
            ->withHeader('X-Integration-Key', 'test-pos-sale-key')
            ->getJson('/api/integrations/logo/pos-sales/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('records.0.pos_sale_id', $sale->id)
            ->assertJsonPath('records.0.document_type', 'delivery')
            ->assertJsonPath('records.0.logo.document_target', 'sales_dispatch_note')
            ->assertJsonPath('records.0.logo.target_tables', ['STFICHE', 'STLINE']);
    }

    public function test_cash_and_card_pos_sales_do_not_add_vat_to_point_total(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-VAT-'.Str::upper(Str::random(4)),
            'name' => 'Point Vat Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);

        $cashbox = Cashbox::query()->create([
            'code' => 'POINT-'.$user->id,
            'name' => 'Erzurum Point Kasa',
            'is_active' => true,
        ]);

        $session = PosSession::query()->create([
            'cashbox_id' => $cashbox->id,
            'opened_by' => $user->id,
            'opened_at' => now(),
            'opening_cash' => 0,
            'status' => 'open',
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1001',
            'code' => 'POINT-NAKIT',
            'name' => 'Point Nakit Satış',
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'POS-NO-VAT-001',
                'name' => 'POS No Vat Product',
                'unit' => 'adet',
                'vat_rate' => 20,
                'is_active' => true,
            ]);
        });

        DB::table('stock_summary')->insert([
            'product_id' => $product->id,
            'available_total' => 5,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);

        $this->actingAs($user);

        foreach (['cash', 'card'] as $index => $saleType) {
            $this->postJson('/api/pos/sales', [
                'pos_session_id' => $session->id,
                'customer_id' => $customer->id,
                'sale_type' => $saleType,
                'document_type' => 'delivery',
                'receipt_no' => 'POS-NO-VAT-00'.($index + 1),
                'items' => [
                    [
                        'product_id' => $product->id,
                        'qty' => 1,
                        'unit_price' => 100,
                        'vat_rate' => 20,
                    ],
                ],
                'payments' => [
                    [
                        'method' => $saleType,
                        'amount' => 100,
                    ],
                ],
            ])
                ->assertCreated()
                ->assertJsonPath('data.subtotal', '100.00')
                ->assertJsonPath('data.vat_total', '0.00')
                ->assertJsonPath('data.grand_total', '100.00');
        }

        $this->assertDatabaseCount('pos_sales', 2);
        $this->assertDatabaseMissing('pos_sales', [
            'vat_total' => '20.00',
        ]);
    }

    public function test_pos_sale_can_be_created_when_stock_summary_is_missing(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POINT-'.Str::upper(Str::random(4)),
            'name' => 'Point Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);

        $cashbox = Cashbox::query()->create([
            'code' => '100.01.002',
            'name' => 'Ahmet Arac Kasasi',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'POINT-NAKIT',
            'name' => 'Point Nakit Cari',
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'POS-NOSTOCK-001',
                'name' => 'POS Missing Stock Product',
                'unit' => 'adet',
                'vat_rate' => 0,
                'is_active' => true,
            ]);
        });

        $this->actingAs($user);

        $openResponse = $this->postJson('/api/pos/sessions/open', [
            'cashbox_id' => $cashbox->id,
            'opening_cash' => 0,
        ])->assertCreated();

        $this->postJson('/api/pos/sales', [
            'pos_session_id' => (int) $openResponse->json('data.id'),
            'customer_id' => $customer->id,
            'sale_type' => 'cash',
            'document_type' => 'invoice',
            'items' => [
                [
                    'product_id' => $product->id,
                    'qty' => 1,
                    'unit_price' => 100,
                    'vat_rate' => 0,
                ],
            ],
            'payments' => [
                [
                    'method' => 'cash',
                    'amount' => 100,
                ],
            ],
        ])->assertCreated();

        $this->assertDatabaseHas('stock_summary', [
            'product_id' => $product->id,
            'available_total' => -1,
        ]);

        $sale = PosSale::query()->latest('id')->firstOrFail();

        $this->assertDatabaseHas('integration_sync_states', [
            'domain' => 'pos-sales',
            'entity_type' => PosSale::class,
            'entity_id' => $sale->id,
            'status' => 'queued',
        ]);

        config(['integrations.logo.pos_sale_sync_key' => 'test-pos-sale-key']);

        $this
            ->withHeader('X-Integration-Key', 'test-pos-sale-key')
            ->getJson('/api/integrations/logo/pos-sales/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('records.0.pos_sale_id', $sale->id)
            ->assertJsonPath('records.0.document_type', 'invoice');
    }

    public function test_logo_pos_sale_pending_payload_marks_delivery_as_sales_dispatch_note(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POS-LOGO-'.Str::upper(Str::random(4)),
            'name' => 'POS Logo Dealer',
            'is_active' => true,
        ]);
        $user = $this->createUserWithRole('point', $dealer);

        $cashbox = Cashbox::query()->create([
            'code' => 'POINT-'.$user->id,
            'name' => 'ERZURUM POINT KASASI',
            'is_active' => true,
        ]);

        $session = PosSession::query()->create([
            'cashbox_id' => $cashbox->id,
            'opened_by' => $user->id,
            'opened_at' => now(),
            'opening_cash' => 0,
            'status' => 'open',
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => '120-POS-LOGO',
            'name' => 'POS Logo Cari',
            'source_system' => 'logo',
            'source_reference' => '1001',
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'POS-DLV-001',
                'name' => 'POS Delivery Product',
                'unit' => 'adet',
                'vat_rate' => 20,
                'is_active' => true,
                'meta' => [
                    'integrations' => [
                        'logo' => [
                            'external_ref' => '2002',
                            'payload' => [
                                'unitset_ref' => 1,
                                'logo_price' => [
                                    'uomref' => 1,
                                ],
                            ],
                        ],
                    ],
                ],
            ]);
        });

        $sale = PosSale::query()->create([
            'pos_session_id' => $session->id,
            'customer_id' => $customer->id,
            'sale_type' => 'cash',
            'document_type' => 'delivery',
            'receipt_no' => 'POS-DLV-LOGO-001',
            'subtotal' => '100.00',
            'discount_total' => '0.00',
            'vat_total' => '20.00',
            'grand_total' => '120.00',
            'status' => 'paid',
            'created_by' => $user->id,
        ]);

        PosSaleItem::query()->create([
            'pos_sale_id' => $sale->id,
            'product_id' => $product->id,
            'qty' => '1.000',
            'unit_price' => '100.00',
            'vat_rate' => '20.00',
            'line_total' => '100.00',
        ]);

        PosPayment::query()->create([
            'pos_sale_id' => $sale->id,
            'method' => 'cash',
            'amount' => '120.00',
        ]);

        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'pos-sales',
            'direction' => 'outbound',
            'entity_type' => PosSale::class,
            'entity_id' => $sale->id,
            'status' => 'queued',
            'meta' => [
                'export_key' => 'B2B-POSSALE-'.$sale->id,
            ],
        ]);

        config(['integrations.logo.pos_sale_sync_key' => 'test-pos-sale-key']);

        $this
            ->withHeader('X-Integration-Key', 'test-pos-sale-key')
            ->getJson('/api/integrations/logo/pos-sales/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('records.0.pos_sale_id', $sale->id)
            ->assertJsonPath('records.0.document_type', 'delivery')
            ->assertJsonPath('records.0.logo.document_target', 'sales_dispatch_note')
            ->assertJsonPath('records.0.logo.trcode', 8)
            ->assertJsonPath('records.0.logo.target_tables', ['STFICHE', 'STLINE']);
    }

    public function test_editing_synced_delivery_note_queues_logo_stfiche_update_with_existing_reference(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-DLV-EDIT-'.Str::upper(Str::random(4)),
            'name' => 'Delivery Edit Dealer',
            'is_active' => true,
        ]);
        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill(['menu_permissions' => ['pos', 'delivery-notes']])->save();
        $cashbox = Cashbox::query()->create([
            'code' => 'POINT-'.$user->id,
            'name' => 'Erzurum Point Kasa',
            'is_active' => true,
        ]);
        $session = PosSession::query()->create([
            'cashbox_id' => $cashbox->id,
            'opened_by' => $user->id,
            'opened_at' => now(),
            'opening_cash' => 0,
            'status' => 'open',
        ]);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '1001',
            'code' => 'DLV-EDIT-CUST',
            'name' => 'Irsaliye Edit Cari',
            'is_active' => true,
        ]);
        $product = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'DLV-EDIT-001',
                'name' => 'Irsaliye Edit Urun',
                'unit' => 'ADET',
                'vat_rate' => 0,
                'is_active' => true,
                'meta' => ['integrations' => ['logo' => ['external_ref' => '501']]],
            ]);
        });
        DB::table('stock_summary')->insert([
            'product_id' => $product->id,
            'available_total' => 20,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);
        $sale = PosSale::query()->create([
            'pos_session_id' => $session->id,
            'customer_id' => $customer->id,
            'sale_type' => 'cash',
            'document_type' => 'delivery',
            'receipt_no' => 'IRS-EDIT-001',
            'subtotal' => '500.00',
            'discount_total' => '0.00',
            'vat_total' => '0.00',
            'grand_total' => '500.00',
            'status' => 'paid',
            'created_by' => $user->id,
        ]);
        $item = PosSaleItem::query()->create([
            'pos_sale_id' => $sale->id,
            'product_id' => $product->id,
            'qty' => '5.000',
            'unit_price' => '100.00',
            'vat_rate' => '0.00',
            'line_total' => '500.00',
        ]);
        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'pos-sales',
            'direction' => 'outbound',
            'entity_type' => PosSale::class,
            'entity_id' => $sale->id,
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'external_ref' => 'STFICHE-12345',
            'status' => 'synced',
            'last_synced_at' => now(),
            'meta' => ['export_key' => 'B2B-POSSALE-'.$sale->id],
        ]);

        $this->actingAs($user);

        $this->putJson("/api/pos/sales/{$sale->id}", [
            'receipt_no' => 'IRS-EDIT-001',
            'sale_type' => 'cash',
            'discount_total' => 0,
            'items' => [[
                'id' => $item->id,
                'qty' => 3,
                'unit_price' => 100,
                'vat_rate' => 0,
                'line_total' => 300,
            ]],
            'payments' => [[
                'method' => 'cash',
                'amount' => 300,
            ]],
        ])
            ->assertOk()
            ->assertJsonPath('data.logo_sync_status', 'queued')
            ->assertJsonPath('data.logo_external_ref', 'STFICHE-12345');

        $state = IntegrationSyncState::query()
            ->where('entity_type', PosSale::class)
            ->where('entity_id', $sale->id)
            ->firstOrFail();

        $this->assertSame('queued', $state->status);
        $this->assertSame('STFICHE-12345', $state->external_ref);
        $this->assertSame('update', data_get($state->meta, 'operation'));
        $this->assertSame('STFICHE-12345', data_get($state->meta, 'logo_external_ref'));

        config(['integrations.logo.pos_sale_sync_key' => 'test-pos-sale-key']);

        $this
            ->withHeader('X-Integration-Key', 'test-pos-sale-key')
            ->getJson('/api/integrations/logo/pos-sales/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('records.0.logo.operation', 'update')
            ->assertJsonPath('records.0.logo.existing_external_ref', 'STFICHE-12345')
            ->assertJsonPath('records.0.meta.operation', 'update')
            ->assertJsonPath('records.0.meta.logo_external_ref', 'STFICHE-12345');
    }

    public function test_deleting_current_month_synced_delivery_note_queues_logo_stfiche_delete(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-DLV-DEL-'.Str::upper(Str::random(4)),
            'name' => 'Delivery Delete Dealer',
            'is_active' => true,
        ]);
        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill(['menu_permissions' => ['pos', 'delivery-notes']])->save();

        [$sale, $product] = $this->createLogoSyncedDeliverySale($dealer, $user, [
            'receipt_no' => 'IRS-DELETE-001',
            'external_ref' => 'STFICHE-471',
            'qty' => '2.000',
        ]);

        DB::table('stock_summary')->where('product_id', $product->id)->update(['available_total' => 8]);

        $this->actingAs($user)
            ->deleteJson("/api/pos/sales/{$sale->id}")
            ->assertOk()
            ->assertJsonPath('message', 'İrsaliye belgesi silindi.');

        $this->assertDatabaseHas('pos_sales', [
            'id' => $sale->id,
            'status' => 'cancelled',
        ]);
        $this->assertSame(10, (int) DB::table('stock_summary')->where('product_id', $product->id)->value('available_total'));

        $state = IntegrationSyncState::query()
            ->where('entity_type', PosSale::class)
            ->where('entity_id', $sale->id)
            ->firstOrFail();

        $this->assertSame('queued', $state->status);
        $this->assertSame('STFICHE-471', $state->external_ref);
        $this->assertSame('delete', data_get($state->meta, 'operation'));
        $this->assertSame('STFICHE-471', data_get($state->meta, 'logo_external_ref'));

        $this->actingAs($user)
            ->getJson('/api/pos/sales?document_type=delivery&limit=10')
            ->assertOk()
            ->assertJsonMissing(['id' => $sale->id]);

        config(['integrations.logo.pos_sale_sync_key' => 'test-pos-sale-key']);

        $this
            ->withHeader('X-Integration-Key', 'test-pos-sale-key')
            ->getJson('/api/integrations/logo/pos-sales/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('records.0.pos_sale_id', $sale->id)
            ->assertJsonPath('records.0.logo.operation', 'delete')
            ->assertJsonPath('records.0.logo.existing_external_ref', 'STFICHE-471')
            ->assertJsonPath('records.0.meta.operation', 'delete')
            ->assertJsonPath('records.0.meta.logo_external_ref', 'STFICHE-471');
    }

    public function test_delivery_note_delete_is_blocked_outside_current_month(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-DLV-OLD-'.Str::upper(Str::random(4)),
            'name' => 'Old Delivery Dealer',
            'is_active' => true,
        ]);
        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill(['menu_permissions' => ['pos', 'delivery-notes']])->save();

        [$sale] = $this->createLogoSyncedDeliverySale($dealer, $user, [
            'receipt_no' => 'IRS-OLD-001',
            'created_at' => now()->startOfMonth()->subDay(),
        ]);

        $this->actingAs($user)
            ->deleteJson("/api/pos/sales/{$sale->id}")
            ->assertUnprocessable()
            ->assertJsonValidationErrors('sale');

        $this->assertDatabaseHas('pos_sales', [
            'id' => $sale->id,
            'status' => 'paid',
        ]);
    }

    public function test_cash_or_card_delivery_note_delete_is_blocked_after_day_end_save(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-DLV-CLOSED-'.Str::upper(Str::random(4)),
            'name' => 'Closed Day Delivery Dealer',
            'is_active' => true,
        ]);
        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill(['menu_permissions' => ['pos', 'delivery-notes']])->save();

        [$sale, , $session] = $this->createLogoSyncedDeliverySale($dealer, $user, [
            'receipt_no' => 'IRS-CLOSED-001',
            'sale_type' => 'card',
            'payment_method' => 'card',
            'customer_code' => '120-25-002',
            'customer_name' => 'ERZURUM POINT KREDI KARTI SATIS',
        ]);
        $session->forceFill([
            'status' => 'closed',
            'closed_at' => now(),
        ])->save();

        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'pos-day-ends',
            'direction' => 'outbound',
            'entity_type' => PosSession::class,
            'entity_id' => $session->id,
            'dealer_id' => $dealer->id,
            'status' => 'synced',
            'meta' => ['export_key' => 'B2B-POSDAYEND-'.$session->id.'-'.now()->toDateString()],
        ]);

        $this->actingAs($user)
            ->deleteJson("/api/pos/sales/{$sale->id}")
            ->assertUnprocessable()
            ->assertJsonValidationErrors('sale');

        $this->assertDatabaseHas('pos_sales', [
            'id' => $sale->id,
            'status' => 'paid',
        ]);
    }

    public function test_normal_customer_delivery_note_can_be_deleted_after_day_end_save(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-DLV-NORMAL-'.Str::upper(Str::random(4)),
            'name' => 'Normal Delivery Dealer',
            'is_active' => true,
        ]);
        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill(['menu_permissions' => ['pos', 'delivery-notes']])->save();

        [$sale, , $session] = $this->createLogoSyncedDeliverySale($dealer, $user, [
            'receipt_no' => 'IRS-NORMAL-001',
            'sale_type' => 'card',
            'payment_method' => 'card',
            'customer_code' => '120-00-321',
            'customer_name' => 'AK PETROL ISMAIL AK',
            'external_ref' => 'STFICHE-448',
        ]);
        $session->forceFill([
            'status' => 'closed',
            'closed_at' => now(),
        ])->save();

        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'pos-day-ends',
            'direction' => 'outbound',
            'entity_type' => PosSession::class,
            'entity_id' => $session->id,
            'dealer_id' => $dealer->id,
            'status' => 'synced',
            'meta' => ['export_key' => 'B2B-POSDAYEND-'.$session->id.'-'.now()->toDateString()],
        ]);

        $this->actingAs($user)
            ->deleteJson("/api/pos/sales/{$sale->id}")
            ->assertOk();

        $this->assertDatabaseHas('pos_sales', [
            'id' => $sale->id,
            'status' => 'cancelled',
        ]);
        $this->assertDatabaseHas('integration_sync_states', [
            'domain' => 'pos-sales',
            'entity_type' => PosSale::class,
            'entity_id' => $sale->id,
            'status' => 'queued',
            'external_ref' => 'STFICHE-448',
        ]);
    }

    public function test_customer_collections_can_be_filtered_by_method_and_invoice_entries(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-COL-'.Str::upper(Str::random(4)),
            'name' => 'Collection Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'CR-'.Str::upper(Str::random(5)),
            'name' => 'Filtre Cari',
            'is_active' => true,
        ]);

        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'date' => '2026-06-01',
            'collection_date' => '2026-06-01',
            'method' => 'cash',
            'amount' => 100,
            'currency' => 'TRY',
            'note' => 'Nakit tahsilat',
        ]);

        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'date' => '2026-06-02',
            'collection_date' => '2026-06-02',
            'method' => 'cc',
            'amount' => 75,
            'currency' => 'TRY',
            'reference_fields' => [
                'collection_channel' => 'factory',
            ],
            'note' => 'Fabrika kart çekimi',
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'date' => '2026-06-02',
            'entry_date' => '2026-06-02',
            'type' => 'invoice',
            'entry_type' => 'debit',
            'debit' => 250,
            'amount' => 250,
            'currency' => 'TRY',
            'reference_no' => 'INV-001',
            'description' => 'Fatura hareketi',
        ]);

        $this->actingAs($user);

        $this->getJson("/api/customers/{$customer->id}/collections?method=cash")
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.method', 'cash')
            ->assertJsonPath('data.0.amount', '100.00')
            ->assertJsonFragment([
                'method' => 'cash',
                'count' => 1,
                'total_amount' => '100.00',
            ]);

        $this->getJson("/api/customers/{$customer->id}/collections?method=factory_cc")
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.method', 'cc')
            ->assertJsonPath('data.0.reference_fields.collection_channel', 'factory')
            ->assertJsonFragment([
                'method' => 'factory_cc',
                'count' => 1,
                'total_amount' => '75.00',
            ]);

        $this->getJson("/api/customers/{$customer->id}/collections?method=invoice")
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.record_type', 'invoice')
            ->assertJsonPath('data.0.method', 'invoice')
            ->assertJsonPath('data.0.amount', '250.00')
            ->assertJsonFragment([
                'method' => 'invoice',
                'count' => 1,
                'total_amount' => '250.00',
            ]);

        $this->getJson("/api/customers/{$customer->id}/collections")
            ->assertOk()
            ->assertJsonCount(2, 'data');
    }

    public function test_customer_collections_response_includes_compact_logo_sync_summary(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-COL-SUM-'.Str::upper(Str::random(4)),
            'name' => 'Collection Summary Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'CR-SUM-'.Str::upper(Str::random(5)),
            'name' => 'Tahsilat Ozet Cari',
            'is_active' => true,
        ]);

        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'date' => '2026-06-01',
            'collection_date' => '2026-06-01',
            'method' => 'cash',
            'amount' => 100,
            'currency' => 'TRY',
        ]);

        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'synced',
            'last_synced_at' => '2026-06-22 21:45:00',
            'date' => '2026-06-02',
            'collection_date' => '2026-06-02',
            'method' => 'transfer',
            'amount' => 250,
            'currency' => 'TRY',
        ]);

        $this->actingAs($user);

        DB::flushQueryLog();
        DB::enableQueryLog();

        $this->getJson("/api/customers/{$customer->id}/collections")
            ->assertOk()
            ->assertJsonPath('logo_sync.pending', 1)
            ->assertJsonPath('logo_sync.synced', 1)
            ->assertJsonPath('logo_sync.latest_synced_at', '2026-06-22T21:45:00.000000Z');

        DB::disableQueryLog();

        $collectionQueries = collect(DB::getQueryLog())
            ->filter(fn (array $query): bool => str_contains((string) $query['query'], 'collections'))
            ->count();

        $this->assertLessThanOrEqual(5, $collectionQueries);
    }

    public function test_customer_collections_can_skip_heavy_summaries_for_fast_screen_refreshes(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-COL-FAST-'.Str::upper(Str::random(4)),
            'name' => 'Collection Fast Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'CR-FAST-'.Str::upper(Str::random(5)),
            'name' => 'Hizli Tahsilat Cari',
            'is_active' => true,
        ]);

        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'date' => '2026-07-27',
            'collection_date' => '2026-07-27',
            'method' => 'cash',
            'amount' => 100,
            'currency' => 'TRY',
        ]);

        $this->actingAs($user);

        DB::flushQueryLog();
        DB::enableQueryLog();

        $this->getJson("/api/customers/{$customer->id}/collections?include_summary=0")
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonCount(0, 'tabs')
            ->assertJsonPath('logo_sync', []);

        DB::disableQueryLog();

        $collectionQueries = collect(DB::getQueryLog())
            ->filter(fn (array $query): bool => str_contains((string) $query['query'], 'collections'))
            ->count();

        $this->assertLessThanOrEqual(2, $collectionQueries);
    }

    public function test_point_user_can_update_and_delete_draft_customer_collections(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-COL-EDIT-'.Str::upper(Str::random(4)),
            'name' => 'Collection Edit Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'EDIT-COL-'.Str::upper(Str::random(4)),
            'name' => 'Edit Collection Customer',
            'is_active' => true,
        ]);

        $collection = Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'draft',
            'date' => '2026-06-01',
            'collection_date' => '2026-06-01',
            'method' => 'cash',
            'amount' => 100,
            'currency' => 'TRY',
            'note' => 'Eski not',
        ]);

        $this->actingAs($user);

        $this->patchJson("/api/customers/{$customer->id}/collections/{$collection->id}", [
            'method' => 'transfer',
            'amount' => 125.50,
            'currency' => 'TRY',
            'date' => '2026-06-05',
            'note' => 'Güncel not',
            'reference_fields' => [
                'bank_code' => 'yapi_kredi',
            ],
        ])
            ->assertOk()
            ->assertJsonPath('collection.method', 'transfer')
            ->assertJsonPath('collection.amount', '125.50')
            ->assertJsonPath('collection.note', 'Edit Collection Customer');

        $this->assertDatabaseHas('collections', [
            'id' => $collection->id,
            'method' => 'transfer',
            'amount' => '125.50',
            'note' => 'Edit Collection Customer',
        ]);

        $this->deleteJson("/api/customers/{$customer->id}/collections/{$collection->id}")
            ->assertNoContent();

        $this->assertDatabaseMissing('collections', [
            'id' => $collection->id,
        ]);
    }

    public function test_point_user_can_update_and_delete_synced_b2b_customer_collections(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-COL-SYNC-'.Str::upper(Str::random(4)),
            'name' => 'Collection Synced Edit Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'SYNC-COL-'.Str::upper(Str::random(4)),
            'name' => 'Synced Collection Customer',
            'is_active' => true,
        ]);

        $collection = Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'sync_status' => 'synced',
            'last_synced_at' => now(),
            'date' => '2026-06-01',
            'collection_date' => '2026-06-01',
            'method' => 'cash',
            'amount' => 588.24,
            'currency' => 'GEL',
            'note' => 'Gönderilmiş not',
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'collection_id' => $collection->id,
            'date' => '2026-06-01',
            'entry_date' => '2026-06-01',
            'type' => 'payment',
            'entry_type' => 'credit',
            'credit' => 588.24,
            'amount' => 588.24,
            'currency' => 'GEL',
            'description' => 'Gönderilmiş not',
        ]);

        $this->actingAs($user);

        $this->patchJson("/api/customers/{$customer->id}/collections/{$collection->id}", [
            'method' => 'cash',
            'amount' => 169.51,
            'currency' => 'GEL',
            'date' => '2026-06-09',
            'note' => 'Düzeltilmiş tahsilat',
        ])
            ->assertOk()
            ->assertJsonPath('collection.sync_status', 'draft')
            ->assertJsonPath('collection.amount', '169.51')
            ->assertJsonPath('collection.note', 'Synced Collection Customer NAKİT');

        $this->assertDatabaseHas('collections', [
            'id' => $collection->id,
            'sync_status' => 'draft',
            'amount' => '169.51',
            'note' => 'Synced Collection Customer NAKİT',
        ]);

        $this->assertDatabaseHas('ledger_entries', [
            'collection_id' => $collection->id,
            'credit' => '169.51',
            'amount' => '169.51',
            'description' => 'Synced Collection Customer NAKİT',
        ]);

        $this->deleteJson("/api/customers/{$customer->id}/collections/{$collection->id}")
            ->assertNoContent();

        $this->assertDatabaseMissing('collections', [
            'id' => $collection->id,
        ]);
        $this->assertDatabaseMissing('ledger_entries', [
            'collection_id' => $collection->id,
        ]);
    }

    public function test_batum_customer_collections_display_try_amounts_as_lari(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-BATUM-COL-'.Str::upper(Str::random(4)),
            'name' => 'Batum Collection Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'branch_code' => 'BATUM',
            'region_code' => 'BATUM',
        ])->save();

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => 'BATUM-COL-'.Str::upper(Str::random(4)),
            'name' => 'Batum Tahsilat Cari',
            'is_active' => true,
        ]);

        Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'date' => '2026-06-01',
            'collection_date' => '2026-06-01',
            'method' => 'cash',
            'amount' => 170,
            'currency' => 'TRY',
        ]);

        LedgerEntry::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'date' => '2026-06-02',
            'entry_date' => '2026-06-02',
            'type' => 'invoice',
            'entry_type' => 'debit',
            'debit' => 340,
            'amount' => 340,
            'currency' => 'TRY',
        ]);

        $this->actingAs($user);

        $this->getJson("/api/customers/{$customer->id}/collections?method=cash")
            ->assertOk()
            ->assertJsonPath('data.0.amount', '10.00')
            ->assertJsonPath('data.0.currency', 'GEL')
            ->assertJsonFragment([
                'method' => 'cash',
                'count' => 1,
                'total_amount' => '10.00',
            ]);

        $this->getJson("/api/customers/{$customer->id}/collections?method=invoice")
            ->assertOk()
            ->assertJsonPath('data.0.amount', '20.00')
            ->assertJsonPath('data.0.currency', 'GEL')
            ->assertJsonFragment([
                'method' => 'invoice',
                'count' => 1,
                'total_amount' => '20.00',
            ]);
    }

    public function test_batum_branch_point_user_can_collect_batum_city_customer(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-BATUM-AUTH-'.Str::upper(Str::random(4)),
            'name' => 'Batum Auth Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'customer_scope' => 'branch',
            'branch_code' => 'BATUM',
            'region_code' => 'BATUM',
        ])->save();

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => '120-00-002',
            'name' => 'Batum Perakende Kredi Karti Satis',
            'city' => 'BATUMI',
            'district' => 'BATUMI',
            'source_system' => 'logo',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->postJson("/api/customers/{$customer->id}/collections", [
            'method' => 'cash',
            'amount' => 10,
            'currency' => 'GEL',
            'date' => '2026-06-05',
        ])
            ->assertCreated()
            ->assertJsonPath('collection.method', 'cash')
            ->assertJsonPath('collection.amount', '10.00');
    }

    public function test_batum_user_can_select_active_batum_bank_for_pos_and_transfer_collections(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-BATUM-POS-'.Str::upper(Str::random(4)),
            'name' => 'Batum Pos Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);
        $user->forceFill([
            'customer_scope' => 'branch',
            'branch_code' => 'BATUM',
            'region_code' => 'BATUM',
        ])->save();

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => '120-00-003',
            'name' => 'Batum Depo Siparis',
            'city' => 'BATUMI',
            'district' => 'BATUMI',
            'source_system' => 'logo',
            'is_active' => true,
        ]);

        FinanceDefinition::query()->updateOrCreate(
            ['type' => 'bank', 'code' => 'tbc_bank'],
            [
                'name' => 'GEORGIA TBC BANK GEL BATUM',
                'logo_code' => '04',
                'logo_name' => 'GEORGIA TBC BANK GEL BATUM',
                'is_active' => true,
            ]
        );

        $this->actingAs($user);

        $this->postJson("/api/customers/{$customer->id}/collections", [
            'method' => 'cc',
            'amount' => 25,
            'currency' => 'GEL',
            'date' => '2026-06-09',
            'reference_fields' => [
                'pos_bank' => 'tbc_bank',
                'pos_payment_type' => 'pesin',
            ],
        ])
            ->assertCreated()
            ->assertJsonPath('collection.method', 'cc')
            ->assertJsonPath('collection.reference_fields.pos_bank', 'tbc_bank')
            ->assertJsonPath('collection.reference_fields.bank_logo_code', '04');

        $this->postJson("/api/customers/{$customer->id}/collections", [
            'method' => 'transfer',
            'amount' => 30,
            'currency' => 'GEL',
            'date' => '2026-06-09',
            'reference_fields' => [
                'bank_code' => '04',
            ],
        ])
            ->assertCreated()
            ->assertJsonPath('collection.method', 'transfer')
            ->assertJsonPath('collection.reference_fields.bank_code', 'tbc_bank')
            ->assertJsonPath('collection.reference_fields.bank_logo_code', '04');
    }

    public function test_non_admin_expense_history_is_isolated_by_creator_while_admin_can_see_all(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-EXP-SCOPE-'.Str::upper(Str::random(4)),
            'name' => 'Expense Scope Dealer',
            'is_active' => true,
        ]);

        $firstUser = $this->createUserWithRole('point', $dealer);
        $firstUser->forceFill(['menu_permissions' => ['pos-expenses']])->save();
        $secondUser = $this->createUserWithRole('point', $dealer);

        $cashbox = Cashbox::query()->create([
            'code' => 'EXP-SCOPE-'.$dealer->id,
            'name' => 'Expense Scope Cashbox',
            'is_active' => true,
        ]);
        $session = PosSession::query()->create([
            'cashbox_id' => $cashbox->id,
            'opened_by' => $firstUser->id,
            'opened_at' => now()->subHour(),
            'opening_cash' => 0,
            'status' => 'open',
        ]);

        $ownExpense = PosExpense::query()->create([
            'pos_session_id' => $session->id,
            'dealer_id' => $dealer->id,
            'expense_date' => now()->toDateString(),
            'category' => 'own-expense',
            'amount' => 10,
            'currency' => 'TRY',
            'created_by_user_id' => $firstUser->id,
        ]);
        $otherExpense = PosExpense::query()->create([
            'pos_session_id' => $session->id,
            'dealer_id' => $dealer->id,
            'expense_date' => now()->toDateString(),
            'category' => 'other-expense',
            'amount' => 20,
            'currency' => 'TRY',
            'created_by_user_id' => $secondUser->id,
        ]);

        $this->actingAs($firstUser)
            ->getJson('/api/pos/expenses?limit=50')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $ownExpense->id)
            ->assertJsonMissing(['id' => $otherExpense->id]);

        $admin = $this->createUserWithRole('admin');

        $this->actingAs($admin)
            ->getJson('/api/pos/expenses?limit=50')
            ->assertOk()
            ->assertJsonFragment(['id' => $ownExpense->id])
            ->assertJsonFragment(['id' => $otherExpense->id]);
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

    /**
     * @param  array<string, mixed>  $overrides
     * @return array{0:PosSale,1:Product,2:PosSession}
     */
    private function createLogoSyncedDeliverySale(Dealer $dealer, User $user, array $overrides = []): array
    {
        $cashbox = Cashbox::query()->create([
            'code' => 'POINT-DELETE-'.$user->id.'-'.Str::upper(Str::random(3)),
            'name' => 'Point Delete Kasa',
            'is_active' => true,
        ]);
        $session = PosSession::query()->create([
            'cashbox_id' => $cashbox->id,
            'opened_by' => $user->id,
            'opened_at' => now(),
            'opening_cash' => 0,
            'status' => 'open',
        ]);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => (string) random_int(1000, 9999),
            'code' => (string) ($overrides['customer_code'] ?? 'DLV-DEL-CUST-'.Str::upper(Str::random(3))),
            'name' => (string) ($overrides['customer_name'] ?? 'Irsaliye Silme Cari'),
            'is_active' => true,
        ]);
        $product = Product::withoutEvents(function (): Product {
            return Product::query()->create([
                'sku' => 'DLV-DEL-'.Str::upper(Str::random(5)),
                'name' => 'Irsaliye Silme Urun',
                'unit' => 'ADET',
                'vat_rate' => 0,
                'is_active' => true,
                'meta' => ['integrations' => ['logo' => ['external_ref' => '501']]],
            ]);
        });
        DB::table('stock_summary')->insert([
            'product_id' => $product->id,
            'available_total' => 20,
            'reserved_total' => 0,
            'updated_at' => now(),
        ]);

        $createdAt = $overrides['created_at'] ?? now();
        $saleType = (string) ($overrides['sale_type'] ?? 'cash');
        $sale = PosSale::query()->create([
            'pos_session_id' => $session->id,
            'customer_id' => $customer->id,
            'sale_type' => $saleType,
            'document_type' => 'delivery',
            'receipt_no' => (string) ($overrides['receipt_no'] ?? 'IRS-DELETE-'.Str::upper(Str::random(5))),
            'subtotal' => '100.00',
            'discount_total' => '0.00',
            'vat_total' => '0.00',
            'grand_total' => '100.00',
            'status' => 'paid',
            'created_by' => $user->id,
        ]);
        $sale->forceFill([
            'created_at' => $createdAt,
            'updated_at' => $createdAt,
        ])->save();
        PosSaleItem::query()->create([
            'pos_sale_id' => $sale->id,
            'product_id' => $product->id,
            'qty' => (string) ($overrides['qty'] ?? '1.000'),
            'unit_price' => '100.00',
            'vat_rate' => '0.00',
            'line_total' => '100.00',
        ]);
        PosPayment::query()->create([
            'pos_sale_id' => $sale->id,
            'method' => (string) ($overrides['payment_method'] ?? $saleType),
            'amount' => '100.00',
        ]);

        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'pos-sales',
            'direction' => 'outbound',
            'entity_type' => PosSale::class,
            'entity_id' => $sale->id,
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'external_ref' => (string) ($overrides['external_ref'] ?? 'STFICHE-12345'),
            'status' => 'synced',
            'last_synced_at' => now(),
            'meta' => ['export_key' => 'B2B-POSSALE-'.$sale->id],
        ]);

        return [$sale, $product, $session];
    }
}
