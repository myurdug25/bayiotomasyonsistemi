<?php

namespace App\Services\Integrations\Logo;

use App\Models\IntegrationSyncState;
use App\Models\PosSession;
use App\Services\Integrations\IntegrationSyncStateService;
use Illuminate\Validation\ValidationException;

class LogoPosDayEndExportService
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
            ->where('domain', 'pos-day-ends')
            ->where('direction', 'outbound')
            ->where('entity_type', PosSession::class)
            ->whereIn('status', $statuses)
            ->orderBy('id')
            ->limit($limit)
            ->get();

        $sessions = PosSession::query()
            ->with(['cashbox', 'openedBy:id,name,logo_cashbox_code,logo_cashbox_name'])
            ->whereIn('id', $states->pluck('entity_id')->map(fn ($id) => (int) $id)->all())
            ->get()
            ->keyBy('id');

        $records = $states
            ->map(function (IntegrationSyncState $state) use ($sessions): ?array {
                $session = $sessions->get((int) $state->entity_id);

                if (! $session instanceof PosSession) {
                    return null;
                }

                return $this->transformDayEnd($session, $state);
            })
            ->filter()
            ->values();

        return [
            'received' => $records->count(),
            'filters' => [
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
            $session = PosSession::query()->find((int) $record['pos_session_id']);

            if (! $session instanceof PosSession) {
                throw ValidationException::withMessages([
                    "records.$index.pos_session_id" => ['Gonderilen POS gun sonu oturumu bulunamadi.'],
                ]);
            }

            $status = (string) $record['status'];
            $externalReference = $this->nullableString($record['external_ref'] ?? null);
            $error = $this->nullableString($record['error'] ?? null);
            $meta = is_array($record['meta'] ?? null) ? $record['meta'] : [];

            $this->syncState->record(
                system: 'logo',
                domain: 'pos-day-ends',
                direction: 'outbound',
                entity: $session,
                externalRef: $externalReference,
                status: $status,
                error: $status === 'failed' ? $error : null,
                meta: array_replace_recursive([
                    'acknowledged' => true,
                    'export_key' => 'B2B-POSDAYEND-'.$session->id,
                ], $meta),
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
    private function transformDayEnd(PosSession $session, IntegrationSyncState $state): array
    {
        $payload = is_array(data_get($state->meta, 'payload')) ? data_get($state->meta, 'payload') : [];
        $cashbox = $this->cashboxPayloadForExport($session);
        $cashAmount = $this->dayEndCashAmount($payload);
        $cardAmount = $this->dayEndCardAmount($payload);

        $record = array_replace_recursive([
            'pos_session_id' => $session->id,
            'export_key' => data_get($state->meta, 'export_key', 'B2B-POSDAYEND-'.$session->id),
            'date' => data_get($payload, 'date'),
            'cash_amount' => number_format($cashAmount, 2, '.', ''),
            'card_amount' => number_format($cardAmount, 2, '.', ''),
            'currency' => data_get($payload, 'currency', 'TRY'),
            'cashbox_code' => $cashbox['code'],
            'cashbox_name' => $cashbox['name'],
            'opened_by_user_id' => $session->opened_by,
            'opened_by_name' => $session->openedBy?->name,
            'sync_status' => $state->status,
            'sync_error' => $state->last_error,
            'meta' => [
                'logo_external_ref' => $state->external_ref,
                'queued_payload' => $payload,
            ],
        ], $payload);

        $record['cash_amount'] = number_format($cashAmount, 2, '.', '');
        $record['card_amount'] = number_format($cardAmount, 2, '.', '');
        $record['cashbox_code'] = $cashbox['code'];
        $record['cashbox_name'] = $cashbox['name'];
        $record['meta']['resolved_cashbox'] = $cashbox;
        $record['meta']['day_end_logo_rule'] = 'cash_sales_and_card_sales_only_collections_report_only';

        return $record;
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    private function dayEndCashAmount(array $payload): float
    {
        $accountingTotals = (array) data_get($payload, 'accounting_totals', []);

        if (array_key_exists('cash_sales', $accountingTotals)) {
            return $this->numeric($accountingTotals['cash_sales']);
        }

        if (array_key_exists('cash_amount', $payload)) {
            return $this->numeric(data_get($payload, 'cash_amount'));
        }

        if (array_key_exists('cash_sales', (array) data_get($payload, 'totals', []))) {
            return $this->numeric(data_get($payload, 'totals.cash_sales'));
        }

        return 0.0;
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    private function dayEndCardAmount(array $payload): float
    {
        $accountingTotals = (array) data_get($payload, 'accounting_totals', []);

        if (array_key_exists('card_sales', $accountingTotals)) {
            return $this->numeric($accountingTotals['card_sales']);
        }

        if (array_key_exists('card_amount', $payload)) {
            return $this->numeric(data_get($payload, 'card_amount'));
        }

        if (array_key_exists('card_sales', (array) data_get($payload, 'totals', []))) {
            return $this->numeric(data_get($payload, 'totals.card_sales'));
        }

        return 0.0;
    }

    /**
     * @return array{code:?string,name:?string}
     */
    private function cashboxPayloadForExport(PosSession $session): array
    {
        $code = $this->nullableString($session->openedBy?->logo_cashbox_code)
            ?? $this->nullableString($session->cashbox?->code);
        $name = $this->nullableString($session->openedBy?->logo_cashbox_name)
            ?? $this->nullableString($session->cashbox?->name);

        return [
            'code' => $code,
            'name' => $name,
        ];
    }

    private function numeric(mixed $value): float
    {
        if (is_numeric($value)) {
            return (float) $value;
        }

        return 0.0;
    }

    private function nullableString(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $value = trim((string) $value);

        return $value === '' ? null : $value;
    }
}
