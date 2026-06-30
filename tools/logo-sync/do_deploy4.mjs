import { NodeSSH } from 'node-ssh';

const ssh = new NodeSSH();

async function deploy() {
  try {
    console.log('Connecting via SSH...');
    await ssh.connect({
      host: '62.72.20.30',
      username: 'root',
      password: 'Bilekpay.x4322'
    });
    console.log('Connected!');

    const commands = [
      `cd /var/www/powersab2b.com/web && ~/.nvm/nvm.sh || true && export PATH=$PATH:~/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -n 1)/bin && pm2 restart all || /usr/local/bin/pm2 restart all || /usr/bin/pm2 restart all || ~/.npm-global/bin/pm2 restart all || npx pm2 restart all`
    ];

    for (const cmd of commands) {
      console.log(`\n>>> Executing: ${cmd}`);
      const { stdout, stderr, code } = await ssh.execCommand(cmd);
      if (stdout) console.log(`STDOUT:\n${stdout}`);
      if (stderr) console.error(`STDERR:\n${stderr}`);
    }
    
    console.log('\nFrontend PM2 restarted!');
    ssh.dispose();
  } catch (error) {
    console.error('Error:', error);
    ssh.dispose();
  }
}

deploy();
