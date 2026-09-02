<?php

namespace App\Http\Requests\Integration;

use Closure;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\Exceptions\HttpResponseException;

class SyncLogoCampaignsRequest extends FormRequest
{
    public function authorize(): bool
    {
        $configuredKey = trim((string) config('integrations.logo.product_sync_key', ''));
        $providedKey = trim((string) $this->header('X-Integration-Key', ''));

        return $configuredKey !== ''
            && $providedKey !== ''
            && hash_equals($configuredKey, $providedKey);
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'campaigns' => ['required', 'array', 'max:1000'],
            'campaigns.*.source_reference' => ['required', 'string', 'max:128'],
            'campaigns.*.code' => ['required', 'string', 'max:64'],
            'campaigns.*.name' => ['required', 'string', 'max:255'],
            'campaigns.*.description' => ['nullable', 'string', 'max:500'],
            'campaigns.*.customer_group' => ['required', 'string', 'max:128'],
            'campaigns.*.target_quantity' => ['required', 'integer', 'min:1'],
            'campaigns.*.group_field' => ['nullable', 'string', 'max:32'],
            'campaigns.*.starts_at' => ['nullable', 'date'],
            'campaigns.*.ends_at' => ['nullable', 'date'],
            'campaigns.*.is_active' => ['boolean'],
            'campaigns.*.meta' => ['nullable', 'array'],
            'campaigns.*.discount_percent' => ['nullable', 'numeric', 'min:0', 'max:100'],
            'campaigns.*.products' => [
                'present',
                'array',
                'max:50000',
                function (string $attribute, mixed $products, Closure $fail): void {
                    $campaignIndex = explode('.', $attribute)[1] ?? null;
                    $campaign = is_numeric($campaignIndex)
                        ? ($this->input("campaigns.{$campaignIndex}") ?? [])
                        : [];
                    $isActive = filter_var($campaign['is_active'] ?? true, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE) ?? true;

                    if ($isActive && is_array($products) && count($products) < 1) {
                        $fail("{$attribute} aktif kampanyalar için en az bir ürün kodu içermelidir.");

                        return;
                    }

                    foreach ($products as $sku) {
                        if (! is_string($sku) || mb_strlen($sku) > 191) {
                            $fail("{$attribute} yalnızca en fazla 191 karakterlik ürün kodları içerebilir.");

                            return;
                        }
                    }
                },
            ],
        ];
    }

    protected function failedAuthorization(): void
    {
        throw new HttpResponseException(response()->json([
            'message' => 'Unauthorized integration request.',
        ], 401));
    }
}
