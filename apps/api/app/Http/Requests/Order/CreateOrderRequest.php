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
            'item_checkout_summary_modes' => ['nullable', 'array'],
            'item_checkout_summary_modes.*' => ['nullable', 'string', 'in:detailed,excluded,included'],
            'checkout_grand_total' => ['nullable', 'numeric', 'min:0'],
            'shipping_fee_amount' => ['nullable', 'numeric', 'min:0'],
            'selected_product_ids' => ['nullable', 'array'],
            'selected_product_ids.*' => ['integer', 'min:1'],
            'payment_method' => ['nullable', 'string', 'max:64'],
            'sales_price_type' => ['nullable', 'string', 'max:64'],
            'warehouse_transfer_request' => ['nullable', 'boolean'],
            'shipping_target_warehouse_code' => ['nullable', 'string', 'max:64'],
            'shipping_target_warehouse_name' => ['nullable', 'string', 'max:160'],
            'transfer_source_warehouse_code' => ['nullable', 'string', 'max:64'],
            'transfer_source_warehouse_name' => ['nullable', 'string', 'max:160'],
            'transfer_target_warehouse_code' => ['nullable', 'string', 'max:64'],
            'transfer_target_warehouse_name' => ['nullable', 'string', 'max:160'],
        ];
    }
}
