import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const productsSource = fs.readFileSync("src/components/products/products-page.tsx", "utf8");
const css = fs.readFileSync("src/app/globals.css", "utf8");

test("search page exposes stable hooks for light table polish", () => {
  [
    "product-search-button",
    "product-clear-button",
    "product-show-all-toggle",
    "product-results-table-head",
    "product-stock-header-cell",
    "product-info-header-cell",
    "product-cart-header-cell",
    "product-results-body",
    "product-results-status-row",
    "product-result-row",
    "product-sku-cell",
    "product-list-price-cell",
    "product-stock-cell",
    "product-info-button",
    "product-cart-button",
  ].forEach((className) => {
    assert.match(productsSource, new RegExp(className));
  });
});

test("search table stays compact without clipping stock shelf labels", () => {
  assert.match(productsSource, /function productBranchStockHeaderLabel/);
  assert.match(productsSource, /minWidth = Math\.max\(1200, 842 \+ stockColumnWidth\)/);
  assert.match(productsSource, /stockColumnWidth = Math\.min\(390, Math\.max\(300, normalizedStockColumnCount \* 66\)\)/);
  assert.match(css, /font-size:\s*11px !important/);
  assert.match(css, /font-size:\s*9\.75px !important/);
  assert.match(css, /white-space:\s*nowrap !important/);
  assert.match(css, /text-overflow:\s*clip !important/);
  assert.match(css, /width:\s*max-content !important/);
});

test("search light theme polish is scoped to light search page only", () => {
  assert.match(css, /\/\* Search page light table polish/);
  assert.match(css, /html\[data-ui-theme="light"\] \.app-shell-root \.admin-catalog-page/);
  assert.match(css, /\.admin-catalog-page \.product-results-table-head/);
  assert.match(css, /\.admin-catalog-page \.product-info-button:not\(:disabled\)/);
  assert.match(css, /\.admin-catalog-page \.product-cart-button:not\(:disabled\)/);
  assert.match(css, /\.admin-catalog-page \.product-search-button:not\(:disabled\)/);
  assert.match(css, /\.admin-catalog-page \.product-clear-button:not\(:disabled\)/);
  assert.match(css, /scrollbar-color:\s*#7b9187 #edf4f0 !important/);
  assert.match(css, /filter:\s*none !important/);
  assert.match(css, /text-shadow:\s*none !important/);
  assert.doesNotMatch(css, /html\[data-ui-theme="dark"\] \.app-shell-root \.admin-catalog-page/);
});
