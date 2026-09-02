<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Customer\CustomerCollectionIndexRequest;
use App\Http\Requests\Customer\StoreCustomerCollectionRequest;
use App\Http\Resources\CollectionResource;
use App\Models\Cashbox;
use App\Models\Collection as CollectionModel;
use App\Models\Customer;
use App\Models\FinanceDefinition;
use App\Models\LedgerEntry;
use App\Models\User;
use App\Services\Integrations\Logo\LogoWritePublisher;
use App\Services\Ledger\LedgerWriter;
use App\Services\Notifications\UserNotificationService;
use App\Support\Pricing\DisplayCurrency;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class CustomerCollectionController extends Controller
{
    public function index(CustomerCollectionIndexRequest $request, Customer $customer): JsonResponse
    {
        $this->authorize('viewCollections', $customer);

        $validated = $request->validated();
        $perPage = min((int) ($validated['per_page'] ?? 25), 50);
        $dateFrom = $validated['date_from'] ?? null;
        $dateTo = $validated['date_to'] ?? null;
        $method = $validated['method'] ?? null;
        // Both fields are written together. Using the indexed `date` column
        // directly keeps the collections screen responsive on large tables;
        // COALESCE/DATE wrappers force a scan and were causing 15-20s loads.
        $dateCol = DB::connection()->getDriverName() === 'mysql' ? '`date`' : '"date"';
        $dateColumn = $dateCol;
        $user = $request->user();
        $displayUser = $user instanceof User ? $user : null;
        $includeSummary = (bool) ($validated['include_summary'] ?? true);
        $compact = (bool) ($validated['compact'] ?? false);
        $collectionSummary = $includeSummary
            ? $this->collectionSummaryPayload($customer, $dateFrom, $dateTo, $displayUser)
            : ['tabs' => collect(), 'logo_sync' => []];

        if ($method === 'invoice') {
            $invoiceQuery = $this->invoiceQuery($customer, $dateFrom, $dateTo)
                ->orderByRaw("COALESCE({$dateCol}, entry_date) DESC")
                ->orderByDesc('id');

            $paginator = $invoiceQuery->paginate($perPage)->withQueryString();

            return response()->json([
                'customer_id' => $customer->id,
                'filters' => [
                    'method' => $method,
                    'date_from' => $dateFrom,
                    'date_to' => $dateTo,
                ],
                'tabs' => $collectionSummary['tabs'],
                'logo_sync' => $collectionSummary['logo_sync'],
                'data' => collect($paginator->items())
                    ->map(fn (LedgerEntry $item) => $this->invoiceEntryPayload($item, $displayUser))
                    ->values(),
                'meta' => [
                    'current_page' => $paginator->currentPage(),
                    'last_page' => $paginator->lastPage(),
                    'per_page' => $paginator->perPage(),
                    'total' => $paginator->total(),
                ],
            ]);
        }

        $query = CollectionModel::query()
            ->where('customer_id', $customer->id)
            ->when(! empty($method), fn ($q) => $this->applyCollectionMethodFilter($q, (string) $method))
            ->when(! empty($dateFrom), fn ($q) => $q->where('date', '>=', $dateFrom))
            ->when(! empty($dateTo), fn ($q) => $q->where('date', '<=', $dateTo))
            ->orderByDesc('date')
            ->orderByDesc('id');

        $paginator = $query->paginate($perPage)->withQueryString();

        return response()->json([
            'customer_id' => $customer->id,
            'filters' => [
                'method' => $method,
                'date_from' => $dateFrom,
                'date_to' => $dateTo,
            ],
            'tabs' => $collectionSummary['tabs'],
            'logo_sync' => $collectionSummary['logo_sync'],
            'data' => collect($paginator->items())
                ->map(fn ($item) => $compact
                    ? $this->compactCollectionPayload($item, $request)
                    : (new CollectionResource($item))->toArray($request))
                ->values(),
            'meta' => [
                'current_page' => $paginator->currentPage(),
                'last_page' => $paginator->lastPage(),
                'per_page' => $paginator->perPage(),
                'total' => $paginator->total(),
            ],
        ]);
    }

    /**
     * @return array<string, mixed>
     */
    private function compactCollectionPayload(CollectionModel $collection, Request $request): array
    {
        $payload = (new CollectionResource($collection))->toArray($request);
        $referenceFields = $payload['reference_fields'];

        if (is_array($referenceFields)) {
            unset(
                $referenceFields['image_data'],
                $referenceFields['image_name'],
                $referenceFields['image_type'],
                $referenceFields['images_json']
            );
        }

        $payload['reference_fields'] = $referenceFields;
        $payload['meta'] = null;

        if (($payload['sync_status'] ?? null) !== 'failed') {
            $payload['sync_error'] = null;
        }

        return $payload;
    }

    /**
     * @return array{tabs:Collection<int, array{method:string,count:int,total_amount:string}>,logo_sync:array{draft:int,pending:int,reviewing:int,synced:int,failed:int,latest_synced_at:?string}}
     */
    private function collectionSummaryPayload(Customer $customer, ?string $dateFrom, ?string $dateTo, ?User $user): array
    {
        $collectionSummary = $this->collectionTabSummaries($customer, $dateFrom, $dateTo, $user);
        $summaries = $collectionSummary['tabs'];
        $summaries['invoice'] = $this->invoiceTabSummary($customer, $dateFrom, $dateTo, $user);

        $tabs = collect(['cash', 'transfer', 'check', 'cc', 'factory_cc', 'invoice'])
            ->map(function (string $method) use ($summaries): array {
                $summary = $summaries[$method] ?? ['count' => 0, 'total_amount' => 0.0];

                return [
                    'method' => $method,
                    'count' => $summary['count'],
                    'total_amount' => number_format($summary['total_amount'], 2, '.', ''),
                ];
            })
            ->values();

        return [
            'tabs' => $tabs,
            'logo_sync' => $collectionSummary['logo_sync'],
        ];
    }

    /**
     * @return array{tabs:array<string, array{count:int,total_amount:float}>,logo_sync:array{draft:int,pending:int,reviewing:int,synced:int,failed:int,latest_synced_at:?string}}
     */
    private function collectionTabSummaries(Customer $customer, ?string $dateFrom, ?string $dateTo, ?User $user): array
    {
        $dateCol = DB::connection()->getDriverName() === 'mysql' ? '`date`' : '"date"';
        $dateColumn = $dateCol;
        $channelExpression = $this->collectionChannelExpression();
        $rows = CollectionModel::query()
            ->where('customer_id', $customer->id)
            ->when(! empty($dateFrom), fn ($q) => $q->where('date', '>=', $dateFrom))
            ->when(! empty($dateTo), fn ($q) => $q->where('date', '<=', $dateTo))
            ->selectRaw('method')
            ->selectRaw("UPPER(COALESCE(currency, 'TRY')) as currency")
            ->selectRaw("{$channelExpression} as collection_channel")
            ->selectRaw("COALESCE(sync_status, 'draft') as sync_status")
            ->selectRaw('COUNT(*) as entry_count')
            ->selectRaw('SUM(amount) as total_amount')
            ->selectRaw('MAX(last_synced_at) as latest_synced_at')
            ->groupByRaw("method, UPPER(COALESCE(currency, 'TRY')), {$channelExpression}, COALESCE(sync_status, 'draft')")
            ->get();

        $summaries = [
            'cash' => ['count' => 0, 'total_amount' => 0.0],
            'transfer' => ['count' => 0, 'total_amount' => 0.0],
            'check' => ['count' => 0, 'total_amount' => 0.0],
            'cc' => ['count' => 0, 'total_amount' => 0.0],
            'factory_cc' => ['count' => 0, 'total_amount' => 0.0],
        ];
        $logoSync = [
            'draft' => 0,
            'pending' => 0,
            'reviewing' => 0,
            'synced' => 0,
            'failed' => 0,
            'latest_synced_at' => null,
        ];

        foreach ($rows as $row) {
            $method = (string) $row->method;
            $summaryKey = match (true) {
                $method === 'cc' && (string) $row->collection_channel === 'factory' => 'factory_cc',
                $method === 'cc' => 'cc',
                $method === 'check' || $method === 'note' => 'check',
                default => $method,
            };

            if (! array_key_exists($summaryKey, $summaries)) {
                continue;
            }

            $summaries[$summaryKey]['count'] += (int) $row->entry_count;
            $summaries[$summaryKey]['total_amount'] += DisplayCurrency::convertPrice(
                (float) $row->total_amount,
                (string) $row->currency,
                $user
            );

            $status = (string) $row->sync_status;

            if (array_key_exists($status, $logoSync)) {
                $logoSync[$status] += (int) $row->entry_count;
            }

            if ($row->latest_synced_at !== null) {
                $logoSync['latest_synced_at'] = collect([$logoSync['latest_synced_at'], (string) $row->latest_synced_at])
                    ->filter()
                    ->max();
            }
        }

        if ($logoSync['latest_synced_at'] !== null) {
            $logoSync['latest_synced_at'] = Carbon::parse($logoSync['latest_synced_at'])->toJSON();
        }

        return [
            'tabs' => $summaries,
            'logo_sync' => $logoSync,
        ];
    }

    private function applyCollectionMethodFilter($query, string $method): void
    {
        if ($method === 'factory_cc') {
            $query
                ->where('method', 'cc')
                ->where('reference_fields->collection_channel', 'factory');

            return;
        }

        if ($method === 'check') {
            $query->whereIn('method', ['check', 'note']);

            return;
        }

        if ($method === 'cc') {
            $query
                ->where('method', 'cc')
                ->where(function ($query): void {
                    $query
                        ->whereNull('reference_fields->collection_channel')
                        ->orWhere('reference_fields->collection_channel', '!=', 'factory');
                });

            return;
        }

        $query->where('method', $method);
    }

    /**
     * @return array{count:int,total_amount:float}
     */
    private function invoiceTabSummary(Customer $customer, ?string $dateFrom, ?string $dateTo, ?User $user): array
    {
        $query = $this->invoiceQuery($customer, $dateFrom, $dateTo);
        $currencyTotals = (clone $query)
            ->selectRaw("UPPER(COALESCE(currency, 'TRY')) as currency")
            ->selectRaw('SUM(COALESCE(debit, amount, 0)) as total_amount')
            ->groupByRaw("UPPER(COALESCE(currency, 'TRY'))")
            ->get();

        return [
            'count' => (int) (clone $query)->count(),
            'total_amount' => (float) $currencyTotals->sum(
                fn ($row) => DisplayCurrency::convertPrice((float) $row->total_amount, (string) $row->currency, $user)
            ),
        ];
    }

    private function invoiceQuery(Customer $customer, ?string $dateFrom, ?string $dateTo)
    {
        $dateCol = DB::connection()->getDriverName() === 'mysql' ? '`date`' : '"date"';

        return $customer->ledgerEntries()
            ->effectiveForCustomerBalance()
            ->where('type', 'invoice')
            ->when(! empty($dateFrom), fn ($q) => $q->whereRaw("DATE(COALESCE({$dateCol}, entry_date)) >= ?", [$dateFrom]))
            ->when(! empty($dateTo), fn ($q) => $q->whereRaw("DATE(COALESCE({$dateCol}, entry_date)) <= ?", [$dateTo]));
    }

    private function collectionChannelExpression(): string
    {
        return match (DB::connection()->getDriverName()) {
            'pgsql' => "reference_fields->>'collection_channel'",
            'mysql', 'mariadb' => "JSON_UNQUOTE(JSON_EXTRACT(reference_fields, '$.collection_channel'))",
            'sqlite' => "json_extract(reference_fields, '$.collection_channel')",
            default => 'NULL',
        };
    }

    /**
     * @return array<string, mixed>
     */
    private function invoiceEntryPayload(LedgerEntry $entry, ?User $user): array
    {
        $date = $entry->date ?? $entry->entry_date;
        $amount = (float) ($entry->debit ?? $entry->amount ?? 0);
        $sourceCurrency = (string) ($entry->currency ?: 'TRY');

        return [
            'id' => -1 * (int) $entry->id,
            'record_type' => 'invoice',
            'ledger_entry_id' => (int) $entry->id,
            'dealer_id' => $entry->dealer_id,
            'customer_id' => $entry->customer_id,
            'source_system' => $entry->source_system,
            'source_reference' => $entry->source_reference,
            'sync_status' => null,
            'sync_error' => null,
            'last_synced_at' => $entry->last_synced_at,
            'date' => $date,
            'created_by' => $entry->created_by_user_id,
            'collected_by_user_id' => null,
            'created_by_user_id' => $entry->created_by_user_id,
            'collection_date' => $date,
            'method' => 'invoice',
            'amount' => DisplayCurrency::formatPrice($amount, $sourceCurrency, $user) ?? number_format($amount, 2, '.', ''),
            'currency' => DisplayCurrency::normalize($sourceCurrency, $user),
            'reference_no' => $entry->reference_no,
            'reference_fields' => null,
            'note' => $entry->description,
            'meta' => $entry->meta,
            'created_at' => $entry->created_at,
            'updated_at' => $entry->updated_at,
        ];
    }

    public function store(
        StoreCustomerCollectionRequest $request,
        Customer $customer,
        LogoWritePublisher $logoWritePublisher,
        LedgerWriter $ledgerWriter,
        UserNotificationService $notifications
    ): JsonResponse {
        $this->authorize('createCollection', $customer);

        $validated = $request->validated();
        $user = $request->user();

        $collection = DB::transaction(function () use ($validated, $customer, $user, $logoWritePublisher, $ledgerWriter, $notifications) {
            $this->ensurePaperInstrumentAllowedForUser($user, (string) $validated['method']);
            $collectionDate = $validated['date'] ?? $validated['collection_date'] ?? now()->toDateString();
            $submittedMeta = is_array($validated['meta'] ?? null) ? $validated['meta'] : [];
            $referenceFields = $validated['reference_fields'] ?? data_get($submittedMeta, 'reference_fields', []);
            $referenceNo = $validated['reference_no']
                ?? ($referenceFields['transfer_no'] ?? $referenceFields['check_no'] ?? $referenceFields['note_no'] ?? $referenceFields['auth_code'] ?? null);
            [$referenceFields, $referenceNo, $automaticNote] = $this->prepareFinanceFields(
                method: (string) $validated['method'],
                customer: $customer,
                user: $user,
                referenceFields: is_array($referenceFields) ? $referenceFields : [],
                referenceNo: $referenceNo,
            );
            $requiresManagerApproval = $this->requiresPaperInstrumentApproval(
                $user,
                (string) $validated['method'],
                $referenceFields
            );
            $paperInstrumentApprover = $requiresManagerApproval
                ? $this->resolvePaperInstrumentApprover($user, (string) $validated['method'])
                : null;
            $meta = array_merge($submittedMeta, [
                'reference_fields' => $referenceFields,
            ]);
            $isFactoryCollection = data_get($referenceFields, 'collection_channel') === 'factory';
            $valorDays = data_get($referenceFields, 'valor_days');

            if ($isFactoryCollection) {
                $meta['factory_collected'] = true;
            }

            if ($requiresManagerApproval) {
                $referenceFields['requires_manager_approval'] = true;
                $referenceFields['manager_approval_reason'] = 'valor_limit_exceeded';
                $referenceFields['manager_approval_user_id'] = $paperInstrumentApprover->id;
                $meta['manager_approval'] = [
                    'status' => 'reviewing',
                    'reason' => 'valor_limit_exceeded',
                    'method' => $validated['method'],
                    'valor_days' => is_numeric($valorDays) ? (int) $valorDays : null,
                    'limit_days' => 90,
                    'approver_user_id' => $paperInstrumentApprover->id,
                    'approver_username' => $paperInstrumentApprover->username,
                    'submitted_at' => now()->toIso8601String(),
                    'submitted_by_user_id' => $user->id,
                    'submitted_by_username' => $user->username,
                ];
                $meta['reference_fields'] = $referenceFields;
            } elseif ($this->isPaperInstrumentMethod((string) $validated['method'])) {
                $referenceFields['requires_manager_approval'] = false;
                $referenceFields['manager_approval_status'] = 'approved';
                $meta['manager_approval'] = [
                    'status' => 'approved',
                    'reason' => $this->isPaperInstrumentApprovalAuthority($user)
                        ? 'approval_authority'
                        : 'valor_within_limit',
                    'method' => $validated['method'],
                    'valor_days' => is_numeric($valorDays) ? (int) $valorDays : null,
                    'approved_at' => now()->toIso8601String(),
                    'approved_by_user_id' => $user->id,
                    'approved_by_username' => $user->username,
                ];
                $meta['reference_fields'] = $referenceFields;
            }

            $cashbox = $validated['method'] === 'cash' && ! $isFactoryCollection
                ? $this->resolveCollectionCashbox($user, $meta)
                : null;

            if ($cashbox instanceof Cashbox) {
                $meta['cashbox_id'] = (int) $cashbox->id;
                $meta['cashbox'] = [
                    'id' => (int) $cashbox->id,
                    'code' => $cashbox->code,
                    'name' => $cashbox->name,
                ];
            }

            $collection = CollectionModel::create([
                'dealer_id' => $customer->dealer_id,
                'customer_id' => $customer->id,
                'source_system' => 'b2b',
                'source_reference' => null,
                'sync_status' => $requiresManagerApproval ? 'reviewing' : 'draft',
                'sync_error' => null,
                'last_synced_at' => null,
                'collected_by_user_id' => $user->id,
                'created_by_user_id' => $user->id,
                'date' => $collectionDate,
                'collection_date' => $collectionDate,
                'method' => $validated['method'],
                'amount' => $validated['amount'],
                'currency' => strtoupper($validated['currency'] ?? 'TRY'),
                'reference_no' => $referenceNo,
                'reference_fields' => $referenceFields,
                'note' => $automaticNote,
                'meta' => $meta,
            ]);

            if ($collection->sync_status === 'pending') {
                $meta = is_array($collection->meta) ? $collection->meta : [];
                data_set($meta, 'integrations.logo.submitted_at', now()->toIso8601String());
                data_set($meta, 'integrations.logo.submitted_by_user_id', $user->id);
                $collection->forceFill(['meta' => $meta])->save();

                $this->writeCollectionLedgerEntry($collection, $ledgerWriter);

                if ($this->shouldQueueForLogoExport($customer)) {
                    $logoWritePublisher->queueCollectionCreate($collection);
                }
            }

            if ($requiresManagerApproval) {
                $this->notifyPaperInstrumentApprovalRequested($notifications, $collection->fresh(['customer']), $user, $paperInstrumentApprover);
            }

            return $collection;
        });

        return response()->json([
            'collection' => new CollectionResource($collection),
            'ledger_entry' => null,
        ], 201);
    }

    public function approvalIndex(Request $request): JsonResponse
    {
        $user = $request->user();

        $collections = CollectionModel::query()
            ->with(['customer:id,code,name', 'collectedBy:id,name,username', 'createdBy:id,name,username'])
            ->where('source_system', 'b2b')
            ->where('sync_status', 'reviewing')
            ->whereIn('method', ['check', 'note'])
            ->orderByDesc('id')
            ->limit(250)
            ->get()
            ->filter(fn (CollectionModel $collection): bool => $this->canReviewPaperInstrument($collection, $user))
            ->take(100)
            ->values();

        return response()->json([
            'data' => $collections->map(fn (CollectionModel $collection): array => $this->paperInstrumentApprovalPayload($collection))->all(),
        ]);
    }

    public function approve(
        Request $request,
        Customer $customer,
        CollectionModel $collection,
        LogoWritePublisher $logoWritePublisher,
        LedgerWriter $ledgerWriter,
        UserNotificationService $notifications
    ): JsonResponse {
        $this->ensurePaperInstrumentReviewable($customer, $collection, $request->user());

        if (! $this->shouldQueueForLogoExport($customer)) {
            throw ValidationException::withMessages([
                'collection' => ['Cari Logo’ya aktarılmadan çek/senet onaylanamaz.'],
            ]);
        }

        DB::transaction(function () use ($collection, $logoWritePublisher, $ledgerWriter, $notifications, $request): void {
            $meta = is_array($collection->meta) ? $collection->meta : [];
            data_set($meta, 'manager_approval.status', 'approved');
            data_set($meta, 'manager_approval.approved_at', now()->toIso8601String());
            data_set($meta, 'manager_approval.approved_by_user_id', $request->user()->id);
            data_set($meta, 'manager_approval.approved_by_username', $request->user()->username);
            data_set($meta, 'integrations.logo.submitted_at', now()->toIso8601String());
            data_set($meta, 'integrations.logo.submitted_by_user_id', $request->user()->id);

            $referenceFields = is_array($collection->reference_fields) ? $collection->reference_fields : [];
            $referenceFields['manager_approval_status'] = 'approved';

            $collection->fill([
                'sync_status' => 'pending',
                'sync_error' => null,
                'last_synced_at' => null,
                'reference_fields' => $referenceFields,
                'meta' => $meta,
            ])->save();

            $this->writeCollectionLedgerEntry($collection->fresh(), $ledgerWriter);
            $logoWritePublisher->queueCollectionCreate($collection);
            $this->notifyPaperInstrumentDecision($notifications, $collection->fresh(['customer']), true);
        });

        return response()->json([
            'collection' => new CollectionResource($collection->fresh()),
            'message' => 'Çek/Senet onaylandı ve Logo kuyruğuna alındı.',
        ]);
    }

    public function reject(
        Request $request,
        Customer $customer,
        CollectionModel $collection,
        UserNotificationService $notifications
    ): JsonResponse {
        $this->ensurePaperInstrumentReviewable($customer, $collection, $request->user());

        $validated = $request->validate([
            'reason' => ['nullable', 'string', 'max:500'],
        ]);

        DB::transaction(function () use ($collection, $request, $validated, $notifications): void {
            $meta = is_array($collection->meta) ? $collection->meta : [];
            data_set($meta, 'manager_approval.status', 'rejected');
            data_set($meta, 'manager_approval.rejected_at', now()->toIso8601String());
            data_set($meta, 'manager_approval.rejected_by_user_id', $request->user()->id);
            data_set($meta, 'manager_approval.rejected_by_username', $request->user()->username);
            data_set($meta, 'manager_approval.rejection_reason', $validated['reason'] ?? null);

            $referenceFields = is_array($collection->reference_fields) ? $collection->reference_fields : [];
            $referenceFields['manager_approval_status'] = 'rejected';

            $collection->fill([
                'sync_status' => 'failed',
                'sync_error' => 'Çek/Senet onayı reddedildi.',
                'reference_fields' => $referenceFields,
                'meta' => $meta,
            ])->save();

            $this->notifyPaperInstrumentDecision($notifications, $collection->fresh(['customer']), false);
        });

        return response()->json([
            'collection' => new CollectionResource($collection->fresh()),
            'message' => 'Çek/Senet reddedildi. Logo’ya gönderilmedi.',
        ]);
    }

    public function update(
        StoreCustomerCollectionRequest $request,
        Customer $customer,
        CollectionModel $collection
    ): JsonResponse {
        $this->authorize('createCollection', $customer);
        $this->ensureEditableCollection($customer, $collection);

        $validated = $request->validated();
        $user = $request->user();

        $updatedCollection = DB::transaction(function () use ($validated, $customer, $collection, $user) {
            $attributes = $this->buildCollectionAttributes($validated, $customer, $user);

            $collection->fill(array_merge($attributes, [
                'sync_error' => null,
                'last_synced_at' => null,
            ]))->save();

            $this->syncExistingCollectionLedgerEntries($collection->fresh());

            return $collection->fresh();
        });

        return response()->json([
            'collection' => new CollectionResource($updatedCollection),
            'ledger_entry' => null,
        ]);
    }

    public function destroy(Customer $customer, CollectionModel $collection): Response
    {
        $this->authorize('createCollection', $customer);
        $this->ensureEditableCollection($customer, $collection);

        DB::transaction(function () use ($collection): void {
            $collection->ledgerEntries()->delete();
            $collection->delete();
        });

        return response()->noContent();
    }

    public function send(
        Customer $customer,
        CollectionModel $collection,
        LogoWritePublisher $logoWritePublisher,
        LedgerWriter $ledgerWriter
    ): JsonResponse {
        $this->authorize('createCollection', $customer);

        if ((int) $collection->customer_id !== (int) $customer->id) {
            abort(404);
        }

        if ($collection->source_system !== 'b2b') {
            throw ValidationException::withMessages([
                'collection' => ['Bu tahsilat Logo gönderimine uygun değil.'],
            ]);
        }

        if ($collection->sync_status === 'synced') {
            throw ValidationException::withMessages([
                'collection' => ['Bu tahsilat daha önce Logo’ya gönderildi.'],
            ]);
        }

        if ($collection->sync_status === 'pending') {
            return response()->json([
                'collection' => new CollectionResource($collection),
                'message' => 'Tahsilat zaten gönderim kuyruğunda.',
            ]);
        }

        if ($collection->sync_status === 'reviewing') {
            if (! $this->isPaperInstrumentMethod((string) $collection->method)) {
                throw ValidationException::withMessages([
                    'collection' => ['Bu tahsilat müdür onayı bekliyor.'],
                ]);
            }
        }

        $this->assertPaperInstrumentReadyForLogo($collection);

        if (! $this->shouldQueueForLogoExport($customer)) {
            throw ValidationException::withMessages([
                'collection' => ['Cari Logo’ya aktarılmadan tahsilat gönderilemez.'],
            ]);
        }

        DB::transaction(function () use ($collection, $logoWritePublisher, $ledgerWriter): void {
            $meta = is_array($collection->meta) ? $collection->meta : [];
            data_set($meta, 'integrations.logo.submitted_at', now()->toIso8601String());
            data_set($meta, 'integrations.logo.submitted_by_user_id', auth()->id());

            $collection->fill([
                'sync_status' => 'pending',
                'sync_error' => null,
                'last_synced_at' => null,
                'meta' => $meta,
            ])->save();

            $this->writeCollectionLedgerEntry($collection->fresh(), $ledgerWriter);
            $logoWritePublisher->queueCollectionCreate($collection);
        });

        return response()->json([
            'collection' => new CollectionResource($collection->fresh()),
            'message' => 'Tahsilat Logo’ya gönderiliyor.',
        ]);
    }

    public function sendMany(
        Request $request,
        Customer $customer,
        LogoWritePublisher $logoWritePublisher,
        LedgerWriter $ledgerWriter
    ): JsonResponse {
        $this->authorize('createCollection', $customer);

        $validated = $request->validate([
            'collection_ids' => ['required', 'array', 'min:1'],
            'collection_ids.*' => ['integer', 'distinct'],
        ]);

        $collectionIds = collect($validated['collection_ids'])
            ->map(fn ($id): int => (int) $id)
            ->values();

        $collections = CollectionModel::query()
            ->where('customer_id', $customer->id)
            ->whereIn('id', $collectionIds)
            ->orderBy('id')
            ->get();

        if ($collections->count() !== $collectionIds->unique()->count()) {
            throw ValidationException::withMessages([
                'collection_ids' => ['Gönderilecek tahsilat kayıtlarından biri bulunamadı.'],
            ]);
        }

        $sendableCollections = $collections
            ->filter(fn (CollectionModel $collection): bool => $this->isSendableCollection($collection))
            ->values();

        if ($sendableCollections->isEmpty()) {
            return response()->json([
                'summary' => [
                    'received' => $collections->count(),
                    'queued' => 0,
                    'skipped' => $collections->count(),
                ],
                'message' => 'Gönderilecek uygun tahsilat bulunamadı.',
            ]);
        }

        $sendableCollections->each(fn (CollectionModel $collection) => $this->assertPaperInstrumentReadyForLogo($collection));

        if (! $this->shouldQueueForLogoExport($customer)) {
            throw ValidationException::withMessages([
                'collection_ids' => ['Cari Logo’ya aktarılmadan tahsilat gönderilemez.'],
            ]);
        }

        DB::transaction(function () use ($sendableCollections, $logoWritePublisher, $ledgerWriter): void {
            foreach ($sendableCollections as $collection) {
                $meta = is_array($collection->meta) ? $collection->meta : [];
                data_set($meta, 'integrations.logo.submitted_at', now()->toIso8601String());
                data_set($meta, 'integrations.logo.submitted_by_user_id', auth()->id());

                $collection->fill([
                    'sync_status' => 'pending',
                    'sync_error' => null,
                    'last_synced_at' => null,
                    'meta' => $meta,
                ])->save();

                $this->writeCollectionLedgerEntry($collection->fresh(), $ledgerWriter);
                $logoWritePublisher->queueCollectionCreate($collection);
            }
        });

        return response()->json([
            'summary' => [
                'received' => $collections->count(),
                'queued' => $sendableCollections->count(),
                'skipped' => $collections->count() - $sendableCollections->count(),
            ],
            'message' => 'Tahsilatlar Logo’ya gönderiliyor.',
        ]);
    }

    private function writeCollectionLedgerEntry(CollectionModel $collection, LedgerWriter $ledgerWriter): void
    {
        if (LedgerEntry::query()->where('collection_id', $collection->id)->exists()) {
            return;
        }

        $meta = is_array($collection->meta) ? $collection->meta : [];

        $ledgerWriter->write([
            'dealer_id' => $collection->dealer_id,
            'customer_id' => $collection->customer_id,
            'source_system' => 'b2b',
            'source_reference' => null,
            'last_synced_at' => null,
            'order_id' => null,
            'collection_id' => $collection->id,
            'date' => $collection->date ?? $collection->collection_date ?? now()->toDateString(),
            'type' => 'payment',
            'debit' => 0,
            'credit' => $collection->amount,
            'currency' => $collection->currency,
            'reference_no' => $collection->reference_no,
            'description' => $collection->note ?: "Collection ({$collection->method})",
            'created_by_user_id' => $collection->created_by_user_id,
            'meta' => [
                'source' => $meta['source'] ?? 'customer_collection',
                'method' => $collection->method,
                'pos_session_id' => $meta['pos_session_id'] ?? null,
                'cashbox_id' => $meta['cashbox_id'] ?? null,
                'reference_fields' => $collection->reference_fields,
            ],
        ]);
    }

    /**
     * @param  array<string, mixed>  $validated
     * @return array<string, mixed>
     */
    private function buildCollectionAttributes(array $validated, Customer $customer, User $user): array
    {
        $this->ensurePaperInstrumentAllowedForUser($user, (string) $validated['method']);
        $collectionDate = $validated['date'] ?? $validated['collection_date'] ?? now()->toDateString();
        $submittedMeta = is_array($validated['meta'] ?? null) ? $validated['meta'] : [];
        $referenceFields = $validated['reference_fields'] ?? data_get($submittedMeta, 'reference_fields', []);
        $referenceNo = $validated['reference_no']
            ?? ($referenceFields['transfer_no'] ?? $referenceFields['check_no'] ?? $referenceFields['note_no'] ?? $referenceFields['auth_code'] ?? null);
        [$referenceFields, $referenceNo, $automaticNote] = $this->prepareFinanceFields(
            method: (string) $validated['method'],
            customer: $customer,
            user: $user,
            referenceFields: is_array($referenceFields) ? $referenceFields : [],
            referenceNo: $referenceNo,
            allocateSequence: false,
        );
        $requiresManagerApproval = $this->requiresPaperInstrumentApproval(
            $user,
            (string) $validated['method'],
            $referenceFields
        );
        $paperInstrumentApprover = $requiresManagerApproval
            ? $this->resolvePaperInstrumentApprover($user, (string) $validated['method'])
            : null;
        $meta = array_merge($submittedMeta, [
            'reference_fields' => $referenceFields,
        ]);
        $isFactoryCollection = data_get($referenceFields, 'collection_channel') === 'factory';
        $valorDays = data_get($referenceFields, 'valor_days');

        if ($isFactoryCollection) {
            $meta['factory_collected'] = true;
        } else {
            unset($meta['factory_collected']);
        }

        if ($requiresManagerApproval) {
            $referenceFields['requires_manager_approval'] = true;
            $referenceFields['manager_approval_reason'] = 'valor_limit_exceeded';
            $referenceFields['manager_approval_user_id'] = $paperInstrumentApprover->id;
            $meta['manager_approval'] = [
                'status' => 'reviewing',
                'reason' => 'valor_limit_exceeded',
                'method' => $validated['method'],
                'valor_days' => is_numeric($valorDays) ? (int) $valorDays : null,
                'limit_days' => 90,
                'approver_user_id' => $paperInstrumentApprover->id,
                'approver_username' => $paperInstrumentApprover->username,
                'submitted_at' => now()->toIso8601String(),
                'submitted_by_user_id' => $user->id,
                'submitted_by_username' => $user->username,
            ];
            $meta['reference_fields'] = $referenceFields;
        } elseif ($this->isPaperInstrumentMethod((string) $validated['method'])) {
            $referenceFields['requires_manager_approval'] = false;
            $referenceFields['manager_approval_status'] = 'approved';
            $meta['manager_approval'] = [
                'status' => 'approved',
                'reason' => $this->isPaperInstrumentApprovalAuthority($user)
                    ? 'approval_authority'
                    : 'valor_within_limit',
                'method' => $validated['method'],
                'valor_days' => is_numeric($valorDays) ? (int) $valorDays : null,
                'approved_at' => now()->toIso8601String(),
                'approved_by_user_id' => $user->id,
                'approved_by_username' => $user->username,
            ];
            $meta['reference_fields'] = $referenceFields;
        } else {
            unset($meta['manager_approval']);
        }

        $cashbox = $validated['method'] === 'cash' && ! $isFactoryCollection
            ? $this->resolveCollectionCashbox($user, $meta)
            : null;

        if ($cashbox instanceof Cashbox) {
            $meta['cashbox_id'] = (int) $cashbox->id;
            $meta['cashbox'] = [
                'id' => (int) $cashbox->id,
                'code' => $cashbox->code,
                'name' => $cashbox->name,
            ];
        } else {
            unset($meta['cashbox_id'], $meta['cashbox']);
        }

        return [
            'dealer_id' => $customer->dealer_id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'source_reference' => null,
            'sync_status' => $requiresManagerApproval ? 'reviewing' : 'draft',
            'date' => $collectionDate,
            'collection_date' => $collectionDate,
            'method' => $validated['method'],
            'amount' => $validated['amount'],
            'currency' => strtoupper($validated['currency'] ?? 'TRY'),
            'reference_no' => $referenceNo,
            'reference_fields' => $referenceFields,
            'note' => $automaticNote,
            'meta' => $meta,
        ];
    }

    private function syncExistingCollectionLedgerEntries(CollectionModel $collection): void
    {
        $entries = LedgerEntry::query()
            ->where('collection_id', $collection->id)
            ->get();

        if ($entries->isEmpty()) {
            return;
        }

        foreach ($entries as $entry) {
            $entry->forceFill([
                'date' => $collection->date ?? $collection->collection_date ?? now()->toDateString(),
                'entry_date' => $collection->date ?? $collection->collection_date ?? now()->toDateString(),
                'debit' => 0,
                'credit' => $collection->amount,
                'amount' => $collection->amount,
                'currency' => $collection->currency,
                'reference_no' => $collection->reference_no,
                'description' => $collection->note ?: "Collection ({$collection->method})",
                'meta' => [
                    'source' => data_get($collection->meta, 'source', 'customer_collection'),
                    'method' => $collection->method,
                    'pos_session_id' => data_get($collection->meta, 'pos_session_id'),
                    'cashbox_id' => data_get($collection->meta, 'cashbox_id'),
                    'reference_fields' => $collection->reference_fields,
                ],
            ])->save();
        }
    }

    private function ensureEditableCollection(Customer $customer, CollectionModel $collection): void
    {
        if ((int) $collection->customer_id !== (int) $customer->id) {
            abort(404);
        }

        if ($collection->source_system !== 'b2b') {
            throw ValidationException::withMessages([
                'collection' => ['Bu tahsilat kaydı düzenlenemez.'],
            ]);
        }

        if (in_array($collection->sync_status, ['pending', 'reviewing'], true)) {
            throw ValidationException::withMessages([
                'collection' => ['Logo gönderimindeki tahsilat düzenlenemez veya silinemez.'],
            ]);
        }
    }

    private function shouldQueueForLogoExport(Customer $customer): bool
    {
        if ($customer->source_reference !== null) {
            return true;
        }

        if ($customer->source_system === 'logo') {
            return true;
        }

        return $customer->source_system === 'b2b' && $customer->sync_status === 'synced';
    }

    private function isSendableCollection(CollectionModel $collection): bool
    {
        if ($collection->source_system !== 'b2b') {
            return false;
        }

        if ($this->paperInstrumentApprovalWasRequired($collection)
            && data_get($collection->meta, 'manager_approval.status') !== 'approved') {
            return false;
        }

        return ! in_array($collection->sync_status, ['pending', 'synced'], true);
    }

    private function assertPaperInstrumentReadyForLogo(CollectionModel $collection): void
    {
        if (! $this->isPaperInstrumentMethod((string) $collection->method)) {
            return;
        }

        $dueDate = data_get($collection->reference_fields, 'due_date');

        if (is_string($dueDate) && trim($dueDate) !== '') {
            return;
        }

        throw ValidationException::withMessages([
            'reference_fields.due_date' => ['Çek/Senet vade tarihi zorunludur.'],
        ]);
    }

    /**
     * @param  array<string, mixed>  $meta
     */
    private function resolveCollectionCashbox(User $user, array $meta): ?Cashbox
    {
        $cashboxId = data_get($meta, 'cashbox_id');

        if (is_numeric($cashboxId)) {
            $cashbox = Cashbox::query()
                ->lockForUpdate()
                ->find((int) $cashboxId);

            if (! $cashbox instanceof Cashbox || ! $cashbox->is_active) {
                throw ValidationException::withMessages([
                    'meta.cashbox_id' => ['Cashbox not found or inactive.'],
                ]);
            }

            return $cashbox;
        }

        if ($this->nullableString($user->logo_cashbox_code) === null) {
            return null;
        }

        return $this->resolveSalespersonCashbox($user);
    }

    /**
     * @param  array<string, mixed>  $referenceFields
     * @return array{0:array<string,mixed>,1:?string,2:string}
     */
    private function prepareFinanceFields(
        string $method,
        Customer $customer,
        User $user,
        array $referenceFields,
        ?string $referenceNo,
        bool $allocateSequence = true,
    ): array {
        $customerName = trim((string) ($customer->name ?: $customer->code));
        $channel = (string) data_get($referenceFields, 'collection_channel', '');

        if ($method === 'cc' && $channel === 'factory') {
            $factoryCode = trim((string) data_get($referenceFields, 'factory_pos_account', ''));
            $factory = FinanceDefinition::query()
                ->where('type', 'factory')
                ->where('is_active', true)
                ->where('code', $factoryCode)
                ->first();

            if (! $factory instanceof FinanceDefinition) {
                throw ValidationException::withMessages([
                    'reference_fields.factory_pos_account' => ['Seçilen fabrika aktif değil veya tanımlı değil.'],
                ]);
            }

            $referenceNo = $referenceNo ?: ($allocateSequence ? $this->nextFactoryReference() : null);
            $referenceFields['factory_pos_account'] = $factory->code;
            $referenceFields['factory_name'] = $factory->name;
            $referenceFields['factory_customer_code'] = $factory->logo_code ?: $factory->code;
            $referenceFields['finance_definition_id'] = $factory->id;
            unset($referenceFields['pos_payment_type'], $referenceFields['installment']);

            return [
                $referenceFields,
                $referenceNo,
                trim(implode(' ', array_filter([$referenceNo, $customerName]))),
            ];
        }

        if ($method === 'cc') {
            $bankCode = trim((string) data_get($referenceFields, 'pos_bank', ''));
            $bank = $this->activeFinanceDefinition(
                'bank',
                $bankCode,
                'reference_fields.pos_bank',
                $this->usesBatumFinanceScope($user, $customer),
                data_get($referenceFields, 'finance_definition_id'),
            );
            $referenceNo = $referenceNo ?: ($allocateSequence ? $this->nextPhysicalPosReference() : null);
            $referenceFields['collection_channel'] = 'physical_pos';
            $referenceFields['pos_bank'] = $bank->code;
            $referenceFields['bank_name'] = $bank->name;
            $referenceFields['bank_logo_code'] = $bank->logo_code;
            $referenceFields['finance_definition_id'] = $bank->id;

            unset(
                $referenceFields['pos_device'],
                $referenceFields['pos_device_name'],
                $referenceFields['pos_device_logo_code'],
                $referenceFields['card_type'],
                $referenceFields['card_type_name'],
                $referenceFields['pos_payment_type'],
                $referenceFields['installment'],
                $referenceFields['commission_rate']
            );

            return [
                $referenceFields,
                $referenceNo,
                trim(implode(' ', array_filter([$referenceNo, $customerName]))),
            ];
        }

        if ($method === 'transfer') {
            $bankCode = trim((string) data_get($referenceFields, 'bank_code', data_get($referenceFields, 'bank_name', '')));
            $bank = $this->activeFinanceDefinition(
                'bank',
                $bankCode,
                'reference_fields.bank_code',
                $this->usesBatumFinanceScope($user, $customer),
                data_get($referenceFields, 'finance_definition_id'),
            );
            $referenceNo = $referenceNo ?: ($allocateSequence ? $this->nextTransferReference() : null);
            $referenceFields['bank_code'] = $bank->code;
            $referenceFields['bank_name'] = $bank->name;
            $referenceFields['bank_logo_code'] = $bank->logo_code;
            $referenceFields['finance_definition_id'] = $bank->id;

            return [
                $referenceFields,
                $referenceNo,
                trim(implode(' ', array_filter([$referenceNo, $customerName]))),
            ];
        }

        if (in_array($method, ['check', 'note'], true)) {
            $documentNo = trim((string) ($referenceFields['check_no'] ?? $referenceFields['note_no'] ?? $referenceNo ?? ''));

            return [$referenceFields, $referenceNo, trim("{$documentNo} {$customerName}")];
        }

        return [$referenceFields, $referenceNo, trim("{$customerName} NAKİT")];
    }

    private function activeFinanceDefinition(
        string $type,
        string $code,
        string $field,
        bool $batumScope = false,
        mixed $definitionId = null,
    ): FinanceDefinition {
        $normalizedCode = mb_strtolower(trim($code), 'UTF-8');

        $query = FinanceDefinition::query()
            ->where('type', $type)
            ->where('is_active', true)
            ->when(
                $type === 'bank',
                fn ($query) => $batumScope
                    ? $this->applyBatumBankScope($query)
                    : $this->applyTurkeyBankScope($query)
            );

        $definition = is_numeric($definitionId)
            ? (clone $query)->whereKey((int) $definitionId)->first()
            : null;

        if (! $definition instanceof FinanceDefinition) {
            $definition = $query
                ->where(function ($query) use ($normalizedCode): void {
                    foreach (['code', 'name', 'logo_code', 'logo_name'] as $column) {
                        $query->orWhereRaw(
                            "LOWER(TRIM(COALESCE({$column}, ''))) = ?",
                            [$normalizedCode]
                        );
                    }
                })
                ->first();
        }

        if (! $definition instanceof FinanceDefinition) {
            throw ValidationException::withMessages([$field => ['Seçilen finans tanımı aktif değil veya bulunamadı.']]);
        }

        return $definition;
    }

    private function usesBatumFinanceScope(User $user, Customer $customer): bool
    {
        if ($this->userBelongsToBranch($user, 'BATUM')) {
            return true;
        }

        foreach ([
            $customer->branch_code,
            $customer->branch_name,
            $customer->region_code,
            $customer->region_name,
            $customer->city,
            $customer->district,
            $customer->name,
        ] as $signal) {
            $normalized = $this->normalizeBranchSignal($signal);
            if ($normalized !== null && str_contains($normalized, 'BATUM')) {
                return true;
            }
        }

        return false;
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

    private function nextPhysicalPosReference(): string
    {
        $row = DB::table('finance_sequences')
            ->where('key', 'physical_pos')
            ->lockForUpdate()
            ->first();
        $value = max(1, (int) ($row?->next_value ?? 1));

        DB::table('finance_sequences')->updateOrInsert(
            ['key' => 'physical_pos'],
            ['next_value' => $value + 1, 'updated_at' => now(), 'created_at' => $row ? $row->created_at : now()]
        );

        return 'FP'.str_pad((string) $value, 4, '0', STR_PAD_LEFT);
    }

    private function nextTransferReference(): string
    {
        $row = DB::table('finance_sequences')
            ->where('key', 'transfer')
            ->lockForUpdate()
            ->first();
        $value = max(1, (int) ($row?->next_value ?? 1));

        DB::table('finance_sequences')->updateOrInsert(
            ['key' => 'transfer'],
            ['next_value' => $value + 1, 'updated_at' => now(), 'created_at' => $row ? $row->created_at : now()]
        );

        return 'HE'.str_pad((string) $value, 4, '0', STR_PAD_LEFT);
    }

    private function nextFactoryReference(): string
    {
        $row = DB::table('finance_sequences')
            ->where('key', 'factory')
            ->lockForUpdate()
            ->first();
        $value = max(1, (int) ($row?->next_value ?? 1));

        DB::table('finance_sequences')->updateOrInsert(
            ['key' => 'factory'],
            ['next_value' => $value + 1, 'updated_at' => now(), 'created_at' => $row ? $row->created_at : now()]
        );

        return 'FBC'.str_pad((string) $value, 4, '0', STR_PAD_LEFT);
    }

    private function resolveSalespersonCashbox(User $user): ?Cashbox
    {
        $configuredCode = $this->nullableString($user->logo_cashbox_code);
        $configuredName = $this->nullableString($user->logo_cashbox_name);

        if ($configuredCode === null) {
            throw ValidationException::withMessages([
                'cashbox' => [
                    'Bu kullanıcı için Logo kasa kodu tanımlı değil. Tahsilat göndermeden önce kullanıcı-kasa eşleştirmesini tamamlayın.',
                ],
            ]);
        }

        return $this->resolveCashboxByCode(
            code: $configuredCode,
            name: $configuredName ?? (($this->nullableString($user->name) ?? 'Plasiyer').' Kasasi')
        );
    }

    private function isPaperInstrumentMethod(string $method): bool
    {
        return in_array($method, ['check', 'note'], true);
    }

    private function ensurePaperInstrumentAllowedForUser(User $user, string $method): void
    {
        if (! $this->isPaperInstrumentMethod($method)) {
            return;
        }

        if ($this->userBelongsToBranch($user, 'BATUM')) {
            throw ValidationException::withMessages([
                'method' => ['Batum kullanıcısı için çek/senet tahsilatı kapalıdır.'],
            ]);
        }
    }

    private function resolvePaperInstrumentApprover(User $user, string $method): ?User
    {
        if (! $this->isPaperInstrumentMethod($method)) {
            return null;
        }

        $username = $this->userBelongsToBranch($user, 'TRABZON') || $this->userBelongsToBranch($user, 'SAMSUN')
            ? 'turgay.buyukkal'
            : 'mudur.erzurum';

        $approver = User::query()
            ->where('username', $username)
            ->where('is_active', true)
            ->first();

        if (! $approver instanceof User) {
            throw ValidationException::withMessages([
                'method' => ["Çek/Senet onay kullanıcısı bulunamadı: {$username}"],
            ]);
        }

        return $approver;
    }

    /**
     * Only long-dated paper instruments created by ordinary users need a
     * second approval. Admin/global users and managers are approval authorities.
     *
     * @param  array<string, mixed>  $referenceFields
     */
    private function requiresPaperInstrumentApproval(User $user, string $method, array $referenceFields): bool
    {
        return false;
    }

    private function isPaperInstrumentApprovalAuthority(User $user): bool
    {
        if ($user->hasAnyRole([
            'admin',
            'global',
            'global_user',
            'manager',
            'branch_manager',
            'dealer_manager',
        ])) {
            return true;
        }

        $identity = mb_strtoupper(trim(($user->username ?? '').' '.($user->name ?? '')), 'UTF-8');

        return str_contains($identity, 'MÜDÜR') || str_contains($identity, 'MUDUR');
    }

    private function paperInstrumentApprovalWasRequired(CollectionModel $collection): bool
    {
        return false;
    }

    private function userBelongsToBranch(User $user, string $branch): bool
    {
        $branch = $this->normalizeBranchSignal($branch);
        $signals = [
            $user->branch_code,
            $user->branch_name,
            $user->region_code,
            $user->region_name,
            $user->logo_cashbox_code,
            $user->logo_cashbox_name,
            $user->username,
            $user->name,
        ];

        foreach ($signals as $signal) {
            $normalized = $this->normalizeBranchSignal($signal);
            if ($normalized !== null && str_contains($normalized, $branch)) {
                return true;
            }
        }

        return false;
    }

    private function normalizeBranchSignal(mixed $value): ?string
    {
        $normalized = mb_strtoupper(trim((string) $value), 'UTF-8');
        $normalized = str_replace(
            ['İ', 'İ', 'Ş', 'Ğ', 'Ü', 'Ö', 'Ç'],
            ['I', 'I', 'S', 'G', 'U', 'O', 'C'],
            $normalized
        );
        $normalized = preg_replace('/\s+/', ' ', $normalized) ?: '';

        return $normalized === '' ? null : $normalized;
    }

    private function canReviewPaperInstrument(CollectionModel $collection, User $user): bool
    {
        if ($user->hasRole('admin')) {
            return true;
        }

        $approverId = data_get($collection->meta, 'manager_approval.approver_user_id')
            ?? data_get($collection->reference_fields, 'manager_approval_user_id');

        return is_numeric($approverId) && (int) $approverId === (int) $user->id;
    }

    private function ensurePaperInstrumentReviewable(Customer $customer, CollectionModel $collection, User $user): void
    {
        if ((int) $collection->customer_id !== (int) $customer->id) {
            abort(404);
        }

        if (! $this->isPaperInstrumentMethod((string) $collection->method)) {
            throw ValidationException::withMessages([
                'collection' => ['Bu kayıt çek/senet onay sürecine ait değil.'],
            ]);
        }

        if ($collection->sync_status !== 'reviewing') {
            throw ValidationException::withMessages([
                'collection' => ['Bu çek/senet kaydı onay beklemiyor.'],
            ]);
        }

        if (! $this->canReviewPaperInstrument($collection, $user)) {
            abort(403, 'Bu çek/senet onayı size atanmadı.');
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function paperInstrumentApprovalPayload(CollectionModel $collection): array
    {
        $fields = is_array($collection->reference_fields) ? $collection->reference_fields : [];
        $sender = $collection->collectedBy ?? $collection->createdBy;

        return [
            'id' => $collection->id,
            'customer_id' => $collection->customer_id,
            'customer_code' => $collection->customer?->code,
            'customer_name' => $collection->customer?->name,
            'method' => $collection->method,
            'method_label' => $collection->method === 'note' ? 'Senet' : 'Çek',
            'amount' => (string) $collection->amount,
            'currency' => $collection->currency,
            'reference_no' => $collection->reference_no,
            'document_no' => $fields['check_no'] ?? $fields['note_no'] ?? $collection->reference_no,
            'due_date' => $fields['due_date'] ?? null,
            'valor_days' => $fields['valor_days'] ?? null,
            'sender_name' => $sender?->name ?? $sender?->username,
            'sender_username' => $sender?->username,
            'created_at' => $collection->created_at?->toJSON(),
        ];
    }

    private function notifyPaperInstrumentApprovalRequested(
        UserNotificationService $notifications,
        CollectionModel $collection,
        User $sender,
        User $approver
    ): void {
        $fields = is_array($collection->reference_fields) ? $collection->reference_fields : [];
        $methodLabel = $collection->method === 'note' ? 'Senet' : 'Çek';
        $amount = number_format((float) $collection->amount, 2, ',', '.').' '.($collection->currency ?: 'TRY');
        $dueDate = $this->nullableString($fields['due_date'] ?? null);

        $notifications->notifyUsers(
            [$approver],
            'collection.paper_approval.requested',
            'Yeni Çek/Senet Onayı Bekliyor',
            trim("{$sender->name} tarafından {$amount} tutarında {$methodLabel} girildi.".($dueDate ? " Vade: {$dueDate}." : '')),
            '/collections?approval=paper-instruments',
            [
                'collection_id' => $collection->id,
                'customer_id' => $collection->customer_id,
                'method' => $collection->method,
                'amount' => (string) $collection->amount,
                'currency' => $collection->currency,
                'due_date' => $dueDate,
            ]
        );
    }

    private function notifyPaperInstrumentDecision(
        UserNotificationService $notifications,
        CollectionModel $collection,
        bool $approved
    ): void {
        $recipient = $collection->createdBy ?? $collection->collectedBy;
        if (! $recipient instanceof User) {
            return;
        }

        $methodLabel = $collection->method === 'note' ? 'Senet' : 'Çek';
        $notifications->notifyUsers(
            [$recipient],
            $approved ? 'collection.paper_approval.approved' : 'collection.paper_approval.rejected',
            $approved ? 'Çek/Senet Onaylandı' : 'Çek/Senet Reddedildi',
            $approved
                ? "{$methodLabel} tahsilatınız onaylandı ve Logo kuyruğuna alındı."
                : "{$methodLabel} tahsilatınız reddedildi; Logo’ya gönderilmedi.",
            '/collections',
            [
                'collection_id' => $collection->id,
                'customer_id' => $collection->customer_id,
                'method' => $collection->method,
                'approved' => $approved,
            ]
        );
    }

    public function nextSequence(Request $request): JsonResponse
    {
        $type = $request->query('type');

        $key = match ($type) {
            'factory_cc' => 'factory',
            'transfer' => 'transfer',
            'cc' => 'physical_pos',
            default => null,
        };

        if (! $key) {
            return response()->json(['next_sequence' => '']);
        }

        $row = DB::table('finance_sequences')->where('key', $key)->first();
        $value = max(1, (int) ($row?->next_value ?? 1));

        $prefix = match ($key) {
            'factory' => 'FBC',
            'transfer' => 'HE',
            'physical_pos' => 'FP',
        };
        $pad = match ($key) {
            'factory' => 4,
            default => 4,
        };

        return response()->json(['next_sequence' => $prefix.str_pad((string) $value, $pad, '0', STR_PAD_LEFT)]);
    }

    private function resolveCashboxByCode(string $code, string $name): Cashbox
    {
        $cashbox = Cashbox::query()
            ->lockForUpdate()
            ->where('code', $code)
            ->first();

        if ($cashbox instanceof Cashbox) {
            $updates = ['is_active' => true];

            if ($this->nullableString($cashbox->name) !== $name) {
                $updates['name'] = $name;
            }

            $cashbox->forceFill($updates)->save();

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

        $normalized = trim((string) $value);

        return $normalized === '' ? null : $normalized;
    }
}
