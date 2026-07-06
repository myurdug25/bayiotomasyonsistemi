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
            'transaction_type_label' => $this->transactionTypeLabel($transactionType),
            'document_no' => $this->reference_no,
            'document_date' => $date,
            'source_document' => $this->sourceDocument(),
            'checkout_summary' => $this->checkoutSummary(),
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
        $type = trim((string) ($this->type ?? $this->entry_type));

        if ($type === 'debit' && $this->looksLikeInvoice()) {
            return 'invoice';
        }

        return $type !== '' ? $type : 'debit';
    }

    private function transactionTypeLabel(string $type): string
    {
        return match ($type) {
            'invoice' => 'Fatura',
            'payment' => 'Tahsilat',
            'credit' => 'İade / Alacak',
            'transfer' => 'Virman',
            'offset' => 'Mahsup',
            'opening' => 'Devir',
            default => 'Borç',
        };
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
        $summary = data_get($this->meta, 'checkout_summary');

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
}
