<?php

namespace App\Http\Requests\Order;

use Illuminate\Foundation\Http\FormRequest;

class CreateOrderRequest extends FormRequest
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
            'cart_id' => ['nullable', 'integer', 'exists:carts,id'],
            'customer_id' => ['nullable', 'integer', 'exists:customers,id'],
            'dealer_id' => ['nullable', 'integer', 'exists:dealers,id'],
            'note' => ['nullable', 'string', 'max:2000'],
            'checkout_summary_mode' => ['nullable', 'string', 'in:detailed,excluded,included'],
            'payment_method' => ['nullable', 'string', 'max:64'],
            'sales_price_type' => ['nullable', 'string', 'max:64'],
        ];
    }
}
