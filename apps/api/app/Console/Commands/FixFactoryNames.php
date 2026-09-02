<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

class FixFactoryNames extends Command
{
    protected $signature = 'fix:factory-names';
    protected $description = 'Fix factory POS names from the approved Cari POS account list';

    /**
     * @var array<string, string>
     */
    private array $approvedFactoryNames = [
        '120-61-006' => 'SIRAÇ MADENİ YAĞLAR PAZ. TİC. LTD. ŞTİ.',
        '320-54-002' => 'DİNAMİK OTOMOTİV GID.TEKS.İTH.İHR.SANAYİ VE TİC.LTD.ŞTİ',
        '320-34-006' => 'DELTA OTO AKSAMI SAN.TİC.A.Ş',
        '320-34-008' => 'ŞAMPİYON FİLTRE PAZ.TİC.VE SAN.A.Ş.',
        '320-34-010' => 'ŞAMPİYON FİLTRE PROTESTO HESABI',
        '320-34-026' => 'ATILGAN OTOMOTİV SANAYİ SERVİS HİZ.İÇ VE DIŞ TİC.A.Ş',
        '320-34-020' => 'ÖZAŞ OTOMOTİV SAN. VE TİC. LTD. ŞTİ.',
        '320-34-001' => 'WUNDER FİLTRE ANONİM ŞİRKETİ',
        '320-25-005' => 'YAĞSAN İNŞAAT MAĞDENİ YAĞLAR A.Ş.',
        '320-35-004' => 'GARANTİ FİLTRE SANAYİ VE TİCARET ANONİM ŞİRKETİ(FİLTRECİM)',
        '320-34-014' => 'BAYER OTOMOTİV SANAYİ VE TİCARET A.Ş',
    ];

    public function handle()
    {
        foreach ($this->approvedFactoryNames as $code => $name) {
            $updated = DB::table('finance_definitions')
                ->where('type', 'factory')
                ->where('code', $code)
                ->update([
                    'name' => $name,
                    'logo_name' => $name,
                    'logo_code' => $code,
                    'is_active' => true,
                    'updated_at' => now(),
                ]);

            if ($updated > 0) {
                $this->info("Updated {$code} to {$name}");

                continue;
            }

            DB::table('finance_definitions')->insert([
                'type' => 'factory',
                'code' => $code,
                'name' => $name,
                'logo_code' => $code,
                'logo_name' => $name,
                'sort_order' => (array_search($code, array_keys($this->approvedFactoryNames), true) + 1) * 10,
                'is_active' => true,
                'created_at' => now(),
                'updated_at' => now(),
            ]);

            $this->info("Created {$code} as {$name}");
        }

        DB::table('finance_definitions')
            ->where('type', 'factory')
            ->whereNotIn('code', array_keys($this->approvedFactoryNames))
            ->update([
                'is_active' => false,
                'updated_at' => now(),
            ]);

        return self::SUCCESS;
    }
}
