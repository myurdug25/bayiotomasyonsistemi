import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const cartProviderSource = fs.readFileSync("src/components/cart/cart-provider.tsx", "utf8");
const cartPageSource = fs.readFileSync("src/components/cart/cart-page.tsx", "utf8");

test("cart checkout shortens open-account risk errors before showing them", () => {
  assert.match(cartProviderSource, /OPEN_ACCOUNT_RISK_LIMIT_MESSAGE/);
  assert.match(cartProviderSource, /normalizeCartErrorMessage/);
  assert.doesNotMatch(cartProviderSource, /Limit: %s TL/);
});

test("cart checkout does not append payment summary lines to order note", () => {
  assert.match(cartPageSource, /const checkoutNote = useMemo\(\(\) => \{/);

  const checkoutNoteBlock = cartPageSource.slice(
    cartPageSource.indexOf("const checkoutNote = useMemo"),
    cartPageSource.indexOf("const compactWarehouseTransferPanel")
  );

  assert.doesNotMatch(checkoutNoteBlock, /Ödeme tercihi:/);
  assert.doesNotMatch(checkoutNoteBlock, /Satış tipi:/);
  assert.doesNotMatch(checkoutNoteBlock, /Ekranda gösterilen ödeme tutarı:/);
});

test("cart checkout risk error is not rendered under the product list", () => {
  assert.doesNotMatch(cartPageSource, /\{error\s*\?\s*<p className="text-sm text-red-400">\{error\}<\/p>\s*:\s*null\}/);
});

test("warehouse transfer panel is hidden for ordinary customer carts", () => {
  assert.match(cartPageSource, /const shouldShowWarehouseTransferPanel =/);
  assert.match(cartPageSource, /shouldAutoEnableDepotTransfer \|\| depotTransferRequest \|\| isWarehouseOrderCustomer\(selectedCustomer\)/);
});

test("cart hides sale type selector for Batum branch and Batum customers", () => {
  assert.match(cartPageSource, /function isBatumCustomerIdentity/);
  assert.match(cartPageSource, /const isBatumSelectedCustomer = useMemo\(\(\) => isBatumCustomerIdentity\(selectedCustomer\), \[selectedCustomer\]\);/);
  assert.match(cartPageSource, /const shouldHideSaleTypeSelector = isBatumBranch \|\| isBatumSelectedCustomer;/);
  assert.match(cartPageSource, /const shouldShowSaleTypeSelector = !shouldHideSaleTypeSelector && !isTransferMode && allowedVatSummaryModes\.length > 0;/);
});

test("cart submit button does not submit surrounding forms", () => {
  assert.match(cartPageSource, /<Button\s+type="button"\s+className=\{cn\(\s*"h-full min-h-\[7rem\]/s);
  assert.match(cartPageSource, /sm:min-h-\[8\.5rem\]/);
});

test("cart submit keeps handled order errors from bubbling to the page", () => {
  const submitBlock = cartPageSource.slice(
    cartPageSource.indexOf("onClick={() => void (async () => {"),
    cartPageSource.indexOf("if (isWarehouseUser)")
  );

  assert.match(submitBlock, /try\s*\{\s*await createOrderFromCart\(/s);
  assert.match(submitBlock, /catch\s*\{\s*return;\s*\}/s);
});
