#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import sql from "mssql";

import { logoFirmTable } from "./logo-table-names.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(scriptDir, ".env");

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

main().catch((error) => {
  console.error("[logo-campaign-discovery] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  const config = buildConfig();
  validateConfig(config);

  const pool = new sql.ConnectionPool(config.connection);
  await pool.connect();

  try {
    const candidateTables = await pool.request().query(`
      SELECT
        SCHEMA_NAME(t.schema_id) AS schema_name,
        t.name AS table_name,
        SUM(p.rows) AS approximate_rows
      FROM sys.tables AS t
      LEFT JOIN sys.partitions AS p
        ON p.object_id = t.object_id
       AND p.index_id IN (0, 1)
      WHERE
        t.name LIKE '%PRCLIST%'
        OR t.name LIKE '%PROM%'
        OR t.name LIKE '%CAMPAIGN%'
        OR t.name LIKE '%CMP%'
        OR t.name LIKE '%COND%'
        OR t.name LIKE '%DISCOUNT%'
      GROUP BY t.schema_id, t.name
      ORDER BY t.name;
    `);

    const priceTable = assertSafeTableName(config.priceTable);
    const campaignTable = assertSafeTableName(config.campaignTable);
    const campaignLineTable = assertSafeTableName(config.campaignLineTable);
    const priceColumns = await pool
      .request()
      .input("tableName", sql.NVarChar(128), priceTable.split(".").at(-1).replaceAll("[", "").replaceAll("]", ""))
      .query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = @tableName
        ORDER BY ORDINAL_POSITION;
      `);

    const campaignColumns = await loadColumns(pool, campaignTable);
    const campaignLineColumns = await loadColumns(pool, campaignLineTable);
    const campaignRows = await pool.request().query(`
      SELECT *
      FROM ${campaignTable} WITH (NOLOCK)
      ORDER BY LOGICALREF;
    `);
    const campaignLineRows = await pool.request().query(`
      SELECT TOP (500) *
      FROM ${campaignLineTable} WITH (NOLOCK)
      ORDER BY LOGICALREF;
    `);

    console.log(JSON.stringify({
      checked_at: new Date().toISOString(),
      campaign_table: campaignTable,
      campaign_columns: campaignColumns,
      campaign_rows: campaignRows.recordset ?? [],
      campaign_line_table: campaignLineTable,
      campaign_line_columns: campaignLineColumns,
      campaign_line_sample: campaignLineRows.recordset ?? [],
    }, null, 2));
  } finally {
    await pool.close();
  }
}

function buildConfig() {
  const port = parseInteger(process.env.LOGO_SQL_PORT);
  const options = {
    encrypt: parseBoolean(process.env.LOGO_SQL_ENCRYPT, false),
    trustServerCertificate: parseBoolean(process.env.LOGO_SQL_TRUST_SERVER_CERTIFICATE, true),
    instanceName: nullable(process.env.LOGO_SQL_INSTANCE),
  };

  const connection = {
    server: String(process.env.LOGO_SQL_SERVER ?? "").trim(),
    database: String(process.env.LOGO_SQL_DATABASE ?? "").trim(),
    user: String(process.env.LOGO_SQL_USER ?? "").trim(),
    password: process.env.LOGO_SQL_PASSWORD ?? "",
    options,
    requestTimeout: parseInteger(process.env.LOGO_SQL_REQUEST_TIMEOUT_MS) ?? 30_000,
  };

  if (port !== undefined) {
    connection.port = port;
  }

  return {
    connection,
    priceTable: nullable(process.env.LOGO_PRICE_TABLE) ?? logoFirmTable("PRCLIST"),
    campaignTable: nullable(process.env.LOGO_CAMPAIGN_TABLE) ?? logoFirmTable("CAMPAIGN"),
    campaignLineTable: nullable(process.env.LOGO_CAMPAIGN_LINE_TABLE) ?? logoFirmTable("CMPGNLINE"),
  };
}

async function loadColumns(pool, tableName) {
  const plainTableName = tableName.split(".").at(-1).replaceAll("[", "").replaceAll("]", "");
  const result = await pool
    .request()
    .input("tableName", sql.NVarChar(128), plainTableName)
    .query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = @tableName
      ORDER BY ORDINAL_POSITION;
    `);

  return (result.recordset ?? []).map((row) => row.COLUMN_NAME);
}

function validateConfig(config) {
  const missing = [];
  if (!config.connection.server) missing.push("LOGO_SQL_SERVER");
  if (!config.connection.database) missing.push("LOGO_SQL_DATABASE");
  if (!config.connection.user) missing.push("LOGO_SQL_USER");
  if (!config.connection.password) missing.push("LOGO_SQL_PASSWORD");

  if (missing.length > 0) {
    throw new Error(`missing required config: ${missing.join(", ")}`);
  }
}

function assertSafeTableName(value) {
  if (!/^[A-Za-z0-9_.\[\]]+$/.test(value)) {
    throw new Error("LOGO_PRICE_TABLE contains unsupported characters");
  }

  return value;
}

function nullable(value) {
  const normalized = String(value ?? "").trim();
  return normalized === "" ? null : normalized;
}

function parseInteger(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "") return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
}
