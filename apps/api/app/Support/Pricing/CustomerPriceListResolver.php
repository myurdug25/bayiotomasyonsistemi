<?php

namespace App\Support\Pricing;

use App\Models\Customer;
use App\Models\PriceList;
use Illuminate\Support\Facades\Cache;

class CustomerPriceListResolver
{
    private const CACHE_TTL_SECONDS = 120;

    public function resolve(?int $customerId, ?int $fallbackPriceListId): ?int
    {
        if ($customerId === null) {
            return $fallbackPriceListId;
        }

        $priceListId = Cache::remember(
            "pricing:customer-price-list:v1:{$customerId}",
            now()->addSeconds(self::CACHE_TTL_SECONDS),
            function () use ($customerId): ?int {
                $customer = Customer::query()
                    ->select(['id', 'meta'])
                    ->find($customerId);

                if (! $customer instanceof Customer) {
                    return null;
                }

                if ($this->isBatumCustomer($customer)) {
                    return $this->priceListIdByCode('F12');
                }

                $groupCode = $this->resolveGroupCode(is_array($customer->meta) ? $customer->meta : []);
                if ($groupCode === null) {
                    return null;
                }

                return $this->priceListIdByCode($groupCode);
            }
        );

        return $priceListId ?? $fallbackPriceListId;
    }

    /**
     * Logo customer cards may carry the F group in different special-code
     * fields depending on the firm setup. Exact F-number values qualify so
     * newly opened groups such as F13 do not require a deploy.
     *
     * @param  array<string, mixed>  $meta
     */
    public function resolveGroupCode(array $meta): ?string
    {
        foreach ([
            'price_group',
            'price_list_code',
            'specode',
            'specode2',
            'specode3',
            'specode4',
            'specode5',
            'trading_group',
            'integrations.logo.payload.price_group',
            'integrations.logo.payload.price_list_code',
            'integrations.logo.payload.specode',
            'integrations.logo.payload.specode2',
            'integrations.logo.payload.specode3',
            'integrations.logo.payload.specode4',
            'integrations.logo.payload.specode5',
            'integrations.logo.payload.trading_group',
            'integrations.logo.payload.raw.SPECODE',
            'integrations.logo.payload.raw.SPECODE2',
            'integrations.logo.payload.raw.SPECODE3',
            'integrations.logo.payload.raw.SPECODE4',
            'integrations.logo.payload.raw.SPECODE5',
            'integrations.logo.payload.raw.TRADINGGRP',
        ] as $path) {
            $candidate = mb_strtoupper(trim((string) data_get($meta, $path, '')), 'UTF-8');
            if (preg_match('/^F[1-9][0-9]*$/', $candidate) === 1) {
                return $candidate;
            }
        }

        return null;
    }

    private function priceListIdByCode(string $code): ?int
    {
        $id = PriceList::query()
            ->whereRaw('UPPER(code) = ?', [mb_strtoupper($code, 'UTF-8')])
            ->where('is_active', true)
            ->value('id');

        return $id !== null ? (int) $id : null;
    }

    private function isBatumCustomer(Customer $customer): bool
    {
        $codeSegments = preg_split('/[^0-9]+/', trim((string) $customer->code), -1, PREG_SPLIT_NO_EMPTY) ?: [];
        if (($codeSegments[1] ?? null) === '00') {
            return true;
        }

        foreach (['branch_code', 'branch_name', 'region_code', 'region_name'] as $field) {
            $value = mb_strtoupper(trim((string) $customer->{$field}), 'UTF-8');
            if ($value !== '' && str_contains($value, 'BATUM')) {
                return true;
            }
        }

        return false;
    }
}
