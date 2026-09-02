<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('product_previous_purchases', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('dealer_id')->nullable()->constrained('dealers')->nullOnDelete();
            $table->foreignId('customer_id')->nullable()->constrained('customers')->nullOnDelete();
            $table->foreignId('product_id')->nullable()->constrained('products')->nullOnDelete();
            $table->string('customer_code', 64);
            $table->string('product_code', 64);
            $table->string('source_database', 64)->nullable();
            $table->string('external_ref', 191);
            $table->date('purchase_date')->nullable();
            $table->string('document_no', 64)->nullable();
            $table->string('description', 255)->nullable();
            $table->decimal('quantity', 19, 4)->default(0);
            $table->string('unit', 16)->nullable();
            $table->decimal('unit_price', 19, 4)->default(0);
            $table->decimal('net_price', 19, 4)->default(0);
            $table->json('discounts')->nullable();
            $table->decimal('gross_total', 19, 4)->default(0);
            $table->decimal('net_total', 19, 4)->default(0);
            $table->timestamp('synced_at')->nullable();
            $table->timestamps();

            $table->unique('external_ref', 'product_previous_purchases_external_ref_unique');
            $table->index(['customer_code', 'product_code', 'purchase_date'], 'product_previous_purchases_lookup_index');
            $table->index(['customer_id', 'product_id', 'purchase_date'], 'product_previous_purchases_models_index');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('product_previous_purchases');
    }
};
