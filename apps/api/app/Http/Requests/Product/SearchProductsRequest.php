<?php

namespace App\Http\Requests\Product;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class SearchProductsRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'q' => ['nullable', 'string', 'max:120'],
            'brand_id' => ['nullable', 'integer', 'exists:brands,id'],
            'category_id' => ['nullable', 'integer', 'exists:categories,id'],
            'kod1' => ['nullable', 'string', 'max:64'],
            'kod2' => ['nullable', 'string', 'max:64'],
            'kod3' => ['nullable', 'string', 'max:64'],
            'specode4' => ['nullable', 'string', 'max:64'],
            'specode5' => ['nullable', 'string', 'max:64'],
            'stok_turu' => ['nullable', 'string', 'max:32'],
            'vehicle_id' => ['nullable', 'integer', 'exists:vehicles,id'],
            'dealer_id' => ['nullable', 'integer', 'exists:dealers,id'],
            'customer_id' => ['nullable', 'integer', 'exists:customers,id'],
            'in_stock' => ['nullable', 'boolean'],
            'include_equivalents' => ['nullable', 'boolean'],
            'sort' => ['nullable', Rule::in(['price_asc', 'price_desc', 'stock_desc'])],
            'cursor' => ['nullable', 'string'],
            'page' => ['nullable', 'integer', 'min:1', 'max:10000'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:50'],
        ];
    }
}
