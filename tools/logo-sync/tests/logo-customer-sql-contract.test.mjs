import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.resolve(testDir, "../sql/powersa-b2b-customer-write-procedure.sql");

test("customer export writes customer code to Logo DEFINITION2", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(
    source,
    /DECLARE\s+@Definition2\s+VARCHAR\(201\)\s*=\s*CONVERT\(VARCHAR\(201\),\s*LEFT\(@Code,\s*201\)\)/i
  );
  assert.doesNotMatch(
    source,
    /DECLARE\s+@Definition2\s+VARCHAR\(201\)[\s\S]{0,160}@ContactName/i
  );
  assert.match(source, /DEFINITION_\s*=\s*@Definition/i);
  assert.match(source, /DEFINITION2\s*=\s*@Definition2/i);
  assert.match(source, /export_log\.DOCUMENT_TYPE\s*=\s*N'customer'/i);
  assert.match(source, /WHERE\s+ISNULL\(card\.DEFINITION2,\s*''\)\s*<>\s*card\.CODE/i);
});
