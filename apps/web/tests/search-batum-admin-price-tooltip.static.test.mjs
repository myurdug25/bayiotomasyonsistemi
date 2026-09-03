import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const productsSource = fs.readFileSync("src/components/products/products-page.tsx", "utf8");

test("admin-selected Batum customer can see search price hover cards", () => {
  assert.match(productsSource, /function customerCodeLooksLikeBatum/);
  assert.match(productsSource, /customerCodeLooksLikeBatum\(selectedCustomer\?\.code\)/);
  assert.match(productsSource, /const showPriceCardsOnSearch = isPointPanel \|\| isBatumPriceScope;/);
  assert.match(productsSource, /showRetailPriceHint=\{showPriceCardsOnSearch\}/);
  assert.doesNotMatch(productsSource, /showRetailPriceHint=\{isPointPanel\}/);
});
