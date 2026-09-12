import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

function assertLogoutBeforeLoginRedirect(filePath, handlerName = "handleLogout") {
  const source = readFileSync(filePath, "utf8");
  const handlerStart = source.indexOf(`const ${handlerName} = useCallback(async () => {`);

  assert.notEqual(handlerStart, -1, `${handlerName} should exist in ${filePath}`);

  const handlerEnd = source.indexOf("}, [", handlerStart);
  assert.notEqual(handlerEnd, -1, `${handlerName} should have a dependency array in ${filePath}`);

  const handlerBody = source.slice(handlerStart, handlerEnd);
  const logoutIndex = handlerBody.indexOf("await logout()");
  const redirectIndex = handlerBody.indexOf('router.replace("/login');

  assert.notEqual(logoutIndex, -1, `${handlerName} should await logout in ${filePath}`);
  assert.notEqual(redirectIndex, -1, `${handlerName} should redirect to login in ${filePath}`);
  assert.ok(
    logoutIndex < redirectIndex,
    `${handlerName} should clear the session before redirecting to login in ${filePath}`
  );
}

test("app shell logout clears the session before opening the login page", () => {
  assertLogoutBeforeLoginRedirect("src/components/layout/app-shell.tsx");
});

test("point sidebar logout clears the session before opening the login page", () => {
  assertLogoutBeforeLoginRedirect("src/components/pos/point-sidebar-nav.tsx");
});
