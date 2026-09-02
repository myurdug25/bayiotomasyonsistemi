import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const campaignSource = fs.readFileSync(
  path.join(root, "logo-campaigns-sync.mjs"),
  "utf8"
);
const daemonSource = fs.readFileSync(
  path.join(root, "logo-sync-daemon.mjs"),
  "utf8"
);

test("campaign sync reads the full Logo campaign snapshot so passive cards deactivate B2B campaigns", () => {
  assert.doesNotMatch(campaignSource, /WHERE\s+ISNULL\(ACTIVE,\s*0\)\s*=\s*0/i);
  assert.match(campaignSource, /is_active:\s*isActive/);
  assert.match(campaignSource, /campaign-sync-status\.json/);
});

test("daemon keeps campaign sync in the one-minute maintenance loop", () => {
  assert.match(daemonSource, /defaultMaintenanceSteps\s*=\s*\[[\s\S]*"campaigns"/);
  assert.match(daemonSource, /SYNC_DAEMON_MAINTENANCE_INTERVAL_MS",\s*60_000/);
  assert.match(daemonSource, /\.\.\.parseStepList\(process\.env\.SYNC_DAEMON_MAINTENANCE_STEPS[\s\S]*"campaigns"/);
});

test("daemon runs campaigns independently from long product catalog maintenance", () => {
  assert.match(daemonSource, /runCampaignLoop\(\)/);
  assert.match(daemonSource, /campaignIntervalMs:\s*parseIntEnv\("SYNC_DAEMON_CAMPAIGN_INTERVAL_MS",\s*60_000/);
  assert.match(daemonSource, /const steps = \["campaigns"\]/);
});
