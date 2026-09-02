/*
  PowerSA B2B POS day-end export.

  - cash_amount writes to the selected Logo cashbox (LG_003_01_KSLINES)
    and the branch cash-sale customer account (LG_003_01_CLFLINE).
  - card_amount writes as a Logo credit-card customer fiche style row
    (LG_003_01_CLFICHE, TRCODE = 70) and the branch card-sale customer
    account (LG_003_01_CLFLINE).

  The procedure is idempotent by @ExportKey via POWERSA_B2B_EXPORT_LOG.
*/

IF OBJECT_ID(N'dbo.POWERSA_B2B_EXPORT_LOG', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.POWERSA_B2B_EXPORT_LOG (
        ID INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        EXPORT_KEY NVARCHAR(128) NOT NULL UNIQUE,
        DOCUMENT_TYPE NVARCHAR(64) NOT NULL,
        EXTERNAL_REF NVARCHAR(128) NULL,
        PAYLOAD_JSON NVARCHAR(MAX) NULL,
        STATUS NVARCHAR(32) NOT NULL CONSTRAINT DF_POWERSA_B2B_EXPORT_LOG_STATUS DEFAULT N'pending',
        ERROR_MESSAGE NVARCHAR(MAX) NULL,
        CREATED_AT DATETIME2 NOT NULL CONSTRAINT DF_POWERSA_B2B_EXPORT_LOG_CREATED DEFAULT SYSUTCDATETIME(),
        UPDATED_AT DATETIME2 NOT NULL CONSTRAINT DF_POWERSA_B2B_EXPORT_LOG_UPDATED DEFAULT SYSUTCDATETIME()
    );
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

    SELECT @ExistingExternalRef = EXTERNAL_REF
    FROM dbo.POWERSA_B2B_EXPORT_LOG WITH (UPDLOCK, HOLDLOCK)
    WHERE EXPORT_KEY = @ExportKey
      AND STATUS = N'synced';

    IF @ExistingExternalRef IS NOT NULL
        RETURN;

    IF NOT EXISTS (SELECT 1 FROM dbo.POWERSA_B2B_EXPORT_LOG WITH (UPDLOCK, HOLDLOCK) WHERE EXPORT_KEY = @ExportKey)
    BEGIN
        INSERT INTO dbo.POWERSA_B2B_EXPORT_LOG (EXPORT_KEY, DOCUMENT_TYPE, PAYLOAD_JSON, STATUS)
        VALUES (@ExportKey, @DocumentType, @PayloadJson, N'pending');
    END
    ELSE
    BEGIN
        UPDATE dbo.POWERSA_B2B_EXPORT_LOG
           SET DOCUMENT_TYPE = @DocumentType,
               PAYLOAD_JSON = @PayloadJson,
               STATUS = N'pending',
               ERROR_MESSAGE = NULL,
               UPDATED_AT = SYSUTCDATETIME()
         WHERE EXPORT_KEY = @ExportKey;
    END;
END;
GO

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_FinishExport
    @ExportKey NVARCHAR(128),
    @ExternalRef NVARCHAR(128)
AS
BEGIN
    SET NOCOUNT ON;

    UPDATE dbo.POWERSA_B2B_EXPORT_LOG
       SET EXTERNAL_REF = @ExternalRef,
           STATUS = N'synced',
           ERROR_MESSAGE = NULL,
           UPDATED_AT = SYSUTCDATETIME()
     WHERE EXPORT_KEY = @ExportKey;
END;
GO

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ExportPosDayEnd
    @DayEndDate DATE,
    @CashAmount DECIMAL(15, 2) = 0,
    @CardAmount DECIMAL(15, 2) = 0,
    @Currency NVARCHAR(3) = N'TRY',
    @CashboxCode NVARCHAR(64) = NULL,
    @CashboxName NVARCHAR(128) = NULL,
    @ExportKey NVARCHAR(128),
    @PayloadJson NVARCHAR(MAX) = NULL,
    @ExternalRef NVARCHAR(128) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @ExistingExternalRef NVARCHAR(128);
    EXEC dbo.PowersaB2B_BeginExport @ExportKey, N'pos-day-end', @PayloadJson, @ExistingExternalRef OUTPUT;
    IF @ExistingExternalRef IS NOT NULL
    BEGIN
        SET @ExternalRef = @ExistingExternalRef;
        RETURN;
    END;

    IF COALESCE(@CashAmount, 0) <= 0 AND COALESCE(@CardAmount, 0) <= 0
        THROW 51120, 'POS day-end export requires cash or card amount.', 1;

    DECLARE @CashboxRef INT;
    DECLARE @Now DATETIME = GETDATE();
    DECLARE @Hour SMALLINT = DATEPART(HOUR, @Now);
    DECLARE @Minute SMALLINT = DATEPART(MINUTE, @Now);
    DECLARE @Second SMALLINT = DATEPART(SECOND, @Now);
    DECLARE @LogoTime INT = (@Hour * 16777216) + (@Minute * 65536) + (@Second * 256);
    DECLARE @Specode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(@ExportKey, 11));
    DECLARE @CyphCode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(COALESCE(NULLIF(@Currency, N''), N'TRY'), 11));
    DECLARE @Docode VARCHAR(33) = CONVERT(VARCHAR(33), LEFT(@ExportKey, 33));
    DECLARE @CashFicheNo VARCHAR(17) = CONVERT(VARCHAR(17), RIGHT(REPLICATE('0', 17) + CONCAT(N'K', ABS(CHECKSUM(@ExportKey))), 17));
    DECLARE @CardFicheNo VARCHAR(17) = CONVERT(VARCHAR(17), RIGHT(REPLICATE('0', 17) + CONCAT(N'C', ABS(CHECKSUM(CONCAT(@ExportKey, N'-CARD')))), 17));
    DECLARE @CashLineRef INT;
    DECLARE @CardFicheRef INT;
    DECLARE @CashSaleCustomerRef INT;
    DECLARE @CardSaleCustomerRef INT;
    DECLARE @CashSaleCustomerLineRef INT;
    DECLARE @CardSaleCustomerLineRef INT;
    DECLARE @CashSaleCustomerCode NVARCHAR(64) = NULL;
    DECLARE @CashSaleCustomerName NVARCHAR(180) = NULL;
    DECLARE @CardSaleCustomerCode NVARCHAR(64) = NULL;
    DECLARE @CardSaleCustomerName NVARCHAR(180) = NULL;
    DECLARE @ExternalParts NVARCHAR(256) = N'';
    DECLARE @CashLineExp VARCHAR(251) = CONVERT(VARCHAR(251), LEFT(CONCAT(N'PowerSA POS gün sonu nakit - ', COALESCE(@CashboxName, @CashboxCode, N'')), 251));
    DECLARE @CardLineExp VARCHAR(251) = CONVERT(VARCHAR(251), LEFT(CONCAT(N'PowerSA POS gün sonu kredi kartı - ', COALESCE(@CashboxName, @CashboxCode, N'')), 251));

    IF NULLIF(LTRIM(RTRIM(@CashboxCode)), N'') IS NULL AND @PayloadJson IS NOT NULL AND ISJSON(@PayloadJson) = 1
    BEGIN
        SET @CashboxCode = JSON_VALUE(@PayloadJson, '$.cashbox_code');
    END;

    IF NULLIF(LTRIM(RTRIM(@CashboxName)), N'') IS NULL AND @PayloadJson IS NOT NULL AND ISJSON(@PayloadJson) = 1
    BEGIN
        SET @CashboxName = JSON_VALUE(@PayloadJson, '$.cashbox_name');
    END;

    IF @PayloadJson IS NOT NULL AND ISJSON(@PayloadJson) = 1
    BEGIN
        SET @CashSaleCustomerCode = COALESCE(
            JSON_VALUE(@PayloadJson, '$.cash_sale_customer_code'),
            JSON_VALUE(@PayloadJson, '$.cash_sale_customer.code')
        );
        SET @CashSaleCustomerName = COALESCE(
            JSON_VALUE(@PayloadJson, '$.cash_sale_customer_name'),
            JSON_VALUE(@PayloadJson, '$.cash_sale_customer.name')
        );
        SET @CardSaleCustomerCode = COALESCE(
            JSON_VALUE(@PayloadJson, '$.card_sale_customer_code'),
            JSON_VALUE(@PayloadJson, '$.card_sale_customer.code')
        );
        SET @CardSaleCustomerName = COALESCE(
            JSON_VALUE(@PayloadJson, '$.card_sale_customer_name'),
            JSON_VALUE(@PayloadJson, '$.card_sale_customer.name')
        );
    END;

    IF @CashboxCode IS NOT NULL
    BEGIN
        SELECT TOP 1 @CashboxRef = LOGICALREF
        FROM dbo.LG_003_KSCARD WITH (NOLOCK)
        WHERE CODE = CONVERT(VARCHAR(25), @CashboxCode)
          AND ISNULL(ACTIVE, 0) = 0;
    END;

    IF @CashboxRef IS NULL AND NULLIF(LTRIM(RTRIM(@CashboxName)), N'') IS NOT NULL
    BEGIN
        SELECT TOP 1 @CashboxRef = LOGICALREF
        FROM dbo.LG_003_KSCARD WITH (NOLOCK)
        WHERE NAME = CONVERT(VARCHAR(51), @CashboxName)
          AND ISNULL(ACTIVE, 0) = 0
        ORDER BY LOGICALREF;
    END;

    IF COALESCE(@CashAmount, 0) > 0 AND @CashboxRef IS NULL
        THROW 51121, 'Logo cashbox could not be resolved for POS day-end cash export.', 1;

    IF COALESCE(@CashAmount, 0) > 0
    BEGIN
        IF NULLIF(LTRIM(RTRIM(@CashSaleCustomerCode)), N'') IS NOT NULL
        BEGIN
            SELECT TOP 1 @CashSaleCustomerRef = LOGICALREF
            FROM dbo.LG_003_CLCARD WITH (NOLOCK)
            WHERE CODE = CONVERT(VARCHAR(25), @CashSaleCustomerCode)
              AND ISNULL(ACTIVE, 0) = 0
            ORDER BY LOGICALREF;
        END;

        IF @CashSaleCustomerRef IS NULL AND NULLIF(LTRIM(RTRIM(@CashSaleCustomerName)), N'') IS NOT NULL
        BEGIN
            SELECT TOP 1 @CashSaleCustomerRef = LOGICALREF
            FROM dbo.LG_003_CLCARD WITH (NOLOCK)
            WHERE DEFINITION_ = CONVERT(VARCHAR(201), @CashSaleCustomerName)
              AND ISNULL(ACTIVE, 0) = 0
            ORDER BY LOGICALREF;
        END;

        IF @CashSaleCustomerRef IS NULL
            THROW 51122, 'Logo cash sale customer could not be resolved for POS day-end export.', 1;
    END;

    IF COALESCE(@CardAmount, 0) > 0
    BEGIN
        IF NULLIF(LTRIM(RTRIM(@CardSaleCustomerCode)), N'') IS NOT NULL
        BEGIN
            SELECT TOP 1 @CardSaleCustomerRef = LOGICALREF
            FROM dbo.LG_003_CLCARD WITH (NOLOCK)
            WHERE CODE = CONVERT(VARCHAR(25), @CardSaleCustomerCode)
              AND ISNULL(ACTIVE, 0) = 0
            ORDER BY LOGICALREF;
        END;

        IF @CardSaleCustomerRef IS NULL AND NULLIF(LTRIM(RTRIM(@CardSaleCustomerName)), N'') IS NOT NULL
        BEGIN
            SELECT TOP 1 @CardSaleCustomerRef = LOGICALREF
            FROM dbo.LG_003_CLCARD WITH (NOLOCK)
            WHERE DEFINITION_ = CONVERT(VARCHAR(201), @CardSaleCustomerName)
              AND ISNULL(ACTIVE, 0) = 0
            ORDER BY LOGICALREF;
        END;

        IF @CardSaleCustomerRef IS NULL
            THROW 51123, 'Logo card sale customer could not be resolved for POS day-end export.', 1;
    END;

    BEGIN TRANSACTION;

    IF COALESCE(@CashAmount, 0) > 0
    BEGIN
        IF OBJECTPROPERTY(OBJECT_ID('dbo.LG_003_01_KSLINES'), 'TableHasIdentity') = 1
        BEGIN
            INSERT INTO dbo.LG_003_01_KSLINES (
                CARDREF, DATE_, HOUR_, MINUTE_, TRCODE, SPECODE, CYPHCODE, FICHENO,
                LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET, REPORTRATE, REPORTNET,
                CANCELLED, STATUS, AFFECTRISK, BRANCH, DEPARTMENT, ACCREF, CENTERREF,
                CASHACCREF, CASHCENREF, ACCFICHEREF, ACCOUNTED, REFLECTED,
                CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
                CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC,
                CAPIBLOCK_MODIFIEDBY, CAPIBLOCK_MODIFIEDDATE, CAPIBLOCK_MODIFIEDHOUR,
                CAPIBLOCK_MODIFIEDMIN, CAPIBLOCK_MODIFIEDSEC, DOCODE, DOCDATE, TIME_
            )
            VALUES (
                @CashboxRef, @DayEndDate, @Hour, @Minute, 11, @Specode, @CyphCode, @CashFicheNo,
                @CashLineExp, 0, CONVERT(FLOAT, @CashAmount), 0, 1, CONVERT(FLOAT, @CashAmount),
                1, CONVERT(FLOAT, @CashAmount), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                1, @Now, @Hour, @Minute, @Second, 1, @Now, @Hour, @Minute, @Second,
                @Docode, @Now, @LogoTime
            );
            SET @CashLineRef = SCOPE_IDENTITY();
        END
        ELSE
        BEGIN
            SELECT @CashLineRef = ISNULL(MAX(LOGICALREF), 0) + 1 FROM dbo.LG_003_01_KSLINES WITH (UPDLOCK, TABLOCKX);
            INSERT INTO dbo.LG_003_01_KSLINES (
                LOGICALREF, CARDREF, DATE_, HOUR_, MINUTE_, TRCODE, SPECODE, CYPHCODE, FICHENO,
                LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET, REPORTRATE, REPORTNET,
                CANCELLED, STATUS, AFFECTRISK, BRANCH, DEPARTMENT, ACCREF, CENTERREF,
                CASHACCREF, CASHCENREF, ACCFICHEREF, ACCOUNTED, REFLECTED,
                CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
                CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC,
                CAPIBLOCK_MODIFIEDBY, CAPIBLOCK_MODIFIEDDATE, CAPIBLOCK_MODIFIEDHOUR,
                CAPIBLOCK_MODIFIEDMIN, CAPIBLOCK_MODIFIEDSEC, DOCODE, DOCDATE, TIME_
            )
            VALUES (
                @CashLineRef, @CashboxRef, @DayEndDate, @Hour, @Minute, 11, @Specode, @CyphCode, @CashFicheNo,
                @CashLineExp, 0, CONVERT(FLOAT, @CashAmount), 0, 1, CONVERT(FLOAT, @CashAmount),
                1, CONVERT(FLOAT, @CashAmount), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                1, @Now, @Hour, @Minute, @Second, 1, @Now, @Hour, @Minute, @Second,
                @Docode, @Now, @LogoTime
            );
        END;

        SET @ExternalParts = CONCAT(@ExternalParts, N'KSLINES-', @CashLineRef);

        INSERT INTO dbo.LG_003_01_CLFLINE (
            CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, TRANNO, DOCODE,
            LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET, REPORTRATE,
            REPORTNET, CANCELLED, STATUS, MONTH_, YEAR_, BRANCH, DEPARTMENT, PAIDINCASH,
            CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
            CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC
        )
        VALUES (
            @CashSaleCustomerRef, @CashLineRef, @DayEndDate, 10, 11, @CashFicheNo, @Docode,
            @CashLineExp, 0, CONVERT(FLOAT, @CashAmount), 0, 1, CONVERT(FLOAT, @CashAmount), 1,
            CONVERT(FLOAT, @CashAmount), 0, 0, MONTH(@DayEndDate), YEAR(@DayEndDate), 0, 0, 0,
            1, @Now, @Hour, @Minute, @Second
        );
        SET @CashSaleCustomerLineRef = SCOPE_IDENTITY();
        SET @ExternalParts = CONCAT(@ExternalParts, N'-CLFLINE-', @CashSaleCustomerLineRef);
    END;

    IF COALESCE(@CardAmount, 0) > 0
    BEGIN
        IF OBJECTPROPERTY(OBJECT_ID('dbo.LG_003_01_CLFICHE'), 'TableHasIdentity') = 1
        BEGIN
            INSERT INTO dbo.LG_003_01_CLFICHE (
                FICHENO, DATE_, DOCODE, TRCODE, GENEXP1,
                DEBIT, CREDIT, REPDEBIT, REPCREDIT, CAPIBLOCK_CREATEDBY,
                CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN,
                CAPIBLOCK_CREATEDSEC, ACCOUNTED, CANCELLED, HOUR_, MINUTE_
            )
            VALUES (
                @CardFicheNo, @DayEndDate, @Docode, 70, CONVERT(VARCHAR(51), LEFT(@CardLineExp, 51)),
                CONVERT(FLOAT, @CardAmount), CONVERT(FLOAT, @CardAmount),
                CONVERT(FLOAT, @CardAmount), CONVERT(FLOAT, @CardAmount),
                1, @Now, @Hour, @Minute, @Second, 0, 0, @Hour, @Minute
            );
            SET @CardFicheRef = SCOPE_IDENTITY();
        END
        ELSE
        BEGIN
            SELECT @CardFicheRef = ISNULL(MAX(LOGICALREF), 0) + 1 FROM dbo.LG_003_01_CLFICHE WITH (UPDLOCK, TABLOCKX);
            INSERT INTO dbo.LG_003_01_CLFICHE (
                LOGICALREF, FICHENO, DATE_, DOCODE, TRCODE, GENEXP1,
                DEBIT, CREDIT, REPDEBIT, REPCREDIT, CAPIBLOCK_CREATEDBY,
                CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN,
                CAPIBLOCK_CREATEDSEC, ACCOUNTED, CANCELLED, HOUR_, MINUTE_
            )
            VALUES (
                @CardFicheRef, @CardFicheNo, @DayEndDate, @Docode, 70, CONVERT(VARCHAR(51), LEFT(@CardLineExp, 51)),
                CONVERT(FLOAT, @CardAmount), CONVERT(FLOAT, @CardAmount),
                CONVERT(FLOAT, @CardAmount), CONVERT(FLOAT, @CardAmount),
                1, @Now, @Hour, @Minute, @Second, 0, 0, @Hour, @Minute
            );
        END;

        SET @ExternalParts = CONCAT(@ExternalParts, CASE WHEN @ExternalParts = N'' THEN N'' ELSE N'-' END, N'CLFICHE-', @CardFicheRef);

        INSERT INTO dbo.LG_003_01_CLFLINE (
            CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, TRANNO, DOCODE,
            LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET, REPORTRATE,
            REPORTNET, CANCELLED, STATUS, MONTH_, YEAR_, BRANCH, DEPARTMENT, PAIDINCASH,
            CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
            CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC
        )
        VALUES (
            @CardSaleCustomerRef, @CardFicheRef, @DayEndDate, 5, 70, @CardFicheNo, @Docode,
            @CardLineExp, 0, CONVERT(FLOAT, @CardAmount), 0, 1, CONVERT(FLOAT, @CardAmount), 1,
            CONVERT(FLOAT, @CardAmount), 0, 0, MONTH(@DayEndDate), YEAR(@DayEndDate), 0, 0, 0,
            1, @Now, @Hour, @Minute, @Second
        );
        SET @CardSaleCustomerLineRef = SCOPE_IDENTITY();
        SET @ExternalParts = CONCAT(@ExternalParts, N'-CLFLINE-', @CardSaleCustomerLineRef);
    END;

    SET @ExternalRef = @ExternalParts;
    EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;

    COMMIT TRANSACTION;
END;
GO
