import { NodeSSH } from 'node-ssh';

const ssh = new NodeSSH();

async function run() {
  try {
    await ssh.connect({
      host: process.env.POWERSA_SSH_HOST,
      username: 'root',
      password: process.env.POWERSA_SSH_PASSWORD
    });
    console.log("Connected to server...");
    
    const command = `pm2 logs powersa-web --lines 50 --nostream`;
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
