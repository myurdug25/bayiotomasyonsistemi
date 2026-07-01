/*
  Powersa B2B collection write procedure for Logo Go Wings firm 003 period 01.

  This installs the idempotency log helpers and dbo.PowersaB2B_ExportCollection.
  It writes B2B tahsilat rows to:
  - LG_003_01_KSLINES  (kasa line)
  - LG_003_01_CLFLINE  (cari hareket)

  Existing Logo samples on 2026-06-03 showed this B2B mapping:
  - KSLINES.TRCODE = 11
  - CLFLINE.MODULENR = 10
  - CLFLINE.TRCODE = 1 for cash/transfer/cc/factory_cc
  - CLFLINE.TRCODE = 61 for check/note
  - KSLINES.TRANSREF = CLFLINE.LOGICALREF
  - CLFLINE.SOURCEFREF = KSLINES.LOGICALREF
  - SPECODE = B2B-COL-{collection_id}
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

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_WriteFactoryCollection
    @CustomerRef INT,
    @CollectionDate DATE,
    @Amount DECIMAL(15, 2),
    @ReferenceNo NVARCHAR(120),
    @Note NVARCHAR(MAX),
    @ExportKey NVARCHAR(128),
    @PayloadJson NVARCHAR(MAX),
    @ExternalRef NVARCHAR(128) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @FactoryCode VARCHAR(17) = CONVERT(VARCHAR(17), JSON_VALUE(@PayloadJson, '$.reference_fields.factory_customer_code'));
    DECLARE @FactoryRef INT;
    DECLARE @FicheRef INT;
    DECLARE @CustomerLineRef INT;
    DECLARE @FactoryLineRef INT;
    DECLARE @FicheNo VARCHAR(17) = CONVERT(VARCHAR(17), RIGHT(REPLICATE('0', 17) + @ExportKey, 17));
    DECLARE @Docode VARCHAR(33) = CONVERT(VARCHAR(33), LEFT(COALESCE(NULLIF(@ReferenceNo, N''), @ExportKey), 33));
    DECLARE @LineExp VARCHAR(251) = CONVERT(VARCHAR(251), LEFT(COALESCE(NULLIF(@Note, N''), N'Powersa B2B fabrika kart çekimi'), 251));
    DECLARE @Now DATETIME = GETDATE();
    DECLARE @Hour SMALLINT = DATEPART(HOUR, @Now);
    DECLARE @Minute SMALLINT = DATEPART(MINUTE, @Now);
    DECLARE @Second SMALLINT = DATEPART(SECOND, @Now);

    SELECT TOP 1 @FactoryRef = LOGICALREF
    FROM dbo.LG_003_CLCARD WITH (NOLOCK)
    WHERE CODE = @FactoryCode AND ISNULL(ACTIVE, 0) = 0;
    IF @FactoryRef IS NULL
        THROW 51031, 'Factory POS customer could not be resolved in Logo.', 1;

    INSERT INTO dbo.LG_003_01_CLFICHE (
        FICHENO, DATE_, DOCODE, TRCODE, GENEXP1, DEBIT, CREDIT,
        REPDEBIT, REPCREDIT, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
        CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC,
        ACCOUNTED, CANCELLED, HOUR_, MINUTE_
    )
    VALUES (
        @FicheNo, @CollectionDate, @Docode, 3, CONVERT(VARCHAR(51), LEFT(@LineExp, 51)),
        CONVERT(FLOAT, @Amount), CONVERT(FLOAT, @Amount), CONVERT(FLOAT, @Amount),
        CONVERT(FLOAT, @Amount), 1, @Now, @Hour, @Minute, @Second, 0, 0, @Hour, @Minute
    );
    SET @FicheRef = SCOPE_IDENTITY();

    INSERT INTO dbo.LG_003_01_CLFLINE (
        CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, TRANNO, DOCODE,
        LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET, REPORTRATE,
        REPORTNET, CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
        CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC
    )
    VALUES (
        @CustomerRef, @FicheRef, @CollectionDate, 5, 3, @FicheNo, @Docode,
        @LineExp, 1, CONVERT(FLOAT, @Amount), 0, 1, CONVERT(FLOAT, @Amount), 1,
        CONVERT(FLOAT, @Amount), 0, 1, @Now, @Hour, @Minute, @Second
    );
    SET @CustomerLineRef = SCOPE_IDENTITY();

    INSERT INTO dbo.LG_003_01_CLFLINE (
        CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, TRANNO, DOCODE,
        LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET, REPORTRATE,
        REPORTNET, CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
        CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC
    )
    VALUES (
        @FactoryRef, @FicheRef, @CollectionDate, 5, 3, @FicheNo, @Docode,
        @LineExp, 0, CONVERT(FLOAT, @Amount), 0, 1, CONVERT(FLOAT, @Amount), 1,
        CONVERT(FLOAT, @Amount), 0, 1, @Now, @Hour, @Minute, @Second
    );
    SET @FactoryLineRef = SCOPE_IDENTITY();

    SET @ExternalRef = CONCAT(N'CLFICHE-', @FicheRef, N'-CLFLINE-', @CustomerLineRef, N'-', @FactoryLineRef);
END;
GO

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_WriteBankCollection
    @CustomerRef INT,
    @CollectionDate DATE,
    @Method NVARCHAR(32),
    @Amount DECIMAL(15, 2),
    @ReferenceNo NVARCHAR(120),
    @Note NVARCHAR(MAX),
    @ExportKey NVARCHAR(128),
    @PayloadJson NVARCHAR(MAX),
    @ExternalRef NVARCHAR(128) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @BankCode VARCHAR(7) = CONVERT(VARCHAR(7), JSON_VALUE(@PayloadJson, '$.reference_fields.bank_logo_code'));
    DECLARE @BankRef INT;
    DECLARE @BankAccountRef INT;
    DECLARE @BankFicheRef INT;
    DECLARE @BankLineRef INT;
    DECLARE @ClientLineRef INT;
    DECLARE @FicheNo VARCHAR(17) = CONVERT(VARCHAR(17), RIGHT(REPLICATE('0', 17) + @ExportKey, 17));
    DECLARE @Docode VARCHAR(33) = CONVERT(VARCHAR(33), LEFT(COALESCE(NULLIF(@ReferenceNo, N''), @ExportKey), 33));
    DECLARE @LineExp VARCHAR(201) = CONVERT(VARCHAR(201), LEFT(COALESCE(NULLIF(@Note, N''), N'Powersa B2B banka tahsilatı'), 201));
    DECLARE @Now DATETIME = GETDATE();
    DECLARE @Hour SMALLINT = DATEPART(HOUR, @Now);
    DECLARE @Minute SMALLINT = DATEPART(MINUTE, @Now);
    DECLARE @Second SMALLINT = DATEPART(SECOND, @Now);

    SELECT TOP 1 @BankRef = LOGICALREF
    FROM dbo.LG_003_BNCARD WITH (NOLOCK)
    WHERE CODE = @BankCode AND ISNULL(ACTIVE, 0) = 0;

    IF @BankRef IS NULL
        THROW 51020, 'Logo bank card could not be resolved for collection export.', 1;

    SELECT TOP 1 @BankAccountRef = LOGICALREF
    FROM dbo.LG_003_BANKACC WITH (NOLOCK)
    WHERE BANKREF = @BankRef
      AND ISNULL(ACTIVE, 0) = 0
      AND (
        (LOWER(@Method) = N'cc' AND DEFINITION_ LIKE N'%KREDİ KARTI%')
        OR (LOWER(@Method) <> N'cc' AND DEFINITION_ NOT LIKE N'%KREDİ KARTI%')
      )
    ORDER BY CASE WHEN DEFINITION_ LIKE N'%POWERSA%' THEN 0 ELSE 1 END, LOGICALREF;

    IF @BankAccountRef IS NULL
        THROW 51021, 'Logo bank account could not be resolved for collection export.', 1;

    INSERT INTO dbo.LG_003_01_BNFICHE (
        DATE_, FICHENO, TRCODE, MODULENR, SIGN, DEBITTOT, CREDITTOT,
        GENEXP1, CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
        CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC,
        BNACCOUNTREF
    )
    VALUES (
        @CollectionDate, @FicheNo, 3, 7, 0, CONVERT(FLOAT, @Amount), 0,
        CONVERT(VARCHAR(51), LEFT(@LineExp, 51)), 0, 1, @Now,
        @Hour, @Minute, @Second, @BankAccountRef
    );
    SET @BankFicheRef = SCOPE_IDENTITY();

    INSERT INTO dbo.LG_003_01_BNFLINE (
        BANKREF, BNACCREF, CLIENTREF, SOURCEFREF, TRANSTYPE, DATE_,
        SIGN, TRCODE, MODULENR, LINENR, TRANNO, DOCODE, LINEEXP,
        TRCURR, AMOUNT, TRRATE, TRNET, REPORTRATE, REPORTNET,
        CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
        CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC
    )
    VALUES (
        @BankRef, @BankAccountRef, @CustomerRef, @BankFicheRef, 0, @CollectionDate,
        0, 3, 7, 1, @FicheNo, @Docode, @LineExp,
        0, CONVERT(FLOAT, @Amount), 1, CONVERT(FLOAT, @Amount), 1, CONVERT(FLOAT, @Amount),
        0, 1, @Now, @Hour, @Minute, @Second
    );
    SET @BankLineRef = SCOPE_IDENTITY();

    INSERT INTO dbo.LG_003_01_CLFLINE (
        CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, TRANNO, DOCODE,
        LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET, REPORTRATE,
        REPORTNET, CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
        CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC
    )
    VALUES (
        @CustomerRef, @BankLineRef, @CollectionDate, 7, 3, @FicheNo, @Docode,
        @LineExp, 1, CONVERT(FLOAT, @Amount), 0, 1, CONVERT(FLOAT, @Amount), 1,
        CONVERT(FLOAT, @Amount), 0, 1, @Now, @Hour, @Minute, @Second
    );
    SET @ClientLineRef = SCOPE_IDENTITY();

    SET @ExternalRef = CONCAT(N'BNFLINE-', @BankLineRef, N'-CLFLINE-', @ClientLineRef);
END;
GO

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_WriteChequeCollection
    @CustomerRef INT,
    @CollectionDate DATE,
    @Method NVARCHAR(32),
    @Amount DECIMAL(15, 2),
    @ReferenceNo NVARCHAR(120),
    @Note NVARCHAR(MAX),
    @ExportKey NVARCHAR(128),
    @PayloadJson NVARCHAR(MAX),
    @ExternalRef NVARCHAR(128) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @DocumentNo VARCHAR(31) = CONVERT(VARCHAR(31), LEFT(COALESCE(
        JSON_VALUE(@PayloadJson, '$.reference_fields.check_no'),
        JSON_VALUE(@PayloadJson, '$.reference_fields.note_no'),
        @ReferenceNo, @ExportKey
    ), 31));
    DECLARE @DueDate DATE = TRY_CONVERT(DATE, JSON_VALUE(@PayloadJson, '$.reference_fields.due_date'));
    DECLARE @BankName VARCHAR(51) = CONVERT(VARCHAR(51), LEFT(COALESCE(JSON_VALUE(@PayloadJson, '$.reference_fields.bank_name'), N''), 51));
    DECLARE @CardRef INT;
    DECLARE @RollRef INT;
    DECLARE @TransRef INT;
    DECLARE @ClientLineRef INT;
    DECLARE @RollNo VARCHAR(9) = CONVERT(VARCHAR(9), RIGHT(REPLICATE('0', 9) + CONVERT(VARCHAR(20), ABS(CHECKSUM(@ExportKey))), 9));
    DECLARE @LineExp VARCHAR(201) = CONVERT(VARCHAR(201), LEFT(COALESCE(NULLIF(@Note, N''), N'Powersa B2B çek/senet'), 201));
    DECLARE @Now DATETIME = GETDATE();
    DECLARE @Hour SMALLINT = DATEPART(HOUR, @Now);
    DECLARE @Minute SMALLINT = DATEPART(MINUTE, @Now);
    DECLARE @Second SMALLINT = DATEPART(SECOND, @Now);

    IF @DueDate IS NULL
        THROW 51030, 'Cheque due date is required for Logo export.', 1;

    INSERT INTO dbo.LG_003_01_CSCARD (
        DOC, CURRSTAT, PORTFOYNO, SERINO, BANKNAME, DUEDATE, SETDATE,
        AMOUNT, TRCURR, TRRATE, TRNET, REPORTRATE, REPORTNET, INUSE,
        CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR,
        CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC, CANCELLED, NEWSERINO,
        STATUS
    )
    VALUES (
        CASE WHEN LOWER(@Method) = N'note' THEN 2 ELSE 1 END, 1, @DocumentNo, @DocumentNo,
        @BankName, @DueDate, @CollectionDate, CONVERT(FLOAT, @Amount), 0, 1,
        CONVERT(FLOAT, @Amount), 1, CONVERT(FLOAT, @Amount), 1,
        1, @Now, @Hour, @Minute, @Second, 0, @DocumentNo, 0
    );
    SET @CardRef = SCOPE_IDENTITY();

    INSERT INTO dbo.LG_003_01_CSROLL (
        CARDREF, ROLLNO, DATE_, TRCODE, CARDMD, PROCTYPE, DOCCNT, TOTAL,
        TRCURR, TRRATE, TRNET, REPORTRATE, REPORTNET, GENEXP1,
        CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR,
        CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC, CANCELLED, DOCODE
    )
    VALUES (
        @CustomerRef, @RollNo, @CollectionDate, 1, 1, 0, 1, CONVERT(FLOAT, @Amount),
        0, 1, CONVERT(FLOAT, @Amount), 1, CONVERT(FLOAT, @Amount),
        CONVERT(VARCHAR(51), LEFT(@LineExp, 51)), 1, @Now, @Hour, @Minute, @Second, 0,
        CONVERT(VARCHAR(33), LEFT(@DocumentNo, 33))
    );
    SET @RollRef = SCOPE_IDENTITY();

    INSERT INTO dbo.LG_003_01_CSTRANS (
        DATE_, CSREF, ROLLREF, TRCODE, STATUS, CARDMD, CARDREF, STATNO,
        LINENO_, FROMCASH, CANCELLED
    )
    VALUES (
        @CollectionDate, @CardRef, @RollRef, 1, 0, 1, @CustomerRef, 1,
        1, 0, 0
    );
    SET @TransRef = SCOPE_IDENTITY();

    INSERT INTO dbo.LG_003_01_CLFLINE (
        CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, TRANNO, DOCODE,
        LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET, REPORTRATE,
        REPORTNET, CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
        CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC
    )
    VALUES (
        @CustomerRef, @TransRef, @CollectionDate, 6, 61, @RollNo, @DocumentNo,
        @LineExp, 1, CONVERT(FLOAT, @Amount), 0, 1, CONVERT(FLOAT, @Amount), 1,
        CONVERT(FLOAT, @Amount), 0, 1, @Now, @Hour, @Minute, @Second
    );
    SET @ClientLineRef = SCOPE_IDENTITY();

    SET @ExternalRef = CONCAT(N'CSCARD-', @CardRef, N'-CLFLINE-', @ClientLineRef);
END;
GO

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ExportCollection
    @CustomerExternalRef NVARCHAR(128) = NULL,
    @CustomerCode NVARCHAR(64) = NULL,
    @CollectionDate DATE,
    @Method NVARCHAR(32) = NULL,
    @Amount DECIMAL(15, 2),
    @Currency NVARCHAR(3) = N'TRY',
    @ReferenceNo NVARCHAR(120) = NULL,
    @Note NVARCHAR(MAX) = NULL,
    @ExportKey NVARCHAR(128),
    @CashboxId INT = NULL,
    @CashboxCode NVARCHAR(64) = NULL,
    @CashboxName NVARCHAR(128) = NULL,
    @PayloadJson NVARCHAR(MAX) = NULL,
    @ExternalRef NVARCHAR(128) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @ExistingExternalRef NVARCHAR(128);
    EXEC dbo.PowersaB2B_BeginExport @ExportKey, N'collection', @PayloadJson, @ExistingExternalRef OUTPUT;
    IF @ExistingExternalRef IS NOT NULL
    BEGIN
        SET @ExternalRef = @ExistingExternalRef;
        RETURN;
    END;

    DECLARE @CustomerRef INT = TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(@CustomerExternalRef)), N''));
    DECLARE @CashboxRef INT;
    DECLARE @Specode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(@ExportKey, 11));
    DECLARE @FicheNo VARCHAR(17) = CONVERT(VARCHAR(17), RIGHT(REPLICATE('0', 17) + @ExportKey, 17));
    DECLARE @Docode VARCHAR(33) = CONVERT(VARCHAR(33), LEFT(COALESCE(NULLIF(@ReferenceNo, N''), @ExportKey), 33));
    DECLARE @LineExp VARCHAR(251) = CONVERT(VARCHAR(251), LEFT(COALESCE(NULLIF(@Note, N''), N'Powersa B2B tahsilat'), 251));
    DECLARE @CyphCode VARCHAR(11) = CONVERT(VARCHAR(11), LEFT(COALESCE(NULLIF(@ReferenceNo, N''), N''), 11));
    DECLARE @ClTrcode SMALLINT = CASE WHEN LOWER(COALESCE(@Method, N'')) IN (N'check', N'note') THEN 61 ELSE 1 END;
    DECLARE @Now DATETIME = GETDATE();
    DECLARE @Hour SMALLINT = DATEPART(HOUR, @Now);
    DECLARE @Minute SMALLINT = DATEPART(MINUTE, @Now);
    DECLARE @Second SMALLINT = DATEPART(SECOND, @Now);
    DECLARE @KslinesRef INT;
    DECLARE @ClflineRef INT;

    IF @CustomerRef IS NULL
    BEGIN
        SELECT TOP 1 @CustomerRef = LOGICALREF
        FROM dbo.LG_003_CLCARD WITH (NOLOCK)
        WHERE CODE = CONVERT(VARCHAR(17), @CustomerCode)
          AND ISNULL(ACTIVE, 0) = 0;
    END;

    IF @CustomerRef IS NULL
        THROW 51010, 'Logo customer could not be resolved for collection export.', 1;

    IF LOWER(COALESCE(@Method, N'')) IN (N'transfer', N'cc')
       AND JSON_VALUE(@PayloadJson, '$.reference_fields.collection_channel') <> N'factory'
    BEGIN
        BEGIN TRANSACTION;
        EXEC dbo.PowersaB2B_WriteBankCollection
            @CustomerRef, @CollectionDate, @Method, @Amount, @ReferenceNo,
            @Note, @ExportKey, @PayloadJson, @ExternalRef OUTPUT;
        EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;
        COMMIT TRANSACTION;
        RETURN;
    END;

    IF LOWER(COALESCE(@Method, N'')) IN (N'check', N'note')
    BEGIN
        BEGIN TRANSACTION;
        EXEC dbo.PowersaB2B_WriteChequeCollection
            @CustomerRef, @CollectionDate, @Method, @Amount, @ReferenceNo,
            @Note, @ExportKey, @PayloadJson, @ExternalRef OUTPUT;
        EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;
        COMMIT TRANSACTION;
        RETURN;
    END;

    IF LOWER(COALESCE(@Method, N'')) = N'cc'
       AND JSON_VALUE(@PayloadJson, '$.reference_fields.collection_channel') = N'factory'
    BEGIN
        BEGIN TRANSACTION;
        EXEC dbo.PowersaB2B_WriteFactoryCollection
            @CustomerRef, @CollectionDate, @Amount, @ReferenceNo, @Note,
            @ExportKey, @PayloadJson, @ExternalRef OUTPUT;
        EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;
        COMMIT TRANSACTION;
        RETURN;
    END;

    IF @CashboxCode IS NOT NULL
    BEGIN
        SELECT TOP 1 @CashboxRef = LOGICALREF
        FROM dbo.LG_003_KSCARD WITH (NOLOCK)
        WHERE CODE = CONVERT(VARCHAR(25), @CashboxCode)
          AND ISNULL(ACTIVE, 0) = 0;
    END;

    IF @CashboxRef IS NULL AND @CashboxName IS NOT NULL
    BEGIN
        SELECT TOP 1 @CashboxRef = LOGICALREF
        FROM dbo.LG_003_KSCARD WITH (NOLOCK)
        WHERE NAME = CONVERT(VARCHAR(51), @CashboxName)
          AND ISNULL(ACTIVE, 0) = 0
        ORDER BY LOGICALREF;
    END;

    IF @CashboxRef IS NULL
        THROW 51011, 'Logo cashbox could not be resolved by exact code or name for collection export.', 1;

    SELECT TOP 1 @KslinesRef = LOGICALREF
    FROM dbo.LG_003_01_KSLINES WITH (NOLOCK)
    WHERE CARDREF = @CashboxRef
      AND FICHENO = @FicheNo
      AND ISNULL(CANCELLED, 0) = 0
    ORDER BY LOGICALREF DESC;

    IF @KslinesRef IS NOT NULL
    BEGIN
        IF NOT EXISTS (
            SELECT 1
            FROM dbo.LG_003_01_KSLINES WITH (NOLOCK)
            WHERE LOGICALREF = @KslinesRef
              AND DATE_ = @CollectionDate
              AND ABS(CONVERT(DECIMAL(15, 2), AMOUNT) - @Amount) < 0.01
        )
            THROW 51012, 'Existing Logo cash line does not match collection date or amount.', 1;

        SELECT TOP 1 @ClflineRef = LOGICALREF
        FROM dbo.LG_003_01_CLFLINE WITH (NOLOCK)
        WHERE SOURCEFREF = @KslinesRef
          AND CLIENTREF = @CustomerRef
          AND MODULENR = 10
          AND SIGN = 1
          AND ABS(CONVERT(DECIMAL(15, 2), AMOUNT) - @Amount) < 0.01
          AND ISNULL(CANCELLED, 0) = 0
        ORDER BY LOGICALREF DESC;

        IF @ClflineRef IS NULL
            THROW 51013, 'Existing Logo cash line has no matching customer ledger line.', 1;

        SET @ExternalRef = CONCAT(N'CLFLINE-', @ClflineRef);
        EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;
        RETURN;
    END;

    BEGIN TRANSACTION;

    IF OBJECTPROPERTY(OBJECT_ID('dbo.LG_003_01_KSLINES'), 'TableHasIdentity') = 1
    BEGIN
        INSERT INTO dbo.LG_003_01_KSLINES (
            CARDREF, DATE_, HOUR_, MINUTE_, TRCODE, SPECODE, CYPHCODE, FICHENO,
            LINEEXP, AMOUNT, CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
            CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC,
            DOCODE
        )
        VALUES (
            @CashboxRef, @CollectionDate, @Hour, @Minute, 11, @Specode, @CyphCode, @FicheNo,
            @LineExp, CONVERT(FLOAT, @Amount), 0, 1, @Now,
            @Hour, @Minute, @Second,
            @Docode
        );
        SET @KslinesRef = SCOPE_IDENTITY();
    END
    ELSE
    BEGIN
        SELECT @KslinesRef = ISNULL(MAX(LOGICALREF), 0) + 1 FROM dbo.LG_003_01_KSLINES WITH (UPDLOCK, TABLOCKX);
        INSERT INTO dbo.LG_003_01_KSLINES (
            LOGICALREF, CARDREF, DATE_, HOUR_, MINUTE_, TRCODE, SPECODE, CYPHCODE, FICHENO,
            LINEEXP, AMOUNT, CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
            CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC,
            DOCODE
        )
        VALUES (
            @KslinesRef, @CashboxRef, @CollectionDate, @Hour, @Minute, 11, @Specode, @CyphCode, @FicheNo,
            @LineExp, CONVERT(FLOAT, @Amount), 0, 1, @Now,
            @Hour, @Minute, @Second,
            @Docode
        );
    END

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
            @CustomerRef, @KslinesRef, @CollectionDate, 10, @ClTrcode, @Specode, @CyphCode,
            @FicheNo, @Docode, @LineExp, 1, CONVERT(FLOAT, @Amount), 0, 1, CONVERT(FLOAT, @Amount),
            1, CONVERT(FLOAT, @Amount), 0, 1,
            @Now, @Hour, @Minute, @Second
        );
        SET @ClflineRef = SCOPE_IDENTITY();
    END
    ELSE
    BEGIN
        SELECT @ClflineRef = ISNULL(MAX(LOGICALREF), 0) + 1 FROM dbo.LG_003_01_CLFLINE WITH (UPDLOCK, TABLOCKX);
        INSERT INTO dbo.LG_003_01_CLFLINE (
            LOGICALREF, CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, SPECODE, CYPHCODE,
            TRANNO, DOCODE, LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET,
            REPORTRATE, REPORTNET, CANCELLED, CAPIBLOCK_CREATEDBY,
            CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN,
            CAPIBLOCK_CREATEDSEC
        )
        VALUES (
            @ClflineRef, @CustomerRef, @KslinesRef, @CollectionDate, 10, @ClTrcode, @Specode, @CyphCode,
            @FicheNo, @Docode, @LineExp, 1, CONVERT(FLOAT, @Amount), 0, 1, CONVERT(FLOAT, @Amount),
            1, CONVERT(FLOAT, @Amount), 0, 1,
            @Now, @Hour, @Minute, @Second
        );
    END

    UPDATE dbo.LG_003_01_KSLINES
       SET TRANSREF = @ClflineRef
     WHERE LOGICALREF = @KslinesRef;

    SET @ExternalRef = CONCAT(N'CLFLINE-', @ClflineRef);
    EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;

    COMMIT TRANSACTION;
END;
GO
