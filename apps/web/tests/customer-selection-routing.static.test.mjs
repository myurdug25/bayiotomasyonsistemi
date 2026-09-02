import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/components/customers/customer-selection-page.tsx", "utf8");

assert.match(source, /function getSafeCustomerSelectionNext\(/);
assert.match(source, /requestedNext === ["']\/customers["']/);
assert.match(source, /requestedNext\.startsWith\(["']\/customers\?["']\)/);
assert.match(source, /requestedNext\.startsWith\(["']\/customers\/["']\)/);
assert.match(source, /const safeNext = getSafeCustomerSelectionNext\(searchParams\.get\(["']next["']\)\)/);

console.log("customer selection routing static checks passed");
