<?php

namespace Tests\Feature;

use App\Models\Cashbox;
use App\Models\Collection;
use App\Models\Customer;
use App\Models\Dealer;
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

        $this->postJson('/api/pos/expenses', [
            'pos_session_id' => $sessionId,
            'amount' => 125.50,
            'category' => 'Kargo',
            'note' => 'Acil sevkiyat',
        ])
            ->assertCreated()
            ->assertJsonPath('data.category', 'Kargo')
            ->assertJsonPath('data.amount', '125.50')
            ->assertJsonPath('data.currency', 'TRY');

        $this->getJson('/api/pos/reports/day-end?pos_session_id='.$sessionId)
            ->assertOk()
            ->assertJsonPath('data.summary.expense_count', 1)
            ->assertJsonPath('data.summary.expense_total', '125.50')
            ->assertJsonPath('data.summary.expected_cash', '374.50')
            ->assertJsonPath('data.expenses.by_category.0.category', 'Kargo');

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
            ->assertJsonPath('records.0.category', 'Kargo')
            ->assertJsonPath('records.0.amount', '125.50')
            ->assertJsonPath('records.0.currency', 'TRY')
            ->assertJsonPath('records.0.cashbox_code', $cashbox->code);
    }

    public function test_batum_point_user_records_pos_expense_in_gel(): void
    {
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

        $this->postJson('/api/pos/expenses', [
            'pos_session_id' => $sessionId,
            'amount' => 25,
            'category' => 'Masraf',
            'note' => 'Batum masraf',
        ])
            ->assertCreated()
            ->assertJsonPath('data.currency', 'GEL');
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

        $this->postJson('/api/pos/expenses', [
            'pos_session_id' => $sessionId,
            'amount' => 45,
            'category' => 'Depo',
            'note' => 'Depo masrafı',
        ])
            ->assertCreated()
            ->assertJsonPath('data.category', 'Depo')
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
                        'unit_price' => $salePayload['amount'],
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
            ->assertJsonCount(1, 'data.report_tables.cash_collections')
            ->assertJsonPath('data.report_tables.cash_collections.0.customer_name', 'Tahsilat Cari')
            ->assertJsonPath('data.report_tables.cash_collections.0.amount', '50.00')
            ->assertJsonCount(0, 'data.report_tables.card_collections')
            ->assertJsonPath('data.totals_by_method.0.method', 'cash')
            ->assertJsonPath('data.totals_by_method.0.total_amount', '150.00')
            ->assertJsonPath('data.totals_by_method.1.method', 'card')
            ->assertJsonPath('data.totals_by_method.1.total_amount', '200.00');
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

    public function test_pos_sale_payment_for_exported_customer_is_marked_pending_for_logo_export_with_cashbox(): void
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
            'document_type' => 'delivery',
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

    public function test_batum_or_georgian_bank_cannot_be_selected_for_physical_pos_collection(): void
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
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['reference_fields.pos_bank']);
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
