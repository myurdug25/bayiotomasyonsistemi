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

const referenceColumnCandidates = [
  "PARLOGREF",
  "ITEMREF",
  "CARDREF",
  "STOCKREF",
  "PRODUCTREF",
  "INFOREF",
  "LOGICALREF",
];
const warehouseColumnCandidates = [
  "INVENNO",
  "WAREHOUSE_NO",
  "WAREHOUSE",
  "WHNO",
  "AMBARNO",
  "AMBAR_NO",
  "DEPO_NO",
  "DEPOKODU",
  "DEPONO",
];
const genericShelfColumnCandidates = [
  "RAF",
  "RAF_ADRESI",
  "RAFADRESI",
  "RAF_KODU",
  "RAFKODU",
  "RAF_BILGISI",
  "RAFBILGISI",
  "RAF_BILGILERI",
  "RAFBILGILERI",
  "SHELF",
  "SHELF_ADDRESS",
  "LOCATION",
  "LOCATION_CODE",
  "ADDRESS",
  "ADRES",
];

const config = buildConfig();
const startedAt = Date.now();

main().catch((error) => {
  console.error("[logo-sync] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  validateConfig(config);

  const pendingPayload = await fetchPendingShelves(config);
  const records = Array.isArray(pendingPayload.records) ? pendingPayload.records : [];
  console.log(`[logo-sync] fetched ${records.length} pending product shelf update(s) from B2B`);

  if (records.length === 0) {
    console.log(`[logo-sync] completed. exported=0 duration=${Date.now() - startedAt}ms`);
    return;
  }

  console.log(
    `[logo-sync] connecting to ${config.logo.server}${config.logo.instanceName ? `\\${config.logo.instanceName}` : ""}/${config.logo.database}`
  );

  const pool = new sql.ConnectionPool(config.logo.connection);
  await pool.connect();

  try {
    const productSchema = await inspectTable(pool, config.logo.productTable, true);
    const rafSchema = config.logo.productRafTable
      ? await inspectTable(pool, config.logo.productRafTable, true)
      : null;

    console.log(
      `[logo-sync] discovered ${productSchema.columns.length} column(s) on ${productSchema.qualifiedName}`
    );
    if (rafSchema) {
      console.log(
        `[logo-sync] discovered ${rafSchema.columns.length} column(s) on ${rafSchema.qualifiedName}`
      );
    }

    const acknowledgements = [];

    for (const record of records) {
      try {
        const result = await exportProductShelf(pool, config, productSchema, rafSchema, record);
        acknowledgements.push({
          product_id: record.product_id,
          status: "synced",
          external_ref: result.externalRef,
          warehouse_code: nullable(record.warehouse_code),
          shelf_address: nullable(record.shelf_address),
        });
        console.log(
          `[logo-sync] exported product_shelf product_id=${record.product_id} code=${record.product_code ?? "-"} warehouse=${record.warehouse_code ?? "-"} external_ref=${result.externalRef}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        acknowledgements.push({
          product_id: record.product_id,
          status: "failed",
          error: message.slice(0, 1000),
          warehouse_code: nullable(record.warehouse_code),
          shelf_address: nullable(record.shelf_address),
        });
        console.warn(
          `[logo-sync] product shelf export failed product_id=${record.product_id}: ${message}`
        );
      }
    }

    await acknowledgeShelves(config, acknowledgements);

    console.log(
      `[logo-sync] completed. exported=${acknowledgements.filter((item) => item.status === "synced").length} failed=${acknowledgements.filter((item) => item.status === "failed").length} duration=${Date.now() - startedAt}ms`
    );
  } finally {
    await pool.close();
  }
}

function buildConfig() {
  const timeoutMs = parseInteger(process.env.LOGO_SQL_REQUEST_TIMEOUT_MS, 30000);
  const port = parseInteger(process.env.LOGO_SQL_PORT, undefined);
  const pendingUrl =
    nullable(process.env.POWERSA_PRODUCT_SHELVES_PENDING_URL) ??
    deriveProductShelvesPendingUrl(process.env.POWERSA_SYNC_URL);
  const ackUrl =
    nullable(process.env.POWERSA_PRODUCT_SHELVES_ACK_URL) ??
    deriveProductShelvesAckUrl(process.env.POWERSA_SYNC_URL);
  const syncKey = (
    process.env.POWERSA_PRODUCT_SHELVES_SYNC_KEY ??
    process.env.POWERSA_PRODUCTS_SYNC_KEY ??
    process.env.POWERSA_SYNC_KEY ??
    ""
  ).trim();
  const productTable =
    nullable(process.env.LOGO_PRODUCT_TABLE) ?? `dbo.LG_${firmNo()}_ITEMS`;

  return {
    logo: {
      server: (process.env.LOGO_SQL_SERVER ?? "").trim(),
      instanceName: nullable(process.env.LOGO_SQL_INSTANCE),
      port,
      database: (process.env.LOGO_SQL_DATABASE ?? "").trim(),
      user: (process.env.LOGO_SQL_USER ?? "").trim(),
      password: process.env.LOGO_SQL_PASSWORD ?? "",
      productTable,
      productRafTable: nullable(process.env.LOGO_PRODUCT_RAF_TABLE),
      warehouseRafKeyMap: parseWarehouseRafKeyMap(process.env.LOGO_WAREHOUSE_RAF_KEY_MAP),
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
      pendingUrl: pendingUrl ?? "",
      ackUrl: ackUrl ?? "",
      key: syncKey,
      apiTimeoutMs: parseInteger(process.env.LOGO_API_REQUEST_TIMEOUT_MS, 15000),
      dealerId: parseInteger(process.env.POWERSA_DEALER_ID, undefined),
      dealerCode: nullable(process.env.POWERSA_DEALER_CODE),
      limit: parseInteger(process.env.POWERSA_PRODUCT_SHELVES_LIMIT, 100),
    },
  };
}

function validateConfig(currentConfig) {
  const missing = [];

  if (!currentConfig.logo.server) missing.push("LOGO_SQL_SERVER");
  if (!currentConfig.logo.database) missing.push("LOGO_SQL_DATABASE");
  if (!currentConfig.logo.user) missing.push("LOGO_SQL_USER");
  if (!currentConfig.logo.password) missing.push("LOGO_SQL_PASSWORD");
  if (!currentConfig.logo.productTable) missing.push("LOGO_PRODUCT_TABLE or LOGO_FIRM_NO");
  if (!currentConfig.sync.pendingUrl) missing.push("POWERSA_PRODUCT_SHELVES_PENDING_URL or POWERSA_SYNC_URL");
  if (!currentConfig.sync.ackUrl) missing.push("POWERSA_PRODUCT_SHELVES_ACK_URL or POWERSA_SYNC_URL");
  if (!currentConfig.sync.key) missing.push("POWERSA_PRODUCT_SHELVES_SYNC_KEY or POWERSA_SYNC_KEY");

  if (missing.length > 0) {
    throw new Error(`missing required config: ${missing.join(", ")}`);
  }

  validateQualifiedName(currentConfig.logo.productTable, "LOGO_PRODUCT_TABLE");
  if (currentConfig.logo.productRafTable) {
    validateQualifiedName(currentConfig.logo.productRafTable, "LOGO_PRODUCT_RAF_TABLE");
  }

  if (currentConfig.logo.port !== undefined) {
    currentConfig.logo.connection.port = currentConfig.logo.port;
  }
}

async function fetchPendingShelves(currentConfig) {
  const query = new URLSearchParams();
  query.set("limit", String(currentConfig.sync.limit));

  if (currentConfig.sync.dealerId) {
    query.set("dealer_id", String(currentConfig.sync.dealerId));
  } else if (currentConfig.sync.dealerCode) {
    query.set("dealer_code", currentConfig.sync.dealerCode);
  }

  const url = `${currentConfig.sync.pendingUrl}${currentConfig.sync.pendingUrl.includes("?") ? "&" : "?"}${query.toString()}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-integration-key": currentConfig.sync.key,
    },
    signal: AbortSignal.timeout(currentConfig.sync.apiTimeoutMs),
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? JSON.stringify(await response.json())
      : await response.text();

    throw new Error(`pending endpoint returned ${response.status}: ${body}`);
  }

  return response.json();
}

async function acknowledgeShelves(currentConfig, records) {
  if (!Array.isArray(records) || records.length === 0) {
    return;
  }

  const response = await fetch(currentConfig.sync.ackUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-integration-key": currentConfig.sync.key,
    },
    body: JSON.stringify({ records }),
    signal: AbortSignal.timeout(currentConfig.sync.apiTimeoutMs),
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? JSON.stringify(await response.json())
      : await response.text();

    throw new Error(`ack endpoint returned ${response.status}: ${body}`);
  }

  console.log(`[logo-sync] ack response: ${JSON.stringify(await response.json())}`);
}

async function exportProductShelf(pool, currentConfig, productSchema, rafSchema, record) {
  const product = await resolveProduct(pool, productSchema, record);
  const warehouseCode = normalizeString(record.warehouse_code);
  const shelfAddress = normalizeString(record.shelf_address) ?? "";

  if (!warehouseCode) {
    throw new Error("warehouse_code is required for product shelf export");
  }

  const warehouseKey = currentConfig.logo.warehouseRafKeyMap.get(String(warehouseCode)) ?? String(warehouseCode);

  if (rafSchema) {
    const result = await updateShelfTable(pool, rafSchema, product.logicalRef, warehouseCode, warehouseKey, shelfAddress);
    return {
      externalRef: `${rafSchema.qualifiedName}-${result.reference}`,
    };
  }

  await updateProductTableShelf(pool, productSchema, product.logicalRef, warehouseCode, warehouseKey, shelfAddress);

  return {
    externalRef: `ITEMS-${product.logicalRef}`,
  };
}

async function resolveProduct(pool, productSchema, record) {
  const externalRef = normalizeString(record.product_external_ref);
  const code = normalizeString(record.product_code);
  const parsedRef = parseLogoReference(externalRef);

  const request = pool.request();
  const clauses = [];

  if (parsedRef !== null && hasColumn(productSchema, "LOGICALREF")) {
    request.input("logicalRef", sql.Int, parsedRef);
    clauses.push(`${quoteIdentifier(findColumn(productSchema, "LOGICALREF"))} = @logicalRef`);
  }

  if (code && hasColumn(productSchema, "CODE")) {
    request.input("code", sql.NVarChar(128), code);
    clauses.push(`${quoteIdentifier(findColumn(productSchema, "CODE"))} = @code`);
  }

  if (clauses.length === 0) {
    throw new Error("product_code or product_external_ref is required");
  }

  const result = await request.query(`
    SELECT TOP 1 ${quoteIdentifier(findColumn(productSchema, "LOGICALREF"))} AS logical_ref
    FROM ${productSchema.qualifiedName}
    WHERE ${clauses.join(" OR ")}
  `);

  const logicalRef = Number(result.recordset?.[0]?.logical_ref);
  if (!Number.isFinite(logicalRef) || logicalRef <= 0) {
    throw new Error(`Logo product could not be resolved code=${code ?? "-"} external_ref=${externalRef ?? "-"}`);
  }

  return { logicalRef };
}

async function updateShelfTable(pool, schema, logicalRef, warehouseCode, warehouseKey, shelfAddress) {
  const referenceColumn = firstExistingColumn(schema, referenceColumnCandidates);
  if (!referenceColumn) {
    throw new Error(`${schema.qualifiedName} reference column not found; set LOGO_PRODUCT_RAF_TABLE to a table with ITEMREF/STOCKREF/PARLOGREF`);
  }

  const warehouseColumn = firstExistingColumn(schema, warehouseColumnCandidates);
  const shelfColumn = warehouseColumn
    ? firstExistingColumn(schema, genericShelfColumnCandidates)
    : firstExistingColumn(schema, shelfColumnsForWarehouseKey(warehouseKey, true)) ??
      firstExistingColumn(schema, genericShelfColumnCandidates);

  if (!shelfColumn) {
    throw new Error(`${schema.qualifiedName} shelf column not found for warehouse ${warehouseCode}; configure LOGO_WAREHOUSE_RAF_KEY_MAP or Logo raf table columns`);
  }

  if (warehouseColumn) {
    const update = await pool
      .request()
      .input("logicalRef", sql.Int, logicalRef)
      .input("warehouseCode", sql.NVarChar(32), String(warehouseCode))
      .input("warehouseNo", sql.Int, parseInteger(warehouseCode, -999999))
      .input("shelfAddress", sql.NVarChar(80), shelfAddress)
      .query(`
        UPDATE ${schema.qualifiedName}
           SET ${quoteIdentifier(shelfColumn)} = @shelfAddress
         WHERE ${quoteIdentifier(referenceColumn)} = @logicalRef
           AND (
             TRY_CONVERT(INT, ${quoteIdentifier(warehouseColumn)}) = @warehouseNo
             OR CONVERT(NVARCHAR(32), ${quoteIdentifier(warehouseColumn)}) = @warehouseCode
           );
      `);

    if ((update.rowsAffected?.[0] ?? 0) > 0) {
      return { reference: `${logicalRef}-${warehouseCode}` };
    }

    try {
      await pool
        .request()
        .input("logicalRef", sql.Int, logicalRef)
        .input("warehouseValue", sql.NVarChar(32), String(warehouseCode))
        .input("shelfAddress", sql.NVarChar(80), shelfAddress)
        .query(`
          INSERT INTO ${schema.qualifiedName} (
            ${quoteIdentifier(referenceColumn)}, ${quoteIdentifier(warehouseColumn)}, ${quoteIdentifier(shelfColumn)}
          )
          VALUES (@logicalRef, @warehouseValue, @shelfAddress);
        `);

      return { reference: `${logicalRef}-${warehouseCode}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${schema.qualifiedName} row update failed and insert could not be created: ${message}`);
    }
  }

  const update = await pool
    .request()
    .input("logicalRef", sql.Int, logicalRef)
    .input("shelfAddress", sql.NVarChar(80), shelfAddress)
    .query(`
      UPDATE ${schema.qualifiedName}
         SET ${quoteIdentifier(shelfColumn)} = @shelfAddress
       WHERE ${quoteIdentifier(referenceColumn)} = @logicalRef;
    `);

  if ((update.rowsAffected?.[0] ?? 0) === 0) {
    throw new Error(`${schema.qualifiedName} has no row for product logicalref=${logicalRef}`);
  }

  return { reference: logicalRef };
}

async function updateProductTableShelf(pool, schema, logicalRef, warehouseCode, warehouseKey, shelfAddress) {
  const shelfColumn =
    firstExistingColumn(schema, shelfColumnsForWarehouseKey(warehouseKey, true)) ??
    firstExistingColumn(schema, genericShelfColumnCandidates);

  if (!shelfColumn) {
    throw new Error(
      `Logo product shelf column not found on ${schema.qualifiedName}; set LOGO_PRODUCT_RAF_TABLE or configure a shelf column such as RAF${warehouseKey}`
    );
  }

  const update = await pool
    .request()
    .input("logicalRef", sql.Int, logicalRef)
    .input("shelfAddress", sql.NVarChar(80), shelfAddress)
    .query(`
      UPDATE ${schema.qualifiedName}
         SET ${quoteIdentifier(shelfColumn)} = @shelfAddress
       WHERE ${quoteIdentifier(findColumn(schema, "LOGICALREF"))} = @logicalRef;
    `);

  if ((update.rowsAffected?.[0] ?? 0) === 0) {
    throw new Error(`${schema.qualifiedName} has no product logicalref=${logicalRef}`);
  }

  console.log(
    `[logo-sync] updated product shelf on ${schema.qualifiedName}.${shelfColumn} for warehouse=${warehouseCode}`
  );
}

function shelfColumnsForWarehouseKey(key, includeGeneric = false) {
  const normalized = normalizeString(key);
  if (!normalized) {
    return includeGeneric ? genericShelfColumnCandidates : [];
  }

  const compact = normalized.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const values = [
    `RAF${compact}`,
    `RAF_${compact}`,
    `RAFADRESI${compact}`,
    `RAF_ADRESI_${compact}`,
    `RAF_ADRESI${compact}`,
    `RAFKODU${compact}`,
    `RAF_KODU_${compact}`,
    `SHELF${compact}`,
    `SHELF_${compact}`,
    `SHELF_ADDRESS${compact}`,
    `LOCATION${compact}`,
    `LOCATION_${compact}`,
    `ADRES${compact}`,
    `ADRES_${compact}`,
  ];

  return includeGeneric ? [...values, ...genericShelfColumnCandidates] : values;
}

async function inspectTable(pool, tableName, required = false) {
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

  const columns = (result.recordset ?? [])
    .map((row) => normalizeString(row.COLUMN_NAME))
    .filter(Boolean);

  if (required && columns.length === 0) {
    throw new Error(`Logo table not found or has no columns: ${tableName}`);
  }

  return {
    schema,
    table,
    qualifiedName: `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
    columns,
    lowerColumnMap: new Map(columns.map((column) => [column.toLowerCase(), column])),
  };
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

function validateQualifiedName(value, label) {
  if (!/^[A-Za-z0-9_.\[\]]+$/.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
}

function parseLogoReference(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/(\d+)$/);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveProductShelvesPendingUrl(syncUrl) {
  return deriveEndpointUrl(syncUrl, "/api/integrations/logo/product-shelves/pending");
}

function deriveProductShelvesAckUrl(syncUrl) {
  return deriveEndpointUrl(syncUrl, "/api/integrations/logo/product-shelves/ack");
}

function deriveEndpointUrl(syncUrl, pathName) {
  const normalized = nullable(syncUrl);
  if (!normalized) {
    return null;
  }

  try {
    const url = new URL(normalized);
    url.pathname = pathName;
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

function parseWarehouseRafKeyMap(value) {
  const map = new Map();
  const normalized = normalizeString(value);
  if (!normalized) {
    return map;
  }

  for (const part of normalized.split(/[;,]/)) {
    const [warehouse, key] = part.split("=").map((item) => normalizeString(item));
    if (warehouse && key) {
      map.set(warehouse, key);
    }
  }

  return map;
}

function firmNo() {
  const raw = normalizeString(process.env.LOGO_FIRM_NO ?? process.env.LOGO_FIRM) ?? "003";
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
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === undefined || normalized === null) {
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
  const normalized = normalizeString(value);
  return normalized === "" ? null : normalized;
}

function normalizeString(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}
