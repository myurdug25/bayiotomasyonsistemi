import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.resolve(testDir, "../sql/powersa-b2b-order-shipment-pos-write-procedure.sql");
const documentsExportPath = path.resolve(testDir, "../logo-documents-export.mjs");

function procedureBody(sql, name) {
  const pattern = new RegExp(`CREATE OR ALTER PROCEDURE\\s+${name}[\\s\\S]*?\\nEND;\\s*\\nGO`, "i");
  const match = sql.match(pattern);

  assert.ok(match, `${name} procedure should exist`);

  return match[0];
}

function splitTopLevelList(source) {
  const items = [];
  let current = "";
  let depth = 0;
  let inString = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (character === "'" && next === "'") {
      current += character + next;
      index += 1;
      continue;
    }

    if (character === "'") {
      inString = !inString;
      current += character;
      continue;
    }

    if (!inString && character === "(") {
      depth += 1;
    }

    if (!inString && character === ")") {
      depth -= 1;
    }

    if (!inString && depth === 0 && character === ",") {
      items.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  if (current.trim() !== "") {
    items.push(current.trim());
  }

  return items;
}

function matchingParenEnd(source, start) {
  let depth = 0;
  let inString = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (character === "'" && next === "'") {
      index += 1;
      continue;
    }

    if (character === "'") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function insertValuesCount(body, tableName) {
  const insertStart = body.indexOf(`INSERT INTO ${tableName}`);
  assert.notEqual(insertStart, -1, `${tableName} insert should exist`);

  const valuesStart = body.indexOf("VALUES (", insertStart);
  assert.notEqual(valuesStart, -1, `${tableName} values should exist`);

  const columnsStart = body.indexOf("(", insertStart);
  const columnsEnd = matchingParenEnd(body, columnsStart);
  const valuesParenStart = body.indexOf("(", valuesStart);
  const valuesEnd = matchingParenEnd(body, valuesParenStart);
  assert.notEqual(columnsEnd, -1, `${tableName} columns should close`);
  assert.notEqual(valuesEnd, -1, `${tableName} values should close`);

  return {
    columns: splitTopLevelList(body.slice(columnsStart + 1, columnsEnd)),
    values: splitTopLevelList(body.slice(valuesParenStart + 1, valuesEnd)),
  };
}

test("shipment export writes Logo wholesale sales invoice and customer ledger movement", () => {
  const sql = fs.readFileSync(sqlPath, "utf8");
  const body = procedureBody(sql, "dbo\\.PowersaB2B_ExportShipment");

  assert.match(body, /INSERT\s+INTO\s+dbo\.LG_003_01_INVOICE/i);
  assert.match(body, /\bTRCODE,\s*FICHENO/i);
  assert.match(body, /\b2,\s*8,\s*@FicheNo/i);
  assert.match(body, /\bINVOICEREF\b/i);
  assert.match(body, /\bINVOICELNNO\b/i);
  assert.match(body, /INSERT\s+INTO\s+dbo\.LG_003_01_CLFLINE/i);
  assert.match(body, /\bMODULENR,\s*TRCODE\b/i);
  assert.match(body, /\b4,\s*38\b/i);
  assert.match(body, /SET\s+@ExternalRef\s*=\s*CONCAT\(N'INVOICE-'/i);
});

test("Logo STFICHE inserts have matching column and value counts", () => {
  const sql = fs.readFileSync(sqlPath, "utf8");

  for (const procedureName of ["dbo\\.PowersaB2B_ExportShipment", "dbo\\.PowersaB2B_ExportPosSale"]) {
    const body = procedureBody(sql, procedureName);
    const { columns, values } = insertValuesCount(body, "dbo.LG_003_01_STFICHE");

    assert.equal(values.length, columns.length, `${procedureName} STFICHE values should match columns`);
  }
});

test("documents export enables Logo required SET options before procedure execution", () => {
  const source = fs.readFileSync(documentsExportPath, "utf8");

  assert.match(source, /SET\s+ANSI_NULLS\s+ON/i);
  assert.match(source, /SET\s+QUOTED_IDENTIFIER\s+ON/i);
  assert.match(source, /SET\s+ANSI_PADDING\s+ON/i);
  assert.match(source, /SET\s+ANSI_WARNINGS\s+ON/i);
  assert.match(source, /SET\s+CONCAT_NULL_YIELDS_NULL\s+ON/i);
  assert.match(source, /SET\s+ARITHABORT\s+ON/i);
  assert.match(source, /SET\s+NUMERIC_ROUNDABORT\s+OFF/i);
});

test("Logo write procedures are created with QUOTED_IDENTIFIER ON", () => {
  const sql = fs.readFileSync(sqlPath, "utf8");

  for (const procedureName of [
    "dbo\\.PowersaB2B_BeginExport",
    "dbo\\.PowersaB2B_FinishExport",
    "dbo\\.PowersaB2B_ExportOrder",
    "dbo\\.PowersaB2B_ExportShipment",
    "dbo\\.PowersaB2B_ExportPosSale",
  ]) {
    const pattern = new RegExp(
      `SET\\s+ANSI_NULLS\\s+ON;\\s*\\nGO\\s*\\nSET\\s+QUOTED_IDENTIFIER\\s+ON;\\s*\\nGO\\s*\\nCREATE OR ALTER PROCEDURE\\s+${procedureName}`,
      "i"
    );

    assert.match(sql, pattern);
  }
});
