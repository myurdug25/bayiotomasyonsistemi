#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import sql from "mssql";
import { triggerTargetedStockSync } from "./logo-targeted-stock-sync.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(scriptDir, ".env");
const isMain = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const config = buildConfig();
const startedAt = Date.now();

if (isMain) {
  main().catch((error) => {
    console.error("[logo-sync] failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

async function main() {
  const steps = buildSteps(config).filter((step) => step.procedure);

  if (steps.length === 0) {
    console.log("[logo-sync] no document export procedures configured; skipped.");
    return;
  }

  validateLogoConfig(config);

  console.log(
    `[logo-sync] connecting to ${config.logo.server}${config.logo.instanceName ? `\\${config.logo.instanceName}` : ""}/${config.logo.database}`
  );

  const pool = new sql.ConnectionPool(config.logo.connection);
  await pool.connect();

  try {
    for (const step of steps) {
      validateStepConfig(step);
      await runStep(pool, step);
    }
  } finally {
    await pool.close();
  }

  console.log(`[logo-sync] document exports completed duration=${Date.now() - startedAt}ms`);
}

async function runStep(pool, step) {
  const pendingPayload = await fetchPending(step);
  const records = Array.isArray(pendingPayload.records) ? pendingPayload.records : [];
  console.log(`[logo-sync] fetched ${records.length} pending ${step.label}(s) from B2B`);

  if (records.length === 0) {
    return;
  }

  const procedureParameters = await loadProcedureParameters(pool, step.procedure, step.label);
  const acknowledgements = [];
  const syncedRecords = [];

  for (const record of records) {
    try {
      const externalReference = await exportRecord(pool, step, record, procedureParameters);
      acknowledgements.push({
        [step.idField]: record[step.idField],
        status: "synced",
        external_ref: externalReference,
        meta: {
          export_key: record.export_key,
        },
      });
      syncedRecords.push(record);
      console.log(
        `[logo-sync] exported ${step.idField}=${record[step.idField]} external_ref=${externalReference ?? "null"}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      acknowledgements.push({
        [step.idField]: record[step.idField],
        status: "failed",
        error: message.slice(0, 2000),
        meta: {
          export_key: record.export_key,
        },
      });
      console.warn(`[logo-sync] ${step.label} export failed id=${record[step.idField]}: ${message}`);
    }
  }

  await acknowledge(step, acknowledgements);

  if (step.key === "shipments") {
    triggerTargetedStockSync(syncedRecords, "shipment_invoice");
  }

  if (step.key === "warehouse-transfers") {
    triggerTargetedStockSync(syncedRecords, "warehouse_transfer");
  }

  console.log(
    `[logo-sync] ${step.label} completed. exported=${acknowledgements.filter((item) => item.status === "synced").length} failed=${acknowledgements.filter((item) => item.status === "failed").length}`
  );
}

export function buildConfig() {
  const timeoutMs = parseInteger(process.env.LOGO_SQL_REQUEST_TIMEOUT_MS, 30000);
  const port = parseInteger(process.env.LOGO_SQL_PORT, undefined);

  return {
    logo: {
      server: (process.env.LOGO_SQL_SERVER ?? "").trim(),
      instanceName: nullable(process.env.LOGO_SQL_INSTANCE),
      port,
      database: (process.env.LOGO_SQL_DATABASE ?? "").trim(),
      user: (process.env.LOGO_SQL_USER ?? "").trim(),
      password: process.env.LOGO_SQL_PASSWORD ?? "",
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
    common: {
      dealerId: parseInteger(process.env.POWERSA_DEALER_ID, undefined),
      dealerCode: nullable(process.env.POWERSA_DEALER_CODE),
      fallbackSyncKey: (process.env.POWERSA_SYNC_KEY ?? "").trim(),
      syncUrl: nullable(process.env.POWERSA_SYNC_URL),
      apiTimeoutMs: parseInteger(process.env.LOGO_API_REQUEST_TIMEOUT_MS, 15000),
    },
  };
}

export function buildSteps(currentConfig) {
  return [
    {
      key: "warehouse-transfers",
      envKey: "WAREHOUSE_TRANSFERS",
      label: "warehouse transfer",
      idField: "shipment_id",
      procedure: (process.env.LOGO_WAREHOUSE_TRANSFER_EXPORT_PROCEDURE ?? "").trim(),
      pendingUrl:
        nullable(process.env.POWERSA_WAREHOUSE_TRANSFERS_PENDING_URL) ??
        derivePendingUrl(currentConfig.common.syncUrl, "warehouse-transfers"),
      ackUrl:
        nullable(process.env.POWERSA_WAREHOUSE_TRANSFERS_ACK_URL) ??
        deriveAckUrl(currentConfig.common.syncUrl, "warehouse-transfers"),
      syncKey: (
        process.env.POWERSA_WAREHOUSE_TRANSFERS_SYNC_KEY ??
        process.env.POWERSA_SHIPMENTS_SYNC_KEY ??
        process.env.POWERSA_ORDERS_SYNC_KEY ??
        currentConfig.common.fallbackSyncKey ??
        ""
      ).trim(),
      limit: parseInteger(process.env.POWERSA_WAREHOUSE_TRANSFERS_LIMIT, 100),
      inputs: buildWarehouseTransferInputs,
    },
    {
      key: "orders",
      label: "order",
      idField: "order_id",
      procedure: (process.env.LOGO_ORDER_EXPORT_PROCEDURE ?? "").trim(),
      pendingUrl:
        nullable(process.env.POWERSA_ORDERS_PENDING_URL) ??
        derivePendingUrl(currentConfig.common.syncUrl, "orders"),
      ackUrl:
        nullable(process.env.POWERSA_ORDERS_ACK_URL) ??
        deriveAckUrl(currentConfig.common.syncUrl, "orders"),
      syncKey: (
        process.env.POWERSA_ORDERS_SYNC_KEY ??
        process.env.POWERSA_COLLECTIONS_SYNC_KEY ??
        currentConfig.common.fallbackSyncKey ??
        ""
      ).trim(),
      limit: parseInteger(process.env.POWERSA_ORDERS_LIMIT, 100),
      inputs: buildOrderInputs,
    },
    {
      key: "shipments",
      label: "shipment",
      idField: "shipment_id",
      procedure: (process.env.LOGO_SHIPMENT_EXPORT_PROCEDURE ?? "").trim(),
      pendingUrl:
        nullable(process.env.POWERSA_SHIPMENTS_PENDING_URL) ??
        derivePendingUrl(currentConfig.common.syncUrl, "shipments"),
      ackUrl:
        nullable(process.env.POWERSA_SHIPMENTS_ACK_URL) ??
        deriveAckUrl(currentConfig.common.syncUrl, "shipments"),
      syncKey: (
        process.env.POWERSA_SHIPMENTS_SYNC_KEY ??
        process.env.POWERSA_ORDERS_SYNC_KEY ??
        currentConfig.common.fallbackSyncKey ??
        ""
      ).trim(),
      limit: parseInteger(process.env.POWERSA_SHIPMENTS_LIMIT, 100),
      inputs: buildShipmentInputs,
    },
    {
      key: "purchase-receipts",
      envKey: "PURCHASE_RECEIPTS",
      label: "purchase receipt",
      idField: "purchase_receipt_id",
      procedure: (process.env.LOGO_PURCHASE_RECEIPT_EXPORT_PROCEDURE ?? "").trim(),
      pendingUrl:
        nullable(process.env.POWERSA_PURCHASE_RECEIPTS_PENDING_URL) ??
        derivePendingUrl(currentConfig.common.syncUrl, "purchase-receipts"),
      ackUrl:
        nullable(process.env.POWERSA_PURCHASE_RECEIPTS_ACK_URL) ??
        deriveAckUrl(currentConfig.common.syncUrl, "purchase-receipts"),
      syncKey: (
        process.env.POWERSA_PURCHASE_RECEIPTS_SYNC_KEY ??
        process.env.POWERSA_SHIPMENTS_SYNC_KEY ??
        process.env.POWERSA_ORDERS_SYNC_KEY ??
        currentConfig.common.fallbackSyncKey ??
        ""
      ).trim(),
      limit: parseInteger(process.env.POWERSA_PURCHASE_RECEIPTS_LIMIT, 100),
      inputs: buildPurchaseReceiptInputs,
    },
    {
      key: "returns",
      label: "return",
      idField: "return_request_id",
      procedure: (process.env.LOGO_RETURN_EXPORT_PROCEDURE ?? "").trim(),
      pendingUrl:
        nullable(process.env.POWERSA_RETURNS_PENDING_URL) ??
        derivePendingUrl(currentConfig.common.syncUrl, "returns"),
      ackUrl:
        nullable(process.env.POWERSA_RETURNS_ACK_URL) ??
        deriveAckUrl(currentConfig.common.syncUrl, "returns"),
      syncKey: (
        process.env.POWERSA_RETURNS_SYNC_KEY ??
        process.env.POWERSA_ORDERS_SYNC_KEY ??
        currentConfig.common.fallbackSyncKey ??
        ""
      ).trim(),
      limit: parseInteger(process.env.POWERSA_RETURNS_LIMIT, 100),
      inputs: buildReturnInputs,
    },
    {
      key: "return-scraps",
      envKey: "RETURN_SCRAPS",
      label: "return scrap",
      idField: "return_request_id",
      procedure: (process.env.LOGO_RETURN_SCRAP_EXPORT_PROCEDURE ?? "").trim(),
      pendingUrl:
        nullable(process.env.POWERSA_RETURN_SCRAPS_PENDING_URL) ??
        derivePendingUrl(currentConfig.common.syncUrl, "return-scraps"),
      ackUrl:
        nullable(process.env.POWERSA_RETURN_SCRAPS_ACK_URL) ??
        deriveAckUrl(currentConfig.common.syncUrl, "return-scraps"),
      syncKey: (
        process.env.POWERSA_RETURN_SCRAPS_SYNC_KEY ??
        process.env.POWERSA_RETURNS_SYNC_KEY ??
        process.env.POWERSA_ORDERS_SYNC_KEY ??
        currentConfig.common.fallbackSyncKey ??
        ""
      ).trim(),
      limit: parseInteger(process.env.POWERSA_RETURN_SCRAPS_LIMIT, 100),
      inputs: buildReturnScrapInputs,
    },
  ].map((step) => ({
    ...step,
    dealerId: currentConfig.common.dealerId,
    dealerCode: currentConfig.common.dealerCode,
    apiTimeoutMs: currentConfig.common.apiTimeoutMs,
  }));
}

export function validateLogoConfig(currentConfig) {
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

export function validateStepConfig(step) {
  const missing = [];
  const envKey = step.envKey ?? step.key.toUpperCase();

  if (!step.pendingUrl) missing.push(`POWERSA_${envKey}_PENDING_URL or POWERSA_SYNC_URL`);
  if (!step.ackUrl) missing.push(`POWERSA_${envKey}_ACK_URL or POWERSA_SYNC_URL`);
  if (!step.syncKey) missing.push(`POWERSA_${envKey}_SYNC_KEY or POWERSA_SYNC_KEY`);

  if (missing.length > 0) {
    throw new Error(`missing required ${step.label} export config: ${missing.join(", ")}`);
  }

  if (!/^[A-Za-z0-9_.\[\]]+$/.test(step.procedure)) {
    throw new Error(`${step.label} export procedure contains unsupported characters: ${step.procedure}`);
  }
}

async function fetchPending(step) {
  const query = new URLSearchParams();
  query.set("limit", String(step.limit));

  if (step.dealerId) {
    query.set("dealer_id", String(step.dealerId));
  } else if (step.dealerCode) {
    query.set("dealer_code", step.dealerCode);
  }

  const url = `${step.pendingUrl}${step.pendingUrl.includes("?") ? "&" : "?"}${query.toString()}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-integration-key": step.syncKey,
    },
    signal: AbortSignal.timeout(step.apiTimeoutMs),
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

export async function loadProcedureParameters(pool, procedureName, label) {
  const normalizedProcedureName = procedureName.replaceAll("[", "").replaceAll("]", "");

  try {
    const result = await pool
      .request()
      .input("procedureName", sql.NVarChar(256), normalizedProcedureName)
      .query(`
        SELECT LOWER(name) AS name
        FROM sys.parameters
        WHERE object_id = OBJECT_ID(@procedureName);
      `);

    return new Set(
      (result.recordset ?? [])
        .map((row) => normalizeString(row.name))
        .filter(Boolean)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[logo-sync] could not inspect ${label} procedure parameters: ${message}`);

    return new Set();
  }
}

export async function exportRecord(pool, step, record, procedureParameters) {
  const request = pool.request();
  const inputDefinitions = step.inputs(record);
  const execParameters = [];

  for (const definition of inputDefinitions) {
    request.input(definition.binding, definition.type, definition.value);

    if (procedureParameters.size === 0 || hasProcedureParameter(procedureParameters, definition.parameter)) {
      execParameters.push(`@${definition.parameter} = @${definition.binding}`);
    }
  }

  const hasExternalRefOutput =
    procedureParameters.size === 0 || hasProcedureParameter(procedureParameters, "ExternalRef");
  if (hasExternalRefOutput) {
    execParameters.push("@ExternalRef = @ExternalRef OUTPUT");
  }

  const query = hasExternalRefOutput
    ? `
      ${logoRequiredSetOptions()}
      DECLARE @ExternalRef NVARCHAR(128);
      EXEC ${step.procedure}
        ${execParameters.join(",\n        ")};
      SELECT @ExternalRef AS external_ref;
    `
    : `
      ${logoRequiredSetOptions()}
      EXEC ${step.procedure}
        ${execParameters.join(",\n        ")};
      SELECT @exportKey AS external_ref;
    `;

  const result = await request.query(query);

  return normalizeString(result.recordset?.[0]?.external_ref) ?? nullable(record.export_key);
}

function logoRequiredSetOptions() {
  return `
      SET ANSI_NULLS ON;
      SET QUOTED_IDENTIFIER ON;
      SET ANSI_PADDING ON;
      SET ANSI_WARNINGS ON;
      SET CONCAT_NULL_YIELDS_NULL ON;
      SET ARITHABORT ON;
      SET NUMERIC_ROUNDABORT OFF;
  `;
}

function buildOrderInputs(record) {
  return [
    input("CustomerExternalRef", "customerExternalRef", sql.NVarChar(128), nullable(record.customer_external_ref)),
    input("CustomerCode", "customerCode", sql.NVarChar(64), nullable(record.customer_code)),
    input("OrderDate", "orderDate", sql.Date, toDate(record.order_date)),
    input("OrderNo", "orderNo", sql.NVarChar(64), nullable(record.order_no)),
    input("Currency", "currency", sql.NVarChar(3), nullable(record.currency) ?? "TRY"),
    input("Subtotal", "subtotal", sql.Decimal(15, 2), toNumber(record.subtotal)),
    input("DiscountTotal", "discountTotal", sql.Decimal(15, 2), toNumber(record.discount_total)),
    input("VatTotal", "vatTotal", sql.Decimal(15, 2), toNumber(record.vat_total)),
    input("GrandTotal", "grandTotal", sql.Decimal(15, 2), toNumber(record.grand_total)),
    input("ExportKey", "exportKey", sql.NVarChar(128), nullable(record.export_key)),
    input("PayloadJson", "payloadJson", sql.NVarChar(sql.MAX), JSON.stringify(record)),
  ];
}

function buildShipmentInputs(record) {
  return [
    input("CustomerExternalRef", "customerExternalRef", sql.NVarChar(128), nullable(record.customer_external_ref)),
    input("CustomerCode", "customerCode", sql.NVarChar(64), nullable(record.customer_code)),
    input("ShipmentDate", "shipmentDate", sql.Date, toDate(record.shipment_date)),
    input("ShipmentNo", "shipmentNo", sql.NVarChar(64), nullable(record.shipment_no)),
    input("OrderNo", "orderNo", sql.NVarChar(64), nullable(record.order_no)),
    input("WarehouseCode", "warehouseCode", sql.NVarChar(64), nullable(record.warehouse_code)),
    input("Subtotal", "subtotal", sql.Decimal(15, 2), toNumber(record.subtotal)),
    input("VatTotal", "vatTotal", sql.Decimal(15, 2), toNumber(record.vat_total)),
    input("GrandTotal", "grandTotal", sql.Decimal(15, 2), toNumber(record.grand_total)),
    input("ExportKey", "exportKey", sql.NVarChar(128), nullable(record.export_key)),
    input("PayloadJson", "payloadJson", sql.NVarChar(sql.MAX), JSON.stringify(record)),
  ];
}

function buildWarehouseTransferInputs(record) {
  return [
    input("TransferDate", "transferDate", sql.Date, toDate(record.transfer_date)),
    input("TransferNo", "transferNo", sql.NVarChar(64), nullable(record.transfer_no)),
    input("OrderNo", "orderNo", sql.NVarChar(64), nullable(record.order_no)),
    input("SourceWarehouseCode", "sourceWarehouseCode", sql.NVarChar(64), nullable(record.source_warehouse_code)),
    input("SourceWarehouseName", "sourceWarehouseName", sql.NVarChar(160), nullable(record.source_warehouse_name)),
    input("TargetWarehouseCode", "targetWarehouseCode", sql.NVarChar(64), nullable(record.target_warehouse_code)),
    input("TargetWarehouseName", "targetWarehouseName", sql.NVarChar(160), nullable(record.target_warehouse_name)),
    input("ExportKey", "exportKey", sql.NVarChar(128), nullable(record.export_key)),
    input("PayloadJson", "payloadJson", sql.NVarChar(sql.MAX), JSON.stringify(record)),
  ];
}

function buildPurchaseReceiptInputs(record) {
  return [
    input("ReceiptDate", "receiptDate", sql.Date, toDate(record.received_at)),
    input("ReceiptNo", "receiptNo", sql.NVarChar(64), nullable(record.receipt_no)),
    input("DocumentNo", "documentNo", sql.NVarChar(64), nullable(record.document_no)),
    input("SupplierName", "supplierName", sql.NVarChar(160), nullable(record.supplier_name)),
    input("WarehouseCode", "warehouseCode", sql.NVarChar(64), nullable(record.warehouse_code)),
    input("WarehouseName", "warehouseName", sql.NVarChar(160), nullable(record.warehouse_name)),
    input("AcceptedQuantityTotal", "acceptedQuantityTotal", sql.Int, toNumber(record.accepted_quantity_total)),
    input("ExpectedQuantityTotal", "expectedQuantityTotal", sql.Int, toNumber(record.expected_quantity_total)),
    input("ExportKey", "exportKey", sql.NVarChar(128), nullable(record.export_key)),
    input("PayloadJson", "payloadJson", sql.NVarChar(sql.MAX), JSON.stringify(record)),
  ];
}

function buildReturnInputs(record) {
  return [
    input("CustomerExternalRef", "customerExternalRef", sql.NVarChar(128), nullable(record.customer_external_ref)),
    input("CustomerCode", "customerCode", sql.NVarChar(64), nullable(record.customer_code)),
    input("ReturnDate", "returnDate", sql.Date, toDate(record.return_date)),
    input("RequestNo", "requestNo", sql.NVarChar(64), nullable(record.request_no)),
    input("WarehouseCode", "warehouseCode", sql.NVarChar(64), nullable(record.warehouse_code)),
    input("WarehouseName", "warehouseName", sql.NVarChar(160), nullable(record.warehouse_name)),
    input("ReturnType", "returnType", sql.NVarChar(32), nullable(record.request_type)),
    input("ReasonCode", "reasonCode", sql.NVarChar(64), nullable(record.reason_code)),
    input("Amount", "amount", sql.Decimal(15, 2), toNumber(record.line_total)),
    input("Currency", "currency", sql.NVarChar(3), nullable(record.currency) ?? "TRY"),
    input("ExportKey", "exportKey", sql.NVarChar(128), nullable(record.export_key)),
    input("PayloadJson", "payloadJson", sql.NVarChar(sql.MAX), JSON.stringify(record)),
  ];
}

function buildReturnScrapInputs(record) {
  return [
    input("CustomerExternalRef", "customerExternalRef", sql.NVarChar(128), nullable(record.customer_external_ref)),
    input("CustomerCode", "customerCode", sql.NVarChar(64), nullable(record.customer_code)),
    input("ScrapDate", "scrapDate", sql.Date, toDate(record.scrap_date)),
    input("DocumentNo", "documentNo", sql.NVarChar(64), nullable(record.document_no ?? record.docode)),
    input("RequestNo", "requestNo", sql.NVarChar(64), nullable(record.request_no)),
    input("WarehouseCode", "warehouseCode", sql.NVarChar(64), nullable(record.warehouse_code)),
    input("WarehouseName", "warehouseName", sql.NVarChar(160), nullable(record.warehouse_name)),
    input("ReturnType", "returnType", sql.NVarChar(32), nullable(record.request_type)),
    input("ReasonCode", "reasonCode", sql.NVarChar(64), nullable(record.reason_code)),
    input("Amount", "amount", sql.Decimal(15, 2), toNumber(record.line_total)),
    input("Currency", "currency", sql.NVarChar(3), nullable(record.currency) ?? "TRY"),
    input("ExportKey", "exportKey", sql.NVarChar(128), nullable(record.export_key)),
    input("PayloadJson", "payloadJson", sql.NVarChar(sql.MAX), JSON.stringify(record)),
  ];
}

function input(parameter, binding, type, value) {
  return { parameter, binding, type, value };
}

async function acknowledge(step, records) {
  if (!Array.isArray(records) || records.length === 0) {
    return;
  }

  const response = await fetch(step.ackUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-integration-key": step.syncKey,
    },
    body: JSON.stringify({ records }),
    signal: AbortSignal.timeout(step.apiTimeoutMs),
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? JSON.stringify(await response.json())
      : await response.text();

    throw new Error(`ack endpoint returned ${response.status}: ${body}`);
  }

  const body = await response.json();
  console.log(`[logo-sync] ${step.label} ack response:`, JSON.stringify(body.summary ?? body));
}

function derivePendingUrl(baseUrl, resource) {
  const normalized = nullable(baseUrl);
  if (!normalized) {
    return null;
  }

  return normalized.replace(/\/customers\/sync$/i, `/${resource}/pending`);
}

function deriveAckUrl(baseUrl, resource) {
  const normalized = nullable(baseUrl);
  if (!normalized) {
    return null;
  }

  return normalized.replace(/\/customers\/sync$/i, `/${resource}/ack`);
}

function hasProcedureParameter(parameters, name) {
  return parameters.has(`@${name.toLowerCase()}`);
}

function toDate(value) {
  const normalized = nullable(value);
  if (!normalized) {
    return new Date();
  }

  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function toNumber(value) {
  const parsed = Number.parseFloat(String(value ?? 0));
  return Number.isFinite(parsed) ? parsed : 0;
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
