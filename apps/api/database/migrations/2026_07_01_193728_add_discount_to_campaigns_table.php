<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        if (! Schema::hasTable('campaigns') || Schema::hasColumn('campaigns', 'discount_percent')) {
            return;
        }

        Schema::table('campaigns', function (Blueprint $table) {
            $table->unsignedTinyInteger('discount_percent')->nullable()->after('target_quantity')->comment('Kampanyanın sağlayacağı indirim yüzdesi');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        if (! Schema::hasTable('campaigns') || ! Schema::hasColumn('campaigns', 'discount_percent')) {
            return;
        }

        Schema::table('campaigns', function (Blueprint $table) {
            $table->dropColumn('discount_percent');
        });
    }
};
