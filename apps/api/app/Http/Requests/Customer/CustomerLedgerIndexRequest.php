<?php

namespace App\Http\Requests\Customer;

use Illuminate\Foundation\Http\FormRequest;

class CustomerLedgerIndexRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    protected function prepareForValidation(): void
    {
        $excludeTypes = $this->input('exclude_types');

        if (is_string($excludeTypes)) {
            $this->merge([
                'exclude_types' => array_values(array_filter(array_map('trim', explode(',', $excludeTypes)))),
            ]);

            return;
        }

        if ($excludeTypes !== null && ! is_array($excludeTypes)) {
            $this->merge([
                'exclude_types' => [$excludeTypes],
            ]);
        }
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'date_from' => ['nullable', 'date'],
            'date_to' => ['nullable', 'date', 'after_or_equal:date_from'],
            'from_date' => ['nullable', 'date'],
            'to_date' => ['nullable', 'date', 'after_or_equal:from_date'],
            'type' => ['nullable', 'in:order,invoice,payment,return,credit,debit'],
            'collection_method' => ['nullable', 'in:cash,transfer,check,note,cc,factory_cc'],
            'exclude_types' => ['nullable', 'array'],
            'exclude_types.*' => ['in:order,invoice,payment,return,credit,debit'],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:50'],
        ];
    }
}
