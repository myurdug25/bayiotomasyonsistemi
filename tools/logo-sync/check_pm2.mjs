import { NodeSSH } from 'node-ssh';

const ssh = new NodeSSH();

async function check() {
  try {
    await ssh.connect({
      host: process.env.POWERSA_SSH_HOST,
      username: process.env.POWERSA_SSH_USER ?? 'root',
      password: process.env.POWERSA_SSH_PASSWORD
    });
    
    const { stdout, stderr } = await ssh.execCommand('pm2 list');
    console.log(`STDOUT:\n${stdout}`);
    if (stderr) console.error(`STDERR:\n${stderr}`);

    ssh.dispose();
  } catch (error) {
    console.error('Error:', error);
  }
}

check();
