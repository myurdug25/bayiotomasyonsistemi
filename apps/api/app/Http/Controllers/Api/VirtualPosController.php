<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Collection as CollectionModel;
use App\Models\Customer;
use App\Models\IntegrationSyncEvent;
use App\Models\User;
use App\Services\Integrations\Logo\LogoWritePublisher;
use App\Services\Ledger\LedgerWriter;
use App\Support\VirtualPosSettings;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\RedirectResponse;
use Symfony\Component\HttpFoundation\Response;

class VirtualPosController extends Controller
{
    public function store(Request $request): JsonResponse
    {
        if (is_string($request->input('amount'))) {
            $request->merge([
                'amount' => str_replace(',', '.', str_replace('.', '', $request->input('amount'))),
            ]);
        }

        $validated = $request->validate([
            'customer_id' => ['required', 'integer', 'exists:customers,id'],
            'amount' => ['required', 'numeric', 'min:0.01', 'max:999999999'],
            'currency' => ['sometimes', 'string', 'size:3'],
            'installment' => ['required', 'integer', 'in:1,2,3'],
            'description' => ['nullable', 'string', 'max:500'],
        ]);

        /** @var User $user */
        $user = $request->user();
        $customer = Customer::query()->with('dealer')->findOrFail($validated['customer_id']);

        if (! $user->canAccessCustomer($customer)) {
            abort(Response::HTTP_FORBIDDEN, 'Bu cari için sanal POS işlemi başlatamazsınız.');
        }

        $dealer = $customer->dealer;
        if (! VirtualPosSettings::isReady($dealer)) {
            throw ValidationException::withMessages([
                'virtual_pos' => ['Sanal POS ayarları tamamlanmadan ödeme başlatılamaz.'],
            ]);
        }

        $settings = VirtualPosSettings::privateConfig($dealer);
        $amount = number_format((float) $validated['amount'], 2, '.', '');
        $currency = strtoupper($validated['currency'] ?? 'TRY');
        $reference = $this->signedPaymentReference($customer, $user, (float) $validated['amount'], $currency);
        $gatewayUrl = $this->paymentGatewayUrl($settings['gateway_url']);
        $installment = (int) $validated['installment'];
        $installmentValue = $installment <= 1 ? '' : (string) $installment;
        $apiBaseUrl = rtrim((string) config('app.url'), '/');
        $okUrl = $apiBaseUrl.'/api/virtual-pos/callback/success';
        $failUrl = $apiBaseUrl.'/api/virtual-pos/callback/fail';
        $transactionType = 'Auth';
        $rnd = (string) Str::uuid();
        $currencyCode = $this->nestpayCurrencyCode($currency);

        $providerPayload = [
            'clientid' => $settings['merchant_no'],
            'oid' => $reference,
            'amount' => $amount,
            'currency' => $currencyCode,
            'taksit' => $installmentValue,
            'okUrl' => $okUrl,
            'failUrl' => $failUrl,
            'islemtipi' => $transactionType,
            'storetype' => '3d_pay_hosting',
            'lang' => 'tr',
            'rnd' => $rnd,
            'hashAlgorithm' => 'ver3',
            'encoding' => 'UTF-8',
            'BillToName' => $this->truncateNestpayText($customer->name, 100),
            'BillToCompany' => $this->truncateNestpayText($customer->name, 100),
            'BillToCustomerId' => $this->truncateNestpayText($customer->code, 64),
        ];

        $providerPayload['hash'] = $this->nestpayHash($providerPayload, $settings['security_code']);

        return response()->json([
            'payment' => [
                'status' => 'ready',
                'reference' => $reference,
                'amount' => $amount,
                'currency' => $currency,
                'installment' => (int) $validated['installment'],
                'description' => $validated['description'] ?? null,
                'customer' => [
                    'id' => $customer->id,
                    'code' => $customer->code,
                    'title' => $customer->name,
                ],
            ],
            'provider' => [
                'mode' => $settings['mode'],
                'integration' => 'nestpay_3d_pay_hosting',
                'method' => 'POST',
                'gateway_url' => $gatewayUrl,
                'payload' => $providerPayload,
                'meta' => [
                    'merchant_no' => $settings['merchant_no'],
                    'username' => $settings['username'],
                    'reference' => $reference,
                    'amount' => $amount,
                    'currency' => $currency,
                    'installment' => $installment,
                    'customer_code' => $customer->code,
                    'customer_title' => $customer->name,
                    'description' => $validated['description'] ?? '',
                ],
            ],
        ]);
    }

    public function callback(
        Request $request,
        string $result,
        LedgerWriter $ledgerWriter,
        LogoWritePublisher $logoWritePublisher
    ): RedirectResponse {
        $reference = (string) ($request->input('oid') ?: $request->input('ReturnOid') ?: $request->input('reference') ?: '');
        $payment = $this->parseSignedPaymentReference($reference);
        $status = $result === 'success' && $payment !== null && $this->bankApproved($request)
            ? 'success'
            : 'fail';

        if ($status === 'success') {
            $this->recordApprovedPayment($payment, $request, $ledgerWriter, $logoWritePublisher);
        }

        $frontendUrl = rtrim((string) config('app.frontend_url', env('FRONTEND_URL', config('app.url'))), '/');

        return redirect()->away($frontendUrl.'/virtual-pos?payment='.$status.($reference !== '' ? '&reference='.urlencode($reference) : ''));
    }

    /**
     * NestPay hashAlgorithm=ver3: form values sorted alphabetically, separated by pipes, then storekey.
     *
     * @param  array<string, mixed>  $payload
     */
    private function nestpayHash(array $payload, string $storeKey): string
    {
        $hashFields = $payload;
        unset($hashFields['hash'], $hashFields['encoding']);

        uksort($hashFields, static fn (string $left, string $right): int => strcasecmp($left, $right));

        $plainText = '';
        foreach ($hashFields as $value) {
            $plainText .= $this->escapeHashValue((string) $value).'|';
        }
        $plainText .= $this->escapeHashValue($storeKey);

        return base64_encode(hash('sha512', $plainText, true));
    }

    private function escapeHashValue(string $value): string
    {
        return str_replace(['\\', '|'], ['\\\\', '\\|'], $value);
    }

    private function nestpayCurrencyCode(string $currency): string
    {
        return match (strtoupper($currency)) {
            'USD' => '840',
            'EUR' => '978',
            default => '949',
        };
    }

    private function truncateNestpayText(?string $value, int $limit): string
    {
        $value = trim((string) $value);

        if ($value === '') {
            return '';
        }

        return mb_substr($value, 0, $limit);
    }

    private function signedPaymentReference(Customer $customer, User $user, float $amount, string $currency): string
    {
        $minorAmount = (string) max(1, (int) round($amount * 100));
        $currency = strtoupper($currency);
        $payload = implode('-', [
            'VPOS',
            (string) $customer->id,
            (string) $user->id,
            $minorAmount,
            $currency,
            now()->format('YmdHis'),
            Str::upper(Str::random(6)),
        ]);

        return $payload.'-'.$this->paymentReferenceSignature($payload);
    }

    /**
     * @return array{customer_id:int,user_id:int,amount:string,currency:string,reference:string}|null
     */
    private function parseSignedPaymentReference(string $reference): ?array
    {
        $parts = explode('-', trim($reference));
        if (count($parts) !== 8 || $parts[0] !== 'VPOS') {
            return null;
        }

        [$prefix, $customerId, $userId, $minorAmount, $currency, $timestamp, $random, $signature] = $parts;
        $payload = implode('-', [$prefix, $customerId, $userId, $minorAmount, $currency, $timestamp, $random]);

        if (
            ! ctype_digit($customerId)
            || ! ctype_digit($userId)
            || ! ctype_digit($minorAmount)
            || ! preg_match('/^[A-Z]{3}$/', $currency)
            || ! hash_equals($this->paymentReferenceSignature($payload), $signature)
        ) {
            return null;
        }

        return [
            'customer_id' => (int) $customerId,
            'user_id' => (int) $userId,
            'amount' => number_format(((int) $minorAmount) / 100, 2, '.', ''),
            'currency' => $currency,
            'reference' => $reference,
        ];
    }

    private function paymentReferenceSignature(string $payload): string
    {
        return substr(hash_hmac('sha256', $payload, (string) config('app.key')), 0, 16);
    }

    private function bankApproved(Request $request): bool
    {
        $response = Str::lower(trim((string) ($request->input('Response') ?? $request->input('response') ?? '')));
        $procReturnCode = trim((string) ($request->input('ProcReturnCode') ?? $request->input('procreturncode') ?? ''));
        $mdStatus = trim((string) ($request->input('mdStatus') ?? $request->input('mdstatus') ?? ''));

        return $response === 'approved'
            && $procReturnCode === '00'
            && ($mdStatus === '' || $mdStatus === '1');
    }

    /**
     * @param  array{customer_id:int,user_id:int,amount:string,currency:string,reference:string}  $payment
     */
    private function recordApprovedPayment(
        array $payment,
        Request $request,
        LedgerWriter $ledgerWriter,
        LogoWritePublisher $logoWritePublisher
    ): void {
        DB::transaction(function () use ($payment, $request, $ledgerWriter, $logoWritePublisher): void {
            $existing = CollectionModel::query()
                ->where('source_system', 'b2b')
                ->where('source_reference', $payment['reference'])
                ->lockForUpdate()
                ->first();

            if ($existing instanceof CollectionModel) {
                $this->ensureCollectionLedgerAndLogoQueue($existing, $ledgerWriter, $logoWritePublisher);

                return;
            }

            $customer = Customer::query()->find($payment['customer_id']);
            if (! $customer instanceof Customer) {
                return;
            }

            $date = now()->toDateString();
            $referenceFields = [
                'collection_channel' => 'virtual_pos',
                'pos_payment_type' => 'single_payment',
                'auth_code' => $this->nullableString($request->input('AuthCode')),
                'transaction_id' => $this->nullableString($request->input('TransId')),
                'host_reference' => $this->nullableString($request->input('HostRefNum')),
                'bank_response' => $this->nullableString($request->input('Response')),
                'proc_return_code' => $this->nullableString($request->input('ProcReturnCode')),
                'md_status' => $this->nullableString($request->input('mdStatus')),
            ];
            $referenceFields = array_filter($referenceFields, static fn ($value): bool => $value !== null && $value !== '');
            $meta = [
                'source' => 'virtual_pos',
                'reference_fields' => $referenceFields,
                'virtual_pos' => [
                    'approved_at' => now()->toIso8601String(),
                    'callback_result' => 'success',
                ],
                'integrations' => [
                    'logo' => [
                        'submitted_at' => now()->toIso8601String(),
                        'submitted_by_user_id' => $payment['user_id'],
                    ],
                ],
            ];

            $collection = CollectionModel::query()->create([
                'dealer_id' => $customer->dealer_id,
                'customer_id' => $customer->id,
                'source_system' => 'b2b',
                'source_reference' => $payment['reference'],
                'sync_status' => 'pending',
                'sync_error' => null,
                'last_synced_at' => null,
                'collected_by_user_id' => $payment['user_id'],
                'created_by_user_id' => $payment['user_id'],
                'date' => $date,
                'collection_date' => $date,
                'method' => 'cc',
                'amount' => $payment['amount'],
                'currency' => $payment['currency'],
                'reference_no' => $payment['reference'],
                'reference_fields' => $referenceFields,
                'note' => 'Sanal POS Tahsilatı - '.$payment['reference'],
                'meta' => $meta,
            ]);

            $this->ensureCollectionLedgerAndLogoQueue($collection, $ledgerWriter, $logoWritePublisher);
        });
    }

    private function ensureCollectionLedgerAndLogoQueue(
        CollectionModel $collection,
        LedgerWriter $ledgerWriter,
        LogoWritePublisher $logoWritePublisher
    ): void {
        if (! $collection->ledgerEntries()->exists()) {
            $meta = is_array($collection->meta) ? $collection->meta : [];

            $ledgerWriter->write([
                'dealer_id' => $collection->dealer_id,
                'customer_id' => $collection->customer_id,
                'source_system' => 'b2b',
                'source_reference' => $collection->source_reference,
                'last_synced_at' => null,
                'order_id' => null,
                'collection_id' => $collection->id,
                'date' => $collection->date ?? $collection->collection_date ?? now()->toDateString(),
                'type' => 'payment',
                'debit' => 0,
                'credit' => $collection->amount,
                'currency' => $collection->currency,
                'reference_no' => $collection->reference_no,
                'description' => $collection->note ?: 'Sanal POS Tahsilatı',
                'created_by_user_id' => $collection->created_by_user_id,
                'meta' => [
                    'source' => $meta['source'] ?? 'virtual_pos',
                    'method' => $collection->method,
                    'reference_fields' => $collection->reference_fields,
                ],
            ]);
        }

        if (! $this->shouldQueueForLogoExport($collection->customer)) {
            return;
        }

        $alreadyQueued = IntegrationSyncEvent::query()
            ->where('domain', 'collections-write')
            ->where('entity_type', CollectionModel::class)
            ->where('entity_id', $collection->id)
            ->exists();

        if (! $alreadyQueued) {
            $logoWritePublisher->queueCollectionCreate($collection->fresh(['customer']) ?? $collection);
        }
    }

    private function shouldQueueForLogoExport(?Customer $customer): bool
    {
        if (! $customer instanceof Customer) {
            return false;
        }

        if ($customer->source_reference !== null) {
            return true;
        }

        if ($customer->source_system === 'logo') {
            return true;
        }

        return $customer->source_system === 'b2b' && $customer->sync_status === 'synced';
    }

    private function nullableString(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $normalized = trim((string) $value);

        return $normalized === '' ? null : $normalized;
    }

    private function paymentGatewayUrl(string $configuredUrl): string
    {
        $configuredUrl = trim($configuredUrl);
        $parts = parse_url($configuredUrl);

        if (
            is_array($parts)
            && str_contains(Str::lower((string) ($parts['host'] ?? '')), 'ziraatbank.com.tr')
            && ! str_contains(Str::lower((string) ($parts['path'] ?? '')), 'est3dgate')
        ) {
            $scheme = $parts['scheme'] ?? 'https';
            $host = $parts['host'];

            return $scheme.'://'.$host.'/fim/est3Dgate';
        }

        if (
            is_array($parts)
            && str_contains(Str::lower((string) ($parts['host'] ?? '')), 'ziraatbank.com.tr')
            && str_contains(Str::lower((string) ($parts['path'] ?? '')), 'est3dgate')
        ) {
            $scheme = $parts['scheme'] ?? 'https';
            $host = $parts['host'];

            return $scheme.'://'.$host.'/fim/est3Dgate';
        }

        return $configuredUrl;
    }
}
