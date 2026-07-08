#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT_DIR/apps/web"

REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_HOST="${REMOTE_HOST:-62.72.20.30}"
REMOTE_PORT="${REMOTE_PORT:-22}"
REMOTE_WEB_ROOT="${REMOTE_WEB_ROOT:-/var/www/powersab2b.com/web}"

STAMP="${DEPLOY_STAMP:-web-$(date +%Y%m%d-%H%M%S)}"
SSH=(ssh -o BatchMode=yes -p "$REMOTE_PORT")
RSYNC_RSH="ssh -o BatchMode=yes -p $REMOTE_PORT"

CRITICAL_WEB_PATHS=(
  "apps/web/src/components/search"
  "apps/web/src/components/collections"
  "apps/web/src/app/search"
  "apps/web/src/app/collections"
  "apps/web/src/app/globals.css"
  "apps/web/src/components/layout/app-shell.tsx"
  "apps/web/server.cjs"
)

if git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  DIRTY_CRITICAL="$(
    git -C "$ROOT_DIR" status --porcelain -- "${CRITICAL_WEB_PATHS[@]}" \
      | sed '/^[[:space:]]*$/d' || true
  )"

  if [ -n "$DIRTY_CRITICAL" ] && [ "${ALLOW_RISKY_WEB_DEPLOY:-}" != "1" ]; then
    cat >&2 <<EOF
Refusing full web deploy: critical web files are dirty.

These paths can change /search, /collections, the global header, or the web server runtime.
Deploying the whole .next build from this state can overwrite the currently-good live pages.

$DIRTY_CRITICAL

Use a targeted backend/Logo deploy for API-only changes, or reconcile these web changes first.
If you intentionally want to replace the whole live web build, rerun with:
  ALLOW_RISKY_WEB_DEPLOY=1 tools/deploy-web-production.sh
EOF
    exit 42
  fi
fi

cd "$WEB_DIR"
npm run build

"${SSH[@]}" "$REMOTE_USER@$REMOTE_HOST" "set -e; cd '$REMOTE_WEB_ROOT'; mkdir -p tmp .codex-backups /root/powersa-web-backups; cp -p server.cjs '.codex-backups/server.cjs-before-$STAMP' 2>/dev/null || true; tar -czf '/root/powersa-web-backups/powersa-web-before-$STAMP.tar.gz' .next public server.cjs package.json package-lock.json next.config.ts 2>/dev/null || true; if [ -d .next ]; then cp -al .next '.next-prev-$STAMP'; fi"

rsync -az --delete --exclude='dev/' -e "$RSYNC_RSH" "$WEB_DIR/.next/" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_WEB_ROOT/.next/"
rsync -az --delete -e "$RSYNC_RSH" "$WEB_DIR/public/" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_WEB_ROOT/public/"
rsync -az -e "$RSYNC_RSH" \
  "$WEB_DIR/server.cjs" \
  "$WEB_DIR/package.json" \
  "$WEB_DIR/package-lock.json" \
  "$WEB_DIR/next.config.ts" \
  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_WEB_ROOT/"

"${SSH[@]}" "$REMOTE_USER@$REMOTE_HOST" "set -e; cd '$REMOTE_WEB_ROOT'; if [ -d '.next-prev-$STAMP/static' ]; then rsync -a --ignore-existing '.next-prev-$STAMP/static/' '.next/static/'; fi; mkdir -p .next/cache/images; chown -R www-data:www-data .next/cache; chmod -R u+rwX,g+rwX .next/cache; rm -rf src src_upload_tmp .codex-staging ._.next .env.example .env.local.example README.md eslint.config.mjs next-env.d.ts postcss.config.mjs tsconfig.json components.json .gitignore; echo '$STAMP' > tmp/last-ui-deploy-stamp.txt; touch tmp/restart.txt; systemctl restart powersab2b-web.service; echo \"deployed_build=\$(cat .next/BUILD_ID)\"; echo \"fixed_icons=\$(find public/dashboard-icons/fixed -maxdepth 1 -type f -name '*.webp' 2>/dev/null | wc -l)\""

"${SSH[@]}" "$REMOTE_USER@$REMOTE_HOST" "set -e; cd '$REMOTE_WEB_ROOT'; \
  check_page() { \
    url=\"\$1\"; \
    label=\"\$2\"; \
    body=\"\$(mktemp)\"; \
    code=\"\$(curl -L -sS -m 15 -o \"\$body\" -w '%{http_code}' \"\$url\" || true)\"; \
    if [ \"\$code\" != '200' ] || grep -Eqi 'This page couldn.t load|Tahsilat sayfası yenilenemedi|Application error|ChunkLoadError' \"\$body\"; then \
      echo \"Smoke failed for \$label: HTTP \$code\" >&2; \
      rm -f \"\$body\"; \
      return 1; \
    fi; \
    rm -f \"\$body\"; \
  }; \
  if ! check_page 'https://powersab2b.com/search' '/search' || ! check_page 'https://powersab2b.com/collections' '/collections' || [ \"\$(curl -sS -m 15 -o /dev/null -w '%{http_code}|%{content_type}' 'https://powersab2b.com/api/me')\" != '401|application/json' ]; then \
    echo 'Smoke test failed; rolling web back from pre-deploy archive.' >&2; \
    tar -xzf '/root/powersa-web-backups/powersa-web-before-$STAMP.tar.gz'; \
    systemctl restart powersab2b-web.service; \
    exit 43; \
  fi; \
  echo 'smoke_ok=/search,/collections,/api/me';"
