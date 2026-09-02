/*
  Powersa B2B collection write procedure for Logo Go Wings firm 003 period 01.

  This installs the idempotency log helpers and dbo.PowersaB2B_ExportCollection.
  It writes B2B tahsilat rows to the correct Logo modules:
  - cash: LG_003_01_KSLINES + LG_003_01_CLFLINE
  - transfer: LG_003_01_BNFICHE + LG_003_01_BNFLINE + LG_003_01_CLFLINE
  - check/note: LG_003_01_CSCARD + LG_003_01_CSROLL + LG_003_01_CSTRANS + LG_003_01_CLFLINE
  - physical POS: LG_003_01_CLFICHE + LG_003_01_CLFLINE (Kredi Kartı Fişi)

  Existing Logo samples on 2026-06-03 showed this B2B mapping:
  - KSLINES.TRCODE = 11
  - CLFLINE.MODULENR = 10
  - CLFLINE.TRCODE = 1 for cash, 20 for transfer, 70 for physical POS, 5 for factory card virman
  - CLFLINE.TRCODE = 61 for check, 62 for note
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

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ApplyCustomerTitleToCSCard
    @CardRef INT,
    @CustomerTitle NVARCHAR(201),
    @CustomerCode NVARCHAR(64) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @Title VARCHAR(201) = CONVERT(VARCHAR(201), LEFT(NULLIF(LTRIM(RTRIM(COALESCE(@CustomerTitle, N''))), N''), 201));
    DECLARE @Code VARCHAR(25) = CONVERT(VARCHAR(25), LEFT(NULLIF(LTRIM(RTRIM(COALESCE(@CustomerCode, N''))), N''), 25));

    IF @CardRef IS NULL
        RETURN;

    IF @Title IS NOT NULL AND COL_LENGTH(N'dbo.LG_003_01_CSCARD', N'OWING') IS NOT NULL
    BEGIN
        EXEC sys.sp_executesql
            N'UPDATE dbo.LG_003_01_CSCARD SET OWING = @Title WHERE LOGICALREF = @CardRef',
            N'@Title VARCHAR(201), @CardRef INT',
            @Title = @Title,
            @CardRef = @CardRef;
    END;

    IF @Title IS NOT NULL AND COL_LENGTH(N'dbo.LG_003_01_CSCARD', N'CUSTTITLE') IS NOT NULL
    BEGIN
        EXEC sys.sp_executesql
            N'UPDATE dbo.LG_003_01_CSCARD SET CUSTTITLE = @Title WHERE LOGICALREF = @CardRef',
            N'@Title VARCHAR(201), @CardRef INT',
            @Title = @Title,
            @CardRef = @CardRef;
    END;

    IF @Code IS NOT NULL AND COL_LENGTH(N'dbo.LG_003_01_CSCARD', N'CUSTCODE') IS NOT NULL
    BEGIN
        EXEC sys.sp_executesql
            N'UPDATE dbo.LG_003_01_CSCARD SET CUSTCODE = @Code WHERE LOGICALREF = @CardRef',
            N'@Code VARCHAR(25), @CardRef INT',
            @Code = @Code,
            @CardRef = @CardRef;
    END;

    IF COL_LENGTH(N'dbo.LG_003_01_CSCARD', N'CLTRCURR') IS NOT NULL
       OR COL_LENGTH(N'dbo.LG_003_01_CSCARD', N'CLTRRATE') IS NOT NULL
       OR COL_LENGTH(N'dbo.LG_003_01_CSCARD', N'CLTRNET') IS NOT NULL
       OR COL_LENGTH(N'dbo.LG_003_01_CSCARD', N'COLLATCARDREF') IS NOT NULL
    BEGIN
        DECLARE @SetList NVARCHAR(MAX) = N'';

        IF COL_LENGTH(N'dbo.LG_003_01_CSCARD', N'CLTRCURR') IS NOT NULL
            SET @SetList += N', CLTRCURR = ISNULL(CLTRCURR, 0)';
        IF COL_LENGTH(N'dbo.LG_003_01_CSCARD', N'CLTRRATE') IS NOT NULL
            SET @SetList += N', CLTRRATE = ISNULL(CLTRRATE, 0)';
        IF COL_LENGTH(N'dbo.LG_003_01_CSCARD', N'CLTRNET') IS NOT NULL
            SET @SetList += N', CLTRNET = ISNULL(CLTRNET, 0)';
        IF COL_LENGTH(N'dbo.LG_003_01_CSCARD', N'COLLATCARDREF') IS NOT NULL
            SET @SetList += N', COLLATCARDREF = ISNULL(COLLATCARDREF, 0)';

        IF LEN(@SetList) > 0
        BEGIN
            DECLARE @Sql NVARCHAR(MAX) =
                N'UPDATE dbo.LG_003_01_CSCARD SET ' + STUFF(@SetList, 1, 2, N'') + N' WHERE LOGICALREF = @CardRef';

            EXEC sys.sp_executesql
                @Sql,
                N'@CardRef INT',
                @CardRef = @CardRef;
        END;
    END;
END;
GO

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ApplyChequeNoteLogoDefaults
    @TableName NVARCHAR(128),
    @LogicalRef INT
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @SqlTable NVARCHAR(128) = CASE
        WHEN @TableName = N'dbo.LG_003_01_CSROLL' THEN N'dbo.LG_003_01_CSROLL'
        WHEN @TableName = N'dbo.LG_003_01_CSTRANS' THEN N'dbo.LG_003_01_CSTRANS'
        ELSE NULL
    END;
    DECLARE @SetList NVARCHAR(MAX) = N'';

    IF @LogicalRef IS NULL
        RETURN;

    IF @SqlTable IS NULL
        RETURN;

    IF @TableName = N'dbo.LG_003_01_CSROLL'
    BEGIN
        IF COL_LENGTH(@SqlTable, N'CARDMD') IS NOT NULL SET @SetList += N', CARDMD = CASE WHEN TRCODE IN (1, 2) AND ISNULL(CARDMD, 0) <> 5 THEN 5 ELSE CARDMD END';
        IF COL_LENGTH(@SqlTable, N'CENTERREF') IS NOT NULL SET @SetList += N', CENTERREF = ISNULL(CENTERREF, 0)';
        IF COL_LENGTH(@SqlTable, N'BRANCH') IS NOT NULL SET @SetList += N', BRANCH = ISNULL(BRANCH, 0)';
        IF COL_LENGTH(@SqlTable, N'DEPARTMENT') IS NOT NULL SET @SetList += N', DEPARTMENT = ISNULL(DEPARTMENT, 0)';
        IF COL_LENGTH(@SqlTable, N'DESTBRANCH') IS NOT NULL SET @SetList += N', DESTBRANCH = ISNULL(DESTBRANCH, 0)';
        IF COL_LENGTH(@SqlTable, N'DESTDEPARTMENT') IS NOT NULL SET @SetList += N', DESTDEPARTMENT = ISNULL(DESTDEPARTMENT, 0)';
        IF COL_LENGTH(@SqlTable, N'FROMCASH') IS NOT NULL SET @SetList += N', FROMCASH = ISNULL(FROMCASH, 0)';
        IF COL_LENGTH(@SqlTable, N'FROMBANK') IS NOT NULL SET @SetList += N', FROMBANK = ISNULL(FROMBANK, 0)';
        IF COL_LENGTH(@SqlTable, N'ACCREF') IS NOT NULL SET @SetList += N', ACCREF = ISNULL(ACCREF, 0)';
        IF COL_LENGTH(@SqlTable, N'ACCOUNTED') IS NOT NULL SET @SetList += N', ACCOUNTED = ISNULL(ACCOUNTED, 0)';
        IF COL_LENGTH(@SqlTable, N'CANCELLED') IS NOT NULL SET @SetList += N', CANCELLED = ISNULL(CANCELLED, 0)';
        IF COL_LENGTH(@SqlTable, N'CANCELLEDACC') IS NOT NULL SET @SetList += N', CANCELLEDACC = ISNULL(CANCELLEDACC, 0)';
        IF COL_LENGTH(@SqlTable, N'STATUS') IS NOT NULL SET @SetList += N', STATUS = ISNULL(STATUS, 0)';
        IF COL_LENGTH(@SqlTable, N'AFFECTRISK') IS NOT NULL SET @SetList += N', AFFECTRISK = ISNULL(AFFECTRISK, 1)';
        IF COL_LENGTH(@SqlTable, N'AFFECTCOLLATRL') IS NOT NULL SET @SetList += N', AFFECTCOLLATRL = ISNULL(AFFECTCOLLATRL, 0)';
        IF COL_LENGTH(@SqlTable, N'COLLATROLLREF') IS NOT NULL SET @SetList += N', COLLATROLLREF = ISNULL(COLLATROLLREF, 0)';
        IF COL_LENGTH(@SqlTable, N'BNCREREF') IS NOT NULL SET @SetList += N', BNCREREF = ISNULL(BNCREREF, 0)';
        IF COL_LENGTH(@SqlTable, N'PROCTYPE') IS NOT NULL SET @SetList += N', PROCTYPE = ISNULL(PROCTYPE, 0)';
        IF COL_LENGTH(@SqlTable, N'TEXTINC') IS NOT NULL SET @SetList += N', TEXTINC = ISNULL(TEXTINC, 0)';
        IF COL_LENGTH(@SqlTable, N'SITEID') IS NOT NULL SET @SetList += N', SITEID = ISNULL(SITEID, 0)';
        IF COL_LENGTH(@SqlTable, N'RECSTATUS') IS NOT NULL SET @SetList += N', RECSTATUS = ISNULL(RECSTATUS, 0)';
        IF COL_LENGTH(@SqlTable, N'ORGLOGICREF') IS NOT NULL SET @SetList += N', ORGLOGICREF = ISNULL(ORGLOGICREF, 0)';
        IF COL_LENGTH(@SqlTable, N'WFLOWCRDREF') IS NOT NULL SET @SetList += N', WFLOWCRDREF = ISNULL(WFLOWCRDREF, 0)';
        IF COL_LENGTH(@SqlTable, N'WFSTATUS') IS NOT NULL SET @SetList += N', WFSTATUS = ISNULL(WFSTATUS, 0)';
        IF COL_LENGTH(@SqlTable, N'OPSTAT') IS NOT NULL SET @SetList += N', OPSTAT = ISNULL(OPSTAT, 0)';
        IF COL_LENGTH(@SqlTable, N'INFIDX') IS NOT NULL SET @SetList += N', INFIDX = ISNULL(INFIDX, 0)';
        IF COL_LENGTH(@SqlTable, N'PROJECTREF') IS NOT NULL SET @SetList += N', PROJECTREF = ISNULL(PROJECTREF, 0)';
        IF COL_LENGTH(@SqlTable, N'GRPFIRMTRANS') IS NOT NULL SET @SetList += N', GRPFIRMTRANS = ISNULL(GRPFIRMTRANS, 0)';
        IF COL_LENGTH(@SqlTable, N'DEGCURR') IS NOT NULL SET @SetList += N', DEGCURR = ISNULL(DEGCURR, 0)';
        IF COL_LENGTH(@SqlTable, N'DEGCURRRATE') IS NOT NULL SET @SetList += N', DEGCURRRATE = ISNULL(DEGCURRRATE, 0)';
        IF COL_LENGTH(@SqlTable, N'APPROVE') IS NOT NULL SET @SetList += N', APPROVE = ISNULL(APPROVE, 0)';
        IF COL_LENGTH(@SqlTable, N'DEGACTIVE2') IS NOT NULL SET @SetList += N', DEGACTIVE2 = ISNULL(DEGACTIVE2, 0)';
        IF COL_LENGTH(@SqlTable, N'DEGCURR2') IS NOT NULL SET @SetList += N', DEGCURR2 = ISNULL(DEGCURR2, 0)';
        IF COL_LENGTH(@SqlTable, N'DEGCURRRATE2') IS NOT NULL SET @SetList += N', DEGCURRRATE2 = ISNULL(DEGCURRRATE2, 0)';
        IF COL_LENGTH(@SqlTable, N'FROMPARTIALCSPAY') IS NOT NULL SET @SetList += N', FROMPARTIALCSPAY = ISNULL(FROMPARTIALCSPAY, 0)';
    END
    ELSE IF @TableName = N'dbo.LG_003_01_CSTRANS'
    BEGIN
        IF COL_LENGTH(@SqlTable, N'STATUS') IS NOT NULL SET @SetList += N', STATUS = CASE WHEN TRCODE IN (1, 2) THEN 1 ELSE ISNULL(STATUS, 0) END';
        IF COL_LENGTH(@SqlTable, N'CARDMD') IS NOT NULL SET @SetList += N', CARDMD = CASE WHEN TRCODE IN (1, 2) AND ISNULL(CARDMD, 0) <> 5 THEN 5 ELSE CARDMD END';
        IF COL_LENGTH(@SqlTable, N'ACCOUNTED') IS NOT NULL SET @SetList += N', ACCOUNTED = ISNULL(ACCOUNTED, 0)';
        IF COL_LENGTH(@SqlTable, N'DEVIR') IS NOT NULL SET @SetList += N', DEVIR = ISNULL(DEVIR, 0)';
        IF COL_LENGTH(@SqlTable, N'STATNO') IS NOT NULL SET @SetList += N', STATNO = ISNULL(STATNO, 1)';
        IF COL_LENGTH(@SqlTable, N'LINENO_') IS NOT NULL SET @SetList += N', LINENO_ = ISNULL(LINENO_, 1)';
        IF COL_LENGTH(@SqlTable, N'ACCREF') IS NOT NULL SET @SetList += N', ACCREF = ISNULL(ACCREF, 0)';
        IF COL_LENGTH(@SqlTable, N'COSTREF') IS NOT NULL SET @SetList += N', COSTREF = ISNULL(COSTREF, 0)';
        IF COL_LENGTH(@SqlTable, N'CRSACCREF') IS NOT NULL SET @SetList += N', CRSACCREF = ISNULL(CRSACCREF, 0)';
        IF COL_LENGTH(@SqlTable, N'CRSCOSTREF') IS NOT NULL SET @SetList += N', CRSCOSTREF = ISNULL(CRSCOSTREF, 0)';
        IF COL_LENGTH(@SqlTable, N'FROMCASH') IS NOT NULL SET @SetList += N', FROMCASH = ISNULL(FROMCASH, 0)';
        IF COL_LENGTH(@SqlTable, N'FROMBANK') IS NOT NULL SET @SetList += N', FROMBANK = ISNULL(FROMBANK, 0)';
        IF COL_LENGTH(@SqlTable, N'CANCELLED') IS NOT NULL SET @SetList += N', CANCELLED = ISNULL(CANCELLED, 0)';
        IF COL_LENGTH(@SqlTable, N'LINEEXCTYP') IS NOT NULL SET @SetList += N', LINEEXCTYP = ISNULL(LINEEXCTYP, 0)';
        IF COL_LENGTH(@SqlTable, N'OPSTAT') IS NOT NULL SET @SetList += N', OPSTAT = ISNULL(OPSTAT, 0)';
        IF COL_LENGTH(@SqlTable, N'SITEID') IS NOT NULL SET @SetList += N', SITEID = ISNULL(SITEID, 0)';
        IF COL_LENGTH(@SqlTable, N'RECSTATUS') IS NOT NULL SET @SetList += N', RECSTATUS = ISNULL(RECSTATUS, 0)';
        IF COL_LENGTH(@SqlTable, N'ORGLOGICREF') IS NOT NULL SET @SetList += N', ORGLOGICREF = ISNULL(ORGLOGICREF, 0)';
        IF COL_LENGTH(@SqlTable, N'PROVLNACCREF') IS NOT NULL SET @SetList += N', PROVLNACCREF = ISNULL(PROVLNACCREF, 0)';
        IF COL_LENGTH(@SqlTable, N'PROVLNCOSTREF') IS NOT NULL SET @SetList += N', PROVLNCOSTREF = ISNULL(PROVLNCOSTREF, 0)';
        IF COL_LENGTH(@SqlTable, N'AFFECTCOLLATRL') IS NOT NULL SET @SetList += N', AFFECTCOLLATRL = ISNULL(AFFECTCOLLATRL, 0)';
        IF COL_LENGTH(@SqlTable, N'AFFECTRISK') IS NOT NULL SET @SetList += N', AFFECTRISK = ISNULL(AFFECTRISK, 1)';
        IF COL_LENGTH(@SqlTable, N'ORGLOGOID') IS NOT NULL SET @SetList += N', ORGLOGOID = ISNULL(ORGLOGOID, '''')';
        IF COL_LENGTH(@SqlTable, N'USEGIRORATE') IS NOT NULL SET @SetList += N', USEGIRORATE = ISNULL(USEGIRORATE, 0)';
        IF COL_LENGTH(@SqlTable, N'USERAISEDVAL') IS NOT NULL SET @SetList += N', USERAISEDVAL = ISNULL(USERAISEDVAL, 0)';
        IF COL_LENGTH(@SqlTable, N'CLACCREF') IS NOT NULL SET @SetList += N', CLACCREF = ISNULL(CLACCREF, 0)';
        IF COL_LENGTH(@SqlTable, N'CLCOSTREF') IS NOT NULL SET @SetList += N', CLCOSTREF = ISNULL(CLCOSTREF, 0)';
        IF COL_LENGTH(@SqlTable, N'BNCREREF') IS NOT NULL SET @SetList += N', BNCREREF = ISNULL(BNCREREF, 0)';
    END;

    IF LEN(@SetList) > 0
    BEGIN
        DECLARE @Sql NVARCHAR(MAX) =
            N'UPDATE ' + @SqlTable + N' SET ' + STUFF(@SetList, 1, 2, N'') + N' WHERE LOGICALREF = @LogicalRef';

        EXEC sys.sp_executesql
            @Sql,
            N'@LogicalRef INT',
            @LogicalRef = @LogicalRef;
    END;
END;
GO

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ApplyCustomerIdentityToCSRow
    @TableName NVARCHAR(128),
    @LogicalRef INT,
    @CustomerRef INT,
    @CustomerCode NVARCHAR(64),
    @CustomerTitle NVARCHAR(201)
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @SqlTable NVARCHAR(128) = CASE
        WHEN @TableName = N'dbo.LG_003_01_CSCARD' THEN N'dbo.LG_003_01_CSCARD'
        WHEN @TableName = N'dbo.LG_003_01_CSROLL' THEN N'dbo.LG_003_01_CSROLL'
        WHEN @TableName = N'dbo.LG_003_01_CSTRANS' THEN N'dbo.LG_003_01_CSTRANS'
        ELSE NULL
    END;
    DECLARE @Code VARCHAR(25) = CONVERT(VARCHAR(25), LEFT(NULLIF(LTRIM(RTRIM(COALESCE(@CustomerCode, N''))), N''), 25));
    DECLARE @Title VARCHAR(201) = CONVERT(VARCHAR(201), LEFT(NULLIF(LTRIM(RTRIM(COALESCE(@CustomerTitle, N''))), N''), 201));
    DECLARE @SetList NVARCHAR(MAX) = N'';

    IF @LogicalRef IS NULL OR @SqlTable IS NULL
        RETURN;

    IF @CustomerRef IS NOT NULL AND @TableName IN (N'dbo.LG_003_01_CSROLL', N'dbo.LG_003_01_CSTRANS')
       AND COL_LENGTH(@SqlTable, N'CARDREF') IS NOT NULL
        SET @SetList = @SetList + N', CARDREF = @CustomerRef';
    IF @CustomerRef IS NOT NULL AND COL_LENGTH(@SqlTable, N'CLIENTREF') IS NOT NULL
        SET @SetList = @SetList + N', CLIENTREF = @CustomerRef';
    IF @CustomerRef IS NOT NULL AND COL_LENGTH(@SqlTable, N'CLCARDREF') IS NOT NULL
        SET @SetList = @SetList + N', CLCARDREF = @CustomerRef';
    IF @CustomerRef IS NOT NULL AND COL_LENGTH(@SqlTable, N'CLREF') IS NOT NULL
        SET @SetList = @SetList + N', CLREF = @CustomerRef';
    IF @CustomerRef IS NOT NULL AND @TableName = N'dbo.LG_003_01_CSTRANS'
       AND COL_LENGTH(@SqlTable, N'CLACCREF') IS NOT NULL
        SET @SetList = @SetList + N', CLACCREF = @CustomerRef';

    IF @Code IS NOT NULL AND COL_LENGTH(@SqlTable, N'CLCODE') IS NOT NULL
        SET @SetList = @SetList + N', CLCODE = @Code';
    IF @Code IS NOT NULL AND COL_LENGTH(@SqlTable, N'CLIENTCODE') IS NOT NULL
        SET @SetList = @SetList + N', CLIENTCODE = @Code';
    IF @Code IS NOT NULL AND COL_LENGTH(@SqlTable, N'CUSTCODE') IS NOT NULL
        SET @SetList = @SetList + N', CUSTCODE = @Code';
    IF @Code IS NOT NULL AND COL_LENGTH(@SqlTable, N'CUSTOMERCODE') IS NOT NULL
        SET @SetList = @SetList + N', CUSTOMERCODE = @Code';

    IF @Title IS NOT NULL AND COL_LENGTH(@SqlTable, N'CLTITLE') IS NOT NULL
        SET @SetList = @SetList + N', CLTITLE = @Title';
    IF @Title IS NOT NULL AND COL_LENGTH(@SqlTable, N'CLIENTTITLE') IS NOT NULL
        SET @SetList = @SetList + N', CLIENTTITLE = @Title';
    IF @Title IS NOT NULL AND COL_LENGTH(@SqlTable, N'CUSTTITLE') IS NOT NULL
        SET @SetList = @SetList + N', CUSTTITLE = @Title';
    IF @Title IS NOT NULL AND COL_LENGTH(@SqlTable, N'CUSTOMERTITLE') IS NOT NULL
        SET @SetList = @SetList + N', CUSTOMERTITLE = @Title';
    IF @Title IS NOT NULL AND COL_LENGTH(@SqlTable, N'OWING') IS NOT NULL
        SET @SetList = @SetList + N', OWING = @Title';

    IF LEN(@SetList) > 0
    BEGIN
        DECLARE @Sql NVARCHAR(MAX) =
            N'UPDATE ' + @SqlTable + N' SET ' + STUFF(@SetList, 1, 2, N'') + N' WHERE LOGICALREF = @LogicalRef';

        EXEC sys.sp_executesql
            @Sql,
            N'@LogicalRef INT, @CustomerRef INT, @Code VARCHAR(25), @Title VARCHAR(201)',
            @LogicalRef = @LogicalRef,
            @CustomerRef = @CustomerRef,
            @Code = @Code,
            @Title = @Title;
    END;
END;
GO

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ApplyCustomerIdentityToLogoRow
    @TableName NVARCHAR(128),
    @LogicalRef INT,
    @CustomerRef INT
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @SqlTable NVARCHAR(128) = CASE
        WHEN @TableName = N'dbo.LG_003_01_CLFICHE' THEN N'dbo.LG_003_01_CLFICHE'
        WHEN @TableName = N'dbo.LG_003_01_CLFLINE' THEN N'dbo.LG_003_01_CLFLINE'
        WHEN @TableName = N'dbo.LG_003_01_BNFICHE' THEN N'dbo.LG_003_01_BNFICHE'
        WHEN @TableName = N'dbo.LG_003_01_BNFLINE' THEN N'dbo.LG_003_01_BNFLINE'
        WHEN @TableName = N'dbo.LG_003_01_INVOICE' THEN N'dbo.LG_003_01_INVOICE'
        WHEN @TableName = N'dbo.LG_003_01_STFICHE' THEN N'dbo.LG_003_01_STFICHE'
        WHEN @TableName = N'dbo.LG_003_01_STLINE' THEN N'dbo.LG_003_01_STLINE'
        ELSE NULL
    END;
    DECLARE @CustomerCode VARCHAR(25);
    DECLARE @CustomerTitle VARCHAR(201);
    DECLARE @SetList NVARCHAR(MAX) = N'';

    IF @LogicalRef IS NULL OR @CustomerRef IS NULL OR @SqlTable IS NULL
        RETURN;

    SELECT TOP 1
        @CustomerCode = CONVERT(VARCHAR(25), LEFT(CODE, 25)),
        @CustomerTitle = CONVERT(VARCHAR(201), LEFT(DEFINITION_, 201))
    FROM dbo.LG_003_CLCARD WITH (NOLOCK)
    WHERE LOGICALREF = @CustomerRef;

    IF @CustomerCode IS NULL AND @CustomerTitle IS NULL
        RETURN;

    IF COL_LENGTH(@SqlTable, N'CLIENTREF') IS NOT NULL
        SET @SetList += N', CLIENTREF = @CustomerRef';
    IF COL_LENGTH(@SqlTable, N'CARDREF') IS NOT NULL AND @TableName IN (N'dbo.LG_003_01_CLFICHE', N'dbo.LG_003_01_BNFICHE')
        SET @SetList += N', CARDREF = @CustomerRef';
    IF COL_LENGTH(@SqlTable, N'CLCARDREF') IS NOT NULL
        SET @SetList += N', CLCARDREF = @CustomerRef';
    IF COL_LENGTH(@SqlTable, N'CLREF') IS NOT NULL
        SET @SetList += N', CLREF = @CustomerRef';
    IF COL_LENGTH(@SqlTable, N'CLACCREF') IS NOT NULL
        SET @SetList += N', CLACCREF = @CustomerRef';

    IF @CustomerCode IS NOT NULL AND COL_LENGTH(@SqlTable, N'CLCODE') IS NOT NULL
        SET @SetList += N', CLCODE = @CustomerCode';
    IF @CustomerCode IS NOT NULL AND COL_LENGTH(@SqlTable, N'CLIENTCODE') IS NOT NULL
        SET @SetList += N', CLIENTCODE = @CustomerCode';
    IF @CustomerCode IS NOT NULL AND COL_LENGTH(@SqlTable, N'CUSTCODE') IS NOT NULL
        SET @SetList += N', CUSTCODE = @CustomerCode';
    IF @CustomerCode IS NOT NULL AND COL_LENGTH(@SqlTable, N'CUSTOMERCODE') IS NOT NULL
        SET @SetList += N', CUSTOMERCODE = @CustomerCode';

    IF @CustomerTitle IS NOT NULL AND COL_LENGTH(@SqlTable, N'CLTITLE') IS NOT NULL
        SET @SetList += N', CLTITLE = @CustomerTitle';
    IF @CustomerTitle IS NOT NULL AND COL_LENGTH(@SqlTable, N'CLIENTTITLE') IS NOT NULL
        SET @SetList += N', CLIENTTITLE = @CustomerTitle';
    IF @CustomerTitle IS NOT NULL AND COL_LENGTH(@SqlTable, N'CUSTTITLE') IS NOT NULL
        SET @SetList += N', CUSTTITLE = @CustomerTitle';
    IF @CustomerTitle IS NOT NULL AND COL_LENGTH(@SqlTable, N'CUSTOMERTITLE') IS NOT NULL
        SET @SetList += N', CUSTOMERTITLE = @CustomerTitle';
    IF @CustomerTitle IS NOT NULL AND COL_LENGTH(@SqlTable, N'DEFINITION_') IS NOT NULL AND @TableName <> N'dbo.LG_003_01_STLINE'
        SET @SetList += N', DEFINITION_ = ISNULL(NULLIF(DEFINITION_, ''''), @CustomerTitle)';

    IF LEN(@SetList) > 0
    BEGIN
        DECLARE @Sql NVARCHAR(MAX) =
            N'UPDATE ' + @SqlTable + N' SET ' + STUFF(@SetList, 1, 2, N'') + N' WHERE LOGICALREF = @LogicalRef';

        EXEC sys.sp_executesql
            @Sql,
            N'@LogicalRef INT, @CustomerRef INT, @CustomerCode VARCHAR(25), @CustomerTitle VARCHAR(201)',
            @LogicalRef = @LogicalRef,
            @CustomerRef = @CustomerRef,
            @CustomerCode = @CustomerCode,
            @CustomerTitle = @CustomerTitle;
    END;
END;
GO

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ApplyBankIdentityToLogoRow
    @TableName NVARCHAR(128),
    @LogicalRef INT,
    @BankRef INT,
    @BankAccountRef INT
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @SqlTable NVARCHAR(128) = CASE
        WHEN @TableName = N'dbo.LG_003_01_CLFICHE' THEN N'dbo.LG_003_01_CLFICHE'
        WHEN @TableName = N'dbo.LG_003_01_CLFLINE' THEN N'dbo.LG_003_01_CLFLINE'
        WHEN @TableName = N'dbo.LG_003_01_BNFICHE' THEN N'dbo.LG_003_01_BNFICHE'
        WHEN @TableName = N'dbo.LG_003_01_BNFLINE' THEN N'dbo.LG_003_01_BNFLINE'
        ELSE NULL
    END;
    DECLARE @BankCode VARCHAR(25);
    DECLARE @BankName VARCHAR(101);
    DECLARE @BankAccountCode VARCHAR(25);
    DECLARE @BankAccountName VARCHAR(101);
    DECLARE @SetList NVARCHAR(MAX) = N'';

    IF @LogicalRef IS NULL OR @SqlTable IS NULL
        RETURN;

    IF @BankRef IS NOT NULL
    BEGIN
        SELECT TOP 1
            @BankCode = CONVERT(VARCHAR(25), LEFT(CODE, 25)),
            @BankName = CONVERT(VARCHAR(101), LEFT(DEFINITION_, 101))
        FROM dbo.LG_003_BNCARD WITH (NOLOCK)
        WHERE LOGICALREF = @BankRef;
    END;

    IF @BankAccountRef IS NOT NULL
    BEGIN
        SELECT TOP 1
            @BankAccountCode = CONVERT(VARCHAR(25), LEFT(CODE, 25)),
            @BankAccountName = CONVERT(VARCHAR(101), LEFT(DEFINITION_, 101))
        FROM dbo.LG_003_BANKACC WITH (NOLOCK)
        WHERE LOGICALREF = @BankAccountRef;
    END;

    IF @BankRef IS NOT NULL AND COL_LENGTH(@SqlTable, N'BANKREF') IS NOT NULL
        SET @SetList += N', BANKREF = @BankRef';
    IF @BankRef IS NOT NULL AND COL_LENGTH(@SqlTable, N'BNCREREF') IS NOT NULL
        SET @SetList += N', BNCREREF = @BankRef';
    IF @BankAccountRef IS NOT NULL AND COL_LENGTH(@SqlTable, N'BNACCREF') IS NOT NULL
        SET @SetList += N', BNACCREF = @BankAccountRef';
    IF @BankAccountRef IS NOT NULL AND COL_LENGTH(@SqlTable, N'BNACCOUNTREF') IS NOT NULL
        SET @SetList += N', BNACCOUNTREF = @BankAccountRef';
    IF @BankAccountRef IS NOT NULL AND COL_LENGTH(@SqlTable, N'BANKACCREF') IS NOT NULL
        SET @SetList += N', BANKACCREF = @BankAccountRef';
    IF @BankAccountRef IS NOT NULL AND COL_LENGTH(@SqlTable, N'BANKACCOUNTREF') IS NOT NULL
        SET @SetList += N', BANKACCOUNTREF = @BankAccountRef';

    IF @BankCode IS NOT NULL AND COL_LENGTH(@SqlTable, N'BANKCODE') IS NOT NULL
        SET @SetList += N', BANKCODE = @BankCode';
    IF @BankName IS NOT NULL AND COL_LENGTH(@SqlTable, N'BANKNAME') IS NOT NULL
        SET @SetList += N', BANKNAME = @BankName';
    IF @BankAccountCode IS NOT NULL AND COL_LENGTH(@SqlTable, N'BNACCCODE') IS NOT NULL
        SET @SetList += N', BNACCCODE = @BankAccountCode';
    IF @BankAccountCode IS NOT NULL AND COL_LENGTH(@SqlTable, N'BANKACCCODE') IS NOT NULL
        SET @SetList += N', BANKACCCODE = @BankAccountCode';
    IF @BankAccountName IS NOT NULL AND COL_LENGTH(@SqlTable, N'BNACCDEFINITION_') IS NOT NULL
        SET @SetList += N', BNACCDEFINITION_ = @BankAccountName';
    IF @BankAccountName IS NOT NULL AND COL_LENGTH(@SqlTable, N'BANKACCDEFINITION_') IS NOT NULL
        SET @SetList += N', BANKACCDEFINITION_ = @BankAccountName';

    IF LEN(@SetList) > 0
    BEGIN
        DECLARE @Sql NVARCHAR(MAX) =
            N'UPDATE ' + @SqlTable + N' SET ' + STUFF(@SetList, 1, 2, N'') + N' WHERE LOGICALREF = @LogicalRef';

        EXEC sys.sp_executesql
            @Sql,
            N'@LogicalRef INT, @BankRef INT, @BankAccountRef INT, @BankCode VARCHAR(25), @BankName VARCHAR(101), @BankAccountCode VARCHAR(25), @BankAccountName VARCHAR(101)',
            @LogicalRef = @LogicalRef,
            @BankRef = @BankRef,
            @BankAccountRef = @BankAccountRef,
            @BankCode = @BankCode,
            @BankName = @BankName,
            @BankAccountCode = @BankAccountCode,
            @BankAccountName = @BankAccountName;
    END;
END;
GO

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ApplySalespersonToLogoRow
    @TableName NVARCHAR(128),
    @LogicalRef INT,
    @SalespersonCode NVARCHAR(64)
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @Code VARCHAR(25) = CONVERT(VARCHAR(25), LEFT(NULLIF(LTRIM(RTRIM(COALESCE(@SalespersonCode, N''))), N''), 25));
    DECLARE @Sql NVARCHAR(MAX);
    DECLARE @SalespersonRef INT = NULL;
    DECLARE @SalespersonTable NVARCHAR(256) = NULL;
    DECLARE @SalespersonObject NVARCHAR(256) = NULL;
    DECLARE @CashboxSalespersonName VARCHAR(51) = NULL;
    DECLARE @SqlTable NVARCHAR(128) = CASE
        WHEN @TableName = N'dbo.LG_003_01_INVOICE' THEN N'dbo.LG_003_01_INVOICE'
        WHEN @TableName = N'dbo.LG_003_01_STFICHE' THEN N'dbo.LG_003_01_STFICHE'
        WHEN @TableName = N'dbo.LG_003_01_STLINE' THEN N'dbo.LG_003_01_STLINE'
        WHEN @TableName = N'dbo.LG_003_01_KSLINES' THEN N'dbo.LG_003_01_KSLINES'
        WHEN @TableName = N'dbo.LG_003_01_CLFICHE' THEN N'dbo.LG_003_01_CLFICHE'
        WHEN @TableName = N'dbo.LG_003_01_CLFLINE' THEN N'dbo.LG_003_01_CLFLINE'
        WHEN @TableName = N'dbo.LG_003_01_BNFICHE' THEN N'dbo.LG_003_01_BNFICHE'
        WHEN @TableName = N'dbo.LG_003_01_BNFLINE' THEN N'dbo.LG_003_01_BNFLINE'
        WHEN @TableName = N'dbo.LG_003_01_CSROLL' THEN N'dbo.LG_003_01_CSROLL'
        WHEN @TableName = N'dbo.LG_003_01_CSTRANS' THEN N'dbo.LG_003_01_CSTRANS'
        ELSE NULL
    END;

    IF @LogicalRef IS NULL OR @Code IS NULL OR @SqlTable IS NULL
        RETURN;

    SELECT TOP 1
        @SalespersonTable = QUOTENAME(SCHEMA_NAME(t.schema_id)) + N'.' + QUOTENAME(t.name),
        @SalespersonObject = SCHEMA_NAME(t.schema_id) + N'.' + t.name
    FROM sys.tables AS t
    WHERE t.name IN (N'LG_003_SLSMAN', N'LG_SLSMAN')
      AND EXISTS (SELECT 1 FROM sys.columns AS c WHERE c.object_id = t.object_id AND c.name = N'LOGICALREF')
      AND EXISTS (SELECT 1 FROM sys.columns AS c WHERE c.object_id = t.object_id AND c.name = N'CODE')
    ORDER BY CASE t.name WHEN N'LG_003_SLSMAN' THEN 0 WHEN N'LG_SLSMAN' THEN 1 ELSE 2 END;

    IF @SalespersonTable IS NULL
    BEGIN
        SELECT TOP 1
            @SalespersonTable = QUOTENAME(SCHEMA_NAME(t.schema_id)) + N'.' + QUOTENAME(t.name),
            @SalespersonObject = SCHEMA_NAME(t.schema_id) + N'.' + t.name
        FROM sys.tables AS t
        WHERE t.name LIKE N'%SLSMAN%'
          AND EXISTS (SELECT 1 FROM sys.columns AS c WHERE c.object_id = t.object_id AND c.name = N'LOGICALREF')
          AND EXISTS (SELECT 1 FROM sys.columns AS c WHERE c.object_id = t.object_id AND c.name = N'CODE')
        ORDER BY CASE WHEN t.name LIKE N'LG[_]%' THEN 0 ELSE 1 END, t.name;
    END;

    IF @TableName = N'dbo.LG_003_01_KSLINES'
    BEGIN
        SELECT TOP 1
            @CashboxSalespersonName = CONVERT(VARCHAR(51), LEFT(
                LTRIM(RTRIM(REPLACE(REPLACE(ks.NAME, N' KASASI', N''), N'KASASI', N''))),
                51
            ))
        FROM dbo.LG_003_01_KSLINES AS k WITH (NOLOCK)
        INNER JOIN dbo.LG_003_KSCARD AS ks WITH (NOLOCK)
            ON ks.LOGICALREF = k.CARDREF
        WHERE k.LOGICALREF = @LogicalRef;
    END;

    IF @SalespersonTable IS NOT NULL
    BEGIN
        SET @Sql = N'
            SELECT TOP 1 @ResolvedRef = LOGICALREF
            FROM ' + @SalespersonTable + N' WITH (NOLOCK)
            WHERE (
                    CODE = @Code
                    OR REPLACE(REPLACE(REPLACE(UPPER(CODE), ''.'', ''''), '' '', ''''), ''-'', '''')
                       = REPLACE(REPLACE(REPLACE(UPPER(@Code), ''.'', ''''), '' '', ''''), ''-'', '''')
                )
              AND ISNULL(ACTIVE, 0) = 0
            ORDER BY LOGICALREF';
        EXEC sys.sp_executesql
            @Sql,
            N'@Code VARCHAR(25), @ResolvedRef INT OUTPUT',
            @Code = @Code,
            @ResolvedRef = @SalespersonRef OUTPUT;

        IF @SalespersonRef IS NULL AND COL_LENGTH(@SalespersonObject, N'DEFINITION_') IS NOT NULL
        BEGIN
            SET @Sql = N'
                SELECT TOP 1 @ResolvedRef = LOGICALREF
                FROM ' + @SalespersonTable + N' WITH (NOLOCK)
                WHERE (
                        DEFINITION_ = @Code
                        OR REPLACE(REPLACE(REPLACE(UPPER(DEFINITION_), ''.'', ''''), '' '', ''''), ''-'', '''')
                           = REPLACE(REPLACE(REPLACE(UPPER(@Code), ''.'', ''''), '' '', ''''), ''-'', '''')
                    )
                  AND ISNULL(ACTIVE, 0) = 0
                ORDER BY LOGICALREF';
            EXEC sys.sp_executesql
                @Sql,
                N'@Code VARCHAR(25), @ResolvedRef INT OUTPUT',
                @Code = @Code,
                @ResolvedRef = @SalespersonRef OUTPUT;
        END;

        IF @SalespersonRef IS NULL AND @CashboxSalespersonName IS NOT NULL AND COL_LENGTH(@SalespersonObject, N'DEFINITION_') IS NOT NULL
        BEGIN
            SET @Sql = N'
                SELECT TOP 1 @ResolvedRef = LOGICALREF
                FROM ' + @SalespersonTable + N' WITH (NOLOCK)
                WHERE (
                        DEFINITION_ = @CashboxName
                        OR REPLACE(REPLACE(REPLACE(UPPER(DEFINITION_), ''.'', ''''), '' '', ''''), ''-'', '''')
                           = REPLACE(REPLACE(REPLACE(UPPER(@CashboxName), ''.'', ''''), '' '', ''''), ''-'', '''')
                    )
                  AND ISNULL(ACTIVE, 0) = 0
                ORDER BY LOGICALREF';
            EXEC sys.sp_executesql
                @Sql,
                N'@CashboxName VARCHAR(51), @ResolvedRef INT OUTPUT',
                @CashboxName = @CashboxSalespersonName,
                @ResolvedRef = @SalespersonRef OUTPUT;
        END;
    END;

    IF @SalespersonRef IS NOT NULL AND COL_LENGTH(@SqlTable, N'SALESMANREF') IS NOT NULL
    BEGIN
        SET @Sql = N'UPDATE ' + @SqlTable + N' SET SALESMANREF = @SalespersonRef WHERE LOGICALREF = @LogicalRef';
        EXEC sys.sp_executesql
            @Sql,
            N'@SalespersonRef INT, @LogicalRef INT',
            @SalespersonRef = @SalespersonRef,
            @LogicalRef = @LogicalRef;
    END;

    IF COL_LENGTH(@SqlTable, N'SALESMANCODE') IS NOT NULL
    BEGIN
        SET @Sql = N'UPDATE ' + @SqlTable + N' SET SALESMANCODE = @Code WHERE LOGICALREF = @LogicalRef';
        EXEC sys.sp_executesql
            @Sql,
            N'@Code VARCHAR(25), @LogicalRef INT',
            @Code = @Code,
            @LogicalRef = @LogicalRef;
    END;

    IF COL_LENGTH(@SqlTable, N'SLSMANCODE') IS NOT NULL
    BEGIN
        SET @Sql = N'UPDATE ' + @SqlTable + N' SET SLSMANCODE = @Code WHERE LOGICALREF = @LogicalRef';
        EXEC sys.sp_executesql
            @Sql,
            N'@Code VARCHAR(25), @LogicalRef INT',
            @Code = @Code,
            @LogicalRef = @LogicalRef;
    END;

    IF COL_LENGTH(@SqlTable, N'SLSMAN_CODE') IS NOT NULL
    BEGIN
        SET @Sql = N'UPDATE ' + @SqlTable + N' SET SLSMAN_CODE = @Code WHERE LOGICALREF = @LogicalRef';
        EXEC sys.sp_executesql
            @Sql,
            N'@Code VARCHAR(25), @LogicalRef INT',
            @Code = @Code,
            @LogicalRef = @LogicalRef;
    END;

    IF COL_LENGTH(@SqlTable, N'SALESMAN_CODE') IS NOT NULL
    BEGIN
        SET @Sql = N'UPDATE ' + @SqlTable + N' SET SALESMAN_CODE = @Code WHERE LOGICALREF = @LogicalRef';
        EXEC sys.sp_executesql
            @Sql,
            N'@Code VARCHAR(25), @LogicalRef INT',
            @Code = @Code,
            @LogicalRef = @LogicalRef;
    END;
END;
GO

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ApplyCashboxInSign
    @KslinesRef INT
AS
BEGIN
    SET NOCOUNT ON;

    IF @KslinesRef IS NULL
        RETURN;

    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'SIGN') IS NOT NULL
    BEGIN
        EXEC sys.sp_executesql
            N'UPDATE dbo.LG_003_01_KSLINES SET SIGN = 0 WHERE LOGICALREF = @KslinesRef',
            N'@KslinesRef INT',
            @KslinesRef = @KslinesRef;
    END;
END;
GO

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ApplyCashboxLocalCurrencyTotals
    @KslinesRef INT
AS
BEGIN
    SET NOCOUNT ON;

    IF @KslinesRef IS NULL
        RETURN;

    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'TRCURR') IS NOT NULL
       AND COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'TRRATE') IS NOT NULL
       AND COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'TRNET') IS NOT NULL
       AND COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'REPORTRATE') IS NOT NULL
       AND COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'REPORTNET') IS NOT NULL
    BEGIN
        EXEC sys.sp_executesql
            N'UPDATE dbo.LG_003_01_KSLINES
                 SET TRCURR = ISNULL(TRCURR, 0),
                     TRRATE = CASE WHEN ISNULL(TRRATE, 0) = 0 THEN 1 ELSE TRRATE END,
                     TRNET = CASE WHEN ISNULL(TRNET, 0) = 0 THEN ISNULL(AMOUNT, 0) ELSE TRNET END,
                     REPORTRATE = CASE WHEN ISNULL(REPORTRATE, 0) = 0 THEN 1 ELSE REPORTRATE END,
                     REPORTNET = CASE WHEN ISNULL(REPORTNET, 0) = 0 THEN ISNULL(AMOUNT, 0) ELSE REPORTNET END
               WHERE LOGICALREF = @KslinesRef',
            N'@KslinesRef INT',
            @KslinesRef = @KslinesRef;
    END;
END;
GO

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ApplyCashboxLogoDefaults
    @KslinesRef INT
AS
BEGIN
    SET NOCOUNT ON;

    IF @KslinesRef IS NULL
        RETURN;

    DECLARE @SetList NVARCHAR(MAX) = N'';

    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'ACCREF') IS NOT NULL
        SET @SetList = @SetList + N', ACCREF = ISNULL(ACCREF, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'CENTERREF') IS NOT NULL
        SET @SetList = @SetList + N', CENTERREF = ISNULL(CENTERREF, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'CASHACCREF') IS NOT NULL
        SET @SetList = @SetList + N', CASHACCREF = ISNULL(CASHACCREF, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'CASHCENREF') IS NOT NULL
        SET @SetList = @SetList + N', CASHCENREF = ISNULL(CASHCENREF, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'ACCFICHEREF') IS NOT NULL
        SET @SetList = @SetList + N', ACCFICHEREF = ISNULL(ACCFICHEREF, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'ACCOUNTED') IS NOT NULL
        SET @SetList = @SetList + N', ACCOUNTED = ISNULL(ACCOUNTED, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'REFLECTED') IS NOT NULL
        SET @SetList = @SetList + N', REFLECTED = ISNULL(REFLECTED, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'STATUS') IS NOT NULL
        SET @SetList = @SetList + N', STATUS = ISNULL(STATUS, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'AFFECTRISK') IS NOT NULL
        SET @SetList = @SetList + N', AFFECTRISK = ISNULL(AFFECTRISK, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'BRANCH') IS NOT NULL
        SET @SetList = @SetList + N', BRANCH = ISNULL(BRANCH, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_KSLINES', N'DEPARTMENT') IS NOT NULL
        SET @SetList = @SetList + N', DEPARTMENT = ISNULL(DEPARTMENT, 0)';

    IF LEN(@SetList) > 0
    BEGIN
        DECLARE @Sql NVARCHAR(MAX) =
            N'UPDATE dbo.LG_003_01_KSLINES SET ' + STUFF(@SetList, 1, 2, N'') + N' WHERE LOGICALREF = @KslinesRef';

        EXEC sys.sp_executesql
            @Sql,
            N'@KslinesRef INT',
            @KslinesRef = @KslinesRef;
    END;
END;
GO

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ApplyCustomerLedgerLogoDefaults
    @ClflineRef INT,
    @LedgerDate DATE
AS
BEGIN
    SET NOCOUNT ON;

    IF @ClflineRef IS NULL
        RETURN;

    DECLARE @SetList NVARCHAR(MAX) = N'';

    IF COL_LENGTH(N'dbo.LG_003_01_CLFLINE', N'STATUS') IS NOT NULL
        SET @SetList = @SetList + N', STATUS = ISNULL(STATUS, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_CLFLINE', N'CANCELLED') IS NOT NULL
        SET @SetList = @SetList + N', CANCELLED = ISNULL(CANCELLED, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_CLFLINE', N'MONTH_') IS NOT NULL
        SET @SetList = @SetList + N', MONTH_ = ISNULL(MONTH_, MONTH(COALESCE(DATE_, @LedgerDate, GETDATE())))';
    IF COL_LENGTH(N'dbo.LG_003_01_CLFLINE', N'YEAR_') IS NOT NULL
        SET @SetList = @SetList + N', YEAR_ = ISNULL(YEAR_, YEAR(COALESCE(DATE_, @LedgerDate, GETDATE())))';
    IF COL_LENGTH(N'dbo.LG_003_01_CLFLINE', N'BRANCH') IS NOT NULL
        SET @SetList = @SetList + N', BRANCH = ISNULL(BRANCH, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_CLFLINE', N'DEPARTMENT') IS NOT NULL
        SET @SetList = @SetList + N', DEPARTMENT = ISNULL(DEPARTMENT, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_CLFLINE', N'PAIDINCASH') IS NOT NULL
        SET @SetList = @SetList + N', PAIDINCASH = ISNULL(PAIDINCASH, 0)';
    IF COL_LENGTH(N'dbo.LG_003_01_CLFLINE', N'TRNET') IS NOT NULL
        SET @SetList = @SetList + N', TRNET = ISNULL(TRNET, AMOUNT)';
    IF COL_LENGTH(N'dbo.LG_003_01_CLFLINE', N'REPORTNET') IS NOT NULL
        SET @SetList = @SetList + N', REPORTNET = ISNULL(REPORTNET, ISNULL(TRNET, AMOUNT))';

    IF LEN(@SetList) > 0
    BEGIN
        DECLARE @Sql NVARCHAR(MAX) =
            N'UPDATE dbo.LG_003_01_CLFLINE SET ' + STUFF(@SetList, 1, 2, N'') + N' WHERE LOGICALREF = @ClflineRef';

        EXEC sys.sp_executesql
            @Sql,
            N'@ClflineRef INT, @LedgerDate DATE',
            @ClflineRef = @ClflineRef,
            @LedgerDate = @LedgerDate;
    END;
END;
GO

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_ApplyLogoEditTimestamp
    @TableName NVARCHAR(128),
    @LogicalRef INT,
    @ModifiedAt DATETIME
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @Sql NVARCHAR(MAX);
    DECLARE @SqlTable NVARCHAR(128) = CASE
        WHEN @TableName = N'dbo.LG_003_01_KSLINES' THEN N'dbo.LG_003_01_KSLINES'
        WHEN @TableName = N'dbo.LG_003_01_CLFLINE' THEN N'dbo.LG_003_01_CLFLINE'
        WHEN @TableName = N'dbo.LG_003_01_BNFLINE' THEN N'dbo.LG_003_01_BNFLINE'
        WHEN @TableName = N'dbo.LG_003_01_CSTRANS' THEN N'dbo.LG_003_01_CSTRANS'
        ELSE NULL
    END;

    IF @LogicalRef IS NULL OR @SqlTable IS NULL
        RETURN;

    DECLARE @LogoTime INT =
        (DATEPART(HOUR, @ModifiedAt) * 16777216)
        + (DATEPART(MINUTE, @ModifiedAt) * 65536)
        + (DATEPART(SECOND, @ModifiedAt) * 256);

    IF COL_LENGTH(@SqlTable, N'CAPIBLOCK_MODIFIEDBY') IS NOT NULL
       AND COL_LENGTH(@SqlTable, N'CAPIBLOCK_MODIFIEDDATE') IS NOT NULL
       AND COL_LENGTH(@SqlTable, N'CAPIBLOCK_MODIFIEDHOUR') IS NOT NULL
       AND COL_LENGTH(@SqlTable, N'CAPIBLOCK_MODIFIEDMIN') IS NOT NULL
       AND COL_LENGTH(@SqlTable, N'CAPIBLOCK_MODIFIEDSEC') IS NOT NULL
    BEGIN
        SET @Sql = N'
            UPDATE ' + @SqlTable + N'
               SET CAPIBLOCK_MODIFIEDBY = 1,
                   CAPIBLOCK_MODIFIEDDATE = @ModifiedAt,
                   CAPIBLOCK_MODIFIEDHOUR = DATEPART(HOUR, @ModifiedAt),
                   CAPIBLOCK_MODIFIEDMIN = DATEPART(MINUTE, @ModifiedAt),
                   CAPIBLOCK_MODIFIEDSEC = DATEPART(SECOND, @ModifiedAt)
             WHERE LOGICALREF = @LogicalRef';
        EXEC sys.sp_executesql
            @Sql,
            N'@ModifiedAt DATETIME, @LogicalRef INT',
            @ModifiedAt = @ModifiedAt,
            @LogicalRef = @LogicalRef;
    END;

    IF COL_LENGTH(@SqlTable, N'DOCDATE') IS NOT NULL
    BEGIN
        SET @Sql = N'UPDATE ' + @SqlTable + N' SET DOCDATE = @ModifiedAt WHERE LOGICALREF = @LogicalRef';
        EXEC sys.sp_executesql
            @Sql,
            N'@ModifiedAt DATETIME, @LogicalRef INT',
            @ModifiedAt = @ModifiedAt,
            @LogicalRef = @LogicalRef;
    END;

    IF COL_LENGTH(@SqlTable, N'TIME_') IS NOT NULL
    BEGIN
        SET @Sql = N'UPDATE ' + @SqlTable + N' SET TIME_ = @LogoTime WHERE LOGICALREF = @LogicalRef';
        EXEC sys.sp_executesql
            @Sql,
            N'@LogoTime INT, @LogicalRef INT',
            @LogoTime = @LogoTime,
            @LogicalRef = @LogicalRef;
    END;
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
    DECLARE @FactoryCardTrcode SMALLINT = 5;
    DECLARE @SalespersonCode VARCHAR(25) = CONVERT(VARCHAR(25), LEFT(COALESCE(
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.logo.salesperson_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.logo_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.name'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.username'), N'')
    ), 25));
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
        @FicheNo, @CollectionDate, @Docode, @FactoryCardTrcode, CONVERT(VARCHAR(51), LEFT(@LineExp, 51)),
        CONVERT(FLOAT, @Amount), CONVERT(FLOAT, @Amount), CONVERT(FLOAT, @Amount),
        CONVERT(FLOAT, @Amount), 1, @Now, @Hour, @Minute, @Second, 0, 0, @Hour, @Minute
    );
    SET @FicheRef = SCOPE_IDENTITY();
    EXEC dbo.PowersaB2B_ApplyCustomerIdentityToLogoRow N'dbo.LG_003_01_CLFICHE', @FicheRef, @CustomerRef;
    EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_CLFICHE', @FicheRef, @SalespersonCode;

    INSERT INTO dbo.LG_003_01_CLFLINE (
        CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, TRANNO, DOCODE,
        LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET, REPORTRATE,
        REPORTNET, CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
        CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC
    )
    VALUES (
        @CustomerRef, @FicheRef, @CollectionDate, 5, @FactoryCardTrcode, @FicheNo, @Docode,
        @LineExp, 1, CONVERT(FLOAT, @Amount), 0, 1, CONVERT(FLOAT, @Amount), 1,
        CONVERT(FLOAT, @Amount), 0, 1, @Now, @Hour, @Minute, @Second
    );
    SET @CustomerLineRef = SCOPE_IDENTITY();
    EXEC dbo.PowersaB2B_ApplyCustomerLedgerLogoDefaults @CustomerLineRef, @CollectionDate;
    EXEC dbo.PowersaB2B_ApplyCustomerIdentityToLogoRow N'dbo.LG_003_01_CLFLINE', @CustomerLineRef, @CustomerRef;
    EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_CLFLINE', @CustomerLineRef, @SalespersonCode;

    INSERT INTO dbo.LG_003_01_CLFLINE (
        CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, TRANNO, DOCODE,
        LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET, REPORTRATE,
        REPORTNET, CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
        CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC
    )
    VALUES (
        @FactoryRef, @FicheRef, @CollectionDate, 5, @FactoryCardTrcode, @FicheNo, @Docode,
        @LineExp, 0, CONVERT(FLOAT, @Amount), 0, 1, CONVERT(FLOAT, @Amount), 1,
        CONVERT(FLOAT, @Amount), 0, 1, @Now, @Hour, @Minute, @Second
    );
    SET @FactoryLineRef = SCOPE_IDENTITY();
    EXEC dbo.PowersaB2B_ApplyCustomerLedgerLogoDefaults @FactoryLineRef, @CollectionDate;
    EXEC dbo.PowersaB2B_ApplyCustomerIdentityToLogoRow N'dbo.LG_003_01_CLFLINE', @FactoryLineRef, @FactoryRef;
    EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_CLFLINE', @FactoryLineRef, @SalespersonCode;

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

    DECLARE @BankCode VARCHAR(25) = CONVERT(VARCHAR(25), LEFT(COALESCE(
        NULLIF(JSON_VALUE(@PayloadJson, '$.reference_fields.bank_logo_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.reference_fields.bank_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.logo.bank_code'), N'')
    ), 25));
    DECLARE @BankRef INT;
    DECLARE @BankAccountRef INT;
    DECLARE @BankFicheRef INT;
    DECLARE @BankLineRef INT;
    DECLARE @ClientLineRef INT;
    DECLARE @FicheNo VARCHAR(17) = CONVERT(VARCHAR(17), RIGHT(REPLICATE('0', 17) + @ExportKey, 17));
    DECLARE @Docode VARCHAR(33) = CONVERT(VARCHAR(33), LEFT(COALESCE(NULLIF(@ReferenceNo, N''), @ExportKey), 33));
    DECLARE @LineExp VARCHAR(201) = CONVERT(VARCHAR(201), LEFT(COALESCE(NULLIF(@Note, N''), N'Powersa B2B banka tahsilatı'), 201));
    DECLARE @BankClientTrcode SMALLINT = 20;
    DECLARE @BankLineTranstype SMALLINT = 1;
    DECLARE @BankLineTrcode SMALLINT = 1;
    DECLARE @BankProcessType SMALLINT = 2;
    DECLARE @SalespersonCode VARCHAR(25) = CONVERT(VARCHAR(25), LEFT(COALESCE(
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.logo.salesperson_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.logo_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.name'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.username'), N'')
    ), 25));
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
    EXEC dbo.PowersaB2B_ApplyCustomerIdentityToLogoRow N'dbo.LG_003_01_BNFICHE', @BankFicheRef, @CustomerRef;
    EXEC dbo.PowersaB2B_ApplyBankIdentityToLogoRow N'dbo.LG_003_01_BNFICHE', @BankFicheRef, @BankRef, @BankAccountRef;
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
        @BankRef, @BankAccountRef, @CustomerRef, @BankFicheRef, @BankLineTranstype, @CollectionDate,
        0, @BankLineTrcode, 7, 1, @FicheNo, @Docode, @LineExp,
        0, CONVERT(FLOAT, @Amount), 1, CONVERT(FLOAT, @Amount), 1, CONVERT(FLOAT, @Amount),
        @BankProcessType, @BankProcessType,
        0, 1, @Now, @Hour, @Minute, @Second
    );
    SET @BankLineRef = SCOPE_IDENTITY();
    EXEC dbo.PowersaB2B_ApplyCustomerIdentityToLogoRow N'dbo.LG_003_01_BNFLINE', @BankLineRef, @CustomerRef;
    EXEC dbo.PowersaB2B_ApplyBankIdentityToLogoRow N'dbo.LG_003_01_BNFLINE', @BankLineRef, @BankRef, @BankAccountRef;
    EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_BNFLINE', @BankLineRef, @SalespersonCode;

    INSERT INTO dbo.LG_003_01_CLFLINE (
        CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, TRANNO, DOCODE,
        LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET, REPORTRATE,
        REPORTNET, CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
        CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC
    )
    VALUES (
        @CustomerRef, @BankLineRef, @CollectionDate, 7, @BankClientTrcode, @FicheNo, @Docode,
        @LineExp, 1, CONVERT(FLOAT, @Amount), 0, 1, CONVERT(FLOAT, @Amount), 1,
        CONVERT(FLOAT, @Amount), 0, 1, @Now, @Hour, @Minute, @Second
    );
    SET @ClientLineRef = SCOPE_IDENTITY();
    EXEC dbo.PowersaB2B_ApplyCustomerLedgerLogoDefaults @ClientLineRef, @CollectionDate;
    EXEC dbo.PowersaB2B_ApplyCustomerIdentityToLogoRow N'dbo.LG_003_01_CLFLINE', @ClientLineRef, @CustomerRef;
    EXEC dbo.PowersaB2B_ApplyBankIdentityToLogoRow N'dbo.LG_003_01_CLFLINE', @ClientLineRef, @BankRef, @BankAccountRef;
    EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_CLFLINE', @ClientLineRef, @SalespersonCode;

    SET @ExternalRef = CONCAT(N'BNFLINE-', @BankLineRef, N'-CLFLINE-', @ClientLineRef);
END;
GO

CREATE OR ALTER PROCEDURE dbo.PowersaB2B_WritePhysicalPosCollection
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

    DECLARE @BankCode VARCHAR(7) = CONVERT(VARCHAR(7), JSON_VALUE(@PayloadJson, '$.reference_fields.bank_logo_code'));
    DECLARE @BankRef INT;
    DECLARE @BankAccountRef INT;
    DECLARE @FicheRef INT;
    DECLARE @ClientLineRef INT;
    DECLARE @FicheNo VARCHAR(17) = CONVERT(VARCHAR(17), RIGHT(REPLICATE('0', 17) + @ExportKey, 17));
    DECLARE @Docode VARCHAR(33) = CONVERT(VARCHAR(33), LEFT(COALESCE(NULLIF(@ReferenceNo, N''), @ExportKey), 33));
    DECLARE @LineExp VARCHAR(251) = CONVERT(VARCHAR(251), LEFT(COALESCE(NULLIF(@Note, N''), N'Powersa B2B fiziksel POS tahsilatı'), 251));
    DECLARE @BankName VARCHAR(51) = CONVERT(VARCHAR(51), LEFT(COALESCE(JSON_VALUE(@PayloadJson, '$.reference_fields.bank_name'), JSON_VALUE(@PayloadJson, '$.reference_fields.pos_bank'), N''), 51));
    DECLARE @SalespersonCode VARCHAR(25) = CONVERT(VARCHAR(25), LEFT(COALESCE(
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.logo.salesperson_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.logo_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.name'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.username'), N'')
    ), 25));
    DECLARE @Now DATETIME = GETDATE();
    DECLARE @Hour SMALLINT = DATEPART(HOUR, @Now);
    DECLARE @Minute SMALLINT = DATEPART(MINUTE, @Now);
    DECLARE @Second SMALLINT = DATEPART(SECOND, @Now);

    IF @BankCode IS NULL
        THROW 51032, 'Physical POS Logo bank code is required for collection export.', 1;

    SELECT TOP 1 @BankRef = LOGICALREF
    FROM dbo.LG_003_BNCARD WITH (NOLOCK)
    WHERE CODE = @BankCode AND ISNULL(ACTIVE, 0) = 0;

    IF @BankRef IS NULL
        THROW 51033, 'Physical POS Logo bank card could not be resolved for collection export.', 1;

    SELECT TOP 1 @BankAccountRef = LOGICALREF
    FROM dbo.LG_003_BANKACC WITH (NOLOCK)
    WHERE BANKREF = @BankRef
      AND ISNULL(ACTIVE, 0) = 0
    ORDER BY
        CASE
            WHEN CODE LIKE N'%POS%' OR DEFINITION_ LIKE N'%POS%' THEN 0
            WHEN DEFINITION_ LIKE N'%KREDİ KARTI%' THEN 1
            ELSE 2
        END,
        CASE WHEN DEFINITION_ LIKE N'%POWERSA%' THEN 0 ELSE 1 END,
        LOGICALREF;

    IF @BankAccountRef IS NULL
        THROW 51034, 'Physical POS Logo bank account could not be resolved for collection export.', 1;

    INSERT INTO dbo.LG_003_01_CLFICHE (
        FICHENO, DATE_, DOCODE, TRCODE, GENEXP1,
        DEBIT, CREDIT, REPDEBIT, REPCREDIT, CAPIBLOCK_CREATEDBY,
        CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN,
        CAPIBLOCK_CREATEDSEC, ACCOUNTED, CANCELLED, BANKACCREF, BNACCREF,
        HOUR_, MINUTE_
    )
    VALUES (
        @FicheNo, @CollectionDate, @Docode, 70,
        CONVERT(VARCHAR(51), LEFT(CONCAT(@LineExp, N' ', COALESCE(@BankName, N'')), 51)),
        CONVERT(FLOAT, @Amount), CONVERT(FLOAT, @Amount),
        CONVERT(FLOAT, @Amount), CONVERT(FLOAT, @Amount),
        1, @Now, @Hour, @Minute, @Second, 0, 0,
        @BankAccountRef, @BankAccountRef, @Hour, @Minute
    );
    SET @FicheRef = SCOPE_IDENTITY();
    EXEC dbo.PowersaB2B_ApplyCustomerIdentityToLogoRow N'dbo.LG_003_01_CLFICHE', @FicheRef, @CustomerRef;
    EXEC dbo.PowersaB2B_ApplyBankIdentityToLogoRow N'dbo.LG_003_01_CLFICHE', @FicheRef, @BankRef, @BankAccountRef;
    EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_CLFICHE', @FicheRef, @SalespersonCode;

    INSERT INTO dbo.LG_003_01_CLFLINE (
        CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, TRANNO, DOCODE,
        LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET, REPORTRATE,
        REPORTNET, CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
        CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC,
        BANKACCREF, BNACCREF, BNLNTRCURR, BNLNTRRATE, BNLNTRNET
    )
    VALUES (
        @CustomerRef, @FicheRef, @CollectionDate, 5, 70, @FicheNo, @Docode,
        CONVERT(VARCHAR(251), LEFT(CONCAT(@LineExp, N' POS Banka: ', COALESCE(@BankName, N'')), 251)),
        1, CONVERT(FLOAT, @Amount), 0, 1, CONVERT(FLOAT, @Amount), 1,
        CONVERT(FLOAT, @Amount), 0, 1, @Now, @Hour, @Minute, @Second,
        @BankAccountRef, @BankAccountRef, 0, 1, CONVERT(FLOAT, @Amount)
    );
    SET @ClientLineRef = SCOPE_IDENTITY();
    EXEC dbo.PowersaB2B_ApplyCustomerLedgerLogoDefaults @ClientLineRef, @CollectionDate;
    EXEC dbo.PowersaB2B_ApplyCustomerIdentityToLogoRow N'dbo.LG_003_01_CLFLINE', @ClientLineRef, @CustomerRef;
    EXEC dbo.PowersaB2B_ApplyBankIdentityToLogoRow N'dbo.LG_003_01_CLFLINE', @ClientLineRef, @BankRef, @BankAccountRef;
    EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_CLFLINE', @ClientLineRef, @SalespersonCode;

    SET @ExternalRef = CONCAT(N'CLFICHE-', @FicheRef, N'-CLFLINE-', @ClientLineRef);
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

    DECLARE @NormalizedMethod NVARCHAR(32) = LOWER(LTRIM(RTRIM(COALESCE(@Method, N''))));
    DECLARE @IsNote BIT = CASE
        WHEN @NormalizedMethod IN (N'note', N'senet', N'promissory_note', N'promissory-note', N'promissorynote')
            THEN 1
        ELSE 0
    END;
    DECLARE @CardDoc SMALLINT = CASE WHEN @IsNote = 1 THEN 2 ELSE 1 END;
    DECLARE @RollCardMd SMALLINT = 5;
    DECLARE @RollTrcode SMALLINT = CASE WHEN @IsNote = 1 THEN 2 ELSE 1 END;
    DECLARE @ClientTrcode SMALLINT = CASE WHEN @IsNote = 1 THEN 62 ELSE 61 END;
    DECLARE @RawDocumentNo NVARCHAR(128) = COALESCE(
        NULLIF(JSON_VALUE(@PayloadJson, '$.reference_fields.check_no'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.reference_fields.note_no'), N''),
        NULLIF(@ReferenceNo, N''), @ExportKey
    );
    DECLARE @RawPortfolioNo NVARCHAR(128) = COALESCE(
        NULLIF(JSON_VALUE(@PayloadJson, '$.reference_fields.portfolio_no'), N''),
        NULLIF(@ExportKey, N''),
        @RawDocumentNo
    );
    -- Logo LG_003_01_CSCARD.PORTFOYNO is 16 characters in the live schema.
    -- Portfolio number is generated from the unique B2B collection identity.
    -- The user-entered cheque/note number remains the document serial number.
    DECLARE @PortfolioNo VARCHAR(16) = CONVERT(VARCHAR(16),
        CASE
            WHEN LEN(@RawPortfolioNo) <= 16 THEN @RawPortfolioNo
            ELSE CONCAT(
                LEFT(@RawPortfolioNo, 11),
                RIGHT('00000' + CONVERT(VARCHAR(20), ABS(CONVERT(BIGINT, CHECKSUM(@RawPortfolioNo)))), 5)
            )
        END
    );
    DECLARE @DocumentNo VARCHAR(16) = CONVERT(VARCHAR(16),
        CASE
            WHEN LEN(@RawDocumentNo) <= 16 THEN @RawDocumentNo
            ELSE CONCAT(
                LEFT(@RawDocumentNo, 11),
                RIGHT('00000' + CONVERT(VARCHAR(20), ABS(CONVERT(BIGINT, CHECKSUM(@RawDocumentNo)))), 5)
            )
        END
    );
    DECLARE @DueDate DATE = TRY_CONVERT(DATE, JSON_VALUE(@PayloadJson, '$.reference_fields.due_date'));
    DECLARE @BankName VARCHAR(51) = CONVERT(VARCHAR(51), LEFT(COALESCE(JSON_VALUE(@PayloadJson, '$.reference_fields.bank_name'), N''), 51));
    DECLARE @CustomerCode NVARCHAR(64);
    DECLARE @CustomerTitle NVARCHAR(201);
    DECLARE @SalespersonCode VARCHAR(25) = CONVERT(VARCHAR(25), LEFT(COALESCE(
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.logo.salesperson_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.logo_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.name'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.username'), N'')
    ), 25));
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

    SELECT TOP 1
        @CustomerCode = CONVERT(NVARCHAR(64), CODE),
        @CustomerTitle = CONVERT(NVARCHAR(201), LEFT(COALESCE(NULLIF(DEFINITION_, ''), CODE), 201))
    FROM dbo.LG_003_CLCARD WITH (NOLOCK)
    WHERE LOGICALREF = @CustomerRef;

    INSERT INTO dbo.LG_003_01_CSCARD (
        DOC, CURRSTAT, PORTFOYNO, SERINO, BANKNAME, DUEDATE, SETDATE,
        AMOUNT, TRCURR, TRRATE, TRNET, REPORTRATE, REPORTNET, INUSE,
        CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR,
        CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC, CANCELLED, NEWSERINO,
        STATUS
    )
    VALUES (
        @CardDoc, 1, @PortfolioNo, @DocumentNo,
        @BankName, @DueDate, @CollectionDate, CONVERT(FLOAT, @Amount), 0, 1,
        CONVERT(FLOAT, @Amount), 1, CONVERT(FLOAT, @Amount), 1,
        1, @Now, @Hour, @Minute, @Second, 0, @DocumentNo, 0
    );
    SET @CardRef = SCOPE_IDENTITY();
    EXEC dbo.PowersaB2B_ApplyCustomerTitleToCSCard @CardRef, @CustomerTitle, @CustomerCode;
    EXEC dbo.PowersaB2B_ApplyCustomerIdentityToCSRow N'dbo.LG_003_01_CSCARD', @CardRef, @CustomerRef, @CustomerCode, @CustomerTitle;

    INSERT INTO dbo.LG_003_01_CSROLL (
        CARDREF, ROLLNO, DATE_, TRCODE, CARDMD, PROCTYPE, DOCCNT, TOTAL,
        TRCURR, TRRATE, TRNET, REPORTRATE, REPORTNET, GENEXP1,
        CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE, CAPIBLOCK_CREATEDHOUR,
        CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC, CANCELLED, DOCODE
    )
    VALUES (
        @CustomerRef, @RollNo, @CollectionDate, @RollTrcode, @RollCardMd, 0, 1, CONVERT(FLOAT, @Amount),
        0, 1, CONVERT(FLOAT, @Amount), 1, CONVERT(FLOAT, @Amount),
        CONVERT(VARCHAR(51), LEFT(@LineExp, 51)), 1, @Now, @Hour, @Minute, @Second, 0,
        CONVERT(VARCHAR(33), LEFT(@DocumentNo, 33))
    );
    SET @RollRef = SCOPE_IDENTITY();
    EXEC dbo.PowersaB2B_ApplyCustomerIdentityToCSRow N'dbo.LG_003_01_CSROLL', @RollRef, @CustomerRef, @CustomerCode, @CustomerTitle;
    EXEC dbo.PowersaB2B_ApplyChequeNoteLogoDefaults N'dbo.LG_003_01_CSROLL', @RollRef;
    EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_CSROLL', @RollRef, @SalespersonCode;

    INSERT INTO dbo.LG_003_01_CSTRANS (
        DATE_, CSREF, ROLLREF, TRCODE, STATUS, CARDMD, CARDREF, STATNO,
        LINENO_, FROMCASH, CANCELLED
    )
    VALUES (
        @CollectionDate, @CardRef, @RollRef, @RollTrcode, 1, @RollCardMd, @CustomerRef, 1,
        1, 0, 0
    );
    SET @TransRef = SCOPE_IDENTITY();
    EXEC dbo.PowersaB2B_ApplyCustomerIdentityToCSRow N'dbo.LG_003_01_CSTRANS', @TransRef, @CustomerRef, @CustomerCode, @CustomerTitle;
    EXEC dbo.PowersaB2B_ApplyChequeNoteLogoDefaults N'dbo.LG_003_01_CSTRANS', @TransRef;
    EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_CSTRANS', @TransRef, @SalespersonCode;

    INSERT INTO dbo.LG_003_01_CLFLINE (
        CLIENTREF, SOURCEFREF, DATE_, MODULENR, TRCODE, TRANNO, DOCODE,
        LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET, REPORTRATE,
        REPORTNET, CANCELLED, CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
        CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC
    )
    VALUES (
        @CustomerRef, @TransRef, @CollectionDate, 6, @ClientTrcode, @RollNo, @DocumentNo,
        @LineExp, 1, CONVERT(FLOAT, @Amount), 0, 1, CONVERT(FLOAT, @Amount), 1,
        CONVERT(FLOAT, @Amount), 0, 1, @Now, @Hour, @Minute, @Second
    );
    SET @ClientLineRef = SCOPE_IDENTITY();
    EXEC dbo.PowersaB2B_ApplyCustomerLedgerLogoDefaults @ClientLineRef, @CollectionDate;

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
    DECLARE @NormalizedMethod NVARCHAR(32) = LOWER(LTRIM(RTRIM(COALESCE(@Method, N''))));
    DECLARE @ClTrcode SMALLINT = CASE
        WHEN @NormalizedMethod IN (N'note', N'senet', N'promissory_note', N'promissory-note', N'promissorynote') THEN 62
        WHEN @NormalizedMethod IN (N'check', N'cheque', N'cek', N'çek') THEN 61
        ELSE 1
    END;
    DECLARE @SalespersonCode VARCHAR(25) = CONVERT(VARCHAR(25), LEFT(COALESCE(
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.logo.salesperson_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.logo_code'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.name'), N''),
        NULLIF(JSON_VALUE(@PayloadJson, '$.salesperson.username'), N'')
    ), 25));
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

    IF @NormalizedMethod = N'transfer'
    BEGIN
        BEGIN TRANSACTION;
        EXEC dbo.PowersaB2B_WriteBankCollection
            @CustomerRef, @CollectionDate, @Method, @Amount, @ReferenceNo,
            @Note, @ExportKey, @PayloadJson, @ExternalRef OUTPUT;
        EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;
        COMMIT TRANSACTION;
        RETURN;
    END;

    IF @NormalizedMethod = N'cc'
       AND ISNULL(JSON_VALUE(@PayloadJson, '$.reference_fields.collection_channel'), N'') <> N'factory'
    BEGIN
        BEGIN TRANSACTION;
        EXEC dbo.PowersaB2B_WritePhysicalPosCollection
            @CustomerRef, @CollectionDate, @Amount, @ReferenceNo,
            @Note, @ExportKey, @PayloadJson, @ExternalRef OUTPUT;
        EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;
        COMMIT TRANSACTION;
        RETURN;
    END;

    IF @NormalizedMethod IN (
        N'check', N'cheque', N'cek', N'çek',
        N'note', N'senet', N'promissory_note', N'promissory-note', N'promissorynote'
    )
    BEGIN
        BEGIN TRANSACTION;
        EXEC dbo.PowersaB2B_WriteChequeCollection
            @CustomerRef, @CollectionDate, @Method, @Amount, @ReferenceNo,
            @Note, @ExportKey, @PayloadJson, @ExternalRef OUTPUT;
        EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;
        COMMIT TRANSACTION;
        RETURN;
    END;

    IF @NormalizedMethod = N'cc'
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

        EXEC dbo.PowersaB2B_ApplyCashboxInSign @KslinesRef;
        EXEC dbo.PowersaB2B_ApplyCashboxLocalCurrencyTotals @KslinesRef;
        EXEC dbo.PowersaB2B_ApplyCashboxLogoDefaults @KslinesRef;
        EXEC dbo.PowersaB2B_ApplyCustomerLedgerLogoDefaults @ClflineRef, @CollectionDate;
        EXEC dbo.PowersaB2B_ApplyLogoEditTimestamp N'dbo.LG_003_01_KSLINES', @KslinesRef, @Now;
        EXEC dbo.PowersaB2B_ApplyLogoEditTimestamp N'dbo.LG_003_01_CLFLINE', @ClflineRef, @Now;
        EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_KSLINES', @KslinesRef, @SalespersonCode;
        EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_CLFLINE', @ClflineRef, @SalespersonCode;

        SET @ExternalRef = CONCAT(N'CLFLINE-', @ClflineRef);
        EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;
        RETURN;
    END;

    BEGIN TRANSACTION;

    IF OBJECTPROPERTY(OBJECT_ID('dbo.LG_003_01_KSLINES'), 'TableHasIdentity') = 1
    BEGIN
        INSERT INTO dbo.LG_003_01_KSLINES (
            CARDREF, DATE_, HOUR_, MINUTE_, TRCODE, SPECODE, CYPHCODE, FICHENO,
            LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET, REPORTRATE, REPORTNET,
            CANCELLED, STATUS, AFFECTRISK, BRANCH, DEPARTMENT,
            ACCREF, CENTERREF, CASHACCREF, CASHCENREF, ACCFICHEREF, ACCOUNTED, REFLECTED,
            CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
            CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC,
            CAPIBLOCK_MODIFIEDBY, CAPIBLOCK_MODIFIEDDATE, CAPIBLOCK_MODIFIEDHOUR,
            CAPIBLOCK_MODIFIEDMIN, CAPIBLOCK_MODIFIEDSEC,
            DOCODE, DOCDATE, TIME_
        )
        VALUES (
            @CashboxRef, @CollectionDate, @Hour, @Minute, 11, @Specode, @CyphCode, @FicheNo,
            @LineExp, 0, CONVERT(FLOAT, @Amount), 0, 1, CONVERT(FLOAT, @Amount), 1, CONVERT(FLOAT, @Amount),
            0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0,
            1, @Now,
            @Hour, @Minute, @Second,
            1, @Now, @Hour, @Minute, @Second,
            @Docode, @Now, ((@Hour * 16777216) + (@Minute * 65536) + (@Second * 256))
        );
        SET @KslinesRef = SCOPE_IDENTITY();
    END
    ELSE
    BEGIN
        SELECT @KslinesRef = ISNULL(MAX(LOGICALREF), 0) + 1 FROM dbo.LG_003_01_KSLINES WITH (UPDLOCK, TABLOCKX);
        INSERT INTO dbo.LG_003_01_KSLINES (
            LOGICALREF, CARDREF, DATE_, HOUR_, MINUTE_, TRCODE, SPECODE, CYPHCODE, FICHENO,
            LINEEXP, SIGN, AMOUNT, TRCURR, TRRATE, TRNET, REPORTRATE, REPORTNET,
            CANCELLED, STATUS, AFFECTRISK, BRANCH, DEPARTMENT,
            ACCREF, CENTERREF, CASHACCREF, CASHCENREF, ACCFICHEREF, ACCOUNTED, REFLECTED,
            CAPIBLOCK_CREATEDBY, CAPIBLOCK_CREADEDDATE,
            CAPIBLOCK_CREATEDHOUR, CAPIBLOCK_CREATEDMIN, CAPIBLOCK_CREATEDSEC,
            CAPIBLOCK_MODIFIEDBY, CAPIBLOCK_MODIFIEDDATE, CAPIBLOCK_MODIFIEDHOUR,
            CAPIBLOCK_MODIFIEDMIN, CAPIBLOCK_MODIFIEDSEC,
            DOCODE, DOCDATE, TIME_
        )
        VALUES (
            @KslinesRef, @CashboxRef, @CollectionDate, @Hour, @Minute, 11, @Specode, @CyphCode, @FicheNo,
            @LineExp, 0, CONVERT(FLOAT, @Amount), 0, 1, CONVERT(FLOAT, @Amount), 1, CONVERT(FLOAT, @Amount),
            0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0,
            1, @Now,
            @Hour, @Minute, @Second,
            1, @Now, @Hour, @Minute, @Second,
            @Docode, @Now, ((@Hour * 16777216) + (@Minute * 65536) + (@Second * 256))
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

    EXEC dbo.PowersaB2B_ApplyCashboxInSign @KslinesRef;
    EXEC dbo.PowersaB2B_ApplyCashboxLocalCurrencyTotals @KslinesRef;
    EXEC dbo.PowersaB2B_ApplyCashboxLogoDefaults @KslinesRef;
    EXEC dbo.PowersaB2B_ApplyCustomerLedgerLogoDefaults @ClflineRef, @CollectionDate;
    EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_KSLINES', @KslinesRef, @SalespersonCode;
    EXEC dbo.PowersaB2B_ApplySalespersonToLogoRow N'dbo.LG_003_01_CLFLINE', @ClflineRef, @SalespersonCode;

    SET @ExternalRef = CONCAT(N'CLFLINE-', @ClflineRef);
    EXEC dbo.PowersaB2B_FinishExport @ExportKey, @ExternalRef;

    COMMIT TRANSACTION;
END;
GO
