/*
  READ ONLY - Logo ambar fisi baslik/satir esleme denetimi.
  @ManualFicheNo alanina Logo arayuzunden elle olusturulan dogru bir
  ambar fisinin numarasini yazin. Bos birakilirsa son B2B fisleri listelenir.
*/
SET NOCOUNT ON;

DECLARE @ManualFicheNo VARCHAR(32) = NULL;

SELECT
    TABLE_NAME,
    ORDINAL_POSITION,
    COLUMN_NAME,
    DATA_TYPE,
    CHARACTER_MAXIMUM_LENGTH
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME IN ('LG_003_01_STFICHE', 'LG_003_01_STLINE')
ORDER BY TABLE_NAME, ORDINAL_POSITION;

SELECT
    warehouse.FIRMNR,
    warehouse.NR AS warehouse_no,
    warehouse.NAME AS warehouse_name,
    warehouse.DIVISNR AS warehouse_division_no,
    division.NR AS workplace_no,
    division.NAME AS workplace_name
FROM dbo.L_CAPIWHOUSE AS warehouse WITH (NOLOCK)
LEFT JOIN dbo.L_CAPIDIV AS division WITH (NOLOCK)
    ON division.FIRMNR = warehouse.FIRMNR
   AND division.NR = TRY_CONVERT(INT, warehouse.DIVISNR)
WHERE warehouse.FIRMNR = 3
ORDER BY warehouse.NR;

SELECT TOP (50)
    fiche.LOGICALREF,
    fiche.FICHENO,
    fiche.DOCODE,
    fiche.DATE_,
    fiche.TRCODE,
    fiche.IOCODE,
    fiche.SOURCETYPE,
    fiche.SOURCEINDEX,
    fiche.SOURCECOSTGRP,
    fiche.BRANCH,
    fiche.DEPARTMENT,
    fiche.COMPBRANCH,
    fiche.COMPDEPARTMENT,
    fiche.COMPFACTORY,
    fiche.DESTTYPE,
    fiche.DESTINDEX,
    fiche.DESTCOSTGRP,
    fiche.NETTOTAL,
    fiche.GENEXP1,
    fiche.GENEXP2,
    fiche.GENEXP3,
    fiche.GENEXP4
FROM dbo.LG_003_01_STFICHE AS fiche WITH (NOLOCK)
WHERE fiche.TRCODE = 25
  AND (
      (@ManualFicheNo IS NOT NULL AND fiche.FICHENO = @ManualFicheNo)
      OR (@ManualFicheNo IS NULL AND fiche.SPECODE = 'B2B')
  )
ORDER BY fiche.LOGICALREF DESC;

SELECT TOP (200)
    line.STFICHEREF,
    line.STFICHELNNO,
    line.STOCKREF,
    item.CODE AS product_code,
    line.LINETYPE,
    line.TRCODE,
    line.IOCODE,
    line.SOURCETYPE,
    line.SOURCEINDEX,
    line.SOURCECOSTGRP,
    line.DESTTYPE,
    line.DESTINDEX,
    line.DESTCOSTGRP,
    line.AMOUNT,
    line.PRICE,
    line.TOTAL,
    line.LINENET,
    line.LINEEXP
FROM dbo.LG_003_01_STLINE AS line WITH (NOLOCK)
INNER JOIN dbo.LG_003_01_STFICHE AS fiche WITH (NOLOCK)
    ON fiche.LOGICALREF = line.STFICHEREF
LEFT JOIN dbo.LG_003_ITEMS AS item WITH (NOLOCK)
    ON item.LOGICALREF = line.STOCKREF
WHERE fiche.TRCODE = 25
  AND (
      (@ManualFicheNo IS NOT NULL AND fiche.FICHENO = @ManualFicheNo)
      OR (@ManualFicheNo IS NULL AND fiche.SPECODE = 'B2B')
  )
ORDER BY line.STFICHEREF DESC, line.STFICHELNNO;
