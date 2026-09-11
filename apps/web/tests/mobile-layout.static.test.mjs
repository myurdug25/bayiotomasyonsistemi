import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

function read(relativePath) {
  return fs.readFileSync(relativePath, "utf8");
}

const appShellSource = read("src/components/layout/app-shell.tsx");
const globalsSource = read("src/app/globals.css");
const cartPageSource = read("src/components/cart/cart-page.tsx");
const collectionsSource = read("src/components/collections/collections-page.tsx");
const ledgerSource = read("src/components/ledger/ledger-page.tsx");
const productsSource = read("src/components/products/products-page.tsx");
const posSource = read("src/components/pos/pos-page.tsx");
const virtualPosSource = read("src/components/virtual-pos/virtual-pos-page.tsx");
const warehouseOrdersSource = read("src/components/warehouse/warehouse-orders-page.tsx");

test("app shell root prevents body-level horizontal overflow on mobile routes", () => {
  assert.match(appShellSource, /app-shell-root[^"]*overflow-x-hidden/);
  assert.match(appShellSource, /page-shell-main[^"]*min-w-0/);
  assert.match(globalsSource, /\.app-content-region,\s*\.page-shell-main,\s*\.point-sale-fit-screen\s*\{[^}]*max-width: 100% !important;[^}]*min-width: 0 !important;[^}]*overflow-x: hidden;/s);
  assert.doesNotMatch(globalsSource, /\.app-content-region,\s*\.page-shell-main,\s*\.point-sale-fit-screen\s*\{[^}]*max-width: none !important;/s);
});

test("mobile header keeps customer and action content truncatable", () => {
  assert.match(appShellSource, /dashboard-header-actions[^"]*min-w-0/);
  assert.match(appShellSource, /header-selected-customer[^"]*min-w-0/);
});

test("mobile header does not stick to scroll or spill action buttons", () => {
  const mobileHeaderBlockStart = globalsSource.indexOf("/* Mobil üst bar:");
  const mobileHeaderBlockEnd = globalsSource.indexOf("/* Müşteri seçimi:", mobileHeaderBlockStart);
  const mobileHeaderBlock = globalsSource.slice(mobileHeaderBlockStart, mobileHeaderBlockEnd);

  assert.match(appShellSource, /page-shell-header[^"]*lg:sticky[^"]*lg:top-0/);
  assert.doesNotMatch(appShellSource, /page-shell-header sticky top-0/);
  assert.match(mobileHeaderBlock, /\.dashboard-header-center \{[\s\S]*?display: flex !important;/);
  assert.doesNotMatch(mobileHeaderBlock, /\.dashboard-header-center \{[\s\S]*?display: block !important;/);
  assert.doesNotMatch(mobileHeaderBlock, /\.dashboard-header-actions \{[\s\S]*?overflow: visible !important;/);
});

test("mobile header actions fill the row and use a two-row customer layout", () => {
  const mobileHeaderBlockStart = globalsSource.indexOf("/* Mobil üst bar:");
  const mobileHeaderBlockEnd = globalsSource.indexOf("/* Müşteri seçimi:", mobileHeaderBlockStart);
  const mobileHeaderBlock = globalsSource.slice(mobileHeaderBlockStart, mobileHeaderBlockEnd);

  assert.match(mobileHeaderBlock, /\.dashboard-header-actions \{[\s\S]*?display: grid !important;/);
  assert.match(mobileHeaderBlock, /\.dashboard-header-actions \{[\s\S]*?grid-template-columns: minmax\(2\.2rem, 1fr\) minmax\(2\.2rem, 1fr\) minmax\(6\.8rem, 2\.1fr\) minmax\(2\.2rem, 1fr\) minmax\(2\.2rem, 1fr\) !important;/);
  assert.match(mobileHeaderBlock, /\.dashboard-header-actions \{[\s\S]*?overflow-x: hidden !important;/);
  assert.match(mobileHeaderBlock, /\.header-notification-action \{[\s\S]*?margin-left: 0 !important;/);
  assert.doesNotMatch(mobileHeaderBlock, /\.header-notification-action \{[\s\S]*?order: 1000 !important;/);
  assert.match(mobileHeaderBlock, /\.header-customer-action-group \{[\s\S]*?display: contents !important;/);
  assert.match(mobileHeaderBlock, /\.dashboard-header-actions:has\(\.header-customer-select-button\) \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) minmax\(3\.4rem, 0\.52fr\) minmax\(2\.35rem, 0\.42fr\) !important;/);
  assert.match(mobileHeaderBlock, /\.dashboard-header-actions:has\(\.header-customer-select-button\) \.header-theme-switch \{[\s\S]*?grid-column: 1;/);
  assert.match(mobileHeaderBlock, /\.dashboard-header-actions:has\(\.header-customer-select-button\) \.header-notification-action \{[\s\S]*?grid-column: 3;/);
});

test("cart submit area uses a compact mobile height before desktop expansion", () => {
  assert.match(cartPageSource, /cart-submit-panel grid min-w-0 max-w-full/);
  assert.match(cartPageSource, /min-h-\[7rem\][^"]*sm:min-h-\[8\.5rem\][^"]*lg:min-h-\[13\.25rem\]/);
  assert.doesNotMatch(cartPageSource, /h-full min-h-\[8\.5rem\][^"]*whitespace-nowrap/);
  assert.match(globalsSource, /@media \(max-width: 640px\) \{[^}]*\.cart-submit-panel \{[^}]*min-height: auto;/s);
});

test("cart sale type rail is compact on mobile and expands later", () => {
  assert.match(cartPageSource, /grid-cols-\[3rem_minmax\(0,1fr\)\]/);
  assert.match(cartPageSource, /min-h-\[7rem\][^"]*sm:min-h-\[8\.5rem\]/);
});

test("collections recent panel uses theme surfaces instead of dark-only paint", () => {
  const recentPanelBlock = collectionsSource.slice(
    collectionsSource.indexOf("collection-recent-panel"),
    collectionsSource.indexOf("{selectedCustomer && displayRows.length > 0")
  );

  assert.doesNotMatch(recentPanelBlock, /bg-\[rgba\(8,18,27,0\.96\)\]/);
  assert.doesNotMatch(recentPanelBlock, /text-slate-500/);
  assert.match(recentPanelBlock, /bg-\[var\(--surface(?:-soft)?\)\]/);
  assert.match(recentPanelBlock, /max-h-\[min\(.*dvh/);
});

test("product results become cards on tablet and phone widths", () => {
  assert.match(productsSource, /admin-catalog-page min-w-0/);
  assert.match(globalsSource, /\/\* Search results responsive card layout/);
  assert.match(globalsSource, /@media \(max-width: 1023px\)[\s\S]*\.admin-catalog-page \.product-results-scroll \{[\s\S]*overflow:\s*visible !important;/);
  assert.match(globalsSource, /@media \(max-width: 1023px\)[\s\S]*\.admin-catalog-page \.admin-product-row-grid \{[\s\S]*width:\s*100% !important;[\s\S]*min-width:\s*0 !important;/);
});

test("search page does not promote depot transfer before customer selection", () => {
  assert.doesNotMatch(productsSource, /Depolar arası transfer için cari seçmeden ürün ekleyebilirsiniz\./);
  assert.match(productsSource, /Sepete ürün eklemek için önce müşteri seçin\./);
});

test("product add-to-cart modal stays compact on desktop", () => {
  assert.match(productsSource, /product-cart-dialog[^"]*max-w-\[min\(760px,calc\(100vw-16px\)\)\]/);
  assert.doesNotMatch(productsSource, /max-w-\[min\(980px,calc\(100vw-12px\)\)\]/);
});

test("ledger filters can wrap without refresh button overflow", () => {
  assert.match(ledgerSource, /ledger-filter-grid grid min-w-0 gap-2/);
  assert.match(ledgerSource, /ledger-filter-actions flex min-w-0 flex-wrap/);
  assert.match(globalsSource, /\.ledger-filter-strip \{[^}]*flex-wrap: wrap !important;/s);
});

test("point of sale cart table does not force body-level mobile overflow", () => {
  assert.match(posSource, /point-table max-w-full rounded-\[12px\] border/);
  assert.match(posSource, /visibleCartItems\.length === 0 \? "overflow-hidden" : "overflow-x-auto"/);
  assert.match(posSource, /point-sales-footer-scroll/);
});

test("point sale enter flow goes code to quantity to price to line", () => {
  assert.match(posSource, /const commitPointPriceInput = useCallback/);
  assert.match(posSource, /focusPointPriceInput\(\);/);
  assert.match(posSource, /const commitPointPriceInput = useCallback\([\s\S]*?addPointDraftLine\(\);/);
  assert.match(posSource, /event\.preventDefault\(\);\s*commitPointPriceInput\(\);/);
  assert.doesNotMatch(posSource, /ref=\{pointPriceInputRef\}[\s\S]{0,260}readOnly/);
});

test("virtual pos form avoids cramped medium screens", () => {
  assert.match(virtualPosSource, /virtual-pos-workspace/);
  assert.match(virtualPosSource, /virtual-pos-main-grid/);
  assert.match(virtualPosSource, /virtual-pos-form-grid/);
  assert.match(globalsSource, /@media \(max-width: 1280px\) \{[\s\S]*?\.virtual-pos-main-grid \{/);
  assert.match(globalsSource, /@media \(max-width: 1280px\) \{[\s\S]*?\.virtual-pos-form-grid \{/);
});

test("warehouse order filters keep mobile actions bounded", () => {
  assert.match(warehouseOrdersSource, /warehouse-filter-actions flex min-w-0 max-w-full/);
  assert.match(warehouseOrdersSource, /warehouse-mobile-orders/);
});
