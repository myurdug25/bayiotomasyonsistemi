/*
  Powersa B2B order, shipment and POS sale write procedures for Logo Go Wings
  firm 003 period 01.

  Payment writes are intentionally left to PowersaB2B_ExportCollection. POS sale
  export writes the stock/delivery side only, so POS cash movements are not
  duplicated in KSLINES/CLFLINE. Shipment export writes the wholesale sales
  invoice side and the matching customer ledger debit.
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
        CONVERT(FLOAT, @Subtotal), 0, 0, CONVERT(FLOAT, @VatTotal), CONVERT(FLOAT, @Subtotal),
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
    DECLARE @InvoiceRef INT;
    DECLARE @StockFicheRef INT;
    DECLARE @ClflineRef INT;

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
        @Subtotal = CASE WHEN @Subtotal > 0 THEN @Subtotal ELSE COALESCE(SUM(LineTotal), 0) END,
        @VatTotal = CASE WHEN @VatTotal > 0 THEN @VatTotal ELSE COALESCE(SUM(VatAmount), 0) END
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
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@OrderNo, N''), N''), 51)),
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
        CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC
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
        1, @Now, @Hour, @Minute, @Second
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
        UPDATE SET ONHAND = ONHAND - source.TotalQty
    WHEN NOT MATCHED THEN
        INSERT (STOCKREF, INVENNO, ONHAND, RESERVED, TRANSFERRED)
        VALUES (source.StockRef, source.InvenNo, -source.TotalQty, 0, 0);

    MERGE dbo.LG_003_01_STINVTOT AS target
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

    DECLARE @ExistingExternalRef NVARCHAR(128);
    EXEC dbo.PowersaB2B_BeginExport @ExportKey, N'pos-sale', @PayloadJson, @ExistingExternalRef OUTPUT;
    IF @ExistingExternalRef IS NOT NULL
    BEGIN
        SET @ExternalRef = @ExistingExternalRef;
        RETURN;
    END;

    DECLARE @CustomerRef INT = TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(@CustomerExternalRef)), N''));
    DECLARE @SourceIndex SMALLINT = 0;
    DECLARE @Branch SMALLINT = 0;
    DECLARE @Department SMALLINT = 0;

    IF @CashboxCode = '100.01.002'
    BEGIN
        SET @SourceIndex = 4;
        SET @Branch = 4;
    END;
    ELSE IF @CashboxCode = '100.01.007'
    BEGIN
        SET @SourceIndex = 0;
        SET @Branch = 0;
    END;
    ELSE
    BEGIN
        SET @SourceIndex = COALESCE(
            TRY_CONVERT(SMALLINT, JSON_VALUE(@PayloadJson, '$.logo.source_index')),
            TRY_CONVERT(SMALLINT, JSON_VALUE(@PayloadJson, '$.logo.warehouse_no')),
            0
        );
        SET @Branch = COALESCE(
            TRY_CONVERT(SMALLINT, JSON_VALUE(@PayloadJson, '$.logo.branch')),
            0
        );
        SET @Department = COALESCE(
            TRY_CONVERT(SMALLINT, JSON_VALUE(@PayloadJson, '$.logo.department')),
            0
        );
    END;
    DECLARE @Docode VARCHAR(33) = CONVERT(VARCHAR(33), LEFT(COALESCE(NULLIF(@ReceiptNo, N''), @ExportKey), 33));
    DECLARE @FicheNo VARCHAR(17) = CONVERT(VARCHAR(17), 'F' + RIGHT(REPLICATE('0', 16) + CONVERT(VARCHAR(32), ABS(CHECKSUM(@ExportKey))), 16));
    DECLARE @Specode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(@ExportKey, 11));
    DECLARE @Now DATETIME = GETDATE();
    DECLARE @Hour SMALLINT = DATEPART(HOUR, @Now);
    DECLARE @Minute SMALLINT = DATEPART(MINUTE, @Now);
    DECLARE @Second SMALLINT = DATEPART(SECOND, @Now);
    DECLARE @CyphCode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(COALESCE(NULLIF(@SaleType, N''), N''), 11));
    DECLARE @LineExp VARCHAR(251) = CONVERT(VARCHAR(251), LEFT(COALESCE(NULLIF(@ReceiptNo, N''), @ExportKey), 251));
    DECLARE @IsInvoice BIT = CASE WHEN LOWER(COALESCE(@DocumentType, N'')) = N'delivery' THEN 0 ELSE 1 END;
    DECLARE @InvoiceRef INT;
    DECLARE @StockFicheRef INT;
    DECLARE @ClflineRef INT;

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

    IF @IsInvoice = 1
    BEGIN
        INSERT INTO dbo.LG_003_01_INVOICE (
            GRPCODE, TRCODE, FICHENO, DATE_, DOCODE, SPECODE, CYPHCODE, CLIENTREF,
            SOURCEINDEX, SOURCECOSTGRP, CANCELLED, ACCOUNTED, VAT, TOTALDISCOUNTS,
            TOTALDISCOUNTED, TOTALVAT, GROSSTOTAL, NETTOTAL, GENEXP1, GENEXP2, GENEXP3, GENEXP4,
            TRCURR, TRRATE, REPORTRATE, REPORTNET, PAYDEFREF, BRANCH, DEPARTMENT,
            CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR,
            CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC, STATUS
        )
        VALUES (
            2, 8, @FicheNo, @SaleDate, @Docode, @Specode, @CyphCode, @CustomerRef,
            @SourceIndex, @SourceIndex, 0, 0, CONVERT(FLOAT, @VatTotal), CONVERT(FLOAT, @DiscountTotal),
            CONVERT(FLOAT, @Subtotal), CONVERT(FLOAT, @VatTotal), CONVERT(FLOAT, @Subtotal), CONVERT(FLOAT, @GrandTotal),
            CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@ReceiptNo, N''), @ExportKey), 51)),
            CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@CustomerCode, N''), N''), 51)),
            CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@CashboxCode, N''), N''), 51)),
            CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@DocumentType, N''), N''), 51)),
            0, 1, 1, CONVERT(FLOAT, @GrandTotal), 0, @Branch, @Department,
            1, @Now, @Hour, @Minute, @Second, 1
        );

        SET @InvoiceRef = SCOPE_IDENTITY();
    END;

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
        2, 8, 4, @FicheNo, @SaleDate, 0, @Docode, @Specode, @CyphCode,
        @CustomerRef, 0, @SourceIndex, @SourceIndex, @Branch, @Department,
        0, @IsInvoice, 0, 0, 0, 0,
        CASE WHEN @IsInvoice = 1 THEN @InvoiceRef ELSE 0 END,
        CONVERT(FLOAT, @DiscountTotal), CONVERT(FLOAT, @Subtotal), 0, 0,
        CONVERT(FLOAT, @VatTotal), CONVERT(FLOAT, @Subtotal), CONVERT(FLOAT, @GrandTotal),
        1, CONVERT(FLOAT, @GrandTotal),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@ReceiptNo, N''), @ExportKey), 51)),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@CustomerCode, N''), N''), 51)),
        1, @Now, @Hour, @Minute, @Second, 1
    );

    SET @StockFicheRef = SCOPE_IDENTITY();

    INSERT INTO dbo.LG_003_01_STLINE (
        STOCKREF, LINETYPE, TRCODE, DATE_, FTIME, GLOBTRANS, CALCTYPE,
        SOURCETYPE, SOURCEINDEX, SOURCECOSTGRP, DESTTYPE, DESTINDEX, DESTCOSTGRP,
        FACTORYNR, IOCODE, STFICHEREF, STFICHELNNO, INVOICEREF, INVOICELNNO,
        CLIENTREF, SPECODE, AMOUNT,
        PRICE, TOTAL, PRCURR, PRPRICE, TRCURR, TRRATE, REPORTRATE, LINEEXP,
        UOMREF, USREF, UINFO1, UINFO2, VATINC, VAT, VATAMNT, VATMATRAH,
        BILLEDITEM, BILLED, CANCELLED, LINENET, MONTH_, YEAR_, STATUS, BRANCH, DEPARTMENT
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
        0, @IsInvoice, 0, CONVERT(FLOAT, src.LineTotal), MONTH(@SaleDate), YEAR(@SaleDate), 1, @Branch, @Department
    FROM @Lines AS src
    ORDER BY src.RowNo;

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
        
        IF NULLIF(@CashboxCode, N'') IS NOT NULL
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
                    DOCODE
                )
                VALUES (
                    @CashboxRef, @SaleDate, @Hour, @Minute, 11, @Specode, @CyphCode, @FicheNo,
                    @LineExp, CONVERT(FLOAT, @GrandTotal), 0, 1, @Now,
                    @Hour, @Minute, @Second,
                    @Docode
                );

                SET @KslinesRef = SCOPE_IDENTITY();

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

                UPDATE dbo.LG_003_01_KSLINES
                   SET TRANSREF = @PaymentClflineRef
                 WHERE LOGICALREF = @KslinesRef;
            END
        END
    END;

    DECLARE @NormalizeSql NVARCHAR(MAX) = N'';

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
        UPDATE SET ONHAND = ONHAND - source.TotalQty
    WHEN NOT MATCHED THEN
        INSERT (STOCKREF, INVENNO, ONHAND, RESERVED, TRANSFERRED)
        VALUES (source.StockRef, source.InvenNo, -source.TotalQty, 0, 0);

    MERGE dbo.LG_003_01_STINVTOT AS target
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

    SET @ExternalRef = CASE WHEN @IsInvoice = 1 THEN CONCAT(N'INVOICE-', @InvoiceRef) ELSE CONCAT(N'STFICHE-', @StockFicheRef) END;
    EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;

    COMMIT TRANSACTION;
END;
GO
