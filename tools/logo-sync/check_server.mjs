import { NodeSSH } from 'node-ssh';

const ssh = new NodeSSH();

async function check() {
  try {
    await ssh.connect({
      host: '62.72.20.30',
      username: 'root',
      password: 'Bilekpay.x4322'
    });
    
    // Check processes
    const { stdout, stderr } = await ssh.execCommand('netstat -tulpn | grep -E "3000|80|443"');
    console.log(`STDOUT:\n${stdout}`);
    
    // Check if litespeed or something else
    const { stdout: ps } = await ssh.execCommand('ps aux | grep -E "node|litespeed|nginx|apache|lscpd"');
    console.log(`PS:\n${ps}`);

    ssh.dispose();
  } catch (error) {
    console.error('Error:', error);
  }
}

check();
