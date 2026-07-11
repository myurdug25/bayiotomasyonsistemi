<?php

namespace App\Http\Requests\Warehouse;

use Illuminate\Foundation\Http\FormRequest;

class CreateShipmentRequest extends FormRequest
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
            'order_id' => ['required', 'integer', 'exists:orders,id'],
            'warehouse_id' => ['nullable', 'integer'],
            'warehouse_code' => ['nullable', 'string', 'max:64'],
            'warehouse_name' => ['nullable', 'string', 'max:160'],
            'assigned_user_id' => ['nullable', 'integer', 'exists:users,id'],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'order_id.required' => 'Siparis secimi zorunlu.',
            'order_id.exists' => 'Siparis bulunamadi.',
            'warehouse_id.integer' => 'Depo secimi gecersiz.',
            'assigned_user_id.integer' => 'Depocu secimi gecersiz.',
            'assigned_user_id.exists' => 'Secilen depocu bulunamadi.',
        ];
    }
}
