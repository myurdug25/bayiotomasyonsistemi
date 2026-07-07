/*
  Powersa B2B POS expense write procedure for Logo Go Wings firm 003 period 01.

  POS expenses are cash out movements. The procedure writes a single KSLINES
  row with TRCODE=12 and keeps idempotency in POWERSA_B2B_EXPORT_LOG.
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

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ExportPosExpense
    @ExpenseDate DATE,
    @Category NVARCHAR(80) = NULL,
    @Amount DECIMAL(15, 2),
    @Currency NVARCHAR(3) = N'TRY',
    @Note NVARCHAR(MAX) = NULL,
    @CashboxCode NVARCHAR(64) = NULL,
    @AccountCode NVARCHAR(64) = NULL,
    @ExportKey NVARCHAR(128),
    @PayloadJson NVARCHAR(MAX) = NULL,
    @ExternalRef NVARCHAR(128) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @ExistingExternalRef NVARCHAR(128);
    EXEC dbo.PowersaB2B_BeginExport @ExportKey, N'pos-expense', @PayloadJson, @ExistingExternalRef OUTPUT;
    IF @ExistingExternalRef IS NOT NULL
    BEGIN
        SET @ExternalRef = @ExistingExternalRef;
        RETURN;
    END;

    IF @Amount IS NULL OR @Amount <= 0
        THROW 51060, 'POS expense amount must be greater than zero.', 1;

    DECLARE @CashboxRef INT;
    DECLARE @AccountRef INT;
    DECLARE @CashAccountRef INT;
    DECLARE @ExpenseAccountCode VARCHAR(25);
    DECLARE @CashAccountCode VARCHAR(25);
    DECLARE @FicheNo VARCHAR(17) = CONVERT(VARCHAR(17), RIGHT(REPLICATE('0', 17) + CONVERT(VARCHAR(128), @ExportKey), 17));
    DECLARE @Docode VARCHAR(33) = CONVERT(VARCHAR(33), LEFT(@ExportKey, 33));
    DECLARE @Specode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(@ExportKey, 11));
    DECLARE @CyphCode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(COALESCE(NULLIF(@Category, N''), N'Masraf'), 11));
    DECLARE @LineExp VARCHAR(201) = CONVERT(
        VARCHAR(201),
        LEFT(
            LTRIM(RTRIM(CONCAT(
                N'POS masraf',
                CASE WHEN NULLIF(@Category, N'') IS NULL THEN N'' ELSE CONCAT(N' - ', @Category) END,
                CASE WHEN NULLIF(@Note, N'') IS NULL THEN N'' ELSE CONCAT(N': ', @Note) END
            ))),
            201
        )
    );
    DECLARE @Now DATETIME = GETDATE();
    DECLARE @Hour SMALLINT = DATEPART(HOUR, @Now);
    DECLARE @Minute SMALLINT = DATEPART(MINUTE, @Now);
    DECLARE @Second SMALLINT = DATEPART(SECOND, @Now);
    DECLARE @KslinesRef INT;

    IF @CashboxCode IS NOT NULL
    BEGIN
        SELECT TOP 1 @CashboxRef = LOGICALREF
        FROM dbo.LG_003_KSCARD WITH (NOLOCK)
        WHERE CODE = CONVERT(VARCHAR(25), @CashboxCode)
          AND ISNULL(ACTIVE, 0) = 0;
    END;

    IF @CashboxRef IS NULL
    BEGIN
        SELECT TOP 1 @CashboxRef = LOGICALREF
        FROM dbo.LG_003_KSCARD WITH (NOLOCK)
        WHERE ISNULL(ACTIVE, 0) = 0
        ORDER BY LOGICALREF;
    END;

    IF @CashboxRef IS NULL
        THROW 51061, 'Logo cashbox could not be resolved for POS expense export.', 1;

    IF @AccountCode IS NOT NULL
    BEGIN
        SELECT TOP 1 @AccountRef = LOGICALREF
        FROM dbo.LG_003_EMUHACC WITH (NOLOCK)
        WHERE CODE = CONVERT(VARCHAR(25), @AccountCode)
          AND ISNULL(ACTIVE, 0) = 0;

        IF @AccountRef IS NULL
        BEGIN
            SELECT TOP 1 @AccountRef = LOGICALREF
            FROM dbo.LG_003_EMUHACC WITH (NOLOCK)
            WHERE REPLACE(CODE, '.', '-') = REPLACE(CONVERT(VARCHAR(25), @AccountCode), '.', '-')
              AND ISNULL(ACTIVE, 0) = 0;
        END;
    END;

    IF @AccountCode IS NOT NULL AND @AccountRef IS NULL
        THROW 51062, 'Logo expense account could not be resolved.', 1;

    IF @AccountRef IS NOT NULL
    BEGIN
        SELECT TOP 1
            @ExpenseAccountCode = CODE
        FROM dbo.LG_003_EMUHACC WITH (NOLOCK)
        WHERE LOGICALREF = @AccountRef;

        IF @CashboxCode IS NOT NULL
        BEGIN
            SELECT TOP 1
                @CashAccountRef = LOGICALREF,
                @CashAccountCode = CODE
            FROM dbo.LG_003_EMUHACC WITH (NOLOCK)
            WHERE CODE = CONVERT(VARCHAR(25), @CashboxCode)
              AND ISNULL(ACTIVE, 0) = 0;

            IF @CashAccountRef IS NULL
            BEGIN
                SELECT TOP 1
                    @CashAccountRef = LOGICALREF,
                    @CashAccountCode = CODE
                FROM dbo.LG_003_EMUHACC WITH (NOLOCK)
                WHERE REPLACE(CODE, '.', '-') = REPLACE(CONVERT(VARCHAR(25), @CashboxCode), '.', '-')
                  AND ISNULL(ACTIVE, 0) = 0;
            END;
        END;

        IF @CashAccountRef IS NULL
            THROW 51063, 'Logo cash accounting account could not be resolved for POS expense export.', 1;
    END;

    BEGIN TRANSACTION;

    INSERT INTO dbo.LG_003_01_KSLINES (
        CARDREF, ACCREF, DATE_, HOUR_, MINUTE_, TRCODE, SPECODE, CYPHCODE, FICHENO,
        LINEEXP, AMOUNT, CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
        CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC,
        DOCODE
    )
    VALUES (
        @CashboxRef, @AccountRef, @ExpenseDate, @Hour, @Minute, 12, @Specode, @CyphCode, @FicheNo,
        @LineExp, CONVERT(FLOAT, @Amount), 0, 1, @Now,
        @Hour, @Minute, @Second,
        @Docode
    );

    SET @KslinesRef = SCOPE_IDENTITY();

    IF @AccountRef IS NOT NULL AND @CashAccountRef IS NOT NULL
    BEGIN
        DECLARE @EmficheRef INT;
        DECLARE @EmflineDebitRef INT;
        DECLARE @EmflineCreditRef INT;
        DECLARE @ExpenseKebirCode VARCHAR(17) = CONVERT(VARCHAR(17), LEFT(COALESCE(@ExpenseAccountCode, ''), 3));
        DECLARE @CashKebirCode VARCHAR(17) = CONVERT(VARCHAR(17), LEFT(COALESCE(@CashAccountCode, ''), 3));

        IF OBJECTPROPERTY(OBJECT_ID('dbo.LG_003_01_EMFICHE'), 'TableHasIdentity') = 1
        BEGIN
            INSERT INTO dbo.LG_003_01_EMFICHE (
                TRCODE, FICHENO, DATE_, SPECODE, CYPHCODE, DOCODE, BRANCH, DEPARTMENT,
                MODULENO, SOURCEFREF, GENEXP1, TOTALACTIVE, TOTALPASSIVE, CANCELLED,
                PRINTCNT, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR,
                CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC, MODULENR, EMUTOTACTIVE,
                EMUTOTPASSIVE, REPTOTACTIVE, REPTOTPASSIVE, STATUS, DOCDATE
            )
            VALUES (
                3, @FicheNo, @ExpenseDate, @Specode, @CyphCode, @Docode, 0, 0,
                10, @KslinesRef, @LineExp, CONVERT(FLOAT, @Amount), CONVERT(FLOAT, @Amount), 0,
                0, 1, @Now, @Hour,
                @Minute, @Second, 10, CONVERT(FLOAT, @Amount),
                CONVERT(FLOAT, @Amount), CONVERT(FLOAT, @Amount), CONVERT(FLOAT, @Amount), 0, @ExpenseDate
            );

            SET @EmficheRef = SCOPE_IDENTITY();
        END
        ELSE
        BEGIN
            SELECT @EmficheRef = ISNULL(MAX(LOGICALREF), 0) + 1 FROM dbo.LG_003_01_EMFICHE WITH (UPDLOCK, TABLOCKX);
            INSERT INTO dbo.LG_003_01_EMFICHE (
                LOGICALREF, TRCODE, FICHENO, DATE_, SPECODE, CYPHCODE, DOCODE, BRANCH, DEPARTMENT,
                MODULENO, SOURCEFREF, GENEXP1, TOTALACTIVE, TOTALPASSIVE, CANCELLED,
                PRINTCNT, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR,
                CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC, MODULENR, EMUTOTACTIVE,
                EMUTOTPASSIVE, REPTOTACTIVE, REPTOTPASSIVE, STATUS, DOCDATE
            )
            VALUES (
                @EmficheRef, 3, @FicheNo, @ExpenseDate, @Specode, @CyphCode, @Docode, 0, 0,
                10, @KslinesRef, @LineExp, CONVERT(FLOAT, @Amount), CONVERT(FLOAT, @Amount), 0,
                0, 1, @Now, @Hour,
                @Minute, @Second, 10, CONVERT(FLOAT, @Amount),
                CONVERT(FLOAT, @Amount), CONVERT(FLOAT, @Amount), CONVERT(FLOAT, @Amount), 0, @ExpenseDate
            );
        END;

        IF OBJECTPROPERTY(OBJECT_ID('dbo.LG_003_01_EMFLINE'), 'TableHasIdentity') = 1
        BEGIN
            INSERT INTO dbo.LG_003_01_EMFLINE (
                DATE_, SIGN, ACCOUNTREF, ACCFICHEREF, TRCODE, BRANCH, KEBIRCODE,
                ACCOUNTCODE, SPECODE, DEBIT, CREDIT, LINENO_, LINEEXP, CANCELLED,
                TRCURR, REPORTRATE, REPORTNET, TRRATE, TRNET, AMNT, EMUDEBIT,
                EMUCREDIT, MONTH_, YEAR_, SOURCEFREF, CASHLINE
            )
            VALUES (
                @ExpenseDate, 0, @AccountRef, @EmficheRef, 3, 0, @ExpenseKebirCode,
                @ExpenseAccountCode, @Specode, CONVERT(FLOAT, @Amount), 0, 1, @LineExp, 0,
                0, 1, CONVERT(FLOAT, @Amount), 1, CONVERT(FLOAT, @Amount), 0, CONVERT(FLOAT, @Amount),
                0, MONTH(@ExpenseDate), YEAR(@ExpenseDate), @KslinesRef, 1
            );
            SET @EmflineDebitRef = SCOPE_IDENTITY();

            INSERT INTO dbo.LG_003_01_EMFLINE (
                DATE_, SIGN, ACCOUNTREF, ACCFICHEREF, TRCODE, BRANCH, KEBIRCODE,
                ACCOUNTCODE, SPECODE, DEBIT, CREDIT, LINENO_, LINEEXP, CANCELLED,
                TRCURR, REPORTRATE, REPORTNET, TRRATE, TRNET, AMNT, EMUDEBIT,
                EMUCREDIT, MONTH_, YEAR_, SOURCEFREF, CASHLINE
            )
            VALUES (
                @ExpenseDate, 1, @CashAccountRef, @EmficheRef, 3, 0, @CashKebirCode,
                @CashAccountCode, @Specode, 0, CONVERT(FLOAT, @Amount), 2, @LineExp, 0,
                0, 1, CONVERT(FLOAT, @Amount), 1, CONVERT(FLOAT, @Amount), 0, 0,
                CONVERT(FLOAT, @Amount), MONTH(@ExpenseDate), YEAR(@ExpenseDate), @KslinesRef, 1
            );
            SET @EmflineCreditRef = SCOPE_IDENTITY();
        END
        ELSE
        BEGIN
            SELECT @EmflineDebitRef = ISNULL(MAX(LOGICALREF), 0) + 1 FROM dbo.LG_003_01_EMFLINE WITH (UPDLOCK, TABLOCKX);
            INSERT INTO dbo.LG_003_01_EMFLINE (
                LOGICALREF, DATE_, SIGN, ACCOUNTREF, ACCFICHEREF, TRCODE, BRANCH, KEBIRCODE,
                ACCOUNTCODE, SPECODE, DEBIT, CREDIT, LINENO_, LINEEXP, CANCELLED,
                TRCURR, REPORTRATE, REPORTNET, TRRATE, TRNET, AMNT, EMUDEBIT,
                EMUCREDIT, MONTH_, YEAR_, SOURCEFREF, CASHLINE
            )
            VALUES (
                @EmflineDebitRef, @ExpenseDate, 0, @AccountRef, @EmficheRef, 3, 0, @ExpenseKebirCode,
                @ExpenseAccountCode, @Specode, CONVERT(FLOAT, @Amount), 0, 1, @LineExp, 0,
                0, 1, CONVERT(FLOAT, @Amount), 1, CONVERT(FLOAT, @Amount), 0, CONVERT(FLOAT, @Amount),
                0, MONTH(@ExpenseDate), YEAR(@ExpenseDate), @KslinesRef, 1
            );

            SET @EmflineCreditRef = @EmflineDebitRef + 1;
            INSERT INTO dbo.LG_003_01_EMFLINE (
                LOGICALREF, DATE_, SIGN, ACCOUNTREF, ACCFICHEREF, TRCODE, BRANCH, KEBIRCODE,
                ACCOUNTCODE, SPECODE, DEBIT, CREDIT, LINENO_, LINEEXP, CANCELLED,
                TRCURR, REPORTRATE, REPORTNET, TRRATE, TRNET, AMNT, EMUDEBIT,
                EMUCREDIT, MONTH_, YEAR_, SOURCEFREF, CASHLINE
            )
            VALUES (
                @EmflineCreditRef, @ExpenseDate, 1, @CashAccountRef, @EmficheRef, 3, 0, @CashKebirCode,
                @CashAccountCode, @Specode, 0, CONVERT(FLOAT, @Amount), 2, @LineExp, 0,
                0, 1, CONVERT(FLOAT, @Amount), 1, CONVERT(FLOAT, @Amount), 0, 0,
                CONVERT(FLOAT, @Amount), MONTH(@ExpenseDate), YEAR(@ExpenseDate), @KslinesRef, 1
            );
        END;
    END;

    SET @ExternalRef = CONCAT(N'KSLINES-', @KslinesRef);
    EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;

    COMMIT TRANSACTION;
END;
GO
