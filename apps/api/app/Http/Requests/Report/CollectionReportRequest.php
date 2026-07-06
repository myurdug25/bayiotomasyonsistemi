<?php

namespace App\Http\Requests\Report;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class CollectionReportRequest extends FormRequest
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
            'dealer_id' => ['nullable', 'integer', 'exists:dealers,id'],
            'customer_id' => ['nullable', 'integer', 'exists:customers,id'],
            'collector_id' => ['nullable', 'integer', 'exists:users,id'],
            'date_from' => ['nullable', 'date'],
            'date_to' => ['nullable', 'date', 'after_or_equal:date_from'],
            'method' => ['nullable', Rule::in(['cash', 'transfer', 'check', 'note', 'cc', 'factory_cc'])],
            'q' => ['nullable', 'string', 'max:120'],
            'top' => ['nullable', 'integer', Rule::in([10, 20, 50])],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:100'],
            'async' => ['nullable', 'boolean'],
        ];
    }
}
