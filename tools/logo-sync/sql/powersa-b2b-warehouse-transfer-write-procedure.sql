SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ExportWarehouseTransfer
    @TransferDate DATE,
    @TransferNo NVARCHAR(64) = NULL,
    @OrderNo NVARCHAR(64) = NULL,
    @SourceWarehouseCode NVARCHAR(64) = NULL,
    @SourceWarehouseName NVARCHAR(160) = NULL,
    @TargetWarehouseCode NVARCHAR(64) = NULL,
    @TargetWarehouseName NVARCHAR(160) = NULL,
    @ExportKey NVARCHAR(128),
    @PayloadJson NVARCHAR(MAX),
    @ExternalRef NVARCHAR(128) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @ExistingExternalRef NVARCHAR(128);
    EXEC dbo.PowersaB2B_BeginExport @ExportKey, N'warehouse-transfer', @PayloadJson, @ExistingExternalRef OUTPUT;
    IF @ExistingExternalRef IS NOT NULL
    BEGIN
        SET @ExternalRef = @ExistingExternalRef;
        RETURN;
    END;

    DECLARE @Now DATETIME = GETDATE();
    DECLARE @Hour SMALLINT = DATEPART(HOUR, @Now);
    DECLARE @Minute SMALLINT = DATEPART(MINUTE, @Now);
    DECLARE @Second SMALLINT = DATEPART(SECOND, @Now);
    DECLARE @FicheNo VARCHAR(16) = CONVERT(VARCHAR(16), RIGHT(REPLICATE('0', 16) + CONVERT(VARCHAR(32), ABS(CHECKSUM(NEWID()))), 16));
    DECLARE @Docode VARCHAR(33) = CONVERT(VARCHAR(33), LEFT(COALESCE(NULLIF(@TransferNo, N''), @ExportKey), 33));
    DECLARE @LineExp VARCHAR(251) = CONVERT(VARCHAR(251), LEFT(CONCAT(N'Depo transferi ', COALESCE(@OrderNo, @TransferNo, @ExportKey)), 251));
    DECLARE @SourceIndex INT = TRY_CONVERT(INT, NULLIF(@SourceWarehouseCode, N''));
    DECLARE @DestIndex INT = TRY_CONVERT(INT, NULLIF(@TargetWarehouseCode, N''));
    DECLARE @TransferStage NVARCHAR(32) = LOWER(COALESCE(NULLIF(JSON_VALUE(@PayloadJson, '$.transfer_stage'), N''), N'shipment'));
    DECLARE @StockSourceIndex INT = TRY_CONVERT(INT, NULLIF(COALESCE(
        JSON_VALUE(@PayloadJson, '$.stock_source_warehouse_code'),
        JSON_VALUE(@PayloadJson, '$.meta.source_state_meta.transfer_source_warehouse_code')
    ), N''));
    DECLARE @StockDestIndex INT = TRY_CONVERT(INT, NULLIF(COALESCE(
        JSON_VALUE(@PayloadJson, '$.stock_target_warehouse_code'),
        JSON_VALUE(@PayloadJson, '$.meta.source_state_meta.transfer_target_warehouse_code')
    ), N''));

    IF @TransferDate IS NULL
        SET @TransferDate = CONVERT(DATE, @Now);

    IF @SourceIndex IS NULL OR @DestIndex IS NULL
        THROW 51000, 'Depo transferi icin kaynak/hedef Logo ambar kodu zorunludur.', 1;

    IF @SourceIndex = @DestIndex
        THROW 51000, 'Depo transferinde kaynak ve hedef ambar ayni olamaz.', 1;

    IF @StockSourceIndex IS NULL
        THROW 51000, 'Stok kaynak ambari olmadan sevkiyat fisi olusturulamaz.', 1;

    IF @StockDestIndex IS NULL
        THROW 51000, 'Stok hedef ambari olmadan kabul fisi olusturulamaz.', 1;

    IF @StockSourceIndex = @StockDestIndex
        THROW 51000, 'Stok hareketinde kaynak ve hedef ambar ayni olamaz.', 1;

    /*
      Isyeri numarasi ambar numarasindan turetilmez. Logo'nun kendi ambar
      tanimindaki DIVISNR alani, ambara bagli gercek isyerini belirtir.
      Boylece yeni bir ambar/isyeri eklendiginde kod degisikligi gerekmez.
    */
    DECLARE @SourceBranch INT = NULL;
    DECLARE @DestBranch INT = NULL;
    DECLARE @StockSourceBranch INT = NULL;
    DECLARE @StockDestBranch INT = NULL;

    SELECT TOP (1) @SourceBranch = division.NR
    FROM dbo.L_CAPIWHOUSE AS warehouse WITH (NOLOCK)
    INNER JOIN dbo.L_CAPIDIV AS division WITH (NOLOCK)
        ON division.FIRMNR = warehouse.FIRMNR
       AND division.NR = TRY_CONVERT(INT, warehouse.DIVISNR)
    WHERE warehouse.FIRMNR = 3
      AND warehouse.NR = @SourceIndex;

    SELECT TOP (1) @DestBranch = division.NR
    FROM dbo.L_CAPIWHOUSE AS warehouse WITH (NOLOCK)
    INNER JOIN dbo.L_CAPIDIV AS division WITH (NOLOCK)
        ON division.FIRMNR = warehouse.FIRMNR
       AND division.NR = TRY_CONVERT(INT, warehouse.DIVISNR)
    WHERE warehouse.FIRMNR = 3
      AND warehouse.NR = @DestIndex;

    IF @SourceBranch IS NULL
        THROW 51000, 'Kaynak ambar Logo L_CAPIWHOUSE taniminda bulunamadi veya isyeri eslesmesi yok.', 1;

    IF @DestBranch IS NULL
        THROW 51000, 'Hedef ambar Logo L_CAPIWHOUSE taniminda bulunamadi veya isyeri eslesmesi yok.', 1;

    IF @StockSourceIndex IS NOT NULL
    BEGIN
        SELECT TOP (1) @StockSourceBranch = division.NR
        FROM dbo.L_CAPIWHOUSE AS warehouse WITH (NOLOCK)
        INNER JOIN dbo.L_CAPIDIV AS division WITH (NOLOCK)
            ON division.FIRMNR = warehouse.FIRMNR
           AND division.NR = TRY_CONVERT(INT, warehouse.DIVISNR)
        WHERE warehouse.FIRMNR = 3
          AND warehouse.NR = @StockSourceIndex;

        IF @StockSourceBranch IS NULL
            THROW 51000, 'Stok kaynak ambari Logo L_CAPIWHOUSE taniminda bulunamadi veya isyeri eslesmesi yok.', 1;
    END;

    IF @StockDestIndex IS NOT NULL
    BEGIN
        SELECT TOP (1) @StockDestBranch = division.NR
        FROM dbo.L_CAPIWHOUSE AS warehouse WITH (NOLOCK)
        INNER JOIN dbo.L_CAPIDIV AS division WITH (NOLOCK)
            ON division.FIRMNR = warehouse.FIRMNR
           AND division.NR = TRY_CONVERT(INT, warehouse.DIVISNR)
        WHERE warehouse.FIRMNR = 3
          AND warehouse.NR = @StockDestIndex;

        IF @StockDestBranch IS NULL
            THROW 51000, 'Stok hedef ambari Logo L_CAPIWHOUSE taniminda bulunamadi veya isyeri eslesmesi yok.', 1;
    END;

    DECLARE @Lines TABLE (
        RowNo INT IDENTITY(1,1),
        StockRef INT NOT NULL,
        Quantity DECIMAL(18, 6) NOT NULL,
        Price DECIMAL(18, 6) NOT NULL,
        LineTotal DECIMAL(18, 6) NOT NULL,
        UomRef INT NULL,
        UsRef INT NULL,
        LineExp NVARCHAR(251) NULL
    );

    INSERT INTO @Lines (StockRef, Quantity, Price, LineTotal, UomRef, UsRef, LineExp)
    SELECT
        TRY_CONVERT(INT, COALESCE(JSON_VALUE(value, '$.logo.stock_ref'), JSON_VALUE(value, '$.product_external_ref'))),
        TRY_CONVERT(DECIMAL(18, 6), JSON_VALUE(value, '$.shipped_qty')),
        COALESCE(TRY_CONVERT(DECIMAL(18, 6), JSON_VALUE(value, '$.unit_price')), 0),
        COALESCE(TRY_CONVERT(DECIMAL(18, 6), JSON_VALUE(value, '$.line_total')), 0),
        TRY_CONVERT(INT, JSON_VALUE(value, '$.logo.uom_ref')),
        TRY_CONVERT(INT, JSON_VALUE(value, '$.logo.unitset_ref')),
        LEFT(COALESCE(JSON_VALUE(value, '$.product_name'), JSON_VALUE(value, '$.product_code'), N''), 251)
    FROM OPENJSON(@PayloadJson, '$.items')
    WHERE TRY_CONVERT(INT, COALESCE(JSON_VALUE(value, '$.logo.stock_ref'), JSON_VALUE(value, '$.product_external_ref'))) IS NOT NULL
      AND TRY_CONVERT(DECIMAL(18, 6), JSON_VALUE(value, '$.shipped_qty')) > 0;

    IF NOT EXISTS (SELECT 1 FROM @Lines)
        THROW 51000, 'Depo transferi icin Logo stok referansi olan satir bulunamadi.', 1;

    DECLARE @NetTotal DECIMAL(18, 6) = (SELECT SUM(LineTotal) FROM @Lines);
    DECLARE @StockFicheRef INT;

    BEGIN TRANSACTION;

    /*
      Logo Ambar Fisi basligindaki gercek alan eslesmesi:
        - Cikis isyeri : BRANCH
        - Cikis ambar  : SOURCEINDEX
        - Giris isyeri : COMPBRANCH
        - Giris ambar  : DESTINDEX

      SOURCETYPE/DESTTYPE isyeri numarasi degildir; kaynak/hedef nesne
      turudur. Ambar transferinde her ikisi de 0 (ambar) tutulur.
      DEPARTMENT/COMPDEPARTMENT ve FACTORYNR/COMPFACTORY bu akista 0'dur.
    */
    INSERT INTO dbo.LG_003_01_STFICHE (
        GRPCODE, TRCODE, IOCODE, FICHENO, DATE_, FTIME, DOCODE, SPECODE, CYPHCODE,
        CLIENTREF, SOURCETYPE, SOURCEINDEX, SOURCECOSTGRP,
        BRANCH, DEPARTMENT, COMPBRANCH, COMPDEPARTMENT, COMPFACTORY,
        DESTTYPE, DESTINDEX, DESTCOSTGRP, FACTORYNR,
        PRODSTAT, DEVIR, INVKIND, GRPFIRMTRANS, DISPSTATUS, APPROVE, CREATEWHERE,
        CANCELLED, BILLED, ACCOUNTED, UPDCURR, INUSE, ADDDISCOUNTS,
        INVOICEREF, TOTALDISCOUNTS, TOTALDISCOUNTED, ADDEXPENSES, TOTALEXPENSES,
        TOTALVAT, GROSSTOTAL, NETTOTAL, REPORTRATE, REPORTNET, GENEXP1, GENEXP2, GENEXP3, GENEXP4,
        CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR,
        CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC, STATUS
    )
    VALUES (
        3, 25, 2, @FicheNo, @TransferDate, 0, @Docode, N'B2B', N'',
        0, 0, @StockSourceIndex, @StockSourceIndex,
        @StockSourceBranch, 0, @StockDestBranch, 0, 0,
        0, @StockDestIndex, @StockDestIndex, 0,
        0, 0, 0, 0, 1, 0, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, CONVERT(FLOAT, @NetTotal), 0, 0,
        0, CONVERT(FLOAT, @NetTotal), CONVERT(FLOAT, @NetTotal), 1, CONVERT(FLOAT, @NetTotal),
        CONVERT(VARCHAR(51), LEFT(COALESCE(@TransferNo, @ExportKey), 51)),
        CONVERT(VARCHAR(51), LEFT(COALESCE(@OrderNo, N''), 51)),
        CONVERT(VARCHAR(51), LEFT(CONCAT(COALESCE(@SourceWarehouseName, @SourceWarehouseCode), N' -> ', COALESCE(@TargetWarehouseName, @TargetWarehouseCode), N' ', @TransferStage), 51)),
        CONVERT(VARCHAR(51), LEFT(@ExportKey, 51)),
        1, @Now, @Hour, @Minute, @Second, 0
    );

    SET @StockFicheRef = SCOPE_IDENTITY();

    /*
      Bu Logo kurulumunda tek TRCODE=25/STLINE satiri iki ambari da giris gibi
      etkileyebiliyor. Bu nedenle hareket net iki satirla yazilir:
        - kaynak ambar cikisi  : IOCODE=3
        - hedef ambar girisi   : IOCODE=2
      Her satir kendi ambarinda kalir; transferin kaynak/hedef bacagi fis
      basliginda korunur.
    */
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
        src.StockRef, 0, 25, @TransferDate, 0, 0, 0,
        0, @StockSourceIndex, @StockSourceIndex,
        0, @StockSourceIndex, @StockSourceIndex,
        0, 3, @StockFicheRef,
        src.RowNo * 2 - 1, 0, 0,
        0, N'B2B', CONVERT(FLOAT, src.Quantity),
        CONVERT(FLOAT, src.Price), CONVERT(FLOAT, src.LineTotal), 0, CONVERT(FLOAT, src.Price), 0, 1, 1,
        CONVERT(VARCHAR(251), LEFT(CONCAT(N'Cikis ', COALESCE(src.LineExp, @LineExp)), 251)),
        COALESCE(src.UomRef, 0), COALESCE(src.UsRef, 0), 1, 1,
        0, 0, 0, CONVERT(FLOAT, src.LineTotal),
        0, 0, 0, CONVERT(FLOAT, src.LineTotal), 0, 1, MONTH(@TransferDate), YEAR(@TransferDate), 0
    FROM @Lines AS src
    ORDER BY src.RowNo;

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
        src.StockRef, 0, 25, @TransferDate, 0, 0, 0,
        0, @StockDestIndex, @StockDestIndex,
        0, @StockDestIndex, @StockDestIndex,
        0, 2, @StockFicheRef,
        src.RowNo * 2, 0, 0,
        0, N'B2B', CONVERT(FLOAT, src.Quantity),
        CONVERT(FLOAT, src.Price), CONVERT(FLOAT, src.LineTotal), 0, CONVERT(FLOAT, src.Price), 0, 1, 1,
        CONVERT(VARCHAR(251), LEFT(CONCAT(N'Giris ', COALESCE(src.LineExp, @LineExp)), 251)),
        COALESCE(src.UomRef, 0), COALESCE(src.UsRef, 0), 1, 1,
        0, 0, 0, CONVERT(FLOAT, src.LineTotal),
        0, 0, 0, CONVERT(FLOAT, src.LineTotal), 0, 1, MONTH(@TransferDate), YEAR(@TransferDate), 0
    FROM @Lines AS src
    ORDER BY src.RowNo;

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

    SET @ExternalRef = CONCAT(N'AMBARFIS-', @StockFicheRef);
    EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;
    COMMIT TRANSACTION;
END;
GO
