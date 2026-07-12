<?php

namespace App\Http\Requests\CustomerCardRequest;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreCustomerCardRequest extends FormRequest
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
            'dealer_id' => ['nullable', 'integer', 'exists:dealers,id'],
            'salesperson_user_id' => ['nullable', 'integer', 'exists:users,id'],
            'company_name' => ['required', 'string', 'max:160'],
            'contact_name' => ['required', 'string', 'max:120'],
            'phone' => ['required', 'string', 'regex:/^05\d{9}$/'],
            'email' => ['nullable', 'email', 'max:255'],
            'customer_kind' => ['nullable', 'string', Rule::in(['person', 'company'])],
            'logo_special_code' => ['nullable', 'string', Rule::in(['F1', 'F2', 'F3'])],
            'logo_authorization_code' => ['nullable', 'string', 'max:64'],
            'auto_convert' => ['sometimes', 'boolean'],
            'city' => ['required', 'string', 'max:120'],
            'district' => ['required', 'string', 'max:120'],
            'tax_office' => ['required_if:customer_kind,company', 'nullable', 'string', 'max:120'],
            'tax_number' => [
                'required_if:customer_kind,company',
                'nullable',
                'string',
                'max:40',
                function (string $attribute, mixed $value, \Closure $fail): void {
                    if ($this->input('customer_kind') === 'person' && ! preg_match('/^\d{11}$/', (string) $value)) {
                        $fail('TC Kimlik numarası hatalı.');
                    }
                },
            ],
            'address' => ['nullable', 'string', 'max:1000'],
            'note' => ['nullable', 'string', 'max:1000'],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'phone.regex' => 'Telefon numarası hatalı.',
            'district.required' => 'İlçe seçimi zorunlu.',
            'tax_number.required_if' => 'Vergi no zorunlu.',
        ];
    }
}
