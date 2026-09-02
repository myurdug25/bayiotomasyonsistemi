<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Cart\UpsertCartItemRequest;
use App\Models\Cart;
use App\Models\CartItem;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\Product;
use App\Models\User;
use App\Services\Pricing\ProductCampaignPricing;
use App\Support\Cart\CartLogoIntegrationSummary;
use App\Support\Cart\CheckoutNoteCleaner;
use App\Support\CustomerFeaturePermissions;
use App\Support\Pricing\CustomerPriceListResolver;
use App\Support\Pricing\DealerNetPriceExpression;
use App\Support\Pricing\DisplayCurrency;
use App\Support\Products\ProductCodeNormalizer;
use App\Support\Warehouse\CartWarehouseOptions;
use Illuminate\Cache\Repository as CacheRepository;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\Response as HttpStatus;

class CartItemController extends Controller
{
    public function store(UpsertCartItemRequest $request): JsonResponse
    {
        $user = $request->user();
        $this->ensureOrderRole($user);

        $cart = $this->upsertValidatedCartItem($user, $request->validated());

        return response()->json($this->cartPayload($cart));
    }

    public function bulk(Request $request): JsonResponse
    {
        $user = $request->user();
        $this->ensureOrderRole($user);

        $validated = $request->validate([
            'items' => ['required', 'array', 'min:1', 'max:300'],
            'items.*.product_code' => ['required', 'string', 'max:191'],
            'items.*.quantity' => ['required', 'integer', 'min:1', 'max:999999'],
            'customer_id' => ['nullable', 'integer', 'exists:customers,id'],
            'dealer_id' => ['nullable', 'integer', 'exists:dealers,id'],
            'shipping_method' => ['nullable', 'string', 'max:120'],
            'warehouse_transfer' => ['nullable', 'boolean'],
            'order_note' => ['nullable', 'string', 'max:2000'],
        ]);

        $results = [];
        $cart = null;
        $added = 0;
        $failed = 0;

        foreach ($validated['items'] as $index => $row) {
            $code = trim((string) $row['product_code']);
            $quantity = (int) $row['quantity'];
            $product = $this->resolveProductByCode($code);

            if (! $product instanceof Product) {
                $failed++;
                $results[] = [
                    'row' => $index + 1,
                    'product_code' => $code,
                    'quantity' => $quantity,
                    'status' => 'not_found',
                    'message' => 'Ürün bulunamadı.',
                ];

                continue;
            }

            try {
                $cart = $this->upsertValidatedCartItem($user, [
                    'product_id' => (int) $product->id,
                    'quantity' => $quantity,
                    'customer_id' => $validated['customer_id'] ?? null,
                    'dealer_id' => $validated['dealer_id'] ?? null,
                    'shipping_method' => $validated['shipping_method'] ?? null,
                    'warehouse_transfer' => $validated['warehouse_transfer'] ?? null,
                    'order_note' => CheckoutNoteCleaner::clean($validated['order_note'] ?? null),
                ]);

                $added++;
                $results[] = [
                    'row' => $index + 1,
                    'product_code' => $code,
                    'resolved_code' => $product->sku,
                    'product_id' => (int) $product->id,
                    'quantity' => $quantity,
                    'status' => 'added',
                    'message' => 'Eklendi.',
                ];
            } catch (ValidationException $exception) {
                $failed++;
                $results[] = [
                    'row' => $index + 1,
                    'product_code' => $code,
                    'resolved_code' => $product->sku,
                    'product_id' => (int) $product->id,
                    'quantity' => $quantity,
                    'status' => 'failed',
                    'message' => collect($exception->errors())->flatten()->first() ?? 'Eklenemedi.',
                ];
            }
        }

        if (! $cart instanceof Cart) {
            $cart = $this->currentDraftCartForUser($user, $validated);
        }

        return response()->json([
            'summary' => [
                'received' => count($validated['items']),
                'added' => $added,
                'failed' => $failed,
            ],
            'results' => $results,
            'cart' => $cart instanceof Cart ? $this->cartPayload($cart) : null,
        ]);
    }

    /**
     * @param  array<string, mixed>  $validated
     */
    private function upsertValidatedCartItem(User $user, array $validated): Cart
    {
        $customerId = isset($validated['customer_id'])
            ? (int) $validated['customer_id']
            : ($user->selected_customer_id !== null ? (int) $user->selected_customer_id : null);

        $dealerId = $this->resolveDealerId(
            user: $user,
            requestedDealerId: $validated['dealer_id'] ?? null,
            customerId: $customerId
        );
        if ($dealerId === null) {
            return response()->json([
                'message' => 'dealer_id is required for admin users without dealer assignment.',
            ], HttpStatus::HTTP_UNPROCESSABLE_ENTITY);
        }

        $forceWarehouseTransfer = $user->hasRole('salesperson');
        $isWarehouseTransfer = $forceWarehouseTransfer || (bool) ($validated['warehouse_transfer'] ?? false);

        if ($customerId === null) {
            if ($isWarehouseTransfer && $this->canUseWarehouseTransferCustomer($user)) {
                $customerId = (int) $this->warehouseTransferCustomer($dealerId)->id;
            } else {
                throw ValidationException::withMessages([
                    'customer_id' => ['No selected customer. Choose a customer via /api/context/customer first.'],
                ]);
            }
        }

        return DB::transaction(function () use ($validated, $dealerId, $user, $forceWarehouseTransfer, $customerId) {
            $productId = (int) $validated['product_id'];
            $quantity = (int) $validated['quantity'];
            $this->assertCustomerBelongsToDealer($user, $customerId, $dealerId);
            $isDepotTransferSystemCart = $this->isWarehouseTransferSystemCustomer($customerId);
            $discountRate = $isDepotTransferSystemCart
                ? 0.0
                : (array_key_exists('discount', $validated)
                    ? (float) ($validated['discount'] ?? 0)
                    : $this->customerSpecialDiscountRate($customerId));
            $cart = Cart::query()
                ->where('status', 'draft')
                ->where('dealer_id', $dealerId)
                ->where('user_id', $user->id)
                ->where('customer_id', $customerId)
                ->lockForUpdate()
                ->latest('id')
                ->first();

            if ($cart === null) {
                $cart = Cart::create([
                    'dealer_id' => $dealerId,
                    'customer_id' => $customerId,
                    'user_id' => $user->id,
                    'status' => 'draft',
                    'currency' => 'TRY',
                    'shipping_method' => $validated['shipping_method'] ?? null,
                    'is_warehouse_transfer' => $forceWarehouseTransfer || (bool) ($validated['warehouse_transfer'] ?? false),
                    'order_note' => CheckoutNoteCleaner::clean($validated['order_note'] ?? null),
                ]);
            } else {
                $cart->fill([
                    'shipping_method' => $validated['shipping_method'] ?? $cart->shipping_method,
                    'is_warehouse_transfer' => $forceWarehouseTransfer || (array_key_exists('warehouse_transfer', $validated)
                        ? (bool) $validated['warehouse_transfer']
                        : $cart->is_warehouse_transfer),
                    'order_note' => array_key_exists('order_note', $validated)
                        ? CheckoutNoteCleaner::clean($validated['order_note'])
                        : $cart->order_note,
                ])->save();
            }

            $this->assertCustomerBelongsToDealer($user, $cart->customer_id, $dealerId);

            $price = $this->resolveUnitPrice($dealerId, $customerId, $productId, $user);

            if ($price === null) {
                throw ValidationException::withMessages([
                    'product_id' => ['Bu ürün için fiyat gelmemiş. Logo fiyat senkronunu çalıştırın.'],
                ]);
            }

            $product = Product::query()
                ->select(['id', 'vat_rate', 'brand_id'])
                ->with('stockSummary')
                ->find($productId);

            $this->assertCustomerBrandAllowed($user, $customerId, $product?->brand_id);

            if ($product && $product->stockSummary) {
                $physicalStock = max(0, (int) $product->stockSummary->available_total);
                $reservedStock = max(0, (int) $product->stockSummary->reserved_total);
                $available = max(0, $physicalStock - $reservedStock);
                $allowsBackorder = $forceWarehouseTransfer || (bool) $cart->is_warehouse_transfer;
                if (! $allowsBackorder && $quantity > $available) {
                    throw ValidationException::withMessages([
                        'quantity' => ["Stok yetersiz. Bu üründen en fazla {$available} adet alabilirsiniz."],
                    ]);
                }
            }

            $item = CartItem::query()
                ->where('cart_id', $cart->id)
                ->where('product_id', $productId)
                ->lockForUpdate()
                ->first();

            $campaignKey = $isDepotTransferSystemCart ? null : (isset($validated['campaign_key'])
                ? trim((string) $validated['campaign_key'])
                : null);
            if ($campaignKey !== null && $campaignKey !== '' && $user->hasRole('customer')
                && ! in_array('search.campaigns', CustomerFeaturePermissions::forUser($user), true)) {
                throw ValidationException::withMessages([
                    'campaign_key' => ['Bu kullanıcı için kampanya kullanımı yetkili değil.'],
                ]);
            }
            $campaignPrice = $campaignKey !== null && $campaignKey !== ''
                ? app(ProductCampaignPricing::class)->resolve(
                    $productId,
                    $campaignKey,
                    $quantity,
                    $user,
                    $customerId
                )
                : null;

            if ($campaignKey !== null && $campaignKey !== '' && $campaignPrice === null) {
                throw ValidationException::withMessages([
                    'campaign_key' => ['Bu kampanya seçilen miktar için geçerli değil veya süresi dolmuş.'],
                ]);
            }

            $unitPrice = round((float) ($campaignPrice['unit_price'] ?? $price['net_price']), 2);
            $priceCurrency = (string) ($campaignPrice['currency'] ?? $price['currency']);
            $brandDiscounts = $campaignPrice === null
                ? $this->customerBrandDiscountChain($customerId, $product?->brand_id)
                : [];
            if ($brandDiscounts !== []) {
                foreach ($brandDiscounts as $brandDiscount) {
                    $unitPrice *= 1 - ($brandDiscount / 100);
                }
                $unitPrice = round($unitPrice, 2);
                $discountRate = 0.0;
            }
            if ($campaignPrice !== null) {
                $discountRate = $campaignPrice['discount_percent'] !== null
                    ? (float) $campaignPrice['discount_percent']
                    : 0.0;
            }
            $campaignProvidesFinalUnitPrice = $campaignPrice !== null
                && ($campaignPrice['unit_price'] ?? null) !== null;
            $grossTotal = $unitPrice * $quantity;
            $discountAmount = $campaignProvidesFinalUnitPrice
                ? 0.0
                : $grossTotal * ($discountRate / 100);
            $lineTotal = number_format(round($grossTotal - $discountAmount, 2), 2, '.', '');
            $vatRate = $isDepotTransferSystemCart ? 0.0 : (float) ($product?->vat_rate ?? 20.00);
            $cart->fill(['currency' => $priceCurrency])->save();

            if ($item !== null) {
                $item->fill([
                    'quantity' => $quantity,
                    'unit_net_price' => $unitPrice,
                    'currency' => $priceCurrency,
                    'campaign_key' => $campaignPrice['campaign_key'] ?? null,
                    'discount_rate' => $discountRate,
                    'vat_rate' => $vatRate,
                    'line_total' => $lineTotal,
                ])->save();
            } else {
                CartItem::create([
                    'cart_id' => $cart->id,
                    'product_id' => $productId,
                    'quantity' => $quantity,
                    'unit_net_price' => $unitPrice,
                    'currency' => $priceCurrency,
                    'campaign_key' => $campaignPrice['campaign_key'] ?? null,
                    'discount_rate' => $discountRate,
                    'vat_rate' => $vatRate,
                    'line_total' => $lineTotal,
                ]);
            }

            return $cart->fresh(['items.product.brand', 'items.product.stockSummary', 'customer']);
        });
    }

    public function destroy(Request $request, int $id): Response
    {
        $user = $request->user();
        $this->ensureOrderRole($user);

        $item = CartItem::query()
            ->with('cart')
            ->whereKey($id)
            ->first();

        if ($item === null || $item->cart === null) {
            abort(HttpStatus::HTTP_NOT_FOUND, 'Cart item not found.');
        }

        if ($item->cart->status !== 'draft' || (int) $item->cart->user_id !== (int) $user->id) {
            abort(HttpStatus::HTTP_FORBIDDEN, 'Cart item does not belong to your active cart.');
        }

        if ($user->dealer_id !== null && (int) $item->cart->dealer_id !== (int) $user->dealer_id) {
            abort(HttpStatus::HTTP_FORBIDDEN, 'Cart item dealer mismatch.');
        }

        $item->delete();

        return response()->noContent();
    }

    /**
     * @param  array<string, mixed>  $validated
     */
    private function currentDraftCartForUser(User $user, array $validated): ?Cart
    {
        $customerId = isset($validated['customer_id'])
            ? (int) $validated['customer_id']
            : ($user->selected_customer_id !== null ? (int) $user->selected_customer_id : null);

        $dealerId = $this->resolveDealerId(
            user: $user,
            requestedDealerId: $validated['dealer_id'] ?? null,
            customerId: $customerId
        );

        if ($dealerId === null) {
            return null;
        }

        if ($customerId === null) {
            if (! $this->canUseWarehouseTransferCustomer($user)) {
                return null;
            }

            $customerId = (int) $this->warehouseTransferCustomer($dealerId)->id;
        }

        return Cart::query()
            ->where('status', 'draft')
            ->where('dealer_id', $dealerId)
            ->where('user_id', $user->id)
            ->where('customer_id', $customerId)
            ->latest('id')
            ->with(['items.product.brand', 'items.product.stockSummary', 'customer'])
            ->first();
    }

    private function resolveProductByCode(string $code): ?Product
    {
        $trimmed = trim($code);
        if ($trimmed === '') {
            return null;
        }

        $normalized = ProductCodeNormalizer::normalize($trimmed);

        return Product::query()
            ->where('is_active', true)
            ->where(function ($query) use ($trimmed, $normalized): void {
                $query->where('sku', $trimmed)
                    ->orWhere('oem_code', $trimmed);

                if ($normalized !== null && $normalized !== '') {
                    $query->orWhereRaw("regexp_replace(upper(products.sku), '[^A-Z0-9]+', '', 'g') = ?", [$normalized])
                        ->orWhereRaw("regexp_replace(upper(products.oem_code), '[^A-Z0-9]+', '', 'g') = ?", [$normalized])
                        ->orWhereHas('codeAliases', fn ($aliasQuery) => $aliasQuery->where('normalized_code', $normalized));
                }
            })
            ->orderByRaw('sku = ? DESC', [$trimmed])
            ->first();
    }

    private function assertCustomerBelongsToDealer(User $user, int $customerId, int $dealerId): void
    {
        $customer = Customer::query()
            ->whereKey($customerId)
            ->where('dealer_id', $dealerId)
            ->first();

        if (! $customer instanceof Customer) {
            throw ValidationException::withMessages([
                'customer_id' => ['Customer does not belong to selected dealer.'],
            ]);
        }

        if (! $user->canAccessCustomer($customer)) {
            $meta = is_array($customer->meta) ? $customer->meta : [];
            if (($meta['system_purpose'] ?? null) === 'warehouse_transfer') {
                return;
            }

            throw ValidationException::withMessages([
                'customer_id' => ['You can only use assigned customers in cart flow.'],
            ]);
        }
    }

    private function warehouseTransferCustomer(int $dealerId): Customer
    {
        return Customer::query()->firstOrCreate(
            [
                'dealer_id' => $dealerId,
                'code' => 'B2B-DEPO-TRANSFER',
            ],
            [
                'name' => 'DEPOLAR ARASI TRANSFER',
                'source_system' => 'powersa',
                'source_reference' => 'warehouse-transfer',
                'sync_status' => 'ignored',
                'is_active' => true,
                'meta' => [
                    'system_purpose' => 'warehouse_transfer',
                    'logo_export' => false,
                ],
            ],
        );
    }

    private function canUseWarehouseTransferCustomer(User $user): bool
    {
        return $user->hasAnyRole(['admin', 'dealer_admin', 'warehouse', 'point']);
    }

    private function cartPayload(Cart $cart): array
    {
        $items = $cart->items->map(function ($item): array {
            $quantity = max(1, (int) $item->quantity);
            $lineTotal = $this->cartLineTotal($item);
            $effectiveUnitPrice = round($lineTotal / $quantity, 2);

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
                'unit_price' => number_format($effectiveUnitPrice, 2, '.', ''),
                'unit_net_price' => number_format($effectiveUnitPrice, 2, '.', ''),
                'source_unit_net_price' => $item->unit_net_price,
                'discount' => $item->discount_rate,
                'discount_rate' => $item->discount_rate,
                'vat_rate' => $item->vat_rate,
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
                'order_note' => CheckoutNoteCleaner::clean($cart->order_note),
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
        $quantity = max(1, (int) $item->quantity);
        $unitPrice = round((float) $item->unit_net_price, 2);
        $gross = $unitPrice * $quantity;

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

    /**
     * @return array{net_price:string, currency:string}|null
     */
    private function resolveUnitPrice(int $dealerId, int $customerId, int $productId, User $user): ?array
    {
        $fallbackPriceListId = Dealer::query()
            ->whereKey($dealerId)
            ->value('price_list_id');
        $priceListId = app(CustomerPriceListResolver::class)->resolve(
            $customerId,
            $fallbackPriceListId !== null ? (int) $fallbackPriceListId : null
        );
        if ($priceListId === null) {
            return null;
        }

        $cacheKey = "cart-price:dealer:{$dealerId}:customer:{$customerId}:list:{$priceListId}:product:{$productId}";
        $cached = $this->cacheStore()->get($cacheKey);
        if (is_array($cached) && isset($cached['net_price'], $cached['currency'])) {
            return [
                'net_price' => DisplayCurrency::formatPrice($cached['net_price'], (string) $cached['currency'], $user) ?? (string) $cached['net_price'],
                'currency' => DisplayCurrency::normalize((string) $cached['currency'], $user),
            ];
        }

        $netPriceSql = DealerNetPriceExpression::sql(
            basePriceColumn: 'COALESCE(bp.list_price, fallback_bp.list_price)',
            discountRateColumn: 'CASE WHEN bp.list_price IS NOT NULL THEN pl.discount_rate ELSE fallback_pl.discount_rate END',
        );

        $price = DB::table('dealers as d')
            ->leftJoin('dealer_price_overrides as dpo', function ($join) use ($productId) {
                $join->on('dpo.dealer_id', '=', 'd.id')
                    ->where('dpo.product_id', '=', $productId);
            })
            ->leftJoin('base_prices as bp', function ($join) use ($productId, $priceListId) {
                $join->where('bp.price_list_id', '=', $priceListId)
                    ->where('bp.product_id', '=', $productId);
            })
            ->leftJoin('price_lists as pl', 'pl.id', '=', 'bp.price_list_id')
            ->leftJoin('base_prices as fallback_bp', function ($join) use ($productId, $fallbackPriceListId) {
                $join->where('fallback_bp.price_list_id', '=', $fallbackPriceListId)
                    ->where('fallback_bp.product_id', '=', $productId);
            })
            ->leftJoin('price_lists as fallback_pl', 'fallback_pl.id', '=', 'fallback_bp.price_list_id')
            ->where('d.id', $dealerId)
            ->selectRaw("{$netPriceSql} as net_price")
            ->selectRaw("COALESCE(dpo.currency, bp.currency, fallback_bp.currency, 'TRY') as currency")
            ->first();

        if ($price === null || $price->net_price === null) {
            return null;
        }

        $normalized = [
            'net_price' => number_format((float) $price->net_price, 2, '.', ''),
            'currency' => (string) $price->currency,
        ];

        $this->cacheStore()->put($cacheKey, $normalized, now()->addMinutes(5));

        return [
            'net_price' => DisplayCurrency::formatPrice($normalized['net_price'], $normalized['currency'], $user) ?? $normalized['net_price'],
            'currency' => DisplayCurrency::normalize($normalized['currency'], $user),
        ];
    }

    private function customerSpecialDiscountRate(int $customerId): float
    {
        $customer = Customer::query()
            ->select(['id', 'meta'])
            ->find($customerId);

        if (! $customer instanceof Customer) {
            return 0.0;
        }

        $rate = data_get($customer->meta, 'special_discount_rate');

        if (! is_numeric($rate)) {
            return 0.0;
        }

        return max(0.0, min(100.0, (float) $rate));
    }

    /**
     * @return list<float>
     */
    private function customerBrandDiscountChain(int $customerId, mixed $brandId): array
    {
        if ($brandId === null) {
            return [];
        }

        $rows = data_get(Customer::query()->find($customerId)?->meta, 'customer_user.brand_discounts', []);
        foreach (is_array($rows) ? $rows : [] as $row) {
            if (! is_array($row) || (int) ($row['brand_id'] ?? 0) !== (int) $brandId) {
                continue;
            }

            return array_map(
                fn (mixed $value): float => max(0.0, min(100.0, (float) $value)),
                [$row['discount_1'] ?? 0, $row['discount_2'] ?? 0, $row['discount_3'] ?? 0]
            );
        }

        return [];
    }

    private function assertCustomerBrandAllowed(User $user, int $customerId, mixed $brandId): void
    {
        if (! $user->hasRole('customer')) {
            return;
        }

        $allowedBrandIds = data_get(
            Customer::query()->find($customerId)?->meta,
            'customer_user.allowed_brand_ids'
        );

        if (! is_array($allowedBrandIds)) {
            return;
        }

        $allowed = array_map('intval', $allowedBrandIds);
        if ($brandId === null || ! in_array((int) $brandId, $allowed, true)) {
            throw ValidationException::withMessages([
                'product_id' => ['Bu ürünün markası kullanıcı için yetkili değil.'],
            ]);
        }
    }

    private function isWarehouseTransferSystemCustomer(int $customerId): bool
    {
        $customer = Customer::query()
            ->select(['id', 'meta'])
            ->find($customerId);

        if (! $customer instanceof Customer) {
            return false;
        }

        $meta = is_array($customer->meta) ? $customer->meta : [];

        return ($meta['system_purpose'] ?? null) === 'warehouse_transfer';
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

        if ($user->hasRole('admin') && $this->canUseWarehouseTransferCustomer($user)) {
            return $this->defaultDealerId();
        }

        return null;
    }

    private function defaultDealerId(): ?int
    {
        $dealerId = Dealer::query()
            ->where('is_active', true)
            ->orderBy('id')
            ->value('id');

        if ($dealerId !== null) {
            return (int) $dealerId;
        }

        $dealerId = Dealer::query()
            ->orderBy('id')
            ->value('id');

        return $dealerId !== null ? (int) $dealerId : null;
    }

    private function ensureOrderRole(User $user): void
    {
        if (! $user->hasAnyRole(['admin', 'dealer_admin', 'salesperson', 'cashier', 'point', 'customer', 'warehouse'])) {
            abort(HttpStatus::HTTP_FORBIDDEN, 'You are not allowed to access cart/order flow.');
        }
    }

    private function cacheStore(): CacheRepository
    {
        return Cache::store((string) config('cache.default', 'file'));
    }
}
