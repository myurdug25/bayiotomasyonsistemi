import assert from "node:assert/strict";
import test from "node:test";

import {
  isLogoCampaignActive,
  normalizeLogoDate,
} from "../campaign-date.mjs";

test("Logo SQL date keeps its calendar day instead of converting through UTC", () => {
  const logoEndDate = new Date(2026, 6, 31, 0, 0, 0);

  assert.equal(normalizeLogoDate(logoEndDate), "2026-07-31");
  assert.equal(normalizeLogoDate("2026-07-31T00:00:00.000"), "2026-07-31");
});

test("Logo ACTIVE flag is authoritative for campaign availability", () => {
  assert.equal(isLogoCampaignActive({ ACTIVE: 0 }), true);
  assert.equal(isLogoCampaignActive({ ACTIVE: 1 }), false);
});
