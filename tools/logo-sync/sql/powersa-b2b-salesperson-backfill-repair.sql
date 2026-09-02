/*
Backfill Logo salesperson fields for existing B2B-created documents.

Run after both write procedure files so dbo.PowersaB2B_ApplySalespersonToLogoRow
supports every Logo table below. This script does not create new documents; it
only fills salesperson fields on existing rows where the customer/cashbox context
already identifies the responsible Logo salesperson.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'dbo.PowersaB2B_ApplySalespersonToLogoRow', N'P') IS NULL
BEGIN
    RAISERROR('PowersaB2B_ApplySalespersonToLogoRow was not found. Install write procedures first.', 16, 1);
    RETURN;
END;

IF OBJECT_ID(N'dbo.LG_003_CLCARD', N'U') IS NULL
BEGIN
    RAISERROR('LG_003_CLCARD was not found.', 16, 1);
    RETURN;
END;

DECLARE @TableName NVARCHAR(128);
DECLARE @LogicalRef INT;
DECLARE @SalespersonCode NVARCHAR(64);
DECLARE @UpdatedClfiches INT = 0;
DECLARE @UpdatedClflines INT = 0;
DECLARE @UpdatedBnfiches INT = 0;
DECLARE @UpdatedBnflines INT = 0;
DECLARE @UpdatedInvoices INT = 0;
DECLARE @UpdatedStfiches INT = 0;
DECLARE @UpdatedStlines INT = 0;
DECLARE @UpdatedKslines INT = 0;
DECLARE @UpdatedCsrolls INT = 0;
DECLARE @UpdatedCstrans INT = 0;

DECLARE repair_cursor CURSOR LOCAL FAST_FORWARD FOR
SELECT TableName, LogicalRef, SalespersonCode
FROM (
    SELECT DISTINCT
        N'dbo.LG_003_01_CLFICHE' AS TableName,
        f.LOGICALREF AS LogicalRef,
        CONVERT(NVARCHAR(64), LEFT(NULLIF(LTRIM(RTRIM(c.SPECODE4)), ''), 64)) AS SalespersonCode
    FROM dbo.LG_003_01_CLFICHE AS f
    INNER JOIN dbo.LG_003_01_CLFLINE AS l
        ON l.SOURCEFREF = f.LOGICALREF
    INNER JOIN dbo.LG_003_CLCARD AS c
        ON c.LOGICALREF = l.CLIENTREF
    WHERE ISNULL(f.CANCELLED, 0) = 0
      AND ISNULL(l.CANCELLED, 0) = 0
      AND NULLIF(LTRIM(RTRIM(c.SPECODE4)), '') IS NOT NULL

    UNION ALL

    SELECT
        N'dbo.LG_003_01_CLFLINE' AS TableName,
        l.LOGICALREF AS LogicalRef,
        CONVERT(NVARCHAR(64), LEFT(NULLIF(LTRIM(RTRIM(c.SPECODE4)), ''), 64)) AS SalespersonCode
    FROM dbo.LG_003_01_CLFLINE AS l
    INNER JOIN dbo.LG_003_CLCARD AS c
        ON c.LOGICALREF = l.CLIENTREF
    WHERE ISNULL(l.CANCELLED, 0) = 0
      AND NULLIF(LTRIM(RTRIM(c.SPECODE4)), '') IS NOT NULL

    UNION ALL

    SELECT DISTINCT
        N'dbo.LG_003_01_BNFICHE' AS TableName,
        f.LOGICALREF AS LogicalRef,
        CONVERT(NVARCHAR(64), LEFT(NULLIF(LTRIM(RTRIM(c.SPECODE4)), ''), 64)) AS SalespersonCode
    FROM dbo.LG_003_01_BNFICHE AS f
    INNER JOIN dbo.LG_003_01_BNFLINE AS l
        ON l.SOURCEFREF = f.LOGICALREF
    INNER JOIN dbo.LG_003_CLCARD AS c
        ON c.LOGICALREF = l.CLIENTREF
    WHERE ISNULL(f.CANCELLED, 0) = 0
      AND ISNULL(l.CANCELLED, 0) = 0
      AND NULLIF(LTRIM(RTRIM(c.SPECODE4)), '') IS NOT NULL

    UNION ALL

    SELECT
        N'dbo.LG_003_01_BNFLINE' AS TableName,
        l.LOGICALREF AS LogicalRef,
        CONVERT(NVARCHAR(64), LEFT(NULLIF(LTRIM(RTRIM(c.SPECODE4)), ''), 64)) AS SalespersonCode
    FROM dbo.LG_003_01_BNFLINE AS l
    INNER JOIN dbo.LG_003_CLCARD AS c
        ON c.LOGICALREF = l.CLIENTREF
    WHERE ISNULL(l.CANCELLED, 0) = 0
      AND NULLIF(LTRIM(RTRIM(c.SPECODE4)), '') IS NOT NULL

    UNION ALL

    SELECT
        N'dbo.LG_003_01_INVOICE' AS TableName,
        i.LOGICALREF AS LogicalRef,
        CONVERT(NVARCHAR(64), LEFT(NULLIF(LTRIM(RTRIM(c.SPECODE4)), ''), 64)) AS SalespersonCode
    FROM dbo.LG_003_01_INVOICE AS i
    INNER JOIN dbo.LG_003_CLCARD AS c
        ON c.LOGICALREF = i.CLIENTREF
    WHERE ISNULL(i.CANCELLED, 0) = 0
      AND NULLIF(LTRIM(RTRIM(c.SPECODE4)), '') IS NOT NULL

    UNION ALL

    SELECT
        N'dbo.LG_003_01_STFICHE' AS TableName,
        s.LOGICALREF AS LogicalRef,
        CONVERT(NVARCHAR(64), LEFT(NULLIF(LTRIM(RTRIM(c.SPECODE4)), ''), 64)) AS SalespersonCode
    FROM dbo.LG_003_01_STFICHE AS s
    INNER JOIN dbo.LG_003_CLCARD AS c
        ON c.LOGICALREF = s.CLIENTREF
    WHERE ISNULL(s.CANCELLED, 0) = 0
      AND NULLIF(LTRIM(RTRIM(c.SPECODE4)), '') IS NOT NULL

    UNION ALL

    SELECT
        N'dbo.LG_003_01_STLINE' AS TableName,
        l.LOGICALREF AS LogicalRef,
        CONVERT(NVARCHAR(64), LEFT(NULLIF(LTRIM(RTRIM(c.SPECODE4)), ''), 64)) AS SalespersonCode
    FROM dbo.LG_003_01_STLINE AS l
    INNER JOIN dbo.LG_003_01_STFICHE AS s
        ON s.LOGICALREF = l.STFICHEREF
    INNER JOIN dbo.LG_003_CLCARD AS c
        ON c.LOGICALREF = s.CLIENTREF
    WHERE ISNULL(l.CANCELLED, 0) = 0
      AND ISNULL(s.CANCELLED, 0) = 0
      AND NULLIF(LTRIM(RTRIM(c.SPECODE4)), '') IS NOT NULL

    UNION ALL

    SELECT
        N'dbo.LG_003_01_KSLINES' AS TableName,
        k.LOGICALREF AS LogicalRef,
        CONVERT(NVARCHAR(64), LEFT(LTRIM(RTRIM(REPLACE(REPLACE(ks.NAME, N' KASASI', N''), N'KASASI', N''))), 64)) AS SalespersonCode
    FROM dbo.LG_003_01_KSLINES AS k
    INNER JOIN dbo.LG_003_KSCARD AS ks
        ON ks.LOGICALREF = k.CARDREF
    WHERE ISNULL(k.CANCELLED, 0) = 0
      AND NULLIF(LTRIM(RTRIM(ks.NAME)), '') IS NOT NULL

    UNION ALL

    SELECT
        N'dbo.LG_003_01_CSROLL' AS TableName,
        r.LOGICALREF AS LogicalRef,
        CONVERT(NVARCHAR(64), LEFT(NULLIF(LTRIM(RTRIM(c.SPECODE4)), ''), 64)) AS SalespersonCode
    FROM dbo.LG_003_01_CSROLL AS r
    INNER JOIN dbo.LG_003_CLCARD AS c
        ON c.LOGICALREF = r.CARDREF
    WHERE ISNULL(r.CANCELLED, 0) = 0
      AND r.TRCODE IN (1, 2)
      AND NULLIF(LTRIM(RTRIM(c.SPECODE4)), '') IS NOT NULL

    UNION ALL

    SELECT
        N'dbo.LG_003_01_CSTRANS' AS TableName,
        t.LOGICALREF AS LogicalRef,
        CONVERT(NVARCHAR(64), LEFT(NULLIF(LTRIM(RTRIM(c.SPECODE4)), ''), 64)) AS SalespersonCode
    FROM dbo.LG_003_01_CSTRANS AS t
    INNER JOIN dbo.LG_003_CLCARD AS c
        ON c.LOGICALREF = t.CARDREF
    WHERE ISNULL(t.CANCELLED, 0) = 0
      AND t.TRCODE IN (1, 2)
      AND NULLIF(LTRIM(RTRIM(c.SPECODE4)), '') IS NOT NULL
) AS Repairs
WHERE SalespersonCode IS NOT NULL;

OPEN repair_cursor;
FETCH NEXT FROM repair_cursor INTO @TableName, @LogicalRef, @SalespersonCode;
WHILE @@FETCH_STATUS = 0
BEGIN
    EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow @TableName, @LogicalRef, @SalespersonCode;

    IF @TableName = N'dbo.LG_003_01_CLFICHE' SET @UpdatedClfiches += 1;
    IF @TableName = N'dbo.LG_003_01_CLFLINE' SET @UpdatedClflines += 1;
    IF @TableName = N'dbo.LG_003_01_BNFICHE' SET @UpdatedBnfiches += 1;
    IF @TableName = N'dbo.LG_003_01_BNFLINE' SET @UpdatedBnflines += 1;
    IF @TableName = N'dbo.LG_003_01_INVOICE' SET @UpdatedInvoices += 1;
    IF @TableName = N'dbo.LG_003_01_STFICHE' SET @UpdatedStfiches += 1;
    IF @TableName = N'dbo.LG_003_01_STLINE' SET @UpdatedStlines += 1;
    IF @TableName = N'dbo.LG_003_01_KSLINES' SET @UpdatedKslines += 1;
    IF @TableName = N'dbo.LG_003_01_CSROLL' SET @UpdatedCsrolls += 1;
    IF @TableName = N'dbo.LG_003_01_CSTRANS' SET @UpdatedCstrans += 1;

    FETCH NEXT FROM repair_cursor INTO @TableName, @LogicalRef, @SalespersonCode;
END;
CLOSE repair_cursor;
DEALLOCATE repair_cursor;

SELECT
    @UpdatedClfiches AS repaired_clfiche_rows,
    @UpdatedClflines AS repaired_clfline_rows,
    @UpdatedBnfiches AS repaired_bnfiche_rows,
    @UpdatedBnflines AS repaired_bnfline_rows,
    @UpdatedInvoices AS repaired_invoice_rows,
    @UpdatedStfiches AS repaired_stfiche_rows,
    @UpdatedStlines AS repaired_stline_rows,
    @UpdatedKslines AS repaired_kslines_rows,
    @UpdatedCsrolls AS repaired_csroll_rows,
    @UpdatedCstrans AS repaired_cstrans_rows;
