<?php

namespace Tests\Feature;

use App\Jobs\SendCustomerComplaintEmailJob;
use App\Models\Customer;
use App\Models\CustomerComplaint;
use App\Models\Dealer;
use App\Models\Role;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

class CustomerComplaintApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_customer_complaint_is_stored_and_queued_for_configured_recipient(): void
    {
        Queue::fake();

        $dealer = Dealer::query()->create([
            'code' => 'DLR-COMPLAINT',
            'name' => 'Complaint Dealer',
            'is_active' => true,
            'meta' => [
                'system_settings' => [
                    'complaint_mail_to' => 'farukcelik@gucsa.com.tr',
                ],
            ],
        ]);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'code' => '120-25-999',
            'name' => 'Şikayet Test Cari',
            'phone' => '05320000000',
            'branch_code' => 'ERZURUM',
            'branch_name' => 'Erzurum',
            'is_active' => true,
        ]);
        $role = Role::query()->create(['slug' => 'customer', 'name' => 'Customer']);
        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'selected_customer_id' => $customer->id,
            'username' => $customer->code,
            'menu_permissions' => ['customer-complaints'],
            'is_active' => true,
        ]);
        $user->roles()->sync([$role->id]);

        $response = $this->actingAs($user)->postJson('/api/customer-complaints', [
            'subject' => 'Teslimat talebi',
            'message' => 'Test mesajı',
        ]);

        $complaintId = (int) $response->assertCreated()->assertJsonPath('data.status', 'queued')->json('data.id');
        $this->assertDatabaseHas('customer_complaints', [
            'id' => $complaintId,
            'mail_recipient' => 'farukcelik@gucsa.com.tr',
            'status' => 'queued',
        ]);
        Queue::assertPushed(SendCustomerComplaintEmailJob::class, fn ($job) => $job->complaintId === $complaintId);

        Mail::fake();
        (new SendCustomerComplaintEmailJob($complaintId))->handle();

        $this->assertSame('sent', CustomerComplaint::query()->findOrFail($complaintId)->status);
    }
}
