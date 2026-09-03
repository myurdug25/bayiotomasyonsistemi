import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("../src/components/returns/returns-page.tsx", import.meta.url), "utf8");
const globals = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

test("returns page exposes stable light-theme hooks without changing submit workflow", () => {
  [
    "returns-page",
    "returns-main-grid",
    "returns-panel returns-create-panel",
    "returns-panel-header",
    "returns-type-grid",
    "returns-type-card",
    "data-selected={active}",
    "aria-pressed={active}",
    "returns-workflow-strip",
    "returns-field",
    "returns-select-trigger",
    "returns-product-select-trigger",
    "returns-info-message",
    "returns-form-actions",
    "returns-reset-button",
    "returns-submit-button",
    "disabled:!bg-[#e7b9c0]",
    "disabled:!text-[#762f3a]",
    "disabled:!border-[#d29ca5]",
    "disabled:opacity-100",
    "returns-panel returns-requests-panel",
    "returns-filter-trigger",
    "returns-request-card",
    "returns-request-empty",
    "returns-status-badge",
    "returns-type-badge",
    "returns-pagination",
  ].forEach((snippet) => assert.match(component, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));

  [
    "const handleSubmit = () =>",
    "mutationFn: createReturnRequest",
    "request_type: requestType",
    "order_id: selectedOrder.id",
    "order_item_id: selectedOrderItem.id",
    "quantity: Math.max(1, Number(resolvedQuantity || 1))",
    "reason_code: resolvedReasonCode",
    "reason_note: reasonNote.trim() || undefined",
    "updateReturnRequestStatus(",
  ].forEach((snippet) => assert.match(component, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));
});

test("returns light theme polish is scoped to light mode", () => {
  [
    "/* Returns light theme polish */",
    'html[data-ui-theme="light"] .app-shell-root .returns-page',
    "--returns-page-bg: #f3f7f4",
    "--returns-green: #087a52",
    "--returns-red: #c60e28",
    "--returns-gold: #b68008",
    ".returns-panel",
    ".returns-type-card[data-selected=\"true\"]",
    ".returns-type-card[data-selected=\"false\"]",
    ".returns-workflow-strip",
    ".returns-field",
    ".returns-select-trigger",
    ".returns-product-select-trigger[aria-disabled=\"true\"]",
    ".returns-info-message",
    ".returns-reset-button:not(:disabled)",
    ".returns-submit-button:not(:disabled)",
    ".returns-submit-button:disabled",
    ".returns-requests-panel",
    ".returns-request-empty",
    ".returns-request-card",
  ].forEach((snippet) => assert.match(globals, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));

  assert.doesNotMatch(globals, /html\[data-ui-theme="dark"\]\s+\.app-shell-root\s+\.returns-page/);
});
