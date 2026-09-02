import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const productsSource = fs.readFileSync(
  path.join(root, "logo-products-sync.mjs"),
  "utf8"
);
const daemonSource = fs.readFileSync(
  path.join(root, "logo-sync-daemon.mjs"),
  "utf8"
);

test("catalog sync follows recently modified Logo price rows", () => {
  assert.match(productsSource, /fetchCatalogPriceRefs/);
  assert.match(productsSource, /CAPIBLOCK_MODIFIEDDATE/);
  assert.match(productsSource, /SYNC_PRODUCTS_PRICE_LOOKBACK_MINUTES/);
  assert.match(productsSource, /catalog incremental added .* price refresh/);
});

test("maintenance sync defaults to one minute", () => {
  assert.match(
    daemonSource,
    /SYNC_DAEMON_MAINTENANCE_INTERVAL_MS", 60_000/
  );
});

test("full product sync splits heavy API payloads to avoid request timeouts", () => {
  assert.match(productsSource, /SYNC_API_REQUEST_MAX_RECORDS/);
  assert.match(productsSource, /SYNC_API_REQUEST_MAX_ALIASES/);
  assert.match(productsSource, /pushBatchAdaptively\(records, config, \{/);
  assert.match(productsSource, /partitionApiRequests/);
  assert.doesNotMatch(productsSource, /endpoint timeout/);
});

test("full catalog sync marks the final API request as authoritative", () => {
  assert.match(productsSource, /shouldSendAuthoritativeCatalogSnapshot/);
  assert.match(productsSource, /sync_run_id/);
  assert.match(productsSource, /is_full_sync/);
  assert.match(productsSource, /is_final_batch/);
  assert.match(productsSource, /syncState\.sync_run_id = authoritativeSyncRunId/);
  assert.match(productsSource, /index === requestChunks\.length - 1/);
});
