<?php

namespace App\Services\Pos;

use App\Models\PosExpense;
use App\Models\PosSession;
use App\Models\FinanceDefinition;
use App\Models\User;
use App\Services\Integrations\IntegrationSyncStateService;
use App\Support\MenuPermissions;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class PosExpenseService
{
    private const POINT_CURRENCY = 'TRY';
    private const BATUM_POINT_CURRENCY = 'GEL';

    public function __construct(
        private readonly IntegrationSyncStateService $syncState
    ) {}

    /**
     * @param  array<string, mixed>  $payload
     */
    public function create(User $user, array $payload): PosExpense
    {
        return DB::transaction(function () use ($user, $payload): PosExpense {
            if ($user->hasRole('salesperson') && empty($payload['pos_session_id'])) {
                return $this->createSalespersonExpense($user, $payload);
            }

            $session = PosSession::query()
                ->with(['openedBy', 'cashbox'])
                ->lockForUpdate()
                ->find((int) $payload['pos_session_id']);

            if (! $session instanceof PosSession || $session->status !== 'open') {
                throw ValidationException::withMessages([
                    'pos_session_id' => ['POS session not found or not open.'],
                ]);
            }

            $this->assertCanOperateSession($user, $session);
            $pointCurrency = $this->pointCurrency($session, $user);

            $expense = PosExpense::query()->create([
                'pos_session_id' => $session->id,
                'dealer_id' => (int) ($session->openedBy?->dealer_id ?? $user->dealer_id),
                'expense_date' => $payload['expense_date'] ?? now()->toDateString(),
                'category' => trim((string) $payload['category']),
                'amount' => number_format((float) $payload['amount'], 2, '.', ''),
                'currency' => $pointCurrency,
                'note' => filled($payload['note'] ?? null) ? trim((string) $payload['note']) : null,
                'created_by_user_id' => $user->id,
                'meta' => $payload['meta'] ?? null,
            ]);

            $this->queueExpenseForLogoExport($expense);

            return $expense->fresh(['posSession.cashbox', 'createdBy']);
        });
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    private function createSalespersonExpense(User $user, array $payload): PosExpense
    {
        $definition = FinanceDefinition::query()
            ->where('type', 'expense_category')
            ->where('is_active', true)
            ->where(function (Builder $query) use ($payload): void {
                if (! empty($payload['finance_definition_id'])) {
                    $query->whereKey((int) $payload['finance_definition_id']);
                } else {
                    $query->where('code', (string) $payload['category']);
                }
            })
            ->first();

        if (! $definition instanceof FinanceDefinition) {
            throw ValidationException::withMessages(['category' => ['Aktif gider kategorisi bulunamadı.']]);
        }

        $expenseAccountCode = $user->logo_expense_account_code ?: $definition->logo_code;
        $expenseAccountName = $user->logo_expense_account_name ?: $definition->logo_name;

        if (! filled($expenseAccountCode)) {
            throw ValidationException::withMessages([
                'expense_account' => ['Bu plasiyer için Logo gider cari kodu tanımlı değil.'],
            ]);
        }

        if (! filled($user->logo_cashbox_code)) {
            throw ValidationException::withMessages([
                'cashbox' => ['Bu plasiyer için Logo kasa kodu tanımlı değil.'],
            ]);
        }

        $expense = PosExpense::query()->create([
            'pos_session_id' => null,
            'dealer_id' => (int) $user->dealer_id,
            'expense_date' => $payload['expense_date'] ?? now()->toDateString(),
            'category' => $definition->name,
            'amount' => number_format((float) $payload['amount'], 2, '.', ''),
            'currency' => self::POINT_CURRENCY,
            'note' => trim(implode(' ', array_filter([
                $user->name,
                $definition->name,
                filled($payload['note'] ?? null) ? trim((string) $payload['note']) : null,
            ]))),
            'created_by_user_id' => $user->id,
            'meta' => array_merge(is_array($payload['meta'] ?? null) ? $payload['meta'] : [], [
                'scope' => 'salesperson',
                'finance_definition_id' => $definition->id,
                'expense_category_code' => $definition->code,
                'logo_expense_account_code' => $expenseAccountCode,
                'logo_expense_account_name' => $expenseAccountName,
                'logo_category_code' => $definition->logo_code,
                'cashbox_code' => $user->logo_cashbox_code,
                'cashbox_name' => $user->logo_cashbox_name,
            ]),
        ]);

        $this->queueExpenseForLogoExport($expense);

        return $expense->fresh(['createdBy']);
    }

    /**
     * @param  Builder<PosExpense>  $query
     * @param  array<string, mixed>  $filters
     * @return Builder<PosExpense>
     */
    public function applyFilters(Builder $query, User $user, array $filters): Builder
    {
        if (! $user->hasRole('admin')) {
            $query->where('dealer_id', $user->dealer_id);

            if ($user->hasAnyRole(['cashier', 'point']) && ! $user->hasRole('dealer_admin')) {
                $query->whereHas('posSession', fn (Builder $q) => $q->where('opened_by', $user->id));
            }

            if ($user->hasRole('salesperson')) {
                $query->where('created_by_user_id', $user->id);
            }
        }

        if (! empty($filters['pos_session_id'])) {
            $query->where('pos_session_id', (int) $filters['pos_session_id']);
        }

        if (! empty($filters['cashbox_id'])) {
            $query->whereHas('posSession', fn (Builder $q) => $q->where('cashbox_id', (int) $filters['cashbox_id']));
        }

        if (! empty($filters['date'])) {
            $query->whereDate('expense_date', (string) $filters['date']);
        } else {
            if (! empty($filters['date_from'])) {
                $query->whereDate('expense_date', '>=', (string) $filters['date_from']);
            }

            if (! empty($filters['date_to'])) {
                $query->whereDate('expense_date', '<=', (string) $filters['date_to']);
            }
        }

        return $query;
    }

    private function assertCanOperateSession(User $user, PosSession $session): void
    {
        if ($user->hasRole('admin')) {
            return;
        }

        $sessionDealerId = $session->openedBy?->dealer_id;
        if ($sessionDealerId === null || (int) $sessionDealerId !== (int) $user->dealer_id) {
            throw ValidationException::withMessages([
                'pos_session_id' => ['Session is not accessible in your dealer scope.'],
            ]);
        }

        if ($this->usesUserScopedCashbox($user) && (int) $session->opened_by !== (int) $user->id) {
            throw ValidationException::withMessages([
                'pos_session_id' => ['Cashier can only operate own session.'],
            ]);
        }
    }

    private function usesUserScopedCashbox(User $user): bool
    {
        if ($user->hasRole('dealer_admin') || $user->hasRole('admin')) {
            return false;
        }

        return $user->hasAnyRole(['cashier', 'point'])
            || in_array('pos', MenuPermissions::forUser($user), true);
    }

    private function pointCurrency(PosSession $session, User $user): string
    {
        $session->loadMissing('cashbox', 'openedBy');

        $batumSignals = [
            $user->branch_code,
            $user->region_code,
            $session->openedBy?->branch_code,
            $session->openedBy?->region_code,
            $session->cashbox?->code,
            $session->cashbox?->name,
        ];

        foreach ($batumSignals as $value) {
            if ($this->isBatumPointSignal($value)) {
                return self::BATUM_POINT_CURRENCY;
            }
        }

        return self::POINT_CURRENCY;
    }

    private function isBatumPointSignal(mixed $value): bool
    {
        $normalized = $this->normalizePointCurrencySignal($value);
        $batumCashboxCode = $this->normalizePointCurrencySignal(config('integrations.pos.batum_point_cashbox_code'));

        return str_contains($normalized, 'BATUM')
            || ($batumCashboxCode !== '' && $normalized === $batumCashboxCode);
    }

    private function normalizePointCurrencySignal(mixed $value): string
    {
        return mb_strtoupper(trim((string) $value), 'UTF-8');
    }

    private function queueExpenseForLogoExport(PosExpense $expense): void
    {
        $this->syncState->record(
            system: 'logo',
            domain: 'pos-expenses',
            direction: 'outbound',
            entity: $expense,
            externalRef: null,
            status: 'queued',
            error: null,
            meta: [
                'export_key' => 'B2B-POSEXP-'.$expense->id,
                'category' => $expense->category,
                'pos_session_id' => $expense->pos_session_id,
            ],
            payload: [
                'pos_expense_id' => $expense->id,
                'category' => $expense->category,
                'amount' => number_format((float) $expense->amount, 2, '.', ''),
                'currency' => $expense->currency,
            ],
        );
    }
}
