<?php

namespace App\Services\Pricing;

use App\Models\ProductCampaignPrice;
use App\Models\User;
use App\Support\Pricing\DisplayCurrency;
use Illuminate\Support\Collection;

class ProductCampaignPricing
{
    /**
     * @param  list<int>  $productIds
     * @return Collection<int, list<array<string, mixed>>>
     */
    public function forProducts(array $productIds, User $user): Collection
    {
        if ($productIds === []) {
            return collect();
        }

        return $this->activeQuery()
            ->whereIn('product_id', $productIds)
            ->orderBy('campaign_key')
            ->orderBy('min_quantity')
            ->orderByDesc('priority')
            ->get()
            ->groupBy('product_id')
            ->map(fn (Collection $prices): array => $prices
                ->groupBy('campaign_key')
                ->map(fn (Collection $tiers): array => $this->campaignPayload($tiers, $user))
                ->values()
                ->all());
    }

    /**
     * @return array{campaign_key:string,name:string,unit_price:string,currency:string,tier:ProductCampaignPrice}|null
     */
    public function resolve(int $productId, string $campaignKey, int $quantity, User $user): ?array
    {
        $tier = $this->activeQuery()
            ->where('product_id', $productId)
            ->where('campaign_key', $campaignKey)
            ->where('min_quantity', '<=', max(1, $quantity))
            ->orderByDesc('min_quantity')
            ->orderByDesc('priority')
            ->first();

        if (! $tier instanceof ProductCampaignPrice) {
            return null;
        }

        $price = DisplayCurrency::formatPrice($tier->unit_price, $tier->currency, $user);

        return [
            'campaign_key' => $tier->campaign_key,
            'name' => $tier->name,
            'unit_price' => $price ?? number_format((float) $tier->unit_price, 2, '.', ''),
            'currency' => DisplayCurrency::normalize($tier->currency, $user),
            'tier' => $tier,
        ];
    }

    private function activeQuery()
    {
        return ProductCampaignPrice::query()
            ->where('is_active', true)
            ->where(fn ($query) => $query->whereNull('starts_at')->orWhereDate('starts_at', '<=', today()))
            ->where(fn ($query) => $query->whereNull('ends_at')->orWhereDate('ends_at', '>=', today()));
    }

    /**
     * @param  Collection<int, ProductCampaignPrice>  $tiers
     * @return array<string, mixed>
     */
    private function campaignPayload(Collection $tiers, User $user): array
    {
        /** @var ProductCampaignPrice $first */
        $first = $tiers->first();

        return [
            'key' => $first->campaign_key,
            'name' => $first->name,
            'tiers' => $tiers
                ->unique(fn (ProductCampaignPrice $tier): string => $tier->min_quantity.'|'.$tier->unit_price.'|'.$tier->currency)
                ->map(fn (ProductCampaignPrice $tier): array => [
                    'min_quantity' => $tier->min_quantity,
                    'unit_price' => DisplayCurrency::formatPrice($tier->unit_price, $tier->currency, $user)
                        ?? number_format((float) $tier->unit_price, 2, '.', ''),
                    'currency' => DisplayCurrency::normalize($tier->currency, $user),
                    'condition' => $tier->condition,
                    'starts_at' => $tier->starts_at?->toDateString(),
                    'ends_at' => $tier->ends_at?->toDateString(),
                ])
                ->values()
                ->all(),
        ];
    }
}
