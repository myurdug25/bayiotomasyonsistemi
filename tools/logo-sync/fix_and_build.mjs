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

    // Upload globals.css which is corrupted on server
    console.log('\nUploading globals.css...');
    await ssh.putFile(
      'c:/Users/MURAT/Desktop/NFSSOFT/powersa/apps/web/src/app/globals.css',
      '/var/www/powersab2b.com/web/src/app/globals.css'
    );
    console.log('globals.css uploaded!');

    // Check line count on server
    const { stdout: wc } = await ssh.execCommand('wc -l /var/www/powersab2b.com/web/src/app/globals.css');
    console.log('Server globals.css line count:', wc);

    console.log('\n=== Building frontend ===');
    const { stdout: buildOut, stderr: buildErr } = await ssh.execCommand('cd /var/www/powersab2b.com/web && npm run build');
    if (buildOut) console.log(buildOut.substring(0, 2000));
    if (buildErr) console.error('Build stderr:', buildErr.substring(0, 1000));

    console.log('\nDone!');
    ssh.dispose();
  } catch (error) {
    console.error('Error:', error);
    ssh.dispose();
  }
}

deploy();
