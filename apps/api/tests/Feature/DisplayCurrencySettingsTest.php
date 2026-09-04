<?php

namespace Tests\Feature;

use App\Models\Customer;
use App\Models\Dealer;
use App\Models\Role;
use App\Models\User;
use App\Support\Pricing\DisplayCurrency;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class DisplayCurrencySettingsTest extends TestCase
{
    use RefreshDatabase;

    public function test_batum_lari_conversion_uses_moderator_configured_exchange_rate(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-BATUM-CONVERSION',
            'name' => 'Dealer Batum Conversion',
            'is_active' => true,
            'meta' => [
                'system_settings' => [
                    'batum_exchange_rate' => '18.7500',
                ],
            ],
        ]);

        $user = $this->createUserWithRole('admin', $dealer);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'code' => '120-00-001',
            'name' => 'Batum Cari',
            'branch_code' => 'BATUM',
            'branch_name' => 'BATUM',
            'phone' => '05320000000',
            'city' => 'BATUM',
            'is_active' => true,
        ]);

        $this->assertSame('GEL', DisplayCurrency::normalize('TRY', $user, $customer));
        $this->assertSame('10.00', DisplayCurrency::formatPrice(187.5, 'TRY', $user, $customer));
    }

    public function test_batum_lari_conversion_prefers_moderator_configured_exchange_multiplier(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-BATUM-MULTIPLIER',
            'name' => 'Dealer Batum Multiplier',
            'is_active' => true,
            'meta' => [
                'system_settings' => [
                    'batum_exchange_rate' => '18.7500',
                    'batum_exchange_multiplier' => '0.0560',
                ],
            ],
        ]);

        $user = $this->createUserWithRole('admin', $dealer);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'code' => '120-00-001',
            'name' => 'Batum Cari',
            'branch_code' => 'BATUM',
            'branch_name' => 'BATUM',
            'phone' => '05320000000',
            'city' => 'BATUM',
            'is_active' => true,
        ]);

        $this->assertSame('GEL', DisplayCurrency::normalize('TRY', $user, $customer));
        $this->assertSame('5.60', DisplayCurrency::formatPrice(100, 'TRY', $user, $customer));
    }

    public function test_batum_lari_conversion_uses_multiplier_as_fixed_try_factor(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-BATUM-FIXED-MULTIPLIER',
            'name' => 'Dealer Batum Fixed Multiplier',
            'is_active' => true,
            'meta' => [
                'system_settings' => [
                    'batum_exchange_rate' => '100.0000',
                    'batum_exchange_multiplier' => '0.6600',
                ],
            ],
        ]);

        $user = $this->createUserWithRole('admin', $dealer);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'code' => '120-00-001',
            'name' => 'Batum Cari',
            'branch_code' => 'BATUM',
            'branch_name' => 'BATUM',
            'phone' => '05320000000',
            'city' => 'BATUM',
            'is_active' => true,
        ]);

        $this->assertSame('GEL', DisplayCurrency::normalize('TRY', $user, $customer));
        $this->assertSame('66.00', DisplayCurrency::formatPrice(100, 'TRY', $user, $customer));
    }

    private function createUserWithRole(string $roleSlug, ?Dealer $dealer = null): User
    {
        $role = Role::query()->firstOrCreate(
            ['slug' => $roleSlug],
            ['name' => Str::headline(str_replace('_', ' ', $roleSlug))]
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer?->id,
            'customer_scope' => 'dealer',
            'is_active' => true,
        ]);

        $user->roles()->sync([$role->id]);

        return $user;
    }
}
