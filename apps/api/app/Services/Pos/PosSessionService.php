<?php

namespace App\Services\Pos;

use App\Models\Cashbox;
use App\Models\Collection;
use App\Models\IntegrationSyncState;
use App\Models\PosSale;
use App\Models\PosSession;
use App\Models\User;
use App\Services\Integrations\IntegrationSyncStateService;
use App\Services\Integrations\Logo\LogoWritePublisher;
use App\Support\MenuPermissions;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class PosSessionService
{
    public function __construct(
        private readonly IntegrationSyncStateService $syncState,
        private readonly LogoWritePublisher $logoWritePublisher,
    ) {}

    public function open(User $user, ?int $cashboxId, float $openingCash): PosSession
    {
        return DB::transaction(function () use ($user, $cashboxId, $openingCash) {
            $cashbox = $this->resolveCashbox($user, $cashboxId);
            $cashboxId = (int) $cashbox->getKey();

            $hasOpenSession = PosSession::query()
                ->where('cashbox_id', $cashboxId)
                ->where('status', 'open')
                ->lockForUpdate()
                ->exists();

            if ($hasOpenSession) {
                throw ValidationException::withMessages([
                    'cashbox_id' => ['There is already an open POS session for this cashbox.'],
                ]);
            }

            $session = PosSession::create([
                'cashbox_id' => $cashboxId,
                'opened_by' => $user->id,
                'opened_at' => now(),
                'opening_cash' => number_format(max(0, $openingCash), 2, '.', ''),
                'status' => 'open',
            ]);

            return $session->fresh(['cashbox', 'openedBy']);
        });
    }

    private function resolveCashbox(User $user, ?int $cashboxId): Cashbox
    {
        if ($cashboxId !== null) {
            $cashbox = Cashbox::query()->lockForUpdate()->find($cashboxId);

            if ($cashbox === null || ! $cashbox->is_active) {
                throw ValidationException::withMessages([
                    'cashbox_id' => ['Cashbox not found or inactive.'],
                ]);
            }

            return $cashbox;
        }

        if ($this->usesUserScopedCashbox($user)) {
            return $this->resolvePointCashbox($user);
        }

        if ($user->hasRole('admin')) {
            return $this->resolvePointCashboxByCode('MAIN-POS', 'Ana POS Kasasi');
        }

        $cashbox = Cashbox::query()
            ->lockForUpdate()
            ->where('is_active', true)
            ->orderBy('id')
            ->first();

        if ($cashbox instanceof Cashbox) {
            return $cashbox;
        }

        $defaultCashbox = Cashbox::query()
            ->lockForUpdate()
            ->where('code', 'MAIN-POS')
            ->first();

        if ($defaultCashbox instanceof Cashbox) {
            if (! $defaultCashbox->is_active) {
                $defaultCashbox->forceFill(['is_active' => true])->save();
            }

            return $defaultCashbox;
        }

        return Cashbox::query()->create([
            'code' => 'MAIN-POS',
            'name' => 'Ana POS Kasasi',
            'is_active' => true,
        ]);
    }

    private function resolvePointCashbox(User $user): Cashbox
    {
        $userCashboxCode = $this->nullableString($user->logo_cashbox_code);
        $code = $userCashboxCode ?? 'POINT-'.$user->id;
        $name = $this->nullableString($user->logo_cashbox_name)
            ?? trim(($user->name ?: 'Point').' Kasasi');

        return $this->resolvePointCashboxByCode($code, $name);
    }

    private function resolvePointCashboxByCode(string $code, string $name): Cashbox
    {
        $cashbox = Cashbox::query()
            ->lockForUpdate()
            ->where('code', $code)
            ->first();

        if ($cashbox instanceof Cashbox) {
            $updates = [];

            if (! $cashbox->is_active) {
                $updates['is_active'] = true;
            }

            if ($this->nullableString($cashbox->name) !== $name) {
                $updates['name'] = $name;
            }

            if ($updates !== []) {
                $cashbox->forceFill($updates)->save();
            }

            return $cashbox;
        }

        return Cashbox::query()->create([
            'code' => $code,
            'name' => $name,
            'is_active' => true,
        ]);
    }

    private function nullableString(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $value = trim((string) $value);

        return $value === '' ? null : $value;
    }

    public function closeCurrent(User $user, float $closingCashCounted, ?int $cashboxId = null): PosSession
    {
        return DB::transaction(function () use ($user, $closingCashCounted, $cashboxId) {
            $session = $this->currentQuery($user, $cashboxId)
                ->lockForUpdate()
                ->first();

            if (! $session instanceof PosSession) {
                throw ValidationException::withMessages([
                    'session' => ['No open POS session found for current scope.'],
                ]);
            }

            $session->status = 'closed';
            $session->closed_at = now();
            $session->closing_cash_counted = number_format(max(0, $closingCashCounted), 2, '.', '');
            $session->save();

            $this->queueSessionSalesForLogoExport($session);
            $this->queueSessionCollectionsForLogoExport($session);

            return $session->fresh(['cashbox', 'openedBy']);
        });
    }

    public function current(User $user, ?int $cashboxId = null): ?PosSession
    {
        return $this->currentQuery($user, $cashboxId)->first();
    }

    /**
     * @return Builder<PosSession>
     */
    public function currentQuery(User $user, ?int $cashboxId = null, bool $includeAllAccessible = false): Builder
    {
        $query = PosSession::query()
            ->with(['cashbox', 'openedBy'])
            ->where('status', 'open')
            ->orderByDesc('opened_at')
            ->orderByDesc('id');

        if ($user->hasRole('admin')) {
            if (! $includeAllAccessible && $cashboxId === null) {
                $query->where('opened_by', $user->id);
            }
        } else {
            $query->whereHas('openedBy', fn (Builder $q) => $q->where('dealer_id', $user->dealer_id));

            if ($this->usesUserScopedCashbox($user)) {
                $query->where('opened_by', $user->id);
            }
        }

        if ($cashboxId !== null) {
            $query->where('cashbox_id', $cashboxId);
        }

        return $query;
    }

    private function usesUserScopedCashbox(User $user): bool
    {
        if ($user->hasRole('admin')) {
            return false;
        }

        $hasPosMenu = in_array('pos', MenuPermissions::forUser($user), true);
        $hasOwnLogoCashbox = $this->nullableString($user->logo_cashbox_code) !== null;

        if ($user->hasRole('dealer_admin')) {
            return $hasPosMenu && $hasOwnLogoCashbox;
        }

        return $user->hasAnyRole(['cashier', 'point']) || $hasPosMenu;
    }

    private function queueSessionSalesForLogoExport(PosSession $session): void
    {
        PosSale::query()
            ->where('pos_session_id', (int) $session->id)
            ->where('status', 'paid')
            ->whereIn('document_type', ['delivery', 'invoice'])
            ->each(function (PosSale $sale): void {
                $existingStatus = IntegrationSyncState::query()
                    ->where('system', 'logo')
                    ->where('domain', 'pos-sales')
                    ->where('direction', 'outbound')
                    ->where('entity_type', PosSale::class)
                    ->where('entity_id', (int) $sale->id)
                    ->value('status');

                if ($existingStatus === 'synced') {
                    return;
                }

                $this->syncState->record(
                    system: 'logo',
                    domain: 'pos-sales',
                    direction: 'outbound',
                    entity: $sale,
                    externalRef: null,
                    status: 'queued',
                    error: null,
                    meta: [
                        'export_key' => 'B2B-POSSALE-'.$sale->id,
                        'document_type' => $sale->document_type,
                        'receipt_no' => $sale->receipt_no,
                        'queued_from' => 'pos_day_end_close',
                    ],
                    payload: [
                        'pos_sale_id' => $sale->id,
                        'receipt_no' => $sale->receipt_no,
                        'document_type' => $sale->document_type,
                    ],
                );
            });
    }

    private function queueSessionCollectionsForLogoExport(PosSession $session): void
    {
        Collection::query()
            ->with('customer:id,source_system,source_reference,sync_status')
            ->where('source_system', 'b2b')
            ->whereNotIn('sync_status', ['pending', 'reviewing', 'synced'])
            ->where('meta->pos_session_id', (int) $session->id)
            ->whereHas('customer', function (Builder $query): void {
                $query
                    ->whereNotNull('source_reference')
                    ->orWhere('source_system', 'logo')
                    ->orWhere(function (Builder $b2bQuery): void {
                        $b2bQuery
                            ->where('source_system', 'b2b')
                            ->where('sync_status', 'synced');
                    });
            })
            ->each(function (Collection $collection): void {
                $meta = is_array($collection->meta) ? $collection->meta : [];
                data_set($meta, 'integrations.logo.submitted_at', now()->toIso8601String());
                data_set($meta, 'integrations.logo.queued_from', 'pos_day_end_close');

                $collection->fill([
                    'sync_status' => 'pending',
                    'sync_error' => null,
                    'last_synced_at' => null,
                    'meta' => $meta,
                ])->save();

                $this->logoWritePublisher->queueCollectionCreate($collection);
            });
    }
}
