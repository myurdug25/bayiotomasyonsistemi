#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import fs from "node:fs";

import dotenv from "dotenv";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(scriptDir, ".env");

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

main().catch((error) => {
  console.error("[logo-sync] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  const startedAt = Date.now();
  const steps = buildSteps();

  for (const step of steps) {
    console.log(`[logo-sync] starting step=${step.name}`);
    await runNodeScript(step.script);
    console.log(`[logo-sync] finished step=${step.name}`);
  }

  const durationMs = Date.now() - startedAt;
  console.log(`[logo-sync] all steps completed duration=${durationMs}ms`);
}

function buildSteps() {
  const steps = [
    {
      name: "customers",
      script: path.join(scriptDir, "logo-customers-sync.mjs"),
    },
    {
      name: "products",
      script: path.join(scriptDir, "logo-products-sync.mjs"),
    },
  ];

  if (parseBoolean(process.env.LOGO_LEDGER_SYNC_ENABLED, true)) {
    steps.push({
      name: "ledger",
      script: path.join(scriptDir, "logo-ledger-sync.mjs"),
    });
  }

  if (String(process.env.LOGO_CUSTOMER_EXPORT_PROCEDURE ?? "").trim() !== "") {
    steps.push({
      name: "customers-export",
      script: path.join(scriptDir, "logo-customers-export.mjs"),
    });
  }

  if (String(process.env.LOGO_COLLECTION_EXPORT_PROCEDURE ?? "").trim() !== "") {
    steps.push({
      name: "collections",
      script: path.join(scriptDir, "logo-collections-export.mjs"),
    });
  }

  if (String(process.env.LOGO_POS_SALE_EXPORT_PROCEDURE ?? "").trim() !== "") {
    steps.push({
      name: "pos-sales",
      script: path.join(scriptDir, "logo-pos-sales-export.mjs"),
    });
  }

  if (parseBoolean(process.env.LOGO_POS_EXPENSES_IMPORT_ENABLED, false)) {
    steps.push({
      name: "pos-expenses-import",
      script: path.join(scriptDir, "logo-pos-expenses-sync.mjs"),
    });
  }

  if (String(process.env.LOGO_POS_EXPENSE_EXPORT_PROCEDURE ?? "").trim() !== "") {
    steps.push({
      name: "pos-expenses",
      script: path.join(scriptDir, "logo-pos-expenses-export.mjs"),
    });
  }

  if (
    String(process.env.POWERSA_POS_DELIVERY_BALANCES_SYNC_URL ?? "").trim() !== "" ||
    String(process.env.POWERSA_SYNC_URL ?? "").trim() !== ""
  ) {
    steps.push({
      name: "pos-delivery-balances",
      script: path.join(scriptDir, "logo-pos-delivery-balances-sync.mjs"),
    });
  }

  if (String(process.env.LOGO_POS_DAY_END_EXPORT_PROCEDURE ?? "").trim() !== "") {
    steps.push({
      name: "pos-day-ends",
      script: path.join(scriptDir, "logo-pos-day-ends-export.mjs"),
    });
  }

  if (
    String(process.env.LOGO_ORDER_EXPORT_PROCEDURE ?? "").trim() !== "" ||
    String(process.env.LOGO_SHIPMENT_EXPORT_PROCEDURE ?? "").trim() !== "" ||
    String(process.env.LOGO_RETURN_EXPORT_PROCEDURE ?? "").trim() !== "" ||
    String(process.env.LOGO_RETURN_SCRAP_EXPORT_PROCEDURE ?? "").trim() !== ""
  ) {
    steps.push({
      name: "documents-export",
      script: path.join(scriptDir, "logo-documents-export.mjs"),
    });
  }

  return steps;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "evet", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "hayir", "off"].includes(normalized)) return false;
  return fallback;
}

function runNodeScript(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: scriptDir,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`step exited with code ${code}`));
    });
  });
}
