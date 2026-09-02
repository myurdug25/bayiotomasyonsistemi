import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cartPagePath = path.join(rootDir, "apps", "web", "src", "components", "cart", "cart-page.tsx");
const orderControllerPath = path.join(rootDir, "apps", "api", "app", "Http", "Controllers", "Api", "OrderController.php");

test("cart shows role default sales type choices instead of forcing every checkout to 1-F", () => {
  const source = fs.readFileSync(cartPagePath, "utf8");

  assert.doesNotMatch(source, /const\s+shouldShowSaleTypeSelector\s*=\s*false\s*;/);
  assert.doesNotMatch(source, /const\s+effectiveVatSummaryMode:\s*VatSummaryMode\s*=\s*"detailed"\s*;/);
  assert.doesNotMatch(source, /\(\):\s*VatSummaryMode\s*=>\s*"detailed"/);
  assert.match(source, /roleSlugSet\.has\("salesperson"\)[\s\S]*\["detailed",\s*"included"\]/);
  assert.match(source, /isCustomerUser[\s\S]*\["excluded"\]/);
});

test("order backend defaults salesperson to 1-F and 3-B, customer users to 2-0", () => {
  const source = fs.readFileSync(orderControllerPath, "utf8");

  assert.match(source, /hasRole\('customer'\)[\s\S]*return\s+\['excluded'\]/);
  assert.match(source, /hasRole\('salesperson'\)[\s\S]*return\s+\['detailed',\s*'included'\]/);
  assert.doesNotMatch(source, /customerUser\s+instanceof\s+User[\s\S]{0,160}return\s+\['excluded'\]/);
});
