<?php

namespace App\Http\Requests\Customer;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class CustomerCollectionIndexRequest extends FormRequest
{
    protected function prepareForValidation(): void
    {
        $method = $this->input('method');

        $this->merge([
            'method' => is_string($method) ? strtolower($method) : $method,
        ]);
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
            'method' => ['nullable', Rule::in(['cash', 'transfer', 'check', 'note', 'cc', 'factory_cc', 'invoice'])],
            'date_from' => ['nullable', 'date'],
            'date_to' => ['nullable', 'date', 'after_or_equal:date_from'],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:50'],
            'include_summary' => ['nullable', 'boolean'],
            'compact' => ['nullable', 'boolean'],
        ];
    }
}
