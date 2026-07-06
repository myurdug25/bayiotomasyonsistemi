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
            'specode',
            'trading_group',
            'tradinggrp',
            'specode2',
            'integrations.logo.payload.specode',
            'integrations.logo.payload.trading_group',
            'integrations.logo.payload.tradinggrp',
            'integrations.logo.payload.specode2',
            'integrations.logo.payload.raw.SPECODE',
            'integrations.logo.payload.raw.TRADINGGRP',
            'integrations.logo.payload.raw.SPECODE2',
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

        return array_values($groups);
    }
}
