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

    console.log('Uploading deploy.tar.gz...');
    await ssh.putFile('deploy.tar.gz', '/root/deploy.tar.gz');
    console.log('Upload complete.');

    const commands = [
      `mkdir -p /root/deploy_ext`,
      `tar -xzf /root/deploy.tar.gz -C /root/deploy_ext`,
      
      // Sync to backend (API)
      `rsync -a /root/deploy_ext/apps/api/ /var/www/powersab2b.com/backend/`,
      
      // Sync to web (Next.js)
      `rsync -a /root/deploy_ext/apps/web/ /var/www/powersab2b.com/web/`,
      
      // Restart PM2 for web
      `cd /var/www/powersab2b.com/web && pm2 restart all`,
      
      // Restart PHP for backend
      `cd /var/www/powersab2b.com/backend && php artisan optimize:clear && php artisan queue:restart`,
      
      // Cleanup
      `rm -rf /root/deploy_ext /root/deploy.tar.gz`
    ];

    for (const cmd of commands) {
      console.log(`\n>>> Executing: ${cmd}`);
      const { stdout, stderr, code } = await ssh.execCommand(cmd);
      if (stdout) console.log(`STDOUT:\n${stdout}`);
      if (stderr) console.error(`STDERR:\n${stderr}`);
      if (code !== 0) {
        console.error(`Command failed with code ${code}. Stopping.`);
        break;
      }
    }
    
    console.log('\nDeployment completely finished!');
    ssh.dispose();
  } catch (error) {
    console.error('Deployment error:', error);
    ssh.dispose();
  }
}

deploy();
