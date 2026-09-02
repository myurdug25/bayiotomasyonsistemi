import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dayEndService = fs.readFileSync(
  path.join(rootDir, "apps", "api", "app", "Services", "Integrations", "Logo", "LogoPosDayEndExportService.php"),
  "utf8"
);
const reportService = fs.readFileSync(
  path.join(rootDir, "apps", "api", "app", "Services", "Pos", "DayEndReportService.php"),
  "utf8"
);
const sqlProcedure = fs.readFileSync(
  path.join(rootDir, "tools", "logo-sync", "sql", "powersa-b2b-pos-day-end-write-procedure.sql"),
  "utf8"
);

test("POS day-end Logo export uses sales only and keeps collections report-only", () => {
  assert.match(dayEndService, /accounting_totals/i);
  assert.match(dayEndService, /accountingTotals\['cash_sales'\]/i);
  assert.match(dayEndService, /accountingTotals\['card_sales'\]/i);
  assert.match(dayEndService, /cash_sales_and_card_sales_only_collections_report_only/i);
  assert.doesNotMatch(dayEndService, /totals\.cash_collections/i);
  assert.doesNotMatch(dayEndService, /totals\.card_collections/i);
  assert.doesNotMatch(dayEndService, /return\s+\$cashSales\s*\+\s*\$cashCollections/i);
  assert.doesNotMatch(dayEndService, /return\s+\$cardSales\s*\+\s*\$cardCollections/i);
  assert.doesNotMatch(dayEndService, /totals\.expenses[\s\S]*return/i);
});

test("POS day-end payload keeps expenses only as report metadata", () => {
  assert.match(reportService, /'expenses'\s*=>\s*\(float\)\s*data_get\(\$report,\s*'summary\.expense_total'/i);
  assert.match(reportService, /\$paymentCashAmount\s*=\s*\(float\)\s*\(\$paymentTotals\['cash'\]/i);
  assert.match(reportService, /\$paymentCardAmount\s*=\s*\(float\)\s*\(\$paymentTotals\['card'\]/i);
  assert.doesNotMatch(reportService, /\$cashAmount\s*=\s*\(\$cashSalesAmount[\s\S]*\+\s*\$cashCollectionAmount;/i);
  assert.doesNotMatch(reportService, /\$cardAmount\s*=\s*\(\$cardSalesAmount[\s\S]*\+\s*\$cardCollectionAmount;/i);
  assert.match(reportService, /collections_report_only/i);
  assert.match(reportService, /expenses_report_only/i);
});

test("POS day-end payload carries branch retail customer accounts for Logo ledger lines", () => {
  assert.match(reportService, /cash_sale_customer/i);
  assert.match(reportService, /card_sale_customer/i);
  assert.match(reportService, /BATUM PERAKENDE NAKIT SATIS/i);
  assert.match(reportService, /ERZURUM POINT NAKIT SATIS/i);
  assert.match(reportService, /SAMSUN DEPO KREDI KARTI SATIS/i);
});

test("POS day-end cashbox is resolved from the session owner/user before session fallback", () => {
  assert.match(dayEndService, /openedBy\?\->logo_cashbox_code[\s\S]*session\->cashbox\?\->code/i);
  assert.match(dayEndService, /openedBy\?\->logo_cashbox_name[\s\S]*session\->cashbox\?\->name/i);
  assert.match(dayEndService, /record\['cashbox_code'\]\s*=\s*\$cashbox\['code'\]/i);
});

test("POS day-end SQL separates cashbox movement from credit card fiche", () => {
  assert.match(sqlProcedure, /LG_003_01_KSLINES/i);
  assert.match(sqlProcedure, /LG_003_01_CLFICHE/i);
  assert.match(sqlProcedure, /LG_003_CLCARD/i);
  assert.match(sqlProcedure, /LG_003_01_CLFLINE/i);
  assert.match(sqlProcedure, /cash_sale_customer_code/i);
  assert.match(sqlProcedure, /card_sale_customer_code/i);
  assert.match(sqlProcedure, /TRCODE,\s*GENEXP1[\s\S]*@CardFicheNo[\s\S]*70/i);
  assert.doesNotMatch(sqlProcedure, /@CardAmount[\s\S]{0,800}LG_003_01_KSLINES/i);
});

test("POS day-end cash KSLINES writes Logo edit timestamp on creation", () => {
  assert.match(sqlProcedure, /CAPIBLOCK_CREATEDHOUR,\s*CAPIBLOCK_CREATEDMIN,\s*CAPIBLOCK_CREATEDSEC,\s*CAPIBLOCK_MODIFIEDBY,\s*CAPIBLOCK_MODIFIEDDATE,\s*CAPIBLOCK_MODIFIEDHOUR,\s*CAPIBLOCK_MODIFIEDMIN,\s*CAPIBLOCK_MODIFIEDSEC,\s*DOCODE/i);
  assert.match(sqlProcedure, /@Hour,\s*@Minute,\s*@Second,\s*1,\s*@Now,\s*@Hour,\s*@Minute,\s*@Second,\s*@Docode,\s*@Now,\s*@LogoTime/i);
});

test("POS day-end cash KSLINES writes Logo balance fields", () => {
  assert.match(sqlProcedure, /LINEEXP,\s*SIGN,\s*AMOUNT,\s*TRCURR,\s*TRRATE,\s*TRNET,\s*REPORTRATE,\s*REPORTNET/i);
  assert.match(sqlProcedure, /CANCELLED,\s*STATUS,\s*AFFECTRISK,\s*BRANCH,\s*DEPARTMENT,\s*ACCREF,\s*CENTERREF/i);
  assert.match(sqlProcedure, /CASHACCREF,\s*CASHCENREF,\s*ACCFICHEREF,\s*ACCOUNTED,\s*REFLECTED/i);
  assert.match(sqlProcedure, /@CashLineExp,\s*0,\s*CONVERT\(FLOAT,\s*@CashAmount\),\s*0,\s*1,\s*CONVERT\(FLOAT,\s*@CashAmount\)/i);
});

test("POS day-end customer ledger rows write Logo totals fields", () => {
  assert.match(sqlProcedure, /REPORTNET,\s*CANCELLED,\s*STATUS,\s*MONTH_,\s*YEAR_,\s*BRANCH,\s*DEPARTMENT,\s*PAIDINCASH/i);
  assert.match(sqlProcedure, /CONVERT\(FLOAT,\s*@CashAmount\),\s*0,\s*0,\s*MONTH\(@DayEndDate\),\s*YEAR\(@DayEndDate\),\s*0,\s*0,\s*0/i);
  assert.match(sqlProcedure, /CONVERT\(FLOAT,\s*@CardAmount\),\s*0,\s*0,\s*MONTH\(@DayEndDate\),\s*YEAR\(@DayEndDate\),\s*0,\s*0,\s*0/i);
});
