import { NodeSSH } from 'node-ssh';
import fs from 'fs';

const scriptContent = `<?php

use App\\Models\\User;
use App\\Models\\Dealer;
use App\\Models\\Role;
use Illuminate\\Support\\Facades\\Hash;

$usersData = [
    ['name' => 'Muhasebe', 'username' => 'muhasebe', 'dealer_code' => 'DLR-001', 'customer_scope' => 'dealer', 'region' => null, 'branch' => null, 'role' => 'admin'],
    ['name' => 'Müşteri Demo', 'username' => 'musteri.demo', 'dealer_code' => 'DLR-001', 'customer_scope' => 'dealer', 'region' => null, 'branch' => null, 'role' => 'customer'],
    ['name' => 'Kasiyer', 'username' => 'kasiyer', 'dealer_code' => 'DLR-001', 'customer_scope' => 'dealer', 'region' => null, 'branch' => null, 'role' => 'cashier'],
    ['name' => 'Hızlı Satış', 'username' => 'hizli.satis', 'dealer_code' => 'DLR-001', 'customer_scope' => 'dealer', 'region' => null, 'branch' => null, 'role' => 'point'],
    ['name' => 'ERZURUM DEPO', 'username' => 'erz.depo', 'dealer_code' => 'DLR-001', 'customer_scope' => 'dealer', 'region' => 'ERZURUM', 'branch' => 'ERZURUM', 'role' => 'warehouse'],
    ['name' => 'Depo Kullanıcısı', 'username' => 'depo', 'dealer_code' => 'DLR-001', 'customer_scope' => 'dealer', 'region' => null, 'branch' => null, 'role' => 'warehouse'],
    ['name' => 'Bayi Yöneticisi', 'username' => 'bayi.admin', 'dealer_code' => 'DLR-001', 'customer_scope' => 'dealer', 'region' => null, 'branch' => null, 'role' => 'dealer_admin'],
    ['name' => 'Ornek Musteri', 'username' => 'ornek.musteri', 'dealer_code' => 'DLR-001', 'customer_scope' => 'dealer', 'region' => null, 'branch' => null, 'role' => 'customer'],
    ['name' => 'TUGAY BÜYÜKKAL', 'username' => 'tugay.buyukkal', 'dealer_code' => 'DLR-001', 'customer_scope' => 'assigned', 'region' => 'BATUM', 'branch' => 'BATUM', 'role' => 'salesperson'],
    ['name' => 'MEHMET ATACAN', 'username' => 'mehmet.atacan', 'dealer_code' => 'DLR-001', 'customer_scope' => 'assigned', 'region' => 'BATUM', 'branch' => 'BATUM', 'role' => 'salesperson'],
    ['name' => 'BATUM B2B VE HIZLI SATIŞ', 'username' => 'batum', 'dealer_code' => 'DLR-001', 'customer_scope' => 'branch', 'region' => 'BATUM', 'branch' => 'BATUM', 'role' => 'point'],
    ['name' => 'SAMSUN POINT HIZLI SATIŞ', 'username' => 'samsun.point', 'dealer_code' => 'DLR-001', 'customer_scope' => 'branch', 'region' => 'SAMSUN', 'branch' => 'SAMSUN', 'role' => 'point'],
    ['name' => 'TRABZON POINT HIZLI SATIŞ', 'username' => 'trabzon.point', 'dealer_code' => 'DLR-001', 'customer_scope' => 'branch', 'region' => 'TRABZON', 'branch' => 'TRABZON', 'role' => 'point'],
    ['name' => 'ERZURUM HIZLI SATIŞ', 'username' => 'erzurum.hizlisatis', 'dealer_code' => 'DLR-001', 'customer_scope' => 'dealer', 'region' => 'ERZURUM', 'branch' => 'ERZURUM', 'role' => 'point'],
    ['name' => 'ERZURUM POINT HIZLI SATIŞ', 'username' => 'erzurum.point', 'dealer_code' => 'DLR-001', 'customer_scope' => 'branch', 'region' => 'ERZURUM', 'branch' => 'ERZURUM', 'role' => 'point'],
    ['name' => 'SAMSUN MERKEZ', 'username' => 'samsun.merkez', 'dealer_code' => 'DLR-001', 'customer_scope' => 'assigned', 'region' => 'SAMSUN', 'branch' => 'SAMSUN', 'role' => 'salesperson'],
    ['name' => 'ADEM CANBAKIŞ', 'username' => 'adem.canbakis', 'dealer_code' => 'DLR-001', 'customer_scope' => 'assigned', 'region' => 'SAMSUN', 'branch' => 'SAMSUN', 'role' => 'salesperson'],
    ['name' => 'SAMET GÖRPÜZ', 'username' => 'samet.gorpuz', 'dealer_code' => 'DLR-001', 'customer_scope' => 'assigned', 'region' => 'SAMSUN', 'branch' => 'SAMSUN', 'role' => 'salesperson'],
    ['name' => 'TRABZON MERKEZ', 'username' => 'trabzon.merkez', 'dealer_code' => 'DLR-001', 'customer_scope' => 'assigned', 'region' => 'TRABZON', 'branch' => 'TRABZON', 'role' => 'salesperson'],
    ['name' => 'AHMET CANTÜFEKCİ', 'username' => 'ahmet.cantufekci', 'dealer_code' => 'DLR-001', 'customer_scope' => 'assigned', 'region' => 'TRABZON', 'branch' => 'TRABZON', 'role' => 'salesperson'],
    ['name' => 'EMRE KALAYCI', 'username' => 'emre.kalayci', 'dealer_code' => 'DLR-001', 'customer_scope' => 'assigned', 'region' => 'TRABZON', 'branch' => 'TRABZON', 'role' => 'salesperson'],
    ['name' => 'SATIŞ', 'username' => 'satis', 'dealer_code' => 'DLR-001', 'customer_scope' => 'branch', 'region' => 'ERZURUM', 'branch' => 'ERZURUM', 'role' => 'salesperson'],
    ['name' => 'SATINALMA', 'username' => 'satinalma', 'dealer_code' => 'DLR-001', 'customer_scope' => 'branch', 'region' => 'ERZURUM', 'branch' => 'ERZURUM', 'role' => 'salesperson'],
    ['name' => 'Erzurum Müdür', 'username' => 'mudur.erzurum', 'dealer_code' => 'Global kullanıcı', 'customer_scope' => 'dealer', 'region' => null, 'branch' => null, 'role' => 'admin'],
    ['name' => 'ERZURUM MERKEZ', 'username' => 'erz.merkez', 'dealer_code' => 'DLR-001', 'customer_scope' => 'assigned', 'region' => 'ERZURUM', 'branch' => 'ERZURUM', 'role' => 'salesperson'],
    ['name' => 'ERZURUM MERKEZ', 'username' => 'erzurum.merkez', 'dealer_code' => 'DLR-001', 'customer_scope' => 'assigned', 'region' => 'ERZURUM', 'branch' => 'ERZURUM', 'role' => 'salesperson'],
    ['name' => 'MEHMET AKSOY', 'username' => 'mehmet.aksoy', 'dealer_code' => 'DLR-001', 'customer_scope' => 'assigned', 'region' => 'ERZURUM', 'branch' => 'ERZURUM', 'role' => 'salesperson'],
    ['name' => 'HÜSEYİN ÖZGÜNEY', 'username' => 'huseyin.ozguney', 'dealer_code' => 'DLR-001', 'customer_scope' => 'assigned', 'region' => 'ERZURUM', 'branch' => 'ERZURUM', 'role' => 'salesperson'],
    ['name' => 'AHMET ARAÇ', 'username' => 'ahmet.arac', 'dealer_code' => 'DLR-001', 'customer_scope' => 'assigned', 'region' => 'ERZURUM', 'branch' => 'ERZURUM', 'role' => 'salesperson'],
    ['name' => 'Point Bayi', 'username' => 'point', 'dealer_code' => 'DLR-001', 'customer_scope' => 'dealer', 'region' => null, 'branch' => null, 'role' => 'point'],
    ['name' => 'Depo Kullanıcısı', 'username' => 'warehouse', 'dealer_code' => 'DLR-001', 'customer_scope' => 'dealer', 'region' => null, 'branch' => null, 'role' => 'warehouse'],
    ['name' => 'Plasiyer', 'username' => 'salesperson', 'dealer_code' => 'DLR-001', 'customer_scope' => 'assigned', 'region' => null, 'branch' => null, 'role' => 'salesperson'],
    ['name' => 'Moderatör', 'username' => 'moderator', 'dealer_code' => 'DLR-001', 'customer_scope' => 'dealer', 'region' => null, 'branch' => null, 'role' => 'moderator'],
    ['name' => 'Bayi Yöneticisi', 'username' => 'dealer_admin', 'dealer_code' => 'DLR-001', 'customer_scope' => 'dealer', 'region' => null, 'branch' => null, 'role' => 'dealer_admin'],
    ['name' => 'Admin', 'username' => 'admin', 'dealer_code' => 'Global kullanıcı', 'customer_scope' => 'dealer', 'region' => null, 'branch' => null, 'role' => 'admin'],
];

$dealerIdMap = [];
foreach (Dealer::all() as $d) {
    $dealerIdMap[$d->code] = $d->id;
}

$roles = Role::all()->keyBy("slug");

foreach ($usersData as $u) {
    $existing = User::where("username", $u["username"])->first();
    if ($existing) {
        continue;
    }

    $dealerId = null;
    if ($u["dealer_code"] !== "Global kullanıcı") {
        $dealerId = $dealerIdMap[$u["dealer_code"]] ?? null;
    }
    
    $newUser = new User();
    $newUser->name = $u["name"];
    $newUser->username = $u["username"];
    $newUser->email = $u["username"] . "@powersab2b.com";
    $newUser->password = Hash::make("123456");
    $newUser->dealer_id = $dealerId;
    $newUser->customer_scope = $u["customer_scope"];
    
    if ($u["region"]) {
        $newUser->region_code = $u["region"];
        $newUser->region_name = $u["region"];
    }
    if ($u["branch"]) {
        $newUser->branch_code = $u["branch"];
        $newUser->branch_name = $u["branch"];
    }
    
    $newUser->is_active = true;
    $newUser->save();
    
    if (isset($roles[$u["role"]])) {
        $newUser->roles()->attach($roles[$u["role"]]->id);
    }
    
    echo "Created user " . $u["username"] . "\\n";
}
echo "Done!\\n";
`;
const ssh = new NodeSSH();

async function check() {
  try {
    await ssh.connect({
      host: process.env.POWERSA_SSH_HOST,
      username: process.env.POWERSA_SSH_USER ?? 'root',
      password: process.env.POWERSA_SSH_PASSWORD
    });
    
    fs.writeFileSync('restore_users.php', scriptContent);
    await ssh.putFile('restore_users.php', '/var/www/powersab2b.com/backend/restore_users.php');

    const cmd = `cd /var/www/powersab2b.com/backend && php artisan tinker restore_users.php`;
    const { stdout, stderr } = await ssh.execCommand(cmd);
    console.log(`STDOUT:\n${stdout}`);
    if (stderr) console.error("STDERR:", stderr);

    ssh.dispose();
  } catch (error) {
    console.error('Error:', error);
  }
}

check();
