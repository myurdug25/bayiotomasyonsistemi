#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import sql from "mssql";

import {
  logoFirmCode,
  logoFirmTable,
  logoPeriodCode,
  logoPeriodTable,
} from "./logo-table-names.mjs";
import {
  hasProductTargetSelection,
  parseProductTargetCodes,
  parseProductTargetRefs,
} from "./logo-product-target-selection.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(scriptDir, ".env");

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const config = buildConfig();
const runStartedAt = Date.now();
const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  main().catch((error) => {
    console.error("[logo-sync] failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

async function main() {
  validateConfig(config);

  const logFile = resolveLogFilePath(config.sync.logDir);
  const syncMode = resolveSyncMode(config);
  const lockHandle = acquireSyncLock(config.sync.lockFile, config.sync.disableLock);
  const stateFile = config.sync.stockFast ? config.sync.stockStateFile : config.sync.stateFile;
  const useBatchResume = config.sync.resume && !config.sync.stockFast;

  if (!lockHandle) {
    return;
  }

  appendSyncLog(
    logFile,
    `[logo-sync] run start mode=${syncMode} resume=${config.sync.resume} batch_size=${config.sync.batchSize} retry_max=${config.sync.retryMax} retry_base_delay_ms=${config.sync.retryBaseDelayMs} continue_on_error=${config.sync.continueOnError}`
  );

  let stateSaved = false;
    let syncState = buildInitialSyncState(
      useBatchResume ? loadSyncState(stateFile) : null,
      config,
      syncMode
    );
    const resumedAuthoritativeRunId = normalizeString(syncState.sync_run_id);
    if (config.sync.stockFast) {
      syncState.last_run_started_at = new Date().toISOString();
      syncState.lookback_minutes = config.sync.stockLookbackMinutes;
    }
    const sendsAuthoritativeCatalogSnapshot = shouldSendAuthoritativeCatalogSnapshot(config);
    const authoritativeSyncRunId = sendsAuthoritativeCatalogSnapshot
      ? (resumedAuthoritativeRunId ?? buildProductSyncRunId(config))
      : null;
    let canFinalizeAuthoritativeCatalogSnapshot =
      authoritativeSyncRunId !== null && (!useBatchResume || resumedAuthoritativeRunId === authoritativeSyncRunId);
    if (authoritativeSyncRunId !== null) {
      syncState.sync_run_id = authoritativeSyncRunId;
      syncState.authoritative_catalog_snapshot = true;
      syncState.can_finalize_authoritative_catalog_snapshot = canFinalizeAuthoritativeCatalogSnapshot;
    }

    const pool = new sql.ConnectionPool(config.logo.connection);

  try {
    await pool.connect();

    syncState.started_at = syncState.started_at || new Date().toISOString();
    syncState.updated_at = new Date().toISOString();
    saveSyncState(stateFile, syncState);
    stateSaved = true;

    const imageMap = buildProductImageMap(
      config.logo.productImageMapFile,
      config.logo.productImageRoot
    );
    if (imageMap) {
      console.log(
        `[logo-sync] loaded ${imageMap.entryCount} product image mapping(s) from ${imageMap.filePath}`
      );
    }

    const imageFileIndex = buildProductImageFileIndex(config.logo.productImageFallbackDir);
    if (imageFileIndex) {
      console.log(
        `[logo-sync] indexed ${imageFileIndex.fileCount} product image file(s) from ${imageFileIndex.root}`
      );
    }

    const rafMap = config.sync.imagesOnly ? null : buildProductRafMap(config.logo.productRafMapFile);
    if (rafMap) {
      console.log(`[logo-sync] loaded ${rafMap.entryCount} product raf mapping(s) from ${rafMap.filePath}`);
    }

    console.log(
      `[logo-sync] connecting to ${config.logo.server}${config.logo.instanceName ? `\\${config.logo.instanceName}` : ""}/${config.logo.database}`
    );

    const productSchema = await inspectTable(pool, config.logo.productTable, "product", true);
    console.log(
      `[logo-sync] discovered ${productSchema.columns.length} column(s) on ${config.logo.productTable}`
    );

    const stockSchema = config.sync.imagesOnly
      ? null
      : await resolveOptionalTableSchema(
          pool,
          config,
          "stockTable",
          "stock",
          derivePrimaryStockTableNames(config.logo.productTable)
        );
    if (stockSchema) {
      console.log(
        `[logo-sync] discovered ${stockSchema.columns.length} column(s) on ${stockSchema.qualifiedName}`
      );
    } else if (!config.sync.imagesOnly) {
      console.warn("[logo-sync] stock table not configured or not found; stock sync will be skipped.");
    }

    const warehouseInfoSchema = config.sync.imagesOnly
      ? null
      : await resolveOptionalTableSchema(
          pool,
          config,
          "warehouseInfoTable",
          "warehouse info",
          derivePrimaryWarehouseInfoTableNames(config.logo.productTable)
        );
    const warehouseInfoByNo = config.sync.imagesOnly
      ? new Map(config.logo.warehouseNameMap)
      : await fetchWarehouseInfo(pool, warehouseInfoSchema, config.logo.warehouseNameMap);
    if (warehouseInfoSchema) {
      console.log(
        `[logo-sync] discovered ${warehouseInfoSchema.columns.length} column(s) on ${warehouseInfoSchema.qualifiedName}; loaded ${warehouseInfoByNo.size} warehouse definition(s)`
      );
    }

    const priceSchema = config.sync.imagesOnly
      ? null
      : await resolveOptionalTableSchema(
          pool,
          config,
          "priceTable",
          "price",
          derivePrimaryPriceTableNames(config.logo.productTable)
        );
    if (priceSchema) {
      console.log(
        `[logo-sync] discovered ${priceSchema.columns.length} column(s) on ${priceSchema.qualifiedName}`
      );
    } else if (!config.sync.imagesOnly) {
      console.warn("[logo-sync] price table not configured or not found; price sync will be skipped.");
    }

    const productUnitSchema = config.sync.imagesOnly
      ? null
      : await resolveOptionalTableSchema(
          pool,
          config,
          "productUnitTable",
          "product unit assignment",
          derivePrimaryProductUnitTableNames(config.logo.productTable)
        );
    if (productUnitSchema) {
      console.log(
        `[logo-sync] discovered ${productUnitSchema.columns.length} column(s) on ${productUnitSchema.qualifiedName}`
      );
    }

    const unitSetSchema = config.sync.imagesOnly
      ? null
      : await resolveOptionalTableSchema(
          pool,
          config,
          "unitSetTable",
          "unit set",
          derivePrimaryUnitSetTableNames(config.logo.productTable)
        );
    if (unitSetSchema) {
      console.log(
        `[logo-sync] discovered ${unitSetSchema.columns.length} column(s) on ${unitSetSchema.qualifiedName}`
      );
    }

    const unitSchema = config.sync.imagesOnly
      ? null
      : await resolveOptionalTableSchema(
          pool,
          config,
          "unitTable",
          "unit",
          derivePrimaryUnitTableNames(config.logo.productTable)
        );
    if (unitSchema) {
      console.log(
        `[logo-sync] discovered ${unitSchema.columns.length} column(s) on ${unitSchema.qualifiedName}`
      );
    }

    const imageSchema = await resolveProductImageTableSchema(
      pool,
      config,
      derivePrimaryProductImageTableNames(config.logo.productTable)
    );
    if (imageSchema) {
      console.log(
        `[logo-sync] discovered ${imageSchema.columns.length} column(s) on ${imageSchema.qualifiedName}`
      );
    } else {
      console.warn("[logo-sync] product image table not configured or not found; image sync will be skipped.");
    }

    const oemSchema = config.sync.imagesOnly
      ? null
      : await inspectTable(pool, config.logo.oemTable, "oem reference", false);
    if (oemSchema) {
      console.log(
        `[logo-sync] discovered ${oemSchema.columns.length} column(s) on ${config.logo.oemTable}`
      );
    }

    const competitorSchema = config.sync.imagesOnly
      ? null
      : await inspectTable(
          pool,
          config.logo.competitorTable,
          "competitor reference",
          false
        );
    if (competitorSchema) {
      console.log(
        `[logo-sync] discovered ${competitorSchema.columns.length} column(s) on ${config.logo.competitorTable}`
      );
    }

    const substituteSchema = config.sync.imagesOnly
      ? null
      : await resolveOptionalTableSchema(
          pool,
          config,
          "productSubstituteTable",
          "product substitute",
          derivePrimaryProductSubstituteTableNames(config.logo.productTable)
        );
    if (substituteSchema) {
      console.log(
        `[logo-sync] discovered ${substituteSchema.columns.length} column(s) on ${substituteSchema.qualifiedName}`
      );
    }

    const productRafSchema = config.sync.imagesOnly
      ? null
      : await resolveOptionalTableSchema(
          pool,
          config,
          "productRafTable",
          "product raf",
          derivePrimaryProductRafTableNames(config.logo.productTable)
        );
    if (productRafSchema) {
      console.log(
        `[logo-sync] discovered ${productRafSchema.columns.length} column(s) on ${productRafSchema.qualifiedName}`
      );
    }

    const productSelection = await fetchProductsForSync(
      pool,
      config,
      productSchema,
      productRafSchema,
      priceSchema
    );
    const rows = productSelection.rows;
    if (productSelection.targeted) {
      syncState.target_refs = productSelection.targetRefs ?? [];
      syncState.target_codes = productSelection.targetCodes ?? [];
      syncState.target_table = productSelection.catalogTable ?? config.logo.productTable;
    } else if (config.sync.stockFast) {
      syncState.last_seen_stock_line_ref = productSelection.lastSeenStockLineRef ?? null;
      syncState.incremental_since_at = productSelection.sinceAt ?? null;
      syncState.stock_line_table = productSelection.stockLineTable ?? null;
      syncState.stock_fast_limit = productSelection.stockFastLimit ?? config.sync.stockFastLimit;
      syncState.stock_fast_limited = productSelection.stockFastLimited ?? false;
    } else if (config.sync.catalogIncremental) {
      syncState.incremental_since_at = productSelection.sinceAt ?? null;
      syncState.catalog_table = productSelection.catalogTable ?? config.logo.productTable;
      syncState.catalog_raf_ref_count =
        Array.isArray(productSelection.catalogRafRefs) ? productSelection.catalogRafRefs.length : 0;
      syncState.catalog_raf_since_at = productSelection.sinceAt ?? null;
      if (productSelection.catalogRolling) {
        syncState.catalog_rolling_last_seen_logical_ref =
          productSelection.catalogRolling.lastSeenLogicalRef ?? null;
        syncState.catalog_rolling_next_logical_ref =
          productSelection.catalogRolling.nextLogicalRef ?? null;
        syncState.catalog_rolling_limit = productSelection.catalogRolling.limit ?? null;
        syncState.catalog_rolling_selected_count =
          productSelection.catalogRolling.refs?.length ?? 0;
        syncState.catalog_rolling_wrapped =
          productSelection.catalogRolling.wrapped ?? false;
      }
    }
    console.log(`[logo-sync] fetched ${rows.length} product row(s) from ${config.logo.productTable}`);

    const chunks = chunk(rows, config.sync.batchSize);
    const totalBatches = chunks.length;

    syncState.total_records = rows.length;
    syncState.total_batches = totalBatches;
    syncState.mode = syncMode;
    syncState.batch_size = config.sync.batchSize;
    syncState.product_table = config.logo.productTable;
    syncState.updated_at = new Date().toISOString();

    let sent = 0;
    let skipped = 0;
    const startBatchIndex = resolveResumeStartIndex(
      syncState,
      useBatchResume,
      totalBatches
    );
    canFinalizeAuthoritativeCatalogSnapshot =
      authoritativeSyncRunId !== null &&
      (startBatchIndex <= 0 || resumedAuthoritativeRunId === authoritativeSyncRunId);
    if (authoritativeSyncRunId !== null) {
      syncState.can_finalize_authoritative_catalog_snapshot = canFinalizeAuthoritativeCatalogSnapshot;
    }
    let pendingBatches = totalBatches - Math.max(startBatchIndex, 0);

    if (pendingBatches <= 0) {
      console.log(
        `[logo-sync] nothing to process; sync state already at or past the end (batch=${startBatchIndex + 1}).`
      );
      appendSyncLog(
        logFile,
        `[logo-sync] nothing to process; sync state already at or past the end (batch=${startBatchIndex + 1}).`
      );
      syncState.updated_at = new Date().toISOString();
      updateFastStockState(syncState, sent, skipped);
      saveSyncState(stateFile, syncState);
      stateSaved = true;
      return;
    }

    console.log(
      `[logo-sync] starting batch loop from ${startBatchIndex + 1}/${totalBatches} with ${rows.length} total records`
    );
    appendSyncLog(
      logFile,
      `[logo-sync] starting batch loop from ${startBatchIndex + 1}/${totalBatches} with ${rows.length} total records`
    );

    for (let index = startBatchIndex; index < chunks.length; index += 1) {
      const currentChunk = chunks[index];
      if (currentChunk.length === 0) {
        continue;
      }

      const logicalRefs = currentChunk
        .map((row) => normalizeInteger(readFirst(row, ["LOGICALREF", "logicalref", "external_ref"])))
        .filter((value) => value !== null);

      const stockByRef = config.sync.imagesOnly
        ? new Map()
        : await fetchStockSnapshot(pool, config, stockSchema, logicalRefs, warehouseInfoByNo);

      const records = [];

      if (config.sync.imagesOnly) {
        const productImagesByRef = await fetchProductImages(
          pool,
          config,
          imageSchema,
          currentChunk,
          productSchema,
          logicalRefs
        );

        for (const row of currentChunk) {
          const record = mapProductRow(
            row,
            config.logo.productTable,
            productSchema,
            stockByRef,
            new Map(),
            new Map(),
            productImagesByRef,
            new Map(),
            new Map(),
            imageMap,
            imageFileIndex,
            null
          );

          if (!record) {
            skipped += 1;
            const externalRef = normalizeString(readFirst(row, ["external_ref", "LOGICALREF"]));
            if (!config.sync.imageSkippedRefs.has(externalRef)) {
              config.sync.imageStats.skipped_no_image += 1;
            }
            continue;
          }

          records.push(record);
        }
      } else if (config.sync.stockOnly) {
        for (const row of currentChunk) {
          const record = mapStockOnlyProductRow(row, productSchema, stockByRef, config);

          if (!record) {
            skipped += 1;
            continue;
          }

          records.push(record);
        }
      } else {
        const priceByRef = await fetchPriceSnapshot(pool, config, priceSchema, logicalRefs);
        const unitsByRef = await fetchProductUnits(
          pool,
          productUnitSchema,
          unitSchema,
          unitSetSchema,
          logicalRefs
        );
        const productImagesByRef = await fetchProductImages(
          pool,
          config,
          imageSchema,
          currentChunk,
          productSchema,
          logicalRefs
        );
        const productRafByRef = await fetchProductRafAddresses(pool, productRafSchema, logicalRefs);
        const codeAliasesByRef = config.sync.skipAliases
          ? new Map()
          : await fetchCodeAliases(
              pool,
              [
                { schema: oemSchema, type: "oem", tableName: config.logo.oemTable },
                { schema: competitorSchema, type: "competitor", tableName: config.logo.competitorTable },
              ],
              logicalRefs
            );
        if (!config.sync.skipAliases) {
          const substituteAliasesByRef = await fetchProductSubstitutes(
            pool,
            substituteSchema,
            productSchema,
            config.logo.productTable,
            logicalRefs
          );
          mergeAliasMaps(codeAliasesByRef, substituteAliasesByRef);
        }

        for (const row of currentChunk) {
          const record = mapProductRow(
            row,
            config.logo.productTable,
            productSchema,
            stockByRef,
            priceByRef,
            unitsByRef,
            productImagesByRef,
            productRafByRef,
            codeAliasesByRef,
            imageMap,
            imageFileIndex,
            rafMap
          );

          if (!record) {
            skipped += 1;
            continue;
          }

          records.push(record);
        }
      }

      if (records.length === 0) {
        continue;
      }

      const offset = index * config.sync.batchSize;
      const batchNumber = index + 1;
      console.log(`[logo-sync] sending batch ${batchNumber}/${chunks.length} with ${records.length} record(s)`);
      appendSyncLog(
        logFile,
        `[logo-sync] sending batch ${batchNumber}/${chunks.length} offset=${offset} count=${records.length}`
      );

      const batchStart = Date.now();
      try {
        const result = await pushBatchAdaptively(records, config, {
          syncRunId: authoritativeSyncRunId,
          isFullSync: sendsAuthoritativeCatalogSnapshot,
          isFinalBatch: canFinalizeAuthoritativeCatalogSnapshot && index === chunks.length - 1,
          batchIndex: index,
          batchCount: chunks.length,
          sourceTable: config.logo.productTable,
        });
        const elapsed = Date.now() - batchStart;

        sent += records.length;
        if (config.sync.imagesOnly) {
          config.sync.imageStats.images_synced += records.length;
        }
        syncState.last_success_batch_index = index;
        syncState.last_success_offset = offset;
        syncState.last_success_count = records.length;
        syncState.success_count += records.length;
        syncState.updated_at = new Date().toISOString();
        syncState.mode = syncMode;
        syncState.batch_size = config.sync.batchSize;

        updateFastStockState(syncState, sent, skipped);
        saveSyncState(stateFile, syncState);
        stateSaved = true;
        appendSyncLog(
          logFile,
          `[logo-sync] batch ${batchNumber}/${chunks.length} done retry_count=${result.retryCount} status=${result.status} duration_s=${(
            elapsed / 1000
          ).toFixed(2)} response=${result.responsePreview ?? "ok"}`
        );
      } catch (error) {
        const elapsed = Date.now() - batchStart;
        const errorMessage =
          error instanceof Error ? error.message : `error type ${Object.prototype.toString.call(error)}`;
        const retryCount = Number.isInteger(error.retryCount) ? error.retryCount : 0;
        syncState.failed_count += 1;
        syncState.updated_at = new Date().toISOString();

        appendFailedBatch(config.sync.failedFile, {
          batch_index: index,
          batch_number: batchNumber,
          total_batches: chunks.length,
          offset,
          count: records.length,
          http_status: error.httpStatus,
          error_message: errorMessage,
          response_preview: error.responsePreview,
          product_refs: extractBatchProductRefs(records),
        });

        if (config.sync.imagesOnly && Number(error.httpStatus) === 413) {
          for (const record of records) {
            appendImageFailed(config, {
              product_ref: normalizeString(record.external_ref),
              sku: normalizeString(record.sku),
              original_bytes: null,
              optimized_bytes: null,
              reason: "api_413_after_optimize",
              table: config.logo.productImageTable,
              ref_column: config.logo.productImageRefColumn,
              data_column: config.logo.productImageDataColumn,
            });
          }
        }

        updateFastStockState(syncState, sent, skipped);
        saveSyncState(stateFile, syncState);
        stateSaved = true;
        appendSyncLog(
          logFile,
          `[logo-sync] batch ${batchNumber}/${chunks.length} failed retry_count=${retryCount} duration_s=${(
            elapsed / 1000
          ).toFixed(2)} status=${error.httpStatus ?? "n/a"} error=${errorMessage}`
        );

        if (!config.sync.continueOnError) {
          throw error;
        }
      }
    }

    const durationMs = Date.now() - runStartedAt;
    console.log(
      `[logo-sync] completed. sent=${sent} skipped=${skipped} failed=${syncState.failed_count} duration=${durationMs}ms`
    );
    appendSyncLog(
      logFile,
      `[logo-sync] completed. sent=${sent} skipped=${skipped} failed=${syncState.failed_count} duration_ms=${durationMs}`
    );
    if (config.sync.imagesOnly) {
      const imageSummary = {
        images_found: config.sync.imageStats.images_found,
        originals_sent: config.sync.imageStats.originals_sent,
        optimized_sent: config.sync.imageStats.optimized_sent,
        optimized_failed: config.sync.imageStats.optimized_failed,
        images_synced: config.sync.imageStats.images_synced,
        skipped_no_image: config.sync.imageStats.skipped_no_image,
        failed: syncState.failed_count,
        duration_ms: durationMs,
        total_original_bytes: config.sync.imageStats.total_original_bytes,
        total_sent_bytes: config.sync.imageStats.total_sent_bytes,
        saved_bytes: Math.max(
          0,
          config.sync.imageStats.total_original_bytes - config.sync.imageStats.total_sent_bytes
        ),
      };
      const imageSummaryText = `[logo-sync] image summary ${Object.entries(imageSummary)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")}`;
      console.log(imageSummaryText);
      appendSyncLog(logFile, imageSummaryText);
    }
    syncState.updated_at = new Date().toISOString();
    updateFastStockState(syncState, sent, skipped, durationMs);
    if (
      config.sync.catalogIncremental &&
      syncState.failed_count === 0 &&
      productSelection.catalogRolling
    ) {
      saveCatalogRollingState(config, productSelection.catalogRolling);
    }
    if (chunks.length > 0) {
      const lastChunkIndex = chunks.length - 1;
      syncState.last_success_batch_index = lastChunkIndex;
      syncState.last_success_offset = lastChunkIndex * config.sync.batchSize;
      syncState.last_success_count = chunks[lastChunkIndex].length;
    }
    saveSyncState(stateFile, syncState);
    stateSaved = true;
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch (error) {
        console.warn(
          `[logo-sync] could not close SQL connection cleanly: ${error instanceof Error ? error.message : "unknown"}`
        );
      }
    }
    syncState.updated_at = new Date().toISOString();
    if (!stateSaved) {
      saveSyncState(stateFile, syncState);
    }
    releaseSyncLock(lockHandle);
  }
}

async function resolveOptionalTableSchema(pool, currentConfig, configKey, label, candidates) {
  const configuredTableName = currentConfig.logo[configKey];
  if (configuredTableName) {
    const configuredSchema = await inspectTable(pool, configuredTableName, label, false);
    if (configuredSchema) {
      return configuredSchema;
    }

    console.warn(
      `[logo-sync] configured ${label} table not found: ${configuredTableName}; trying derived candidates.`
    );
  }

  for (const candidate of uniqueColumns(candidates)) {
    const resolved = await inspectTable(pool, candidate, label, false);
    if (!resolved) {
      continue;
    }

    currentConfig.logo[configKey] = resolved.qualifiedName;
    console.log(
      `[logo-sync] auto-discovered ${label} table ${resolved.qualifiedName}`
    );

    return resolved;
  }

  return null;
}

async function resolveProductImageTableSchema(pool, currentConfig, candidates) {
  const configuredTableName = currentConfig.logo.productImageTable;
  if (configuredTableName) {
    const configuredSchema = await inspectTable(pool, configuredTableName, "product image", false);
    if (configuredSchema && isUsableProductImageSchema(currentConfig, configuredSchema)) {
      return configuredSchema;
    }

    console.warn(
      `[logo-sync] configured product image table not found or has no supported image columns: ${configuredTableName}; trying derived candidates.`
    );
  }

  for (const candidate of uniqueColumns(candidates)) {
    const resolved = await inspectTable(pool, candidate, "product image", false);
    if (!resolved) {
      continue;
    }

    if (!isUsableProductImageSchema(currentConfig, resolved)) {
      console.warn(
        `[logo-sync] skipped product image candidate ${resolved.qualifiedName}; missing supported reference or image column.`
      );
      continue;
    }

    currentConfig.logo.productImageTable = resolved.qualifiedName;
    console.log(`[logo-sync] auto-discovered product image table ${resolved.qualifiedName}`);

    return resolved;
  }

  return null;
}

function isUsableProductImageSchema(currentConfig, schema) {
  const resolvedColumns = resolveProductImageColumns(currentConfig, schema);

  return Boolean(resolvedColumns.referenceColumn && (resolvedColumns.dataColumn || resolvedColumns.pathColumn));
}

function resolveSyncPath(value, fallback, _isFile = true) {
  const rawPath = normalizeString(value) ?? normalizeString(fallback);
  return path.resolve(scriptDir, rawPath ?? "logs");
}

function resolveSyncMode(currentConfig) {
  if (currentConfig.sync.imagesOnly) {
    return "images_only";
  }

  if (hasProductTargetSelection(currentConfig.sync)) {
    return "products_target";
  }

  if (currentConfig.sync.stockFast) {
    return "stock_fast";
  }

  if (currentConfig.sync.stockOnly) {
    return "stock_only";
  }

  return currentConfig.sync.skipAliases ? "products_no_aliases" : "products";
}

function shouldSendAuthoritativeCatalogSnapshot(currentConfig) {
  return !currentConfig.sync.stockOnly
    && !currentConfig.sync.imagesOnly
    && !currentConfig.sync.catalogIncremental
    && !hasProductTargetSelection(currentConfig.sync);
}

function buildProductSyncRunId(currentConfig) {
  const firmCode = logoFirmCode();
  const periodCode = logoPeriodCode();
  const tableName = normalizeString(currentConfig.logo.productTable)?.replace(/[^\w.-]+/g, "_") ?? "products";
  return `${firmCode}-${periodCode}-${tableName}-${new Date().toISOString()}`;
}

function buildInitialSyncState(persistedSyncState, currentConfig, syncMode) {
  const now = new Date().toISOString();
  const base = {
    started_at: now,
    updated_at: now,
    mode: syncMode,
    total_records: 0,
    total_batches: 0,
    last_success_batch_index: -1,
    last_success_offset: -1,
    last_success_count: 0,
    success_count: 0,
    failed_count: 0,
    batch_size: currentConfig.sync.batchSize,
    product_table: currentConfig.logo.productTable,
  };

  if (!currentConfig.sync.resume || !isSyncStateCompatible(persistedSyncState, currentConfig, syncMode)) {
    return base;
  }

  return {
    ...base,
    ...persistedSyncState,
    started_at: normalizeString(persistedSyncState.started_at) ?? now,
    mode: syncMode,
    batch_size: normalizeInteger(persistedSyncState.batch_size) ?? currentConfig.sync.batchSize,
    last_success_batch_index:
      normalizeInteger(persistedSyncState.last_success_batch_index) ?? -1,
    last_success_offset: normalizeInteger(persistedSyncState.last_success_offset) ?? -1,
    last_success_count: normalizeInteger(persistedSyncState.last_success_count) ?? 0,
    success_count: normalizeInteger(persistedSyncState.success_count) ?? 0,
    failed_count: normalizeInteger(persistedSyncState.failed_count) ?? 0,
  };
}

function isSyncStateCompatible(persistedSyncState, currentConfig, syncMode) {
  return (
    persistedSyncState &&
    typeof persistedSyncState === "object" &&
    persistedSyncState.mode === syncMode &&
    persistedSyncState.product_table === currentConfig.logo.productTable &&
    persistedSyncState.batch_size === currentConfig.sync.batchSize
  );
}

function resolveResumeStartIndex(syncState, resumeEnabled, totalBatches) {
  if (!resumeEnabled) {
    return 0;
  }

  const lastSuccessBatch = Number.parseInt(syncState.last_success_batch_index, 10);
  if (!Number.isFinite(lastSuccessBatch)) {
    return 0;
  }

  const index = lastSuccessBatch + 1;
  return Math.min(Math.max(index, 0), Math.max(totalBatches, 0));
}

function resolveLogFilePath(logDir) {
  const today = new Date().toISOString().slice(0, 10);
  const directory = resolveSyncPath(logDir, "logs", false);
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, `products-sync-${today}.log`);
}

function appendSyncLog(logFile, message) {
  const timestamp = new Date().toISOString();
  try {
    fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`, "utf8");
  } catch (error) {
    console.warn(
      `[logo-sync] could not write sync log to ${logFile}: ${error instanceof Error ? error.message : "unknown"}`
    );
  }
}

function appendFailedBatch(failedFile, payload) {
  const directory = path.dirname(failedFile);
  fs.mkdirSync(directory, { recursive: true });
  const record = {
    timestamp: new Date().toISOString(),
    ...payload,
  };
  fs.appendFileSync(failedFile, `${JSON.stringify(record)}\n`, "utf8");
}

function appendImageFailed(currentConfig, payload) {
  const directory = path.dirname(currentConfig.sync.imageFailedFile);
  fs.mkdirSync(directory, { recursive: true });
  const record = {
    timestamp: new Date().toISOString(),
    ...payload,
  };
  fs.appendFileSync(currentConfig.sync.imageFailedFile, `${JSON.stringify(record)}\n`, "utf8");
}

function extractBatchProductRefs(records) {
  const refs = [];
  for (const record of records) {
    const rawRef = normalizeString(record.external_ref);
    const sku = normalizeString(record.sku);
    if (rawRef) {
      refs.push(`external_ref:${rawRef}`);
      continue;
    }

    if (sku) {
      refs.push(`sku:${sku}`);
    }

    if (refs.length >= 40) {
      break;
    }
  }

  return refs;
}

function acquireSyncLock(lockFile, disableLock) {
  if (disableLock) {
    console.log("[logo-sync] lock disabled via SYNC_DISABLE_LOCK.");
    return { path: lockFile, enabled: false };
  }

  if (fs.existsSync(lockFile)) {
    const lockInfo = readSyncLockInfo(lockFile);
    const staleAfterMs = config.sync.lockStaleMs;

    if (lockInfo.pid && isProcessAlive(lockInfo.pid)) {
      console.warn(`[logo-sync] another sync is already running; lock file exists: ${lockFile}`);
      return null;
    }

    if (lockInfo.ageMs !== null && lockInfo.ageMs < staleAfterMs) {
      console.warn(
        `[logo-sync] lock file exists without live pid but is not stale yet age_ms=${lockInfo.ageMs}; lock=${lockFile}`
      );
      return null;
    }

    console.warn(
      `[logo-sync] removing stale sync lock lock=${lockFile} pid=${lockInfo.pid ?? "unknown"} age_ms=${lockInfo.ageMs ?? "unknown"}`
    );
    fs.unlinkSync(lockFile);
  }

  const directory = path.dirname(lockFile);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(lockFile, `${new Date().toISOString()} ${process.pid}\n`, "utf8");
  return { path: lockFile, enabled: true };
}

function readSyncLockInfo(lockFile) {
  try {
    const stat = fs.statSync(lockFile);
    const raw = fs.readFileSync(lockFile, "utf8");
    const pid = normalizeInteger(raw.match(/\b(\d+)\b/)?.[1]);

    return {
      pid,
      ageMs: Math.max(0, Date.now() - stat.mtimeMs),
    };
  } catch {
    return { pid: null, ageMs: null };
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseSyncLock(lockHandle) {
  if (!lockHandle || !lockHandle.enabled || !lockHandle.path) {
    return;
  }

  try {
    if (fs.existsSync(lockHandle.path)) {
      fs.unlinkSync(lockHandle.path);
    }
  } catch (error) {
    console.warn(
      `[logo-sync] could not remove lock file ${lockHandle.path}: ${error instanceof Error ? error.message : "unknown"}`
    );
  }
}

function loadSyncState(stateFile) {
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    const rawState = fs.readFileSync(stateFile, "utf8");
    return JSON.parse(rawState);
  } catch (error) {
    console.warn(
      `[logo-sync] could not read sync state file ${stateFile}: ${error instanceof Error ? error.message : "unknown"}`
    );
    return null;
  }
}

function saveSyncState(stateFile, state) {
  const directory = path.dirname(stateFile);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function updateFastStockState(state, sent, skipped, durationMs = Date.now() - runStartedAt) {
  if (!config.sync.stockFast) {
    return;
  }

  state.sent_count = sent;
  state.skipped_count = skipped;
  state.failed_count = normalizeInteger(state.failed_count) ?? 0;
  state.last_run_completed_at = new Date().toISOString();
  state.duration_ms = durationMs;
}

function buildConfig() {
  const batchSize = parseInteger(process.env.SYNC_BATCH_SIZE, 500);
  const apiRequestMaxRecords = parseInteger(process.env.SYNC_API_REQUEST_MAX_RECORDS, 10);
  const apiRequestMaxAliases = parseInteger(process.env.SYNC_API_REQUEST_MAX_ALIASES, 750);
  const stockFastLimit = parseInteger(process.env.SYNC_PRODUCTS_STOCK_FAST_LIMIT, 150);
  const timeoutMs = parseInteger(process.env.LOGO_SQL_REQUEST_TIMEOUT_MS, 30000);
  const port = parseInteger(process.env.LOGO_SQL_PORT, undefined);
  const productCardTypes = parseIntegerList(process.env.LOGO_PRODUCT_CARDTYPES, [1]);
  const syncUrl =
    nullable(process.env.POWERSA_PRODUCTS_SYNC_URL) ??
    deriveProductsSyncUrl(process.env.POWERSA_SYNC_URL);
  const syncKey = (process.env.POWERSA_PRODUCTS_SYNC_KEY ?? process.env.POWERSA_SYNC_KEY ?? "").trim();
  const retryMax = parseInteger(process.env.SYNC_RETRY_MAX, 3);
  const retryBaseDelayMs = parseInteger(process.env.SYNC_RETRY_BASE_DELAY_MS, 3000);
  const stateFile = resolveSyncPath(process.env.SYNC_STATE_FILE, ".sync-state/products-sync-state.json");
  const stockStateFile = resolveSyncPath(
    process.env.SYNC_PRODUCTS_STOCK_STATE_FILE,
    ".sync-state/products-stock-fast-state.json"
  );
  const catalogStateFile = resolveSyncPath(
    process.env.SYNC_PRODUCTS_CATALOG_STATE_FILE,
    ".sync-state/products-catalog-fast-state.json"
  );
  const failedFile = resolveSyncPath(
    process.env.SYNC_FAILED_FILE,
    ".sync-state/products-sync-failed.jsonl"
  );
  const imageFailedFile = resolveSyncPath(
    process.env.SYNC_PRODUCT_IMAGE_FAILED_FILE ?? process.env.SYNC_FAILED_FILE,
    ".sync-state/products-images-failed.jsonl"
  );
  const logDir = resolveSyncPath(process.env.SYNC_LOG_DIR, "logs", false);

  return {
    logo: {
      explicitStockTable: nullable(process.env.LOGO_STOCK_TABLE),
      server: (process.env.LOGO_SQL_SERVER ?? "").trim(),
      instanceName: nullable(process.env.LOGO_SQL_INSTANCE),
      port,
      database: (process.env.LOGO_SQL_DATABASE ?? "").trim(),
      user: (process.env.LOGO_SQL_USER ?? "").trim(),
      password: process.env.LOGO_SQL_PASSWORD ?? "",
      encrypt: parseBoolean(process.env.LOGO_SQL_ENCRYPT, false),
      trustServerCertificate: parseBoolean(
        process.env.LOGO_SQL_TRUST_SERVER_CERTIFICATE,
        true
      ),
      requestTimeoutMs: timeoutMs,
      productTable: nullable(process.env.LOGO_PRODUCT_TABLE) ?? logoFirmTable("ITEMS"),
      productCardTypes,
      stockTable: nullable(process.env.LOGO_STOCK_TABLE),
      stockLineTable: nullable(process.env.LOGO_STOCK_LINE_TABLE),
      stockFicheTable: nullable(process.env.LOGO_STOCK_FICHE_TABLE),
      warehouseInfoTable: nullable(process.env.LOGO_WAREHOUSE_INFO_TABLE),
      warehouseNameMap: parseWarehouseNameMap(process.env.LOGO_WAREHOUSE_NAME_MAP),
      warehouseRafKeyMap: parseWarehouseRafKeyMap(process.env.LOGO_WAREHOUSE_RAF_KEY_MAP),
      priceTable: nullable(process.env.LOGO_PRICE_TABLE),
      productUnitTable: nullable(process.env.LOGO_PRODUCT_UNIT_TABLE),
      unitSetTable: nullable(process.env.LOGO_UNIT_SET_TABLE),
      unitTable: nullable(process.env.LOGO_UNIT_TABLE),
      productImageTable:
        nullable(process.env.LOGO_PRODUCT_IMAGE_TABLE) ??
        nullable(process.env.LOGO_PRODUCT_DOCUMENT_TABLE),
      productImageRefColumn: nullable(process.env.LOGO_PRODUCT_IMAGE_REF_COLUMN),
      productImageDataColumn: nullable(process.env.LOGO_PRODUCT_IMAGE_DATA_COLUMN),
      productImagePathColumn: nullable(process.env.LOGO_PRODUCT_IMAGE_PATH_COLUMN),
      productImageOrderColumn: nullable(process.env.LOGO_PRODUCT_IMAGE_ORDER_COLUMN),
      productImageRoot: nullable(process.env.LOGO_PRODUCT_IMAGE_ROOT),
      productImageBaseUrl: normalizeImageBaseUrl(process.env.LOGO_PRODUCT_IMAGE_BASE_URL),
      productImageMapFile: nullable(process.env.LOGO_PRODUCT_IMAGE_MAP_FILE),
      productImageFallbackDir: nullable(process.env.LOGO_PRODUCT_IMAGE_FALLBACK_DIR),
      productRafTable: nullable(process.env.LOGO_PRODUCT_RAF_TABLE),
      productRafMapFile: nullable(process.env.LOGO_PRODUCT_RAF_MAP_FILE),
      oemTable: nullable(process.env.LOGO_OEM_TABLE),
      competitorTable: nullable(process.env.LOGO_COMPETITOR_TABLE),
      productSubstituteTable: nullable(process.env.LOGO_PRODUCT_SUBSTITUTE_TABLE),
      priceType: parseInteger(process.env.LOGO_PRICE_PTYPE, undefined),
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
      apiRequestMaxRecords,
      apiRequestMaxAliases,
      url: syncUrl ?? "",
      key: syncKey,
      priceListCode: nullable(process.env.POWERSA_PRICE_LIST_CODE) ?? "A",
      resume: parseBoolean(process.env.SYNC_RESUME, true),
      stockFast: parseBoolean(process.env.SYNC_PRODUCTS_STOCK_FAST, false),
      stockIncremental: parseBoolean(process.env.SYNC_PRODUCTS_STOCK_INCREMENTAL, false),
      stockFastLimit,
      stockLookbackMinutes: parseInteger(process.env.SYNC_PRODUCTS_STOCK_LOOKBACK_MINUTES, 10),
      stockSkipMovementFallback: parseBoolean(process.env.SYNC_PRODUCTS_STOCK_SKIP_MOVEMENT_FALLBACK, false),
      stockRequireSummaryRow: parseBoolean(process.env.SYNC_PRODUCTS_STOCK_REQUIRE_SUMMARY_ROW, false),
      stockIncludePrice: parseBoolean(process.env.SYNC_PRODUCTS_STOCK_INCLUDE_PRICE, true),
      catalogIncremental: parseBoolean(process.env.SYNC_PRODUCTS_CATALOG_INCREMENTAL, false),
      catalogLookbackMinutes: parseInteger(process.env.SYNC_PRODUCTS_CATALOG_LOOKBACK_MINUTES, 60),
      priceLookbackMinutes: parseInteger(process.env.SYNC_PRODUCTS_PRICE_LOOKBACK_MINUTES, 10),
      catalogRecentLimit: parseInteger(process.env.SYNC_PRODUCTS_CATALOG_RECENT_LIMIT, 500),
      catalogRollingLimit: parseInteger(process.env.SYNC_PRODUCTS_CATALOG_ROLLING_LIMIT, 0),
      catalogStateFile,
      targetRefs: parseProductTargetRefs(process.env.SYNC_PRODUCTS_TARGET_REFS),
      targetCodes: parseProductTargetCodes(process.env.SYNC_PRODUCTS_TARGET_CODES),
      stockOnly:
        parseBoolean(process.env.SYNC_PRODUCTS_STOCK_ONLY, false) ||
        parseBoolean(process.env.SYNC_PRODUCTS_STOCK_FAST, false) ||
        parseBoolean(process.env.SYNC_PRODUCTS_STOCK_INCREMENTAL, false),
      imagesOnly: parseBoolean(process.env.SYNC_PRODUCTS_IMAGES_ONLY, false),
      skipAliases: parseBoolean(process.env.SYNC_PRODUCTS_SKIP_ALIASES, false),
      imageOptimize: parseBoolean(process.env.SYNC_PRODUCT_IMAGE_OPTIMIZE, false),
      imageMaxWidth: parseInteger(process.env.SYNC_PRODUCT_IMAGE_MAX_WIDTH, 1200),
      imageJpegQuality: parseInteger(process.env.SYNC_PRODUCT_IMAGE_JPEG_QUALITY, 80),
      imageTargetMaxBytes: parseInteger(process.env.SYNC_PRODUCT_IMAGE_TARGET_MAX_BYTES, 1_500_000),
      imageOutputFormat: normalizeString(process.env.SYNC_PRODUCT_IMAGE_OUTPUT_FORMAT) ?? "jpeg",
      imageAllowOriginalIfSmall: parseBoolean(process.env.SYNC_PRODUCT_IMAGE_ALLOW_ORIGINAL_IF_SMALL, true),
      imageOriginalMaxBytes: parseInteger(process.env.SYNC_PRODUCT_IMAGE_ORIGINAL_MAX_BYTES, 1_500_000),
      retryMax: Number.isFinite(retryMax) ? retryMax : 3,
      retryBaseDelayMs: Number.isFinite(retryBaseDelayMs) ? retryBaseDelayMs : 3000,
      stateFile,
      stockStateFile,
      failedFile,
      imageFailedFile,
      logDir,
      lockFile: path.resolve(scriptDir, ".sync-state/products-sync.lock"),
      lockStaleMs: parseInteger(process.env.SYNC_LOCK_STALE_MS, 10 * 60 * 1000),
      continueOnError: parseBoolean(process.env.SYNC_CONTINUE_ON_ERROR, false),
      disableLock: parseBoolean(process.env.SYNC_DISABLE_LOCK, false),
      imageStats: {
        images_found: 0,
        originals_sent: 0,
        optimized_sent: 0,
        optimized_failed: 0,
        images_synced: 0,
        skipped_no_image: 0,
        total_original_bytes: 0,
        total_sent_bytes: 0,
      },
      imageSkippedRefs: new Set(),
    },
  };
}

function validateConfig(currentConfig) {
  const missing = [];

  if (!currentConfig.logo.server) missing.push("LOGO_SQL_SERVER");
  if (!currentConfig.logo.database) missing.push("LOGO_SQL_DATABASE");
  if (!currentConfig.logo.user) missing.push("LOGO_SQL_USER");
  if (!currentConfig.logo.password) missing.push("LOGO_SQL_PASSWORD");
  if (!currentConfig.sync.url) missing.push("POWERSA_PRODUCTS_SYNC_URL or POWERSA_SYNC_URL");
  if (!currentConfig.sync.key) missing.push("POWERSA_PRODUCTS_SYNC_KEY or POWERSA_SYNC_KEY");

  if (missing.length > 0) {
    throw new Error(`missing required config: ${missing.join(", ")}`);
  }

  for (const tableName of [
    currentConfig.logo.productTable,
    currentConfig.logo.stockTable,
    currentConfig.logo.stockLineTable,
    currentConfig.logo.stockFicheTable,
    currentConfig.logo.warehouseInfoTable,
    currentConfig.logo.priceTable,
    currentConfig.logo.productUnitTable,
    currentConfig.logo.unitSetTable,
    currentConfig.logo.unitTable,
    currentConfig.logo.productImageTable,
    currentConfig.logo.productRafTable,
    currentConfig.logo.oemTable,
    currentConfig.logo.competitorTable,
    currentConfig.logo.productSubstituteTable,
  ]) {
    if (tableName && !/^[A-Za-z0-9_.\[\]]+$/.test(tableName)) {
      throw new Error(`table name contains unsupported characters: ${tableName}`);
    }
  }

  for (const columnName of [
    currentConfig.logo.productImageRefColumn,
    currentConfig.logo.productImageDataColumn,
    currentConfig.logo.productImagePathColumn,
    currentConfig.logo.productImageOrderColumn,
  ]) {
    if (columnName && !/^[A-Za-z0-9_\[\]]+$/.test(columnName)) {
      throw new Error(`column name contains unsupported characters: ${columnName}`);
    }
  }

  if (currentConfig.sync.batchSize < 1 || currentConfig.sync.batchSize > 1000) {
    throw new Error("SYNC_BATCH_SIZE must be between 1 and 1000");
  }

  if (currentConfig.sync.apiRequestMaxRecords < 1 || currentConfig.sync.apiRequestMaxRecords > 1000) {
    throw new Error("SYNC_API_REQUEST_MAX_RECORDS must be between 1 and 1000");
  }

  if (currentConfig.sync.stockFastLimit < 1 || currentConfig.sync.stockFastLimit > 5000) {
    throw new Error("SYNC_PRODUCTS_STOCK_FAST_LIMIT must be between 1 and 5000");
  }

  if (currentConfig.sync.apiRequestMaxAliases < 1) {
    throw new Error("SYNC_API_REQUEST_MAX_ALIASES must be at least 1");
  }

  if (currentConfig.logo.port !== undefined) {
    currentConfig.logo.connection.port = currentConfig.logo.port;
  }
}

async function inspectTable(pool, tableName, label, required) {
  if (!tableName) {
    return null;
  }

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
    if (required) {
      throw new Error(`Logo ${label} table not found: ${tableName}`);
    }

    return null;
  }

  return {
    schemaName,
    objectName,
    columns,
    columnSet: new Set(columns.map((column) => column.toUpperCase())),
    qualifiedName: tableName,
  };
}

async function fetchProducts(pool, currentConfig, schema) {
  let query = `
    SELECT *
    FROM ${currentConfig.logo.productTable}
  `;

  const filters = [];

  if (currentConfig.logo.productCardTypes.length > 0 && schema.columnSet.has("CARDTYPE")) {
    filters.push(`CARDTYPE IN (${currentConfig.logo.productCardTypes.join(", ")})`);
  }

  if (filters.length > 0) {
    query += ` WHERE ${filters.join(" AND ")}`;
  }

  if (schema.columnSet.has("LOGICALREF")) {
    query += " ORDER BY LOGICALREF ASC";
  } else if (schema.columnSet.has("CAPIBLOCK_MODIFIEDDATE")) {
    query += `
      ORDER BY
        CASE WHEN CAPIBLOCK_MODIFIEDDATE IS NULL THEN 0 ELSE 1 END ASC,
        CAPIBLOCK_MODIFIEDDATE ASC
    `;
  }

  const result = await pool.request().query(query);
  return result.recordset ?? [];
}

async function fetchProductsForSync(
  pool,
  currentConfig,
  productSchema,
  productRafSchema,
  priceSchema
) {
  if (hasProductTargetSelection(currentConfig.sync)) {
    return fetchTargetProducts(pool, currentConfig, productSchema);
  }

  if (currentConfig.sync.stockFast && currentConfig.sync.stockIncremental) {
    return fetchIncrementalStockProducts(pool, currentConfig, productSchema);
  }

  if (currentConfig.sync.catalogIncremental) {
    return fetchIncrementalCatalogProducts(
      pool,
      currentConfig,
      productSchema,
      productRafSchema,
      priceSchema
    );
  }

  return {
    rows: await fetchProducts(pool, currentConfig, productSchema),
    lastSeenStockLineRef: null,
    sinceAt: null,
    stockLineTable: null,
    catalogTable: currentConfig.logo.productTable,
  };
}

async function fetchTargetProducts(pool, currentConfig, productSchema) {
  const logicalRefColumn = findColumn(productSchema.columns, ["LOGICALREF"]);
  const codeColumn = findColumn(productSchema.columns, ["CODE", "CODE_", "sku"]);
  const filters = [];
  const request = pool.request();

  if (currentConfig.sync.targetRefs.length > 0) {
    if (logicalRefColumn) {
      filters.push(`p.${logicalRefColumn} IN (${currentConfig.sync.targetRefs.join(", ")})`);
    } else {
      console.warn("[logo-sync] target refs requested but product table has no LOGICALREF column.");
    }
  }

  if (currentConfig.sync.targetCodes.length > 0) {
    if (codeColumn) {
      const codeParams = [];
      currentConfig.sync.targetCodes.forEach((code, index) => {
        const param = `target_code_${index}`;
        request.input(param, sql.NVarChar(128), code);
        codeParams.push(`@${param}`);
      });
      filters.push(`p.${codeColumn} IN (${codeParams.join(", ")})`);
    } else {
      console.warn("[logo-sync] target codes requested but product table has no CODE column.");
    }
  }

  if (filters.length === 0) {
    return {
      rows: [],
      lastSeenStockLineRef: null,
      sinceAt: null,
      stockLineTable: null,
      catalogTable: currentConfig.logo.productTable,
      targeted: true,
      targetRefs: currentConfig.sync.targetRefs,
      targetCodes: currentConfig.sync.targetCodes,
    };
  }

  const cardTypeFilter =
    currentConfig.logo.productCardTypes.length > 0 && productSchema.columnSet.has("CARDTYPE")
      ? `AND p.CARDTYPE IN (${currentConfig.logo.productCardTypes.join(", ")})`
      : "";
  const orderBy = logicalRefColumn ? `p.${logicalRefColumn} ASC` : `p.${codeColumn} ASC`;

  const result = await request.query(`
    SELECT p.*
    FROM ${currentConfig.logo.productTable} p
    WHERE (${filters.join(" OR ")})
      ${cardTypeFilter}
    ORDER BY ${orderBy}
  `);

  return {
    rows: result.recordset ?? [],
    lastSeenStockLineRef: null,
    sinceAt: null,
    stockLineTable: null,
    catalogTable: currentConfig.logo.productTable,
    targeted: true,
    targetRefs: currentConfig.sync.targetRefs,
    targetCodes: currentConfig.sync.targetCodes,
  };
}

async function fetchIncrementalCatalogProducts(
  pool,
  currentConfig,
  productSchema,
  productRafSchema,
  priceSchema
) {
  const modifiedDateColumn = findColumn(productSchema.columns, [
    "CAPIBLOCK_MODIFIEDDATE",
    "MODIFIEDDATE",
    "UPDATED_AT",
    "UPDATEDAT",
  ]);
  const createdDateColumn = findColumn(productSchema.columns, [
    "CAPIBLOCK_CREATEDDATE",
    "CREATEDDATE",
    "CREATED_AT",
    "CREATEDAT",
  ]);

  const logicalRefColumn = findColumn(productSchema.columns, ["LOGICALREF"]);
  const catalogRafRefs =
    productRafSchema && logicalRefColumn
      ? await fetchCatalogProductRefs(pool, currentConfig, productRafSchema)
      : [];
  if (catalogRafRefs.length > 0) {
    const source = productRafSchema?.qualifiedName ?? "product raf table";
    console.log(
      `[logo-sync] catalog incremental added ${catalogRafRefs.length} product ref(s) from ${source} for shelf-address refresh`
    );
  }

  if (!modifiedDateColumn && !createdDateColumn && !logicalRefColumn) {
    console.warn("[logo-sync] catalog incremental requested but product table has no supported created/modified date or LOGICALREF columns.");
    return {
      rows: [],
      lastSeenStockLineRef: null,
      sinceAt: null,
      stockLineTable: null,
      catalogTable: currentConfig.logo.productTable,
    };
  }

  const lookbackMinutes = Math.max(1, currentConfig.sync.catalogLookbackMinutes);
  const sinceAt = new Date(Date.now() - lookbackMinutes * 60_000);
  const filters = [];
  const catalogPriceRefs =
    priceSchema && logicalRefColumn
      ? await fetchCatalogPriceRefs(
          pool,
          currentConfig,
          priceSchema,
          new Date(
            Date.now() -
              Math.max(1, currentConfig.sync.priceLookbackMinutes) * 60_000
          )
        )
      : [];
  if (catalogPriceRefs.length > 0) {
    console.log(
      `[logo-sync] catalog incremental added ${catalogPriceRefs.length} product ref(s) from ${priceSchema.qualifiedName} for price refresh`
    );
  }

  if (modifiedDateColumn) {
    filters.push(`p.${modifiedDateColumn} >= @sinceAt`);
  }

  if (createdDateColumn) {
    filters.push(`p.${createdDateColumn} >= @sinceAt`);
  }

  if (catalogRafRefs.length > 0 && logicalRefColumn) {
    filters.push(`p.${logicalRefColumn} IN (${catalogRafRefs.join(", ")})`);
  }
  if (catalogPriceRefs.length > 0 && logicalRefColumn) {
    filters.push(`p.${logicalRefColumn} IN (${catalogPriceRefs.join(", ")})`);
  }

  const cardTypeFilter =
    currentConfig.logo.productCardTypes.length > 0 && productSchema.columnSet.has("CARDTYPE")
      ? `AND p.CARDTYPE IN (${currentConfig.logo.productCardTypes.join(", ")})`
      : "";
  const recentLimit = Math.max(0, currentConfig.sync.catalogRecentLimit);
  if (logicalRefColumn && recentLimit > 0) {
    const recentCardTypeFilter =
      currentConfig.logo.productCardTypes.length > 0 && productSchema.columnSet.has("CARDTYPE")
        ? `AND q.CARDTYPE IN (${currentConfig.logo.productCardTypes.join(", ")})`
        : "";
    filters.push(`p.${logicalRefColumn} IN (
      SELECT TOP (${recentLimit}) q.${logicalRefColumn}
      FROM ${currentConfig.logo.productTable} q
      WHERE q.${logicalRefColumn} IS NOT NULL
        ${recentCardTypeFilter}
      ORDER BY q.${logicalRefColumn} DESC
    )`);
  }

  const rollingSelection =
    logicalRefColumn && Math.max(0, currentConfig.sync.catalogRollingLimit) > 0
      ? await fetchRollingCatalogLogicalRefs(
          pool,
          currentConfig,
          productSchema,
          logicalRefColumn
        )
      : null;
  if (rollingSelection?.refs?.length > 0) {
    filters.push(`p.${logicalRefColumn} IN (${rollingSelection.refs.join(", ")})`);
  }

  if (filters.length === 0) {
    console.warn("[logo-sync] catalog incremental requested but no usable catalog change filter could be built.");
    return {
      rows: [],
      lastSeenStockLineRef: null,
      sinceAt: null,
      stockLineTable: null,
      catalogTable: currentConfig.logo.productTable,
    };
  }

  const orderBy = logicalRefColumn
    ? `p.${logicalRefColumn} ASC`
    : `COALESCE(p.${modifiedDateColumn ?? createdDateColumn}, p.${createdDateColumn ?? modifiedDateColumn}) ASC`;

  const result = await pool
    .request()
    .input("sinceAt", sql.DateTime2, sinceAt)
    .query(`
      SELECT p.*
      FROM ${currentConfig.logo.productTable} p
      WHERE (${filters.join(" OR ")})
        ${cardTypeFilter}
      ORDER BY ${orderBy}
    `);

  return {
    rows: result.recordset ?? [],
    lastSeenStockLineRef: null,
    sinceAt: sinceAt.toISOString(),
    stockLineTable: null,
    catalogTable: currentConfig.logo.productTable,
    catalogRolling: rollingSelection,
    catalogRafRefs,
    catalogPriceRefs,
  };
}

async function fetchCatalogPriceRefs(pool, currentConfig, priceSchema, sinceAt) {
  const referenceColumn = findColumn(priceSchema.columns, [
    "CARDREF",
    "STOCKREF",
    "ITEMREF",
    "PRODUCTREF",
  ]);
  const modifiedDateColumn = findColumn(priceSchema.columns, [
    "CAPIBLOCK_MODIFIEDDATE",
    "MODIFIEDDATE",
    "UPDATED_AT",
    "UPDATEDAT",
  ]);
  const priceTypeColumn = findColumn(priceSchema.columns, ["PTYPE", "PRICE_TYPE"]);
  const activeColumn = findColumn(priceSchema.columns, ["ACTIVE", "IS_ACTIVE"]);

  if (!referenceColumn || !modifiedDateColumn) {
    return [];
  }

  const request = pool.request().input("priceCatalogSinceAt", sql.DateTime2, sinceAt);
  let query = `
    SELECT DISTINCT ${referenceColumn} AS product_ref
    FROM ${priceSchema.qualifiedName}
    WHERE ${modifiedDateColumn} >= @priceCatalogSinceAt
      AND ${referenceColumn} IS NOT NULL
  `;

  if (priceTypeColumn && currentConfig.logo.priceType !== undefined) {
    request.input("priceCatalogType", sql.Int, currentConfig.logo.priceType);
    query += ` AND ${priceTypeColumn} = @priceCatalogType`;
  }
  if (activeColumn) {
    query += ` AND ISNULL(${activeColumn}, 0) = 0`;
  }

  const result = await request.query(query);
  return [
    ...new Set(
      (result.recordset ?? [])
        .map((row) => Number.parseInt(String(row.product_ref), 10))
        .filter((value) => Number.isInteger(value) && value > 0)
    ),
  ];
}

async function fetchCatalogProductRefs(pool, currentConfig, productRafSchema) {
  const referenceColumn = findColumn(productRafSchema.columns, [
    "PARLOGREF",
    "PARENTREF",
    "PARENT_LOGICALREF",
    "ITEMREF",
    "CARDREF",
    "STOCKREF",
    "PRODUCTREF",
    "INFOREF",
    "LOGREF",
    "LOGICALREF",
  ]);

  if (!referenceColumn) {
    return [];
  }

  const modifiedDateColumn = findColumn(productRafSchema.columns, [
    "CAPIBLOCK_MODIFIEDDATE",
    "MODIFIEDDATE",
    "UPDATED_AT",
    "UPDATEDAT",
    "UPDATE_DATE",
  ]);
  const createdDateColumn = findColumn(productRafSchema.columns, [
    "CAPIBLOCK_CREATEDDATE",
    "CREATEDDATE",
    "CREATED_AT",
    "CREATEDAT",
  ]);
  const recentLimit = Math.max(1, currentConfig.sync.catalogRecentLimit);
  const lookbackMinutes = Math.max(1, currentConfig.sync.catalogLookbackMinutes);
  const sinceAt = new Date(Date.now() - lookbackMinutes * 60_000);

  const dateFilter = modifiedDateColumn || createdDateColumn;
  if (dateFilter) {
    const result = await pool
      .request()
      .input("sinceAt", sql.DateTime2, sinceAt)
      .query(`
        SELECT ${referenceColumn} AS product_ref
        FROM ${productRafSchema.qualifiedName}
        WHERE ${referenceColumn} IS NOT NULL
          AND (
            ${modifiedDateColumn ? `COALESCE(${modifiedDateColumn}, ${createdDateColumn ?? "NULL"}) >= @sinceAt` : ""}
            ${modifiedDateColumn && createdDateColumn ? " OR " : ""}
            ${!modifiedDateColumn && createdDateColumn ? `${createdDateColumn} >= @sinceAt` : ""}
          )
      `);

    return dedupeNumericRefs(result.recordset ?? []);
  }

  const result = await pool.request().query(`
    SELECT TOP (${recentLimit}) ${referenceColumn} AS product_ref
    FROM ${productRafSchema.qualifiedName}
    WHERE ${referenceColumn} IS NOT NULL
    ORDER BY ${referenceColumn} DESC
  `);

  return dedupeNumericRefs(result.recordset ?? []);
}

function dedupeNumericRefs(rows) {
  const seen = new Set();
  const refs = [];

  for (const row of rows) {
    const value = normalizeInteger(row.product_ref);
    if (value === null) {
      continue;
    }
    const key = String(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push(value);
  }

  return refs;
}

async function fetchRollingCatalogLogicalRefs(pool, currentConfig, productSchema, logicalRefColumn) {
  const limit = Math.max(0, currentConfig.sync.catalogRollingLimit);
  if (limit <= 0) {
    return null;
  }

  const state = loadSyncState(currentConfig.sync.catalogStateFile) ?? {};
  const lastSeenLogicalRef = Math.max(0, normalizeInteger(state.last_seen_logical_ref) ?? 0);
  const cardTypeFilter =
    currentConfig.logo.productCardTypes.length > 0 && productSchema.columnSet.has("CARDTYPE")
      ? `AND CARDTYPE IN (${currentConfig.logo.productCardTypes.join(", ")})`
      : "";

  let refs = await fetchRollingCatalogRefsAfter(
    pool,
    currentConfig,
    logicalRefColumn,
    cardTypeFilter,
    lastSeenLogicalRef,
    limit
  );
  let wrapped = false;

  if (refs.length === 0 && lastSeenLogicalRef > 0) {
    refs = await fetchRollingCatalogRefsAfter(
      pool,
      currentConfig,
      logicalRefColumn,
      cardTypeFilter,
      0,
      limit
    );
    wrapped = true;
  }

  const nextLogicalRef = refs.reduce((max, value) => Math.max(max, value), wrapped ? 0 : lastSeenLogicalRef);

  return {
    refs,
    lastSeenLogicalRef,
    nextLogicalRef,
    limit,
    wrapped,
  };
}

function saveCatalogRollingState(currentConfig, rollingSelection) {
  saveSyncState(currentConfig.sync.catalogStateFile, {
    last_seen_logical_ref: rollingSelection.nextLogicalRef,
    previous_seen_logical_ref: rollingSelection.lastSeenLogicalRef,
    limit: rollingSelection.limit,
    wrapped: rollingSelection.wrapped,
    selected_count: rollingSelection.refs?.length ?? 0,
    updated_at: new Date().toISOString(),
    product_table: currentConfig.logo.productTable,
  });
}

async function fetchRollingCatalogRefsAfter(pool, currentConfig, logicalRefColumn, cardTypeFilter, afterRef, limit) {
  const result = await pool
    .request()
    .input("afterRef", sql.Int, afterRef)
    .query(`
      SELECT TOP (${limit}) ${logicalRefColumn} AS logical_ref
      FROM ${currentConfig.logo.productTable}
      WHERE ${logicalRefColumn} IS NOT NULL
        AND ${logicalRefColumn} > @afterRef
        ${cardTypeFilter}
      ORDER BY ${logicalRefColumn} ASC
    `);

  return (result.recordset ?? [])
    .map((row) => normalizeInteger(row.logical_ref))
    .filter((value) => value !== null);
}

async function fetchIncrementalStockProducts(pool, currentConfig, productSchema) {
  const stockLineSchema = await resolveOptionalTableSchema(
    pool,
    currentConfig,
    "stockLineTable",
    "stock line",
    derivePrimaryStockMovementTableNames(currentConfig.logo.productTable)
  );

  if (!stockLineSchema) {
    console.warn("[logo-sync] stock fast incremental requested but stock line table was not found.");
    return { rows: [], lastSeenStockLineRef: null, sinceAt: null, stockLineTable: null };
  }

  const productRefColumn = findColumn(stockLineSchema.columns, [
    "STOCKREF",
    "ITEMREF",
    "CARDREF",
    "PRODUCTREF",
  ]);
  const lineRefColumn = findColumn(stockLineSchema.columns, ["LOGICALREF"]);
  const lineDateColumn = findColumn(stockLineSchema.columns, ["DATE_", "DATE", "TRDATE"]);
  const lineFtimeColumn = findColumn(stockLineSchema.columns, ["FTIME"]);
  const ficheRefColumn = findColumn(stockLineSchema.columns, ["STFICHEREF"]);
  const productLogicalRefColumn = findColumn(productSchema.columns, ["LOGICALREF"]);

  if (!productRefColumn || !productLogicalRefColumn) {
    console.warn("[logo-sync] stock fast incremental skipped; stock line or product table is missing reference columns.");
    return {
      rows: [],
      lastSeenStockLineRef: null,
      sinceAt: null,
      stockLineTable: stockLineSchema.qualifiedName,
    };
  }

  let ficheSchema = null;
  let ficheDateColumn = null;
  let ficheFtimeColumn = null;
  let joinFicheSql = "";

  if (!lineDateColumn && ficheRefColumn) {
    ficheSchema = await resolveOptionalTableSchema(
      pool,
      currentConfig,
      "stockFicheTable",
      "stock fiche",
      derivePrimaryStockFicheTableNames()
    );
    ficheDateColumn = ficheSchema ? findColumn(ficheSchema.columns, ["DATE_", "DATE", "TRDATE"]) : null;
    ficheFtimeColumn = ficheSchema ? findColumn(ficheSchema.columns, ["FTIME"]) : null;
    const ficheLogicalRefColumn = ficheSchema ? findColumn(ficheSchema.columns, ["LOGICALREF"]) : null;

    if (ficheSchema && ficheLogicalRefColumn) {
      joinFicheSql = `LEFT JOIN ${ficheSchema.qualifiedName} sf ON sf.${ficheLogicalRefColumn} = sl.${ficheRefColumn}`;
    }
  }

  const eventDateSql = buildStockEventDateSql(
    lineDateColumn ? "sl" : "sf",
    lineDateColumn ?? ficheDateColumn,
    lineFtimeColumn ?? ficheFtimeColumn
  );

  if (!eventDateSql) {
    console.warn("[logo-sync] stock fast incremental skipped; DATE_ column was not found on stock line/fiche tables.");
    return {
      rows: [],
      lastSeenStockLineRef: null,
      sinceAt: null,
      stockLineTable: stockLineSchema.qualifiedName,
    };
  }

  const lookbackMinutes = Math.max(1, currentConfig.sync.stockLookbackMinutes);
  const sinceAt = new Date(Date.now() - lookbackMinutes * 60_000);
  const cardTypeFilter =
    currentConfig.logo.productCardTypes.length > 0 && productSchema.columnSet.has("CARDTYPE")
      ? `AND p.CARDTYPE IN (${currentConfig.logo.productCardTypes.join(", ")})`
      : "";
  const maxLineRefSql = lineRefColumn ? `MAX(sl.${lineRefColumn})` : "NULL";
  const fastLimit = currentConfig.sync.stockFastLimit;
  const changedStockOrderSql = lineRefColumn
    ? "last_stock_line_ref DESC, product_ref ASC"
    : "product_ref ASC";
  const productOrderSql = lineRefColumn
    ? `c.last_stock_line_ref DESC, p.${productLogicalRefColumn} ASC`
    : `p.${productLogicalRefColumn} ASC`;

  const result = await pool
    .request()
    .input("sinceAt", sql.DateTime2, sinceAt)
    .query(`
      WITH ChangedStock AS (
        SELECT
          sl.${productRefColumn} AS product_ref,
          ${maxLineRefSql} AS last_stock_line_ref
        FROM ${stockLineSchema.qualifiedName} sl
        ${joinFicheSql}
        WHERE sl.${productRefColumn} IS NOT NULL
          AND ${eventDateSql} >= @sinceAt
        GROUP BY sl.${productRefColumn}
      ),
      LimitedChangedStock AS (
        SELECT TOP (${fastLimit})
          product_ref,
          last_stock_line_ref
        FROM ChangedStock
        ORDER BY ${changedStockOrderSql}
      )
      SELECT p.*, c.last_stock_line_ref
      FROM ${currentConfig.logo.productTable} p
      INNER JOIN LimitedChangedStock c ON c.product_ref = p.${productLogicalRefColumn}
      WHERE 1 = 1
        ${cardTypeFilter}
      ORDER BY ${productOrderSql}
    `);

  const rows = result.recordset ?? [];
  const lastSeenStockLineRef = rows.reduce((max, row) => {
    const current = normalizeInteger(row.last_stock_line_ref);
    if (current === null) {
      return max;
    }

    return max === null ? current : Math.max(max, current);
  }, null);

  console.log(
    `[logo-sync] stock fast incremental selected ${rows.length} changed product(s) since ${sinceAt.toISOString()} from ${stockLineSchema.qualifiedName} limit=${fastLimit}${rows.length >= fastLimit ? " limited=true" : ""}`
  );

  return {
    rows,
    lastSeenStockLineRef,
    sinceAt: sinceAt.toISOString(),
    stockLineTable: stockLineSchema.qualifiedName,
    stockFastLimit: fastLimit,
    stockFastLimited: rows.length >= fastLimit,
  };
}

function buildStockEventDateSql(alias, dateColumn, ftimeColumn) {
  if (!alias || !dateColumn) {
    return "";
  }

  const baseDate = `CAST(${alias}.${dateColumn} AS datetime2)`;
  if (!ftimeColumn) {
    return baseDate;
  }

  return `DATEADD(second, COALESCE(TRY_CONVERT(int, ${alias}.${ftimeColumn}), 0), ${baseDate})`;
}

async function fetchStockSnapshot(pool, currentConfig, schema, logicalRefs, warehouseInfoByNo = new Map()) {
  if (logicalRefs.length === 0) {
    return new Map();
  }

  const snapshot = new Map();
  const summarySchemas = await resolveStockSummarySchemas(pool, currentConfig, schema);

  for (const currentSchema of summarySchemas) {
    const refsNeedingStock = stockRefsNeedingWarehouseBreakdown(logicalRefs, snapshot);
    if (refsNeedingStock.length === 0) {
      break;
    }

    const currentSnapshot = await fetchStockSnapshotFromSummarySchema(
      pool,
      currentConfig,
      currentSchema,
      refsNeedingStock,
      warehouseInfoByNo
    );

    mergeStockSnapshot(snapshot, currentSnapshot);
  }

  const remainingRefs = logicalRefs.filter((logicalRef) => !snapshot.has(String(logicalRef)));
  const refsNeedingWarehouseBreakdown = stockRefsNeedingWarehouseBreakdown(logicalRefs, snapshot);
  if (refsNeedingWarehouseBreakdown.length === 0) {
    return snapshot;
  }

  if (currentConfig.sync.stockSkipMovementFallback) {
    if (currentConfig.logo.explicitStockTable && remainingRefs.length > 0) {
      console.warn(
        `[logo-sync] stock summary returned no row for ${remainingRefs.length} product(s) on ${currentConfig.logo.explicitStockTable}; movement fallback skipped by config.`
      );
    }

    return snapshot;
  }

  if (currentConfig.logo.explicitStockTable && remainingRefs.length > 0) {
    console.warn(
      `[logo-sync] stock summary returned no row for ${remainingRefs.length} product(s) on ${currentConfig.logo.explicitStockTable}; movement fallback will be tried for warehouse breakdown.`
    );
  }

  const movementSchemas = await resolveStockMovementSchemas(pool, currentConfig, summarySchemas);

  for (const movementSchema of movementSchemas) {
    const movementSnapshot = await fetchStockSnapshotFromMovementSchema(
      pool,
      currentConfig,
      movementSchema,
      refsNeedingWarehouseBreakdown,
      warehouseInfoByNo
    );

    if (movementSnapshot.size === 0) {
      continue;
    }

    console.warn(
      `[logo-sync] stock summary missing for ${movementSnapshot.size} product(s); movement fallback used via ${movementSchema.qualifiedName}.`
    );

    mergeStockSnapshot(snapshot, movementSnapshot);
    break;
  }

  return snapshot;
}

async function fetchStockSnapshotFromSummarySchema(pool, currentConfig, schema, logicalRefs, warehouseInfoByNo = new Map()) {
  if (!schema || logicalRefs.length === 0) {
    return new Map();
  }

  const referenceColumn = findColumn(schema.columns, [
    "STOCKREF",
    "ITEMREF",
    "CARDREF",
    "PRODUCTREF",
    "LOGICALREF",
  ]);
  const availableColumn = findColumn(schema.columns, [
    "ONHAND",
    "AVAILABLE_TOTAL",
    "AVAILABLE",
    "AMOUNT",
  ]);
  const reservedColumn = findColumn(schema.columns, ["RESERVED", "RESERVED_TOTAL"]);
  const warehouseColumn = findColumn(schema.columns, [
    "INVENNO",
    "SOURCEINDEX",
    "SOURCECOSTGRP",
    "DESTINDEX",
    "DESTCOSTGRP",
    "WAREHOUSE_NO",
    "WAREHOUSE",
  ]);
  const dateColumn = findColumn(schema.columns, ["DATE_", "DATE", "TRDATE"]);

  if (!referenceColumn || !availableColumn) {
    console.warn(
      `[logo-sync] stock table ${currentConfig.logo.stockTable} is missing a supported reference or quantity column.`
    );
    return new Map();
  }

  const refsSql = logicalRefs.join(", ");
  const reservedSql = reservedColumn ? `SUM(COALESCE(${reservedColumn}, 0))` : "0";
  const warehouseGroupSql = warehouseColumn
    ? `, COALESCE(${warehouseColumn}, -1)`
    : "";
  const dateFilterSql = dateColumn
    ? ` AND CAST(${dateColumn} AS date) >= CONVERT(date, '19190519', 112)`
    : "";

  const result = await pool.request().query(
    `
      SELECT
        ${referenceColumn} AS product_ref,
        ${warehouseColumn ? "COALESCE(" + warehouseColumn + ", -1)" : "-1"} AS warehouse_no,
        SUM(COALESCE(${availableColumn}, 0)) AS available_total,
        ${reservedSql} AS reserved_total
      FROM ${schema.qualifiedName}
      WHERE ${referenceColumn} IN (${refsSql})${dateFilterSql}
      GROUP BY ${referenceColumn}${warehouseGroupSql}
    `
  );

  const snapshot = new Map();
  const rowsByRef = new Map();

  for (const row of result.recordset ?? []) {
    const productRef = normalizeString(row.product_ref);
    if (!productRef) {
      continue;
    }

    const rowSnapshot = {
      invenno: normalizeInteger(row.warehouse_no) ?? -1,
      onhand_total: normalizeInteger(row.available_total) ?? 0,
      reserved_total: normalizeInteger(row.reserved_total) ?? 0,
    };

    const existing = rowsByRef.get(productRef) ?? [];
    existing.push(rowSnapshot);
    rowsByRef.set(productRef, existing);
  }

  for (const [productRef, rows] of rowsByRef.entries()) {
    const totalRow = rows.find((row) => row.invenno === -1);
    const warehouseRows = rows.filter((row) => row.invenno !== -1);
    const rowsForTotal = totalRow ? [totalRow] : warehouseRows;
    const onhandTotal = rowsForTotal.reduce((sum, row) => sum + row.onhand_total, 0);
    const reservedTotal = rowsForTotal.reduce((sum, row) => sum + row.reserved_total, 0);

    snapshot.set(productRef, {
      available_total: onhandTotal,
      reserved_total: reservedTotal,
      authoritative: true,
      source_kind: "warehouse_totals",
      source_table: schema.qualifiedName,
      warehouses: warehouseRows.map((row) => ({
        invenno: row.invenno,
        warehouse_code: warehouseInfoByNo.get(row.invenno)?.code ?? String(row.invenno),
        warehouse_name: warehouseInfoByNo.get(row.invenno)?.name ?? null,
        shelf_key: currentConfig.logo.warehouseRafKeyMap.get(row.invenno) ?? null,
        onhand_total: row.onhand_total,
        reserved_total: row.reserved_total,
        available_total: row.onhand_total,
      })),
    });
  }

  return snapshot;
}

async function fetchWarehouseInfo(pool, schema, fallbackMap = new Map()) {
  if (!schema) {
    return new Map(fallbackMap);
  }

  const noColumn = findColumn(schema.columns, [
    "INVENNO",
    "NR",
    "NUMBER",
    "NO",
    "WAREHOUSE_NO",
    "LOGICALREF",
  ]);
  const codeColumn = findColumn(schema.columns, ["CODE", "CODE_", "NR", "NUMBER", "NO"]);
  const nameColumn = findColumn(schema.columns, [
    "NAME",
    "DESCRIPTION",
    "DEFINITION_",
    "DEFINITION",
    "TITLE",
  ]);

  if (!noColumn) {
    console.warn(
      `[logo-sync] warehouse info table ${schema.qualifiedName} has no supported warehouse number column.`
    );
    return new Map();
  }

  const result = await pool.request().query(`
    SELECT
      ${noColumn} AS warehouse_no
      ${codeColumn ? `, ${codeColumn} AS warehouse_code` : ""}
      ${nameColumn ? `, ${nameColumn} AS warehouse_name` : ""}
    FROM ${schema.qualifiedName}
  `);

  const map = new Map();

  for (const row of result.recordset ?? []) {
    const warehouseNo = normalizeInteger(row.warehouse_no);
    if (warehouseNo === null) {
      continue;
    }

    const fallback = fallbackMap.get(warehouseNo);

    map.set(warehouseNo, {
      no: warehouseNo,
      code: normalizeString(row.warehouse_code) ?? fallback?.code ?? String(warehouseNo),
      name: normalizeString(row.warehouse_name) ?? fallback?.name ?? null,
    });
  }

  for (const [warehouseNo, fallback] of fallbackMap.entries()) {
    if (!map.has(warehouseNo)) {
      map.set(warehouseNo, fallback);
    }
  }

  return map;
}

async function fetchStockSnapshotFromMovementSchema(
  pool,
  currentConfig,
  schema,
  logicalRefs,
  warehouseInfoByNo = new Map()
) {
  if (!schema || logicalRefs.length === 0) {
    return new Map();
  }

  const referenceColumn = findColumn(schema.columns, [
    "STOCKREF",
    "ITEMREF",
    "CARDREF",
    "PRODUCTREF",
    "LOGICALREF",
  ]);
  const amountColumn = findColumn(schema.columns, ["AMOUNT", "ONHAND", "AVAILABLE_TOTAL"]);
  const warehouseColumn = findColumn(schema.columns, [
    "INVENNO",
    "SOURCEINDEX",
    "SOURCECOSTGRP",
    "DESTINDEX",
    "DESTCOSTGRP",
    "WAREHOUSE_NO",
    "WAREHOUSE",
  ]);
  const ioCodeColumn = findColumn(schema.columns, ["IOCODE"]);
  const lineTypeColumn = findColumn(schema.columns, ["LINETYPE"]);
  const cancelledColumn = findColumn(schema.columns, ["CANCELLED", "CANCELLED_"]);

  if (!referenceColumn || !amountColumn) {
    return new Map();
  }

  const refsSql = logicalRefs.join(", ");
  const amountSql = `COALESCE(${amountColumn}, 0)`;
  const signedAmountSql = ioCodeColumn
    ? `
      CASE
        WHEN ${ioCodeColumn} IN (1, 2) THEN ${amountSql}
        WHEN ${ioCodeColumn} IN (3, 4) THEN -${amountSql}
        ELSE 0
      END
    `
    : amountSql;

  const extraFilters = [];
  if (lineTypeColumn) {
    extraFilters.push(`COALESCE(${lineTypeColumn}, 0) = 0`);
  }
  if (cancelledColumn) {
    extraFilters.push(`COALESCE(${cancelledColumn}, 0) = 0`);
  }

  const filterSql =
    extraFilters.length > 0
      ? `\n      AND ${extraFilters.join("\n      AND ")}`
      : "";

  const result = await pool.request().query(`
    SELECT
      ${referenceColumn} AS product_ref,
      ${warehouseColumn ? `COALESCE(${warehouseColumn}, -1)` : "-1"} AS warehouse_no,
      SUM(${signedAmountSql}) AS available_total
    FROM ${schema.qualifiedName}
    WHERE ${referenceColumn} IN (${refsSql})${filterSql}
    GROUP BY ${referenceColumn}${warehouseColumn ? `, COALESCE(${warehouseColumn}, -1)` : ""}
  `);

  const snapshot = new Map();
  const rowsByRef = new Map();

  for (const row of result.recordset ?? []) {
    const productRef = normalizeString(row.product_ref);
    if (!productRef) {
      continue;
    }

    const rowSnapshot = {
      invenno: normalizeInteger(row.warehouse_no) ?? -1,
      available_total: normalizeInteger(row.available_total) ?? 0,
      reserved_total: 0,
    };

    const existing = rowsByRef.get(productRef) ?? [];
    existing.push(rowSnapshot);
    rowsByRef.set(productRef, existing);
  }

  for (const [productRef, rows] of rowsByRef.entries()) {
    const totalRow = rows.find((row) => row.invenno === -1);
    const warehouseRows = rows.filter((row) => row.invenno !== -1);
    const rowsForTotal = totalRow ? [totalRow] : warehouseRows;
    const availableTotal = rowsForTotal.reduce((sum, row) => sum + row.available_total, 0);

    snapshot.set(productRef, {
      available_total: availableTotal,
      reserved_total: 0,
      warehouses: warehouseRows.map((row) => ({
        invenno: row.invenno,
        warehouse_code: warehouseInfoByNo.get(row.invenno)?.code ?? String(row.invenno),
        warehouse_name: warehouseInfoByNo.get(row.invenno)?.name ?? null,
        shelf_key: currentConfig.logo.warehouseRafKeyMap.get(row.invenno) ?? null,
        onhand_total: row.available_total,
        reserved_total: 0,
        available_total: row.available_total,
      })),
    });
  }

  return snapshot;
}

async function resolveStockSummarySchemas(pool, currentConfig, primarySchema) {
  const cacheKey = "__stockSummarySchemas";
  if (Array.isArray(currentConfig.logo[cacheKey])) {
    return currentConfig.logo[cacheKey];
  }

  const schemas = [];
  const seen = new Set();

  if (primarySchema?.qualifiedName) {
    schemas.push(primarySchema);
    seen.add(primarySchema.qualifiedName.toUpperCase());
  }

  for (const tableName of deriveSiblingStockSummaryTableNames(currentConfig.logo.stockTable)) {
    if (seen.has(tableName.toUpperCase())) {
      continue;
    }

    const resolved = await inspectTable(pool, tableName, "stock fallback", false);
    if (!resolved) {
      continue;
    }

    schemas.push(resolved);
    seen.add(resolved.qualifiedName.toUpperCase());
  }

  currentConfig.logo[cacheKey] = schemas;
  return schemas;
}

async function resolveStockMovementSchemas(pool, currentConfig, summarySchemas) {
  const cacheKey = "__stockMovementSchemas";
  if (Array.isArray(currentConfig.logo[cacheKey])) {
    return currentConfig.logo[cacheKey];
  }

  const schemas = [];
  const seen = new Set(
    summarySchemas
      .map((schema) => schema?.qualifiedName)
      .filter(Boolean)
      .map((value) => value.toUpperCase())
  );

  const movementCandidates = currentConfig.logo.stockTable
    ? deriveStockMovementTableNames(currentConfig.logo.stockTable)
    : derivePrimaryStockMovementTableNames(currentConfig.logo.productTable);

  for (const tableName of movementCandidates) {
    if (seen.has(tableName.toUpperCase())) {
      continue;
    }

    const resolved = await inspectTable(pool, tableName, "stock movement fallback", false);
    if (!resolved) {
      continue;
    }

    schemas.push(resolved);
    seen.add(resolved.qualifiedName.toUpperCase());
  }

  currentConfig.logo[cacheKey] = schemas;
  return schemas;
}

function deriveSiblingStockSummaryTableNames(stockTable) {
  return replaceTableSuffixes(stockTable, [
    { pattern: /STINVTOT$/i, replacement: "GNTOTST" },
    { pattern: /STINVTOT$/i, replacement: "VRNTINVTOT" },
    { pattern: /GNTOTST$/i, replacement: "STINVTOT" },
    { pattern: /GNTOTST$/i, replacement: "VRNTINVTOT" },
    { pattern: /VRNTINVTOT$/i, replacement: "STINVTOT" },
    { pattern: /VRNTINVTOT$/i, replacement: "GNTOTST" },
  ]);
}

function derivePrimaryStockTableNames(productTable) {
  const directCandidates = replaceTableSuffixes(productTable, [
    { pattern: /ITEMS$/i, replacement: "STINVTOT" },
    { pattern: /ITEMS$/i, replacement: "GNTOTST" },
    { pattern: /ITEMS$/i, replacement: "VRNTINVTOT" },
  ]);

  const branchCandidates = directCandidates.flatMap((candidate) => deriveBranch01TableNames(candidate));
  const viewCandidates = [...directCandidates, ...branchCandidates].flatMap((candidate) => deriveLogoStockViewTableNames(candidate));
  return uniqueColumns([...viewCandidates, ...branchCandidates, ...directCandidates]);
}

function derivePrimaryStockFicheTableNames() {
  return [logoPeriodTable("STFICHE")];
}

function deriveLogoStockViewTableNames(stockTable) {
  return [stockTable.replace(/(^|[.\[])(LG_)/i, "$1LV_")];
}

function deriveStockMovementTableNames(stockTable) {
  return replaceTableSuffixes(stockTable, [
    { pattern: /STINVTOT$/i, replacement: "STLINE" },
    { pattern: /GNTOTST$/i, replacement: "STLINE" },
    { pattern: /VRNTINVTOT$/i, replacement: "STLINE" },
  ]);
}

function derivePrimaryStockMovementTableNames(productTable) {
  const summaryCandidates = derivePrimaryStockTableNames(productTable);
  const movementCandidates = summaryCandidates.flatMap((candidate) => deriveStockMovementTableNames(candidate));
  return uniqueColumns(movementCandidates);
}

function derivePrimaryWarehouseInfoTableNames(productTable) {
  return replaceTableSuffixes(productTable, [
    { pattern: /ITEMS$/i, replacement: "INVDEF" },
  ]);
}

function derivePrimaryPriceTableNames(productTable) {
  return replaceTableSuffixes(productTable, [
    { pattern: /ITEMS$/i, replacement: "PRCLIST" },
  ]);
}

function derivePrimaryProductUnitTableNames(productTable) {
  return replaceTableSuffixes(productTable, [
    { pattern: /ITEMS$/i, replacement: "ITMUNITA" },
  ]);
}

function derivePrimaryUnitSetTableNames(productTable) {
  return replaceTableSuffixes(productTable, [
    { pattern: /ITEMS$/i, replacement: "UNITSETF" },
  ]);
}

function derivePrimaryUnitTableNames(productTable) {
  return replaceTableSuffixes(productTable, [
    { pattern: /ITEMS$/i, replacement: "UNITSETL" },
  ]);
}

function derivePrimaryProductImageTableNames(productTable) {
  const logoDocumentCandidates = deriveLogoDocumentImageTableNames(productTable);
  const directCandidates = replaceTableSuffixes(productTable, [
    { pattern: /ITEMS$/i, replacement: "ITEMSIMG" },
    { pattern: /ITEMS$/i, replacement: "ITEMPIC" },
    { pattern: /ITEMS$/i, replacement: "ITEMIMAGE" },
    { pattern: /ITEMS$/i, replacement: "ITEMPHOTO" },
    { pattern: /ITEMS$/i, replacement: "PICTURE" },
    { pattern: /ITEMS$/i, replacement: "PICTURES" },
    { pattern: /ITEMS$/i, replacement: "IMAGES" },
  ]);

  const branchCandidates = directCandidates.flatMap((candidate) => deriveBranch01TableNames(candidate));
  return uniqueColumns([...logoDocumentCandidates, ...directCandidates, ...branchCandidates]);
}

function derivePrimaryProductRafTableNames(productTable) {
  const normalized = normalizeString(productTable);
  const [schemaName, objectName] = normalized ? splitTableName(normalized) : ["dbo", ""];
  const firmMatch = objectName.match(/^LG_(\d{3})_ITEMS$/i);
  const firmNo = firmMatch?.[1] ?? logoFirmCode();

  return uniqueColumns([
    `${schemaName}.LG_XT1001_${firmNo}`,
    logoFirmTable("XT1001"),
  ]);
}

function derivePrimaryProductSubstituteTableNames(productTable) {
  return replaceTableSuffixes(productTable, [
    { pattern: /ITEMS$/i, replacement: "ITEMSUBS" },
  ]);
}

function deriveLogoDocumentImageTableNames(productTable) {
  const normalized = normalizeString(productTable);
  const [schemaName, objectName] = normalized ? splitTableName(normalized) : ["dbo", ""];
  const firmMatch = objectName.match(/^LG_(\d{3})_ITEMS$/i);
  const firmNo = firmMatch?.[1] ?? logoFirmCode();
  const periodNo = logoPeriodCode();

  return [
    `${schemaName}.LG_${firmNo}_${periodNo}_PERDOC`,
    `${schemaName}.LG_${firmNo}_FIRMDOC`,
    `${schemaName}.LG_${firmNo}_${periodNo}_FOLDER`,
    logoPeriodTable("PERDOC"),
    logoFirmTable("FIRMDOC"),
    logoPeriodTable("FOLDER"),
  ];
}

function replaceTableSuffixes(tableName, replacements) {
  const normalized = normalizeString(tableName);
  if (!normalized) {
    return [];
  }

  const candidates = replacements
    .map(({ pattern, replacement }) => normalized.replace(pattern, replacement))
    .filter((candidate) => candidate !== normalized);

  return uniqueColumns(candidates);
}

function deriveBranch01TableNames(tableName) {
  const normalized = normalizeString(tableName);
  if (!normalized) {
    return [];
  }

  const [schemaName, objectName] = splitTableName(normalized);
  const branchVersion = objectName.replace(/^LG_(\d{3})_/i, "LG_$1_01_");

  if (branchVersion === objectName) {
    return [];
  }

  return [`${schemaName}.${branchVersion}`];
}

function mergeStockSnapshot(target, source) {
  for (const [productRef, stock] of source.entries()) {
    const existing = target.get(productRef);
    if (existing && (hasWarehouseRows(existing) || !hasWarehouseRows(stock))) {
      continue;
    }

    target.set(productRef, existing ? { ...existing, ...stock } : stock);
  }
}

function hasWarehouseRows(stock) {
  return Array.isArray(stock?.warehouses) && stock.warehouses.length > 0;
}

function stockRefsNeedingWarehouseBreakdown(logicalRefs, snapshot) {
  return logicalRefs.filter((logicalRef) => {
    const stock = snapshot.get(String(logicalRef));
    return !stock || !hasWarehouseRows(stock);
  });
}

async function fetchPriceSnapshot(pool, currentConfig, schema, logicalRefs) {
  if (!schema || logicalRefs.length === 0) {
    return new Map();
  }

  const referenceColumn = findColumn(schema.columns, [
    "CARDREF",
    "STOCKREF",
    "ITEMREF",
    "PRODUCTREF",
    "LOGICALREF",
  ]);
  const amountColumn = findColumn(schema.columns, ["PRICE", "LIST_PRICE", "AMOUNT"]);
  const currencyColumn = findColumn(schema.columns, ["CURRENCY", "CURCODE", "CURRENCY_CODE"]);
  const priceTypeColumn = findColumn(schema.columns, ["PTYPE", "PRICE_TYPE"]);
  const logicalRefColumn = findColumn(schema.columns, ["LOGICALREF"]);
  const modifiedDateColumn = findColumn(schema.columns, [
    "CAPIBLOCK_MODIFIEDDATE",
    "UPDATED_AT",
    "DATE_",
  ]);
  const beginDateColumn = findColumn(schema.columns, ["BEGDATE", "BEGIN_DATE", "STARTDATE"]);
  const endDateColumn = findColumn(schema.columns, ["ENDDATE", "END_DATE", "STOPDATE"]);
  const activeColumn = findColumn(schema.columns, ["ACTIVE", "IS_ACTIVE"]);
  const groupedPricePredicate = buildLogoGroupedPricePredicate(schema.columns);

  if (!referenceColumn || !amountColumn) {
    console.warn(
      `[logo-sync] price table ${currentConfig.logo.priceTable} is missing a supported reference or amount column.`
    );
    return new Map();
  }

  const refsSql = logicalRefs.join(", ");
  const request = pool.request();

  let query = `
    SELECT *
    FROM ${schema.qualifiedName}
    WHERE ${referenceColumn} IN (${refsSql})
  `;

  if (priceTypeColumn && currentConfig.logo.priceType !== undefined) {
    request.input("priceType", sql.Int, currentConfig.logo.priceType);
    query += groupedPricePredicate
      ? ` AND (${priceTypeColumn} = @priceType OR ${groupedPricePredicate})`
      : ` AND ${priceTypeColumn} = @priceType`;
  }

  if (activeColumn) {
    query += ` AND ISNULL(${activeColumn}, 0) = 0`;
  }

  if (beginDateColumn) {
    query += ` AND (${beginDateColumn} IS NULL OR ${beginDateColumn} <= GETDATE())`;
  }

  if (endDateColumn) {
    query += ` AND (${endDateColumn} IS NULL OR ${endDateColumn} >= CAST(GETDATE() AS date))`;
  }

  query += ` ORDER BY ${referenceColumn} ASC`;

  if (modifiedDateColumn) {
    query += `, ${modifiedDateColumn} DESC`;
  }

  if (logicalRefColumn) {
    query += `, ${logicalRefColumn} DESC`;
  }

  const result = await request.query(query);
  const snapshot = new Map();

  for (const row of result.recordset ?? []) {
    const productRef = normalizeString(readFirst(row, ["product_ref", referenceColumn]));
    if (!productRef) {
      continue;
    }

    const listPrice = normalizeDecimal(readFirst(row, ["list_price", amountColumn]));
    if (listPrice === null) {
      continue;
    }

    const priceGroupCode = resolveLogoPriceGroupCode(row);
    const price = {
      list_price: listPrice,
      currency: normalizeCurrencyCode(readFirst(row, ["currency", currencyColumn])),
      price_list_code: priceGroupCode,
      meta: compactObject({
        logicalref: normalizeString(readFirst(row, ["LOGICALREF", logicalRefColumn])),
        ptype: normalizeInteger(readFirst(row, ["PTYPE", priceTypeColumn])),
        uomref: normalizeString(readFirst(row, ["UOMREF", "uomref"])),
        incvat: normalizeInteger(readFirst(row, ["INCVAT", "incvat"])),
        priority: normalizeInteger(readFirst(row, ["PRIORITY", "priority"])),
        clientcode: normalizeString(readFirst(row, ["CLIENTCODE", "clientcode"])),
        clspecode: normalizeString(readFirst(row, ["CLSPECODE", "clspecode"])),
        clspecode2: normalizeString(readFirst(row, ["CLSPECODE2", "clspecode2"])),
        clspecode3: normalizeString(readFirst(row, ["CLSPECODE3", "clspecode3"])),
        clspecode4: normalizeString(readFirst(row, ["CLSPECODE4", "clspecode4"])),
        clspecode5: normalizeString(readFirst(row, ["CLSPECODE5", "clspecode5"])),
        payplanref: normalizeString(readFirst(row, ["PAYPLANREF", "payplanref"])),
        mtrltype: normalizeInteger(readFirst(row, ["MTRLTYPE", "mtrltype"])),
        leadtime: normalizeInteger(readFirst(row, ["LEADTIME", "leadtime"])),
        begdate: readFirst(row, ["BEGDATE", beginDateColumn]) ?? null,
        enddate: readFirst(row, ["ENDDATE", endDateColumn]) ?? null,
        condition: normalizeString(readFirst(row, ["CONDITION", "condition"])),
        shiptyp: normalizeString(readFirst(row, ["SHIPTYP", "shiptyp"])),
        specialized: normalizeInteger(readFirst(row, ["SPECIALIZED", "specialized"])),
      }),
    };

    const productPrices = snapshot.get(productRef) ?? {
      primary: null,
      entries: [],
      campaign_prices: [],
    };

    const campaignPriceReason = logoCampaignPriceReason(row, priceGroupCode);
    if (campaignPriceReason) {
      const campaignPrice = buildLogoCampaignPrice(row, price, priceGroupCode, {
        logicalRefColumn,
        beginDateColumn,
        endDateColumn,
        campaignPriceReason,
      });

      if (
        campaignPrice &&
        !productPrices.campaign_prices.some(
          (entry) => entry.source_reference === campaignPrice.source_reference
        )
      ) {
        productPrices.campaign_prices.push(campaignPrice);
      }

      snapshot.set(productRef, productPrices);
      if (campaignPriceReason !== "batum_f12_price") {
        continue;
      }
    }

    if (
      priceGroupCode &&
      !productPrices.entries.some((entry) => entry.price_list_code === priceGroupCode)
    ) {
      productPrices.entries.push(price);
    }

    if (
      !productPrices.primary ||
      (
        normalizeString(currentConfig.sync.priceListCode)?.toUpperCase() === priceGroupCode &&
        productPrices.primary.price_list_code !== priceGroupCode
      ) ||
      (!priceGroupCode && productPrices.primary.price_list_code)
    ) {
      productPrices.primary = price;
    }

    snapshot.set(productRef, productPrices);
  }

  return snapshot;
}

function resolveLogoPriceGroupCode(row) {
  for (const value of [
    readFirst(row, ["CLSPECODE", "clspecode"]),
    readFirst(row, ["CLSPECODE2", "clspecode2"]),
    readFirst(row, ["CLSPECODE3", "clspecode3"]),
    readFirst(row, ["CLSPECODE4", "clspecode4"]),
    readFirst(row, ["CLSPECODE5", "clspecode5"]),
    readFirst(row, ["GRPCODE", "grpcode", "GROUPCODE", "groupcode"]),
    readFirst(row, ["CLIENTCODE", "clientcode"]),
    readFirst(row, ["CYPHCODE", "cyphcode"]),
    readFirst(row, [
      "PRICEEXP",
      "PRICE_EXP",
      "PRICE_DESCRIPTION",
      "PRICE_DESC",
      "EXPLANATION",
      "EXPLAIN",
      "ACIKLAMA",
      "aciklama",
    ]),
    readFirst(row, ["DEFINITION_", "DEFINITION", "NAME"]),
  ]) {
    const normalized = normalizeString(value)?.toUpperCase() ?? "";
    const exactMatch = normalized.match(/^F(?:[1-9]|1[0-2])$/);
    if (exactMatch) {
      return exactMatch[0];
    }

    const embeddedMatch = normalized.match(/\bF(?:[1-9]|1[0-2])\b/);
    if (embeddedMatch) {
      return embeddedMatch[0];
    }

    if (["PRK", "PERAK", "PERAKENDE"].includes(normalized) || normalized.includes("PERAKENDE")) {
      return "PRK";
    }
  }

  return null;
}

function buildLogoGroupedPricePredicate(columns) {
  const candidateColumns = [
    "CLSPECODE",
    "CLSPECODE2",
    "CLSPECODE3",
    "CLSPECODE4",
    "CLSPECODE5",
    "GRPCODE",
    "GROUPCODE",
    "CLIENTCODE",
    "CYPHCODE",
    "PRICEEXP",
    "PRICE_EXP",
    "PRICE_DESCRIPTION",
    "PRICE_DESC",
    "EXPLANATION",
    "EXPLAIN",
    "ACIKLAMA",
    "DEFINITION_",
    "DEFINITION",
    "NAME",
  ]
    .map((name) => findColumn(columns, [name]))
    .filter((name, index, names) => Boolean(name) && names.indexOf(name) === index);

  if (candidateColumns.length === 0) {
    return null;
  }

  const fCodes = Array.from({ length: 12 }, (_, index) => `'F${index + 1}'`).join(", ");
  const exactCodes = `${fCodes}, 'PRK', 'PERAK', 'PERAKENDE'`;

  return candidateColumns
    .map((column) => {
      const normalized = `UPPER(LTRIM(RTRIM(CAST(${column} AS NVARCHAR(180)))))`;

      return `(${normalized} IN (${exactCodes}) OR ${normalized} LIKE 'F[0-9]%' OR ${normalized} LIKE '%PERAKENDE%')`;
    })
    .join(" OR ");
}

function logoCampaignPriceReason(row, priceGroupCode) {
  const normalizedPriceGroupCode = normalizeString(priceGroupCode)?.toUpperCase();
  const definition = normalizeString(readFirst(row, ["DEFINITION_", "DEFINITION", "NAME"]));
  const condition = normalizeString(readFirst(row, ["CONDITION", "condition", "COND", "cond"]));
  const formula = normalizeString(readFirst(row, ["FORMULA", "MATHFORMULA", "formula", "mathformula"]));
  const explicitDiscount = normalizeDecimal(readFirst(row, ["DISCPER", "DISCOUNT", "DISCRATE", "discount_rate"]));
  const explicitQuantity = normalizeInteger(readFirst(row, ["MIN_QUANTITY", "MINQTY", "CONDQTY", "MINAMOUNT", "MIN_QUANTITY_", "min_quantity"]));

  if (Boolean(condition) ||
    Boolean(formula) ||
    (explicitDiscount !== null && explicitDiscount > 0) ||
    (explicitQuantity !== null && explicitQuantity > 1) ||
    /\b(KAMPANYA(?:SI)?|PROMOSYON|ISKONTO|İSKONTO)\b/iu.test(definition ?? "")) {
    return "conditional_price";
  }

  if (normalizedPriceGroupCode === "F12") {
    return "batum_f12_price";
  }

  return null;
}

function buildLogoCampaignPrice(row, price, priceGroupCode, columns = {}) {
  const normalizedPriceGroupCode = normalizeString(priceGroupCode)?.toUpperCase();
  const condition =
    normalizeString(readFirst(row, ["CONDITION", "condition", "COND", "cond"])) ??
    normalizeString(readFirst(row, ["FORMULA", "MATHFORMULA", "formula", "mathformula"]));
  const sourceReference =
    normalizeString(readFirst(row, ["LOGICALREF", columns.logicalRefColumn])) ??
    [
      normalizeString(readFirst(row, ["CARDREF", "STOCKREF", "ITEMREF", "PRODUCTREF"])),
      normalizedPriceGroupCode ?? "ALL",
      price.list_price,
      condition ??
        normalizeString(readFirst(row, ["DEFINITION_", "DEFINITION", "NAME"])) ??
        "campaign",
    ]
      .filter(Boolean)
      .join(":");

  const name =
    normalizedPriceGroupCode === "F12"
      ? "Batum Size Ozel Fiyat"
      : normalizeString(readFirst(row, ["DEFINITION_", "DEFINITION", "NAME"])) ??
    `Logo ${normalizedPriceGroupCode ?? "Genel"} Kampanya Fiyati`;
  const minQuantity = resolveLogoCampaignMinQuantity(row, condition);
  const campaignKey = normalizeLogoCampaignKey(normalizedPriceGroupCode, sourceReference, name);

  return {
    source_reference: sourceReference,
    campaign_key: campaignKey,
    name,
    condition,
    min_quantity: minQuantity,
    unit_price: price.list_price,
    currency: normalizedPriceGroupCode === "F12" ? "GEL" : price.currency,
    priority: price.meta?.priority ?? 0,
    starts_at: normalizeDateOnly(readFirst(row, ["BEGDATE", columns.beginDateColumn])),
    ends_at: normalizeDateOnly(readFirst(row, ["ENDDATE", columns.endDateColumn])),
    is_active: true,
    meta: compactObject({
      ...price.meta,
      price_group: priceGroupCode,
      logo_price_group: priceGroupCode,
      source: "logo_prclist",
    }),
  };
}

function resolveLogoCampaignMinQuantity(row, condition) {
  const explicit = normalizeInteger(
    readFirst(row, ["MIN_QUANTITY", "MINQTY", "CONDQTY", "condqty", "MINAMOUNT", "MIN_QUANTITY_", "min_quantity"])
  );

  if (explicit && explicit > 0) {
    return explicit;
  }

  const raw = normalizeString(condition) ?? normalizeString(readFirst(row, ["DEFINITION_", "DEFINITION", "NAME"]));
  const comparison = raw?.match(/(?:p1|quantity|qty|adet|miktar)\s*(>=|>|=)\s*(\d+)/iu);
  if (comparison) {
    const value = Number.parseInt(comparison[2], 10);
    return comparison[1] === ">" ? value + 1 : Math.max(1, value);
  }

  const adetMatch = raw?.match(/\b(\d+)\s*(?:\+?\s*)?ADET\b/iu);
  if (adetMatch) {
    return Math.max(1, Number.parseInt(adetMatch[1], 10));
  }

  return 1;
}

function normalizeLogoCampaignKey(priceGroupCode, sourceReference, name) {
  const group = normalizeString(priceGroupCode)?.toLowerCase() ?? "all";
  const raw = normalizeString(name)?.toLowerCase() ?? "campaign";
  const slug = raw
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ı/g, "i")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `logo:price:${group}:${sourceReference}:${slug || "campaign"}`.slice(0, 191);
}

function normalizeDateOnly(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

async function fetchProductUnits(pool, productUnitSchema, unitSchema, unitSetSchema, logicalRefs) {
  if (!productUnitSchema || logicalRefs.length === 0) {
    return new Map();
  }

  const itemRefColumn = findColumn(productUnitSchema.columns, [
    "ITEMREF",
    "CARDREF",
    "STOCKREF",
    "PRODUCTREF",
  ]);
  const unitLineRefColumn = findColumn(productUnitSchema.columns, [
    "UNITLINEREF",
    "UNITREF",
    "UOMREF",
  ]);
  const unitSetRefColumn = findColumn(productUnitSchema.columns, ["UNITSETREF", "UNITSETLREF"]);
  const lineNoColumn = findColumn(productUnitSchema.columns, ["LINENR", "LINENO_", "LINENO"]);
  const mainUnitColumn = findColumn(productUnitSchema.columns, ["MAINUNIT", "MAIN_UNIT"]);
  const convFact1Column = findColumn(productUnitSchema.columns, ["CONVFACT1"]);
  const convFact2Column = findColumn(productUnitSchema.columns, ["CONVFACT2"]);
  const priorityColumn = findColumn(productUnitSchema.columns, ["PRIORITY"]);
  const barcodeColumn = findColumn(productUnitSchema.columns, ["BARCODE", "BARCODE1", "EAN13"]);

  if (!itemRefColumn) {
    console.warn(
      `[logo-sync] product unit table ${productUnitSchema.qualifiedName} is missing ITEMREF/CARDREF; unit sync will be skipped.`
    );
    return new Map();
  }

  const unitLogicalRefColumn = unitSchema ? findColumn(unitSchema.columns, ["LOGICALREF"]) : null;
  const unitCodeColumn = unitSchema ? findColumn(unitSchema.columns, ["CODE", "UNITCODE"]) : null;
  const unitNameColumn = unitSchema ? findColumn(unitSchema.columns, ["NAME", "UNITNAME"]) : null;
  const unitLineNoColumn = unitSchema ? findColumn(unitSchema.columns, ["LINENR", "LINENO_", "LINENO"]) : null;
  const unitSetColumnOnUnit = unitSchema ? findColumn(unitSchema.columns, ["UNITSETREF"]) : null;
  const unitSetLogicalRefColumn = unitSetSchema ? findColumn(unitSetSchema.columns, ["LOGICALREF"]) : null;
  const unitSetCodeColumn = unitSetSchema ? findColumn(unitSetSchema.columns, ["CODE"]) : null;
  const unitSetNameColumn = unitSetSchema ? findColumn(unitSetSchema.columns, ["NAME"]) : null;
  const canJoinUnitSet = Boolean(unitSetSchema && unitSetLogicalRefColumn && (unitSetRefColumn || unitSetColumnOnUnit));

  const refsSql = logicalRefs.join(", ");
  const selectColumns = [`pu.${itemRefColumn} AS product_ref`];

  if (unitLineRefColumn) selectColumns.push(`pu.${unitLineRefColumn} AS uom_ref`);
  if (unitSetRefColumn) selectColumns.push(`pu.${unitSetRefColumn} AS unitset_ref`);
  if (lineNoColumn) selectColumns.push(`pu.${lineNoColumn} AS line_no`);
  if (mainUnitColumn) selectColumns.push(`pu.${mainUnitColumn} AS main_unit`);
  if (convFact1Column) selectColumns.push(`pu.${convFact1Column} AS convfact1`);
  if (convFact2Column) selectColumns.push(`pu.${convFact2Column} AS convfact2`);
  if (priorityColumn) selectColumns.push(`pu.${priorityColumn} AS priority`);
  if (barcodeColumn) selectColumns.push(`pu.${barcodeColumn} AS barcode`);
  if (unitCodeColumn) selectColumns.push(`u.${unitCodeColumn} AS unit_code`);
  if (unitNameColumn) selectColumns.push(`u.${unitNameColumn} AS unit_name`);
  if (unitLineNoColumn) selectColumns.push(`u.${unitLineNoColumn} AS unit_line_no`);
  if (unitSetColumnOnUnit) selectColumns.push(`u.${unitSetColumnOnUnit} AS unit_unitset_ref`);
  if (canJoinUnitSet && unitSetCodeColumn) selectColumns.push(`us.${unitSetCodeColumn} AS unitset_code`);
  if (canJoinUnitSet && unitSetNameColumn) selectColumns.push(`us.${unitSetNameColumn} AS unitset_name`);

  const joins = [];
  if (unitSchema && unitLogicalRefColumn && unitLineRefColumn) {
    joins.push(`
      LEFT JOIN ${unitSchema.qualifiedName} u
        ON u.${unitLogicalRefColumn} = pu.${unitLineRefColumn}
    `);
  }
  if (canJoinUnitSet) {
    const unitSetRefExpression = unitSetRefColumn
      ? `pu.${unitSetRefColumn}`
      : `u.${unitSetColumnOnUnit}`;
    joins.push(`
      LEFT JOIN ${unitSetSchema.qualifiedName} us
        ON us.${unitSetLogicalRefColumn} = ${unitSetRefExpression}
    `);
  }

  const orderBy = [`pu.${itemRefColumn} ASC`];
  if (mainUnitColumn) orderBy.push(`pu.${mainUnitColumn} DESC`);
  if (lineNoColumn) orderBy.push(`pu.${lineNoColumn} ASC`);
  if (priorityColumn) orderBy.push(`pu.${priorityColumn} ASC`);

  const result = await pool.request().query(`
    SELECT
      ${selectColumns.join(",\n      ")}
    FROM ${productUnitSchema.qualifiedName} pu
    ${joins.join("\n")}
    WHERE pu.${itemRefColumn} IN (${refsSql})
    ORDER BY ${orderBy.join(", ")}
  `);

  const rowsByRef = new Map();

  for (const row of result.recordset ?? []) {
    const productRef = normalizeString(row.product_ref);
    if (!productRef) {
      continue;
    }

    const unit = compactObject({
      uom_ref: normalizeString(row.uom_ref),
      unitset_ref: normalizeString(row.unitset_ref) ?? normalizeString(row.unit_unitset_ref),
      unitset_code: normalizeString(row.unitset_code),
      unitset_name: normalizeString(row.unitset_name),
      code: normalizeString(row.unit_code),
      name: normalizeString(row.unit_name),
      line_no: normalizeInteger(row.line_no) ?? normalizeInteger(row.unit_line_no),
      main_unit: normalizeInteger(row.main_unit),
      convfact1: normalizeDecimal(row.convfact1),
      convfact2: normalizeDecimal(row.convfact2),
      priority: normalizeInteger(row.priority),
      barcode: normalizeString(row.barcode),
    });

    const existing = rowsByRef.get(productRef) ?? [];
    existing.push(unit);
    rowsByRef.set(productRef, existing);
  }

  const unitsByRef = new Map();
  for (const [productRef, units] of rowsByRef.entries()) {
    const primary =
      units.find((unit) => Number(unit.main_unit ?? 0) === 1) ??
      units.find((unit) => Number(unit.line_no ?? 0) === 1) ??
      units[0] ??
      null;

    unitsByRef.set(productRef, {
      primary_unit_code: normalizeString(primary?.code),
      primary_unit_name: normalizeString(primary?.name),
      uom_ref: normalizeString(primary?.uom_ref),
      unitset_ref: normalizeString(primary?.unitset_ref),
      unitset_code: normalizeString(primary?.unitset_code),
      unitset_name: normalizeString(primary?.unitset_name),
      units,
    });
  }

  return unitsByRef;
}

async function fetchProductImages(pool, currentConfig, schema, productRows, productSchema, logicalRefs) {
  if (!schema || logicalRefs.length === 0) {
    return new Map();
  }

  const resolvedColumns = resolveProductImageColumns(currentConfig, schema);
  if (!resolvedColumns.referenceColumn) {
    console.warn(
      `[logo-sync] product image table ${schema.qualifiedName} is missing a supported reference column.`
    );
    return new Map();
  }

  if (!resolvedColumns.dataColumn && !resolvedColumns.pathColumn) {
    console.warn(
      `[logo-sync] product image table ${schema.qualifiedName} is missing a supported image payload or path column.`
    );
    return new Map();
  }

  const refsSql = logicalRefs.join(", ");
  const selectColumns = [`${resolvedColumns.referenceColumn} AS product_ref`];

  if (resolvedColumns.dataColumn) {
    selectColumns.push(`${resolvedColumns.dataColumn} AS image_blob`);
  }

  if (resolvedColumns.pathColumn) {
    selectColumns.push(`${resolvedColumns.pathColumn} AS image_path`);
  }

  if (resolvedColumns.orderColumn) {
    selectColumns.push(`${resolvedColumns.orderColumn} AS image_order`);
  }

  if (schema.columnSet.has("LOGICALREF")) {
    selectColumns.push("LOGICALREF AS image_logicalref");
  }

  const orderBy = [`${resolvedColumns.referenceColumn} ASC`];
  appendUniqueOrderBy(orderBy, resolvedColumns.orderColumn, "DESC");
  if (schema.columnSet.has("LOGICALREF")) {
    appendUniqueOrderBy(orderBy, "LOGICALREF", "DESC");
  }

  const query = `
    SELECT
      ${selectColumns.join(",\n      ")}
    FROM ${schema.qualifiedName}
    WHERE ${resolvedColumns.referenceColumn} IN (${refsSql})
    ORDER BY ${orderBy.join(", ")}
  `;

  const result = await pool.request().query(query);
  const snapshot = new Map();
  const skuByRef = new Map(
    productRows
      .map((row) => [
        normalizeString(readFirst(row, ["external_ref", "LOGICALREF"])),
        normalizeString(readFirst(row, ["sku", "code", "CODE"])),
      ])
      .filter(([productRef]) => productRef)
  );

  for (const row of result.recordset ?? []) {
    const productRef = normalizeString(row.product_ref);
    if (!productRef || snapshot.has(productRef)) {
      continue;
    }

    const resolvedImage = await resolveImagePayloadValue(
      row.image_blob,
      row.image_path,
      currentConfig.logo.productImageRoot,
      currentConfig.logo.productImageBaseUrl,
      currentConfig
    );

    if (!resolvedImage) {
      continue;
    }

    if (resolvedImage.reason) {
      const sku = skuByRef.get(productRef) ?? null;
      currentConfig.sync.imageStats.optimized_failed += 1;
      currentConfig.sync.imageSkippedRefs.add(productRef);
      appendImageFailed(currentConfig, {
        product_ref: productRef,
        sku,
        original_bytes: resolvedImage.originalBytes ?? null,
        optimized_bytes: resolvedImage.optimizedBytes ?? null,
        reason: resolvedImage.reason,
        table: schema.qualifiedName,
        ref_column: resolvedColumns.referenceColumn,
        data_column: resolvedColumns.dataColumn ?? null,
      });
      console.warn(
        `[logo-sync] product image optimize failed product_ref=${productRef} sku=${sku ?? ""} original_bytes=${resolvedImage.originalBytes ?? "unknown"} optimized_bytes=${resolvedImage.optimizedBytes ?? "unknown"} reason=${resolvedImage.reason}`
      );
      continue;
    }

    currentConfig.sync.imageStats.images_found += 1;
    currentConfig.sync.imageStats.total_original_bytes += resolvedImage.originalBytes ?? 0;
    currentConfig.sync.imageStats.total_sent_bytes += resolvedImage.sentBytes ?? 0;
    if (resolvedImage.optimized) {
      currentConfig.sync.imageStats.optimized_sent += 1;
    } else {
      currentConfig.sync.imageStats.originals_sent += 1;
    }
    snapshot.set(productRef, {
      rawKey: resolvedImage.source === "url" ? "IMAGE_URL" : resolvedImage.source === "path" ? "IMAGE_PATH" : "IMAGE",
      value: resolvedImage.value,
    });
  }

  await fetchProductImagesByCode(
    pool,
    currentConfig,
    schema,
    productRows,
    productSchema,
    resolvedColumns,
    snapshot
  );

  return snapshot;
}

async function fetchProductImagesByCode(
  pool,
  currentConfig,
  imageSchema,
  productRows,
  productSchema,
  resolvedColumns,
  snapshot
) {
  if (!resolvedColumns.referenceColumn || (!resolvedColumns.dataColumn && !resolvedColumns.pathColumn)) {
    return;
  }

  const imageProductTableName = deriveImageProductTableName(imageSchema);
  if (!imageProductTableName) {
    return;
  }

  const imageProductSchema = await inspectTable(pool, imageProductTableName, "product image source item", false);
  if (!imageProductSchema) {
    return;
  }

  const sourceCodeColumn = findColumn(imageProductSchema.columns, ["CODE", "CODE_"]);
  const sourceRefColumn = findColumn(imageProductSchema.columns, ["LOGICALREF"]);
  const currentCodeColumn = findColumn(productSchema.columns, ["CODE", "CODE_", "sku"]);

  if (!sourceCodeColumn || !sourceRefColumn || !currentCodeColumn) {
    return;
  }

  const productRefByCode = new Map();
  const exactCodes = [];

  for (const row of productRows) {
    const currentRef = normalizeString(readFirst(row, ["LOGICALREF", "logicalref", "external_ref"]));
    const code = normalizeString(readFirst(row, [currentCodeColumn, "CODE", "code", "sku"]));
    const normalizedCode = normalizeCodeValue(code);

    if (!currentRef || !code || !normalizedCode || snapshot.has(currentRef)) {
      continue;
    }

    productRefByCode.set(normalizedCode, currentRef);
    exactCodes.push(code);
  }

  if (exactCodes.length === 0) {
    return;
  }

  const request = pool.request();
  const codeParams = [];
  uniqueColumns(exactCodes).forEach((code, index) => {
    const param = `code_${index}`;
    request.input(param, sql.NVarChar(128), code);
    codeParams.push(`@${param}`);
  });

  const selectColumns = [
    `i.${sourceCodeColumn} AS product_code`,
    `d.${resolvedColumns.referenceColumn} AS product_ref`,
  ];

  if (resolvedColumns.dataColumn) {
    selectColumns.push(`d.${resolvedColumns.dataColumn} AS image_blob`);
  }

  if (resolvedColumns.pathColumn) {
    selectColumns.push(`d.${resolvedColumns.pathColumn} AS image_path`);
  }

  if (resolvedColumns.orderColumn) {
    selectColumns.push(`d.${resolvedColumns.orderColumn} AS image_order`);
  }

  if (imageSchema.columnSet.has("LOGICALREF")) {
    selectColumns.push("d.LOGICALREF AS image_logicalref");
  }

  const orderBy = [`i.${sourceCodeColumn} ASC`];
  if (resolvedColumns.orderColumn) {
    appendUniqueOrderBy(orderBy, `d.${resolvedColumns.orderColumn}`, "DESC");
  }
  if (imageSchema.columnSet.has("LOGICALREF")) {
    appendUniqueOrderBy(orderBy, "d.LOGICALREF", "DESC");
  }

  const query = `
    SELECT
      ${selectColumns.join(",\n      ")}
    FROM ${imageSchema.qualifiedName} d
    INNER JOIN ${imageProductSchema.qualifiedName} i
      ON i.${sourceRefColumn} = d.${resolvedColumns.referenceColumn}
    WHERE i.${sourceCodeColumn} IN (${codeParams.join(", ")})
    ORDER BY ${orderBy.join(", ")}
  `;

  const result = await request.query(query);

  for (const row of result.recordset ?? []) {
    const normalizedCode = normalizeCodeValue(row.product_code);
    const currentRef = normalizedCode ? productRefByCode.get(normalizedCode) : null;

    if (!currentRef || snapshot.has(currentRef)) {
      continue;
    }

    const resolvedImage = await resolveImagePayloadValue(
      row.image_blob,
      row.image_path,
      currentConfig.logo.productImageRoot,
      currentConfig.logo.productImageBaseUrl,
      currentConfig
    );

    if (!resolvedImage) {
      continue;
    }

    if (resolvedImage.reason) {
      currentConfig.sync.imageStats.optimized_failed += 1;
      currentConfig.sync.imageSkippedRefs.add(currentRef);
      appendImageFailed(currentConfig, {
        product_ref: currentRef,
        sku: normalizeString(row.product_code),
        original_bytes: resolvedImage.originalBytes ?? null,
        optimized_bytes: resolvedImage.optimizedBytes ?? null,
        reason: resolvedImage.reason,
        table: imageSchema.qualifiedName,
        ref_column: resolvedColumns.referenceColumn,
        data_column: resolvedColumns.dataColumn ?? null,
      });
      console.warn(
        `[logo-sync] product image optimize failed product_ref=${currentRef} sku=${normalizeString(row.product_code) ?? ""} original_bytes=${resolvedImage.originalBytes ?? "unknown"} optimized_bytes=${resolvedImage.optimizedBytes ?? "unknown"} reason=${resolvedImage.reason}`
      );
      continue;
    }

    currentConfig.sync.imageStats.images_found += 1;
    currentConfig.sync.imageStats.total_original_bytes += resolvedImage.originalBytes ?? 0;
    currentConfig.sync.imageStats.total_sent_bytes += resolvedImage.sentBytes ?? 0;
    if (resolvedImage.optimized) {
      currentConfig.sync.imageStats.optimized_sent += 1;
    } else {
      currentConfig.sync.imageStats.originals_sent += 1;
    }
    snapshot.set(currentRef, {
      rawKey: resolvedImage.source === "url" ? "IMAGE_URL" : resolvedImage.source === "path" ? "IMAGE_PATH" : "IMAGE",
      value: resolvedImage.value,
    });
  }
}

async function fetchCodeAliases(pool, sources, logicalRefs) {
  if (logicalRefs.length === 0) {
    return new Map();
  }

  const aliasesByRef = new Map();

  for (const source of sources) {
    if (!source.schema) {
      continue;
    }

    const referenceColumn = findAliasReferenceColumn(source.schema.columns);
    const codeColumns = collectAliasCodeColumns(source.schema.columns, source.type);
    const brandNameColumn = findColumn(source.schema.columns, [
      "BRANDNAME",
      "BRAND",
      "MARKA",
      "MARK",
      "FIRMANAME",
      "MANUFACTURER",
      "MANUFACTURERNAME",
    ]);

    if (!referenceColumn || codeColumns.length === 0) {
      console.warn(
        `[logo-sync] ${source.tableName} is missing a supported reference or code column; ${source.type} sync will be skipped.`
      );
      continue;
    }

    const refsSql = logicalRefs.join(", ");
    const selectColumns = [
      `${referenceColumn} AS product_ref`,
      ...codeColumns.map((column, index) => `${column} AS code_${index}`),
    ];

    if (brandNameColumn) {
      selectColumns.push(`${brandNameColumn} AS brand_name`);
    }

    const result = await pool.request().query(`
      SELECT
        ${selectColumns.join(",\n        ")}
      FROM ${source.schema.qualifiedName}
      WHERE ${referenceColumn} IN (${refsSql})
    `);

    for (const row of result.recordset ?? []) {
      const productRef = normalizeString(row.product_ref);
      if (!productRef) {
        continue;
      }

      const rawCodes = codeColumns.flatMap((_, index) => splitAliasCodes(readFirst(row, [`code_${index}`])));

      if (rawCodes.length === 0) {
        continue;
      }

      const existing = aliasesByRef.get(productRef) ?? [];

      for (const code of rawCodes) {
        const normalizedCode = normalizeCodeValue(code);
        if (!normalizedCode) {
          continue;
        }

        const aliasKey = `${source.type}:${normalizedCode}`;
        if (existing.some((alias) => alias.key === aliasKey)) {
          continue;
        }

        existing.push({
          key: aliasKey,
          code,
          type: source.type,
          brand_name: normalizeString(row.brand_name),
        });
      }

      aliasesByRef.set(productRef, existing);
    }
  }

  for (const [productRef, aliases] of aliasesByRef.entries()) {
    aliasesByRef.set(
      productRef,
      aliases.map(({ key, ...alias }) => alias)
    );
  }

  return aliasesByRef;
}

async function fetchProductSubstitutes(pool, schema, productSchema, productTable, logicalRefs) {
  if (!schema || logicalRefs.length === 0) {
    return new Map();
  }

  const mainItemColumn = findColumn(schema.columns, ["MAINITEMREF", "MAINCREF", "CARDREF", "ITEMREF"]);
  const substituteItemColumn = findColumn(schema.columns, ["SUBITEMREF", "SUBSTITEMREF", "ITEMREF2", "ALTITEMREF"]);
  const lineNoColumn = findColumn(schema.columns, ["LINENO_", "LINENO", "LINE_NO"]);
  const priorityColumn = findColumn(schema.columns, ["PRIORITY"]);
  const convFact1Column = findColumn(schema.columns, ["CONVFACT1"]);
  const convFact2Column = findColumn(schema.columns, ["CONVFACT2"]);
  const minQuantityColumn = findColumn(schema.columns, ["MINQUANTITY", "MINQTY"]);
  const maxQuantityColumn = findColumn(schema.columns, ["MAXQUANTITY", "MAXQTY"]);
  const beginDateColumn = findColumn(schema.columns, ["BEGDATE", "BEGIN_DATE", "STARTDATE"]);
  const endDateColumn = findColumn(schema.columns, ["ENDDATE", "END_DATE", "STOPDATE"]);
  const productRefColumn = findColumn(productSchema.columns, ["LOGICALREF"]);
  const productCodeColumn = findColumn(productSchema.columns, ["CODE", "sku"]);
  const productNameColumn = findColumn(productSchema.columns, [
    "NAME3",
    "NAME2",
    "DEFINITION3",
    "DEFINITION3_",
    "DEFINITION2",
    "DEFINITION2_",
    "DESCRIPTION3",
    "DESCRIPTION2",
    "NAME",
    "DEFINITION_",
    "DEFINITION",
  ]);

  if (!mainItemColumn || !substituteItemColumn) {
    console.warn(
      `[logo-sync] substitute table ${schema.qualifiedName} is missing MAINITEMREF/SUBITEMREF columns; substitute sync will be skipped.`
    );
    return new Map();
  }

  const refsSql = logicalRefs.join(", ");
  const selectColumns = [
    `s.${mainItemColumn} AS product_ref`,
    `s.${substituteItemColumn} AS substitute_ref`,
  ];

  if (lineNoColumn) selectColumns.push(`s.${lineNoColumn} AS line_no`);
  if (priorityColumn) selectColumns.push(`s.${priorityColumn} AS priority`);
  if (convFact1Column) selectColumns.push(`s.${convFact1Column} AS convfact1`);
  if (convFact2Column) selectColumns.push(`s.${convFact2Column} AS convfact2`);
  if (minQuantityColumn) selectColumns.push(`s.${minQuantityColumn} AS min_quantity`);
  if (maxQuantityColumn) selectColumns.push(`s.${maxQuantityColumn} AS max_quantity`);
  if (beginDateColumn) selectColumns.push(`s.${beginDateColumn} AS begdate`);
  if (endDateColumn) selectColumns.push(`s.${endDateColumn} AS enddate`);
  if (productRefColumn && productCodeColumn) selectColumns.push(`sub.${productCodeColumn} AS substitute_code`);
  if (productRefColumn && productNameColumn) selectColumns.push(`sub.${productNameColumn} AS substitute_name`);

  const joins = [];
  if (productRefColumn) {
    joins.push(`
      LEFT JOIN ${productTable} sub
        ON sub.${productRefColumn} = s.${substituteItemColumn}
    `);
  }

  let query = `
    SELECT
      ${selectColumns.join(",\n      ")}
    FROM ${schema.qualifiedName} s
    ${joins.join("\n")}
    WHERE s.${mainItemColumn} IN (${refsSql})
  `;

  if (beginDateColumn) {
    query += ` AND (s.${beginDateColumn} IS NULL OR s.${beginDateColumn} <= GETDATE())`;
  }

  if (endDateColumn) {
    query += ` AND (s.${endDateColumn} IS NULL OR s.${endDateColumn} >= CAST(GETDATE() AS date))`;
  }

  const orderBy = [`s.${mainItemColumn} ASC`];
  if (priorityColumn) orderBy.push(`s.${priorityColumn} ASC`);
  if (lineNoColumn) orderBy.push(`s.${lineNoColumn} ASC`);
  query += ` ORDER BY ${orderBy.join(", ")}`;

  const result = await pool.request().query(query);
  const aliasesByRef = new Map();

  for (const row of result.recordset ?? []) {
    const productRef = normalizeString(row.product_ref);
    const substituteRef = normalizeString(row.substitute_ref);
    const code = normalizeString(row.substitute_code) ?? substituteRef;

    if (!productRef || !code) {
      continue;
    }

    const existing = aliasesByRef.get(productRef) ?? [];
    const aliasKey = `equivalent:${normalizeCodeValue(code)}`;
    if (existing.some((alias) => alias.key === aliasKey)) {
      continue;
    }

    existing.push({
      key: aliasKey,
      code,
      type: "equivalent",
      brand_name: null,
      meta: compactObject({
        source: "logo_itemsubs",
        table: schema.qualifiedName,
        substitute_ref: substituteRef,
        substitute_name: normalizeString(row.substitute_name),
        line_no: normalizeInteger(row.line_no),
        priority: normalizeInteger(row.priority),
        convfact1: normalizeDecimal(row.convfact1),
        convfact2: normalizeDecimal(row.convfact2),
        min_quantity: normalizeDecimal(row.min_quantity),
        max_quantity: normalizeDecimal(row.max_quantity),
        begdate: row.begdate ?? null,
        enddate: row.enddate ?? null,
      }),
    });

    aliasesByRef.set(productRef, existing);
  }

  for (const [productRef, aliases] of aliasesByRef.entries()) {
    aliasesByRef.set(
      productRef,
      aliases.map(({ key, ...alias }) => alias)
    );
  }

  return aliasesByRef;
}

async function fetchProductRafAddresses(pool, schema, logicalRefs) {
  if (!schema || logicalRefs.length === 0) {
    return new Map();
  }

  const referenceColumn = findColumn(schema.columns, [
    "PARLOGREF",
    "PARENTREF",
    "PARENT_LOGICALREF",
    "ITEMREF",
    "CARDREF",
    "STOCKREF",
    "PRODUCTREF",
    "INFOREF",
    "LOGREF",
    "LOGICALREF",
  ]);

  if (!referenceColumn) {
    console.warn(
      `[logo-sync] product raf table ${schema.qualifiedName} has no supported product reference column; raf sync will be skipped.`
    );
    return new Map();
  }

  const warehouseColumn = findColumn(schema.columns, [
    "INVENNO",
    "WAREHOUSE_NO",
    "WAREHOUSE_NR",
    "WAREHOUSE",
    "WHOUSE",
    "WHOUSE_NR",
    "WHNO",
    "AMBARNO",
    "AMBAR_NO",
    "AMBAR_NR",
    "DEPO_NO",
    "DEPO_NR",
    "DEPOKODU",
    "DEPONO",
    "INVNR",
    "INVENNR",
  ]);
  const shelfColumn = findColumn(schema.columns, [
    "RAF",
    "RAF_ADRESI",
    "RAFADRESI",
    "RAF_KODU",
    "RAFKODU",
    "RAF_BILGISI",
    "RAFBILGISI",
    "RAF_BILGILERI",
    "RAFBILGILERI",
    "SHELF",
    "SHELF_ADDRESS",
    "LOCATION",
    "LOCATION_CODE",
    "ADDRESS",
    "ADRES",
  ]);

  const refsSql = logicalRefs.join(", ");
  const result = await pool.request().query(`
    SELECT *
    FROM ${schema.qualifiedName}
    WHERE ${referenceColumn} IN (${refsSql})
  `);

  const rafByRef = new Map();

  for (const row of result.recordset ?? []) {
    const productRef = normalizeString(row[referenceColumn]);
    if (!productRef) {
      continue;
    }

    const rafRecord = rafByRef.get(productRef) ?? {};
    for (const column of schema.columns) {
      const value = row[column];
      if (value === null || value === undefined) {
        continue;
      }

      rafRecord[column] = value;
    }

    const warehouseCode = warehouseColumn ? normalizeString(row[warehouseColumn]) : null;
    const shelfAddress = shelfColumn ? normalizeString(row[shelfColumn]) : null;
    if (shelfAddress) {
      if (warehouseCode) {
        assignWarehouseShelfRawFields(rafRecord, warehouseCode, shelfAddress);
      } else {
        rafRecord.RAF = rafRecord.RAF ?? shelfAddress;
        rafRecord.RAF_ADRESI = rafRecord.RAF_ADRESI ?? shelfAddress;
        rafRecord.RAF_BILGILERI = rafRecord.RAF_BILGILERI ?? shelfAddress;
      }
    }

    rafByRef.set(productRef, rafRecord);
  }

  return rafByRef;
}

function assignWarehouseShelfRawFields(record, warehouseCode, shelfAddress) {
  const key = normalizeString(warehouseCode);
  const value = normalizeString(shelfAddress);
  if (!key || !value) {
    return;
  }

  for (const field of [
    `RAF${key}`,
    `raf${key}`,
    `RAF_${key}`,
    `raf_${key}`,
    `RAFADRESI${key}`,
    `rafadresi${key}`,
    `RAF_ADRESI_${key}`,
    `raf_adresi_${key}`,
    `RAF_BILGILERI_${key}`,
    `raf_bilgileri_${key}`,
    `SHELF_ADDRESS${key}`,
    `shelf_address${key}`,
    `LOCATION${key}`,
    `location${key}`,
  ]) {
    record[field] = record[field] ?? value;
  }
}

function mergeAliasMaps(target, source) {
  for (const [productRef, aliases] of source.entries()) {
    const existing = target.get(productRef) ?? [];
    const seen = new Set(
      existing
        .map((alias) => `${alias.type ?? "other"}:${normalizeCodeValue(alias.code)}`)
        .filter(Boolean)
    );

    for (const alias of aliases) {
      const normalizedCode = normalizeCodeValue(alias.code);
      if (!normalizedCode) {
        continue;
      }

      const key = `${alias.type ?? "other"}:${normalizedCode}`;
      if (seen.has(key)) {
        continue;
      }

      existing.push(alias);
      seen.add(key);
    }

    target.set(productRef, existing);
  }
}

const PRODUCT_NAME2_ALIASES = [
  "name3",
  "NAME3",
  "NAME_3",
  "name2",
  "NAME2",
  "NAME_2",
  "DEFINITION3",
  "DEFINITION3_",
  "DEFINITION_3",
  "DEFINITION_3_",
  "DEFINITION2",
  "DEFINITION2_",
  "DEFINITION_2",
  "DEFINITION_2_",
  "description3",
  "DESCRIPTION3",
  "DESCRIPTION_3",
  "description2",
  "DESCRIPTION2",
  "DESCRIPTION_2",
  "DESC3",
  "DESC2",
];

const PRODUCT_NAME_ALIASES = ["name", "NAME", "DEFINITION_", "DEFINITION"];

const PRODUCT_NAME3_ALIASES = [
  "PRODUCERCODE",
  "PRODUCER_CODE",
  "OEMCODE",
];

function resolveProductDisplayName(row, sku, externalRef) {
  return (
    normalizeString(readFirst(row, PRODUCT_NAME2_ALIASES)) ??
    normalizeString(readFirst(row, PRODUCT_NAME_ALIASES)) ??
    normalizeString(readFirst(row, PRODUCT_NAME3_ALIASES)) ??
    sku ??
    externalRef
  );
}

function extractInlineCompetitorAliases(row) {
  const aliases = [];

  for (const key of sortAliasColumns(Object.keys(row))) {
    if (!/^RKP\d+$/i.test(key) && !/^RAKIP\d+$/i.test(key) && !/^COMPETITOR\d+$/i.test(key)) {
      continue;
    }

    for (const code of splitAliasCodes(row[key])) {
      aliases.push({
        code,
        type: "competitor",
        brand_name: null,
        meta: {
          source_column: key,
        },
      });
    }
  }

  return aliases;
}

function extractInlineOemAliases(row) {
  const aliases = [];

  for (const key of sortAliasColumns(Object.keys(row))) {
    if (!/^OEM\d+$/i.test(key)) {
      continue;
    }

    for (const code of splitAliasCodes(row[key])) {
      aliases.push({
        code,
        type: "oem",
        brand_name: null,
        meta: {
          source_column: key,
        },
      });
    }
  }

  return aliases;
}

function splitAliasCodes(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(/[,;\r\n]+/)
    .map((code) => normalizeString(code))
    .filter(Boolean);
}

function mergeProductCodeAliases(...groups) {
  const aliases = [];
  const seen = new Set();

  for (const group of groups) {
    for (const alias of group ?? []) {
      const normalizedCode = normalizeCodeValue(alias.code);
      if (!normalizedCode) {
        continue;
      }

      const type = alias.type ?? "other";
      const key = `${type}:${normalizedCode}`;
      if (seen.has(key)) {
        continue;
      }

      aliases.push(alias);
      seen.add(key);

      if (aliases.length >= 1000) {
        return aliases;
      }
    }
  }

  return aliases;
}

function mapStockOnlyProductRow(row, schema, stockByRef, currentConfig = config) {
  const externalRef = normalizeString(readFirst(row, ["external_ref", "LOGICALREF"]));
  const sku = normalizeString(readFirst(row, ["sku", "code", "CODE"]));

  if (!externalRef && !sku) {
    return null;
  }

  const rawRecord = extractRawLogoRecord(row, schema.columns);
  const stock = externalRef ? stockByRef.get(externalRef) ?? null : null;

  if (currentConfig.sync.stockRequireSummaryRow && !stock) {
    return null;
  }

  const rawStockAvailable = normalizeInteger(
    readFirst(row, ["available_total", "AVAILABLE_TOTAL", "ONHAND"])
  );
  const rawStockReserved = normalizeInteger(
    readFirst(row, ["reserved_total", "RESERVED_TOTAL", "RESERVED"])
  );
  const stockReserved = stock?.reserved_total ?? rawStockReserved ?? 0;
  const stockAvailable =
    stock?.available_total ??
    (rawStockAvailable !== null ? rawStockAvailable - Math.max(0, rawStockReserved ?? 0) : null);

  // A missing warehouse-total row is not proof of zero stock. Skipping it prevents
  // a wrong/empty Logo table selection from wiping every PowerSA stock value.
  if (stockAvailable === null && !stock) {
    return null;
  }

  const logoStock = stock
    ? {
        available_total: stock.available_total,
        reserved_total: stock.reserved_total,
        authoritative: stock.authoritative === true,
        source_kind: stock.source_kind ?? null,
        source_table: stock.source_table ?? null,
        warehouses: stock.warehouses ?? [],
      }
    : {
        available_total: stockAvailable,
        reserved_total: Math.max(0, stockReserved),
        authoritative: false,
        warehouses: [],
      };

  return {
    external_ref: externalRef,
    sku,
    available_total: stockAvailable ?? 0,
    reserved_total: Math.max(0, stockReserved),
    meta: {
      logo_stock: {
        ...logoStock,
        warehouses: (logoStock.warehouses ?? []).map((warehouse) => ({
          ...warehouse,
          shelf_address: resolveWarehouseShelfAddress(rawRecord, warehouse),
        })),
      },
    },
  };
}

function mapProductRow(
  row,
  productTable,
  schema,
  stockByRef,
  priceByRef,
  unitsByRef,
  productImagesByRef,
  productRafByRef,
  codeAliasesByRef,
  imageMap,
  imageFileIndex,
  rafMap
) {
  const externalRef = normalizeString(readFirst(row, ["external_ref", "LOGICALREF"]));
  const sku = normalizeString(readFirst(row, ["sku", "code", "CODE"]));
  const logoName = normalizeString(readFirst(row, PRODUCT_NAME_ALIASES));
  const logoName2 = normalizeString(readFirst(row, PRODUCT_NAME2_ALIASES));
  const logoName3 = normalizeString(readFirst(row, PRODUCT_NAME3_ALIASES));
  const name = resolveProductDisplayName(row, sku, externalRef);

  if (!sku || !name) {
    console.warn(
      `[logo-sync] skipping product row without sku or name${externalRef ? ` logicalref=${externalRef}` : ""}`
    );
    return null;
  }

  const rawRecord = extractRawLogoRecord(row, schema.columns);
  const rafRecord = externalRef ? productRafByRef.get(externalRef) ?? null : null;
  if (rafRecord) {
    Object.assign(rawRecord, rafRecord);
  }
  const mappedRafRecord = resolveProductRafFromMap(sku, rafMap);
  if (mappedRafRecord) {
    Object.assign(rawRecord, mappedRafRecord);
  }

  const stock = externalRef ? stockByRef.get(externalRef) ?? null : null;
  const priceSnapshot = externalRef ? priceByRef.get(externalRef) ?? null : null;
  const price = priceSnapshot?.primary ?? priceSnapshot;
  const unitInfo = externalRef ? unitsByRef.get(externalRef) ?? null : null;
  const productImage =
    (externalRef ? productImagesByRef.get(externalRef) ?? null : null) ??
    resolveProductImageFromMap(sku, imageMap) ??
    resolveProductImageFromFileIndex(sku, imageFileIndex);

  if (config.sync.imagesOnly) {
    if (!productImage?.value) {
      return null;
    }

    return {
      external_ref: externalRef,
      sku,
      meta: {
        raw: {
          [productImage.rawKey]: productImage.value,
        },
      },
    };
  }

  const codeAliases = mergeProductCodeAliases(
    externalRef ? codeAliasesByRef.get(externalRef) ?? [] : [],
    extractInlineOemAliases(row),
    extractInlineCompetitorAliases(row)
  );
  const primaryOemCode = codeAliases.find((alias) => alias.type === "oem")?.code ?? null;

  if (productImage?.value) {
    rawRecord[productImage.rawKey] = productImage.value;
  }

  const meta = {
    logo_table: productTable,
    brand_code: normalizeString(readFirst(row, ["brand_code", "BRANDCODE", "MARKCODE"])),
    category_code: normalizeString(
      readFirst(row, ["category_code", "CATEGORYCODE", "CATCODE", "STGRPCODE", "GRPCODE"])
    ),
    kod1: normalizeString(readFirst(row, ["kod1", "KOD1", "SPECODE"])),
    kod2: normalizeString(readFirst(row, ["kod2", "KOD2", "SPECODE2"])),
    kod3: normalizeString(readFirst(row, ["kod3", "KOD3", "SPECODE3"])),
    stok_turu:
      normalizeString(readFirst(row, ["stok_turu", "STOK_TURU", "STOKTURU"])) ??
      normalizeString(readFirst(row, ["CARDTYPE"])),
    unitset_ref: normalizeString(readFirst(row, ["unitset_ref", "UNITSETREF"])),
    classtype: normalizeInteger(readFirst(row, ["classtype", "CLASSTYPE"])),
    purchbrws: normalizeInteger(readFirst(row, ["purchbrws", "PURCHBRWS"])),
    salesbrws: normalizeInteger(readFirst(row, ["salesbrws", "SALESBRWS"])),
    mtrlbrws: normalizeInteger(readFirst(row, ["mtrlbrws", "MTRLBRWS"])),
    payment_ref: normalizeString(readFirst(row, ["payment_ref", "PAYMENTREF"])),
    tracktype: normalizeInteger(readFirst(row, ["tracktype", "TRACKTYPE"])),
    loctracking: normalizeInteger(readFirst(row, ["loctracking", "LOCTRACKING"])),
    tool: normalizeInteger(readFirst(row, ["tool", "TOOL"])),
    autoincsl: normalizeInteger(readFirst(row, ["autoincsl", "AUTOINCSL"])),
    divlotsize: normalizeDecimal(readFirst(row, ["divlotsize", "DIVLOTSIZE"])),
    shelflife: normalizeInteger(readFirst(row, ["shelflife", "SHELFLIFE"])),
    shelfdate: readFirst(row, ["shelfdate", "SHELFDATE"]) ?? null,
    imageinc: normalizeInteger(readFirst(row, ["imageinc", "IMAGEINC"])),
    textinc: normalizeInteger(readFirst(row, ["textinc", "TEXTINC"])),
    approved: normalizeInteger(readFirst(row, ["approved", "APPROVED"])),
    qccset_ref: normalizeString(readFirst(row, ["qccset_ref", "QCCSETREF"])),
    site_id: normalizeString(readFirst(row, ["site_id", "SITEID"])),
    org_logic_ref: normalizeString(readFirst(row, ["org_logic_ref", "ORGLOGICREF"])),
    univid: normalizeString(readFirst(row, ["univid", "UNIVID"])),
    distlotunits: normalizeInteger(readFirst(row, ["distlotunits", "DISTLOTUNITS"])),
    comblotunits: normalizeInteger(readFirst(row, ["comblotunits", "COMBLOTUNITS"])),
    specode4: normalizeString(readFirst(row, ["specode4", "SPECODE4"])),
    specode5: normalizeString(readFirst(row, ["specode5", "SPECODE5"])),
    shelf_address: resolveShelfAddress(rawRecord),
    logo_name: logoName,
    logo_name2: logoName2,
    logo_name3: logoName3,
    cyphcode: normalizeString(readFirst(row, ["cyphcode", "CYPHCODE"])),
    logo_price: price?.meta ?? null,
    logo_units: unitInfo,
    logo_stock: stock
      ? {
          available_total: stock.available_total,
          reserved_total: stock.reserved_total,
          warehouses: (stock.warehouses ?? []).map((warehouse) => ({
            ...warehouse,
            shelf_address: resolveWarehouseShelfAddress(rawRecord, warehouse),
          })),
        }
      : null,
    source_created_date:
      readFirst(row, ["source_created_date", "CAPIBLOCK_CREATEDDATE", "capiblock_createddate"]) ??
      null,
    source_modified_date:
      readFirst(row, ["source_modified_date", "CAPIBLOCK_MODIFIEDDATE", "capiblock_modifieddate"]) ??
      null,
    raw: rawRecord,
  };

  const record = {
    external_ref: externalRef,
    sku,
    oem_code: normalizeString(
      readFirst(row, ["oem_code", "OEMCODE", "PRODUCERCODE", "PRODUCER_CODE"])
    ) ?? primaryOemCode,
    name,
    description:
      normalizeString(readFirst(row, ["description", "DESCRIPTION"])) ?? logoName ?? logoName3,
    unit:
      normalizeString(unitInfo?.primary_unit_code) ??
      normalizeString(readFirst(row, ["unit", "UNIT", "UNITCODE", "UNITCODE1"])) ??
      "adet",
    vat_rate: normalizeDecimal(readFirst(row, ["vat_rate", "VAT", "ADDTAXRATE"])),
    weight_kg: normalizeDecimal(readFirst(row, ["weight_kg", "WEIGHT", "NETWEIGHT", "GROSSWEIGHT"])),
    is_active: Number(readFirst(row, ["active", "ACTIVE"]) ?? 0) === 0,
    brand_code: meta.specode5 ?? meta.brand_code,
    brand_name:
      meta.specode5 ??
      normalizeString(readFirst(row, ["brand_name", "BRANDNAME", "MARKNAME", "MARKA", "MARK"])) ??
      meta.brand_code,
    category_code: meta.category_code,
    category_name:
      normalizeString(
        readFirst(row, ["category_name", "CATEGORY", "CATNAME", "GRPNAME", "GROUPNAME"])
      ) ?? meta.category_code,
    meta: compactObject(meta),
  };

  if (codeAliases.length > 0) {
    record.code_aliases = codeAliases;
  }

  const rawStockAvailable = normalizeInteger(
    readFirst(row, ["available_total", "AVAILABLE_TOTAL", "ONHAND"])
  );
  const rawStockReserved = normalizeInteger(
    readFirst(row, ["reserved_total", "RESERVED_TOTAL", "RESERVED"])
  );
  const stockReserved = stock?.reserved_total ?? rawStockReserved;
  const stockAvailable =
    stock?.available_total ??
    (rawStockAvailable !== null ? rawStockAvailable - Math.max(0, rawStockReserved ?? 0) : null);
  const listPrice =
    price?.list_price ??
    normalizeDecimal(readFirst(row, ["list_price", "LIST_PRICE", "PRICE"]));

  if (stockAvailable !== null) {
    record.available_total = stockAvailable;
  }

  if (stockReserved !== null) {
    record.reserved_total = Math.max(0, stockReserved);
  }

  if (listPrice !== null) {
    record.list_price = listPrice;
    record.currency = normalizeCurrencyCode(price?.currency ?? readFirst(row, ["currency", "CURRENCY"]));
  }

  if (Array.isArray(priceSnapshot?.entries) && priceSnapshot.entries.length > 0) {
    record.price_entries = priceSnapshot.entries.map((entry) => ({
      price_list_code: entry.price_list_code,
      list_price: entry.list_price,
      currency: normalizeCurrencyCode(entry.currency),
    }));
  }

  if (Array.isArray(priceSnapshot?.campaign_prices)) {
    record.campaign_prices = priceSnapshot.campaign_prices;
  }

  return record;
}

function resolveWarehouseShelfAddress(rawRecord, warehouse) {
  const warehouseKeys = [
    warehouse?.shelf_key,
    warehouse?.invenno,
    warehouse?.warehouse_code,
    warehouse?.warehouse_no,
  ]
    .map((value) => normalizeString(value))
    .filter(Boolean);

  for (const key of warehouseKeys) {
    const shelfAddress = normalizeString(
      rawRecord[`RAF${key}`] ??
        rawRecord[`raf${key}`] ??
        rawRecord[`RAF_${key}`] ??
        rawRecord[`raf_${key}`] ??
        rawRecord[`RAFADRESI${key}`] ??
        rawRecord[`rafadresi${key}`] ??
        rawRecord[`RAF_ADRESI_${key}`] ??
        rawRecord[`raf_adresi_${key}`] ??
        rawRecord[`SHELF_ADDRESS${key}`] ??
        rawRecord[`shelf_address${key}`] ??
        rawRecord[`LOCATION${key}`] ??
        rawRecord[`location${key}`]
    );

    if (shelfAddress) {
      return shelfAddress;
    }
  }

  return null;
}

function resolveShelfAddress(rawRecord) {
  return normalizeString(
    readFirst(rawRecord, [
      "shelf_address",
      "SHELF_ADDRESS",
      "shelfaddress",
      "SHELFADDRESS",
      "shelf_addr",
      "SHELF_ADDR",
      "raf_address",
      "RAF_ADDRESS",
      "raf_adresi",
      "RAF_ADRESI",
      "rafadresi",
      "RAFADRESI",
      "shelf",
      "SHELF",
      "raf",
      "RAF",
      "location",
      "LOCATION",
      "location_code",
      "LOCATION_CODE",
      "LOCATIONCODE",
    ])
  );
}

function deriveProductsSyncUrl(syncUrl) {
  const normalized = nullable(syncUrl);
  if (!normalized) {
    return null;
  }

  return normalized.replace(/\/customers\/sync$/, "/products/sync");
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

function deriveImageProductTableName(imageSchema) {
  if (!imageSchema?.schemaName || !imageSchema?.objectName) {
    return null;
  }

  const normalized = String(imageSchema.objectName).toUpperCase();
  const match = normalized.match(/^LG_(\d{3})(?:_\d{2})?_(?:FIRMDOC|PERDOC|FOLDER)$/);

  if (!match) {
    return null;
  }

  return `${imageSchema.schemaName}.LG_${match[1]}_ITEMS`;
}

function stripBrackets(value) {
  return String(value ?? "").replace(/^\[|\]$/g, "");
}

function readFirst(record, aliases) {
  for (const alias of aliases) {
    if (alias && Object.prototype.hasOwnProperty.call(record, alias)) {
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

function findColumn(columns, aliases) {
  for (const alias of aliases) {
    const matching = columns.find((column) => column.toUpperCase() === String(alias).toUpperCase());
    if (matching) {
      return matching;
    }
  }

  return null;
}

function findAliasReferenceColumn(columns) {
  return findColumn(columns, [
    "PARLOGREF",
    "PARENTREF",
    "PARENT_LOGICALREF",
    "CARDREF",
    "STOCKREF",
    "ITEMREF",
    "PRODUCTREF",
    "MAINCREF",
    "LOGICALREF",
    "LOGREF",
  ]);
}

function collectAliasCodeColumns(columns, type) {
  const specificWidePatterns =
    type === "oem"
      ? [/^OEM\d+$/i]
      : [/^RKP\d+$/i, /^RAKIP\d+$/i, /^COMPETITOR\d+$/i];

  const specificSingleAliases =
    type === "oem"
      ? ["OEMNO", "OEM_NO", "OEMCODE", "OEM_CODE"]
      : [
          "COMPETITORCODE",
          "COMPETITOR_CODE",
          "RIVALCODE",
          "RIVAL_CODE",
          "RAKIPKODU",
          "RAKIP_KODU",
          "RAKIPCODE",
          "RAKIP_CODE",
          "ALTCODE",
          "ALT_CODE",
          "REFCODE",
        ];

  const wideColumns = sortAliasColumns(
    columns.filter((column) => specificWidePatterns.some((pattern) => pattern.test(column)))
  );

  const specificColumns = specificSingleAliases
    .map((alias) => findColumn(columns, [alias]))
    .filter(Boolean);

  if (wideColumns.length > 0 || specificColumns.length > 0) {
    return uniqueColumns([...wideColumns, ...specificColumns]);
  }

  const fallback = findColumn(columns, ["CODE", "CODE_", "NUMBER", "NO"]);
  return fallback ? [fallback] : [];
}

function sortAliasColumns(columns) {
  return [...columns].sort((left, right) => {
    const leftMatch = String(left).match(/(\D+)(\d+)$/);
    const rightMatch = String(right).match(/(\D+)(\d+)$/);

    if (leftMatch && rightMatch && leftMatch[1].toUpperCase() === rightMatch[1].toUpperCase()) {
      return Number.parseInt(leftMatch[2], 10) - Number.parseInt(rightMatch[2], 10);
    }

    return String(left).localeCompare(String(right), "en", { numeric: true });
  });
}

function uniqueColumns(columns) {
  return [...new Set(columns)];
}

function appendUniqueOrderBy(orderBy, column, direction) {
  if (!column) {
    return;
  }

  const normalizedColumn = String(column).replace(/\[[^\]]+\]\./g, "").replace(/^[^.]+\./, "").toUpperCase();
  const exists = orderBy.some((entry) => {
    const entryColumn = String(entry).trim().split(/\s+/)[0] ?? "";
    return entryColumn.replace(/\[[^\]]+\]\./g, "").replace(/^[^.]+\./, "").toUpperCase() === normalizedColumn;
  });

  if (!exists) {
    orderBy.push(`${column} ${direction}`);
  }
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

function resolveProductImageColumns(currentConfig, schema) {
  const explicitRefColumn = resolveConfiguredColumn(schema, currentConfig.logo.productImageRefColumn);
  const explicitDataColumn = resolveConfiguredColumn(schema, currentConfig.logo.productImageDataColumn);
  const explicitPathColumn = resolveConfiguredColumn(schema, currentConfig.logo.productImagePathColumn);
  const explicitOrderColumn = resolveConfiguredColumn(schema, currentConfig.logo.productImageOrderColumn);

  return {
    referenceColumn:
      explicitRefColumn ??
      findColumn(schema.columns, [
        "ITEMREF",
        "STOCKREF",
        "CARDREF",
        "INFOREF",
        "PRODUCTREF",
        "PARENTREF",
        "PARLOGREF",
        "LREF",
        "LOGICALREF",
      ]),
    dataColumn: explicitDataColumn ?? findFirstImageDataColumn(schema.columns),
    pathColumn:
      explicitPathColumn ??
      findColumn(schema.columns, [
        "IMAGEPATH",
        "IMAGE_PATH",
        "IMAGEFILE",
        "IMAGE_FILE",
        "IMAGEURL",
        "IMAGE_URL",
        "IMAGEURL1",
        "IMAGE_URL1",
        "IMAGEPATH1",
        "IMAGE_PATH1",
        "IMAGEURI",
        "IMAGE_URI",
        "PICTUREPATH",
        "PICTURE_PATH",
        "PICTUREURL",
        "PICTURE_URL",
        "PICTUREURL1",
        "PICTURE_URL1",
        "PHOTOPATH",
        "PHOTO_PATH",
        "PHOTOURL",
        "PHOTO_URL",
        "PHOTO_URL1",
        "PHOTOURL1",
        "PHOTOFILE",
        "PHOTO_FILE",
        "PICPATH",
        "PIC_PATH",
        "PICURL",
        "PIC_URL",
        "PIC_URL1",
        "PICURL1",
        "FILEPATH",
        "FILE_PATH",
        "FPATH",
        "FULLPATH",
        "FULL_PATH",
        "FILENAME",
        "FILE_NAME",
        "URL",
        "URI",
        "PATH",
        "IMAGEURL_1",
        "PHOTOURL_1",
        "PHOTO_URL_1",
        "PICTUREURL_1",
        "PICTURE_URL_1",
        "PICURL_1",
        "PIC_URL_1",
        "RESIMYOLU",
        "RESIM_YOLU",
        "RESIMURL",
        "RESIM_URL",
        "RESIMURL1",
        "RESIM_URL1",
        "RESIMDOSYA",
        "RESIM_DOSYA",
        "RESIMDOSYASI",
        "RESIM_DOSYASI",
        "RESIMYOLU1",
        "RESIM_YOLU1",
      ]),
    orderColumn:
      explicitOrderColumn ??
      findColumn(schema.columns, [
        "CAPIBLOCK_MODIFIEDDATE",
        "UPDATED_AT",
        "DATE_",
        "DOCNR",
        "LREF",
        "LOGICALREF",
        "ORDINAL",
        "LINENO",
        "SEQNO",
      ]),
  };
}

function resolveConfiguredColumn(schema, configuredColumn) {
  if (!configuredColumn) {
    return null;
  }

  return findColumn(schema.columns, [configuredColumn]);
}

function findFirstImageDataColumn(columns) {
  const candidates = columns.filter((column) => {
    const normalized = String(column).toUpperCase();

    if (!/(IMAGE|PHOTO|PICTURE|PIC|RESIM)/.test(normalized)) {
      return false;
    }

    if (/INC\d*$/.test(normalized)) {
      return false;
    }

    if (/(PATH|FILE|URL|EXT|NAME|TYPE)/.test(normalized)) {
      return false;
    }

    return true;
  });

  if (candidates.length === 0) {
    return findColumn(columns, [
      "IMAGE",
      "IMAGE_DATA",
      "IMAGEBLOB",
      "IMAGE_BLOB",
      "PICTURE",
      "PICTURE_DATA",
      "PHOTO",
      "PHOTO_DATA",
      "PIC",
      "PIC_DATA",
      "RESIM",
      "RESIM_DATA",
      "RESIMBLOB",
      "RESIM_BLOB",
      "BLOB",
      "FILEDATA",
      "FILE_DATA",
      "LDATA",
      "L_DATA",
      "DOCDATA",
      "DOC_DATA",
      "DOCUMENTDATA",
      "DOCUMENT_DATA",
      "CONTENT",
      "DATA",
    ]);
  }

  return sortAliasColumns(candidates)[0] ?? null;
}

function normalizeImageBaseUrl(value) {
  const baseUrl = normalizeString(value);
  if (!baseUrl) {
    return null;
  }

  return baseUrl.replace(/\/+$/, "");
}

function resolveLogoImageUrl(imagePath, baseUrl) {
  const normalizedPath = normalizeString(imagePath);
  if (!normalizedPath || !baseUrl) {
    return null;
  }

  if (/^[A-Za-z]:\\/.test(normalizedPath) || /^\\\\/.test(normalizedPath) || path.isAbsolute(normalizedPath)) {
    return null;
  }

  return `${baseUrl}/${normalizedPath.replace(/^[\\/]+/, "").replace(/\\/g, "/")}`;
}

async function resolveImagePayloadValue(blobValue, pathValue, imageRoot, imageBaseUrl, currentConfig) {
  const imageBuffer = extractImageBufferFromValue(blobValue);
  if (imageBuffer) {
    return optimizeImageBufferForSync(imageBuffer, currentConfig);
  }

  const normalizedPath = normalizeString(pathValue) ?? normalizeString(blobValue);
  if (!normalizedPath) {
    return null;
  }

  if (/^https?:\/\//i.test(normalizedPath)) {
    return {
      source: "url",
      value: normalizedPath,
    };
  }

  const baseUrl = resolveLogoImageUrl(normalizedPath, imageBaseUrl);
  if (baseUrl) {
    return {
      source: "url",
      value: baseUrl,
    };
  }

  if (/^data:image\//i.test(normalizedPath)) {
    const dataBuffer = extractImageBufferFromValue(normalizedPath);
    if (!dataBuffer) {
      return {
        source: "failed",
        reason: "invalid_image_payload",
        originalBytes: estimateImageByteLength(normalizedPath),
      };
    }

    return optimizeImageBufferForSync(dataBuffer, currentConfig);
  }

  const candidatePaths = [];

  if (path.isAbsolute(normalizedPath)) {
    candidatePaths.push(normalizedPath);
  }

  if (imageRoot) {
    candidatePaths.push(path.resolve(imageRoot, normalizedPath));
  }

  for (const candidatePath of uniqueColumns(candidatePaths)) {
    try {
      if (!fs.existsSync(candidatePath)) {
        continue;
      }

      const buffer = fs.readFileSync(candidatePath);
      if (buffer.length === 0) {
        continue;
      }

      const fileImageBuffer = extractImageBuffer(buffer);
      if (!fileImageBuffer) {
        continue;
      }

      return optimizeImageBufferForSync(fileImageBuffer, currentConfig, "path");
    } catch (error) {
      console.warn(
        `[logo-sync] failed to read product image file ${candidatePath}: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  return null;
}

function normalizeImageBlobValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (Buffer.isBuffer(value)) {
    return normalizeImageBufferValue(value);
  }

  if (value instanceof Uint8Array) {
    return normalizeImageBufferValue(Buffer.from(value));
  }

  if (value instanceof ArrayBuffer) {
    return normalizeImageBufferValue(Buffer.from(value));
  }

  if (Array.isArray(value)) {
    if (value.length === 0 || value.some((item) => !Number.isInteger(item))) {
      return null;
    }

    return normalizeImageBufferValue(Buffer.from(value));
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      return null;
    }

    if (/^data:image\//i.test(normalized)) {
      return normalized;
    }

    const base64Payload = tryResolveImageBase64Payload(normalized);
    if (base64Payload) {
      return base64Payload.value;
    }

    const hexPayload = resolveHexImagePayload(normalized);
    if (hexPayload) {
      return hexPayload;
    }

    return null;
  }

  if (typeof value === "object") {
    for (const key of ["data", "buffer", "value", "bytes"]) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        continue;
      }

      const nested = normalizeImageBlobValue(value[key]);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

function resolveHexImagePayload(value) {
  const normalized = value.replace(/\s+/g, "").replace(/^0x/i, "");
  if (normalized.length < 64 || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(normalized)) {
    return null;
  }

  const buffer = Buffer.from(normalized, "hex");
  return normalizeImageBufferValue(buffer);
}

function buildProductImageFileIndex(rootPath) {
  const normalizedRoot = normalizeString(rootPath);
  if (!normalizedRoot) {
    return null;
  }

  try {
    const stat = fs.statSync(normalizedRoot);
    if (!stat.isDirectory()) {
      console.warn(
        `[logo-sync] product image fallback dir is not a directory: ${normalizedRoot}`
      );
      return null;
    }
  } catch (error) {
    console.warn(
      `[logo-sync] product image fallback dir not available: ${normalizedRoot} (${error instanceof Error ? error.message : error})`
    );
    return null;
  }

  const allowedExtensions = new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".bmp",
    ".gif",
    ".webp",
    ".tif",
    ".tiff",
    ".svg",
  ]);
  const filesByKey = new Map();
  const stack = [normalizedRoot];
  let fileCount = 0;

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (error) {
      console.warn(
        `[logo-sync] failed to scan product image fallback dir ${currentDir}: ${error instanceof Error ? error.message : error}`
      );
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (!allowedExtensions.has(extension)) {
        continue;
      }

      const key = normalizeImageLookupKey(path.parse(entry.name).name);
      if (!key || filesByKey.has(key)) {
        continue;
      }

      filesByKey.set(key, entryPath);
      fileCount += 1;
    }
  }

  return {
    root: normalizedRoot,
    fileCount,
    filesByKey,
  };
}

function buildProductImageMap(mapFilePath, imageRoot) {
  const normalizedMapFilePath = normalizeString(mapFilePath);
  if (!normalizedMapFilePath) {
    return null;
  }

  let fileContents = "";
  try {
    fileContents = fs.readFileSync(normalizedMapFilePath, "utf8");
  } catch (error) {
    console.warn(
      `[logo-sync] failed to read product image map file ${normalizedMapFilePath}: ${error instanceof Error ? error.message : error}`
    );
    return null;
  }

  const fileDir = path.dirname(normalizedMapFilePath);
  const lines = fileContents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  if (lines.length === 0) {
    return {
      filePath: normalizedMapFilePath,
      fileDir,
      imageRoot: normalizeString(imageRoot),
      entryCount: 0,
      entriesByKey: new Map(),
    };
  }

  const delimiter = detectDelimitedFileSeparator(lines[0]);
  const headerCells = splitDelimitedLine(lines[0], delimiter).map((cell) => normalizeString(cell) ?? "");
  const keyIndex = findDelimitedHeaderIndex(headerCells, ["sku", "code", "product_code", "item_code"]);
  const valueIndex = findDelimitedHeaderIndex(headerCells, [
    "image_path",
    "path",
    "file_path",
    "file",
    "filename",
    "image_file",
    "image_url",
    "url",
    "image",
  ]);

  const hasHeader = keyIndex !== -1 && valueIndex !== -1;
  const entriesByKey = new Map();
  const dataLines = hasHeader ? lines.slice(1) : lines;

  for (const line of dataLines) {
    const cells = splitDelimitedLine(line, delimiter);
    const rawKey = hasHeader ? cells[keyIndex] : cells[0];
    const rawValue = hasHeader ? cells[valueIndex] : cells[1];
    const normalizedKey = normalizeImageLookupKey(rawKey);
    const normalizedValue = normalizeString(rawValue);

    if (!normalizedKey || !normalizedValue || entriesByKey.has(normalizedKey)) {
      continue;
    }

    entriesByKey.set(normalizedKey, normalizedValue);
  }

  return {
    filePath: normalizedMapFilePath,
    fileDir,
    imageRoot: normalizeString(imageRoot),
    entryCount: entriesByKey.size,
    entriesByKey,
  };
}

function buildProductRafMap(mapFilePath) {
  const normalizedMapFilePath = normalizeString(mapFilePath);
  if (!normalizedMapFilePath) {
    return null;
  }

  let fileContents = "";
  try {
    fileContents = fs.readFileSync(normalizedMapFilePath, "utf8");
  } catch (error) {
    console.warn(
      `[logo-sync] failed to read product raf map file ${normalizedMapFilePath}: ${error instanceof Error ? error.message : error}`
    );
    return null;
  }

  const lines = fileContents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  if (lines.length === 0) {
    return {
      filePath: normalizedMapFilePath,
      entryCount: 0,
      entriesByKey: new Map(),
    };
  }

  const delimiter = detectDelimitedFileSeparator(lines[0]);
  const headerCells = splitDelimitedLine(lines[0], delimiter).map((cell) => normalizeString(cell) ?? "");
  const keyIndex = findDelimitedHeaderIndex(headerCells, [
    "sku",
    "code",
    "product_code",
    "item_code",
    "urun_kodu",
    "ürün_kodu",
    "stok_kodu",
    "stokkodu",
  ]);

  if (keyIndex === -1) {
    console.warn(`[logo-sync] product raf map file ${normalizedMapFilePath} has no product code header.`);
    return null;
  }

  const entriesByKey = new Map();
  for (const line of lines.slice(1)) {
    const cells = splitDelimitedLine(line, delimiter);
    const normalizedKeys = normalizeRafLookupKeys(cells[keyIndex]);
    if (normalizedKeys.length === 0 || normalizedKeys.every((key) => entriesByKey.has(key))) {
      continue;
    }

    const rafRecord = {};
    let firstShelfAddress = null;
    for (let index = 0; index < headerCells.length; index += 1) {
      if (index === keyIndex) {
        continue;
      }

      const header = normalizeString(headerCells[index]);
      const value = normalizeString(cells[index]);
      if (!header || !value) {
        continue;
      }

      firstShelfAddress = firstShelfAddress ?? value;
      if (/^\d+$/.test(header)) {
        assignWarehouseShelfRawFields(rafRecord, header, value);
      } else {
        rafRecord[header] = value;
      }
    }

    if (firstShelfAddress) {
      rafRecord.RAF = rafRecord.RAF ?? firstShelfAddress;
      rafRecord.RAF_ADRESI = rafRecord.RAF_ADRESI ?? firstShelfAddress;
      rafRecord.RAF_BILGILERI = rafRecord.RAF_BILGILERI ?? firstShelfAddress;
    }

    if (Object.keys(rafRecord).length > 0) {
      for (const normalizedKey of normalizedKeys) {
        if (!entriesByKey.has(normalizedKey)) {
          entriesByKey.set(normalizedKey, rafRecord);
        }
      }
    }
  }

  return {
    filePath: normalizedMapFilePath,
    entryCount: entriesByKey.size,
    entriesByKey,
  };
}

function detectDelimitedFileSeparator(line) {
  const candidates = [",", ";", "\t", "|"];
  let bestDelimiter = ",";
  let bestCount = -1;

  for (const delimiter of candidates) {
    const count = splitDelimitedLine(line, delimiter).length;
    if (count > bestCount) {
      bestDelimiter = delimiter;
      bestCount = count;
    }
  }

  return bestDelimiter;
}

function splitDelimitedLine(line, delimiter) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        current += "\"";
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && char === delimiter) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function findDelimitedHeaderIndex(headerCells, aliases) {
  return headerCells.findIndex((cell) => aliases.includes((cell ?? "").toLowerCase()));
}

function resolveProductRafFromMap(sku, rafMap) {
  if (!rafMap) {
    return null;
  }

  for (const skuKey of normalizeRafLookupKeys(sku)) {
    const entry = rafMap.entriesByKey.get(skuKey);
    if (entry) {
      return entry;
    }
  }

  return null;
}

function normalizeRafLookupKeys(value) {
  const raw = normalizeString(value);
  const keys = [];
  const fullKey = normalizeImageLookupKey(raw);
  if (fullKey) {
    keys.push(fullKey);
  }

  const withoutPrefix = raw?.includes("-") ? raw.slice(raw.indexOf("-") + 1) : null;
  const suffixKey = normalizeImageLookupKey(withoutPrefix);
  if (suffixKey && !keys.includes(suffixKey)) {
    keys.push(suffixKey);
  }

  return keys;
}

function resolveProductImageFromMap(sku, imageMap) {
  if (!imageMap) {
    return null;
  }

  const skuKey = normalizeImageLookupKey(sku);
  if (!skuKey) {
    return null;
  }

  const mappedValue = imageMap.entriesByKey.get(skuKey);
  if (!mappedValue) {
    return null;
  }

  const resolvedImage = resolveMappedImageValue(
    mappedValue,
    imageMap.fileDir,
    imageMap.imageRoot
  );
  if (!resolvedImage) {
    return null;
  }

  return {
    rawKey: resolvedImage.source === "url" ? "IMAGE_URL" : resolvedImage.source === "path" ? "IMAGE_PATH" : "IMAGE",
    value: resolvedImage.value,
  };
}

function resolveMappedImageValue(imageValue, mapFileDir, imageRoot) {
  const normalizedValue = normalizeString(imageValue);
  if (!normalizedValue) {
    return null;
  }

  if (/^https?:\/\//i.test(normalizedValue)) {
    return {
      source: "url",
      value: normalizedValue,
    };
  }

  if (normalizedValue.startsWith("data:image/")) {
    return {
      source: "blob",
      value: normalizedValue,
    };
  }

  const directBase64 = tryResolveImageBase64Payload(normalizedValue);
  if (directBase64) {
    return directBase64;
  }

  const candidatePaths = [];
  if (path.isAbsolute(normalizedValue)) {
    candidatePaths.push(normalizedValue);
  } else {
    candidatePaths.push(path.resolve(mapFileDir, normalizedValue));
    if (imageRoot) {
      candidatePaths.push(path.resolve(imageRoot, normalizedValue));
    }
  }

  for (const candidatePath of uniqueColumns(candidatePaths)) {
    try {
      if (!fs.existsSync(candidatePath)) {
        continue;
      }

      const buffer = fs.readFileSync(candidatePath);
      if (buffer.length === 0) {
        continue;
      }

      const imagePayload = normalizeImageBufferValue(buffer);
      if (!imagePayload) {
        continue;
      }

      return {
        source: "blob",
        value: imagePayload,
      };
    } catch (error) {
      console.warn(
        `[logo-sync] failed to read mapped product image ${candidatePath}: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  return null;
}

function resolveProductImageFromFileIndex(sku, imageFileIndex) {
  if (!imageFileIndex) {
    return null;
  }

  const skuKey = normalizeImageLookupKey(sku);
  if (!skuKey) {
    return null;
  }

  const candidatePath = imageFileIndex.filesByKey.get(skuKey);
  if (!candidatePath) {
    return null;
  }

  try {
    const buffer = fs.readFileSync(candidatePath);
    if (buffer.length === 0) {
      return null;
    }

    const imagePayload = normalizeImageBufferValue(buffer);
    if (!imagePayload) {
      return null;
    }

    return {
      rawKey: "IMAGE",
      value: imagePayload,
    };
  } catch (error) {
    console.warn(
      `[logo-sync] failed to read fallback product image ${candidatePath}: ${error instanceof Error ? error.message : error}`
    );
    return null;
  }
}

function normalizeImageLookupKey(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }

  const compact = normalized.toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact || null;
}

function tryResolveImageBase64Payload(value) {
  const normalized = value.replace(/\s+/g, "");
  if (normalized.length < 32) {
    return null;
  }

  let decoded = null;
  try {
    decoded = Buffer.from(normalized, "base64");
  } catch {
    return null;
  }

  if (!decoded || decoded.length === 0) {
    return null;
  }

  const normalizedImage = normalizeImageBufferValue(decoded);
  if (!normalizedImage) {
    return null;
  }

  return {
    source: "blob",
    value: normalizedImage,
  };
}

function normalizeImageBufferValue(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return null;
  }

  const imageBuffer = extractImageBuffer(buffer);
  return imageBuffer ? imageBuffer.toString("base64") : null;
}

let sharpLoader = null;

async function optimizeImageBufferForSync(imageBuffer, currentConfig, source = "blob") {
  const originalBytes = imageBuffer.length;

  if (
    !currentConfig.sync.imageOptimize ||
    (currentConfig.sync.imageAllowOriginalIfSmall &&
      originalBytes <= currentConfig.sync.imageOriginalMaxBytes)
  ) {
    return {
      source,
      value: imageBuffer.toString("base64"),
      originalBytes,
      sentBytes: originalBytes,
      optimizedBytes: originalBytes,
      optimized: false,
    };
  }

  let optimizedBuffer = null;
  try {
    optimizedBuffer = await optimizeImageBufferWithSharp(imageBuffer, currentConfig);
  } catch (error) {
    return {
      source: "failed",
      reason: "optimize_failed",
      originalBytes,
      optimizedBytes: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!optimizedBuffer || optimizedBuffer.length === 0) {
    return {
      source: "failed",
      reason: "optimize_failed",
      originalBytes,
      optimizedBytes: null,
    };
  }

  if (
    currentConfig.sync.imageTargetMaxBytes > 0 &&
    optimizedBuffer.length > currentConfig.sync.imageTargetMaxBytes
  ) {
    return {
      source: "failed",
      reason: "optimize_failed",
      originalBytes,
      optimizedBytes: optimizedBuffer.length,
    };
  }

  return {
    source,
    value: optimizedBuffer.toString("base64"),
    originalBytes,
    sentBytes: optimizedBuffer.length,
    optimizedBytes: optimizedBuffer.length,
    optimized: true,
  };
}

async function optimizeImageBufferWithSharp(imageBuffer, currentConfig) {
  const sharp = await loadSharp();
  const format = String(currentConfig.sync.imageOutputFormat ?? "jpeg").toLowerCase();
  const maxWidth = Math.max(1, currentConfig.sync.imageMaxWidth);
  const baseQuality = clampInteger(currentConfig.sync.imageJpegQuality, 1, 100, 80);
  const qualitySteps = uniqueColumns([baseQuality, 70, 60].filter((quality) => quality > 0));
  let bestBuffer = null;

  for (const quality of qualitySteps) {
    let pipeline = sharp(imageBuffer, { failOn: "none" })
      .rotate()
      .resize({ width: maxWidth, withoutEnlargement: true });

    if (format === "webp") {
      pipeline = pipeline.webp({ quality });
    } else if (format === "png") {
      pipeline = pipeline.png({ compressionLevel: 9 });
    } else {
      pipeline = pipeline.jpeg({ quality, mozjpeg: true });
    }

    const candidate = await pipeline.toBuffer();
    if (!bestBuffer || candidate.length < bestBuffer.length) {
      bestBuffer = candidate;
    }

    if (currentConfig.sync.imageTargetMaxBytes <= 0 || candidate.length <= currentConfig.sync.imageTargetMaxBytes) {
      return candidate;
    }
  }

  return bestBuffer;
}

async function loadSharp() {
  if (!sharpLoader) {
    sharpLoader = import("sharp").then((mod) => mod.default ?? mod);
  }

  return sharpLoader;
}

function extractImageBufferFromValue(value) {
  if (Buffer.isBuffer(value)) {
    return extractImageBuffer(value);
  }

  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }

  const dataImageMatch = normalized.match(/^data:image\/[^;]+;base64,(.+)$/i);
  if (dataImageMatch) {
    return Buffer.from(dataImageMatch[1], "base64");
  }

  if (/^[A-Za-z0-9+/=\r\n]+$/.test(normalized) && normalized.length > 128) {
    return extractImageBuffer(Buffer.from(normalized.replace(/\s+/g, ""), "base64"));
  }

  return null;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function isImageTooLarge(imageBytes, maxBytes) {
  return Number.isFinite(imageBytes) && Number.isFinite(maxBytes) && maxBytes > 0 && imageBytes > maxBytes;
}

function estimateImageByteLength(value) {
  if (Buffer.isBuffer(value)) {
    const imageBuffer = extractImageBuffer(value);
    return imageBuffer?.length ?? value.length;
  }

  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }

  const dataImageMatch = normalized.match(/^data:image\/[^;]+;base64,(.+)$/i);
  if (dataImageMatch) {
    return estimateBase64ByteLength(dataImageMatch[1]);
  }

  if (/^[A-Za-z0-9+/=\r\n]+$/.test(normalized) && normalized.length > 128) {
    return estimateBase64ByteLength(normalized);
  }

  return Buffer.byteLength(normalized, "utf8");
}

function estimateBase64ByteLength(value) {
  const compact = String(value ?? "").replace(/\s+/g, "");
  if (compact.length === 0) {
    return 0;
  }

  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function extractImageBuffer(buffer) {
  if (detectImageMimeFromBuffer(buffer)) {
    return buffer;
  }

  for (const offset of embeddedImageOffsets(buffer)) {
    const candidate = buffer.subarray(offset);
    if (detectImageMimeFromBuffer(candidate)) {
      return candidate;
    }
  }

  return null;
}

function embeddedImageOffsets(buffer) {
  const offsets = [];
  const signatures = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from("GIF87a", "ascii"),
    Buffer.from("GIF89a", "ascii"),
    Buffer.from([0x49, 0x49, 0x2a, 0x00]),
    Buffer.from([0x4d, 0x4d, 0x00, 0x2a]),
    Buffer.from("BM", "ascii"),
  ];

  for (const signature of signatures) {
    const offset = buffer.indexOf(signature);
    if (offset > 0) {
      offsets.push(offset);
    }
  }

  let riffOffset = buffer.indexOf("RIFF", 1, "ascii");
  while (riffOffset !== -1) {
    if (buffer.subarray(riffOffset + 8, riffOffset + 12).toString("ascii") === "WEBP") {
      offsets.push(riffOffset);
    }

    riffOffset = buffer.indexOf("RIFF", riffOffset + 1, "ascii");
  }

  const text = buffer.toString("utf8");
  for (const signature of ["<svg", "<?xml"]) {
    const offset = text.indexOf(signature);
    if (offset > 0) {
      offsets.push(offset);
    }
  }

  return [...new Set(offsets)].sort((left, right) => left - right);
}

function detectImageMimeFromBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  if (buffer.length >= 6) {
    const header = buffer.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") {
      return "image/gif";
    }
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return "image/bmp";
  }

  if (
    buffer.length >= 4 &&
    ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
      (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a))
  ) {
    return "image/tiff";
  }

  const trimmedText = buffer.subarray(0, 256).toString("utf8").trimStart();
  if (trimmedText.startsWith("<svg") || (trimmedText.startsWith("<?xml") && trimmedText.includes("<svg"))) {
    return "image/svg+xml";
  }

  return null;
}

async function pushBatchWithRetry(records, currentConfig, syncMeta = {}) {
  const maxRetries = Number.parseInt(currentConfig.sync.retryMax, 10);
  const baseDelayMs = Number.parseInt(currentConfig.sync.retryBaseDelayMs, 10);
  let retryCount = 0;

  while (true) {
    try {
      const result = await pushBatch(records, currentConfig, syncMeta);
      return {
        retryCount,
        status: result.status,
        responsePreview: result.responsePreview,
      };
    } catch (error) {
      const syncError = ensureSyncError(error);
      syncError.retryCount = retryCount;

      if (retryCount >= (Number.isFinite(maxRetries) ? maxRetries : 0) || !isRetryableError(syncError)) {
        throw syncError;
      }

      retryCount += 1;
      const delayMs = Math.max(1, (Number.isFinite(baseDelayMs) ? baseDelayMs : 3000)) * (2 ** (retryCount - 1));
      appendSyncLog(
        resolveLogFilePath(currentConfig.sync.logDir),
        `[logo-sync] retrying batch request after failure status=${syncError.httpStatus ?? "n/a"} error=${syncError.message}; retry=${retryCount}/${maxRetries} delay_ms=${delayMs}`
      );
      await waitMs(delayMs);
    }
  }
}

async function pushBatchAdaptively(records, currentConfig, syncMeta = {}) {
  const requestChunks = partitionApiRequests(
    records,
    currentConfig.sync.apiRequestMaxRecords,
    currentConfig.sync.apiRequestMaxAliases
  );

  if (requestChunks.length > 1) {
    console.log(
      `[logo-sync] splitting batch into ${requestChunks.length} smaller API request(s)`
    );
  }

  let retryCount = 0;
  let status = 200;
  let responsePreview = "ok";

  for (let index = 0; index < requestChunks.length; index += 1) {
    const requestRecords = requestChunks[index];
    const result = await pushBatchWithRetry(requestRecords, currentConfig, {
      ...syncMeta,
      isFinalBatch: Boolean(syncMeta.isFinalBatch) && index === requestChunks.length - 1,
    });
    retryCount += result.retryCount;
    status = result.status;
    responsePreview = result.responsePreview;
  }

  return {
    retryCount,
    status,
    responsePreview,
  };
}

function partitionApiRequests(records, maxRecords, maxAliases) {
  const requests = [];
  let current = [];
  let aliasCount = 0;

  for (const record of records) {
    const recordAliasCount = Array.isArray(record?.code_aliases)
      ? record.code_aliases.length
      : 0;
    const exceedsRecordLimit = current.length >= maxRecords;
    const exceedsAliasLimit =
      current.length > 0 && aliasCount + recordAliasCount > maxAliases;

    if (exceedsRecordLimit || exceedsAliasLimit) {
      requests.push(current);
      current = [];
      aliasCount = 0;
    }

    current.push(record);
    aliasCount += recordAliasCount;
  }

  if (current.length > 0) {
    requests.push(current);
  }

  return requests;
}

async function pushBatch(records, currentConfig, syncMeta = {}) {
  const payload = {
    records,
  };

  if (currentConfig.sync.stockOnly) {
    payload.mode = "stock_only";
    payload.stock_only = true;
  }

  if (currentConfig.sync.imagesOnly) {
    payload.mode = "images_only";
    payload.images_only = true;
  }

  if (currentConfig.sync.priceListCode) {
    payload.price_list_code = currentConfig.sync.priceListCode;
  }

  if (syncMeta.syncRunId) {
    payload.sync_run_id = syncMeta.syncRunId;
    payload.is_full_sync = Boolean(syncMeta.isFullSync);
    payload.is_final_batch = Boolean(syncMeta.isFinalBatch);
    payload.batch_index = Number.isInteger(syncMeta.batchIndex) ? syncMeta.batchIndex : null;
    payload.batch_count = Number.isInteger(syncMeta.batchCount) ? syncMeta.batchCount : null;
    payload.source_table = syncMeta.sourceTable ?? currentConfig.logo.productTable;
  }

  let response;
  try {
    response = await fetch(currentConfig.sync.url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-integration-key": currentConfig.sync.key,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw buildSyncError(error, {
      stage: "request",
      httpStatus: null,
    });
  }

  const contentType = response.headers.get("content-type") ?? "";
  const rawBody = await response.text();
  const parsedBody = contentType.includes("application/json") ? parseMaybeJson(rawBody) : rawBody;
  const responsePreview = typeof parsedBody === "string" ? parsedBody : JSON.stringify(parsedBody ?? {});
  const preview = responsePreview.slice(0, 1024);

  if (!response.ok) {
    throw buildSyncError(new Error(`sync endpoint returned ${response.status}`), {
      httpStatus: response.status,
      responsePreview: preview,
    });
  }

  console.log("[logo-sync] sync response:", preview);

  return {
    status: response.status,
    responsePreview: preview,
    body: parsedBody,
  };
}

function isRetryableError(error) {
  const retryableStatuses = [408, 429, 500, 502, 503, 504];
  const retryableCodes = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"];
  const code = normalizeString(error.code) ?? normalizeString(error.cause?.code) ?? normalizeString(error.cause?.errno);
  const status = normalizeInteger(error.httpStatus ?? error.status);
  const message = normalizeString(error.message) ?? "";

  if (Number.isFinite(status) && retryableStatuses.includes(status)) {
    return true;
  }

  if (code && retryableCodes.includes(code.toUpperCase())) {
    return true;
  }

  if (message?.toLowerCase().includes("fetch failed")) {
    return true;
  }

  return false;
}

function buildSyncError(error, options = {}) {
  if (error instanceof Error) {
    if (Number.isFinite(Number.parseInt(error.httpStatus, 10))) {
      error.httpStatus = Number.parseInt(error.httpStatus, 10);
    }
    if (!error.httpStatus && Number.isFinite(Number.parseInt(options.httpStatus, 10))) {
      error.httpStatus = Number.parseInt(options.httpStatus, 10);
    }
    if (!error.responsePreview && options.responsePreview) {
      error.responsePreview = options.responsePreview;
    }
    error.retryContext = options;
    return error;
  }

  const syncError = new Error(
    normalizeString(error?.message) ?? normalizeString(error) ?? "product batch request failed"
  );
  if (Number.isFinite(Number.parseInt(options.httpStatus, 10))) {
    syncError.httpStatus = Number.parseInt(options.httpStatus, 10);
  }
  if (options.responsePreview) {
    syncError.responsePreview = options.responsePreview;
  }
  syncError.retryContext = options;
  return syncError;
}

function ensureSyncError(error) {
  if (error instanceof Error) {
    return error;
  }

  return buildSyncError(error);
}

function parseMaybeJson(rawBody) {
  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(items, size) {
  const result = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

function compactObject(input) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => {
      if (value === null || value === undefined) {
        return false;
      }

      if (typeof value === "string") {
        return value.trim() !== "";
      }

      return true;
    })
  );
}

function nullable(value) {
  const normalized = normalizeString(value);
  return normalized === null ? null : normalized;
}

function normalizeString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function normalizeCurrencyCode(value) {
  const normalized = normalizeString(value);

  if (!normalized) {
    return "TRY";
  }

  const upper = normalized.toUpperCase();
  const aliases = {
    "0": "TRY",
    "1": "USD",
    "17": "GBP",
    "20": "EUR",
    "160": "TRY",
    "840": "USD",
    "826": "GBP",
    "978": "EUR",
    TL: "TRY",
    TRL: "TRY",
    TRY: "TRY",
    USD: "USD",
    EUR: "EUR",
    GBP: "GBP",
  };

  return aliases[upper] ?? (upper.length === 3 ? upper : "TRY");
}

function normalizeCodeValue(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }

  const collapsed = normalized.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  return collapsed === "" ? null : collapsed;
}

function normalizeInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = Number.parseInt(String(value), 10);
  return Number.isFinite(normalized) ? normalized : null;
}

function normalizeDecimal(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = Number.parseFloat(String(value).replace(",", "."));
  return Number.isFinite(normalized) ? normalized : null;
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

function parseInteger(value, fallback) {
  const normalized = normalizeInteger(value);
  return normalized === null ? fallback : normalized;
}

function parseIntegerList(value, fallback = []) {
  if (value === undefined) {
    return [...fallback];
  }

  const normalized = String(value)
    .split(",")
    .map((item) => normalizeInteger(item))
    .filter((item) => item !== null);

  return normalized;
}

function parseWarehouseNameMap(value) {
  const map = new Map();
  const normalized = normalizeString(value);

  if (!normalized) {
    return map;
  }

  for (const part of normalized.split(/[;,]/)) {
    const [key, ...nameParts] = part.split("=");
    const warehouseNo = normalizeInteger(key);
    const name = normalizeString(nameParts.join("="));

    if (warehouseNo === null || !name) {
      continue;
    }

    map.set(warehouseNo, {
      no: warehouseNo,
      code: String(warehouseNo),
      name,
    });
  }

  return map;
}

function parseWarehouseRafKeyMap(value) {
  const map = new Map();
  const normalized = normalizeString(value);

  if (!normalized) {
    return map;
  }

  for (const part of normalized.split(/[;,]/)) {
    const [warehouseNoValue, ...shelfKeyParts] = part.split("=");
    const warehouseNo = normalizeInteger(warehouseNoValue);
    const shelfKey = normalizeString(shelfKeyParts.join("="));

    if (warehouseNo === null || !shelfKey) {
      continue;
    }

    map.set(warehouseNo, shelfKey);
  }

  return map;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

export {
  buildLogoCampaignPrice,
  logoCampaignPriceReason,
  resolveLogoCampaignMinQuantity,
  resolveLogoPriceGroupCode,
};
