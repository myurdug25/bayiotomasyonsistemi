import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const source = fs.readFileSync("src/components/mal-kabul/mal-kabul-workspace-page.tsx", "utf8");
const css = fs.readFileSync("src/app/globals.css", "utf8");

test("mal kabul route exposes stable hooks for its light theme surface", () => {
  [
    "mal-kabul-shell",
    "mal-kabul-info-card",
    "mal-kabul-stat-card",
    "mal-kabul-left-panel",
    "mal-kabul-right-panel",
    "mal-kabul-panel-heading",
    "mal-kabul-send-all-button",
    "mal-kabul-send-selected-button",
    "mal-kabul-count-badge",
    "mal-kabul-waiting-table",
    "mal-kabul-waiting-header",
    "mal-kabul-waiting-row",
    "mal-kabul-accepted-row",
    "mal-kabul-empty-state",
    "mal-kabul-save-area",
    "mal-kabul-save-button",
    "mal-kabul-save-note",
  ].forEach((className) => {
    assert.match(source, new RegExp(className));
  });
});

test("mal kabul light theme uses scoped semantic surfaces and actions", () => {
  assert.match(css, /\/\* Mal kabul light theme polish/);
  assert.match(css, /html\[data-ui-theme="light"\] \.app-shell-root \.mal-kabul-workspace/);
  assert.match(css, /--mal-kabul-page-bg: #f3f7f4/);
  assert.match(css, /--mal-kabul-green: #087a52/);
  assert.match(css, /--mal-kabul-red: #c60e28/);
  assert.match(css, /--mal-kabul-gold: #b68008/);

  [
    ".mal-kabul-info-card",
    ".mal-kabul-stat-card",
    ".mal-kabul-left-panel",
    ".mal-kabul-right-panel",
    ".mal-kabul-empty-state",
    ".mal-kabul-send-all-button:not(:disabled)",
    ".mal-kabul-send-selected-button:disabled",
    ".mal-kabul-save-button:not(:disabled)",
    ".mal-kabul-save-button:disabled",
    ".mal-kabul-save-note",
  ].forEach((selector) => {
    assert.match(css, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  assert.doesNotMatch(css, /html\[data-ui-theme="dark"\] \.app-shell-root \.mal-kabul-workspace/);
});

test("mal kabul light polish does not change transfer or Logo submit logic", () => {
  [
    "const moveAllRight",
    "const moveSelectedRight",
    "const moveRight",
    "const moveLeft",
    "const save = () =>",
    "approveMutation.mutate(activeReceipt)",
  ].forEach((snippet) => {
    assert.match(source, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});
