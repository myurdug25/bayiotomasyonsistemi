<?php

namespace App\Http\Requests\Integration;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Validation\Rule;

class SyncLogoCustomersRequest extends FormRequest
{
    public function authorize(): bool
    {
        $configuredKey = trim((string) config('integrations.logo.customer_sync_key', ''));
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
            'sync_run_id' => ['nullable', 'string', 'max:128'],
            'is_full_sync' => ['nullable', 'boolean'],
            'is_final_batch' => ['nullable', 'boolean'],
            'batch_index' => ['nullable', 'integer', 'min:0'],
            'batch_count' => ['nullable', 'integer', 'min:1'],
            'source_table' => ['nullable', 'string', 'max:191'],
            'records' => ['required', 'array', 'min:1', 'max:1000'],
            'records.*.dealer_id' => ['nullable', 'integer', 'exists:dealers,id'],
            'records.*.dealer_code' => ['nullable', 'string', 'max:64', Rule::exists('dealers', 'code')],
            'records.*.external_ref' => ['nullable', 'string', 'max:128'],
            'records.*.code' => ['required', 'string', 'max:64'],
            'records.*.name' => ['required', 'string', 'max:255'],
            'records.*.contact_name' => ['nullable', 'string', 'max:255'],
            'records.*.email' => ['nullable', 'email', 'max:255'],
            'records.*.phone' => ['nullable', 'string', 'max:32'],
            'records.*.city' => ['nullable', 'string', 'max:120'],
            'records.*.district' => ['nullable', 'string', 'max:120'],
            'records.*.tax_office' => ['nullable', 'string', 'max:255'],
            'records.*.tax_number' => ['nullable', 'string', 'max:32'],
            'records.*.credit_limit' => ['nullable', 'numeric', 'min:0'],
            'records.*.balance_due' => ['nullable', 'numeric'],
            'records.*.balance_debit' => ['nullable', 'numeric'],
            'records.*.balance_credit' => ['nullable', 'numeric'],
            'records.*.balance_direction' => ['nullable', 'string', 'max:16'],
            'records.*.order_due' => ['nullable', 'numeric'],
            'records.*.currency' => ['nullable', 'string', 'size:3'],
            'records.*.is_active' => ['nullable', 'boolean'],
            'records.*.address' => ['nullable', 'string', 'max:2000'],
            'records.*.iban' => ['nullable', 'string', 'max:64'],
            'records.*.salesperson_email' => ['nullable', 'email', 'max:255'],
            'records.*.meta' => ['nullable', 'array'],
        ];
    }

    public function withValidator($validator): void
    {
        $validator->after(function ($validator): void {
            $hasDefaultDealer = $this->filled('dealer_id') || $this->filled('dealer_code');

            if ($hasDefaultDealer) {
                return;
            }

            foreach ((array) $this->input('records', []) as $index => $record) {
                $hasDealer = ! empty($record['dealer_id']) || ! empty($record['dealer_code']);

                if (! $hasDealer) {
                    $validator->errors()->add(
                        "records.$index.dealer_id",
                        'Her cari kaydi icin dealer_id veya dealer_code gonderilmelidir.'
                    );
                }
            }
        });
    }

    protected function failedAuthorization(): void
    {
        throw new HttpResponseException(response()->json([
            'message' => 'Unauthorized integration request.',
        ], 401));
    }
}
