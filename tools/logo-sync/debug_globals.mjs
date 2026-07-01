import { NodeSSH } from 'node-ssh';

const ssh = new NodeSSH();

async function fix() {
  try {
    await ssh.connect({
      host: process.env.POWERSA_SSH_HOST,
      username: process.env.POWERSA_SSH_USER ?? 'root',
      password: process.env.POWERSA_SSH_PASSWORD
    });

    // Read the problematic part of the file on the server
    const { stdout: problematic } = await ssh.execCommand(
      `sed -n '4490,4520p' /var/www/powersab2b.com/web/src/app/globals.css`
    );
    console.log('Lines 4490-4520 on server:\n', problematic);

    // Also check what's around line 4395-4415 (where point-admin-shell starts)
    const { stdout: adminShell } = await ssh.execCommand(
      `grep -n "html\\[data-ui-theme" /var/www/powersab2b.com/web/src/app/globals.css | tail -10`
    );
    console.log('\npoint-admin-shell dark theme lines:\n', adminShell);

    // Count open/close braces around line 4500
    const { stdout: braceCheck } = await ssh.execCommand(
      `sed -n '4450,4515p' /var/www/powersab2b.com/web/src/app/globals.css`
    );
    console.log('\n4450-4515:\n', braceCheck);

    ssh.dispose();
  } catch (error) {
    console.error('Error:', error);
    ssh.dispose();
  }
}

fix();
