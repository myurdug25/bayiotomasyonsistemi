import { NodeSSH } from 'node-ssh';

const ssh = new NodeSSH();

async function run() {
  try {
    await ssh.connect({
      host: '62.72.20.30',
      username: 'root',
      password: 'Bilekpay.x4322'
    });
    
    const cmd = `cd /var/www/powersab2b.com/backend && php artisan users:sync-operational`;
    const { stdout, stderr } = await ssh.execCommand(cmd);
    console.log(`STDOUT:\n${stdout}`);
    if (stderr) console.error(`STDERR:\n${stderr}`);

    ssh.dispose();
  } catch (error) {
    console.error('Error:', error);
  }
}

run();
