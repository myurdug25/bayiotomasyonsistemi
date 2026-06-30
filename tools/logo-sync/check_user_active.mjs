import { NodeSSH } from 'node-ssh';

const ssh = new NodeSSH();

async function run() {
  try {
    await ssh.connect({
      host: process.env.POWERSA_SSH_HOST,
      username: process.env.POWERSA_SSH_USER ?? 'root',
      password: process.env.POWERSA_SSH_PASSWORD
    });
    
    const cmd = `cd /var/www/powersab2b.com/backend && php artisan tinker --execute='echo json_encode(\\App\\Models\\User::where(\"username\", \"ahmet.arac\")->first()->toArray(), JSON_PRETTY_PRINT);'`;
    const { stdout, stderr } = await ssh.execCommand(cmd);
    console.log(`STDOUT:\n${stdout}`);
    if (stderr) console.error(`STDERR:\n${stderr}`);

    ssh.dispose();
  } catch (error) {
    console.error('Error:', error);
  }
}

run();
