<?php

namespace App\Jobs;

use App\Models\CustomerComplaint;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Mail;
use Throwable;

class SendCustomerComplaintEmailJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 3;

    public array $backoff = [10, 60, 180];

    public function __construct(public readonly int $complaintId) {}

    public function handle(): void
    {
        $complaint = CustomerComplaint::query()
            ->with(['customer.salesperson', 'user', 'dealer'])
            ->findOrFail($this->complaintId);
        $recipient = trim((string) $complaint->mail_recipient);

        if ($recipient === '') {
            throw new \RuntimeException('Dilek / şikayet e-posta alıcısı tanımlı değil.');
        }

        $customer = $complaint->customer;
        $user = $complaint->user;
        $meta = is_array($complaint->meta) ? $complaint->meta : [];
        $body = implode("\n", [
            'Yeni müşteri dilek/şikayet kaydı alındı.',
            '',
            'Konu: '.$complaint->subject,
            'Mesaj: '.$complaint->message,
            'Müşteri / Cari: '.($customer?->name ?? data_get($meta, 'customer_title', '-')),
            'Cari Kodu: '.($customer?->code ?? data_get($meta, 'customer_code', '-')),
            'Gönderen Kullanıcı: '.trim(($user?->name ?? '-').' / '.($user?->username ?? '-')),
            'Bağlı Plasiyer: '.($customer?->salesperson?->name ?? data_get($meta, 'salesperson_name', '-')),
            'Şube: '.($customer?->branch_name ?? $user?->branch_name ?? '-'),
            'Telefon: '.($customer?->phone ?? $user?->phone ?? '-'),
            'Gönderim Tarihi: '.optional($complaint->created_at)?->format('d.m.Y H:i'),
            'Eklenen Dosya: '.($complaint->attachment_name ?? '-'),
        ]);

        Mail::raw($body, function ($message) use ($complaint, $recipient): void {
            $message
                ->to($recipient)
                ->subject('[PowerSA Dilek/Şikayet] '.$complaint->subject);

            if ($complaint->attachment_path) {
                $message->attachFromStorageDisk(
                    'public',
                    $complaint->attachment_path,
                    $complaint->attachment_name ?? basename($complaint->attachment_path)
                );
            }
        });

        $complaint->forceFill([
            'status' => 'sent',
            'mail_error' => null,
            'sent_at' => now(),
        ])->save();
    }

    public function failed(?Throwable $exception): void
    {
        CustomerComplaint::query()
            ->whereKey($this->complaintId)
            ->update([
                'status' => 'failed',
                'mail_error' => mb_substr((string) ($exception?->getMessage() ?? 'E-posta gönderilemedi.'), 0, 2000),
                'updated_at' => now(),
            ]);
    }
}
