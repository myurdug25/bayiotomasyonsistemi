<?php

namespace App\Http\Requests\Integration;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\Exceptions\HttpResponseException;

class SyncLogoFinanceDefinitionsRequest extends FormRequest
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
            'records' => ['required', 'array', 'max:5000'],
            'records.*.type' => ['required', 'in:factory,bank,cashbox,pos_device,card_type'],
            'records.*.code' => ['required', 'string', 'max:64'],
            'records.*.logo_code' => ['nullable', 'string', 'max:64'],
            'records.*.name' => ['required', 'string', 'max:180'],
            'records.*.source_table' => ['nullable', 'string', 'max:128'],
            'records.*.is_active' => ['nullable', 'boolean'],
            'records.*.balance' => ['nullable', 'numeric'],
            'records.*.balance_debit' => ['nullable', 'numeric'],
            'records.*.balance_credit' => ['nullable', 'numeric'],
            'records.*.balance_direction' => ['nullable', 'string', 'max:16'],
            'records.*.currency' => ['nullable', 'string', 'max:8'],
            'records.*.meta' => ['nullable', 'array'],
            'full_snapshot_types' => ['nullable', 'array'],
            'full_snapshot_types.*' => ['string', 'in:bank,cashbox,pos_device,card_type'],
        ];
    }

    protected function failedAuthorization(): void
    {
        throw new HttpResponseException(response()->json([
            'message' => 'Unauthorized integration request.',
        ], 401));
    }
}
