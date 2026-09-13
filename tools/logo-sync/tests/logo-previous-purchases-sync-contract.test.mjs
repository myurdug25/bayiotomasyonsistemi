import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const source = fs.readFileSync(path.join(root, "logo-previous-purchases-sync.mjs"), "utf8");
const daemonSource = fs.readFileSync(path.join(root, "logo-sync-daemon.mjs"), "utf8");

test("previous purchases sync pushes Eryaz history into B2B instead of requiring live SQL access", () => {
  assert.match(source, /TBLCAHAR/);
  assert.match(source, /TBLSTHAR/);
  assert.match(source, /TBLSTSABIT/);
  assert.match(source, /previous-purchases\/sync/);
  assert.match(source, /POWERSA_PREVIOUS_PURCHASES_SYNC_KEY/);
});

test("previous purchases sync reads configured GUCSAAS year databases incrementally", () => {
  assert.match(source, /ERYAZ_PREVIOUS_PURCHASE_DATABASES/);
  assert.match(source, /ERYAZ_PREVIOUS_PURCHASE_LOOKBACK_DAYS/);
  assert.match(source, /previous-purchases-sync-state\.json/);
});

test("daemon can run previous purchases as a maintenance sync step", () => {
  assert.match(daemonSource, /"previous-purchases":\s*{/);
  assert.match(daemonSource, /logo-previous-purchases-sync\.mjs/);
  assert.match(daemonSource, /POWERSA_PREVIOUS_PURCHASES_SYNC_URL/);
});

test("daemon runs Eryaz ledger history during automatic maintenance syncs", () => {
  assert.match(daemonSource, /"eryaz-ledger":\s*{/);
  assert.match(daemonSource, /eryaz-ledger-sync\.mjs/);
  const defaultMaintenanceSteps = daemonSource.match(/const\s+defaultMaintenanceSteps\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(defaultMaintenanceSteps, "defaultMaintenanceSteps should be declared");
  assert.match(defaultMaintenanceSteps[1], /"previous-purchases"/);
  assert.match(defaultMaintenanceSteps[1], /"eryaz-ledger"/);
});
