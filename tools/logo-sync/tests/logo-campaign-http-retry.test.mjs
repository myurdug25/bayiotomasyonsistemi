import assert from "node:assert/strict";
import test from "node:test";

import { postCampaignSync } from "../campaign-sync-http.mjs";

test("campaign sync retries a throttled request using Retry-After", async () => {
  const calls = [];
  const delays = [];
  const responses = [
    new Response('{"message":"Too Many Attempts."}', {
      status: 429,
      headers: { "Retry-After": "2" },
    }),
    Response.json({ synced: 11 }),
  ];

  const result = await postCampaignSync({
    endpoint: "https://example.test/api/integrations/logo/campaigns/sync",
    apiKey: "test-key",
    campaigns: [{ source_reference: "1" }],
    timeoutMs: 5_000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
    sleepImpl: async (delayMs) => delays.push(delayMs),
  });

  assert.deepEqual(result, { synced: 11 });
  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [2_000]);
  assert.equal(calls[0].options.headers["X-Integration-Key"], "test-key");
});

test("campaign sync does not retry a validation failure", async () => {
  let calls = 0;

  await assert.rejects(
    postCampaignSync({
      endpoint: "https://example.test/api/integrations/logo/campaigns/sync",
      apiKey: "test-key",
      campaigns: [],
      timeoutMs: 5_000,
      fetchImpl: async () => {
        calls += 1;
        return new Response('{"message":"invalid"}', { status: 422 });
      },
      sleepImpl: async () => assert.fail("422 must not be retried"),
    }),
    /HTTP 422/
  );

  assert.equal(calls, 1);
});
