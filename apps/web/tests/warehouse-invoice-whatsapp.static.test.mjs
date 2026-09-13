import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const apiSource = fs.readFileSync("src/lib/api.ts", "utf8");
const whatsappSource = fs.readFileSync("src/lib/whatsapp.ts", "utf8");
const shipmentDetailSource = fs.readFileSync("src/components/warehouse/warehouse-shipment-detail-page.tsx", "utf8");

test("warehouse invoice share endpoint is exposed to the frontend", () => {
  assert.match(apiSource, /createWarehouseShipmentInvoiceShareLink/);
  assert.match(apiSource, /\/api\/warehouse\/shipments\/\$\{shipmentId\}\/print\/invoice\/share-link/);
  assert.match(apiSource, /method:\s*"POST"/);
});

test("warehouse shipment detail opens WhatsApp with the signed invoice link", () => {
  assert.match(whatsappSource, /https:\/\/wa\.me\/\$\{normalizedPhone\}\?text=\$\{encodedMessage\}/);
  assert.match(shipmentDetailSource, /createWarehouseShipmentInvoiceShareLink\(shipmentId\)/);
  assert.match(shipmentDetailSource, /buildWhatsAppTextUrl\(message,\s*currentCustomer\.phone\)/);
  assert.match(shipmentDetailSource, /WhatsApp Fatura/);
});
