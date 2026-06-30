import { NodeSSH } from 'node-ssh';

const ssh = new NodeSSH();

async function deploy() {
  try {
    console.log('Connecting via SSH...');
    await ssh.connect({
      host: process.env.POWERSA_SSH_HOST,
      username: process.env.POWERSA_SSH_USER ?? 'root',
      password: process.env.POWERSA_SSH_PASSWORD
    });
    console.log('Connected!');

    console.log('Uploading deploy4.tar.gz...');
    await ssh.putFile('c:/Users/MURAT/Desktop/NFSSOFT/powersa/deploy4.tar.gz', '/root/deploy4.tar.gz');
    console.log('Upload complete.');

    const commands = [
      `mkdir -p /root/deploy_ext4`,
      `tar -xzf /root/deploy4.tar.gz -C /root/deploy_ext4`,
      
      // Sync to web (Next.js)
      `rsync -a /root/deploy_ext4/apps/web/src/ /var/www/powersab2b.com/web/src/`,
      
      // Build Next.js
      `cd /var/www/powersab2b.com/web && npm run build`,

      // Since Node.js might be running orphan processes that hold the port, let's kill them
      `pkill -f "node server.js" || true`,
      `pkill -f "next-server" || true`,
      `pkill node || true`,
      
      // Restart web
      `touch /var/www/powersab2b.com/web/tmp/restart.txt`,
      `systemctl restart lsws || true`,
      
      // Cleanup
      `rm -rf /root/deploy_ext4 /root/deploy4.tar.gz`
    ];

    for (const cmd of commands) {
      console.log(`\n>>> Executing: ${cmd}`);
      const { stdout, stderr, code } = await ssh.execCommand(cmd);
      if (stdout) console.log(`STDOUT:\n${stdout}`);
      if (stderr) console.error(`STDERR:\n${stderr}`);
    }
    
    console.log('\nDeployment completely finished!');
    ssh.dispose();
  } catch (error) {
    console.error('Deployment error:', error);
    ssh.dispose();
  }
}

deploy();
