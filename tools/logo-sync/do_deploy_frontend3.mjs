import { NodeSSH } from 'node-ssh';

const ssh = new NodeSSH();

async function deploy() {
  try {
    console.log('Connecting via SSH...');
    await ssh.connect({
      host: '62.72.20.30',
      username: 'root',
      password: 'Bilekpay.x4322'
    });
    console.log('Connected!');

    console.log('Uploading deploy3.tar.gz...');
    await ssh.putFile('deploy3.tar.gz', '/root/deploy3.tar.gz');
    console.log('Upload complete.');

    const commands = [
      `mkdir -p /root/deploy_ext3`,
      `tar -xzf /root/deploy3.tar.gz -C /root/deploy_ext3`,
      
      // Sync to web (Next.js)
      `rsync -a /root/deploy_ext3/apps/web/ /var/www/powersab2b.com/web/`,
      
      // Restart web
      `touch /var/www/powersab2b.com/web/tmp/restart.txt`,
      `systemctl restart lsws || true`,
      
      // Cleanup
      `rm -rf /root/deploy_ext3 /root/deploy3.tar.gz`
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
