<?php

namespace Tests\Feature;

use App\Models\Dealer;
use App\Models\Role;
use App\Models\User;
use App\Models\UserNotification;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class UserNotificationScopeApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_branch_manager_only_sees_notifications_for_own_branch(): void
    {
        $dealer = $this->createDealer('DLR-NOTIFY-ERZ');
        $manager = $this->createUser('dealer_admin', $dealer, [
            'username' => 'mudur.erzurum',
            'branch_code' => 'ERZURUM',
            'menu_permissions' => ['warehouse'],
        ]);

        $this->notification($manager, $dealer, 'Erzurum siparişi', '1');
        $this->notification($manager, $dealer, 'Batum siparişi', '4');

        $this->actingAs($manager)
            ->getJson('/api/notifications?status=all')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.title', 'Erzurum siparişi')
            ->assertJsonPath('unread_count', 1);
    }

    public function test_turgay_manager_sees_trabzon_and_samsun_but_not_other_branches(): void
    {
        $dealer = $this->createDealer('DLR-NOTIFY-KRD');
        $manager = $this->createUser('dealer_admin', $dealer, [
            'username' => 'turgay.buyukkal',
            'branch_code' => 'TRABZON',
            'menu_permissions' => ['warehouse'],
        ]);

        $this->notification($manager, $dealer, 'Trabzon siparişi', '2');
        $this->notification($manager, $dealer, 'Samsun siparişi', '3');
        $this->notification($manager, $dealer, 'Erzurum siparişi', '1');
        $this->notification($manager, $dealer, 'Batum siparişi', '4');

        $response = $this->actingAs($manager)
            ->getJson('/api/notifications?status=all')
            ->assertOk()
            ->assertJsonCount(2, 'data')
            ->assertJsonPath('unread_count', 2);

        $this->assertEqualsCanonicalizing(
            ['Trabzon siparişi', 'Samsun siparişi'],
            collect($response->json('data'))->pluck('title')->all(),
        );
    }

    public function test_batum_user_does_not_see_notifications_from_other_branches(): void
    {
        $dealer = $this->createDealer('DLR-NOTIFY-BAT');
        $batum = $this->createUser('dealer_admin', $dealer, [
            'username' => 'batum',
            'branch_code' => 'BATUM',
            'menu_permissions' => ['warehouse'],
        ]);

        $this->notification($batum, $dealer, 'Batum siparişi', '4');
        $this->notification($batum, $dealer, 'Trabzon siparişi', '2');

        $this->actingAs($batum)
            ->getJson('/api/notifications?status=all')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.title', 'Batum siparişi')
            ->assertJsonPath('unread_count', 1);
    }

    public function test_admin_can_see_all_assigned_branch_notifications(): void
    {
        $dealer = $this->createDealer('DLR-NOTIFY-ADM');
        $admin = $this->createUser('admin', $dealer);

        $this->notification($admin, $dealer, 'Erzurum siparişi', '1');
        $this->notification($admin, $dealer, 'Batum siparişi', '4');

        $this->actingAs($admin)
            ->getJson('/api/notifications?status=all')
            ->assertOk()
            ->assertJsonCount(2, 'data')
            ->assertJsonPath('unread_count', 2);
    }

    private function createDealer(string $code): Dealer
    {
        return Dealer::query()->create([
            'code' => $code,
            'name' => 'Dealer '.$code,
            'is_active' => true,
        ]);
    }

    private function createUser(string $roleSlug, Dealer $dealer, array $overrides = []): User
    {
        $role = Role::query()->firstOrCreate(
            ['slug' => $roleSlug],
            ['name' => Str::headline($roleSlug)],
        );

        $user = User::factory()->create(array_merge([
            'dealer_id' => $dealer->id,
            'is_active' => true,
        ], $overrides));
        $user->roles()->sync([$role->id]);

        return $user;
    }

    private function notification(User $user, Dealer $dealer, string $title, string $warehouseCode): void
    {
        UserNotification::query()->create([
            'user_id' => $user->id,
            'dealer_id' => $dealer->id,
            'type' => 'order.created',
            'title' => $title,
            'body' => $title,
            'url' => '/warehouse',
            'status' => 'unread',
            'meta' => ['warehouse_code' => $warehouseCode],
        ]);
    }
}
