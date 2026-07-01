<?php

use Illuminate\Database\Migrations\Migration;

return new class extends Migration
{
    public function up(): void
    {
        // Compatibility marker: finance_sequences is owned by the 020000 migration.
    }

    public function down(): void
    {
        // Intentionally does not drop a table owned by another migration.
    }
};
