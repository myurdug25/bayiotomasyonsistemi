<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\FinanceDefinition;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class FinanceDefinitionController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'type' => ['nullable', Rule::in(FinanceDefinition::TYPES)],
            'include_inactive' => ['nullable', 'boolean'],
        ]);

        $query = FinanceDefinition::query()
            ->when($validated['type'] ?? null, fn ($q, $type) => $q->where('type', $type))
            ->when(! ($validated['include_inactive'] ?? false), fn ($q) => $q
                ->where('is_active', true)
                ->where(function ($definitionQuery): void {
                    $definitionQuery->where('type', '!=', 'bank')
                        ->orWhere(fn ($bankQuery) => $this->applyTurkeyBankScope($bankQuery));
                }))
            ->orderBy('type')
            ->orderBy('sort_order')
            ->orderBy('name');

        return response()->json(['data' => $query->get()]);
    }

    public function store(Request $request): JsonResponse
    {
        $definition = FinanceDefinition::query()->create($this->validatedPayload($request));

        return response()->json(['data' => $definition], 201);
    }

    public function update(Request $request, FinanceDefinition $financeDefinition): JsonResponse
    {
        $financeDefinition->fill($this->validatedPayload($request, $financeDefinition))->save();

        return response()->json(['data' => $financeDefinition->fresh()]);
    }

    private function validatedPayload(Request $request, ?FinanceDefinition $definition = null): array
    {
        return $request->validate([
            'type' => ['required', Rule::in(FinanceDefinition::TYPES)],
            'code' => [
                'required',
                'string',
                'max:64',
                Rule::unique('finance_definitions', 'code')
                    ->where(fn ($q) => $q->where('type', $request->input('type')))
                    ->ignore($definition?->id),
            ],
            'name' => ['required', 'string', 'max:180'],
            'logo_code' => ['nullable', 'string', 'max:64'],
            'logo_name' => ['nullable', 'string', 'max:180'],
            'meta' => ['nullable', 'array'],
            'sort_order' => ['nullable', 'integer', 'min:0'],
            'is_active' => ['required', 'boolean'],
        ]);
    }

    private function applyTurkeyBankScope($query): void
    {
        $blockedTerms = [
            'batum',
            'georgia',
            'gürcistan',
            'gurcistan',
            'yurtdışı',
            'yurtdisi',
            'tbc',
        ];

        $query->whereNotIn('code', ['georgia_bank', 'tbc_bank']);

        foreach ($blockedTerms as $term) {
            $like = '%'.$term.'%';
            $query
                ->whereRaw('LOWER(COALESCE(code, \'\')) NOT LIKE ?', [$like])
                ->whereRaw('LOWER(COALESCE(name, \'\')) NOT LIKE ?', [$like])
                ->whereRaw('LOWER(COALESCE(logo_code, \'\')) NOT LIKE ?', [$like])
                ->whereRaw('LOWER(COALESCE(logo_name, \'\')) NOT LIKE ?', [$like]);
        }
    }
}
