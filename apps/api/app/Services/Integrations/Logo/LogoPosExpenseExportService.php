<?php

namespace App\Services\Integrations\Logo;

use App\Models\Dealer;
use App\Models\IntegrationSyncState;
use App\Models\PosExpense;
use App\Services\Integrations\IntegrationSyncStateService;
use Illuminate\Validation\ValidationException;

class LogoPosExpenseExportService
{
    /**
     * Banka Para Çıkışı ilk sürümünde yalnız kasa satırı oluşan bazı kayıtlar
     * aynı idempotency anahtarıyla "synced" kalmıştı. Yeni sürüm anahtarı bu
     * kayıtları tam kasa + banka hareketi olarak güvenle bir kez onarır.
     */
    private const BANK_TRANSFER_EXPORT_VERSION = 2;

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

        $statuses = collect((array) ($filters['statuses'] ?? ['queued', 'failed']))
            ->filter(fn ($status) => in_array($status, ['queued', 'failed'], true))
            ->values()
            ->all();

        if ($statuses === []) {
            $statuses = ['queued'];
        }

        $limit = min((int) ($filters['limit'] ?? 100), 500);

        $pendingStates = IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'pos-expenses')
            ->where('direction', 'outbound')
            ->where('entity_type', PosExpense::class)
            ->whereIn('status', $statuses)
            ->orderBy('id')
            ->limit($limit)
            ->get();

        $repairStates = IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'pos-expenses')
            ->where('direction', 'outbound')
            ->where('entity_type', PosExpense::class)
            ->where('status', 'synced')
            ->orderByDesc('id')
            ->limit(min(max($limit * 5, 100), 1000))
            ->get();

        $states = $pendingStates
            ->concat($repairStates)
            ->unique(fn (IntegrationSyncState $state) => (int) $state->entity_id);

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

                if (
                    $state->status === 'synced'
                    && ! $this->needsBankTransferRepair($expense, $state)
                ) {
                    return null;
                }

                return $this->transformExpense($expense, $state);
            })
            ->filter()
            ->take($limit)
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

            $isBankTransfer = $this->isBankTransferExpense($expense);
            $syncMeta = [
                'acknowledged' => true,
                'export_key' => $this->exportKey($expense, $isBankTransfer),
                'payload' => is_array($record['meta'] ?? null) ? $record['meta'] : [],
            ];

            if ($isBankTransfer && $status === 'synced') {
                $syncMeta['bank_transfer_export_version'] = self::BANK_TRANSFER_EXPORT_VERSION;
            }

            $this->syncState->record(
                system: 'logo',
                domain: 'pos-expenses',
                direction: 'outbound',
                entity: $expense,
                externalRef: $externalReference,
                status: $status,
                error: $status === 'failed' ? $error : null,
                meta: $syncMeta,
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
            data_get($sourceMeta, 'cashbox_code') ?? $cashbox?->code,
            data_get($sourceMeta, 'cashbox_name') ?? $cashbox?->name
        );
        $logoDefaults = is_array(data_get($sourceMeta, 'integrations.logo'))
            ? data_get($sourceMeta, 'integrations.logo')
            : [];
        $expenseAccountCode = data_get($sourceMeta, 'logo_expense_account_code')
            ?? data_get($logoDefaults, 'account_code');
        $expenseAccountName = data_get($sourceMeta, 'logo_expense_account_name')
            ?? data_get($logoDefaults, 'account_name');
        $paymentSourceType = $this->nullableString(data_get($sourceMeta, 'payment_source_type')) ?? 'cash';
        $paymentSourceCode = $this->nullableString(data_get($sourceMeta, 'payment_source_code'));
        $paymentSourceName = $this->nullableString(data_get($sourceMeta, 'payment_source_name'));
        $paymentSourceLogoCode = $this->nullableString(data_get($sourceMeta, 'payment_source_logo_code'));
        $bankAccountCode = $this->nullableString(data_get($sourceMeta, 'bank_account_code')) ?? $paymentSourceCode;
        $bankAccountName = $this->nullableString(data_get($sourceMeta, 'bank_account_name')) ?? $paymentSourceName;
        $bankAccountLogoCode = $this->nullableString(data_get($sourceMeta, 'bank_account_logo_code')) ?? $paymentSourceLogoCode;
        $bankAccountLogoCode = $this->canonicalBatumBankLogoCode($bankAccountLogoCode, $bankAccountName);
        $paymentSourceLogoCode = $this->canonicalBatumBankLogoCode($paymentSourceLogoCode, $paymentSourceName);
        $operationType = $this->nullableString(data_get($sourceMeta, 'operation_type')) ?? 'expense';
        $bankTransferMode = (bool) data_get($sourceMeta, 'bank_transfer_mode', false) || $operationType === 'cash_to_bank';
        $legacyBankTransferInferred = false;

        if (
            ! $bankTransferMode
            && $this->isLegacyBatumBankTransfer($expense, $expenseAccountCode, $expenseAccountName)
        ) {
            // Early Banka Para Cikisi records were stored as ordinary expenses.
            // Their 108-* bank account codes are not CLCARD expense accounts, so
            // exporting them as expenses can never succeed. Preserve the records
            // and safely reinterpret only this narrow legacy signature.
            $legacyBankTransferInferred = true;
            $operationType = 'cash_to_bank';
            $bankTransferMode = true;
            $paymentSourceType = 'cash';
            $bankAccountCode = $this->nullableString($expenseAccountCode);
            $bankAccountName = $this->nullableString($expenseAccountName) ?? $expense->category;
            $bankAccountLogoCode = $this->canonicalBatumBankLogoCode($bankAccountCode, $bankAccountName);
            $paymentSourceCode = null;
            $paymentSourceName = null;
            $paymentSourceLogoCode = null;
        }

        if ($this->isBatumExpensePayload($expense, $sourceMeta, $expenseAccountCode, $expenseAccountName)) {
            $cashboxPayload = [
                'id' => $cashboxPayload['id'] ?? null,
                'code' => $this->nullableString(config('integrations.pos.batum_point_cashbox_code')) ?? '100.04.001',
                'name' => $this->nullableString(config('integrations.pos.batum_point_cashbox_name')) ?? 'BATUM MERKEZ KASASI',
            ];
        }

        return [
            'pos_expense_id' => $expense->id,
            'export_key' => $this->exportKey($expense, $bankTransferMode),
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
            'payment_source_type' => $paymentSourceType,
            'payment_source_code' => $paymentSourceCode,
            'payment_source_name' => $paymentSourceName,
            'payment_source_logo_code' => $paymentSourceLogoCode,
            'bank_account_code' => $bankAccountCode,
            'bank_account_name' => $bankAccountName,
            'bank_account_logo_code' => $bankAccountLogoCode,
            'operation_type' => $operationType,
            'bank_transfer_mode' => $bankTransferMode,
            'bank_expense_mode' => (bool) data_get($sourceMeta, 'bank_expense_mode', false),
            'bank_expense_account_code' => $this->nullableString(data_get($sourceMeta, 'bank_expense_account_code')),
            'bank_expense_account_name' => $this->nullableString(data_get($sourceMeta, 'bank_expense_account_name')),
            'account_code' => $expenseAccountCode,
            'expense_account_code' => $expenseAccountCode,
            'logo_expense_account_code' => $expenseAccountCode,
            'logo_expense_account_name' => $expenseAccountName,
            'logo' => [
                'account_code' => $expenseAccountCode,
                'account_name' => $expenseAccountName,
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
                'payment_source' => [
                    'type' => $paymentSourceType,
                    'code' => $paymentSourceCode,
                    'name' => $paymentSourceName,
                    'logo_code' => $paymentSourceLogoCode,
                ],
                'bank_account' => [
                    'code' => $bankAccountCode,
                    'name' => $bankAccountName,
                    'logo_code' => $bankAccountLogoCode,
                ],
                'operation_type' => $operationType,
                'bank_transfer_mode' => $bankTransferMode,
                'legacy_bank_transfer_inferred' => $legacyBankTransferInferred,
            ],
        ];
    }

    private function exportKey(PosExpense $expense, bool $bankTransfer): string
    {
        if ($bankTransfer) {
            return 'B2B-PBANK-V'.self::BANK_TRANSFER_EXPORT_VERSION.'-'.$expense->id;
        }

        return 'B2B-POSEXP-'.$expense->id;
    }

    private function needsBankTransferRepair(
        PosExpense $expense,
        IntegrationSyncState $state
    ): bool {
        if (! $this->isBankTransferExpense($expense)) {
            return false;
        }

        return (int) data_get(
            is_array($state->meta) ? $state->meta : [],
            'bank_transfer_export_version',
            0
        ) < self::BANK_TRANSFER_EXPORT_VERSION;
    }

    private function isBankTransferExpense(PosExpense $expense): bool
    {
        $sourceMeta = is_array($expense->meta) ? $expense->meta : [];
        $operationType = $this->nullableString(data_get($sourceMeta, 'operation_type'));

        if (
            $operationType === 'cash_to_bank'
            || (bool) data_get($sourceMeta, 'bank_transfer_mode', false)
        ) {
            return true;
        }

        $logoDefaults = is_array(data_get($sourceMeta, 'integrations.logo'))
            ? data_get($sourceMeta, 'integrations.logo')
            : [];
        $expenseAccountCode = data_get($sourceMeta, 'logo_expense_account_code')
            ?? data_get($logoDefaults, 'account_code');
        $expenseAccountName = data_get($sourceMeta, 'logo_expense_account_name')
            ?? data_get($logoDefaults, 'account_name');

        return $this->isLegacyBatumBankTransfer(
            $expense,
            $expenseAccountCode,
            $expenseAccountName
        );
    }

    private function isLegacyBatumBankTransfer(
        PosExpense $expense,
        mixed $expenseAccountCode,
        mixed $expenseAccountName
    ): bool {
        $normalizedCode = preg_replace(
            '/[^0-9A-ZÇĞİÖŞÜ]+/u',
            '',
            mb_strtoupper((string) $expenseAccountCode, 'UTF-8')
        ) ?? '';

        $label = mb_strtoupper(trim(implode(' ', array_filter([
            $expense->category,
            $expenseAccountName,
        ]))), 'UTF-8');

        $isLegacyPosAccount = in_array($normalizedCode, ['10800001', '10800002'], true)
            && str_contains($label, 'POS HESABI')
            && str_contains($label, 'BATUM');

        $isLegacyFarukBank = in_array($normalizedCode, ['05', '10800003'], true)
            && str_contains($label, 'FARUK')
            && str_contains($label, 'GEORGIA');

        return $isLegacyPosAccount || $isLegacyFarukBank;
    }

    private function canonicalBatumBankLogoCode(?string $code, ?string $name): ?string
    {
        $normalizedCode = preg_replace('/[^0-9A-ZÇĞİÖŞÜ]+/u', '', mb_strtoupper((string) $code, 'UTF-8')) ?? '';
        $normalizedName = mb_strtoupper(trim((string) $name), 'UTF-8');

        if (str_contains($normalizedName, 'FARUK') && str_contains($normalizedName, 'GEORGIA')) {
            return '05';
        }

        if (str_contains($normalizedName, 'TBC') || $normalizedCode === '10800002') {
            return '04';
        }

        if (
            $normalizedCode === '10800001'
            || (str_contains($normalizedName, 'BANK OF GEORGIA') && ! str_contains($normalizedName, 'FARUK'))
        ) {
            return '03';
        }

        return $code;
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

        if ($this->isBatumCashboxSignal($normalizedCode, $normalizedName)) {
            $normalizedCode = $this->nullableString(config('integrations.pos.batum_point_cashbox_code')) ?? $normalizedCode;
            $normalizedName = $this->nullableString(config('integrations.pos.batum_point_cashbox_name')) ?? $normalizedName;
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

    private function isBatumCashboxSignal(?string $code, ?string $name): bool
    {
        $signal = mb_strtoupper(trim(($code ?? '').' '.($name ?? '')), 'UTF-8');

        return str_contains($signal, 'BATUM');
    }

    /**
     * The session may still contain an old/mistyped cashbox mapping. Batum
     * expenses are identified from their accounting payload and always exported
     * against the moderator/configured Batum cashbox.
     *
     * @param  array<string, mixed>  $sourceMeta
     */
    private function isBatumExpensePayload(
        PosExpense $expense,
        array $sourceMeta,
        mixed $expenseAccountCode,
        mixed $expenseAccountName
    ): bool {
        if (mb_strtoupper(trim((string) $expense->currency), 'UTF-8') === 'GEL') {
            return true;
        }

        $signal = mb_strtoupper(implode(' ', array_filter([
            $expense->category,
            $expenseAccountCode,
            $expenseAccountName,
            data_get($sourceMeta, 'scope'),
            data_get($sourceMeta, 'cashbox_name'),
            data_get($sourceMeta, 'payment_source_name'),
        ])), 'UTF-8');

        return str_contains($signal, 'BATUM');
    }
}
