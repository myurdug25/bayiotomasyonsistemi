<?php

namespace Database\Seeders;

use Illuminate\Database\Console\Seeds\WithoutModelEvents;
use Illuminate\Database\Seeder;

use App\Models\User;
use Illuminate\Support\Facades\Hash;

class CustomPasswordsSeeder extends Seeder
{
    /**
     * Run the database seeds.
     */
    public function run(): void
    {
        $passwords = [
            'satinalma' => 'satinalma',
            'erz.depo' => 'erzurum25',
            'satis' => 'satis+25',
            'mudur.erzurum' => '224148müdür',
            'erzurum.hizlisatis' => '250250',
            'ahmet.arac' => 'Ahmet+25',
            'huseyin.ozguney' => 'Huseyin+25',
            'mehmet.aksoy' => 'Mehmet+25',
            'erzurum.merkez' => 'Erzurum+25',
            'muhasebe' => 'Erzurum+25',
        ];

        foreach ($passwords as $username => $password) {
            $user = User::where('username', $username)->first();
            if ($user) {
                $user->password = Hash::make($password);
                $user->save();
            } else {
                User::create([
                    'name' => mb_convert_case($username, MB_CASE_TITLE, 'UTF-8'),
                    'username' => $username,
                    'password' => Hash::make($password),
                    'is_active' => true,
                    'customer_scope' => 'dealer',
                    'menu_permissions' => ['dashboard', 'orders', 'products'],
                ]);
            }
        }
    }
}
