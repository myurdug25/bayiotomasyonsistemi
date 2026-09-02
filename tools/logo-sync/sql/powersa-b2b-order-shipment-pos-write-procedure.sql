/*
  Powersa B2B order, shipment and POS sale write procedures for Logo Go Wings
  firm 003 period 01.

  Collection writes are handled by PowersaB2B_ExportCollection. POS sale export
  writes stock/delivery/invoice rows and, for cash quick sales, the matching
  cashbox and customer ledger payment rows.
*/

IF OBJECT_ID(N'dbo.POWERSA_B2B_EXPORT_LOG', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.POWERSA_B2B_EXPORT_LOG (
        ID BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_POWERSA_B2B_EXPORT_LOG PRIMARY KEY,
        EXPORT_KEY NVARCHAR(128) NOT NULL,
        DOCUMENT_TYPE NVARCHAR(64) NOT NULL,
        EXTERNAL_REF NVARCHAR(128) NULL,
        STATUS NVARCHAR(32) NOT NULL CONSTRAINT DF_POWERSA_B2B_EXPORT_LOG_STATUS DEFAULT (N'pending'),
        ERROR_MESSAGE NVARCHAR(2000) NULL,
        PAYLOAD_JSON NVARCHAR(MAX) NULL,
        CREATED_AT DATETIME2(0) NOT NULL CONSTRAINT DF_POWERSA_B2B_EXPORT_LOG_CREATED_AT DEFAULT (SYSUTCDATETIME()),
        UPDATED_AT DATETIME2(0) NOT NULL CONSTRAINT DF_POWERSA_B2B_EXPORT_LOG_UPDATED_AT DEFAULT (SYSUTCDATETIME())
    );

    CREATE UNIQUE INDEX UX_POWERSA_B2B_EXPORT_LOG_EXPORT_KEY
        ON dbo.POWERSA_B2B_EXPORT_LOG (EXPORT_KEY);
END;
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO
CREATE OR ALTER PROCEDURE dbo.PowersaB2B_BeginExport
    @ExportKey NVARCHAR(128),
    @DocumentType NVARCHAR(64),
    @PayloadJson NVARCHAR(MAX),
    @ExistingExternalRef NVARCHAR(128) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;

    IF NULLIF(LTRIM(RTRIM(@ExportKey)), N'') IS NULL
        THROW 51000, 'ExportKey is required.', 1;

    IF @PayloadJson IS NOT NULL AND ISJSON(@PayloadJson) <> 1
        THROW 51000, 'PayloadJson must be valid JSON.', 1;

    SELECT @ExistingExternalRef = EXTERNAL_REF
    FROM dbo.POWERSA_B2B_EXPORT_LOG WITH (UPDLOCK, HOLDLOCK)
    WHERE EXPORT_KEY = @ExportKey
      AND STATUS = N'synced'
      AND EXTERNAL_REF IS NOT NULL;

    IF @ExistingExternalRef IS NOT NULL
        RETURN;

    MERGE dbo.POWERSA_B2B_EXPORT_LOG AS target
    USING (SELECT @ExportKey AS EXPORT_KEY) AS source
       ON target.EXPORT_KEY = source.EXPORT_KEY
    WHEN MATCHED THEN
        UPDATE SET
            DOCUMENT_TYPE = @DocumentType,
            STATUS = N'pending',
            ERROR_MESSAGE = NULL,
            PAYLOAD_JSON = @PayloadJson,
            UPDATED_AT = SYSUTCDATETIME()
    WHEN NOT MATCHED THEN
        INSERT (EXPORT_KEY, DOCUMENT_TYPE, STATUS, PAYLOAD_JSON)
        VALUES (@ExportKey, @DocumentType, N'pending', @PayloadJson);
END;
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO
CREATE OR ALTER PROCEDURE dbo.PowersaB2B_FinishExport
    @ExportKey NVARCHAR(128),
    @ExternalRef NVARCHAR(128)
AS
BEGIN
    SET NOCOUNT ON;

    IF NULLIF(LTRIM(RTRIM(@ExternalRef)), N'') IS NULL
        THROW 51000, 'ExternalRef is required after Logo write.', 1;

    UPDATE dbo.POWERSA_B2B_EXPORT_LOG
       SET STATUS = N'synced',
           EXTERNAL_REF = @ExternalRef,
           ERROR_MESSAGE = NULL,
           UPDATED_AT = SYSUTCDATETIME()
     WHERE EXPORT_KEY = @ExportKey;
END;
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO
CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ApplyCashboxInSign
    @KslinesRef INT
AS
BEGIN
    SET NOCOUNT ON;

    IF @KslinesRef IS NULL
        RETURN;

    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'SIGN') IS NOT NULL
    BEGIN
        EXEC sys.sp_executesql
            N'UPDATE dbo.LG_003_01_KSLINES SET SIGN = ISNULL(SIGN, 0) WHERE LOGICALREF = @KslinesRef',
            N'@KslinesRef INT',
            @KslinesRef = @KslinesRef;
    END;
END;
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO
CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ApplyCashboxLocalCurrencyTotals
    @KslinesRef INT
AS
BEGIN
    SET NOCOUNT ON;

    IF @KslinesRef IS NULL
        RETURN;

    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'TRCURR') IS NOT NULL
       AND COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'TRRATE') IS NOT NULL
       AND COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'TRNET') IS NOT NULL
       AND COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'REPORTRATE') IS NOT NULL
       AND COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'REPORTNET') IS NOT NULL
    BEGIN
        EXEC sys.sp_executesql
            N'UPDATE dbo.LG_003_01_KSLINES
                 SET TRCURR = ISNULL(TRCURR, 0),
                     TRRATE = CASE WHEN ISNULL(TRRATE, 0) = 0 THEN 1 ELSE TRRATE END,
                     TRNET = CASE WHEN ISNULL(TRNET, 0) = 0 THEN ISNULL(AMOUNT, 0) ELSE TRNET END,
                     REPORTRATE = CASE WHEN ISNULL(REPORTRATE, 0) = 0 THEN 1 ELSE REPORTRATE END,
                     REPORTNET = CASE WHEN ISNULL(REPORTNET, 0) = 0 THEN ISNULL(AMOUNT, 0) ELSE REPORTNET END
               WHERE LOGICALREF = @KslinesRef',
            N'@KslinesRef INT',
            @KslinesRef = @KslinesRef;
    END;
END;
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO
CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ApplyCashboxLogoDefaults
    @KslinesRef INT
AS
BEGIN
    SET NOCOUNT ON;

    IF @KslinesRef IS NULL
        RETURN;

    DECLARE @SetList NVARCHAR(MAX) = N'';

    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'ACCREF') IS NOT NULL
        SET @SetList = @SetList + N', ACCREF = ISNULL(ACCREF, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'CENTERREF') IS NOT NULL
        SET @SetList = @SetList + N', CENTERREF = ISNULL(CENTERREF, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'CASHACCREF') IS NOT NULL
        SET @SetList = @SetList + N', CASHACCREF = ISNULL(CASHACCREF, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'CASHCENREF') IS NOT NULL
        SET @SetList = @SetList + N', CASHCENREF = ISNULL(CASHCENREF, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'ACCFICHEREF') IS NOT NULL
        SET @SetList = @SetList + N', ACCFICHEREF = ISNULL(ACCFICHEREF, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'ACCOUNTED') IS NOT NULL
        SET @SetList = @SetList + N', ACCOUNTED = ISNULL(ACCOUNTED, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'REFLECTED') IS NOT NULL
        SET @SetList = @SetList + N', REFLECTED = ISNULL(REFLECTED, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'STATUS') IS NOT NULL
        SET @SetList = @SetList + N', STATUS = ISNULL(STATUS, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'AFFECTRISK') IS NOT NULL
        SET @SetList = @SetList + N', AFFECTRISK = ISNULL(AFFECTRISK, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'BRANCH') IS NOT NULL
        SET @SetList = @SetList + N', BRANCH = ISNULL(BRANCH, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'DEPARTMENT') IS NOT NULL
        SET @SetList = @SetList + N', DEPARTMENT = ISNULL(DEPARTMENT, 0)';

    IF LEN(@SetList) > 0
    BEGIN
        DECLARE @Sql NVARCHAR(MAX) =
            N'UPDATE dbo.LG_003_01_KSLINES SET ' + STUFF(@SetList, 1, 2, N'') + N' WHERE LOGICALREF = @KslinesRef';

        EXEC sys.sp_executesql
            @Sql,
            N'@KslinesRef INT',
            @KslinesRef = @KslinesRef;
    END;
END;
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO
CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ApplyCustomerLedgerLogoDefaults
    @ClflineRef INT,
    @LedgerDate DATE
AS
BEGIN
    SET NOCOUNT ON;

    IF @ClflineRef IS NULL
        RETURN;

    DECLARE @SetList NVARCHAR(MAX) = N'';

    IF COL_LENGTH(N'dbo.LG_003_01_CLFLINE', N'STATUS') IS NOT NULL
        SET @SetList = @SetList + N', STATUS = ISNULL(STATUS, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_CLFLINE', N'CANCELLED') IS NOT NULL
        SET @SetList = @SetList + N', CANCELLED = ISNULL(CANCELLED, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_CLFLINE', N'MONTH_') IS NOT NULL
        SET @SetList = @SetList + N', MONTH_ = ISNULL(MONTH_, MONTH(COALESCE(DATE_, @LedgerDate, GETDATE())))';
    IF COL_LENGTH(N'dbo.LG_003_01_CLFLINE', N'YEAR_') IS NOT NULL
        SET @SetList = @SetList + N', YEAR_ = ISNULL(YEAR_, YEAR(COALESCE(DATE_, @LedgerDate, GETDATE())))';
    IF COL_LENGTH(N'dbo.LG_003_01_CLFLINE', N'BRANCH') IS NOT NULL
        SET @SetList = @SetList + N', BRANCH = ISNULL(BRANCH, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_CLFLINE', N'DEPARTMENT') IS NOT NULL
        SET @SetList = @SetList + N', DEPARTMENT = ISNULL(DEPARTMENT, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_CLFLINE', N'PAIDINCASH') IS NOT NULL
        SET @SetList = @SetList + N', PAIDINCASH = ISNULL(PAIDINCASH, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_CLFLINE', N'TRNET') IS NOT NULL
        SET @SetList = @SetList + N', TRNET = ISNULL(TRNET, AMOUNT)';
    IF COL_LENGTH(N'dbo.LG_003_01_CLFLINE', N'REPORTNET') IS NOT NULL
        SET @SetList = @SetList + N', REPORTNET = ISNULL(REPORTNET, ISNULL(TRNET, AMOUNT))';

    IF LEN(@SetList) > 0
    BEGIN
        DECLARE @Sql NVARCHAR(MAX) =
            N'UPDATE dbo.LG_003_01_CLFLINE SET ' + STUFF(@SetList, 1, 2, N'') + N' WHERE LOGICALREF = @ClflineRef';

        EXEC sys.sp_executesql
            @Sql,
            N'@ClflineRef INT, @LedgerDate DATE',
            @ClflineRef = @ClflineRef,
            @LedgerDate = @LedgerDate;
    END;
END;
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO
CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ApplySalespersonToLogoRow
    @TableName NVARCHAR(128),
    @LogicalRef INT,
    @SalespersonCode NVARCHAR(64)
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @Code VARCHAR(25) = CONVERT(VARCHAR(25), LEFT(NULLIF(LTRIM(RTRIM(COALESCE(@SalespersonCode, N''))), N''), 25));
    DECLARE @Sql NVARCHAR(MAX);
    DECLARE @SalespersonRef INT = NULL;
    DECLARE @SalespersonTable NVARCHAR(256) = NULL;
    DECLARE @SalespersonObject NVARCHAR(256) = NULL;
    DECLARE @CashboxSalespersonName VARCHAR(51) = NULL;
    DECLARE @SqlTable NVARCHAR(128) = CASE
        WHEN @TableName = N'dbo.LG_003_01_INVOICE' THEN N'dbo.LG_003_01_INVOICE'
        WHEN @TableName = N'dbo.LG_003_01_STFICHE' THEN N'dbo.LG_003_01_STFICHE'
        WHEN @TableName = N'dbo.LG_003_01_STLINE' THEN N'dbo.LG_003_01_STLINE'
        WHEN @TableName = N'dbo.LG_003_01_KSLINES' THEN N'dbo.LG_003_01_KSLINES'
        WHEN @TableName = N'dbo.LG_003_01_CLFICHE' THEN N'dbo.LG_003_01_CLFICHE'
        WHEN @TableName = N'dbo.LG_003_01_CLFLINE' THEN N'dbo.LG_003_01_CLFLINE'
        WHEN @TableName = N'dbo.LG_003_01_BNFICHE' THEN N'dbo.LG_003_01_BNFICHE'
        WHEN @TableName = N'dbo.LG_003_01_BNFLINE' THEN N'dbo.LG_003_01_BNFLINE'
        WHEN @TableName = N'dbo.LG_003_01_CSROLL' THEN N'dbo.LG_003_01_CSROLL'
        WHEN @TableName = N'dbo.LG_003_01_CSTRANS' THEN N'dbo.LG_003_01_CSTRANS'
        ELSE NULL
    END;

    IF @LogicalRef IS NULL OR @Code IS NULL OR @SqlTable IS NULL
        RETURN;

    SELECT TOP 1
        @SalespersonTable = QUOTENAME(SCHEMA_NAME(t.schema_id)) + N'.' + QUOTENAME(t.name),
        @SalespersonObject = SCHEMA_NAME(t.schema_id) + N'.' + t.name
    FROM sys.tables AS t
    WHERE t.name IN (N'LG_003_SLSMAN', N'LG_SLSMAN')
      AND EXISTS (SELECT 1 FROM sys.columns AS c WHERE c.object_id = t.object_id AND c.name = N'LOGICALREF')
      AND EXISTS (SELECT 1 FROM sys.columns AS c WHERE c.object_id = t.object_id AND c.name = N'CODE')
    ORDER BY CASE t.name WHEN N'LG_003_SLSMAN' THEN 0 WHEN N'LG_SLSMAN' THEN 1 ELSE 2 END;

    IF @SalespersonTable IS NULL
    BEGIN
        SELECT TOP 1
            @SalespersonTable = QUOTENAME(SCHEMA_NAME(t.schema_id)) + N'.' + QUOTENAME(t.name),
            @SalespersonObject = SCHEMA_NAME(t.schema_id) + N'.' + t.name
        FROM sys.tables AS t
        WHERE t.name LIKE N'%SLSMAN%'
          AND EXISTS (SELECT 1 FROM sys.columns AS c WHERE c.object_id = t.object_id AND c.name = N'LOGICALREF')
          AND EXISTS (SELECT 1 FROM sys.columns AS c WHERE c.object_id = t.object_id AND c.name = N'CODE')
        ORDER BY CASE WHEN t.name LIKE N'LG[_]%' THEN 0 ELSE 1 END, t.name;
    END;

    IF @TableName = N'dbo.LG_003_01_KSLINES'
    BEGIN
        SELECT TOP 1
            @CashboxSalespersonName = CONVERT(VARCHAR(51), LEFT(
                LTRIM(RTRIM(REPLACE(REPLACE(ks.NAME, N' KASASI', N''), N'KASASI', N''))),
                51
            ))
        FROM dbo.LG_003_01_KSLINES AS k WITH (NOLOCK)
        INNER JOIN dbo.LG_003_KSCARD AS ks WITH (NOLOCK)
            ON ks.LOGICALREF = k.CARDREF
        WHERE k.LOGICALREF = @LogicalRef;
    END;

    IF @SalespersonTable IS NOT NULL
    BEGIN
        SET @Sql = N'
            SELECT TOP 1 @ResolvedRef = LOGICALREF
            FROM ' + @SalespersonTable + N' WITH (NOLOCK)
            WHERE (
                    CODE = @Code
                    OR REPLACE(REPLACE(REPLACE(UPPER(CODE), ''.'', ''''), '' '', ''''), ''-'', '''')
                       = REPLACE(REPLACE(REPLACE(UPPER(@Code), ''.'', ''''), '' '', ''''), ''-'', '''')
                )
              AND ISNULL(ACTIVE, 0) = 0
            ORDER BY LOGICALREF';
        EXEC sys.sp_executesql
            @Sql,
            N'@Code VARCHAR(25), @ResolvedRef INT OUTPUT',
            @Code = @Code,
            @ResolvedRef = @SalespersonRef OUTPUT;

        IF @SalespersonRef IS NULL AND COL_LENGTH(@SalespersonObject, N'DEFINITION_') IS NOT NULL
        BEGIN
            SET @Sql = N'
                SELECT TOP 1 @ResolvedRef = LOGICALREF
                FROM ' + @SalespersonTable + N' WITH (NOLOCK)
                WHERE (
                        DEFINITION_ = @Code
                        OR REPLACE(REPLACE(REPLACE(UPPER(DEFINITION_), ''.'', ''''), '' '', ''''), ''-'', '''')
                           = REPLACE(REPLACE(REPLACE(UPPER(@Code), ''.'', ''''), '' '', ''''), ''-'', '''')
                    )
                  AND ISNULL(ACTIVE, 0) = 0
                ORDER BY LOGICALREF';
            EXEC sys.sp_executesql
                @Sql,
                N'@Code VARCHAR(25), @ResolvedRef INT OUTPUT',
                @Code = @Code,
                @ResolvedRef = @SalespersonRef OUTPUT;
        END;

        IF @SalespersonRef IS NULL AND @CashboxSalespersonName IS NOT NULL AND COL_LENGTH(@SalespersonObject, N'DEFINITION_') IS NOT NULL
        BEGIN
            SET @Sql = N'
                SELECT TOP 1 @ResolvedRef = LOGICALREF
                FROM ' + @SalespersonTable + N' WITH (NOLOCK)
                WHERE (
                        DEFINITION_ = @CashboxName
                        OR REPLACE(REPLACE(REPLACE(UPPER(DEFINITION_), ''.'', ''''), '' '', ''''), ''-'', '''')
                           = REPLACE(REPLACE(REPLACE(UPPER(@CashboxName), ''.'', ''''), '' '', ''''), ''-'', '''')
                    )
                  AND ISNULL(ACTIVE, 0) = 0
                ORDER BY LOGICALREF';
            EXEC sys.sp_executesql
                @Sql,
                N'@CashboxName VARCHAR(51), @ResolvedRef INT OUTPUT',
                @CashboxName = @CashboxSalespersonName,
                @ResolvedRef = @SalespersonRef OUTPUT;
        END;
    END;

    IF @SalespersonRef IS NOT NULL AND COL_LENGTH(@SqlTable, N'SALESMANREF') IS NOT NULL
    BEGIN
        SET @Sql = N'UPDATE ' + @SqlTable + N' SET SALESMANREF = @SalespersonRef WHERE LOGICALREF = @LogicalRef';
        EXEC sys.sp_executesql
            @Sql,
            N'@SalespersonRef INT, @LogicalRef INT',
            @SalespersonRef = @SalespersonRef,
            @LogicalRef = @LogicalRef;
    END;

    IF COL_LENGTH(@SqlTable, N'SALESMANCODE') IS NOT NULL
    BEGIN
        SET @Sql = N'UPDATE ' + @SqlTable + N' SET SALESMANCODE = @Code WHERE LOGICALREF = @LogicalRef';
        EXEC sys.sp_executesql
            @Sql,
            N'@Code VARCHAR(25), @LogicalRef INT',
            @Code = @Code,
            @LogicalRef = @LogicalRef;
    END;

    IF COL_LENGTH(@SqlTable, N'SLSMANCODE') IS NOT NULL
    BEGIN
        SET @Sql = N'UPDATE ' + @SqlTable + N' SET SLSMANCODE = @Code WHERE LOGICALREF = @LogicalRef';
        EXEC sys.sp_executesql
            @Sql,
            N'@Code VARCHAR(25), @LogicalRef INT',
            @Code = @Code,
            @LogicalRef = @LogicalRef;
    END;

    IF COL_LENGTH(@SqlTable, N'SLSMAN_CODE') IS NOT NULL
    BEGIN
        SET @Sql = N'UPDATE ' + @SqlTable + N' SET SLSMAN_CODE = @Code WHERE LOGICALREF = @LogicalRef';
        EXEC sys.sp_executesql
            @Sql,
            N'@Code VARCHAR(25), @LogicalRef INT',
            @Code = @Code,
            @LogicalRef = @LogicalRef;
    END;

    IF COL_LENGTH(@SqlTable, N'SALESMAN_CODE') IS NOT NULL
    BEGIN
        SET @Sql = N'UPDATE ' + @SqlTable + N' SET SALESMAN_CODE = @Code WHERE LOGICALREF = @LogicalRef';
        EXEC sys.sp_executesql
            @Sql,
            N'@Code VARCHAR(25), @LogicalRef INT',
            @Code = @Code,
            @LogicalRef = @LogicalRef;
    END;
END;
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO
CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ExportOrder
    @CustomerExternalRef NVARCHAR(128) = NULL,
    @CustomerCode NVARCHAR(64) = NULL,
    @OrderDate DATE,
    @OrderNo NVARCHAR(64) = NULL,
    @Currency NVARCHAR(3) = N'TRY',
    @Subtotal DECIMAL(15, 2) = 0,
    @DiscountTotal DECIMAL(15, 2) = 0,
    @VatTotal DECIMAL(15, 2) = 0,
    @GrandTotal DECIMAL(15, 2) = 0,
    @ExportKey NVARCHAR(128),
    @PayloadJson NVARCHAR(MAX) = NULL,
    @ExternalRef NVARCHAR(128) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @ExistingExternalRef NVARCHAR(128);
    EXEC dbo.PowersaB2B_BeginExport @ExportKey, N'order', @PayloadJson, @ExistingExternalRef OUTPUT;
    IF @ExistingExternalRef IS NOT NULL
    BEGIN
        SET @ExternalRef = @ExistingExternalRef;
        RETURN;
    END;

    DECLARE @CustomerRef INT = TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(@CustomerExternalRef)), N''));
    DECLARE @Docode VARCHAR(33) = CONVERT(VARCHAR(33), LEFT(COALESCE(NULLIF(@OrderNo, N''), @ExportKey), 33));
    DECLARE @FicheNo VARCHAR(17) = CONVERT(VARCHAR(17), 'F' + RIGHT(REPLICATE('0', 16) + CONVERT(VARCHAR(32), ABS(CHECKSUM(@ExportKey))), 16));
    DECLARE @Specode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(@ExportKey, 11));
    DECLARE @Now DATETIME = GETDATE();
    DECLARE @Hour SMALLINT = DATEPART(HOUR, @Now);
    DECLARE @Minute SMALLINT = DATEPART(MINUTE, @Now);
    DECLARE @Second SMALLINT = DATEPART(SECOND, @Now);
    DECLARE @OrderRef INT;
    DECLARE @ShippingFee DECIMAL(15, 2) = COALESCE(
        TRY_CONVERT(DECIMAL(15, 2), JSON_VALUE(@PayloadJson, '$.shipping_fee_amount')),
        0
    );

    DECLARE @Lines TABLE (
        RowNo INT IDENTITY(1, 1) NOT NULL,
        StockRef INT NULL,
        ProductCode NVARCHAR(64) NULL,
        Quantity DECIMAL(18, 4) NOT NULL,
        Price DECIMAL(18, 4) NOT NULL,
        LineTotal DECIMAL(18, 4) NOT NULL,
        VatRate DECIMAL(18, 4) NOT NULL,
        VatAmount DECIMAL(18, 4) NOT NULL DEFAULT (0),
        UomRef INT NULL,
        UsRef INT NULL,
        LineExp NVARCHAR(251) NULL
    );

    IF @CustomerRef IS NULL
    BEGIN
        SELECT TOP 1 @CustomerRef = LOGICALREF
        FROM dbo.LG_003_CLCARD WITH (NOLOCK)
        WHERE CODE = CONVERT(VARCHAR(17), @CustomerCode)
          AND ISNULL(ACTIVE, 0) = 0;
    END;

    IF @CustomerRef IS NULL
        THROW 51040, 'Logo customer could not be resolved for order export.', 1;

    INSERT INTO @Lines (StockRef, ProductCode, Quantity, Price, LineTotal, VatRate, UomRef, UsRef, LineExp)
    SELECT
        TRY_CONVERT(INT, COALESCE(NULLIF(logo_stock_ref, N''), NULLIF(product_external_ref, N''))),
        product_code,
        CASE WHEN TRY_CONVERT(DECIMAL(18, 4), quantity) > 0 THEN TRY_CONVERT(DECIMAL(18, 4), quantity) ELSE 1 END,
        COALESCE(TRY_CONVERT(DECIMAL(18, 4), unit_net_price), TRY_CONVERT(DECIMAL(18, 4), unit_price), 0),
        COALESCE(TRY_CONVERT(DECIMAL(18, 4), line_total), 0),
        COALESCE(TRY_CONVERT(DECIMAL(18, 4), vat_rate), 0),
        TRY_CONVERT(INT, NULLIF(uom_ref, N'')),
        TRY_CONVERT(INT, NULLIF(unitset_ref, N'')),
        CONVERT(NVARCHAR(251), LEFT(COALESCE(NULLIF(product_name, N''), NULLIF(product_code, N''), N'Powersa B2B siparis'), 251))
    FROM OPENJSON(@PayloadJson, '$.items')
    WITH (
        product_external_ref NVARCHAR(128) '$.product_external_ref',
        product_code NVARCHAR(64) '$.product_code',
        product_name NVARCHAR(251) '$.product_name',
        quantity NVARCHAR(32) '$.quantity',
        unit_net_price NVARCHAR(32) '$.unit_net_price',
        unit_price NVARCHAR(32) '$.unit_price',
        line_total NVARCHAR(32) '$.line_total',
        vat_rate NVARCHAR(32) '$.vat_rate',
        logo_stock_ref NVARCHAR(128) '$.logo.stock_ref',
        unitset_ref NVARCHAR(128) '$.logo.unitset_ref',
        uom_ref NVARCHAR(128) '$.logo.uom_ref'
    );

    UPDATE lines
       SET StockRef = items.LOGICALREF
      FROM @Lines AS lines
      INNER JOIN dbo.LG_003_ITEMS AS items WITH (NOLOCK)
        ON items.CODE = CONVERT(VARCHAR(25), lines.ProductCode)
     WHERE lines.StockRef IS NULL
       AND NULLIF(lines.ProductCode, N'') IS NOT NULL;

    UPDATE lines
       SET UsRef = COALESCE(lines.UsRef, items.UNITSETREF),
           UomRef = COALESCE(lines.UomRef, unitLines.LOGICALREF)
      FROM @Lines AS lines
      INNER JOIN dbo.LG_003_ITEMS AS items WITH (NOLOCK)
        ON items.LOGICALREF = lines.StockRef
      LEFT JOIN dbo.LG_003_UNITSETL AS unitLines WITH (NOLOCK)
        ON unitLines.UNITSETREF = items.UNITSETREF
       AND ISNULL(unitLines.MAINUNIT, 0) = 1;

    IF NOT EXISTS (SELECT 1 FROM @Lines)
        THROW 51041, 'Order export requires at least one item.', 1;

    IF EXISTS (SELECT 1 FROM @Lines WHERE StockRef IS NULL)
        THROW 51042, 'Logo stock item could not be resolved for order export.', 1;

    UPDATE @Lines
       SET LineTotal = CASE WHEN LineTotal > 0 THEN LineTotal ELSE Quantity * Price END;

    UPDATE @Lines
       SET VatAmount = LineTotal * VatRate / 100;

    BEGIN TRANSACTION;

    INSERT INTO dbo.LG_003_01_ORFICHE (
        TRCODE, FICHENO, DATE_, TIME_, DOCODE, SPECODE, CLIENTREF,
        SOURCEINDEX, SOURCECOSTGRP, UPDCURR, ADDDISCOUNTS, TOTALDISCOUNTS,
        TOTALDISCOUNTED, ADDEXPENSES, TOTALEXPENSES, TOTALVAT, GROSSTOTAL,
        NETTOTAL, REPORTRATE, REPORTNET, GENEXP1, BRANCH, DEPARTMENT,
        STATUS, CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
        CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC,
        TRCURR, TRRATE
    )
    VALUES (
        1, @FicheNo, @OrderDate, 0, @Docode, @Specode, @CustomerRef,
        0, 0, 0, 0, CONVERT(FLOAT, @DiscountTotal),
        CONVERT(FLOAT, @Subtotal), CONVERT(FLOAT, @ShippingFee), CONVERT(FLOAT, @ShippingFee),
        CONVERT(FLOAT, @VatTotal), CONVERT(FLOAT, @Subtotal),
        CONVERT(FLOAT, @GrandTotal), 1, CONVERT(FLOAT, @GrandTotal), CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@OrderNo, N''), @ExportKey), 51)),
        0, 0, 4, 0, 1, @Now, @Hour, @Minute, @Second, 0, 1
    );

    SET @OrderRef = SCOPE_IDENTITY();

    INSERT INTO dbo.LG_003_01_ORFLINE (
        STOCKREF, ORDFICHEREF, CLIENTREF, LINETYPE, LINENO_, TRCODE, DATE_, TIME_,
        GLOBTRANS, CALCTYPE, SPECODE, AMOUNT, PRICE, TOTAL, SHIPPEDAMOUNT,
        VAT, VATAMNT, VATMATRAH, LINEEXP, UOMREF, USREF, UINFO1, UINFO2,
        VATINC, CLOSED, DORESERVE, INUSE, DUEDATE, PRCURR, PRPRICE, REPORTRATE,
        BILLEDITEM, SOURCEINDEX, SOURCECOSTGRP, BRANCH, DEPARTMENT, LINENET,
        STATUS, CANCELLED
    )
    SELECT
        src.StockRef, @OrderRef, @CustomerRef, 0, src.RowNo, 1, @OrderDate, 0,
        0, 0, @Specode, CONVERT(FLOAT, src.Quantity), CONVERT(FLOAT, src.Price),
        CONVERT(FLOAT, src.LineTotal), 0, CONVERT(FLOAT, src.VatRate),
        CONVERT(FLOAT, src.VatAmount), CONVERT(FLOAT, src.LineTotal),
        CONVERT(VARCHAR(251), src.LineExp), COALESCE(src.UomRef, 0), COALESCE(src.UsRef, 0), 1, 1,
        0, 0, 0, 0, @OrderDate, 0, CONVERT(FLOAT, src.Price), 1,
        0, 0, 0, 0, 0, CONVERT(FLOAT, src.LineTotal), 4, 0
    FROM @Lines AS src
    ORDER BY src.RowNo;

    SET @ExternalRef = CONCAT(N'ORFICHE-', @OrderRef);
    EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;

    COMMIT TRANSACTION;
END;
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO
CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ExportShipment
    @CustomerExternalRef NVARCHAR(128) = NULL,
    @CustomerCode NVARCHAR(64) = NULL,
    @ShipmentDate DATE,
    @ShipmentNo NVARCHAR(64) = NULL,
    @OrderNo NVARCHAR(64) = NULL,
    @WarehouseCode NVARCHAR(64) = NULL,
    @Subtotal DECIMAL(15, 2) = 0,
    @VatTotal DECIMAL(15, 2) = 0,
    @GrandTotal DECIMAL(15, 2) = 0,
    @ExportKey NVARCHAR(128),
    @PayloadJson NVARCHAR(MAX) = NULL,
    @ExternalRef NVARCHAR(128) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @ExistingExternalRef NVARCHAR(128);
    EXEC dbo.PowersaB2B_BeginExport @ExportKey, N'shipment', @PayloadJson, @ExistingExternalRef OUTPUT;
    IF @ExistingExternalRef IS NOT NULL
    BEGIN
        SET @ExternalRef = @ExistingExternalRef;
        RETURN;
    END;

    DECLARE @CustomerRef INT = TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(@CustomerExternalRef)), N''));
    DECLARE @SourceIndex SMALLINT = COALESCE(TRY_CONVERT(SMALLINT, NULLIF(@WarehouseCode, N'')), 0);
    DECLARE @Docode VARCHAR(33) = CONVERT(VARCHAR(33), LEFT(COALESCE(NULLIF(@ShipmentNo, N''), NULLIF(@OrderNo, N''), @ExportKey), 33));
    DECLARE @FicheNo VARCHAR(17) = CONVERT(VARCHAR(17), 'F' + RIGHT(REPLICATE('0', 16) + CONVERT(VARCHAR(32), ABS(CHECKSUM(@ExportKey))), 16));
    DECLARE @Specode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(@ExportKey, 11));
    DECLARE @Now DATETIME = GETDATE();
    DECLARE @Hour SMALLINT = DATEPART(HOUR, @Now);
    DECLARE @Minute SMALLINT = DATEPART(MINUTE, @Now);
    DECLARE @Second SMALLINT = DATEPART(SECOND, @Now);
    DECLARE @CyphCode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(COALESCE(NULLIF(@OrderNo, N''), N''), 11));
    DECLARE @LineExp VARCHAR(251) = CONVERT(VARCHAR(251), LEFT(COALESCE(NULLIF(@ShipmentNo, N''), NULLIF(@OrderNo, N''), @ExportKey), 251));
    DECLARE @SalesPriceTypeRaw NVARCHAR(64) = COALESCE(
        NULLIF(JSON_VALUE(@PayloadJson, '$.sales_price_type'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.payment_method'), N'')
    );
    DECLARE @SalesPriceType VARCHAR(51) = CONVERT(VARCHAR(51), LEFT(
        CASE
            WHEN LOWER(COALESCE(@SalesPriceTypeRaw, N'')) IN (N'bank_transfer', N'transfer', N'havale', N'havale/eft', N'havale / eft') THEN N'Havale / EFT'
            WHEN LOWER(COALESCE(@SalesPriceTypeRaw, N'')) IN (N'cash', N'nakit') THEN N'Nakit'
            WHEN LOWER(COALESCE(@SalesPriceTypeRaw, N'')) IN (N'single_payment', N'tek çekim', N'tek cekim') THEN N'Tek Çekim'
            ELSE COALESCE(@SalesPriceTypeRaw, N'')
        END,
        51
    ));
    DECLARE @InvoiceRef INT;
    DECLARE @StockFicheRef INT;
    DECLARE @ClflineRef INT;
    DECLARE @SalespersonCode VARCHAR(25) = CONVERT(VARCHAR(25), LEFT(COALESCE(
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.logo.salesperson_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.logo_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.name'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.username'), N'')
    ), 25));
    DECLARE @PayloadSubtotalRaw NVARCHAR(32) = JSON_VALUE(@PayloadJson, '$.subtotal');
    DECLARE @PayloadVatTotalRaw NVARCHAR(32) = JSON_VALUE(@PayloadJson, '$.vat_total');

    DECLARE @Lines TABLE (
        RowNo INT IDENTITY(1, 1) NOT NULL,
        StockRef INT NULL,
        ProductCode NVARCHAR(64) NULL,
        Quantity DECIMAL(18, 4) NOT NULL,
        Price DECIMAL(18, 4) NOT NULL,
        LineTotal DECIMAL(18, 4) NOT NULL,
        VatRate DECIMAL(18, 4) NOT NULL,
        VatAmount DECIMAL(18, 4) NOT NULL DEFAULT (0),
        UomRef INT NULL,
        UsRef INT NULL,
        LineExp NVARCHAR(251) NULL
    );

    IF @CustomerRef IS NULL
    BEGIN
        SELECT TOP 1 @CustomerRef = LOGICALREF
        FROM dbo.LG_003_CLCARD WITH (NOLOCK)
        WHERE CODE = CONVERT(VARCHAR(17), @CustomerCode)
          AND ISNULL(ACTIVE, 0) = 0;
    END;

    IF @CustomerRef IS NULL
        THROW 51050, 'Logo customer could not be resolved for shipment export.', 1;

    INSERT INTO @Lines (StockRef, ProductCode, Quantity, Price, LineTotal, VatRate, UomRef, UsRef, LineExp)
    SELECT
        TRY_CONVERT(INT, COALESCE(NULLIF(logo_stock_ref, N''), NULLIF(product_external_ref, N''))),
        product_code,
        CASE WHEN TRY_CONVERT(DECIMAL(18, 4), shipped_qty) > 0 THEN TRY_CONVERT(DECIMAL(18, 4), shipped_qty) ELSE 1 END,
        COALESCE(TRY_CONVERT(DECIMAL(18, 4), unit_price), 0),
        COALESCE(TRY_CONVERT(DECIMAL(18, 4), line_total), 0),
        COALESCE(TRY_CONVERT(DECIMAL(18, 4), vat_rate), 0),
        TRY_CONVERT(INT, NULLIF(uom_ref, N'')),
        TRY_CONVERT(INT, NULLIF(unitset_ref, N'')),
        CONVERT(NVARCHAR(251), LEFT(COALESCE(NULLIF(product_name, N''), NULLIF(product_code, N''), N'Powersa B2B irsaliye'), 251))
    FROM OPENJSON(@PayloadJson, '$.items')
    WITH (
        product_external_ref NVARCHAR(128) '$.product_external_ref',
        product_code NVARCHAR(64) '$.product_code',
        product_name NVARCHAR(251) '$.product_name',
        shipped_qty NVARCHAR(32) '$.shipped_qty',
        unit_price NVARCHAR(32) '$.unit_price',
        line_total NVARCHAR(32) '$.line_total',
        vat_rate NVARCHAR(32) '$.vat_rate',
        logo_stock_ref NVARCHAR(128) '$.logo.stock_ref',
        unitset_ref NVARCHAR(128) '$.logo.unitset_ref',
        uom_ref NVARCHAR(128) '$.logo.uom_ref'
    );

    UPDATE lines
       SET StockRef = items.LOGICALREF
      FROM @Lines AS lines
      INNER JOIN dbo.LG_003_ITEMS AS items WITH (NOLOCK)
        ON items.CODE = CONVERT(VARCHAR(25), lines.ProductCode)
     WHERE lines.StockRef IS NULL
       AND NULLIF(lines.ProductCode, N'') IS NOT NULL;

    UPDATE lines
       SET UsRef = COALESCE(lines.UsRef, items.UNITSETREF),
           UomRef = COALESCE(lines.UomRef, unitLines.LOGICALREF)
      FROM @Lines AS lines
      INNER JOIN dbo.LG_003_ITEMS AS items WITH (NOLOCK)
        ON items.LOGICALREF = lines.StockRef
      LEFT JOIN dbo.LG_003_UNITSETL AS unitLines WITH (NOLOCK)
        ON unitLines.UNITSETREF = items.UNITSETREF
       AND ISNULL(unitLines.MAINUNIT, 0) = 1;

    IF NOT EXISTS (SELECT 1 FROM @Lines)
        THROW 51051, 'Shipment export requires at least one item.', 1;

    IF EXISTS (SELECT 1 FROM @Lines WHERE StockRef IS NULL)
        THROW 51052, 'Logo stock item could not be resolved for shipment export.', 1;

    UPDATE @Lines
       SET LineTotal = CASE WHEN LineTotal > 0 THEN LineTotal ELSE Quantity * Price END;

    UPDATE @Lines
       SET VatAmount = LineTotal * VatRate / 100;

    SELECT
        @Subtotal = CASE WHEN @PayloadSubtotalRaw IS NOT NULL OR @Subtotal > 0 THEN @Subtotal ELSE COALESCE(SUM(LineTotal), 0) END,
        @VatTotal = CASE WHEN @PayloadVatTotalRaw IS NOT NULL OR @VatTotal > 0 THEN @VatTotal ELSE COALESCE(SUM(VatAmount), 0) END
    FROM @Lines;

    IF @GrandTotal <= 0
        SET @GrandTotal = @Subtotal + @VatTotal;

    BEGIN TRANSACTION;

    INSERT INTO dbo.LG_003_01_INVOICE (
        GRPCODE, TRCODE, FICHENO, DATE_, DOCODE, SPECODE, CYPHCODE, CLIENTREF,
        SOURCEINDEX, SOURCECOSTGRP, CANCELLED, ACCOUNTED, VAT, TOTALDISCOUNTS,
        TOTALDISCOUNTED, TOTALVAT, GROSSTOTAL, NETTOTAL, GENEXP1, GENEXP2, GENEXP3, GENEXP4,
        TRCURR, TRRATE, REPORTRATE, REPORTNET, PAYDEFREF, BRANCH, DEPARTMENT,
        CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR,
        CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC
    )
    VALUES (
        2, 8, @FicheNo, @ShipmentDate, @Docode, @Specode, @CyphCode, @CustomerRef,
        @SourceIndex, @SourceIndex, 0, 0, CONVERT(FLOAT, @VatTotal), 0,
        CONVERT(FLOAT, @Subtotal), CONVERT(FLOAT, @VatTotal), CONVERT(FLOAT, @Subtotal), CONVERT(FLOAT, @GrandTotal),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@ShipmentNo, N''), @ExportKey), 51)),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@CustomerCode, N''), N''), 51)),
        CONVERT(VARCHAR(51), LEFT(CONCAT(COALESCE(NULLIF(@OrderNo, N''), N''), CASE WHEN NULLIF(@SalesPriceType, '') IS NOT NULL THEN CONCAT(N' | ', @SalesPriceType) ELSE N'' END), 51)),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@WarehouseCode, N''), N''), 51)),
        0, 1, 1, CONVERT(FLOAT, @GrandTotal), 0, 0, 0,
        1, @Now, @Hour, @Minute, @Second
    );

    SET @InvoiceRef = SCOPE_IDENTITY();

    INSERT INTO dbo.LG_003_01_STFICHE (
        GRPCODE, TRCODE, IOCODE, FICHENO, DATE_, FTIME, DOCODE, SPECODE, CYPHCODE,
        CLIENTREF, SOURCETYPE, SOURCEINDEX, SOURCECOSTGRP, BRANCH, DEPARTMENT,
        CANCELLED, BILLED, ACCOUNTED, UPDCURR, INUSE, ADDDISCOUNTS,
        INVOICEREF, TOTALDISCOUNTS, TOTALDISCOUNTED, ADDEXPENSES, TOTALEXPENSES,
        TOTALVAT, GROSSTOTAL, NETTOTAL, REPORTRATE, REPORTNET, GENEXP1, GENEXP2,
        CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR,
        CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC, STATUS
    )
    VALUES (
        2, 8, 4, @FicheNo, @ShipmentDate, 0, @Docode, @Specode, @CyphCode,
        @CustomerRef, 0, @SourceIndex, @SourceIndex, 0, 0,
        0, 1, 0, 0, 0, 0,
        @InvoiceRef, 0, CONVERT(FLOAT, @Subtotal), 0, 0,
        CONVERT(FLOAT, @VatTotal), CONVERT(FLOAT, @Subtotal), CONVERT(FLOAT, @GrandTotal),
        1, CONVERT(FLOAT, @GrandTotal),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@ShipmentNo, N''), @ExportKey), 51)),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@CustomerCode, N''), N''), 51)),
        1, @Now, @Hour, @Minute, @Second, 1
    );

    SET @StockFicheRef = SCOPE_IDENTITY();

    INSERT INTO dbo.LG_003_01_STLINE (
        STOCKREF, LINETYPE, TRCODE, DATE_, FTIME, GLOBTRANS, CALCTYPE,
        SOURCETYPE, SOURCEINDEX, SOURCECOSTGRP, DESTTYPE, DESTINDEX, DESTCOSTGRP,
        FACTORYNR, IOCODE, STFICHEREF, STFICHELNNO, INVOICEREF, INVOICELNNO,
        CLIENTREF, PAYDEFREF, SPECODE, AMOUNT, PRICE, TOTAL, PRCURR, PRPRICE,
        TRCURR, TRRATE, REPORTRATE, LINEEXP, UOMREF, USREF, UINFO1, UINFO2,
        VATINC, VAT, VATAMNT, VATMATRAH,
        BILLEDITEM, BILLED, CANCELLED, LINENET, MONTH_, YEAR_
    )
    SELECT
        src.StockRef, 0, 8, @ShipmentDate, 0, 0, 0,
        0, @SourceIndex, @SourceIndex, 0, 0, 0,
        0, 4, @StockFicheRef, src.RowNo, @InvoiceRef, src.RowNo,
        @CustomerRef, 0, @Specode, CONVERT(FLOAT, src.Quantity),
        CONVERT(FLOAT, src.Price), CONVERT(FLOAT, src.LineTotal), 0, CONVERT(FLOAT, src.Price),
        0, 1, 1, CONVERT(VARCHAR(251), src.LineExp), COALESCE(src.UomRef, 0), COALESCE(src.UsRef, 0), 1, 1,
        0, CONVERT(FLOAT, src.VatRate), CONVERT(FLOAT, src.VatAmount), CONVERT(FLOAT, src.LineTotal),
        0, 1, 0, CONVERT(FLOAT, src.LineTotal), MONTH(@ShipmentDate), YEAR(@ShipmentDate)
    FROM @Lines AS src
    ORDER BY src.RowNo;

    INSERT INTO dbo.LG_003_01_CLFLINE (
        CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, SPECODE, CYPHCODE,
        TRANNO, DOCODE, LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET,
        REPORTRATE, REPORTNET, CANCELLED, CAPIBLOCK_CREATEDBY,
        CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN,
        CAPIBLOCK_CREATEDSEC
    )
    VALUES (
        @CustomerRef, @InvoiceRef, @ShipmentDate, 4, 38, @Specode, @CyphCode,
        @FicheNo, @Docode, @LineExp, 0, CONVERT(FLOAT, @GrandTotal), 0, 1, CONVERT(FLOAT, @GrandTotal),
        1, CONVERT(FLOAT, @GrandTotal), 0, 1,
        @Now, @Hour, @Minute, @Second
    );

    SET @ClflineRef = SCOPE_IDENTITY();
    EXEC dbo.PowersaB2B_ApplyCustomerLedgerLogoDefaults @ClflineRef, @ShipmentDate;

    DECLARE @NormalizeSql NVARCHAR(MAX) = N'';

    SELECT @NormalizeSql = @NormalizeSql + N'UPDATE dbo.LG_003_01_INVOICE SET ' + QUOTENAME(c.name) + N' = 0 WHERE LOGICALREF = @Ref AND ' + QUOTENAME(c.name) + N' IS NULL;'
    FROM sys.columns AS c
    INNER JOIN sys.types AS t ON t.user_type_id = c.user_type_id
    WHERE c.object_id = OBJECT_ID(N'dbo.LG_003_01_INVOICE')
      AND c.is_nullable = 1
      AND t.name IN (N'tinyint', N'smallint', N'int', N'bigint', N'float', N'real', N'decimal', N'numeric', N'money', N'smallmoney');

    EXEC sp_executesql @NormalizeSql, N'@Ref INT', @Ref = @InvoiceRef;

    SET @NormalizeSql = N'';
    SELECT @NormalizeSql = @NormalizeSql + N'UPDATE dbo.LG_003_01_STFICHE SET ' + QUOTENAME(c.name) + N' = 0 WHERE LOGICALREF = @Ref AND ' + QUOTENAME(c.name) + N' IS NULL;'
    FROM sys.columns AS c
    INNER JOIN sys.types AS t ON t.user_type_id = c.user_type_id
    WHERE c.object_id = OBJECT_ID(N'dbo.LG_003_01_STFICHE')
      AND c.is_nullable = 1
      AND t.name IN (N'tinyint', N'smallint', N'int', N'bigint', N'float', N'real', N'decimal', N'numeric', N'money', N'smallmoney');

    EXEC sp_executesql @NormalizeSql, N'@Ref INT', @Ref = @StockFicheRef;

    SET @NormalizeSql = N'';
    SELECT @NormalizeSql = @NormalizeSql + N'UPDATE dbo.LG_003_01_STLINE SET ' + QUOTENAME(c.name) + N' = 0 WHERE INVOICEREF = @Ref AND ' + QUOTENAME(c.name) + N' IS NULL;'
    FROM sys.columns AS c
    INNER JOIN sys.types AS t ON t.user_type_id = c.user_type_id
    WHERE c.object_id = OBJECT_ID(N'dbo.LG_003_01_STLINE')
      AND c.is_nullable = 1
      AND t.name IN (N'tinyint', N'smallint', N'int', N'bigint', N'float', N'real', N'decimal', N'numeric', N'money', N'smallmoney');

    EXEC sp_executesql @NormalizeSql, N'@Ref INT', @Ref = @InvoiceRef;

    MERGE dbo.LG_003_01_GNTOTST AS target
    USING (
        SELECT StockRef, @SourceIndex AS InvenNo, SUM(Quantity) AS TotalQty
        FROM @Lines
        GROUP BY StockRef
    ) AS source
    ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
    WHEN MATCHED THEN
        UPDATE SET ONHAND = ONHAND - source.TotalQty
    WHEN NOT MATCHED THEN
        INSERT (STOCKREF, INVENNO, ONHAND, RESERVED, TRANSFERRED)
        VALUES (source.StockRef, source.InvenNo, -source.TotalQty, 0, 0);

    MERGE dbo.LG_003_01_GNTOTST AS target
    USING (
        SELECT StockRef, -1 AS InvenNo, SUM(Quantity) AS TotalQty
        FROM @Lines
        GROUP BY StockRef
    ) AS source
    ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
    WHEN MATCHED THEN
        UPDATE SET ONHAND = ONHAND - source.TotalQty
    WHEN NOT MATCHED THEN
        INSERT (STOCKREF, INVENNO, ONHAND, RESERVED, TRANSFERRED)
        VALUES (source.StockRef, source.InvenNo, -source.TotalQty, 0, 0);

    MERGE dbo.LG_003_01_STINVTOT AS target
    USING (
        SELECT StockRef, @SourceIndex AS InvenNo, SUM(Quantity) AS TotalQty
        FROM @Lines
        GROUP BY StockRef
    ) AS source
    ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
    WHEN MATCHED THEN
        UPDATE SET ONHAND = ONHAND - source.TotalQty, DATE_ = @ShipmentDate
    WHEN NOT MATCHED THEN
        INSERT (STOCKREF, INVENNO, DATE_, ONHAND, RESERVED, TRANSFERRED)
        VALUES (source.StockRef, source.InvenNo, @ShipmentDate, -source.TotalQty, 0, 0);

    MERGE dbo.LG_003_01_STINVTOT AS target
    USING (
        SELECT StockRef, -1 AS InvenNo, SUM(Quantity) AS TotalQty
        FROM @Lines
        GROUP BY StockRef
    ) AS source
    ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
    WHEN MATCHED THEN
        UPDATE SET ONHAND = ONHAND - source.TotalQty, DATE_ = @ShipmentDate
    WHEN NOT MATCHED THEN
        INSERT (STOCKREF, INVENNO, DATE_, ONHAND, RESERVED, TRANSFERRED)
        VALUES (source.StockRef, source.InvenNo, @ShipmentDate, -source.TotalQty, 0, 0);

    SET @ExternalRef = CONCAT(N'INVOICE-', @InvoiceRef);
    EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;

    COMMIT TRANSACTION;
END;
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO
CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ExportPosSale
    @CustomerExternalRef NVARCHAR(128) = NULL,
    @CustomerCode NVARCHAR(64) = NULL,
    @SaleDate DATE,
    @ReceiptNo NVARCHAR(64) = NULL,
    @SaleType NVARCHAR(32) = NULL,
    @DocumentType NVARCHAR(32) = NULL,
    @Subtotal DECIMAL(15, 2) = 0,
    @DiscountTotal DECIMAL(15, 2) = 0,
    @VatTotal DECIMAL(15, 2) = 0,
    @GrandTotal DECIMAL(15, 2) = 0,
    @CashboxCode NVARCHAR(64) = NULL,
    @ExportKey NVARCHAR(128),
    @PayloadJson NVARCHAR(MAX) = NULL,
    @ExternalRef NVARCHAR(128) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @ExistingPosSaleOperation NVARCHAR(32) = LOWER(COALESCE(
        JSON_VALUE(@PayloadJson, '$.meta.operation'),
        JSON_VALUE(@PayloadJson, '$.logo.operation'),
        N''
    ));
    DECLARE @ExistingPosSaleExternalRef NVARCHAR(128) = COALESCE(
        JSON_VALUE(@PayloadJson, '$.meta.logo_external_ref'),
        JSON_VALUE(@PayloadJson, '$.logo.existing_external_ref')
    );
    DECLARE @ExistingPosSaleRefId INT = TRY_CONVERT(INT, SUBSTRING(@ExistingPosSaleExternalRef, CHARINDEX(N'-', @ExistingPosSaleExternalRef) + 1, 32));
    DECLARE @IsDeliveryUpdate BIT = CASE
        WHEN @ExistingPosSaleOperation = N'update'
         AND LOWER(COALESCE(@DocumentType, N'')) = N'delivery'
         AND @ExistingPosSaleExternalRef LIKE N'STFICHE-%'
         AND @ExistingPosSaleRefId IS NOT NULL
        THEN 1 ELSE 0 END;
    DECLARE @IsDeliveryDelete BIT = CASE
        WHEN @ExistingPosSaleOperation = N'delete'
         AND LOWER(COALESCE(@DocumentType, N'')) = N'delivery'
         AND @ExistingPosSaleExternalRef LIKE N'STFICHE-%'
         AND @ExistingPosSaleRefId IS NOT NULL
        THEN 1 ELSE 0 END;
    DECLARE @ExistingExternalRef NVARCHAR(128);
    EXEC dbo.PowersaB2B_BeginExport @ExportKey, N'pos-sale', @PayloadJson, @ExistingExternalRef OUTPUT;
    IF @ExistingExternalRef IS NOT NULL
    BEGIN
        DECLARE @ExistingRefId INT = TRY_CONVERT(INT, SUBSTRING(COALESCE(@ExistingPosSaleExternalRef, @ExistingExternalRef), CHARINDEX(N'-', COALESCE(@ExistingPosSaleExternalRef, @ExistingExternalRef)) + 1, 32));
        DECLARE @ExistingRefIsValid BIT = 0;

        IF COALESCE(@ExistingPosSaleExternalRef, @ExistingExternalRef) LIKE N'STFICHE-%'
           AND @ExistingRefId IS NOT NULL
           AND EXISTS (
               SELECT 1
               FROM dbo.LG_003_01_STFICHE WITH (NOLOCK)
               WHERE LOGICALREF = @ExistingRefId
                 AND (
                    @IsDeliveryUpdate = 1
                    OR @IsDeliveryDelete = 1
                    OR GENEXP1 = CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@ReceiptNo, N''), @ExportKey), 51))
                 )
           )
            SET @ExistingRefIsValid = 1;

        IF @ExistingExternalRef LIKE N'INVOICE-%'
           AND @ExistingRefId IS NOT NULL
           AND EXISTS (
               SELECT 1
               FROM dbo.LG_003_01_INVOICE WITH (NOLOCK)
               WHERE LOGICALREF = @ExistingRefId
                 AND GENEXP1 = CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@ReceiptNo, N''), @ExportKey), 51))
           )
            SET @ExistingRefIsValid = 1;

        IF (@IsDeliveryUpdate = 1 OR @IsDeliveryDelete = 1) AND @ExistingRefIsValid = 0
            THROW 51069, 'Existing Logo delivery note reference could not be resolved for update/delete.', 1;

        IF @ExistingRefIsValid = 1 AND @IsDeliveryUpdate = 0 AND @IsDeliveryDelete = 0
        BEGIN
            SET @ExternalRef = @ExistingExternalRef;
            RETURN;
        END;

        IF @ExistingRefIsValid = 1 AND (@IsDeliveryUpdate = 1 OR @IsDeliveryDelete = 1)
        BEGIN
            SET @ExistingPosSaleRefId = @ExistingRefId;
            UPDATE dbo.POWERSA_B2B_EXPORT_LOG
               SET STATUS = N'pending',
                   ERROR_MESSAGE = NULL,
                   PAYLOAD_JSON = @PayloadJson,
                   UPDATED_AT = SYSUTCDATETIME()
             WHERE EXPORT_KEY = @ExportKey;
        END;

        IF @IsDeliveryUpdate = 0 AND @IsDeliveryDelete = 0
        BEGIN
            UPDATE dbo.POWERSA_B2B_EXPORT_LOG
           SET STATUS = N'pending',
               EXTERNAL_REF = NULL,
               ERROR_MESSAGE = CONCAT(N'Stale external ref ignored: ', @ExistingExternalRef),
               PAYLOAD_JSON = @PayloadJson,
               UPDATED_AT = SYSUTCDATETIME()
         WHERE EXPORT_KEY = @ExportKey;
        END;
    END;

    DECLARE @CustomerRef INT = TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(@CustomerExternalRef)), N''));
    DECLARE @SourceIndex SMALLINT = COALESCE(
        TRY_CONVERT(SMALLINT, JSON_VALUE(@PayloadJson, '$.logo.source_index')),
        TRY_CONVERT(SMALLINT, JSON_VALUE(@PayloadJson, '$.logo.warehouse_no'))
    );
    DECLARE @Branch SMALLINT = TRY_CONVERT(SMALLINT, JSON_VALUE(@PayloadJson, '$.logo.branch'));
    DECLARE @Department SMALLINT = COALESCE(TRY_CONVERT(SMALLINT, JSON_VALUE(@PayloadJson, '$.logo.department')), 0);

    IF @SourceIndex IS NULL AND @CashboxCode = '100.04.001'
    BEGIN
        SET @SourceIndex = 4;
        SET @Branch = COALESCE(@Branch, 3);
    END;
    ELSE IF @SourceIndex IS NULL AND @CashboxCode = '100.01.007'
    BEGIN
        SET @SourceIndex = 0;
        SET @Branch = COALESCE(@Branch, 0);
    END;
    ELSE IF @SourceIndex IS NULL
        SET @SourceIndex = 0;

    SET @Branch = COALESCE(
        @Branch,
        CASE @SourceIndex
            WHEN 2 THEN 1 -- Trabzon
            WHEN 3 THEN 2 -- Samsun
            WHEN 4 THEN 3 -- Batum
            ELSE 0       -- Erzurum / Erzurum Point
        END
    );
    SET @Department = COALESCE(@Department, 0);
    DECLARE @Docode VARCHAR(33) = CONVERT(VARCHAR(33), LEFT(COALESCE(NULLIF(@ReceiptNo, N''), @ExportKey), 33));
    DECLARE @FicheNo VARCHAR(17) = CONVERT(VARCHAR(17), 'F' + RIGHT(REPLICATE('0', 16) + CONVERT(VARCHAR(32), ABS(CHECKSUM(@ExportKey))), 16));
    DECLARE @StockFicheNo VARCHAR(17) = @FicheNo;
    DECLARE @Specode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(@ExportKey, 11));
    DECLARE @Now DATETIME = GETDATE();
    DECLARE @Hour SMALLINT = DATEPART(HOUR, @Now);
    DECLARE @Minute SMALLINT = DATEPART(MINUTE, @Now);
    DECLARE @Second SMALLINT = DATEPART(SECOND, @Now);
    DECLARE @CyphCode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(COALESCE(NULLIF(@SaleType, N''), N''), 11));
    DECLARE @LineExp VARCHAR(251) = CONVERT(VARCHAR(251), LEFT(COALESCE(NULLIF(@ReceiptNo, N''), @ExportKey), 251));
    DECLARE @IsInvoice BIT = CASE WHEN LOWER(COALESCE(@DocumentType, N'')) = N'delivery' THEN 0 ELSE 1 END;
    DECLARE @DeliveryFichePrefix CHAR(1) = CASE
        WHEN @SourceIndex = 4 THEN 'H' -- Batum
        WHEN @SourceIndex = 3 THEN 'S' -- Samsun
        WHEN @SourceIndex = 2 THEN 'T' -- Trabzon
        ELSE 'A' -- Erzurum Point / default POS irsaliye serisi
    END;
    DECLARE @NormalizedSaleType NVARCHAR(32) = LOWER(LTRIM(RTRIM(COALESCE(@SaleType, N''))));
    DECLARE @IsCashSale BIT = CASE WHEN @NormalizedSaleType IN (N'cash', N'nakit') THEN 1 ELSE 0 END;
    DECLARE @InvoiceRef INT;
    DECLARE @StockFicheRef INT;
    DECLARE @ClflineRef INT;
    DECLARE @SalespersonCode VARCHAR(25) = CONVERT(VARCHAR(25), LEFT(COALESCE(
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.logo.salesperson_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.logo_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.name'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.username'), N'')
    ), 25));

    IF @IsDeliveryDelete = 1
    BEGIN
        SET @StockFicheRef = @ExistingPosSaleRefId;

        IF NOT EXISTS (
            SELECT 1
            FROM dbo.LG_003_01_STFICHE WITH (UPDLOCK, HOLDLOCK)
            WHERE LOGICALREF = @StockFicheRef
              AND GRPCODE = 2
              AND TRCODE = 8
              AND IOCODE = 4
        )
            THROW 51071, 'Existing Logo delivery note reference could not be resolved for delete.', 1;

        IF EXISTS (
            SELECT 1
            FROM dbo.LG_003_01_STFICHE WITH (UPDLOCK, HOLDLOCK)
            WHERE LOGICALREF = @StockFicheRef
              AND (ISNULL(BILLED, 0) <> 0 OR ISNULL(ACCOUNTED, 0) <> 0)
        )
            THROW 51072, 'Existing Logo delivery note is billed or accounted and cannot be deleted.', 1;

        IF EXISTS (
            SELECT 1
            FROM dbo.LG_003_01_STFICHE WITH (UPDLOCK, HOLDLOCK)
            WHERE LOGICALREF = @StockFicheRef
              AND ISNULL(CANCELLED, 0) = 1
        )
        BEGIN
            SET @ExternalRef = CONCAT(N'STFICHE-', @StockFicheRef);
            EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;
            RETURN;
        END;

        BEGIN TRANSACTION;

        DECLARE @DeleteOldLines TABLE (
            StockRef INT NOT NULL,
            SourceIndex SMALLINT NOT NULL,
            Quantity DECIMAL(18, 4) NOT NULL
        );

        INSERT INTO @DeleteOldLines (StockRef, SourceIndex, Quantity)
        SELECT STOCKREF, SOURCEINDEX, SUM(AMOUNT)
        FROM dbo.LG_003_01_STLINE WITH (UPDLOCK, HOLDLOCK)
        WHERE STFICHEREF = @StockFicheRef
          AND LINETYPE = 0
          AND ISNULL(CANCELLED, 0) = 0
        GROUP BY STOCKREF, SOURCEINDEX;

        UPDATE dbo.LG_003_01_STFICHE
           SET CANCELLED = 1,
               CAPIBLOCK_MODIFIEDBY = 1,
               CAPIBLOCK_MODIFIEDDATE = @Now,
               CAPIBLOCK_MODIFIEDHOUR = @Hour,
               CAPIBLOCK_MODIFIEDMIN = @Minute,
               CAPIBLOCK_MODIFIEDSEC = @Second
         WHERE LOGICALREF = @StockFicheRef;

        UPDATE dbo.LG_003_01_STLINE
           SET CANCELLED = 1
         WHERE STFICHEREF = @StockFicheRef;

        MERGE dbo.LG_003_01_GNTOTST AS target
        USING (
            SELECT StockRef, SourceIndex AS InvenNo, Quantity AS QuantityDelta
            FROM @DeleteOldLines
        ) AS source
        ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
        WHEN MATCHED THEN
            UPDATE SET ONHAND = ONHAND + source.QuantityDelta
        WHEN NOT MATCHED THEN
            INSERT (STOCKREF, INVENNO, ONHAND, RESERVED, TRANSFERRED)
            VALUES (source.StockRef, source.InvenNo, source.QuantityDelta, 0, 0);

        MERGE dbo.LG_003_01_GNTOTST AS target
        USING (
            SELECT StockRef, -1 AS InvenNo, SUM(Quantity) AS QuantityDelta
            FROM @DeleteOldLines
            GROUP BY StockRef
        ) AS source
        ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
        WHEN MATCHED THEN
            UPDATE SET ONHAND = ONHAND + source.QuantityDelta
        WHEN NOT MATCHED THEN
            INSERT (STOCKREF, INVENNO, ONHAND, RESERVED, TRANSFERRED)
            VALUES (source.StockRef, source.InvenNo, source.QuantityDelta, 0, 0);

        MERGE dbo.LG_003_01_STINVTOT AS target
        USING (
            SELECT StockRef, SourceIndex AS InvenNo, Quantity AS QuantityDelta
            FROM @DeleteOldLines
        ) AS source
        ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
        WHEN MATCHED THEN
            UPDATE SET ONHAND = ONHAND + source.QuantityDelta, DATE_ = @SaleDate
        WHEN NOT MATCHED THEN
            INSERT (STOCKREF, INVENNO, DATE_, ONHAND, RESERVED, TRANSFERRED)
            VALUES (source.StockRef, source.InvenNo, @SaleDate, source.QuantityDelta, 0, 0);

        MERGE dbo.LG_003_01_STINVTOT AS target
        USING (
            SELECT StockRef, -1 AS InvenNo, SUM(Quantity) AS QuantityDelta
            FROM @DeleteOldLines
            GROUP BY StockRef
        ) AS source
        ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
        WHEN MATCHED THEN
            UPDATE SET ONHAND = ONHAND + source.QuantityDelta, DATE_ = @SaleDate
        WHEN NOT MATCHED THEN
            INSERT (STOCKREF, INVENNO, DATE_, ONHAND, RESERVED, TRANSFERRED)
            VALUES (source.StockRef, source.InvenNo, @SaleDate, source.QuantityDelta, 0, 0);

        SET @ExternalRef = CONCAT(N'STFICHE-', @StockFicheRef);
        EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;

        COMMIT TRANSACTION;
        RETURN;
    END;

    DECLARE @Lines TABLE (
        RowNo INT IDENTITY(1, 1) NOT NULL,
        StockRef INT NULL,
        ProductCode NVARCHAR(64) NULL,
        Quantity DECIMAL(18, 4) NOT NULL,
        Price DECIMAL(18, 4) NOT NULL,
        LineTotal DECIMAL(18, 4) NOT NULL,
        VatRate DECIMAL(18, 4) NOT NULL,
        VatAmount DECIMAL(18, 4) NOT NULL DEFAULT (0),
        UomRef INT NULL,
        UsRef INT NULL,
        LineExp NVARCHAR(251) NULL
    );

    IF @CustomerRef IS NULL
    BEGIN
        SELECT TOP 1 @CustomerRef = LOGICALREF
        FROM dbo.LG_003_CLCARD WITH (NOLOCK)
        WHERE CODE = CONVERT(VARCHAR(17), @CustomerCode)
          AND ISNULL(ACTIVE, 0) = 0;
    END;

    IF @CustomerRef IS NULL
        THROW 51060, 'Logo customer could not be resolved for POS sale export.', 1;

    INSERT INTO @Lines (StockRef, ProductCode, Quantity, Price, LineTotal, VatRate, UomRef, UsRef, LineExp)
    SELECT
        TRY_CONVERT(INT, COALESCE(NULLIF(logo_stock_ref, N''), NULLIF(product_external_ref, N''))),
        product_code,
        CASE WHEN TRY_CONVERT(DECIMAL(18, 4), qty) > 0 THEN TRY_CONVERT(DECIMAL(18, 4), qty) ELSE 1 END,
        COALESCE(TRY_CONVERT(DECIMAL(18, 4), unit_price), 0),
        COALESCE(TRY_CONVERT(DECIMAL(18, 4), line_total), 0),
        COALESCE(TRY_CONVERT(DECIMAL(18, 4), vat_rate), 0),
        TRY_CONVERT(INT, NULLIF(uom_ref, N'')),
        TRY_CONVERT(INT, NULLIF(unitset_ref, N'')),
        CONVERT(NVARCHAR(251), LEFT(COALESCE(NULLIF(product_name, N''), NULLIF(product_code, N''), N'Powersa B2B POS satis'), 251))
    FROM OPENJSON(@PayloadJson, '$.items')
    WITH (
        product_external_ref NVARCHAR(128) '$.product_external_ref',
        product_code NVARCHAR(64) '$.product_code',
        product_name NVARCHAR(251) '$.product_name',
        qty NVARCHAR(32) '$.qty',
        unit_price NVARCHAR(32) '$.unit_price',
        line_total NVARCHAR(32) '$.line_total',
        vat_rate NVARCHAR(32) '$.vat_rate',
        logo_stock_ref NVARCHAR(128) '$.logo.stock_ref',
        unitset_ref NVARCHAR(128) '$.logo.unitset_ref',
        uom_ref NVARCHAR(128) '$.logo.uom_ref'
    );

    UPDATE lines
       SET StockRef = items.LOGICALREF
      FROM @Lines AS lines
      INNER JOIN dbo.LG_003_ITEMS AS items WITH (NOLOCK)
        ON items.CODE = CONVERT(VARCHAR(25), lines.ProductCode)
     WHERE lines.StockRef IS NULL
       AND NULLIF(lines.ProductCode, N'') IS NOT NULL;

    UPDATE lines
       SET UsRef = COALESCE(lines.UsRef, items.UNITSETREF),
           UomRef = COALESCE(lines.UomRef, unitLines.LOGICALREF)
      FROM @Lines AS lines
      INNER JOIN dbo.LG_003_ITEMS AS items WITH (NOLOCK)
        ON items.LOGICALREF = lines.StockRef
      LEFT JOIN dbo.LG_003_UNITSETL AS unitLines WITH (NOLOCK)
        ON unitLines.UNITSETREF = items.UNITSETREF
       AND ISNULL(unitLines.MAINUNIT, 0) = 1;

    IF NOT EXISTS (SELECT 1 FROM @Lines)
        THROW 51061, 'POS sale export requires at least one item.', 1;

    IF EXISTS (SELECT 1 FROM @Lines WHERE StockRef IS NULL)
        THROW 51062, 'Logo stock item could not be resolved for POS sale export.', 1;

    UPDATE @Lines
       SET LineTotal = CASE WHEN LineTotal > 0 THEN LineTotal ELSE Quantity * Price END;

    UPDATE @Lines
       SET VatAmount = LineTotal * VatRate / 100;

    SELECT
        @Subtotal = CASE WHEN @Subtotal > 0 THEN @Subtotal ELSE COALESCE(SUM(LineTotal), 0) END,
        @VatTotal = CASE WHEN @VatTotal > 0 THEN @VatTotal ELSE COALESCE(SUM(VatAmount), 0) END
    FROM @Lines;

    IF @GrandTotal <= 0
        SET @GrandTotal = @Subtotal + @VatTotal;

    BEGIN TRANSACTION;

    DECLARE @NormalizeSql NVARCHAR(MAX) = N'';

    IF @IsDeliveryUpdate = 1
    BEGIN
        SET @StockFicheRef = @ExistingPosSaleRefId;

        IF NOT EXISTS (
            SELECT 1
            FROM dbo.LG_003_01_STFICHE WITH (UPDLOCK, HOLDLOCK)
            WHERE LOGICALREF = @StockFicheRef
              AND GRPCODE = 2
              AND TRCODE = 8
              AND IOCODE = 4
              AND ISNULL(CANCELLED, 0) = 0
              AND ISNULL(BILLED, 0) = 0
              AND ISNULL(ACCOUNTED, 0) = 0
        )
            THROW 51070, 'Existing Logo delivery note is billed, cancelled, accounted or not editable.', 1;

        SELECT @StockFicheNo = FICHENO
        FROM dbo.LG_003_01_STFICHE WITH (UPDLOCK, HOLDLOCK)
        WHERE LOGICALREF = @StockFicheRef;

        DECLARE @OldLines TABLE (
            StockRef INT NOT NULL,
            Quantity DECIMAL(18, 4) NOT NULL
        );

        INSERT INTO @OldLines (StockRef, Quantity)
        SELECT STOCKREF, SUM(AMOUNT)
        FROM dbo.LG_003_01_STLINE WITH (UPDLOCK, HOLDLOCK)
        WHERE STFICHEREF = @StockFicheRef
          AND LINETYPE = 0
          AND ISNULL(CANCELLED, 0) = 0
        GROUP BY STOCKREF;

        UPDATE dbo.LG_003_01_STFICHE
           SET DATE_ = @SaleDate,
               DOCODE = @Docode,
               SPECODE = @Specode,
               CYPHCODE = N'',
               CLIENTREF = @CustomerRef,
               SOURCEINDEX = @SourceIndex,
               SOURCECOSTGRP = @SourceIndex,
               BRANCH = @Branch,
               DEPARTMENT = @Department,
               TOTALDISCOUNTS = CONVERT(FLOAT, @DiscountTotal),
               TOTALDISCOUNTED = CONVERT(FLOAT, @Subtotal),
               TOTALVAT = CONVERT(FLOAT, @VatTotal),
               GROSSTOTAL = CONVERT(FLOAT, @Subtotal),
               NETTOTAL = CONVERT(FLOAT, @GrandTotal),
               REPORTNET = CONVERT(FLOAT, @GrandTotal),
               GENEXP1 = CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@ReceiptNo, N''), @ExportKey), 51)),
               GENEXP2 = CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@CustomerCode, N''), N''), 51)),
               CAPIBLOCK_MODIFIEDBY = 1,
               CAPIBLOCK_MODIFIEDDATE = @Now,
               CAPIBLOCK_MODIFIEDHOUR = @Hour,
               CAPIBLOCK_MODIFIEDMIN = @Minute,
               CAPIBLOCK_MODIFIEDSEC = @Second
         WHERE LOGICALREF = @StockFicheRef;

        DELETE FROM dbo.LG_003_01_STLINE WHERE STFICHEREF = @StockFicheRef;

        INSERT INTO dbo.LG_003_01_STLINE (
            STOCKREF, LINETYPE, TRCODE, DATE_, FTIME, GLOBTRANS, CALCTYPE,
            SOURCETYPE, SOURCEINDEX, SOURCECOSTGRP, DESTTYPE, DESTINDEX, DESTCOSTGRP,
            FACTORYNR, IOCODE, STFICHEREF, STFICHELNNO, INVOICEREF, INVOICELNNO,
            CLIENTREF, SPECODE, AMOUNT,
            PRICE, TOTAL, PRCURR, PRPRICE, TRCURR, TRRATE, REPORTRATE, LINEEXP,
            UOMREF, USREF, UINFO1, UINFO2, VATINC, VAT, VATAMNT, VATMATRAH,
            BILLEDITEM, BILLED, CANCELLED, LINENET, MONTH_, YEAR_, STATUS, RECSTATUS
        )
        SELECT
            src.StockRef, 0, 8, @SaleDate, 0, 0, 0,
            0, @SourceIndex, @SourceIndex, 0, 0, 0,
            0, 4, @StockFicheRef, src.RowNo,
            0, 0,
            @CustomerRef, @Specode, CONVERT(FLOAT, src.Quantity),
            CONVERT(FLOAT, src.Price), CONVERT(FLOAT, src.LineTotal), 0, CONVERT(FLOAT, src.Price), 0, 1, 1,
            CONVERT(VARCHAR(251), src.LineExp), COALESCE(src.UomRef, 0), COALESCE(src.UsRef, 0), 1, 1,
            0, CONVERT(FLOAT, src.VatRate), CONVERT(FLOAT, src.VatAmount), CONVERT(FLOAT, src.LineTotal),
            0, 0, 0, CONVERT(FLOAT, src.LineTotal), MONTH(@SaleDate), YEAR(@SaleDate), 0, 2
        FROM @Lines AS src
        ORDER BY src.RowNo;

        SET @NormalizeSql = N'';
        SELECT @NormalizeSql = @NormalizeSql + N'UPDATE dbo.LG_003_01_STFICHE SET ' + QUOTENAME(c.name) + N' = 0 WHERE LOGICALREF = @Ref AND ' + QUOTENAME(c.name) + N' IS NULL;'
        FROM sys.columns AS c
        INNER JOIN sys.types AS t ON t.user_type_id = c.user_type_id
        WHERE c.object_id = OBJECT_ID(N'dbo.LG_003_01_STFICHE')
          AND c.is_nullable = 1
          AND t.name IN (N'tinyint', N'smallint', N'int', N'bigint', N'float', N'real', N'decimal', N'numeric', N'money', N'smallmoney');

        EXEC sp_executesql @NormalizeSql, N'@Ref INT', @Ref = @StockFicheRef;

        SET @NormalizeSql = N'';
        SELECT @NormalizeSql = @NormalizeSql + N'UPDATE dbo.LG_003_01_STLINE SET ' + QUOTENAME(c.name) + N' = 0 WHERE STFICHEREF = @Ref AND ' + QUOTENAME(c.name) + N' IS NULL;'
        FROM sys.columns AS c
        INNER JOIN sys.types AS t ON t.user_type_id = c.user_type_id
        WHERE c.object_id = OBJECT_ID(N'dbo.LG_003_01_STLINE')
          AND c.is_nullable = 1
          AND t.name IN (N'tinyint', N'smallint', N'int', N'bigint', N'float', N'real', N'decimal', N'numeric', N'money', N'smallmoney');

        EXEC sp_executesql @NormalizeSql, N'@Ref INT', @Ref = @StockFicheRef;

        MERGE dbo.LG_003_01_GNTOTST AS target
        USING (
            SELECT
                COALESCE(OLD.StockRef, NEW.StockRef) AS StockRef,
                @SourceIndex AS InvenNo,
                COALESCE(OLD.Quantity, 0) - COALESCE(NEW.Quantity, 0) AS QuantityDelta
            FROM @OldLines AS OLD
            FULL OUTER JOIN (
                SELECT StockRef, SUM(Quantity) AS Quantity
                FROM @Lines
                GROUP BY StockRef
            ) AS NEW ON NEW.StockRef = OLD.StockRef
        ) AS source
        ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
        WHEN MATCHED THEN
            UPDATE SET ONHAND = ONHAND + source.QuantityDelta
        WHEN NOT MATCHED THEN
            INSERT (STOCKREF, INVENNO, ONHAND, RESERVED, TRANSFERRED)
            VALUES (source.StockRef, source.InvenNo, source.QuantityDelta, 0, 0);

        MERGE dbo.LG_003_01_GNTOTST AS target
        USING (
            SELECT
                COALESCE(OLD.StockRef, NEW.StockRef) AS StockRef,
                -1 AS InvenNo,
                COALESCE(OLD.Quantity, 0) - COALESCE(NEW.Quantity, 0) AS QuantityDelta
            FROM @OldLines AS OLD
            FULL OUTER JOIN (
                SELECT StockRef, SUM(Quantity) AS Quantity
                FROM @Lines
                GROUP BY StockRef
            ) AS NEW ON NEW.StockRef = OLD.StockRef
        ) AS source
        ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
        WHEN MATCHED THEN
            UPDATE SET ONHAND = ONHAND + source.QuantityDelta
        WHEN NOT MATCHED THEN
            INSERT (STOCKREF, INVENNO, ONHAND, RESERVED, TRANSFERRED)
            VALUES (source.StockRef, source.InvenNo, source.QuantityDelta, 0, 0);

        MERGE dbo.LG_003_01_STINVTOT AS target
        USING (
            SELECT
                COALESCE(OLD.StockRef, NEW.StockRef) AS StockRef,
                @SourceIndex AS InvenNo,
                COALESCE(OLD.Quantity, 0) - COALESCE(NEW.Quantity, 0) AS QuantityDelta
            FROM @OldLines AS OLD
            FULL OUTER JOIN (
                SELECT StockRef, SUM(Quantity) AS Quantity
                FROM @Lines
                GROUP BY StockRef
            ) AS NEW ON NEW.StockRef = OLD.StockRef
        ) AS source
        ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
        WHEN MATCHED THEN
            UPDATE SET ONHAND = ONHAND + source.QuantityDelta, DATE_ = @SaleDate
        WHEN NOT MATCHED THEN
            INSERT (STOCKREF, INVENNO, DATE_, ONHAND, RESERVED, TRANSFERRED)
            VALUES (source.StockRef, source.InvenNo, @SaleDate, source.QuantityDelta, 0, 0);

        MERGE dbo.LG_003_01_STINVTOT AS target
        USING (
            SELECT
                COALESCE(OLD.StockRef, NEW.StockRef) AS StockRef,
                -1 AS InvenNo,
                COALESCE(OLD.Quantity, 0) - COALESCE(NEW.Quantity, 0) AS QuantityDelta
            FROM @OldLines AS OLD
            FULL OUTER JOIN (
                SELECT StockRef, SUM(Quantity) AS Quantity
                FROM @Lines
                GROUP BY StockRef
            ) AS NEW ON NEW.StockRef = OLD.StockRef
        ) AS source
        ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
        WHEN MATCHED THEN
            UPDATE SET ONHAND = ONHAND + source.QuantityDelta, DATE_ = @SaleDate
        WHEN NOT MATCHED THEN
            INSERT (STOCKREF, INVENNO, DATE_, ONHAND, RESERVED, TRANSFERRED)
            VALUES (source.StockRef, source.InvenNo, @SaleDate, source.QuantityDelta, 0, 0);

        SET @ExternalRef = CONCAT(N'STFICHE-', @StockFicheRef);
        EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;

        COMMIT TRANSACTION;
        RETURN;
    END;

    IF @IsInvoice = 0
    BEGIN
        DECLARE @LastDeliveryFicheNo BIGINT;

        SELECT @LastDeliveryFicheNo = MAX(TRY_CONVERT(BIGINT, SUBSTRING(FICHENO, 2, 15)))
        FROM dbo.LG_003_01_STFICHE WITH (UPDLOCK, HOLDLOCK)
        WHERE GRPCODE = 2
          AND TRCODE = 8
          AND LEN(FICHENO) = 16
          AND LEFT(FICHENO, 1) = @DeliveryFichePrefix
          AND SUBSTRING(FICHENO, 2, 15) NOT LIKE '%[^0-9]%';

        SET @StockFicheNo = CONVERT(
            VARCHAR(17),
            @DeliveryFichePrefix + RIGHT(REPLICATE('0', 15) + CONVERT(VARCHAR(20), COALESCE(@LastDeliveryFicheNo, 0) + 1), 15)
        );
    END;

    IF @IsInvoice = 1
    BEGIN
        INSERT INTO dbo.LG_003_01_INVOICE (
            GRPCODE, TRCODE, FICHENO, DATE_, DOCODE, SPECODE, CYPHCODE, CLIENTREF,
            SOURCEINDEX, SOURCECOSTGRP, CANCELLED, ACCOUNTED, VAT, TOTALDISCOUNTS,
            TOTALDISCOUNTED, TOTALVAT, GROSSTOTAL, NETTOTAL, GENEXP1, GENEXP2, GENEXP3, GENEXP4,
            TRCURR, TRRATE, REPORTRATE, REPORTNET, PAYDEFREF, BRANCH, DEPARTMENT,
            CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR,
            CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC, CAPIBLOCK_MODIFIEDBY,
            CAPIBLOCK_MODIFIEDDATE, CAPIBLOCK_MODIFIEDHOUR, CAPIBLOCK_MODIFIEDMIN,
            CAPIBLOCK_MODIFIEDSEC, STATUS
        )
        VALUES (
            2, 8, @FicheNo, @SaleDate, @Docode, @Specode, N'', @CustomerRef,
            @SourceIndex, @SourceIndex, 0, 0, CONVERT(FLOAT, @VatTotal), CONVERT(FLOAT, @DiscountTotal),
            CONVERT(FLOAT, @Subtotal), CONVERT(FLOAT, @VatTotal), CONVERT(FLOAT, @Subtotal), CONVERT(FLOAT, @GrandTotal),
            CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@ReceiptNo, N''), @ExportKey), 51)),
            CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@CustomerCode, N''), N''), 51)),
            CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@CashboxCode, N''), N''), 51)),
            CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@DocumentType, N''), N''), 51)),
            0, 1, 1, CONVERT(FLOAT, @GrandTotal), 0, @Branch, @Department,
            1, @Now, @Hour, @Minute, @Second, 1,
            @Now, @Hour, @Minute, @Second, 1
        );

        SET @InvoiceRef = SCOPE_IDENTITY();
        EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_INVOICE', @InvoiceRef, @SalespersonCode;
    END;

    INSERT INTO dbo.LG_003_01_STFICHE (
        GRPCODE, TRCODE, IOCODE, FICHENO, DATE_, FTIME, DOCODE, SPECODE, CYPHCODE,
        CLIENTREF, SOURCETYPE, SOURCEINDEX, SOURCECOSTGRP, BRANCH, DEPARTMENT,
        CANCELLED, BILLED, ACCOUNTED, UPDCURR, INUSE, ADDDISCOUNTS,
        INVOICEREF, TOTALDISCOUNTS, TOTALDISCOUNTED, ADDEXPENSES, TOTALEXPENSES,
        TOTALVAT, GROSSTOTAL, NETTOTAL, REPORTRATE, REPORTNET, GENEXP1, GENEXP2,
        CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR,
        CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC, CAPIBLOCK_MODIFIEDBY,
        CAPIBLOCK_MODIFIEDDATE, CAPIBLOCK_MODIFIEDHOUR, CAPIBLOCK_MODIFIEDMIN,
        CAPIBLOCK_MODIFIEDSEC, STATUS
    )
    VALUES (
        2, 8, 4, @StockFicheNo, @SaleDate, 0, @Docode, @Specode, N'',
        @CustomerRef, 0, @SourceIndex, @SourceIndex, @Branch, @Department,
        0, @IsInvoice, 0, 0, 0, 0,
        CASE WHEN @IsInvoice = 1 THEN @InvoiceRef ELSE 0 END,
        CONVERT(FLOAT, @DiscountTotal), CONVERT(FLOAT, @Subtotal), 0, 0,
        CONVERT(FLOAT, @VatTotal), CONVERT(FLOAT, @Subtotal), CONVERT(FLOAT, @GrandTotal),
        1, CONVERT(FLOAT, @GrandTotal),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@ReceiptNo, N''), @ExportKey), 51)),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@CustomerCode, N''), N''), 51)),
        1, @Now, @Hour, @Minute, @Second,
        1, @Now, @Hour, @Minute, @Second,
        CASE WHEN @IsInvoice = 1 THEN 1 ELSE 0 END
    );

    SET @StockFicheRef = SCOPE_IDENTITY();
    EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_STFICHE', @StockFicheRef, @SalespersonCode;

    INSERT INTO dbo.LG_003_01_STLINE (
        STOCKREF, LINETYPE, TRCODE, DATE_, FTIME, GLOBTRANS, CALCTYPE,
        SOURCETYPE, SOURCEINDEX, SOURCECOSTGRP, DESTTYPE, DESTINDEX, DESTCOSTGRP,
        FACTORYNR, IOCODE, STFICHEREF, STFICHELNNO, INVOICEREF, INVOICELNNO,
        CLIENTREF, SPECODE, AMOUNT,
        PRICE, TOTAL, PRCURR, PRPRICE, TRCURR, TRRATE, REPORTRATE, LINEEXP,
        UOMREF, USREF, UINFO1, UINFO2, VATINC, VAT, VATAMNT, VATMATRAH,
        BILLEDITEM, BILLED, CANCELLED, LINENET, MONTH_, YEAR_, STATUS, RECSTATUS
    )
    SELECT
        src.StockRef, 0, 8, @SaleDate, 0, 0, 0,
        0, @SourceIndex, @SourceIndex, 0, 0, 0,
        0, 4, @StockFicheRef, src.RowNo,
        CASE WHEN @IsInvoice = 1 THEN @InvoiceRef ELSE 0 END,
        CASE WHEN @IsInvoice = 1 THEN src.RowNo ELSE 0 END,
        @CustomerRef, @Specode, CONVERT(FLOAT, src.Quantity),
        CONVERT(FLOAT, src.Price), CONVERT(FLOAT, src.LineTotal), 0, CONVERT(FLOAT, src.Price), 0, 1, 1,
        CONVERT(VARCHAR(251), src.LineExp), COALESCE(src.UomRef, 0), COALESCE(src.UsRef, 0), 1, 1,
        0, CONVERT(FLOAT, src.VatRate), CONVERT(FLOAT, src.VatAmount), CONVERT(FLOAT, src.LineTotal),
        0, @IsInvoice, 0, CONVERT(FLOAT, src.LineTotal), MONTH(@SaleDate), YEAR(@SaleDate), 0, 2
    FROM @Lines AS src
    ORDER BY src.RowNo;

    DECLARE @SalespersonRef INT = NULL;
    IF COL_LENGTH(N'dbo.LG_003_01_STFICHE', N'SALESMANREF') IS NOT NULL
       AND COL_LENGTH(N'dbo.LG_003_01_STLINE', N'SALESMANREF') IS NOT NULL
    BEGIN
        EXEC sys.sp_executesql
            N'SELECT @ResolvedRef = SALESMANREF FROM dbo.LG_003_01_STFICHE WHERE LOGICALREF = @StockFicheRef',
            N'@StockFicheRef INT, @ResolvedRef INT OUTPUT',
            @StockFicheRef = @StockFicheRef,
            @ResolvedRef = @SalespersonRef OUTPUT;

        IF @SalespersonRef IS NOT NULL
        BEGIN
            EXEC sys.sp_executesql
                N'UPDATE dbo.LG_003_01_STLINE SET SALESMANREF = @SalespersonRef WHERE STFICHEREF = @StockFicheRef',
                N'@SalespersonRef INT, @StockFicheRef INT',
                @SalespersonRef = @SalespersonRef,
                @StockFicheRef = @StockFicheRef;
        END;
    END;

    IF @IsInvoice = 1
    BEGIN
        INSERT INTO dbo.LG_003_01_CLFLINE (
            CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, SPECODE, CYPHCODE,
            TRANNO, DOCODE, LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET,
            REPORTRATE, REPORTNET, CANCELLED, CAPIBLOCK_CREATEDBY,
            CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN,
            CAPIBLOCK_CREATEDSEC
        )
        VALUES (
            @CustomerRef, @InvoiceRef, @SaleDate, 4, 38, @Specode, @CyphCode,
            @FicheNo, @Docode, @LineExp, 0, CONVERT(FLOAT, @GrandTotal), 0, 1, CONVERT(FLOAT, @GrandTotal),
            1, CONVERT(FLOAT, @GrandTotal), 0, 1,
            @Now, @Hour, @Minute, @Second
        );

        SET @ClflineRef = SCOPE_IDENTITY();
        EXEC dbo.PowersaB2B_ApplyCustomerLedgerLogoDefaults @ClflineRef, @SaleDate;
        EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_CLFLINE', @ClflineRef, @SalespersonCode;
        
        IF @IsCashSale = 1 AND NULLIF(@CashboxCode, N'') IS NOT NULL
        BEGIN
            DECLARE @CashboxRef INT;
            SELECT TOP 1 @CashboxRef = LOGICALREF
            FROM dbo.LG_003_KSCARD WITH (NOLOCK)
            WHERE CODE = CONVERT(VARCHAR(25), @CashboxCode)
              AND ISNULL(ACTIVE, 0) = 0;

            IF @CashboxRef IS NOT NULL
            BEGIN
                DECLARE @KslinesRef INT;
                DECLARE @PaymentClflineRef INT;

                INSERT INTO dbo.LG_003_01_KSLINES (
                    CARDREF, DATE_, HOUR_, MINUTE_, TRCODE, SPECODE, CYPHCODE, FICHENO,
                    LINEEXP, AMOUNT, CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
                    CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC,
                    CAPIBLOCK_MODIFIEDBY, CAPIBLOCK_MODIFIEDDATE, CAPIBLOCK_MODIFIEDHOUR,
                    CAPIBLOCK_MODIFIEDMIN, CAPIBLOCK_MODIFIEDSEC,
                    DOCODE
                )
                VALUES (
                    @CashboxRef, @SaleDate, @Hour, @Minute, 11, @Specode, @CyphCode, @FicheNo,
                    @LineExp, CONVERT(FLOAT, @GrandTotal), 0, 1, @Now,
                    @Hour, @Minute, @Second,
                    1, @Now, @Hour, @Minute, @Second,
                    @Docode
                );

                SET @KslinesRef = SCOPE_IDENTITY();
                EXEC dbo.PowersaB2B_ApplyCashboxInSign @KslinesRef;
                EXEC dbo.PowersaB2B_ApplyCashboxLocalCurrencyTotals @KslinesRef;
                EXEC dbo.PowersaB2B_ApplyCashboxLogoDefaults @KslinesRef;
                EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_KSLINES', @KslinesRef, @SalespersonCode;

                INSERT INTO dbo.LG_003_01_CLFLINE (
                    CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, SPECODE, CYPHCODE,
                    TRANNO, DOCODE, LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET,
                    REPORTRATE, REPORTNET, CANCELLED, CAPIBLOCK_CREATEDBY,
                    CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN,
                    CAPIBLOCK_CREATEDSEC
                )
                VALUES (
                    @CustomerRef, @KslinesRef, @SaleDate, 10, 14, @Specode, @CyphCode,
                    @FicheNo, @Docode, @LineExp, 1, CONVERT(FLOAT, @GrandTotal), 0, 1, CONVERT(FLOAT, @GrandTotal),
                    1, CONVERT(FLOAT, @GrandTotal), 0, 1,
                    @Now, @Hour, @Minute, @Second
                );

                SET @PaymentClflineRef = SCOPE_IDENTITY();
                EXEC dbo.PowersaB2B_ApplyCustomerLedgerLogoDefaults @PaymentClflineRef, @SaleDate;
                EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_CLFLINE', @PaymentClflineRef, @SalespersonCode;

                UPDATE dbo.LG_003_01_KSLINES
                   SET TRANSREF = @PaymentClflineRef
                 WHERE LOGICALREF = @KslinesRef;
            END
        END
    END;

    SET @NormalizeSql = N'';

    IF @IsInvoice = 1 AND @InvoiceRef IS NOT NULL
    BEGIN
        SELECT @NormalizeSql = @NormalizeSql + N'UPDATE dbo.LG_003_01_INVOICE SET ' + QUOTENAME(c.name) + N' = 0 WHERE LOGICALREF = @Ref AND ' + QUOTENAME(c.name) + N' IS NULL;'
        FROM sys.columns AS c
        INNER JOIN sys.types AS t ON t.user_type_id = c.user_type_id
        WHERE c.object_id = OBJECT_ID(N'dbo.LG_003_01_INVOICE')
          AND c.is_nullable = 1
          AND t.name IN (N'tinyint', N'smallint', N'int', N'bigint', N'float', N'real', N'decimal', N'numeric', N'money', N'smallmoney');

        EXEC sp_executesql @NormalizeSql, N'@Ref INT', @Ref = @InvoiceRef;
    END;

    SET @NormalizeSql = N'';
    SELECT @NormalizeSql = @NormalizeSql + N'UPDATE dbo.LG_003_01_STFICHE SET ' + QUOTENAME(c.name) + N' = 0 WHERE LOGICALREF = @Ref AND ' + QUOTENAME(c.name) + N' IS NULL;'
    FROM sys.columns AS c
    INNER JOIN sys.types AS t ON t.user_type_id = c.user_type_id
    WHERE c.object_id = OBJECT_ID(N'dbo.LG_003_01_STFICHE')
      AND c.is_nullable = 1
      AND t.name IN (N'tinyint', N'smallint', N'int', N'bigint', N'float', N'real', N'decimal', N'numeric', N'money', N'smallmoney');

    EXEC sp_executesql @NormalizeSql, N'@Ref INT', @Ref = @StockFicheRef;

    SET @NormalizeSql = N'';
    SELECT @NormalizeSql = @NormalizeSql + N'UPDATE dbo.LG_003_01_STLINE SET ' + QUOTENAME(c.name) + N' = 0 WHERE STFICHEREF = @Ref AND ' + QUOTENAME(c.name) + N' IS NULL;'
    FROM sys.columns AS c
    INNER JOIN sys.types AS t ON t.user_type_id = c.user_type_id
    WHERE c.object_id = OBJECT_ID(N'dbo.LG_003_01_STLINE')
      AND c.is_nullable = 1
      AND t.name IN (N'tinyint', N'smallint', N'int', N'bigint', N'float', N'real', N'decimal', N'numeric', N'money', N'smallmoney');

    EXEC sp_executesql @NormalizeSql, N'@Ref INT', @Ref = @StockFicheRef;

    MERGE dbo.LG_003_01_GNTOTST AS target
    USING (
        SELECT StockRef, @SourceIndex AS InvenNo, SUM(Quantity) AS TotalQty
        FROM @Lines
        GROUP BY StockRef
    ) AS source
    ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
    WHEN MATCHED THEN
        UPDATE SET ONHAND = ONHAND - source.TotalQty
    WHEN NOT MATCHED THEN
        INSERT (STOCKREF, INVENNO, ONHAND, RESERVED, TRANSFERRED)
        VALUES (source.StockRef, source.InvenNo, -source.TotalQty, 0, 0);

    MERGE dbo.LG_003_01_GNTOTST AS target
    USING (
        SELECT StockRef, -1 AS InvenNo, SUM(Quantity) AS TotalQty
        FROM @Lines
        GROUP BY StockRef
    ) AS source
    ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
    WHEN MATCHED THEN
        UPDATE SET ONHAND = ONHAND - source.TotalQty
    WHEN NOT MATCHED THEN
        INSERT (STOCKREF, INVENNO, ONHAND, RESERVED, TRANSFERRED)
        VALUES (source.StockRef, source.InvenNo, -source.TotalQty, 0, 0);

    MERGE dbo.LG_003_01_STINVTOT AS target
    USING (
        SELECT StockRef, @SourceIndex AS InvenNo, SUM(Quantity) AS TotalQty
        FROM @Lines
        GROUP BY StockRef
    ) AS source
    ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
    WHEN MATCHED THEN
        UPDATE SET ONHAND = ONHAND - source.TotalQty, DATE_ = @SaleDate
    WHEN NOT MATCHED THEN
        INSERT (STOCKREF, INVENNO, DATE_, ONHAND, RESERVED, TRANSFERRED)
        VALUES (source.StockRef, source.InvenNo, @SaleDate, -source.TotalQty, 0, 0);

    MERGE dbo.LG_003_01_STINVTOT AS target
    USING (
        SELECT StockRef, -1 AS InvenNo, SUM(Quantity) AS TotalQty
        FROM @Lines
        GROUP BY StockRef
    ) AS source
    ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
    WHEN MATCHED THEN
        UPDATE SET ONHAND = ONHAND - source.TotalQty, DATE_ = @SaleDate
    WHEN NOT MATCHED THEN
        INSERT (STOCKREF, INVENNO, DATE_, ONHAND, RESERVED, TRANSFERRED)
        VALUES (source.StockRef, source.InvenNo, @SaleDate, -source.TotalQty, 0, 0);

    SET @ExternalRef = CASE WHEN @IsInvoice = 1 THEN CONCAT(N'INVOICE-', @InvoiceRef) ELSE CONCAT(N'STFICHE-', @StockFicheRef) END;
    EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;

    COMMIT TRANSACTION;
END;
GO
