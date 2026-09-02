/*
  Backfill B2B-only customer ledger rows into Logo CLFLINE.

  This is intentionally separate from the collection/order exporters. It should be
  used for existing BOS ledger rows that affect customer balance but do not have a
  real Logo customer movement yet.
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

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_BackfillB2BLedgerEntry
    @CustomerExternalRef NVARCHAR(128) = NULL,
    @CustomerCode NVARCHAR(64) = NULL,
    @LedgerDate DATE,
    @Sign SMALLINT,
    @Amount DECIMAL(15, 2),
    @Currency NVARCHAR(3) = N'TRY',
    @ReferenceNo NVARCHAR(120) = NULL,
    @Description NVARCHAR(250) = NULL,
    @ExportKey NVARCHAR(128),
    @PayloadJson NVARCHAR(MAX) = NULL,
    @ExternalRef NVARCHAR(128) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF OBJECT_ID(N'dbo.LG_003_01_CLFLINE', N'U') IS NULL
        THROW 51000, 'LG_003_01_CLFLINE was not found.', 1;

    IF OBJECT_ID(N'dbo.LG_003_CLCARD', N'U') IS NULL
        THROW 51000, 'LG_003_CLCARD was not found.', 1;

    IF @LedgerDate IS NULL
        THROW 51000, 'LedgerDate is required.', 1;

    IF @Amount IS NULL OR @Amount <= 0
        THROW 51000, 'Amount must be greater than zero.', 1;

    DECLARE @ExistingExternalRef NVARCHAR(128) = NULL;
    EXEC dbo.PowersaB2B_BeginExport @ExportKey, N'b2b-ledger-backfill', @PayloadJson, @ExistingExternalRef OUTPUT;

    IF @ExistingExternalRef IS NOT NULL
    BEGIN
        SET @ExternalRef = @ExistingExternalRef;
        RETURN;
    END;

    BEGIN TRANSACTION;

    DECLARE @CustomerRef INT = NULL;
    DECLARE @ExternalRefNumber INT = CASE
        WHEN ISNUMERIC(@CustomerExternalRef) = 1 THEN CONVERT(INT, @CustomerExternalRef)
        ELSE NULL
    END;

    IF @ExternalRefNumber IS NOT NULL
    BEGIN
        SELECT TOP (1) @CustomerRef = LOGICALREF
        FROM dbo.LG_003_CLCARD WITH (NOLOCK)
        WHERE LOGICALREF = @ExternalRefNumber
          AND ISNULL(ACTIVE, 0) = 0;
    END;

    IF @CustomerRef IS NULL AND NULLIF(LTRIM(RTRIM(@CustomerCode)), N'') IS NOT NULL
    BEGIN
        SELECT TOP (1) @CustomerRef = LOGICALREF
        FROM dbo.LG_003_CLCARD WITH (NOLOCK)
        WHERE CODE = CONVERT(VARCHAR(25), @CustomerCode)
          AND ISNULL(ACTIVE, 0) = 0
        ORDER BY LOGICALREF;
    END;

    IF @CustomerRef IS NULL
        THROW 51000, 'Logo customer card was not found for B2B ledger backfill.', 1;

    DECLARE @Docode VARCHAR(33) = CONVERT(VARCHAR(33), LEFT(@ExportKey, 33));
    DECLARE @TransNo VARCHAR(17) = CONVERT(VARCHAR(17), LEFT(COALESCE(NULLIF(@ReferenceNo, N''), @ExportKey), 17));
    DECLARE @Specode VARCHAR(11) = 'B2B-LEDGER';
    DECLARE @CyphCode VARCHAR(11) = '';
    DECLARE @LineExp VARCHAR(251) = CONVERT(VARCHAR(251), LEFT(COALESCE(NULLIF(@Description, N''), @ExportKey), 251));
    DECLARE @NormalizedSign SMALLINT = CASE WHEN ISNULL(@Sign, 1) = 0 THEN 0 ELSE 1 END;
    DECLARE @Trcode SMALLINT = CASE WHEN @NormalizedSign = 0 THEN 70 ELSE 3 END;
    DECLARE @Now DATETIME = GETDATE();
    DECLARE @Hour INT = DATEPART(HOUR, @Now);
    DECLARE @Minute INT = DATEPART(MINUTE, @Now);
    DECLARE @Second INT = DATEPART(SECOND, @Now);
    DECLARE @ClflineRef INT = NULL;

    SELECT TOP (1) @ClflineRef = LOGICALREF
    FROM dbo.LG_003_01_CLFLINE WITH (UPDLOCK, HOLDLOCK)
    WHERE CLIENTREF = @CustomerRef
      AND DOCODE = @Docode
      AND SPECODE = @Specode;

    IF @ClflineRef IS NOT NULL
    BEGIN
        SET @ExternalRef = CONCAT(N'CLFLINE-', @ClflineRef);
        EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;
        COMMIT TRANSACTION;
        RETURN;
    END;

    IF OBJECTPROPERTY(OBJECT_ID('dbo.LG_003_01_CLFLINE'), 'TableHasIdentity') = 1
    BEGIN
        INSERT INTO dbo.LG_003_01_CLFLINE (
            CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, SPECODE, CYPHCODE,
            TRANNO, DOCODE, LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET,
            REPORTRATE, REPORTNET, CANCELLED, STATUS, MONTH_, YEAR_, BRANCH,
            DEPARTMENT, PAIDINCASH, CAPIBLOCK_CREATEDBY,
            CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN,
            CAPIBLOCK_CREATEDSEC, CAPIBLOCK_MODIFIEDBY, CAPIBLOCK_MODIFIEDDATE,
            CAPIBLOCK_MODIFIEDHOUR, CAPIBLOCK_MODIFIEDMIN, CAPIBLOCK_MODIFIEDSEC
        )
        VALUES (
            @CustomerRef, 0, @LedgerDate, 5, @Trcode, @Specode, @CyphCode,
            @TransNo, @Docode, @LineExp, @NormalizedSign, CONVERT(FLOAT, @Amount), 0, 1,
            CONVERT(FLOAT, @Amount), 1, CONVERT(FLOAT, @Amount), 0, 0,
            MONTH(@LedgerDate), YEAR(@LedgerDate), 0, 0, 0, 1,
            @Now, @Hour, @Minute, @Second, 1, @Now, @Hour, @Minute, @Second
        );
        SET @ClflineRef = SCOPE_IDENTITY();
    END
    ELSE
    BEGIN
        SELECT @ClflineRef = ISNULL(MAX(LOGICALREF), 0) + 1 FROM dbo.LG_003_01_CLFLINE WITH (UPDLOCK, TABLOCKX);
        INSERT INTO dbo.LG_003_01_CLFLINE (
            LOGICALREF, CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, SPECODE, CYPHCODE,
            TRANNO, DOCODE, LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET,
            REPORTRATE, REPORTNET, CANCELLED, STATUS, MONTH_, YEAR_, BRANCH,
            DEPARTMENT, PAIDINCASH, CAPIBLOCK_CREATEDBY,
            CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN,
            CAPIBLOCK_CREATEDSEC, CAPIBLOCK_MODIFIEDBY, CAPIBLOCK_MODIFIEDDATE,
            CAPIBLOCK_MODIFIEDHOUR, CAPIBLOCK_MODIFIEDMIN, CAPIBLOCK_MODIFIEDSEC
        )
        VALUES (
            @ClflineRef, @CustomerRef, 0, @LedgerDate, 5, @Trcode, @Specode, @CyphCode,
            @TransNo, @Docode, @LineExp, @NormalizedSign, CONVERT(FLOAT, @Amount), 0, 1,
            CONVERT(FLOAT, @Amount), 1, CONVERT(FLOAT, @Amount), 0, 0,
            MONTH(@LedgerDate), YEAR(@LedgerDate), 0, 0, 0, 1,
            @Now, @Hour, @Minute, @Second, 1, @Now, @Hour, @Minute, @Second
        );
    END;

    SET @ExternalRef = CONCAT(N'CLFLINE-', @ClflineRef);
    EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;

    COMMIT TRANSACTION;
END;
GO
