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
            'records.*.type' => ['required', 'in:factory,bank,pos_device,card_type'],
            'records.*.code' => ['required', 'string', 'max:64'],
            'records.*.logo_code' => ['nullable', 'string', 'max:64'],
            'records.*.name' => ['required', 'string', 'max:180'],
            'records.*.source_table' => ['nullable', 'string', 'max:128'],
            'records.*.is_active' => ['nullable', 'boolean'],
            'records.*.meta' => ['nullable', 'array'],
            'full_snapshot_types' => ['nullable', 'array'],
            'full_snapshot_types.*' => ['string', 'in:bank,pos_device,card_type'],
        ];
    }

    protected function failedAuthorization(): void
    {
        throw new HttpResponseException(response()->json([
            'message' => 'Unauthorized integration request.',
        ], 401));
    }
}
