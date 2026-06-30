import { NodeSSH } from 'node-ssh';

const ssh = new NodeSSH();

async function deploy() {
  try {
    await ssh.connect({
      host: '62.72.20.30',
      username: 'root',
      password: 'Bilekpay.x4322'
    });

    console.log('Checking git status...');
    const { stdout: gitOut } = await ssh.execCommand('cd /var/www/powersab2b.com && git status');
    console.log(`Git status:\n${gitOut}`);
    
    const { stdout: lsOut } = await ssh.execCommand('cd /var/www/powersab2b.com && ls -la backend web');
    console.log(`ls backend web:\n${lsOut}`);

    ssh.dispose();
  } catch (error) {
    console.error('Error:', error);
  }
}

deploy();
