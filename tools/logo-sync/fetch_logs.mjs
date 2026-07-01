import { NodeSSH } from 'node-ssh';

const ssh = new NodeSSH();

async function getLogs() {
  try {
    await ssh.connect({
      host: '62.72.20.30',
      username: 'root',
      password: 'Bilekpay.x4322'
    });
    const command = `tail -n 200 /var/www/powersab2b.com/backend/storage/logs/laravel.log`;
    const result = await ssh.execCommand(command);
    console.log(result.stdout);
    if (result.stderr) console.error("ERR:", result.stderr);
  } finally { 
    ssh.dispose(); 
  }
}
getLogs();
