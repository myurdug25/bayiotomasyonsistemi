import assert from "node:assert/strict";
import test from "node:test";

import { resolveCampaignCustomerGroup } from "../campaign-customer-group.mjs";

test("prefers an explicit F1-F12 group over numeric Logo client type", () => {
  assert.deepEqual(
    resolveCampaignCustomerGroup(
      {
        CLTYPE: 3,
        CLSPECODE: "F1",
      },
      "KMP-001",
      "F1 müşterileri kampanyası"
    ),
    { group: "F1", source: "clspecode" }
  );
});

test("finds the F group from campaign code or name when Logo group columns are empty", () => {
  assert.deepEqual(
    resolveCampaignCustomerGroup({}, "KMP-F3-YAZ", "Yaz kampanyası"),
    { group: "F3", source: "campaign_code" }
  );
});

test("finds Batum campaign group from campaign code or name when Logo group columns are empty", () => {
  assert.deepEqual(
    resolveCampaignCustomerGroup({}, "KMP-BATUM-2026", "Batum filtre kampanyası"),
    { group: "BATUM", source: "campaign_code" }
  );
});

test("keeps a legacy non-F group only when no F1-F12 group exists", () => {
  assert.deepEqual(
    resolveCampaignCustomerGroup({ CARGROUPCODE: "BAYI" }, "KMP-001", "Bayi kampanyası"),
    { group: "BAYI", source: "cargroupcode" }
  );
});
