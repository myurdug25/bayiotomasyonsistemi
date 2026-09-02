import assert from "node:assert/strict";
import fs from "node:fs";

const installPromptSource = fs.readFileSync("src/components/app/pwa-install-prompt.tsx", "utf8");
const serviceWorkerSource = fs.readFileSync("public/sw.js", "utf8");
const manifest = JSON.parse(fs.readFileSync("public/manifest.json", "utf8"));
const webManifest = JSON.parse(fs.readFileSync("public/manifest.webmanifest", "utf8"));

const loginStartUrl = "/login?v=20260605-login-fast&next=%2Fdashboard";

assert.match(installPromptSource, /PowerSA B2B uygulamasını yüklemek istiyor musunuz\?/);
assert.match(installPromptSource, /Evet, yükle/);
assert.match(installPromptSource, /fixed inset-0/);
assert.doesNotMatch(installPromptSource, /fixed bottom-4 right-4/);
assert.match(installPromptSource, /usePathname/);
assert.match(installPromptSource, /pathname !== ["']\/login["']/);
assert.doesNotMatch(
  installPromptSource,
  /isInstalled\s*\|\|\s*installPrompt === null\s*\|\|\s*isDismissed/,
);
assert.doesNotMatch(installPromptSource, /disabled=\{installPrompt === null\}/);
assert.match(installPromptSource, /Nasıl yüklerim\?/);
assert.match(installPromptSource, /Uygulamayı yükle/);
assert.match(installPromptSource, /WINDOWS_INSTALLER_FLAG_KEY/);
assert.match(installPromptSource, /shouldShowInstallPrompt/);
assert.match(installPromptSource, /params\.get\(["']install["']\) === ["']1["']/);
assert.match(installPromptSource, /params\.get\(["']desktop["']\) === ["']1["']/);
assert.match(installPromptSource, /params\.get\(["']installer["']\) === ["']1["']/);
assert.match(installPromptSource, /isWindowsShortcut/);
assert.match(installPromptSource, /!installRequested/);

assert.equal(manifest.start_url, loginStartUrl);
assert.equal(webManifest.start_url, loginStartUrl);
assert.match(serviceWorkerSource, /powersa-b2b-pwa-v5-login-install/);

console.log("pwa install flow static checks passed");
