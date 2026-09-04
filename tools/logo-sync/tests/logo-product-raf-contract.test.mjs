import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(testDir, "..", "logo-products-sync.mjs"), "utf8");

test("product raf table supports Logo custom table parent reference columns", () => {
  const fetchRafBlock = source.match(/async function fetchProductRafAddresses[\s\S]+?const warehouseColumn = findColumn/)?.[0];
  const catalogRefsBlock = source.match(/async function fetchCatalogProductRefs[\s\S]+?if \(!referenceColumn\)/)?.[0];

  assert.ok(fetchRafBlock);
  assert.ok(catalogRefsBlock);
  assert.match(fetchRafBlock, /"PARENTREF"/);
  assert.match(fetchRafBlock, /"PARENT_LOGICALREF"/);
  assert.match(catalogRefsBlock, /"PARENTREF"/);
  assert.match(catalogRefsBlock, /"PARENT_LOGICALREF"/);
});

test("product raf table is auto-discovered from Logo firm extension table when not configured", () => {
  const schemaBlock = source.match(/const productRafSchema =[\s\S]+?if \(productRafSchema\)/)?.[0];
  const deriveBlock = source.match(/function derivePrimaryProductRafTableNames[\s\S]+?function derivePrimaryProductSubstituteTableNames/)?.[0];

  assert.ok(schemaBlock);
  assert.ok(deriveBlock);
  assert.match(schemaBlock, /resolveOptionalTableSchema\(/);
  assert.match(schemaBlock, /derivePrimaryProductRafTableNames\(config\.logo\.productTable\)/);
  assert.match(deriveBlock, /LG_XT1001_\$\{firmNo\}/);
});

test("warehouse shelf addresses do not fall back to one general raf for every warehouse", () => {
  const resolverBlock = source.match(/function resolveWarehouseShelfAddress[\s\S]+?function resolveShelfAddress/)?.[0];

  assert.ok(resolverBlock);
  assert.doesNotMatch(resolverBlock, /return resolveShelfAddress\(rawRecord\);/);
});
