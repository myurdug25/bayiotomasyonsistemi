/*
  Powersa B2B damaged/faulty return scrap write procedure for Logo Go Wings
  firm 003 period 01.

  It writes B2B hasarli/arizali return scrap rows to:
  - LG_003_01_STFICHE (fire fisi, TRCODE = 11)
  - LG_003_01_STLINE  (fire satirlari, TRCODE = 11)

  Live Logo samples on 2026-06-03 showed:
  - STFICHE.GRPCODE = 3
  - STFICHE.TRCODE = 11
  - STFICHE.IOCODE = 3
  - STLINE.TRCODE = 11
  - STLINE.IOCODE = 1 for B2B approved damaged/faulty returns, because the
    warehouse physically receives the returned item and the regional fiili stok
    must increase after warehouse approval.
  - SOURCEINDEX = iadenin bagli oldugu depo/ambar

  B2B sends @DocumentNo as the customer code; this procedure writes it to
  STFICHE.DOCODE so Logo's belge no shows which cari returned the item.
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

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ExportReturnScrap
    @CustomerExternalRef NVARCHAR(128) = NULL,
    @CustomerCode NVARCHAR(64) = NULL,
    @ScrapDate DATE,
    @DocumentNo NVARCHAR(64) = NULL,
    @RequestNo NVARCHAR(64) = NULL,
    @WarehouseCode NVARCHAR(64) = NULL,
    @WarehouseName NVARCHAR(160) = NULL,
    @ReturnType NVARCHAR(32) = NULL,
    @ReasonCode NVARCHAR(64) = NULL,
    @Amount DECIMAL(15, 2) = 0,
    @Currency NVARCHAR(3) = N'TRY',
    @ExportKey NVARCHAR(128),
    @PayloadJson NVARCHAR(MAX) = NULL,
    @ExternalRef NVARCHAR(128) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @ExistingExternalRef NVARCHAR(128);
    EXEC dbo.PowersaB2B_BeginExport @ExportKey, N'return-scrap', @PayloadJson, @ExistingExternalRef OUTPUT;
    IF @ExistingExternalRef IS NOT NULL
    BEGIN
        SET @ExternalRef = @ExistingExternalRef;
        RETURN;
    END;

    DECLARE @CustomerRef INT = TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(@CustomerExternalRef)), N''));
    DECLARE @RequestId BIGINT = TRY_CONVERT(BIGINT, JSON_VALUE(@PayloadJson, '$.return_request_id'));
    DECLARE @Docode VARCHAR(33) = CONVERT(VARCHAR(33), LEFT(COALESCE(NULLIF(@DocumentNo, N''), NULLIF(@CustomerCode, N''), @ExportKey), 33));
    DECLARE @Specode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(@ExportKey, 11));
    DECLARE @FicheNo VARCHAR(16) = CONVERT(VARCHAR(16), RIGHT(REPLICATE('0', 16) + CONVERT(VARCHAR(32), COALESCE(@RequestId, ABS(CHECKSUM(@ExportKey)))), 16));
    DECLARE @CyphCode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(COALESCE(NULLIF(@RequestNo, N''), N''), 11));
    DECLARE @Now DATETIME = GETDATE();
    DECLARE @Hour SMALLINT = DATEPART(HOUR, @Now);
    DECLARE @Minute SMALLINT = DATEPART(MINUTE, @Now);
    DECLARE @Second SMALLINT = DATEPART(SECOND, @Now);
    DECLARE @LogoTime INT = (@Hour * 16777216) + (@Minute * 65536) + (@Second * 256);
    DECLARE @StockFicheRef INT;
    DECLARE @Total DECIMAL(18, 4);
    DECLARE @WarehouseIndex INT = TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(@WarehouseCode)), N''));
    DECLARE @WarehouseIdentity NVARCHAR(320) = UPPER(CONCAT(
        COALESCE(@WarehouseCode, N''), N' ',
        COALESCE(@WarehouseName, N''), N' ',
        COALESCE(JSON_VALUE(@PayloadJson, '$.warehouse_code'), N''), N' ',
        COALESCE(JSON_VALUE(@PayloadJson, '$.warehouse_name'), N'')
    ));

    IF @WarehouseIndex IS NULL
    BEGIN
        SET @WarehouseIndex = CASE
            WHEN @WarehouseIdentity LIKE N'%POINT%' THEN 0
            WHEN @WarehouseIdentity LIKE N'%ERZURUM%' THEN 1
            WHEN @WarehouseIdentity LIKE N'%TRABZON%' THEN 2
            WHEN @WarehouseIdentity LIKE N'%SAMSUN%' THEN 3
            WHEN @WarehouseIdentity LIKE N'%BATUM%' THEN 4
            ELSE 1
        END;
    END;

    DECLARE @Lines TABLE (
        RowNo INT IDENTITY(1, 1) NOT NULL,
        StockRef INT NULL,
        ProductCode NVARCHAR(64) NULL,
        Quantity DECIMAL(18, 4) NOT NULL,
        Price DECIMAL(18, 4) NOT NULL,
        LineTotal DECIMAL(18, 4) NOT NULL,
        VatRate DECIMAL(18, 4) NOT NULL,
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

    INSERT INTO @Lines (
        StockRef, ProductCode, Quantity, Price, LineTotal, VatRate, UomRef, UsRef, LineExp
    )
    SELECT
        TRY_CONVERT(INT, COALESCE(NULLIF(logo_stock_ref, N''), NULLIF(product_external_ref, N''))),
        product_code,
        COALESCE(TRY_CONVERT(DECIMAL(18, 4), quantity), 0),
        COALESCE(TRY_CONVERT(DECIMAL(18, 4), unit_price), 0),
        COALESCE(TRY_CONVERT(DECIMAL(18, 4), line_total), 0),
        COALESCE(TRY_CONVERT(DECIMAL(18, 4), vat_rate), 0),
        TRY_CONVERT(INT, NULLIF(uom_ref, N'')),
        TRY_CONVERT(INT, NULLIF(unitset_ref, N'')),
        CONVERT(NVARCHAR(251), LEFT(COALESCE(NULLIF(reason_note, N''), NULLIF(resolution_note, N''), NULLIF(@ReasonCode, N''), NULLIF(@ReturnType, N''), N'Powersa B2B fire fisi'), 251))
    FROM OPENJSON(@PayloadJson, '$.items')
    WITH (
        product_external_ref NVARCHAR(128) '$.product_external_ref',
        product_code NVARCHAR(64) '$.product_code',
        quantity NVARCHAR(32) '$.quantity',
        unit_price NVARCHAR(32) '$.unit_price',
        line_total NVARCHAR(32) '$.line_total',
        vat_rate NVARCHAR(32) '$.vat_rate',
        logo_stock_ref NVARCHAR(128) '$.logo.stock_ref',
        unitset_ref NVARCHAR(128) '$.logo.unitset_ref',
        uom_ref NVARCHAR(128) '$.logo.uom_ref',
        reason_note NVARCHAR(251) '$.reason_note',
        resolution_note NVARCHAR(251) '$.resolution_note'
    );

    IF NOT EXISTS (SELECT 1 FROM @Lines)
    BEGIN
        INSERT INTO @Lines (
            StockRef, ProductCode, Quantity, Price, LineTotal, VatRate, UomRef, UsRef, LineExp
        )
        VALUES (
            TRY_CONVERT(INT, JSON_VALUE(@PayloadJson, '$.logo.stock_ref')),
            JSON_VALUE(@PayloadJson, '$.items[0].product_code'),
            COALESCE(TRY_CONVERT(DECIMAL(18, 4), JSON_VALUE(@PayloadJson, '$.quantity')), 0),
            COALESCE(TRY_CONVERT(DECIMAL(18, 4), JSON_VALUE(@PayloadJson, '$.unit_price')), 0),
            COALESCE(TRY_CONVERT(DECIMAL(18, 4), JSON_VALUE(@PayloadJson, '$.line_total')), @Amount),
            0,
            TRY_CONVERT(INT, JSON_VALUE(@PayloadJson, '$.logo.uom_ref')),
            TRY_CONVERT(INT, JSON_VALUE(@PayloadJson, '$.logo.unitset_ref')),
            CONVERT(NVARCHAR(251), LEFT(COALESCE(NULLIF(@ReasonCode, N''), NULLIF(@ReturnType, N''), N'Powersa B2B fire fisi'), 251))
        );
    END;

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

    IF NOT EXISTS (SELECT 1 FROM @Lines WHERE Quantity > 0)
        THROW 51021, 'Return scrap export requires at least one item with quantity greater than zero.', 1;

    IF EXISTS (SELECT 1 FROM @Lines WHERE Quantity <= 0)
        THROW 51022, 'Return scrap export item quantity must be greater than zero.', 1;

    IF EXISTS (SELECT 1 FROM @Lines WHERE StockRef IS NULL)
        THROW 51020, 'Logo stock item could not be resolved for return scrap export.', 1;

    UPDATE @Lines
       SET LineTotal = CASE WHEN LineTotal > 0 THEN LineTotal ELSE Quantity * Price END;

    SELECT @Total = COALESCE(SUM(LineTotal), 0) FROM @Lines;

    BEGIN TRANSACTION;

    INSERT INTO dbo.LG_003_01_STFICHE (
        GRPCODE, TRCODE, IOCODE, FICHENO, DATE_, FTIME, DOCODE, SPECODE, CYPHCODE,
        CLIENTREF, SOURCETYPE, SOURCEINDEX, SOURCECOSTGRP, BRANCH, DEPARTMENT,
        CANCELLED, BILLED, ACCOUNTED, UPDCURR, INUSE, ADDDISCOUNTS,
        TOTALDISCOUNTS, TOTALDISCOUNTED, ADDEXPENSES, TOTALEXPENSES,
        GROSSTOTAL, NETTOTAL, REPORTRATE, REPORTNET, GENEXP1, GENEXP2, GENEXP3, GENEXP4,
        CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR,
        CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC
    )
    VALUES (
        3, 11, 3, @FicheNo, @ScrapDate, 0, @Docode, @Specode, @CyphCode,
        COALESCE(@CustomerRef, 0), 0, @WarehouseIndex, @WarehouseIndex, 0, 0,
        0, 0, 0, 0, 0, 0,
        0, CONVERT(FLOAT, @Total), 0, 0,
        CONVERT(FLOAT, @Total), CONVERT(FLOAT, @Total), 1, CONVERT(FLOAT, @Total),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@RequestNo, N''), @ExportKey), 51)),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@ReturnType, N''), N''), 51)),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@ReasonCode, N''), N''), 51)),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@CustomerCode, N''), N''), 51)),
        1, @Now, @Hour, @Minute, @Second
    );

    SET @StockFicheRef = SCOPE_IDENTITY();

    UPDATE dbo.LG_003_01_STFICHE
       SET FTIME = @LogoTime,
           DOCODE = N'',
           SPECODE = N'',
           CYPHCODE = N'',
           INVNO = N'',
           SOURCEINDEX = 0,
           SOURCECOSTGRP = 0,
           STATUS = 0,
           CANCELLED = 0,
           ACCOUNTED = 0,
           INVOICEREF = 0,
           RECVREF = 0,
           ACCOUNTREF = 0,
           CENTERREF = 0,
           PRODORDERREF = 0,
           PORDERFICHENO = N'',
           SOURCEWSREF = 0,
           SOURCEPOLNREF = 0,
           DESTTYPE = 0,
           DESTINDEX = 0,
           DESTWSREF = 0,
           DESTPOLNREF = 0,
           DESTCOSTGRP = 0,
           FACTORYNR = 0,
           COMPBRANCH = 0,
           COMPDEPARTMENT = 0,
           COMPFACTORY = 0,
           PRODSTAT = 0,
           DEVIR = 0,
           INVKIND = 0,
           TOTALDEPOZITO = 0,
           TOTALPROMOTIONS = 0,
           EXTENREF = 0,
           PAYDEFREF = 0,
           PRINTCNT = 0,
           FICHECNT = 0,
           ACCFICHEREF = 0,
           CAPIBLOCK_MODIFIEDBY = 0,
           CAPIBLOCK_MODIFIEDHOUR = 0,
           CAPIBLOCK_MODIFIEDMIN = 0,
           CAPIBLOCK_MODIFIEDSEC = 0,
           SALESMANREF = 0,
           CANCELLEDACC = 0,
           SHPTYPCOD = N'',
           SHPAGNCOD = N'',
           TRACKNR = N'',
           GENEXCTYP = 3,
           LINEEXCTYP = 0,
           TRADINGGRP = N'',
           TEXTINC = 0,
           SITEID = 0,
           RECSTATUS = 1,
           ORGLOGICREF = 0,
           WFSTATUS = 0,
           SHIPINFOREF = 0,
           DISTORDERREF = 0,
           SENDCNT = 0,
           DLVCLIENT = 0,
           DOCTRACKINGNR = N'',
           ADDTAXCALC = 0,
           TOTALADDTAX = 0,
           UGIRTRACKINGNO = N'',
           QPRODFCREF = 0,
           VAACCREF = 0,
           VACENTERREF = 0,
           ORGLOGOID = N'',
           FROMEXIM = 0,
           FRGTYPCOD = N'',
           TRCURR = 0,
           TRRATE = 0,
           TRNET = 0,
           EXIMWHFCREF = 0,
           EXIMFCTYPE = 0,
           MAINSTFCREF = 0,
           FROMORDWITHPAY = 0,
           PROJECTREF = 0,
           WFLOWCRDREF = 0,
           UPDTRCURR = 0,
           TOTALEXADDTAX = 0,
           AFFECTCOLLATRL = 0,
           DEDUCTIONPART1 = 0,
           DEDUCTIONPART2 = 0,
           GRPFIRMTRANS = 0,
           AFFECTRISK = 0,
           DISPSTATUS = 0,
           APPROVE = 0,
           CANTCREDEDUCT = 0,
           SHIPDATE = @ScrapDate,
           SHIPTIME = @LogoTime,
           ENTRUSTDEVIR = 0,
           RELTRANSFCREF = 0,
           FROMTRANSFER = 0,
           GUID = CONVERT(VARCHAR(36), NEWID()),
           GLOBALID = N'',
           COMPSTFCREF = 0,
           COMPINVREF = 0,
           TOTALSERVICES = 0,
           CAMPAIGNCODE = N'',
           OFFERREF = 0,
           EINVOICETYP = 0,
           EINVOICE = 0,
           NOCALCULATE = 0,
           PRODORDERTYP = 0,
           QPRODFCTYP = 0,
           PRDORDSLPLNRESERVE = 0,
           CONTROLINFO = 0,
           EDESPATCH = 0,
           DOCDATE = @ScrapDate,
           DOCTIME = @LogoTime,
           EDESPSTATUS = 0,
           PROFILEID = 0,
           DELIVERYCODE = N'',
           DESTSTATUS = 0,
           CANCELEXP = N'',
           UNDOEXP = N'',
           CREATEWHERE = 0,
           PUBLICBNACCREF = 0,
           ACCEPTEINVPUBLIC = 0,
           VATEXCEPTCODE = N'',
           VATEXCEPTREASON = N'',
           ATAXEXCEPTCODE = N'',
           ATAXEXCEPTREASON = N'',
           TAXFREECHX = 0,
           MNTORDERFREF = 0,
           PRINTEDDESPFCNO = N'',
           OKCFICHE = 0,
           NOTIFYCRDREF = 0,
           CANCELLEDINVREF1 = 0,
           CANCELLEDINVREF2 = 0,
           CANCELLEDINVREF3 = 0,
           CANCELLEDINVREF4 = 0,
           FROMINTEGTYPE = 0,
           FROMINTEGREF = 0,
           EPRINTCNT = 0,
           CLNOTREFLAACCREF = 0,
           CLNOTREFLACNTRREF = 0,
           PAYERCRPROVIDER = N'',
           PAYERCRKEY = N'',
           FORENTRUST = 0,
           ORDFICHECMREF = 0,
           ESENDTIME = 0,
           ORDFICHEREF2 = 0,
           IDISSHIPNO = N''
     WHERE LOGICALREF = @StockFicheRef;

    INSERT INTO dbo.LG_003_01_STLINE (
        STOCKREF, LINETYPE, TRCODE, DATE_, FTIME, GLOBTRANS, CALCTYPE,
        SOURCETYPE, SOURCEINDEX, SOURCECOSTGRP, DESTTYPE, DESTINDEX, DESTCOSTGRP,
        FACTORYNR, IOCODE, STFICHEREF, STFICHELNNO, INVOICEREF, INVOICELNNO,
        CLIENTREF, SPECODE, AMOUNT,
        PRICE, TOTAL, PRCURR, PRPRICE, TRCURR, TRRATE, REPORTRATE, LINEEXP,
        UOMREF, USREF, UINFO1, UINFO2, VATINC, VAT, VATAMNT, VATMATRAH,
        BILLEDITEM, BILLED, CANCELLED, LINENET, LPRODSTAT, RECSTATUS, MONTH_, YEAR_, STATUS
    )
    SELECT
        src.StockRef, 0, 11, @ScrapDate, 0, 0, 0,
        0, @WarehouseIndex, @WarehouseIndex, 0, 0, 0,
        0, 1, @StockFicheRef, src.RowNo, 0, 0,
        COALESCE(@CustomerRef, 0), @Specode, CONVERT(FLOAT, src.Quantity),
        CONVERT(FLOAT, src.Price), CONVERT(FLOAT, src.LineTotal), 0, CONVERT(FLOAT, src.Price), 0, 1, 1, CONVERT(VARCHAR(251), src.LineExp),
        COALESCE(src.UomRef, 0), COALESCE(src.UsRef, 0), 1, 1, 0, 0, 0, CONVERT(FLOAT, src.LineTotal),
        0, 0, 0, CONVERT(FLOAT, src.LineTotal), 0, 2, MONTH(@ScrapDate), YEAR(@ScrapDate), 0
    FROM @Lines AS src
    ORDER BY src.RowNo;

    UPDATE dbo.LG_003_01_STLINE
       SET STATUS = 0,
           LPRODSTAT = 0,
           RECSTATUS = 1
     WHERE STFICHEREF = @StockFicheRef
       AND TRCODE = 11;

    DECLARE @NormalizeSql NVARCHAR(MAX) = N'';

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

    SET @ExternalRef = CONCAT(N'STFICHE-', @StockFicheRef);
    EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;

    COMMIT TRANSACTION;
END;
GO
