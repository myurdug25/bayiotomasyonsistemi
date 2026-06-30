<?php

namespace App\Http\Resources\Order;

use App\Models\IntegrationSyncState;
use App\Models\Order;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * @mixin Order
 */
class OrderListItemResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        $logoSyncState = $this->logoSyncState();
        $totalQuantity = (int) round((float) ($this->getAttribute('total_quantity') ?? 0));
        $shippedQuantity = (int) round((float) ($this->getAttribute('shipped_quantity') ?? 0));
        $remainingQuantity = max(0, $totalQuantity - $shippedQuantity);

        $latestTimelineEntry = $this->latestStatusHistory;
        $totals = [
            'currency' => $this->currency,
            'subtotal' => $this->subtotal,
            'discount_total' => $this->discount_total,
            'tax_total' => $this->tax_total,
            'grand_total' => $this->grand_total,
            'item_count' => (int) ($this->items_count ?? 0),
            'total_quantity' => $totalQuantity,
            'shipped_quantity' => $shippedQuantity,
            'remaining_quantity' => $remainingQuantity,
        ];

        return [
            'id' => $this->id,
            'order_id' => $this->id,
            'order_no' => $this->order_no,
            'status' => $this->status === 'partially_shipped' ? 'balance' : $this->status,
            'dealer_id' => $this->dealer_id,
            'customer_id' => $this->customer_id,
            'customer' => [
                'id' => $this->customer?->id,
                'code' => $this->customer?->code,
                'title' => $this->customer?->name,
            ],
            'currency' => $this->currency,
            'subtotal' => $this->subtotal,
            'discount_total' => $this->discount_total,
            'tax_total' => $this->tax_total,
            'grand_total' => $this->grand_total,
            'item_count' => $totals['item_count'],
            'total_quantity' => $totals['total_quantity'],
            'shipped_quantity' => $totals['shipped_quantity'],
            'remaining_quantity' => $totals['remaining_quantity'],
            'ordered_at' => $this->ordered_at,
            'approved_at' => $this->approved_at,
            'logo_sync_status' => $logoSyncState?->status,
            'logo_sync_error' => $logoSyncState?->last_error,
            'logo_external_ref' => $logoSyncState?->external_ref,
            'logo_last_synced_at' => $logoSyncState?->last_synced_at,
            'totals' => $totals,
            'status_timeline_summary' => [
                'total_events' => (int) ($this->status_timeline_count ?? 0),
                'last_event' => $latestTimelineEntry
                    ? [
                        'id' => $latestTimelineEntry->id,
                        'status' => $latestTimelineEntry->status,
                        'note' => $latestTimelineEntry->note,
                        'created_at' => $latestTimelineEntry->created_at,
                        'changed_by' => [
                            'id' => $latestTimelineEntry->changedBy?->id,
                            'name' => $latestTimelineEntry->changedBy?->name,
                        ],
                    ]
                    : null,
            ],
        ];
    }

    private function logoSyncState(): ?IntegrationSyncState
    {
        return IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'orders')
            ->where('direction', 'outbound')
            ->where('entity_type', Order::class)
            ->where('entity_id', $this->id)
            ->latest('id')
            ->first();
    }
}
