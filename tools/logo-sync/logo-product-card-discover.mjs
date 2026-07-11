#!/usr/bin/env node

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
}

const config = buildConfig();

main().catch((error) => {
  console.error("[logo-sync] discover failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  validateConfig(config);

  console.log(
    `[logo-sync] connecting to ${config.logo.server}${config.logo.instanceName ? `\\${config.logo.instanceName}` : ""}/${config.logo.database}`
  );

  const pool = new sql.ConnectionPool(config.logo.connection);
  await pool.connect();

  try {
    const productTable = config.logo.productTable;
    const productSchema = await inspectTable(pool, productTable);
    console.log(`[logo-sync] product table: ${productSchema.qualifiedName} columns=${productSchema.columns.length}`);
    printMatchingColumns("product-table", productSchema, ["OEM", "RKP", "RAF", "RAFADRES", "RAF_ADRES"]);

    const extensionCandidates = await discoverExtensionTables(pool, config.logo.firmNo);
    console.log(`[logo-sync] candidate extension/custom tables: ${extensionCandidates.length}`);

    for (const table of extensionCandidates.slice(0, 120)) {
      const schema = await inspectTable(pool, `${table.TABLE_SCHEMA}.${table.TABLE_NAME}`);
      const interesting = matchingColumns(schema, ["OEM", "RKP", "RAF", "RAFADRES", "RAF_ADRES"]);
      const hasReference = ["PARLOGREF", "ITEMREF", "STOCKREF", "CARDREF", "PRODUCTREF", "INFOREF", "LOGICALREF"].some((column) =>
        hasColumn(schema, column)
      );

      if (interesting.length > 0 || hasReference) {
        console.log("");
        console.log(`[logo-sync] table ${schema.qualifiedName}`);
        console.log(`  reference_column=${firstExistingColumn(schema, ["PARLOGREF", "ITEMREF", "STOCKREF", "CARDREF", "PRODUCTREF", "INFOREF", "LOGICALREF"]) ?? "-"}`);
        console.log(`  columns=${interesting.join(", ") || "-"}`);
      }
    }

    if (config.sample.productCode) {
      console.log("");
      console.log(`[logo-sync] sample lookup product_code=${config.sample.productCode}`);
      await printSampleRows(pool, productSchema, extensionCandidates, config.sample.productCode);
    }
  } finally {
    await pool.close();
  }
}

function buildConfig() {
  const timeoutMs = parseInteger(process.env.LOGO_SQL_REQUEST_TIMEOUT_MS, 30000);
  const port = parseInteger(process.env.LOGO_SQL_PORT, undefined);
  const firm = firmNo();

  return {
    logo: {
      firmNo: firm,
      server: (process.env.LOGO_SQL_SERVER ?? "").trim(),
      instanceName: nullable(process.env.LOGO_SQL_INSTANCE),
      port,
      database: (process.env.LOGO_SQL_DATABASE ?? "").trim(),
      user: (process.env.LOGO_SQL_USER ?? "").trim(),
      password: process.env.LOGO_SQL_PASSWORD ?? "",
      productTable: nullable(process.env.LOGO_PRODUCT_TABLE) ?? `dbo.LG_${firm}_ITEMS`,
      connection: {
        server: (process.env.LOGO_SQL_SERVER ?? "").trim(),
        database: (process.env.LOGO_SQL_DATABASE ?? "").trim(),
        user: (process.env.LOGO_SQL_USER ?? "").trim(),
        password: process.env.LOGO_SQL_PASSWORD ?? "",
        pool: {
          max: 4,
          min: 0,
          idleTimeoutMillis: 30000,
        },
        options: {
          encrypt: parseBoolean(process.env.LOGO_SQL_ENCRYPT, false),
          trustServerCertificate: parseBoolean(process.env.LOGO_SQL_TRUST_SERVER_CERTIFICATE, true),
          instanceName: nullable(process.env.LOGO_SQL_INSTANCE),
        },
        requestTimeout: timeoutMs,
      },
    },
    sample: {
      productCode: nullable(process.env.LOGO_DISCOVER_PRODUCT_CODE) ?? "CS 0040",
    },
  };
}

function validateConfig(currentConfig) {
  const missing = [];
  if (!currentConfig.logo.server) missing.push("LOGO_SQL_SERVER");
  if (!currentConfig.logo.database) missing.push("LOGO_SQL_DATABASE");
  if (!currentConfig.logo.user) missing.push("LOGO_SQL_USER");
  if (!currentConfig.logo.password) missing.push("LOGO_SQL_PASSWORD");

  if (missing.length > 0) {
    throw new Error(`missing required config: ${missing.join(", ")}`);
  }

  if (currentConfig.logo.port !== undefined) {
    currentConfig.logo.connection.port = currentConfig.logo.port;
  }
}

async function discoverExtensionTables(pool, firm) {
  const result = await pool
    .request()
    .input("firm", sql.NVarChar(16), firm)
    .query(`
      SELECT DISTINCT
        c.TABLE_SCHEMA,
        c.TABLE_NAME,
        CASE
          WHEN c.TABLE_NAME LIKE 'LG[_]XT%[_]' + @firm THEN 0
          WHEN c.COLUMN_NAME LIKE 'OEM%' OR c.COLUMN_NAME LIKE 'RKP%' OR c.COLUMN_NAME LIKE 'RAF%' THEN 1
          WHEN c.TABLE_NAME LIKE 'LG[_]%' + @firm + '%' THEN 2
          ELSE 9
        END AS PRIORITY
      FROM INFORMATION_SCHEMA.COLUMNS c
      WHERE c.TABLE_SCHEMA = 'dbo'
        AND (
          c.TABLE_NAME LIKE 'LG[_]XT%[_]' + @firm
          OR c.COLUMN_NAME LIKE 'OEM%'
          OR c.COLUMN_NAME LIKE 'RKP%'
          OR c.COLUMN_NAME LIKE 'RAF%'
          OR c.COLUMN_NAME LIKE 'RAF[_]%'
          OR (
            c.TABLE_NAME LIKE 'LG[_]%' + @firm + '%'
            AND c.COLUMN_NAME IN ('PARLOGREF', 'ITEMREF', 'STOCKREF', 'CARDREF', 'PRODUCTREF', 'INFOREF')
          )
        )
      ORDER BY PRIORITY, c.TABLE_NAME;
    `);

  return result.recordset ?? [];
}

async function printSampleRows(pool, productSchema, tables, productCode) {
  const logicalRefColumn = findColumn(productSchema, "LOGICALREF");
  const codeColumn = findColumn(productSchema, "CODE");

  if (!logicalRefColumn || !codeColumn) {
    console.log("  product sample skipped: LOGICALREF/CODE column missing");
    return;
  }

  const product = await pool
    .request()
    .input("code", sql.NVarChar(128), productCode)
    .query(`
      SELECT TOP 1 ${quoteIdentifier(logicalRefColumn)} AS logical_ref, ${quoteIdentifier(codeColumn)} AS code
      FROM ${productSchema.qualifiedName}
      WHERE ${quoteIdentifier(codeColumn)} = @code
         OR REPLACE(${quoteIdentifier(codeColumn)}, ' ', '') = REPLACE(@code, ' ', '');
    `);

  const logicalRef = Number(product.recordset?.[0]?.logical_ref);
  if (!Number.isFinite(logicalRef)) {
    console.log("  product not found");
    return;
  }

  console.log(`  logical_ref=${logicalRef}`);

  for (const table of tables.slice(0, 40)) {
    const schema = await inspectTable(pool, `${table.TABLE_SCHEMA}.${table.TABLE_NAME}`);
    const refColumn = firstExistingColumn(schema, ["PARLOGREF", "ITEMREF", "STOCKREF", "CARDREF", "PRODUCTREF", "INFOREF", "LOGICALREF"]);
    const interesting = matchingColumns(schema, ["OEM", "RKP", "RAF", "RAFADRES", "RAF_ADRES"]);

    if (!refColumn || interesting.length === 0) {
      continue;
    }

    const selectColumns = [refColumn, ...interesting.slice(0, 25)]
      .map((column) => `${quoteIdentifier(column)} AS ${quoteIdentifier(column)}`)
      .join(", ");

    const rows = await pool
      .request()
      .input("logicalRef", sql.Int, logicalRef)
      .query(`
        SELECT TOP 3 ${selectColumns}
        FROM ${schema.qualifiedName}
        WHERE ${quoteIdentifier(refColumn)} = @logicalRef;
      `);

    if ((rows.recordset ?? []).length > 0) {
      console.log(`  sample ${schema.qualifiedName}:`);
      console.dir(rows.recordset, { depth: 4 });
    }
  }
}

async function inspectTable(pool, tableName) {
  const parts = tableName.replaceAll("[", "").replaceAll("]", "").split(".");
  const table = parts.pop();
  const schema = parts.pop() ?? "dbo";

  const result = await pool
    .request()
    .input("schema", sql.NVarChar(128), schema)
    .input("table", sql.NVarChar(128), table)
    .query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @schema
        AND TABLE_NAME = @table
      ORDER BY ORDINAL_POSITION;
    `);

  const columns = (result.recordset ?? []).map((row) => nullable(row.COLUMN_NAME)).filter(Boolean);

  return {
    schema,
    table,
    qualifiedName: `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
    columns,
    lowerColumnMap: new Map(columns.map((column) => [column.toLowerCase(), column])),
  };
}

function printMatchingColumns(label, schema, needles) {
  const columns = matchingColumns(schema, needles);
  console.log(`[logo-sync] ${label} interesting columns: ${columns.join(", ") || "-"}`);
}

function matchingColumns(schema, needles) {
  return schema.columns.filter((column) => {
    const upper = column.toUpperCase();
    return needles.some((needle) => upper.includes(needle.toUpperCase()));
  });
}

function firstExistingColumn(schema, candidates) {
  for (const candidate of candidates) {
    const column = findColumn(schema, candidate);
    if (column) {
      return column;
    }
  }

  return null;
}

function findColumn(schema, name) {
  return schema.lowerColumnMap.get(String(name).toLowerCase()) ?? null;
}

function hasColumn(schema, name) {
  return findColumn(schema, name) !== null;
}

function quoteIdentifier(value) {
  return `[${String(value).replaceAll("]", "]]")}]`;
}

function firmNo() {
  const raw = nullable(process.env.LOGO_FIRM_NO ?? process.env.LOGO_FIRM) ?? "003";
  return raw.padStart(3, "0").slice(-3);
}

function parseInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  const normalized = nullable(value)?.toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function nullable(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}
