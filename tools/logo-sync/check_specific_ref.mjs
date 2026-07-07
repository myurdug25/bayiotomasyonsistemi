import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import sql from "mssql";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(scriptDir, ".env");

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

  const pool = new sql.ConnectionPool(config);
  await pool.connect();
  console.log("Connected to Logo DB.");

  // Check LOGICALREF = 28, 27, 26
  console.log("\n=== QUERY BY LOGICALREF (26, 27, 28) ===");
  const refResult = await pool.request().query(`
    SELECT LOGICALREF, GRPCODE, TRCODE, FICHENO, 
      CONVERT(VARCHAR(10), DATE_, 120) AS DATE_, 
      SOURCEINDEX, BRANCH, STATUS, BILLED, CANCELLED, NETTOTAL,
      GENEXP1, GENEXP2
    FROM dbo.LG_003_01_STFICHE 
    WHERE LOGICALREF IN (26, 27, 28);
  `);
  console.table(refResult.recordset);

  // Search by receipt no or export key
  console.log("\n=== SEARCH BY RECEIPT / EXPORT KEY ===");
  const searchResult = await pool.request().query(`
    SELECT LOGICALREF, GRPCODE, TRCODE, FICHENO, 
      CONVERT(VARCHAR(10), DATE_, 120) AS DATE_, 
      SOURCEINDEX, BRANCH, STATUS, BILLED, CANCELLED, NETTOTAL,
      GENEXP1, GENEXP2
    FROM dbo.LG_003_01_STFICHE 
    WHERE FICHENO LIKE '%XZZGO%' 
       OR GENEXP1 LIKE '%XZZGO%'
       OR GENEXP1 LIKE '%OCKEF%'
       OR GENEXP1 LIKE '%SQ1S0%'
       OR GENEXP1 LIKE '%B2B-POSSALE%';
  `);
  console.table(searchResult.recordset);

  await pool.close();
}

run().catch(console.error);
