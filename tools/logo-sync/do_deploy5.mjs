import { NodeSSH } from 'node-ssh';

const ssh = new NodeSSH();

async function deploy() {
  try {
    await ssh.connect({
      host: process.env.POWERSA_SSH_HOST,
      username: process.env.POWERSA_SSH_USER ?? 'root',
      password: process.env.POWERSA_SSH_PASSWORD
    });

    const commands = [
      `mkdir -p /var/www/powersab2b.com/tmp && touch /var/www/powersab2b.com/tmp/restart.txt`,
      `mkdir -p /var/www/powersab2b.com/web/tmp && touch /var/www/powersab2b.com/web/tmp/restart.txt`,
      `systemctl restart lsws || true`,
    ];

    for (const cmd of commands) {
      await ssh.execCommand(cmd);
    }
    
    console.log('\nRestart triggered!');
    ssh.dispose();
  } catch (error) {
    console.error('Error:', error);
    ssh.dispose();
  }
}

deploy();
