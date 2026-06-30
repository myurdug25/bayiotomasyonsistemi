import { NodeSSH } from 'node-ssh';

const ssh = new NodeSSH();

async function deploy() {
  try {
    console.log('Connecting via SSH...');
    await ssh.connect({
      host: process.env.POWERSA_SSH_HOST,
      username: process.env.POWERSA_SSH_USER ?? 'root',
      password: process.env.POWERSA_SSH_PASSWORD
    });
    console.log('Connected!');

    const commands = [
      // Restart PHP for backend
      `cd /var/www/powersab2b.com/backend && php artisan optimize:clear && php artisan queue:restart`,
    ];

    for (const cmd of commands) {
      console.log(`\n>>> Executing: ${cmd}`);
      const { stdout, stderr, code } = await ssh.execCommand(cmd);
      if (stdout) console.log(`STDOUT:\n${stdout}`);
      if (stderr) console.error(`STDERR:\n${stderr}`);
    }
    
    console.log('\nBackend restarted!');
    ssh.dispose();
  } catch (error) {
    console.error('Error:', error);
    ssh.dispose();
  }
}

deploy();
