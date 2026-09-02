<?php

namespace Tests\Unit;

use App\Support\Cart\CheckoutNoteCleaner;
use Tests\TestCase;

class CheckoutNoteCleanerTest extends TestCase
{
    public function test_it_removes_automatic_checkout_summary_lines(): void
    {
        $note = implode(PHP_EOL, [
            'Müşteri özel notu',
            'Ödeme tercihi: Cari Hesap · Satış tipi: 1 - F · Ekranda gösterilen ödeme tutarı: 58.838,40 TL',
            'Ödeme tercihi: Cari Hesap · Satış tipi: 1 - F · Ekranda gösterilen ödeme tutarı: 58.838,40 TL',
        ]);

        $this->assertSame('Müşteri özel notu', CheckoutNoteCleaner::clean($note));
    }

    public function test_it_returns_null_when_only_automatic_checkout_summary_remains(): void
    {
        $this->assertNull(CheckoutNoteCleaner::clean(
            'Ödeme tercihi: Cari Hesap · Satış tipi: 1 - F · Ekranda gösterilen ödeme tutarı: 58.838,40 TL'
        ));
    }
}
