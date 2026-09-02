<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\FinanceDefinition;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class FinanceDefinitionController extends Controller
{
    /**
     * These are UI categories, not shared Logo accounts. PosExpenseService
     * resolves each category to the authenticated salesperson's own account.
     *
     * @var list<string>
     */
    private const STANDARD_EXPENSE_CATEGORY_CODES = [
        'vehicle_maintenance',
        'marketing',
        'fuel',
    ];

    public function index(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'type' => ['nullable', Rule::in(FinanceDefinition::TYPES)],
            'include_inactive' => ['nullable', 'boolean'],
            'scope' => ['nullable', Rule::in(['turkey', 'batum'])],
        ]);

        $scope = $validated['scope'] ?? 'turkey';
        $type = $validated['type'] ?? null;
        $user = $request->user();

        $query = FinanceDefinition::query()
            ->when($type, fn ($q, $definitionType) => $q->where('type', $definitionType))
            ->when(! ($validated['include_inactive'] ?? false), fn ($q) => $q->where('is_active', true))
            ->when(! ($validated['include_inactive'] ?? false), function ($q) use ($scope): void {
                $q->where(function ($definitionQuery) use ($scope): void {
                    $definitionQuery
                        ->where('type', '!=', 'bank')
                        ->orWhere(function ($bankQuery) use ($scope): void {
                            if ($scope === 'batum') {
                                $this->applyBatumBankScope($bankQuery);

                                return;
                            }

                            $this->applyTurkeyBankScope($bankQuery);
                        });
                });
            });

        if ($type === 'expense_category' && $user instanceof User) {
            $this->applyExpenseCategoryScope($query, $user);
        }

        $query->orderBy('type')
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

    private function applyBatumBankScope($query): void
    {
        $query->where(function ($bankQuery): void {
            foreach (['batum', 'georgia', 'gürcistan', 'gurcistan', 'tbc'] as $term) {
                $like = '%'.$term.'%';
                $bankQuery
                    ->orWhereRaw('LOWER(COALESCE(code, \'\')) LIKE ?', [$like])
                    ->orWhereRaw('LOWER(COALESCE(name, \'\')) LIKE ?', [$like])
                    ->orWhereRaw('LOWER(COALESCE(logo_code, \'\')) LIKE ?', [$like])
                    ->orWhereRaw('LOWER(COALESCE(logo_name, \'\')) LIKE ?', [$like]);
            }
        });
    }

    private function applyExpenseCategoryScope($query, User $user): void
    {
        if ($user->hasAnyRole(['admin', 'dealer_admin'])) {
            return;
        }

        if ($this->isBatumUser($user)) {
            $query->where(function ($expenseQuery): void {
                $expenseQuery->where('meta->scope', 'batum');

                foreach (['batum', 'georgia', 'gürcistan', 'gurcistan'] as $term) {
                    $like = '%'.$term.'%';
                    $expenseQuery
                        ->orWhereRaw('LOWER(COALESCE(code, \'\')) LIKE ?', [$like])
                        ->orWhereRaw('LOWER(COALESCE(name, \'\')) LIKE ?', [$like])
                        ->orWhereRaw('LOWER(COALESCE(logo_name, \'\')) LIKE ?', [$like]);
                }

                $expenseQuery->orWhere(function ($codeQuery): void {
                    foreach (['196-00-', '397-00-', '612-00-', '760-00-', '770-00-'] as $prefix) {
                        $codeQuery
                            ->orWhere('logo_code', 'like', $prefix.'%')
                            ->orWhere('code', 'like', $prefix.'%');
                    }
                });
            });

            return;
        }

        // The three standard cards are resolved to the authenticated user's
        // own Logo expense accounts by PosExpenseService. Returning arbitrary
        // account definitions here would leak another branch/user's cards.
        $query->whereIn('code', self::STANDARD_EXPENSE_CATEGORY_CODES);
    }

    private function isBatumUser(User $user): bool
    {
        $signals = implode(' ', array_filter([
            $user->branch_code,
            $user->branch_name,
            $user->region_code,
            $user->region_name,
            $user->username,
            $user->name,
        ]));

        return str_contains(
            mb_strtoupper(Str::ascii($signals), 'UTF-8'),
            'BATUM'
        );
    }
}
