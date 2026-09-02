import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const requireFromLogoSync = createRequire(path.join(repoRoot, "tools", "logo-sync", "package.json"));
const { NodeSSH } = requireFromLogoSync("node-ssh");

const credentialSource = fs.readFileSync(
  path.join(repoRoot, "tools", "logo-sync", "deploy-logo-invoice-ledger-fallback-20260825.mjs"),
  "utf8",
);

const remoteRoot = "/var/www/bayiotomasyonsistemi.com";
const remoteBackend = `${remoteRoot}/backend`;
const remoteWeb = `${remoteRoot}/web`;
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const auditDir = path.join(repoRoot, ".codex-deploy", "audits");
const auditPath = path.join(auditDir, `${stamp}-production-state.json`);

const sourceRoots = [
  "apps/api/app",
  "apps/api/bootstrap",
  "apps/api/config",
  "apps/api/database/migrations",
  "apps/api/routes",
  "apps/web/public",
  "apps/web/src",
  "tools/logo-sync",
  "tools/deploy",
];

const excludedSourceSegments = [
  "/apps/api/bootstrap/cache/",
  "/.sync-state/",
  "/.sync-source-manifest.json",
  "/tools/logo-sync/apps/",
  "/node_modules/",
  "/package-lock.json",
];

const includedExtensions = new Set([
  ".cmd",
  ".css",
  ".json",
  ".md",
  ".mjs",
  ".php",
  ".ps1",
  ".sql",
  ".svg",
  ".ts",
  ".tsx",
  ".webmanifest",
]);

function listLocalSourceFiles() {
  const files = [];

  for (const root of sourceRoots) {
    const absoluteRoot = path.join(repoRoot, root);
    if (!fs.existsSync(absoluteRoot)) {
      continue;
    }

    const stack = [absoluteRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true });

      for (const entry of entries) {
        const absolutePath = path.join(current, entry.name);
        const localPath = path.relative(repoRoot, absolutePath).replaceAll("\\", "/");
        const normalized = `/${localPath}/`;

        if (excludedSourceSegments.some((segment) => normalized.includes(segment))) {
          continue;
        }

        if (entry.isDirectory()) {
          stack.push(absolutePath);
          continue;
        }

        const extension = path.extname(entry.name).toLowerCase();
        if (includedExtensions.has(extension)) {
          files.push(localPath);
        }
      }
    }
  }

  return files.sort();
}

function remotePathForLocal(localPath) {
  if (localPath.startsWith("apps/api/")) {
    return `${remoteBackend}/${localPath.slice("apps/api/".length)}`;
  }

  if (localPath.startsWith("apps/web/")) {
    return `${remoteWeb}/${localPath.slice("apps/web/".length)}`;
  }

  if (localPath.startsWith("tools/logo-sync/")) {
    return `${remoteRoot}/${localPath}`;
  }

  return null;
}

function readStringSetting(name, fallback = undefined) {
  const match = credentialSource.match(new RegExp(`${name}:\\s*['"]([^'"]+)['"]`));
  return match?.[1] ?? fallback;
}

function readNumberSetting(name, fallback) {
  const match = credentialSource.match(new RegExp(`${name}:\\s*(\\d+)`));
  return match ? Number(match[1]) : fallback;
}

function q(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function localGit(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function localSha256(localPath) {
  const absolutePath = path.join(repoRoot, localPath);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }

  return crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
}

function parseSha256sum(output) {
  const [hash] = output.trim().split(/\s+/, 1);

  return /^[a-f0-9]{64}$/i.test(hash ?? "") ? hash.toLowerCase() : null;
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

async function remoteRead(ssh, command, timeout = 120000) {
  const result = await ssh.execCommand(command, { execOptions: { timeout } });
  if (result.code !== 0) {
    return { ok: false, stdout: result.stdout.trim(), stderr: result.stderr.trim(), code: result.code };
  }

  return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim(), code: result.code };
}

const ssh = new NodeSSH();

try {
  const localHead = localGit(["rev-parse", "HEAD"]);
  const localBranch = localGit(["branch", "--show-current"]);
  const localStatusRaw = localGit(["status", "--porcelain"]);
  const localStatus = localStatusRaw === "" ? [] : localStatusRaw.split(/\r?\n/);

  await ssh.connect({
    host: readStringSetting("host"),
    port: readNumberSetting("port", 22),
    username: readStringSetting("username", "root"),
    password: readStringSetting("password"),
  });

  const manifestResult = await remoteRead(
    ssh,
    `if [ -f ${q(`${remoteRoot}/.deploy-manifest.json`)} ]; then cat ${q(`${remoteRoot}/.deploy-manifest.json`)}; fi`,
  );
  const serviceResult = await remoteRead(ssh, "systemctl is-active bayiotomasyonsistemi-web.service");

  const localSourceFiles = listLocalSourceFiles();
  const remoteCandidates = localSourceFiles
    .map((localPath) => [localPath, remotePathForLocal(localPath)])
    .filter(([, remotePath]) => remotePath !== null);
  const remoteHashes = new Map();

  for (const candidateChunk of chunks(remoteCandidates, 80)) {
    const remoteHashScript = candidateChunk
      .map(([localPath, remotePath]) => [
        `p=${q(remotePath)}`,
        `if [ -f "$p" ]; then printf '%s|' ${q(localPath)}; sha256sum "$p" | cut -d' ' -f1; else printf '%s|MISSING\\n' ${q(localPath)}; fi`,
      ].join("; "))
      .join("\n");
    const remoteHashResult = remoteHashScript === ""
      ? { ok: true, stdout: "", stderr: "", code: 0 }
      : await remoteRead(ssh, remoteHashScript, 300000);

    if (!remoteHashResult.ok) {
      throw new Error(`Remote checksum chunk failed: ${remoteHashResult.stderr || remoteHashResult.stdout || remoteHashResult.code}`);
    }

    if (remoteHashResult.stdout === "") {
      continue;
    }

    for (const line of remoteHashResult.stdout.split(/\r?\n/)) {
      const separatorIndex = line.indexOf("|");
      if (separatorIndex !== -1) {
        const localPath = line.slice(0, separatorIndex);
        const hash = line.slice(separatorIndex + 1);
        remoteHashes.set(localPath, hash === "MISSING" ? null : hash.toLowerCase());
      }
    }
  }

  const files = [];
  for (const [localPath, remotePath] of remoteCandidates) {
    const remoteHash = remoteHashes.get(localPath) ?? null;
    const localHash = localSha256(localPath);

    files.push({
      local_path: localPath,
      remote_path: remotePath,
      local_sha256: localHash,
      remote_sha256: remoteHash,
      status: localHash === null
        ? "missing_local"
        : remoteHash === null
          ? "missing_remote"
          : localHash === remoteHash
            ? "same"
            : "different",
    });
  }

  const report = {
    generated_at: new Date().toISOString(),
    mode: "read_only",
    local: {
      branch: localBranch,
      head: localHead,
      dirty_count: localStatus.length,
      dirty_files: localStatus,
    },
    production: {
      root: remoteRoot,
      web_service: serviceResult.ok ? serviceResult.stdout : null,
      manifest_present: manifestResult.ok && manifestResult.stdout !== "",
      manifest: manifestResult.stdout || null,
    },
    files,
    summary: {
      same: files.filter((file) => file.status === "same").length,
      different: files.filter((file) => file.status === "different").length,
      missing_local: files.filter((file) => file.status === "missing_local").length,
      missing_remote: files.filter((file) => file.status === "missing_remote").length,
    },
  };

  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(auditPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log("PRODUCTION_AUDIT_OK");
  console.log(`mode=${report.mode}`);
  console.log(`local_branch=${report.local.branch}`);
  console.log(`local_head=${report.local.head}`);
  console.log(`local_dirty_count=${report.local.dirty_count}`);
  console.log(`production_service=${report.production.web_service ?? "unknown"}`);
  console.log(`production_manifest=${report.production.manifest_present ? "present" : "missing"}`);
  console.log(`files_same=${report.summary.same}`);
  console.log(`files_different=${report.summary.different}`);
  console.log(`files_missing_local=${report.summary.missing_local}`);
  console.log(`files_missing_remote=${report.summary.missing_remote}`);
  console.log(`audit=${auditPath}`);
} catch (error) {
  console.error("PRODUCTION_AUDIT_FAILED");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  ssh.dispose();
}
