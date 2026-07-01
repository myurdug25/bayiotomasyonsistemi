<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('campaigns', function (Blueprint $table): void {
            $table->id();
            $table->string('source_reference', 128)->unique()->comment('Logo CAMPAIGN.LOGICALREF');
            $table->string('code', 64)->comment('Logo kampanya kodu');
            $table->string('name');
            $table->string('description')->nullable();
            // Cari grup filtresi: Logo CLCARD üzerindeki specode / tradinggrp değeri
            // Örn: F1, F2 ... F12 - birden fazla grup virgülle ayrılabilir
            $table->string('customer_group', 128)->nullable()->comment('F1, F2 gibi cari grup kodu');
            $table->unsignedInteger('target_quantity')->default(1)->comment('Kampanya koşulu: kaç adet');
            $table->unsignedInteger('discount_percent')->nullable()->comment('Kampanya indirimi (ör: 35)');
            $table->string('group_field', 32)->default('specode')->comment('Logo\'da hangi alan grup tutuyor: specode, specode2, tradinggrp');
            $table->date('starts_at')->nullable();
            $table->date('ends_at')->nullable();
            $table->boolean('is_active')->default(true);
            $table->json('meta')->nullable()->comment('Logo ham verisi');
            $table->timestamp('last_synced_at')->nullable();
            $table->timestamps();

            $table->index(['is_active', 'starts_at', 'ends_at']);
            $table->index('customer_group');
        });

        Schema::create('campaign_products', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('campaign_id')->constrained()->cascadeOnDelete();
            $table->foreignId('product_id')->nullable()->constrained()->nullOnDelete();
            $table->string('product_sku', 191)->comment('Logo ürün kodu - product_id bulunamazsa fallback');
            $table->json('meta')->nullable();
            $table->timestamps();

            $table->unique(['campaign_id', 'product_sku']);
            $table->index(['campaign_id', 'product_id']);
            $table->index('product_sku');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('campaign_products');
        Schema::dropIfExists('campaigns');
    }
};
