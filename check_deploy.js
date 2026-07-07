const { Client } = require('ssh2');

const host = '62.72.20.30';
const username = 'root';
const password = 'Bilekpay.x4322';

const conn = new Client();

const phpScript = `<?php
require 'vendor/autoload.php';
$app = require_once 'bootstrap/app.php';
$kernel = $app->make(Illuminate\\Contracts\\Console\\Kernel::class);
$kernel->bootstrap();

use App\\Models\\PosSale;
use App\\Models\\IntegrationSyncState;

$sales = PosSale::orderBy('id', 'desc')->get()->map(fn($p) => [
  'id' => $p->id,
  'receipt_no' => $p->receipt_no,
  'document_type' => $p->document_type,
  'grand_total' => $p->grand_total,
  'customer_name' => $p->customer?->name,
  'sync' => IntegrationSyncState::where('entity_type', PosSale::class)->where('entity_id', $p->id)->first()?->toArray()
]);

echo json_encode($sales, JSON_PRETTY_PRINT);
`;

const cmd = `
cat << 'EOF' > /var/www/powersab2b.com/backend/check_sales_all.php
${phpScript}
EOF
cd /var/www/powersab2b.com/backend
php check_sales_all.php
rm check_sales_all.php
`;

conn.on('ready', () => {
  conn.exec(cmd, (err, stream) => {
    if (err) {
      console.error(err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('data', (d) => { output += d.toString(); });
    stream.on('close', () => {
      console.log(output);
      conn.end();
    });
  });
}).connect({ host, username, password, readyTimeout: 20000 });
