#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import defaultSql from "mssql";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(scriptDir, ".env");

if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

const config = buildConfig();
const sql = config.eryaz.useTrustedConnection
  ? (await import("mssql/msnodesqlv8.js")).default
  : defaultSql;

main().catch((error) => {
  console.error("[logo-previous-purchases-sync] failed:", error instanceof Error ? error.message : error);
  writeStatus({ ok: false, last_error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});

async function main() {
  validateConfig(config);

  const startedAt = Date.now();
  const since = new Date(Date.now() - config.sync.lookbackDays * 24 * 60 * 60 * 1000);
  const pool = new sql.ConnectionPool(config.eryaz.connection);
  await pool.connect();

  let readCount = 0;
  let sentCount = 0;

  try {
    for (const database of config.eryaz.databases) {
      console.log(`[logo-previous-purchases-sync] reading ${database} since ${since.toISOString().slice(0, 10)}`);
      const rows = await readDatabase(pool, database, since);
      readCount += rows.length;

      for (const chunk of chunks(rows.map((row) => normalizeRecord(database, row)), config.sync.batchSize)) {
        await sendChunk(chunk);
        sentCount += chunk.length;
      }
    }
  } finally {
    await pool.close();
  }

  writeStatus({
    ok: true,
    dry_run: false,
    last_run_at: new Date().toISOString(),
    last_success_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    source_databases: config.eryaz.databases,
    lookback_days: config.sync.lookbackDays,
    read_count: readCount,
    synced_count: sentCount,
    last_error: null,
  });

  console.log(`[logo-previous-purchases-sync] completed read=${readCount} synced=${sentCount} duration=${Date.now() - startedAt}ms`);
}

async function readDatabase(pool, database, since) {
  const qualified = `[${database}]`;
  const request = pool.request();
  request.input("since", sql.DateTime, since);

  const result = await request.query(`
    SELECT
      ${sqlString(database)} AS SOURCE_DATABASE,
      CH.CARI_KOD AS CUSTOMER_CODE,
      FD.STOK_KODU AS PRODUCT_CODE,
      CH.TARIH AS TARIH,
      CH.ACIKLAMA AS ACIKLAMA,
      CH.BELGE_NO AS BELGE_NO,
      FD.STHAR_GCMIK AS MIKTAR,
      COALESCE(FDS.OLCU_BR1, 'AD') AS BIRIM,
      FD.STHAR_BF AS FIYAT,
      FD.STHAR_SATISK * 100000 AS ISK1,
      FD.STHAR_SATISK2 AS ISK2,
      FD.STRA_SATISK3 AS ISK3,
      FD.STRA_SATISK4 AS ISK4,
      FD.STRA_SATISK5 AS ISK5,
      FD.STHAR_BF * FD.STHAR_GCMIK AS TUTAR,
      FD.STHAR_NF AS FIYAT_NET,
      FD.INCKEYNO AS LINE_REF
    FROM ${qualified}.dbo.TBLCAHAR AS CH WITH (NOLOCK)
    INNER JOIN ${qualified}.dbo.TBLSTHAR AS FD WITH (NOLOCK)
      ON CH.CARI_KOD = FD.STHAR_ACIKLAMA
      AND CH.BELGE_NO = FD.FISNO
      AND CH.TARIH = FD.STHAR_TARIH
    INNER JOIN ${qualified}.dbo.TBLSTSABIT AS FDS WITH (NOLOCK)
      ON FD.STOK_KODU = FDS.STOK_KODU
    WHERE CH.TARIH >= @since
      AND ISNULL(CH.CARI_KOD, '') <> ''
      AND ISNULL(FD.STOK_KODU, '') <> ''
    ORDER BY CH.TARIH DESC, CH.BELGE_NO DESC, FD.INCKEYNO DESC;
  `);

  return result.recordset;
}

function normalizeRecord(database, row) {
  const date = formatDate(row.TARIH);
  const customerCode = string(row.CUSTOMER_CODE);
  const productCode = string(row.PRODUCT_CODE);
  const documentNo = string(row.BELGE_NO);
  const lineRef = string(row.LINE_REF) || [
    date,
    documentNo,
    numeric(row.MIKTAR),
    numeric(row.FIYAT_NET),
  ].join(":");
  const quantity = numeric(row.MIKTAR);
  const netPrice = numeric(row.FIYAT_NET);

  return {
    customer_code: customerCode,
    product_code: productCode,
    source_database: string(row.SOURCE_DATABASE) || database,
    external_ref: [database, customerCode, productCode, documentNo, date, lineRef].join("|"),
    date,
    description: string(row.ACIKLAMA),
    document_no: documentNo,
    quantity,
    unit: string(row.BIRIM) || "AD",
    unit_price: numeric(row.FIYAT),
    net_price: netPrice,
    discounts: ["ISK1", "ISK2", "ISK3", "ISK4", "ISK5"].map((key) => numeric(row[key])).filter((value) => value > 0),
    gross_total: numeric(row.TUTAR),
    net_total: round(quantity * netPrice),
  };
}

async function sendChunk(records) {
  if (records.length === 0) return;

  const response = await fetch(config.sync.url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-integration-key": config.sync.key,
    },
    body: JSON.stringify({
      dealer_id: config.sync.dealerId,
      records,
    }),
  });

  if (!response.ok) {
    throw new Error(`endpoint returned ${response.status}: ${await response.text()}`);
  }
}

function buildConfig() {
  const timeoutMs = parseInteger(process.env.ERYAZ_SQL_REQUEST_TIMEOUT_MS ?? process.env.LOGO_SQL_REQUEST_TIMEOUT_MS, 120000);
  const port = parseInteger(process.env.ERYAZ_SQL_PORT ?? process.env.LOGO_SQL_PORT, undefined);
  const baseUrl = nullable(process.env.POWERSA_SYNC_URL);
  const explicitUrl = nullable(process.env.POWERSA_PREVIOUS_PURCHASES_SYNC_URL);

  const instanceName = nullable(process.env.ERYAZ_SQL_INSTANCE ?? process.env.LOGO_SQL_INSTANCE);
  const useTrustedConnection = parseBoolean(
    process.env.ERYAZ_SQL_TRUSTED_CONNECTION ?? process.env.ERYAZ_SQL_USE_WINDOWS_AUTH,
    false
  );
  const connection = {
    server: (process.env.ERYAZ_SQL_SERVER ?? process.env.LOGO_SQL_SERVER ?? "").trim(),
    database: (process.env.ERYAZ_SQL_DATABASE ?? "GUCSAAS2026").trim(),
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: parseBoolean(process.env.ERYAZ_SQL_ENCRYPT ?? process.env.LOGO_SQL_ENCRYPT, false),
      trustServerCertificate: parseBoolean(
        process.env.ERYAZ_SQL_TRUST_SERVER_CERTIFICATE ?? process.env.LOGO_SQL_TRUST_SERVER_CERTIFICATE,
        true
      ),
    },
    requestTimeout: timeoutMs,
  };

  if (useTrustedConnection) {
    connection.driver = "msnodesqlv8";
    connection.options.trustedConnection = true;
  } else {
    connection.user = (process.env.ERYAZ_SQL_USER ?? process.env.LOGO_SQL_USER ?? "").trim();
    connection.password = process.env.ERYAZ_SQL_PASSWORD ?? process.env.LOGO_SQL_PASSWORD ?? "";
  }

  if (port !== undefined) connection.port = port;
  if (instanceName) connection.options.instanceName = instanceName;

  return {
    eryaz: {
      connection,
      useTrustedConnection,
      databases: parseDatabases(process.env.ERYAZ_PREVIOUS_PURCHASE_DATABASES),
    },
    sync: {
      url: explicitUrl ?? deriveSyncUrl(baseUrl) ?? "",
      key: (process.env.POWERSA_PREVIOUS_PURCHASES_SYNC_KEY ?? process.env.POWERSA_PRODUCTS_SYNC_KEY ?? process.env.POWERSA_SYNC_KEY ?? "").trim(),
      dealerId: parseInteger(process.env.POWERSA_DEALER_ID, undefined),
      batchSize: parseInteger(process.env.ERYAZ_PREVIOUS_PURCHASE_BATCH_SIZE, 1000),
      lookbackDays: parseInteger(process.env.ERYAZ_PREVIOUS_PURCHASE_LOOKBACK_DAYS, 3650),
    },
    stateFile: path.resolve(scriptDir, process.env.ERYAZ_PREVIOUS_PURCHASE_STATE_FILE ?? ".sync-state/previous-purchases-sync-state.json"),
  };
}

function validateConfig(current) {
  const missing = [];
  if (!current.eryaz.connection.server) missing.push("ERYAZ_SQL_SERVER or LOGO_SQL_SERVER");
  if (!current.eryaz.connection.database) missing.push("ERYAZ_SQL_DATABASE");
  if (!current.eryaz.useTrustedConnection && !current.eryaz.connection.user) missing.push("ERYAZ_SQL_USER or LOGO_SQL_USER");
  if (!current.eryaz.useTrustedConnection && !current.eryaz.connection.password) missing.push("ERYAZ_SQL_PASSWORD or LOGO_SQL_PASSWORD");
  if (!current.sync.url) missing.push("POWERSA_PREVIOUS_PURCHASES_SYNC_URL or POWERSA_SYNC_URL");
  if (!current.sync.key) missing.push("POWERSA_PREVIOUS_PURCHASES_SYNC_KEY or POWERSA_PRODUCTS_SYNC_KEY or POWERSA_SYNC_KEY");
  if (current.eryaz.databases.length === 0) missing.push("ERYAZ_PREVIOUS_PURCHASE_DATABASES");
  if (missing.length > 0) throw new Error(`missing required config: ${missing.join(", ")}`);
}

function parseDatabases(value) {
  const configured = nullable(value)
    ? String(value).split(",").map((item) => item.trim()).filter(Boolean)
    : Array.from({ length: 9 }, (_, index) => `GUCSAAS${2018 + index}`);

  return configured.filter((database) => {
    if (/^GUCSAAS\d{4}$/.test(database)) return true;
    console.warn(`[logo-previous-purchases-sync] unsafe database skipped: ${database}`);
    return false;
  });
}

function deriveSyncUrl(baseUrl) {
  if (!baseUrl) return null;
  return baseUrl.replace(/\/customers\/sync$/i, "/previous-purchases/sync");
}

function chunks(items, size) {
  const normalizedSize = Math.max(1, Math.min(5000, size));
  const result = [];
  for (let index = 0; index < items.length; index += normalizedSize) {
    result.push(items.slice(index, index + normalizedSize));
  }
  return result;
}

function sqlString(value) {
  return `N'${String(value).replaceAll("'", "''")}'`;
}

function string(value) {
  const normalized = value === undefined || value === null ? "" : String(value).trim();
  return normalized === "" ? null : normalized;
}

function numeric(value) {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? round(parsed) : 0;
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}

function formatDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
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

function writeStatus(partial) {
  const payload = {
    task: "previous-purchases-read",
    ...partial,
    updated_at: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
  fs.writeFileSync(config.stateFile, `${JSON.stringify(payload, null, 2)}\n`);
}
