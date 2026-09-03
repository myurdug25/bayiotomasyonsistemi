import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const appShellSource = fs.readFileSync("src/components/layout/app-shell.tsx", "utf8");
const pointSidebarSource = fs.readFileSync("src/components/pos/point-sidebar-nav.tsx", "utf8");

test("app shell logout buttons use a shared immediate navigation handler", () => {
  assert.match(appShellSource, /const handleLogout = useCallback\(async \(\) => \{/);
  assert.match(appShellSource, /router\.replace\("\/login\?v=20260605-login-fast"\);\s*await logout\(\);/s);
  assert.doesNotMatch(appShellSource, /void logout\(\)\.then\(\(\) => router\.replace/);
});

test("point sidebar logout also navigates immediately", () => {
  assert.match(pointSidebarSource, /const handleLogout = useCallback\(async \(\) => \{/);
  assert.match(pointSidebarSource, /router\.replace\("\/login\?v=20260605-login-fast"\);\s*await logout\(\);/s);
  assert.doesNotMatch(pointSidebarSource, /void logout\(\)\.then/);
});
