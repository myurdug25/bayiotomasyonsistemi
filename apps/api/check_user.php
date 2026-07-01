<?php

use App\Models\User;
use Illuminate\Support\Facades\Hash;

require '/var/www/powersab2b.com/backend/vendor/autoload.php';
$app = require_once '/var/www/powersab2b.com/backend/bootstrap/app.php';
$app->make('Illuminate\Contracts\Console\Kernel')->bootstrap();

$u = User::where('username', 'ahmet.arac')->first();
if ($u) {
    echo 'User found: '.$u->username."\n";
    echo 'Active: '.$u->is_active."\n";
    if (Hash::check('Ahmet+25', $u->password)) {
        echo "Password matches!\n";
    } else {
        echo "Password does NOT match.\n";
    }
} else {
    echo "User not found.\n";
}
