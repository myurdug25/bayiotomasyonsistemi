import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import sql from "mssql";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(scriptDir, "..", "..", ".env");

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  // Try local .env
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

  const sqlPath = path.join(scriptDir, "sql", "powersa-b2b-order-shipment-pos-write-procedure.sql");
  const sqlContent = fs.readFileSync(sqlPath, "utf-8");

  const blocks = sqlContent.split(/^GO\s*$/im).filter(b => b.trim().length > 0);

  for (const block of blocks) {
    try {
      await pool.request().batch(block);
      console.log("Executed block successfully.");
    } catch (err) {
      console.error("Error executing block:", err.message);
    }
  }

  await pool.close();
  console.log("Done deploying SQL.");
}

run().catch(console.error);
