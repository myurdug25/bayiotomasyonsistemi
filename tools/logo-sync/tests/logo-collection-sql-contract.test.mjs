import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.resolve(testDir, "../sql/powersa-b2b-collection-write-procedure.sql");
const orderSqlPath = path.resolve(testDir, "../sql/powersa-b2b-order-shipment-pos-write-procedure.sql");
const salespersonRepairSqlPath = path.resolve(testDir, "../sql/powersa-b2b-salesperson-backfill-repair.sql");
const headerIdentityRepairSqlPath = path.resolve(testDir, "../sql/powersa-b2b-logo-header-identity-repair.sql");

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

test("cash collection KSLINES writes Logo edit timestamp on creation", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(source, /CAPIBLOCK_CREATEDHOUR,\s*CAPIBLOCK_CREATEDMIN,\s*CAPIBLOCK_CREATEDSEC,\s*CAPIBLOCK_MODIFIEDBY,\s*CAPIBLOCK_MODIFIEDDATE,\s*CAPIBLOCK_MODIFIEDHOUR,\s*CAPIBLOCK_MODIFIEDMIN,\s*CAPIBLOCK_MODIFIEDSEC,\s*DOCODE,\s*DOCDATE,\s*TIME_/i);
  assert.match(source, /@Hour,\s*@Minute,\s*@Second,\s*1,\s*@Now,\s*@Hour,\s*@Minute,\s*@Second,\s*@Docode,\s*@Now,\s*\(\(@Hour \* 16777216\) \+ \(@Minute \* 65536\) \+ \(@Second \* 256\)\)/i);
});

test("cash collection KSLINES initial insert includes Logo balance trigger fields", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(
    source,
    /INSERT INTO dbo\.LG_003_01_KSLINES \([\s\S]*LINEEXP,\s*SIGN,\s*AMOUNT,\s*TRCURR,\s*TRRATE,\s*TRNET,\s*REPORTRATE,\s*REPORTNET,\s*CANCELLED,\s*STATUS,\s*AFFECTRISK,\s*BRANCH,\s*DEPARTMENT/i
  );
  assert.match(
    source,
    /INSERT INTO dbo\.LG_003_01_KSLINES \([\s\S]*ACCREF,\s*CENTERREF,\s*CASHACCREF,\s*CASHCENREF,\s*ACCFICHEREF,\s*ACCOUNTED,\s*REFLECTED/i
  );
  assert.match(
    source,
    /@LineExp,\s*0,\s*CONVERT\(FLOAT,\s*@Amount\),\s*0,\s*1,\s*CONVERT\(FLOAT,\s*@Amount\),\s*1,\s*CONVERT\(FLOAT,\s*@Amount\),\s*0,\s*0,\s*0,\s*0,\s*0,\s*0,\s*0,\s*0,\s*0,\s*0,\s*0,\s*0/i
  );
});

test("physical POS without factory channel is routed to credit card customer fiche", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(
    source,
    /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_WritePhysicalPosCollection/i
  );
  assert.match(
    source,
    /@NormalizedMethod = N'cc'[\s\S]{0,180}reference_fields\.collection_channel'\),\s*N''\) <> N'factory'/i
  );
  assert.match(
    source,
    /EXEC dbo\.PowersaB2B_WritePhysicalPosCollection/i
  );
  assert.match(
    source,
    /INSERT INTO dbo\.LG_003_01_CLFICHE[\s\S]*70/i
  );
  assert.match(
    source,
    /INSERT INTO dbo\.LG_003_01_CLFICHE \([\s\S]*BANKACCREF,\s*BNACCREF/i
  );
  assert.match(
    source,
    /INSERT INTO dbo\.LG_003_01_CLFLINE \([\s\S]*BANKACCREF,\s*BNACCREF,\s*BNLNTRCURR,\s*BNLNTRRATE,\s*BNLNTRNET/i
  );
  assert.match(source, /Physical POS Logo bank code is required for collection export/i);
  assert.match(source, /Physical POS Logo bank card could not be resolved for collection export/i);
  assert.match(source, /Physical POS Logo bank account could not be resolved for collection export/i);
  assert.match(source, /WHEN CODE LIKE N'%POS%' OR DEFINITION_ LIKE N'%POS%' THEN 0/i);
});

test("bank transfer is the only method routed to bank fiche", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(
    source,
    /@NormalizedMethod = N'transfer'[\s\S]{0,180}EXEC dbo\.PowersaB2B_WriteBankCollection/i
  );
  assert.doesNotMatch(
    source,
    /@NormalizedMethod IN \(N'transfer',\s*N'cc'\)/i
  );
});

test("bank transfer customer ledger line uses the Logo transfer transaction code", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(source, /DECLARE @BankClientTrcode SMALLINT = 20/i);
  assert.match(
    source,
    /@CustomerRef,\s*@BankLineRef,\s*@CollectionDate,\s*7,\s*@BankClientTrcode,\s*@FicheNo/i
  );
  assert.doesNotMatch(
    source,
    /@CustomerRef,\s*@BankLineRef,\s*@CollectionDate,\s*7,\s*3,\s*@FicheNo/i
  );
  assert.doesNotMatch(source, /DECLARE @BankClientTrcode SMALLINT = 21/i);
});

test("bank transfer writes an explicit incoming transfer line type", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(source, /DECLARE @BankLineTranstype SMALLINT = 1/i);
  assert.match(source, /DECLARE @BankLineTrcode SMALLINT = 1/i);
  assert.match(source, /DECLARE @BankProcessType SMALLINT = 2/i);
  assert.match(
    source,
    /@BankRef,\s*@BankAccountRef,\s*@CustomerRef,\s*@BankFicheRef,\s*@BankLineTranstype,\s*@CollectionDate/i
  );
  assert.match(
    source,
    /@BankLineTrcode,\s*7,\s*1,\s*@FicheNo,\s*@Docode,\s*@LineExp/i
  );
  assert.match(source, /BANKPROCTYPE,\s*BANKPROCCODE/i);
  assert.match(source, /@BankProcessType,\s*@BankProcessType/i);
  assert.doesNotMatch(
    source,
    /@BankRef,\s*@BankAccountRef,\s*@CustomerRef,\s*@BankFicheRef,\s*0,\s*@CollectionDate/i
  );
  assert.doesNotMatch(
    source,
    /0,\s*3,\s*7,\s*1,\s*@FicheNo,\s*@Docode,\s*@LineExp/i
  );
});

test("factory card collection is written as Logo virman fiche", () => {
  const source = fs.readFileSync(sqlPath, "utf8");
  const repair = fs.readFileSync(path.resolve(testDir, "../sql/powersa-b2b-bank-factory-collection-type-repair.sql"), "utf8");
  const factoryProcedure = source.match(/CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_WriteFactoryCollection[\s\S]*?^END;\r?\nGO/im)?.[0] ?? "";

  assert.match(factoryProcedure, /DECLARE @FactoryCardTrcode SMALLINT = 5/i);
  assert.match(factoryProcedure, /@FicheNo,\s*@CollectionDate,\s*@Docode,\s*@FactoryCardTrcode/i);
  assert.match(factoryProcedure, /@CustomerRef,\s*@FicheRef,\s*@CollectionDate,\s*5,\s*@FactoryCardTrcode/i);
  assert.match(factoryProcedure, /@FactoryRef,\s*@FicheRef,\s*@CollectionDate,\s*5,\s*@FactoryCardTrcode/i);
  assert.doesNotMatch(factoryProcedure, /DECLARE @FactoryCardTrcode SMALLINT = 70/i);
  assert.doesNotMatch(factoryProcedure, /@CollectionDate,\s*@Docode,\s*3,\s*CONVERT/i);
  assert.doesNotMatch(factoryProcedure, /@CollectionDate,\s*5,\s*3,\s*@FicheNo/i);
  assert.match(repair, /BNFLINE\.TRCODE 3\/4 -> 1/i);
  assert.match(repair, /BNFLINE\.BANKPROCTYPE\/BANKPROCCODE -> 2/i);
  assert.match(repair, /UPDATE l\s+SET TRANSTYPE = 1,\s+TRCODE = 1,\s+BANKPROCTYPE = 2,\s+BANKPROCCODE = 2/i);
  assert.match(repair, /CLFICHE\/CLFLINE\.TRCODE 3\/70 -> 5/i);
  assert.match(repair, /ISNULL\(f\.TRCODE,\s*0\) IN \(3,\s*70\)/i);
  assert.match(repair, /UPDATE f\s+SET TRCODE = 5/i);
  assert.match(repair, /ISNULL\(c\.TRCODE,\s*0\) IN \(3,\s*70\)/i);
  assert.match(repair, /UPDATE c\s+SET TRCODE = 5/i);
});

test("cheque and note cards write the customer title to supported Logo fields", () => {
  const source = fs.readFileSync(sqlPath, "utf8");
  const repair = fs.readFileSync(path.resolve(testDir, "../sql/powersa-b2b-cheque-note-customer-identity-repair.sql"), "utf8");

  assert.match(source, /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_ApplyCustomerTitleToCSCard/i);
  assert.match(source, /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_ApplyChequeNoteLogoDefaults/i);
  assert.match(source, /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_ApplyCustomerIdentityToCSRow/i);
  assert.match(source, /DECLARE @SetList NVARCHAR\(MAX\) = N''/i);
  assert.match(source, /COL_LENGTH\(@SqlTable,\s*N'BRANCH'\) IS NOT NULL SET @SetList \+= N', BRANCH = ISNULL\(BRANCH,\s*0\)'/i);
  assert.match(source, /COL_LENGTH\(@SqlTable,\s*N'DEPARTMENT'\) IS NOT NULL SET @SetList \+= N', DEPARTMENT = ISNULL\(DEPARTMENT,\s*0\)'/i);
  assert.match(source, /COL_LENGTH\(@SqlTable,\s*N'WFLOWCRDREF'\) IS NOT NULL SET @SetList \+= N', WFLOWCRDREF = ISNULL\(WFLOWCRDREF,\s*0\)'/i);
  assert.match(source, /COL_LENGTH\(@SqlTable,\s*N'STATUS'\) IS NOT NULL SET @SetList \+= N', STATUS = ISNULL\(STATUS,\s*0\)'/i);
  assert.match(source, /COL_LENGTH\(@SqlTable,\s*N'CARDMD'\) IS NOT NULL SET @SetList \+= N', CARDMD = CASE WHEN TRCODE IN \(1,\s*2\) AND ISNULL\(CARDMD,\s*0\) <> 5 THEN 5 ELSE CARDMD END'/i);
  assert.match(source, /COL_LENGTH\(@SqlTable,\s*N'STATUS'\) IS NOT NULL SET @SetList \+= N', STATUS = CASE WHEN TRCODE IN \(1,\s*2\) THEN 1 ELSE ISNULL\(STATUS,\s*0\) END'/i);
  assert.match(source, /COL_LENGTH\(@SqlTable,\s*N'AFFECTRISK'\) IS NOT NULL SET @SetList \+= N', AFFECTRISK = ISNULL\(AFFECTRISK,\s*1\)'/i);
  assert.match(source, /@TableName = N'dbo\.LG_003_01_CSTRANS'[\s\S]*COL_LENGTH\(@SqlTable,\s*N'CLACCREF'\) IS NOT NULL[\s\S]*SET @SetList = @SetList \+ N', CLACCREF = @CustomerRef'/i);
  assert.match(source, /N'UPDATE ' \+ @SqlTable \+ N' SET ' \+ STUFF\(@SetList,\s*1,\s*2,\s*N''\) \+ N' WHERE LOGICALREF = @LogicalRef'/i);
  assert.match(source, /COL_LENGTH\(@SqlTable,\s*N'CLACCREF'\) IS NOT NULL SET @SetList \+= N', CLACCREF = ISNULL\(CLACCREF,\s*0\)'/i);
  assert.match(source, /COL_LENGTH\(N'dbo\.LG_003_01_CSCARD',\s*N'OWING'\)/i);
  assert.match(source, /UPDATE dbo\.LG_003_01_CSCARD SET OWING = @Title WHERE LOGICALREF = @CardRef/i);
  assert.match(source, /COL_LENGTH\(N'dbo\.LG_003_01_CSCARD',\s*N'CLTRCURR'\)/i);
  assert.match(source, /CLTRCURR = ISNULL\(CLTRCURR,\s*0\)/i);
  assert.match(source, /CLTRRATE = ISNULL\(CLTRRATE,\s*0\)/i);
  assert.match(source, /CLTRNET = ISNULL\(CLTRNET,\s*0\)/i);
  assert.match(source, /COLLATCARDREF = ISNULL\(COLLATCARDREF,\s*0\)/i);
  assert.match(source, /COL_LENGTH\(@SqlTable,\s*N'CLCODE'\)/i);
  assert.match(source, /COL_LENGTH\(@SqlTable,\s*N'CLIENTCODE'\)/i);
  assert.match(source, /COL_LENGTH\(@SqlTable,\s*N'CUSTCODE'\)/i);
  assert.match(source, /COL_LENGTH\(@SqlTable,\s*N'CLTITLE'\)/i);
  assert.match(source, /COL_LENGTH\(@SqlTable,\s*N'CLIENTTITLE'\)/i);
  assert.match(source, /COL_LENGTH\(@SqlTable,\s*N'CUSTTITLE'\)/i);
  assert.match(source, /@CustomerCode = CONVERT\(NVARCHAR\(64\), CODE\)/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyCustomerTitleToCSCard\s+@CardRef,\s*@CustomerTitle,\s*@CustomerCode/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyCustomerIdentityToCSRow\s+N'dbo\.LG_003_01_CSCARD',\s*@CardRef,\s*@CustomerRef,\s*@CustomerCode,\s*@CustomerTitle/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyCustomerIdentityToCSRow\s+N'dbo\.LG_003_01_CSROLL',\s*@RollRef,\s*@CustomerRef,\s*@CustomerCode,\s*@CustomerTitle/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyChequeNoteLogoDefaults\s+N'dbo\.LG_003_01_CSROLL',\s*@RollRef/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyCustomerIdentityToCSRow\s+N'dbo\.LG_003_01_CSTRANS',\s*@TransRef,\s*@CustomerRef,\s*@CustomerCode,\s*@CustomerTitle/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyChequeNoteLogoDefaults\s+N'dbo\.LG_003_01_CSTRANS',\s*@TransRef/i);

  assert.match(repair, /PowersaB2B_ApplyCustomerIdentityToCSRow was not found/i);
  assert.match(repair, /PowersaB2B_ApplyChequeNoteLogoDefaults was not found/i);
  assert.match(repair, /PowersaB2B_ApplySalespersonToLogoRow was not found/i);
  assert.match(repair, /FROM dbo\.LG_003_01_CSROLL AS r/i);
  assert.match(repair, /INNER JOIN dbo\.LG_003_CLCARD AS c[\s\S]*c\.LOGICALREF = r\.CARDREF/i);
  assert.match(repair, /COALESCE\(c\.SPECODE4,\s*''\)/i);
  assert.match(repair, /FROM dbo\.LG_003_01_CSTRANS AS t/i);
  assert.match(repair, /INNER JOIN dbo\.LG_003_CLCARD AS c[\s\S]*c\.LOGICALREF = t\.CARDREF/i);
  assert.match(repair, /EXEC dbo\.PowersaB2B_ApplyChequeNoteLogoDefaults\s+N'dbo\.LG_003_01_CSROLL',\s*@RollRef/i);
  assert.match(repair, /EXEC dbo\.PowersaB2B_ApplyChequeNoteLogoDefaults\s+N'dbo\.LG_003_01_CSTRANS',\s*@TransRef/i);
  assert.match(repair, /EXEC dbo\.PowersaB2B_ApplySalespersonToLogoRow\s+N'dbo\.LG_003_01_CSROLL',\s*@RollRef,\s*@SalespersonCode/i);
  assert.match(repair, /EXEC dbo\.PowersaB2B_ApplySalespersonToLogoRow\s+N'dbo\.LG_003_01_CSTRANS',\s*@TransRef,\s*@SalespersonCode/i);
  assert.match(repair, /EXEC dbo\.PowersaB2B_ApplyCustomerTitleToCSCard\s+@CardRef,\s*@CustomerTitle,\s*@CustomerCode/i);
  assert.match(repair, /repaired_csroll_rows/i);
});

test("cash collection writes salesperson code to supported Logo cash and ledger rows", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(source, /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_ApplySalespersonToLogoRow/i);
  assert.match(source, /@SalespersonTable = QUOTENAME\(SCHEMA_NAME\(t\.schema_id\)\) \+ N'\.' \+ QUOTENAME\(t\.name\)/i);
  assert.match(source, /t\.name IN \(N'LG_003_SLSMAN',\s*N'LG_SLSMAN'\)/i);
  assert.match(source, /WHERE t\.name LIKE N'%SLSMAN%'/i);
  assert.match(source, /FROM ' \+ @SalespersonTable \+ N' WITH \(NOLOCK\)[\s\S]*CODE = @Code/i);
  assert.match(source, /REPLACE\(REPLACE\(REPLACE\(UPPER\(CODE\)/i);
  assert.match(source, /DEFINITION_ = @Code/i);
  assert.match(source, /@CashboxSalespersonName/i);
  assert.match(source, /SET SALESMANREF = @SalespersonRef WHERE LOGICALREF = @LogicalRef/i);
  assert.match(source, /DECLARE @SalespersonCode VARCHAR\(25\)/i);
  assert.match(source, /WHEN @TableName = N'dbo\.LG_003_01_CLFICHE' THEN N'dbo\.LG_003_01_CLFICHE'/i);
  assert.match(source, /WHEN @TableName = N'dbo\.LG_003_01_BNFICHE' THEN N'dbo\.LG_003_01_BNFICHE'/i);
  assert.match(source, /WHEN @TableName = N'dbo\.LG_003_01_CSROLL' THEN N'dbo\.LG_003_01_CSROLL'/i);
  assert.match(source, /JSON_VALUE\(@PayloadJson,\s*'\$\.salesperson\.name'\)/i);
  assert.match(source, /JSON_VALUE\(@PayloadJson,\s*'\$\.salesperson_code'\)/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplySalespersonToLogoRow\s+N'dbo\.LG_003_01_KSLINES',\s*@KslinesRef,\s*@SalespersonCode/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplySalespersonToLogoRow\s+N'dbo\.LG_003_01_CLFLINE',\s*@ClflineRef,\s*@SalespersonCode/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplySalespersonToLogoRow\s+N'dbo\.LG_003_01_CSROLL',\s*@RollRef,\s*@SalespersonCode/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplySalespersonToLogoRow\s+N'dbo\.LG_003_01_CSTRANS',\s*@TransRef,\s*@SalespersonCode/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplySalespersonToLogoRow\s+N'dbo\.LG_003_01_CLFICHE',\s*@FicheRef,\s*@SalespersonCode/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplySalespersonToLogoRow\s+N'dbo\.LG_003_01_BNFICHE',\s*@BankFicheRef,\s*@SalespersonCode/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplySalespersonToLogoRow\s+N'dbo\.LG_003_01_BNFLINE',\s*@BankLineRef,\s*@SalespersonCode/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplySalespersonToLogoRow\s+N'dbo\.LG_003_01_CLFLINE',\s*@CustomerLineRef,\s*@SalespersonCode/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplySalespersonToLogoRow\s+N'dbo\.LG_003_01_CLFLINE',\s*@FactoryLineRef,\s*@SalespersonCode/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplySalespersonToLogoRow\s+N'dbo\.LG_003_01_CLFLINE',\s*@ClientLineRef,\s*@SalespersonCode/i);
});

test("financial document headers are backfilled with customer and bank identity", () => {
  const source = fs.readFileSync(sqlPath, "utf8");
  const repair = fs.readFileSync(headerIdentityRepairSqlPath, "utf8");

  assert.match(source, /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_ApplyCustomerIdentityToLogoRow/i);
  assert.match(source, /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_ApplyBankIdentityToLogoRow/i);
  assert.match(source, /WHEN @TableName = N'dbo\.LG_003_01_CLFICHE' THEN N'dbo\.LG_003_01_CLFICHE'/i);
  assert.match(source, /WHEN @TableName = N'dbo\.LG_003_01_BNFICHE' THEN N'dbo\.LG_003_01_BNFICHE'/i);
  assert.match(source, /COL_LENGTH\(@SqlTable,\s*N'CLIENTREF'\) IS NOT NULL/i);
  assert.match(source, /COL_LENGTH\(@SqlTable,\s*N'BNACCREF'\) IS NOT NULL/i);
  assert.match(source, /COL_LENGTH\(@SqlTable,\s*N'BNACCOUNTREF'\) IS NOT NULL/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyCustomerIdentityToLogoRow\s+N'dbo\.LG_003_01_CLFICHE',\s*@FicheRef,\s*@CustomerRef/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyBankIdentityToLogoRow\s+N'dbo\.LG_003_01_CLFICHE',\s*@FicheRef,\s*@BankRef,\s*@BankAccountRef/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyCustomerIdentityToLogoRow\s+N'dbo\.LG_003_01_BNFICHE',\s*@BankFicheRef,\s*@CustomerRef/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyBankIdentityToLogoRow\s+N'dbo\.LG_003_01_BNFLINE',\s*@BankLineRef,\s*@BankRef,\s*@BankAccountRef/i);

  assert.match(repair, /PowersaB2B_ApplyCustomerIdentityToLogoRow was not found/i);
  assert.match(repair, /PowersaB2B_ApplyBankIdentityToLogoRow was not found/i);
  assert.match(repair, /FROM dbo\.LG_003_01_CLFICHE AS f/i);
  assert.match(repair, /COALESCE\(f\.GENEXP1,\s*''\) LIKE '%'\s*\+\s*b\.DEFINITION_\s*\+\s*'%'/i);
  assert.match(repair, /COALESCE\(lx\.LINEEXP,\s*''\) LIKE '%'\s*\+\s*b\.DEFINITION_\s*\+\s*'%'/i);
  assert.match(repair, /FROM dbo\.LG_003_01_BNFICHE AS f/i);
  assert.match(repair, /EXEC dbo\.PowersaB2B_ApplyCustomerIdentityToLogoRow @TableName,\s*@LogicalRef,\s*@CustomerRef/i);
  assert.match(repair, /EXEC dbo\.PowersaB2B_ApplyBankIdentityToLogoRow @TableName,\s*@LogicalRef,\s*@BankRef,\s*@BankAccountRef/i);
  assert.match(repair, /repaired_clfiche_identity_rows/i);
  assert.match(repair, /repaired_bnfline_identity_rows/i);
});

test("salesperson helper supports every Logo write table regardless of install order", () => {
  const collectionSql = fs.readFileSync(sqlPath, "utf8");
  const orderSql = fs.readFileSync(orderSqlPath, "utf8");
  const requiredTables = [
    "INVOICE",
    "STFICHE",
    "STLINE",
    "KSLINES",
    "CLFICHE",
    "CLFLINE",
    "BNFICHE",
    "BNFLINE",
    "CSROLL",
    "CSTRANS",
  ];

  for (const table of requiredTables) {
    const pattern = new RegExp(`WHEN @TableName = N'dbo\\.LG_003_01_${table}' THEN N'dbo\\.LG_003_01_${table}'`, "i");
    assert.match(collectionSql, pattern, `collection helper should support ${table}`);
    assert.match(orderSql, pattern, `order/POS helper should support ${table}`);
  }
});

test("salesperson backfill repair covers existing collection and document rows", () => {
  const repair = fs.readFileSync(salespersonRepairSqlPath, "utf8");

  assert.match(repair, /PowersaB2B_ApplySalespersonToLogoRow/i);
  for (const table of [
    "CLFICHE",
    "CLFLINE",
    "BNFICHE",
    "BNFLINE",
    "INVOICE",
    "STFICHE",
    "STLINE",
    "KSLINES",
    "CSROLL",
    "CSTRANS",
  ]) {
    assert.match(repair, new RegExp(`N'dbo\\.LG_003_01_${table}'`, "i"));
  }
  assert.match(repair, /LG_003_CLCARD[\s\S]*SPECODE4/i);
  assert.match(repair, /KASASI[\s\S]*LG_003_KSCARD/i);
});

test("cash collection marks KSLINES as cashbox inflow when Logo has a SIGN column", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(source, /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_ApplyCashboxInSign/i);
  assert.match(source, /COL_LENGTH\(N'dbo\.LG_003_01_KSLINES',\s*N'SIGN'\)/i);
  assert.match(source, /SET SIGN = 0 WHERE LOGICALREF = @KslinesRef/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyCashboxInSign @KslinesRef/i);
});

test("cash collection fills KSLINES local and report currency totals for Logo cashbox balances", () => {
  const source = fs.readFileSync(sqlPath, "utf8");
  const repair = fs.readFileSync(path.resolve(testDir, "../sql/powersa-b2b-cashbox-sign-repair.sql"), "utf8");

  assert.match(source, /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_ApplyCashboxLocalCurrencyTotals/i);
  assert.match(source, /TRCURR = ISNULL\(TRCURR,\s*0\)/i);
  assert.match(source, /TRRATE = CASE WHEN ISNULL\(TRRATE,\s*0\) = 0 THEN 1 ELSE TRRATE END/i);
  assert.match(source, /TRNET = CASE WHEN ISNULL\(TRNET,\s*0\) = 0 THEN ISNULL\(AMOUNT,\s*0\) ELSE TRNET END/i);
  assert.match(source, /REPORTRATE = CASE WHEN ISNULL\(REPORTRATE,\s*0\) = 0 THEN 1 ELSE REPORTRATE END/i);
  assert.match(source, /REPORTNET = CASE WHEN ISNULL\(REPORTNET,\s*0\) = 0 THEN ISNULL\(AMOUNT,\s*0\) ELSE REPORTNET END/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyCashboxLocalCurrencyTotals @KslinesRef/i);

  assert.match(repair, /TRCURR = ISNULL\(TRCURR,\s*0\)/i);
  assert.match(repair, /OR ISNULL\(k\.TRNET,\s*0\) = 0/i);
  assert.match(repair, /OR ISNULL\(k\.REPORTNET,\s*0\) = 0/i);
});

test("cash collection fills nullable KSLINES Logo default columns", () => {
  const source = fs.readFileSync(sqlPath, "utf8");
  const repair = fs.readFileSync(path.resolve(testDir, "../sql/powersa-b2b-cashbox-sign-repair.sql"), "utf8");

  assert.match(source, /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_ApplyCashboxLogoDefaults/i);
  assert.match(source, /ACCREF = ISNULL\(ACCREF,\s*0\)/i);
  assert.match(source, /ACCOUNTED = ISNULL\(ACCOUNTED,\s*0\)/i);
  assert.match(source, /BRANCH = ISNULL\(BRANCH,\s*0\)/i);
  assert.match(source, /DEPARTMENT = ISNULL\(DEPARTMENT,\s*0\)/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyCashboxLogoDefaults @KslinesRef/i);

  assert.match(repair, /ACCREF = CASE[\s\S]*ISNULL\(ACCREF,\s*0\)/i);
  assert.match(repair, /OR k\.ACCOUNTED IS NULL/i);
  assert.match(repair, /OR k\.BRANCH IS NULL/i);
  assert.match(repair, /OR k\.DEPARTMENT IS NULL/i);
});

test("collection-created customer ledger rows are visible to Logo balance views", () => {
  const source = fs.readFileSync(sqlPath, "utf8");
  const repair = fs.readFileSync(path.resolve(testDir, "../sql/powersa-b2b-customer-ledger-required-fields-repair.sql"), "utf8");

  assert.match(source, /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_ApplyCustomerLedgerLogoDefaults/i);
  assert.match(source, /STATUS = ISNULL\(STATUS,\s*0\)/i);
  assert.match(source, /MONTH_ = ISNULL\(MONTH_,\s*MONTH\(COALESCE\(DATE_,\s*@LedgerDate,\s*GETDATE\(\)\)\)\)/i);
  assert.match(source, /YEAR_ = ISNULL\(YEAR_,\s*YEAR\(COALESCE\(DATE_,\s*@LedgerDate,\s*GETDATE\(\)\)\)\)/i);
  assert.match(source, /BRANCH = ISNULL\(BRANCH,\s*0\)/i);
  assert.match(source, /DEPARTMENT = ISNULL\(DEPARTMENT,\s*0\)/i);
  assert.match(source, /PAIDINCASH = ISNULL\(PAIDINCASH,\s*0\)/i);
  assert.match(source, /TRNET = ISNULL\(TRNET,\s*AMOUNT\)/i);
  assert.match(source, /REPORTNET = ISNULL\(REPORTNET,\s*ISNULL\(TRNET,\s*AMOUNT\)\)/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyCustomerLedgerLogoDefaults @ClflineRef,\s*@CollectionDate/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyCustomerLedgerLogoDefaults @ClientLineRef,\s*@CollectionDate/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyCustomerLedgerLogoDefaults @CustomerLineRef,\s*@CollectionDate/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyCustomerLedgerLogoDefaults @FactoryLineRef,\s*@CollectionDate/i);

  assert.match(repair, /B2B_BACKUP_CLFLINE_REQUIRED_FIELDS_20260826/i);
  assert.match(repair, /B2B_BACKUP_CLCARD_LOWLEVEL_20260826/i);
  assert.match(repair, /LOWLEVELCODES1 = ISNULL\(LOWLEVELCODES1,\s*0\)/i);
  assert.match(repair, /STATUS = ISNULL\(STATUS,\s*0\)/i);
  assert.match(repair, /PAIDINCASH = ISNULL\(PAIDINCASH,\s*0\)/i);
});

test("cash collection refreshes Logo edit timestamp when reconciling existing rows", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(source, /CREATE OR ALTER PROCEDURE dbo\.PowersaB2B_ApplyLogoEditTimestamp/i);
  assert.match(source, /DECLARE @LogoTime INT =[\s\S]*DATEPART\(HOUR,\s*@ModifiedAt\) \* 16777216[\s\S]*DATEPART\(MINUTE,\s*@ModifiedAt\) \* 65536[\s\S]*DATEPART\(SECOND,\s*@ModifiedAt\) \* 256/i);
  assert.match(source, /SET DOCDATE = @ModifiedAt WHERE LOGICALREF = @LogicalRef/i);
  assert.match(source, /SET TIME_ = @LogoTime WHERE LOGICALREF = @LogicalRef/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyLogoEditTimestamp\s+N'dbo\.LG_003_01_KSLINES',\s*@KslinesRef,\s*@Now/i);
  assert.match(source, /EXEC dbo\.PowersaB2B_ApplyLogoEditTimestamp\s+N'dbo\.LG_003_01_CLFLINE',\s*@ClflineRef,\s*@Now/i);
});

test("paper instruments separate cheque and note Logo bordro types", () => {
  const source = fs.readFileSync(sqlPath, "utf8");

  assert.match(source, /DECLARE @NormalizedMethod NVARCHAR\(32\) = LOWER\(LTRIM\(RTRIM\(COALESCE\(@Method,\s*N''\)\)\)\)/i);
  assert.match(source, /DECLARE @IsNote BIT = CASE[\s\S]*@NormalizedMethod IN \(N'note',\s*N'senet',\s*N'promissory_note',\s*N'promissory-note',\s*N'promissorynote'\)[\s\S]*THEN 1/i);
  assert.match(source, /DECLARE @CardDoc SMALLINT = CASE WHEN @IsNote = 1 THEN 2 ELSE 1 END/i);
  assert.match(source, /DECLARE @RollCardMd SMALLINT = 5/i);
  assert.match(source, /DECLARE @RollTrcode SMALLINT = CASE WHEN @IsNote = 1 THEN 2 ELSE 1 END/i);
  assert.match(source, /DECLARE @ClientTrcode SMALLINT = CASE WHEN @IsNote = 1 THEN 62 ELSE 61 END/i);
  assert.match(source, /WHEN @NormalizedMethod IN \(N'note',\s*N'senet',\s*N'promissory_note',\s*N'promissory-note',\s*N'promissorynote'\) THEN 62/i);
  assert.match(source, /WHEN @NormalizedMethod IN \(N'check',\s*N'cheque',\s*N'cek',\s*N'çek'\) THEN 61/i);
  assert.match(source, /IF @NormalizedMethod IN \([\s\S]*N'check'[\s\S]*N'cheque'[\s\S]*N'cek'[\s\S]*N'çek'[\s\S]*N'note'[\s\S]*N'senet'[\s\S]*N'promissory_note'[\s\S]*N'promissory-note'[\s\S]*N'promissorynote'[\s\S]*\)/i);
  assert.match(source, /INSERT INTO dbo\.LG_003_01_CSROLL[\s\S]*@RollTrcode,\s*@RollCardMd/i);
  assert.match(source, /INSERT INTO dbo\.LG_003_01_CSTRANS[\s\S]*@RollTrcode,\s*1,\s*@RollCardMd/i);
  assert.match(source, /NULLIF\(JSON_VALUE\(@PayloadJson,\s*'\$\.reference_fields\.note_no'\),\s*N''\)/i);
  assert.match(source, /@CollectionDate,\s*6,\s*@ClientTrcode,\s*@RollNo/i);
  assert.match(source, /reference_fields\.portfolio_no/i);
  assert.match(source, /DECLARE @PortfolioNo VARCHAR\(16\)/i);
  assert.match(source, /@CardDoc,\s*1,\s*@PortfolioNo,\s*@DocumentNo/i);
  assert.match(source, /ABS\(CONVERT\(BIGINT,\s*CHECKSUM\(@RawPortfolioNo\)\)\)/i);
});
