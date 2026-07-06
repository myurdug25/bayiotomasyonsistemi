/*
  Powersa B2B customer write procedure for Logo Go Wings firm 003.

  It writes B2B-created/updated customer cards to:
  - LG_003_CLCARD (Cari Hesap Kartlari)

  Logo screen mapping confirmed on 2026-06-03:
  - Cari Hesaplar list
  - Cari Hesap Karti
  - CARDTYPE = 3 means Alici + Satici, shown with (AS)
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

/*
  Repair cards previously exported by PowerSA with the legacy contact-name mapping.
  The export log limits this correction to PowerSA-originated customer cards.
*/
UPDATE card
   SET card.DEFINITION2 = CONVERT(VARCHAR(201), LEFT(card.CODE, 201)),
       card.CAPIBLOCK_MODIFIEDBY = 1,
       card.CAPIBLOCK_MODIFIEDDATE = GETDATE(),
       card.CAPIBLOCK_MODIFIEDHOUR = DATEPART(HOUR, GETDATE()),
       card.CAPIBLOCK_MODIFIEDMIN = DATEPART(MINUTE, GETDATE()),
       card.CAPIBLOCK_MODIFIEDSEC = DATEPART(SECOND, GETDATE())
FROM dbo.LG_003_CLCARD AS card
INNER JOIN dbo.POWERSA_B2B_EXPORT_LOG AS export_log
        ON TRY_CONVERT(INT, export_log.EXTERNAL_REF) = card.LOGICALREF
       AND export_log.DOCUMENT_TYPE = N'customer'
       AND export_log.STATUS = N'synced'
WHERE ISNULL(card.DEFINITION2, '') <> card.CODE;
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

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ExportCustomer
    @CustomerCode NVARCHAR(64),
    @Name NVARCHAR(255),
    @ContactName NVARCHAR(255) = NULL,
    @Email NVARCHAR(255) = NULL,
    @Phone NVARCHAR(32) = NULL,
    @City NVARCHAR(120) = NULL,
    @District NVARCHAR(120) = NULL,
    @TaxOffice NVARCHAR(255) = NULL,
    @TaxNumber NVARCHAR(32) = NULL,
    @CreditLimit DECIMAL(15, 2) = 0,
    @IsActive BIT = 1,
    @Address NVARCHAR(MAX) = NULL,
    @Iban NVARCHAR(64) = NULL,
    @ExportKey NVARCHAR(128),
    @PayloadJson NVARCHAR(MAX) = NULL,
    @ExternalRef NVARCHAR(128) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @ExistingExternalRef NVARCHAR(128);
    EXEC dbo.PowersaB2B_BeginExport @ExportKey, N'customer', @PayloadJson, @ExistingExternalRef OUTPUT;
    IF @ExistingExternalRef IS NOT NULL
    BEGIN
        SET @ExternalRef = @ExistingExternalRef;
        RETURN;
    END;

    DECLARE @Code VARCHAR(17) = CONVERT(VARCHAR(17), LEFT(LTRIM(RTRIM(@CustomerCode)), 17));
    DECLARE @Definition VARCHAR(201) = CONVERT(VARCHAR(201), LEFT(COALESCE(NULLIF(@Name, N''), @CustomerCode), 201));
    DECLARE @Definition2 VARCHAR(201) = CONVERT(VARCHAR(201), LEFT(@Code, 201));
    DECLARE @CardType SMALLINT = COALESCE(TRY_CONVERT(SMALLINT, JSON_VALUE(@PayloadJson, '$.meta.logo.cardtype')), 3);
    DECLARE @CustomerKind NVARCHAR(32) = NULLIF(JSON_VALUE(@PayloadJson, '$.meta.logo.customer_kind'), N'');
    DECLARE @Specode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(COALESCE(NULLIF(JSON_VALUE(@PayloadJson, '$.meta.logo.specode'), N''), N'F1'), 11));
    DECLARE @Specode2 VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(COALESCE(NULLIF(JSON_VALUE(@PayloadJson, '$.meta.logo.specode2'), N''), N''), 11));
    DECLARE @Specode3 VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(COALESCE(NULLIF(JSON_VALUE(@PayloadJson, '$.meta.logo.specode3'), N''), N''), 11));
    DECLARE @Specode4 VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(COALESCE(NULLIF(JSON_VALUE(@PayloadJson, '$.meta.logo.specode4'), N''), N''), 11));
    DECLARE @Specode5 VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(COALESCE(NULLIF(JSON_VALUE(@PayloadJson, '$.meta.logo.specode5'), N''), N''), 11));
    DECLARE @CyphCode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(COALESCE(NULLIF(JSON_VALUE(@PayloadJson, '$.meta.logo.cyphcode'), N''), N''), 11));
    DECLARE @ECollectionNote VARCHAR(41) = CONVERT(VARCHAR(41), LEFT(COALESCE(NULLIF(JSON_VALUE(@PayloadJson, '$.meta.logo.e_collection_note'), N''), N''), 41));
    DECLARE @PostCode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(COALESCE(NULLIF(JSON_VALUE(@PayloadJson, '$.meta.logo.postcode'), N''), N''), 11));
    DECLARE @Country VARCHAR(41) = CONVERT(VARCHAR(41), LEFT(COALESCE(NULLIF(JSON_VALUE(@PayloadJson, '$.meta.logo.country'), N''), N'TURKIYE'), 41));
    DECLARE @TradingGroup VARCHAR(17) = CONVERT(VARCHAR(17), LEFT(COALESCE(NULLIF(JSON_VALUE(@PayloadJson, '$.meta.logo.trading_group'), N''), N''), 17));
    DECLARE @PaymentRef INT = TRY_CONVERT(INT, JSON_VALUE(@PayloadJson, '$.meta.logo.payment_ref'));
    DECLARE @Currency SMALLINT = TRY_CONVERT(SMALLINT, JSON_VALUE(@PayloadJson, '$.meta.logo.currency_code'));
    DECLARE @DiscountRate FLOAT = TRY_CONVERT(FLOAT, JSON_VALUE(@PayloadJson, '$.meta.logo.discount_rate'));
    DECLARE @Blocked SMALLINT = COALESCE(TRY_CONVERT(SMALLINT, JSON_VALUE(@PayloadJson, '$.meta.logo.blocked')), 0);
    DECLARE @AddressText NVARCHAR(MAX) = COALESCE(NULLIF(@Address, N''), NULLIF(JSON_VALUE(@PayloadJson, '$.meta.customer_card_request.address'), N''));
    DECLARE @Addr1 VARCHAR(201) = CONVERT(VARCHAR(201), LEFT(COALESCE(@AddressText, N''), 201));
    DECLARE @Addr2 VARCHAR(201) = CONVERT(VARCHAR(201), SUBSTRING(COALESCE(@AddressText, N''), 202, 201));
    DECLARE @TaxValue VARCHAR(16) = CONVERT(VARCHAR(16), LEFT(COALESCE(NULLIF(@TaxNumber, N''), N''), 16));
    DECLARE @TaxNr VARCHAR(16) = CASE WHEN @CustomerKind = N'person' OR LEN(@TaxValue) = 11 THEN N'' ELSE @TaxValue END;
    DECLARE @TckNo VARCHAR(16) = CASE WHEN @CustomerKind = N'person' OR LEN(@TaxValue) = 11 THEN @TaxValue ELSE N'' END;
    DECLARE @Now DATETIME = GETDATE();
    DECLARE @Hour SMALLINT = DATEPART(HOUR, @Now);
    DECLARE @Minute SMALLINT = DATEPART(MINUTE, @Now);
    DECLARE @Second SMALLINT = DATEPART(SECOND, @Now);
    DECLARE @LogicalRef INT;

    IF NULLIF(@Code, '') IS NULL
        THROW 51030, 'CustomerCode is required for Logo customer export.', 1;

    IF NULLIF(@Definition, '') IS NULL
        THROW 51031, 'Name is required for Logo customer export.', 1;

    BEGIN TRANSACTION;

    SELECT TOP 1 @LogicalRef = LOGICALREF
    FROM dbo.LG_003_CLCARD WITH (UPDLOCK, HOLDLOCK)
    WHERE CODE = @Code;

    IF @LogicalRef IS NULL
    BEGIN
        INSERT INTO dbo.LG_003_CLCARD (
            ACTIVE, CARDTYPE, CODE, DEFINITION_, DEFINITION2, SPECODE, SPECODE2, SPECODE3,
            SPECODE4, SPECODE5, CYPHCODE, ADDR1, ADDR2, CITY, TOWN, COUNTRY, POSTCODE,
            TELNRS1, TELNRS2, FAXNR, TAXNR, TCKNO, TAXOFFICE, INCHARGE, EMAILADDR,
            WEBADDR, BLOCKED, CCURRENCY, TRADINGGRP, PAYMENTREF, DISCRATE, INCHARGE3,
            CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR,
            CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC
        )
        VALUES (
            CASE WHEN @IsActive = 1 THEN 0 ELSE 1 END, @CardType, @Code, @Definition, @Definition2,
            @Specode, @Specode2, @Specode3, @Specode4, @Specode5, @CyphCode, @Addr1, @Addr2,
            CONVERT(VARCHAR(21), LEFT(COALESCE(NULLIF(@City, N''), N''), 21)),
            CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@District, N''), N''), 51)),
            @Country, @PostCode,
            CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@Phone, N''), N''), 51)),
            CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(JSON_VALUE(@PayloadJson, '$.meta.logo.phone_2'), N''), N''), 51)),
            CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(JSON_VALUE(@PayloadJson, '$.meta.logo.fax'), N''), N''), 51)),
            @TaxNr, @TckNo,
            CONVERT(VARCHAR(31), LEFT(COALESCE(NULLIF(@TaxOffice, N''), N''), 31)),
            CONVERT(VARCHAR(41), LEFT(COALESCE(NULLIF(@ContactName, N''), N''), 41)),
            CONVERT(VARCHAR(251), LEFT(COALESCE(NULLIF(@Email, N''), N''), 251)),
            CONVERT(VARCHAR(101), LEFT(COALESCE(NULLIF(JSON_VALUE(@PayloadJson, '$.meta.logo.website'), N''), N''), 101)),
            @Blocked, @Currency, @TradingGroup, @PaymentRef, @DiscountRate, @ECollectionNote,
            1, @Now, @Hour, @Minute, @Second
        );

        SET @LogicalRef = SCOPE_IDENTITY();
    END
    ELSE
    BEGIN
        UPDATE dbo.LG_003_CLCARD
           SET ACTIVE = CASE WHEN @IsActive = 1 THEN 0 ELSE 1 END,
               CARDTYPE = @CardType,
               DEFINITION_ = @Definition,
               DEFINITION2 = @Definition2,
               SPECODE = @Specode,
               SPECODE2 = @Specode2,
               SPECODE3 = @Specode3,
               SPECODE4 = @Specode4,
               SPECODE5 = @Specode5,
               CYPHCODE = @CyphCode,
               ADDR1 = @Addr1,
               ADDR2 = @Addr2,
               CITY = CONVERT(VARCHAR(21), LEFT(COALESCE(NULLIF(@City, N''), N''), 21)),
               TOWN = CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@District, N''), N''), 51)),
               COUNTRY = @Country,
               POSTCODE = @PostCode,
               TELNRS1 = CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(@Phone, N''), N''), 51)),
               TELNRS2 = CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(JSON_VALUE(@PayloadJson, '$.meta.logo.phone_2'), N''), N''), 51)),
               FAXNR = CONVERT(VARCHAR(51), LEFT(COALESCE(NULLIF(JSON_VALUE(@PayloadJson, '$.meta.logo.fax'), N''), N''), 51)),
               TAXNR = @TaxNr,
               TCKNO = @TckNo,
               TAXOFFICE = CONVERT(VARCHAR(31), LEFT(COALESCE(NULLIF(@TaxOffice, N''), N''), 31)),
               INCHARGE = CONVERT(VARCHAR(41), LEFT(COALESCE(NULLIF(@ContactName, N''), N''), 41)),
               EMAILADDR = CONVERT(VARCHAR(251), LEFT(COALESCE(NULLIF(@Email, N''), N''), 251)),
               WEBADDR = CONVERT(VARCHAR(101), LEFT(COALESCE(NULLIF(JSON_VALUE(@PayloadJson, '$.meta.logo.website'), N''), N''), 101)),
               BLOCKED = @Blocked,
               CCURRENCY = @Currency,
               TRADINGGRP = @TradingGroup,
               PAYMENTREF = @PaymentRef,
               DISCRATE = @DiscountRate,
               INCHARGE3 = @ECollectionNote,
               CAPIBLOCK_MODIFIEDBY = 1,
               CAPIBLOCK_MODIFIEDDATE = @Now,
               CAPIBLOCK_MODIFIEDHOUR = @Hour,
               CAPIBLOCK_MODIFIEDMIN = @Minute,
               CAPIBLOCK_MODIFIEDSEC = @Second
         WHERE LOGICALREF = @LogicalRef;
    END;

    SET @ExternalRef = CONVERT(NVARCHAR(128), @LogicalRef);
    EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;

    COMMIT TRANSACTION;
END;
GO
