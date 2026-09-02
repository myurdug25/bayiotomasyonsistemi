<?php

namespace App\Support\Cart;

final class CheckoutNoteCleaner
{
    private const AUTOMATIC_NOTE_MARKERS = [
        'Ödeme tercihi:',
        'Satış tipi:',
        'Ekranda gösterilen ödeme tutarı:',
        'Özet gösterimi:',
    ];

    public static function clean(mixed $value): ?string
    {
        if (! is_scalar($value)) {
            return null;
        }

        $lines = preg_split('/\R/u', (string) $value) ?: [];
        $keptLines = array_filter($lines, function (string $line): bool {
            foreach (self::AUTOMATIC_NOTE_MARKERS as $marker) {
                if (str_contains($line, $marker)) {
                    return false;
                }
            }

            return true;
        });

        $cleaned = trim(implode(PHP_EOL, $keptLines));

        return $cleaned === '' ? null : $cleaned;
    }
}
