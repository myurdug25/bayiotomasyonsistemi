<?php

namespace App\Http\Requests\Integration;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Validation\Rule;

class ListPendingLogoPosDayEndsRequest extends FormRequest
{
    public function authorize(): bool
    {
        $configuredKey = trim((string) config('integrations.logo.pos_day_end_sync_key', config('integrations.logo.pos_expense_sync_key', '')));
        $providedKey = trim((string) $this->header('X-Integration-Key', ''));

        return $configuredKey !== '' && $providedKey !== '' && hash_equals($configuredKey, $providedKey);
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'limit' => ['nullable', 'integer', 'min:1', 'max:500'],
            'statuses' => ['nullable', 'array', 'min:1', 'max:3'],
            'statuses.*' => ['string', Rule::in(['queued', 'failed'])],
        ];
    }

    protected function failedAuthorization(): void
    {
        throw new HttpResponseException(response()->json([
            'message' => 'Unauthorized integration request.',
        ], 401));
    }
}
