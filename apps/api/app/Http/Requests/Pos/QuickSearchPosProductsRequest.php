<?php

namespace App\Http\Requests\Pos;

use Illuminate\Foundation\Http\FormRequest;

class QuickSearchPosProductsRequest extends FormRequest
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
            'q' => ['required', 'string', 'min:2', 'max:120'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:20'],
            'dealer_id' => ['nullable', 'integer', 'exists:dealers,id'],
            'customer_id' => ['nullable', 'integer', 'exists:customers,id'],
            'in_stock' => ['nullable', 'boolean'],
            'code_only' => ['nullable', 'boolean'],
        ];
    }
}
