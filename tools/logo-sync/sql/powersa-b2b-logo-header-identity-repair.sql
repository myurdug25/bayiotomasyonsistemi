/*
Backfill Logo header identity fields for B2B-created financial documents.

This does not create new documents. It copies the already-known customer and
bank context from detail rows into supported header/detail columns so Logo edit
screens can show Cari Hesap Bilgileri and Banka Hesap Bilgileri consistently.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'dbo.PowersaB2B_ApplyCustomerIdentityToLogoRow', N'P') IS NULL
BEGIN
    RAISERROR('PowersaB2B_ApplyCustomerIdentityToLogoRow was not found. Install collection procedure first.', 16, 1);
    RETURN;
END;

IF OBJECT_ID(N'dbo.PowersaB2B_ApplyBankIdentityToLogoRow', N'P') IS NULL
BEGIN
    RAISERROR('PowersaB2B_ApplyBankIdentityToLogoRow was not found. Install collection procedure first.', 16, 1);
    RETURN;
END;

DECLARE @UpdatedClfiches INT = 0;
DECLARE @UpdatedClflines INT = 0;
DECLARE @UpdatedBnfiches INT = 0;
DECLARE @UpdatedBnflines INT = 0;

DECLARE @TableName NVARCHAR(128);
DECLARE @LogicalRef INT;
DECLARE @CustomerRef INT;
DECLARE @BankRef INT;
DECLARE @BankAccountRef INT;

DECLARE identity_cursor CURSOR LOCAL FAST_FORWARD FOR
SELECT TableName, LogicalRef, CustomerRef, BankRef, BankAccountRef
FROM (
    SELECT DISTINCT
        N'dbo.LG_003_01_CLFICHE' AS TableName,
        f.LOGICALREF AS LogicalRef,
        MIN(NULLIF(l.CLIENTREF, 0)) OVER (PARTITION BY f.LOGICALREF) AS CustomerRef,
        bank.BankRef AS BankRef,
        bank.BankAccountRef AS BankAccountRef
    FROM dbo.LG_003_01_CLFICHE AS f
    INNER JOIN dbo.LG_003_01_CLFLINE AS l
        ON l.SOURCEFREF = f.LOGICALREF
    OUTER APPLY (
        SELECT TOP (1)
            b.LOGICALREF AS BankRef,
            a.LOGICALREF AS BankAccountRef
        FROM dbo.LG_003_BNCARD AS b WITH (NOLOCK)
        INNER JOIN dbo.LG_003_BANKACC AS a WITH (NOLOCK)
            ON a.BANKREF = b.LOGICALREF
           AND ISNULL(a.ACTIVE, 0) = 0
        WHERE f.TRCODE = 70
          AND ISNULL(b.ACTIVE, 0) = 0
          AND NULLIF(LTRIM(RTRIM(b.DEFINITION_)), '') IS NOT NULL
          AND (
              COALESCE(f.GENEXP1, '') LIKE '%' + b.DEFINITION_ + '%'
              OR COALESCE(f.GENEXP2, '') LIKE '%' + b.DEFINITION_ + '%'
              OR EXISTS (
                  SELECT 1
                  FROM dbo.LG_003_01_CLFLINE AS lx WITH (NOLOCK)
                  WHERE lx.SOURCEFREF = f.LOGICALREF
                    AND COALESCE(lx.LINEEXP, '') LIKE '%' + b.DEFINITION_ + '%'
              )
          )
        ORDER BY
            CASE
                WHEN a.CODE LIKE '%POS%' OR a.DEFINITION_ LIKE '%POS%' THEN 0
                WHEN a.DEFINITION_ LIKE '%KREDİ KARTI%' THEN 1
                ELSE 2
            END,
            CASE WHEN a.DEFINITION_ LIKE '%POWERSA%' THEN 0 ELSE 1 END,
            LEN(b.DEFINITION_) DESC,
            a.LOGICALREF
    ) AS bank
    WHERE ISNULL(f.CANCELLED, 0) = 0
      AND ISNULL(l.CANCELLED, 0) = 0
      AND ISNULL(l.CLIENTREF, 0) > 0

    UNION ALL

    SELECT
        N'dbo.LG_003_01_CLFLINE' AS TableName,
        l.LOGICALREF AS LogicalRef,
        NULLIF(l.CLIENTREF, 0) AS CustomerRef,
        bank.BankRef AS BankRef,
        COALESCE(NULLIF(l.BANKACCREF, 0), NULLIF(l.BNACCREF, 0), bank.BankAccountRef) AS BankAccountRef
    FROM dbo.LG_003_01_CLFLINE AS l
    OUTER APPLY (
        SELECT TOP (1)
            b.LOGICALREF AS BankRef,
            a.LOGICALREF AS BankAccountRef
        FROM dbo.LG_003_BNCARD AS b WITH (NOLOCK)
        INNER JOIN dbo.LG_003_BANKACC AS a WITH (NOLOCK)
            ON a.BANKREF = b.LOGICALREF
           AND ISNULL(a.ACTIVE, 0) = 0
        WHERE l.MODULENR = 5
          AND l.TRCODE = 70
          AND ISNULL(b.ACTIVE, 0) = 0
          AND NULLIF(LTRIM(RTRIM(b.DEFINITION_)), '') IS NOT NULL
          AND COALESCE(l.LINEEXP, '') LIKE '%' + b.DEFINITION_ + '%'
        ORDER BY
            CASE
                WHEN a.CODE LIKE '%POS%' OR a.DEFINITION_ LIKE '%POS%' THEN 0
                WHEN a.DEFINITION_ LIKE '%KREDİ KARTI%' THEN 1
                ELSE 2
            END,
            CASE WHEN a.DEFINITION_ LIKE '%POWERSA%' THEN 0 ELSE 1 END,
            LEN(b.DEFINITION_) DESC,
            a.LOGICALREF
    ) AS bank
    WHERE ISNULL(l.CANCELLED, 0) = 0
      AND ISNULL(l.CLIENTREF, 0) > 0

    UNION ALL

    SELECT DISTINCT
        N'dbo.LG_003_01_BNFICHE' AS TableName,
        f.LOGICALREF AS LogicalRef,
        MIN(NULLIF(l.CLIENTREF, 0)) OVER (PARTITION BY f.LOGICALREF) AS CustomerRef,
        MIN(NULLIF(l.BANKREF, 0)) OVER (PARTITION BY f.LOGICALREF) AS BankRef,
        MIN(NULLIF(l.BNACCREF, 0)) OVER (PARTITION BY f.LOGICALREF) AS BankAccountRef
    FROM dbo.LG_003_01_BNFICHE AS f
    INNER JOIN dbo.LG_003_01_BNFLINE AS l
        ON l.SOURCEFREF = f.LOGICALREF
    WHERE ISNULL(f.CANCELLED, 0) = 0
      AND ISNULL(l.CANCELLED, 0) = 0

    UNION ALL

    SELECT
        N'dbo.LG_003_01_BNFLINE' AS TableName,
        l.LOGICALREF AS LogicalRef,
        NULLIF(l.CLIENTREF, 0) AS CustomerRef,
        NULLIF(l.BANKREF, 0) AS BankRef,
        NULLIF(l.BNACCREF, 0) AS BankAccountRef
    FROM dbo.LG_003_01_BNFLINE AS l
    WHERE ISNULL(l.CANCELLED, 0) = 0
) AS Repairs
WHERE CustomerRef IS NOT NULL
   OR BankRef IS NOT NULL
   OR BankAccountRef IS NOT NULL;

OPEN identity_cursor;
FETCH NEXT FROM identity_cursor INTO @TableName, @LogicalRef, @CustomerRef, @BankRef, @BankAccountRef;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF @CustomerRef IS NOT NULL
        EXEC dbo.PowersaB2B_ApplyCustomerIdentityToLogoRow @TableName, @LogicalRef, @CustomerRef;

    IF @BankRef IS NOT NULL OR @BankAccountRef IS NOT NULL
        EXEC dbo.PowersaB2B_ApplyBankIdentityToLogoRow @TableName, @LogicalRef, @BankRef, @BankAccountRef;

    IF @TableName = N'dbo.LG_003_01_CLFICHE' SET @UpdatedClfiches += 1;
    IF @TableName = N'dbo.LG_003_01_CLFLINE' SET @UpdatedClflines += 1;
    IF @TableName = N'dbo.LG_003_01_BNFICHE' SET @UpdatedBnfiches += 1;
    IF @TableName = N'dbo.LG_003_01_BNFLINE' SET @UpdatedBnflines += 1;

    FETCH NEXT FROM identity_cursor INTO @TableName, @LogicalRef, @CustomerRef, @BankRef, @BankAccountRef;
END;
CLOSE identity_cursor;
DEALLOCATE identity_cursor;

SELECT
    @UpdatedClfiches AS repaired_clfiche_identity_rows,
    @UpdatedClflines AS repaired_clfline_identity_rows,
    @UpdatedBnfiches AS repaired_bnfiche_identity_rows,
    @UpdatedBnflines AS repaired_bnfline_identity_rows;
