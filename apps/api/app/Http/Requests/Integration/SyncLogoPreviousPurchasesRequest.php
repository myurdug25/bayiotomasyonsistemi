<?php

namespace App\Http\Requests\Integration;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\Exceptions\HttpResponseException;

class SyncLogoPreviousPurchasesRequest extends FormRequest
{
    public function authorize(): bool
    {
        $configuredKey = trim((string) config('integrations.logo.previous_purchase_sync_key', ''));
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
            'dealer_id' => ['nullable', 'integer', 'min:1', 'exists:dealers,id'],
            'records' => ['required', 'array', 'max:5000'],
            'records.*.customer_code' => ['required', 'string', 'max:64'],
            'records.*.product_code' => ['required', 'string', 'max:64'],
            'records.*.source_database' => ['nullable', 'string', 'max:64'],
            'records.*.external_ref' => ['required', 'string', 'max:191'],
            'records.*.date' => ['nullable', 'date'],
            'records.*.description' => ['nullable', 'string', 'max:255'],
            'records.*.document_no' => ['nullable', 'string', 'max:64'],
            'records.*.quantity' => ['nullable', 'numeric'],
            'records.*.unit' => ['nullable', 'string', 'max:16'],
            'records.*.unit_price' => ['nullable', 'numeric'],
            'records.*.net_price' => ['nullable', 'numeric'],
            'records.*.discounts' => ['nullable', 'array', 'max:5'],
            'records.*.discounts.*' => ['numeric'],
            'records.*.gross_total' => ['nullable', 'numeric'],
            'records.*.net_total' => ['nullable', 'numeric'],
        ];
    }

    protected function failedAuthorization(): void
    {
        throw new HttpResponseException(response()->json([
            'message' => 'Unauthorized integration request.',
        ], 401));
    }
}
