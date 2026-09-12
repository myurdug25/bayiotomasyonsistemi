import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const productsSource = fs.readFileSync(
  path.join(root, "logo-products-sync.mjs"),
  "utf8"
);
const daemonSource = fs.readFileSync(
  path.join(root, "logo-sync-daemon.mjs"),
  "utf8"
);

test("catalog sync follows recently modified Logo price rows", () => {
  assert.match(productsSource, /fetchCatalogPriceRefs/);
  assert.match(productsSource, /CAPIBLOCK_MODIFIEDDATE/);
  assert.match(productsSource, /SYNC_PRODUCTS_PRICE_LOOKBACK_MINUTES/);
  assert.match(productsSource, /catalog incremental added .* price refresh/);
});

test("catalog price refresh includes modified F-group and GEL price rows", () => {
  const fetchCatalogPriceRefsSource = productsSource.match(
    /async function fetchCatalogPriceRefs[\s\S]*?\n}\n\nasync function /
  )?.[0] ?? "";

  assert.match(fetchCatalogPriceRefsSource, /buildLogoGroupedPricePredicate\(priceSchema\.columns\)/);
  assert.match(fetchCatalogPriceRefsSource, /buildLogoGelCurrencyPredicate\(currencyColumn\)/);
  assert.match(fetchCatalogPriceRefsSource, /buildLogoConditionalPricePredicate\(priceSchema\.columns\)/);
  assert.match(fetchCatalogPriceRefsSource, /alternatePricePredicates/);
  assert.match(fetchCatalogPriceRefsSource, /OR \$\{alternatePricePredicates\.join\(" OR "\)\}/);
});

test("maintenance sync defaults to one minute", () => {
  assert.match(
    daemonSource,
    /SYNC_DAEMON_MAINTENANCE_INTERVAL_MS", 60_000/
  );
});

test("full product sync splits heavy API payloads to avoid request timeouts", () => {
  assert.match(productsSource, /SYNC_API_REQUEST_MAX_RECORDS/);
  assert.match(productsSource, /SYNC_API_REQUEST_MAX_ALIASES/);
  assert.match(productsSource, /pushBatchAdaptively\(records, config, \{/);
  assert.match(productsSource, /partitionApiRequests/);
  assert.doesNotMatch(productsSource, /endpoint timeout/);
});

test("full catalog sync marks the final API request as authoritative", () => {
  assert.match(productsSource, /shouldSendAuthoritativeCatalogSnapshot/);
  assert.match(productsSource, /sync_run_id/);
  assert.match(productsSource, /is_full_sync/);
  assert.match(productsSource, /is_final_batch/);
  assert.match(productsSource, /syncState\.sync_run_id = authoritativeSyncRunId/);
  assert.match(productsSource, /index === requestChunks\.length - 1/);
});

test("Logo price rows read customer special-code fields as F group prices", () => {
  assert.match(productsSource, /CLSPECODE5/);
  assert.match(productsSource, /CLSPECODE4/);
  assert.match(productsSource, /CLSPECODE3/);
  assert.match(productsSource, /CLSPECODE2/);
});

test("Logo price type filter still includes customer-group sales price rows", () => {
  assert.match(productsSource, /buildLogoGroupedPricePredicate/);
  assert.match(productsSource, /groupedPricePredicate/);
  assert.match(productsSource, /alternatePricePredicates/);
  assert.match(productsSource, /LIKE 'F\[0-9\]%'/);
  assert.match(productsSource, /PERAKENDE/);
});

test("Logo conditional price rows are sent as campaign prices", () => {
  assert.match(productsSource, /buildLogoCampaignPrice/);
  assert.match(productsSource, /campaign_prices/);
  assert.match(productsSource, /buildLogoGelCurrencyPredicate/);
  assert.match(productsSource, /FORMULA/);
  assert.match(productsSource, /MATHFORMULA/);
  assert.match(productsSource, /DISCPER/);
  assert.match(productsSource, /CONDQTY/);
  assert.match(productsSource, /price_group: priceGroupCode/);
  assert.match(productsSource, /logo_price_group: priceGroupCode/);
  assert.match(productsSource, /resolveLogoCampaignMinQuantity/);
  assert.doesNotMatch(productsSource, /if \(isLogoCampaignPriceRow\(row\)\) \{\s*continue;\s*\}/);
});

test("plain Logo F12 price rows are not sent as Batum campaign prices", async () => {
  const helpers = await import("../logo-products-sync.mjs?test=campaign-price-helpers");
  const row = {
    LOGICALREF: 170407,
    CARDREF: 9420,
    PRICE: 120,
    CURRENCY: 0,
    CLSPECODE5: "F12",
    CYPHCODE: "F12",
  };
  const price = {
    list_price: "120.0000",
    currency: "TRY",
    price_list_code: "F12",
    meta: { priority: 0 },
  };

  assert.match(productsSource, /logoCampaignPriceReason/);
  assert.equal(helpers.logoCampaignPriceReason(row, "F12", price.currency), null);
});

test("product sync sends empty campaign price snapshots so stale PRCLIST campaigns deactivate", () => {
  assert.match(productsSource, /Array\.isArray\(priceSnapshot\?\.campaign_prices\)/);
  assert.doesNotMatch(
    productsSource,
    /Array\.isArray\(priceSnapshot\?\.campaign_prices\) && priceSnapshot\.campaign_prices\.length > 0/
  );
  assert.match(productsSource, /record\.campaign_prices = priceSnapshot\.campaign_prices/);
});

test("Logo price helper keeps plain F12 as list price and builds conditional tiers from real PRCLIST rows", async () => {
  const helpers = await import("../logo-products-sync.mjs?test=campaign-price-helpers");
  const f12Row = {
    LOGICALREF: 105456,
    CARDREF: 61,
    PRICE: 164.06,
    CURRENCY: 0,
    CLSPECODE5: "F12",
    CYPHCODE: "F12",
    BEGDATE: new Date("2026-09-03T00:00:00Z"),
    ENDDATE: new Date("2030-12-31T00:00:00Z"),
  };
  const tierRow = {
    LOGICALREF: 900016,
    CARDREF: 61,
    PRICE: 200,
    CURRENCY: 0,
    CLSPECODE5: "F12",
    CONDQTY: 5,
    CONDITION: "p1>4",
  };

  assert.equal(helpers.resolveLogoPriceGroupCode(f12Row), "F12");
  assert.equal(helpers.logoCampaignPriceReason(f12Row, "F12", "TRY"), null);
  assert.equal(helpers.logoCampaignPriceReason(tierRow, "F12", "TRY"), "conditional_price");
  assert.equal(helpers.resolveLogoCampaignMinQuantity(tierRow, tierRow.CONDITION), 5);

  const tierPrice = {
    list_price: "200.0000",
    currency: "TRY",
    price_list_code: "F12",
    meta: { priority: 0 },
  };
  const campaignPrice = helpers.buildLogoCampaignPrice(tierRow, tierPrice, "F12");

  assert.equal(campaignPrice.unit_price, "200.0000");
  assert.equal(campaignPrice.currency, "GEL");
});

test("Logo price sync fetches workplace conditional PRCLIST rows even without price group codes", () => {
  assert.match(productsSource, /function buildLogoConditionalPricePredicate/);
  assert.match(productsSource, /conditionalPricePredicate/);
  assert.match(
    productsSource,
    /alternatePricePredicates = \[groupedPricePredicate, gelCurrencyPredicate, conditionalPricePredicate\]/
  );
});

test("Logo conditional price helper treats P1 equals conditions as quantity thresholds", async () => {
  const helpers = await import("../logo-products-sync.mjs?test=campaign-price-helpers");
  const row = {
    LOGICALREF: 131625160,
    CARDREF: 417,
    PRICE: 75.22,
    CURRENCY: 0,
    CODE: "WUNDER_131625^160",
    OFFICE: "002",
    CONDITION: "P1=60",
  };

  assert.equal(helpers.logoCampaignPriceReason(row, null, "TRY"), "conditional_price");
  assert.equal(helpers.resolveLogoCampaignMinQuantity(row, row.CONDITION), 60);
});

test("Logo price sync preserves PRCLIST row identity metadata for branch debugging", () => {
  assert.match(productsSource, /price_code: normalizeString\(readFirst\(row, \["CODE", "code"\]\)\)/);
  assert.match(productsSource, /price_definition: normalizeString\(readFirst\(row, \["DEFINITION_", "DEFINITION", "NAME"\]\)\)/);
  assert.match(productsSource, /price_explanation: normalizeString\(readFirst\(row, \[/);
});

test("Logo GEL price rows without F group are sent as Batum special prices", async () => {
  const helpers = await import("../logo-products-sync.mjs?test=campaign-price-helpers");
  const row = {
    LOGICALREF: 170401,
    CARDREF: 7574,
    PRICE: 15,
    CURRENCY: "GEL",
    CODE: "WUNDER_105456_001",
    BEGDATE: new Date("2026-09-03T00:00:00Z"),
    ENDDATE: new Date("2026-12-31T00:00:00Z"),
  };
  const price = {
    list_price: "15.0000",
    currency: "GEL",
    price_list_code: null,
    meta: { logicalref: "170401", priority: 0 },
  };

  assert.equal(helpers.resolveLogoPriceGroupCode(row), null);
  assert.equal(helpers.logoCampaignPriceReason(row, null, price.currency), "batum_gel_price");

  const campaignPrice = helpers.buildLogoCampaignPrice(row, price, null, {
    campaignPriceReason: "batum_gel_price",
  });

  assert.equal(campaignPrice.name, "Batum Size Ozel Fiyat");
  assert.equal(campaignPrice.min_quantity, 1);
  assert.equal(campaignPrice.unit_price, "15.0000");
  assert.equal(campaignPrice.currency, "GEL");
  assert.equal(campaignPrice.meta.price_group, "BATUM");
});

test("Logo F12 GEL price rows are sent as Batum special prices", async () => {
  const helpers = await import("../logo-products-sync.mjs?test=campaign-price-helpers");
  const row = {
    LOGICALREF: 131624000,
    CARDREF: 7574,
    PRICE: 15,
    CURRENCY: "GEL",
    BRANCH: 3,
    CODE: "WUNDER_131624_000",
    CLSPECODE5: "F12",
    CYPHCODE: "F12",
    BEGDATE: new Date("2026-09-03T00:00:00Z"),
    ENDDATE: new Date("2026-12-31T00:00:00Z"),
  };
  const price = {
    list_price: "15.0000",
    currency: "GEL",
    price_list_code: "F12",
    meta: { logicalref: "131624000", priority: 0 },
  };

  assert.equal(helpers.resolveLogoPriceGroupCode(row), "F12");
  assert.equal(helpers.logoCampaignPriceReason(row, "F12", price.currency), "batum_gel_price");

  const campaignPrice = helpers.buildLogoCampaignPrice(row, price, "F12", {
    campaignPriceReason: "batum_gel_price",
  });

  assert.equal(campaignPrice.name, "Batum Size Ozel Fiyat");
  assert.equal(campaignPrice.min_quantity, 1);
  assert.equal(campaignPrice.unit_price, "15.0000");
  assert.equal(campaignPrice.currency, "GEL");
  assert.equal(campaignPrice.branch, 4);
  assert.equal(campaignPrice.meta.branch_code, "BATUM");
  assert.equal(campaignPrice.meta.price_group, "BATUM");
  assert.equal(campaignPrice.meta.logo_price_group, "F12");
});
