/*
  One-time repair for a synced normal return whose INVOICE/STFICHE/STLINE exists
  but Logo stock totals were not incremented by the older procedure.

  By default it repairs the latest synced B2B normal return in POWERSA_B2B_EXPORT_LOG.
  To repair a specific record, set @ExportKey, for example:
      DECLARE @ExportKey NVARCHAR(128) = N'B2B-RETURN-19';
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @ExportKey NVARCHAR(128) = NULL;
DECLARE @PayloadJson NVARCHAR(MAX);
DECLARE @ReturnDate DATE;
DECLARE @WarehouseCode NVARCHAR(64);
DECLARE @WarehouseName NVARCHAR(160);
DECLARE @WarehouseIndex INT;
DECLARE @AlreadyRepaired BIT = 0;

IF NULLIF(LTRIM(RTRIM(@ExportKey)), N'') IS NULL
BEGIN
    SELECT TOP 1 @ExportKey = EXPORT_KEY
    FROM dbo.POWERSA_B2B_EXPORT_LOG WITH (NOLOCK)
    WHERE DOCUMENT_TYPE = N'return'
      AND STATUS = N'synced'
      AND EXPORT_KEY LIKE N'B2B-RETURN-%'
    ORDER BY ID DESC;
END;

SELECT
    @PayloadJson = PAYLOAD_JSON,
    @AlreadyRepaired = CASE WHEN COALESCE(ERROR_MESSAGE, N'') LIKE N'%return-stock-total-repaired%' THEN 1 ELSE 0 END
FROM dbo.POWERSA_B2B_EXPORT_LOG WITH (UPDLOCK, HOLDLOCK)
WHERE EXPORT_KEY = @ExportKey
  AND DOCUMENT_TYPE = N'return'
  AND STATUS = N'synced';

IF @PayloadJson IS NULL
    THROW 51080, 'Synced normal return export log was not found.', 1;

IF @AlreadyRepaired = 1
    THROW 51081, 'This return stock total was already repaired.', 1;

SET @ReturnDate = COALESCE(TRY_CONVERT(DATE, JSON_VALUE(@PayloadJson, '$.return_date')), CONVERT(DATE, GETDATE()));
SET @WarehouseCode = JSON_VALUE(@PayloadJson, '$.warehouse_code');
SET @WarehouseName = JSON_VALUE(@PayloadJson, '$.warehouse_name');
SET @WarehouseIndex = TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(@WarehouseCode)), N''));

IF @WarehouseIndex IS NULL
BEGIN
    DECLARE @WarehouseIdentity NVARCHAR(320) = UPPER(CONCAT(COALESCE(@WarehouseCode, N''), N' ', COALESCE(@WarehouseName, N'')));
    SET @WarehouseIndex = CASE
        WHEN @WarehouseIdentity LIKE N'%POINT%' THEN 0
        WHEN @WarehouseIdentity LIKE N'%ERZURUM%' THEN 1
        WHEN @WarehouseIdentity LIKE N'%TRABZON%' THEN 2
        WHEN @WarehouseIdentity LIKE N'%SAMSUN%' THEN 3
        WHEN @WarehouseIdentity LIKE N'%BATUM%' THEN 4
        ELSE NULL
    END;
END;

IF @WarehouseIndex IS NULL
    THROW 51082, 'Return warehouse index could not be resolved.', 1;

DECLARE @Lines TABLE (
    StockRef INT NOT NULL,
    ProductCode NVARCHAR(64) NULL,
    Quantity DECIMAL(18, 4) NOT NULL
);

INSERT INTO @Lines (StockRef, ProductCode, Quantity)
SELECT
    COALESCE(
        TRY_CONVERT(INT, NULLIF(logo_stock_ref, N'')),
        TRY_CONVERT(INT, NULLIF(product_external_ref, N'')),
        items.LOGICALREF
    ),
    product_code,
    CASE WHEN TRY_CONVERT(DECIMAL(18, 4), quantity) > 0 THEN TRY_CONVERT(DECIMAL(18, 4), quantity) ELSE 1 END
FROM OPENJSON(@PayloadJson, '$.items')
WITH (
    product_external_ref NVARCHAR(128) '$.product_external_ref',
    product_code NVARCHAR(64) '$.product_code',
    quantity NVARCHAR(32) '$.quantity',
    logo_stock_ref NVARCHAR(128) '$.logo.stock_ref'
) payload
LEFT JOIN dbo.LG_003_ITEMS AS items WITH (NOLOCK)
    ON items.CODE = CONVERT(VARCHAR(25), payload.product_code);

IF NOT EXISTS (SELECT 1 FROM @Lines WHERE StockRef IS NOT NULL AND Quantity > 0)
    THROW 51083, 'No repairable return stock line was found in payload.', 1;

BEGIN TRANSACTION;

UPDATE line
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
  FROM dbo.LG_003_01_STLINE AS line
  INNER JOIN dbo.POWERSA_B2B_EXPORT_LOG AS exportLog WITH (NOLOCK)
    ON exportLog.EXPORT_KEY = @ExportKey
   AND exportLog.DOCUMENT_TYPE = N'return'
  INNER JOIN dbo.LG_003_01_INVOICE AS invoice WITH (NOLOCK)
    ON CONCAT(N'INVOICE-', invoice.LOGICALREF) = exportLog.EXTERNAL_REF
 WHERE line.INVOICEREF = invoice.LOGICALREF
   AND line.TRCODE = 3;

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

UPDATE dbo.POWERSA_B2B_EXPORT_LOG
   SET ERROR_MESSAGE = CONCAT(N'return-stock-total-repaired ', CONVERT(NVARCHAR(19), SYSUTCDATETIME(), 120)),
       UPDATED_AT = SYSUTCDATETIME()
 WHERE EXPORT_KEY = @ExportKey;

COMMIT TRANSACTION;

SELECT
    @ExportKey AS ExportKey,
    @WarehouseIndex AS WarehouseIndex,
    StockRef,
    ProductCode,
    SUM(Quantity) AS RepairedQuantity
FROM @Lines
GROUP BY StockRef, ProductCode;
