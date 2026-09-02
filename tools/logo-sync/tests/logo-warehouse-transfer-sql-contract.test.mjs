import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.resolve(testDir, "../sql/powersa-b2b-warehouse-transfer-write-procedure.sql");

test("warehouse transfer writes paired Logo movements with proven input/output directions", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  const stlineInsertCount = [...source.matchAll(/INSERT INTO dbo\.LG_003_01_STLINE/gi)].length;

  assert.equal(stlineInsertCount, 2);
  assert.match(
    source,
    /0,\s*@StockSourceIndex,\s*@StockSourceIndex,\s*0,\s*@StockSourceIndex,\s*@StockSourceIndex,[\s\S]*?0,\s*3,\s*@StockFicheRef/i
  );
  assert.match(
    source,
    /0,\s*@StockDestIndex,\s*@StockDestIndex,\s*0,\s*@StockDestIndex,\s*@StockDestIndex,[\s\S]*?0,\s*2,\s*@StockFicheRef/i
  );
  assert.doesNotMatch(source, /DESTTYPE,\s*DESTINDEX,\s*DESTCOSTGRP[\s\S]*?3,\s*@StockDestIndex/i);
  assert.match(source, /src\.RowNo\s*\*\s*2\s*-\s*1,\s*0,\s*0,/i);
  assert.match(source, /src\.RowNo\s*\*\s*2,\s*0,\s*0,/i);
  assert.doesNotMatch(source, /MERGE\s+dbo\.LG_003_01_GNTOTST/i);
  assert.doesNotMatch(source, /MERGE\s+dbo\.LG_003_01_STINVTOT/i);
  assert.match(source, /BEGIN\s+TRANSACTION/i);
  assert.match(source, /COMMIT\s+TRANSACTION/i);
  assert.match(source, /Stok kaynak ambari olmadan sevkiyat fisi olusturulamaz/i);
  assert.match(source, /Stok hedef ambari olmadan kabul fisi olusturulamaz/i);
});

test("warehouse transfer accepts staged stock warehouses from legacy queued payloads", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(source, /source_state_meta\.transfer_source_warehouse_code/i);
  assert.match(source, /source_state_meta\.transfer_target_warehouse_code/i);
});

test("warehouse transfer resolves workplaces from Logo warehouse definitions", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(source, /FROM\s+dbo\.L_CAPIWHOUSE\s+AS\s+warehouse\s+WITH\s*\(NOLOCK\)/i);
  assert.match(source, /INNER\s+JOIN\s+dbo\.L_CAPIDIV\s+AS\s+division/i);
  assert.match(source, /division\.NR\s*=\s*TRY_CONVERT\(INT,\s*warehouse\.DIVISNR\)/i);
  assert.match(source, /WHERE\s+warehouse\.FIRMNR\s*=\s*3\s+AND\s+warehouse\.NR\s*=\s*@SourceIndex/i);
  assert.match(source, /WHERE\s+warehouse\.FIRMNR\s*=\s*3\s+AND\s+warehouse\.NR\s*=\s*@DestIndex/i);
  assert.doesNotMatch(source, /DECLARE\s+@SourceBranch\s+INT\s*=\s*CASE\s+@SourceIndex/i);
  assert.doesNotMatch(source, /DECLARE\s+@DestBranch\s+INT\s*=\s*CASE\s+@DestIndex/i);
});

test("warehouse transfer keeps source and destination header fields separate", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(source, /BRANCH,\s*DEPARTMENT,\s*COMPBRANCH,\s*COMPDEPARTMENT,\s*COMPFACTORY/i);
  assert.match(
    source,
    /0,\s*0,\s*@StockSourceIndex,\s*@StockSourceIndex,\s*@StockSourceBranch,\s*0,\s*@StockDestBranch,\s*0,\s*0,\s*0,\s*@StockDestIndex,\s*@StockDestIndex/i
  );
  assert.doesNotMatch(source, /SOURCETYPE\s*\/\s*DESTTYPE'tir/i);
});
