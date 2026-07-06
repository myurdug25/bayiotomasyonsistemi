#!/usr/bin/env node

import http from "node:http";
import process from "node:process";

import sql from "mssql";

import {
  buildConfig,
  buildSteps,
  exportRecord,
  loadProcedureParameters,
  validateLogoConfig,
  validateStepConfig,
} from "./logo-documents-export.mjs";
import { triggerTargetedStockSync } from "./logo-targeted-stock-sync.mjs";

const config = buildConfig();
const host = process.env.LOGO_SHIPMENT_IMMEDIATE_BRIDGE_HOST ?? "127.0.0.1";
const port = parseInteger(process.env.LOGO_SHIPMENT_IMMEDIATE_BRIDGE_PORT, 8789);
const token = (process.env.LOGO_SHIPMENT_IMMEDIATE_BRIDGE_TOKEN ?? process.env.POWERSA_SHIPMENTS_SYNC_KEY ?? "").trim();

main().catch((error) => {
  console.error("[logo-shipment-immediate-bridge] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  validateLogoConfig(config);

  const step = buildSteps(config).find((candidate) => candidate.key === "shipments");
  if (!step) {
    throw new Error("shipment export step could not be resolved");
  }
  validateStepConfig(step);

  const server = http.createServer((request, response) => {
    void handleRequest(request, response, step);
  });

  server.listen(port, host, () => {
    console.log(`[logo-shipment-immediate-bridge] listening on http://${host}:${port}/shipments/export`);
  });
}

async function handleRequest(request, response, step) {
  if (request.method !== "POST" || request.url !== "/shipments/export") {
    sendJson(response, 404, { message: "not found" });
    return;
  }

  if (token && request.headers.authorization !== `Bearer ${token}`) {
    sendJson(response, 401, { message: "unauthorized" });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(request));
  } catch {
    sendJson(response, 400, { message: "invalid json body" });
    return;
  }

  const record = body?.record;
  if (!record || typeof record !== "object") {
    sendJson(response, 422, { message: "record is required" });
    return;
  }

  const pool = new sql.ConnectionPool(config.logo.connection);

  try {
    await pool.connect();
    const procedureParameters = await loadProcedureParameters(pool, step.procedure, step.label);
    const externalReference = await exportRecord(pool, step, record, procedureParameters);
    triggerTargetedStockSync([record], "shipment_invoice_immediate");

    sendJson(response, 200, {
      status: "synced",
      external_ref: externalReference,
      meta: {
        export_key: record.export_key ?? null,
      },
    });
  } catch (error) {
    sendJson(response, 500, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await pool.close().catch(() => {});
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        request.destroy();
        reject(new Error("request body too large"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function parseInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);

  return Number.isFinite(parsed) ? parsed : fallback;
}
