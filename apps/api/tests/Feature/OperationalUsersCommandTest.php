<?php

namespace Tests\Feature;

use App\Models\Cashbox;
use App\Models\Dealer;
use App\Models\Role;
use App\Models\User;
use App\Support\MenuPermissions;
use App\Support\OperationalUserRoster;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

class OperationalUsersCommandTest extends TestCase
{
    use RefreshDatabase;

    public function test_operational_user_sync_creates_roster_and_deletes_unreferenced_users(): void
    {
        Dealer::query()->create([
            'code' => 'DLR-TEST',
            'name' => 'Test Dealer',
            'is_active' => true,
        ]);

        $legacyUser = User::factory()->create([
            'username' => 'legacy.user',
            'is_active' => true,
        ]);

        Artisan::call('users:sync-operational', [
            '--password' => 'RosterUser@2026',
        ]);

        $this->assertDatabaseMissing('users', [
            'id' => $legacyUser->id,
        ]);

        $this->assertSame(
            count(OperationalUserRoster::usernames()),
            User::query()->count()
        );

        $this->assertDatabaseHas('users', [
            'username' => 'erzurum.point',
            'name' => 'ERZURUM POINT HIZLI SATIŞ',
            'is_active' => true,
        ]);

        $pointUser = User::query()
            ->where('username', 'erzurum.point')
            ->with('roles')
            ->firstOrFail();

        $this->assertTrue($pointUser->roles->contains('slug', 'point'));
        $this->assertSame(MenuPermissions::fromRoles(['point']), $pointUser->menu_permissions);
        $this->assertSame('branch', $pointUser->customer_scope);
        $this->assertSame('ERZURUM', $pointUser->branch_code);
        $this->assertTrue(Hash::check('RosterUser@2026', $pointUser->password));

        $dealerAdminUser = User::query()
            ->where('username', 'dealer_admin')
            ->with('roles')
            ->firstOrFail();

        $this->assertTrue($dealerAdminUser->roles->contains('slug', 'dealer_admin'));
        $this->assertSame(MenuPermissions::fromRoles(['dealer_admin']), $dealerAdminUser->menu_permissions);

        $moderatorUser = User::query()
            ->where('username', 'moderator')
            ->with('roles')
            ->firstOrFail();

        $this->assertTrue($moderatorUser->roles->contains('slug', 'moderator'));
        $this->assertSame(MenuPermissions::fromRoles(['moderator']), $moderatorUser->menu_permissions);

        $salespersonUser = User::query()
            ->where('username', 'ahmet.arac')
            ->with('roles')
            ->firstOrFail();

        $this->assertTrue($salespersonUser->roles->contains('slug', 'salesperson'));
        $this->assertSame(MenuPermissions::fromRoles(['salesperson']), $salespersonUser->menu_permissions);
        $this->assertSame('assigned', $salespersonUser->customer_scope);
        $this->assertSame('ERZURUM', $salespersonUser->branch_code);
        $this->assertSame('A', $salespersonUser->logo_customer_specode4);

        $this->assertSame('C', User::query()->where('username', 'mehmet.aksoy')->value('logo_customer_specode4'));
        $this->assertSame('B', User::query()->where('username', 'huseyin.ozguney')->value('logo_customer_specode4'));
        $this->assertSame('D', User::query()->where('username', 'erzurum.merkez')->value('logo_customer_specode4'));
        $this->assertSame('E', User::query()->where('username', 'emre.kalayci')->value('logo_customer_specode4'));
        $this->assertSame('F', User::query()->where('username', 'ahmet.cantufekci')->value('logo_customer_specode4'));
        $this->assertSame('I', User::query()->where('username', 'samet.gorpuz')->value('logo_customer_specode4'));
        $this->assertSame('G', User::query()->where('username', 'adem.canbakis')->value('logo_customer_specode4'));
        $this->assertSame('J', User::query()->where('username', 'samsun.point')->value('logo_customer_specode4'));
        $this->assertSame('L', User::query()->where('username', 'trabzon.point')->value('logo_customer_specode4'));
        $this->assertSame('E,F,I,G,J,L', User::query()->where('username', 'turgay.buyukkal')->value('logo_customer_specode4'));

        $pointAliasUser = User::query()
            ->where('username', 'erzurum.hizlisatis')
            ->with('roles')
            ->firstOrFail();

        $this->assertTrue($pointAliasUser->roles->contains('slug', 'point'));
        $this->assertSame('dealer', $pointAliasUser->customer_scope);
        $this->assertSame('ERZURUM', $pointAliasUser->branch_code);

        $managerUser = User::query()
            ->where('username', 'mudur.erzurum')
            ->with('roles')
            ->firstOrFail();

        $this->assertTrue($managerUser->roles->contains('slug', 'admin'));
        $this->assertSame(MenuPermissions::keys(), $managerUser->menu_permissions);
        $this->assertNull($managerUser->dealer_id);
        $this->assertSame('A,B,C,D', $managerUser->logo_customer_specode4);

        $warehouseAliasUser = User::query()
            ->where('username', 'erz.depo')
            ->with('roles')
            ->firstOrFail();

        $this->assertTrue($warehouseAliasUser->roles->contains('slug', 'warehouse'));
        $this->assertSame('dealer', $warehouseAliasUser->customer_scope);
        $this->assertSame('ERZURUM', $warehouseAliasUser->branch_code);

        $batumUser = User::query()
            ->where('username', 'batum')
            ->with('roles')
            ->firstOrFail();

        $this->assertTrue($batumUser->roles->contains('slug', 'dealer_admin'));
        $this->assertTrue($batumUser->roles->contains('slug', 'point'));
        $this->assertSame(MenuPermissions::fromRoles(['dealer_admin', 'point']), $batumUser->menu_permissions);
        $this->assertSame('BATUM', $batumUser->branch_code);
        $this->assertSame('K', $batumUser->logo_customer_specode4);

        $warehouseUser = User::query()
            ->where('username', 'depo')
            ->with('roles')
            ->firstOrFail();

        $this->assertTrue($warehouseUser->roles->contains('slug', 'warehouse'));
        $this->assertSame(['warehouse'], $warehouseUser->menu_permissions);

        $cashierUser = User::query()
            ->where('username', 'kasiyer')
            ->with('roles')
            ->firstOrFail();

        $this->assertTrue($cashierUser->roles->contains('slug', 'cashier'));
        $this->assertSame(MenuPermissions::fromRoles(['cashier']), $cashierUser->menu_permissions);
    }

    public function test_operational_user_sync_accepts_per_user_password_map(): void
    {
        Dealer::query()->create([
            'code' => 'DLR-TEST',
            'name' => 'Test Dealer',
            'is_active' => true,
        ]);

        Artisan::call('users:sync-operational', [
            '--password' => 'RosterUser@2026',
        ]);

        User::query()
            ->where('username', 'erzurum.hizlisatis')
            ->firstOrFail()
            ->forceFill([
                'menu_permissions' => ['pos', 'delivery-notes', 'new-customer-card', 'returns'],
            ])
            ->save();

        Artisan::call('users:sync-operational', [
            '--password-map-json' => json_encode([
                'ahmet.arac' => 'AhmetMapped@2026',
                'erzurum.hizlisatis' => 'HizliMapped@2026',
            ], JSON_THROW_ON_ERROR),
            '--prune' => 'keep',
        ]);

        $ahmet = User::query()->where('username', 'ahmet.arac')->firstOrFail();
        $hizliSatis = User::query()->where('username', 'erzurum.hizlisatis')->firstOrFail();
        $mehmet = User::query()->where('username', 'mehmet.aksoy')->firstOrFail();

        $this->assertTrue(Hash::check('AhmetMapped@2026', $ahmet->password));
        $this->assertTrue(Hash::check('HizliMapped@2026', $hizliSatis->password));
        $this->assertTrue(Hash::check('RosterUser@2026', $mehmet->password));
        $this->assertSame(['pos', 'delivery-notes', 'new-customer-card', 'returns'], $hizliSatis->menu_permissions);
    }

    public function test_operational_user_sync_deactivates_referenced_users_that_cannot_be_deleted(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-TEST',
            'name' => 'Test Dealer',
            'is_active' => true,
        ]);
        $role = Role::query()->create([
            'slug' => 'point',
            'name' => 'Point',
        ]);
        $blockedUser = User::factory()->create([
            'dealer_id' => $dealer->id,
            'username' => 'blocked.user',
            'is_active' => true,
        ]);
        $blockedUser->roles()->sync([$role->id]);
        $cashbox = Cashbox::query()->create([
            'code' => 'CB-BLOCKED',
            'name' => 'Blocked Cashbox',
            'is_active' => true,
        ]);

        DB::table('pos_sessions')->insert([
            'cashbox_id' => $cashbox->id,
            'opened_by' => $blockedUser->id,
            'opened_at' => now(),
            'opening_cash' => 0,
            'status' => 'open',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        Artisan::call('users:sync-operational', [
            '--password' => 'RosterUser@2026',
        ]);

        $this->assertDatabaseHas('users', [
            'id' => $blockedUser->id,
            'username' => 'blocked.user',
            'is_active' => false,
        ]);
    }
}
