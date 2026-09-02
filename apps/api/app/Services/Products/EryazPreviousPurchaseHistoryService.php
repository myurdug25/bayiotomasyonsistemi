<?php

namespace App\Services\Products;

use App\Models\ProductPreviousPurchase;
use Illuminate\Support\Facades\Cache;

class EryazPreviousPurchaseHistoryService
{
    /**
     * @return array{summary: array<string, mixed>, items: list<array<string, mixed>>}
     */
    public function fetch(string $customerCode, string $productCode, int $limit = 50): array
    {
        $customerCode = trim($customerCode);
        $productCode = trim($productCode);
        $limit = max(1, min(100, $limit));

        if ($customerCode === '' || $productCode === '') {
            return $this->emptyResult();
        }

        $cacheKey = self::cacheKey($customerCode, $productCode, $limit);
        $ttl = max(60, (int) config('integrations.eryaz.previous_purchases_cache_seconds', 300));

        return Cache::remember($cacheKey, now()->addSeconds($ttl), function () use ($customerCode, $productCode, $limit): array {
            $normalizedProductCode = $this->normalizeProductCode($productCode);

            $items = ProductPreviousPurchase::query()
                ->where('customer_code', $customerCode)
                ->where(function ($query) use ($productCode, $normalizedProductCode): void {
                    $query->where('product_code', $productCode)
                        ->orWhereRaw("REPLACE(UPPER(product_code), ' ', '') = ?", [$normalizedProductCode])
                        ->orWhereRaw("REPLACE(UPPER(product_code), ' ', '') LIKE ?", ['%-'.$normalizedProductCode]);
                })
                ->orderByDesc('purchase_date')
                ->orderByDesc('document_no')
                ->limit($limit)
                ->get()
                ->map(fn (ProductPreviousPurchase $purchase): array => [
                    'date' => $purchase->purchase_date?->toDateString(),
                    'description' => $purchase->description,
                    'document_no' => $purchase->document_no,
                    'quantity' => $this->numeric($purchase->quantity),
                    'unit' => $purchase->unit ?: 'AD',
                    'unit_price' => $this->numeric($purchase->unit_price),
                    'net_price' => $this->numeric($purchase->net_price),
                    'discounts' => array_values((array) ($purchase->discounts ?? [])),
                    'gross_total' => $this->numeric($purchase->gross_total),
                    'net_total' => $this->numeric($purchase->net_total),
                ])
                ->values()
                ->all();

            return [
                'summary' => $this->summary($items),
                'items' => $items,
            ];
        });
    }

    public static function cacheKey(string $customerCode, string $productCode, int $limit = 50): string
    {
        return 'eryaz:previous-purchases:'.md5(mb_strtoupper(trim($customerCode)).'|'.mb_strtoupper(trim($productCode)).'|'.max(1, min(100, $limit)));
    }

    /**
     * @return array{summary: array<string, mixed>, items: list<array<string, mixed>>}
     */
    private function emptyResult(): array
    {
        return [
            'summary' => [
                'purchase_count' => 0,
                'total_quantity' => 0.0,
                'total_net_amount' => 0.0,
                'last_purchase_date' => null,
                'last_quantity' => null,
                'last_net_price' => null,
                'last_unit' => null,
            ],
            'items' => [],
        ];
    }

    private function numeric(mixed $value): float
    {
        if (is_numeric($value)) {
            return round((float) $value, 4);
        }

        $normalized = str_replace(',', '.', trim((string) ($value ?? '')));

        return is_numeric($normalized) ? round((float) $normalized, 4) : 0.0;
    }

    private function normalizeProductCode(string $value): string
    {
        return mb_strtoupper(str_replace(' ', '', trim($value)));
    }

    /**
     * @param  list<array<string, mixed>>  $items
     * @return array<string, mixed>
     */
    private function summary(array $items): array
    {
        $first = $items[0] ?? null;

        return [
            'purchase_count' => count($items),
            'total_quantity' => round((float) collect($items)->sum('quantity'), 4),
            'total_net_amount' => round((float) collect($items)->sum('net_total'), 4),
            'last_purchase_date' => $first['date'] ?? null,
            'last_quantity' => $first['quantity'] ?? null,
            'last_net_price' => $first['net_price'] ?? null,
            'last_unit' => $first['unit'] ?? null,
        ];
    }
}
