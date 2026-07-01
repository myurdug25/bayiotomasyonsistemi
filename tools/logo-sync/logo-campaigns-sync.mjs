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

import { logoFirmTable } from "./logo-table-names.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(scriptDir, ".env");

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const DRY_RUN = process.argv.includes("--dry-run");

main().catch((error) => {
  console.error(
    "[logo-campaigns-sync] failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
});

async function main() {
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

    // Aktif kampanyaları çek
    const campaignRows = await pool.request().query(`
      SELECT *
      FROM ${campaignTable} WITH (NOLOCK)
      WHERE ISNULL(ACTIVE, 0) = 0
      ORDER BY LOGICALREF
    `);

    console.log(
      `[logo-campaigns-sync] ${campaignRows.recordset.length} aktif kampanya bulundu`
    );

    if (campaignRows.recordset.length === 0) {
      console.log("[logo-campaigns-sync] Gönderilecek kampanya yok. Çıkılıyor.");
      return;
    }

    // Kampanya satır sütunlarını keşfet
    const lineTableExists = await checkTableExists(pool, campaignLineTable);
    const lineColumns = lineTableExists
      ? await getTableColumns(pool, campaignLineTable)
      : [];

    // Her kampanya için ürün kodlarını çek
    const campaigns = [];

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

      // Cari grup bilgisi: farklı sürümlerde farklı alan adı olabilir
      const customerGroup = normalizeString(
        row.CLTYPE ??          // cari tipi
        row.CLCARD_TYPE ??
        row.CARGROUPCODE ??
        row.CARDGRPCODE ??
        row.CUSTGROUP ??
        row.SPECODE ??         // özel kod
        null
      );

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
      const startsAt = normalizeDate(
        row.BGNDATE ?? row.BEGINDATE ?? row.STARTDATE ?? row.BEGINS_AT ?? null
      );
      const endsAt = normalizeDate(
        row.ENDDATE ?? row.FINDATE ?? row.ENDS_AT ?? null
      );

      // Aktif mi? (Logo'da 0 = Kullanımda, 1 = Kullanım Dışı)
      const isActive =
        Number(row.ACTIVE ?? row.active ?? 0) === 0 &&
        (!endsAt || new Date(endsAt) >= new Date());

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
              WHERE CAMPCARDREF = @campRef OR CMPGNREF = @campRef
              ORDER BY LOGICALREF
            `);

          for (const lineRow of lineRows.recordset) {
            // Formülden indirim oranını çıkar (örn: P76*(35/100) -> 35)
            const formula = lineRow.FORMULA ?? lineRow.MATHFORMULA ?? lineRow.DISCPER ?? "";
            const conditionStr = lineRow.CONDITION ?? lineRow.COND ?? "";
            
            if (!discountPercent && formula) {
              const match = String(formula).match(/\*\s*\(\s*(\d+)\s*\/\s*100\s*\)/);
              if (match) {
                discountPercent = parseInt(match[1], 10);
              } else {
                const flatMatch = String(formula).match(/(\d+)/);
                if (flatMatch) discountPercent = parseInt(flatMatch[1], 10);
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
      const titleMatch = (code + " " + name).match(/(?:\s|-|^)(\d+)\s*(?:ADE|ADET|LI|Lİ|'Lİ|'LI)?(?:\s|-|$)/i);
      if (titleMatch) {
         parsedTargetQty = parseInt(titleMatch[1], 10);
      } else if (lineCondition) {
         const condMatch = lineCondition.match(/\*\s*\(\s*(\d+)\s*\/\s*100\s*\)/);
         if (condMatch) {
             parsedTargetQty = parseInt(condMatch[1], 10);
         }
      }

      productSkus = [...new Set(productSkus)].filter((s) => s !== "");

      campaigns.push({
        source_reference: ref,
        code: code || `CAMP-${ref}`,
        name: name || `Kampanya ${ref}`,
        description: normalizeString(row.NOTES ?? row.DESCRIPTION2 ?? null),
        customer_group: customerGroup,
        target_quantity: parsedTargetQty,
        discount_percent: discountPercent,
        group_field: "specode",
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
        `[logo-campaigns-sync] Kampanya: ${code} (grup: ${customerGroup ?? "hepsi"}, hedef: ${parsedTargetQty}, indirim: %${discountPercent ?? 0}, ürün: ${productSkus.length})`
      );
    }

    if (DRY_RUN) {
      console.log("[logo-campaigns-sync] DRY RUN — gönderilecek veri:");
      console.log(JSON.stringify({ campaigns }, null, 2));
      return;
    }

    // 2. B2B API'sine gönder
    const apiBase = config.apiBase;
    const apiKey = config.apiKey;

    console.log(`[logo-campaigns-sync] API'ye gönderiliyor: ${apiBase}/api/integrations/logo/campaigns/sync`);

    const response = await fetch(
      `${apiBase}/api/integrations/logo/campaigns/sync`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(apiKey ? { "X-Integration-Key": apiKey } : {}),
        },
        body: JSON.stringify({ campaigns }),
        signal: AbortSignal.timeout(30_000),
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "(body okunamadı)");
      throw new Error(
        `API yanıtı başarısız: HTTP ${response.status} — ${body}`
      );
    }

    const result = await response.json();
    console.log(
      `[logo-campaigns-sync] Tamamlandı: ${result.synced ?? 0} kampanya güncellendi.`
    );
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
      process.env.B2B_API_BASE ?? process.env.API_BASE ?? "http://localhost:8000"
    ).replace(/\/$/, ""),
    apiKey: nullable(process.env.B2B_API_KEY ?? process.env.LOGO_API_KEY),
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

function normalizeDate(value) {
  if (!value) return null;
  try {
    const d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function nullable(value) {
  const s = String(value ?? "").trim();
  return s === "" ? null : s;
}

function parseInteger(value) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseBoolean(value, fallback) {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "") return fallback;
  return ["1", "true", "yes", "on"].includes(s);
}
