#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import sql from "mssql";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(scriptDir, ".env");
const allowedFiles = new Map([
  ["collection", "powersa-b2b-collection-write-procedure.sql"],
  ["return", "powersa-b2b-return-write-procedure.sql"],
  ["return-scrap", "powersa-b2b-return-scrap-write-procedure.sql"],
  ["warehouse-transfer", "powersa-b2b-warehouse-transfer-write-procedure.sql"],
]);

dotenv.config({ path: envPath });

main().catch((error) => {
  console.error("[logo-sql-deploy] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  const target = String(process.argv[2] ?? "").trim().toLowerCase();
  const fileName = allowedFiles.get(target);
  if (!fileName) {
    throw new Error(`unsupported SQL target: ${target || "(empty)"}`);
  }

  const config = buildConfig();
  validateConfig(config);
  const sqlPath = path.join(scriptDir, "sql", fileName);
  const blocks = fs
    .readFileSync(sqlPath, "utf8")
    .split(/^GO\s*$/im)
    .map((block) => block.trim())
    .filter(Boolean);

  const pool = new sql.ConnectionPool(config);
  await pool.connect();

  try {
    for (let index = 0; index < blocks.length; index += 1) {
      await pool.request().batch(blocks[index]);
      console.log(`[logo-sql-deploy] executed block ${index + 1}/${blocks.length}`);
    }
  } finally {
    await pool.close();
  }

  console.log(`[logo-sql-deploy] deployed ${fileName}`);
}

function buildConfig() {
  const port = parseInteger(process.env.LOGO_SQL_PORT);
  const config = {
    server: String(process.env.LOGO_SQL_SERVER ?? "").trim(),
    database: String(process.env.LOGO_SQL_DATABASE ?? "").trim(),
    user: String(process.env.LOGO_SQL_USER ?? "").trim(),
    password: process.env.LOGO_SQL_PASSWORD ?? "",
    options: {
      encrypt: parseBoolean(process.env.LOGO_SQL_ENCRYPT, false),
      trustServerCertificate: parseBoolean(process.env.LOGO_SQL_TRUST_SERVER_CERTIFICATE, true),
      instanceName: nullable(process.env.LOGO_SQL_INSTANCE),
    },
    requestTimeout: parseInteger(process.env.LOGO_SQL_REQUEST_TIMEOUT_MS) ?? 30_000,
  };

  if (port !== undefined) {
    config.port = port;
  }

  return config;
}

function validateConfig(config) {
  const missing = [];
  if (!config.server) missing.push("LOGO_SQL_SERVER");
  if (!config.database) missing.push("LOGO_SQL_DATABASE");
  if (!config.user) missing.push("LOGO_SQL_USER");
  if (!config.password) missing.push("LOGO_SQL_PASSWORD");
  if (missing.length > 0) {
    throw new Error(`missing required config: ${missing.join(", ")}`);
  }
}

function nullable(value) {
  const normalized = String(value ?? "").trim();
  return normalized === "" ? undefined : normalized;
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
