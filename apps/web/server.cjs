const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const next = require("next");

const port = Number.parseInt(process.env.PORT || "3000", 10);
const hostname = process.env.HOSTNAME || "0.0.0.0";
const LOGIN_VERSION = "20260605-login-fast";
const apiBaseUrl = new URL(process.env.NEXT_PUBLIC_API_BASE_URL || "https://bayiotomasyonsistemi.com/backend");
const nextStaticDir = path.join(__dirname, ".next", "static");
const legacyLoginHideCss = [
  "html,body{visibility:hidden!important;opacity:0!important;background:#0d1814!important}",
].join("");
const legacyLoginRedirectScript = [
  "(() => {",
  "  const redirectToFreshLogin = () => {",
  "    const current = new URL(window.location.href);",
  "    const target = new URL('/login', window.location.origin);",
  `    target.searchParams.set('v', '${LOGIN_VERSION}');`,
  "    const next = current.searchParams.get('next');",
  "    if (next) target.searchParams.set('next', next);",
  "    if (current.pathname === target.pathname && current.search === target.search) return;",
  "    window.location.replace(target.toString());",
  "  };",
  "  try {",
  "    redirectToFreshLogin();",
  "  } catch (error) {",
  `    window.location.replace('/login?v=${LOGIN_VERSION}');`,
  "  }",
  "})();",
].join("");
const securityHeaders = [
  ["Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "SAMEORIGIN"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), bluetooth=(self)"],
  ["Content-Security-Policy", "upgrade-insecure-requests; frame-ancestors 'self'"],
];
const compatibilityAssets = new Map([
  [
    "/_next/static/chunks/75dd593d612b2a1f.js",
    {
      type: "application/javascript; charset=utf-8",
      body: legacyLoginRedirectScript,
    },
  ],
  [
    "/_next/static/chunks/d867e7c63cbdd25f.css",
    {
      type: "text/css; charset=utf-8",
      body: legacyLoginHideCss,
    },
  ],
]);

const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

function applySecurityHeaders(res) {
  for (const [key, value] of securityHeaders) {
    res.setHeader(key, value);
  }

  res.removeHeader("X-Powered-By");
}

function shouldProxyBackendRequest(req) {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  return pathname.startsWith("/api/") || pathname.startsWith("/sanctum/");
}

function proxyBackendRequest(req, res) {
  const targetPath = `/backend${req.url || "/"}`;
  const headers = { ...req.headers };

  headers.host = apiBaseUrl.host;

  const proxy = https.request(
    {
      hostname: apiBaseUrl.hostname,
      port: Number(apiBaseUrl.port || 443),
      path: targetPath,
      method: req.method,
      headers,
    },
    (backendRes) => {
      res.statusCode = backendRes.statusCode || 502;

      for (const [name, value] of Object.entries(backendRes.headers)) {
        if (value !== undefined) {
          res.setHeader(name, value);
        }
      }

      applySecurityHeaders(res);
      backendRes.pipe(res);
    },
  );

  proxy.on("error", () => {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    applySecurityHeaders(res);
    res.end(JSON.stringify({ message: "Backend proxy failed." }));
  });

  req.pipe(proxy);
}

function serveMutableCssChunk(req, res) {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  if (!pathname.startsWith("/_next/static/chunks/") || !pathname.endsWith(".css")) {
    return false;
  }

  const diskPath = path.join(nextStaticDir, pathname.replace("/_next/static/", ""));

  if (!fs.existsSync(diskPath)) {
    return false;
  }

  const body = fs.readFileSync(diskPath);

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/css; charset=utf-8");
  res.setHeader("Content-Length", body.byteLength);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  if (req.method === "HEAD") {
    res.end();
    return true;
  }

  res.end(body);
  return true;
}

function serveCompatibilityAsset(req, res) {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const referer = req.headers.referer;
  const asset =
    compatibilityAssets.get(pathname) ??
    resolveLegacyLoginFallbackAsset({
      pathname,
      referer,
    });

  if (!asset) {
    return false;
  }

  const body = Buffer.from(asset.body);

  res.statusCode = 200;
  res.setHeader("Content-Type", asset.type);
  res.setHeader("Content-Length", body.byteLength);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

  if (req.method === "HEAD") {
    res.end();
    return true;
  }

  res.end(body);
  return true;
}

function resolveLegacyLoginFallbackAsset({
  pathname,
  referer,
}) {
  if (!pathname.startsWith("/_next/static/chunks/")) {
    return null;
  }

  if (!isLoginReferer(referer)) {
    return null;
  }

  const diskPath = path.join(nextStaticDir, pathname.replace("/_next/static/", ""));

  if (fs.existsSync(diskPath)) {
    return null;
  }

  if (pathname.endsWith(".js")) {
    return {
      type: "application/javascript; charset=utf-8",
      body: legacyLoginRedirectScript,
    };
  }

  if (pathname.endsWith(".css")) {
    return {
      type: "text/css; charset=utf-8",
      body: legacyLoginHideCss,
    };
  }

  return null;
}

function isLoginReferer(referer) {
  if (!referer) {
    return false;
  }

  try {
    return new URL(referer).pathname === "/login";
  } catch {
    return false;
  }
}

app
  .prepare()
  .then(() => {
    http
      .createServer((req, res) => {
        applySecurityHeaders(res);

        const writeHead = res.writeHead.bind(res);
        res.writeHead = (...args) => {
          applySecurityHeaders(res);
          return writeHead(...args);
        };

        if (serveMutableCssChunk(req, res)) {
          return;
        }

        if (serveCompatibilityAsset(req, res)) {
          return;
        }

        if (shouldProxyBackendRequest(req)) {
          proxyBackendRequest(req, res);
          return;
        }

        handle(req, res);
      })
      .listen(port, hostname, () => {
        console.log(`> Ready on http://${hostname}:${port}`);
      });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
