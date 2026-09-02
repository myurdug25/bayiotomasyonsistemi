import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(process.cwd(), "../../apps/web/src/components/products/products-page.tsx"),
  "utf8",
);

test("erzurum fast sale search stock columns keep Point before Erzurum Depo", () => {
  assert.match(
    source,
    /case "erzurum hizlisatis":\s*return \["erz-point",\s*"erz-depo"\];/,
  );
  assert.match(
    source,
    /if \(userSpecificColumns !== null\) \{\s*return userSpecificColumns;\s*\}/,
  );
});
