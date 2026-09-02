# Mobile UI Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the B2B app usable and visually stable on mobile without reverting existing desktop styling or recent live fixes.

**Architecture:** Treat this as a responsive stabilization pass, not a redesign. Start from shared layout constraints, then fix the highest-traffic screens with focused CSS/class changes and small behavior guards where mobile overflow causes bad state.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS v4, shadcn/Radix UI, Sonner, static Node-based UI checks.

**Spec:** User request in current conversation: “mobil görünümünde sıkıntılar var planı oluştur ve başla.”

## Global Constraints

- Preserve existing dark/light theme language and do not overwrite previous user-approved visual work.
- Keep changes narrow and mobile-first; desktop should remain visually equivalent except where responsive constraints need shared class fixes.
- Do not introduce new dependencies.
- No live deploy until the user explicitly asks after local verification.
- Add or update focused static checks before production code changes where the behavior can be asserted from source.
- Validate with `npm run lint`, `npm run build`, and browser/mobile screenshot checks when practical.

---

### Task 1: Mobile Audit Map

**Files:**
- Read: `apps/web/src/components/layout/app-shell.tsx`
- Read: `apps/web/src/components/cart/cart-page.tsx`
- Read: `apps/web/src/components/collections/collections-page.tsx`
- Read: `apps/web/src/components/products/products-page.tsx`
- Read: `apps/web/src/components/pos/pos-page.tsx`
- Read: `apps/web/src/components/warehouse/*`
- Create: `apps/web/tests/mobile-layout.static.test.mjs`

**Interfaces:**
- Consumes: Existing Tailwind class strings and route components.
- Produces: Static checks that flag known mobile anti-patterns before fixes: fixed wide grids without overflow wrappers, oversized action panels, missing `min-w-0`, and mobile-hidden required controls.

- [x] **Step 1: Write static audit tests**

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("cart mobile checkout panel keeps send controls inside the viewport", () => {
  const source = read("src/components/cart/cart-page.tsx");
  assert.match(source, /grid-cols-\[minmax\(0,.*\)_/);
  assert.match(source, /min-w-0/);
  assert.doesNotMatch(source, /min-w-\[520px\].*GÖNDER/s);
});

test("collections recent panel uses compact mobile rows", () => {
  const source = read("src/components/collections/collections-page.tsx");
  assert.match(source, /collection-recent-panel/);
  assert.match(source, /max-h-\[.*dvh|overflow-y-auto/);
  assert.match(source, /min-w-0/);
});
```

- [x] **Step 2: Run the static tests and confirm at least one mobile expectation fails**

Run: `cd apps/web && node --test tests/mobile-layout.static.test.mjs`

Expected: FAIL until mobile classes are corrected.

### Task 2: App Shell Mobile Foundation

**Files:**
- Modify: `apps/web/src/components/layout/app-shell.tsx`
- Modify: `apps/web/src/app/globals.css`
- Test: `apps/web/tests/mobile-layout.static.test.mjs`

**Interfaces:**
- Consumes: Existing shell props, current user context, sidebar/navigation model.
- Produces: A viewport-safe mobile shell where header text truncates, action buttons do not wrap awkwardly, and content has predictable safe-area padding.

- [x] **Step 1: Add failing checks for shell constraints**

Static test additions:

```js
test("app shell has mobile safe-area and truncation guards", () => {
  const source = read("src/components/layout/app-shell.tsx");
  assert.match(source, /min-w-0/);
  assert.match(source, /truncate/);
  assert.match(source, /safe-area|dvh|overflow/);
});
```

- [x] **Step 2: Implement shell class fixes**

Use `min-w-0`, `truncate`, `max-w-full`, mobile `overflow-x-hidden`, and `pb-[env(safe-area-inset-bottom)]` where appropriate.

- [x] **Step 3: Re-run shell/static test**

Run: `cd apps/web && node --test tests/mobile-layout.static.test.mjs`

Expected: PASS for shell checks.

### Task 3: Cart Mobile Checkout Area

**Files:**
- Modify: `apps/web/src/components/cart/cart-page.tsx`
- Test: `apps/web/tests/cart-checkout-message.static.test.mjs`
- Test: `apps/web/tests/mobile-layout.static.test.mjs`

**Interfaces:**
- Consumes: Existing cart state, sales type, checkout submit mutation, order notes behavior.
- Produces: Mobile checkout area where `1-F / 2-0 / 3-B` controls and `GÖNDER` button fit without overflow, popup errors do not leave inline product-list messages, and submit never causes accidental page reload.

- [x] **Step 1: Extend failing tests for mobile send button layout and popup-only risk message**

Assert that risk messages are not rendered under the product list and submit button has `type="button"` or submit handler prevention where needed.

- [x] **Step 2: Fix layout**

Use a two-column mobile-safe grid: compact vertical sales-type selector on the left, flexible send button on the right, both with stable min/max heights.

- [x] **Step 3: Fix submit behavior**

Ensure click handlers call React mutations directly and any form wrapper uses `event.preventDefault()`.

- [x] **Step 4: Run cart tests**

Run: `cd apps/web && node --test tests/cart-checkout-message.static.test.mjs tests/mobile-layout.static.test.mjs`

Expected: PASS.

### Task 4: Collections Mobile Polish

**Files:**
- Modify: `apps/web/src/components/collections/collections-page.tsx`
- Test: `apps/web/tests/mobile-layout.static.test.mjs`

**Interfaces:**
- Consumes: Existing collection form, recent collections data, method tabs.
- Produces: A readable mobile collection page: recent collections are compact, scrollable, not visually heavy, and light mode colors remain legible.

- [x] **Step 1: Add failing checks for recent collections mobile classes**

Check for mobile compact row layout, bounded recent-list height, and no oversized nested card style.

- [x] **Step 2: Implement mobile row/card changes**

Keep one card level, reduce row padding/radius on mobile, keep amount/status aligned, and use theme variables instead of hard-coded dark-only colors where possible.

- [x] **Step 3: Run static test**

Run: `cd apps/web && node --test tests/mobile-layout.static.test.mjs`

Expected: PASS.

### Task 5: Product, POS, Warehouse Mobile Tables

**Files:**
- Modify: `apps/web/src/components/products/products-page.tsx`
- Modify: `apps/web/src/components/pos/pos-page.tsx`
- Modify: selected `apps/web/src/components/warehouse/*.tsx`
- Test: `apps/web/tests/mobile-layout.static.test.mjs`

**Interfaces:**
- Consumes: Existing tables, search controls, selection actions.
- Produces: Tables that either become compact cards on small screens or remain in clear horizontal scroll containers with stable controls.

- [x] **Step 1: Add source checks for table wrappers**

Detect `min-w-[...]` tables without nearby `overflow-x-auto` wrappers.

- [x] **Step 2: Fix high-risk tables only**

Prioritize product search, POS cart, warehouse orders, and shipment detail.

- [x] **Step 3: Run static test**

Run: `cd apps/web && node --test tests/mobile-layout.static.test.mjs`

Expected: PASS.

### Task 6: Browser QA and Build

**Files:**
- No production file expected unless QA finds regressions.

**Interfaces:**
- Consumes: Local Next.js app.
- Produces: Evidence that key mobile pages render without horizontal body overflow or clipped primary actions.

- [x] **Step 1: Run lint**

Run: `cd apps/web && npm run lint`

Result: FAIL on existing non-mobile files/rules (`server.cjs`, `pwa-install-prompt.tsx`, moderator finance/panel set-state-in-effect rules). Mobile files added in this pass were not the reported lint errors.

- [x] **Step 2: Run build**

Run: `cd apps/web && npm run build`

Result: PASS.

- [ ] **Step 3: Start local web server**

Run: `cd apps/web && npm run dev`

Expected: Local URL available.

- [ ] **Step 4: Mobile viewport QA**

Check at `390x844` and `430x932` for:
- `/cart`
- `/products`
- `/collections`
- `/orders`
- `/warehouse/orders`
- `/pos`

Expected: No body-level horizontal overflow, no clipped primary action, no unreadable light-mode controls.

### Task 7: Final Deploy Handoff

**Files:**
- Modify: deployment package only if user asks to deploy.

**Interfaces:**
- Consumes: Verified local changes.
- Produces: A concise deploy checklist or live deploy if authorized.

- [ ] **Step 1: Summarize changed files and verification**

Include exact files and commands.

- [ ] **Step 2: Ask for or use explicit deploy authorization**

If user says deploy/canlıya al, run the existing narrow deploy flow.
