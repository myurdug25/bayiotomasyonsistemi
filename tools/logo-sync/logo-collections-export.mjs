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
const startedAt = Date.now();

main().catch((error) => {
  console.error("[logo-sync] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  validateConfig(config);

  const pendingPayload = await fetchPendingCollections(config);
  const records = Array.isArray(pendingPayload.records) ? pendingPayload.records : [];
  console.log(`[logo-sync] fetched ${records.length} pending collection(s) from B2B`);

  if (records.length === 0) {
    const durationMs = Date.now() - startedAt;
    console.log(`[logo-sync] completed. exported=0 duration=${durationMs}ms`);
    return;
  }

  console.log(
    `[logo-sync] connecting to ${config.logo.server}${config.logo.instanceName ? `\\${config.logo.instanceName}` : ""}/${config.logo.database}`
  );

  const pool = new sql.ConnectionPool(config.logo.connection);
  await pool.connect();

  try {
    const procedureParameters = await loadProcedureParameters(
      pool,
      config.logo.collectionExportProcedure
    );
    const acknowledgements = [];

    for (const record of records) {
      try {
        const externalReference = await exportCollection(
          pool,
          config,
          record,
          procedureParameters
        );
        acknowledgements.push({
          collection_id: record.collection_id,
          status: "synced",
          external_ref: externalReference,
          meta: {
            export_key: record.export_key,
          },
        });
        console.log(
          `[logo-sync] exported collection_id=${record.collection_id} external_ref=${externalReference ?? "null"}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        acknowledgements.push({
          collection_id: record.collection_id,
          status: "failed",
          error: message.slice(0, 2000),
          meta: {
            export_key: record.export_key,
          },
        });
        console.warn(`[logo-sync] collection export failed id=${record.collection_id}: ${message}`);
      }
    }

    await acknowledgeCollections(config, acknowledgements);

    const durationMs = Date.now() - startedAt;
    console.log(
      `[logo-sync] completed. exported=${acknowledgements.filter((item) => item.status === "synced").length} failed=${acknowledgements.filter((item) => item.status === "failed").length} duration=${durationMs}ms`
    );
  } finally {
    await pool.close();
  }
}

function buildConfig() {
  const timeoutMs = parseInteger(process.env.LOGO_SQL_REQUEST_TIMEOUT_MS, 30000);
  const port = parseInteger(process.env.LOGO_SQL_PORT, undefined);
  const pendingUrl =
    nullable(process.env.POWERSA_COLLECTIONS_PENDING_URL) ??
    deriveCollectionsPendingUrl(process.env.POWERSA_SYNC_URL);
  const ackUrl =
    nullable(process.env.POWERSA_COLLECTIONS_ACK_URL) ??
    deriveCollectionsAckUrl(process.env.POWERSA_SYNC_URL);
  const syncKey = (process.env.POWERSA_COLLECTIONS_SYNC_KEY ?? process.env.POWERSA_SYNC_KEY ?? "").trim();

  return {
    logo: {
      server: (process.env.LOGO_SQL_SERVER ?? "").trim(),
      instanceName: nullable(process.env.LOGO_SQL_INSTANCE),
      port,
      database: (process.env.LOGO_SQL_DATABASE ?? "").trim(),
      user: (process.env.LOGO_SQL_USER ?? "").trim(),
      password: process.env.LOGO_SQL_PASSWORD ?? "",
      collectionExportProcedure: (process.env.LOGO_COLLECTION_EXPORT_PROCEDURE ?? "").trim(),
      defaultCollectionCashboxId: parseInteger(
        process.env.LOGO_COLLECTION_DEFAULT_CASHBOX_ID,
        undefined
      ),
      defaultCollectionCashboxCode: nullable(process.env.LOGO_COLLECTION_DEFAULT_CASHBOX_CODE),
      defaultCollectionCashboxName: nullable(process.env.LOGO_COLLECTION_DEFAULT_CASHBOX_NAME),
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
      dealerId: parseInteger(process.env.POWERSA_DEALER_ID, undefined),
      dealerCode: nullable(process.env.POWERSA_DEALER_CODE),
      limit: parseInteger(process.env.POWERSA_COLLECTIONS_LIMIT, 100),
    },
  };
}

function validateConfig(currentConfig) {
  const missing = [];

  if (!currentConfig.logo.server) missing.push("LOGO_SQL_SERVER");
  if (!currentConfig.logo.database) missing.push("LOGO_SQL_DATABASE");
  if (!currentConfig.logo.user) missing.push("LOGO_SQL_USER");
  if (!currentConfig.logo.password) missing.push("LOGO_SQL_PASSWORD");
  if (!currentConfig.logo.collectionExportProcedure) missing.push("LOGO_COLLECTION_EXPORT_PROCEDURE");
  if (!currentConfig.sync.pendingUrl) missing.push("POWERSA_COLLECTIONS_PENDING_URL or POWERSA_SYNC_URL");
  if (!currentConfig.sync.ackUrl) missing.push("POWERSA_COLLECTIONS_ACK_URL or POWERSA_SYNC_URL");
  if (!currentConfig.sync.key) missing.push("POWERSA_COLLECTIONS_SYNC_KEY or POWERSA_SYNC_KEY");

  if (missing.length > 0) {
    throw new Error(`missing required config: ${missing.join(", ")}`);
  }

  if (!/^[A-Za-z0-9_.\[\]]+$/.test(currentConfig.logo.collectionExportProcedure)) {
    throw new Error("LOGO_COLLECTION_EXPORT_PROCEDURE contains unsupported characters");
  }

  if (currentConfig.logo.port !== undefined) {
    currentConfig.logo.connection.port = currentConfig.logo.port;
  }
}

async function fetchPendingCollections(currentConfig) {
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

async function loadProcedureParameters(pool, procedureName) {
  const normalizedProcedureName = procedureName.replaceAll("[", "").replaceAll("]", "");

  try {
    const result = await pool
      .request()
      .input("procedureName", sql.NVarChar(256), normalizedProcedureName)
      .query(`
        SELECT name
        FROM sys.parameters
        WHERE object_id = OBJECT_ID(@procedureName);
      `);

    return new Set(
      (result.recordset ?? [])
        .map((row) => normalizeString(row.name)?.toLowerCase())
        .filter(Boolean)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[logo-sync] could not inspect collection procedure parameters: ${message}`);

    return new Set();
  }
}

function hasProcedureParameter(parameters, name) {
  return parameters.has(`@${name.toLowerCase()}`);
}

async function exportCollection(pool, currentConfig, record, procedureParameters) {
  const isCashCollection = String(record.method ?? "").trim().toLowerCase() === "cash";
  const cashboxId = isCashCollection
    ? parseInteger(record.cashbox_id, currentConfig.logo.defaultCollectionCashboxId)
    : null;
  const cashboxCode = isCashCollection
    ? nullable(record.cashbox_code) ?? currentConfig.logo.defaultCollectionCashboxCode
    : null;
  const cashboxName = isCashCollection
    ? nullable(record.cashbox_name) ?? currentConfig.logo.defaultCollectionCashboxName
    : null;
  const request = pool.request();
  request.input("customerExternalRef", sql.NVarChar(128), nullable(record.customer_external_ref));
  request.input("customerCode", sql.NVarChar(64), nullable(record.customer_code));
  request.input("collectionDate", sql.Date, new Date(record.date));
  request.input("method", sql.NVarChar(32), nullable(record.method));
  request.input("amount", sql.Decimal(15, 2), Number.parseFloat(String(record.amount ?? 0)));
  request.input("currency", sql.NVarChar(3), nullable(record.currency) ?? "TRY");
  request.input("referenceNo", sql.NVarChar(120), nullable(record.reference_no));
  request.input("note", sql.NVarChar(sql.MAX), nullable(record.note));
  request.input("exportKey", sql.NVarChar(128), nullable(record.export_key));
  request.input("cashboxId", sql.Int, cashboxId ?? null);
  request.input("cashboxCode", sql.NVarChar(64), cashboxCode);
  request.input("cashboxName", sql.NVarChar(128), cashboxName);
  request.input(
    "payloadJson",
    sql.NVarChar(sql.MAX),
    JSON.stringify({
      ...record,
      cashbox_id: cashboxId ?? null,
      cashbox_code: cashboxCode,
      cashbox_name: cashboxName,
    })
  );

  const execParameters = [
    "@CustomerExternalRef = @customerExternalRef",
    "@CustomerCode = @customerCode",
    "@CollectionDate = @collectionDate",
    "@Method = @method",
    "@Amount = @amount",
    "@Currency = @currency",
    "@ReferenceNo = @referenceNo",
    "@Note = @note",
    "@ExportKey = @exportKey",
  ];

  if (hasProcedureParameter(procedureParameters, "CashboxId")) {
    execParameters.push("@CashboxId = @cashboxId");
  }

  if (hasProcedureParameter(procedureParameters, "CashboxCode")) {
    execParameters.push("@CashboxCode = @cashboxCode");
  }

  if (hasProcedureParameter(procedureParameters, "CashboxName")) {
    execParameters.push("@CashboxName = @cashboxName");
  }

  execParameters.push("@PayloadJson = @payloadJson", "@ExternalRef = @ExternalRef OUTPUT");

  const result = await request.query(`
    DECLARE @ExternalRef NVARCHAR(128);
    EXEC ${currentConfig.logo.collectionExportProcedure}
      ${execParameters.join(",\n      ")};
    SELECT @ExternalRef AS external_ref;
  `);

  return (
    normalizeString(result.recordset?.[0]?.external_ref) ??
    nullable(record.export_key)
  );
}

async function acknowledgeCollections(currentConfig, records) {
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
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? JSON.stringify(await response.json())
      : await response.text();

    throw new Error(`ack endpoint returned ${response.status}: ${body}`);
  }

  const body = await response.json();
  console.log("[logo-sync] ack response:", JSON.stringify(body.summary ?? body));
}

function deriveCollectionsPendingUrl(baseUrl) {
  const normalized = nullable(baseUrl);
  if (!normalized) {
    return null;
  }

  return normalized.replace(/\/customers\/sync$/i, "/collections/pending");
}

function deriveCollectionsAckUrl(baseUrl) {
  const normalized = nullable(baseUrl);
  if (!normalized) {
    return null;
  }

  return normalized.replace(/\/customers\/sync$/i, "/collections/ack");
}

function normalizeString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function parseInteger(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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
