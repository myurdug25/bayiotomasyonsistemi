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
    DECLARE @ExpenseClientRef INT;
    DECLARE @CashAccountRef INT;
    DECLARE @BankRef INT;
    DECLARE @BankAccountRef INT;
    DECLARE @BankLineRef INT;
    DECLARE @BankFicheRef INT;
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
    DECLARE @ExpenseClflineRef INT;
    DECLARE @CashboxName NVARCHAR(128);
    DECLARE @ExpenseAccountName NVARCHAR(255);
    DECLARE @PaymentSourceType NVARCHAR(32) = N'cash';
    DECLARE @BankCode NVARCHAR(64);
    DECLARE @BankName NVARCHAR(128);
    DECLARE @BankExpenseMode BIT = 0;
    DECLARE @BankTransferMode BIT = 0;
    DECLARE @OperationType NVARCHAR(32) = N'expense';
    DECLARE @UseBankSource BIT = 0;
    DECLARE @UseCashboxSource BIT = 1;
    DECLARE @BankLineTranstype SMALLINT = 1;
    DECLARE @BankLineTrcode SMALLINT = 1;
    DECLARE @BankProcessType SMALLINT = 2;
    DECLARE @SalespersonCode VARCHAR(25);

    IF NULLIF(LTRIM(RTRIM(@CashboxCode)), N'') IS NULL AND @PayloadJson IS NOT NULL AND ISJSON(@PayloadJson) = 1
    BEGIN
        SET @CashboxCode = COALESCE(
            JSON_VALUE(@PayloadJson, '$.cashbox_code'),
            JSON_VALUE(@PayloadJson, '$.meta.source_meta.cashbox_code'),
            JSON_VALUE(@PayloadJson, '$.meta.cashbox.code')
        );
    END;

    IF @PayloadJson IS NOT NULL AND ISJSON(@PayloadJson) = 1
    BEGIN
        SET @CashboxName = COALESCE(
            JSON_VALUE(@PayloadJson, '$.cashbox_name'),
            JSON_VALUE(@PayloadJson, '$.meta.source_meta.cashbox_name'),
            JSON_VALUE(@PayloadJson, '$.meta.cashbox.name')
        );

        SET @ExpenseAccountName = COALESCE(
            JSON_VALUE(@PayloadJson, '$.account_name'),
            JSON_VALUE(@PayloadJson, '$.expense_account_name'),
            JSON_VALUE(@PayloadJson, '$.logo_expense_account_name'),
            JSON_VALUE(@PayloadJson, '$.meta.logo_expense_account_name'),
            JSON_VALUE(@PayloadJson, '$.meta.source_meta.logo_expense_account_name'),
            JSON_VALUE(@PayloadJson, '$.meta.expense_account.name')
        );

        SET @PaymentSourceType = COALESCE(
            JSON_VALUE(@PayloadJson, '$.payment_source_type'),
            JSON_VALUE(@PayloadJson, '$.payment_source.type'),
            JSON_VALUE(@PayloadJson, '$.meta.source_meta.payment_source_type'),
            JSON_VALUE(@PayloadJson, '$.meta.payment_source.type'),
            N'cash'
        );

        SET @BankCode = COALESCE(
            JSON_VALUE(@PayloadJson, '$.bank_account_logo_code'),
            JSON_VALUE(@PayloadJson, '$.payment_source_logo_code'),
            JSON_VALUE(@PayloadJson, '$.bank_account.code'),
            JSON_VALUE(@PayloadJson, '$.bank_account.logo_code'),
            JSON_VALUE(@PayloadJson, '$.payment_source.logo_code'),
            JSON_VALUE(@PayloadJson, '$.meta.source_meta.bank_account_logo_code'),
            JSON_VALUE(@PayloadJson, '$.meta.source_meta.payment_source_logo_code'),
            JSON_VALUE(@PayloadJson, '$.meta.bank_account.logo_code'),
            JSON_VALUE(@PayloadJson, '$.meta.payment_source.logo_code')
        );

        SET @BankName = COALESCE(
            JSON_VALUE(@PayloadJson, '$.bank_account_name'),
            JSON_VALUE(@PayloadJson, '$.payment_source_name'),
            JSON_VALUE(@PayloadJson, '$.bank_account.name'),
            JSON_VALUE(@PayloadJson, '$.payment_source.name'),
            JSON_VALUE(@PayloadJson, '$.meta.source_meta.bank_account_name'),
            JSON_VALUE(@PayloadJson, '$.meta.source_meta.payment_source_name'),
            JSON_VALUE(@PayloadJson, '$.meta.bank_account.name'),
            JSON_VALUE(@PayloadJson, '$.meta.payment_source.name')
        );

        SET @BankExpenseMode = CASE
            WHEN COALESCE(JSON_VALUE(@PayloadJson, '$.bank_expense_mode'), JSON_VALUE(@PayloadJson, '$.meta.source_meta.bank_expense_mode')) IN (N'true', N'1')
                THEN 1
            ELSE 0
        END;

        SET @OperationType = COALESCE(
            JSON_VALUE(@PayloadJson, '$.operation_type'),
            JSON_VALUE(@PayloadJson, '$.meta.source_meta.operation_type'),
            N'expense'
        );

        SET @BankTransferMode = CASE
            WHEN COALESCE(JSON_VALUE(@PayloadJson, '$.bank_transfer_mode'), JSON_VALUE(@PayloadJson, '$.meta.source_meta.bank_transfer_mode')) IN (N'true', N'1')
                THEN 1
            WHEN LOWER(COALESCE(@OperationType, N'')) = N'cash_to_bank'
                THEN 1
            ELSE 0
        END;

        SET @SalespersonCode = CONVERT(VARCHAR(25), LEFT(COALESCE(
            NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson_code'), N''),
            NULLIF(JSON_VALUE(@PayloadJson, '$.logo.salesperson_code'), N''),
            NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.logo_code'), N''),
            NULLIF(JSON_VALUE(@PayloadJson, '$.meta.source_meta.salesperson_code'), N''),
            NULLIF(JSON_VALUE(@PayloadJson, '$.meta.salesperson.logo_code'), N''),
            NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.name'), N''),
            NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.username'), N''),
            NULLIF(JSON_VALUE(@PayloadJson, '$.created_by_name'), N''),
            NULLIF(JSON_VALUE(@PayloadJson, '$.meta.source_meta.created_by_name'), N''),
            NULLIF(JSON_VALUE(@PayloadJson, '$.created_by_user_id'), N'')
        ), 25));
    END;

    SET @UseBankSource = CASE
        WHEN LOWER(COALESCE(@PaymentSourceType, N'')) = N'bank' AND NULLIF(LTRIM(RTRIM(@BankCode)), N'') IS NOT NULL THEN 1
        ELSE 0
    END;

    SET @UseCashboxSource = CASE
        WHEN @BankTransferMode = 1 THEN 1
        WHEN @UseBankSource = 1 AND @BankExpenseMode = 0 THEN 0
        ELSE 1
    END;

    IF @UseCashboxSource = 1 AND @CashboxCode IS NOT NULL
    BEGIN
        SELECT TOP 1 @CashboxRef = LOGICALREF
        FROM dbo.LG_003_KSCARD WITH (NOLOCK)
        WHERE CODE = CONVERT(VARCHAR(25), @CashboxCode)
          AND ISNULL(ACTIVE, 0) = 0;
    END;

    IF @UseCashboxSource = 1 AND @CashboxRef IS NULL AND NULLIF(LTRIM(RTRIM(@CashboxName)), N'') IS NOT NULL
    BEGIN
        SELECT TOP 1 @CashboxRef = LOGICALREF
        FROM dbo.LG_003_KSCARD WITH (NOLOCK)
        WHERE NAME = CONVERT(VARCHAR(51), @CashboxName)
          AND ISNULL(ACTIVE, 0) = 0;
    END;

    IF @UseCashboxSource = 1 AND @CashboxRef IS NULL
        THROW 51061, 'Logo cashbox could not be resolved for POS expense export. Check cashbox_code/cashbox_name.', 1;

    IF @UseBankSource = 1 OR @BankTransferMode = 1
    BEGIN
        SELECT TOP 1 @BankRef = LOGICALREF
        FROM dbo.LG_003_BNCARD WITH (NOLOCK)
        WHERE CODE = CONVERT(VARCHAR(25), @BankCode)
          AND ISNULL(ACTIVE, 0) = 0;

        IF @BankRef IS NULL AND NULLIF(LTRIM(RTRIM(@BankName)), N'') IS NOT NULL
        BEGIN
            SELECT TOP 1 @BankRef = LOGICALREF
            FROM dbo.LG_003_BNCARD WITH (NOLOCK)
            WHERE DEFINITION_ = CONVERT(VARCHAR(51), @BankName)
              AND ISNULL(ACTIVE, 0) = 0;
        END;

        IF @BankRef IS NULL
            THROW 51064, 'Logo bank card could not be resolved for POS expense export.', 1;

        SELECT TOP 1 @BankAccountRef = LOGICALREF
        FROM dbo.LG_003_BANKACC WITH (NOLOCK)
        WHERE BANKREF = @BankRef
          AND ISNULL(ACTIVE, 0) = 0
        ORDER BY CASE WHEN DEFINITION_ LIKE N'%POWERSA%' THEN 0 ELSE 1 END, LOGICALREF;

        IF @BankAccountRef IS NULL
            THROW 51065, 'Logo bank account could not be resolved for POS expense export.', 1;
    END;

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

        SELECT TOP 1 @ExpenseClientRef = LOGICALREF
        FROM dbo.LG_003_CLCARD WITH (NOLOCK)
        WHERE CODE = CONVERT(VARCHAR(25), @AccountCode)
          AND ISNULL(ACTIVE, 0) = 0;

        IF @ExpenseClientRef IS NULL
        BEGIN
            SELECT TOP 1 @ExpenseClientRef = LOGICALREF
            FROM dbo.LG_003_CLCARD WITH (NOLOCK)
            WHERE REPLACE(CODE, '.', '-') = REPLACE(CONVERT(VARCHAR(25), @AccountCode), '.', '-')
              AND ISNULL(ACTIVE, 0) = 0;
        END;

        IF @ExpenseClientRef IS NULL
        BEGIN
            SELECT TOP 1 @ExpenseClientRef = LOGICALREF
            FROM dbo.LG_003_CLCARD WITH (NOLOCK)
            WHERE REPLACE(REPLACE(REPLACE(CODE, '.', '-'), ' ', ''), CHAR(9), '')
                = REPLACE(REPLACE(REPLACE(CONVERT(VARCHAR(25), @AccountCode), '.', '-'), ' ', ''), CHAR(9), '')
              AND ISNULL(ACTIVE, 0) = 0;
        END;

        IF @ExpenseClientRef IS NULL AND NULLIF(LTRIM(RTRIM(@ExpenseAccountName)), N'') IS NOT NULL
        BEGIN
            SELECT TOP 1 @ExpenseClientRef = LOGICALREF
            FROM dbo.LG_003_CLCARD WITH (NOLOCK)
            WHERE DEFINITION_ = CONVERT(VARCHAR(201), @ExpenseAccountName)
              AND ISNULL(ACTIVE, 0) = 0;
        END;
    END;

    IF @AccountCode IS NOT NULL AND @ExpenseClientRef IS NULL AND @BankTransferMode = 0
        THROW 51062, 'Logo expense customer card could not be resolved for POS expense export. Check LOGO Gider Hesap Kodu / Logo CLCARD code.', 1;

    IF @AccountRef IS NOT NULL
    BEGIN
        SELECT TOP 1
            @ExpenseAccountCode = CODE
        FROM dbo.LG_003_EMUHACC WITH (NOLOCK)
        WHERE LOGICALREF = @AccountRef;

        IF @UseCashboxSource = 1 AND @CashboxCode IS NOT NULL
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

        IF @UseCashboxSource = 1 AND @CashAccountRef IS NULL
            THROW 51063, 'Logo cash accounting account could not be resolved for POS expense export.', 1;
    END;

    BEGIN TRANSACTION;

    IF @UseCashboxSource = 1
    BEGIN
        IF @BankTransferMode = 1
        BEGIN
            -- Kasa -> banka aktarımı gider değildir. Kasa çıkış satırı gider
            -- muhasebe hesabına bağlanmadan oluşturulur.
            INSERT INTO dbo.LG_003_01_KSLINES (
                CARDREF, DATE_, HOUR_, MINUTE_, TRCODE, SPECODE, CYPHCODE, FICHENO,
                LINEEXP, AMOUNT, CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
                CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC,
                CAPIBLOCK_MODIFIEDBY, CAPIBLOCK_MODIFIEDDATE, CAPIBLOCK_MODIFIEDHOUR,
                CAPIBLOCK_MODIFIEDMIN, CAPIBLOCK_MODIFIEDSEC,
                DOCODE
            )
            VALUES (
                @CashboxRef, @ExpenseDate, @Hour, @Minute, 12, @Specode, @CyphCode, @FicheNo,
                @LineExp, CONVERT(FLOAT, @Amount), 0, 1, @Now,
                @Hour, @Minute, @Second,
                1, @Now, @Hour, @Minute, @Second,
                @Docode
            );
        END
        ELSE
        BEGIN
            INSERT INTO dbo.LG_003_01_KSLINES (
                CARDREF, ACCREF, DATE_, HOUR_, MINUTE_, TRCODE, SPECODE, CYPHCODE, FICHENO,
                LINEEXP, AMOUNT, CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
                CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC,
                CAPIBLOCK_MODIFIEDBY, CAPIBLOCK_MODIFIEDDATE, CAPIBLOCK_MODIFIEDHOUR,
                CAPIBLOCK_MODIFIEDMIN, CAPIBLOCK_MODIFIEDSEC,
                DOCODE
            )
            VALUES (
                @CashboxRef, @AccountRef, @ExpenseDate, @Hour, @Minute, 12, @Specode, @CyphCode, @FicheNo,
                @LineExp, CONVERT(FLOAT, @Amount), 0, 1, @Now,
                @Hour, @Minute, @Second,
                1, @Now, @Hour, @Minute, @Second,
                @Docode
            );
        END;

        SET @KslinesRef = SCOPE_IDENTITY();
    END;

    IF @UseCashboxSource = 1 AND @AccountRef IS NOT NULL AND @CashAccountRef IS NOT NULL
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
                10, @KslinesRef, CONVERT(VARCHAR(51), LEFT(@LineExp, 51)), CONVERT(FLOAT, @Amount), CONVERT(FLOAT, @Amount), 0,
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
                10, @KslinesRef, CONVERT(VARCHAR(51), LEFT(@LineExp, 51)), CONVERT(FLOAT, @Amount), CONVERT(FLOAT, @Amount), 0,
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

    IF @UseBankSource = 1 OR @BankTransferMode = 1
    BEGIN
        INSERT INTO dbo.LG_003_01_BNFICHE (
            DATE_, FICHENO, TRCODE, MODULENR, SIGN, DEBITTOT, CREDITTOT,
            GENEXP1, CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
            CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC,
            BNACCOUNTREF
        )
        VALUES (
            @ExpenseDate, @FicheNo, CASE WHEN @BankTransferMode = 1 THEN 3 ELSE 4 END, 7,
            CASE WHEN @BankTransferMode = 1 THEN 0 ELSE 1 END,
            CASE WHEN @BankTransferMode = 1 THEN CONVERT(FLOAT, @Amount) ELSE 0 END,
            CASE WHEN @BankTransferMode = 1 THEN 0 ELSE CONVERT(FLOAT, @Amount) END,
            CONVERT(VARCHAR(51), LEFT(@LineExp, 51)), 0, 1, @Now,
            @Hour, @Minute, @Second, @BankAccountRef
        );
        SET @BankFicheRef = SCOPE_IDENTITY();
        IF OBJECT_ID(N'dbo.PowersaB2B_ApplySalespersonToLogoRow', N'P') IS NOT NULL
            EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_BNFICHE', @BankFicheRef, @SalespersonCode;

        INSERT INTO dbo.LG_003_01_BNFLINE (
            BANKREF, BNACCREF, CLIENTREF, SOURCEFREF, TRANSTYPE, DATE_,
            SIGN, TRCODE, MODULENR, LINENR, TRANNO, DOCODE, LINEEXP,
            TRCURR, AMOUNT, TRRATE, TRNET, REPORTRATE, REPORTNET,
            BANKPROCTYPE, BANKPROCCODE,
            CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
            CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC
        )
        VALUES (
            @BankRef, @BankAccountRef, @ExpenseClientRef, @BankFicheRef, @BankLineTranstype, @ExpenseDate,
            CASE WHEN @BankTransferMode = 1 THEN 0 ELSE 1 END,
            @BankLineTrcode,
            7, 1, @FicheNo, @Docode, @LineExp,
            0, CONVERT(FLOAT, @Amount), 1, CONVERT(FLOAT, @Amount), 1, CONVERT(FLOAT, @Amount),
            @BankProcessType, @BankProcessType,
            0, 1, @Now, @Hour, @Minute, @Second
        );
        SET @BankLineRef = SCOPE_IDENTITY();
        IF OBJECT_ID(N'dbo.PowersaB2B_ApplySalespersonToLogoRow', N'P') IS NOT NULL
            EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_BNFLINE', @BankLineRef, @SalespersonCode;
    END;

    IF @ExpenseClientRef IS NOT NULL AND @BankTransferMode = 0
    BEGIN
        DECLARE @ClientSourceRef INT = COALESCE(@KslinesRef, @BankLineRef);
        DECLARE @ClientModuleNr SMALLINT = CASE WHEN @KslinesRef IS NOT NULL THEN 10 ELSE 7 END;
        DECLARE @ClientTrcode SMALLINT = CASE WHEN @KslinesRef IS NOT NULL THEN 1 ELSE 4 END;

        IF OBJECTPROPERTY(OBJECT_ID('dbo.LG_003_01_CLFLINE'), 'TableHasIdentity') = 1
        BEGIN
            INSERT INTO dbo.LG_003_01_CLFLINE (
                CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, SPECODE, CYPHCODE,
                TRANNO, DOCODE, LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET,
                REPORTRATE, REPORTNET, CANCELLED, CAPIBLOCK_CREATEDBY,
                CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN,
                CAPIBLOCK_CREATEDSEC
            )
            VALUES (
                @ExpenseClientRef, @ClientSourceRef, @ExpenseDate, @ClientModuleNr, @ClientTrcode, @Specode, @CyphCode,
                @FicheNo, @Docode, @LineExp, 0, CONVERT(FLOAT, @Amount), 0, 1, CONVERT(FLOAT, @Amount),
                1, CONVERT(FLOAT, @Amount), 0, 1, @Now, @Hour, @Minute, @Second
            );

            SET @ExpenseClflineRef = SCOPE_IDENTITY();
        END
        ELSE
        BEGIN
            SELECT @ExpenseClflineRef = ISNULL(MAX(LOGICALREF), 0) + 1
            FROM dbo.LG_003_01_CLFLINE WITH (UPDLOCK, TABLOCKX);

            INSERT INTO dbo.LG_003_01_CLFLINE (
                LOGICALREF, CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, SPECODE, CYPHCODE,
                TRANNO, DOCODE, LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET,
                REPORTRATE, REPORTNET, CANCELLED, CAPIBLOCK_CREATEDBY,
                CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN,
                CAPIBLOCK_CREATEDSEC
            )
            VALUES (
                @ExpenseClflineRef, @ExpenseClientRef, @ClientSourceRef, @ExpenseDate, @ClientModuleNr, @ClientTrcode, @Specode, @CyphCode,
                @FicheNo, @Docode, @LineExp, 0, CONVERT(FLOAT, @Amount), 0, 1, CONVERT(FLOAT, @Amount),
                1, CONVERT(FLOAT, @Amount), 0, 1, @Now, @Hour, @Minute, @Second
            );
        END;

        IF @KslinesRef IS NOT NULL
        BEGIN
            UPDATE dbo.LG_003_01_KSLINES
               SET TRANSREF = @ExpenseClflineRef
             WHERE LOGICALREF = @KslinesRef;
        END;
    END;

    IF (@UseBankSource = 1 OR @BankTransferMode = 1)
       AND (
            @BankFicheRef IS NULL
            OR @BankLineRef IS NULL
            OR NOT EXISTS (
                SELECT 1
                FROM dbo.LG_003_01_BNFLINE WITH (NOLOCK)
                WHERE LOGICALREF = @BankLineRef
                  AND BANKREF = @BankRef
                  AND BNACCREF = @BankAccountRef
                  AND ISNULL(CANCELLED, 0) = 0
                  AND ABS(ISNULL(AMOUNT, 0) - CONVERT(FLOAT, @Amount)) < 0.001
            )
       )
        THROW 51066, 'Logo bank movement could not be verified for POS expense export.', 1;

    SET @ExternalRef = CONCAT(
        CASE WHEN @KslinesRef IS NULL THEN N'' ELSE CONCAT(N'KSLINES-', @KslinesRef) END,
        CASE WHEN @KslinesRef IS NOT NULL AND @BankLineRef IS NOT NULL THEN N'-' ELSE N'' END,
        CASE WHEN @BankLineRef IS NULL THEN N'' ELSE CONCAT(N'BNFLINE-', @BankLineRef) END,
        CASE WHEN @ExpenseClflineRef IS NULL THEN N'' ELSE CONCAT(N'-CLFLINE-', @ExpenseClflineRef) END
    );
    EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;

    COMMIT TRANSACTION;
END;
GO
