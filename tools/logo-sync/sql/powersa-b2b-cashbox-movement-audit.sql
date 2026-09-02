/*
  Read-only audit for B2B-created Logo cashbox movements.

  Run in LOGODB to find B2B KSLINES rows that may not show the expected Logo
  edit date, salesperson reference/code, sign, or linked customer ledger row.
  This script does not update production data.
*/

SET NOCOUNT ON;

DECLARE @SalespersonTable NVARCHAR(256) = NULL;
DECLARE @Sql NVARCHAR(MAX);
DECLARE @CashSignSelect NVARCHAR(200) = N'NULL AS cash_sign,';
DECLARE @CashSignStatus NVARCHAR(MAX) = N'';
DECLARE @SalespersonJoin NVARCHAR(MAX) = N'';
DECLARE @SalespersonSelect NVARCHAR(MAX) = N'
    CONVERT(INT, NULL) AS cash_salesman_ref,
    CONVERT(VARCHAR(25), NULL) AS salesman_code,
    CONVERT(VARCHAR(51), NULL) AS salesman_name,';
DECLARE @SalespersonStatus NVARCHAR(MAX) = N'';

SELECT TOP 1
    @SalespersonTable = QUOTENAME(SCHEMA_NAME(t.schema_id)) + N'.' + QUOTENAME(t.name)
FROM sys.tables AS t
WHERE t.name IN (N'LG_003_SLSMAN', N'LG_SLSMAN')
  AND EXISTS (SELECT 1 FROM sys.columns AS c WHERE c.object_id = t.object_id AND c.name = N'LOGICALREF')
  AND EXISTS (SELECT 1 FROM sys.columns AS c WHERE c.object_id = t.object_id AND c.name = N'CODE')
ORDER BY CASE t.name WHEN N'LG_003_SLSMAN' THEN 0 WHEN N'LG_SLSMAN' THEN 1 ELSE 2 END;

IF @SalespersonTable IS NULL
BEGIN
    SELECT TOP 1
        @SalespersonTable = QUOTENAME(SCHEMA_NAME(t.schema_id)) + N'.' + QUOTENAME(t.name)
    FROM sys.tables AS t
    WHERE t.name LIKE N'%SLSMAN%'
      AND EXISTS (SELECT 1 FROM sys.columns AS c WHERE c.object_id = t.object_id AND c.name = N'LOGICALREF')
      AND EXISTS (SELECT 1 FROM sys.columns AS c WHERE c.object_id = t.object_id AND c.name = N'CODE')
    ORDER BY CASE WHEN t.name LIKE N'LG[_]%' THEN 0 ELSE 1 END, t.name;
END;

IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'SIGN') IS NOT NULL
BEGIN
    SET @CashSignSelect = N'k.SIGN AS cash_sign,';
    SET @CashSignStatus = N'
        WHEN k.SIGN IS NULL THEN N''MISSING_CASH_SIGN''
        WHEN k.TRCODE = 11 AND k.SIGN <> 0 THEN N''UNEXPECTED_CASH_IN_SIGN''';
END;

IF @SalespersonTable IS NOT NULL AND COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'SALESMANREF') IS NOT NULL
BEGIN
    SET @SalespersonJoin = N'
LEFT JOIN ' + @SalespersonTable + N' AS salesman WITH (NOLOCK)
    ON salesman.LOGICALREF = k.SALESMANREF';
    SET @SalespersonSelect = N'
    k.SALESMANREF AS cash_salesman_ref,
    salesman.CODE AS salesman_code,
    salesman.DEFINITION_ AS salesman_name,';
    SET @SalespersonStatus = N'
        WHEN ISNULL(k.SALESMANREF, 0) = 0 THEN N''MISSING_SALESMANREF''';
END;

SET @Sql = N'
SELECT TOP (500)
    k.LOGICALREF AS kslines_ref,
    k.CARDREF AS cashbox_ref,
    cashbox.CODE AS cashbox_code,
    cashbox.NAME AS cashbox_name,
    k.FICHENO AS cash_fiche_no,
    k.DOCODE AS document_no,
    k.SPECODE AS special_code,
    k.CYPHCODE AS auth_code,
    k.TRCODE AS cash_trcode,
    ' + @CashSignSelect + N'
    k.DATE_ AS cash_date,
    k.AMOUNT AS cash_amount,
    k.CANCELLED AS cash_cancelled,
    k.TRANSREF AS linked_clfline_ref,
    cl.LOGICALREF AS clfline_ref,
    cl.CLIENTREF AS customer_ref,
    customer.CODE AS customer_code,
    customer.DEFINITION_ AS customer_title,
    cl.MODULENR AS customer_modulenr,
    cl.TRCODE AS customer_trcode,
    cl.SIGN AS customer_sign,
    cl.AMOUNT AS customer_amount,
    k.CAPIBLOCK_MODIFIEDDATE AS cash_modified_date,
    k.CAPIBLOCK_MODIFIEDHOUR AS cash_modified_hour,
    k.CAPIBLOCK_MODIFIEDMIN AS cash_modified_minute,
    k.CAPIBLOCK_MODIFIEDSEC AS cash_modified_second,' + @SalespersonSelect + N'
    CASE
        WHEN k.CAPIBLOCK_MODIFIEDDATE IS NULL THEN N''MISSING_MODIFIED_DATE''' + @CashSignStatus + @SalespersonStatus + N'
        WHEN cl.LOGICALREF IS NULL THEN N''MISSING_LINKED_CLFLINE''
        WHEN cl.SIGN <> 1 THEN N''UNEXPECTED_CUSTOMER_SIGN''
        ELSE N''OK''
    END AS audit_status
FROM dbo.LG_003_01_KSLINES AS k WITH (NOLOCK)
LEFT JOIN dbo.LG_003_KSCARD AS cashbox WITH (NOLOCK)
    ON cashbox.LOGICALREF = k.CARDREF
LEFT JOIN dbo.LG_003_01_CLFLINE AS cl WITH (NOLOCK)
    ON cl.LOGICALREF = k.TRANSREF
LEFT JOIN dbo.LG_003_CLCARD AS customer WITH (NOLOCK)
    ON customer.LOGICALREF = cl.CLIENTREF' + @SalespersonJoin + N'
WHERE (
        k.FICHENO LIKE ''B2B-%''
        OR k.FICHENO LIKE ''%B2B-%''
        OR k.SPECODE LIKE ''B2B-%''
        OR k.DOCODE LIKE ''B2B-%''
    )
  AND ISNULL(k.CANCELLED, 0) = 0
ORDER BY k.DATE_ DESC, k.LOGICALREF DESC;';

EXEC sys.sp_executesql @Sql;
