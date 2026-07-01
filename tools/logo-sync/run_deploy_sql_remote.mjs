import { NodeSSH } from 'node-ssh';

const ssh = new NodeSSH();

async function run() {
  try {
    await ssh.connect({
      host: '62.72.20.30',
      username: 'root',
      password: 'Bilekpay.x4322'
    });
    console.log("Connected to server...");
    
    // Copy backend/.env to tools/logo-sync/.env so deploy-sql.mjs finds it
    const command = `cd /var/www/powersab2b.com && cp backend/.env tools/logo-sync/.env && cd tools/logo-sync && node deploy-sql.mjs`;
    const result = await ssh.execCommand(command);
    console.log("STDOUT:\n", result.stdout);
    if (result.stderr) console.error("STDERR:\n", result.stderr);
    
  } catch (error) {
    console.error("Error:", error);
  } finally {
    ssh.dispose();
  }
}

run();
