#!/usr/bin/env node
/**
 * logo-campaigns-sync.mjs
 *
 * Logo ERP'den kampanya başlıklarını (CAMPAIGN) ve ürün satırlarını (CMPGNLINE)
 * okuyarak B2B API'sine senkronize eder.
 *
 * Çalıştırmak için:
 *   node logo-campaigns-sync.mjs
 *   node logo-campaigns-sync.mjs --dry-run
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import sql from "mssql";

import { postCampaignSync } from "./campaign-sync-http.mjs";
import { resolveCampaignCustomerGroup } from "./campaign-customer-group.mjs";
import {
  isLogoCampaignActive,
  normalizeLogoDate,
} from "./campaign-date.mjs";
import { logoFirmTable } from "./logo-table-names.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(scriptDir, ".env");
const statusPath = path.join(scriptDir, "campaign-sync-status.json");

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const DRY_RUN = process.argv.includes("--dry-run");

main().catch((error) => {
  writeCampaignStatus({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
  console.error(
    "[logo-campaigns-sync] failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
});

async function main() {
  const startedAt = new Date();
  const config = buildConfig();
  validateConfig(config);

  if (DRY_RUN) {
    console.log("[logo-campaigns-sync] DRY RUN mode — API'ye veri gönderilmeyecek");
  }

  const pool = new sql.ConnectionPool(config.connection);
  await pool.connect();

  try {
    console.log(
      `[logo-campaigns-sync] Logo'ya bağlanıldı: ${config.connection.server}/${config.connection.database}`
    );

    // 1. Kampanya başlıklarını oku
    const campaignTable = config.campaignTable;
    const campaignLineTable = config.campaignLineTable;
    const itemTable = config.itemTable;

    // Tablo var mı kontrol et
    const tableExists = await checkTableExists(pool, campaignTable);
    if (!tableExists) {
      console.warn(
        `[logo-campaigns-sync] UYARI: Kampanya tablosu bulunamadı: ${campaignTable}`
      );
      console.warn(
        "[logo-campaigns-sync] Lütfen LOGO_CAMPAIGN_TABLE ortam değişkenini doğrulayın."
      );
      return;
    }

    // Kampanya sütunlarını keşfet
    const campaignColumns = await getTableColumns(pool, campaignTable);
    console.log(
      `[logo-campaigns-sync] ${campaignTable} → sütunlar: ${campaignColumns.join(", ")}`
    );

    // Kampanya snapshot'ını çek. Pasif Logo kartları da B2B'ye is_active=false
    // olarak gitmeli; yoksa eski aktif kayıt yeni siparişlerde yaşamaya devam eder.
    const campaignRows = await pool.request().query(`
      SELECT *
      FROM ${campaignTable} WITH (NOLOCK)
      ORDER BY LOGICALREF
    `);

    console.log(
      `[logo-campaigns-sync] ${campaignRows.recordset.length} kampanya kartı bulundu`
    );

    if (campaignRows.recordset.length === 0) {
      console.log(
        "[logo-campaigns-sync] Kampanya kartı yok; eski B2B kampanyalarını pasife almak için boş snapshot gönderilecek."
      );
    }

    // Kampanya satır sütunlarını keşfet
    const lineTableExists = await checkTableExists(pool, campaignLineTable);
    const lineColumns = lineTableExists
      ? await getTableColumns(pool, campaignLineTable)
      : [];

    // Her kampanya için ürün kodlarını çek
    const campaigns = [];
    let skipped = 0;

    for (const row of campaignRows.recordset) {
      const ref = String(row.LOGICALREF ?? row.logicalref ?? "");
      if (!ref) continue;

      const code = normalizeString(
        row.CODE ?? row.code ?? row.CMPGNCODE ?? row.cmpgncode ?? ref
      );
      const name = normalizeString(
        row.DEFINITION_ ??
          row.DEFINITION ??
          row.definition ?? 
          row.DESCRIPTION ??
          row.NAME ??
          row.name ??
          code ??
          `Kampanya-${ref}`
      );

      // Logo'nun sayısal CLTYPE alanı gerçek F1-F12 grubunu maskelemesin.
      // Tüm olası grup alanlarını tarayıp somut F grubunu önceliklendiririz.
      const resolvedCustomerGroup = resolveCampaignCustomerGroup(row, code, name);
      const customerGroup = resolvedCustomerGroup.group;
      const groupField = resolvedCustomerGroup.source;

      // Hedef adet / koşul
      const targetQty = parseInt(
        String(
          row.MINQTY ??
          row.CONDQTY ??
          row.MINQUANTITY ??
          row.TARGETQTY ??
          row.QUANTITY ??
          "1"
        ),
        10
      ) || 1;

      // Tarihler
      const startsAt = normalizeLogoDate(
        row.BGNDATE ?? row.BEGINDATE ?? row.STARTDATE ?? row.BEGINS_AT ?? null
      );
      const endsAt = normalizeLogoDate(
        row.ENDDATE ?? row.FINDATE ?? row.ENDS_AT ?? null
      );

      // Aktif mi? (Logo'da 0 = Kullanımda, 1 = Kullanım Dışı)
      const isActive = isLogoCampaignActive(row);

      // Kampanya ürün kodlarını ve formülü çek
      let productSkus = [];
      let discountPercent = null;
      let lineCondition = null;

      if (lineTableExists) {
        try {
          const lineRows = await pool
            .request()
            .input("campRef", sql.Int, parseInt(ref, 10))
            .query(`
              SELECT *
              FROM ${campaignLineTable} WITH (NOLOCK)
              WHERE CAMPCARDREF = @campRef
              ORDER BY LOGICALREF
            `);

          for (const lineRow of lineRows.recordset) {
            // Formülden indirim oranını çıkar (örn: P76*(35/100) -> 35)
            const formula = lineRow.FORMULA ?? lineRow.MATHFORMULA ?? "";
            const conditionStr = lineRow.CONDITION ?? lineRow.COND ?? "";

            if (discountPercent === null && Number.isFinite(Number(lineRow.DISCPER))) {
              const directDiscount = Number(lineRow.DISCPER);
              if (directDiscount >= 0 && directDiscount <= 100) {
                discountPercent = directDiscount;
              }
            }

            if (discountPercent === null && formula) {
              const match = String(formula).match(/\*\s*\(\s*(\d+(?:[.,]\d+)?)\s*\/\s*100\s*\)/);
              if (match) {
                discountPercent = Number(match[1].replace(",", "."));
              }
            }
            if (!lineCondition && conditionStr) {
               lineCondition = String(conditionStr);
            }

            // Ürün kodu: ITEMS tablosundan çek veya doğrudan al
            const stockRef = lineRow.STOCKREF ?? lineRow.MATREF ?? lineRow.ITEMREF ?? null;
            if (stockRef) {
              try {
                const itemRow = await pool
                  .request()
                  .input("itemRef", sql.Int, parseInt(String(stockRef), 10))
                  .query(`
                    SELECT TOP 1 CODE
                    FROM ${itemTable} WITH (NOLOCK)
                    WHERE LOGICALREF = @itemRef
                  `);
                const itemCode = itemRow.recordset[0]?.CODE;
                if (itemCode) {
                  productSkus.push(String(itemCode).trim());
                }
              } catch {
                // Bu item çekilemedi, devam et
              }
            }

            // Alternatif: doğrudan MATCODE, CONDITEMCODE veya STOCKCODE alanı varsa
            const directCode = normalizeString(
              lineRow.MATCODE ?? lineRow.STOCKCODE ?? lineRow.ITEMCODE ?? lineRow.CONDITEMCODE ?? null
            );
            if (directCode && !productSkus.includes(directCode)) {
              productSkus.push(directCode);
            }
          }
        } catch (err) {
          console.warn(
            `[logo-campaigns-sync] Kampanya ${ref} satırları okunamadı: ${err.message}`
          );
        }
      }

      // Adet bulma: Başlık isminden veya satır koşulundan çıkar (örn: "KAMPANYASI 10", "5 ADE", "P76*(5/100)")
      let parsedTargetQty = targetQty;
      const titleMatch = (code + " " + name).match(/(?:\s|-|^)(\d+)\s*(?:AD|ADE|ADET|LI|Lİ|'Lİ|'LI)?(?:\s|-|$)/i);
      if (titleMatch) {
         parsedTargetQty = parseInt(titleMatch[1], 10);
      } else if (lineCondition) {
         const condMatch = lineCondition.match(/\*\s*\(\s*(\d+)\s*\/\s*100\s*\)/);
         if (condMatch) {
             parsedTargetQty = parseInt(condMatch[1], 10);
         }
      }

      productSkus = [...new Set(productSkus)].filter((s) => s !== "");

      if (!customerGroup) {
        console.warn(
          `[logo-campaigns-sync] Kampanya atlandı: ${code || ref} için cari grubu çözülemedi.`
        );
        skipped++;
        continue;
      }

      if (productSkus.length === 0 && isActive) {
        console.warn(
          `[logo-campaigns-sync] Kampanya atlandı: ${code || ref} için ürün bulunamadı.`
        );
        skipped++;
        continue;
      }

      campaigns.push({
        source_reference: ref,
        code: code || `CAMP-${ref}`,
        name: name || `Kampanya ${ref}`,
        description: normalizeString(row.NOTES ?? row.DESCRIPTION2 ?? null),
        customer_group: customerGroup,
        target_quantity: parsedTargetQty,
        discount_percent: discountPercent,
        group_field: groupField,
        starts_at: startsAt,
        ends_at: endsAt,
        is_active: isActive,
        meta: {
          logo_ref: ref,
          raw_columns: campaignColumns,
        },
        products: productSkus,
      });

      console.log(
        `[logo-campaigns-sync] Kampanya: ${code} (grup: ${customerGroup ?? "hepsi"}, hedef: ${parsedTargetQty}, indirim: %${discountPercent ?? 0}, ürün: ${productSkus.length}, tarih: ${startsAt ?? "-"}..${endsAt ?? "-"}, Logo aktif: ${isActive ? "evet" : "hayır"})`
      );
    }

    if (DRY_RUN) {
      console.log("[logo-campaigns-sync] DRY RUN — gönderilecek veri:");
      console.log(JSON.stringify({ campaigns }, null, 2));
      writeCampaignStatus({
        ok: true,
        dryRun: true,
        startedAt,
        logoReadCount: campaignRows.recordset.length,
        payloadCount: campaigns.length,
        skipped,
      });
      return;
    }

    // 2. B2B API'sine gönder
    const apiBase = config.apiBase;
    const apiKey = config.apiKey;

    console.log(`[logo-campaigns-sync] API'ye gönderiliyor: ${apiBase}/api/integrations/logo/campaigns/sync`);

    const result = await postCampaignSync({
      endpoint: `${apiBase}/api/integrations/logo/campaigns/sync`,
      apiKey,
      campaigns,
      timeoutMs: config.requestTimeoutMs,
      onRetry: ({ attempt, maxAttempts, delayMs, status }) => {
        console.warn(
          `[logo-campaigns-sync] HTTP ${status}; ${delayMs} ms sonra yeniden denenecek (${attempt + 1}/${maxAttempts}).`
        );
      },
    });
    console.log(
      `[logo-campaigns-sync] Tamamlandı: ${result.synced ?? 0} kampanya güncellendi.`
    );
    writeCampaignStatus({
      ok: true,
      startedAt,
      logoReadCount: campaignRows.recordset.length,
      payloadCount: campaigns.length,
      skipped,
      result,
    });
  } finally {
    await pool.close();
  }
}

// ── Yardımcı fonksiyonlar ─────────────────────────────────────────────────────

async function checkTableExists(pool, tableName) {
  try {
    const plainName = tableName
      .split(".")
      .at(-1)
      .replaceAll("[", "")
      .replaceAll("]", "");
    const result = await pool
      .request()
      .input("tableName", sql.NVarChar(128), plainName)
      .query(`
        SELECT COUNT(*) AS cnt
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_NAME = @tableName
      `);
    return (result.recordset[0]?.cnt ?? 0) > 0;
  } catch {
    return false;
  }
}

async function getTableColumns(pool, tableName) {
  const plainName = tableName
    .split(".")
    .at(-1)
    .replaceAll("[", "")
    .replaceAll("]", "");
  const result = await pool
    .request()
    .input("tableName", sql.NVarChar(128), plainName)
    .query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = @tableName
      ORDER BY ORDINAL_POSITION
    `);
  return (result.recordset ?? []).map((r) => String(r.COLUMN_NAME));
}

function buildConfig() {
  const port = parseInteger(process.env.LOGO_SQL_PORT);
  const options = {
    encrypt: parseBoolean(process.env.LOGO_SQL_ENCRYPT, false),
    trustServerCertificate: parseBoolean(
      process.env.LOGO_SQL_TRUST_SERVER_CERTIFICATE,
      true
    ),
    instanceName: nullable(process.env.LOGO_SQL_INSTANCE),
  };

  const connection = {
    server: String(process.env.LOGO_SQL_SERVER ?? "").trim(),
    database: String(process.env.LOGO_SQL_DATABASE ?? "").trim(),
    user: String(process.env.LOGO_SQL_USER ?? "").trim(),
    password: process.env.LOGO_SQL_PASSWORD ?? "",
    options,
    requestTimeout: parseInteger(process.env.LOGO_SQL_REQUEST_TIMEOUT_MS) ?? 30_000,
  };

  if (port !== undefined) {
    connection.port = port;
  }

  return {
    connection,
    campaignTable:
      nullable(process.env.LOGO_CAMPAIGN_TABLE) ?? logoFirmTable("CAMPAIGN"),
    campaignLineTable:
      nullable(process.env.LOGO_CAMPAIGN_LINE_TABLE) ?? logoFirmTable("CMPGNLINE"),
    itemTable:
      nullable(process.env.LOGO_PRODUCT_TABLE) ?? logoFirmTable("ITEMS"),
    apiBase: String(
      process.env.B2B_API_BASE ?? process.env.API_BASE ?? "https://bayiotomasyonsistemi.com"
    ).replace(/\/$/, ""),
    apiKey: nullable(
      process.env.POWERSA_PRODUCTS_SYNC_KEY ??
      process.env.POWERSA_SYNC_KEY ??
      process.env.B2B_API_KEY ??
      process.env.LOGO_API_KEY
    ),
    requestTimeoutMs: positiveInteger(
      process.env.LOGO_CAMPAIGNS_SYNC_TIMEOUT_MS,
      180_000
    ),
  };
}

function validateConfig(config) {
  const missing = [];
  if (!config.connection.server) missing.push("LOGO_SQL_SERVER");
  if (!config.connection.database) missing.push("LOGO_SQL_DATABASE");
  if (!config.connection.user) missing.push("LOGO_SQL_USER");
  if (!config.connection.password) missing.push("LOGO_SQL_PASSWORD");

  if (missing.length > 0) {
    throw new Error(`Eksik konfigürasyon: ${missing.join(", ")}`);
  }
}

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function nullable(value) {
  const s = String(value ?? "").trim();
  return s === "" ? null : s;
}

function parseInteger(value) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

function positiveInteger(value, fallback) {
  const parsed = parseInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "") return fallback;
  return ["1", "true", "yes", "on"].includes(s);
}

function writeCampaignStatus({
  ok,
  dryRun = false,
  startedAt = new Date(),
  logoReadCount = null,
  payloadCount = null,
  skipped = null,
  result = null,
  error = null,
}) {
  const finishedAt = new Date();
  const previous = readJson(statusPath) ?? {};
  const payload = {
    task: "campaigns-read",
    ok,
    dry_run: dryRun,
    last_run_at: finishedAt.toISOString(),
    last_success_at: ok ? finishedAt.toISOString() : previous.last_success_at ?? null,
    next_run_hint: "Logo sync daemon maintenance loop; default every 60 seconds.",
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    logo_read_count: logoReadCount,
    payload_count: payloadCount,
    synced_count: result?.synced ?? null,
    created_count: result?.created ?? null,
    updated_count: result?.updated ?? null,
    deactivated_count: result?.deactivated ?? null,
    skipped_count: skipped,
    error_count: ok ? 0 : 1,
    last_error: ok ? null : error,
  };

  try {
    fs.writeFileSync(statusPath, JSON.stringify(payload, null, 2));
  } catch {
    // Status yazılamasa bile kampanya sync başarısını bozma.
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
