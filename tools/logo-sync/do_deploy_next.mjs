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

    console.log('Uploading deploy_next.tar.gz...');
    await ssh.putFile('c:/Users/MURAT/Desktop/NFSSOFT/powersa/deploy_next.tar.gz', '/root/deploy_next.tar.gz');
    console.log('Upload complete.');

    const commands = [
      `mkdir -p /root/deploy_next_tmp`,
      `tar -xzf /root/deploy_next.tar.gz -C /root/deploy_next_tmp`,
      
      // Sync to web (Next.js)
      `rsync -a /root/deploy_next_tmp/apps/web/ /var/www/powersab2b.com/web/`,
      
      // Since Node.js might be running orphan processes that hold the port, let's kill them
      `pkill -f "node server.js" || true`,
      `pkill -f "next-server" || true`,
      `pkill node || true`,
      
      // Restart web
      `touch /var/www/powersab2b.com/web/tmp/restart.txt`,
      
      // Cleanup
      `rm -rf /root/deploy_next_tmp /root/deploy_next.tar.gz`
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
