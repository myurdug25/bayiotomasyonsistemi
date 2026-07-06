import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export function triggerTargetedStockSync(records, context = "invoice") {
  const productCodes = collectProductCodes(records);

  if (productCodes.length === 0) {
    return false;
  }

  const child = spawn(process.execPath, [path.join(scriptDir, "logo-products-sync.mjs")], {
    cwd: scriptDir,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      SYNC_PRODUCTS_TARGET_CODES: productCodes.join(","),
      SYNC_PRODUCTS_STOCK_ONLY: "true",
      SYNC_PRODUCTS_STOCK_FAST: "false",
      SYNC_PRODUCTS_STOCK_INCREMENTAL: "false",
      SYNC_PRODUCTS_STOCK_SKIP_MOVEMENT_FALLBACK: "true",
      SYNC_PRODUCTS_STOCK_REQUIRE_SUMMARY_ROW: "true",
      SYNC_PRODUCTS_STOCK_INCLUDE_PRICE: "false",
      SYNC_RESUME: "false",
      SYNC_DISABLE_LOCK: "true",
    },
  });

  child.unref();
  console.log(
    `[logo-sync] targeted warehouse-total refresh queued context=${context} products=${productCodes.length}`
  );

  return true;
}

export function collectProductCodes(records) {
  return [
    ...new Set(
      (Array.isArray(records) ? records : [])
        .flatMap((record) => (Array.isArray(record?.items) ? record.items : []))
        .map((item) => String(item?.product_code ?? "").trim())
        .filter(Boolean)
    ),
  ];
}
