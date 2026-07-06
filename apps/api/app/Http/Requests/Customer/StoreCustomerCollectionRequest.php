<?php

namespace App\Http\Requests\Customer;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreCustomerCollectionRequest extends FormRequest
{
    protected function prepareForValidation(): void
    {
        $method = $this->input('method');

        $this->merge([
            'method' => is_string($method) ? strtolower($method) : $method,
        ]);

        if ($this->filled('collection_date') && ! $this->filled('date')) {
            $this->merge(['date' => $this->input('collection_date')]);
        }

        if ($this->filled('meta') && ! $this->filled('reference_fields')) {
            $this->merge(['reference_fields' => $this->input('meta')]);
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
            'date' => ['nullable', 'date'],
            'collection_date' => ['nullable', 'date'],
            'method' => ['required', Rule::in(['cash', 'transfer', 'check', 'note', 'cc'])],
            'amount' => ['required', 'numeric', 'gt:0'],
            'currency' => ['nullable', 'string', 'size:3'],
            'reference_no' => ['nullable', 'string', 'max:120'],
            'note' => ['nullable', 'string', 'max:2000'],
            'reference_fields' => ['nullable', 'array'],
            'reference_fields.bank_name' => [
                Rule::requiredIf(fn () => (string) $this->input('method') === 'check'),
                'string',
                'max:120',
            ],
            'reference_fields.transfer_no' => [
                'nullable',
                'string',
                'max:120',
            ],
            'reference_fields.iban' => [
                'nullable',
                'string',
                'max:64',
            ],
            'reference_fields.check_no' => [
                Rule::requiredIf(fn () => (string) $this->input('method') === 'check'),
                'string',
                'max:64',
            ],
            'reference_fields.due_date' => [
                Rule::requiredIf(fn () => in_array((string) $this->input('method'), ['check', 'note'], true)),
                'date',
            ],
            'reference_fields.valor_days' => [
                Rule::requiredIf(fn () => (string) $this->input('method') === 'check'),
                'integer',
                'min:0',
            ],
            'reference_fields.requires_manager_approval' => ['nullable'],
            'reference_fields.manager_approval_reason' => ['nullable', 'string', 'max:120'],
            'reference_fields.note_no' => [
                Rule::requiredIf(fn () => (string) $this->input('method') === 'note'),
                'string',
                'max:64',
            ],
            'reference_fields.image_data' => ['nullable', 'string'],
            'reference_fields.image_name' => ['nullable', 'string', 'max:180'],
            'reference_fields.image_type' => ['nullable', 'string', 'max:80'],
            'reference_fields.images_json' => ['nullable', 'string'],
            'reference_fields.collection_channel' => [
                'nullable',
                Rule::in(['factory', 'physical_pos']),
            ],
            'reference_fields.factory_name' => [
                'nullable',
                'string',
                'max:160',
            ],
            'reference_fields.pos_bank' => [
                Rule::requiredIf(fn () => (string) $this->input('method') === 'cc'
                    && (string) $this->input('reference_fields.collection_channel') !== 'factory'),
                'string',
                'max:64',
            ],
            'reference_fields.pos_device' => ['nullable', 'string', 'max:64'],
            'reference_fields.card_type' => ['nullable', 'string', 'max:64'],
            'reference_fields.commission_rate' => ['nullable', 'numeric', 'min:0', 'max:100'],
            'reference_fields.factory_pos_account' => [
                Rule::requiredIf(fn () => (string) $this->input('method') === 'cc'
                    && (string) $this->input('reference_fields.collection_channel') === 'factory'),
                'string',
                'max:64',
            ],
            'reference_fields.pos_payment_type' => [
                'nullable',
                Rule::in(['pesin', 'taksitli']),
            ],
            'reference_fields.card_holder' => [
                'nullable',
                'string',
                'max:120',
            ],
            'reference_fields.masked_pan' => [
                'nullable',
                'string',
                'max:32',
            ],
            'reference_fields.auth_code' => [
                'nullable',
                'string',
                'max:64',
            ],
            'reference_fields.installment' => [
                'nullable',
                'integer',
                'min:1',
                'max:6',
            ],
            'reference_fields.bank_code' => [
                Rule::requiredIf(fn () => (string) $this->input('method') === 'transfer'),
                'string',
                'max:64',
            ],
            'meta' => ['nullable', 'array'],
        ];
    }
}
