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
    "TL / GEL oranı",
    "Kur Çarpanı",
    "TRY x çarpan",
    "const systemSettingsPayload",
    "systemSettingsPayload.complaint_mail_to = trimmedComplaintMailTo",
    "batum_exchange_rate: batumExchangeRate.trim()",
    "batum_exchange_multiplier: batumExchangeMultiplier.trim()",
    "Kur ve E-posta Ayarını Kaydet",
  ].forEach((snippet) => assert.match(component, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));

  assert.doesNotMatch(component, /effectiveBatumRate|effectiveBatumMultiplier/);
  assert.doesNotMatch(component, /canSaveSystemSettings\s*=\s*[\s\S]{0,140}complaintMailTo\.trim\(\)\s*!==\s*""/);
});

test("saving Batum exchange settings refreshes product prices without a hard reload", () => {
  [
    'const BATUM_PRICING_UPDATED_EVENT = "powersa:batum-pricing-updated"',
    'window.dispatchEvent(new CustomEvent(BATUM_PRICING_UPDATED_EVENT',
    'window.localStorage.setItem(BATUM_PRICING_UPDATED_EVENT',
    'queryClient.invalidateQueries({ queryKey: ["products"]',
    'queryClient.invalidateQueries({ queryKey: ["product-filter-options"]',
    'queryClient.invalidateQueries({ queryKey: ["cart"]',
    'queryClient.invalidateQueries({ queryKey: ["campaignProgress"]',
    'queryClient.invalidateQueries({ queryKey: ["pos"]',
  ].forEach((snippet) => assert.match(component, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));
});

test("cart provider refreshes local cart totals when Batum pricing changes", () => {
  const cartProvider = readFileSync(new URL("../src/components/cart/cart-provider.tsx", import.meta.url), "utf8");

  [
    'const BATUM_PRICING_UPDATED_EVENT = "powersa:batum-pricing-updated"',
    'window.addEventListener(BATUM_PRICING_UPDATED_EVENT, handleBatumPricingUpdated)',
    'window.addEventListener("storage", handleStorageBatumPricingUpdated)',
    'void refresh()',
  ].forEach((snippet) => assert.match(cartProvider, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));
});
