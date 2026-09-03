import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const source = fs.readFileSync("src/components/pos/day-end-page.tsx", "utf8");
const css = fs.readFileSync("src/app/globals.css", "utf8");

test("day end page exposes stable hooks for the complete light theme surface", () => {
  [
    "day-end-stat-card",
    "day-end-panel-frame",
    "day-end-panel-header",
    "day-end-panel-body",
    "day-end-table-head",
    "day-end-table-row",
    "day-end-empty-state",
    "day-end-card-total",
    "day-end-detail-button",
    "day-end-expense-details-card",
    "day-end-expense-details-header",
    "day-end-expense-details-body",
    "day-end-summary-panel",
    "day-end-selected-date-card",
    "day-end-summary-group",
    "day-end-summary-row",
    "day-end-summary-value",
    "day-end-save-area",
    "day-end-save-button",
    "day-end-back-button",
    "day-end-today-button",
    "day-end-yesterday-button",
    "day-end-refresh-button",
    "day-end-return-sales-button",
  ].forEach((className) => {
    assert.match(source, new RegExp(className));
  });
});

test("day end light theme has scoped tokens and semantic component overrides", () => {
  assert.match(css, /\/\* POS day end light theme polish/);
  assert.match(css, /html\[data-ui-theme="light"\] \.app-shell-root \.pos-day-end-page/);
  assert.match(css, /--dayend-page-bg: #f2f6f3/);
  assert.match(css, /--dayend-green: #087a52/);
  assert.match(css, /--dayend-red: #ce1c2d/);
  assert.match(css, /--dayend-gold: #b68008/);

  [
    ".day-end-panel-frame",
    ".day-end-panel-header",
    ".day-end-panel-body",
    ".day-end-empty-state",
    ".day-end-card-total",
    ".day-end-expense-details-card",
    ".day-end-summary-panel",
    ".day-end-selected-date-card",
    ".day-end-save-button:not(:disabled)",
    ".day-end-save-button:disabled",
    ".day-end-back-button:not(:disabled)",
    ".day-end-refresh-button:not(:disabled)",
    ".day-end-return-sales-button",
  ].forEach((selector) => {
    assert.match(css, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  assert.doesNotMatch(css, /html\[data-ui-theme="dark"\] \.app-shell-root \.pos-day-end-page/);
});

test("day end light polish does not change finance and Logo integration functions", () => {
  [
    "function compactMoney",
    "function reportTableTotal",
    "function isBatumPointFlow",
    "function dayEndCurrencyLabel",
    "const closeSessionSubmit",
    "await savePosDayEnd",
    "cashOnHandTotal = cashSaleTotal + cashCollectionTotal - cashExpenseTotal - bankDepositTotal",
  ].forEach((snippet) => {
    assert.match(source, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});
