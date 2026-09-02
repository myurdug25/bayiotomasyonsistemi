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

main().catch((error) => {
  console.error(
    "[logo-finance-definitions-sync] failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});

async function main() {
  const config = buildConfig();
  validateConfig(config);

  const pending = await apiRequest(config, "/api/integrations/logo/finance-definitions/pending");
  const definitions = Array.isArray(pending.records) ? pending.records : [];

  const pool = new sql.ConnectionPool(config.connection);
  await pool.connect();

  try {
    const availableTables = [];
    for (const table of config.tables) {
      if (await tableExists(pool, table.name)) {
        availableTables.push(table);
      }
    }
    const discoveredTables = await discoverCandidateTables(pool);
    for (const table of discoveredTables) {
      if (!availableTables.some((candidate) => candidate.name === table.name)) {
        availableTables.push(table);
      }
    }

    if (availableTables.length === 0) {
      throw new Error("Logo cari veya muhasebe hesap tablosu bulunamadı.");
    }

    const records = [];
    const unresolved = [];

    for (const definition of definitions) {
      const code = normalizeString(definition.logo_code ?? definition.code);
      if (!code) {
        continue;
      }

      const matches = await findDefinitions(pool, availableTables, code);
      const uniqueNames = [...new Set(matches.map((match) => match.name))];

      if (uniqueNames.length === 0) {
        unresolved.push(code);
        continue;
      }
      if (uniqueNames.length > 1) {
        console.warn(
          `[logo-finance-definitions-sync] Belirsiz kod ${code}: ${matches
            .map((match) => `${match.sourceTable}=${match.name}`)
            .join(" | ")}`,
        );
        unresolved.push(code);
        continue;
      }

      records.push({
        type: "factory",
        code: normalizeString(definition.code) ?? code,
        logo_code: code,
        name: uniqueNames[0],
        source_table: matches[0].sourceTable,
        is_active: true,
      });
    }

    const fullSnapshotTypes = [];
    for (const source of [
      { type: "bank", table: config.bankTable },
      { type: "pos_device", table: config.posDeviceTable },
    ]) {
      const snapshot = await readActiveLogoDefinitions(pool, source.table, source.type);
      if (!snapshot.available) {
        console.warn(`[logo-finance-definitions-sync] Logo tablosu bulunamadı: ${source.table}`);
        continue;
      }

      fullSnapshotTypes.push(source.type);
      records.push(...snapshot.records);
      console.log(
        `[logo-finance-definitions-sync] ${source.type}: ${snapshot.records.length} aktif tanım okundu (${source.table}).`,
      );
    }

    const cashboxSnapshot = await readActiveCashboxDefinitions(
      pool,
      config.cashboxTable,
      config.cashLineTable,
    );
    if (cashboxSnapshot.available) {
      fullSnapshotTypes.push("cashbox");
      records.push(...cashboxSnapshot.records);
      console.log(
        `[logo-finance-definitions-sync] cashbox: ${cashboxSnapshot.records.length} aktif kasa okundu (${config.cashboxTable}).`,
      );
    } else {
      console.warn(`[logo-finance-definitions-sync] Logo kasa tablosu bulunamadı: ${config.cashboxTable}`);
    }

    const uniqueRecords = [
      ...new Map(
        records.map((record) => [`${record.type}:${record.code}`, record]),
      ).values(),
    ];

    if (uniqueRecords.length > 0 || fullSnapshotTypes.length > 0) {
      const result = await apiRequest(
        config,
        "/api/integrations/logo/finance-definitions/sync",
        {
          method: "POST",
          body: JSON.stringify({
            records: uniqueRecords,
            full_snapshot_types: fullSnapshotTypes,
          }),
        },
      );
      console.log(
        `[logo-finance-definitions-sync] Tamamlandı: ${result.created ?? 0} eklendi, ${result.updated ?? 0} güncellendi, ${result.deactivated ?? 0} pasifleştirildi.`,
      );
    } else {
      console.log("[logo-finance-definitions-sync] Logo'da eşleşen hesap adı bulunamadı.");
    }

    if (unresolved.length > 0) {
      console.warn(
        `[logo-finance-definitions-sync] Eşleşmeyen kodlar (${unresolved.length}): ${unresolved.join(", ")}`,
      );
    }
  } finally {
    await pool.close();
  }
}

async function findDefinitions(pool, tables, code) {
  const matches = [];

  for (const table of tables) {
    const result = await pool
      .request()
      .input("code", sql.NVarChar(64), code)
      .query(`
        SELECT TOP (1)
          CODE,
          ${table.nameColumn} AS NAME
        FROM ${table.name} WITH (NOLOCK)
        WHERE LTRIM(RTRIM(CODE)) = @code
      `);

    const name = normalizeString(result.recordset[0]?.NAME);
    if (name) {
      matches.push({ name, sourceTable: table.name });
    }
  }

  return matches;
}

async function readActiveLogoDefinitions(pool, tableName, type) {
  if (!await tableExists(pool, tableName)) {
    return { available: false, records: [] };
  }

  const columns = await tableColumns(pool, tableName);
  const nameColumn = ["DEFINITION_", "DEFINITION", "NAME"]
    .find((column) => columns.has(column));

  if (!columns.has("CODE") || !nameColumn) {
    throw new Error(`${tableName} tablosunda CODE ve ad sütunu bulunamadı.`);
  }

  const activeFilter = columns.has("ACTIVE")
    ? "WHERE ISNULL(ACTIVE, 0) = 0"
    : "";
  const logicalRefSelect = columns.has("LOGICALREF")
    ? "LOGICALREF"
    : "NULL AS LOGICALREF";
  const result = await pool.request().query(`
    SELECT CODE, ${quoteIdentifier(nameColumn)} AS NAME, ${logicalRefSelect}
    FROM ${tableName} WITH (NOLOCK)
    ${activeFilter}
    ORDER BY CODE
  `);

  return {
    available: true,
    records: result.recordset
      .map((row) => {
        const code = normalizeString(row.CODE);
        const name = normalizeString(row.NAME);
        if (!code || !name) {
          return null;
        }

        return {
          type,
          code,
          logo_code: code,
          name,
          source_table: tableName,
          is_active: true,
          meta: {
            logical_ref: row.LOGICALREF ?? null,
          },
        };
      })
      .filter(Boolean),
  };
}

async function readActiveCashboxDefinitions(pool, tableName, lineTableName) {
  if (!await tableExists(pool, tableName)) {
    return { available: false, records: [] };
  }

  const columns = await tableColumns(pool, tableName);
  const nameColumn = ["DEFINITION_", "DEFINITION", "NAME"]
    .find((column) => columns.has(column));

  if (!columns.has("CODE") || !nameColumn || !columns.has("LOGICALREF")) {
    throw new Error(`${tableName} tablosunda LOGICALREF, CODE ve ad sütunu bulunamadı.`);
  }

  const activeFilter = columns.has("ACTIVE")
    ? "WHERE ISNULL(ACTIVE, 0) = 0"
    : "";
  const cards = await pool.request().query(`
    SELECT LOGICALREF, CODE, ${quoteIdentifier(nameColumn)} AS NAME
    FROM ${tableName} WITH (NOLOCK)
    ${activeFilter}
    ORDER BY CODE
  `);

  const balances = await readCashboxBalances(pool, lineTableName);

  return {
    available: true,
    records: cards.recordset
      .map((row) => {
        const code = normalizeString(row.CODE);
        const name = normalizeString(row.NAME);
        if (!code || !name) {
          return null;
        }

        const balance = balances.get(Number(row.LOGICALREF)) ?? {
          debit: 0,
          credit: 0,
          balance: 0,
        };
        const direction = balance.balance > 0
          ? "debit"
          : (balance.balance < 0 ? "credit" : "zero");

        return {
          type: "cashbox",
          code,
          logo_code: code,
          name,
          source_table: tableName,
          is_active: true,
          balance: roundMoney(balance.balance),
          balance_debit: roundMoney(balance.debit),
          balance_credit: roundMoney(balance.credit),
          balance_direction: direction,
          currency: "TRY",
          meta: {
            logical_ref: row.LOGICALREF ?? null,
          },
        };
      })
      .filter(Boolean),
  };
}

async function readCashboxBalances(pool, lineTableName) {
  const empty = new Map();
  if (!await tableExists(pool, lineTableName)) {
    return empty;
  }

  const columns = await tableColumns(pool, lineTableName);
  if (!columns.has("CARDREF") || !columns.has("AMOUNT") || !columns.has("SIGN")) {
    return empty;
  }

  const cancelledFilter = columns.has("CANCELLED")
    ? "WHERE ISNULL(CANCELLED, 0) = 0"
    : "";
  const result = await pool.request().query(`
    SELECT
      CARDREF,
      SUM(CASE WHEN ISNULL(SIGN, 0) = 0 THEN ISNULL(AMOUNT, 0) ELSE 0 END) AS DEBIT,
      SUM(CASE WHEN ISNULL(SIGN, 0) = 1 THEN ISNULL(AMOUNT, 0) ELSE 0 END) AS CREDIT
    FROM ${lineTableName} WITH (NOLOCK)
    ${cancelledFilter}
    GROUP BY CARDREF
  `);

  return new Map(result.recordset.map((row) => {
    const debit = Number(row.DEBIT ?? 0);
    const credit = Number(row.CREDIT ?? 0);

    return [
      Number(row.CARDREF),
      {
        debit,
        credit,
        balance: debit - credit,
      },
    ];
  }));
}

async function discoverCandidateTables(pool) {
  const result = await pool.request().query(`
    SELECT
      schemas.name AS SCHEMA_NAME,
      tables.name AS TABLE_NAME,
      COALESCE(
        MAX(CASE WHEN columns.name = 'DEFINITION_' THEN 'DEFINITION_' END),
        MAX(CASE WHEN columns.name = 'DEFINITION' THEN 'DEFINITION' END),
        MAX(CASE WHEN columns.name = 'NAME' THEN 'NAME' END)
      ) AS NAME_COLUMN
    FROM sys.tables AS tables
    INNER JOIN sys.schemas AS schemas
      ON schemas.schema_id = tables.schema_id
    INNER JOIN sys.columns AS columns
      ON columns.object_id = tables.object_id
    WHERE (
      tables.name LIKE 'LG[_]%[_]CLCARD'
      OR tables.name LIKE 'LG[_]%[_]EMUHACC'
    )
    AND EXISTS (
      SELECT 1
      FROM sys.columns AS code_columns
      WHERE code_columns.object_id = tables.object_id
        AND code_columns.name = 'CODE'
    )
    GROUP BY schemas.name, tables.name
    HAVING COALESCE(
      MAX(CASE WHEN columns.name = 'DEFINITION_' THEN 'DEFINITION_' END),
      MAX(CASE WHEN columns.name = 'DEFINITION' THEN 'DEFINITION' END),
      MAX(CASE WHEN columns.name = 'NAME' THEN 'NAME' END)
    ) IS NOT NULL
    ORDER BY schemas.name, tables.name
  `);

  return result.recordset.map((row) => ({
    name: `${quoteIdentifier(row.SCHEMA_NAME)}.${quoteIdentifier(row.TABLE_NAME)}`,
    nameColumn: quoteIdentifier(row.NAME_COLUMN),
  }));
}

async function tableExists(pool, qualifiedTable) {
  const tableName = plainTableName(qualifiedTable);
  const result = await pool
    .request()
    .input("tableName", sql.NVarChar(128), tableName)
    .query(`
      SELECT COUNT(*) AS count
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_NAME = @tableName
    `);

  return Number(result.recordset[0]?.count ?? 0) > 0;
}

async function tableColumns(pool, qualifiedTable) {
  const result = await pool
    .request()
    .input("tableName", sql.NVarChar(128), plainTableName(qualifiedTable))
    .query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = @tableName
    `);

  return new Set(result.recordset.map((row) => String(row.COLUMN_NAME).toUpperCase()));
}

function plainTableName(qualifiedTable) {
  return qualifiedTable.split(".").at(-1)?.replaceAll("[", "").replaceAll("]", "");
}

async function apiRequest(config, endpoint, options = {}) {
  const response = await fetch(`${config.apiBase}${endpoint}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Integration-Key": config.apiKey,
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(yanıt okunamadı)");
    throw new Error(`API yanıtı başarısız: HTTP ${response.status} — ${body}`);
  }

  return response.json();
}

function buildConfig() {
  const port = parseInteger(process.env.LOGO_SQL_PORT);
  const connection = {
    server: String(process.env.LOGO_SQL_SERVER ?? "").trim(),
    database: String(process.env.LOGO_SQL_DATABASE ?? "").trim(),
    user: String(process.env.LOGO_SQL_USER ?? "").trim(),
    password: process.env.LOGO_SQL_PASSWORD ?? "",
    options: {
      encrypt: parseBoolean(process.env.LOGO_SQL_ENCRYPT, false),
      trustServerCertificate: parseBoolean(
        process.env.LOGO_SQL_TRUST_SERVER_CERTIFICATE,
        true,
      ),
      instanceName: normalizeString(process.env.LOGO_SQL_INSTANCE),
    },
    requestTimeout: parseInteger(process.env.LOGO_SQL_REQUEST_TIMEOUT_MS) ?? 30_000,
  };

  if (port !== undefined) {
    connection.port = port;
  }

  return {
    connection,
    apiBase: String(
      process.env.B2B_API_BASE ?? process.env.API_BASE ?? "https://bayiotomasyonsistemi.com",
    ).replace(/\/+$/, ""),
    apiKey: normalizeString(
      process.env.POWERSA_PRODUCTS_SYNC_KEY
        ?? process.env.POWERSA_SYNC_KEY
        ?? process.env.B2B_API_KEY
        ?? process.env.LOGO_API_KEY,
    ),
    tables: [
      {
        name: normalizeString(process.env.LOGO_CUSTOMER_TABLE) ?? logoFirmTable("CLCARD"),
        nameColumn: "DEFINITION_",
      },
      {
        name: normalizeString(process.env.LOGO_GL_ACCOUNT_TABLE) ?? logoFirmTable("EMUHACC"),
        nameColumn: "DEFINITION_",
      },
    ],
    bankTable:
      normalizeString(process.env.LOGO_BANK_CARD_TABLE) ?? logoFirmTable("BNCARD"),
    posDeviceTable:
      normalizeString(process.env.LOGO_POS_ACCOUNT_TABLE) ?? logoFirmTable("BANKACC"),
    cashboxTable:
      normalizeString(process.env.LOGO_CASHBOX_TABLE) ?? logoFirmTable("KSCARD"),
    cashLineTable:
      normalizeString(process.env.LOGO_CASH_LINE_TABLE) ?? logoPeriodTable("KSLINES"),
  };
}

function validateConfig(config) {
  const missing = [];
  if (!config.connection.server) missing.push("LOGO_SQL_SERVER");
  if (!config.connection.database) missing.push("LOGO_SQL_DATABASE");
  if (!config.connection.user) missing.push("LOGO_SQL_USER");
  if (!config.connection.password) missing.push("LOGO_SQL_PASSWORD");
  if (!config.apiKey) missing.push("POWERSA_PRODUCTS_SYNC_KEY veya POWERSA_SYNC_KEY");

  if (missing.length > 0) {
    throw new Error(`Eksik konfigürasyon: ${missing.join(", ")}`);
  }
}

function normalizeString(value) {
  const normalized = String(value ?? "").trim();
  return normalized === "" ? null : normalized;
}

function quoteIdentifier(value) {
  return `[${String(value).replaceAll("]", "]]")}]`;
}

function parseInteger(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "") return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
}

function roundMoney(value) {
  return Math.round(Number(value ?? 0) * 100) / 100;
}
