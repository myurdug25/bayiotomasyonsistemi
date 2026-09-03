<?php

namespace App\Http\Requests\Integration;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Validation\Rule;

class SyncLogoProductsRequest extends FormRequest
{
    public function authorize(): bool
    {
        $configuredKey = trim((string) config('integrations.logo.product_sync_key', ''));
        $providedKey = trim((string) $this->header('X-Integration-Key', ''));

        return $configuredKey !== '' && $providedKey !== '' && hash_equals($configuredKey, $providedKey);
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'mode' => ['nullable', Rule::in(['catalog', 'stock_only', 'images_only'])],
            'stock_only' => ['nullable', 'boolean'],
            'sync_run_id' => ['nullable', 'string', 'max:128'],
            'is_full_sync' => ['nullable', 'boolean'],
            'is_final_batch' => ['nullable', 'boolean'],
            'batch_index' => ['nullable', 'integer', 'min:0'],
            'batch_count' => ['nullable', 'integer', 'min:1'],
            'source_table' => ['nullable', 'string', 'max:191'],
            'price_list_id' => ['nullable', 'integer', 'exists:price_lists,id'],
            'price_list_code' => ['nullable', 'string', 'max:8', Rule::exists('price_lists', 'code')],
            'records' => ['required', 'array', 'min:1', 'max:1000'],
            'records.*.external_ref' => ['nullable', 'string', 'max:128'],
            'records.*.sku' => ['required', 'string', 'max:128'],
            'records.*.oem_code' => ['nullable', 'string', 'max:255'],
            'records.*.name' => ['required_unless:mode,stock_only,images_only', 'string', 'max:255'],
            'records.*.description' => ['nullable', 'string', 'max:10000'],
            'records.*.unit' => ['nullable', 'string', 'max:16'],
            'records.*.vat_rate' => ['nullable', 'numeric', 'min:0', 'max:999.99'],
            'records.*.weight_kg' => ['nullable', 'numeric', 'min:0'],
            'records.*.is_active' => ['nullable', 'boolean'],
            'records.*.brand_code' => ['nullable', 'string', 'max:128'],
            'records.*.brand_name' => ['nullable', 'string', 'max:255'],
            'records.*.brand_is_active' => ['nullable', 'boolean'],
            'records.*.category_code' => ['nullable', 'string', 'max:128'],
            'records.*.category_name' => ['nullable', 'string', 'max:255'],
            'records.*.category_is_active' => ['nullable', 'boolean'],
            'records.*.available_total' => ['nullable', 'integer'],
            'records.*.reserved_total' => ['nullable', 'integer', 'min:0'],
            'records.*.price_list_id' => ['nullable', 'integer', 'exists:price_lists,id'],
            'records.*.price_list_code' => ['nullable', 'string', 'max:8', Rule::exists('price_lists', 'code')],
            'records.*.list_price' => ['nullable', 'numeric', 'min:0'],
            'records.*.currency' => ['nullable', 'string', 'size:3'],
            'records.*.price_entries' => ['sometimes', 'array', 'max:12'],
            'records.*.price_entries.*.price_list_code' => [
                'required',
                'string',
                'max:8',
                'regex:/^(?:F(?:[1-9]|1[0-2])|PRK|PERAK)$/',
            ],
            'records.*.price_entries.*.list_price' => ['required', 'numeric', 'min:0'],
            'records.*.price_entries.*.currency' => ['nullable', 'string', 'size:3'],
            'records.*.campaign_prices' => ['sometimes', 'array', 'max:100'],
            'records.*.campaign_prices.*.source_reference' => ['required', 'string', 'max:128'],
            'records.*.campaign_prices.*.campaign_key' => ['required', 'string', 'max:191'],
            'records.*.campaign_prices.*.name' => ['required', 'string', 'max:255'],
            'records.*.campaign_prices.*.condition' => ['nullable', 'string', 'max:255'],
            'records.*.campaign_prices.*.min_quantity' => ['required', 'integer', 'min:1', 'max:1000000'],
            'records.*.campaign_prices.*.unit_price' => ['required', 'numeric', 'min:0'],
            'records.*.campaign_prices.*.currency' => ['nullable', 'string', 'size:3'],
            'records.*.campaign_prices.*.priority' => ['nullable', 'integer'],
            'records.*.campaign_prices.*.branch' => ['nullable', 'integer'],
            'records.*.campaign_prices.*.starts_at' => ['nullable', 'date'],
            'records.*.campaign_prices.*.ends_at' => ['nullable', 'date'],
            'records.*.campaign_prices.*.is_active' => ['nullable', 'boolean'],
            'records.*.campaign_prices.*.meta' => ['nullable', 'array'],
            'records.*.code_aliases' => ['sometimes', 'array', 'max:1000'],
            'records.*.code_aliases.*.code' => ['required', 'string', 'max:255'],
            'records.*.code_aliases.*.type' => ['nullable', Rule::in(['oem', 'competitor', 'equivalent', 'other'])],
            'records.*.code_aliases.*.brand_name' => ['nullable', 'string', 'max:255'],
            'records.*.code_aliases.*.meta' => ['nullable', 'array'],
            'records.*.meta' => ['nullable', 'array'],
        ];
    }

    protected function failedAuthorization(): void
    {
        throw new HttpResponseException(response()->json([
            'message' => 'Unauthorized integration request.',
        ], 401));
    }
}
