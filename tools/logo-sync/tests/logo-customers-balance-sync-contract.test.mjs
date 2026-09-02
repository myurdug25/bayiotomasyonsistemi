import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const customersSource = fs.readFileSync(
  path.join(root, "logo-customers-sync.mjs"),
  "utf8"
);

test("customer sync derives Logo current account balances from CLFLINE movements", () => {
  assert.match(customersSource, /customerLedgerTable:[\s\S]*logoPeriodTable\("CLFLINE"\)/);
  assert.match(customersSource, /LEFT\s+JOIN\s*\([\s\S]*SUM\(CASE WHEN ISNULL\(SIGN,\s*0\)\s*=\s*0/);
  assert.match(customersSource, /AS\s+BALANCE_DEBIT/);
  assert.match(customersSource, /AS\s+BALANCE_CREDIT/);
  assert.match(customersSource, /AS\s+BALANCE_DUE/);
  assert.match(customersSource, /balance_debit:\s*normalizeDecimal/);
  assert.match(customersSource, /balance_credit:\s*normalizeDecimal/);
  assert.match(customersSource, /balance_direction:\s*resolveBalanceDirection/);
});

test("customer full sync marks the final batch as authoritative", () => {
  assert.match(customersSource, /buildCustomerSyncRunId/);
  assert.match(customersSource, /syncPlan\.mode === "full" \? buildCustomerSyncRunId/);
  assert.match(customersSource, /sync_run_id/);
  assert.match(customersSource, /is_full_sync/);
  assert.match(customersSource, /is_final_batch/);
  assert.match(customersSource, /index === chunks\.length - 1/);
});
