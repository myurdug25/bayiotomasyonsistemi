import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const collectionsSource = fs.readFileSync("src/components/collections/collections-page.tsx", "utf8");
const css = fs.readFileSync("src/app/globals.css", "utf8");

test("collections page exposes stable light-theme hooks", () => {
  [
    "collection-form-card",
    "collection-side-card",
    "collection-back-button",
    "collection-payment-method",
    "collection-choice-button",
    "collection-field-input",
    "collection-save-button",
    "collection-empty-state",
    "collection-edit-button",
    "collection-delete-button",
    "collection-actions-panel",
    "collection-whatsapp-button",
    "collection-print-button",
    "collection-send-button",
  ].forEach((className) => {
    assert.match(collectionsSource, new RegExp(className));
  });
});

test("collections payment cards are styled from real selected state", () => {
  assert.match(collectionsSource, /data-selected=\{method === value \? "true" : "false"\}/);
  assert.match(collectionsSource, /aria-pressed=\{method === value\}/);
  assert.match(css, /\.collection-payment-method\[data-selected="true"\]/);
  assert.match(css, /\.collection-payment-method\[data-selected="false"\]/);
  assert.match(css, /linear-gradient\(180deg, #ff4b4f 0%, #d71920 58%, #a50c12 100%\)/);
});

test("collections light polish keeps semantic action colors readable", () => {
  assert.match(css, /\/\* Collections light theme polish/);
  assert.match(css, /html\[data-ui-theme="light"\] \.app-shell-root \.admin-collections-page/);
  assert.match(css, /\.collection-save-button:not\(:disabled\)/);
  assert.match(css, /\.collection-send-button:not\(:disabled\)/);
  assert.match(css, /\.collection-whatsapp-button:not\(:disabled\)/);
  assert.match(css, /\.collection-print-button:not\(:disabled\)/);
  assert.match(css, /\.collection-delete-button:not\(:disabled\)/);
  assert.match(css, /linear-gradient\(180deg, #17392f 0%, #071d18 100%\)/);
  assert.doesNotMatch(css, /html\[data-ui-theme="dark"\] \.app-shell-root \.admin-collections-page/);
});
