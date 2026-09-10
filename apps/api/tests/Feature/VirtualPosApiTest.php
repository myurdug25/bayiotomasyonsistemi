<?php

namespace Tests\Feature;

use App\Models\Collection;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\IntegrationSyncEvent;
use App\Models\LedgerEntry;
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
            ->assertJsonPath('provider.meta.merchant_no', 'MAGAZA-999')
            ->assertJsonPath('provider.meta.username', 'merchant_user')
            ->assertJsonMissingPath('provider.payload.merchant_no')
            ->assertJsonMissingPath('provider.payload.username')
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
            ->assertJsonPath('provider.payload.BillToName', '3D Pay Cari')
            ->assertJsonPath('provider.payload.BillToCompany', '3D Pay Cari')
            ->assertJsonPath('provider.payload.BillToCustomerId', 'VPOS-CUST-003')
            ->assertJsonPath('provider.payload.okUrl', 'https://bayiotomasyonsistemi.com/api/virtual-pos/callback/success')
            ->assertJsonPath('provider.payload.failUrl', 'https://bayiotomasyonsistemi.com/api/virtual-pos/callback/fail')
            ->assertJsonMissingPath('provider.payload.security_code')
            ->assertJsonMissingPath('provider.payload.password')
            ->assertJsonMissingPath('provider.payload.card_number')
            ->assertJsonMissingPath('provider.payload.cvv')
            ->assertJsonMissingPath('provider.payload.merchant_no')
            ->assertJsonMissingPath('provider.payload.username')
            ->assertJsonMissingPath('provider.payload.reference')
            ->assertJsonMissingPath('provider.payload.customer_code')
            ->assertJsonMissingPath('provider.payload.customer_title')
            ->assertJsonMissingPath('provider.payload.description');

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

    public function test_virtual_pos_payment_does_not_require_panel_password_for_3d_hash(): void
    {
        $this->seed(RoleSeeder::class);

        $dealer = $this->createDealer('DLR-VPOS-PAY-004A', [
            'meta' => [
                'system_settings' => [
                    'virtual_pos' => [
                        'enabled' => true,
                        'mode' => 'live',
                        'gateway_url' => 'https://sanalpos2.ziraatbank.com.tr/fim/est3Dgate',
                        'merchant_no' => '192046469',
                        'username' => '',
                        'security_code_encrypted' => Crypt::encryptString('STOREKEY-123'),
                        'password_encrypted' => null,
                    ],
                ],
            ],
        ]);
        $customer = $this->createCustomer($dealer, 'VPOS-CUST-004A', '3D Storekey Cari');
        $user = $this->createUserWithRole('dealer_admin', $dealer, [
            'menu_permissions' => ['virtual-pos'],
            'selected_customer_id' => $customer->id,
        ]);

        $this->actingAs($user)
            ->postJson('/api/virtual-pos/payments', [
                'customer_id' => $customer->id,
                'amount' => 1,
                'installment' => 1,
            ])
            ->assertOk()
            ->assertJsonPath('provider.payload.clientid', '192046469')
            ->assertJsonMissingPath('provider.payload.password')
            ->assertJsonMissingPath('provider.payload.username');
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

    public function test_successful_virtual_pos_callback_records_customer_ledger_and_queues_logo_credit_card_collection(): void
    {
        $this->seed(RoleSeeder::class);
        config()->set('app.url', 'https://bayiotomasyonsistemi.com');
        config()->set('app.frontend_url', 'https://bayiotomasyonsistemi.com');

        $dealer = $this->createDealer('DLR-VPOS-PAY-005', [
            'meta' => [
                'system_settings' => [
                    'virtual_pos' => [
                        'enabled' => true,
                        'mode' => 'live',
                        'gateway_url' => 'https://sanalpos2.ziraatbank.com.tr/fim/est3Dgate',
                        'merchant_no' => '192046469',
                        'username' => '',
                        'security_code_encrypted' => Crypt::encryptString('STOREKEY-123'),
                        'password_encrypted' => null,
                    ],
                ],
            ],
        ]);
        $customer = $this->createCustomer($dealer, 'VPOS-CUST-005', 'Cari Pos Tahsilat');
        $user = $this->createUserWithRole('dealer_admin', $dealer, [
            'menu_permissions' => ['virtual-pos'],
            'selected_customer_id' => $customer->id,
        ]);

        $paymentResponse = $this->actingAs($user)
            ->postJson('/api/virtual-pos/payments', [
                'customer_id' => $customer->id,
                'amount' => 1250.50,
                'installment' => 1,
                'description' => 'Cari kart ödemesi',
            ])
            ->assertOk();

        $reference = $paymentResponse->json('payment.reference');

        $this->post('/api/virtual-pos/callback/success', [
            'oid' => $reference,
            'Response' => 'Approved',
            'ProcReturnCode' => '00',
            'mdStatus' => '1',
            'AuthCode' => 'AUTH123',
            'TransId' => 'TRX123',
            'HostRefNum' => 'HOST123',
        ])->assertRedirect('https://bayiotomasyonsistemi.com/virtual-pos?payment=success&reference='.urlencode($reference));

        $collection = Collection::query()->where('source_reference', $reference)->first();
        $this->assertNotNull($collection);
        $this->assertSame($customer->id, $collection->customer_id);
        $this->assertSame('b2b', $collection->source_system);
        $this->assertSame('pending', $collection->sync_status);
        $this->assertSame('cc', $collection->method);
        $this->assertSame('1250.50', $collection->amount);
        $this->assertSame('TRY', $collection->currency);
        $this->assertSame('virtual_pos', $collection->reference_fields['collection_channel']);
        $this->assertSame('AUTH123', $collection->reference_fields['auth_code']);

        $ledgerEntry = LedgerEntry::query()->where('collection_id', $collection->id)->first();
        $this->assertNotNull($ledgerEntry);
        $this->assertSame('payment', $ledgerEntry->type);
        $this->assertSame('0.00', $ledgerEntry->debit);
        $this->assertSame('1250.50', $ledgerEntry->credit);
        $this->assertSame($reference, $ledgerEntry->reference_no);
        $this->assertSame('virtual_pos', $ledgerEntry->meta['reference_fields']['collection_channel']);

        $this->assertDatabaseHas('integration_sync_events', [
            'domain' => 'collections-write',
            'entity_type' => Collection::class,
            'entity_id' => $collection->id,
            'customer_id' => $customer->id,
            'status' => 'queued',
        ]);
    }

    public function test_virtual_pos_callback_is_idempotent_and_does_not_record_declined_payments(): void
    {
        $this->seed(RoleSeeder::class);
        config()->set('app.url', 'https://bayiotomasyonsistemi.com');
        config()->set('app.frontend_url', 'https://bayiotomasyonsistemi.com');

        $dealer = $this->createDealer('DLR-VPOS-PAY-006', [
            'meta' => [
                'system_settings' => [
                    'virtual_pos' => [
                        'enabled' => true,
                        'mode' => 'live',
                        'gateway_url' => 'https://sanalpos2.ziraatbank.com.tr/fim/est3Dgate',
                        'merchant_no' => '192046469',
                        'username' => '',
                        'security_code_encrypted' => Crypt::encryptString('STOREKEY-123'),
                        'password_encrypted' => null,
                    ],
                ],
            ],
        ]);
        $customer = $this->createCustomer($dealer, 'VPOS-CUST-006', 'Tekrar Pos Cari');
        $user = $this->createUserWithRole('dealer_admin', $dealer, [
            'menu_permissions' => ['virtual-pos'],
            'selected_customer_id' => $customer->id,
        ]);

        $approvedReference = $this->actingAs($user)
            ->postJson('/api/virtual-pos/payments', [
                'customer_id' => $customer->id,
                'amount' => 100,
                'installment' => 1,
            ])
            ->json('payment.reference');

        $approvedPayload = [
            'oid' => $approvedReference,
            'Response' => 'Approved',
            'ProcReturnCode' => '00',
            'mdStatus' => '1',
        ];

        $this->post('/api/virtual-pos/callback/success', $approvedPayload)->assertRedirect();
        $this->post('/api/virtual-pos/callback/success', $approvedPayload)->assertRedirect();

        $this->assertSame(1, Collection::query()->where('source_reference', $approvedReference)->count());
        $collection = Collection::query()->where('source_reference', $approvedReference)->firstOrFail();
        $this->assertSame(1, LedgerEntry::query()->where('collection_id', $collection->id)->count());
        $this->assertSame(1, IntegrationSyncEvent::query()
            ->where('domain', 'collections-write')
            ->where('entity_type', Collection::class)
            ->where('entity_id', $collection->id)
            ->count());

        $declinedReference = $this->actingAs($user)
            ->postJson('/api/virtual-pos/payments', [
                'customer_id' => $customer->id,
                'amount' => 200,
                'installment' => 1,
            ])
            ->json('payment.reference');

        $this->post('/api/virtual-pos/callback/success', [
            'oid' => $declinedReference,
            'Response' => 'Declined',
            'ProcReturnCode' => '99',
            'mdStatus' => '1',
        ])->assertRedirect('https://bayiotomasyonsistemi.com/virtual-pos?payment=fail&reference='.urlencode($declinedReference));

        $this->assertDatabaseMissing('collections', ['source_reference' => $declinedReference]);
        $this->assertDatabaseMissing('ledger_entries', ['source_reference' => $declinedReference]);
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
