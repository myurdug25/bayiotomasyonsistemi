import assert from "node:assert/strict";
import test from "node:test";

import { sendLedgerRecords } from "../eryaz-ledger-http.mjs";

test("Eryaz ledger sender splits retryable gateway timeout batches and continues", async () => {
  const payloadSizes = [];
  const records = [
    { external_ref: "ERYAZLED|2019|1" },
    { external_ref: "ERYAZLED|2019|2" },
    { external_ref: "ERYAZLED|2019|3" },
  ];

  const sent = await sendLedgerRecords(records, {
    url: "https://example.test/integrations/logo/ledger/sync",
    key: "secret",
    dealerId: 1,
    batchSize: 3,
    minBatchSize: 1,
    retryMax: 0,
    retryBaseDelayMs: 1,
    sleep: async () => {},
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body);
      payloadSizes.push(payload.records.length);

      if (payload.records.length > 1) {
        return {
          ok: false,
          status: 504,
          text: async () => "Gateway Time-out",
        };
      }

      return {
        ok: true,
        status: 200,
        text: async () => "{}",
      };
    },
    log: () => {},
  });

  assert.equal(sent, 3);
  assert.deepEqual(payloadSizes, [3, 2, 1, 1, 1]);
});

test("Eryaz ledger sender treats fetch timeout failures as retryable", async () => {
  const payloadSizes = [];
  const records = [
    { external_ref: "ERYAZLED|2019|1" },
    { external_ref: "ERYAZLED|2019|2" },
  ];

  const sent = await sendLedgerRecords(records, {
    url: "https://example.test/integrations/logo/ledger/sync",
    key: "secret",
    dealerId: 1,
    batchSize: 2,
    minBatchSize: 1,
    retryMax: 0,
    retryBaseDelayMs: 1,
    sleep: async () => {},
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body);
      payloadSizes.push(payload.records.length);

      if (payload.records.length > 1) {
        const cause = new Error("headers timeout");
        cause.code = "UND_ERR_HEADERS_TIMEOUT";
        throw new TypeError("fetch failed", { cause });
      }

      return {
        ok: true,
        status: 200,
        text: async () => "{}",
      };
    },
    log: () => {},
  });

  assert.equal(sent, 2);
  assert.deepEqual(payloadSizes, [2, 1, 1]);
});

test("Eryaz ledger sender reports successful batch progress", async () => {
  const sentSizes = [];

  const sent = await sendLedgerRecords([
    { external_ref: "ERYAZLED|2019|1" },
    { external_ref: "ERYAZLED|2019|2" },
  ], {
    url: "https://example.test/integrations/logo/ledger/sync",
    key: "secret",
    dealerId: 1,
    batchSize: 1,
    minBatchSize: 1,
    retryMax: 0,
    retryBaseDelayMs: 1,
    sleep: async () => {},
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => "{}",
    }),
    onBatchSent: (size) => sentSizes.push(size),
  });

  assert.equal(sent, 2);
  assert.deepEqual(sentSizes, [1, 1]);
});
