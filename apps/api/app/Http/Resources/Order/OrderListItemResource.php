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
        $logoSyncMeta = is_array($logoSyncState?->meta) ? $logoSyncState->meta : [];
        $totalQuantity = (int) round((float) ($this->getAttribute('total_quantity') ?? 0));
        $shippedQuantity = (int) round((float) ($this->getAttribute('shipped_quantity') ?? 0));
        $remainingQuantity = max(0, $totalQuantity - $shippedQuantity);
        $checkoutSummary = $this->checkoutSummaryFromMode($logoSyncMeta['checkout_summary_mode'] ?? null);
        $salesPriceType = $this->nullableString($logoSyncMeta['sales_price_type'] ?? null);

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
            'checkout_summary' => $checkoutSummary,
            'sales_price_type' => $salesPriceType,
            'sales_price_type_label' => $this->salesPriceTypeLabel($salesPriceType),
            'shipping_method' => $this->cart?->shipping_method,
            'origin' => [
                'checkout_summary' => $checkoutSummary,
                'sales_price_type' => $salesPriceType,
                'sales_price_type_label' => $this->salesPriceTypeLabel($salesPriceType),
                'shipping_method' => $this->cart?->shipping_method,
            ],
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

    /**
     * @return array{mode:string,code:string,label:string}|null
     */
    private function checkoutSummaryFromMode(mixed $value): ?array
    {
        $mode = trim((string) $value);

        return match ($mode) {
            'detailed' => ['mode' => 'detailed', 'code' => '1-F', 'label' => '1-F'],
            'excluded' => ['mode' => 'excluded', 'code' => '2-O', 'label' => '2-0'],
            'included' => ['mode' => 'included', 'code' => '3-B', 'label' => '3-B'],
            default => null,
        };
    }

    private function nullableString(mixed $value): ?string
    {
        if (! is_scalar($value)) {
            return null;
        }

        $normalized = trim((string) $value);

        return $normalized !== '' ? $normalized : null;
    }

    private function salesPriceTypeLabel(?string $value): ?string
    {
        $normalized = mb_strtolower(trim((string) $value), 'UTF-8');

        return match ($normalized) {
            'bank_transfer', 'transfer', 'havale', 'havale/eft', 'havale / eft' => 'Havale / EFT',
            'cash', 'nakit' => 'Nakit',
            'single_payment', 'tek çekim', 'tek cekim' => 'Tek Çekim',
            default => $value,
        };
    }
}
