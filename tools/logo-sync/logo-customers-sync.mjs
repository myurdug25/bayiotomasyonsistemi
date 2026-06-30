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

const config = buildConfig();
const startedAt = Date.now();

main().catch((error) => {
  console.error("[logo-sync] failed:", error instanceof Error ? error.message : error);
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
    const schema = await inspectCustomerTable(pool, config);
    console.log(
      `[logo-sync] discovered ${schema.columns.length} column(s) on ${config.logo.customerTable}`
    );

    const syncState = loadSyncState(config.sync.stateFile);
    const syncPlan = resolveSyncPlan(config, schema, syncState);

    console.log(`[logo-sync] mode=${syncPlan.mode}${syncPlan.reason ? ` reason=${syncPlan.reason}` : ""}`);
    if (syncPlan.mode === "delta") {
      console.log(
        `[logo-sync] delta cursor last_modified_at=${syncPlan.cursor.last_modified_at} last_logicalref=${syncPlan.cursor.last_logicalref}`
      );
      if (config.sync.lookbackSeconds > 0) {
        console.log(`[logo-sync] delta lookback seconds=${config.sync.lookbackSeconds}`);
      }
    }

    const rows = await fetchCustomers(pool, config, schema, syncPlan);
    console.log(`[logo-sync] fetched ${rows.length} customer row(s) from ${config.logo.customerTable}`);

    const records = rows.map((row) => mapCustomerRow(row, config.logo.customerTable, schema));
    const chunks = chunk(records, config.sync.batchSize);

    let sent = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const currentChunk = chunks[index];
      if (currentChunk.length === 0) {
        continue;
      }

      console.log(
        `[logo-sync] sending batch ${index + 1}/${chunks.length} with ${currentChunk.length} record(s)`
      );

      await pushBatch(currentChunk, config);
      sent += currentChunk.length;
    }

    if (schema.columnSet.has("CAPIBLOCK_MODIFIEDDATE") && rows.length > 0) {
      saveSyncState(
        config.sync.stateFile,
        buildSyncState(config, rows),
      );
    }

    const durationMs = Date.now() - startedAt;
    console.log(`[logo-sync] completed. sent=${sent} duration=${durationMs}ms`);
  } finally {
    await pool.close();
  }
}

function buildConfig() {
  const batchSize = parseInteger(process.env.SYNC_BATCH_SIZE, 500);
  const timeoutMs = parseInteger(process.env.LOGO_SQL_REQUEST_TIMEOUT_MS, 30000);
  const cardTypes = parseIntegerList(
    process.env.LOGO_CUSTOMER_CARDTYPES ?? process.env.LOGO_CUSTOMER_CARDTYPE,
    [1, 2, 3, 4]
  );
  const syncUrl =
    nullable(process.env.POWERSA_CUSTOMERS_SYNC_URL) ??
    nullable(process.env.POWERSA_SYNC_URL);
  const port = parseInteger(process.env.LOGO_SQL_PORT, undefined);
  const dealerId = parseInteger(process.env.POWERSA_DEALER_ID, undefined);
  const syncKey = (process.env.POWERSA_CUSTOMERS_SYNC_KEY ?? process.env.POWERSA_SYNC_KEY ?? "").trim();

  return {
    logo: {
      server: (process.env.LOGO_SQL_SERVER ?? "").trim(),
      instanceName: nullable(process.env.LOGO_SQL_INSTANCE),
      port,
      database: (process.env.LOGO_SQL_DATABASE ?? "").trim(),
      user: (process.env.LOGO_SQL_USER ?? "").trim(),
      password: process.env.LOGO_SQL_PASSWORD ?? "",
      encrypt: parseBoolean(process.env.LOGO_SQL_ENCRYPT, false),
      trustServerCertificate: parseBoolean(
        process.env.LOGO_SQL_TRUST_SERVER_CERTIFICATE,
        true
      ),
      requestTimeoutMs: timeoutMs,
      customerTable: nullable(process.env.LOGO_CUSTOMER_TABLE) ?? logoFirmTable("CLCARD"),
      customerCardTypes: cardTypes,
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
          trustServerCertificate: parseBoolean(
            process.env.LOGO_SQL_TRUST_SERVER_CERTIFICATE,
            true
          ),
          instanceName: nullable(process.env.LOGO_SQL_INSTANCE),
        },
        requestTimeout: timeoutMs,
      },
    },
    sync: {
      batchSize,
      url: syncUrl,
      key: syncKey,
      dealerId,
      dealerCode: nullable(process.env.POWERSA_DEALER_CODE),
      forceFull: parseBoolean(process.env.SYNC_FORCE_FULL, false),
      lookbackSeconds: parseInteger(process.env.SYNC_CUSTOMERS_LOOKBACK_SECONDS, 300),
      stateFile: path.resolve(scriptDir, process.env.SYNC_STATE_FILE ?? ".sync-state.json"),
    },
  };
}

function validateConfig(currentConfig) {
  const missing = [];

  if (!currentConfig.logo.server) missing.push("LOGO_SQL_SERVER");
  if (!currentConfig.logo.database) missing.push("LOGO_SQL_DATABASE");
  if (!currentConfig.logo.user) missing.push("LOGO_SQL_USER");
  if (!currentConfig.logo.password) missing.push("LOGO_SQL_PASSWORD");
  if (!currentConfig.sync.url) missing.push("POWERSA_CUSTOMERS_SYNC_URL or POWERSA_SYNC_URL");
  if (!currentConfig.sync.key) missing.push("POWERSA_CUSTOMERS_SYNC_KEY or POWERSA_SYNC_KEY");
  if (!currentConfig.sync.dealerId && !currentConfig.sync.dealerCode) {
    missing.push("POWERSA_DEALER_ID or POWERSA_DEALER_CODE");
  }

  if (missing.length > 0) {
    throw new Error(`missing required config: ${missing.join(", ")}`);
  }

  if (!/^[A-Za-z0-9_.\[\]]+$/.test(currentConfig.logo.customerTable)) {
    throw new Error("LOGO_CUSTOMER_TABLE contains unsupported characters");
  }

  if (currentConfig.sync.batchSize < 1 || currentConfig.sync.batchSize > 1000) {
    throw new Error("SYNC_BATCH_SIZE must be between 1 and 1000");
  }

  if (currentConfig.sync.lookbackSeconds < 0 || currentConfig.sync.lookbackSeconds > 86400) {
    throw new Error("SYNC_CUSTOMERS_LOOKBACK_SECONDS must be between 0 and 86400");
  }

  if (currentConfig.logo.port !== undefined) {
    currentConfig.logo.connection.port = currentConfig.logo.port;
  }
}

async function inspectCustomerTable(pool, currentConfig) {
  const [schemaName, tableName] = splitTableName(currentConfig.logo.customerTable);
  const result = await pool
    .request()
    .input("schemaName", sql.NVarChar(128), schemaName)
    .input("tableName", sql.NVarChar(128), tableName)
    .query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @schemaName
        AND TABLE_NAME = @tableName
      ORDER BY ORDINAL_POSITION
    `);

  const columns = (result.recordset ?? [])
    .map((row) => normalizeString(row.COLUMN_NAME))
    .filter(Boolean);

  if (columns.length === 0) {
    throw new Error(`Logo customer table not found: ${currentConfig.logo.customerTable}`);
  }

  return {
    schemaName,
    tableName,
    columns,
    columnSet: new Set(columns.map((column) => column.toUpperCase())),
  };
}

function resolveSyncPlan(currentConfig, schema, syncState) {
  if (!schema.columnSet.has("CAPIBLOCK_MODIFIEDDATE") || !schema.columnSet.has("LOGICALREF")) {
    return {
      mode: "full",
      reason: "CAPIBLOCK_MODIFIEDDATE_or_LOGICALREF_missing",
    };
  }

  if (currentConfig.sync.forceFull) {
    return {
      mode: "full",
      reason: "SYNC_FORCE_FULL",
    };
  }

  if (
    syncState &&
    syncState.database === currentConfig.logo.database &&
    syncState.customer_table === currentConfig.logo.customerTable &&
    typeof syncState.last_modified_at === "string" &&
    Number.isFinite(Number(syncState.last_logicalref))
  ) {
    return {
      mode: "delta",
      reason: "state_file",
      cursor: {
        last_modified_at: syncState.last_modified_at,
        last_logicalref: Number(syncState.last_logicalref),
      },
    };
  }

  return {
    mode: "full",
    reason: "initial_sync",
  };
}

async function fetchCustomers(pool, currentConfig, schema, syncPlan) {
  const request = pool.request();
  let query = `
    SELECT *
    FROM ${currentConfig.logo.customerTable}
    WHERE CARDTYPE IN (${currentConfig.logo.customerCardTypes.join(", ")})
  `;

  if (syncPlan.mode === "delta") {
    const lastModifiedAt = new Date(syncPlan.cursor.last_modified_at);
    const lookbackStart = subtractSeconds(lastModifiedAt, currentConfig.sync.lookbackSeconds);

    request.input("lookbackStart", sql.DateTime2, lookbackStart);
    request.input("lastLogicalRef", sql.Int, syncPlan.cursor.last_logicalref);
    query += `
      AND CAPIBLOCK_MODIFIEDDATE IS NOT NULL
      AND (
        CAPIBLOCK_MODIFIEDDATE >= @lookbackStart
        OR (CAPIBLOCK_MODIFIEDDATE = @lookbackStart AND LOGICALREF > @lastLogicalRef)
      )
      ORDER BY CAPIBLOCK_MODIFIEDDATE ASC, LOGICALREF ASC
    `;
  } else if (schema.columnSet.has("CAPIBLOCK_MODIFIEDDATE")) {
    query += `
      ORDER BY
        CASE WHEN CAPIBLOCK_MODIFIEDDATE IS NULL THEN 0 ELSE 1 END ASC,
        CAPIBLOCK_MODIFIEDDATE ASC,
        LOGICALREF ASC
    `;
  } else {
    query += `
      ORDER BY LOGICALREF ASC
    `;
  }

  const result = await request.query(query);
  return result.recordset ?? [];
}

function mapCustomerRow(row, customerTable, schema) {
  const address = [readFirst(row, ["address_1", "address1", "ADDR1", "ADDRESS1"]), readFirst(row, ["address_2", "address2", "ADDR2", "ADDRESS2"])]
    .map((value) => normalizeString(value))
    .filter(Boolean)
    .join(" ");

  const rawRecord = extractRawLogoRecord(row, schema.columns);
  const code = normalizeString(readFirst(row, ["code", "CODE"]));
  const name = resolveCustomerTitle(row, code);

  return {
    external_ref: normalizeString(readFirst(row, ["external_ref", "LOGICALREF"])),
    code,
    name,
    contact_name: normalizeString(readFirst(row, ["contact_name", "incharge", "INCHARGE"])),
    email: normalizeEmail(readFirst(row, ["email", "emailaddr", "EMAILADDR"])),
    phone: normalizeString(readFirst(row, ["phone", "phone_1", "telephone", "mobile_phone", "telnrs1", "TELNRS1", "TELNR1", "PHONE", "PHONE1", "PHONE_1", "TELEFON", "TELEFON1", "GSM", "CEPTEL"])),
    city: normalizeString(readFirst(row, ["city", "CITY", "IL", "İL", "PROVINCE", "SEHIR", "ŞEHİR"])),
    district: normalizeString(readFirst(row, ["district", "town", "TOWN", "DISTRICT", "ILCE", "İLÇE", "COUNTY", "ILÇE", "ILCE_ADI", "İLÇE_ADI"])),
    tax_office: normalizeString(readFirst(row, ["tax_office", "taxoffice", "TAXOFFICE"])),
    tax_number: normalizeString(readFirst(row, ["tax_number", "taxnr", "tckno", "TAXNR", "TCKNO"])),
    balance_due: normalizeDecimal(readFirst(row, ["balance_due", "BALANCE_DUE", "total_due", "TOTAL_DUE"])),
    order_due: normalizeDecimal(readFirst(row, ["order_due", "ORDER_DUE", "open_order_due", "OPEN_ORDER_DUE"])),
    currency: normalizeString(readFirst(row, ["currency", "CURRENCY"])) ?? "TRY",
    address: address || null,
    is_active: Number(readFirst(row, ["active", "ACTIVE"]) ?? 0) === 0,
    meta: {
      logo_table: customerTable,
      cardtype: normalizeInteger(readFirst(row, ["cardtype", "CARDTYPE"])),
      phone_2: normalizeString(readFirst(row, ["phone_2", "telnrs2", "TELNRS2", "TELNR2", "PHONE2", "PHONE_2", "TELEFON2"])),
      fax: normalizeString(readFirst(row, ["fax", "faxnr", "FAXNR"])),
      website: normalizeString(readFirst(row, ["website", "webaddr", "WEBADDR"])),
      postcode: normalizeString(readFirst(row, ["postcode", "POSTCODE"])),
      district_name: normalizeString(readFirst(row, ["district_name", "district", "DISTRICT"])),
      town: normalizeString(readFirst(row, ["town", "TOWN"])),
      country: normalizeString(readFirst(row, ["country", "COUNTRY"])),
      country_code: normalizeString(readFirst(row, ["country_code", "countrycode", "COUNTRYCODE"])),
      city_code: normalizeString(readFirst(row, ["city_code", "citycode", "CITYCODE"])),
      town_code: normalizeString(readFirst(row, ["town_code", "towncode", "TOWNCODE"])),
      trading_group: normalizeString(readFirst(row, ["trading_group", "tradinggrp", "TRADINGGRP"])),
      specode: normalizeString(readFirst(row, ["specode", "SPECODE"])),
      specode2: normalizeString(readFirst(row, ["specode2", "SPECODE2"])),
      specode3: normalizeString(readFirst(row, ["specode3", "SPECODE3"])),
      specode4: normalizeString(readFirst(row, ["specode4", "SPECODE4"])),
      specode5: normalizeString(readFirst(row, ["specode5", "SPECODE5"])),
      cyphcode: normalizeString(readFirst(row, ["cyphcode", "CYPHCODE"])),
      payment_ref: normalizeString(readFirst(row, ["payment_ref", "paymentref", "PAYMENTREF"])),
      discount_rate: normalizeDecimal(readFirst(row, ["discount_rate", "DISCRATE"])),
      exten_ref: normalizeString(readFirst(row, ["exten_ref", "EXTENREF"])),
      vat_number: normalizeString(readFirst(row, ["vat_number", "VATNR"])),
      warn_method: normalizeInteger(readFirst(row, ["warn_method", "WARNMETHOD"])),
      warn_email: normalizeString(readFirst(row, ["warn_email", "WARNEMAILADDR"])),
      warn_fax: normalizeString(readFirst(row, ["warn_fax", "WARNFAXNR"])),
      language: normalizeInteger(readFirst(row, ["language", "CLANGUAGE"])),
      blocked: normalizeInteger(readFirst(row, ["blocked", "BLOCKED"])),
      delivery_method: normalizeString(readFirst(row, ["delivery_method", "DELIVERYMETHOD"])),
      delivery_firm: normalizeString(readFirst(row, ["delivery_firm", "DELIVERYFIRM"])),
      currency_code: normalizeInteger(readFirst(row, ["currency_code", "CCURRENCY"])),
      textinc: normalizeInteger(readFirst(row, ["textinc", "TEXTINC"])),
      site_id: normalizeString(readFirst(row, ["site_id", "SITEID"])),
      org_logic_ref: normalizeString(readFirst(row, ["org_logic_ref", "ORGLOGICREF"])),
      edino: normalizeString(readFirst(row, ["edino", "EDINO"])),
      bank_branches: collectSequentialValues(row, "BANKBRANCHS", 7),
      bank_accounts: collectSequentialValues(row, "BANKACCOUNTS", 7),
      source_created_date: readFirst(row, ["source_created_date", "capiblock_createddate", "CAPIBLOCK_CREATEDDATE"]) ?? null,
      source_modified_date: readFirst(row, ["source_modified_date", "capiblock_modifieddate", "CAPIBLOCK_MODIFIEDDATE"]) ?? null,
      raw: rawRecord,
    },
  };
}

function resolveCustomerTitle(row, code) {
  const aliases = [
    "DEFINITION_",
    "DEFINITION",
    "DESCRIPTION",
    "DESC_",
    "DESC",
    "ACIKLAMA",
    "AÇIKLAMA",
    "TITLE",
    "UNVAN",
    "name",
    "NAME",
  ];
  const normalizedCode = normalizeComparable(code);
  let codeLikeFallback = null;

  for (const alias of aliases) {
    const title = normalizeString(readFirst(row, [alias]));
    if (title === null) {
      continue;
    }

    if (normalizedCode !== null && normalizeComparable(title) === normalizedCode) {
      codeLikeFallback ??= title;
      continue;
    }

    return title;
  }

  return codeLikeFallback ?? code ?? "Logo Cari";
}

function collectSequentialValues(row, prefix, count) {
  const values = [];

  for (let index = 1; index <= count; index += 1) {
    const value = normalizeString(readFirst(row, [`${prefix}${index}`, `${prefix}_${index}`]));
    if (value !== null) {
      values.push({
        index,
        value,
      });
    }
  }

  return values;
}

function splitTableName(tableName) {
  const normalized = String(tableName ?? "").trim();
  const parts = normalized.split(".");

  if (parts.length === 1) {
    return ["dbo", stripBrackets(parts[0])];
  }

  const schemaName = stripBrackets(parts[parts.length - 2]);
  const objectName = stripBrackets(parts[parts.length - 1]);
  return [schemaName || "dbo", objectName];
}

function stripBrackets(value) {
  return String(value ?? "").replace(/^\[|\]$/g, "");
}

function readFirst(record, aliases) {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(record, alias)) {
      return record[alias];
    }

    const matchingKey = Object.keys(record).find(
      (key) => key.toUpperCase() === String(alias).toUpperCase()
    );

    if (matchingKey) {
      return record[matchingKey];
    }
  }

  return null;
}

function extractRawLogoRecord(row, columns) {
  const payload = {};

  for (const column of columns) {
    if (!Object.prototype.hasOwnProperty.call(row, column)) {
      continue;
    }

    const value = normalizeValue(row[column]);
    if (value === null || value === "") {
      continue;
    }

    payload[column] = value;
  }

  return payload;
}

function loadSyncState(stateFile) {
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (error) {
    console.warn(
      `[logo-sync] could not parse sync state ${stateFile}: ${error instanceof Error ? error.message : error}`
    );
    return null;
  }
}

function saveSyncState(stateFile, state) {
  const directory = path.dirname(stateFile);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  console.log(`[logo-sync] state saved to ${stateFile}`);
}

function buildSyncState(currentConfig, rows) {
  const lastRow = rows[rows.length - 1];
  const lastModifiedAt = normalizeValue(
    readFirst(lastRow, ["CAPIBLOCK_MODIFIEDDATE", "capiblock_modifieddate", "source_modified_date"])
  );
  const lastLogicalRef = Number(readFirst(lastRow, ["LOGICALREF", "logicalref", "external_ref"]) ?? 0);

  return {
    database: currentConfig.logo.database,
    customer_table: currentConfig.logo.customerTable,
    last_modified_at: lastModifiedAt,
    last_logicalref: Number.isFinite(lastLogicalRef) ? lastLogicalRef : 0,
    saved_at: new Date().toISOString(),
  };
}

function normalizeValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized === "" ? null : normalized;
  }

  return value;
}

async function pushBatch(records, currentConfig) {
  const payload = {
    records,
  };

  if (currentConfig.sync.dealerId) {
    payload.dealer_id = currentConfig.sync.dealerId;
  } else if (currentConfig.sync.dealerCode) {
    payload.dealer_code = currentConfig.sync.dealerCode;
  }

  const response = await fetch(currentConfig.sync.url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-integration-key": currentConfig.sync.key,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? JSON.stringify(await response.json())
      : await response.text();

    throw new Error(`sync endpoint returned ${response.status}: ${body}`);
  }

  const body = await response.json();
  console.log("[logo-sync] sync response:", JSON.stringify(body.summary ?? body));
}

function chunk(items, size) {
  const result = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

function subtractSeconds(value, seconds) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()) || seconds <= 0) {
    return date;
  }

  return new Date(date.getTime() - seconds * 1000);
}

function normalizeString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function normalizeComparable(value) {
  const normalized = normalizeString(value);
  return normalized === null ? null : normalized.toLocaleUpperCase("tr-TR");
}

function normalizeEmail(value) {
  const normalized = normalizeString(value);
  if (normalized === null) {
    return null;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

function normalizeDecimal(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = Number.parseFloat(String(value).replace(",", "."));
  return Number.isFinite(normalized) ? normalized : null;
}

function normalizeInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = Number.parseInt(String(value), 10);
  return Number.isFinite(normalized) ? normalized : null;
}

function parseInteger(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIntegerList(value, fallback = []) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return [...fallback];
  }

  const parsed = String(value)
    .split(",")
    .map((item) => normalizeInteger(item))
    .filter((item) => item !== null);

  return parsed.length > 0 ? parsed : [...fallback];
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function nullable(value) {
  const normalized = normalizeString(value);
  return normalized === null ? null : normalized;
}
