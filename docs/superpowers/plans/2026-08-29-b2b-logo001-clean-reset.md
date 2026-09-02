# B2B Logo001 Clean Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reset live B2B operational content so the system starts clean against Logo firm `001`.

**Architecture:** Keep identity and master access data intact, backup the live database, truncate operational/history tables, remove stale non-Logo customer remnants, and let Windows Logo sync repopulate Logo-derived customers/products/ledger. The reset must not drop users, roles, dealer setup, or migrations.

**Tech Stack:** Laravel API, PostgreSQL, SSH deployment scripts, Windows Logo sync Node.js scripts.

**Spec:** User request in current thread: “B2B içeriği temiz olmalı... baştan başlayacağız... sistemin tamamı logoda ne varsa ona göre çalışacak.”

## Global Constraints

- Do not print secrets from `.env` or SSH credentials.
- Always create a live DB backup before destructive cleanup.
- Preserve users, roles, dealers, warehouses, cashboxes, products, brands, categories, price lists, and finance definitions.
- Clear carts, orders, shipments, POS operation data, collections, ledger cache, returns, purchase receipts, notifications, and integration sync history.
- Keep only active Logo customers after cleanup; remove stale `logo-superseded`, manual, and null-source customer rows after selected customer pointers are cleared.

---

### Task 1: Build Live Reset Script

**Files:**
- Create: `.codex-deploy/reset-live-b2b-content-for-logo001-20260829.mjs`

**Interfaces:**
- Consumes: SSH credential pattern from `tools/logo-sync/deploy-logo-invoice-ledger-fallback-20260825.mjs`.
- Produces: remote PostgreSQL backup and reset summary JSON.

- [ ] **Step 1: Connect over SSH**

Use `node-ssh` from `tools/logo-sync/package.json` and do not print credentials.

- [ ] **Step 2: Backup database**

Run `pg_dump -Fc` on the live Laravel database into `/var/www/bayiotomasyonsistemi.com/.deploy-backups/b2b-logo001-clean-reset-<stamp>/database.dump`.

- [ ] **Step 3: Execute cleanup in Laravel bootstrap**

Run a PHP cleanup script inside `/var/www/bayiotomasyonsistemi.com/backend` that truncates operational tables using `TRUNCATE ... RESTART IDENTITY CASCADE`, clears `users.selected_customer_id`, deletes non-Logo/superseded customers, and clears Laravel cache/session tables.

- [ ] **Step 4: Verify counts**

Print counts for `customers`, `ledger_entries`, `orders`, `carts`, `collections`, `pos_sales`, `shipments`, `return_requests`, `integration_sync_events`, and `integration_sync_states`.

### Task 2: Run Windows Logo Sync

**Files:**
- No code changes.

**Interfaces:**
- Consumes: Windows `.env` already switched to Logo firm `001`.
- Produces: clean B2B state populated from Logo 001.

- [ ] **Step 1: Stop daemon and clear locks**

Run the provided PowerShell daemon stop and lock cleanup commands.

- [ ] **Step 2: Force full customers/products/ledger sync**

Run `logo-customers-sync.mjs`, `logo-product-catalog-sync.mjs`, and `logo-ledger-sync.mjs` with `SYNC_FORCE_FULL=true`.

- [ ] **Step 3: Restart daemon**

Run `install-sync-daemon-task.ps1`.

### Task 3: Verify Live Dashboard

**Files:**
- No code changes.

**Interfaces:**
- Consumes: live API dashboard endpoint.
- Produces: visible confirmation that operational content is clean and Logo sync timestamps are fresh.

- [ ] **Step 1: Probe dashboard counts**

Call the dashboard report controller through Laravel bootstrap and inspect totals.

- [ ] **Step 2: Probe customer count**

Confirm customers are Logo `001` records and old operational counts are zero.
