<?php

namespace App\Http\Requests\Integration;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\Exceptions\HttpResponseException;

class SyncLogoPosDeliveryBalancesRequest extends FormRequest
{
    public function authorize(): bool
    {
        $configuredKey = trim((string) config('integrations.logo.pos_sale_sync_key', ''));
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
            'dealer_id' => ['nullable', 'integer', 'min:1'],
            'records' => ['required', 'array', 'max:10000'],
            'records.*.warehouse_no' => ['required', 'integer', 'min:0', 'max:999'],
            'records.*.customer_ref' => ['nullable', 'integer', 'min:1'],
            'records.*.count' => ['required', 'integer', 'min:0'],
            'records.*.amount' => ['required', 'numeric', 'min:0'],
        ];
    }

    protected function failedAuthorization(): void
    {
        throw new HttpResponseException(response()->json([
            'message' => 'Unauthorized integration request.',
        ], 401));
    }
}
