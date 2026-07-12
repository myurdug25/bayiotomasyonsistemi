<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\IntegrationSyncState;
use App\Models\Order;
use App\Models\Shipment;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Symfony\Component\HttpFoundation\Response as HttpResponse;

class WarehouseShipmentPrintController extends Controller
{
    public function packingSlip(Request $request, Shipment $shipment): Response
    {
        $shipment = $this->loadShipment($shipment);
        $this->ensureShipmentScope($request->user(), $shipment);

        $totals = [
            'ordered_qty_total' => 0,
            'shipped_qty_total' => 0,
            'remaining_qty_total' => 0,
            'sent_amount' => 0.0,
        ];

        foreach ($shipment->items as $item) {
            $ordered = (int) $item->ordered_qty;
            $shipped = (int) $item->shipped_qty;
            $remaining = max(0, $ordered - $shipped);

            $totals['ordered_qty_total'] += $ordered;
            $totals['shipped_qty_total'] += $shipped;
            $totals['remaining_qty_total'] += $remaining;
            $totals['sent_amount'] += (float) $item->line_total_shipped;
        }

        return response()->view('warehouse.prints.packing-slip', [
            'shipment' => $shipment,
            'totals' => $totals,
            'powersaLogoDataUri' => $this->powersaLogoDataUri(),
            'statusLabel' => $this->statusLabel((string) $shipment->status),
            'printedAt' => now(),
        ], HttpResponse::HTTP_OK, [
            'Content-Type' => 'text/html; charset=UTF-8',
        ]);
    }

    public function label(Request $request, Shipment $shipment): Response
    {
        $shipment = $this->loadShipment($shipment);
        $this->ensureShipmentScope($request->user(), $shipment);

        return response()->view('warehouse.prints.label', [
            'shipment' => $shipment,
            'labelShipTime' => $this->resolveLabelShipTime($request->query('ship_time'), $shipment),
        ], HttpResponse::HTTP_OK, [
            'Content-Type' => 'text/html; charset=UTF-8',
        ]);
    }

    public function invoice(Request $request, Shipment $shipment): Response
    {
        $shipment = $this->loadShipment($shipment);
        $this->ensureShipmentScope($request->user(), $shipment);

        $order = $shipment->order;
        $syncMeta = $order instanceof Order ? $this->orderSyncMeta($order) : [];
        $checkoutSummary = $this->checkoutSummaryFromMode(data_get($syncMeta, 'checkout_summary_mode'));
        $salesPriceType = $this->salesPriceTypeLabel($this->nullableString(data_get($syncMeta, 'sales_price_type')));
        $isTaxExcluded = data_get($checkoutSummary, 'mode') === 'excluded';

        $subtotal = 0.0;
        $vatTotal = 0.0;
        $quantityTotal = 0;

        foreach ($shipment->items as $item) {
            $lineTotal = (float) $item->line_total_shipped;
            $vatRate = (float) $item->vat_rate;

            $subtotal += $lineTotal;
            $quantityTotal += (int) $item->shipped_qty;

            if (! $isTaxExcluded) {
                $vatTotal += $lineTotal * ($vatRate / 100);
            }
        }

        return response()->view('warehouse.prints.invoice', [
            'shipment' => $shipment,
            'powersaLogoDataUri' => $this->powersaLogoDataUri(),
            'printedAt' => now(),
            'checkoutSummary' => $checkoutSummary,
            'salesPriceType' => $salesPriceType,
            'shippingLabel' => $this->shippingLabel($order?->cart?->shipping_method),
            'totals' => [
                'subtotal' => $subtotal,
                'vat_total' => $vatTotal,
                'grand_total' => $subtotal + $vatTotal,
                'quantity_total' => $quantityTotal,
            ],
        ], HttpResponse::HTTP_OK, [
            'Content-Type' => 'text/html; charset=UTF-8',
        ]);
    }

    private function loadShipment(Shipment $shipment): Shipment
    {
        return $shipment->loadMissing([
            'order.customer',
            'order.dealer',
            'order.cart',
            'order.user',
            'warehouse',
            'items.product.brand',
            'createdBy',
        ]);
    }

    private function powersaLogoDataUri(): ?string
    {
        $paths = [
            base_path('../web/public/brand/apple/powersa-filter-logo-from-pdf.png'),
            base_path('../web/public/brand/powersa-gucsa-logo-clean.png'),
            base_path('../web/public/brand/powersa-logo-tight.png'),
            base_path('../web/public/brand/powersa-logo.png'),
        ];

        foreach ($paths as $path) {
            if (! is_file($path)) {
                continue;
            }

            $binary = file_get_contents($path);

            if ($binary === false) {
                continue;
            }

            $mime = mime_content_type($path) ?: 'image/png';

            return 'data:'.$mime.';base64,'.base64_encode($binary);
        }

        return null;
    }

    private function statusLabel(string $status): string
    {
        return match (strtolower($status)) {
            'draft' => 'Taslak',
            'picking' => 'Toplanıyor',
            'packed' => 'Hazırlandı',
            'shipped' => 'Sevk Edildi',
            'cancelled' => 'İptal',
            default => strtoupper($status),
        };
    }

    private function resolveLabelShipTime(mixed $value, Shipment $shipment): string
    {
        if (is_scalar($value)) {
            $raw = trim((string) $value);
            if ($raw !== '') {
                return $raw;
            }
        }

        return optional($shipment->shipped_at ?? $shipment->created_at)->format('d.m.Y H:i:s') ?? '-';
    }

    /**
     * @return array<string, mixed>
     */
    private function orderSyncMeta(Order $order): array
    {
        $state = IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'orders')
            ->where('direction', 'outbound')
            ->where('entity_type', Order::class)
            ->where('entity_id', (int) $order->id)
            ->latest('id')
            ->first();

        return is_array($state?->meta) ? $state->meta : [];
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

    private function shippingLabel(?string $value): ?string
    {
        $normalized = mb_strtoupper(trim((string) $value), 'UTF-8');

        if ($normalized === '') {
            return null;
        }

        if (str_contains($normalized, 'KARGO') || str_contains($normalized, 'CARGO')) {
            return 'KARGO';
        }

        if (str_contains($normalized, 'OTOB')) {
            return 'OTOBÜS';
        }

        if (str_contains($normalized, 'DEPO')) {
            return 'DEPOYA SEVK';
        }

        return $value;
    }

    private function ensureShipmentScope(?User $user, Shipment $shipment): void
    {
        if (! $user instanceof User) {
            abort(HttpResponse::HTTP_UNAUTHORIZED, 'Unauthenticated.');
        }

        if ($user->hasRole('admin')) {
            return;
        }

        $dealerId = $shipment->order?->dealer_id;

        if ($dealerId === null || $user->dealer_id === null || (int) $dealerId !== (int) $user->dealer_id) {
            abort(HttpResponse::HTTP_FORBIDDEN, 'Bu sevkiyat yazdirma yetkiniz yok.');
        }
    }
}
