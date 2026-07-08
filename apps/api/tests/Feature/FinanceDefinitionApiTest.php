<?php

namespace Tests\Feature;

use App\Models\Dealer;
use App\Models\FinanceDefinition;
use App\Models\IntegrationSyncState;
use App\Models\PosExpense;
use App\Models\Role;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class FinanceDefinitionApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_logo_integration_can_list_and_update_factory_account_names(): void
    {
        config()->set('integrations.logo.product_sync_key', 'finance-test-key');

        $this->getJson('/api/integrations/logo/finance-definitions/pending')
            ->assertUnauthorized();

        $this->withHeader('X-Integration-Key', 'finance-test-key')
            ->getJson('/api/integrations/logo/finance-definitions/pending')
            ->assertOk()
            ->assertJsonPath('received', 11)
            ->assertJsonPath('records.0.code', '120-61-031');

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
                    ['type' => 'bank', 'code' => '10', 'logo_code' => '10', 'name' => 'Türkiye İş Bankası', 'source_table' => 'dbo.LG_003_BNCARD'],
                ],
                'full_snapshot_types' => ['bank'],
            ])
            ->assertOk()
            ->assertJsonPath('created', 1)
            ->assertJsonPath('deactivated', 2);

        $this->assertDatabaseHas('finance_definitions', [
            'type' => 'bank',
            'code' => '10',
            'name' => 'Türkiye İş Bankası',
            'is_active' => true,
        ]);
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
        $this->assertSame('760.25.027', data_get($expense->meta, 'logo_expense_account_code'));
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
            ->assertJsonPath('records.0.logo.account_code', '760.25.027');

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
            ->assertJsonPath('received', 1);

        $this
            ->withHeader('X-Integration-Key', 'test-pos-expense-key')
            ->getJson('/api/integrations/logo/pos-expenses/pending?limit=10&statuses[]=failed')
            ->assertOk()
            ->assertJsonPath('received', 1)
            ->assertJsonPath('records.0.pos_expense_id', $failedExpense->id);
    }
}
