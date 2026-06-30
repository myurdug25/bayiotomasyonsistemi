<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\ReturnRequest\ListReturnRequestsRequest;
use App\Http\Requests\ReturnRequest\StoreReturnRequestRequest;
use App\Http\Requests\ReturnRequest\UpdateReturnRequestStatusRequest;
use App\Models\Customer;
use App\Models\IntegrationSyncState;
use App\Models\Order;
use App\Models\OrderItem;
use App\Models\ReturnRequest;
use App\Models\User;
use App\Services\Customers\CustomerAccessScopeService;
use App\Services\Integrations\IntegrationSyncStateService;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Collection;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\Response;

class ReturnRequestController extends Controller
{
    public function index(ListReturnRequestsRequest $request, CustomerAccessScopeService $customerAccessScope): JsonResponse
    {
        $user = $request->user();
        $this->ensureReturnRole($user);

        $validated = $request->validated();
        $limit = min((int) ($validated['limit'] ?? 20), 50);
        $q = trim((string) ($validated['q'] ?? ''));
        $statuses = is_array($validated['statuses'] ?? null) ? $validated['statuses'] : [];
        $types = is_array($validated['types'] ?? null) ? $validated['types'] : [];

        $query = ReturnRequest::query()
            ->select([
                'id',
                'dealer_id',
                'customer_id',
                'order_id',
                'order_item_id',
                'requested_by_user_id',
                'reviewed_by_user_id',
                'request_no',
                'request_type',
                'status',
                'reason_code',
                'reason_note',
                'quantity',
                'unit_price',
                'currency',
                'product_snapshot',
                'order_snapshot',
                'resolution_note',
                'reviewed_at',
                'created_at',
            ])
            ->with([
                'customer:id,code,name',
                'order:id,order_no,ordered_at',
                'requestedBy:id,name',
                'reviewedBy:id,name',
            ]);

        if (! $user->hasRole('admin')) {
            if ($user->dealer_id === null) {
                abort(Response::HTTP_FORBIDDEN, 'User has no dealer scope.');
            }

            $query->where('dealer_id', (int) $user->dealer_id);
        } elseif (! empty($validated['dealer_id'])) {
            $query->where('dealer_id', (int) $validated['dealer_id']);
        }

        $customerAccessScope->applyToCustomerOwnedQuery($query, $user, 'customer_id');

        if (! empty($validated['customer_id'])) {
            $query->where('customer_id', (int) $validated['customer_id']);
        }

        if ($statuses !== []) {
            $query->whereIn('status', $statuses);
        }

        if ($types !== []) {
            $query->whereIn('request_type', $types);
        }

        if ($q !== '') {
            $query->where(function (Builder $builder) use ($q): void {
                $builder->whereLike('request_no', "%{$q}%", caseSensitive: false)
                    ->orWhereHas('order', function (Builder $orderQuery) use ($q): void {
                        $orderQuery->whereLike('order_no', "%{$q}%", caseSensitive: false);
                    })
                    ->orWhereHas('customer', function (Builder $customerQuery) use ($q): void {
                        $customerQuery
                            ->whereLike('code', "{$q}%", caseSensitive: false)
                            ->orWhereLike('name', "%{$q}%", caseSensitive: false);
                    });
            });
        }

        $requests = $query
            ->orderByDesc('created_at')
            ->orderByDesc('id')
            ->cursorPaginate(
                perPage: $limit,
                columns: ['*'],
                cursorName: 'cursor',
                cursor: $validated['cursor'] ?? null
            );

        $rows = collect($requests->items())
            ->map(fn (ReturnRequest $returnRequest) => $this->serializeReturnRequest($returnRequest))
            ->values();

        return response()->json([
            'data' => $rows,
            'next_cursor' => $requests->nextCursor()?->encode(),
            'prev_cursor' => $requests->previousCursor()?->encode(),
            'limit' => $limit,
            'summary' => $this->buildSummary($rows),
        ]);
    }

    public function store(StoreReturnRequestRequest $request): JsonResponse
    {
        $user = $request->user();
        $this->ensureReturnRole($user);

        $validated = $request->validated();

        $order = Order::query()
            ->with(['customer:id,code,name', 'dealer:id,code,name'])
            ->findOrFail((int) $validated['order_id']);
        $this->ensureCanAccessOrder($user, $order);

        $orderItem = OrderItem::query()
            ->with(['product.brand'])
            ->where('order_id', $order->id)
            ->whereKey((int) $validated['order_item_id'])
            ->first();

        if (! $orderItem instanceof OrderItem) {
            throw ValidationException::withMessages([
                'order_item_id' => ['Seçilen sipariş kalemi bu siparişe ait değil.'],
            ]);
        }

        $quantity = (int) $validated['quantity'];
        if ($quantity > (int) $orderItem->quantity) {
            throw ValidationException::withMessages([
                'quantity' => ['İade miktarı sipariş edilen miktardan büyük olamaz.'],
            ]);
        }

        $returnRequest = ReturnRequest::create([
            'dealer_id' => (int) $order->dealer_id,
            'customer_id' => (int) $order->customer_id,
            'order_id' => (int) $order->id,
            'order_item_id' => (int) $orderItem->id,
            'requested_by_user_id' => (int) $user->id,
            'reviewed_by_user_id' => null,
            'request_no' => $this->generateRequestNo(),
            'request_type' => (string) $validated['request_type'],
            'status' => ReturnRequest::STATUS_SUBMITTED,
            'reason_code' => (string) $validated['reason_code'],
            'reason_note' => $validated['reason_note'] ?? null,
            'quantity' => $quantity,
            'unit_price' => $orderItem->unit_net_price,
            'currency' => $orderItem->currency,
            'product_snapshot' => [
                'product_id' => $orderItem->product_id,
                'sku' => $orderItem->product?->sku,
                'name' => $orderItem->product?->name,
                'brand' => $orderItem->product?->brand?->name,
            ],
            'order_snapshot' => [
                'order_no' => $order->order_no,
                'ordered_at' => $order->ordered_at?->toJSON(),
                'customer_code' => $order->customer?->code,
                'customer_name' => $order->customer?->name,
            ],
            'resolution_note' => null,
            'reviewed_at' => null,
        ]);

        $returnRequest->loadMissing([
            'customer:id,code,name',
            'order:id,order_no,ordered_at',
            'requestedBy:id,name',
            'reviewedBy:id,name',
        ]);

        return response()->json([
            'data' => $this->serializeReturnRequest($returnRequest),
        ], Response::HTTP_CREATED);
    }

    public function updateStatus(
        UpdateReturnRequestStatusRequest $request,
        ReturnRequest $returnRequest,
        IntegrationSyncStateService $syncState
    ): JsonResponse {
        $user = $request->user();
        $this->ensureCanReviewReturnRequest($user, $returnRequest);

        $validated = $request->validated();
        $nextStatus = (string) $validated['status'];
        $this->ensureValidStatusTransition($returnRequest, $nextStatus);

        $returnRequest->forceFill([
            'status' => $nextStatus,
            'resolution_note' => $validated['resolution_note'] ?? $returnRequest->resolution_note,
            'reviewed_by_user_id' => $user->id,
            'reviewed_at' => now(),
        ])->save();

        if ($nextStatus === ReturnRequest::STATUS_APPROVED) {
            $this->queueReturnForLogoExport($syncState, $returnRequest);
        } elseif ($nextStatus === ReturnRequest::STATUS_COMPLETED) {
            $this->queueMissingReturnLogoExports($syncState, $returnRequest);
        }

        $returnRequest->loadMissing([
            'customer:id,code,name',
            'order:id,order_no,ordered_at',
            'requestedBy:id,name',
            'reviewedBy:id,name',
        ]);

        return response()->json([
            'data' => $this->serializeReturnRequest($returnRequest),
        ]);
    }

    private function queueReturnForLogoExport(IntegrationSyncStateService $syncState, ReturnRequest $returnRequest): void
    {
        $syncState->record(
            system: 'logo',
            domain: 'returns',
            direction: 'outbound',
            entity: $returnRequest,
            externalRef: null,
            status: 'queued',
            error: null,
            meta: [
                'export_key' => 'B2B-RETURN-'.$returnRequest->id,
                'request_no' => $returnRequest->request_no,
                'status' => $returnRequest->status,
                'order_id' => $returnRequest->order_id,
            ],
            payload: [
                'return_request_id' => $returnRequest->id,
                'request_no' => $returnRequest->request_no,
                'status' => $returnRequest->status,
                'quantity' => $returnRequest->quantity,
            ],
        );

        if (! in_array($returnRequest->request_type, [ReturnRequest::TYPE_DAMAGED, ReturnRequest::TYPE_FAULTY], true)) {
            return;
        }

        $this->queueReturnScrapForLogoExport($syncState, $returnRequest);
    }

    private function queueMissingReturnLogoExports(IntegrationSyncStateService $syncState, ReturnRequest $returnRequest): void
    {
        if (! ($this->logoSyncState('returns', ReturnRequest::class, (int) $returnRequest->id) instanceof IntegrationSyncState)) {
            $this->queueReturnForLogoExport($syncState, $returnRequest);

            return;
        }

        if (
            in_array($returnRequest->request_type, [ReturnRequest::TYPE_DAMAGED, ReturnRequest::TYPE_FAULTY], true)
            && ! ($this->logoSyncState('return-scraps', ReturnRequest::class, (int) $returnRequest->id) instanceof IntegrationSyncState)
        ) {
            $this->queueReturnScrapForLogoExport($syncState, $returnRequest);
        }
    }

    private function queueReturnScrapForLogoExport(IntegrationSyncStateService $syncState, ReturnRequest $returnRequest): void
    {
        $customerCode = $returnRequest->customer?->code
            ?? data_get($returnRequest->order_snapshot, 'customer_code')
            ?? Customer::query()->whereKey($returnRequest->customer_id)->value('code');

        $syncState->record(
            system: 'logo',
            domain: 'return-scraps',
            direction: 'outbound',
            entity: $returnRequest,
            externalRef: null,
            status: 'queued',
            error: null,
            meta: [
                'export_key' => 'B2B-RETURN-SCRAP-'.$returnRequest->id,
                'request_no' => $returnRequest->request_no,
                'request_type' => $returnRequest->request_type,
                'document_type' => 'fire_fiche',
                'document_no' => $customerCode,
                'order_id' => $returnRequest->order_id,
            ],
            payload: [
                'return_request_id' => $returnRequest->id,
                'request_no' => $returnRequest->request_no,
                'request_type' => $returnRequest->request_type,
                'document_type' => 'fire_fiche',
                'document_no' => $customerCode,
                'quantity' => $returnRequest->quantity,
            ],
        );
    }

    private function ensureReturnRole(User $user): void
    {
        if (! $user->hasAnyRole(['admin', 'dealer_admin', 'salesperson', 'cashier', 'point'])) {
            abort(Response::HTTP_FORBIDDEN, 'You are not allowed to access return flow.');
        }
    }

    private function ensureCanAccessOrder(User $user, Order $order): void
    {
        if ($user->hasRole('admin')) {
            return;
        }

        $customer = Customer::query()->find((int) $order->customer_id);

        if (! $customer instanceof Customer) {
            abort(Response::HTTP_FORBIDDEN, 'Order customer is missing.');
        }

        if ($user->dealer_id === null || (int) $user->dealer_id !== (int) $order->dealer_id) {
            abort(Response::HTTP_FORBIDDEN, 'You can only access orders for your dealer.');
        }

        if (! $user->canAccessCustomer($customer)) {
            abort(Response::HTTP_FORBIDDEN, 'You can only access return flow for customers in your scope.');
        }
    }

    private function ensureCanReviewReturnRequest(User $user, ReturnRequest $returnRequest): void
    {
        if (! $user->hasAnyRole(['admin', 'salesperson'])) {
            abort(Response::HTTP_FORBIDDEN, 'You are not allowed to review return requests.');
        }

        if ($user->hasRole('admin')) {
            return;
        }

        if ($user->dealer_id === null || (int) $user->dealer_id !== (int) $returnRequest->dealer_id) {
            abort(Response::HTTP_FORBIDDEN, 'You can only review return requests for your dealer.');
        }

        $customer = Customer::query()->find((int) $returnRequest->customer_id);

        if (! $customer instanceof Customer || ! $user->canAccessCustomer($customer)) {
            abort(Response::HTTP_FORBIDDEN, 'You can only review return requests for customers in your scope.');
        }
    }

    private function ensureValidStatusTransition(ReturnRequest $returnRequest, string $nextStatus): void
    {
        $allowedTransitions = match ($returnRequest->status) {
            ReturnRequest::STATUS_SUBMITTED => [
                ReturnRequest::STATUS_REVIEWING,
                ReturnRequest::STATUS_APPROVED,
                ReturnRequest::STATUS_REJECTED,
            ],
            ReturnRequest::STATUS_REVIEWING => [
                ReturnRequest::STATUS_APPROVED,
                ReturnRequest::STATUS_REJECTED,
                ReturnRequest::STATUS_COMPLETED,
            ],
            ReturnRequest::STATUS_APPROVED => [
                ReturnRequest::STATUS_COMPLETED,
            ],
            default => [],
        };

        if (! in_array($nextStatus, $allowedTransitions, true)) {
            throw ValidationException::withMessages([
                'status' => ['Seçilen durum geçişi bu talep için geçerli değil.'],
            ]);
        }
    }

    private function generateRequestNo(): string
    {
        do {
            $candidate = 'RET-'.now()->format('YmdHis').'-'.Str::upper(Str::random(4));
            $exists = ReturnRequest::query()->where('request_no', $candidate)->exists();
        } while ($exists);

        return $candidate;
    }

    /**
     * @param  array<string, mixed>  $row
     * @return array<string, mixed>
     */
    private function serializeReturnRequest(ReturnRequest $returnRequest): array
    {
        $logoSyncState = $this->logoSyncState('returns', ReturnRequest::class, (int) $returnRequest->id);
        $scrapLogoSyncState = $this->logoSyncState('return-scraps', ReturnRequest::class, (int) $returnRequest->id);
        $productSnapshot = is_array($returnRequest->product_snapshot) ? $returnRequest->product_snapshot : [];
        $orderSnapshot = is_array($returnRequest->order_snapshot) ? $returnRequest->order_snapshot : [];
        $lineTotal = number_format(((float) $returnRequest->unit_price) * (int) $returnRequest->quantity, 2, '.', '');

        return [
            'id' => $returnRequest->id,
            'request_no' => $returnRequest->request_no,
            'request_type' => $returnRequest->request_type,
            'status' => $returnRequest->status,
            'reason_code' => $returnRequest->reason_code,
            'reason_note' => $returnRequest->reason_note,
            'quantity' => (int) $returnRequest->quantity,
            'unit_price' => (string) $returnRequest->unit_price,
            'currency' => $returnRequest->currency,
            'line_total' => $lineTotal,
            'resolution_note' => $returnRequest->resolution_note,
            'logo_sync_status' => $logoSyncState?->status,
            'logo_sync_error' => $logoSyncState?->last_error,
            'logo_external_ref' => $logoSyncState?->external_ref,
            'logo_last_synced_at' => $logoSyncState?->last_synced_at,
            'scrap_logo_sync_status' => $scrapLogoSyncState?->status,
            'scrap_logo_sync_error' => $scrapLogoSyncState?->last_error,
            'scrap_logo_external_ref' => $scrapLogoSyncState?->external_ref,
            'scrap_logo_last_synced_at' => $scrapLogoSyncState?->last_synced_at,
            'created_at' => $returnRequest->created_at,
            'reviewed_at' => $returnRequest->reviewed_at,
            'customer' => [
                'id' => $returnRequest->customer?->id ?? $returnRequest->customer_id,
                'code' => $returnRequest->customer?->code ?? ($orderSnapshot['customer_code'] ?? null),
                'title' => $returnRequest->customer?->name ?? ($orderSnapshot['customer_name'] ?? null),
            ],
            'order' => [
                'id' => $returnRequest->order?->id ?? $returnRequest->order_id,
                'order_no' => $returnRequest->order?->order_no ?? ($orderSnapshot['order_no'] ?? null),
                'ordered_at' => $returnRequest->order?->ordered_at ?? ($orderSnapshot['ordered_at'] ?? null),
            ],
            'product' => [
                'id' => $productSnapshot['product_id'] ?? null,
                'sku' => $productSnapshot['sku'] ?? null,
                'name' => $productSnapshot['name'] ?? null,
                'brand' => $productSnapshot['brand'] ?? null,
            ],
            'requested_by' => [
                'id' => $returnRequest->requestedBy?->id ?? $returnRequest->requested_by_user_id,
                'name' => $returnRequest->requestedBy?->name,
            ],
            'reviewed_by' => [
                'id' => $returnRequest->reviewedBy?->id,
                'name' => $returnRequest->reviewedBy?->name,
            ],
        ];
    }

    private function logoSyncState(string $domain, string $entityType, int $entityId): ?IntegrationSyncState
    {
        return IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', $domain)
            ->where('direction', 'outbound')
            ->where('entity_type', $entityType)
            ->where('entity_id', $entityId)
            ->latest('id')
            ->first();
    }

    /**
     * @param  Collection<int, array<string, mixed>>  $rows
     * @return array<string, mixed>
     */
    private function buildSummary(Collection $rows): array
    {
        $statusBreakdown = $rows
            ->groupBy('status')
            ->map(fn (Collection $group, string $status) => [
                'status' => $status,
                'count' => $group->count(),
            ])
            ->values()
            ->sortByDesc('count')
            ->values();

        $typeBreakdown = $rows
            ->groupBy('request_type')
            ->map(fn (Collection $group, string $requestType) => [
                'request_type' => $requestType,
                'count' => $group->count(),
            ])
            ->values()
            ->sortByDesc('count')
            ->values();

        return [
            'total_count' => $rows->count(),
            'submitted_count' => $rows->where('status', ReturnRequest::STATUS_SUBMITTED)->count(),
            'reviewing_count' => $rows->where('status', ReturnRequest::STATUS_REVIEWING)->count(),
            'closed_count' => $rows->filter(
                fn (array $row) => in_array((string) ($row['status'] ?? ''), [ReturnRequest::STATUS_APPROVED, ReturnRequest::STATUS_REJECTED, ReturnRequest::STATUS_COMPLETED], true)
            )->count(),
            'status_breakdown' => $statusBreakdown,
            'type_breakdown' => $typeBreakdown,
        ];
    }
}
