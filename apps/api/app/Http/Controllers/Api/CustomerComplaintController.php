<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Jobs\SendCustomerComplaintEmailJob;
use App\Models\Customer;
use App\Models\CustomerComplaint;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class CustomerComplaintController extends Controller
{
    public function store(Request $request): JsonResponse
    {
        /** @var User $user */
        $user = $request->user();

        $validated = $request->validate([
            'subject' => ['required', 'string', 'max:180'],
            'message' => ['required', 'string', 'max:5000'],
            'attachment' => ['nullable', 'file', 'max:8192'],
        ]);

        $customer = $this->resolveCustomer($user);
        $attachmentPath = null;
        $attachmentName = null;

        if ($request->hasFile('attachment')) {
            $file = $request->file('attachment');
            $attachmentPath = $file?->store('customer-complaints', 'public');
            $attachmentName = $file?->getClientOriginalName();
        }

        $customerName = $customer?->name ?? $customer?->title ?? $user->name;

        $recipient = $this->mailRecipient($user);
        $complaint = CustomerComplaint::query()->create([
            'dealer_id' => $user->dealer_id ?? $customer?->dealer_id,
            'customer_id' => $customer?->id,
            'user_id' => $user->id,
            'subject' => trim((string) $validated['subject']),
            'message' => trim((string) $validated['message']),
            'attachment_path' => $attachmentPath,
            'attachment_name' => $attachmentName,
            'mail_recipient' => $recipient,
            'status' => $recipient !== null ? 'queued' : 'failed',
            'mail_error' => $recipient === null ? 'Dilek / şikayet e-posta alıcısı tanımlı değil.' : null,
            'meta' => [
                'customer_code' => $customer?->code,
                'customer_title' => $customerName,
                'salesperson_name' => $customer?->salesperson?->name,
                'salesperson_phone' => $customer?->salesperson?->phone,
                'dealer_name' => $user->dealer?->name,
                'dealer_phone' => $user->dealer?->phone,
                'company_info' => $this->companyInfo(),
                'iban_info' => $this->ibanInfo(),
            ],
        ]);

        if ($recipient !== null) {
            SendCustomerComplaintEmailJob::dispatch($complaint->id)->afterResponse();
        }

        return response()->json([
            'data' => [
                'id' => $complaint->id,
                'status' => $complaint->status,
                'sent_at' => optional($complaint->sent_at)->toIso8601String(),
            ],
            'message' => $recipient !== null
                ? 'Dilek / şikayet kaydınız alındı ve e-posta kuyruğuna eklendi.'
                : 'Dilek / şikayet kaydınız alındı ancak e-posta alıcısı tanımlı değil.',
        ], 201);
    }

    private function resolveCustomer(User $user): ?Customer
    {
        if ($user->relationLoaded('selectedCustomer') && $user->selectedCustomer instanceof Customer) {
            return $user->selectedCustomer->loadMissing('salesperson');
        }

        if ($user->selected_customer_id) {
            return Customer::query()
                ->with('salesperson')
                ->where('dealer_id', $user->dealer_id)
                ->find($user->selected_customer_id);
        }

        return Customer::query()
            ->with('salesperson')
            ->where('dealer_id', $user->dealer_id)
            ->where('code', $user->username)
            ->first();
    }

    private function mailRecipient(User $user): ?string
    {
        $dealerMeta = is_array($user->dealer?->meta) ? $user->dealer->meta : [];
        $value = trim((string) (data_get($dealerMeta, 'system_settings.complaint_mail_to')
            ?? config('integrations.customer_complaints.mail_to')));

        return filter_var($value, FILTER_VALIDATE_EMAIL) ? $value : null;
    }

    private function companyInfo(): ?string
    {
        $value = trim((string) config('integrations.customer_complaints.company_info', env('POWERSA_COMPANY_INFO', '')));

        return $value !== '' ? $value : null;
    }

    private function ibanInfo(): ?string
    {
        $value = trim((string) config('integrations.customer_complaints.iban_info', env('POWERSA_IBAN_INFO', '')));

        return $value !== '' ? $value : null;
    }
}
