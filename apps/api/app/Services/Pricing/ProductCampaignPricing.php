<?php

namespace App\Services\Pricing;

use App\Models\CampaignProduct;
use App\Models\Customer;
use App\Models\Product;
use App\Models\ProductCampaignPrice;
use App\Models\User;
use App\Services\Campaign\CampaignWindowSelector;
use App\Services\Campaign\CustomerCampaignGroupResolver;
use App\Support\Pricing\DisplayCurrency;
use App\Support\Products\ProductCodeNormalizer;
use App\Support\Warehouse\WarehouseBranchResolver;
use Illuminate\Support\Collection;
use Illuminate\Support\Str;

class ProductCampaignPricing
{
    public function __construct(
        private readonly CustomerCampaignGroupResolver $groupResolver,
        private readonly CampaignWindowSelector $windowSelector,
        private readonly WarehouseBranchResolver $branchResolver
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

        // Logo campaign price tiers are product campaigns, not customer-specific
        // campaign assignments. Selecting a customer must not make those tiers
        // disappear; customer-group campaigns are merged below after scope checks.
        $applicableLogoPriceTiers = $this->activeQuery()
            ->whereIn('product_id', $productIds)
            ->orderBy('campaign_key')
            ->orderBy('min_quantity')
            ->orderByDesc('priority')
            ->get()
            ->filter(fn (ProductCampaignPrice $price): bool => $this->tierMatchesCustomerGroups(
                $price,
                $customerGroups,
                $customer instanceof Customer
            ) && $this->tierMatchesCustomerBranch(
                $price,
                $user,
                $customer
            ));
        $existing = $applicableLogoPriceTiers
            ->groupBy('product_id')
            ->map(fn (Collection $prices): array => $this->windowSelector->select($prices)
                ->groupBy('campaign_key')
                ->map(fn (Collection $tiers): array => $this->campaignPayload($tiers, $user, $customer))
                ->values()
                ->all());

        $campaignProductLookup = $this->campaignProductLookup($productIds);
        $newCampaignProducts = CampaignProduct::with('campaign')
            ->where(function ($query) use ($productIds, $campaignProductLookup): void {
                $query->whereIn('product_id', $productIds);

                if ($campaignProductLookup['raw_codes'] !== []) {
                    $query->orWhereIn('product_sku', $campaignProductLookup['raw_codes']);
                }
            })
            ->whereHas('campaign', function ($query) {
                $query->active();
            })
            ->get()
            ->filter(function ($cp) use ($customerGroups) {
                return $cp->campaign && $cp->campaign->matchesAnyGroup($customerGroups);
            });

        $this->groupCampaignProductsByProduct($newCampaignProducts, $campaignProductLookup)
            ->each(function (Collection $campaignProducts, $productId) use (&$existing) {
                $selectedCampaigns = $this->windowSelector->select(
                    $campaignProducts->pluck('campaign')->unique('id')->values()
                );
                $selectedCampaignIds = $selectedCampaigns->pluck('id')->all();

                // Group by campaign code in case a product is in multiple campaigns
                $formattedCampaigns = $campaignProducts
                    ->filter(fn ($cp): bool => in_array($cp->campaign_id, $selectedCampaignIds, true))
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
        $tiers = $this->activeQuery()
            ->where('product_id', $productId)
            ->get();
        $customer = $customerId ? Customer::find($customerId) : null;
        $customerGroups = $customer instanceof Customer ? $this->groupResolver->resolveAll($customer) : [];
        $applicableTiers = $this->windowSelector->select($tiers)
            ->filter(fn (ProductCampaignPrice $price): bool => $this->tierMatchesCustomerGroups(
                $price,
                $customerGroups,
                $customer instanceof Customer
            ) && $this->tierMatchesCustomerBranch(
                $price,
                $user,
                $customer
            ));
        $tier = $applicableTiers
            ->where('campaign_key', $campaignKey)
            ->where('min_quantity', '<=', max(1, $quantity))
            ->sortByDesc(fn (ProductCampaignPrice $price): string => sprintf('%010d|%010d', $price->min_quantity, $price->priority))
            ->first();

        if ($tier instanceof ProductCampaignPrice) {
            $price = DisplayCurrency::formatPrice($tier->unit_price, $tier->currency, $user, $customer);

            return [
                'campaign_key' => $tier->campaign_key,
                'name' => $tier->name,
                'unit_price' => $price ?? number_format((float) $tier->unit_price, 2, '.', ''),
                'currency' => DisplayCurrency::normalize($tier->currency, $user, $customer),
                'discount_percent' => null,
                'tier' => $tier,
            ];
        }

        if (! $customer instanceof Customer) {
            return null;
        }

        $campaignProductLookup = $this->campaignProductLookup([$productId]);
        $campaignProducts = CampaignProduct::query()
            ->with('campaign')
            ->where(function ($query) use ($productId, $campaignProductLookup): void {
                $query->where('product_id', $productId);

                if ($campaignProductLookup['raw_codes'] !== []) {
                    $query->orWhereIn('product_sku', $campaignProductLookup['raw_codes']);
                }
            })
            ->whereHas('campaign', fn ($query) => $query->active())
            ->get()
            ->filter(fn (CampaignProduct $cp): bool => $this->campaignProductMatchesProduct($cp, $productId, $campaignProductLookup)
                && $cp->campaign
                && $cp->campaign->matchesAnyGroup($this->groupResolver->resolveAll($customer)));
        $selectedCampaignIds = $this->windowSelector
            ->select($campaignProducts->pluck('campaign')->unique('id')->values())
            ->pluck('id')
            ->all();
        $campaignProduct = $campaignProducts
            ->first(fn (CampaignProduct $cp): bool => $cp->campaign->code === $campaignKey
                && in_array($cp->campaign_id, $selectedCampaignIds, true));
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
            ->where('is_active', true);
    }

    /**
     * @param  Collection<int, ProductCampaignPrice>  $tiers
     * @return array<int, true>
     */
    private function logoPrclistProductIds(Collection $tiers): array
    {
        return $tiers
            ->filter(fn (ProductCampaignPrice $tier): bool => data_get($tier->meta, 'source') === 'logo_prclist')
            ->pluck('product_id')
            ->mapWithKeys(fn (int $productId): array => [$productId => true])
            ->all();
    }

    /**
     * @param  Collection<int, ProductCampaignPrice>  $tiers
     */
    private function hasLogoPrclistTier(Collection $tiers, int $productId): bool
    {
        return $tiers->contains(
            fn (ProductCampaignPrice $tier): bool => (int) $tier->product_id === $productId
                && data_get($tier->meta, 'source') === 'logo_prclist'
        );
    }

    /**
     * @param  Collection<int, ProductCampaignPrice>  $tiers
     * @return array<string, mixed>
     */
    private function campaignPayload(Collection $tiers, User $user, ?Customer $customer): array
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
                    'unit_price' => DisplayCurrency::formatPrice($tier->unit_price, $tier->currency, $user, $customer)
                        ?? number_format((float) $tier->unit_price, 2, '.', ''),
                    'currency' => DisplayCurrency::normalize($tier->currency, $user, $customer),
                    'condition' => $tier->condition,
                    'starts_at' => $tier->starts_at?->toDateString(),
                    'ends_at' => $tier->ends_at?->toDateString(),
                ])
                ->values()
                ->all(),
        ];
    }

    /**
     * @param  list<string>  $customerGroups
     */
    private function tierMatchesCustomerGroups(
        ProductCampaignPrice $tier,
        array $customerGroups,
        bool $hasSelectedCustomer
    ): bool {
        $priceGroups = collect([
            'price_group',
            'logo_price_group',
            'price_list_code',
            'customer_group',
            'group_code',
        ])
            ->map(fn (string $path): ?string => $this->normalizeTierPriceGroup(data_get($tier->meta, $path)))
            ->filter()
            ->unique()
            ->values();

        if ($priceGroups->isEmpty()) {
            return true;
        }

        if (! $hasSelectedCustomer) {
            return true;
        }

        return $priceGroups->intersect($customerGroups)->isNotEmpty();
    }

    private function tierMatchesCustomerBranch(ProductCampaignPrice $tier, User $user, ?Customer $customer): bool
    {
        $tierBranch = $this->resolveTierBranch($tier);

        if ($tierBranch === null) {
            return true;
        }

        if (! $customer instanceof Customer) {
            return true;
        }

        $customerBranch = $this->normalizeBranchCode($this->branchResolver->resolveBranchCode($user, $customer));

        return $customerBranch !== null && $tierBranch === $customerBranch;
    }

    private function resolveTierBranch(ProductCampaignPrice $tier): ?string
    {
        $priceGroup = $this->normalizeTierPriceGroup(data_get($tier->meta, 'price_group'));
        if ($priceGroup === 'BATUM') {
            return 'BATUM';
        }

        foreach ([
            'workplace_name',
            'office_name',
            'division_name',
            'warehouse_name',
            'branch_name',
        ] as $path) {
            $branch = $this->normalizeBranchCode(data_get($tier->meta, $path));
            if ($branch !== null) {
                return $branch;
            }
        }

        foreach ([
            'workplace_code',
            'office_code',
            'division_code',
        ] as $path) {
            $branch = $this->normalizeLogoWorkplaceCode(data_get($tier->meta, $path));
            if ($branch !== null) {
                return $branch;
            }
        }

        if (data_get($tier->meta, 'source') === 'logo_prclist') {
            foreach ([
                'branch_code',
                'warehouse_code',
                'invenno',
            ] as $path) {
                $branch = $this->normalizeLogoPrclistWorkplaceCode(data_get($tier->meta, $path));
                if ($branch !== null) {
                    return $branch;
                }
            }

            $branch = $this->normalizeLogoPrclistWorkplaceCode($tier->branch);
            if ($branch !== null) {
                return $branch;
            }
        }

        foreach ([
            'branch_code',
            'warehouse_code',
            'invenno',
        ] as $path) {
            $branch = $this->normalizeBranchCode(data_get($tier->meta, $path));
            if ($branch !== null) {
                return $branch;
            }
        }

        return $this->normalizeBranchCode($tier->branch);
    }

    private function normalizeLogoPrclistWorkplaceCode(mixed $value): ?string
    {
        $raw = Str::upper(Str::ascii(trim((string) $value)));

        if ($raw === '' || in_array($raw, ['-1', '0', '000', 'HEPSI', 'ALL', 'GENEL'], true)) {
            return null;
        }

        $normalized = preg_replace('/[^A-Z0-9]+/', '', $raw) ?? '';

        if (in_array($normalized, ['1', '001'], true)) {
            return 'TRABZON';
        }

        if (in_array($normalized, ['2', '002'], true)) {
            return 'SAMSUN';
        }

        if (in_array($normalized, ['3', '003'], true)) {
            return 'ERZURUM';
        }

        if (in_array($normalized, ['4', '004'], true)) {
            return 'BATUM';
        }

        return $this->normalizeBranchCode($value);
    }

    private function normalizeLogoWorkplaceCode(mixed $value): ?string
    {
        $raw = Str::upper(Str::ascii(trim((string) $value)));

        if ($raw === '' || in_array($raw, ['-1', '0', '000', 'HEPSI', 'ALL', 'GENEL'], true)) {
            return null;
        }

        $normalized = preg_replace('/[^A-Z0-9]+/', '', $raw) ?? '';

        if (in_array($normalized, ['1', '001'], true)) {
            return 'TRABZON';
        }

        if (in_array($normalized, ['2', '002'], true)) {
            return 'SAMSUN';
        }

        if (in_array($normalized, ['3', '003'], true)) {
            return 'ERZURUM';
        }

        if (in_array($normalized, ['4', '004'], true)) {
            return 'BATUM';
        }

        return $this->normalizeBranchCode($value);
    }

    private function normalizeBranchCode(mixed $value): ?string
    {
        $raw = Str::upper(Str::ascii(trim((string) $value)));

        if ($raw === '' || in_array($raw, ['-1', '0', 'HEPSI', 'ALL', 'GENEL'], true)) {
            return null;
        }

        $normalized = preg_replace('/[^A-Z0-9]+/', '', $raw) ?? '';

        if (in_array($normalized, ['2', '61', 'RAF61', 'TRABZON', 'TRABZONDEPO', 'TRABZONPOINT'], true) || str_contains($normalized, 'TRABZON')) {
            return 'TRABZON';
        }

        if (in_array($normalized, ['3', '55', 'RAF55', 'SAMSUN', 'SAMSUNDEPO', 'SAMSUNPOINT'], true) || str_contains($normalized, 'SAMSUN')) {
            return 'SAMSUN';
        }

        if (in_array($normalized, ['4', '995', 'RAF995', 'BATUM', 'BATUMDEPO', 'BATUMPOINT'], true) || str_contains($normalized, 'BATUM')) {
            return 'BATUM';
        }

        if (in_array($normalized, ['1', '25', '250', 'RAF25', 'RAF250', 'ERZURUM', 'ERZURUMDEPO', 'ERZURUMPOINT'], true) || str_contains($normalized, 'ERZURUM') || str_starts_with($normalized, 'ERZ')) {
            return 'ERZURUM';
        }

        return null;
    }

    private function normalizeTierPriceGroup(mixed $value): ?string
    {
        $normalized = mb_strtoupper(trim((string) $value), 'UTF-8');

        return $normalized === '' ? null : $normalized;
    }

    /**
     * @param  list<int>  $productIds
     * @return array{raw_codes:list<string>, product_ids_by_normalized_code:array<string, list<int>>, normalized_codes_by_product_id:array<int, string>}
     */
    private function campaignProductLookup(array $productIds): array
    {
        $rawCodes = [];
        $productIdsByNormalizedCode = [];
        $normalizedCodesByProductId = [];

        $remember = static function (int $productId, mixed $code) use (&$rawCodes, &$productIdsByNormalizedCode, &$normalizedCodesByProductId): void {
            $raw = trim((string) $code);
            if ($raw === '') {
                return;
            }

            $rawCodes[$raw] = $raw;
            $normalized = ProductCodeNormalizer::normalize($raw);
            if ($normalized === null) {
                return;
            }

            $rawCodes[$normalized] = $normalized;
            $productIdsByNormalizedCode[$normalized] ??= [];
            $productIdsByNormalizedCode[$normalized][$productId] = $productId;
            $normalizedCodesByProductId[$productId] = $normalized;
        };

        Product::query()
            ->whereIn('id', $productIds)
            ->get(['id', 'sku'])
            ->each(fn (Product $product) => $remember((int) $product->id, $product->sku));

        return [
            'raw_codes' => array_values($rawCodes),
            'product_ids_by_normalized_code' => array_map(
                static fn (array $ids): array => array_values($ids),
                $productIdsByNormalizedCode
            ),
            'normalized_codes_by_product_id' => $normalizedCodesByProductId,
        ];
    }

    /**
     * @param  Collection<int, CampaignProduct>  $campaignProducts
     * @param  array{product_ids_by_normalized_code:array<string, list<int>>, normalized_codes_by_product_id:array<int, string>}  $lookup
     * @return Collection<int, Collection<int, CampaignProduct>>
     */
    private function groupCampaignProductsByProduct(Collection $campaignProducts, array $lookup): Collection
    {
        $grouped = collect();

        foreach ($campaignProducts as $campaignProduct) {
            foreach ($this->matchingProductIds($campaignProduct, $lookup) as $productId) {
                $items = $grouped->get($productId, collect());
                $items->push($campaignProduct);
                $grouped->put($productId, $items);
            }
        }

        return $grouped;
    }

    /**
     * @param  array{product_ids_by_normalized_code:array<string, list<int>>, normalized_codes_by_product_id:array<int, string>}  $lookup
     * @return list<int>
     */
    private function matchingProductIds(CampaignProduct $campaignProduct, array $lookup): array
    {
        $productIds = [];
        $normalizedSku = ProductCodeNormalizer::normalize($campaignProduct->product_sku);

        if ($campaignProduct->product_id !== null) {
            $productId = (int) $campaignProduct->product_id;
            if (($lookup['normalized_codes_by_product_id'][$productId] ?? null) === $normalizedSku) {
                $productIds[$productId] = $productId;
            }
        }

        foreach ($lookup['product_ids_by_normalized_code'][$normalizedSku] ?? [] as $productId) {
            $productIds[(int) $productId] = (int) $productId;
        }

        return array_values($productIds);
    }

    /**
     * @param  array{product_ids_by_normalized_code:array<string, list<int>>, normalized_codes_by_product_id:array<int, string>}  $lookup
     */
    private function campaignProductMatchesProduct(CampaignProduct $campaignProduct, int $productId, array $lookup): bool
    {
        return in_array($productId, $this->matchingProductIds($campaignProduct, $lookup), true);
    }
}
