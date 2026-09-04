import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const api = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const component = readFileSync(new URL("../src/components/moderator/moderator-panel-page.tsx", import.meta.url), "utf8");

test("moderator system settings exposes editable Batum exchange rate", () => {
  [
    "batum_exchange_rate: string",
    "batum_exchange_multiplier: string",
    "updateModeratorSystemSettings(payload: { complaint_mail_to?: string; batum_exchange_rate: string; batum_exchange_multiplier: string })",
    "system_settings: { complaint_mail_to: string; batum_exchange_rate: string; batum_exchange_multiplier: string }",
  ].forEach((snippet) => assert.match(api, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));

  [
    "const [batumExchangeRateDraft, setBatumExchangeRateDraft] = useState",
    "const [batumExchangeMultiplierDraft, setBatumExchangeMultiplierDraft] = useState",
    "overviewQuery.data?.system_settings.batum_exchange_rate",
    "overviewQuery.data?.system_settings.batum_exchange_multiplier",
    "Batum Kuru",
    "TRY x kur",
    "Kur Çarpanı",
    "TL / GEL oranı",
    "const effectiveBatumMultiplier",
    "const effectiveBatumRate",
    "const systemSettingsPayload",
    "systemSettingsPayload.complaint_mail_to = trimmedComplaintMailTo",
    "batum_exchange_rate: effectiveBatumRate.toFixed(4)",
    "batum_exchange_multiplier: effectiveBatumMultiplier.toFixed(4)",
    "Kur ve E-posta Ayarını Kaydet",
  ].forEach((snippet) => assert.match(component, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));

  assert.doesNotMatch(component, /canSaveSystemSettings\s*=\s*[\s\S]{0,140}complaintMailTo\.trim\(\)\s*!==\s*""/);
});
