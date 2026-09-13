#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import defaultSql from "mssql";

import { sendLedgerRecords } from "./eryaz-ledger-http.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(scriptDir, ".env");

if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

const config = buildConfig();
const sql = config.eryaz.useTrustedConnection
  ? (await import("mssql/msnodesqlv8.js")).default
  : defaultSql;

main().catch((error) => {
  console.error("[eryaz-ledger-sync] failed:", error instanceof Error ? error.message : error);
  writeStatus({ ok: false, last_error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});

async function main() {
  validateConfig(config);

  const startedAt = Date.now();
  const state = loadJson(config.sync.stateFile);
  const since = resolveSince(state);

  console.log(
    `[eryaz-ledger-sync] connecting to ${config.eryaz.connection.server}/${config.eryaz.connection.database}`
  );

  const pool = new sql.ConnectionPool(config.eryaz.connection);
  await pool.connect();

  let readCount = 0;
  let sentCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const errors = [];
  let databases = config.eryaz.databases;

  try {
    if (databases.length === 0) {
      databases = await discoverDatabases(pool, config.sync.startYear);
    }

    if (databases.length === 0) {
      throw new Error(`No GUCSAAS database found from ${config.sync.startYear}`);
    }

    for (const database of databases) {
      console.log(`[eryaz-ledger-sync] reading ${database} since ${formatDate(since)}`);

      try {
        const schema = await inspectTable(pool, database, "TBLCAHAR");
        const rows = await readDatabase(pool, database, schema, since);
        readCount += rows.length;

        const records = [];
        for (const row of rows) {
          const record = normalizeRecord(database, row);
          if (record) {
            records.push(record);
          } else {
            skippedCount += 1;
          }
        }

        console.log(
          `[eryaz-ledger-sync] ${database} read=${rows.length} normalized=${records.length} skipped=${rows.length - records.length}`
        );

        if (!config.sync.dryRun) {
          sentCount += await sendLedgerRecords(records, {
            url: config.sync.url,
            key: config.sync.key,
            dealerId: config.sync.dealerId,
            dealerCode: config.sync.dealerCode,
            batchSize: config.sync.batchSize,
            minBatchSize: config.sync.minBatchSize,
            retryMax: config.sync.retryMax,
            retryBaseDelayMs: config.sync.retryBaseDelayMs,
            log: (message) => console.warn(message),
          });
        } else {
          sentCount += records.length;
        }

        console.log(`[eryaz-ledger-sync] ${database} sent=${records.length}`);
      } catch (error) {
        errorCount += 1;
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ database, message });
        if (!config.sync.continueOnError) throw error;
        console.warn(`[eryaz-ledger-sync] skipped ${database}: ${message}`);
      }
    }
  } finally {
    await pool.close();
  }

  const now = new Date().toISOString();
  const ok = errorCount === 0;
  const payload = {
    ok,
    dry_run: config.sync.dryRun,
    last_run_at: now,
    last_success_at: ok ? now : state?.last_success_at ?? null,
    duration_ms: Date.now() - startedAt,
    source_databases: databases,
    start_date: config.sync.startDate,
    since: formatDate(since),
    read_count: readCount,
    synced_count: sentCount,
    skipped_count: skippedCount,
    error_count: errorCount,
    errors,
    last_error: errors.at(-1)?.message ?? null,
  };

  writeStatus(payload);

  console.log(
    `[eryaz-ledger-sync] completed read=${readCount} synced=${sentCount} skipped=${skippedCount} errors=${errorCount} duration=${Date.now() - startedAt}ms`
  );
}

async function discoverDatabases(pool, startYear) {
  const result = await pool.request().input("startYear", sql.Int, startYear).query(`
    SELECT name
    FROM sys.databases
    WHERE name LIKE 'GUCSAAS[0-9][0-9][0-9][0-9]'
      AND RIGHT(name, 4) >= RIGHT('0000' + CONVERT(varchar(4), @startYear), 4)
    ORDER BY name;
  `);

  return (result.recordset ?? [])
    .map((row) => string(row.name))
    .filter((name) => name && /^GUCSAAS\d{4}$/.test(name));
}

async function inspectTable(pool, database, tableName) {
  assertSafeDatabase(database);

  const result = await pool
    .request()
    .input("tableName", sql.NVarChar(128), tableName)
    .query(`
      SELECT COLUMN_NAME
      FROM [${database}].INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'dbo'
        AND TABLE_NAME = @tableName
      ORDER BY ORDINAL_POSITION;
    `);

  const columns = (result.recordset ?? [])
    .map((row) => string(row.COLUMN_NAME))
    .filter(Boolean);

  if (columns.length === 0) {
    throw new Error(`${database}.dbo.${tableName} not found`);
  }

  return {
    columns,
    columnSet: new Set(columns.map((column) => column.toUpperCase())),
  };
}

async function readDatabase(pool, database, schema, since) {
  assertSafeDatabase(database);

  const customerColumn = requireColumn(schema, ["CARI_KOD", "CARI_KODU"]);
  const dateColumn = requireColumn(schema, ["TARIH", "HAREKET_TARIHI", "KAYIT_TARIHI"]);
  const debitColumn = requireColumn(schema, ["BORC", "BORÇ", "BORC_TUTAR", "BORCTUTAR"]);
  const creditColumn = requireColumn(schema, ["ALACAK", "ALACAK_TUTAR", "ALACAKTUTAR"]);

  const referenceColumn = findColumn(schema, ["BELGE_NO", "FISNO", "FICHENO", "EVRAKNO", "EVRAK_NO"]);
  const descriptionColumn = findColumn(schema, ["ACIKLAMA", "ACIKLAMA1", "DESCRIPTION"]);
  const movementColumn = findColumn(schema, ["HAREKET_TURU", "CARI_HAREKET_TIPI", "ISLEM_TURU", "TIP"]);
  const currencyColumn = findColumn(schema, ["DOVIZ_TURU", "DOVIZTIP", "DOVIZ"]);
  const lineRefColumn = findColumn(schema, ["INCKEYNO", "REC_ID", "KAYITNO", "SIRA", "ID"]);

  const request = pool.request();
  request.input("since", sql.DateTime, since);

  const result = await request.query(`
    SELECT
      ${sqlString(database)} AS SOURCE_DATABASE,
      ${column(customerColumn)} AS CUSTOMER_CODE,
      ${column(dateColumn)} AS ENTRY_DATE,
      ${column(debitColumn)} AS DEBIT_AMOUNT,
      ${column(creditColumn)} AS CREDIT_AMOUNT,
      ${optionalColumn(referenceColumn, "nvarchar(120)")} AS REFERENCE_NO,
      ${optionalColumn(descriptionColumn, "nvarchar(2000)")} AS DESCRIPTION,
      ${optionalColumn(movementColumn, "nvarchar(120)")} AS RAW_TYPE,
      ${optionalColumn(currencyColumn, "nvarchar(30)")} AS RAW_CURRENCY,
      ${optionalColumn(lineRefColumn, "nvarchar(120)")} AS LINE_REF
    FROM [${database}].dbo.TBLCAHAR WITH (NOLOCK)
    WHERE ${column(dateColumn)} >= @since
      AND ISNULL(${column(customerColumn)}, '') <> ''
      AND (ISNULL(${column(debitColumn)}, 0) <> 0 OR ISNULL(${column(creditColumn)}, 0) <> 0)
    ORDER BY ${column(dateColumn)} ASC${lineRefColumn ? `, ${column(lineRefColumn)} ASC` : ""};
  `);

  return result.recordset ?? [];
}

function normalizeRecord(database, row) {
  const customerCode = string(row.CUSTOMER_CODE);
  const date = formatDate(row.ENTRY_DATE);
  const debit = numeric(row.DEBIT_AMOUNT);
  const credit = numeric(row.CREDIT_AMOUNT);

  if (!customerCode || !date) return null;

  const normalizedAmounts = normalizeAmounts(debit, credit);
  if (normalizedAmounts.debit <= 0 && normalizedAmounts.credit <= 0) return null;

  const referenceNo = string(row.REFERENCE_NO);
  const description = string(row.DESCRIPTION);
  const lineRef = string(row.LINE_REF);
  const rawReference = [
    "eryaz-ledger",
    database,
    customerCode,
    date,
    referenceNo ?? "",
    lineRef ?? "",
    normalizedAmounts.debit,
    normalizedAmounts.credit,
  ].join("|");
  const externalRef = `ERYAZLED|${database}|${sha1(rawReference)}`;

  return {
    customer_code: customerCode,
    external_ref: externalRef,
    date,
    type: normalizedAmounts.debit > 0 ? "debit" : "credit",
    debit: normalizedAmounts.debit,
    credit: normalizedAmounts.credit,
    currency: resolveCurrency(row.RAW_CURRENCY, customerCode),
    reference_no: referenceNo,
    description,
    meta: {
      source: "eryaz_tblcahar",
      source_database: string(row.SOURCE_DATABASE) ?? database,
      source_table: "TBLCAHAR",
      raw_type: string(row.RAW_TYPE),
      raw_currency: string(row.RAW_CURRENCY),
      raw_external_ref: rawReference,
      line_ref: lineRef,
    },
  };
}

function buildConfig() {
  const timeoutMs = parseInteger(process.env.ERYAZ_SQL_REQUEST_TIMEOUT_MS ?? process.env.LOGO_SQL_REQUEST_TIMEOUT_MS, 120000);
  const port = parseInteger(process.env.ERYAZ_SQL_PORT ?? process.env.LOGO_SQL_PORT, undefined);
  const instanceName = nullable(process.env.ERYAZ_SQL_INSTANCE ?? process.env.LOGO_SQL_INSTANCE);
  const startDate = nullable(process.env.ERYAZ_LEDGER_START_DATE) ?? "2016-01-01";
  const explicitUrl = nullable(process.env.POWERSA_ERYAZ_LEDGER_SYNC_URL);
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
      databases: parseDatabases(process.env.ERYAZ_LEDGER_DATABASES),
    },
    sync: {
      url: explicitUrl ?? "",
      key: (process.env.POWERSA_ERYAZ_LEDGER_SYNC_KEY ?? process.env.POWERSA_LEDGER_SYNC_KEY ?? process.env.POWERSA_SYNC_KEY ?? "").trim(),
      dealerId: parseInteger(process.env.POWERSA_DEALER_ID, undefined),
      dealerCode: nullable(process.env.POWERSA_DEALER_CODE),
      batchSize: parseInteger(process.env.ERYAZ_LEDGER_BATCH_SIZE, 1000),
      minBatchSize: parseInteger(process.env.ERYAZ_LEDGER_MIN_BATCH_SIZE, 1),
      retryMax: parseInteger(process.env.ERYAZ_LEDGER_RETRY_MAX, 2),
      retryBaseDelayMs: parseInteger(process.env.ERYAZ_LEDGER_RETRY_BASE_DELAY_MS, 2000),
      startDate,
      startYear: Number(startDate.slice(0, 4)) || 2016,
      incrementalDays: parseInteger(process.env.ERYAZ_LEDGER_INCREMENTAL_DAYS, 45),
      forceFull: parseBoolean(process.env.ERYAZ_LEDGER_FORCE_FULL, false),
      dryRun: parseBoolean(process.env.ERYAZ_LEDGER_DRY_RUN, false),
      continueOnError: parseBoolean(process.env.ERYAZ_LEDGER_CONTINUE_ON_ERROR, true),
      batumGelPrefixes: parseList(process.env.ERYAZ_LEDGER_BATUM_GEL_PREFIXES ?? "120-00"),
      stateFile: path.resolve(scriptDir, process.env.ERYAZ_LEDGER_STATE_FILE ?? ".sync-state/eryaz-ledger-sync-state.json"),
    },
  };
}

function validateConfig(current) {
  const missing = [];
  if (!current.eryaz.connection.server) missing.push("ERYAZ_SQL_SERVER or LOGO_SQL_SERVER");
  if (!current.eryaz.connection.database) missing.push("ERYAZ_SQL_DATABASE");
  if (!current.eryaz.useTrustedConnection && !current.eryaz.connection.user) missing.push("ERYAZ_SQL_USER or LOGO_SQL_USER");
  if (!current.eryaz.useTrustedConnection && !current.eryaz.connection.password) missing.push("ERYAZ_SQL_PASSWORD or LOGO_SQL_PASSWORD");
  if (!current.sync.url) missing.push("POWERSA_ERYAZ_LEDGER_SYNC_URL");
  if (!current.sync.key) missing.push("POWERSA_ERYAZ_LEDGER_SYNC_KEY, POWERSA_LEDGER_SYNC_KEY or POWERSA_SYNC_KEY");
  if (!current.sync.dealerId && !current.sync.dealerCode) missing.push("POWERSA_DEALER_ID or POWERSA_DEALER_CODE");
  if (missing.length > 0) throw new Error(`missing required config: ${missing.join(", ")}`);
}

function resolveSince(state) {
  const start = parseDate(config.sync.startDate);

  if (config.sync.forceFull || !state?.last_success_at) {
    return start;
  }

  const lookback = new Date(Date.now() - config.sync.incrementalDays * 24 * 60 * 60 * 1000);
  return lookback > start ? lookback : start;
}

function parseDatabases(value) {
  return parseList(value).filter((database) => {
    if (/^GUCSAAS\d{4}$/.test(database)) return true;
    console.warn(`[eryaz-ledger-sync] unsafe database skipped: ${database}`);
    return false;
  });
}

function parseList(value) {
  return nullable(value)
    ? String(value).split(",").map((item) => item.trim()).filter(Boolean)
    : [];
}

function findColumn(schema, candidates) {
  for (const candidate of candidates) {
    const found = schema.columns.find((columnName) => columnName.toUpperCase() === candidate.toUpperCase());
    if (found) return found;
  }

  return null;
}

function requireColumn(schema, candidates) {
  const found = findColumn(schema, candidates);
  if (!found) throw new Error(`TBLCAHAR missing required column: ${candidates.join(" or ")}`);
  return found;
}

function optionalColumn(columnName, castType) {
  return columnName ? column(columnName) : `CAST(NULL AS ${castType})`;
}

function column(columnName) {
  return `[${String(columnName).replaceAll("]", "]]")}]`;
}

function assertSafeDatabase(database) {
  if (!/^GUCSAAS\d{4}$/.test(database)) {
    throw new Error(`unsafe database name: ${database}`);
  }
}

function normalizeAmounts(debit, credit) {
  const debitAmount = Math.max(0, numeric(debit));
  const creditAmount = Math.max(0, numeric(credit));

  if (debitAmount > 0 && creditAmount > 0) {
    const net = round(debitAmount - creditAmount);
    return net >= 0 ? { debit: net, credit: 0 } : { debit: 0, credit: Math.abs(net) };
  }

  return { debit: debitAmount, credit: creditAmount };
}

function resolveCurrency(rawCurrency, customerCode) {
  const raw = string(rawCurrency)?.toUpperCase();
  if (raw) {
    if (["TRY", "TRL", "TL", "0"].includes(raw)) return "TRY";
    if (["GEL", "LARI"].includes(raw)) return "GEL";
    if (["USD", "DOLAR", "DOLLAR", "1"].includes(raw)) return "USD";
    if (["EUR", "EURO", "2"].includes(raw)) return "EUR";
  }

  if (config.sync.batumGelPrefixes.some((prefix) => customerCode.startsWith(prefix))) {
    return "GEL";
  }

  return "TRY";
}

function deriveLedgerSyncUrl(baseUrl) {
  if (!baseUrl) return null;
  return baseUrl.replace(/\/customers\/sync$/i, "/ledger/sync");
}

function chunks(items, size) {
  const normalizedSize = Math.max(1, Math.min(1000, size));
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

function parseDate(value) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return new Date("2016-01-01T00:00:00");
  return date;
}

function formatDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeStatus(partial) {
  const payload = {
    task: "eryaz-ledger-read",
    ...partial,
    updated_at: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(config.sync.stateFile), { recursive: true });
  fs.writeFileSync(config.sync.stateFile, `${JSON.stringify(payload, null, 2)}\n`);
}
