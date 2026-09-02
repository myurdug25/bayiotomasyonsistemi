<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\PurchaseReceipt\ApprovePurchaseReceiptRequest;
use App\Http\Requests\PurchaseReceipt\StorePurchaseReceiptRequest;
use App\Http\Resources\PurchaseReceiptResource;
use App\Models\IntegrationSyncState;
use App\Models\Order;
use App\Models\PurchaseReceipt;
use App\Models\Shipment;
use App\Services\Integrations\IntegrationSyncStateService;
use App\Services\Integrations\Logo\LogoWarehouseTransferExportService;
use App\Support\Warehouse\WarehouseBranchResolver;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

class PurchaseReceiptController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $status = $this->nullableString($request->query('status')) ?? 'draft';

        $query = PurchaseReceipt::query()
            ->with(['items'])
            ->where('status', $status)
            ->orderByDesc('created_at')
            ->limit(min(max((int) $request->integer('limit', 50), 1), 200));

        if ($request->boolean('warehouse_transfers')) {
            $query->where('note', 'like', 'Depolar arasi transfer:%');

            $user = $request->user();
            $targetWarehouse = $user !== null
                ? app(WarehouseBranchResolver::class)->targetWarehouse($user)
                : null;

            if (! $user?->hasRole('admin')) {
                if ($targetWarehouse === null) {
                    $query->whereRaw('1 = 0');

                    return response()->json([
                        'data' => PurchaseReceiptResource::collection($query->get()),
                    ]);
                }

                $targetCode = $this->nullableString($targetWarehouse['code'] ?? null);
                $targetName = $this->nullableString($targetWarehouse['name'] ?? null);

                $query->where(function ($warehouseQuery) use ($targetCode, $targetName): void {
                    if ($targetCode !== null) {
                        $warehouseQuery->orWhere('warehouse_code', $targetCode);
                    }

                    if ($targetName !== null) {
                        $warehouseQuery->orWhere('warehouse_name', $targetName);
                    }
                });
            }
        }

        return response()->json([
            'data' => PurchaseReceiptResource::collection($query->get()),
        ]);
    }

    public function store(
        StorePurchaseReceiptRequest $request,
        IntegrationSyncStateService $syncState
    ): JsonResponse {
        $user = $request->user();
        $validated = $request->validated();
        $dealerId = $user->dealer_id ?? ($validated['dealer_id'] ?? null);

        $receipt = DB::transaction(function () use ($validated, $user, $dealerId, $syncState): PurchaseReceipt {
            $receipt = PurchaseReceipt::query()->create([
                'dealer_id' => $dealerId,
                'created_by' => $user->id,
                'receipt_no' => $this->generateReceiptNo(),
                'document_no' => $this->nullableString($validated['document_no'] ?? null),
                'supplier_name' => $this->nullableString($validated['supplier_name'] ?? null),
                'warehouse_code' => $this->nullableString($validated['warehouse_code'] ?? null),
                'warehouse_name' => $this->nullableString($validated['warehouse_name'] ?? null),
                'received_at' => $validated['received_at'],
                'note' => $this->nullableString($validated['note'] ?? null),
                'status' => 'queued',
            ]);

            foreach ($validated['items'] as $item) {
                $receipt->items()->create([
                    'product_code' => $this->nullableString($item['product_code'] ?? null),
                    'product_name' => trim((string) $item['product_name']),
                    'expected_quantity' => (int) $item['expected_quantity'],
                    'accepted_quantity' => (int) $item['accepted_quantity'],
                    'note' => $this->nullableString($item['note'] ?? null),
                ]);
            }

            $syncState->record(
                system: 'logo',
                domain: 'purchase-receipts',
                direction: 'outbound',
                entity: $receipt,
                externalRef: null,
                status: 'queued',
                error: null,
                meta: [
                    'export_key' => 'B2B-PURCHASE-'.$receipt->id,
                    'receipt_no' => $receipt->receipt_no,
                    'document_no' => $receipt->document_no,
                    'warehouse_code' => $receipt->warehouse_code,
                ],
                payload: [
                    'purchase_receipt_id' => $receipt->id,
                    'receipt_no' => $receipt->receipt_no,
                    'document_no' => $receipt->document_no,
                    'status' => $receipt->status,
                ],
            );

            return $receipt->fresh(['items']);
        });

        return response()->json([
            'data' => new PurchaseReceiptResource($receipt),
            'message' => 'Mal kabul kaydi Logo kuyruğuna alindi.',
        ], 201);
    }

    public function show(Request $request, PurchaseReceipt $purchaseReceipt): JsonResponse
    {
        return response()->json([
            'data' => new PurchaseReceiptResource($purchaseReceipt->load(['items'])),
        ]);
    }

    public function approve(
        ApprovePurchaseReceiptRequest $request,
        PurchaseReceipt $purchaseReceipt,
        IntegrationSyncStateService $syncState,
        LogoWarehouseTransferExportService $warehouseTransferExport,
    ): JsonResponse {
        $validatedItems = $request->validated('items');

        $receipt = DB::transaction(function () use (
            $purchaseReceipt,
            $syncState,
            $warehouseTransferExport,
            $validatedItems,
        ): PurchaseReceipt {
            /** @var PurchaseReceipt $receipt */
            $receipt = PurchaseReceipt::query()
                ->with('items')
                ->lockForUpdate()
                ->findOrFail($purchaseReceipt->id);

            if ($receipt->status !== 'draft') {
                return $receipt;
            }

            if (is_array($validatedItems)) {
                $submittedQuantities = collect($validatedItems)
                    ->mapWithKeys(fn (array $item): array => [
                        (int) $item['id'] => (int) $item['accepted_quantity'],
                    ]);

                foreach ($receipt->items as $item) {
                    $acceptedQuantity = (int) $submittedQuantities->get((int) $item->id, 0);

                    if ($acceptedQuantity > (int) $item->expected_quantity) {
                        throw ValidationException::withMessages([
                            'items' => ["Kabul miktari beklenen miktari asamaz ({$item->product_code})."],
                        ]);
                    }

                    $item->accepted_quantity = $acceptedQuantity;
                    $item->save();
                }

                $receipt->setRelation('items', $receipt->items()->get());
            }

            $isWarehouseTransfer = str_starts_with((string) $receipt->note, 'Depolar arasi transfer:');

            if ($isWarehouseTransfer && (int) $receipt->items->sum('accepted_quantity') <= 0) {
                throw ValidationException::withMessages([
                    'items' => ['Mal kabul icin en az bir urun ve miktar secilmelidir.'],
                ]);
            }

            if (! $isWarehouseTransfer) {
                $receipt->status = 'queued';
                $receipt->save();

                $syncState->record(
                    system: 'logo',
                    domain: 'purchase-receipts',
                    direction: 'outbound',
                    entity: $receipt,
                    externalRef: null,
                    status: 'queued',
                    error: null,
                    meta: [
                        'export_key' => 'B2B-PURCHASE-'.$receipt->id,
                        'receipt_no' => $receipt->receipt_no,
                        'document_no' => $receipt->document_no,
                        'warehouse_code' => $receipt->warehouse_code,
                    ],
                    payload: [
                        'purchase_receipt_id' => $receipt->id,
                        'receipt_no' => $receipt->receipt_no,
                        'document_no' => $receipt->document_no,
                        'status' => $receipt->status,
                    ],
                );

                return $receipt->fresh(['items']);
            }

            $shipment = Shipment::query()
                ->with(['order', 'warehouse'])
                ->where('shipment_no', $receipt->document_no)
                ->first();

            if (! $shipment instanceof Shipment) {
                throw ValidationException::withMessages([
                    'purchase_receipt' => ['Transfer sevkiyat kaydi bulunamadi.'],
                ]);
            }

            $orderState = IntegrationSyncState::query()
                ->where('system', 'logo')
                ->where('domain', 'warehouse-transfer-orders')
                ->where('direction', 'outbound')
                ->where('entity_type', Order::class)
                ->where('entity_id', (int) $shipment->order_id)
                ->orderByDesc('id')
                ->first();
            $transferMeta = is_array($orderState?->meta) ? $orderState->meta : [];
            $receiptWarehouseCode = $this->nullableString($receipt->warehouse_code);
            $receiptWarehouseName = $this->nullableString($receipt->warehouse_name);
            $acceptanceTransferMeta = [
                ...$transferMeta,
                'transfer_target_warehouse_code' => $receiptWarehouseCode
                    ?? $this->nullableString(data_get($transferMeta, 'transfer_target_warehouse_code')),
                'transfer_target_warehouse_name' => $receiptWarehouseName
                    ?? $this->nullableString(data_get($transferMeta, 'transfer_target_warehouse_name')),
            ];
            $isPartialAcceptance = $receipt->items->contains(
                fn ($item): bool => (int) $item->accepted_quantity < (int) $item->expected_quantity
            );
            $transferStatus = $isPartialAcceptance ? 'Kısmi Mal Kabul' : 'Tamamlandı';

            $warehouseTransferExport->queueAcceptance(
                $shipment,
                [
                    ...$acceptanceTransferMeta,
                    'export_key' => 'B2B-WHTRANS-ACCEPT-'.$receipt->id,
                    'shipment_no' => $shipment->shipment_no,
                    'order_id' => $shipment->order_id,
                    'order_no' => $shipment->order?->order_no,
                    'warehouse_code' => $shipment->warehouse?->code,
                    'document_type' => 'warehouse_transfer',
                    'document_label' => 'Depolar Arası Transfer / Ambar Fişi',
                    'transfer_stage' => 'acceptance',
                    'transfer_status' => $transferStatus,
                    'purchase_receipt_id' => $receipt->id,
                    'purchase_receipt_no' => $receipt->receipt_no,
                ],
                [
                    'shipment_id' => $shipment->id,
                    'shipment_no' => $shipment->shipment_no,
                    'order_id' => $shipment->order_id,
                    'status' => $shipment->status,
                    'document_type' => 'warehouse_transfer',
                    'purchase_receipt_id' => $receipt->id,
                ],
            );

            $syncState->record(
                system: 'logo',
                domain: 'warehouse-transfer-orders',
                direction: 'outbound',
                entity: $shipment->order,
                externalRef: null,
                status: 'queued',
                error: null,
                meta: [
                    ...$acceptanceTransferMeta,
                    'transfer_status' => $transferStatus,
                    'purchase_receipt_id' => $receipt->id,
                    'purchase_receipt_no' => $receipt->receipt_no,
                ],
                payload: [
                    'order_id' => $shipment->order_id,
                    'shipment_id' => $shipment->id,
                    'shipment_no' => $shipment->shipment_no,
                    'transfer_status' => $transferStatus,
                    'purchase_receipt_id' => $receipt->id,
                ],
            );

            $receipt->status = 'queued';
            $receipt->save();

            if ($isPartialAcceptance) {
                $remainingReceipt = PurchaseReceipt::query()->create([
                    'dealer_id' => $receipt->dealer_id,
                    'created_by' => $receipt->created_by,
                    'receipt_no' => $this->generateReceiptNo(),
                    'document_no' => $receipt->document_no,
                    'supplier_name' => $receipt->supplier_name,
                    'warehouse_code' => $receipt->warehouse_code,
                    'warehouse_name' => $receipt->warehouse_name,
                    'received_at' => now()->toDateString(),
                    'note' => $receipt->note,
                    'status' => 'draft',
                ]);

                foreach ($receipt->items as $item) {
                    $remainingQuantity = max(
                        0,
                        (int) $item->expected_quantity - (int) $item->accepted_quantity
                    );

                    if ($remainingQuantity <= 0) {
                        continue;
                    }

                    $remainingReceipt->items()->create([
                        'product_code' => $item->product_code,
                        'product_name' => $item->product_name,
                        'expected_quantity' => $remainingQuantity,
                        'accepted_quantity' => $remainingQuantity,
                        'note' => $item->note,
                    ]);
                }
            }

            return $receipt->fresh(['items']);
        });

        return response()->json([
            'data' => new PurchaseReceiptResource($receipt),
            'message' => str_starts_with((string) $receipt->note, 'Depolar arasi transfer:')
                ? 'Depo transferi Logo ambar fisi kuyruğuna alindi.'
                : 'Mal kabul kaydi Logo kuyruğuna alindi.',
        ]);
    }

    private function generateReceiptNo(): string
    {
        do {
            $receiptNo = 'MK-'.now()->format('YmdHis').'-'.Str::upper(Str::random(4));
        } while (PurchaseReceipt::query()->where('receipt_no', $receiptNo)->exists());

        return $receiptNo;
    }

    private function nullableString(mixed $value): ?string
    {
        $trimmed = trim((string) $value);

        return $trimmed === '' ? null : $trimmed;
    }
}
