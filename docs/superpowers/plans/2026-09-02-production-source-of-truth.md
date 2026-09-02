# Production Source Of Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local, GitHub, and the live Hostinger deployment point to the same production code so fixes are not overwritten by dirty local state or partial deploys.

**Architecture:** GitHub becomes the source of truth. Production deploys are allowed only from a clean commit, and each deploy records the exact commit SHA on the server. A comparison tool checks live files against the local/GitHub commit before any risky work.

**Tech Stack:** Git, Node.js deploy scripts, Laravel API, Next.js web app, Hostinger Linux service.

**Spec:** User request on 2026-09-02: “canlıdaki sistemi korumak ve localdeki kodlarla canlıdaki kodlar aynı olmalı”.

## Global Constraints

- Do not deploy, run production commands, run migrations, or live sync unless the user explicitly approves it.
- Do not print or commit secrets from `.env` files or deploy credential scripts.
- Preserve unrelated dirty files; never reset or overwrite user work without explicit approval.
- Existing live system is treated as protected until a live/local/GitHub comparison is complete.

---

### Task 1: Production Snapshot And Diff Audit

**Files:**
- Create: `tools/deploy/audit-production-state.mjs`
- Read only: production `/var/www/bayiotomasyonsistemi.com`

**Interfaces:**
- Produces: a JSON report containing production marker files, local commit SHA, dirty status summary, and SHA-256 checksums for selected API/web/logo-sync files.

- [x] **Step 1: Write the audit script**

Create `tools/deploy/audit-production-state.mjs` that:
- Reads SSH settings from the existing deploy credential source without printing them.
- Runs `git rev-parse HEAD` and `git status --short` locally.
- Reads `/var/www/bayiotomasyonsistemi.com/.deploy-manifest.json` if present.
- Calculates `sha256sum` on production files included in the deploy manifest.
- Prints a short report: local SHA, production SHA, dirty count, changed file count.

- [x] **Step 2: Run the audit**

Run:

```powershell
node tools/deploy/audit-production-state.mjs
```

Expected: report shows whether live equals local HEAD, local dirty files, and missing production manifest if this is the first run.

- [x] **Step 3: Save the audit result**

Save the report under:

```text
.codex-deploy/audits/YYYYMMDD-HHMMSS-production-state.json
```

### Task 2: Create A Protected Deploy Command

**Files:**
- Create: `tools/deploy/deploy-production.mjs`
- Modify: `package.json` or add a repo-level deploy command if one already exists.

**Interfaces:**
- Consumes: clean Git worktree and a named commit SHA.
- Produces: production deployment and `/var/www/bayiotomasyonsistemi.com/.deploy-manifest.json`.

- [x] **Step 1: Add clean tree guard**

The deploy script must fail before upload when:

```text
git status --porcelain
```

returns any file unless `--allow-dirty` is explicitly passed.

- [x] **Step 2: Add branch and commit guard**

The deploy script must record:

```text
git rev-parse HEAD
git branch --show-current
```

and refuse deploy if HEAD is not the intended production commit.

- [ ] **Step 3: Build before upload**

Run these locally before production upload:

```powershell
cd apps/api
php artisan test --filter=<changed-area-tests>

cd ..\web
npm run build
```

- [ ] **Step 4: Write production manifest**

After successful upload/build/restart, write:

```json
{
  "commit_sha": "<git-sha>",
  "branch": "<branch>",
  "deployed_at": "<iso-date>",
  "deployed_by": "codex",
  "backup_path": "<server-backup-path>"
}
```

to:

```text
/var/www/bayiotomasyonsistemi.com/.deploy-manifest.json
```

### Task 3: One-Time Live Reconciliation

**Files:**
- Modify only after audit confirms exact differences.

**Interfaces:**
- Consumes: audit report from Task 1.
- Produces: a Git commit/tag that matches live production.

- [x] **Step 1: Compare live against local**

Use the audit report to list:
- Files same in live and local.
- Files newer/different on live.
- Files newer/different in local.

- [ ] **Step 2: Choose source for each difference**

For each changed file, decide:
- Keep live version.
- Keep local version.
- Manually merge.

Do not use `git reset --hard`.

- [x] **Step 3: Commit the reconciled production state**

Run:

```powershell
git add <reconciled-files>
git commit -m "chore: reconcile production source of truth"
git tag production-live-2026-09-02
git push origin codex/stable-live-2026-07-11 --tags
```

### Task 4: Replace Ad Hoc Dar Deploy

**Files:**
- Modify: `.codex-deploy/*.mjs` or replace with `tools/deploy/deploy-production.mjs`

**Interfaces:**
- Produces: a single command for production deploy.

- [ ] **Step 1: Add the single command**

Use one production command only:

```powershell
node tools\deploy\deploy-production.mjs
```

- [ ] **Step 2: Make old deploy scripts warn**

Old one-off deploy scripts should print:

```text
Use tools/deploy/deploy-production.mjs instead.
```

and exit unless explicitly allowed.

### Task 5: Daily Production Drift Check

**Files:**
- Create: `tools/deploy/check-production-drift.mjs`

**Interfaces:**
- Consumes: production manifest and GitHub/local commit.
- Produces: pass/fail drift result.

- [ ] **Step 1: Add drift checker**

The drift checker compares production manifest `commit_sha` with local/GitHub HEAD.

- [ ] **Step 2: Run before every deploy**

Deploy must call drift checker first and stop if production changed outside Git.

Expected stop message:

```text
Production does not match Git source of truth. Run audit before deploy.
```

## Self-Review

- Spec coverage: protects live, aligns local/GitHub/live, prevents dirty deploys, records exact deployed commit.
- Placeholder scan: no TBD or open-ended implementation placeholder remains.
- Type consistency: deploy/audit scripts all use Node.js and the same manifest fields.
