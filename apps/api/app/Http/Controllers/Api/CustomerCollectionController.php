<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Customer\CustomerCollectionIndexRequest;
use App\Http\Requests\Customer\StoreCustomerCollectionRequest;
use App\Http\Resources\CollectionResource;
use App\Models\Cashbox;
use App\Models\Collection as CollectionModel;
use App\Models\Customer;
use App\Models\LedgerEntry;
use App\Models\User;
use App\Services\Integrations\Logo\LogoWritePublisher;
use App\Services\Ledger\LedgerWriter;
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
        $dateCol = DB::connection()->getDriverName() === 'mysql' ? '`date`' : '"date"';
        $dateColumn = "COALESCE({$dateCol}, collection_date)";
        $user = $request->user();
        $displayUser = $user instanceof User ? $user : null;
        $collectionSummary = $this->collectionSummaryPayload($customer, $dateFrom, $dateTo, $displayUser);

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
            ->when(! empty($dateFrom), fn ($q) => $q->whereRaw("DATE({$dateColumn}) >= ?", [$dateFrom]))
            ->when(! empty($dateTo), fn ($q) => $q->whereRaw("DATE({$dateColumn}) <= ?", [$dateTo]))
            ->orderByRaw("{$dateColumn} DESC")
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
                ->map(fn ($item) => (new CollectionResource($item))->toArray($request))
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
        $dateColumn = "COALESCE({$dateCol}, collection_date)";
        $channelExpression = $this->collectionChannelExpression();
        $rows = CollectionModel::query()
            ->where('customer_id', $customer->id)
            ->when(! empty($dateFrom), fn ($q) => $q->whereRaw("DATE({$dateColumn}) >= ?", [$dateFrom]))
            ->when(! empty($dateTo), fn ($q) => $q->whereRaw("DATE({$dateColumn}) <= ?", [$dateTo]))
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
        LedgerWriter $ledgerWriter
    ): JsonResponse {
        $this->authorize('createCollection', $customer);

        $validated = $request->validated();
        $user = $request->user();

        $collection = DB::transaction(function () use ($validated, $customer, $user, $logoWritePublisher, $ledgerWriter) {
            $collectionDate = $validated['date'] ?? $validated['collection_date'] ?? now()->toDateString();
            $submittedMeta = is_array($validated['meta'] ?? null) ? $validated['meta'] : [];
            $referenceFields = $validated['reference_fields'] ?? data_get($submittedMeta, 'reference_fields', []);
            $referenceNo = $validated['reference_no']
                ?? ($referenceFields['transfer_no'] ?? $referenceFields['check_no'] ?? $referenceFields['note_no'] ?? $referenceFields['auth_code'] ?? null);
            $meta = array_merge($submittedMeta, [
                'reference_fields' => $referenceFields,
            ]);
            $isFactoryCollection = data_get($referenceFields, 'collection_channel') === 'factory';
            $valorDays = data_get($referenceFields, 'valor_days');
            $requiresManagerApproval = $validated['method'] === 'check'
                && is_numeric($valorDays)
                && (int) $valorDays > 60;

            if ($isFactoryCollection) {
                $meta['factory_collected'] = true;
            }

            if ($requiresManagerApproval) {
                $referenceFields['requires_manager_approval'] = true;
                $referenceFields['manager_approval_reason'] = 'valor_limit_exceeded';
                $meta['manager_approval'] = [
                    'status' => 'reviewing',
                    'reason' => 'valor_limit_exceeded',
                    'valor_days' => (int) $valorDays,
                    'limit_days' => 60,
                    'submitted_at' => now()->toIso8601String(),
                    'submitted_by_user_id' => $user->id,
                ];
                $meta['reference_fields'] = $referenceFields;
            }

            $cashbox = $isFactoryCollection ? null : $this->resolveCollectionCashbox($user, $meta);

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
                'sync_status' => $requiresManagerApproval ? 'reviewing' : 'pending',
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
                'note' => $validated['note'] ?? null,
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

            return $collection;
        });

        return response()->json([
            'collection' => new CollectionResource($collection),
            'ledger_entry' => null,
        ], 201);
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
            throw ValidationException::withMessages([
                'collection' => ['Bu tahsilat müdür onayı bekliyor.'],
            ]);
        }

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
            'message' => 'Tahsilat gönderim kuyruğuna alındı.',
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
            'message' => 'Tahsilatlar gönderim kuyruğuna alındı.',
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
        $collectionDate = $validated['date'] ?? $validated['collection_date'] ?? now()->toDateString();
        $submittedMeta = is_array($validated['meta'] ?? null) ? $validated['meta'] : [];
        $referenceFields = $validated['reference_fields'] ?? data_get($submittedMeta, 'reference_fields', []);
        $referenceNo = $validated['reference_no']
            ?? ($referenceFields['transfer_no'] ?? $referenceFields['check_no'] ?? $referenceFields['note_no'] ?? $referenceFields['auth_code'] ?? null);
        $meta = array_merge($submittedMeta, [
            'reference_fields' => $referenceFields,
        ]);
        $isFactoryCollection = data_get($referenceFields, 'collection_channel') === 'factory';
        $valorDays = data_get($referenceFields, 'valor_days');
        $requiresManagerApproval = $validated['method'] === 'check'
            && is_numeric($valorDays)
            && (int) $valorDays > 60;

        if ($isFactoryCollection) {
            $meta['factory_collected'] = true;
        } else {
            unset($meta['factory_collected']);
        }

        if ($requiresManagerApproval) {
            $referenceFields['requires_manager_approval'] = true;
            $referenceFields['manager_approval_reason'] = 'valor_limit_exceeded';
            $meta['manager_approval'] = [
                'status' => 'reviewing',
                'reason' => 'valor_limit_exceeded',
                'valor_days' => (int) $valorDays,
                'limit_days' => 60,
                'submitted_at' => now()->toIso8601String(),
                'submitted_by_user_id' => $user->id,
            ];
            $meta['reference_fields'] = $referenceFields;
        } else {
            unset($meta['manager_approval']);
        }

        $cashbox = $isFactoryCollection ? null : $this->resolveCollectionCashbox($user, $meta);

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
            'note' => $validated['note'] ?? null,
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

        return ! in_array($collection->sync_status, ['pending', 'reviewing', 'synced'], true);
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

        if (! $user->hasRole('salesperson')) {
            return null;
        }

        return $this->resolveSalespersonCashbox($user);
    }

    private function resolveSalespersonCashbox(User $user): ?Cashbox
    {
        $configuredCode = $this->nullableString($user->logo_cashbox_code);
        $configuredName = $this->nullableString($user->logo_cashbox_name);

        if ($configuredCode === null) {
            return null;
        }

        return $this->resolveCashboxByCode(
            code: $configuredCode,
            name: $configuredName ?? (($this->nullableString($user->name) ?? 'Plasiyer').' Kasasi')
        );
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
