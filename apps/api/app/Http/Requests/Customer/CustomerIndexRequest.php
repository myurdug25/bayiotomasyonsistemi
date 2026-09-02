<?php

namespace App\Http\Requests\Customer;

use Illuminate\Foundation\Http\FormRequest;

class CustomerIndexRequest extends FormRequest
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
            'search' => ['nullable', 'string', 'max:120'],
            'has_cart' => ['nullable', 'boolean'],
            'has_order_balance' => ['nullable', 'boolean'],
            'has_balance_due' => ['nullable', 'boolean'],
            'source_system' => ['nullable', 'string', 'in:logo,b2b'],
            'specode4' => ['nullable', 'string', 'max:120'],
            'price_group' => ['nullable', 'string', 'max:32'],
            'selection_mode' => ['nullable', 'boolean'],
            'fast' => ['nullable', 'boolean'],
            'summary' => ['nullable', 'string', 'in:count'],
            'cursor' => ['nullable', 'string', 'max:512'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:50'],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:50'],
        ];
    }
}
