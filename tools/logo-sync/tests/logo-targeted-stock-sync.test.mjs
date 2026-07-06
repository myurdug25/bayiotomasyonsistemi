import assert from "node:assert/strict";
import test from "node:test";

import { collectProductCodes } from "../logo-targeted-stock-sync.mjs";

test("collectProductCodes returns unique non-empty invoice product codes", () => {
  assert.deepEqual(
    collectProductCodes([
      {
        items: [
          { product_code: "ABC123" },
          { product_code: " ABC123 " },
          { product_code: "XYZ789" },
        ],
      },
      {
        items: [
          { product_code: "" },
          { product_code: null },
          { product_code: "DEF456" },
        ],
      },
    ]),
    ["ABC123", "XYZ789", "DEF456"]
  );
});
