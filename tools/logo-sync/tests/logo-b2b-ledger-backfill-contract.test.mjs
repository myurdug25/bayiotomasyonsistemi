import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(testDir, "../logo-b2b-ledger-backfill-export.mjs");
const sqlPath = path.resolve(testDir, "../sql/powersa-b2b-ledger-backfill-write-procedure.sql");

test("B2B ledger backfill agent uses isolated pending and ack endpoints", () => {
  const source = fs.readFileSync(scriptPath, "utf8");

  assert.match(source, /POWERSA_B2B_LEDGER_BACKFILL_PENDING_URL/);
  assert.match(source, /\/b2b-ledger-backfill\/pending/i);
  assert.match(source, /POWERSA_B2B_LEDGER_BACKFILL_ACK_URL/);
  assert.match(source, /\/b2b-ledger-backfill\/ack/i);
  assert.match(source, /ledger_entry_id:\s*record\.ledger_entry_id/i);
});

test("B2B ledger backfill agent calls the dedicated Logo procedure", () => {
  const source = fs.readFileSync(scriptPath, "utf8");

  assert.match(source, /LOGO_B2B_LEDGER_BACKFILL_PROCEDURE/);
  assert.match(source, /dbo\.PowersaB2B_BackfillB2BLedgerEntry/);
  assert.match(source, /@CustomerExternalRef = @customerExternalRef/i);
  assert.match(source, /@LedgerDate = @ledgerDate/i);
  assert.match(source, /@Sign = @sign/i);
  assert.match(source, /@ExportKey = @exportKey/i);
});

test("B2B ledger backfill SQL writes idempotent customer ledger lines", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.doesNotMatch(source, /TRY_CONVERT/i);
  assert.match(source, /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_BackfillB2BLedgerEntry/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_BeginExport @ExportKey, N'b2b-ledger-backfill'/i);
  assert.match(source, /FROM dbo\.LG_003_01_CLFLINE[\s\S]*DOCODE = @Docode/i);
  assert.match(source, /INSERT INTO dbo\.LG_003_01_CLFLINE/i);
  assert.match(source, /CLIENTREF,\s*SOURCEFREF,\s*DATE_,\s*MODULENR,\s*TRCODE,\s*SPECODE,\s*CYPHCODE/i);
  assert.match(source, /CANCELLED,\s*STATUS,\s*MONTH_,\s*YEAR_,\s*BRANCH,\s*DEPARTMENT,\s*PAIDINCASH/i);
  assert.match(source, /@CustomerRef,\s*0,\s*@LedgerDate,\s*5,\s*@Trcode,\s*@Specode/i);
  assert.match(source, /CONVERT\(FLOAT,\s*@Amount\),\s*1,\s*CONVERT\(FLOAT,\s*@Amount\),\s*0,\s*0,\s*MONTH\(@LedgerDate\),\s*YEAR\(@LedgerDate\),\s*0,\s*0,\s*0,\s*1/i);
  assert.match(source, /SET @ExternalRef = CONCAT\(N'CLFLINE-', @ClflineRef\)/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_FinishExport @ExportKey, @ExternalRef/i);
});
