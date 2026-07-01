<?php

use App\Models\User;
use Illuminate\Support\Facades\Hash;

require '/var/www/powersab2b.com/backend/vendor/autoload.php';
$app = require_once '/var/www/powersab2b.com/backend/bootstrap/app.php';
$app->make('Illuminate\Contracts\Console\Kernel')->bootstrap();

$u = User::where('username', 'ahmet.arac')->first();
if ($u) {
    $u->password = Hash::make('Ahmet+25');
    $u->save();
    echo 'Password updated for '.$u->username."\n";
} else {
    echo "User not found.\n";
}
