import assert from "node:assert/strict";
import fs from "node:fs";

const thermalPrintSource = fs.readFileSync("src/lib/thermal-print.ts", "utf8");

assert.match(thermalPrintSource, /function openNativeBridgeUrl/);
assert.match(thermalPrintSource, /const link = document\.createElement\("a"\)/);
assert.match(thermalPrintSource, /link\.href = url/);
assert.match(thermalPrintSource, /link\.click\(\)/);
assert.match(
  thermalPrintSource,
  /if \(isTouchMobileUserAgent\(\)\) \{[\s\S]*?openNativeBridgeUrl\(bridgeUrl\.url\);[\s\S]*?ok: true,[\s\S]*?message: bridgeUrl\.message,[\s\S]*?\}/,
);

const mobileBridgeBlock = thermalPrintSource.match(
  /if \(isTouchMobileUserAgent\(\)\) \{[\s\S]*?return \{[\s\S]*?\};[\s\S]*?\}/,
)?.[0] ?? "";
assert.ok(mobileBridgeBlock, "mobile bridge block must exist");
assert.doesNotMatch(mobileBridgeBlock, /PowerSA yazdirma koprusu acilamadi/);

console.log("thermal print bridge static checks passed");
