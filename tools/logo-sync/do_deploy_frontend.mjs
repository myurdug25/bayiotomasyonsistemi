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

    console.log('Uploading deploy2.tar.gz...');
    await ssh.putFile('deploy2.tar.gz', '/root/deploy2.tar.gz');
    console.log('Upload complete.');

    const commands = [
      `mkdir -p /root/deploy_ext2`,
      `tar -xzf /root/deploy2.tar.gz -C /root/deploy_ext2`,
      
      // Sync to web (Next.js)
      `rsync -a /root/deploy_ext2/apps/web/ /var/www/powersab2b.com/web/`,
      
      // Restart web
      `touch /var/www/powersab2b.com/web/tmp/restart.txt`,
      `systemctl restart lsws || true`,
      
      // Cleanup
      `rm -rf /root/deploy_ext2 /root/deploy2.tar.gz`
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
