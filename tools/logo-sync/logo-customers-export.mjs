#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import sql from "mssql";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(scriptDir, ".env");
const defaultCustomerExportProcedure = "dbo.PowersaB2B_ExportCustomer";

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

  const pendingPayload = await fetchPendingCustomers(config);
  const records = Array.isArray(pendingPayload.records) ? pendingPayload.records : [];
  console.log(`[logo-sync] fetched ${records.length} pending customer(s) from B2B`);

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
        const externalReference = await exportCustomer(pool, config, record);
        acknowledgements.push({
          customer_id: record.customer_id,
          status: "synced",
          external_ref: externalReference,
          meta: {
            export_key: record.export_key,
          },
        });
        console.log(
          `[logo-sync] exported customer_id=${record.customer_id} external_ref=${externalReference ?? "null"}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        acknowledgements.push({
          customer_id: record.customer_id,
          status: "failed",
          error: message.slice(0, 2000),
          meta: {
            export_key: record.export_key,
          },
        });
        console.warn(`[logo-sync] customer export failed id=${record.customer_id}: ${message}`);
      }
    }

    await acknowledgeCustomers(config, acknowledgements);

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
    nullable(process.env.POWERSA_CUSTOMERS_PENDING_URL) ??
    deriveCustomersPendingUrl(process.env.POWERSA_SYNC_URL);
  const ackUrl =
    nullable(process.env.POWERSA_CUSTOMERS_ACK_URL) ??
    deriveCustomersAckUrl(process.env.POWERSA_SYNC_URL);
  const syncKey = (process.env.POWERSA_CUSTOMERS_SYNC_KEY ?? process.env.POWERSA_SYNC_KEY ?? "").trim();

  return {
    logo: {
      server: (process.env.LOGO_SQL_SERVER ?? "").trim(),
      instanceName: nullable(process.env.LOGO_SQL_INSTANCE),
      port,
      database: (process.env.LOGO_SQL_DATABASE ?? "").trim(),
      user: (process.env.LOGO_SQL_USER ?? "").trim(),
      password: process.env.LOGO_SQL_PASSWORD ?? "",
      customerExportProcedure: (process.env.LOGO_CUSTOMER_EXPORT_PROCEDURE ?? defaultCustomerExportProcedure).trim(),
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
      limit: parseInteger(process.env.POWERSA_CUSTOMERS_LIMIT, 100),
    },
  };
}

function validateConfig(currentConfig) {
  const missing = [];

  if (!currentConfig.logo.server) missing.push("LOGO_SQL_SERVER");
  if (!currentConfig.logo.database) missing.push("LOGO_SQL_DATABASE");
  if (!currentConfig.logo.user) missing.push("LOGO_SQL_USER");
  if (!currentConfig.logo.password) missing.push("LOGO_SQL_PASSWORD");
  if (!currentConfig.logo.customerExportProcedure) missing.push("LOGO_CUSTOMER_EXPORT_PROCEDURE");
  if (!currentConfig.sync.pendingUrl) missing.push("POWERSA_CUSTOMERS_PENDING_URL or POWERSA_SYNC_URL");
  if (!currentConfig.sync.ackUrl) missing.push("POWERSA_CUSTOMERS_ACK_URL or POWERSA_SYNC_URL");
  if (!currentConfig.sync.key) missing.push("POWERSA_CUSTOMERS_SYNC_KEY or POWERSA_SYNC_KEY");

  if (missing.length > 0) {
    throw new Error(`missing required config: ${missing.join(", ")}`);
  }

  if (!/^[A-Za-z0-9_.\[\]]+$/.test(currentConfig.logo.customerExportProcedure)) {
    throw new Error("LOGO_CUSTOMER_EXPORT_PROCEDURE contains unsupported characters");
  }

  if (currentConfig.logo.port !== undefined) {
    currentConfig.logo.connection.port = currentConfig.logo.port;
  }
}

async function fetchPendingCustomers(currentConfig) {
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

async function exportCustomer(pool, currentConfig, record) {
  const request = pool.request();
  request.input("customerCode", sql.NVarChar(64), nullable(record.customer_code));
  request.input("name", sql.NVarChar(255), nullable(record.name));
  request.input("contactName", sql.NVarChar(255), nullable(record.contact_name));
  request.input("email", sql.NVarChar(255), nullable(record.email));
  request.input("phone", sql.NVarChar(32), nullable(record.phone));
  request.input("city", sql.NVarChar(120), nullable(record.city));
  request.input("district", sql.NVarChar(120), nullable(record.district));
  request.input("taxOffice", sql.NVarChar(255), nullable(record.tax_office));
  request.input("taxNumber", sql.NVarChar(32), nullable(record.tax_number));
  request.input("creditLimit", sql.Decimal(15, 2), Number.parseFloat(String(record.credit_limit ?? 0)));
  request.input("isActive", sql.Bit, record.is_active ? 1 : 0);
  request.input("address", sql.NVarChar(sql.MAX), nullable(record.address));
  request.input("iban", sql.NVarChar(64), nullable(record.iban));
  request.input("exportKey", sql.NVarChar(128), nullable(record.export_key));
  request.input(
    "payloadJson",
    sql.NVarChar(sql.MAX),
    JSON.stringify({
      customer_id: record.customer_id,
      dealer_id: record.dealer_id,
      meta: record.meta ?? {},
    })
  );

  const result = await request.query(`
    DECLARE @ExternalRef NVARCHAR(128);
    EXEC ${currentConfig.logo.customerExportProcedure}
      @CustomerCode = @customerCode,
      @Name = @name,
      @ContactName = @contactName,
      @Email = @email,
      @Phone = @phone,
      @City = @city,
      @District = @district,
      @TaxOffice = @taxOffice,
      @TaxNumber = @taxNumber,
      @CreditLimit = @creditLimit,
      @IsActive = @isActive,
      @Address = @address,
      @Iban = @iban,
      @ExportKey = @exportKey,
      @PayloadJson = @payloadJson,
      @ExternalRef = @ExternalRef OUTPUT;
    SELECT @ExternalRef AS external_ref;
  `);

  return (
    normalizeString(result.recordset?.[0]?.external_ref) ??
    nullable(record.export_key)
  );
}

async function acknowledgeCustomers(currentConfig, records) {
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

function deriveCustomersPendingUrl(baseUrl) {
  const normalized = nullable(baseUrl);
  if (!normalized) {
    return null;
  }

  return normalized.replace(/\/customers\/sync$/i, "/customers/pending");
}

function deriveCustomersAckUrl(baseUrl) {
  const normalized = nullable(baseUrl);
  if (!normalized) {
    return null;
  }

  return normalized.replace(/\/customers\/sync$/i, "/customers/ack");
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
