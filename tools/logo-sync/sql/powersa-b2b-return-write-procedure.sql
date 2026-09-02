/*
  Powersa B2B return write procedure for Logo Go Wings firm 003 period 01.

  It writes approved normal B2B iade requests to:
  - LG_003_01_INVOICE (03 Toptan Satis Iade Faturasi, TRCODE = 3)
  - LG_003_01_STFICHE (linked stock fiche, TRCODE = 3)
  - LG_003_01_STLINE  (return lines, TRCODE = 3, IOCODE = 1)

  Hasarli/arizali requests are exported by PowersaB2B_ExportReturnScrap
  as fire fisi, so they do not enter normal sellable stock as sales returns.
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

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ExportReturn
    @CustomerExternalRef NVARCHAR(128) = NULL,
    @CustomerCode NVARCHAR(64) = NULL,
    @ReturnDate DATE,
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
    EXEC dbo.PowersaB2B_BeginExport @ExportKey, N'return', @PayloadJson, @ExistingExternalRef OUTPUT;
    IF @ExistingExternalRef IS NOT NULL
    BEGIN
        SET @ExternalRef = @ExistingExternalRef;
        RETURN;
    END;

    DECLARE @CustomerRef INT = TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(@CustomerExternalRef)), N''));
    DECLARE @RequestId BIGINT = TRY_CONVERT(BIGINT, JSON_VALUE(@PayloadJson, '$.return_request_id'));
    DECLARE @FicheNo VARCHAR(16) = CONVERT(VARCHAR(16), RIGHT(REPLICATE('0', 16) + CONVERT(VARCHAR(32), COALESCE(@RequestId, ABS(CHECKSUM(@ExportKey)))), 16));
    DECLARE @Docode VARCHAR(33) = CONVERT(VARCHAR(33), LEFT(COALESCE(NULLIF(@RequestNo, N''), NULLIF(@CustomerCode, N''), @ExportKey), 33));
    DECLARE @Specode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(@ExportKey, 11));
    DECLARE @CyphCode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(COALESCE(NULLIF(@ReturnType, N''), N''), 11));
    DECLARE @Now DATETIME = GETDATE();
    DECLARE @Hour SMALLINT = DATEPART(HOUR, @Now);
    DECLARE @Minute SMALLINT = DATEPART(MINUTE, @Now);
    DECLARE @Second SMALLINT = DATEPART(SECOND, @Now);
    DECLARE @LogoTime INT = (@Hour * 16777216) + (@Minute * 65536) + (@Second * 256);
    DECLARE @InvoiceRef INT;
    DECLARE @StockFicheRef INT;
    DECLARE @Total DECIMAL(18, 4);
    DECLARE @VatTotal DECIMAL(18, 4);
    DECLARE @InvoiceVatRate DECIMAL(18, 4);
    DECLARE @NetTotal DECIMAL(18, 4);
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
        CONVERT(NVARCHAR(251), LEFT(COALESCE(NULLIF(reason_note, N''), NULLIF(resolution_note, N''), NULLIF(@ReasonCode, N''), NULLIF(@ReturnType, N''), N'Powersa B2B satis iade'), 251))
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
            TRY_CONVERT(INT, COALESCE(JSON_VALUE(@PayloadJson, '$.logo.stock_ref'), JSON_VALUE(@PayloadJson, '$.product_external_ref'))),
            JSON_VALUE(@PayloadJson, '$.product_code'),
            COALESCE(TRY_CONVERT(DECIMAL(18, 4), JSON_VALUE(@PayloadJson, '$.quantity')), 0),
            COALESCE(TRY_CONVERT(DECIMAL(18, 4), JSON_VALUE(@PayloadJson, '$.unit_price')), 0),
            COALESCE(TRY_CONVERT(DECIMAL(18, 4), JSON_VALUE(@PayloadJson, '$.line_total')), @Amount),
            COALESCE(TRY_CONVERT(DECIMAL(18, 4), JSON_VALUE(@PayloadJson, '$.vat_rate')), 0),
            TRY_CONVERT(INT, JSON_VALUE(@PayloadJson, '$.logo.uom_ref')),
            TRY_CONVERT(INT, JSON_VALUE(@PayloadJson, '$.logo.unitset_ref')),
            CONVERT(NVARCHAR(251), LEFT(COALESCE(NULLIF(@ReasonCode, N''), NULLIF(@ReturnType, N''), N'Powersa B2B satis iade'), 251))
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
        THROW 51031, 'Return export requires at least one item with quantity greater than zero.', 1;

    IF EXISTS (SELECT 1 FROM @Lines WHERE Quantity <= 0)
        THROW 51032, 'Return export item quantity must be greater than zero.', 1;

    IF EXISTS (SELECT 1 FROM @Lines WHERE StockRef IS NULL)
        THROW 51030, 'Logo stock item could not be resolved for return export.', 1;

    UPDATE @Lines
       SET LineTotal = CASE WHEN LineTotal > 0 THEN LineTotal ELSE Quantity * Price END;

    UPDATE @Lines
       SET VatRate = 0,
           VatAmount = 0;

    SELECT
        @Total = COALESCE(SUM(LineTotal), 0),
        @VatTotal = COALESCE(SUM(VatAmount), 0),
        @InvoiceVatRate = COALESCE(MAX(VatRate), 0)
    FROM @Lines;

    SET @NetTotal = @Total + @VatTotal;

    BEGIN TRANSACTION;

    INSERT INTO dbo.LG_003_01_INVOICE (
        GRPCODE, TRCODE, FICHENO, DATE_, DOCODE, SPECODE, CYPHCODE, CLIENTREF,
        SOURCEINDEX, SOURCECOSTGRP, CANCELLED, ACCOUNTED, PAIDINCASH, FROMKASA, ENTEGSET,
        VAT, VATINCGROSS, TOTALDISCOUNTS,
        TOTALDISCOUNTED, TOTALVAT, GROSSTOTAL, NETTOTAL, GENEXP1, GENEXP2, GENEXP3, GENEXP4,
        TRCURR, TRRATE, REPORTRATE, REPORTNET, PAYDEFREF, BRANCH, DEPARTMENT,
        CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR,
        CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC
    )
    VALUES (
        2, 3, @FicheNo, @ReturnDate, @Docode, @Specode, @CyphCode, COALESCE(@CustomerRef, 0),
        0, 0, 0, 0, 0, 0, 247,
        CONVERT(FLOAT, @InvoiceVatRate), 0, 0,
        CONVERT(FLOAT, @Total), CONVERT(FLOAT, @VatTotal), CONVERT(FLOAT, @Total), CONVERT(FLOAT, @NetTotal),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@RequestNo, N''), @ExportKey), 51)),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@ReturnType, N''), N''), 51)),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@ReasonCode, N''), N''), 51)),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@CustomerCode, N''), N''), 51)),
        0, 1, 1, CONVERT(FLOAT, @NetTotal), 0, 0, 0,
        1, @Now, @Hour, @Minute, @Second
    );

    SET @InvoiceRef = SCOPE_IDENTITY();

    UPDATE dbo.LG_003_01_INVOICE
       SET TIME_ = @LogoTime,
           DOCODE = N'',
           SPECODE = N'',
           CYPHCODE = N'',
           RECVREF = 0,
           CENTERREF = 0,
           ACCOUNTREF = 0,
           ADDDISCOUNTS = 0,
           ADDEXPENSES = 0,
           TOTALEXPENSES = 0,
           DISTEXPENSE = 0,
           TOTALDEPOZITO = 0,
           TOTALPROMOTIONS = 0,
           INTERESTAPP = 0,
           ONLYONEPAYLINE = 0,
           KASTRANSREF = 0,
           PRINTCNT = 0,
           GVATINC = 0,
           ACCFICHEREF = 0,
           ADDEXPACCREF = 0,
           ADDEXPCENTREF = 0,
           DECPRDIFF = 0,
           SALESMANREF = 0,
           CANCELLEDACC = 0,
           GENEXCTYP = 2,
           LINEEXCTYP = 2,
           TEXTINC = 0,
           SITEID = 0,
           RECSTATUS = 2,
           ORGLOGICREF = 0,
           FACTORYNR = 0,
           WFSTATUS = 0,
           SHIPINFOREF = 0,
           DISTORDERREF = 0,
           SENDCNT = 0,
           DLVCLIENT = 0,
           COSTOFSALEFCREF = 0,
           OPSTAT = 0,
           TOTALADDTAX = 0,
           PAYMENTTYPE = 0,
           INFIDX = 0,
           ACCOUNTEDCNT = 0,
           FROMEXIM = 0,
           EXIMFCTYPE = 0,
           FROMORDWITHPAY = 0,
           PROJECTREF = 0,
           WFLOWCRDREF = 0,
           STATUS = 0,
           DEDUCTIONPART1 = 2,
           DEDUCTIONPART2 = 3,
           TOTALEXADDTAX = 0,
           EXACCOUNTED = 0,
           FROMBANK = 0,
           BNTRANSREF = 0,
           AFFECTCOLLATRL = 0,
           GRPFIRMTRANS = 0,
           AFFECTRISK = 1,
           CONTROLINFO = 0,
           POSTRANSFERINFO = 0,
           TAXFREECHX = 0,
           INEFFECTIVECOST = 0,
           REFLECTED = 0,
           CANCELLEDREFLACC = 0,
           APPROVE = 0,
           CANTCREDEDUCT = 0,
           ENTRUST = 0,
           DOCDATE = @ReturnDate,
           EINVOICE = 0,
           PROFILEID = 0,
           GUID = CONVERT(VARCHAR(36), NEWID()),
           ESTATUS = 12,
           EDURATION = 0,
           EDURATIONTYPE = 0,
           DEVIR = 0,
           DISTADJPRICEUFRS = 0,
           COSFCREFUFRS = 0,
           TOTALSERVICES = 0,
           FROMLEASING = 0,
           CANCELDESPSINV = 0,
           FROMEXCHDIFF = 0,
           EXIMVAT = 0,
           APPCLDEDUCTLIM = 0,
           EINVOICETYP = 0,
           OFFERREF = 0,
           FROMSTAFFOTHEREX = 0,
           NOCALCULATE = 0,
           INSTEADOFDESP = 0,
           OKCFICHE = 0,
           MARKREF = 0,
           ACCEPTEINVPUBLIC = 0,
           PUBLICBNACCREF = 0,
           FUTMNTHYREXPINC = 0,
           DOCDETAIL = 0,
           CALCADDTAXVATSEP = 0,
           ELECTDOC = 0,
           NOTIFYCRDREF = 0,
           GIBACCFICHEREF = 0,
           FROMINTEGTYPE = 0,
           EPRINTCNT = 0,
           CLNOTREFLAACCREF = 0,
           CLNOTREFLACNTRREF = 0,
           ORDFICHECMREF = 0,
           COSFCREFINFL = 0,
           ESENDTIME = 0,
           RECEIPT = 0
     WHERE LOGICALREF = @InvoiceRef;

    INSERT INTO dbo.LG_003_01_STFICHE (
        GRPCODE, TRCODE, IOCODE, FICHENO, DATE_, FTIME, DOCODE, SPECODE, CYPHCODE,
        CLIENTREF, SOURCETYPE, SOURCEINDEX, SOURCECOSTGRP, BRANCH, DEPARTMENT,
        CANCELLED, BILLED, ACCOUNTED, UPDCURR, INUSE, ADDDISCOUNTS,
        INVOICEREF, TOTALDISCOUNTS, TOTALDISCOUNTED, ADDEXPENSES, TOTALEXPENSES,
        TOTALVAT, GROSSTOTAL, NETTOTAL, REPORTRATE, REPORTNET, GENEXP1, GENEXP2, GENEXP3, GENEXP4,
        CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR,
        CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC, STATUS
    )
    VALUES (
        2, 3, 1, @FicheNo, @ReturnDate, 0, @Docode, @Specode, @CyphCode,
        COALESCE(@CustomerRef, 0), 0, @WarehouseIndex, @WarehouseIndex, 0, 0,
        0, 1, 0, 0, 0, 0,
        @InvoiceRef, 0, CONVERT(FLOAT, @Total), 0, 0,
        CONVERT(FLOAT, @VatTotal), CONVERT(FLOAT, @Total), CONVERT(FLOAT, @NetTotal), 1, CONVERT(FLOAT, @NetTotal),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@RequestNo, N''), @ExportKey), 51)),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@ReturnType, N''), N''), 51)),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@ReasonCode, N''), N''), 51)),
        CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@CustomerCode, N''), N''), 51)),
        1, @Now, @Hour, @Minute, @Second, 0
    );

    SET @StockFicheRef = SCOPE_IDENTITY();

    INSERT INTO dbo.LG_003_01_STLINE (
        STOCKREF, LINETYPE, TRCODE, DATE_, FTIME, GLOBTRANS, CALCTYPE,
        SOURCETYPE, SOURCEINDEX, SOURCECOSTGRP, DESTTYPE, DESTINDEX, DESTCOSTGRP,
        FACTORYNR, IOCODE, STFICHEREF, STFICHELNNO, INVOICEREF, INVOICELNNO,
        CLIENTREF, PAYDEFREF, SPECODE, AMOUNT, PRICE, TOTAL, PRCURR, PRPRICE,
        TRCURR, TRRATE, REPORTRATE, LINEEXP, UOMREF, USREF, UINFO1, UINFO2,
        VATINC, VAT, VATAMNT, VATMATRAH, BILLEDITEM, BILLED, CANCELLED,
        LINENET, MONTH_, YEAR_
    )
    SELECT
        src.StockRef, 0, 3, @ReturnDate, 0, 0, 0,
        0, @WarehouseIndex, @WarehouseIndex, 0, 0, 0,
        0, 1, @StockFicheRef, src.RowNo, @InvoiceRef, src.RowNo,
        COALESCE(@CustomerRef, 0), 0, @Specode, CONVERT(FLOAT, src.Quantity),
        CONVERT(FLOAT, src.Price), CONVERT(FLOAT, src.LineTotal), 0, CONVERT(FLOAT, src.Price),
        0, 1, 1, CONVERT(VARCHAR(251), src.LineExp), COALESCE(src.UomRef, 0), COALESCE(src.UsRef, 0), 1, 1,
        0, CONVERT(FLOAT, src.VatRate), CONVERT(FLOAT, src.VatAmount), CONVERT(FLOAT, src.LineTotal),
        0, 1, 0, CONVERT(FLOAT, src.LineTotal), MONTH(@ReturnDate), YEAR(@ReturnDate)
    FROM @Lines AS src
    ORDER BY src.RowNo;

    UPDATE dbo.LG_003_01_STLINE
       SET STATUS = 0,
           LPRODSTAT = 0,
           RECSTATUS = 2,
           PREVLINEREF = 0,
           PREVLINENO = 0,
           DETLINE = 0,
           PRODORDERREF = 0,
           SOURCEWSREF = 0,
           SOURCEPOLNREF = 0,
           DESTWSREF = 0,
           DESTPOLNREF = 0,
           ORDTRANSREF = 0,
           ORDFICHEREF = 0,
           CENTERREF = 0,
           ACCOUNTREF = 0,
           VATACCREF = 0,
           VATCENTERREF = 0,
           PRACCREF = 0,
           PRCENTERREF = 0,
           PRVATACCREF = 0,
           PRVATCENREF = 0,
           PROMREF = 0,
           UINFO3 = 0,
           UINFO4 = 0,
           UINFO5 = 0,
           UINFO6 = 0,
           UINFO7 = 0,
           UINFO8 = 0,
           PLNAMOUNT = 0,
           CPSTFLAG = 0,
           RETCOSTTYPE = COALESCE(RETCOSTTYPE, 1),
           SOURCELINK = 0,
           RETCOST = 0,
           RETCOSTCURR = 0,
           OUTCOST = 0,
           OUTCOSTCURR = 0,
           RETAMOUNT = 0,
           FAREGREF = 0,
           FAATTRIB = 0,
           DISTCOST = 0,
           DISTDISC = 0,
           DISTEXP = 0,
           DISTPROM = 0,
           DISCPER = 0,
           DISTADDEXP = 0,
           FADACCREF = 0,
           FADCENTERREF = 0,
           FARACCREF = 0,
           FARCENTERREF = 0,
           DIFFPRICE = 0,
           DIFFPRCOST = 0,
           DECPRDIFF = 0,
           PRDEXPTOTAL = 0,
           DIFFREPPRICE = 0,
           DIFFPRCRCOST = 0,
           SALESMANREF = 0,
           FAPLACCREF = 0,
           FAPLCENTERREF = 0,
           DREF = 0,
           COSTRATE = 0,
           XPRICEUPD = 0,
           XPRICE = 0,
           XREPRATE = 0,
           DISTCOEF = 0,
           TRANSQCOK = 0,
           SITEID = 0,
           ORGLOGICREF = 0,
           WFSTATUS = 0,
           POLINEREF = 0,
           PLNSTTRANSREF = 0,
           NETDISCFLAG = 0,
           NETDISCPERC = 0,
           NETDISCAMNT = 0,
           VATCALCDIFF = 0,
           CONDITIONREF = 0,
           DISTORDERREF = 0,
           DISTORDLINEREF = 0,
           PORDCLSPLNAMNT = 0,
           DORESERVE = 0,
           PORDSYMOUTLN = 0,
           LPRODRSRVSTAT = 0,
           DESTSTATUS = 0
     WHERE STFICHEREF = @StockFicheRef
       AND TRCODE = 3;

    INSERT INTO dbo.LG_003_01_CLFLINE (
        CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, SPECODE, CYPHCODE,
        TRANNO, DOCODE, LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET,
        REPORTRATE, REPORTNET, CANCELLED, CAPIBLOCK_CREATEDBY,
        CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN,
        CAPIBLOCK_CREATEDSEC
    )
    VALUES (
        COALESCE(@CustomerRef, 0), @InvoiceRef, @ReturnDate, 4, 33, @Specode, @CyphCode,
        @FicheNo, @Docode,
        CONVERT(VARCHAR(251), LEFT(CONCAT(N'Powersa B2B satis iade ', COALESCE(NULLIF(@RequestNo, N''), @ExportKey)), 251)),
        1, CONVERT(FLOAT, @NetTotal), 0, 1, CONVERT(FLOAT, @NetTotal),
        1, CONVERT(FLOAT, @NetTotal), 0, 1,
        @Now, @Hour, @Minute, @Second
    );

    /*
      Normal satis iadesi depoya geri giristir.
      Logo arayuzunde Malzemeler > Ambar Toplamlari > Fiili Stok ekrani
      GNTOTST/STINVTOT toplamlarini baz aldigi icin, raw INVOICE/STFICHE/STLINE
      yazimi sonrasinda ilgili ambar ve genel toplam ayrica + miktar guncellenir.
      Hasarli/arizali iadeler bu prosedure girmez; onlar fire fisi akisini kullanir.
    */
    MERGE dbo.LG_003_01_GNTOTST AS target
    USING (
        SELECT StockRef, @WarehouseIndex AS InvenNo, SUM(Quantity) AS TotalQty
        FROM @Lines
        GROUP BY StockRef
    ) AS source
    ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
    WHEN MATCHED THEN
        UPDATE SET ONHAND = ONHAND + source.TotalQty
    WHEN NOT MATCHED THEN
        INSERT (STOCKREF, INVENNO, ONHAND, RESERVED, TRANSFERRED)
        VALUES (source.StockRef, source.InvenNo, source.TotalQty, 0, 0);

    MERGE dbo.LG_003_01_GNTOTST AS target
    USING (
        SELECT StockRef, -1 AS InvenNo, SUM(Quantity) AS TotalQty
        FROM @Lines
        GROUP BY StockRef
    ) AS source
    ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
    WHEN MATCHED THEN
        UPDATE SET ONHAND = ONHAND + source.TotalQty
    WHEN NOT MATCHED THEN
        INSERT (STOCKREF, INVENNO, ONHAND, RESERVED, TRANSFERRED)
        VALUES (source.StockRef, source.InvenNo, source.TotalQty, 0, 0);

    MERGE dbo.LG_003_01_STINVTOT AS target
    USING (
        SELECT StockRef, @WarehouseIndex AS InvenNo, SUM(Quantity) AS TotalQty
        FROM @Lines
        GROUP BY StockRef
    ) AS source
    ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
    WHEN MATCHED THEN
        UPDATE SET ONHAND = ONHAND + source.TotalQty, DATE_ = @ReturnDate
    WHEN NOT MATCHED THEN
        INSERT (STOCKREF, INVENNO, DATE_, ONHAND, RESERVED, TRANSFERRED)
        VALUES (source.StockRef, source.InvenNo, @ReturnDate, source.TotalQty, 0, 0);

    MERGE dbo.LG_003_01_STINVTOT AS target
    USING (
        SELECT StockRef, -1 AS InvenNo, SUM(Quantity) AS TotalQty
        FROM @Lines
        GROUP BY StockRef
    ) AS source
    ON target.STOCKREF = source.StockRef AND target.INVENNO = source.InvenNo
    WHEN MATCHED THEN
        UPDATE SET ONHAND = ONHAND + source.TotalQty, DATE_ = @ReturnDate
    WHEN NOT MATCHED THEN
        INSERT (STOCKREF, INVENNO, DATE_, ONHAND, RESERVED, TRANSFERRED)
        VALUES (source.StockRef, source.InvenNo, @ReturnDate, source.TotalQty, 0, 0);

    SET @ExternalRef = CONCAT(N'INVOICE-', @InvoiceRef);
    EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;

    COMMIT TRANSACTION;
END;
GO
