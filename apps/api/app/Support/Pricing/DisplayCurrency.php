<?php

namespace App\Support\Pricing;

use App\Models\Customer;
use App\Models\User;

class DisplayCurrency
{
    private const TRY_PER_LARI = 17.0;

    public static function normalize(?string $currency, ?User $user = null, ?Customer $customer = null): string
    {
        $normalized = strtoupper(trim((string) ($currency ?: 'TRY')));

        if ($normalized === '') {
            return 'TRY';
        }

        if (self::usesLariPricing($user, $customer) && self::isTryLikeCurrency($normalized)) {
            return 'GEL';
        }

        if ($normalized === '160') {
            return 'TRY';
        }

        return match ($normalized) {
            'TL', 'TRL' => 'TRY',
            'LARI' => 'GEL',
            default => $normalized,
        };
    }

    public static function formatPrice(mixed $amount, ?string $currency, ?User $user = null, ?Customer $customer = null): ?string
    {
        if ($amount === null || $amount === '') {
            return null;
        }

        if (! is_numeric($amount)) {
            return null;
        }

        return number_format(self::convertPrice((float) $amount, $currency, $user, $customer), 2, '.', '');
    }

    public static function convertPrice(float $amount, ?string $currency, ?User $user = null, ?Customer $customer = null): float
    {
        if (! self::usesLariPricing($user, $customer)) {
            return $amount;
        }

        $normalized = strtoupper(trim((string) ($currency ?: 'TRY')));
        if (! self::isTryLikeCurrency($normalized)) {
            return $amount;
        }

        return $amount / self::TRY_PER_LARI;
    }

    public static function usesLariPricing(?User $user, ?Customer $customer = null): bool
    {
        if ($customer instanceof Customer && self::customerUsesLariPricing($customer)) {
            return true;
        }

        if (! $user instanceof User) {
            return false;
        }

        if (self::normalizeCode($user->username) === 'TURGAY.BUYUKKAL') {
            return false;
        }

        return self::normalizeCode($user->branch_code) === 'BATUM'
            || self::normalizeCode($user->region_code) === 'BATUM';
    }

    private static function customerUsesLariPricing(Customer $customer): bool
    {
        if (self::normalizeCode($customer->branch_code) === 'BATUM'
            || self::normalizeCode($customer->branch_name) === 'BATUM'
            || self::normalizeCode($customer->region_code) === 'BATUM'
            || self::normalizeCode($customer->region_name) === 'BATUM') {
            return true;
        }

        $segments = preg_split('/[^0-9]+/', trim((string) $customer->code)) ?: [];

        return ($segments[1] ?? null) === '00';
    }

    private static function isTryLikeCurrency(string $currency): bool
    {
        return in_array($currency, ['TRY', 'TL', 'TRL', '160'], true);
    }

    private static function normalizeCode(?string $value): ?string
    {
        $normalized = trim((string) $value);

        return $normalized !== '' ? mb_strtoupper($normalized, 'UTF-8') : null;
    }
}
