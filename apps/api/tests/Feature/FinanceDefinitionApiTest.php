<?php

namespace Tests\Feature;

use App\Models\Role;
use App\Models\Dealer;
use App\Models\PosExpense;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class FinanceDefinitionApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_collection_user_can_list_active_definitions_and_admin_can_manage_them(): void
    {
        $salesperson = User::factory()->create(['is_active' => true]);
        $salesperson->roles()->sync([
            Role::query()->firstOrCreate(['slug' => 'salesperson'], ['name' => 'Plasiyer'])->id,
        ]);

        $this->actingAs($salesperson)
            ->getJson('/api/finance-definitions?type=bank')
            ->assertOk()
            ->assertJsonCount(4, 'data')
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
            'is_active' => true,
        ]);
        $salesperson->roles()->sync([
            Role::query()->firstOrCreate(['slug' => 'salesperson'], ['name' => 'Plasiyer'])->id,
        ]);

        $categoryId = \App\Models\FinanceDefinition::query()
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
        $this->assertDatabaseHas('integration_sync_states', [
            'domain' => 'pos-expenses',
            'entity_type' => PosExpense::class,
            'entity_id' => $expense->id,
            'status' => 'queued',
        ]);

        $this->getJson('/api/pos/expenses')
            ->assertOk()
            ->assertJsonCount(1, 'data');
    }
}
