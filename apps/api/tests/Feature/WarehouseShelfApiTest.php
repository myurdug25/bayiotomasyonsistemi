<?php

namespace Tests\Feature;

use App\Models\Role;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class WarehouseShelfApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_non_admin_users_are_locked_to_their_own_rack_warehouse(): void
    {
        $warehouseRole = Role::query()->create(['name' => 'Depo', 'slug' => 'warehouse']);

        $cases = [
            ['trabzon.depo', 'TRABZON', '100.02.001', '2', 'TRABZON DEPO'],
            ['samsun.depo', 'SAMSUN', '100.03.001', '3', 'SAMSUN DEPO'],
            ['batum.depo', 'BATUM', '100.04.001', '4', 'BATUM DEPO'],
            ['erz.depo', 'ERZURUM', '100.01.001', '1', 'ERZURUM DEPO'],
        ];

        foreach ($cases as [$username, $branchCode, $cashboxCode, $warehouseCode, $warehouseName]) {
            $user = User::factory()->create([
                'username' => $username,
                'branch_code' => $branchCode,
                'branch_name' => $branchCode,
                'logo_cashbox_code' => $cashboxCode,
                'menu_permissions' => ['rack-addresses'],
                'feature_permissions' => ['rack-addresses.update'],
            ]);
            $user->roles()->attach($warehouseRole);

            $this->actingAs($user);

            $this->getJson('/api/warehouse/shelves')
                ->assertOk()
                ->assertJsonPath('warehouse.code', $warehouseCode)
                ->assertJsonPath('warehouse.name', $warehouseName)
                ->assertJsonPath('can_choose_warehouse', false)
                ->assertJsonCount(1, 'warehouses')
                ->assertJsonPath('warehouses.0.code', $warehouseCode);
        }
    }

    public function test_admin_can_choose_each_rack_warehouse(): void
    {
        $adminRole = Role::query()->create(['name' => 'Admin', 'slug' => 'admin']);
        $admin = User::factory()->create([
            'username' => 'admin.rack.test',
            'menu_permissions' => ['rack-addresses'],
            'feature_permissions' => ['rack-addresses.update'],
        ]);
        $admin->roles()->attach($adminRole);

        $this->actingAs($admin)
            ->getJson('/api/warehouse/shelves?warehouse_code=2')
            ->assertOk()
            ->assertJsonPath('warehouse.code', '2')
            ->assertJsonPath('warehouse.name', 'TRABZON DEPO')
            ->assertJsonPath('can_choose_warehouse', true)
            ->assertJsonCount(5, 'warehouses');
    }
}
