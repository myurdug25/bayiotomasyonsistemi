import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("../src/components/warehouse/rack-addresses-page.tsx", import.meta.url), "utf8");
const globals = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

test("rack addresses page exposes stateful light-theme hooks without changing update payloads", () => {
  [
    "rack-addresses-page",
    "rack-address-hero",
    "rack-hero-icon",
    "rack-branch-badge",
    "rack-permission-badge",
    "rack-toolbar",
    "rack-search-input",
    "rack-warehouse-select",
    "rack-equivalent-toggle",
    "rack-save-all-button",
    "disabled:!bg-[#e7b9c0]",
    "disabled:!text-[#762f3a]",
    "disabled:!border-[#d29ca5]",
    "rack-address-table",
    "rack-address-table-header",
    "rack-address-table-body",
    "rack-address-row",
    "data-changed={changed}",
    "rack-product-code",
    "rack-product-name",
    "rack-product-brand",
    "rack-text-cell",
    "rack-current-address",
    "rack-new-input",
    "rack-row-save-button",
    "aria-label=\"Bu satırdaki raf adresini kaydet\"",
    "title=\"Bu satırdaki raf adresini kaydet\"",
    "disabled:!bg-[#e7eeea]",
    "disabled:!text-[#5f7469]",
    "disabled:!border-[#c6d4cc]",
    "rack-empty-state",
  ].forEach((snippet) => assert.match(component, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));

  [
    "updateWarehouseShelf(product.id, {",
    "warehouse_code: product.warehouse_code",
    "shelf_address: shelfAddress.trim() || null",
    "onClick={() => updateMutation.mutate({ product, shelfAddress: draftValue })}",
    "onClick={() => bulkUpdateMutation.mutate()}",
    "listWarehouseShelves({",
    "include_equivalents: includeEquivalents ? true : undefined",
  ].forEach((snippet) => assert.match(component, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));
});

test("rack addresses light theme polish is scoped and covers buttons table rows inputs and mobile cards", () => {
  [
    "/* Rack addresses light theme polish */",
    'html[data-ui-theme="light"] .app-shell-root .rack-addresses-page',
    "--rack-page-bg: #f3f7f4",
    "--rack-green: #087a52",
    "--rack-red: #c60e28",
    "--rack-gold: #b68008",
    ".rack-address-hero",
    ".rack-hero-icon",
    ".rack-branch-badge",
    ".rack-permission-badge",
    ".rack-toolbar",
    ".rack-search-input",
    ".rack-warehouse-select",
    ".rack-equivalent-toggle",
    ".rack-save-all-button:not(:disabled)",
    ".rack-save-all-button:disabled",
    ".rack-address-table",
    ".rack-address-table-header",
    ".rack-address-row",
    ".rack-address-row[data-changed=\"true\"]",
    ".rack-product-code",
    ".rack-product-name",
    ".rack-text-cell",
    ".rack-current-address",
    ".rack-new-input",
    ".rack-row-save-button:not(:disabled)",
    ".rack-row-save-button:disabled",
    ".rack-row-save-button svg",
    ".rack-empty-state",
    "@media (max-width: 767px)",
  ].forEach((snippet) => assert.match(globals, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));

  assert.doesNotMatch(globals, /html\[data-ui-theme="dark"\]\s+\.app-shell-root\s+\.rack-addresses-page/);
});
