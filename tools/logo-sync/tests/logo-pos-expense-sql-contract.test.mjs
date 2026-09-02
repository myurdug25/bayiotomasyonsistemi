import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.resolve(testDir, "../sql/powersa-b2b-pos-expense-write-procedure.sql");
const exporterPath = path.resolve(testDir, "../logo-pos-expenses-export.mjs");

test("POS expenses create both cashbox movement and expense customer ledger movement", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(source, /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_ExportPosExpense/i);
  assert.match(source, /INSERT INTO dbo\.LG_003_01_KSLINES/i);
  assert.match(source, /@ExpenseClientRef/i);
  assert.match(source, /FROM dbo\.LG_003_CLCARD[\s\S]*CODE = CONVERT\(VARCHAR\(25\), @AccountCode\)/i);
  assert.match(source, /@AccountCode IS NOT NULL AND @ExpenseClientRef IS NULL/i);
  assert.match(source, /Logo expense customer card could not be resolved/i);
  assert.match(source, /INSERT INTO dbo\.LG_003_01_CLFLINE/i);
  assert.match(source, /SET @ExternalRef = CONCAT\(/i);
  assert.match(source, /CONCAT\(N'KSLINES-', @KslinesRef\)/i);
  assert.match(source, /CONCAT\(N'-CLFLINE-', @ExpenseClflineRef\)/i);
});

test("POS expense exporter keeps fallback account code fields for Logo cari mapping", () => {
  const source = fs.readFileSync(exporterPath, "utf8");

  assert.match(source, /nullable\(record\.logo\?\.account_code\)/i);
  assert.match(source, /nullable\(record\.expense_account_code\)/i);
  assert.match(source, /nullable\(record\.logo_expense_account_code\)/i);
  assert.match(source, /source_meta\?\.logo_expense_account_code/i);
  assert.match(source, /const accountName\s*=/i);
  assert.match(source, /logo_expense_account_name:\s*accountName/i);
  assert.match(source, /nullable\(record\.meta\?\.source_meta\?\.cashbox_code\)/i);
  assert.match(source, /nullable\(record\.meta\?\.cashbox\?\.code\)/i);
  assert.match(source, /request\.input\("accountCode",\s*sql\.NVarChar\(64\),\s*accountCode\)/i);
  assert.match(source, /request\.input\("cashboxCode",\s*sql\.NVarChar\(64\),\s*cashboxCode\)/i);
});

test("POS expenses can use a selected bank source without losing gider cari movement", () => {
  const sqlSource = fs.readFileSync(sqlPath, "utf8");
  const exporterSource = fs.readFileSync(exporterPath, "utf8");

  assert.match(exporterSource, /payment_source_type:\s*paymentSourceType/i);
  assert.match(exporterSource, /bank_account_logo_code:\s*bankAccountCode/i);
  assert.match(exporterSource, /bank_expense_mode:\s*Boolean\(record\.bank_expense_mode\)/i);

  assert.match(sqlSource, /DECLARE @UseBankSource BIT = 0/i);
  assert.match(sqlSource, /DECLARE @UseCashboxSource BIT = 1/i);
  assert.match(sqlSource, /INSERT INTO dbo\.LG_003_01_BNFICHE/i);
  assert.match(sqlSource, /INSERT INTO dbo\.LG_003_01_BNFLINE/i);
  assert.match(sqlSource, /DECLARE @BankLineTranstype SMALLINT = 1/i);
  assert.match(sqlSource, /DECLARE @BankLineTrcode SMALLINT = 1/i);
  assert.match(sqlSource, /DECLARE @BankProcessType SMALLINT = 2/i);
  assert.match(sqlSource, /@BankRef,\s*@BankAccountRef,\s*@ExpenseClientRef,\s*@BankFicheRef,\s*@BankLineTranstype,\s*@ExpenseDate/i);
  assert.match(sqlSource, /@BankLineTrcode,\s*7,\s*1,\s*@FicheNo,\s*@Docode,\s*@LineExp/i);
  assert.match(sqlSource, /BANKPROCTYPE,\s*BANKPROCCODE/i);
  assert.match(sqlSource, /@BankProcessType,\s*@BankProcessType/i);
  assert.match(sqlSource, /Logo bank movement could not be verified/i);
  assert.match(sqlSource, /LOGICALREF = @BankLineRef[\s\S]*BANKREF = @BankRef[\s\S]*BNACCREF = @BankAccountRef/i);
  assert.match(sqlSource, /DECLARE @ClientSourceRef INT = COALESCE\(@KslinesRef, @BankLineRef\)/i);
  assert.match(sqlSource, /@ExpenseClientRef, @ClientSourceRef, @ExpenseDate, @ClientModuleNr, @ClientTrcode/i);
  assert.match(sqlSource, /CONCAT\(N'BNFLINE-', @BankLineRef\)/i);
});

test("Batum bank cash-out uses a dedicated cashbox to bank transfer mode", () => {
  const sqlSource = fs.readFileSync(sqlPath, "utf8");
  const exporterSource = fs.readFileSync(exporterPath, "utf8");

  assert.match(exporterSource, /operation_type:\s*record\.operation_type/i);
  assert.match(exporterSource, /bank_transfer_mode:\s*Boolean/i);
  assert.match(sqlSource, /DECLARE @BankTransferMode BIT = 0/i);
  assert.match(sqlSource, /LOWER\(COALESCE\(@OperationType, N''\)\) = N'cash_to_bank'/i);
  assert.match(sqlSource, /WHEN @BankTransferMode = 1 THEN 1/i);
  assert.match(sqlSource, /@UseBankSource = 1 OR @BankTransferMode = 1/i);
  assert.match(sqlSource, /@ExpenseClientRef IS NOT NULL AND @BankTransferMode = 0/i);
  assert.match(
    sqlSource,
    /IF @BankTransferMode = 1[\s\S]*INSERT INTO dbo\.LG_003_01_KSLINES \(\s*CARDREF,\s*DATE_/i
  );
  assert.match(sqlSource, /CASE WHEN @BankTransferMode = 1 THEN 0 ELSE 1 END/i);
  assert.match(
    sqlSource,
    /@ExpenseDate,\s*@FicheNo,\s*CASE WHEN @BankTransferMode = 1 THEN 3 ELSE 4 END,\s*7/i
  );
  assert.match(
    sqlSource,
    /@BankLineTrcode,\s*7,\s*1,\s*@FicheNo/i
  );
});

test("POS expense bank slips write salesperson metadata on header and line", () => {
  const sqlSource = fs.readFileSync(sqlPath, "utf8");

  assert.match(sqlSource, /DECLARE @SalespersonCode VARCHAR\(25\)/i);
  assert.match(sqlSource, /JSON_VALUE\(@PayloadJson,\s*'\$\.salesperson_code'\)/i);
  assert.match(sqlSource, /JSON_VALUE\(@PayloadJson,\s*'\$\.created_by_name'\)/i);
  assert.match(
    sqlSource,
    /PowersaB2B_ApplySalespersonToLogoRow N'dbo\.LG_003_01_BNFICHE', @BankFicheRef, @SalespersonCode/i
  );
  assert.match(
    sqlSource,
    /PowersaB2B_ApplySalespersonToLogoRow N'dbo\.LG_003_01_BNFLINE', @BankLineRef, @SalespersonCode/i
  );
});

test("POS expense SQL resolves the explicit cashbox and never falls back to the first active cashbox", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(source, /JSON_VALUE\(@PayloadJson,\s*'\$\.meta\.source_meta\.cashbox_code'\)/i);
  assert.match(source, /JSON_VALUE\(@PayloadJson,\s*'\$\.meta\.cashbox\.code'\)/i);
  assert.match(source, /WHERE NAME = CONVERT\(VARCHAR\(51\), @CashboxName\)/i);
  assert.match(source, /Check cashbox_code\/cashbox_name/i);
  assert.doesNotMatch(source, /FROM dbo\.LG_003_KSCARD[\s\S]{0,180}ORDER BY LOGICALREF/i);
});

test("POS expense cash KSLINES writes Logo edit timestamp on creation", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(source, /CAPIBLOCK_CREATEDHOUR,\s*CAPIBLOCK_CREATEDMIN,\s*CAPIBLOCK_CREATEDSEC,\s*CAPIBLOCK_MODIFIEDBY,\s*CAPIBLOCK_MODIFIEDDATE,\s*CAPIBLOCK_MODIFIEDHOUR,\s*CAPIBLOCK_MODIFIEDMIN,\s*CAPIBLOCK_MODIFIEDSEC,\s*DOCODE/i);
  assert.match(source, /@Hour,\s*@Minute,\s*@Second,\s*1,\s*@Now,\s*@Hour,\s*@Minute,\s*@Second,\s*@Docode/i);
});

test("POS expense SQL does not force any branch to a fixed cashbox code", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.doesNotMatch(source, /SET @CashboxCode = N'100\.04\.001'/i);
  assert.doesNotMatch(source, /SET @CashboxName = N'BATUM MERKEZ KASASI'/i);
  assert.match(source, /WHERE CODE = CONVERT\(VARCHAR\(25\), @CashboxCode\)/i);
  assert.match(source, /WHERE NAME = CONVERT\(VARCHAR\(51\), @CashboxName\)/i);
});

test("POS expense accounting voucher descriptions respect the live Logo GENEXP1 limit", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(
    source,
    /10,\s*@KslinesRef,\s*CONVERT\(VARCHAR\(51\),\s*LEFT\(@LineExp,\s*51\)\)/i
  );
});
