<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('product_campaign_prices', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('product_id')->constrained()->cascadeOnDelete();
            $table->string('source_reference', 128);
            $table->string('campaign_key', 191);
            $table->string('name');
            $table->string('condition')->nullable();
            $table->unsignedInteger('min_quantity')->default(1);
            $table->decimal('unit_price', 15, 4);
            $table->char('currency', 3)->default('TRY');
            $table->integer('priority')->default(0);
            $table->integer('branch')->nullable();
            $table->date('starts_at')->nullable();
            $table->date('ends_at')->nullable();
            $table->boolean('is_active')->default(true);
            $table->json('meta')->nullable();
            $table->timestamps();

            $table->unique(['product_id', 'source_reference']);
            $table->index(['product_id', 'campaign_key', 'is_active']);
            $table->index(['starts_at', 'ends_at']);
        });

        Schema::table('cart_items', function (Blueprint $table): void {
            $table->string('campaign_key', 191)->nullable()->after('currency');
        });

        Schema::table('order_items', function (Blueprint $table): void {
            $table->string('campaign_key', 191)->nullable()->after('currency');
        });
    }

    public function down(): void
    {
        Schema::table('order_items', function (Blueprint $table): void {
            $table->dropColumn('campaign_key');
        });

        Schema::table('cart_items', function (Blueprint $table): void {
            $table->dropColumn('campaign_key');
        });

        Schema::dropIfExists('product_campaign_prices');
    }
};
