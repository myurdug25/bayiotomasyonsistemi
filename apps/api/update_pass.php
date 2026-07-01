<?php

use App\Models\User;

require '/var/www/powersab2b.com/backend/vendor/autoload.php';
$app = require_once '/var/www/powersab2b.com/backend/bootstrap/app.php';
$app->make('Illuminate\Contracts\Console\Kernel')->bootstrap();

$u = User::where('username', 'ahmet.arac')->first();
echo $u ? "User exists; password mutation is disabled in repository diagnostics.\n" : "User not found.\n";
