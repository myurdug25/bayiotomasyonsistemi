<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Cart\ShowCartRequest;
use App\Models\Cart;
use App\Models\CartItem;
use App\Models\Customer;
use App\Models\User;
use App\Support\Cart\CartLogoIntegrationSummary;
use App\Support\Warehouse\CartWarehouseOptions;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

class CartController extends Controller
{
    public function show(ShowCartRequest $request): JsonResponse
    {
        $user = $request->user();
        $this->ensureOrderRole($user);

        $validated = $request->validated();
        $customerId = isset($validated['customer_id'])
            ? (int) $validated['customer_id']
            : ($user->selected_customer_id !== null ? (int) $user->selected_customer_id : null);

        if ($customerId === null) {
            return response()->json([
                'cart' => null,
                'items' => [],
                'totals' => $this->emptyTotals(),
                'message' => 'No selected customer found. Select a customer from context first.',
            ]);
        }

        $dealerId = $this->resolveDealerId(
            user: $user,
            requestedDealerId: $validated['dealer_id'] ?? null,
            customerId: $customerId
        );
        if ($dealerId === null) {
            return response()->json([
                'message' => 'dealer_id is required for admin users without dealer assignment.',
            ], Response::HTTP_UNPROCESSABLE_ENTITY);
        }

        $this->assertCustomerBelongsToDealer($user, $customerId, $dealerId);

        $cart = Cart::query()
            ->where('status', 'draft')
            ->where('dealer_id', $dealerId)
            ->where('user_id', $user->id)
            ->where('customer_id', $customerId)
            ->with(['items.product.brand', 'items.product.stockSummary', 'customer'])
            ->latest('id')
            ->first();

        if ($cart === null) {
            return response()->json([
                'cart' => null,
                'items' => [],
                'totals' => $this->emptyTotals(),
            ]);
        }

        return response()->json($this->cartPayload($cart));
    }

    private function cartPayload(Cart $cart): array
    {
        $items = $cart->items->map(function (CartItem $item): array {
            $quantity = max(1, (int) $item->quantity);
            $lineTotal = $this->cartLineTotal($item);
            $unitPrice = round($lineTotal / $quantity, 2);

            return [
                'id' => $item->id,
                'product_id' => $item->product_id,
                'sku' => $item->product?->sku,
                'name' => $item->product?->name,
                'brand' => $item->product?->brand?->name,
                'stock' => max(0, (int) ($item->product?->stockSummary?->available_total ?? 0)),
                'available_total' => max(0, (int) ($item->product?->stockSummary?->available_total ?? 0)),
                'qty' => $item->quantity,
                'quantity' => $item->quantity,
                'unit_price' => number_format($unitPrice, 2, '.', ''),
                'unit_net_price' => number_format($unitPrice, 2, '.', ''),
                'discount' => $item->discount_rate,
                'discount_rate' => $item->discount_rate,
                'vat_rate' => $item->vat_rate,
                'source_unit_net_price' => $item->unit_net_price,
                'line_total' => number_format($lineTotal, 2, '.', ''),
                'currency' => $item->currency,
                'campaign_key' => $item->campaign_key,
            ];
        })->values();

        $totals = $this->calculateTotals($cart);

        return [
            'cart' => [
                'id' => $cart->id,
                'dealer_id' => $cart->dealer_id,
                'customer_id' => $cart->customer_id,
                'status' => $cart->status,
                'currency' => $cart->currency,
                'note' => $cart->note,
                'shipping_method' => $cart->shipping_method,
                'warehouse_transfer' => (bool) $cart->is_warehouse_transfer,
                'order_note' => $cart->order_note,
                'updated_at' => $cart->updated_at,
            ],
            'items' => $items,
            'warehouse_options' => app(CartWarehouseOptions::class)->forCartItems($cart->items),
            'logo_integration' => app(CartLogoIntegrationSummary::class)->forCart($cart),
            'totals' => $totals,
        ];
    }

    private function calculateTotals(Cart $cart): array
    {
        $grossTotal = 0.0;
        $discountTotal = 0.0;
        $netTotal = 0.0;
        $vatTotal = 0.0;
        $lineCount = 0;

        foreach ($cart->items as $item) {
            $qty = (int) $item->quantity;
            $unitPrice = round((float) $item->unit_net_price, 2);
            $discountRate = (float) $item->discount_rate;
            $vatRate = (float) $item->vat_rate;

            $gross = $unitPrice * $qty;
            $hasFinalCampaignUnitPrice = $item->campaign_key !== null
                && trim((string) $item->campaign_key) !== ''
                && $discountRate <= 0;
            $discount = $hasFinalCampaignUnitPrice ? 0.0 : $gross * ($discountRate / 100);
            $net = $this->cartLineTotal($item);
            $vat = $net * ($vatRate / 100);

            $grossTotal += $gross;
            $discountTotal += $discount;
            $netTotal += $net;
            $vatTotal += $vat;
            $lineCount += $qty;
        }

        $grandTotal = $netTotal + $vatTotal;

        return [
            'total' => number_format($grossTotal, 2, '.', ''),
            'discount_total' => number_format($discountTotal, 2, '.', ''),
            'net_total' => number_format($netTotal, 2, '.', ''),
            'vat_total' => number_format($vatTotal, 2, '.', ''),
            'grand_total' => number_format($grandTotal, 2, '.', ''),
            'subtotal' => number_format($netTotal, 2, '.', ''),
            'line_count' => $lineCount,
        ];
    }

    private function cartLineTotal(CartItem $item): float
    {
        $qty = max(1, (int) $item->quantity);
        $unitPrice = round((float) $item->unit_net_price, 2);
        $gross = $unitPrice * $qty;

        if (
            $item->campaign_key !== null
            && trim((string) $item->campaign_key) !== ''
            && (float) $item->discount_rate <= 0
        ) {
            return round($gross, 2);
        }

        $discountRate = max(0.0, (float) $item->discount_rate);

        return round($gross - ($gross * ($discountRate / 100)), 2);
    }

    private function emptyTotals(): array
    {
        return [
            'total' => '0.00',
            'discount_total' => '0.00',
            'net_total' => '0.00',
            'vat_total' => '0.00',
            'grand_total' => '0.00',
            'subtotal' => '0.00',
            'line_count' => 0,
        ];
    }

    private function assertCustomerBelongsToDealer(User $user, int $customerId, int $dealerId): void
    {
        $customer = Customer::query()
            ->whereKey($customerId)
            ->where('dealer_id', $dealerId)
            ->first();

        if (! $customer instanceof Customer) {
            abort(Response::HTTP_FORBIDDEN, 'Selected customer does not belong to this dealer.');
        }

        if (! $user->canAccessCustomer($customer)) {
            abort(Response::HTTP_FORBIDDEN, 'You can only access your assigned customers.');
        }
    }

    /**
     * @param  int|string|null  $requestedDealerId
     */
    private function resolveDealerId(User $user, $requestedDealerId, ?int $customerId = null): ?int
    {
        if ($user->dealer_id !== null) {
            return (int) $user->dealer_id;
        }

        if ($user->hasRole('admin') && $requestedDealerId !== null) {
            return (int) $requestedDealerId;
        }

        if ($user->hasRole('admin') && $customerId !== null) {
            $dealerId = Customer::query()
                ->whereKey($customerId)
                ->value('dealer_id');

            return $dealerId !== null ? (int) $dealerId : null;
        }

        return null;
    }

    private function ensureOrderRole(User $user): void
    {
        if (! $user->hasAnyRole(['admin', 'dealer_admin', 'salesperson', 'cashier', 'point', 'customer', 'warehouse'])) {
            abort(Response::HTTP_FORBIDDEN, 'You are not allowed to access cart/order flow.');
        }
    }
}
