<?php

namespace Tests\Feature;

use App\Models\Customer;
use App\Models\Dealer;
use App\Models\Role;
use App\Models\User;
use Database\Seeders\RoleSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Str;
use Tests\TestCase;

class VirtualPosApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_virtual_pos_payment_requires_configured_gateway(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-VPOS-PAY-001');
        $customer = $this->createCustomer($dealer, 'VPOS-CUST-001', 'Virtual Pos Cari');
        $user = $this->createUserWithRole('dealer_admin', $dealer, [
            'menu_permissions' => ['virtual-pos'],
            'selected_customer_id' => $customer->id,
        ]);

        $this->actingAs($user)
            ->postJson('/api/virtual-pos/payments', [
                'customer_id' => $customer->id,
                'amount' => 1500.75,
                'installment' => 1,
                'description' => 'Test tahsilat',
                'card_holder' => 'TEST MUSTERI',
                'card_number' => '4111111111111111',
                'expiry' => '12/30',
                'cvv' => '123',
            ])
            ->assertUnprocessable()
            ->assertJsonPath('message', 'Sanal POS ayarları tamamlanmadan ödeme başlatılamaz.');
    }

    public function test_virtual_pos_payment_returns_provider_payload_without_secret_fields(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-VPOS-PAY-002', [
            'meta' => [
                'system_settings' => [
                    'virtual_pos' => [
                        'enabled' => true,
                        'mode' => 'live',
                        'gateway_url' => 'https://pos.example.com/pay',
                        'merchant_no' => 'MAGAZA-999',
                        'username' => 'merchant_user',
                        'security_code_encrypted' => Crypt::encryptString('SEC-999'),
                        'password_encrypted' => Crypt::encryptString('PASS-999'),
                    ],
                ],
            ],
        ]);
        $customer = $this->createCustomer($dealer, 'VPOS-CUST-002', 'Virtual Pos Hazir Cari');
        $user = $this->createUserWithRole('dealer_admin', $dealer, [
            'menu_permissions' => ['virtual-pos'],
            'selected_customer_id' => $customer->id,
        ]);

        $response = $this->actingAs($user)
            ->postJson('/api/virtual-pos/payments', [
                'customer_id' => $customer->id,
                'amount' => '1500,75',
                'installment' => 3,
                'description' => 'Cari tahsilat',
                'card_holder' => 'TEST MUSTERI',
                'card_number' => '4111111111111111',
                'expiry' => '12/30',
                'cvv' => '123',
            ])
            ->assertOk()
            ->assertJsonPath('payment.status', 'ready')
            ->assertJsonPath('payment.amount', '1500.75')
            ->assertJsonPath('payment.currency', 'TRY')
            ->assertJsonPath('payment.installment', 3)
            ->assertJsonPath('payment.customer.id', $customer->id)
            ->assertJsonPath('provider.mode', 'live')
            ->assertJsonPath('provider.gateway_url', 'https://pos.example.com/pay')
            ->assertJsonPath('provider.payload.merchant_no', 'MAGAZA-999')
            ->assertJsonPath('provider.payload.username', 'merchant_user')
            ->assertJsonMissingPath('provider.payload.security_code')
            ->assertJsonMissingPath('provider.payload.password')
            ->assertJsonMissingPath('provider.payload.card_number')
            ->assertJsonMissingPath('provider.payload.cvv');

        $this->assertStringStartsWith('VPOS-', $response->json('payment.reference'));
    }

    public function test_virtual_pos_payment_returns_nestpay_3d_pay_form_payload_with_hash(): void
    {
        $this->seed(RoleSeeder::class);
        config()->set('app.url', 'https://bayiotomasyonsistemi.com');

        $dealer = $this->createDealer('DLR-VPOS-PAY-003', [
            'meta' => [
                'system_settings' => [
                    'virtual_pos' => [
                        'enabled' => true,
                        'mode' => 'live',
                        'gateway_url' => 'https://sanalpos2.ziraatbank.com.tr/fim/est3Dgate',
                        'merchant_no' => '192046469',
                        'username' => 'merchant_user',
                        'security_code_encrypted' => Crypt::encryptString('STOREKEY-123'),
                        'password_encrypted' => Crypt::encryptString('PASS-999'),
                    ],
                ],
            ],
        ]);
        $customer = $this->createCustomer($dealer, 'VPOS-CUST-003', '3D Pay Cari');
        $user = $this->createUserWithRole('dealer_admin', $dealer, [
            'menu_permissions' => ['virtual-pos'],
            'selected_customer_id' => $customer->id,
        ]);

        $response = $this->actingAs($user)
            ->postJson('/api/virtual-pos/payments', [
                'customer_id' => $customer->id,
                'amount' => 1,
                'installment' => 1,
                'description' => '3D test tahsilat',
            ])
            ->assertOk()
            ->assertJsonPath('provider.integration', 'nestpay_3d_pay_hosting')
            ->assertJsonPath('provider.method', 'POST')
            ->assertJsonPath('provider.gateway_url', 'https://sanalpos2.ziraatbank.com.tr/fim/est3Dgate')
            ->assertJsonPath('provider.payload.clientid', '192046469')
            ->assertJsonPath('provider.payload.storetype', '3d_pay_hosting')
            ->assertJsonPath('provider.payload.hashAlgorithm', 'ver3')
            ->assertJsonPath('provider.payload.encoding', 'UTF-8')
            ->assertJsonPath('provider.payload.islemtipi', 'Auth')
            ->assertJsonPath('provider.payload.amount', '1.00')
            ->assertJsonPath('provider.payload.currency', '949')
            ->assertJsonPath('provider.payload.lang', 'tr')
            ->assertJsonPath('provider.payload.taksit', '')
            ->assertJsonPath('provider.payload.okUrl', 'https://bayiotomasyonsistemi.com/api/virtual-pos/callback/success')
            ->assertJsonPath('provider.payload.failUrl', 'https://bayiotomasyonsistemi.com/api/virtual-pos/callback/fail')
            ->assertJsonMissingPath('provider.payload.security_code')
            ->assertJsonMissingPath('provider.payload.password')
            ->assertJsonMissingPath('provider.payload.card_number')
            ->assertJsonMissingPath('provider.payload.cvv');

        $payload = $response->json('provider.payload');
        $hashFields = $payload;
        unset($hashFields['hash'], $hashFields['encoding']);
        uksort($hashFields, static fn (string $left, string $right): int => strcasecmp($left, $right));

        $expectedPlainText = collect($hashFields)
            ->map(static fn (mixed $value): string => str_replace(['\\', '|'], ['\\\\', '\\|'], (string) $value).'|')
            ->implode('')
            .str_replace(['\\', '|'], ['\\\\', '\\|'], 'STOREKEY-123');
        $expectedHash = base64_encode(hash('sha512', $expectedPlainText, true));

        $this->assertSame($expectedHash, $payload['hash']);
    }

    public function test_virtual_pos_payment_derives_ziraat_payment_gateway_from_admin_panel_url(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-VPOS-PAY-004', [
            'meta' => [
                'system_settings' => [
                    'virtual_pos' => [
                        'enabled' => true,
                        'mode' => 'live',
                        'gateway_url' => 'https://sanalpos2.ziraatbank.com.tr/fim/est3Dgate/common/login',
                        'merchant_no' => '192046469',
                        'username' => 'merchant_user',
                        'security_code_encrypted' => Crypt::encryptString('STOREKEY-123'),
                        'password_encrypted' => Crypt::encryptString('PASS-999'),
                    ],
                ],
            ],
        ]);
        $customer = $this->createCustomer($dealer, 'VPOS-CUST-004', 'Ziraat Panel Cari');
        $user = $this->createUserWithRole('dealer_admin', $dealer, [
            'menu_permissions' => ['virtual-pos'],
            'selected_customer_id' => $customer->id,
        ]);

        $this->actingAs($user)
            ->postJson('/api/virtual-pos/payments', [
                'customer_id' => $customer->id,
                'amount' => 1,
                'installment' => 2,
            ])
            ->assertOk()
            ->assertJsonPath('provider.gateway_url', 'https://sanalpos2.ziraatbank.com.tr/fim/est3Dgate')
            ->assertJsonPath('provider.payload.taksit', '2');
    }

    private function createDealer(string $code, array $overrides = []): Dealer
    {
        return Dealer::query()->create(array_merge([
            'code' => $code,
            'name' => $code.' Bayi',
            'email' => strtolower($code).'@example.test',
            'phone' => '04420000000',
            'is_active' => true,
        ], $overrides));
    }

    private function createUserWithRole(string $roleSlug, Dealer $dealer, array $overrides = []): User
    {
        $role = Role::query()->firstOrCreate(
            ['slug' => $roleSlug],
            ['name' => Str::headline(str_replace('_', ' ', $roleSlug))]
        );

        $user = User::factory()->create(array_merge([
            'dealer_id' => $dealer->id,
            'customer_scope' => 'dealer',
            'selected_customer_id' => null,
            'is_active' => true,
        ], $overrides));

        $user->roles()->sync([$role->id]);

        return $user;
    }

    private function createCustomer(Dealer $dealer, string $code, string $name): Customer
    {
        return Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'code' => $code,
            'name' => $name,
            'phone' => '05320000000',
            'city' => 'ERZURUM',
            'district' => 'YAKUTIYE',
            'credit_limit' => 50000,
            'is_active' => true,
        ]);
    }
}
