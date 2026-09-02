<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('finance_definitions', function (Blueprint $table): void {
            $table->id();
            $table->string('type', 32);
            $table->string('code', 64);
            $table->string('name', 180);
            $table->string('logo_code', 64)->nullable();
            $table->string('logo_name', 180)->nullable();
            $table->json('meta')->nullable();
            $table->unsignedInteger('sort_order')->default(0);
            $table->boolean('is_active')->default(true);
            $table->timestamps();

            $table->unique(['type', 'code']);
            $table->index(['type', 'is_active', 'sort_order']);
        });

        Schema::create('finance_sequences', function (Blueprint $table): void {
            $table->string('key', 64)->primary();
            $table->unsignedBigInteger('next_value')->default(1);
            $table->timestamps();
        });

        $now = now();
        $rows = [
            ['type' => 'bank', 'code' => 'ziraat_bankasi', 'name' => 'Ziraat Bankası', 'logo_code' => '01', 'sort_order' => 10],
            ['type' => 'bank', 'code' => 'yapi_kredi', 'name' => 'Yapı Kredi', 'logo_code' => '02', 'sort_order' => 20],
            ['type' => 'bank', 'code' => 'georgia_bank', 'name' => 'Bank of Georgia', 'logo_code' => '03', 'sort_order' => 30],
            ['type' => 'bank', 'code' => 'tbc_bank', 'name' => 'TBC Bank', 'logo_code' => '04', 'sort_order' => 40],
            ['type' => 'factory', 'code' => '120-61-031', 'name' => 'SIRAÇ MADENİ YAĞLAR PAZ. TİC. LTD. ŞTİ.', 'logo_code' => '120-61-031', 'logo_name' => 'SIRAÇ MADENİ YAĞLAR PAZ. TİC. LTD. ŞTİ.', 'sort_order' => 10],
            ['type' => 'factory', 'code' => '320-54-002', 'name' => 'DİNAMİK OTOMOTİV GID.TEKS.İTH.İHR.SANAYİ VE TİC.LTD.ŞTİ', 'logo_code' => '320-54-002', 'logo_name' => 'DİNAMİK OTOMOTİV GID.TEKS.İTH.İHR.SANAYİ VE TİC.LTD.ŞTİ', 'sort_order' => 20],
            ['type' => 'factory', 'code' => '320-34-006', 'name' => 'DELTA OTO AKSAMI SAN.TİC.A.Ş', 'logo_code' => '320-34-006', 'logo_name' => 'DELTA OTO AKSAMI SAN.TİC.A.Ş', 'sort_order' => 30],
            ['type' => 'factory', 'code' => '320-34-008', 'name' => 'ŞAMPİYON FİLTRE PAZ.TİC.VE SAN.A.Ş.', 'logo_code' => '320-34-008', 'logo_name' => 'ŞAMPİYON FİLTRE PAZ.TİC.VE SAN.A.Ş.', 'sort_order' => 40],
            ['type' => 'factory', 'code' => '320-34-010', 'name' => 'ŞAMPİYON FİLTRE PROTESTO HESABI', 'logo_code' => '320-34-010', 'logo_name' => 'ŞAMPİYON FİLTRE PROTESTO HESABI', 'sort_order' => 50],
            ['type' => 'factory', 'code' => '320-34-026', 'name' => 'ATILGAN OTOMOTİV SANAYİ SERVİS HİZ.İÇ VE DIŞ TİC.A.Ş', 'logo_code' => '320-34-026', 'logo_name' => 'ATILGAN OTOMOTİV SANAYİ SERVİS HİZ.İÇ VE DIŞ TİC.A.Ş', 'sort_order' => 60],
            ['type' => 'factory', 'code' => '320-34-020', 'name' => 'ÖZAŞ OTOMOTİV SAN. VE TİC. LTD. ŞTİ.', 'logo_code' => '320-34-020', 'logo_name' => 'ÖZAŞ OTOMOTİV SAN. VE TİC. LTD. ŞTİ.', 'sort_order' => 70],
            ['type' => 'factory', 'code' => '320-34-001', 'name' => 'WUNDER FİLTRE ANONİM ŞİRKETİ', 'logo_code' => '320-34-001', 'logo_name' => 'WUNDER FİLTRE ANONİM ŞİRKETİ', 'sort_order' => 80],
            ['type' => 'factory', 'code' => '320-25-005', 'name' => 'YAĞSAN İNŞAAT MAĞDENİ YAĞLAR A.Ş.', 'logo_code' => '320-25-005', 'logo_name' => 'YAĞSAN İNŞAAT MAĞDENİ YAĞLAR A.Ş.', 'sort_order' => 90],
            ['type' => 'factory', 'code' => '320-35-004', 'name' => 'GARANTİ FİLTRE SANAYİ VE TİCARET ANONİM ŞİRKETİ(FİLTRECİM)', 'logo_code' => '320-35-004', 'logo_name' => 'GARANTİ FİLTRE SANAYİ VE TİCARET ANONİM ŞİRKETİ(FİLTRECİM)', 'sort_order' => 100],
            ['type' => 'factory', 'code' => '320-34-014', 'name' => 'BAYER OTOMOTİV SANAYİ VE TİCARET A.Ş', 'logo_code' => '320-34-014', 'logo_name' => 'BAYER OTOMOTİV SANAYİ VE TİCARET A.Ş', 'sort_order' => 110],
            ['type' => 'expense_category', 'code' => 'vehicle_maintenance', 'name' => 'Araç Bakım', 'logo_code' => '760.25.025', 'logo_name' => '34LV0224 FORD CUSTOM BAKIM-YIKAMA-SERVİS', 'sort_order' => 10],
            ['type' => 'expense_category', 'code' => 'marketing', 'name' => 'Pazarlama', 'logo_code' => '760.25.033', 'logo_name' => 'PAZARLAMA YOL GİDERLERİ KARS-ARDAHAN', 'sort_order' => 20],
            ['type' => 'expense_category', 'code' => 'fuel', 'name' => 'Yakıt', 'logo_code' => '760.25.027', 'logo_name' => '34LV0224 FORD CUSTOM YAKIT GİDERİ', 'sort_order' => 30],
        ];

        DB::table('finance_definitions')->insert(array_map(
            fn (array $row): array => array_merge([
                'logo_code' => null,
                'logo_name' => null,
                'meta' => null,
                'is_active' => true,
            ], $row, [
                'created_at' => $now,
                'updated_at' => $now,
            ]),
            $rows
        ));

        DB::table('finance_sequences')->insert([
            'key' => 'physical_pos',
            'next_value' => 1,
            'created_at' => $now,
            'updated_at' => $now,
        ]);
    }

    public function down(): void
    {
        Schema::dropIfExists('finance_sequences');
        Schema::dropIfExists('finance_definitions');
    }
};