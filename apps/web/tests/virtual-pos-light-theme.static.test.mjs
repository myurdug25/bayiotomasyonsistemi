import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const source = fs.readFileSync("src/components/virtual-pos/virtual-pos-page.tsx", "utf8");
const css = fs.readFileSync("src/app/globals.css", "utf8");

test("virtual pos exposes stable hooks for light theme polish", () => {
  [
    "virtual-pos-hero",
    "virtual-pos-status-badge",
    "virtual-pos-card-panel",
    "virtual-pos-card-header",
    "virtual-pos-card-preview",
    "virtual-pos-form-section",
    "virtual-pos-input",
    "virtual-pos-validation-message",
    "virtual-pos-actions-panel",
    "virtual-pos-whatsapp-button",
    "virtual-pos-print-button",
    "virtual-pos-start-button",
    "virtual-pos-summary-card",
    "virtual-pos-summary-tile",
    "virtual-pos-info-card",
    "virtual-pos-info-icon",
  ].forEach((className) => {
    assert.match(source, new RegExp(className));
  });
});

test("virtual pos light theme overrides are scoped and semantic", () => {
  assert.match(css, /\/\* Virtual POS light theme polish/);
  assert.match(css, /html\[data-ui-theme="light"\] \.app-shell-root \.virtual-pos-workspace/);
  assert.match(css, /\.virtual-pos-card-preview/);
  assert.match(css, /linear-gradient\(135deg, #14283f 0%, #17233a 48%, #611d31 100%\)/);
  assert.match(css, /\.virtual-pos-start-button:not\(:disabled\)/);
  assert.match(css, /\.virtual-pos-start-button:disabled/);
  assert.match(css, /\.virtual-pos-whatsapp-button:not\(:disabled\)/);
  assert.match(css, /\.virtual-pos-print-button:not\(:disabled\)/);
  assert.match(css, /\.virtual-pos-validation-message\[data-valid="false"\]/);
  assert.doesNotMatch(css, /html\[data-ui-theme="dark"\] \.app-shell-root \.virtual-pos-workspace/);
});
