#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import sql from "mssql";

import { logoFirmTable, logoPeriodTable } from "./logo-table-names.mjs";

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
    const schema = await inspectTable(pool, config.logo.ledgerTable);
    console.log(
      `[logo-sync] discovered ${schema.columns.length} column(s) on ${config.logo.ledgerTable}`
    );

    const syncState = loadSyncState(config.sync.stateFile);
    const syncPlan = resolveSyncPlan(config, schema, syncState);
    console.log(`[logo-sync] mode=${syncPlan.mode}${syncPlan.reason ? ` reason=${syncPlan.reason}` : ""}`);

    const rows = await fetchLedgerRows(pool, config, schema, syncPlan);
    console.log(`[logo-sync] fetched ${rows.length} ledger row(s) from ${config.logo.ledgerTable}`);
    const invoiceRows = await fetchInvoiceFallbackRows(pool, config, syncState);
    if (invoiceRows.length > 0) {
      console.log(`[logo-sync] fetched ${invoiceRows.length} invoice fallback row(s) from ${config.logo.invoiceTable}`);
    }

    const payloadRows = [
      ...rows.map((row) => ({ kind: "ledger", row })),
      ...invoiceRows.map((row) => ({ kind: "invoice", row })),
    ];
    const chunks = chunk(payloadRows, config.sync.batchSize);
    let sent = 0;
    let skipped = 0;
    let mappedRows = [];
    let mappedInvoiceRows = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const currentChunk = chunks[index];
      const records = [];

      for (const item of currentChunk) {
        const record = item.kind === "invoice"
          ? mapInvoiceFallbackRow(item.row, config.logo.invoiceTable)
          : mapLedgerRow(item.row, config.logo.ledgerTable, schema);
        if (!record) {
          skipped += 1;
          continue;
        }

        if (item.kind === "invoice") {
          mappedInvoiceRows.push(item.row);
        } else {
          mappedRows.push(item.row);
        }
        records.push(record);
      }

      if (records.length === 0) {
        continue;
      }

      console.log(
        `[logo-sync] sending batch ${index + 1}/${chunks.length} with ${records.length} record(s)`
      );

      await pushBatch(records, config);
      sent += records.length;
    }

    if (mappedRows.length > 0 || mappedInvoiceRows.length > 0) {
      saveSyncState(config.sync.stateFile, buildSyncState(config, mappedRows, mappedInvoiceRows, syncState));
    }

    const durationMs = Date.now() - startedAt;
    console.log(`[logo-sync] completed. sent=${sent} skipped=${skipped} duration=${durationMs}ms`);
  } finally {
    await pool.close();
  }
}

function buildConfig() {
  const batchSize = parseInteger(process.env.SYNC_BATCH_SIZE, 500);
  const timeoutMs = parseInteger(process.env.LOGO_SQL_REQUEST_TIMEOUT_MS, 30000);
  const port = parseInteger(process.env.LOGO_SQL_PORT, undefined);
  const syncUrl =
    nullable(process.env.POWERSA_LEDGER_SYNC_URL) ??
    deriveLedgerSyncUrl(process.env.POWERSA_SYNC_URL);
  const syncKey = (process.env.POWERSA_LEDGER_SYNC_KEY ?? process.env.POWERSA_SYNC_KEY ?? "").trim();
  const dealerId = parseInteger(process.env.POWERSA_DEALER_ID, undefined);
  const modifiedLookbackMs = parseInteger(process.env.LOGO_LEDGER_MODIFIED_LOOKBACK_MS, 300_000);

  return {
    logo: {
      server: (process.env.LOGO_SQL_SERVER ?? "").trim(),
      instanceName: nullable(process.env.LOGO_SQL_INSTANCE),
      port,
      database: (process.env.LOGO_SQL_DATABASE ?? "").trim(),
      user: (process.env.LOGO_SQL_USER ?? "").trim(),
      password: process.env.LOGO_SQL_PASSWORD ?? "",
      ledgerTable: nullable(process.env.LOGO_LEDGER_TABLE) ?? logoPeriodTable("CLFLINE"),
      invoiceTable: nullable(process.env.LOGO_INVOICE_TABLE) ?? logoPeriodTable("INVOICE"),
      invoiceLineTable: nullable(process.env.LOGO_STOCK_LINE_TABLE) ?? logoPeriodTable("STLINE"),
      productTable: nullable(process.env.LOGO_PRODUCT_TABLE) ?? logoFirmTable("ITEMS"),
      unitTable: nullable(process.env.LOGO_UNIT_TABLE) ?? logoFirmTable("UNITSETL"),
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
      url: syncUrl ?? "",
      key: syncKey,
      dealerId,
      dealerCode: nullable(process.env.POWERSA_DEALER_CODE),
      forceFull: parseBoolean(process.env.SYNC_FORCE_FULL, false),
      includeInvoiceFallback: parseBoolean(process.env.LOGO_LEDGER_INCLUDE_INVOICE_FALLBACK, true),
      invoiceFallbackLookbackDays: parseInteger(process.env.LOGO_LEDGER_INVOICE_FALLBACK_LOOKBACK_DAYS, 30),
      modifiedLookbackMs: Math.max(60_000, modifiedLookbackMs),
      stateFile: path.resolve(scriptDir, process.env.SYNC_LEDGER_STATE_FILE ?? ".ledger-sync-state.json"),
    },
  };
}

function validateConfig(currentConfig) {
  const missing = [];

  if (!currentConfig.logo.server) missing.push("LOGO_SQL_SERVER");
  if (!currentConfig.logo.database) missing.push("LOGO_SQL_DATABASE");
  if (!currentConfig.logo.user) missing.push("LOGO_SQL_USER");
  if (!currentConfig.logo.password) missing.push("LOGO_SQL_PASSWORD");
  if (!currentConfig.logo.ledgerTable) missing.push("LOGO_LEDGER_TABLE");
  if (!currentConfig.sync.url) missing.push("POWERSA_LEDGER_SYNC_URL or POWERSA_SYNC_URL");
  if (!currentConfig.sync.key) missing.push("POWERSA_LEDGER_SYNC_KEY or POWERSA_SYNC_KEY");
  if (!currentConfig.sync.dealerId && !currentConfig.sync.dealerCode) {
    missing.push("POWERSA_DEALER_ID or POWERSA_DEALER_CODE");
  }

  if (missing.length > 0) {
    throw new Error(`missing required config: ${missing.join(", ")}`);
  }

  if (!/^[A-Za-z0-9_.\[\]]+$/.test(currentConfig.logo.ledgerTable)) {
    throw new Error("LOGO_LEDGER_TABLE contains unsupported characters");
  }
  if (!/^[A-Za-z0-9_.\[\]]+$/.test(currentConfig.logo.invoiceTable)) {
    throw new Error("LOGO_INVOICE_TABLE contains unsupported characters");
  }
  for (const [key, tableName] of [
    ["LOGO_STOCK_LINE_TABLE", currentConfig.logo.invoiceLineTable],
    ["LOGO_PRODUCT_TABLE", currentConfig.logo.productTable],
    ["LOGO_UNIT_TABLE", currentConfig.logo.unitTable],
  ]) {
    if (!/^[A-Za-z0-9_.\[\]]+$/.test(tableName)) {
      throw new Error(`${key} contains unsupported characters`);
    }
  }

  if (currentConfig.sync.batchSize < 1 || currentConfig.sync.batchSize > 1000) {
    throw new Error("SYNC_BATCH_SIZE must be between 1 and 1000");
  }

  if (currentConfig.logo.port !== undefined) {
    currentConfig.logo.connection.port = currentConfig.logo.port;
  }
}

async function inspectTable(pool, tableName) {
  const [schemaName, objectName] = splitTableName(tableName);
  const result = await pool
    .request()
    .input("schemaName", sql.NVarChar(128), schemaName)
    .input("tableName", sql.NVarChar(128), objectName)
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
    throw new Error(`Logo ledger table not found: ${tableName}`);
  }

  return {
    schemaName,
    tableName: objectName,
    columns,
    columnSet: new Set(columns.map((column) => column.toUpperCase())),
  };
}

function resolveSyncPlan(currentConfig, schema, syncState) {
  const modifiedColumn = findColumn(schema.columns, [
    "CAPIBLOCK_MODIFIEDDATE",
    "CAPIBLOK_MODIFIEDDATE",
  ]);
  const logicalRefColumn = findColumn(schema.columns, ["LOGICALREF"]);

  if (!logicalRefColumn) {
    return {
      mode: "full",
      reason: "LOGICALREF_missing",
    };
  }

  if (currentConfig.sync.forceFull) {
    return {
      mode: "full",
      reason: "SYNC_FORCE_FULL",
      modifiedColumn,
      logicalRefColumn,
    };
  }

  if (
    syncState &&
    syncState.database === currentConfig.logo.database &&
    syncState.ledger_table === currentConfig.logo.ledgerTable &&
    Number.isFinite(Number(syncState.last_logicalref))
  ) {
    const lastCheckedAt =
      normalizeString(syncState.saved_at) ??
      normalizeString(syncState.last_modified_at);
    const modifiedSince = lastCheckedAt
      ? new Date(new Date(lastCheckedAt).getTime() - currentConfig.sync.modifiedLookbackMs)
      : null;

    return {
      mode: "delta",
      reason: "state_file",
      modifiedColumn,
      logicalRefColumn,
      cursor: {
        last_logicalref: Number(syncState.last_logicalref),
        modified_since: modifiedColumn && modifiedSince && !Number.isNaN(modifiedSince.getTime())
          ? modifiedSince
          : null,
      },
    };
  }

  return {
    mode: "full",
    reason: "initial_sync",
    modifiedColumn,
    logicalRefColumn,
  };
}

async function fetchLedgerRows(pool, currentConfig, schema, syncPlan) {
  const request = pool.request();

  let query = `
    SELECT *
    FROM ${currentConfig.logo.ledgerTable}
    WHERE 1 = 1
  `;

  if (schema.columnSet.has("CANCELLED")) {
    query += `
      AND (CANCELLED IS NULL OR CANCELLED = 0)
    `;
  }

  if (syncPlan.mode === "delta") {
    request.input("lastLogicalRef", sql.Int, syncPlan.cursor.last_logicalref);
    const logicalRefColumn = quoteIdentifier(syncPlan.logicalRefColumn);

    if (syncPlan.modifiedColumn && syncPlan.cursor.modified_since instanceof Date) {
      request.input("modifiedSince", sql.DateTime2, syncPlan.cursor.modified_since);
      const modifiedColumn = quoteIdentifier(syncPlan.modifiedColumn);
      query += `
        AND (
          ${logicalRefColumn} > @lastLogicalRef
          OR (${modifiedColumn} IS NOT NULL AND ${modifiedColumn} >= @modifiedSince)
        )
        ORDER BY ${logicalRefColumn} ASC
      `;
    } else {
      query += `
        AND ${logicalRefColumn} > @lastLogicalRef
        ORDER BY ${logicalRefColumn} ASC
      `;
    }
  } else if (syncPlan.modifiedColumn && syncPlan.logicalRefColumn) {
    const modifiedColumn = quoteIdentifier(syncPlan.modifiedColumn);
    const logicalRefColumn = quoteIdentifier(syncPlan.logicalRefColumn);
    query += `
      ORDER BY
        CASE WHEN ${modifiedColumn} IS NULL THEN 0 ELSE 1 END ASC,
        ${modifiedColumn} ASC,
        ${logicalRefColumn} ASC
    `;
  } else if (schema.columnSet.has("LOGICALREF")) {
    query += `
      ORDER BY LOGICALREF ASC
    `;
  }

  const result = await request.query(query);
  return result.recordset ?? [];
}

async function fetchInvoiceFallbackRows(pool, currentConfig, syncState) {
  if (!currentConfig.sync.includeInvoiceFallback) {
    return [];
  }

  let schema;
  try {
    schema = await inspectTable(pool, currentConfig.logo.invoiceTable);
  } catch (error) {
    console.warn(
      `[logo-sync] invoice fallback skipped: ${error instanceof Error ? error.message : error}`
    );
    return [];
  }

  const logicalRefColumn = findColumn(schema.columns, ["LOGICALREF"]);
  const clientRefColumn = findColumn(schema.columns, ["CLIENTREF", "CLCARDREF"]);
  const dateColumn = findColumn(schema.columns, ["DATE_", "DATE"]);
  const amountColumn = findColumn(schema.columns, [
    "NETTOTAL",
    "GROSSTOTAL",
    "TOTAL",
    "TOTALDISCOUNTS",
    "TOTALDISCOUNTED",
  ]);
  const trcodeColumn = findColumn(schema.columns, ["TRCODE"]);
  const grpcodeColumn = findColumn(schema.columns, ["GRPCODE"]);
  const cancelledColumn = findColumn(schema.columns, ["CANCELLED"]);
  const modifiedColumn = findColumn(schema.columns, [
    "CAPIBLOCK_MODIFIEDDATE",
    "CAPIBLOK_MODIFIEDDATE",
  ]);

  if (!logicalRefColumn || !clientRefColumn || !dateColumn || !amountColumn) {
    console.warn(
      `[logo-sync] invoice fallback skipped: ${currentConfig.logo.invoiceTable} is missing required columns`
    );
    return [];
  }

  const request = pool.request();
  const logicalRefIdentifier = quoteIdentifier(logicalRefColumn);
  const clientRefIdentifier = quoteIdentifier(clientRefColumn);
  const dateIdentifier = quoteIdentifier(dateColumn);
  const amountIdentifier = quoteIdentifier(amountColumn);
  let query = `
    SELECT *
    FROM ${currentConfig.logo.invoiceTable}
    WHERE ${clientRefIdentifier} IS NOT NULL
      AND ${clientRefIdentifier} <> 0
      AND ${amountIdentifier} IS NOT NULL
      AND ${amountIdentifier} > 0
  `;

  if (cancelledColumn) {
    query += `
      AND (${quoteIdentifier(cancelledColumn)} IS NULL OR ${quoteIdentifier(cancelledColumn)} = 0)
    `;
  }

  if (trcodeColumn && grpcodeColumn) {
    query += `
      AND (${quoteIdentifier(grpcodeColumn)} = 2 OR ${quoteIdentifier(trcodeColumn)} IN (2, 3, 7, 8, 9))
    `;
  } else if (trcodeColumn) {
    query += `
      AND ${quoteIdentifier(trcodeColumn)} IN (2, 3, 7, 8, 9)
    `;
  } else if (grpcodeColumn) {
    query += `
      AND ${quoteIdentifier(grpcodeColumn)} = 2
    `;
  }

  const hasInvoiceCursor =
    syncState &&
    syncState.database === currentConfig.logo.database &&
    syncState.invoice_table === currentConfig.logo.invoiceTable &&
    Number.isFinite(Number(syncState.last_invoice_logicalref));

  if (!currentConfig.sync.forceFull && hasInvoiceCursor) {
    request.input("lastInvoiceLogicalRef", sql.Int, Number(syncState.last_invoice_logicalref));

    if (modifiedColumn) {
      const lastCheckedAt =
        normalizeString(syncState.invoice_saved_at) ??
        normalizeString(syncState.last_invoice_modified_at) ??
        normalizeString(syncState.saved_at);
      const modifiedSince = lastCheckedAt
        ? new Date(new Date(lastCheckedAt).getTime() - currentConfig.sync.modifiedLookbackMs)
        : null;

      if (modifiedSince && !Number.isNaN(modifiedSince.getTime())) {
        request.input("invoiceModifiedSince", sql.DateTime2, modifiedSince);
        query += `
          AND (
            ${logicalRefIdentifier} > @lastInvoiceLogicalRef
            OR (${quoteIdentifier(modifiedColumn)} IS NOT NULL AND ${quoteIdentifier(modifiedColumn)} >= @invoiceModifiedSince)
          )
        `;
      } else {
        query += `
          AND ${logicalRefIdentifier} > @lastInvoiceLogicalRef
        `;
      }
    } else {
      query += `
        AND ${logicalRefIdentifier} > @lastInvoiceLogicalRef
      `;
    }
  } else if (!currentConfig.sync.forceFull) {
    const lookbackDays = Math.max(1, currentConfig.sync.invoiceFallbackLookbackDays);
    const invoiceSince = new Date(Date.now() - lookbackDays * 86_400_000);
    request.input("invoiceSince", sql.DateTime2, invoiceSince);
    query += `
      AND ${dateIdentifier} >= @invoiceSince
    `;
  }

  query += `
    ORDER BY ${logicalRefIdentifier} ASC
  `;

  const result = await request.query(query);
  const invoiceRows = result.recordset ?? [];
  await attachInvoiceLines(pool, currentConfig, invoiceRows);

  return invoiceRows;
}

async function attachInvoiceLines(pool, currentConfig, invoiceRows) {
  if (!Array.isArray(invoiceRows) || invoiceRows.length === 0) {
    return;
  }

  let lineSchema;
  try {
    lineSchema = await inspectTable(pool, currentConfig.logo.invoiceLineTable);
  } catch (error) {
    console.warn(`[logo-sync] invoice lines skipped: ${error instanceof Error ? error.message : error}`);
    return;
  }

  const invoiceRefColumn = findColumn(lineSchema.columns, ["INVOICEREF"]);
  const cancelledColumn = findColumn(lineSchema.columns, ["CANCELLED"]);
  const lineTypeColumn = findColumn(lineSchema.columns, ["LINETYPE"]);
  const uomRefColumn = findColumn(lineSchema.columns, ["UOMREF", "UNITREF"]);
  const lineNoColumn = findColumn(lineSchema.columns, ["LINENO_", "LINENO", "LINE_NO", "ORDERNR"]);

  if (!invoiceRefColumn) {
    console.warn(`[logo-sync] invoice lines skipped: ${currentConfig.logo.invoiceLineTable} is missing INVOICEREF`);
    return;
  }

  const invoiceRefs = Array.from(new Set(
    invoiceRows
      .map((row) => Number(readFirst(row, ["LOGICALREF", "logicalref"])))
      .filter((value) => Number.isFinite(value) && value > 0)
  ));

  if (invoiceRefs.length === 0) {
    return;
  }

  const productExists = await tableExists(pool, currentConfig.logo.productTable);
  const unitExists = uomRefColumn ? await tableExists(pool, currentConfig.logo.unitTable) : false;
  const lineChunks = chunk(invoiceRefs, 500);
  const linesByInvoice = new Map();

  for (const refs of lineChunks) {
    const request = pool.request();
    const placeholders = refs.map((ref, index) => {
      const key = `invoiceRef${index}`;
      request.input(key, sql.Int, ref);
      return `@${key}`;
    });

    let query = `
      SELECT
        line.LOGICALREF,
        line.INVOICEREF,
        line.STOCKREF,
        ${lineNoColumn ? `line.${quoteIdentifier(lineNoColumn)} AS LINENO_,` : "CAST(NULL AS int) AS LINENO_,"}
        line.AMOUNT,
        line.PRICE,
        line.TOTAL,
        line.DISTDISC,
        line.VAT,
        line.VATAMNT,
        line.VATMATRAH,
        line.LINEEXP,
        ${uomRefColumn ? `line.${quoteIdentifier(uomRefColumn)} AS UOMREF` : "NULL AS UOMREF"},
        line.USREF
        ${productExists ? ", item.CODE AS ITEM_CODE, item.NAME AS ITEM_NAME" : ""}
        ${unitExists ? ", unitLine.CODE AS UNIT_CODE, unitLine.NAME AS UNIT_NAME" : ""}
      FROM ${currentConfig.logo.invoiceLineTable} AS line WITH (NOLOCK)
      ${productExists ? `LEFT JOIN ${currentConfig.logo.productTable} AS item WITH (NOLOCK) ON item.LOGICALREF = line.STOCKREF` : ""}
      ${unitExists ? `LEFT JOIN ${currentConfig.logo.unitTable} AS unitLine WITH (NOLOCK) ON unitLine.LOGICALREF = line.${quoteIdentifier(uomRefColumn)}` : ""}
      WHERE line.${quoteIdentifier(invoiceRefColumn)} IN (${placeholders.join(", ")})
        ${lineTypeColumn ? `AND ISNULL(line.${quoteIdentifier(lineTypeColumn)}, 0) = 0` : ""}
    `;

    if (cancelledColumn) {
      query += `
        AND (line.${quoteIdentifier(cancelledColumn)} IS NULL OR line.${quoteIdentifier(cancelledColumn)} = 0)
      `;
    }

    query += `
      ORDER BY line.${quoteIdentifier(invoiceRefColumn)} ASC${lineNoColumn ? `, line.${quoteIdentifier(lineNoColumn)} ASC` : ""}, line.LOGICALREF ASC
    `;

    const result = await request.query(query);
    for (const row of result.recordset ?? []) {
      const invoiceRef = Number(readFirst(row, ["INVOICEREF", "invoiceref"]));
      if (!Number.isFinite(invoiceRef)) {
        continue;
      }

      if (!linesByInvoice.has(invoiceRef)) {
        linesByInvoice.set(invoiceRef, []);
      }

      linesByInvoice.get(invoiceRef).push(mapInvoiceLineRow(row));
    }
  }

  for (const invoiceRow of invoiceRows) {
    const logicalRef = Number(readFirst(invoiceRow, ["LOGICALREF", "logicalref"]));
    invoiceRow.__invoice_lines = linesByInvoice.get(logicalRef) ?? [];
  }
}

async function tableExists(pool, tableName) {
  const [schemaName, objectName] = splitTableName(tableName);
  const result = await pool.request()
    .input("schemaName", sql.NVarChar(128), schemaName)
    .input("tableName", sql.NVarChar(128), objectName)
    .query(`
      SELECT 1 AS found
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = @schemaName
        AND TABLE_NAME = @tableName
    `);

  return (result.recordset ?? []).length > 0;
}

function mapLedgerRow(row, ledgerTable, schema) {
  const externalRef = normalizeString(readFirst(row, ["external_ref", "LOGICALREF", "logicalref"]));
  const customerExternalRef = normalizeString(
    readFirst(row, [
      "customer_external_ref",
      "CLIENTREF",
      "clientref",
      "CLCARDREF",
      "clcardref",
    ])
  );
  const customerCode = normalizeString(
    readFirst(row, ["customer_code", "client_code", "CLIENT_CODE", "CARI_CODE", "cari_code"])
  );
  const date = normalizeDate(readFirst(row, ["date", "DATE_", "DATE", "entry_date", "ENTRY_DATE"]));

  let debit = normalizeDecimal(readFirst(row, ["debit", "DEBIT"]));
  let credit = normalizeDecimal(readFirst(row, ["credit", "CREDIT"]));

  if (debit === null && credit === null) {
    const amount = normalizeDecimal(readFirst(row, ["amount", "AMOUNT"]));
    const logoSign = normalizeString(readFirst(row, ["SIGN", "sign"]));
    const entryType = normalizeString(readFirst(row, ["entry_type", "ENTRY_TYPE"]));

    if (amount !== null && logoSign !== null && ["0", "1"].includes(logoSign)) {
      if (logoSign === "0") {
        debit = amount;
      } else {
        credit = amount;
      }
    } else if (amount !== null && entryType !== null) {
      const normalizedEntryType = entryType.toLowerCase();
      if (["debit", "borc", "b", "1"].includes(normalizedEntryType)) {
        debit = amount;
      } else if (["credit", "alacak", "a", "-1"].includes(normalizedEntryType)) {
        credit = amount;
      }
    }
  }

  if (!externalRef || !date || (!customerExternalRef && !customerCode) || (debit === null && credit === null)) {
    return null;
  }

  const type = normalizeLedgerType(readFirst(row, ["type", "TYPE", "trx_type", "TRX_TYPE"]), debit, credit);
  const rawRecord = extractRawLogoRecord(row, schema.columns);

  return {
    external_ref: externalRef,
    customer_external_ref: customerExternalRef,
    customer_code: customerCode,
    date,
    type,
    debit: debit ?? 0,
    credit: credit ?? 0,
    balance_after: normalizeDecimal(readFirst(row, ["balance_after", "BALANCE_AFTER"])),
    currency: normalizeString(readFirst(row, ["currency", "CURRENCY"])) ?? "TRY",
    reference_no: normalizeString(readFirst(row, [
      "reference_no",
      "REFERENCE_NO",
      "FICHENO",
      "ficheno",
      "TRANNO",
      "tranno",
      "DOCODE",
      "docode",
    ])),
    description: normalizeString(readFirst(row, ["description", "DESCRIPTION", "LINEEXP", "lineexp"])),
    meta: {
      logo_table: ledgerTable,
      source_modified_date: readFirst(row, [
        "CAPIBLOCK_MODIFIEDDATE",
        "capiblock_modifieddate",
        "CAPIBLOK_MODIFIEDDATE",
        "capiblok_modifieddate",
      ]) ?? null,
      raw: rawRecord,
    },
  };
}

function mapInvoiceFallbackRow(row, invoiceTable) {
  const externalRef = normalizeString(readFirst(row, ["LOGICALREF", "logicalref"]));
  const customerExternalRef = normalizeString(readFirst(row, ["CLIENTREF", "clientref", "CLCARDREF", "clcardref"]));
  const customerCode = normalizeString(readFirst(row, ["CLIENT_CODE", "client_code", "CARI_CODE", "cari_code"]));
  const date = normalizeDate(readFirst(row, ["DATE_", "DATE", "date"]));
  const amount = normalizeDecimal(readFirst(row, ["NETTOTAL", "GROSSTOTAL", "TOTALDISCOUNTED", "TOTAL"]));
  const trcode = normalizeInteger(readFirst(row, ["TRCODE", "trcode"]));
  const isReturnInvoice = [2, 3].includes(trcode ?? 0);

  if (!externalRef || !date || (!customerExternalRef && !customerCode) || amount === null || amount <= 0) {
    return null;
  }

  const rawRecord = extractRawLogoRecord(row, Object.keys(row));
  const referenceNo = normalizeString(readFirst(row, [
    "FICHENO",
    "ficheno",
    "DOCODE",
    "docode",
    "GENEXP1",
    "genexp1",
  ]));

  return {
    external_ref: `INVOICE-${externalRef}`,
    customer_external_ref: customerExternalRef,
    customer_code: customerCode,
    date,
    type: isReturnInvoice ? "credit" : "invoice",
    debit: isReturnInvoice ? 0 : amount,
    credit: isReturnInvoice ? amount : 0,
    balance_after: null,
    currency: normalizeString(readFirst(row, ["currency", "CURRENCY"])) ?? "TRY",
    reference_no: referenceNo,
    description: normalizeString(readFirst(row, [
      "GENEXP1",
      "genexp1",
      "FICHENO",
      "ficheno",
      "DOCODE",
      "docode",
    ])),
    meta: {
      logo_table: invoiceTable,
      logo_source: "invoice_fallback",
      logo_invoice_ref: externalRef,
      logo_invoice_trcode: trcode,
      logo_document_kind: isReturnInvoice ? "sales_return_invoice" : "sales_invoice",
      logo_invoice_lines: Array.isArray(row.__invoice_lines) ? row.__invoice_lines : [],
      source_modified_date: readFirst(row, [
        "CAPIBLOCK_MODIFIEDDATE",
        "capiblock_modifieddate",
        "CAPIBLOK_MODIFIEDDATE",
        "capiblok_modifieddate",
      ]) ?? null,
      raw: rawRecord,
    },
  };
}

function mapInvoiceLineRow(row) {
  return {
    logo_line_ref: normalizeString(readFirst(row, ["LOGICALREF", "logicalref"])),
    line_no: normalizeInteger(readFirst(row, ["LINENO_", "lineno_"])),
    product_ref: normalizeString(readFirst(row, ["STOCKREF", "stockref"])),
    product_code: normalizeString(readFirst(row, ["ITEM_CODE", "item_code"])),
    product_name: normalizeString(readFirst(row, ["ITEM_NAME", "item_name", "LINEEXP", "lineexp"])),
    quantity: normalizeDecimal(readFirst(row, ["AMOUNT", "amount"])) ?? 0,
    unit: normalizeString(readFirst(row, ["UNIT_CODE", "unit_code", "UNIT_NAME", "unit_name"])),
    unit_price: normalizeDecimal(readFirst(row, ["PRICE", "price"])) ?? 0,
    discount_total: normalizeDecimal(readFirst(row, ["DISTDISC", "distdisc"])) ?? 0,
    vat_rate: normalizeDecimal(readFirst(row, ["VAT", "vat"])) ?? 0,
    vat_amount: normalizeDecimal(readFirst(row, ["VATAMNT", "vatamnt"])) ?? 0,
    vat_base: normalizeDecimal(readFirst(row, ["VATMATRAH", "vatmatrah"])) ?? 0,
    line_total: normalizeDecimal(readFirst(row, ["TOTAL", "total"])) ?? 0,
    description: normalizeString(readFirst(row, ["LINEEXP", "lineexp"])),
  };
}

function normalizeLedgerType(value, debit, credit) {
  const normalized = normalizeString(value)?.toLowerCase();

  if (normalized) {
    if (["invoice", "fatura"].includes(normalized)) return "invoice";
    if (["payment", "tahsilat"].includes(normalized)) return "payment";
    if (["credit", "alacak"].includes(normalized)) return "credit";
    if (["debit", "borc"].includes(normalized)) return "debit";
  }

  return (debit ?? 0) > 0 ? "invoice" : "payment";
}

function buildSyncState(currentConfig, rows, invoiceRows, previousState = null) {
  const previousLedgerRef = Number(previousState?.last_logicalref ?? 0);
  const lastLogicalRef = rows.reduce((highest, row) => {
    const logicalRef = Number(readFirst(row, ["LOGICALREF", "logicalref", "external_ref"]) ?? 0);

    return Number.isFinite(logicalRef) ? Math.max(highest, logicalRef) : highest;
  }, Number.isFinite(previousLedgerRef) ? previousLedgerRef : 0);
  const modifiedValues = rows
    .map((row) => normalizeValue(readFirst(row, [
      "CAPIBLOCK_MODIFIEDDATE",
      "capiblock_modifieddate",
      "CAPIBLOK_MODIFIEDDATE",
      "capiblok_modifieddate",
    ])))
    .filter(Boolean)
    .sort();

  const state = {
    database: currentConfig.logo.database,
    ledger_table: currentConfig.logo.ledgerTable,
    last_modified_at: modifiedValues.at(-1) ?? previousState?.last_modified_at ?? null,
    last_logicalref: Number.isFinite(lastLogicalRef) ? lastLogicalRef : 0,
    saved_at: new Date().toISOString(),
  };

  if (invoiceRows.length > 0 || previousState?.invoice_table) {
    const previousInvoiceRef = Number(previousState?.last_invoice_logicalref ?? 0);
    const lastInvoiceLogicalRef = invoiceRows.reduce((highest, row) => {
      const logicalRef = Number(readFirst(row, ["LOGICALREF", "logicalref"]) ?? 0);

      return Number.isFinite(logicalRef) ? Math.max(highest, logicalRef) : highest;
    }, Number.isFinite(previousInvoiceRef) ? previousInvoiceRef : 0);
    const invoiceModifiedValues = invoiceRows
      .map((row) => normalizeValue(readFirst(row, [
        "CAPIBLOCK_MODIFIEDDATE",
        "capiblock_modifieddate",
        "CAPIBLOK_MODIFIEDDATE",
        "capiblok_modifieddate",
      ])))
      .filter(Boolean)
      .sort();

    state.invoice_table = currentConfig.logo.invoiceTable;
    state.last_invoice_logicalref = Number.isFinite(lastInvoiceLogicalRef) ? lastInvoiceLogicalRef : 0;
    state.last_invoice_modified_at =
      invoiceModifiedValues.at(-1) ?? previousState?.last_invoice_modified_at ?? null;
    state.invoice_saved_at = new Date().toISOString();
  }

  return state;
}

async function pushBatch(records, currentConfig) {
  const payload = { records };

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

function deriveLedgerSyncUrl(baseUrl) {
  const normalized = nullable(baseUrl);
  if (!normalized) {
    return null;
  }

  return normalized.replace(/\/customers\/sync$/i, "/ledger/sync");
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

function findColumn(columns, aliases) {
  for (const alias of aliases) {
    const matchingColumn = columns.find(
      (column) => String(column).toUpperCase() === String(alias).toUpperCase()
    );

    if (matchingColumn) {
      return matchingColumn;
    }
  }

  return null;
}

function quoteIdentifier(value) {
  return `[${String(value ?? "").replaceAll("]", "]]")}]`;
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

function chunk(items, size) {
  const result = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
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

function normalizeString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
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

  const parsed = Number.parseInt(String(value).replace(",", "."), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDate(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
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
