<?php

namespace App\Http\Resources;

use App\Support\Pricing\DisplayCurrency;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class LedgerEntryResource extends JsonResource
{
    /**
     * Transform the resource into an array.
     *
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        $date = $this->date ?? $this->entry_date;
        $type = $this->type ?? $this->entry_type;
        $debit = $this->debit ?? ($this->entry_type === 'debit' ? $this->amount : 0);
        $credit = $this->credit ?? ($this->entry_type === 'credit' ? $this->amount : 0);

        $currency = $this->displayCurrency((string) $this->currency, $request);
        $collectionMethod = $this->collectionMethod();
        $transactionType = $this->transactionType();
        $returnTypeLabel = $this->returnTypeLabel($transactionType);

        return [
            'id' => $this->id,
            'dealer_id' => $this->dealer_id,
            'customer_id' => $this->customer_id,
            'source_system' => $this->source_system,
            'source_reference' => $this->source_reference,
            'last_synced_at' => $this->last_synced_at,
            'date' => $date,
            'type' => $type,
            'debit' => number_format((float) $debit, 2, '.', ''),
            'credit' => number_format((float) $credit, 2, '.', ''),
            'balance_after' => number_format(
                (float) ($this->balance_after ?? ((float) $debit - (float) $credit)),
                2,
                '.',
                ''
            ),
            'description' => $this->description,
            'currency' => $currency,
            'reference_no' => $this->reference_no,
            'order_id' => $this->order_id,
            'collection_id' => $this->collection_id,
            'collection_method' => $collectionMethod,
            'collection_method_label' => $collectionMethod !== null
                ? $this->collectionMethodLabel($collectionMethod)
                : null,
            'transaction_type' => $transactionType,
            'transaction_type_label' => $returnTypeLabel ?? $this->transactionTypeLabel($transactionType),
            'document_no' => $this->reference_no,
            'document_date' => $date,
            'return_quantity' => $this->returnQuantity($transactionType),
            'return_total' => $this->returnTotal($transactionType),
            'return_type_label' => $returnTypeLabel,
            'source_document' => $this->sourceDocument(),
            'checkout_summary' => $this->checkoutSummary(),
            'sales_price_type' => $this->salesPriceType(),
            'sales_price_type_label' => $this->salesPriceTypeLabel($this->salesPriceType()),
            'shipping_method' => $this->shippingMethod(),
            'shipping_method_label' => $this->shippingMethodLabel($this->shippingMethod()),
            'entry_date' => $this->entry_date,
            'entry_type' => $this->entry_type,
            'amount' => $this->amount,
            'created_by_user_id' => $this->created_by_user_id,
            'created_at' => $this->created_at,
            'updated_at' => $this->updated_at,
        ];
    }

    private function transactionType(): string
    {
        if (data_get($this->meta, 'source') === 'return_request') {
            return 'return';
        }

        if (data_get($this->meta, 'source') === 'order_visibility') {
            return 'order';
        }

        $type = trim((string) ($this->type ?? $this->entry_type));

        if ($type === 'debit' && $this->looksLikeInvoice()) {
            return 'invoice';
        }

        return $type !== '' ? $type : 'debit';
    }

    private function transactionTypeLabel(string $type): string
    {
        return match ($type) {
            'order' => 'Sipariş',
            'invoice' => 'Fatura',
            'payment' => 'Tahsilat',
            'return' => 'İade',
            'credit' => 'İade / Alacak',
            'transfer' => 'Virman',
            'offset' => 'Mahsup',
            'opening' => 'Devir',
            default => 'Borç',
        };
    }

    private function returnTypeLabel(string $transactionType): ?string
    {
        if ($transactionType !== 'return') {
            return null;
        }

        $label = trim((string) data_get($this->meta, 'return_type_label'));

        return $label !== '' ? $label : 'İade';
    }

    private function returnQuantity(string $transactionType): ?int
    {
        if ($transactionType !== 'return') {
            return null;
        }

        $quantity = (int) data_get($this->meta, 'return_quantity', 0);

        return $quantity > 0 ? $quantity : null;
    }

    private function returnTotal(string $transactionType): ?string
    {
        if ($transactionType !== 'return') {
            return null;
        }

        $total = data_get($this->meta, 'return_total');

        if ($total !== null && trim((string) $total) !== '') {
            return number_format((float) $total, 2, '.', '');
        }

        $credit = $this->credit ?? ($this->entry_type === 'credit' ? $this->amount : null);

        return $credit !== null ? number_format((float) $credit, 2, '.', '') : null;
    }

    private function looksLikeInvoice(): bool
    {
        $referenceNo = trim((string) $this->reference_no);
        $description = trim((string) $this->description);

        return str_starts_with($referenceNo, 'F')
            || str_starts_with($description, 'SHP-')
            || data_get($this->meta, 'shipment_id') !== null;
    }

    private function sourceDocument(): ?string
    {
        foreach ([
            data_get($this->meta, 'order_no'),
            data_get($this->meta, 'shipment_no'),
            data_get($this->meta, 'integrations.logo.payload.raw.SOURCE_DOCUMENT'),
            data_get($this->meta, 'integrations.logo.payload.raw.DOCODE'),
        ] as $value) {
            $normalized = trim((string) $value);
            if ($normalized !== '') {
                return $normalized;
            }
        }

        return null;
    }

    private function collectionMethod(): ?string
    {
        if (($this->type ?? $this->entry_type) !== 'payment') {
            return null;
        }

        if (! $this->relationLoaded('collection')) {
            return null;
        }

        $collection = $this->collection;

        if ($collection === null) {
            return null;
        }

        $method = trim((string) $collection->method);
        if ($method === '') {
            return null;
        }

        $channel = trim((string) data_get($collection->reference_fields, 'collection_channel'));

        if ($method === 'cc' && $channel === 'factory') {
            return 'factory_cc';
        }

        if ($method === 'cc' && $channel === 'virtual_pos') {
            return 'virtual_pos';
        }

        return $method;
    }

    private function collectionMethodLabel(string $method): string
    {
        return match ($method) {
            'cash' => 'Nakit',
            'cc' => 'Fiziksel POS',
            'virtual_pos' => 'Sanal POS',
            'transfer' => 'Havale / EFT',
            'check' => 'Çek',
            'note' => 'Senet',
            'factory_cc' => 'Fabrika Kart Çekimi',
            default => str($method)->replace('_', ' ')->title()->toString(),
        };
    }

    private function displayCurrency(string $currency, Request $request): string
    {
        $normalized = strtoupper(trim($currency));
        $user = $request->user();

        if ($normalized === 'GEL' && ! DisplayCurrency::usesLariPricing($user)) {
            return 'TRY';
        }

        return DisplayCurrency::normalize($normalized, $user);
    }

    /**
     * @return array{mode: string, code: string, label: string}|null
     */
    private function checkoutSummary(): ?array
    {
        $summary = data_get($this->meta, 'checkout_summary')
            ?? data_get($this->meta, 'order.checkout_summary')
            ?? data_get($this->meta, 'integrations.logo.checkout_summary');

        if (! is_array($summary)) {
            $summary = $this->checkoutSummaryFromMode(
                data_get($this->meta, 'checkout_summary_mode')
                    ?? data_get($this->meta, 'order.checkout_summary_mode')
                    ?? data_get($this->meta, 'integrations.logo.checkout_summary_mode')
            );
        }

        if (! is_array($summary) && $this->relationLoaded('order') && $this->order !== null) {
            $summary = $this->checkoutSummaryFromOrder($this->order);
        }

        if (! is_array($summary)) {
            return null;
        }

        $mode = (string) ($summary['mode'] ?? '');
        $code = (string) ($summary['code'] ?? '');
        $label = (string) ($summary['label'] ?? '');

        if ($mode === '' || $code === '' || $label === '') {
            return null;
        }

        return [
            'mode' => $mode,
            'code' => $code,
            'label' => $label,
        ];
    }

    private function salesPriceType(): ?string
    {
        $value = data_get($this->meta, 'sales_price_type')
            ?? data_get($this->meta, 'order.sales_price_type')
            ?? data_get($this->meta, 'integrations.logo.sales_price_type');

        if ($value === null && $this->relationLoaded('order') && $this->order !== null) {
            $value = data_get($this->orderSyncMeta($this->order), 'sales_price_type');
        }

        if ($value === null) {
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

    private function shippingMethod(): ?string
    {
        $value = data_get($this->meta, 'shipping_method')
            ?? data_get($this->meta, 'order.shipping_method')
            ?? data_get($this->meta, 'integrations.logo.shipping_method');

        if ($value === null && $this->relationLoaded('order') && $this->order !== null) {
            $value = $this->order->cart?->shipping_method;
        }

        if (! is_scalar($value)) {
            return null;
        }

        $normalized = trim((string) $value);

        return $normalized !== '' ? $normalized : null;
    }

    private function shippingMethodLabel(?string $value): ?string
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

    /**
     * @return array{mode: string, code: string, label: string}|null
     */
    private function checkoutSummaryFromOrder(mixed $order): ?array
    {
        return $this->checkoutSummaryFromMode(data_get($this->orderSyncMeta($order), 'checkout_summary_mode'));
    }

    /**
     * @return array{mode: string, code: string, label: string}|null
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

    /**
     * @return array<string, mixed>
     */
    private function orderSyncMeta(mixed $order): array
    {
        if (! method_exists($order, 'getKey')) {
            return [];
        }

        $state = \App\Models\IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'orders')
            ->where('direction', 'outbound')
            ->where('entity_type', \App\Models\Order::class)
            ->where('entity_id', (int) $order->getKey())
            ->latest('id')
            ->first();

        return is_array($state?->meta) ? $state->meta : [];
    }
}
