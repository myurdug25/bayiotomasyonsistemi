#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import dotenv from "dotenv";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(scriptDir, ".env");
const statusPath = path.join(scriptDir, "sync-daemon-status.json");
const priorityStatusPath = path.join(scriptDir, "sync-daemon-priority-status.json");
const criticalStatusPath = path.join(scriptDir, "sync-daemon-critical-status.json");
const lockPath = path.join(scriptDir, "sync-daemon.lock");
const defaultCustomerExportProcedure = "dbo.PowersaB2B_ExportCustomer";
const defaultPrioritySteps = [
  "pos-expenses",
  "pos-day-ends",
  "customers-export",
  "collections",
  "pos-sales",
  "pos-delivery-balances",
  "documents-export",
  "product-shelves",
];
const requiredPrioritySteps = [
  "collections",
  "pos-sales",
  "pos-delivery-balances",
  "pos-expenses",
  "pos-day-ends",
  "documents-export",
  "product-shelves",
];
const defaultFastSteps = [
  "documents-export",
  "product-shelves",
  "ledger",
  "collections",
  "pos-sales",
  "pos-delivery-balances",
  "pos-expenses",
  "pos-day-ends",
];
const defaultSlowSteps = ["customers", "product-stocks"];
const defaultMaintenanceSteps = [
  "product-catalog",
  "pos-expenses-import",
  "finance-definitions",
  "campaigns",
  "previous-purchases",
  "eryaz-ledger",
];

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const config = buildConfig();
let stopping = false;
let lockAcquired = false;
const activeSteps = new Set();

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

main()
  .catch((error) => {
    log(`fatal ${formatError(error)}`);
    process.exitCode = 1;
  })
  .finally(releaseLock);

async function main() {
  acquireLock();
  log(
    `daemon started priorityIntervalMs=${config.priorityIntervalMs} fastIntervalMs=${config.fastIntervalMs} slowIntervalMs=${config.slowIntervalMs} maintenanceIntervalMs=${config.maintenanceIntervalMs} campaignIntervalMs=${config.campaignIntervalMs} prioritySteps=${config.prioritySteps.join(",") || "none"} fastSteps=${config.fastSteps.join(",")} slowSteps=${config.slowSteps.join(",") || "none"} maintenanceSteps=${config.maintenanceSteps.join(",") || "none"}`
  );

  await Promise.all([runGeneralLoop(), runPriorityLoop(), runCriticalLoop(), runCampaignLoop()]);
  log("daemon stopped");
}

async function runGeneralLoop() {
  let nextSlowRunAt = 0;
  let nextMaintenanceRunAt = 0;
  const priorityStepNames = new Set(config.prioritySteps);

  while (!stopping) {
    const loopStartedAt = Date.now();
    const dueSteps = config.fastSteps.filter((step) => !priorityStepNames.has(step));

    if (config.slowSteps.length > 0 && loopStartedAt >= nextSlowRunAt) {
      dueSteps.push(...config.slowSteps.filter((step) => !priorityStepNames.has(step)));
      nextSlowRunAt = loopStartedAt + config.slowIntervalMs;
    }
    if (config.maintenanceSteps.length > 0 && loopStartedAt >= nextMaintenanceRunAt) {
      dueSteps.push(...config.maintenanceSteps.filter((step) => !priorityStepNames.has(step)));
      nextMaintenanceRunAt = loopStartedAt + config.maintenanceIntervalMs;
    }

    const summary = await runLoop([...new Set(dueSteps)]);
    writeStatus(summary);

    const delayMs = summary.failed > 0 ? config.errorBackoffMs : config.fastIntervalMs;
    await delay(delayMs, () => stopping);
  }
}

async function runPriorityLoop() {
  const steps = config.prioritySteps.filter((step) => !config.criticalSteps.includes(step));

  if (steps.length === 0) {
    return;
  }

  while (!stopping) {
    const summary = await runLoop(steps);
    writeStatusFile(priorityStatusPath, summary, "priority status");

    const delayMs = summary.failed > 0 ? config.errorBackoffMs : config.priorityIntervalMs;
    await delay(delayMs, () => stopping);
  }
}

async function runCriticalLoop() {
  if (config.criticalSteps.length === 0) {
    return;
  }

  while (!stopping) {
    const summary = await runLoop(config.criticalSteps);
    writeStatusFile(criticalStatusPath, summary, "critical status");

    const delayMs = summary.failed > 0 ? config.errorBackoffMs : config.criticalIntervalMs;
    await delay(delayMs, () => stopping);
  }
}

async function runCampaignLoop() {
  const steps = ["campaigns"];

  if (!config.campaignLoopEnabled) {
    return;
  }

  while (!stopping) {
    const summary = await runLoop(steps);
    const delayMs = summary.failed > 0 ? config.errorBackoffMs : config.campaignIntervalMs;
    await delay(delayMs, () => stopping);
  }
}

async function runLoop(steps) {
  const startedAt = new Date();
  const stepResults = [];
  let failed = 0;

  for (const step of steps) {
    if (stopping) break;
    const result = await runStep(step);
    stepResults.push(result);
    if (!result.ok) failed++;
  }

  const finishedAt = new Date();
  return {
    pid: process.pid,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    failed,
    steps: stepResults,
  };
}

async function runStep(stepName) {
  const step = resolveStep(stepName);
  if (!step) {
    return { name: stepName, ok: false, skipped: true, error: "unknown step" };
  }

  if (step.when && !step.when()) {
    return { name: stepName, ok: true, skipped: true, reason: "not configured" };
  }

  // Critical, priority and general loops run independently. Never allow the
  // same exporter to read the same pending records concurrently.
  if (activeSteps.has(stepName)) {
    return { name: stepName, ok: true, skipped: true, reason: "already running" };
  }

  const startedAt = Date.now();
  activeSteps.add(stepName);
  if (config.verboseSteps) {
    log(`step started ${stepName}`);
  }

  try {
    await runNodeScript(step.script, step.env);
    const durationMs = Date.now() - startedAt;
    if (config.verboseSteps) {
      log(`step finished ${stepName} duration=${durationMs}ms`);
    }
    return { name: stepName, ok: true, skipped: false, duration_ms: durationMs };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    log(`step failed ${stepName} duration=${durationMs}ms error=${formatError(error)}`);
    return { name: stepName, ok: false, skipped: false, duration_ms: durationMs, error: formatError(error) };
  } finally {
    activeSteps.delete(stepName);
  }
}

function resolveStep(name) {
  const steps = {
    customers: {
      script: "logo-customers-sync.mjs",
      when: () => hasAny("POWERSA_SYNC_URL", "POWERSA_CUSTOMERS_SYNC_URL"),
    },
    products: {
      script: "logo-products-sync.mjs",
      when: () => hasAny("POWERSA_PRODUCTS_SYNC_URL"),
    },
    "product-stocks": {
      script: "logo-products-sync.mjs",
      env: {
        SYNC_PRODUCTS_STOCK_ONLY: "true",
        SYNC_PRODUCTS_STOCK_FAST: "true",
        SYNC_PRODUCTS_STOCK_INCREMENTAL: "true",
        SYNC_PRODUCTS_STOCK_SKIP_MOVEMENT_FALLBACK: "true",
        SYNC_PRODUCTS_STOCK_REQUIRE_SUMMARY_ROW: "true",
        SYNC_PRODUCTS_STOCK_INCLUDE_PRICE: "false",
        SYNC_PRODUCTS_STOCK_FAST_LIMIT: process.env.SYNC_PRODUCTS_STOCK_FAST_LIMIT ?? "150",
        SYNC_PRODUCTS_STOCK_LOOKBACK_MINUTES: process.env.SYNC_PRODUCTS_STOCK_LOOKBACK_MINUTES ?? "5",
        SYNC_API_REQUEST_MAX_RECORDS:
          process.env.SYNC_PRODUCTS_STOCK_API_REQUEST_MAX_RECORDS ??
          process.env.SYNC_API_REQUEST_MAX_RECORDS ??
          "50",
      },
      when: () => hasAny("POWERSA_PRODUCTS_SYNC_URL"),
    },
    "product-catalog": {
      script: "logo-products-sync.mjs",
      env: {
        SYNC_PRODUCTS_CATALOG_INCREMENTAL: "true",
        SYNC_PRODUCTS_STOCK_ONLY: "false",
        SYNC_PRODUCTS_STOCK_FAST: "false",
        SYNC_PRODUCTS_STOCK_INCREMENTAL: "false",
      },
      when: () => hasAny("POWERSA_PRODUCTS_SYNC_URL"),
    },
    ledger: {
      script: "logo-ledger-sync.mjs",
      when: () => parseBoolean(process.env.LOGO_LEDGER_SYNC_ENABLED, true) && hasAny("POWERSA_LEDGER_SYNC_URL", "POWERSA_SYNC_URL"),
    },
    "customers-export": {
      script: "logo-customers-export.mjs",
      env: { LOGO_CUSTOMER_EXPORT_PROCEDURE: customerExportProcedure() },
      when: () => customerExportProcedure() !== "" && hasAny("POWERSA_CUSTOMERS_PENDING_URL", "POWERSA_SYNC_URL"),
    },
    collections: {
      script: "logo-collections-export.mjs",
      when: () => hasAny("LOGO_COLLECTION_EXPORT_PROCEDURE") && hasAny("POWERSA_COLLECTIONS_PENDING_URL", "POWERSA_SYNC_URL"),
    },
    "pos-sales": {
      script: "logo-pos-sales-export.mjs",
      when: () => hasAny("LOGO_POS_SALE_EXPORT_PROCEDURE") && hasAny("POWERSA_POS_SALES_PENDING_URL", "POWERSA_SYNC_URL"),
    },
    "pos-delivery-balances": {
      script: "logo-pos-delivery-balances-sync.mjs",
      when: () => hasAny("POWERSA_POS_DELIVERY_BALANCES_SYNC_URL", "POWERSA_SYNC_URL"),
    },
    "previous-purchases": {
      script: "logo-previous-purchases-sync.mjs",
      when: () => hasAny("POWERSA_PREVIOUS_PURCHASES_SYNC_URL", "POWERSA_SYNC_URL"),
    },
    "eryaz-ledger": {
      script: "eryaz-ledger-sync.mjs",
      when: () =>
        parseBoolean(process.env.ERYAZ_LEDGER_SYNC_ENABLED, false) &&
        hasAny("POWERSA_ERYAZ_LEDGER_SYNC_URL"),
    },
    "pos-expenses": {
      script: "logo-pos-expenses-export.mjs",
      when: () => hasAny("LOGO_POS_EXPENSE_EXPORT_PROCEDURE") && hasAny("POWERSA_POS_EXPENSES_PENDING_URL", "POWERSA_SYNC_URL"),
    },
    "pos-day-ends": {
      script: "logo-pos-day-ends-export.mjs",
      when: () => hasAny("LOGO_POS_DAY_END_EXPORT_PROCEDURE") && hasAny("POWERSA_POS_DAY_ENDS_PENDING_URL", "POWERSA_SYNC_URL"),
    },
    "pos-expenses-import": {
      script: "logo-pos-expenses-sync.mjs",
      when: () =>
        parseBoolean(process.env.LOGO_POS_EXPENSES_IMPORT_ENABLED, false) &&
        hasAny("POWERSA_POS_EXPENSES_SYNC_URL", "POWERSA_SYNC_URL"),
    },
    "documents-export": {
      script: "logo-documents-export.mjs",
      when: () =>
        hasAny(
          "LOGO_ORDER_EXPORT_PROCEDURE",
          "LOGO_SHIPMENT_EXPORT_PROCEDURE",
          "LOGO_RETURN_EXPORT_PROCEDURE",
          "LOGO_RETURN_SCRAP_EXPORT_PROCEDURE",
          "LOGO_WAREHOUSE_TRANSFER_EXPORT_PROCEDURE"
        ) &&
        hasAny(
          "POWERSA_ORDERS_PENDING_URL",
          "POWERSA_SHIPMENTS_PENDING_URL",
          "POWERSA_RETURNS_PENDING_URL",
          "POWERSA_RETURN_SCRAPS_PENDING_URL",
          "POWERSA_WAREHOUSE_TRANSFERS_PENDING_URL",
        ),
    },
    "product-shelves": {
      script: "logo-product-shelves-export.mjs",
      when: () => hasAny("POWERSA_PRODUCT_SHELVES_PENDING_URL", "POWERSA_SYNC_URL"),
    },
    campaigns: {
      script: "logo-campaigns-sync.mjs",
      when: () => hasAny("POWERSA_SYNC_URL", "POWERSA_CAMPAIGNS_SYNC_URL"),
    },
    "finance-definitions": {
      script: "logo-finance-definitions-sync.mjs",
      when: () => hasAny("POWERSA_PRODUCTS_SYNC_KEY", "POWERSA_SYNC_KEY"),
    },
  };

  return steps[name];
}

function runNodeScript(scriptName, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scriptDir, scriptName)], {
      cwd: scriptDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });

    let outputTail = "";
    const capture = (chunk, stream) => {
      const text = chunk.toString();
      if (config.verboseSteps) {
        stream.write(text);
      }
      outputTail = `${outputTail}${text}`.slice(-65_536);
    };

    child.stdout.on("data", (chunk) => capture(chunk, process.stdout));
    child.stderr.on("data", (chunk) => capture(chunk, process.stderr));

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = outputTail.trim();
      reject(new Error(`${scriptName} exited with code ${code}${detail ? `: ${detail}` : ""}`));
    });
  });
}

function buildConfig() {
  return {
    criticalIntervalMs: parseIntEnv("SYNC_DAEMON_CRITICAL_INTERVAL_MS", 5_000, 2_000, 60_000),
    priorityIntervalMs: parseIntEnv("SYNC_DAEMON_PRIORITY_INTERVAL_MS", 3_000, 1_000, 60_000),
    fastIntervalMs: parseIntEnv("SYNC_DAEMON_FAST_INTERVAL_MS", 3_000, 1_000, 300_000),
    slowIntervalMs: parseIntEnv("SYNC_DAEMON_SLOW_INTERVAL_MS", 60_000, 10_000, 3_600_000),
    maintenanceIntervalMs: parseIntEnv("SYNC_DAEMON_MAINTENANCE_INTERVAL_MS", 60_000, 60_000, 86_400_000),
    campaignIntervalMs: parseIntEnv("SYNC_DAEMON_CAMPAIGN_INTERVAL_MS", 60_000, 30_000, 3_600_000),
    campaignLoopEnabled: parseBoolean(process.env.SYNC_DAEMON_CAMPAIGN_LOOP_ENABLED, true),
    errorBackoffMs: parseIntEnv("SYNC_DAEMON_ERROR_BACKOFF_MS", 30_000, 5_000, 600_000),
    verboseSteps: parseBoolean(process.env.SYNC_DAEMON_VERBOSE_STEPS, false),
    prioritySteps: withRequiredPrioritySteps(parseStepList(process.env.SYNC_DAEMON_PRIORITY_STEPS, defaultPrioritySteps)),
    criticalSteps: parseStepList(
      process.env.SYNC_DAEMON_CRITICAL_STEPS,
      ["collections", "pos-expenses", "documents-export"]
    ),
    fastSteps: parseStepList(process.env.SYNC_DAEMON_FAST_STEPS, defaultFastSteps),
    slowSteps: parseStepList(process.env.SYNC_DAEMON_SLOW_STEPS, defaultSlowSteps),
    maintenanceSteps: [
      ...new Set([
        ...parseStepList(process.env.SYNC_DAEMON_MAINTENANCE_STEPS, defaultMaintenanceSteps),
        "campaigns",
      ]),
    ],
  };
}

function acquireLock() {
  if (fs.existsSync(lockPath)) {
    const existingPid = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    if (Number.isFinite(existingPid) && isProcessAlive(existingPid)) {
      throw new Error(`another logo sync daemon is already running pid=${existingPid}`);
    }

    fs.unlinkSync(lockPath);
  }

  const descriptor = fs.openSync(lockPath, "wx");
  fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
  fs.closeSync(descriptor);
  lockAcquired = true;
}

function releaseLock() {
  if (!lockAcquired) {
    return;
  }

  try {
    const ownerPid = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    if (ownerPid === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // The lock may already have been removed during process shutdown.
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseStepList(value, fallback) {
  const rawValue = value === undefined || value === null ? "" : String(value).trim();
  if (["none", "off", "false", "0"].includes(rawValue.toLowerCase())) {
    return [];
  }

  const raw = rawValue === "" ? fallback.join(",") : rawValue;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIntEnv(name, fallback, min, max) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "evet", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "hayir", "off"].includes(normalized)) return false;
  return fallback;
}

function hasAny(...keys) {
  return keys.some((key) => String(process.env[key] ?? "").trim() !== "");
}

function customerExportProcedure() {
  return String(process.env.LOGO_CUSTOMER_EXPORT_PROCEDURE ?? defaultCustomerExportProcedure).trim();
}

function writeStatus(summary) {
  writeStatusFile(statusPath, summary, "status");
}

function withRequiredPrioritySteps(steps) {
  return [...new Set([...steps, ...requiredPrioritySteps])];
}

function writeStatusFile(targetPath, summary, label) {
  try {
    fs.writeFileSync(targetPath, JSON.stringify(summary, null, 2));
  } catch (error) {
    log(`${label} write failed ${formatError(error)}`);
  }
}

function delay(ms, shouldStop) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (shouldStop() || Date.now() - startedAt >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, 250);
  });
}

function stop() {
  stopping = true;
}

function log(message) {
  console.log(`[${new Date().toISOString()}] [logo-sync-daemon] ${message}`);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
