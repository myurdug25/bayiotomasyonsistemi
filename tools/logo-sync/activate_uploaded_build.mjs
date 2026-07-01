import { NodeSSH } from 'node-ssh';

const ssh = new NodeSSH();
const host = process.env.POWERSA_SSH_HOST?.trim();
const password = process.env.POWERSA_SSH_PASSWORD;

if (!host || !password) {
  throw new Error('POWERSA_SSH_HOST and POWERSA_SSH_PASSWORD are required.');
}

try {
  await ssh.connect({
    host,
    username: process.env.POWERSA_SSH_USER?.trim() || 'root',
    password,
  });

  const command = `
set -e
cd /var/www/powersab2b.com/web
candidate="$(find . -maxdepth 1 -type d -name '.next-failed-*' -exec test -f '{}/BUILD_ID' ';' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
fallback="$(find . -maxdepth 1 -type d -name '.next-prev-*' -exec test -f '{}/BUILD_ID' ';' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
test -n "$candidate"
stamp="$(date +%Y%m%d-%H%M%S)"
chown root:www-data .env.local
chmod 640 .env.local
mv .next ".next-broken-$stamp"
mv "$candidate" .next
chown -R www-data:www-data .next/cache 2>/dev/null || true
systemctl restart powersab2b-web.service
healthy=0
for attempt in $(seq 1 30); do
  if curl -fsS -o /dev/null http://127.0.0.1:3000/login; then
    healthy=1
    break
  fi
  sleep 1
done
if [ "$healthy" -ne 1 ]; then
  mv .next ".next-failed-again-$stamp"
  test -n "$fallback"
  mv "$fallback" .next
  systemctl restart powersab2b-web.service
  exit 1
fi
printf 'WEB_BUILD=%s\n' "$(cat .next/BUILD_ID)"
printf 'SERVICE=%s\n' "$(systemctl is-active powersab2b-web.service)"
curl -fsS -o /dev/null -w 'PUBLIC_HTTP=%{http_code}\n' https://powersab2b.com/login
`;

  const result = await ssh.execCommand(command);

  if (result.stdout) {
    console.log(result.stdout);
  }
  if (result.stderr) {
    console.error(result.stderr);
  }
  if (result.code !== 0) {
    process.exitCode = result.code || 1;
  }
} finally {
  ssh.dispose();
}
