import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const productsSource = fs.readFileSync("src/components/products/products-page.tsx", "utf8");

test("cart modal names single campaign tier as special price", () => {
  assert.match(productsSource, /tier\.min_quantity > 1 \? `\$\{tier\.min_quantity\} adet` : "Size özel fiyat"/);
  assert.doesNotMatch(productsSource, /tier\.min_quantity > 1 \? `\$\{tier\.min_quantity\}\+ adet` : "Tekli"/);
});

test("cart modal hides base sales price for Batum campaign-priced products", () => {
  assert.match(productsSource, /cartModalShowBaseSalesPrice\s*=\s*!\(isBatumPriceScope && cartModalCampaigns\.length > 0\)/);
  assert.match(productsSource, /cartModalShowBaseSalesPrice \? \(/);
});
