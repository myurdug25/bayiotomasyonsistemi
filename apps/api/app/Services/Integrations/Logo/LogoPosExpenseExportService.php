<?php

namespace App\Services\Integrations\Logo;

use App\Models\Dealer;
use App\Models\IntegrationSyncState;
use App\Models\PosExpense;
use App\Services\Integrations\IntegrationSyncStateService;
use Illuminate\Validation\ValidationException;

class LogoPosExpenseExportService
{
    public function __construct(
        private readonly IntegrationSyncStateService $syncState
    ) {}

    /**
     * @param  array<string, mixed>  $filters
     * @return array<string, mixed>
     */
    public function pending(array $filters): array
    {
        $dealer = $this->resolveDealer(
            $filters['dealer_id'] ?? null,
            $filters['dealer_code'] ?? null,
        );

        $statuses = collect((array) ($filters['statuses'] ?? ['queued']))
            ->filter(fn ($status) => in_array($status, ['queued', 'failed'], true))
            ->values()
            ->all();

        if ($statuses === []) {
            $statuses = ['queued'];
        }

        $limit = min((int) ($filters['limit'] ?? 100), 500);

        $states = IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'pos-expenses')
            ->where('direction', 'outbound')
            ->where('entity_type', PosExpense::class)
            ->whereIn('status', $statuses)
            ->orderBy('id')
            ->limit($limit)
            ->get();

        $expenses = PosExpense::query()
            ->with(['posSession.cashbox', 'createdBy:id,name'])
            ->whereIn('id', $states->pluck('entity_id')->map(fn ($id) => (int) $id)->all())
            ->get()
            ->keyBy('id');

        $records = $states
            ->map(function (IntegrationSyncState $state) use ($expenses, $dealer): ?array {
                $expense = $expenses->get((int) $state->entity_id);

                if (! $expense instanceof PosExpense) {
                    return null;
                }

                if ($dealer instanceof Dealer && (int) $expense->dealer_id !== (int) $dealer->id) {
                    return null;
                }

                return $this->transformExpense($expense, $state);
            })
            ->filter()
            ->values();

        return [
            'received' => $records->count(),
            'filters' => [
                'dealer_id' => $dealer?->id,
                'statuses' => $statuses,
                'limit' => $limit,
            ],
            'records' => $records->all(),
        ];
    }

    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, int>
     */
    public function acknowledge(array $payload): array
    {
        $summary = [
            'received' => count($payload['records'] ?? []),
            'synced' => 0,
            'failed' => 0,
            'skipped' => 0,
        ];

        foreach ((array) ($payload['records'] ?? []) as $index => $record) {
            $expense = PosExpense::query()->find((int) $record['pos_expense_id']);

            if (! $expense instanceof PosExpense) {
                throw ValidationException::withMessages([
                    "records.$index.pos_expense_id" => ['Gonderilen POS masraf kaydi bulunamadi.'],
                ]);
            }

            $status = (string) $record['status'];
            $externalReference = $this->nullableString($record['external_ref'] ?? null);
            $error = $this->nullableString($record['error'] ?? null);

            $this->syncState->record(
                system: 'logo',
                domain: 'pos-expenses',
                direction: 'outbound',
                entity: $expense,
                externalRef: $externalReference,
                status: $status,
                error: $status === 'failed' ? $error : null,
                meta: [
                    'acknowledged' => true,
                    'export_key' => 'B2B-POSEXP-'.$expense->id,
                    'payload' => is_array($record['meta'] ?? null) ? $record['meta'] : [],
                ],
                payload: $record,
                syncedAt: now(),
            );

            $summary[$status]++;
        }

        return $summary;
    }

    /**
     * @return array<string, mixed>
     */
    private function transformExpense(PosExpense $expense, IntegrationSyncState $state): array
    {
        $sourceMeta = is_array($expense->meta) ? $expense->meta : [];
        $cashbox = $expense->posSession?->cashbox;
        $cashboxPayload = $this->normalizeCashboxPayload(
            $cashbox?->id,
            $cashbox?->code ?? data_get($sourceMeta, 'cashbox_code'),
            $cashbox?->name ?? data_get($sourceMeta, 'cashbox_name')
        );
        $logoDefaults = is_array(data_get($sourceMeta, 'integrations.logo'))
            ? data_get($sourceMeta, 'integrations.logo')
            : [];

        return [
            'pos_expense_id' => $expense->id,
            'export_key' => 'B2B-POSEXP-'.$expense->id,
            'dealer_id' => $expense->dealer_id,
            'pos_session_id' => $expense->pos_session_id,
            'expense_date' => optional($expense->expense_date)?->toDateString(),
            'category' => $expense->category,
            'amount' => number_format((float) $expense->amount, 2, '.', ''),
            'currency' => strtoupper((string) $expense->currency),
            'note' => $expense->note,
            'cashbox_id' => $cashboxPayload['id'] ?? null,
            'cashbox_code' => $cashboxPayload['code'] ?? null,
            'cashbox_name' => $cashboxPayload['name'] ?? null,
            'logo' => [
                'account_code' => data_get($sourceMeta, 'logo_expense_account_code')
                    ?? data_get($logoDefaults, 'account_code'),
                'account_ref' => data_get($logoDefaults, 'account_ref'),
                'center_code' => data_get($logoDefaults, 'center_code'),
                'center_ref' => data_get($logoDefaults, 'center_ref'),
                'branch' => data_get($logoDefaults, 'branch'),
                'department' => data_get($logoDefaults, 'department'),
                'trcode' => data_get($logoDefaults, 'trcode'),
                'target_tables' => ['KSLINES', 'CLFLINE'],
            ],
            'created_by_user_id' => $expense->created_by_user_id,
            'created_by_name' => $expense->createdBy?->name,
            'sync_status' => $state->status,
            'sync_error' => $state->last_error,
            'meta' => [
                'created_at' => optional($expense->created_at)?->toIso8601String(),
                'updated_at' => optional($expense->updated_at)?->toIso8601String(),
                'logo_external_ref' => $state->external_ref,
                'source_meta' => $sourceMeta,
                'cashbox' => $cashboxPayload,
            ],
        ];
    }

    private function resolveDealer(mixed $dealerId, mixed $dealerCode): ?Dealer
    {
        if ($dealerId !== null && $dealerId !== '') {
            return Dealer::query()->find((int) $dealerId);
        }

        $normalizedDealerCode = $this->nullableString($dealerCode);
        if ($normalizedDealerCode !== null) {
            return Dealer::query()
                ->where('code', $normalizedDealerCode)
                ->first();
        }

        return null;
    }

    private function nullableString(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $value = trim((string) $value);

        return $value === '' ? null : $value;
    }

    /**
     * @return array{id:int|null,code:?string,name:?string}|null
     */
    private function normalizeCashboxPayload(mixed $id, mixed $code, mixed $name): ?array
    {
        $normalizedCode = $this->nullableString($code);
        $normalizedName = $this->nullableString($name);

        if ($normalizedCode === null && $normalizedName === null && $id === null) {
            return null;
        }

        if ($this->isLocalPointCashboxCode($normalizedCode)) {
            $normalizedCode = $this->nullableString(config('integrations.pos.point_cashbox_code')) ?? $normalizedCode;
            $normalizedName = $this->nullableString(config('integrations.pos.point_cashbox_name')) ?? $normalizedName;
        }

        return [
            'id' => is_numeric($id) ? (int) $id : null,
            'code' => $normalizedCode,
            'name' => $normalizedName,
        ];
    }

    private function isLocalPointCashboxCode(?string $code): bool
    {
        return $code !== null && str_starts_with($code, 'POINT-');
    }
}
