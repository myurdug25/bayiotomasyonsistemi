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
  assert.match(productsSource, /OR \$\{groupedPricePredicate\}/);
  assert.match(productsSource, /LIKE 'F\[0-9\]%'/);
  assert.match(productsSource, /PERAKENDE/);
});

test("Logo conditional price rows are sent as campaign prices", () => {
  assert.match(productsSource, /buildLogoCampaignPrice/);
  assert.match(productsSource, /campaign_prices/);
  assert.match(productsSource, /FORMULA/);
  assert.match(productsSource, /MATHFORMULA/);
  assert.match(productsSource, /DISCPER/);
  assert.match(productsSource, /CONDQTY/);
  assert.match(productsSource, /price_group: priceGroupCode/);
  assert.match(productsSource, /logo_price_group: priceGroupCode/);
  assert.match(productsSource, /resolveLogoCampaignMinQuantity/);
  assert.doesNotMatch(productsSource, /if \(isLogoCampaignPriceRow\(row\)\) \{\s*continue;\s*\}/);
});

test("Logo F12 price rows are also sent as Batum special campaign prices", () => {
  assert.match(productsSource, /logoCampaignPriceReason/);
  assert.match(productsSource, /batum_f12_price/);
  assert.match(productsSource, /priceGroupCode === "F12"/);
  assert.match(productsSource, /Batum Size Ozel Fiyat/);
});

test("Logo price helper exports build Batum and conditional campaign prices from real PRCLIST rows", async () => {
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
  assert.equal(helpers.logoCampaignPriceReason(f12Row, "F12"), "batum_f12_price");
  assert.deepEqual(
    helpers.buildLogoCampaignPrice(f12Row, { list_price: 164.06, currency: "TRY", meta: {} }, "F12").name,
    "Batum Size Ozel Fiyat"
  );
  assert.equal(helpers.logoCampaignPriceReason(tierRow, "F12"), "conditional_price");
  assert.equal(helpers.resolveLogoCampaignMinQuantity(tierRow, tierRow.CONDITION), 5);
});
