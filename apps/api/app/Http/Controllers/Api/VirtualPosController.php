<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Customer;
use App\Models\User;
use App\Support\VirtualPosSettings;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
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
        $reference = 'VPOS-'.now()->format('YmdHis').'-'.Str::upper(Str::random(6));
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
            'merchant_no' => $settings['merchant_no'],
            'username' => $settings['username'],
            'oid' => $reference,
            'reference' => $reference,
            'amount' => $amount,
            'currency' => $currencyCode,
            'currency_alpha' => $currency,
            'installment' => $installment,
            'taksit' => $installmentValue,
            'okUrl' => $okUrl,
            'failUrl' => $failUrl,
            'islemtipi' => $transactionType,
            'storetype' => '3d_pay_hosting',
            'lang' => 'tr',
            'rnd' => $rnd,
            'hashAlgorithm' => 'ver3',
            'encoding' => 'UTF-8',
            'customer_code' => $customer->code,
            'customer_title' => $customer->name,
            'description' => $validated['description'] ?? '',
            'firmaadi' => 'PowerSA B2B',
            'refreshtime' => '5',
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
            ],
        ]);
    }

    public function callback(Request $request, string $result): RedirectResponse
    {
        $status = $result === 'success' ? 'success' : 'fail';
        $reference = (string) ($request->input('oid') ?: $request->input('ReturnOid') ?: $request->input('reference') ?: '');
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
