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

  const pendingPayload = await fetchPendingLedgerEntries(config);
  const records = Array.isArray(pendingPayload.records) ? pendingPayload.records : [];
  console.log(`[logo-sync] fetched ${records.length} pending B2B ledger backfill row(s) from B2B`);

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
    const acknowledgements = [];

    for (const record of records) {
      try {
        const externalReference = await exportLedgerEntry(pool, config, record);
        acknowledgements.push({
          ledger_entry_id: record.ledger_entry_id,
          status: "synced",
          external_ref: externalReference,
          meta: {
            export_key: record.export_key,
          },
        });
        console.log(
          `[logo-sync] exported ledger_entry_id=${record.ledger_entry_id} external_ref=${externalReference ?? "null"}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        acknowledgements.push({
          ledger_entry_id: record.ledger_entry_id,
          status: "failed",
          error: message.slice(0, 2000),
          meta: {
            export_key: record.export_key,
          },
        });
        console.warn(
          `[logo-sync] B2B ledger backfill failed id=${record.ledger_entry_id}: ${message}`
        );
      }
    }

    await acknowledgeLedgerEntries(config, acknowledgements);

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
    nullable(process.env.POWERSA_B2B_LEDGER_BACKFILL_PENDING_URL) ??
    deriveBackfillPendingUrl(process.env.POWERSA_SYNC_URL);
  const ackUrl =
    nullable(process.env.POWERSA_B2B_LEDGER_BACKFILL_ACK_URL) ??
    deriveBackfillAckUrl(process.env.POWERSA_SYNC_URL);
  const syncKey = (
    process.env.POWERSA_B2B_LEDGER_BACKFILL_SYNC_KEY ??
    process.env.POWERSA_COLLECTIONS_SYNC_KEY ??
    process.env.POWERSA_SYNC_KEY ??
    ""
  ).trim();

  return {
    logo: {
      server: (process.env.LOGO_SQL_SERVER ?? "").trim(),
      instanceName: nullable(process.env.LOGO_SQL_INSTANCE),
      port,
      database: (process.env.LOGO_SQL_DATABASE ?? "").trim(),
      user: (process.env.LOGO_SQL_USER ?? "").trim(),
      password: process.env.LOGO_SQL_PASSWORD ?? "",
      backfillProcedure: (
        process.env.LOGO_B2B_LEDGER_BACKFILL_PROCEDURE ??
        "dbo.PowersaB2B_BackfillB2BLedgerEntry"
      ).trim(),
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
      customerCode: nullable(process.env.POWERSA_B2B_LEDGER_BACKFILL_CUSTOMER_CODE),
      limit: parseInteger(process.env.POWERSA_B2B_LEDGER_BACKFILL_LIMIT, 100),
    },
  };
}

function validateConfig(currentConfig) {
  const missing = [];

  if (!currentConfig.logo.server) missing.push("LOGO_SQL_SERVER");
  if (!currentConfig.logo.database) missing.push("LOGO_SQL_DATABASE");
  if (!currentConfig.logo.user) missing.push("LOGO_SQL_USER");
  if (!currentConfig.logo.password) missing.push("LOGO_SQL_PASSWORD");
  if (!currentConfig.logo.backfillProcedure) missing.push("LOGO_B2B_LEDGER_BACKFILL_PROCEDURE");
  if (!currentConfig.sync.pendingUrl) missing.push("POWERSA_B2B_LEDGER_BACKFILL_PENDING_URL or POWERSA_SYNC_URL");
  if (!currentConfig.sync.ackUrl) missing.push("POWERSA_B2B_LEDGER_BACKFILL_ACK_URL or POWERSA_SYNC_URL");
  if (!currentConfig.sync.key) missing.push("POWERSA_B2B_LEDGER_BACKFILL_SYNC_KEY or POWERSA_SYNC_KEY");

  if (missing.length > 0) {
    throw new Error(`missing required config: ${missing.join(", ")}`);
  }

  if (!/^[A-Za-z0-9_.\[\]]+$/.test(currentConfig.logo.backfillProcedure)) {
    throw new Error("LOGO_B2B_LEDGER_BACKFILL_PROCEDURE contains unsupported characters");
  }

  if (currentConfig.logo.port !== undefined) {
    currentConfig.logo.connection.port = currentConfig.logo.port;
  }
}

async function fetchPendingLedgerEntries(currentConfig) {
  const query = new URLSearchParams();
  query.set("limit", String(currentConfig.sync.limit));

  if (currentConfig.sync.dealerId) {
    query.set("dealer_id", String(currentConfig.sync.dealerId));
  } else if (currentConfig.sync.dealerCode) {
    query.set("dealer_code", currentConfig.sync.dealerCode);
  }

  if (currentConfig.sync.customerCode) {
    query.set("customer_code", currentConfig.sync.customerCode);
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

async function exportLedgerEntry(pool, currentConfig, record) {
  const request = pool.request();
  request.input("customerExternalRef", sql.NVarChar(128), nullable(record.customer_external_ref));
  request.input("customerCode", sql.NVarChar(64), nullable(record.customer_code));
  request.input("ledgerDate", sql.Date, new Date(record.date));
  request.input("sign", sql.SmallInt, Number.parseInt(String(record.sign ?? 1), 10));
  request.input("amount", sql.Decimal(15, 2), Number.parseFloat(String(record.amount ?? 0)));
  request.input("currency", sql.NVarChar(3), nullable(record.currency) ?? "TRY");
  request.input("referenceNo", sql.NVarChar(120), nullable(record.reference_no));
  request.input("description", sql.NVarChar(250), nullable(record.description));
  request.input("exportKey", sql.NVarChar(128), nullable(record.export_key));
  request.input("payloadJson", sql.NVarChar(sql.MAX), JSON.stringify(record));

  const result = await request.query(`
    DECLARE @ExternalRef NVARCHAR(128);
    EXEC ${currentConfig.logo.backfillProcedure}
      @CustomerExternalRef = @customerExternalRef,
      @CustomerCode = @customerCode,
      @LedgerDate = @ledgerDate,
      @Sign = @sign,
      @Amount = @amount,
      @Currency = @currency,
      @ReferenceNo = @referenceNo,
      @Description = @description,
      @ExportKey = @exportKey,
      @PayloadJson = @payloadJson,
      @ExternalRef = @ExternalRef OUTPUT;
    SELECT @ExternalRef AS external_ref;
  `);

  return normalizeString(result.recordset?.[0]?.external_ref) ?? nullable(record.export_key);
}

async function acknowledgeLedgerEntries(currentConfig, records) {
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

  const body = await response.json();
  console.log("[logo-sync] ack response:", JSON.stringify(body.summary ?? body));
}

function deriveBackfillPendingUrl(baseUrl) {
  const normalized = nullable(baseUrl);
  if (!normalized) {
    return null;
  }

  return normalized.replace(/\/customers\/sync$/i, "/b2b-ledger-backfill/pending");
}

function deriveBackfillAckUrl(baseUrl) {
  const normalized = nullable(baseUrl);
  if (!normalized) {
    return null;
  }

  return normalized.replace(/\/customers\/sync$/i, "/b2b-ledger-backfill/ack");
}

function parseInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function nullable(value) {
  const normalized = normalizeString(value);

  return normalized === "" ? null : normalized;
}

function normalizeString(value) {
  if (value === undefined || value === null) {
    return null;
  }

  return String(value).trim();
}
