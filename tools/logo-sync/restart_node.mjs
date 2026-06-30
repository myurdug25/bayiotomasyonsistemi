import { NodeSSH } from 'node-ssh';

const ssh = new NodeSSH();

async function check() {
  try {
    await ssh.connect({
      host: process.env.POWERSA_SSH_HOST,
      username: process.env.POWERSA_SSH_USER ?? 'root',
      password: process.env.POWERSA_SSH_PASSWORD
    });
    
    console.log('Killing Node.js process 141793...');
    const { stdout, stderr } = await ssh.execCommand('kill 141793');
    console.log(`STDOUT:\n${stdout}`);
    if (stderr) console.error(`STDERR:\n${stderr}`);

    // Wait 3 seconds to see if it auto-restarted
    await new Promise(res => setTimeout(res, 3000));
    
    const { stdout: ps } = await ssh.execCommand('ps aux | grep -E "node"');
    console.log(`PS after kill:\n${ps}`);

    ssh.dispose();
  } catch (error) {
    console.error('Error:', error);
  }
}

check();
