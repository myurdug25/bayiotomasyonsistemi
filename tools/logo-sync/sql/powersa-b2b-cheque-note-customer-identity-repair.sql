/*
Repair customer code/title fields for existing B2B cheque/note Logo rows.

Run after powersa-b2b-collection-write-procedure.sql so the helper procedures
exist. The script does not create new cheques/notes; it only fills supported
customer identity columns on CSROLL, CSTRANS and linked CSCARD rows.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'dbo.PowersaB2B_ApplyCustomerIdentityToCSRow', N'P') IS NULL
BEGIN
    RAISERROR('PowersaB2B_ApplyCustomerIdentityToCSRow was not found. Install collection procedure first.', 16, 1);
    RETURN;
END;

IF OBJECT_ID(N'dbo.PowersaB2B_ApplyCustomerTitleToCSCard', N'P') IS NULL
BEGIN
    RAISERROR('PowersaB2B_ApplyCustomerTitleToCSCard was not found. Install collection procedure first.', 16, 1);
    RETURN;
END;

IF OBJECT_ID(N'dbo.PowersaB2B_ApplyChequeNoteLogoDefaults', N'P') IS NULL
BEGIN
    RAISERROR('PowersaB2B_ApplyChequeNoteLogoDefaults was not found. Install collection procedure first.', 16, 1);
    RETURN;
END;

IF OBJECT_ID(N'dbo.PowersaB2B_ApplySalespersonToLogoRow', N'P') IS NULL
BEGIN
    RAISERROR('PowersaB2B_ApplySalespersonToLogoRow was not found. Install collection procedure first.', 16, 1);
    RETURN;
END;

IF OBJECT_ID(N'dbo.LG_003_01_CSROLL', N'U') IS NULL
OR OBJECT_ID(N'dbo.LG_003_01_CSTRANS', N'U') IS NULL
OR OBJECT_ID(N'dbo.LG_003_01_CSCARD', N'U') IS NULL
OR OBJECT_ID(N'dbo.LG_003_CLCARD', N'U') IS NULL
BEGIN
    RAISERROR('Required Logo cheque/note tables were not found.', 16, 1);
    RETURN;
END;

DECLARE @RollRef INT;
DECLARE @TransRef INT;
DECLARE @CardRef INT;
DECLARE @CustomerRef INT;
DECLARE @CustomerCode NVARCHAR(64);
DECLARE @CustomerTitle NVARCHAR(201);
DECLARE @SalespersonCode VARCHAR(25);
DECLARE @UpdatedRolls INT = 0;
DECLARE @UpdatedTrans INT = 0;
DECLARE @UpdatedCards INT = 0;

DECLARE roll_cursor CURSOR LOCAL FAST_FORWARD FOR
SELECT
    r.LOGICALREF,
    c.LOGICALREF,
    CONVERT(NVARCHAR(64), c.CODE),
    CONVERT(NVARCHAR(201), LEFT(COALESCE(NULLIF(c.DEFINITION_, ''), c.CODE), 201)),
    CONVERT(VARCHAR(25), LEFT(NULLIF(LTRIM(RTRIM(COALESCE(c.SPECODE4, ''))), ''), 25))
FROM dbo.LG_003_01_CSROLL AS r
INNER JOIN dbo.LG_003_CLCARD AS c
    ON c.LOGICALREF = r.CARDREF
WHERE ISNULL(r.CANCELLED, 0) = 0
  AND r.TRCODE IN (1, 2)
  AND ISNULL(r.CARDREF, 0) > 0;

OPEN roll_cursor;
FETCH NEXT FROM roll_cursor INTO @RollRef, @CustomerRef, @CustomerCode, @CustomerTitle, @SalespersonCode;
WHILE @@FETCH_STATUS = 0
BEGIN
    EXEC dbo.PowersaB2B_ApplyCustomerIdentityToCSRow
        N'dbo.LG_003_01_CSROLL',
        @RollRef,
        @CustomerRef,
        @CustomerCode,
        @CustomerTitle;
    EXEC dbo.PowersaB2B_ApplyChequeNoteLogoDefaults
        N'dbo.LG_003_01_CSROLL',
        @RollRef;
    IF @SalespersonCode IS NOT NULL
    BEGIN
        EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow
            N'dbo.LG_003_01_CSROLL',
            @RollRef,
            @SalespersonCode;
    END;
    SET @UpdatedRolls += 1;

    FETCH NEXT FROM roll_cursor INTO @RollRef, @CustomerRef, @CustomerCode, @CustomerTitle, @SalespersonCode;
END;
CLOSE roll_cursor;
DEALLOCATE roll_cursor;

DECLARE trans_cursor CURSOR LOCAL FAST_FORWARD FOR
SELECT
    t.LOGICALREF,
    t.CSREF,
    c.LOGICALREF,
    CONVERT(NVARCHAR(64), c.CODE),
    CONVERT(NVARCHAR(201), LEFT(COALESCE(NULLIF(c.DEFINITION_, ''), c.CODE), 201)),
    CONVERT(VARCHAR(25), LEFT(NULLIF(LTRIM(RTRIM(COALESCE(c.SPECODE4, ''))), ''), 25))
FROM dbo.LG_003_01_CSTRANS AS t
INNER JOIN dbo.LG_003_CLCARD AS c
    ON c.LOGICALREF = t.CARDREF
WHERE ISNULL(t.CANCELLED, 0) = 0
  AND t.TRCODE IN (1, 2)
  AND ISNULL(t.CARDREF, 0) > 0;

OPEN trans_cursor;
FETCH NEXT FROM trans_cursor INTO @TransRef, @CardRef, @CustomerRef, @CustomerCode, @CustomerTitle, @SalespersonCode;
WHILE @@FETCH_STATUS = 0
BEGIN
    EXEC dbo.PowersaB2B_ApplyCustomerIdentityToCSRow
        N'dbo.LG_003_01_CSTRANS',
        @TransRef,
        @CustomerRef,
        @CustomerCode,
        @CustomerTitle;
    EXEC dbo.PowersaB2B_ApplyChequeNoteLogoDefaults
        N'dbo.LG_003_01_CSTRANS',
        @TransRef;
    IF @SalespersonCode IS NOT NULL
    BEGIN
        EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow
            N'dbo.LG_003_01_CSTRANS',
            @TransRef,
            @SalespersonCode;
    END;
    SET @UpdatedTrans += 1;

    EXEC dbo.PowersaB2B_ApplyCustomerTitleToCSCard
        @CardRef,
        @CustomerTitle,
        @CustomerCode;
    EXEC dbo.PowersaB2B_ApplyCustomerIdentityToCSRow
        N'dbo.LG_003_01_CSCARD',
        @CardRef,
        @CustomerRef,
        @CustomerCode,
        @CustomerTitle;
    SET @UpdatedCards += 1;

    FETCH NEXT FROM trans_cursor INTO @TransRef, @CardRef, @CustomerRef, @CustomerCode, @CustomerTitle, @SalespersonCode;
END;
CLOSE trans_cursor;
DEALLOCATE trans_cursor;

SELECT
    @UpdatedRolls AS repaired_csroll_rows,
    @UpdatedTrans AS repaired_cstrans_rows,
    @UpdatedCards AS repaired_cscard_rows;
