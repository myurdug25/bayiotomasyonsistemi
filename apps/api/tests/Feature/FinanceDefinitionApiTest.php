<?php

namespace Tests\Feature;

use App\Models\Cashbox;
use App\Models\Dealer;
use App\Models\FinanceDefinition;
use App\Models\IntegrationSyncState;
use App\Models\PosExpense;
use App\Models\PosSession;
use App\Models\Role;
use App\Models\User;
use App\Services\Orders\ShippingChargeService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class FinanceDefinitionApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_shipping_rules_keep_bus_fee_and_cargo_threshold_independent(): void
    {
        FinanceDefinition::query()->updateOrCreate(
            ['type' => 'shipping_rule', 'code' => 'cargo_limit'],
            ['name' => 'Kargo Ücretsiz Limiti', 'logo_code' => '2500.00', 'sort_order' => 10, 'is_active' => true],
        );
        FinanceDefinition::query()->updateOrCreate(
            ['type' => 'shipping_rule', 'code' => 'cargo_fee'],
            ['name' => 'Kargo Ücreti', 'logo_code' => '175.00', 'sort_order' => 20, 'is_active' => true],
        );
        FinanceDefinition::query()->updateOrCreate(
            ['type' => 'shipping_rule', 'code' => 'bus_fee'],
            ['name' => 'Otobüs Ücreti', 'logo_code' => '90.00', 'sort_order' => 30, 'is_active' => true],
        );

        $service = app(ShippingChargeService::class);

        $this->assertSame(90.0, $service->resolve('otobus', 100)['amount']);
        $this->assertSame(90.0, $service->resolve('otobus', 100000)['amount']);
        $this->assertSame(175.0, $service->resolve('kargo', 2499.99)['amount']);
        $this->assertSame(0.0, $service->resolve('kargo', 2500)['amount']);
        $this->assertSame(0.0, $service->resolve('kargo', 100, true)['amount']);
    }

    public function test_logo_integration_can_list_and_update_factory_account_names(): void
    {
        config()->set('integrations.logo.product_sync_key', 'finance-test-key');

        $this->getJson('/api/integrations/logo/finance-definitions/pending')
            ->assertUnauthorized();

        $this->withHeader('X-Integration-Key', 'finance-test-key')
            ->getJson('/api/integrations/logo/finance-definitions/pending')
            ->assertOk()
            ->assertJsonPath('received', 11)
            ->assertJsonPath('records.0.code', '120-61-006');

        $this->withHeader('X-Integration-Key', 'finance-test-key')
            ->postJson('/api/integrations/logo/finance-definitions/sync', [
                'records' => [[
                    'type' => 'factory',
                    'code' => '320-54-002',
                    'name' => 'FABRİKA POS HESABI',
                    'source_table' => 'dbo.LG_003_CLCARD',
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('received', 1)
            ->assertJsonPath('updated', 1)
            ->assertJsonPath('skipped', 0);

        $definition = FinanceDefinition::query()
            ->where('type', 'factory')
            ->where('code', '320-54-002')
            ->firstOrFail();

        $this->assertSame('DİNAMİK OTOMOTİV GID.TEKS.İTH.İHR.SANAYİ VE TİC.LTD.ŞTİ', $definition->name);
        $this->assertSame('DİNAMİK OTOMOTİV GID.TEKS.İTH.İHR.SANAYİ VE TİC.LTD.ŞTİ', $definition->logo_name);
        $this->assertSame(
            'dbo.LG_003_CLCARD',
            data_get($definition->meta, 'integrations.logo.source_table'),
        );

        $this->withHeader('X-Integration-Key', 'finance-test-key')
            ->postJson('/api/integrations/logo/finance-definitions/sync', [
                'records' => [
                    ['type' => 'bank', 'code' => '01', 'logo_code' => '01', 'name' => 'Ziraat Bankası', 'source_table' => 'dbo.LG_003_BNCARD'],
                    ['type' => 'bank', 'code' => '02', 'logo_code' => '02', 'name' => 'Yapı Kredi', 'source_table' => 'dbo.LG_003_BNCARD'],
                    [
                        'type' => 'bank',
                        'code' => '10',
                        'logo_code' => '10',
                        'name' => 'Türkiye İş Bankası',
                        'source_table' => 'dbo.LG_003_BNCARD',
                        'balance' => 3750,
                        'balance_debit' => 5000,
                        'balance_credit' => 1250,
                        'balance_direction' => 'debit',
                        'currency' => 'TRY',
                    ],
                    [
                        'type' => 'cashbox',
                        'code' => 'KASA-01',
                        'logo_code' => 'KASA-01',
                        'name' => 'Erzurum Kasa',
                        'source_table' => 'dbo.LG_003_KSCARD',
                        'balance' => -210.50,
                        'balance_debit' => 100,
                        'balance_credit' => 310.50,
                        'currency' => 'TRY',
                    ],
                ],
                'full_snapshot_types' => ['bank', 'cashbox'],
            ])
            ->assertOk()
            ->assertJsonPath('created', 2)
            ->assertJsonPath('deactivated', 2);

        $this->assertDatabaseHas('finance_definitions', [
            'type' => 'bank',
            'code' => '10',
            'name' => 'Türkiye İş Bankası',
            'is_active' => true,
        ]);
        $bankDefinition = FinanceDefinition::query()
            ->where('type', 'bank')
            ->where('code', '10')
            ->firstOrFail();
        $this->assertSame('3750.00', data_get($bankDefinition->meta, 'integrations.logo.financials.balance'));
        $this->assertSame('5000.00', data_get($bankDefinition->meta, 'integrations.logo.financials.debit'));
        $this->assertSame('1250.00', data_get($bankDefinition->meta, 'integrations.logo.financials.credit'));
        $this->assertSame('debit', data_get($bankDefinition->meta, 'integrations.logo.financials.direction'));
        $this->assertSame('TRY', data_get($bankDefinition->meta, 'integrations.logo.financials.currency'));

        $cashboxDefinition = FinanceDefinition::query()
            ->where('type', 'cashbox')
            ->where('code', 'KASA-01')
            ->firstOrFail();
        $this->assertSame('-210.50', data_get($cashboxDefinition->meta, 'integrations.logo.financials.balance'));
        $this->assertSame('credit', data_get($cashboxDefinition->meta, 'integrations.logo.financials.direction'));
        $this->assertDatabaseHas('finance_definitions', [
            'type' => 'bank',
            'code' => 'georgia_bank',
            'is_active' => false,
        ]);
    }

    public function test_collection_user_can_list_active_definitions_and_admin_can_manage_them(): void
    {
        $salesperson = User::factory()->create(['is_active' => true]);
        $salesperson->roles()->sync([
            Role::query()->firstOrCreate(['slug' => 'salesperson'], ['name' => 'Plasiyer'])->id,
        ]);

        $this->actingAs($salesperson)
            ->getJson('/api/finance-definitions?type=bank')
            ->assertOk()
            ->assertJsonCount(2, 'data')
            ->assertJsonPath('data.0.logo_code', '01');

        $admin = User::factory()->create(['is_active' => true]);
        $admin->roles()->sync([
            Role::query()->firstOrCreate(['slug' => 'admin'], ['name' => 'Admin'])->id,
        ]);

        $created = $this->actingAs($admin)
            ->postJson('/api/admin/finance-definitions', [
                'type' => 'expense_category',
                'code' => 'meal',
                'name' => 'Yemek',
                'logo_code' => '760-25-099',
                'logo_name' => 'YEMEK GİDERİ',
                'sort_order' => 40,
                'is_active' => true,
            ])
            ->assertCreated()
            ->assertJsonPath('data.code', 'meal');

        $this->patchJson('/api/admin/finance-definitions/'.$created->json('data.id'), [
            'type' => 'expense_category',
            'code' => 'meal',
            'name' => 'Yemek',
            'logo_code' => '760-25-099',
            'logo_name' => 'YEMEK GİDERİ',
            'sort_order' => 40,
            'is_active' => false,
        ])
            ->assertOk()
            ->assertJsonPath('data.is_active', false);
    }

    public function test_expense_cards_are_isolated_by_authenticated_user_scope(): void
    {
        $batumExpense = FinanceDefinition::query()->create([
            'type' => 'expense_category',
            'code' => 'batum_770_00_013',
            'name' => 'KİRA GİDERİ BATUM',
            'logo_code' => '770-00-013',
            'logo_name' => 'KİRA GİDERİ BATUM',
            'meta' => ['scope' => 'batum'],
            'sort_order' => 100,
            'is_active' => true,
        ]);

        $salesperson = User::factory()->create([
            'name' => 'Ahmet Araç',
            'branch_code' => 'ERZURUM',
            'branch_name' => 'Erzurum',
            'is_active' => true,
        ]);
        $salesperson->roles()->sync([
            Role::query()->firstOrCreate(['slug' => 'salesperson'], ['name' => 'Plasiyer'])->id,
        ]);

        $this->actingAs($salesperson)
            ->getJson('/api/finance-definitions?type=expense_category')
            ->assertOk()
            ->assertJsonCount(3, 'data')
            ->assertJsonMissing(['id' => $batumExpense->id])
            ->assertJsonPath('data.0.code', 'vehicle_maintenance')
            ->assertJsonPath('data.1.code', 'marketing')
            ->assertJsonPath('data.2.code', 'fuel');

        $batumUser = User::factory()->create([
            'name' => 'Batum Hızlı Satış',
            'branch_code' => 'BATUM',
            'branch_name' => 'Batum',
            'is_active' => true,
        ]);
        $batumUser->roles()->sync([
            Role::query()->firstOrCreate(['slug' => 'point'], ['name' => 'Point'])->id,
        ]);

        $this->actingAs($batumUser)
            ->getJson('/api/finance-definitions?type=expense_category')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $batumExpense->id)
            ->assertJsonMissing(['code' => 'fuel']);

        $admin = User::factory()->create(['is_active' => true]);
        $admin->roles()->sync([
            Role::query()->firstOrCreate(['slug' => 'admin'], ['name' => 'Admin'])->id,
        ]);

        $this->actingAs($admin)
            ->getJson('/api/finance-definitions?type=expense_category')
            ->assertOk()
            ->assertJsonCount(4, 'data')
            ->assertJsonFragment(['id' => $batumExpense->id])
            ->assertJsonFragment(['code' => 'fuel']);
    }

    public function test_cart_users_can_read_shipping_rules_without_collection_permissions(): void
    {
        foreach (['customer', 'warehouse'] as $roleSlug) {
            $user = User::factory()->create([
                'is_active' => true,
                'menu_permissions' => ['cart'],
            ]);
            $user->roles()->sync([
                Role::query()->firstOrCreate(
                    ['slug' => $roleSlug],
                    ['name' => ucfirst($roleSlug)]
                )->id,
            ]);

            $this->actingAs($user)
                ->getJson('/api/finance-definitions?type=shipping_rule')
                ->assertOk()
                ->assertJsonStructure(['data']);
        }
    }

    public function test_salesperson_can_create_own_expense_without_pos_session(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-EXP',
            'name' => 'Expense Dealer',
            'is_active' => true,
        ]);
        $salesperson = User::factory()->create([
            'dealer_id' => $dealer->id,
            'name' => 'Ahmet Araç',
            'logo_cashbox_code' => '100.01.002',
            'logo_cashbox_name' => 'AHMET ARAÇ KASASI',
            'logo_expense_account_code' => '760.25.000',
            'logo_expense_account_name' => 'PLASİYER GENEL GİDER HESABI',
            'is_active' => true,
        ]);
        $salesperson->roles()->sync([
            Role::query()->firstOrCreate(['slug' => 'salesperson'], ['name' => 'Plasiyer'])->id,
        ]);

        $categoryId = FinanceDefinition::query()
            ->where('type', 'expense_category')
            ->where('code', 'fuel')
            ->value('id');

        $this->actingAs($salesperson)
            ->postJson('/api/pos/expenses', [
                'finance_definition_id' => $categoryId,
                'category' => 'fuel',
                'amount' => 750,
                'note' => 'Mazot',
            ])
            ->assertCreated()
            ->assertJsonPath('data.category', 'Yakıt')
            ->assertJsonPath('data.pos_session_id', null);

        $expense = PosExpense::query()->firstOrFail();
        $this->assertSame($salesperson->id, $expense->created_by_user_id);
        $this->assertSame('760-25-027', data_get($expense->meta, 'logo_expense_account_code'));
        $this->assertSame('34LV0224 FORD CUSTOM YAKIT GİDERİ', data_get($expense->meta, 'logo_expense_account_name'));
        $this->assertDatabaseHas('integration_sync_states', [
            'domain' => 'pos-expenses',
            'entity_type' => PosExpense::class,
            'entity_id' => $expense->id,
            'status' => 'queued',
        ]);

        $this->getJson('/api/pos/expenses')
            ->assertOk()
            ->assertJsonCount(1, 'data');

        config(['integrations.logo.pos_expense_sync_key' => 'test-pos-expense-key']);

        $this
            ->withHeader('X-Integration-Key', 'test-pos-expense-key')
            ->getJson('/api/integrations/logo/pos-expenses/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('received', 1)
            ->assertJsonPath('records.0.logo.account_code', '760-25-027');

        $failedExpense = PosExpense::query()->create([
            'dealer_id' => $dealer->id,
            'expense_date' => now()->toDateString(),
            'category' => 'Yakıt',
            'amount' => '100.00',
            'currency' => 'TRY',
            'created_by_user_id' => $salesperson->id,
            'meta' => [
                'logo_expense_account_code' => '760.25.027',
            ],
        ]);
        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'pos-expenses',
            'direction' => 'outbound',
            'entity_type' => PosExpense::class,
            'entity_id' => $failedExpense->id,
            'status' => 'failed',
            'last_error' => 'Logo expense account could not be resolved.',
        ]);

        $this
            ->withHeader('X-Integration-Key', 'test-pos-expense-key')
            ->getJson('/api/integrations/logo/pos-expenses/pending?limit=10')
            ->assertOk()
            ->assertJsonPath('received', 2);

        $this
            ->withHeader('X-Integration-Key', 'test-pos-expense-key')
            ->getJson('/api/integrations/logo/pos-expenses/pending?limit=10&statuses[]=failed')
            ->assertOk()
            ->assertJsonPath('received', 1)
            ->assertJsonPath('records.0.pos_expense_id', $failedExpense->id);
    }

    public function test_salesperson_expense_accounts_and_cashboxes_are_mapped_per_salesperson(): void
    {
        config(['integrations.logo.pos_expense_sync_key' => 'test-pos-expense-key']);

        $dealer = Dealer::query()->create([
            'code' => 'DLR-EXP-MAP',
            'name' => 'Expense Mapping Dealer',
            'is_active' => true,
        ]);

        $roleId = Role::query()->firstOrCreate(['slug' => 'salesperson'], ['name' => 'Plasiyer'])->id;
        $categoryId = FinanceDefinition::query()
            ->where('type', 'expense_category')
            ->where('code', 'vehicle_maintenance')
            ->value('id');

        $cases = [
            ['Ahmet Araç', 'ahmet.arac', '760-25-025', '100.01.002'],
            ['Mehmet Aksoy', 'mehmet.aksoy', '760-25-016', '100.01.003'],
            ['Hüseyin Özgüney', 'huseyin.ozguney', '760-25-001', '100.01.001'],
            ['Adem Can Bakış', 'adem.canbakis', '760-55-004', '100.03.002'],
            ['SAMET GÖRPÜZ', 'samet.gorpuz', '760-25-013', '100.03.003'],
            ['Ahmet Can Tüfekçi', 'ahmetcan.tufekci', '760-61-007', '100.02.003'],
            ['Emre Kalaycı', 'emre.kalayci', '760-61-010', '100.02.002'],
        ];

        $expectedByName = [];

        foreach ($cases as [$name, $username, $expenseCode, $cashboxCode]) {
            $salesperson = User::factory()->create([
                'dealer_id' => $dealer->id,
                'name' => $name,
                'username' => $username,
                'is_active' => true,
            ]);
            $salesperson->roles()->sync([$roleId]);

            $this->actingAs($salesperson)
                ->postJson('/api/pos/expenses', [
                    'finance_definition_id' => $categoryId,
                    'category' => 'vehicle_maintenance',
                    'amount' => 10,
                    'note' => 'Test',
                ])
                ->assertCreated();

            $expense = PosExpense::query()->latest('id')->firstOrFail();
            $this->assertSame($expenseCode, data_get($expense->meta, 'logo_expense_account_code'), $name.' gider cari kodu');
            $this->assertSame($cashboxCode, data_get($expense->meta, 'cashbox_code'), $name.' kasa kodu');

            $expectedByName[$name] = [
                'expense_id' => $expense->id,
                'expense_code' => $expenseCode,
                'cashbox_code' => $cashboxCode,
            ];
        }

        $response = $this
            ->withHeader('X-Integration-Key', 'test-pos-expense-key')
            ->getJson('/api/integrations/logo/pos-expenses/pending?limit=20')
            ->assertOk();

        $recordsByExpenseId = collect($response->json('records'))->keyBy('pos_expense_id');

        foreach ($expectedByName as $name => $expected) {
            $record = $recordsByExpenseId->get($expected['expense_id']);

            $this->assertNotNull($record, $name.' Logo kuyruğu kaydı');
            $this->assertSame($expected['expense_code'], data_get($record, 'logo.account_code'), $name.' Logo kuyruğu cari kodu');
            $this->assertSame($expected['expense_code'], data_get($record, 'expense_account_code'), $name.' Logo kuyruğu gider cari kodu');
            $this->assertSame($expected['cashbox_code'], data_get($record, 'cashbox_code'), $name.' Logo kuyruğu kasa kodu');
        }
    }

    public function test_salesperson_expense_ignores_stale_pos_session_from_another_user(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-EXP-STALE',
            'name' => 'Expense Stale Session Dealer',
            'is_active' => true,
        ]);
        $salesperson = User::factory()->create([
            'dealer_id' => $dealer->id,
            'name' => 'Ahmet Araç',
            'username' => 'ahmet.arac.stale',
            'logo_cashbox_code' => '100.01.002',
            'logo_cashbox_name' => 'AHMET ARAÇ KASASI',
            'is_active' => true,
        ]);
        $salesperson->roles()->sync([
            Role::query()->firstOrCreate(['slug' => 'salesperson'], ['name' => 'Plasiyer'])->id,
        ]);
        $otherUser = User::factory()->create([
            'dealer_id' => $dealer->id,
            'is_active' => true,
        ]);
        $cashbox = Cashbox::query()->create([
            'code' => 'STALE-CASHBOX',
            'name' => 'Başka Kullanıcı Kasası',
            'is_active' => true,
        ]);
        $staleSession = PosSession::query()->create([
            'cashbox_id' => $cashbox->id,
            'opened_by' => $otherUser->id,
            'opened_at' => now(),
            'opening_cash' => 0,
            'status' => 'open',
        ]);
        $categoryId = FinanceDefinition::query()
            ->where('type', 'expense_category')
            ->where('code', 'fuel')
            ->value('id');

        $this->actingAs($salesperson)
            ->postJson('/api/pos/expenses', [
                'pos_session_id' => $staleSession->id,
                'finance_definition_id' => $categoryId,
                'category' => 'fuel',
                'amount' => 25,
            ])
            ->assertCreated()
            ->assertJsonPath('data.pos_session_id', null);

        $expense = PosExpense::query()->firstOrFail();
        $this->assertSame($salesperson->id, $expense->created_by_user_id);
        $this->assertSame('100.01.002', data_get($expense->meta, 'cashbox_code'));
        $this->assertSame('760-25-027', data_get($expense->meta, 'logo_expense_account_code'));
    }

    public function test_point_user_expense_uses_salesperson_account_mapping_when_name_matches(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-EXP-POINT-MAP',
            'name' => 'Expense Point Mapping Dealer',
            'is_active' => true,
        ]);

        $pointRoleId = Role::query()->firstOrCreate(['slug' => 'point'], ['name' => 'Point'])->id;
        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'name' => 'Emre Kalaycı',
            'username' => 'emre.kalayci',
            'menu_permissions' => ['pos', 'pos-expenses', 'pos-day-end'],
            'is_active' => true,
        ]);
        $user->roles()->sync([$pointRoleId]);

        $cashbox = Cashbox::query()->create([
            'code' => 'POINT-'.$user->id,
            'name' => 'Emre local point kasası',
            'is_active' => true,
        ]);

        $session = PosSession::query()->create([
            'cashbox_id' => $cashbox->id,
            'opened_by' => $user->id,
            'opened_at' => now(),
            'opening_cash' => 0,
            'status' => 'open',
        ]);

        $categoryId = FinanceDefinition::query()
            ->where('type', 'expense_category')
            ->where('code', 'vehicle_maintenance')
            ->value('id');

        $this->actingAs($user)
            ->postJson('/api/pos/expenses', [
                'pos_session_id' => $session->id,
                'finance_definition_id' => $categoryId,
                'category' => 'vehicle_maintenance',
                'amount' => 10,
                'note' => 'Emre bakım test',
            ])
            ->assertCreated();

        $expense = PosExpense::query()->latest('id')->firstOrFail();

        $this->assertSame('760-61-010', data_get($expense->meta, 'logo_expense_account_code'));
        $this->assertSame('34SA0071 FORD CUSTOM BAKIM-YIKAMA-SERVİS', data_get($expense->meta, 'logo_expense_account_name'));
        $this->assertSame('100.02.002', data_get($expense->meta, 'cashbox_code'));
        $this->assertSame('EMRE KALAYCI KASASI', data_get($expense->meta, 'cashbox_name'));
    }
}
