<?php

namespace App\Services\Pos;

use App\Models\Collection;
use App\Models\Customer;
use App\Models\IntegrationSyncEvent;
use App\Models\IntegrationSyncState;
use App\Models\LedgerEntry;
use App\Models\PosPayment;
use App\Models\PosSale;
use App\Models\PosSaleItem;
use App\Models\PosSession;
use App\Models\Product;
use App\Models\StockMovement;
use App\Models\StockSummary;
use App\Models\User;
use App\Services\Integrations\IntegrationSyncStateService;
use App\Services\Integrations\Logo\LogoWritePublisher;
use App\Services\Ledger\LedgerWriter;
use App\Support\MenuPermissions;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

class PosSaleService
{
    private const POINT_CURRENCY = 'TRY';

    private const BATUM_POINT_CURRENCY = 'GEL';

    public function __construct(
        private readonly LedgerWriter $ledgerWriter,
        private readonly LogoWritePublisher $logoWritePublisher,
        private readonly IntegrationSyncStateService $syncState,
    ) {}

    /**
     * @param  array<string, mixed>  $payload
     */
    public function create(User $user, array $payload): PosSale
    {
        return DB::transaction(function () use ($user, $payload) {
            $session = PosSession::query()
                ->with(['openedBy', 'cashbox'])
                ->lockForUpdate()
                ->find((int) $payload['pos_session_id']);

            if (! $session instanceof PosSession || $session->status !== 'open') {
                throw ValidationException::withMessages([
                    'pos_session_id' => ['POS session not found or not open.'],
                ]);
            }

            $this->assertCanOperateSession($user, $session);
            $pointCurrency = $this->pointCurrency($session, $user);

            $customer = Customer::query()->lockForUpdate()->find((int) $payload['customer_id']);
            if (! $customer instanceof Customer) {
                throw ValidationException::withMessages([
                    'customer_id' => ['Customer not found.'],
                ]);
            }

            $this->assertCustomerBelongsToSessionScope($user, $customer, $session);

            $itemsPayload = collect((array) $payload['items']);
            $paymentsPayload = collect((array) $payload['payments']);
            $productIds = $itemsPayload->pluck('product_id')->map(fn ($id) => (int) $id)->unique()->values();

            $products = Product::query()->whereIn('id', $productIds)->get()->keyBy('id');
            $stocks = StockSummary::query()
                ->whereIn('product_id', $productIds)
                ->lockForUpdate()
                ->get()
                ->keyBy('product_id');

            $normalizedItems = [];
            foreach ($itemsPayload as $index => $item) {
                $productId = (int) Arr::get($item, 'product_id');
                $qty = (int) Arr::get($item, 'qty');
                $unitPriceCents = $this->toCents((float) Arr::get($item, 'unit_price', 0));
                $lineTotalInput = Arr::get($item, 'line_total');
                $lineTotalCents = $lineTotalInput !== null
                    ? $this->toCents((float) $lineTotalInput)
                    : ($unitPriceCents * $qty);

                $product = $products->get($productId);
                $stock = $stocks->get($productId);

                if (! $product) {
                    throw ValidationException::withMessages([
                        "items.{$index}.product_id" => ['Product not found.'],
                    ]);
                }

                if (! $stock instanceof StockSummary) {
                    $stock = StockSummary::query()->create([
                        'product_id' => $productId,
                        'available_total' => 0,
                        'reserved_total' => 0,
                        'updated_at' => now(),
                    ]);
                    $stocks->put($productId, $stock);
                }

                $normalizedItems[] = [
                    'product_id' => $productId,
                    'qty' => $qty,
                    'unit_price_cents' => $unitPriceCents,
                    'line_total_cents' => $lineTotalCents,
                    'vat_rate' => (float) (Arr::get($item, 'vat_rate') ?? $product->vat_rate ?? 0),
                ];
            }

            $totals = $this->calculateTotals(
                $normalizedItems,
                discountTotalCents: $this->toCents((float) ($payload['discount_total'] ?? 0)),
                applyVat: true
            );

            $paymentTotalCents = $paymentsPayload
                ->sum(fn (array $payment) => $this->toCents((float) ($payment['amount'] ?? 0)));

            if ($paymentTotalCents !== $totals['grand_total_cents']) {
                throw ValidationException::withMessages([
                    'payments' => ['Payment total must exactly match grand total.'],
                ]);
            }

            $receiptNo = $this->resolveReceiptNo($payload['receipt_no'] ?? null);

            $sale = PosSale::create([
                'pos_session_id' => $session->id,
                'customer_id' => $customer->id,
                'sale_type' => (string) $payload['sale_type'],
                'document_type' => (string) $payload['document_type'],
                'receipt_no' => $receiptNo,
                'subtotal' => $this->fromCents($totals['subtotal_cents']),
                'discount_total' => $this->fromCents($totals['discount_total_cents']),
                'vat_total' => $this->fromCents($totals['vat_total_cents']),
                'grand_total' => $this->fromCents($totals['grand_total_cents']),
                'status' => 'paid',
                'created_by' => $user->id,
            ]);
            $isInvoiceDocument = $sale->document_type === 'invoice';

            foreach ($totals['items'] as $item) {
                PosSaleItem::create([
                    'pos_sale_id' => $sale->id,
                    'product_id' => $item['product_id'],
                    'qty' => number_format((float) $item['qty'], 3, '.', ''),
                    'unit_price' => $this->fromCents($item['unit_price_cents']),
                    'vat_rate' => number_format((float) $item['vat_rate'], 2, '.', ''),
                    'line_total' => $this->fromCents($item['line_total_cents']),
                ]);

                /** @var StockSummary $stock */
                $stock = $stocks->get($item['product_id']);
                $stock->available_total = (int) $stock->available_total - (int) $item['qty'];
                $stock->updated_at = now();
                $stock->save();

                StockMovement::create([
                    'product_id' => $item['product_id'],
                    'type' => 'out',
                    'source' => 'pos_sale',
                    'source_id' => $sale->id,
                    'qty' => number_format((float) $item['qty'], 3, '.', ''),
                    'created_at' => now(),
                ]);
            }

            if ($isInvoiceDocument) {
                $this->ledgerWriter->write([
                    'dealer_id' => $customer->dealer_id,
                    'customer_id' => $customer->id,
                    'order_id' => null,
                    'collection_id' => null,
                    'date' => now()->toDateString(),
                    'type' => 'invoice',
                    'debit' => $this->fromCents($totals['grand_total_cents']),
                    'credit' => 0,
                    'currency' => $pointCurrency,
                    'reference_no' => $sale->receipt_no,
                    'description' => 'POS sale '.$sale->receipt_no,
                    'created_by_user_id' => $user->id,
                    'meta' => [
                        'source' => 'pos_sale',
                        'pos_sale_id' => $sale->id,
                    ],
                ]);
            }

            foreach ($paymentsPayload as $paymentPayload) {
                $payment = PosPayment::create([
                    'pos_sale_id' => $sale->id,
                    'method' => (string) $paymentPayload['method'],
                    'amount' => number_format((float) $paymentPayload['amount'], 2, '.', ''),
                    'meta_json' => $paymentPayload['meta_json'] ?? null,
                ]);

                if (! $isInvoiceDocument) {
                    continue;
                }

                $collection = Collection::create([
                    'dealer_id' => $customer->dealer_id,
                    'customer_id' => $customer->id,
                    'source_system' => 'b2b',
                    'source_reference' => null,
                    'sync_status' => $this->shouldQueueForLogoExport($customer) ? 'pending' : null,
                    'sync_error' => null,
                    'last_synced_at' => null,
                    'date' => now()->toDateString(),
                    'collection_date' => now()->toDateString(),
                    'collected_by_user_id' => $user->id,
                    'created_by_user_id' => $user->id,
                    'method' => $this->toCollectionMethod($payment->method),
                    'amount' => $payment->amount,
                    'currency' => $pointCurrency,
                    'reference_no' => $sale->receipt_no,
                    'reference_fields' => [
                        'pos_payment_id' => $payment->id,
                    ],
                    'note' => 'POS payment '.$sale->receipt_no,
                    'meta' => [
                        'source' => 'pos_sale',
                        'pos_session_id' => $session->id,
                        'pos_sale_id' => $sale->id,
                        'pos_payment_id' => $payment->id,
                        'cashbox_id' => $session->cashbox_id,
                        'payment_meta' => $payment->meta_json,
                    ],
                ]);

                $this->ledgerWriter->write([
                    'dealer_id' => $customer->dealer_id,
                    'customer_id' => $customer->id,
                    'order_id' => null,
                    'collection_id' => $collection->id,
                    'date' => now()->toDateString(),
                    'type' => 'payment',
                    'debit' => 0,
                    'credit' => $payment->amount,
                    'currency' => $pointCurrency,
                    'reference_no' => $sale->receipt_no,
                    'description' => 'POS payment '.$sale->receipt_no,
                    'created_by_user_id' => $user->id,
                    'meta' => [
                        'source' => 'pos_sale_payment',
                        'pos_session_id' => $session->id,
                        'pos_sale_id' => $sale->id,
                        'pos_payment_id' => $payment->id,
                        'cashbox_id' => $session->cashbox_id,
                        'method' => $payment->method,
                    ],
                ]);

                if ($collection->sync_status === 'pending') {
                    $this->logoWritePublisher->queueCollectionCreate($collection);
                }
            }

            if ($this->shouldQueueSaleForLogoExport($sale)) {
                $this->queueSaleForLogoExport($sale);
            }

            return $sale->fresh([
                'customer',
                'createdBy',
                'posSession.cashbox',
                'items.product.brand',
                'payments',
            ]);
        });
    }

    public function cancel(User $user, PosSale $posSale, ?string $note = null): PosSale
    {
        return DB::transaction(function () use ($user, $posSale, $note) {
            $sale = PosSale::query()
                ->with(['posSession.openedBy', 'customer', 'items', 'payments'])
                ->lockForUpdate()
                ->find($posSale->id);

            if (! $sale instanceof PosSale) {
                throw ValidationException::withMessages([
                    'sale' => ['POS sale not found.'],
                ]);
            }

            if ($sale->status === 'cancelled') {
                throw ValidationException::withMessages([
                    'sale' => ['POS sale is already cancelled.'],
                ]);
            }

            if (! $sale->posSession instanceof PosSession) {
                throw ValidationException::withMessages([
                    'sale' => ['POS session relation is missing.'],
                ]);
            }

            $this->assertCanOperateSession($user, $sale->posSession);
            $pointCurrency = $this->pointCurrency($sale->posSession, $user);

            $stocks = StockSummary::query()
                ->whereIn('product_id', $sale->items->pluck('product_id')->unique()->values())
                ->lockForUpdate()
                ->get()
                ->keyBy('product_id');

            foreach ($sale->items as $item) {
                /** @var StockSummary|null $stock */
                $stock = $stocks->get($item->product_id);
                if (! $stock instanceof StockSummary) {
                    throw ValidationException::withMessages([
                        'stock' => ["Stock summary row not found for product_id={$item->product_id}."],
                    ]);
                }

                $stock->available_total = (int) $stock->available_total + (int) round((float) $item->qty);
                $stock->updated_at = now();
                $stock->save();

                StockMovement::create([
                    'product_id' => $item->product_id,
                    'type' => 'in',
                    'source' => 'pos_sale',
                    'source_id' => $sale->id,
                    'qty' => number_format((float) $item->qty, 3, '.', ''),
                    'created_at' => now(),
                ]);
            }

            $sale->status = 'cancelled';
            $sale->save();

            $cancelNote = trim((string) ($note ?? 'POS cancellation (F10)'));

            $this->ledgerWriter->write([
                'dealer_id' => $sale->customer->dealer_id,
                'customer_id' => $sale->customer_id,
                'order_id' => null,
                'collection_id' => null,
                'date' => now()->toDateString(),
                'type' => 'credit',
                'debit' => 0,
                'credit' => $sale->grand_total,
                'currency' => $pointCurrency,
                'reference_no' => $sale->receipt_no,
                'description' => $cancelNote.' - reverse invoice '.$sale->receipt_no,
                'created_by_user_id' => $user->id,
                'meta' => [
                    'source' => 'pos_sale_cancel',
                    'pos_sale_id' => $sale->id,
                ],
            ]);

            foreach ($sale->payments as $payment) {
                $reversalCollection = Collection::create([
                    'dealer_id' => $sale->customer->dealer_id,
                    'customer_id' => $sale->customer_id,
                    'date' => now()->toDateString(),
                    'collection_date' => now()->toDateString(),
                    'collected_by_user_id' => $user->id,
                    'created_by_user_id' => $user->id,
                    'method' => $this->toCollectionMethod($payment->method),
                    'amount' => number_format(-1 * (float) $payment->amount, 2, '.', ''),
                    'currency' => $pointCurrency,
                    'reference_no' => $sale->receipt_no,
                    'reference_fields' => [
                        'reversal_of_pos_payment_id' => $payment->id,
                    ],
                    'note' => $cancelNote.' - reverse payment '.$sale->receipt_no,
                    'meta' => [
                        'source' => 'pos_sale_cancel_reversal',
                        'pos_sale_id' => $sale->id,
                        'reversal_of_pos_payment_id' => $payment->id,
                    ],
                ]);

                $this->ledgerWriter->write([
                    'dealer_id' => $sale->customer->dealer_id,
                    'customer_id' => $sale->customer_id,
                    'order_id' => null,
                    'collection_id' => $reversalCollection->id,
                    'date' => now()->toDateString(),
                    'type' => 'debit',
                    'debit' => $payment->amount,
                    'credit' => 0,
                    'currency' => $pointCurrency,
                    'reference_no' => $sale->receipt_no,
                    'description' => $cancelNote.' - reverse payment '.$sale->receipt_no,
                    'created_by_user_id' => $user->id,
                    'meta' => [
                        'source' => 'pos_sale_cancel_payment_reverse',
                        'pos_sale_id' => $sale->id,
                        'reversal_of_pos_payment_id' => $payment->id,
                    ],
                ]);
            }

            return $sale->fresh([
                'customer',
                'createdBy',
                'posSession.cashbox',
                'items.product.brand',
                'payments',
            ]);
        });
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    public function updateDocument(User $user, PosSale $posSale, array $payload): PosSale
    {
        return DB::transaction(function () use ($user, $posSale, $payload) {
            $sale = PosSale::query()
                ->with(['posSession.openedBy', 'customer', 'items.product', 'payments'])
                ->lockForUpdate()
                ->find($posSale->id);

            if (! $sale instanceof PosSale) {
                throw ValidationException::withMessages([
                    'sale' => ['POS sale not found.'],
                ]);
            }

            if ($sale->status !== 'paid') {
                throw ValidationException::withMessages([
                    'sale' => ['Only active POS sales can be edited.'],
                ]);
            }

            $existingLogoState = $this->latestPosSaleLogoState($sale);
            if (
                $sale->document_type === 'delivery'
                && $existingLogoState instanceof IntegrationSyncState
                && $existingLogoState->status === 'synced'
                && $this->nullableString($existingLogoState->external_ref) === null
            ) {
                throw ValidationException::withMessages([
                    'logo' => ['Logo irsaliye referansı bulunamadı. Mevcut Logo kaydı bulunmadan yeni irsaliye oluşturulamaz.'],
                ]);
            }

            if (! $sale->posSession instanceof PosSession) {
                throw ValidationException::withMessages([
                    'sale' => ['POS session relation is missing.'],
                ]);
            }

            $this->assertCanOperateSession($user, $sale->posSession);

            $receiptNo = trim((string) ($payload['receipt_no'] ?? ''));
            if ($receiptNo === '') {
                throw ValidationException::withMessages([
                    'receipt_no' => ['Belge numarası zorunludur.'],
                ]);
            }

            if (PosSale::query()->where('receipt_no', $receiptNo)->whereKeyNot($sale->id)->exists()) {
                throw ValidationException::withMessages([
                    'receipt_no' => ['receipt_no already exists.'],
                ]);
            }

            $itemsById = $sale->items->keyBy('id');
            $submittedIds = collect((array) $payload['items'])
                ->pluck('id')
                ->map(fn ($id) => (int) $id)
                ->sort()
                ->values();
            $existingIds = $itemsById->keys()->map(fn ($id) => (int) $id)->sort()->values();

            if ($submittedIds->unique()->count() !== $submittedIds->count() || $submittedIds->diff($existingIds)->isNotEmpty()) {
                throw ValidationException::withMessages([
                    'items' => ['Only existing document lines can be edited.'],
                ]);
            }
            $removedItems = $sale->items->whereIn('id', $existingIds->diff($submittedIds)->all());

            $normalizedItems = [];
            foreach ((array) $payload['items'] as $index => $itemPayload) {
                $itemId = (int) Arr::get($itemPayload, 'id');
                /** @var PosSaleItem|null $existingItem */
                $existingItem = $itemsById->get($itemId);

                if (! $existingItem instanceof PosSaleItem) {
                    throw ValidationException::withMessages([
                        "items.{$index}.id" => ['POS sale item not found on this document.'],
                    ]);
                }

                $qty = (int) Arr::get($itemPayload, 'qty');
                $unitPriceCents = $this->toCents((float) Arr::get($itemPayload, 'unit_price', 0));
                $lineTotalInput = Arr::get($itemPayload, 'line_total');
                $lineTotalCents = $lineTotalInput !== null
                    ? $this->toCents((float) $lineTotalInput)
                    : ($unitPriceCents * $qty);

                $normalizedItems[] = [
                    'id' => $existingItem->id,
                    'product_id' => $existingItem->product_id,
                    'qty' => $qty,
                    'old_qty' => (int) round((float) $existingItem->qty),
                    'unit_price_cents' => $unitPriceCents,
                    'line_total_cents' => $lineTotalCents,
                    'vat_rate' => (float) (Arr::get($itemPayload, 'vat_rate') ?? $existingItem->vat_rate ?? $existingItem->product?->vat_rate ?? 0),
                ];
            }

            $oldReceiptNo = $sale->receipt_no;
            $oldGrandTotal = (float) $sale->grand_total;
            $oldPaymentTotal = $sale->payments->sum(fn (PosPayment $payment) => (float) $payment->amount);
            $oldSaleType = $sale->sale_type;

            $totals = $this->calculateTotals(
                $normalizedItems,
                discountTotalCents: $this->toCents((float) ($payload['discount_total'] ?? 0)),
                applyVat: true
            );

            $paymentPayload = Arr::first((array) $payload['payments']);
            $paymentTotalCents = $this->toCents((float) Arr::get($paymentPayload, 'amount', 0));

            if ($paymentTotalCents !== $totals['grand_total_cents']) {
                throw ValidationException::withMessages([
                    'payments' => ['Payment total must exactly match grand total.'],
                ]);
            }

            $stocks = StockSummary::query()
                ->whereIn(
                    'product_id',
                    collect($normalizedItems)
                        ->pluck('product_id')
                        ->merge($removedItems->pluck('product_id'))
                        ->unique()
                        ->values()
                )
                ->lockForUpdate()
                ->get()
                ->keyBy('product_id');

            foreach ($removedItems as $removedItem) {
                /** @var StockSummary|null $stock */
                $stock = $stocks->get($removedItem->product_id);

                if (! $stock instanceof StockSummary) {
                    throw ValidationException::withMessages([
                        'stock' => ["Stock summary row not found for product_id={$removedItem->product_id}."],
                    ]);
                }

                $stock->available_total = (int) $stock->available_total + (int) round((float) $removedItem->qty);
                $stock->updated_at = now();
                $stock->save();

                StockMovement::create([
                    'product_id' => $removedItem->product_id,
                    'type' => 'in',
                    'source' => 'pos_sale',
                    'source_id' => $sale->id,
                    'qty' => number_format((float) $removedItem->qty, 3, '.', ''),
                    'created_at' => now(),
                ]);
            }

            PosSaleItem::query()
                ->whereIn('id', $removedItems->pluck('id')->values())
                ->delete();

            foreach ($totals['items'] as $item) {
                /** @var PosSaleItem $saleItem */
                $saleItem = $itemsById->get($item['id']);
                /** @var StockSummary|null $stock */
                $stock = $stocks->get($item['product_id']);

                if (! $stock instanceof StockSummary) {
                    throw ValidationException::withMessages([
                        'stock' => ["Stock summary row not found for product_id={$item['product_id']}."],
                    ]);
                }

                $deltaQty = (int) $item['qty'] - (int) $item['old_qty'];
                if ($deltaQty !== 0) {
                    $stock->available_total = (int) $stock->available_total - $deltaQty;
                    $stock->updated_at = now();
                    $stock->save();

                    StockMovement::create([
                        'product_id' => $item['product_id'],
                        'type' => $deltaQty > 0 ? 'out' : 'in',
                        'source' => 'pos_sale',
                        'source_id' => $sale->id,
                        'qty' => number_format(abs((float) $deltaQty), 3, '.', ''),
                        'created_at' => now(),
                    ]);
                }

                $saleItem->update([
                    'qty' => number_format((float) $item['qty'], 3, '.', ''),
                    'unit_price' => $this->fromCents($item['unit_price_cents']),
                    'vat_rate' => number_format((float) $item['vat_rate'], 2, '.', ''),
                    'line_total' => $this->fromCents($item['line_total_cents']),
                ]);
            }

            $sale->fill([
                'sale_type' => (string) $payload['sale_type'],
                'receipt_no' => $receiptNo,
                'subtotal' => $this->fromCents($totals['subtotal_cents']),
                'discount_total' => $this->fromCents($totals['discount_total_cents']),
                'vat_total' => $this->fromCents($totals['vat_total_cents']),
                'grand_total' => $this->fromCents($totals['grand_total_cents']),
            ]);
            $sale->save();

            $payment = $sale->payments->first();
            if (! $payment instanceof PosPayment) {
                $payment = PosPayment::create([
                    'pos_sale_id' => $sale->id,
                    'method' => (string) Arr::get($paymentPayload, 'method'),
                    'amount' => $this->fromCents($paymentTotalCents),
                    'meta_json' => Arr::get($paymentPayload, 'meta_json'),
                ]);
            } else {
                $payment->update([
                    'method' => (string) Arr::get($paymentPayload, 'method'),
                    'amount' => $this->fromCents($paymentTotalCents),
                    'meta_json' => Arr::get($paymentPayload, 'meta_json'),
                ]);
            }

            PosPayment::query()
                ->where('pos_sale_id', $sale->id)
                ->whereKeyNot($payment->id)
                ->delete();

            $this->syncPosSaleAccountingReferences(
                sale: $sale,
                payment: $payment,
                oldReceiptNo: $oldReceiptNo,
                oldSaleType: $oldSaleType,
                oldGrandTotal: $oldGrandTotal,
                oldPaymentTotal: (float) $oldPaymentTotal,
                user: $user
            );

            if ($this->shouldQueueSaleForLogoExport($sale)) {
                $this->queueSaleForLogoExport($sale);
            }

            return $sale->fresh([
                'customer',
                'createdBy',
                'posSession.cashbox',
                'items.product.brand',
                'payments',
            ]);
        });
    }

    public function deleteDocument(User $user, PosSale $posSale): void
    {
        DB::transaction(function () use ($user, $posSale): void {
            $sale = PosSale::query()
                ->with(['posSession.openedBy', 'customer', 'items', 'payments'])
                ->lockForUpdate()
                ->find($posSale->id);

            if (! $sale instanceof PosSale) {
                throw ValidationException::withMessages([
                    'sale' => ['POS sale not found.'],
                ]);
            }

            if (! $sale->posSession instanceof PosSession) {
                throw ValidationException::withMessages([
                    'sale' => ['POS session relation is missing.'],
                ]);
            }

            $this->assertCanOperateSession($user, $sale->posSession);
            $this->assertDocumentCanBeDeleted($sale);

            $existingLogoState = $this->latestPosSaleLogoState($sale);
            $logoExternalRef = $this->nullableString($existingLogoState?->external_ref);
            $shouldQueueLogoDelete = $sale->document_type === 'delivery'
                && $existingLogoState instanceof IntegrationSyncState
                && $existingLogoState->status === 'synced'
                && $logoExternalRef !== null
                && str_starts_with($logoExternalRef, 'STFICHE-');

            if ($sale->status === 'paid') {
                $this->restoreSaleStock($sale);
            }

            LedgerEntry::query()
                ->where(function ($query) use ($sale): void {
                    $query
                        ->where('meta->pos_sale_id', $sale->id)
                        ->orWhere('reference_no', $sale->receipt_no);
                })
                ->delete();

            Collection::query()
                ->where(function ($query) use ($sale): void {
                    $query
                        ->where('meta->pos_sale_id', $sale->id)
                        ->orWhere('reference_no', $sale->receipt_no);
                })
                ->delete();

            StockMovement::query()
                ->where('source', 'pos_sale')
                ->where('source_id', $sale->id)
                ->delete();

            if ($shouldQueueLogoDelete) {
                $sale->status = 'cancelled';
                $sale->save();

                $this->queueSaleDeleteForLogoExport($sale, $logoExternalRef);

                return;
            }

            IntegrationSyncEvent::query()
                ->where('entity_type', PosSale::class)
                ->where('entity_id', $sale->id)
                ->delete();

            IntegrationSyncState::query()
                ->where('entity_type', PosSale::class)
                ->where('entity_id', $sale->id)
                ->delete();

            $sale->delete();
        });
    }

    private function syncPosSaleAccountingReferences(
        PosSale $sale,
        PosPayment $payment,
        string $oldReceiptNo,
        string $oldSaleType,
        float $oldGrandTotal,
        float $oldPaymentTotal,
        User $user
    ): void {
        $newGrandTotal = (float) $sale->grand_total;
        $newPaymentTotal = (float) $payment->amount;
        $newCollectionMethod = $this->toCollectionMethod($payment->method);
        $pointCurrency = $this->pointCurrencyForSale($sale, $user);

        Collection::query()
            ->where(function ($query) use ($sale, $oldReceiptNo): void {
                $query
                    ->where('meta->pos_sale_id', $sale->id)
                    ->orWhere('reference_no', $oldReceiptNo);
            })
            ->update([
                'method' => $newCollectionMethod,
                'amount' => number_format($newPaymentTotal, 2, '.', ''),
                'currency' => $pointCurrency,
                'reference_no' => $sale->receipt_no,
                'note' => 'POS payment '.$sale->receipt_no,
            ]);

        LedgerEntry::query()
            ->where(function ($query) use ($sale, $oldReceiptNo): void {
                $query
                    ->where('meta->pos_sale_id', $sale->id)
                    ->orWhere('reference_no', $oldReceiptNo);
            })
            ->update([
                'reference_no' => $sale->receipt_no,
            ]);

        $invoiceDelta = round($newGrandTotal - $oldGrandTotal, 2);
        if ($invoiceDelta !== 0.0) {
            $this->ledgerWriter->write([
                'dealer_id' => $sale->customer->dealer_id,
                'customer_id' => $sale->customer_id,
                'order_id' => null,
                'collection_id' => null,
                'date' => now()->toDateString(),
                'type' => $invoiceDelta > 0 ? 'invoice' : 'credit',
                'debit' => $invoiceDelta > 0 ? number_format($invoiceDelta, 2, '.', '') : 0,
                'credit' => $invoiceDelta < 0 ? number_format(abs($invoiceDelta), 2, '.', '') : 0,
                'currency' => $pointCurrency,
                'reference_no' => $sale->receipt_no,
                'description' => 'POS sale edit '.$sale->receipt_no,
                'created_by_user_id' => $user->id,
                'meta' => [
                    'source' => 'pos_sale_edit',
                    'pos_sale_id' => $sale->id,
                    'old_receipt_no' => $oldReceiptNo,
                ],
            ]);
        }

        $paymentDelta = round($newPaymentTotal - $oldPaymentTotal, 2);
        if ($paymentDelta !== 0.0 || $oldSaleType !== $payment->method) {
            $collectionId = Collection::query()
                ->where('meta->pos_sale_id', $sale->id)
                ->value('id');

            if ($paymentDelta !== 0.0) {
                $this->ledgerWriter->write([
                    'dealer_id' => $sale->customer->dealer_id,
                    'customer_id' => $sale->customer_id,
                    'order_id' => null,
                    'collection_id' => $collectionId,
                    'date' => now()->toDateString(),
                    'type' => $paymentDelta > 0 ? 'payment' : 'debit',
                    'debit' => $paymentDelta < 0 ? number_format(abs($paymentDelta), 2, '.', '') : 0,
                    'credit' => $paymentDelta > 0 ? number_format($paymentDelta, 2, '.', '') : 0,
                    'currency' => $pointCurrency,
                    'reference_no' => $sale->receipt_no,
                    'description' => 'POS payment edit '.$sale->receipt_no,
                    'created_by_user_id' => $user->id,
                    'meta' => [
                        'source' => 'pos_sale_payment_edit',
                        'pos_sale_id' => $sale->id,
                        'pos_payment_id' => $payment->id,
                        'old_method' => $oldSaleType,
                        'method' => $payment->method,
                    ],
                ]);
            }
        }
    }

    private function assertDocumentCanBeDeleted(PosSale $sale): void
    {
        if ($sale->created_at === null || $sale->created_at->format('Y-m') !== now()->format('Y-m')) {
            throw ValidationException::withMessages([
                'sale' => ['Yalnızca içinde bulunulan aya ait irsaliye belgeleri silinebilir.'],
            ]);
        }

        if (! $this->isDayEndProtectedRetailSale($sale)) {
            return;
        }

        $session = $sale->posSession;
        $dayEndQueuedOrSynced = $session instanceof PosSession
            && IntegrationSyncState::query()
                ->where('system', 'logo')
                ->where('domain', 'pos-day-ends')
                ->where('direction', 'outbound')
                ->where('entity_type', PosSession::class)
                ->where('entity_id', (int) $session->id)
                ->whereIn('status', ['queued', 'synced'])
                ->exists();

        if (
            $session instanceof PosSession
            && (
                $session->status === 'closed'
                || $session->closed_at !== null
                || $dayEndQueuedOrSynced
            )
        ) {
            throw ValidationException::withMessages([
                'sale' => ['Gün sonu kaydı alınmış perakende nakit veya kredi kartı satış irsaliyeleri silinemez.'],
            ]);
        }
    }

    private function isDayEndProtectedRetailSale(PosSale $sale): bool
    {
        $customer = $sale->customer;
        if (! $customer instanceof Customer) {
            return false;
        }

        $text = $this->normalizeDayEndCustomerText(trim((string) $customer->code.' '.(string) $customer->name));
        if ($text === '') {
            return false;
        }

        foreach ([
            'BATUM PERAKENDE NAKIT SATIS',
            'BATUM PERAKENDE KREDI KARTI SATIS',
            'ERZURUM POINT NAKIT SATIS',
            'ERZURUM POINT KREDI KARTI SATIS',
            'TRABZON POINT PERAKENDE NAKIT SATIS',
            'TRABZON POINT PERAKENDE KREDI KARTI SATIS',
            'SAMSUN DEPO NAKIT SATIS',
            'SAMSUN DEPO KREDI KARTI SATIS',
        ] as $protectedCustomerName) {
            if (str_contains($text, $protectedCustomerName)) {
                return true;
            }
        }

        return false;
    }

    private function normalizeDayEndCustomerText(string $value): string
    {
        $normalized = mb_strtoupper(trim($value), 'UTF-8');

        return strtr($normalized, [
            'Ç' => 'C',
            'Ğ' => 'G',
            'İ' => 'I',
            'Ö' => 'O',
            'Ş' => 'S',
            'Ü' => 'U',
        ]);
    }

    private function pointCurrencyForSale(PosSale $sale, User $user): string
    {
        $sale->loadMissing('posSession.cashbox', 'posSession.openedBy');

        return $this->pointCurrency($sale->posSession, $user);
    }

    private function pointCurrency(?PosSession $session, User $user): string
    {
        $session?->loadMissing('cashbox', 'openedBy');

        $userBranchSignals = [
            $user->username,
            $user->branch_code,
            $user->branch_name,
            $user->region_code,
            $user->region_name,
            $session?->openedBy?->username,
            $session?->openedBy?->branch_code,
            $session?->openedBy?->branch_name,
            $session?->openedBy?->region_code,
            $session?->openedBy?->region_name,
        ];

        foreach ($userBranchSignals as $value) {
            if ($this->isTurkeyPointSignal($value)) {
                return self::POINT_CURRENCY;
            }
        }

        $batumSignals = [
            $user->branch_code,
            $user->branch_name,
            $user->region_code,
            $user->region_name,
            $session?->openedBy?->branch_code,
            $session?->openedBy?->branch_name,
            $session?->openedBy?->region_code,
            $session?->openedBy?->region_name,
            $session?->cashbox?->code,
            $session?->cashbox?->name,
        ];

        foreach ($batumSignals as $value) {
            if ($this->isBatumPointSignal($value)) {
                return self::BATUM_POINT_CURRENCY;
            }
        }

        return self::POINT_CURRENCY;
    }

    private function isTurkeyPointSignal(mixed $value): bool
    {
        $normalized = $this->normalizePointCurrencySignal($value);

        return str_contains($normalized, 'ERZURUM')
            || str_contains($normalized, 'TRABZON')
            || str_contains($normalized, 'SAMSUN');
    }

    private function isBatumPointSignal(mixed $value): bool
    {
        $normalized = $this->normalizePointCurrencySignal($value);
        $batumCashboxCode = $this->normalizePointCurrencySignal(config('integrations.pos.batum_point_cashbox_code'));

        return str_contains($normalized, 'BATUM')
            || ($batumCashboxCode !== '' && $normalized === $batumCashboxCode);
    }

    private function normalizePointCurrencySignal(mixed $value): string
    {
        return mb_strtoupper(trim((string) $value), 'UTF-8');
    }

    private function nullableString(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $value = trim((string) $value);

        return $value === '' ? null : $value;
    }

    private function restoreSaleStock(PosSale $sale): void
    {
        $stocks = StockSummary::query()
            ->whereIn('product_id', $sale->items->pluck('product_id')->unique()->values())
            ->lockForUpdate()
            ->get()
            ->keyBy('product_id');

        foreach ($sale->items as $item) {
            /** @var StockSummary|null $stock */
            $stock = $stocks->get($item->product_id);
            if (! $stock instanceof StockSummary) {
                throw ValidationException::withMessages([
                    'stock' => ["Stock summary row not found for product_id={$item->product_id}."],
                ]);
            }

            $stock->available_total = (int) $stock->available_total + (int) round((float) $item->qty);
            $stock->updated_at = now();
            $stock->save();
        }
    }

    /**
     * @param  array<int, array<string, mixed>>  $items
     * @return array<string, mixed>
     */
    private function calculateTotals(array $items, int $discountTotalCents, bool $applyVat = true): array
    {
        $subtotalCents = collect($items)->sum('line_total_cents');
        $discountTotalCents = max(0, min($discountTotalCents, $subtotalCents));

        $remainingDiscount = $discountTotalCents;
        $vatTotalCents = 0;

        foreach ($items as $index => &$item) {
            $isLast = $index === array_key_last($items);
            $lineTotalCents = (int) $item['line_total_cents'];

            if ($discountTotalCents === 0 || $subtotalCents === 0) {
                $lineDiscountCents = 0;
            } elseif ($isLast) {
                $lineDiscountCents = $remainingDiscount;
            } else {
                $lineDiscountCents = (int) floor(($lineTotalCents / $subtotalCents) * $discountTotalCents);
            }

            $remainingDiscount -= $lineDiscountCents;
            $taxBaseCents = max(0, $lineTotalCents - $lineDiscountCents);
            $effectiveVatRate = $applyVat ? (float) $item['vat_rate'] : 0.0;
            $lineVatCents = (int) round($taxBaseCents * ($effectiveVatRate / 100));

            $item['line_discount_cents'] = $lineDiscountCents;
            $item['line_vat_cents'] = $lineVatCents;
            $item['vat_rate'] = $effectiveVatRate;

            $vatTotalCents += $lineVatCents;
        }
        unset($item);

        $grandTotalCents = $subtotalCents - $discountTotalCents + $vatTotalCents;

        return [
            'items' => $items,
            'subtotal_cents' => $subtotalCents,
            'discount_total_cents' => $discountTotalCents,
            'vat_total_cents' => $vatTotalCents,
            'grand_total_cents' => $grandTotalCents,
        ];
    }

    private function assertCanOperateSession(User $user, PosSession $session): void
    {
        if ($user->hasRole('admin')) {
            return;
        }

        $sessionDealerId = $session->openedBy?->dealer_id;
        if ($sessionDealerId === null || (int) $sessionDealerId !== (int) $user->dealer_id) {
            throw ValidationException::withMessages([
                'pos_session_id' => ['Session is not accessible in your dealer scope.'],
            ]);
        }

        if ($this->usesUserScopedCashbox($user) && (int) $session->opened_by !== (int) $user->id) {
            throw ValidationException::withMessages([
                'pos_session_id' => ['Cashier can only operate own session.'],
            ]);
        }
    }

    private function assertCustomerBelongsToSessionScope(User $user, Customer $customer, PosSession $session): void
    {
        if ($user->hasRole('admin')) {
            return;
        }

        $sessionDealerId = $session->openedBy?->dealer_id;
        if ($sessionDealerId === null || (int) $customer->dealer_id !== (int) $sessionDealerId) {
            throw ValidationException::withMessages([
                'customer_id' => ['Customer does not belong to the session dealer scope.'],
            ]);
        }
    }

    private function usesUserScopedCashbox(User $user): bool
    {
        if ($user->hasRole('admin')) {
            return false;
        }

        $hasPosMenu = in_array('pos', MenuPermissions::forUser($user), true);
        $hasOwnLogoCashbox = $this->nullableString($user->logo_cashbox_code) !== null;

        if ($user->hasRole('dealer_admin')) {
            return $hasPosMenu && $hasOwnLogoCashbox;
        }

        return $user->hasAnyRole(['cashier', 'point']) || $hasPosMenu;
    }

    private function resolveReceiptNo(?string $receiptNo = null): string
    {
        if (is_string($receiptNo) && trim($receiptNo) !== '') {
            $value = trim($receiptNo);
            if (PosSale::query()->where('receipt_no', $value)->exists()) {
                throw ValidationException::withMessages([
                    'receipt_no' => ['receipt_no already exists.'],
                ]);
            }

            return $value;
        }

        do {
            $candidate = Str::upper('POS-'.now()->format('YmdHis').'-'.Str::random(5));
        } while (PosSale::query()->where('receipt_no', $candidate)->exists());

        return $candidate;
    }

    private function toCollectionMethod(string $paymentMethod): string
    {
        return $paymentMethod === 'card' ? 'cc' : $paymentMethod;
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

    private function shouldQueueSaleForLogoExport(PosSale $sale): bool
    {
        return in_array($sale->document_type, ['delivery', 'invoice'], true);
    }

    private function queueSaleForLogoExport(PosSale $sale): void
    {
        $existingLogoState = $this->latestPosSaleLogoState($sale);
        $existingExternalRef = $this->nullableString($existingLogoState?->external_ref);
        $isLogoDeliveryUpdate = $sale->document_type === 'delivery'
            && $existingLogoState instanceof IntegrationSyncState
            && $existingLogoState->status === 'synced'
            && $existingExternalRef !== null
            && str_starts_with($existingExternalRef, 'STFICHE-');

        $this->syncState->record(
            system: 'logo',
            domain: 'pos-sales',
            direction: 'outbound',
            entity: $sale,
            externalRef: $isLogoDeliveryUpdate ? $existingExternalRef : null,
            status: 'queued',
            error: null,
            meta: [
                'export_key' => 'B2B-POSSALE-'.$sale->id,
                'document_type' => $sale->document_type,
                'receipt_no' => $sale->receipt_no,
                'operation' => $isLogoDeliveryUpdate ? 'update' : 'create',
                'logo_external_ref' => $isLogoDeliveryUpdate ? $existingExternalRef : null,
            ],
            payload: [
                'pos_sale_id' => $sale->id,
                'receipt_no' => $sale->receipt_no,
                'document_type' => $sale->document_type,
                'operation' => $isLogoDeliveryUpdate ? 'update' : 'create',
                'logo_external_ref' => $isLogoDeliveryUpdate ? $existingExternalRef : null,
            ],
        );
    }

    private function queueSaleDeleteForLogoExport(PosSale $sale, string $logoExternalRef): void
    {
        $this->syncState->record(
            system: 'logo',
            domain: 'pos-sales',
            direction: 'outbound',
            entity: $sale,
            externalRef: $logoExternalRef,
            status: 'queued',
            error: null,
            meta: [
                'export_key' => 'B2B-POSSALE-'.$sale->id,
                'document_type' => $sale->document_type,
                'receipt_no' => $sale->receipt_no,
                'operation' => 'delete',
                'logo_external_ref' => $logoExternalRef,
            ],
            payload: [
                'pos_sale_id' => $sale->id,
                'receipt_no' => $sale->receipt_no,
                'document_type' => $sale->document_type,
                'operation' => 'delete',
                'logo_external_ref' => $logoExternalRef,
            ],
        );
    }

    private function latestPosSaleLogoState(PosSale $sale): ?IntegrationSyncState
    {
        return IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'pos-sales')
            ->where('direction', 'outbound')
            ->where('entity_type', PosSale::class)
            ->where('entity_id', (int) $sale->id)
            ->latest('id')
            ->first();
    }

    private function toCents(float $value): int
    {
        return (int) round($value * 100);
    }

    private function fromCents(int $value): string
    {
        return number_format($value / 100, 2, '.', '');
    }
}
