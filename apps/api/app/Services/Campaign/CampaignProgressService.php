<?php

namespace App\Services\Campaign;

use App\Models\Campaign;
use App\Models\Customer;
use Illuminate\Support\Collection;

class CampaignProgressService
{
    /**
     * Müşterinin grubuna ait aktif kampanyaları döner.
     *
     * @return Collection<int, Campaign>
     */
    public function campaignsForCustomer(Customer $customer): Collection
    {
        $customerGroup = $this->resolveCustomerGroup($customer);

        return Campaign::with('campaignProducts')
            ->active()
            ->get()
            ->filter(fn (Campaign $c): bool => $c->matchesGroup($customerGroup))
            ->values();
    }

    /**
     * Verilen sepet içeriğine bakarak kampanya ilerlemelerini hesaplar.
     *
     * @param  Collection<int, Campaign>  $campaigns
     * @param  array<int, array{product_id: int, sku: string, quantity: int}>  $cartItems
     * @return list<array<string, mixed>>
     */
    public function calculate(Collection $campaigns, array $cartItems): array
    {
        // Sepetteki ürünleri SKU ve product_id ile indeksle
        $cartByProductId = [];
        $cartBySku       = [];

        foreach ($cartItems as $item) {
            $pid = (int) ($item['product_id'] ?? 0);
            $sku = (string) ($item['sku'] ?? '');
            $qty = max(0, (int) ($item['quantity'] ?? 0));

            if ($pid > 0) {
                $cartByProductId[$pid] = ($cartByProductId[$pid] ?? 0) + $qty;
            }

            if ($sku !== '') {
                $cartBySku[$sku] = ($cartBySku[$sku] ?? 0) + $qty;
            }
        }

        $result = [];

        foreach ($campaigns as $campaign) {
            $campaignProductSkus = $campaign->campaignProducts
                ->pluck('product_sku')
                ->all();

            $campaignProductIds = $campaign->campaignProducts
                ->whereNotNull('product_id')
                ->pluck('product_id')
                ->map(fn ($id): int => (int) $id)
                ->all();

            // Sepetteki kampanya ürünü adedini topla
            $cartQuantity = 0;

            foreach ($campaignProductIds as $pid) {
                $cartQuantity += $cartByProductId[$pid] ?? 0;
            }

            // product_id eşleşmeyenler için SKU fallback
            foreach ($campaignProductSkus as $sku) {
                if ($sku !== '' && ! in_array($sku, array_keys($cartBySku), true)) {
                    continue;
                }

                // Sadece product_id'siz olanları say (çift saymamak için)
                $cp = $campaign->campaignProducts->firstWhere('product_sku', $sku);
                if ($cp && $cp->product_id === null) {
                    $cartQuantity += $cartBySku[$sku] ?? 0;
                }
            }

            $targetQty   = max(1, (int) $campaign->target_quantity);
            $isCompleted = $cartQuantity >= $targetQty;
            $progressPct = min(100, (int) round(($cartQuantity / $targetQty) * 100));
            $remaining   = max(0, $targetQty - $cartQuantity);

            $result[] = [
                'campaign_id'       => $campaign->id,
                'code'              => $campaign->code,
                'name'              => $campaign->name,
                'description'       => $campaign->description,
                'target_quantity'   => $targetQty,
                'cart_quantity'     => $cartQuantity,
                'progress_pct'      => $progressPct,
                'is_completed'      => $isCompleted,
                'remaining'         => $remaining,
                'discount_percent'  => $campaign->discount_percent,
                'starts_at'         => $campaign->starts_at?->toDateString(),
                'ends_at'           => $campaign->ends_at?->toDateString(),
                'product_skus'      => $campaignProductSkus,
            ];
        }

        // Tamamlanmışları önce, sonra ilerleme yüzdesine göre sırala
        usort($result, fn ($a, $b): int =>
            $b['is_completed'] <=> $a['is_completed']
            ?: $b['progress_pct'] <=> $a['progress_pct']
        );

        return $result;
    }

    /**
     * Customer'ın Logo meta verisinden grup kodunu çeker.
     * Logo'da SPECODE, SPECODE2 veya TRADINGGRP alanlarından biri kullanılır.
     */
    private function resolveCustomerGroup(Customer $customer): ?string
    {
        $meta = is_array($customer->meta) ? $customer->meta : [];

        // Öncelik sırası: specode → trading_group → specode2
        return $this->nullable($meta['specode'] ?? null)
            ?? $this->nullable($meta['trading_group'] ?? null)
            ?? $this->nullable($meta['tradinggrp'] ?? null)
            ?? $this->nullable($meta['specode2'] ?? null)
            ?? null;
    }

    private function nullable(mixed $value): ?string
    {
        $s = trim((string) ($value ?? ''));
        return $s === '' ? null : $s;
    }
}
