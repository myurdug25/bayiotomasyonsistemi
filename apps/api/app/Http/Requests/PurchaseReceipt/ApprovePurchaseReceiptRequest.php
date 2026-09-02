<?php

namespace App\Http\Requests\PurchaseReceipt;

use Illuminate\Foundation\Http\FormRequest;

class ApprovePurchaseReceiptRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'items' => ['nullable', 'array', 'min:1', 'max:250'],
            'items.*.id' => ['required_with:items', 'integer', 'distinct'],
            'items.*.accepted_quantity' => ['required_with:items', 'integer', 'min:0', 'max:999999'],
        ];
    }
}
