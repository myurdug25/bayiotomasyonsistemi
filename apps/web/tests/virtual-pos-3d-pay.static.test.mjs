import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync("src/components/virtual-pos/virtual-pos-page.tsx", "utf8");
const apiSource = fs.readFileSync("src/lib/api.ts", "utf8");

test("virtual pos uses hosted 3D payment without sending card fields to the app API or initial bank form", () => {
  assert.match(source, /function submitNestpayPaymentForm/);
  assert.match(source, /form\.method = "POST"/);
  assert.match(source, /form\.action = gatewayUrl/);
  assert.match(source, /form\.submit\(\)/);
  assert.doesNotMatch(source, /pan: onlyDigits\(card\.number\)/);
  assert.doesNotMatch(source, /cv2: onlyDigits\(card\.cvv\)/);
  assert.doesNotMatch(source, /Ecom_Payment_Card_ExpDate_Month/);
  assert.doesNotMatch(source, /Ecom_Payment_Card_ExpDate_Year/);
  assert.doesNotMatch(source, /window\.open\(providerUrl\.toString\(\)/);
  assert.doesNotMatch(apiSource, /card_number: string/);
  assert.doesNotMatch(apiSource, /cvv: string/);
});
