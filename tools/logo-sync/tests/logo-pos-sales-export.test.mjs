import assert from "node:assert/strict";
import test from "node:test";

import { buildPosSalePayload } from "../logo-pos-sales-export.mjs";

test("buildPosSalePayload keeps Logo sales dispatch metadata for POS delivery notes", () => {
  const payload = buildPosSalePayload({
    pos_sale_id: 42,
    document_type: "delivery",
    cashbox_id: null,
    cashbox_code: "100.01.002",
    cashbox_name: "BATUM POINT KASASI",
    logo: {
      document_target: "sales_dispatch_note",
      trcode: 8,
      target_tables: ["STFICHE", "STLINE"],
    },
    items: [
      {
        product_code: "POS-TEST-001",
        qty: "1.000",
      },
    ],
    payments: [
      {
        method: "cash",
        amount: "100.00",
      },
    ],
    meta: {
      cashbox: {
        code: "100.01.002",
      },
    },
  });

  assert.equal(payload.document_type, "delivery");
  assert.deepEqual(payload.logo, {
    document_target: "sales_dispatch_note",
    trcode: 8,
    target_tables: ["STFICHE", "STLINE"],
  });
  assert.deepEqual(payload.items, [{ product_code: "POS-TEST-001", qty: "1.000" }]);
  assert.deepEqual(payload.payments, [{ method: "cash", amount: "100.00" }]);
});

test("buildPosSalePayload carries update metadata for existing Logo delivery notes", () => {
  const payload = buildPosSalePayload({
    pos_sale_id: 43,
    document_type: "delivery",
    logo: {
      document_target: "sales_dispatch_note",
      existing_external_ref: "STFICHE-12345",
      operation: "update",
    },
    items: [],
    payments: [],
    meta: {
      logo_external_ref: "STFICHE-12345",
      operation: "update",
    },
  });

  assert.equal(payload.logo.existing_external_ref, "STFICHE-12345");
  assert.equal(payload.logo.operation, "update");
  assert.equal(payload.meta.logo_external_ref, "STFICHE-12345");
});
