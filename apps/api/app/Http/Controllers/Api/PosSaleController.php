<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Pos\CancelPosSaleRequest;
use App\Http\Requests\Pos\CreatePosSaleRequest;
use App\Http\Requests\Pos\ListPosSalesRequest;
use App\Http\Requests\Pos\UpdatePosSaleRequest;
use App\Http\Resources\Pos\PosSaleListResource;
use App\Http\Resources\Pos\PosSaleResource;
use App\Models\Customer;
use App\Models\IntegrationSyncState;
use App\Models\PosSale;
use App\Services\Customers\CustomerAccessScopeService;
use App\Services\Pos\DayEndReportService;
use App\Services\Pos\PosSaleService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response as LaravelResponse;
use Symfony\Component\HttpFoundation\Response as HttpStatus;

class PosSaleController extends Controller
{
    public function deliveryBalance(Request $request, DayEndReportService $dayEndReportService): JsonResponse
    {
        $this->authorize('viewAny', PosSale::class);

        $validated = $request->validate([
            'customer_id' => ['nullable', 'integer', 'min:1'],
        ]);
        $customerId = isset($validated['customer_id']) ? (int) $validated['customer_id'] : null;

        if ($customerId === null) {
            return response()->json([
                'data' => [
                    'count' => 0,
                    'amount' => '0.00',
                    'source' => 'b2b',
                    'synced_at' => null,
                ],
            ]);
        }

        $customer = Customer::query()->findOrFail($customerId);
        $this->authorize('view', $customer);

        $warehouseNo = $this->pointWarehouseNo($request);
        $logoCustomerRef = is_numeric($customer->source_reference)
            ? (int) $customer->source_reference
            : null;
        $logoState = $logoCustomerRef !== null
            ? IntegrationSyncState::query()
                ->where('system', 'logo')
                ->where('domain', 'pos-delivery-balances')
                ->where('direction', 'inbound')
                ->where('entity_type', 'logo-customer-warehouse-'.$warehouseNo)
                ->where('entity_id', $logoCustomerRef)
                ->when(
                    $request->user()?->dealer_id !== null,
                    fn ($query) => $query->where(function ($scope) use ($request): void {
                        $scope->whereNull('dealer_id')->orWhere('dealer_id', $request->user()->dealer_id);
                    }),
                )
                ->latest('last_synced_at')
                ->first()
            : null;

        if ($logoState instanceof IntegrationSyncState) {
            return response()->json([
                'data' => [
                    'count' => (int) data_get($logoState->meta, 'count', 0),
                    'amount' => number_format((float) data_get($logoState->meta, 'amount', 0), 2, '.', ''),
                    'source' => 'logo',
                    'synced_at' => $logoState->last_synced_at?->toIso8601String(),
                ],
            ]);
        }

        $query = PosSale::query()
            ->where('status', 'paid')
            ->where('document_type', 'delivery')
            ->where('customer_id', $customer->id);

        $dayEndReportService->applySaleFilters($query, $request->user(), []);

        return response()->json([
            'data' => [
                'count' => (clone $query)->count(),
                'amount' => number_format((float) $query->sum('grand_total'), 2, '.', ''),
                'source' => 'b2b',
                'synced_at' => null,
            ],
        ]);
    }

    private function pointWarehouseNo(Request $request): int
    {
        $user = $request->user();
        $haystack = mb_strtoupper(implode(' ', array_filter([
            $user?->username,
            $user?->email,
            $user?->name,
            $user?->branch_code,
            $user?->branch_name,
            $user?->region_code,
        ], fn ($value): bool => is_scalar($value) && trim((string) $value) !== '')), 'UTF-8');

        if (str_contains($haystack, 'BATUM')) {
            return (int) config('integrations.pos.batum_point_warehouse_no', 4);
        }

        if (str_contains($haystack, 'TRABZON')) {
            return (int) config('integrations.pos.trabzon_point_warehouse_no', 2);
        }

        if (str_contains($haystack, 'SAMSUN')) {
            return (int) config('integrations.pos.samsun_point_warehouse_no', 3);
        }

        return (int) config('integrations.pos.erzurum_point_warehouse_no', config('integrations.pos.point_warehouse_no', 0));
    }

    public function index(
        ListPosSalesRequest $request,
        DayEndReportService $dayEndReportService,
        CustomerAccessScopeService $customerAccessScope,
    ): JsonResponse
    {
        $this->authorize('viewAny', PosSale::class);

        $validated = $request->validated();
        $limit = min((int) ($validated['limit'] ?? 25), 50);

        $query = PosSale::query()
            ->with(['customer', 'createdBy', 'posSession.cashbox']);

        $dayEndReportService->applySaleFilters($query, $request->user(), $validated);

        if (! empty($validated['status'])) {
            $query->where('status', (string) $validated['status']);
        } else {
            $query->where('status', '!=', 'cancelled');
        }

        if (! empty($validated['document_type'])) {
            $query->where('document_type', (string) $validated['document_type']);
        }

        if (($validated['document_type'] ?? null) === 'delivery') {
            $customerAccessScope->applyToCustomerOwnedQuery($query, $request->user(), 'customer_id');
        }

        $search = trim((string) ($validated['q'] ?? ''));
        if ($search !== '') {
            $needle = '%'.mb_strtolower($search).'%';

            $query->where(function ($query) use ($needle): void {
                $query
                    ->whereRaw('LOWER(receipt_no) LIKE ?', [$needle])
                    ->orWhereHas('customer', function ($customerQuery) use ($needle): void {
                        $customerQuery
                            ->whereRaw('LOWER(code) LIKE ?', [$needle])
                            ->orWhereRaw('LOWER(name) LIKE ?', [$needle]);
                    });
            });
        }

        $sales = $query
            ->orderByDesc('created_at')
            ->orderByDesc('id')
            ->cursorPaginate(
                perPage: $limit,
                columns: ['*'],
                cursorName: 'cursor',
                cursor: $validated['cursor'] ?? null,
            );

        return response()->json([
            'data' => PosSaleListResource::collection(collect($sales->items()))->resolve(),
            'next_cursor' => $sales->nextCursor()?->encode(),
            'prev_cursor' => $sales->previousCursor()?->encode(),
            'limit' => $limit,
        ]);
    }

    public function show(PosSale $posSale): JsonResponse
    {
        $this->authorize('view', $posSale);

        $posSale->loadMissing([
            'customer',
            'createdBy',
            'posSession.cashbox',
            'items.product.brand',
            'payments',
        ]);

        return response()->json([
            'data' => new PosSaleResource($posSale),
        ]);
    }

    public function store(CreatePosSaleRequest $request, PosSaleService $posSaleService): JsonResponse
    {
        $this->authorize('create', PosSale::class);

        $sale = $posSaleService->create($request->user(), $request->validated());

        return response()->json([
            'data' => new PosSaleResource($sale),
        ], HttpStatus::HTTP_CREATED);
    }

    public function cancel(
        CancelPosSaleRequest $request,
        PosSale $posSale,
        PosSaleService $posSaleService
    ): JsonResponse {
        $this->authorize('cancel', $posSale);

        $sale = $posSaleService->cancel(
            user: $request->user(),
            posSale: $posSale,
            note: $request->validated('note')
        );

        return response()->json([
            'data' => new PosSaleResource($sale),
        ]);
    }

    public function update(
        UpdatePosSaleRequest $request,
        PosSale $posSale,
        PosSaleService $posSaleService
    ): JsonResponse {
        $this->authorize('update', $posSale);

        $sale = $posSaleService->updateDocument(
            user: $request->user(),
            posSale: $posSale,
            payload: $request->validated()
        );

        return response()->json([
            'data' => new PosSaleResource($sale),
        ]);
    }

    public function destroy(Request $request, PosSale $posSale, PosSaleService $posSaleService): JsonResponse
    {
        $this->authorize('delete', $posSale);

        $posSaleService->deleteDocument($request->user(), $posSale);

        return response()->json([
            'message' => 'İrsaliye belgesi silindi.',
        ]);
    }

    public function print(PosSale $posSale): LaravelResponse
    {
        $this->authorize('view', $posSale);

        $posSale->loadMissing([
            'customer',
            'createdBy',
            'posSession.cashbox',
            'items.product.brand',
            'payments',
        ]);

        return response()->view('pos.prints.receipt', [
            'sale' => $posSale,
        ], HttpStatus::HTTP_OK, [
            'Content-Type' => 'text/html; charset=UTF-8',
        ]);
    }

    public function printReceipt(PosSale $posSale): LaravelResponse
    {
        // Backward-compatible alias for older clients.
        return $this->print($posSale);
    }
}
