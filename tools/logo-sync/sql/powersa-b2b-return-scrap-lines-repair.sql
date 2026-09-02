/*
  Rebuild B2B damaged/faulty return fire slip detail rows from the export log.

  Scope:
  - Only synced POWERSA_B2B_EXPORT_LOG rows with DOCUMENT_TYPE = return-scrap.
  - Rewrites LG_003_01_STLINE rows for the existing STFICHE ref from the saved
    payload items.
  - Does not create a new STFICHE and does not create a duplicate export.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'dbo.POWERSA_B2B_EXPORT_LOG', N'U') IS NULL
OR OBJECT_ID(N'dbo.LG_003_01_STFICHE', N'U') IS NULL
OR OBJECT_ID(N'dbo.LG_003_01_STLINE', N'U') IS NULL
OR OBJECT_ID(N'dbo.LG_003_ITEMS', N'U') IS NULL
BEGIN
    RAISERROR('Required Logo return scrap tables were not found.', 16, 1);
    RETURN;
END;

IF OBJECT_ID(N'dbo.B2B_BACKUP_RETURN_SCRAP_STLINE_20260827', N'U') IS NULL
BEGIN
    SELECT
        CAST(NULL AS INT) AS LOGICALREF,
        CAST(NULL AS INT) AS STFICHEREF,
        CAST(NULL AS INT) AS STOCKREF,
        CAST(NULL AS FLOAT) AS AMOUNT,
        CAST(NULL AS FLOAT) AS PRICE,
        CAST(NULL AS FLOAT) AS TOTAL,
        CAST(NULL AS INT) AS SOURCEINDEX,
        CAST(NULL AS INT) AS SOURCECOSTGRP,
        CAST(NULL AS INT) AS UOMREF,
        CAST(NULL AS INT) AS USREF,
        CAST(NULL AS DATETIME) AS BACKED_UP_AT
    INTO dbo.B2B_BACKUP_RETURN_SCRAP_STLINE_20260827
    WHERE 1 = 0;
END;

DECLARE @Stage TABLE (
    StockFicheRef INT NOT NULL,
    RowNo INT NOT NULL,
    StockRef INT NULL,
    ProductCode NVARCHAR(64) NULL,
    Quantity DECIMAL(18, 4) NOT NULL,
    Price DECIMAL(18, 4) NOT NULL,
    LineTotal DECIMAL(18, 4) NOT NULL,
    UomRef INT NULL,
    UsRef INT NULL,
    LineExp NVARCHAR(251) NULL,
    ScrapDate DATE NOT NULL,
    CustomerRef INT NOT NULL,
    Specode VARCHAR(11) NOT NULL,
    WarehouseIndex INT NOT NULL
);

INSERT INTO @Stage (
    StockFicheRef, RowNo, StockRef, ProductCode, Quantity, Price, LineTotal,
    UomRef, UsRef, LineExp, ScrapDate, CustomerRef, Specode, WarehouseIndex
)
SELECT
    fiche.LOGICALREF,
    TRY_CONVERT(INT, item.[key]) + 1,
    COALESCE(
        TRY_CONVERT(INT, NULLIF(JSON_VALUE(item.value, '$.logo.stock_ref'), N'')),
        TRY_CONVERT(INT, NULLIF(JSON_VALUE(item.value, '$.product_external_ref'), N''))
    ),
    JSON_VALUE(item.value, '$.product_code'),
    COALESCE(TRY_CONVERT(DECIMAL(18, 4), JSON_VALUE(item.value, '$.quantity')), 0),
    COALESCE(TRY_CONVERT(DECIMAL(18, 4), JSON_VALUE(item.value, '$.unit_price')), 0),
    COALESCE(TRY_CONVERT(DECIMAL(18, 4), JSON_VALUE(item.value, '$.line_total')), 0),
    TRY_CONVERT(INT, NULLIF(JSON_VALUE(item.value, '$.logo.uom_ref'), N'')),
    TRY_CONVERT(INT, NULLIF(JSON_VALUE(item.value, '$.logo.unitset_ref'), N'')),
    CONVERT(NVARCHAR(251), LEFT(COALESCE(
        NULLIF(JSON_VALUE(item.value, '$.reason_note'), N''),
        NULLIF(JSON_VALUE(logs.PAYLOAD_JSON, '$.reason_note'), N''),
        NULLIF(JSON_VALUE(logs.PAYLOAD_JSON, '$.resolution_note'), N''),
        NULLIF(JSON_VALUE(logs.PAYLOAD_JSON, '$.reason_code'), N''),
        NULLIF(JSON_VALUE(logs.PAYLOAD_JSON, '$.request_type'), N''),
        N'Powersa B2B fire fisi'
    ), 251)),
    COALESCE(TRY_CONVERT(DATE, JSON_VALUE(logs.PAYLOAD_JSON, '$.scrap_date')), fiche.DATE_),
    COALESCE(fiche.CLIENTREF, 0),
    CONVERT(VARCHAR(11), LEFT(COALESCE(NULLIF(logs.EXPORT_KEY, N''), N'B2B'), 11)),
    CASE
        WHEN TRY_CONVERT(INT, NULLIF(JSON_VALUE(logs.PAYLOAD_JSON, '$.warehouse_code'), N'')) IS NOT NULL
            THEN TRY_CONVERT(INT, NULLIF(JSON_VALUE(logs.PAYLOAD_JSON, '$.warehouse_code'), N''))
        WHEN UPPER(CONCAT(
            COALESCE(JSON_VALUE(logs.PAYLOAD_JSON, '$.warehouse_code'), N''), N' ',
            COALESCE(JSON_VALUE(logs.PAYLOAD_JSON, '$.warehouse_name'), N'')
        )) LIKE N'%POINT%' THEN 0
        WHEN UPPER(CONCAT(
            COALESCE(JSON_VALUE(logs.PAYLOAD_JSON, '$.warehouse_code'), N''), N' ',
            COALESCE(JSON_VALUE(logs.PAYLOAD_JSON, '$.warehouse_name'), N'')
        )) LIKE N'%ERZURUM%' THEN 1
        WHEN UPPER(CONCAT(
            COALESCE(JSON_VALUE(logs.PAYLOAD_JSON, '$.warehouse_code'), N''), N' ',
            COALESCE(JSON_VALUE(logs.PAYLOAD_JSON, '$.warehouse_name'), N'')
        )) LIKE N'%TRABZON%' THEN 2
        WHEN UPPER(CONCAT(
            COALESCE(JSON_VALUE(logs.PAYLOAD_JSON, '$.warehouse_code'), N''), N' ',
            COALESCE(JSON_VALUE(logs.PAYLOAD_JSON, '$.warehouse_name'), N'')
        )) LIKE N'%SAMSUN%' THEN 3
        WHEN UPPER(CONCAT(
            COALESCE(JSON_VALUE(logs.PAYLOAD_JSON, '$.warehouse_code'), N''), N' ',
            COALESCE(JSON_VALUE(logs.PAYLOAD_JSON, '$.warehouse_name'), N'')
        )) LIKE N'%BATUM%' THEN 4
        ELSE COALESCE(NULLIF(fiche.SOURCEINDEX, 0), 1)
    END
FROM dbo.POWERSA_B2B_EXPORT_LOG AS logs WITH (NOLOCK)
INNER JOIN dbo.LG_003_01_STFICHE AS fiche WITH (NOLOCK)
    ON fiche.LOGICALREF = TRY_CONVERT(INT, REPLACE(logs.EXTERNAL_REF, N'STFICHE-', N''))
CROSS APPLY OPENJSON(logs.PAYLOAD_JSON, '$.items') AS item
WHERE logs.DOCUMENT_TYPE = N'return-scrap'
  AND logs.STATUS = N'synced'
  AND logs.EXTERNAL_REF LIKE N'STFICHE-%'
  AND ISJSON(logs.PAYLOAD_JSON) = 1
  AND fiche.TRCODE = 11
  AND ISNULL(fiche.CANCELLED, 0) = 0;

UPDATE stage
   SET StockRef = items.LOGICALREF
  FROM @Stage AS stage
  INNER JOIN dbo.LG_003_ITEMS AS items WITH (NOLOCK)
    ON items.CODE = CONVERT(VARCHAR(25), stage.ProductCode)
 WHERE stage.StockRef IS NULL
   AND NULLIF(stage.ProductCode, N'') IS NOT NULL;

UPDATE stage
   SET UsRef = COALESCE(stage.UsRef, items.UNITSETREF),
       UomRef = COALESCE(stage.UomRef, unitLines.LOGICALREF)
  FROM @Stage AS stage
  INNER JOIN dbo.LG_003_ITEMS AS items WITH (NOLOCK)
    ON items.LOGICALREF = stage.StockRef
  LEFT JOIN dbo.LG_003_UNITSETL AS unitLines WITH (NOLOCK)
    ON unitLines.UNITSETREF = items.UNITSETREF
   AND ISNULL(unitLines.MAINUNIT, 0) = 1;

UPDATE @Stage
   SET LineTotal = CASE WHEN LineTotal > 0 THEN LineTotal ELSE Quantity * Price END;

IF EXISTS (SELECT 1 FROM @Stage WHERE Quantity <= 0 OR StockRef IS NULL)
BEGIN
    RAISERROR('Return scrap repair found rows with unresolved stock or invalid quantity.', 16, 1);
    RETURN;
END;

BEGIN TRANSACTION;

CREATE TABLE #ReturnScrapRefs (
    StockFicheRef INT NOT NULL PRIMARY KEY
);

INSERT INTO #ReturnScrapRefs (StockFicheRef)
SELECT DISTINCT StockFicheRef
FROM @Stage;

INSERT INTO dbo.B2B_BACKUP_RETURN_SCRAP_STLINE_20260827 (
    LOGICALREF, STFICHEREF, STOCKREF, AMOUNT, PRICE, TOTAL,
    SOURCEINDEX, SOURCECOSTGRP, UOMREF, USREF, BACKED_UP_AT
)
SELECT
    lines.LOGICALREF, lines.STFICHEREF, lines.STOCKREF, lines.AMOUNT, lines.PRICE, lines.TOTAL,
    lines.SOURCEINDEX, lines.SOURCECOSTGRP, lines.UOMREF, lines.USREF, GETDATE()
FROM dbo.LG_003_01_STLINE AS lines
WHERE EXISTS (
    SELECT 1
    FROM @Stage AS stage
    WHERE stage.StockFicheRef = lines.STFICHEREF
);

DELETE lines
FROM dbo.LG_003_01_STLINE AS lines
WHERE EXISTS (
    SELECT 1
    FROM @Stage AS stage
    WHERE stage.StockFicheRef = lines.STFICHEREF
);

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
    stage.StockRef, 0, 11, stage.ScrapDate, 0, 0, 0,
    0, stage.WarehouseIndex, stage.WarehouseIndex, 0, 0, 0,
    0, 1, stage.StockFicheRef, stage.RowNo, 0, 0,
    stage.CustomerRef, stage.Specode, CONVERT(FLOAT, stage.Quantity),
    CONVERT(FLOAT, stage.Price), CONVERT(FLOAT, stage.LineTotal), 0, CONVERT(FLOAT, stage.Price), 0, 1, 1,
    CONVERT(VARCHAR(251), stage.LineExp), COALESCE(stage.UomRef, 0), COALESCE(stage.UsRef, 0), 1, 1,
    0, 0, 0, CONVERT(FLOAT, stage.LineTotal),
    0, 0, 0, CONVERT(FLOAT, stage.LineTotal), 0, 2, MONTH(stage.ScrapDate), YEAR(stage.ScrapDate), 0
FROM @Stage AS stage
ORDER BY stage.StockFicheRef, stage.RowNo;

UPDATE fiche
   SET TOTALDISCOUNTED = totals.TotalAmount,
       GROSSTOTAL = totals.TotalAmount,
       NETTOTAL = totals.TotalAmount,
       REPORTNET = totals.TotalAmount,
       SOURCEINDEX = totals.WarehouseIndex,
       SOURCECOSTGRP = totals.WarehouseIndex,
       STATUS = 0,
       CANCELLED = 0,
       RECSTATUS = 1
FROM dbo.LG_003_01_STFICHE AS fiche
INNER JOIN (
    SELECT StockFicheRef, SUM(CONVERT(FLOAT, LineTotal)) AS TotalAmount, MAX(WarehouseIndex) AS WarehouseIndex
    FROM @Stage
    GROUP BY StockFicheRef
) AS totals ON totals.StockFicheRef = fiche.LOGICALREF;

DECLARE @NormalizeSql NVARCHAR(MAX) = N'';
SELECT @NormalizeSql = @NormalizeSql + N'UPDATE dbo.LG_003_01_STFICHE SET ' + QUOTENAME(c.name) + N' = 0 WHERE LOGICALREF IN (SELECT StockFicheRef FROM #ReturnScrapRefs) AND ' + QUOTENAME(c.name) + N' IS NULL;'
FROM sys.columns AS c
INNER JOIN sys.types AS t ON t.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID(N'dbo.LG_003_01_STFICHE')
  AND c.is_nullable = 1
  AND t.name IN (N'tinyint', N'smallint', N'int', N'bigint', N'float', N'real', N'decimal', N'numeric', N'money', N'smallmoney');

EXEC sp_executesql @NormalizeSql;

SET @NormalizeSql = N'';
SELECT @NormalizeSql = @NormalizeSql + N'UPDATE dbo.LG_003_01_STLINE SET ' + QUOTENAME(c.name) + N' = 0 WHERE STFICHEREF IN (SELECT StockFicheRef FROM #ReturnScrapRefs) AND ' + QUOTENAME(c.name) + N' IS NULL;'
FROM sys.columns AS c
INNER JOIN sys.types AS t ON t.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID(N'dbo.LG_003_01_STLINE')
  AND c.is_nullable = 1
  AND t.name IN (N'tinyint', N'smallint', N'int', N'bigint', N'float', N'real', N'decimal', N'numeric', N'money', N'smallmoney');

EXEC sp_executesql @NormalizeSql;

COMMIT TRANSACTION;

SELECT
    COUNT(DISTINCT StockFicheRef) AS repaired_return_scrap_fiches,
    COUNT(*) AS repaired_return_scrap_lines
FROM @Stage;
