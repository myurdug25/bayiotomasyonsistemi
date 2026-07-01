import { NodeSSH } from 'node-ssh';

const ssh = new NodeSSH();

async function check() {
  try {
    await ssh.connect({
      host: process.env.POWERSA_SSH_HOST,
      username: process.env.POWERSA_SSH_USER ?? 'root',
      password: process.env.POWERSA_SSH_PASSWORD
    });

    const commands = [
      `cd /var/www/powersab2b.com && git rev-parse --short HEAD`,
      `cd /var/www/powersab2b.com && git status --short`,
      `cd /var/www/powersab2b.com && sha256sum apps/api/app/Services/Warehouse/WarehouseShipmentService.php backend/app/Services/Warehouse/WarehouseShipmentService.php`,
      `cd /var/www/powersab2b.com && sha256sum apps/api/app/Http/Controllers/Api/WarehouseOrderController.php backend/app/Http/Controllers/Api/WarehouseOrderController.php`,
      `cd /var/www/powersab2b.com && sha256sum apps/web/src/app/globals.css web/src/app/globals.css`,
      `cd /var/www/powersab2b.com && sha256sum apps/web/src/components/warehouse/warehouse-orders-page.tsx web/src/components/warehouse/warehouse-orders-page.tsx`,
      `cd /var/www/powersab2b.com && sha256sum apps/web/src/components/warehouse/warehouse-shipment-detail-page.tsx web/src/components/warehouse/warehouse-shipment-detail-page.tsx`,
      `cd /var/www/powersab2b.com && diff -q --strip-trailing-cr apps/web/src/app/globals.css web/src/app/globals.css || true`,
      `cd /var/www/powersab2b.com && diff -q --strip-trailing-cr apps/web/src/components/warehouse/warehouse-orders-page.tsx web/src/components/warehouse/warehouse-orders-page.tsx || true`,
      `cd /var/www/powersab2b.com && diff -q --strip-trailing-cr apps/web/src/components/warehouse/warehouse-shipment-detail-page.tsx web/src/components/warehouse/warehouse-shipment-detail-page.tsx || true`,
      `test -f /var/www/powersab2b.com/web/.next/BUILD_ID && cat /var/www/powersab2b.com/web/.next/BUILD_ID || echo WEB_BUILD_ID_MISSING`,
      `systemctl is-active lsws || true`,
      `systemctl is-active powersab2b-web.service || true`,
      `systemctl status powersab2b-web.service --no-pager --lines=20 || true`,
      `systemctl show powersab2b-web.service -p User -p Group -p WorkingDirectory -p ExecStart --no-pager`,
      `stat -c '%U %G %a %n' /var/www/powersab2b.com/web/.env.local`,
      `journalctl -u powersab2b-web.service --no-pager -n 30 || true`,
      `for dir in /var/www/powersab2b.com/web/.next*; do test -d "$dir" && printf '%s ' "$dir" && (cat "$dir/BUILD_ID" 2>/dev/null || echo NO_BUILD_ID); done`,
      `ps -eo pid,comm,args | grep -E '[n]ode|[p]hp-fpm|[l]shttpd|[n]ginx|[a]pache'`,
      `pid=$(pgrep -f '/var/www/powersab2b.com/web/server.cjs' | head -1); test -n "$pid" && readlink -f "/proc/$pid/cwd" || true`,
      `for dir in /var/www/powersab2b.com/web/.next /var/www/powersab2b.com/apps/web/.next; do test -d "$dir" && echo "$dir EXISTS" || echo "$dir MISSING"; done`,
      `ss -ltnp | grep -E ':80 |:443 |:3000 ' || true`,
      `systemctl list-units --type=service --state=running --no-pager --no-legend | grep -E 'nginx|apache|lsws|php|node|passenger|pm2' || true`,
      `curl -sS -o /dev/null -w 'HTTP=%{http_code} REDIRECT=%{redirect_url}\\n' https://powersab2b.com`,
    ];

    for (const cmd of commands) {
      console.log(`\n>>> ${cmd}`);
      const { stdout, stderr } = await ssh.execCommand(cmd);
      if (stdout) console.log(stdout);
      if (stderr) console.error('ERR:', stderr);
    }
    
    ssh.dispose();
  } catch (error) {
    console.error('Error:', error);
    ssh.dispose();
  }
}

check();
