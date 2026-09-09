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
            'card_holder' => ['required', 'string', 'max:120'],
            'card_number' => ['required', 'string', 'max:24'],
            'expiry' => ['required', 'string', 'max:5'],
            'cvv' => ['required', 'string', 'max:4'],
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

        $settings = VirtualPosSettings::publicConfig($dealer);
        $amount = number_format((float) $validated['amount'], 2, '.', '');
        $currency = strtoupper($validated['currency'] ?? 'TRY');
        $reference = 'VPOS-'.now()->format('YmdHis').'-'.Str::upper(Str::random(6));

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
                'gateway_url' => $settings['gateway_url'],
                'payload' => [
                    'merchant_no' => $settings['merchant_no'],
                    'username' => $settings['username'],
                    'reference' => $reference,
                    'amount' => $amount,
                    'currency' => $currency,
                    'installment' => (int) $validated['installment'],
                    'customer_code' => $customer->code,
                    'customer_title' => $customer->name,
                    'description' => $validated['description'] ?? '',
                ],
            ],
        ]);
    }
}
