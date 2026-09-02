<?php

namespace App\Http\Requests\Pos;

use Illuminate\Foundation\Http\FormRequest;

class StorePosExpenseRequest extends FormRequest
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
            'pos_session_id' => ['nullable', 'integer', 'exists:pos_sessions,id'],
            'finance_definition_id' => ['nullable', 'integer', 'exists:finance_definitions,id'],
            'amount' => ['required', 'numeric', 'gt:0'],
            'category' => ['required', 'string', 'max:80'],
            'logo_expense_account_code' => ['nullable', 'string', 'max:64'],
            'logo_expense_account_name' => ['nullable', 'string', 'max:180'],
            'note' => ['nullable', 'string', 'max:255'],
            'expense_date' => ['nullable', 'date'],
            'meta' => ['nullable', 'array'],
        ];
    }
}
