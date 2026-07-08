import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(testDir, "..", "logo-products-sync.mjs"), "utf8");

test("stock sync prioritizes Logo daily warehouse totals", () => {
  const primaryBlock = source.match(
    /function derivePrimaryStockTableNames[\s\S]+?const directCandidates[\s\S]+?\]\);/
  )?.[0];

  assert.ok(primaryBlock);
  assert.ok(primaryBlock.indexOf('replacement: "STINVTOT"') < primaryBlock.indexOf('replacement: "GNTOTST"'));
  assert.match(source, /return uniqueColumns\(\[\.\.\.viewCandidates,\s*\.\.\.branchCandidates,\s*\.\.\.directCandidates\]\)/);
});

test("dated warehouse totals use latest snapshot per warehouse", () => {
  assert.match(source, /WITH LatestStockDate AS/);
  assert.match(source, /MAX\(CAST\(\$\{dateColumn\} AS date\)\) AS latest_date/);
  assert.match(source, /INNER JOIN LatestStockDate AS latest/);
  assert.match(source, /latest\.latest_date = CAST\(s\.\$\{dateColumn\} AS date\)/);
  assert.match(source, /SUM\(COALESCE\(\$\{availableColumn\}, 0\)\) AS available_total/);
  assert.match(source, /CAST\(\$\{dateColumn\} AS date\) <= CAST\(GETDATE\(\) AS date\)/);
});

test("physical stock is not reduced by reservations", () => {
  assert.match(source, /available_total: onhandTotal,/);
  assert.match(source, /available_total: row\.onhand_total,/);
  assert.match(source, /source_kind: "warehouse_totals"/);
});

test("missing total rows cannot wipe PowerSA stock", () => {
  assert.match(source, /if \(stockAvailable === null && !stock\) \{\s*return null;\s*\}/);
  assert.match(source, /authoritative: false,\s*warehouses: \[\]/);
});
