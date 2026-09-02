import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const orderPrintSource = fs.readFileSync("src/app/(print)/warehouse/orders/[id]/print/page.tsx", "utf8");
const apiSource = fs.readFileSync("src/lib/api.ts", "utf8");

test("warehouse order print uses target warehouse stock instead of hard-coded Erzurum stock", () => {
  assert.match(orderPrintSource, /function resolvePrintWarehouse/);
  assert.match(orderPrintSource, /function warehouseStockLabel/);
  assert.match(orderPrintSource, /function printWarehouseStock/);
  assert.match(orderPrintSource, /print_warehouse_available_total/);
  assert.doesNotMatch(orderPrintSource, /<th className="w-\[18mm\] text-center">Erz\. Stok<\/th>/);
  assert.doesNotMatch(orderPrintSource, /function erzurumDepoStock/);
});

test("order detail type exposes target warehouse stock for print forms", () => {
  assert.match(apiSource, /target_warehouse_code\?: string \| null;/);
  assert.match(apiSource, /target_warehouse_name\?: string \| null;/);
  assert.match(apiSource, /print_warehouse_code\?: string \| null;/);
  assert.match(apiSource, /print_warehouse_name\?: string \| null;/);
  assert.match(apiSource, /print_warehouse_available_total\?: number \| null;/);
});
