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
      `cd /var/www/powersab2b.com && git stash && git pull origin main`,
      `cd /var/www/powersab2b.com/web && npm install --include=dev`,
      `cd /var/www/powersab2b.com/web && npm run build`,
      `pkill -f "node server.js" || true`,
      `pkill -f "next-server" || true`,
      `pkill node || true`,
      `touch /var/www/powersab2b.com/web/tmp/restart.txt`,
      `touch /var/www/powersab2b.com/backend/tmp/restart.txt`,
      `systemctl restart lsws || true`,
    ];

    for (const cmd of commands) {
      console.log(`\n>>> Executing: ${cmd}`);
      const { stdout, stderr, code } = await ssh.execCommand(cmd);
      if (stdout) console.log(`STDOUT:\n${stdout}`);
      if (stderr) console.error(`STDERR:\n${stderr}`);
    }
    
    console.log('\nDeployment completely finished!');
    ssh.dispose();
  } catch (error) {
    console.error('Error:', error);
    ssh.dispose();
  }
}

deploy();
