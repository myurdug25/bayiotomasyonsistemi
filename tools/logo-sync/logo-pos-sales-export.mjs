#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import sql from "mssql";
import { triggerTargetedStockSync } from "./logo-targeted-stock-sync.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const envPath = path.join(scriptDir, ".env");

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const config = buildConfig();
const startedAt = Date.now();

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error("[logo-sync] failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

async function main() {
  validateConfig(config);

  const pendingPayload = await fetchPendingSales(config);
  const records = Array.isArray(pendingPayload.records) ? pendingPayload.records : [];
  console.log(`[logo-sync] fetched ${records.length} pending POS sale(s) from B2B`);

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
    const acknowledgements = [];
    const syncedRecords = [];

    for (const record of records) {
      try {
        const externalReference = await exportSale(pool, config, record);
        acknowledgements.push({
          pos_sale_id: record.pos_sale_id,
          status: "synced",
          external_ref: externalReference,
          meta: {
            export_key: record.export_key,
          },
        });
        syncedRecords.push(record);
        console.log(
          `[logo-sync] exported pos_sale_id=${record.pos_sale_id} external_ref=${externalReference ?? "null"}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        acknowledgements.push({
          pos_sale_id: record.pos_sale_id,
          status: "failed",
          error: message.slice(0, 2000),
          meta: {
            export_key: record.export_key,
          },
        });
        console.warn(`[logo-sync] POS sale export failed id=${record.pos_sale_id}: ${message}`);
      }
    }

    await acknowledgeSales(config, acknowledgements);
    triggerTargetedStockSync(syncedRecords, "pos_sales_invoice");

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
    nullable(process.env.POWERSA_POS_SALES_PENDING_URL) ??
    derivePosSalesPendingUrl(process.env.POWERSA_SYNC_URL);
  const ackUrl =
    nullable(process.env.POWERSA_POS_SALES_ACK_URL) ??
    derivePosSalesAckUrl(process.env.POWERSA_SYNC_URL);
  const syncKey = (
    process.env.POWERSA_POS_SALES_SYNC_KEY ??
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
      posSaleExportProcedure: (process.env.LOGO_POS_SALE_EXPORT_PROCEDURE ?? "").trim(),
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
    sync: {
      pendingUrl: pendingUrl ?? "",
      ackUrl: ackUrl ?? "",
      key: syncKey,
      apiTimeoutMs: parseInteger(process.env.LOGO_API_REQUEST_TIMEOUT_MS, 15000),
      dealerId: parseInteger(process.env.POWERSA_DEALER_ID, undefined),
      dealerCode: nullable(process.env.POWERSA_DEALER_CODE),
      limit: parseInteger(process.env.POWERSA_POS_SALES_LIMIT, 100),
    },
  };
}

function validateConfig(currentConfig) {
  const missing = [];

  if (!currentConfig.logo.server) missing.push("LOGO_SQL_SERVER");
  if (!currentConfig.logo.database) missing.push("LOGO_SQL_DATABASE");
  if (!currentConfig.logo.user) missing.push("LOGO_SQL_USER");
  if (!currentConfig.logo.password) missing.push("LOGO_SQL_PASSWORD");
  if (!currentConfig.logo.posSaleExportProcedure) missing.push("LOGO_POS_SALE_EXPORT_PROCEDURE");
  if (!currentConfig.sync.pendingUrl) missing.push("POWERSA_POS_SALES_PENDING_URL or POWERSA_SYNC_URL");
  if (!currentConfig.sync.ackUrl) missing.push("POWERSA_POS_SALES_ACK_URL or POWERSA_SYNC_URL");
  if (!currentConfig.sync.key) missing.push("POWERSA_POS_SALES_SYNC_KEY or POWERSA_SYNC_KEY");

  if (missing.length > 0) {
    throw new Error(`missing required config: ${missing.join(", ")}`);
  }

  if (!/^[A-Za-z0-9_.\[\]]+$/.test(currentConfig.logo.posSaleExportProcedure)) {
    throw new Error("LOGO_POS_SALE_EXPORT_PROCEDURE contains unsupported characters");
  }

  if (currentConfig.logo.port !== undefined) {
    currentConfig.logo.connection.port = currentConfig.logo.port;
  }
}

async function fetchPendingSales(currentConfig) {
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

async function exportSale(pool, currentConfig, record) {
  const request = pool.request();
  request.input("customerExternalRef", sql.NVarChar(128), nullable(record.customer_external_ref));
  request.input("customerCode", sql.NVarChar(64), nullable(record.customer_code));
  request.input("saleDate", sql.Date, new Date(record.date));
  request.input("receiptNo", sql.NVarChar(64), nullable(record.receipt_no));
  request.input("saleType", sql.NVarChar(32), nullable(record.sale_type));
  request.input("documentType", sql.NVarChar(32), nullable(record.document_type));
  request.input("subtotal", sql.Decimal(15, 2), Number.parseFloat(String(record.subtotal ?? 0)));
  request.input("discountTotal", sql.Decimal(15, 2), Number.parseFloat(String(record.discount_total ?? 0)));
  request.input("vatTotal", sql.Decimal(15, 2), Number.parseFloat(String(record.vat_total ?? 0)));
  request.input("grandTotal", sql.Decimal(15, 2), Number.parseFloat(String(record.grand_total ?? 0)));
  request.input("cashboxCode", sql.NVarChar(64), nullable(record.cashbox_code));
  request.input("exportKey", sql.NVarChar(128), nullable(record.export_key));
  request.input(
    "payloadJson",
    sql.NVarChar(sql.MAX),
    JSON.stringify(buildPosSalePayload(record))
  );

  const result = await request.query(`
    SET ANSI_NULLS ON;
    SET QUOTED_IDENTIFIER ON;
    SET ANSI_PADDING ON;
    SET ANSI_WARNINGS ON;
    SET CONCAT_NULL_YIELDS_NULL ON;
    SET ARITHABORT ON;
    SET NUMERIC_ROUNDABORT OFF;

    DECLARE @ExternalRef NVARCHAR(128);
    EXEC ${currentConfig.logo.posSaleExportProcedure}
      @CustomerExternalRef = @customerExternalRef,
      @CustomerCode = @customerCode,
      @SaleDate = @saleDate,
      @ReceiptNo = @receiptNo,
      @SaleType = @saleType,
      @DocumentType = @documentType,
      @Subtotal = @subtotal,
      @DiscountTotal = @discountTotal,
      @VatTotal = @vatTotal,
      @GrandTotal = @grandTotal,
      @CashboxCode = @cashboxCode,
      @ExportKey = @exportKey,
      @PayloadJson = @payloadJson,
      @ExternalRef = @ExternalRef OUTPUT;
    SELECT @ExternalRef AS external_ref;
  `);

  return normalizeString(result.recordset?.[0]?.external_ref) ?? nullable(record.export_key);
}

export function buildPosSalePayload(record) {
  return {
    pos_sale_id: record.pos_sale_id,
    document_type: record.document_type ?? null,
    cashbox_id: record.cashbox_id ?? null,
    cashbox_code: record.cashbox_code ?? null,
    cashbox_name: record.cashbox_name ?? null,
    logo: record.logo ?? {},
    items: record.items ?? [],
    payments: record.payments ?? [],
    meta: record.meta ?? {},
  };
}

async function acknowledgeSales(currentConfig, records) {
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

function derivePosSalesPendingUrl(baseUrl) {
  const normalized = nullable(baseUrl);
  if (!normalized) {
    return null;
  }

  return normalized.replace(/\/customers\/sync$/i, "/pos-sales/pending");
}

function derivePosSalesAckUrl(baseUrl) {
  const normalized = nullable(baseUrl);
  if (!normalized) {
    return null;
  }

  return normalized.replace(/\/customers\/sync$/i, "/pos-sales/ack");
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
