/*
  Rebuild Logo cashbox total tables from LG_003_01_KSLINES.

  Why this exists:
  Logo's LG_KSLINES_* triggers select scalar values from INSERTED/DELETED. A
  multi-row UPDATE on KSLINES can therefore update CSHTOTS/GNTOTCSH for only one
  arbitrary row. This script repairs the derived cashbox total tables from the
  source cash movements without creating any new cash movement.

  Scope:
  - Rebuilds LG_003_01_CSHTOTS and LG_003_01_GNTOTCSH for all cashboxes that
    have at least one active KSLINES row.
  - Uses the same total type rules as LG_UPDATE_CASHTRANS_003_01:
    TOTTYPE 1 = local amount totals
    TOTTYPE 2 = reporting currency totals
    TOTTYPE 8 = transaction currency daily totals
  - Ignores cancelled/statused rows just like the Logo procedure.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'dbo.LG_003_01_KSLINES', N'U') IS NULL
   OR OBJECT_ID(N'dbo.LG_003_01_CSHTOTS', N'U') IS NULL
   OR OBJECT_ID(N'dbo.LG_003_01_GNTOTCSH', N'U') IS NULL
BEGIN
    RAISERROR('Required Logo cashbox tables were not found.', 16, 1);
    RETURN;
END;

IF OBJECT_ID(N'dbo.LG_003_01_TRANSAC', N'U') IS NULL
BEGIN
    RAISERROR('LG_003_01_TRANSAC was not found; cannot calculate Logo cashbox day numbers safely.', 16, 1);
    RETURN;
END;

DECLARE @YearBeg DATETIME;
DECLARE @ReportCurrency SMALLINT;

SELECT TOP (1) @YearBeg = PERIODBEGDATE
FROM dbo.LG_003_01_TRANSAC WITH (NOLOCK)
WHERE PERIODBEGDATE IS NOT NULL
ORDER BY PERIODBEGDATE;

IF @YearBeg IS NULL
BEGIN
    RAISERROR('Logo period begin date was not found; cannot calculate Logo cashbox day numbers safely.', 16, 1);
    RETURN;
END;

SELECT @ReportCurrency = ISNULL(FIRMREPCURR, 160)
FROM dbo.LG_003_TRGPAR WITH (NOLOCK);

IF @ReportCurrency IS NULL
BEGIN
    SET @ReportCurrency = 160;
END;

IF OBJECT_ID('tempdb..#CashboxRefs') IS NOT NULL
BEGIN
    DROP TABLE #CashboxRefs;
END;

SELECT DISTINCT CARDREF
INTO #CashboxRefs
FROM dbo.LG_003_01_KSLINES WITH (NOLOCK)
WHERE ISNULL(CARDREF, 0) > 0;

BEGIN TRANSACTION;

DELETE totals
FROM dbo.LG_003_01_CSHTOTS AS totals
INNER JOIN #CashboxRefs AS cashboxes
    ON cashboxes.CARDREF = totals.CARDREF;

DELETE totals
FROM dbo.LG_003_01_GNTOTCSH AS totals
INNER JOIN #CashboxRefs AS cashboxes
    ON cashboxes.CARDREF = totals.CARDREF;

;WITH SourceRows AS (
    SELECT
        CARDREF,
        TRCODE,
        DATE_,
        CASE
            WHEN TRCODE IN (71, 72) THEN CONVERT(SMALLINT, 0)
            ELSE CONVERT(SMALLINT, DATEDIFF(DAY, @YearBeg, DATE_) + 1)
        END AS DAY_,
        ISNULL(SIGN, 0) AS SIGN,
        ISNULL(AMOUNT, 0) AS AMOUNT,
        ISNULL(REPORTNET, 0) AS REPORTNET,
        ISNULL(TRNET, 0) AS TRNET,
        ISNULL(TRCURR, 0) AS TRCURR
    FROM dbo.LG_003_01_KSLINES WITH (NOLOCK)
    WHERE ISNULL(CARDREF, 0) > 0
      AND ISNULL(CANCELLED, 0) = 0
      AND ISNULL(STATUS, 0) = 0
),
DailyLocal AS (
    SELECT
        CARDREF,
        CONVERT(SMALLINT, 1) AS TOTTYPE,
        DAY_,
        DATE_,
        CONVERT(SMALLINT, 0) AS CURRTYP,
        SUM(CASE WHEN SIGN = 0 THEN AMOUNT ELSE 0 END) AS DEBIT,
        SUM(CASE WHEN SIGN = 0 THEN 0 ELSE AMOUNT END) AS CREDIT
    FROM SourceRows
    WHERE AMOUNT > 0.0000001
    GROUP BY CARDREF, DAY_, DATE_
),
DailyReport AS (
    SELECT
        CARDREF,
        CONVERT(SMALLINT, 2) AS TOTTYPE,
        DAY_,
        DATE_,
        @ReportCurrency AS CURRTYP,
        SUM(CASE WHEN SIGN = 0 THEN REPORTNET ELSE 0 END) AS DEBIT,
        SUM(CASE WHEN SIGN = 0 THEN 0 ELSE REPORTNET END) AS CREDIT
    FROM SourceRows
    WHERE REPORTNET > 0.0000001
    GROUP BY CARDREF, DAY_, DATE_
),
DailyTransaction AS (
    SELECT
        CARDREF,
        CONVERT(SMALLINT, 8) AS TOTTYPE,
        DAY_,
        DATE_,
        TRCURR AS CURRTYP,
        SUM(CASE WHEN SIGN = 0 THEN TRNET ELSE 0 END) AS DEBIT,
        SUM(CASE WHEN SIGN = 0 THEN 0 ELSE TRNET END) AS CREDIT
    FROM SourceRows
    WHERE TRNET > 0.0000001
      AND TRCODE NOT IN (79, 80)
    GROUP BY CARDREF, DAY_, DATE_, TRCURR
),
DailyTotals AS (
    SELECT * FROM DailyLocal
    UNION ALL
    SELECT * FROM DailyReport
    UNION ALL
    SELECT * FROM DailyTransaction
)
INSERT INTO dbo.LG_003_01_CSHTOTS
    (CARDREF, TOTTYPE, DAY_, DEBIT, CREDIT, DATE_, CURRTYP)
SELECT
    CARDREF,
    TOTTYPE,
    DAY_,
    SUM(DEBIT) AS DEBIT,
    SUM(CREDIT) AS CREDIT,
    DATE_,
    CURRTYP
FROM DailyTotals
GROUP BY CARDREF, TOTTYPE, DAY_, DATE_, CURRTYP
HAVING ABS(SUM(DEBIT)) > 0.0000001
    OR ABS(SUM(CREDIT)) > 0.0000001;

;WITH SourceRows AS (
    SELECT
        CARDREF,
        ISNULL(SIGN, 0) AS SIGN,
        ISNULL(AMOUNT, 0) AS AMOUNT,
        ISNULL(REPORTNET, 0) AS REPORTNET
    FROM dbo.LG_003_01_KSLINES WITH (NOLOCK)
    WHERE ISNULL(CARDREF, 0) > 0
      AND ISNULL(CANCELLED, 0) = 0
      AND ISNULL(STATUS, 0) = 0
),
GeneralLocal AS (
    SELECT
        CARDREF,
        CONVERT(SMALLINT, 1) AS TOTTYPE,
        SUM(CASE WHEN SIGN = 0 THEN AMOUNT ELSE 0 END) AS DEBIT,
        SUM(CASE WHEN SIGN = 0 THEN 0 ELSE AMOUNT END) AS CREDIT
    FROM SourceRows
    WHERE AMOUNT > 0.0000001
    GROUP BY CARDREF
),
GeneralReport AS (
    SELECT
        CARDREF,
        CONVERT(SMALLINT, 2) AS TOTTYPE,
        SUM(CASE WHEN SIGN = 0 THEN REPORTNET ELSE 0 END) AS DEBIT,
        SUM(CASE WHEN SIGN = 0 THEN 0 ELSE REPORTNET END) AS CREDIT
    FROM SourceRows
    WHERE REPORTNET > 0.0000001
    GROUP BY CARDREF
),
GeneralTotals AS (
    SELECT * FROM GeneralLocal
    UNION ALL
    SELECT * FROM GeneralReport
)
INSERT INTO dbo.LG_003_01_GNTOTCSH
    (CARDREF, TOTTYPE, DEBIT, CREDIT)
SELECT
    CARDREF,
    TOTTYPE,
    SUM(DEBIT) AS DEBIT,
    SUM(CREDIT) AS CREDIT
FROM GeneralTotals
GROUP BY CARDREF, TOTTYPE
HAVING ABS(SUM(DEBIT)) > 0.0000001
    OR ABS(SUM(CREDIT)) > 0.0000001;

DECLARE @CashboxCount INT = (SELECT COUNT(*) FROM #CashboxRefs);
DECLARE @DailyTotalRows INT = (SELECT COUNT(*) FROM dbo.LG_003_01_CSHTOTS WHERE CARDREF IN (SELECT CARDREF FROM #CashboxRefs));
DECLARE @GeneralTotalRows INT = (SELECT COUNT(*) FROM dbo.LG_003_01_GNTOTCSH WHERE CARDREF IN (SELECT CARDREF FROM #CashboxRefs));

COMMIT TRANSACTION;

SELECT
    @CashboxCount AS rebuilt_cashbox_count,
    @DailyTotalRows AS rebuilt_cshtots_rows,
    @GeneralTotalRows AS rebuilt_gntotcsh_rows;
