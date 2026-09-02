import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(testDir, "..", "logo-products-sync.mjs"), "utf8");

test("fast stock sync resumes from the previous Logo stock line ref", () => {
  assert.match(source, /const previousSyncState = loadSyncState\(stateFile\)/);
  assert.match(source, /previousSyncState/);
  assert.match(source, /stockFastPreviousLineRef/);
  assert.match(source, /afterStockLineRef/);
  assert.match(source, /sl\.\$\{lineRefColumn\} > @afterStockLineRef/);
});

test("fast stock sync advances cursor only after a successful run", () => {
  assert.match(source, /pending_last_seen_stock_line_ref/);
  assert.match(source, /if \(\s*config\.sync\.stockFast &&\s*syncState\.failed_count === 0/s);
  assert.match(source, /syncState\.last_seen_stock_line_ref = syncState\.pending_last_seen_stock_line_ref/);
});

test("fast stock sync processes oldest unhandled lines first when a cursor exists", () => {
  assert.match(source, /OrderedStockLines AS/);
  assert.match(source, /ORDER BY sl\.\$\{lineRefColumn\} ASC/);
  assert.match(source, /GROUP BY product_ref/);
});
