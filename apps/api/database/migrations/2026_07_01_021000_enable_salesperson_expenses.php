<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('pos_expenses', function (Blueprint $table): void {
            $table->unsignedBigInteger('pos_session_id')->nullable()->change();
        });

        Schema::table('users', function (Blueprint $table): void {
            $table->string('logo_expense_account_code', 64)->nullable()->after('logo_cashbox_name');
            $table->string('logo_expense_account_name', 180)->nullable()->after('logo_expense_account_code');
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->dropColumn(['logo_expense_account_code', 'logo_expense_account_name']);
        });

        Schema::table('pos_expenses', function (Blueprint $table): void {
            $table->unsignedBigInteger('pos_session_id')->nullable(false)->change();
        });
    }
};
