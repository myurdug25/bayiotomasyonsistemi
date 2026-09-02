import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const globalsSource = fs.readFileSync("src/app/globals.css", "utf8");
const collectionsPageSource = fs.readFileSync("src/components/collections/collections-page.tsx", "utf8");

test("collections recent payments panel has light-mode-safe styling hooks", () => {
  assert.match(collectionsPageSource, /collection-recent-panel/);
  assert.match(collectionsPageSource, /collection-recent-row/);
  assert.match(collectionsPageSource, /collection-recent-status/);
  assert.match(collectionsPageSource, /collection-recent-summary-card/);

  assert.match(globalsSource, /admin-collections-page \.collection-recent-panel/);
  assert.match(globalsSource, /admin-collections-page \.collection-recent-row/);
  assert.match(globalsSource, /admin-collections-page \.collection-recent-status/);
  assert.match(globalsSource, /admin-collections-page \.collection-recent-summary-card/);
});
