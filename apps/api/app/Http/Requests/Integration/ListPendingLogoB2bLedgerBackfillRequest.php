<?php

namespace App\Http\Requests\Integration;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Validation\Rule;

class ListPendingLogoB2bLedgerBackfillRequest extends FormRequest
{
    public function authorize(): bool
    {
        $configuredKey = trim((string) config('integrations.logo.collection_sync_key', ''));
        $providedKey = trim((string) $this->header('X-Integration-Key', ''));

        return $configuredKey !== '' && $providedKey !== '' && hash_equals($configuredKey, $providedKey);
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'dealer_id' => ['nullable', 'integer', 'exists:dealers,id'],
            'dealer_code' => ['nullable', 'string', 'max:64', Rule::exists('dealers', 'code')],
            'customer_code' => ['nullable', 'string', 'max:64'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:500'],
        ];
    }

    protected function failedAuthorization(): void
    {
        throw new HttpResponseException(response()->json([
            'message' => 'Unauthorized integration request.',
        ], 401));
    }
}
