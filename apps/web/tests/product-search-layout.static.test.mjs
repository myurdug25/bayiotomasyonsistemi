import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");
const css = fs.readFileSync(path.join(webRoot, "src", "app", "globals.css"), "utf8");

test("product search desktop rows leave room for action badges in light mode", () => {
  assert.match(css, /html\[data-ui-theme="light"\][\s\S]*?\.admin-catalog-page \.admin-product-row-grid[\s\S]*?min-height:\s*42px !important/);
  assert.match(css, /html\[data-ui-theme="light"\][\s\S]*?\.admin-catalog-page \.admin-product-row-grid \[role="cell"\][\s\S]*?height:\s*42px !important/);
});

test("product search info popover rises above sticky action columns", () => {
  assert.match(css, /\.admin-catalog-page \.admin-product-row-grid:has\(details\[open\]\)/);
  assert.match(css, /\.admin-catalog-page \.product-info-action-cell:has\(details\[open\]\)/);
  assert.match(css, /\.admin-catalog-page \.product-info-popover/);
});
