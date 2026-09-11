import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const css = fs.readFileSync("src/app/globals.css", "utf8");

test("search results switch to card layout before tablet widths force horizontal scrolling", () => {
  assert.match(css, /\/\* Search results responsive card layout/);
  assert.match(
    css,
    /@media \(max-width: 1023px\)[\s\S]*\.admin-catalog-page \.product-results-scroll \{[\s\S]*?overflow:\s*visible !important;/,
  );
  assert.match(
    css,
    /@media \(max-width: 1023px\)[\s\S]*\.admin-catalog-page \.admin-product-row-grid \{[\s\S]*?grid-template-columns:\s*2\.4rem minmax\(0, 1fr\) auto auto !important;[\s\S]*?width:\s*100% !important;[\s\S]*?min-width:\s*0 !important;/,
  );
  assert.match(
    css,
    /@media \(max-width: 1023px\)[\s\S]*\.admin-catalog-page \.product-results-table-head \{\s*display:\s*none !important;/,
  );
});
