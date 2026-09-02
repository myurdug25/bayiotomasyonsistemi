#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import sql from "mssql";

import { logoPeriodTable } from "./logo-table-names.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(scriptDir, ".env");

if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

const config = buildConfig();

main().catch((error) => {
  console.error("[logo-sync] POS delivery balance sync failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  validateConfig(config);
  const pool = new sql.ConnectionPool(config.logo.connection);
  await pool.connect();

  try {
    const result = await pool.request().query(`
      SELECT
        SOURCEINDEX AS warehouse_no,
        CLIENTREF AS customer_ref,
        COUNT_BIG(*) AS document_count,
        SUM(CONVERT(DECIMAL(19, 4), ISNULL(NETTOTAL, 0))) AS total_amount
      FROM ${config.logo.stockFicheTable} WITH (NOLOCK)
      WHERE GRPCODE = 2
        AND TRCODE = 8
        AND ISNULL(CANCELLED, 0) = 0
        AND ISNULL(BILLED, 0) = 0
        AND GENEXP1 LIKE 'POS-%'
        AND SOURCEINDEX IN (0, 2, 3, 4)
        AND ISNULL(CLIENTREF, 0) > 0
      GROUP BY SOURCEINDEX, CLIENTREF
      ORDER BY SOURCEINDEX, CLIENTREF;
    `);

    const warehouseNumbers = [0, 2, 3, 4];
    const customerRecords = result.recordset.map((row) => ({
      warehouse_no: Number(row.warehouse_no),
      customer_ref: Number(row.customer_ref),
      count: Number(row.document_count),
      amount: Number(row.total_amount),
    }));
    const records = [
      ...warehouseNumbers.map((warehouseNo) => ({
        warehouse_no: warehouseNo,
        customer_ref: null,
        count: customerRecords
          .filter((record) => record.warehouse_no === warehouseNo)
          .reduce((total, record) => total + record.count, 0),
        amount: customerRecords
          .filter((record) => record.warehouse_no === warehouseNo)
          .reduce((total, record) => total + record.amount, 0),
      })),
      ...customerRecords,
    ];

    const response = await fetch(config.sync.url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-integration-key": config.sync.key,
      },
      body: JSON.stringify({ dealer_id: config.sync.dealerId, records }),
    });

    if (!response.ok) {
      throw new Error(`endpoint returned ${response.status}: ${await response.text()}`);
    }

    console.log("[logo-sync] POS delivery balances synced:", JSON.stringify(await response.json()));
  } finally {
    await pool.close();
  }
}

function buildConfig() {
  const timeoutMs = parseInteger(process.env.LOGO_SQL_REQUEST_TIMEOUT_MS, 30000);
  const port = parseInteger(process.env.LOGO_SQL_PORT, undefined);
  const baseUrl = nullable(process.env.POWERSA_SYNC_URL);
  const explicitUrl = nullable(process.env.POWERSA_POS_DELIVERY_BALANCES_SYNC_URL);

  const connection = {
    server: (process.env.LOGO_SQL_SERVER ?? "").trim(),
    database: (process.env.LOGO_SQL_DATABASE ?? "").trim(),
    user: (process.env.LOGO_SQL_USER ?? "").trim(),
    password: process.env.LOGO_SQL_PASSWORD ?? "",
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: parseBoolean(process.env.LOGO_SQL_ENCRYPT, false),
      trustServerCertificate: parseBoolean(process.env.LOGO_SQL_TRUST_SERVER_CERTIFICATE, true),
      instanceName: nullable(process.env.LOGO_SQL_INSTANCE),
    },
    requestTimeout: timeoutMs,
  };

  if (port !== undefined) connection.port = port;

  return {
    logo: {
      connection,
      stockFicheTable: nullable(process.env.LOGO_STOCK_FICHE_TABLE) ?? logoPeriodTable("STFICHE"),
    },
    sync: {
      url: explicitUrl ?? deriveSyncUrl(baseUrl) ?? "",
      key: (process.env.POWERSA_POS_SALES_SYNC_KEY ?? process.env.POWERSA_SYNC_KEY ?? "").trim(),
      dealerId: parseInteger(process.env.POWERSA_DEALER_ID, undefined),
    },
  };
}

function validateConfig(current) {
  const missing = [];
  if (!current.logo.connection.server) missing.push("LOGO_SQL_SERVER");
  if (!current.logo.connection.database) missing.push("LOGO_SQL_DATABASE");
  if (!current.logo.connection.user) missing.push("LOGO_SQL_USER");
  if (!current.logo.connection.password) missing.push("LOGO_SQL_PASSWORD");
  if (!current.sync.url) missing.push("POWERSA_POS_DELIVERY_BALANCES_SYNC_URL or POWERSA_SYNC_URL");
  if (!current.sync.key) missing.push("POWERSA_POS_SALES_SYNC_KEY or POWERSA_SYNC_KEY");
  if (missing.length > 0) throw new Error(`missing required config: ${missing.join(", ")}`);
  if (!/^[A-Za-z0-9_.\[\]]+$/.test(current.logo.stockFicheTable)) throw new Error("unsafe Logo stock fiche table name");
}

function deriveSyncUrl(baseUrl) {
  if (!baseUrl) return null;
  return baseUrl.replace(/\/customers\/sync$/i, "/pos-delivery-balances/sync");
}

function parseInteger(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "evet", "on"].includes(String(value).trim().toLowerCase());
}

function nullable(value) {
  const normalized = value === undefined || value === null ? "" : String(value).trim();
  return normalized === "" ? null : normalized;
}
