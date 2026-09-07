import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const productsSource = fs.readFileSync("src/components/products/products-page.tsx", "utf8");

test("cart modal names single campaign tier as special price", () => {
  assert.match(productsSource, /tier\.min_quantity > 1 \? `\$\{tier\.min_quantity\} adet` : "Size özel fiyat"/);
  assert.doesNotMatch(productsSource, /tier\.min_quantity > 1 \? `\$\{tier\.min_quantity\}\+ adet` : "Tekli"/);
});

test("cart modal hides base sales price for Batum campaign-priced products", () => {
  assert.match(productsSource, /cartModalShowBaseSalesPrice\s*=\s*!\(isBatumPriceScope && cartModalCampaigns\.length > 0\)/);
  assert.match(productsSource, /cartModalShowBaseSalesPrice \? \(/);
});

test("cart modal defaults prices to excluding VAT", () => {
  assert.match(productsSource, /const \[cartPricesIncludeVat, setCartPricesIncludeVat\] = useState\(false\)/);
  assert.doesNotMatch(productsSource, /useState\(isBatumPriceScope\)/);
});

test("cart modal VAT toggle also controls Batum campaign tier prices", () => {
  assert.match(
    productsSource,
    /formatCampaignTierPrice\(cartModalProduct, tier, cartPricesIncludeVat, isBatumPriceScope \? "GEL" : undefined\)/
  );
  assert.match(productsSource, /cartPricesIncludeVat \? "KDV Dahil" : "KDV Hariç"/);
  assert.doesNotMatch(productsSource, /isBatumPriceScope \? "Net fiyat"/);
});

test("Batum campaign rows derive list and hint prices from the campaign special price", () => {
  assert.match(productsSource, /function batumCampaignListPrice/);
  assert.match(productsSource, /batumCampaignUnitPrice\(product\)/);
  assert.match(productsSource, /return unitPrice === null \? null : unitPrice \* 2/);
  assert.match(productsSource, /const displayListPrice = batumDerivedListPrice/);
  assert.match(productsSource, /const retailPriceText = batumDerivedListPrice !== null/);
  assert.match(productsSource, /const masterPriceText = batumDerivedListPrice !== null/);
});
