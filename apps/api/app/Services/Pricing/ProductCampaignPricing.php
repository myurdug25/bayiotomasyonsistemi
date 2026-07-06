<?php

namespace App\Services\Pricing;

use App\Models\CampaignProduct;
use App\Models\Customer;
use App\Models\ProductCampaignPrice;
use App\Models\User;
use App\Services\Campaign\CustomerCampaignGroupResolver;
use App\Support\Pricing\DisplayCurrency;
use Illuminate\Support\Collection;

class ProductCampaignPricing
{
    public function __construct(
        private readonly CustomerCampaignGroupResolver $groupResolver
    ) {}

    /**
     * @param  list<int>  $productIds
     * @return Collection<int, list<array<string, mixed>>>
     */
    public function forProducts(array $productIds, User $user, ?int $selectedCustomerId = null): Collection
    {
        if ($productIds === []) {
            return collect();
        }

        $customer = $selectedCustomerId ? Customer::find($selectedCustomerId) : null;
        $customerGroups = $customer instanceof Customer ? $this->groupResolver->resolveAll($customer) : [];

        $existing = $selectedCustomerId === null
            ? $this->activeQuery()
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
                    ->all())
            : collect();

        $newCampaignProducts = CampaignProduct::with('campaign')
            ->whereIn('product_id', $productIds)
            ->whereHas('campaign', function ($query) {
                $query->active();
            })
            ->get()
            ->filter(function ($cp) use ($customerGroups) {
                return $cp->campaign && $cp->campaign->matchesAnyGroup($customerGroups);
            })
            ->groupBy('product_id');

        $newCampaignProducts->each(function (Collection $campaignProducts, $productId) use (&$existing) {
            // Group by campaign code in case a product is in multiple campaigns
            $formattedCampaigns = $campaignProducts
                ->groupBy(fn ($cp) => $cp->campaign->code)
                ->map(function (Collection $cps) {
                    $campaign = $cps->first()->campaign;

                    return [
                        'key' => $campaign->code,
                        'name' => $campaign->name,
                        'tiers' => [
                            [
                                'min_quantity' => $campaign->target_quantity ?: 1,
                                'unit_price' => null,
                                'currency' => 'TRY',
                                'discount_percent' => $campaign->discount_percent,
                            ],
                        ],
                    ];
                })
                ->values()
                ->all();

            $existingForProduct = $existing->get($productId, []);
            $existing->put($productId, array_merge($existingForProduct, $formattedCampaigns));
        });

        return $existing;
    }

    /**
     * @return array{campaign_key:string,name:string,unit_price:string,currency:string,tier:ProductCampaignPrice}|null
     */
    public function resolve(
        int $productId,
        string $campaignKey,
        int $quantity,
        User $user,
        ?int $customerId = null
    ): ?array {
        $tier = $this->activeQuery()
            ->where('product_id', $productId)
            ->where('campaign_key', $campaignKey)
            ->where('min_quantity', '<=', max(1, $quantity))
            ->orderByDesc('min_quantity')
            ->orderByDesc('priority')
            ->first();

        if ($tier instanceof ProductCampaignPrice) {
            $price = DisplayCurrency::formatPrice($tier->unit_price, $tier->currency, $user);

            return [
                'campaign_key' => $tier->campaign_key,
                'name' => $tier->name,
                'unit_price' => $price ?? number_format((float) $tier->unit_price, 2, '.', ''),
                'currency' => DisplayCurrency::normalize($tier->currency, $user),
                'discount_percent' => null,
                'tier' => $tier,
            ];
        }

        $customer = $customerId ? Customer::find($customerId) : null;
        if (! $customer instanceof Customer) {
            return null;
        }

        $campaignProduct = CampaignProduct::query()
            ->with('campaign')
            ->where('product_id', $productId)
            ->whereHas('campaign', fn ($query) => $query
                ->active()
                ->where('code', $campaignKey))
            ->first();
        $campaign = $campaignProduct?->campaign;

        if (
            ! $campaign
            || ! $campaign->matchesAnyGroup($this->groupResolver->resolveAll($customer))
            || $quantity < max(1, (int) $campaign->target_quantity)
        ) {
            return null;
        }

        return [
            'campaign_key' => $campaign->code,
            'name' => $campaign->name,
            'unit_price' => null,
            'currency' => null,
            'discount_percent' => (float) ($campaign->discount_percent ?? 0),
            'tier' => $campaign,
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
