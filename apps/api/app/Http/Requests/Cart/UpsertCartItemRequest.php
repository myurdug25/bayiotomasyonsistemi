<?php

namespace App\Http\Requests\Cart;

use Illuminate\Foundation\Http\FormRequest;

class UpsertCartItemRequest extends FormRequest
{
    protected function prepareForValidation(): void
    {
        if ($this->filled('qty') && ! $this->filled('quantity')) {
            $this->merge([
                'quantity' => $this->input('qty'),
            ]);
        }
    }

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
            'product_id' => ['required', 'integer', 'exists:products,id'],
            'qty' => ['nullable', 'integer', 'min:1'],
            'quantity' => ['required', 'integer', 'min:1'],
            'discount' => ['nullable', 'numeric', 'min:0', 'max:100'],
            'campaign_key' => ['nullable', 'string', 'max:191'],
            'shipping_method' => ['nullable', 'string', 'max:120'],
            'warehouse_transfer' => ['nullable', 'boolean'],
            'order_note' => ['nullable', 'string', 'max:2000'],
            'customer_id' => ['nullable', 'integer', 'exists:customers,id'],
            'dealer_id' => ['nullable', 'integer', 'exists:dealers,id'],
        ];
    }
}
