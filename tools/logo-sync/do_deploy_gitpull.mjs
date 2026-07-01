import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeSSH } from 'node-ssh';

const ssh = new NodeSSH();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const remoteRoot = '/var/www/powersab2b.com';
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
const remoteBuildStage = `${remoteRoot}/web/.next-codex-${stamp}`;

const backendFiles = [
  'app/Http/Controllers/Api/CustomerCollectionController.php',
  'app/Console/Commands/FixFactoryNames.php',
  'database/migrations/2026_07_01_141027_create_finance_sequences_table.php',
];

const frontendFiles = [
  'src/app/(app)/pos/expenses/page.tsx',
  'src/components/collections/collections-page.tsx',
  'src/components/customers/customer-selection-page.tsx',
  'src/components/pos/point-expenses-page.tsx',
];

function requireSshConfig() {
  const host = process.env.POWERSA_SSH_HOST?.trim();
  const password = process.env.POWERSA_SSH_PASSWORD;

  if (!host || !password) {
    throw new Error('POWERSA_SSH_HOST and POWERSA_SSH_PASSWORD are required.');
  }

  return {
    host,
    username: process.env.POWERSA_SSH_USER?.trim() || 'root',
    password,
  };
}

async function run(command) {
  const result = await ssh.execCommand(command);

  if (result.code !== 0) {
    throw new Error(result.stderr || `Remote command failed with code ${result.code}.`);
  }

  return result.stdout.trim();
}

async function uploadFiles(files, localBase, remoteBase) {
  for (const relativePath of files) {
    console.log(`Uploading ${relativePath}`);
    await ssh.putFile(
      path.join(localBase, ...relativePath.split('/')),
      `${remoteBase}/${relativePath}`,
    );
  }
}

async function deploy() {
  try {
    await ssh.connect(requireSshConfig());

    await run(
      `set -e; mkdir -p '${remoteRoot}/.codex-backups/${stamp}/backend' '${remoteRoot}/.codex-backups/${stamp}/web'; ` +
      backendFiles.map((file) => `cp -p '${remoteRoot}/backend/${file}' '${remoteRoot}/.codex-backups/${stamp}/backend/${file.replaceAll('/', '__')}' 2>/dev/null || true`).join('; ') +
      '; ' +
      frontendFiles.map((file) => `cp -p '${remoteRoot}/web/${file}' '${remoteRoot}/.codex-backups/${stamp}/web/${file.replaceAll('/', '__')}' 2>/dev/null || true`).join('; '),
    );

    await uploadFiles(backendFiles, path.join(repoRoot, 'apps', 'api'), `${remoteRoot}/backend`);
    await uploadFiles(frontendFiles, path.join(repoRoot, 'apps', 'web'), `${remoteRoot}/web`);

    console.log('Running artisan command...');

    console.log('Uploading verified frontend build...');
    const uploaded = await ssh.putDirectory(
      path.join(repoRoot, 'apps', 'web', '.next'),
      remoteBuildStage,
      {
        recursive: true,
        concurrency: 8,
      },
    );

    if (!uploaded) {
      throw new Error('Frontend build upload failed.');
    }

    const activation = await run(
      `set -e; ` +
      `test -f '${remoteBuildStage}/BUILD_ID'; ` +
      `cd '${remoteRoot}/web'; ` +
      `mv .next '.next-prev-${stamp}'; ` +
      `mv '.next-codex-${stamp}' .next; ` +
      `chown -R www-data:www-data .next/cache 2>/dev/null || true; ` +
      `if systemctl restart powersab2b-web.service && sleep 10 && curl -fsS -o /dev/null http://127.0.0.1:3000/login; then ` +
      `echo "WEB_BUILD=$(cat .next/BUILD_ID)"; ` +
      `else ` +
      `mv .next '.next-failed-${stamp}'; ` +
      `mv '.next-prev-${stamp}' .next; ` +
      `systemctl restart powersab2b-web.service; ` +
      `exit 1; ` +
      `fi`,
    );
    console.log(activation);

    const backendResult = await run(
      `cd '${remoteRoot}/backend' && php artisan optimize:clear && php artisan queue:restart`,
    );
    console.log(backendResult);

    const publicHealth = await run(
      `curl -fsS -o /dev/null -w 'HTTP=%{http_code}' https://powersab2b.com/login`,
    );
    console.log(publicHealth);
    console.log(`Backup: ${remoteRoot}/.codex-backups/${stamp}`);
  } finally {
    ssh.dispose();
  }
}

deploy().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
