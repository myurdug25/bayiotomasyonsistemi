import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const posSource = fs.readFileSync("src/components/pos/pos-page.tsx", "utf8");

test("POS uses applicable campaign tier price before adding products", () => {
  assert.match(posSource, /function resolveCampaignUnitPrice/);
  assert.match(posSource, /resolvePosProductUnitPrice\(product, qtyToAdd\)/);
  assert.match(posSource, /resolvePosProductUnitPrice\(pointDraftProduct, pointDraftQuantity\)/);
  assert.match(posSource, /resolvePosProductUnitPrice\(scopedProduct, 1\)/);
  assert.match(posSource, /resolvePosProductUnitPrice\(product, quickQty\)/);
  assert.doesNotMatch(posSource, /const fallbackUnitPrice = Number\(product\.net_price \?\? 0\)/);
});

test("Batum POS keeps Logo GEL prices net without VAT mode", () => {
  assert.match(posSource, /const pointSaleAppliesVat = Boolean\(selectedCustomer\) && !isBatumPointCurrencyScope && !selectedCustomerIsAnonymous/);
  assert.match(posSource, /const pointPriceIncludesVat = !isBatumPointCurrencyScope && pointSaleAppliesVat && isVatIncludedPointCustomer\(selectedCustomer\)/);
});

test("POS product search does not hold stale campaign prices", () => {
  assert.doesNotMatch(posSource, /staleTime: 5 \* 60_000/);
  assert.match(posSource, /staleTime: 0/);
});
