import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const cartSource = fs.readFileSync("src/components/cart/cart-page.tsx", "utf8");

test("Batum cart rows display net unit and line prices while VAT stays in summary", () => {
  assert.doesNotMatch(cartSource, /batumVatMultiplier/);
  assert.match(cartSource, /const displayedUnitPrice = effectiveUnitPrice;/);
  assert.match(cartSource, /const displayedLineTotal = toAmount\(item\.line_total\);/);
});
