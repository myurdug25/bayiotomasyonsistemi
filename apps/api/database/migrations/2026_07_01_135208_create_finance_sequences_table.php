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
        Schema::create('finance_sequences', function (Blueprint $table): void {
            $table->string('key', 64)->primary();
            $table->unsignedBigInteger('next_value')->default(1);
            $table->timestamps();
        });

        $now = now();
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
    }
};
