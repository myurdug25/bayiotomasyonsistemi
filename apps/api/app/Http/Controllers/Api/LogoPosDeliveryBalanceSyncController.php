<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Integration\SyncLogoPosDeliveryBalancesRequest;
use App\Models\IntegrationSyncState;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;

class LogoPosDeliveryBalanceSyncController extends Controller
{
    public function sync(SyncLogoPosDeliveryBalancesRequest $request): JsonResponse
    {
        $validated = $request->validated();
        $dealerId = isset($validated['dealer_id']) ? (int) $validated['dealer_id'] : null;

        DB::transaction(function () use ($validated, $dealerId): void {
            $customerRecords = collect($validated['records'])
                ->filter(fn (array $record): bool => isset($record['customer_ref']));
            $warehouseNumbers = collect($validated['records'])
                ->pluck('warehouse_no')
                ->map(fn ($warehouseNo): int => (int) $warehouseNo)
                ->unique()
                ->values();

            // Senkron sonucunda artık açık irsaliyesi kalmayan carilerin eski
            // bakiyeleri ekranda kalmasın.
            foreach ($warehouseNumbers as $warehouseNo) {
                IntegrationSyncState::query()
                    ->where('system', 'logo')
                    ->where('domain', 'pos-delivery-balances')
                    ->where('direction', 'inbound')
                    ->where('entity_type', 'logo-customer-warehouse-'.$warehouseNo)
                    ->when($dealerId !== null, fn ($query) => $query->where('dealer_id', $dealerId))
                    ->get()
                    ->each(function (IntegrationSyncState $state): void {
                        $state->forceFill([
                            'status' => 'synced',
                            'last_error' => null,
                            'last_synced_at' => now(),
                            'meta' => array_merge((array) $state->meta, [
                                'count' => 0,
                                'amount' => '0.00',
                            ]),
                        ])->save();
                    });
            }

            foreach ($validated['records'] as $record) {
                $warehouseNo = (int) $record['warehouse_no'];
                $customerRef = isset($record['customer_ref']) ? (int) $record['customer_ref'] : null;
                $entityType = $customerRef !== null
                    ? 'logo-customer-warehouse-'.$warehouseNo
                    : 'logo-warehouse';
                $entityId = $customerRef ?? $warehouseNo;

                IntegrationSyncState::query()->updateOrCreate(
                    [
                        'system' => 'logo',
                        'domain' => 'pos-delivery-balances',
                        'direction' => 'inbound',
                        'entity_type' => $entityType,
                        'entity_id' => $entityId,
                    ],
                    [
                        'dealer_id' => $dealerId,
                        'external_ref' => $customerRef !== null
                            ? 'WAREHOUSE-'.$warehouseNo.'-CUSTOMER-'.$customerRef
                            : 'WAREHOUSE-'.$warehouseNo,
                        'status' => 'synced',
                        'last_error' => null,
                        'last_synced_at' => now(),
                        'meta' => [
                            'warehouse_no' => $warehouseNo,
                            'customer_ref' => $customerRef,
                            'count' => (int) $record['count'],
                            'amount' => number_format((float) $record['amount'], 2, '.', ''),
                        ],
                    ],
                );
            }

            foreach ($warehouseNumbers as $warehouseNo) {
                $warehouseRecords = $customerRecords
                    ->where('warehouse_no', $warehouseNo);

                IntegrationSyncState::query()->updateOrCreate(
                    [
                        'system' => 'logo',
                        'domain' => 'pos-delivery-balances',
                        'direction' => 'inbound',
                        'entity_type' => 'logo-warehouse',
                        'entity_id' => $warehouseNo,
                    ],
                    [
                        'dealer_id' => $dealerId,
                        'external_ref' => 'WAREHOUSE-'.$warehouseNo,
                        'status' => 'synced',
                        'last_error' => null,
                        'last_synced_at' => now(),
                        'meta' => [
                            'warehouse_no' => $warehouseNo,
                            'count' => $warehouseRecords->sum(fn (array $record): int => (int) $record['count']),
                            'amount' => number_format(
                                $warehouseRecords->sum(fn (array $record): float => (float) $record['amount']),
                                2,
                                '.',
                                ''
                            ),
                        ],
                    ],
                );
            }
        });

        return response()->json([
            'received' => count($validated['records']),
            'synced' => count($validated['records']),
        ]);
    }
}
