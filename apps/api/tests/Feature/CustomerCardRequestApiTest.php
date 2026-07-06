<?php

namespace Tests\Feature;

use App\Models\Customer;
use App\Models\CustomerCardRequest;
use App\Models\CustomerCardRequestAttachment;
use App\Models\Dealer;
use App\Models\IntegrationSyncEvent;
use App\Models\Role;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Tests\TestCase;

class CustomerCardRequestApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_salesperson_can_create_and_list_customer_card_request(): void
    {
        $dealer = $this->createDealer('DLR-CARD-'.Str::upper(Str::random(4)));
        $user = $this->createUserWithRole('salesperson', $dealer);

        $this->actingAs($user);

        $createResponse = $this->postJson('/api/customer-card-requests', [
            'company_name' => 'Akdeniz Oto Servis',
            'contact_name' => 'Murat Korkmaz',
            'phone' => '05321234567',
            'email' => 'murat@example.test',
            'city' => 'Antalya',
            'district' => 'Muratpaşa',
            'tax_office' => 'Muratpaşa',
            'tax_number' => '1234567890',
            'address' => 'Yenigun Mah. 12. Sok. No:4',
            'note' => 'Yeni servis hesabı açılacak.',
        ]);

        $createResponse
            ->assertCreated()
            ->assertJsonPath('data.company_name', 'Akdeniz Oto Servis')
            ->assertJsonPath('data.status', 'submitted')
            ->assertJsonPath('data.dealer.id', $dealer->id)
            ->assertJsonPath('data.requested_by.id', $user->id);

        $listResponse = $this->getJson('/api/customer-card-requests?limit=10');

        $listResponse
            ->assertOk()
            ->assertJsonPath('summary.total_count', 1)
            ->assertJsonPath('summary.submitted_count', 1)
            ->assertJsonPath('data.0.company_name', 'Akdeniz Oto Servis')
            ->assertJsonPath('data.0.phone', '05321234567');
    }

    public function test_point_user_can_create_and_list_customer_card_request_in_own_dealer_scope(): void
    {
        $dealer = $this->createDealer('DLR-POINT-'.Str::upper(Str::random(4)));
        $otherDealer = $this->createDealer('DLR-OTHER-'.Str::upper(Str::random(4)));
        $user = $this->createUserWithRole('point', $dealer);
        $this->createUserWithRole('point', $otherDealer);

        CustomerCardRequest::query()->create([
            'dealer_id' => $otherDealer->id,
            'requested_by_user_id' => $this->createUserWithRole('salesperson', $otherDealer)->id,
            'request_no' => 'YCK-OTHER-0001',
            'company_name' => 'Diğer Bayi Başvurusu',
            'contact_name' => 'Diğer Yetkili',
            'phone' => '05000000000',
            'city' => 'Ankara',
            'status' => CustomerCardRequest::STATUS_SUBMITTED,
        ]);

        $this->actingAs($user);

        $this->postJson('/api/customer-card-requests', [
            'company_name' => 'Point Servis Hesabı',
            'contact_name' => 'Ömer Kaya',
            'phone' => '05324567890',
            'customer_kind' => 'person',
            'city' => 'İstanbul',
            'district' => 'Ümraniye',
            'note' => 'Bayi içinden hızlı başvuru açıldı.',
        ])
            ->assertCreated()
            ->assertJsonPath('data.company_name', 'Point Servis Hesabı')
            ->assertJsonPath('data.dealer.id', $dealer->id)
            ->assertJsonPath('data.requested_by.id', $user->id);

        $this->getJson('/api/customer-card-requests?limit=10')
            ->assertOk()
            ->assertJsonPath('summary.total_count', 1)
            ->assertJsonPath('data.0.company_name', 'Point Servis Hesabı');
    }

    public function test_point_user_cannot_approve_customer_card_request(): void
    {
        $dealer = $this->createDealer('DLR-POINT-'.Str::upper(Str::random(4)));
        $user = $this->createUserWithRole('point', $dealer);

        $request = CustomerCardRequest::query()->create([
            'dealer_id' => $dealer->id,
            'requested_by_user_id' => $user->id,
            'request_no' => 'YCK-POINT-0001',
            'company_name' => 'Point Test',
            'contact_name' => 'Yetkili',
            'phone' => '05320000000',
            'city' => 'Bursa',
            'status' => CustomerCardRequest::STATUS_SUBMITTED,
        ]);

        $this->actingAs($user);

        $this->patchJson("/api/customer-card-requests/{$request->id}/status", [
            'status' => 'approved',
            'review_note' => 'Point onay vermeye çalıştı.',
        ])->assertForbidden();
    }

    public function test_point_user_can_list_salespeople_and_auto_create_customer_card(): void
    {
        $pointDealer = $this->createDealer('DLR-POINT-'.Str::upper(Str::random(4)));
        $salesDealer = $this->createDealer('DLR-SALES-'.Str::upper(Str::random(4)));
        $pointUser = $this->createUserWithRole('point', $pointDealer);
        $salesperson = $this->createUserWithRole('salesperson', $salesDealer);

        $this->actingAs($pointUser);

        $this->getJson('/api/customer-card-salespeople')
            ->assertOk()
            ->assertJsonPath('data.0.id', $salesperson->id);

        $response = $this->postJson('/api/customer-card-requests', [
            'salesperson_user_id' => $salesperson->id,
            'company_name' => 'Point Yeni Cari',
            'contact_name' => 'Point Yeni Cari',
            'phone' => '05324567890',
            'customer_kind' => 'company',
            'city' => 'Erzurum',
            'district' => 'Yakutiye',
            'tax_office' => 'Yakutiye',
            'tax_number' => '1234567890',
            'address' => 'Point hızlı satış ekranından açıldı.',
            'auto_convert' => true,
        ]);

        $response
            ->assertCreated()
            ->assertJsonPath('data.status', CustomerCardRequest::STATUS_APPROVED)
            ->assertJsonPath('data.salesperson.id', $salesperson->id)
            ->assertJsonPath('data.dealer.id', $pointDealer->id)
            ->assertJsonPath('customer.code', '120-25-001')
            ->assertJsonPath('customer.name', 'Point Yeni Cari');

        $customer = Customer::query()->where('name', 'Point Yeni Cari')->firstOrFail();

        $this->assertSame($pointDealer->id, $customer->dealer_id);
        $this->assertSame($salesperson->id, $customer->salesperson_user_id);
        $this->assertSame('120-25-001', $customer->code);
        $this->assertDatabaseHas('integration_sync_events', [
            'system' => 'logo',
            'domain' => 'customers-write',
            'direction' => 'outbound',
            'entity_type' => Customer::class,
            'entity_id' => $customer->id,
            'status' => 'queued',
        ]);
    }

    public function test_admin_can_create_request_using_selected_customer_dealer_context_and_update_status(): void
    {
        $dealer = $this->createDealer('DLR-CTX-'.Str::upper(Str::random(4)));
        $customer = $this->createCustomer($dealer, 'CTX-001', 'Context Customer');
        $admin = $this->createUserWithRole('admin');
        $admin->forceFill([
            'selected_customer_id' => $customer->id,
        ])->save();

        $this->actingAs($admin);

        $createResponse = $this->postJson('/api/customer-card-requests', [
            'company_name' => 'Bursa Filtre Market',
            'contact_name' => 'Ayşe Demir',
            'phone' => '05335557799',
            'customer_kind' => 'person',
            'city' => 'Bursa',
        ]);

        $requestId = (int) $createResponse->json('data.id');

        $createResponse
            ->assertCreated()
            ->assertJsonPath('data.dealer.id', $dealer->id)
            ->assertJsonPath('data.status', 'submitted');

        $reviewResponse = $this->patchJson("/api/customer-card-requests/{$requestId}/status", [
            'status' => 'reviewing',
            'review_note' => 'Evrak doğrulama sürecine alındı.',
        ]);

        $reviewResponse
            ->assertOk()
            ->assertJsonPath('data.status', 'reviewing')
            ->assertJsonPath('data.review_note', 'Evrak doğrulama sürecine alındı.')
            ->assertJsonPath('data.reviewed_by.id', $admin->id);
    }

    public function test_salesperson_can_convert_approved_request_to_real_customer(): void
    {
        Storage::fake('local');

        $dealer = $this->createDealer('DLR-CONV');
        $user = $this->createUserWithRole('salesperson', $dealer);

        $this->actingAs($user);

        $createResponse = $this->postJson('/api/customer-card-requests', [
            'company_name' => 'Ege Filtre Ticaret',
            'contact_name' => 'Selim Acar',
            'phone' => '05332221100',
            'city' => 'İzmir',
            'district' => 'Bornova',
            'tax_office' => 'Bornova',
            'tax_number' => '9988776655',
            'address' => 'Anadolu Cad. No:8',
            'note' => 'Saha görüşmesi sonrası uygun bulundu.',
        ]);

        $requestId = (int) $createResponse->json('data.id');

        $this->uploadRequiredApprovalAttachments($requestId);

        $this->patchJson("/api/customer-card-requests/{$requestId}/status", [
            'status' => 'approved',
            'review_note' => 'Cari açılışı için onay verildi.',
        ])->assertOk();

        $convertResponse = $this->postJson("/api/customer-card-requests/{$requestId}/convert");

        $convertResponse
            ->assertOk()
            ->assertJsonPath('data.customer.code', '120-35-001')
            ->assertJsonPath('data.customer.title', 'Ege Filtre Ticaret')
            ->assertJsonPath('data.converted_by.id', $user->id)
            ->assertJsonPath('customer.name', 'Ege Filtre Ticaret');

        $this->assertDatabaseHas('customers', [
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $user->id,
            'code' => '120-35-001',
            'name' => 'Ege Filtre Ticaret',
            'contact_name' => 'Selim Acar',
            'tax_number' => '9988776655',
        ]);

        $this->assertDatabaseHas('customer_card_requests', [
            'id' => $requestId,
            'customer_id' => Customer::query()->where('code', '120-35-001')->value('id'),
        ]);
    }

    public function test_salesperson_can_auto_create_customer_card_for_logo_write_queue(): void
    {
        $dealer = $this->createDealer('DLR-AUTO');
        $user = $this->createUserWithRole('salesperson', $dealer);
        $user->forceFill([
            'logo_customer_specode4' => 'A',
        ])->save();
        $otherSalesperson = $this->createUserWithRole('salesperson', $dealer);
        $this->createCustomer($dealer, '120-06-001', 'Existing Ankara Customer');

        $this->actingAs($user);

        $response = $this->postJson('/api/customer-card-requests', [
            'salesperson_user_id' => $otherSalesperson->id,
            'company_name' => 'Yeni Cari Test',
            'contact_name' => 'Yeni Cari Test',
            'phone' => '05321230000',
            'email' => null,
            'customer_kind' => 'person',
            'logo_authorization_code' => 'A',
            'city' => 'Ankara',
            'district' => 'Çankaya',
            'address' => 'Atatürk Bulvarı No:1',
            'auto_convert' => true,
        ]);

        $response
            ->assertCreated()
            ->assertJsonPath('data.status', CustomerCardRequest::STATUS_APPROVED)
            ->assertJsonPath('data.salesperson.id', $user->id)
            ->assertJsonPath('data.logo_special_code', 'F1')
            ->assertJsonPath('data.logo_authorization_code', 'A')
            ->assertJsonPath('customer.code', '120-06-002');

        $customer = Customer::query()->where('code', '120-06-002')->firstOrFail();

        $this->assertSame($user->id, $customer->salesperson_user_id);
        $this->assertSame('b2b', $customer->source_system);
        $this->assertSame('pending', $customer->sync_status);
        $this->assertSame('F1', data_get($customer->meta, 'integrations.logo.payload.specode'));
        $this->assertSame('A', data_get($customer->meta, 'integrations.logo.payload.specode4'));
        $this->assertSame('A', data_get($customer->meta, 'integrations.logo.payload.cyphcode'));
        $this->assertSame('person', data_get($customer->meta, 'integrations.logo.payload.customer_kind'));
        $this->assertStringStartsWith('e ( yeni cari - ', (string) data_get($customer->meta, 'integrations.logo.payload.e_collection_note'));

        $this->assertDatabaseHas('integration_sync_events', [
            'system' => 'logo',
            'domain' => 'customers-write',
            'direction' => 'outbound',
            'entity_type' => Customer::class,
            'entity_id' => $customer->id,
            'status' => 'queued',
        ]);

        $this->assertSame(1, IntegrationSyncEvent::query()->count());
    }

    public function test_dealer_admin_can_auto_create_customer_card_for_logo_write_queue(): void
    {
        $dealer = $this->createDealer('DLR-DEALER-AUTO');
        $dealerAdmin = $this->createUserWithRole('dealer_admin', $dealer);
        $salesperson = $this->createUserWithRole('salesperson', $dealer);
        $salesperson->forceFill([
            'logo_customer_specode4' => 'D,H',
        ])->save();
        $dealerAdmin->forceFill([
            'menu_permissions' => ['new-customer-card'],
        ])->save();

        $this->actingAs($dealerAdmin);

        $response = $this->postJson('/api/customer-card-requests', [
            'salesperson_user_id' => $salesperson->id,
            'company_name' => 'Bayi Yeni Cari',
            'contact_name' => 'Bayi Yeni Cari',
            'phone' => '05321230001',
            'email' => 'bayi-yeni-cari@example.test',
            'customer_kind' => 'company',
            'logo_authorization_code' => 'D',
            'city' => 'Erzurum',
            'district' => 'Palandöken',
            'tax_office' => 'Palandöken',
            'tax_number' => '1234567890',
            'address' => 'Bayi yeni cari ekranından açıldı.',
            'auto_convert' => true,
        ]);

        $response
            ->assertCreated()
            ->assertJsonPath('data.status', CustomerCardRequest::STATUS_APPROVED)
            ->assertJsonPath('data.dealer.id', $dealer->id)
            ->assertJsonPath('data.salesperson.id', $salesperson->id)
            ->assertJsonPath('customer.code', '120-25-001')
            ->assertJsonPath('customer.name', 'Bayi Yeni Cari')
            ->assertJsonPath('customer.sync_status', 'pending')
            ->assertJsonPath('customer.logo_queue_status', 'queued');

        $customer = Customer::query()->where('code', '120-25-001')->firstOrFail();

        $this->assertSame($dealer->id, $customer->dealer_id);
        $this->assertSame($salesperson->id, $customer->salesperson_user_id);
        $this->assertSame('b2b', $customer->source_system);
        $this->assertSame('pending', $customer->sync_status);
        $this->assertSame('F1', data_get($customer->meta, 'integrations.logo.payload.specode'));
        $this->assertSame('D', data_get($customer->meta, 'integrations.logo.payload.specode4'));
        $this->assertSame('D', data_get($customer->meta, 'integrations.logo.payload.cyphcode'));

        $this->getJson('/api/customers?'.http_build_query([
            'q' => 'Bayi Yeni Cari',
            'limit' => 10,
        ]))
            ->assertOk()
            ->assertJsonPath('data.0.code', '120-25-001')
            ->assertJsonPath('data.0.title', 'Bayi Yeni Cari');

        $this->assertDatabaseHas('integration_sync_events', [
            'system' => 'logo',
            'domain' => 'customers-write',
            'direction' => 'outbound',
            'entity_type' => Customer::class,
            'entity_id' => $customer->id,
            'status' => 'queued',
        ]);
    }

    public function test_request_must_be_approved_before_customer_conversion(): void
    {
        $dealer = $this->createDealer('DLR-LOCK-'.Str::upper(Str::random(4)));
        $user = $this->createUserWithRole('salesperson', $dealer);

        $this->actingAs($user);

        $createResponse = $this->postJson('/api/customer-card-requests', [
            'company_name' => 'Karadeniz Filtre',
            'contact_name' => 'Kemal Yılmaz',
            'phone' => '05330000000',
            'customer_kind' => 'person',
            'city' => 'Samsun',
        ]);

        $requestId = (int) $createResponse->json('data.id');

        $this->postJson("/api/customer-card-requests/{$requestId}/convert")
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['status']);
    }

    public function test_request_cannot_be_approved_without_required_attachments(): void
    {
        Storage::fake('local');

        $dealer = $this->createDealer('DLR-EVRAK-'.Str::upper(Str::random(4)));
        $user = $this->createUserWithRole('salesperson', $dealer);

        $this->actingAs($user);

        $createResponse = $this->postJson('/api/customer-card-requests', [
            'company_name' => 'Trakya Filtre',
            'contact_name' => 'Burak Sezer',
            'phone' => '05331112233',
            'customer_kind' => 'person',
            'city' => 'Tekirdağ',
        ]);

        $requestId = (int) $createResponse->json('data.id');

        $this->patchJson("/api/customer-card-requests/{$requestId}/status", [
            'status' => 'approved',
            'review_note' => 'Evraklar kontrol edildi.',
        ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['status']);

        $this->uploadRequiredApprovalAttachments($requestId);

        $this->patchJson("/api/customer-card-requests/{$requestId}/status", [
            'status' => 'approved',
            'review_note' => 'Zorunlu evraklar tamam, onay verildi.',
        ])
            ->assertOk()
            ->assertJsonPath('data.status', 'approved')
            ->assertJsonPath('data.attachment_requirements.is_complete', true)
            ->assertJsonCount(0, 'data.attachment_requirements.missing_types');
    }

    public function test_salesperson_can_upload_and_read_request_attachment(): void
    {
        Storage::fake('local');

        $dealer = $this->createDealer('DLR-FILE-'.Str::upper(Str::random(4)));
        $user = $this->createUserWithRole('salesperson', $dealer);

        $this->actingAs($user);

        $createResponse = $this->postJson('/api/customer-card-requests', [
            'company_name' => 'Marmara Filtre',
            'contact_name' => 'Deniz Kaya',
            'phone' => '05334445566',
            'customer_kind' => 'person',
            'city' => 'Kocaeli',
        ]);

        $requestId = (int) $createResponse->json('data.id');

        $uploadResponse = $this->postJson(
            "/api/customer-card-requests/{$requestId}/attachments",
            [
                'attachment_type' => 'photo',
                'note' => 'Tabela fotoğrafı',
                'file' => UploadedFile::fake()->image('store-front.jpg'),
            ]
        );

        $attachmentPath = $uploadResponse->json('data.attachments.0.download_url');

        $uploadResponse
            ->assertCreated()
            ->assertJsonPath('data.attachments.0.attachment_type', 'photo')
            ->assertJsonPath('data.attachments.0.note', 'Tabela fotoğrafı')
            ->assertJsonPath('data.attachments.0.original_name', 'store-front.jpg');

        $attachmentId = (int) $uploadResponse->json('data.attachments.0.id');
        $storedRelativePath = CustomerCardRequestAttachment::query()
            ->whereKey($attachmentId)
            ->value('path');

        Storage::disk('local')->assertExists($storedRelativePath);

        $this->get($attachmentPath)
            ->assertOk()
            ->assertHeader('content-type', 'image/jpeg');
    }

    private function createDealer(string $code): Dealer
    {
        return Dealer::query()->create([
            'code' => $code,
            'name' => 'Dealer '.$code,
            'is_active' => true,
        ]);
    }

    private function uploadRequiredApprovalAttachments(int $requestId): void
    {
        $files = [
            'tax_plate' => UploadedFile::fake()->create('vergi-levhasi.pdf', 128, 'application/pdf'),
            'tax_certificate' => UploadedFile::fake()->create('vergi-belgesi.pdf', 128, 'application/pdf'),
            'trade_registry' => UploadedFile::fake()->create('ticaret-sicil.pdf', 128, 'application/pdf'),
        ];

        foreach ($files as $type => $file) {
            $this->postJson("/api/customer-card-requests/{$requestId}/attachments", [
                'attachment_type' => $type,
                'note' => 'Zorunlu evrak yüklemesi',
                'file' => $file,
            ])->assertCreated();
        }
    }

    private function createCustomer(Dealer $dealer, string $code, string $name): Customer
    {
        return Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => $code,
            'name' => $name,
            'is_active' => true,
        ]);
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
