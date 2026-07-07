import { readFile } from "fs/promises";
import sql from "mssql";

async function run() {
  const file = await readFile("tools/logo-sync/sql/powersa-b2b-customer-write-procedure.sql", "utf-8");
  
  const pool = await sql.connect({
    server: "GUCSASRV\\LOGO",
    database: "LOGODB",
    user: "sa",
    password: "1",
    options: {
      encrypt: false,
      trustServerCertificate: true,
    }
  });

  const batches = file.split("GO\r\n").filter(b => b.trim() !== "");
  for (const batch of batches) {
    if (batch.trim() === "") continue;
    try {
      await pool.request().batch(batch);
      console.log("Executed batch successfully.");
    } catch (e) {
      console.error("Batch error:", e.message);
    }
  }

  await pool.close();
}

run().catch(console.error);
