<?php

namespace App\Support;

use App\Models\Dealer;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Support\Facades\Crypt;

class VirtualPosSettings
{
    /**
     * @return array<string, mixed>
     */
    public static function publicConfig(?Dealer $dealer): array
    {
        $settings = self::rawConfig($dealer);

        return [
            'enabled' => (bool) ($settings['enabled'] ?? false),
            'mode' => self::mode($settings['mode'] ?? 'test'),
            'gateway_url' => (string) ($settings['gateway_url'] ?? ''),
            'merchant_no' => (string) ($settings['merchant_no'] ?? ''),
            'username' => (string) ($settings['username'] ?? ''),
            'has_security_code' => self::hasEncryptedValue($settings['security_code_encrypted'] ?? null),
            'has_password' => self::hasEncryptedValue($settings['password_encrypted'] ?? null),
        ];
    }

    /**
     * @param  array<string, mixed>  $existing
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    public static function merge(array $existing, array $payload): array
    {
        $next = [
            'enabled' => (bool) ($payload['enabled'] ?? ($existing['enabled'] ?? false)),
            'mode' => self::mode($payload['mode'] ?? ($existing['mode'] ?? 'test')),
            'gateway_url' => self::stringValue($payload['gateway_url'] ?? ($existing['gateway_url'] ?? '')),
            'merchant_no' => self::stringValue($payload['merchant_no'] ?? ($existing['merchant_no'] ?? '')),
            'username' => self::stringValue($payload['username'] ?? ($existing['username'] ?? '')),
            'security_code_encrypted' => $existing['security_code_encrypted'] ?? null,
            'password_encrypted' => $existing['password_encrypted'] ?? null,
        ];

        if (array_key_exists('security_code', $payload) && self::stringValue($payload['security_code']) !== '') {
            $next['security_code_encrypted'] = Crypt::encryptString(self::stringValue($payload['security_code']));
        }

        if (array_key_exists('password', $payload) && self::stringValue($payload['password']) !== '') {
            $next['password_encrypted'] = Crypt::encryptString(self::stringValue($payload['password']));
        }

        return $next;
    }

    public static function isReady(?Dealer $dealer): bool
    {
        $settings = self::publicConfig($dealer);

        return (bool) $settings['enabled']
            && $settings['gateway_url'] !== ''
            && $settings['merchant_no'] !== ''
            && $settings['username'] !== ''
            && (bool) $settings['has_security_code']
            && (bool) $settings['has_password'];
    }

    /**
     * @return array<string, mixed>
     */
    public static function privateConfig(?Dealer $dealer): array
    {
        $settings = self::rawConfig($dealer);
        $public = self::publicConfig($dealer);

        return [
            ...$public,
            'security_code' => trim(self::decryptValue($settings['security_code_encrypted'] ?? null)),
            'password' => trim(self::decryptValue($settings['password_encrypted'] ?? null)),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public static function rawConfig(?Dealer $dealer): array
    {
        $settings = data_get($dealer?->meta, 'system_settings.virtual_pos', []);

        return is_array($settings) ? $settings : [];
    }

    public static function hasEncryptedValue(mixed $value): bool
    {
        if (! is_string($value) || trim($value) === '') {
            return false;
        }

        try {
            return Crypt::decryptString($value) !== '';
        } catch (DecryptException) {
            return false;
        }
    }

    private static function decryptValue(mixed $value): string
    {
        if (! is_string($value) || trim($value) === '') {
            return '';
        }

        try {
            return Crypt::decryptString($value);
        } catch (DecryptException) {
            return '';
        }
    }

    private static function mode(mixed $value): string
    {
        return $value === 'live' ? 'live' : 'test';
    }

    private static function stringValue(mixed $value): string
    {
        return trim((string) $value);
    }
}
