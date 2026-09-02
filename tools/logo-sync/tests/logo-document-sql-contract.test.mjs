import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.resolve(testDir, "../sql/powersa-b2b-order-shipment-pos-write-procedure.sql");
const documentsExportPath = path.resolve(testDir, "../logo-documents-export.mjs");
const daemonPath = path.resolve(testDir, "../logo-sync-daemon.mjs");

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

test("POS sale invoice and delivery note are created with edit timestamps and blank auth code", () => {
  const sql = fs.readFileSync(sqlPath, "utf8");
  const body = procedureBody(sql, "dbo\\.PowersaB2B_ExportPosSale");

  const invoiceInsertStart = body.indexOf("INSERT INTO dbo.LG_003_01_INVOICE");
  const stficheInsertStart = body.indexOf("INSERT INTO dbo.LG_003_01_STFICHE", invoiceInsertStart);
  const invoiceBlock = body.slice(invoiceInsertStart, stficheInsertStart);
  const stficheBlock = body.slice(stficheInsertStart, body.indexOf("SET @StockFicheRef = SCOPE_IDENTITY();", stficheInsertStart));

  assert.match(invoiceBlock, /CAPIBLOCK_MODIFIEDBY,\s*CAPIBLOCK_MODIFIEDDATE,\s*CAPIBLOCK_MODIFIEDHOUR,\s*CAPIBLOCK_MODIFIEDMIN,\s*CAPIBLOCK_MODIFIEDSEC/i);
  assert.match(invoiceBlock, /2,\s*8,\s*@FicheNo,\s*@SaleDate,\s*@Docode,\s*@Specode,\s*N''\s*,\s*@CustomerRef/i);
  assert.match(invoiceBlock, /1,\s*@Now,\s*@Hour,\s*@Minute,\s*@Second,\s*1\s*,\s*@Now,\s*@Hour,\s*@Minute,\s*@Second,\s*1/i);

  assert.match(stficheBlock, /CAPIBLOCK_MODIFIEDBY,\s*CAPIBLOCK_MODIFIEDDATE,\s*CAPIBLOCK_MODIFIEDHOUR,\s*CAPIBLOCK_MODIFIEDMIN,\s*CAPIBLOCK_MODIFIEDSEC/i);
  assert.match(stficheBlock, /2,\s*8,\s*4,\s*@StockFicheNo,\s*@SaleDate,\s*0,\s*@Docode,\s*@Specode,\s*N''\s*,/i);
  assert.match(stficheBlock, /1,\s*@Now,\s*@Hour,\s*@Minute,\s*@Second,\s*1,\s*@Now,\s*@Hour,\s*@Minute,\s*@Second,/i);
});

test("normal return export zeroes Logo VAT before totals and lines are written", () => {
  const returnSqlPath = path.resolve(testDir, "../sql/powersa-b2b-return-write-procedure.sql");
  const source = fs.readFileSync(returnSqlPath, "utf8");

  assert.match(source, /UPDATE\s+@Lines\s+SET\s+VatRate\s*=\s*0,\s*VatAmount\s*=\s*0/i);
  assert.doesNotMatch(source, /SET\s+VatAmount\s*=\s*LineTotal\s*\*\s*VatRate\s*\/\s*100/i);
  assert.match(source, /@VatTotal\s*=\s*COALESCE\(SUM\(VatAmount\),\s*0\)/i);
  assert.match(source, /CONVERT\(FLOAT,\s*src\.VatRate\),\s*CONVERT\(FLOAT,\s*src\.VatAmount\)/i);
});

test("return scrap export rejects empty rows and writes fire slip lines without VAT", () => {
  const scrapSqlPath = path.resolve(testDir, "../sql/powersa-b2b-return-scrap-write-procedure.sql");
  const source = fs.readFileSync(scrapSqlPath, "utf8");

  assert.match(source, /IF\s+NOT\s+EXISTS\s*\(SELECT\s+1\s+FROM\s+@Lines\s+WHERE\s+Quantity\s*>\s*0\)/i);
  assert.match(source, /THROW\s+51021,\s*'Return scrap export requires at least one item with quantity greater than zero\.'/i);
  assert.match(source, /IF\s+EXISTS\s*\(SELECT\s+1\s+FROM\s+@Lines\s+WHERE\s+Quantity\s*<=\s*0\)/i);
  assert.match(source, /THROW\s+51022,\s*'Return scrap export item quantity must be greater than zero\.'/i);
  assert.match(
    source,
    /COALESCE\(src\.UomRef,\s*0\),\s*COALESCE\(src\.UsRef,\s*0\),\s*1,\s*1,\s*0,\s*0,\s*0,\s*CONVERT\(FLOAT,\s*src\.LineTotal\)/i
  );
  assert.match(source, /STFICHEREF,\s*STFICHELNNO,\s*INVOICEREF,\s*INVOICELNNO/i);
  assert.match(source, /LPRODSTAT,\s*RECSTATUS,\s*MONTH_,\s*YEAR_,\s*STATUS/i);
  assert.match(source, /UPDATE dbo\.LG_003_01_STLINE SET '\s*\+\s*QUOTENAME\(c\.name\)/i);
});

test("return scrap line repair rebuilds existing fire slip details from export payload", () => {
  const repairSqlPath = path.resolve(testDir, "../sql/powersa-b2b-return-scrap-lines-repair.sql");
  const source = fs.readFileSync(repairSqlPath, "utf8");

  assert.match(source, /DOCUMENT_TYPE\s*=\s*N'return-scrap'/i);
  assert.match(source, /CROSS APPLY OPENJSON\(logs\.PAYLOAD_JSON,\s*'\$\.items'\)/i);
  assert.match(source, /DELETE lines[\s\S]*FROM dbo\.LG_003_01_STLINE AS lines[\s\S]*stage\.StockFicheRef = lines\.STFICHEREF/i);
  assert.match(source, /INSERT INTO dbo\.LG_003_01_STLINE/i);
  assert.match(source, /STFICHEREF,\s*STFICHELNNO,\s*INVOICEREF,\s*INVOICELNNO/i);
  assert.match(source, /LPRODSTAT,\s*RECSTATUS,\s*MONTH_,\s*YEAR_,\s*STATUS/i);
  assert.match(source, /#ReturnScrapRefs/i);
});

test("POS delivery note export uses a non-invoice dispatch fiche number", () => {
  const sql = fs.readFileSync(sqlPath, "utf8");
  const body = procedureBody(sql, "dbo\\.PowersaB2B_ExportPosSale");

  assert.match(body, /DECLARE\s+@DeliveryFichePrefix\s+CHAR\(1\)\s*=\s*CASE/i);
  assert.match(body, /WHEN\s+@SourceIndex\s*=\s*4\s+THEN\s+'H'/i);
  assert.match(body, /WHEN\s+@SourceIndex\s*=\s*3\s+THEN\s+'S'/i);
  assert.match(body, /WHEN\s+@SourceIndex\s*=\s*2\s+THEN\s+'T'/i);
  assert.match(body, /ELSE\s+'A'/i);
  assert.match(body, /FROM\s+dbo\.LG_003_01_STFICHE\s+WITH\s*\(UPDLOCK,\s*HOLDLOCK\)/i);
  assert.match(body, /LEN\(FICHENO\)\s*=\s*16/i);
  assert.match(body, /SUBSTRING\(FICHENO,\s*2,\s*15\)/i);
  assert.match(body, /LEFT\(FICHENO,\s*1\)\s*=\s*@DeliveryFichePrefix/i);
  assert.match(body, /@DeliveryFichePrefix\s*\+\s*RIGHT\(REPLICATE\('0',\s*15\)/i);
  assert.match(body, /\b2,\s*8,\s*4,\s*@StockFicheNo,\s*@SaleDate/i);
  assert.match(body, /CASE\s+WHEN\s+@IsInvoice\s*=\s*1\s+THEN\s+1\s+ELSE\s+0\s+END/i);
});

test("POS sale export writes stock-effective rows and maps Batum to its Logo branch", () => {
  const sql = fs.readFileSync(sqlPath, "utf8");
  const body = procedureBody(sql, "dbo\\.PowersaB2B_ExportPosSale");

  assert.match(body, /@CashboxCode\s*=\s*'100\.04\.001'/i);
  assert.match(body, /WHEN\s+4\s+THEN\s+3\s+--\s*Batum/i);
  assert.match(body, /YEAR_\s*,\s*STATUS\s*,\s*RECSTATUS/i);
  assert.match(body, /YEAR\(@SaleDate\)\s*,\s*0\s*,\s*2/i);
});

test("POS sale export normalizes Logo balance fields for customer and cashbox movements", () => {
  const sql = fs.readFileSync(sqlPath, "utf8");
  const body = procedureBody(sql, "dbo\\.PowersaB2B_ExportPosSale");
  const repair = fs.readFileSync(path.resolve(testDir, "../sql/powersa-b2b-cashbox-sign-repair.sql"), "utf8");

  assert.match(sql, /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_ApplyCashboxInSign/i);
  assert.match(sql, /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_ApplyCashboxLocalCurrencyTotals/i);
  assert.match(sql, /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_ApplyCashboxLogoDefaults/i);
  assert.match(sql, /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_ApplyCustomerLedgerLogoDefaults/i);

  assert.match(body, /EXEC dbo\.PowersaB2B_ApplyCustomerLedgerLogoDefaults\s+@ClflineRef,\s*@SaleDate/i);
  assert.match(body, /EXEC dbo\.PowersaB2B_ApplyCashboxInSign\s+@KslinesRef/i);
  assert.match(body, /EXEC dbo\.PowersaB2B_ApplyCashboxLocalCurrencyTotals\s+@KslinesRef/i);
  assert.match(body, /EXEC dbo\.PowersaB2B_ApplyCashboxLogoDefaults\s+@KslinesRef/i);
  assert.match(body, /EXEC dbo\.PowersaB2B_ApplyCustomerLedgerLogoDefaults\s+@PaymentClflineRef,\s*@SaleDate/i);

  assert.match(repair, /WHERE k\.TRCODE = 11/i);
  assert.doesNotMatch(repair, /k\.SPECODE LIKE 'B2B-COL-%'/i);
});

test("POS sale export writes salesperson code to Logo invoice, dispatch, cashbox and ledger rows", () => {
  const sql = fs.readFileSync(sqlPath, "utf8");
  const body = procedureBody(sql, "dbo\\.PowersaB2B_ExportPosSale");

  assert.match(sql, /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_ApplySalespersonToLogoRow/i);
  assert.match(sql, /WHEN @TableName = N'dbo\.LG_003_01_INVOICE' THEN N'dbo\.LG_003_01_INVOICE'/i);
  assert.match(sql, /WHEN @TableName = N'dbo\.LG_003_01_STFICHE' THEN N'dbo\.LG_003_01_STFICHE'/i);
  assert.match(sql, /WHEN @TableName = N'dbo\.LG_003_01_STLINE' THEN N'dbo\.LG_003_01_STLINE'/i);
  assert.match(sql, /WHEN @TableName = N'dbo\.LG_003_01_KSLINES' THEN N'dbo\.LG_003_01_KSLINES'/i);
  assert.match(sql, /WHEN @TableName = N'dbo\.LG_003_01_CLFLINE' THEN N'dbo\.LG_003_01_CLFLINE'/i);
  assert.match(sql, /JSON_VALUE\(@PayloadJson,\s*'\$\.salesperson\.name'\)/i);
  assert.match(sql, /JSON_VALUE\(@PayloadJson,\s*'\$\.salesperson_code'\)/i);

  assert.match(body, /DECLARE @SalespersonCode VARCHAR\(25\)/i);
  assert.match(body, /EXEC dbo\.PowersaB2B_ApplySalespersonToLogoRow\s+N'dbo\.LG_003_01_INVOICE',\s*@InvoiceRef,\s*@SalespersonCode/i);
  assert.match(body, /EXEC dbo\.PowersaB2B_ApplySalespersonToLogoRow\s+N'dbo\.LG_003_01_STFICHE',\s*@StockFicheRef,\s*@SalespersonCode/i);
  assert.match(body, /UPDATE dbo\.LG_003_01_STLINE[\s\S]*SALESMANREF = @SalespersonRef[\s\S]*STFICHEREF = @StockFicheRef/i);
  assert.match(body, /EXEC dbo\.PowersaB2B_ApplySalespersonToLogoRow\s+N'dbo\.LG_003_01_CLFLINE',\s*@ClflineRef,\s*@SalespersonCode/i);
  assert.match(body, /EXEC dbo\.PowersaB2B_ApplySalespersonToLogoRow\s+N'dbo\.LG_003_01_KSLINES',\s*@KslinesRef,\s*@SalespersonCode/i);
  assert.match(body, /EXEC dbo\.PowersaB2B_ApplySalespersonToLogoRow\s+N'dbo\.LG_003_01_CLFLINE',\s*@PaymentClflineRef,\s*@SalespersonCode/i);
});

test("POS delivery note export can update an existing Logo STFICHE instead of returning the old ref", () => {
  const sql = fs.readFileSync(sqlPath, "utf8");
  const body = procedureBody(sql, "dbo\\.PowersaB2B_ExportPosSale");

  assert.match(body, /@ExistingPosSaleOperation\s+NVARCHAR\(32\)/i);
  assert.match(body, /@ExistingPosSaleExternalRef\s+NVARCHAR\(128\)/i);
  assert.match(body, /@IsDeliveryUpdate\s+BIT/i);
  assert.match(body, /AND\s+@IsDeliveryUpdate\s*=\s*0[\s\S]*SET\s+@ExternalRef\s*=\s*@ExistingExternalRef;[\s\S]*RETURN;/i);
  assert.match(body, /DELETE\s+FROM\s+dbo\.LG_003_01_STLINE\s+WHERE\s+STFICHEREF\s*=\s*@StockFicheRef/i);
  assert.match(body, /UPDATE\s+dbo\.LG_003_01_STFICHE[\s\S]*WHERE\s+LOGICALREF\s*=\s*@StockFicheRef/i);
  assert.match(body, /OLD\.Quantity,\s*0\)\s*-\s*COALESCE\(NEW\.Quantity,\s*0\)/i);
});

test("POS delivery note update normalizes rewritten STFICHE and STLINE rows before finishing", () => {
  const sql = fs.readFileSync(sqlPath, "utf8");
  const body = procedureBody(sql, "dbo\\.PowersaB2B_ExportPosSale");
  const updateStart = body.indexOf("IF @IsDeliveryUpdate = 1");
  const finishStart = body.indexOf("EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;", updateStart);
  const updateBlock = body.slice(updateStart, finishStart);

  assert.match(updateBlock, /LG_003_01_STFICHE[\s\S]*WHERE\s+LOGICALREF\s*=\s*@Ref\s+AND[\s\S]*IS\s+NULL/i);
  assert.match(updateBlock, /EXEC\s+sp_executesql\s+@NormalizeSql,\s*N'@Ref INT',\s*@Ref\s*=\s*@StockFicheRef/i);
  assert.match(updateBlock, /LG_003_01_STLINE[\s\S]*WHERE\s+STFICHEREF\s*=\s*@Ref\s+AND[\s\S]*IS\s+NULL/i);
});

test("POS delivery note export can delete a synced Logo STFICHE without losing the export queue", () => {
  const sql = fs.readFileSync(sqlPath, "utf8");
  const body = procedureBody(sql, "dbo\\.PowersaB2B_ExportPosSale");
  const deleteStart = body.indexOf("IF @IsDeliveryDelete = 1");
  const deleteEnd = body.indexOf("DECLARE @Lines TABLE", deleteStart);
  const deleteBlock = body.slice(deleteStart, deleteEnd);

  assert.match(body, /@IsDeliveryDelete\s+BIT/i);
  assert.match(body, /@ExistingPosSaleOperation\s*=\s*N'delete'/i);
  assert.match(deleteBlock, /UPDATE\s+dbo\.LG_003_01_STFICHE[\s\S]*SET\s+CANCELLED\s*=\s*1[\s\S]*WHERE\s+LOGICALREF\s*=\s*@StockFicheRef/i);
  assert.match(deleteBlock, /UPDATE\s+dbo\.LG_003_01_STLINE[\s\S]*SET\s+CANCELLED\s*=\s*1[\s\S]*WHERE\s+STFICHEREF\s*=\s*@StockFicheRef/i);
  assert.match(deleteBlock, /LG_003_01_GNTOTST[\s\S]*ONHAND\s*=\s*ONHAND\s*\+\s*source\.QuantityDelta/i);
  assert.match(deleteBlock, /LG_003_01_STINVTOT[\s\S]*ONHAND\s*=\s*ONHAND\s*\+\s*source\.QuantityDelta/i);
  assert.match(deleteBlock, /EXEC\s+dbo\.PowersaB2B_FinishExport\s+@ExportKey,\s*@ExternalRef/i);
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

test("sync daemon enables documents export for warehouse-transfer-only configuration", () => {
  const source = fs.readFileSync(daemonPath, "utf8");

  assert.match(source, /LOGO_WAREHOUSE_TRANSFER_EXPORT_PROCEDURE/);
  assert.match(source, /POWERSA_WAREHOUSE_TRANSFERS_PENDING_URL/);
});

test("warehouse transfer queue is processed before slower document queues", () => {
  const source = fs.readFileSync(documentsExportPath, "utf8");
  const stepsStart = source.indexOf("export function buildSteps");
  const warehouseStep = source.indexOf('key: "warehouse-transfers"', stepsStart);
  const orderStep = source.indexOf('key: "orders"', stepsStart);
  const shipmentStep = source.indexOf('key: "shipments"', stepsStart);

  assert.notEqual(warehouseStep, -1);
  assert.ok(warehouseStep < orderStep, "warehouse transfers should be checked before orders");
  assert.ok(warehouseStep < shipmentStep, "warehouse transfers should be checked before shipments");
});

test("order export carries the configured shipping fee into Logo order expenses", () => {
  const sql = fs.readFileSync(sqlPath, "utf8");
  const body = procedureBody(sql, "dbo\\.PowersaB2B_ExportOrder");

  assert.match(body, /JSON_VALUE\(@PayloadJson,\s*'\$\.shipping_fee_amount'\)/i);
  assert.match(
    body,
    /CONVERT\(FLOAT,\s*@ShippingFee\),\s*CONVERT\(FLOAT,\s*@ShippingFee\),\s*CONVERT\(FLOAT,\s*@VatTotal\)/i
  );
});
