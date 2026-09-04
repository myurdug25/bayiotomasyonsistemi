<?php

namespace App\Services\Campaign;

use App\Models\Customer;

class CustomerCampaignGroupResolver
{
    public function resolve(Customer $customer): ?string
    {
        return $this->resolveAll($customer)[0] ?? null;
    }

    /**
     * @return list<string>
     */
    public function resolveAll(Customer $customer): array
    {
        $meta = is_array($customer->meta) ? $customer->meta : [];
        $paths = [
            'price_group',
            'price_list_code',
            'specode',
            'specode2',
            'specode3',
            'specode4',
            'specode5',
            'trading_group',
            'tradinggrp',
            'integrations.logo.payload.price_group',
            'integrations.logo.payload.price_list_code',
            'integrations.logo.payload.specode',
            'integrations.logo.payload.specode2',
            'integrations.logo.payload.specode3',
            'integrations.logo.payload.specode4',
            'integrations.logo.payload.specode5',
            'integrations.logo.payload.trading_group',
            'integrations.logo.payload.tradinggrp',
            'integrations.logo.payload.raw.SPECODE',
            'integrations.logo.payload.raw.SPECODE2',
            'integrations.logo.payload.raw.SPECODE3',
            'integrations.logo.payload.raw.SPECODE4',
            'integrations.logo.payload.raw.SPECODE5',
            'integrations.logo.payload.raw.TRADINGGRP',
        ];
        $groups = [];

        foreach ($paths as $path) {
            $value = trim((string) data_get($meta, $path, ''));
            if ($value === '') {
                continue;
            }

            foreach (preg_split('/[,;|]+/', $value) ?: [] as $group) {
                $normalized = mb_strtoupper(trim($group), 'UTF-8');
                if ($normalized !== '') {
                    $groups[$normalized] = $normalized;
                }
            }
        }

        if ($this->isBatumCustomer($customer)) {
            $groups['BATUM'] = 'BATUM';
            $groups['F12'] = 'F12';
        }

        return array_values($groups);
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
