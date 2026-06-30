import { NodeSSH } from 'node-ssh';
import fs from 'node:fs';

const ssh = new NodeSSH();

async function run() {
  try {
    await ssh.connect({
      host: '62.72.20.30',
      username: 'root',
      password: 'Bilekpay.x4322'
    });
    
    const scriptContent = fs.readFileSync('tools/logo-sync/update_customer_salespersons.php', 'utf8');
    await ssh.putFile('tools/logo-sync/update_customer_salespersons.php', '/var/www/powersab2b.com/backend/update_customer_salespersons.php');

    const cmd = `cd /var/www/powersab2b.com/backend && php artisan tinker update_customer_salespersons.php`;
    const { stdout, stderr } = await ssh.execCommand(cmd);
    console.log(`STDOUT:\n${stdout}`);
    if (stderr) console.error(`STDERR:\n${stderr}`);

    ssh.dispose();
  } catch (error) {
    console.error('Error:', error);
  }
}

run();
