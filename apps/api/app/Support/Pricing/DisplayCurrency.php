<?php

namespace App\Support\Pricing;

use App\Models\Customer;
use App\Models\Dealer;
use App\Models\User;

class DisplayCurrency
{
    private const DEFAULT_TRY_PER_LARI = 17.0;
    private const DEFAULT_TRY_TO_LARI_MULTIPLIER = 0.056;

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

        return $amount * self::tryToLariMultiplier($user, $customer);
    }

    public static function tryPerLari(?User $user = null, ?Customer $customer = null): float
    {
        return self::rateFromCustomer($customer)
            ?? self::rateFromUser($user)
            ?? self::parseRate(config('integrations.pricing.batum_try_per_lari'))
            ?? self::DEFAULT_TRY_PER_LARI;
    }

    public static function tryToLariMultiplier(?User $user = null, ?Customer $customer = null): float
    {
        $multiplier = self::multiplierFromCustomer($customer)
            ?? self::multiplierFromUser($user);

        if ($multiplier !== null) {
            return $multiplier;
        }

        $rate = self::rateFromCustomer($customer)
            ?? self::rateFromUser($user);

        if ($rate !== null) {
            return 1 / $rate;
        }

        return self::parseRate(config('integrations.pricing.batum_try_to_lari_multiplier'))
            ?? self::DEFAULT_TRY_TO_LARI_MULTIPLIER;
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

    private static function rateFromCustomer(?Customer $customer): ?float
    {
        if (! $customer instanceof Customer) {
            return null;
        }

        return self::rateFromDealer(
            $customer->relationLoaded('dealer')
                ? $customer->dealer
                : ($customer->dealer_id ? Dealer::query()->find($customer->dealer_id) : null)
        );
    }

    private static function multiplierFromCustomer(?Customer $customer): ?float
    {
        if (! $customer instanceof Customer) {
            return null;
        }

        return self::multiplierFromDealer(
            $customer->relationLoaded('dealer')
                ? $customer->dealer
                : ($customer->dealer_id ? Dealer::query()->find($customer->dealer_id) : null)
        );
    }

    private static function rateFromUser(?User $user): ?float
    {
        if (! $user instanceof User) {
            return null;
        }

        return self::rateFromDealer(
            $user->relationLoaded('dealer')
                ? $user->dealer
                : ($user->dealer_id ? Dealer::query()->find($user->dealer_id) : null)
        );
    }

    private static function multiplierFromUser(?User $user): ?float
    {
        if (! $user instanceof User) {
            return null;
        }

        return self::multiplierFromDealer(
            $user->relationLoaded('dealer')
                ? $user->dealer
                : ($user->dealer_id ? Dealer::query()->find($user->dealer_id) : null)
        );
    }

    private static function rateFromDealer(?Dealer $dealer): ?float
    {
        if (! $dealer instanceof Dealer) {
            return null;
        }

        $meta = is_array($dealer->meta) ? $dealer->meta : [];

        return self::parseRate(data_get($meta, 'system_settings.batum_exchange_rate'));
    }

    private static function multiplierFromDealer(?Dealer $dealer): ?float
    {
        if (! $dealer instanceof Dealer) {
            return null;
        }

        $meta = is_array($dealer->meta) ? $dealer->meta : [];

        return self::parseRate(data_get($meta, 'system_settings.batum_exchange_multiplier'));
    }

    private static function parseRate(mixed $value): ?float
    {
        $normalized = str_replace(',', '.', trim((string) $value));

        if ($normalized === '' || ! is_numeric($normalized)) {
            return null;
        }

        $rate = (float) $normalized;

        return $rate > 0 ? $rate : null;
    }

    private static function normalizeCode(?string $value): ?string
    {
        $normalized = trim((string) $value);

        return $normalized !== '' ? mb_strtoupper($normalized, 'UTF-8') : null;
    }
}
