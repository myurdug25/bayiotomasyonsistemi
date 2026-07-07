import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import sql from "mssql";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(scriptDir, "..", "..", "apps", "api", ".env");

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

async function run() {
  const config = {
    server: process.env.LOGO_SQL_SERVER,
    database: process.env.LOGO_SQL_DATABASE,
    user: process.env.LOGO_SQL_USER,
    password: process.env.LOGO_SQL_PASSWORD,
    port: process.env.LOGO_SQL_PORT ? Number(process.env.LOGO_SQL_PORT) : undefined,
    options: {
      encrypt: process.env.LOGO_SQL_ENCRYPT === 'true',
      trustServerCertificate: process.env.LOGO_SQL_TRUST_SERVER_CERTIFICATE !== 'false',
      instanceName: process.env.LOGO_SQL_INSTANCE || undefined,
    },
    requestTimeout: Number(process.env.LOGO_SQL_REQUEST_TIMEOUT_MS ?? 30000),
  };

  if (!config.server) {
    console.error("LOGO_SQL_SERVER is not set.");
    process.exit(1);
  }

  const pool = new sql.ConnectionPool(config);
  await pool.connect();
  console.log("Connected to Logo DB.");

  console.log("\n=== RECENT STFICHE (STOCK SLIPS) ===");
  const ficheResult = await pool.request().query(`
    SELECT TOP 10 
      LOGICALREF, GRPCODE, TRCODE, FICHENO, 
      CONVERT(VARCHAR(10), DATE_, 120) AS DATE_, 
      SOURCEINDEX, BRANCH, STATUS, BILLED, CANCELLED, NETTOTAL 
    FROM dbo.LG_003_01_STFICHE 
    ORDER BY LOGICALREF DESC;
  `);
  console.table(ficheResult.recordset);

  console.log("\n=== RECENT STLINE (STOCK MOVEMENTS) ===");
  const lineResult = await pool.request().query(`
    SELECT TOP 10 
      LOGICALREF, STOCKREF, STFICHEREF, SOURCEINDEX, 
      PRICE, AMOUNT, TOTAL, STATUS, 
      MONTH_, YEAR_ 
    FROM dbo.LG_003_01_STLINE 
    ORDER BY LOGICALREF DESC;
  `);
  console.table(lineResult.recordset);

  console.log("\n=== GNTOTST (GENERAL TOTALS FOR RECENTS) ===");
  const gntotResult = await pool.request().query(`
    SELECT STOCKREF, INVENNO, ONHAND 
    FROM dbo.LG_003_01_GNTOTST 
    WHERE STOCKREF IN (SELECT DISTINCT TOP 5 STOCKREF FROM dbo.LG_003_01_STLINE ORDER BY STOCKREF DESC);
  `);
  console.table(gntotResult.recordset);

  console.log("\n=== STINVTOT (INVENTORY TOTALS FOR RECENTS) ===");
  const invtotResult = await pool.request().query(`
    SELECT STOCKREF, INVENNO, ONHAND 
    FROM dbo.LG_003_01_STINVTOT 
    WHERE STOCKREF IN (SELECT DISTINCT TOP 5 STOCKREF FROM dbo.LG_003_01_STLINE ORDER BY STOCKREF DESC);
  `);
  console.table(invtotResult.recordset);

  await pool.close();
}

run().catch(console.error);
