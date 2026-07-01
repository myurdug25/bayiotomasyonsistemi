<?php

use App\Models\User;

require '/var/www/powersab2b.com/backend/vendor/autoload.php';
$app = require_once '/var/www/powersab2b.com/backend/bootstrap/app.php';
$app->make('Illuminate\Contracts\Console\Kernel')->bootstrap();

$u = User::where('username', 'ahmet.arac')->first();
if ($u) {
    echo 'User found: '.$u->username."\n";
    echo 'Active: '.$u->is_active."\n";
    echo "Credential verification intentionally disabled in repository diagnostics.\n";
} else {
    echo "User not found.\n";
}
