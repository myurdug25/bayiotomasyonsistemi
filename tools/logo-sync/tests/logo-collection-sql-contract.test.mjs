import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.resolve(testDir, "../sql/powersa-b2b-collection-write-procedure.sql");

test("collection export requires an exact Logo cashbox match", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(source, /WHERE CODE = CONVERT\(VARCHAR\(25\), @CashboxCode\)/i);
  assert.match(source, /WHERE NAME = CONVERT\(VARCHAR\(51\), @CashboxName\)/i);
  assert.doesNotMatch(
    source,
    /FROM dbo\.LG_003_KSCARD[\s\S]{0,160}WHERE ISNULL\(ACTIVE,\s*0\)\s*=\s*0\s*ORDER BY LOGICALREF/i
  );
});

test("collection export reconciles an existing cash and customer ledger pair", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(source, /FROM dbo\.LG_003_01_KSLINES[\s\S]*CARDREF = @CashboxRef[\s\S]*FICHENO = @FicheNo/i);
  assert.match(source, /FROM dbo\.LG_003_01_CLFLINE[\s\S]*SOURCEFREF = @KslinesRef[\s\S]*CLIENTREF = @CustomerRef/i);
  assert.match(source, /SET @ExternalRef = CONCAT\(N'CLFLINE-', @ClflineRef\)/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_FinishExport @ExportKey, @ExternalRef;\s*RETURN;/i);
});
