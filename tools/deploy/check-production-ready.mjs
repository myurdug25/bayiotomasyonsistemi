import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const productionBranch = "codex/stable-live-2026-07-11";

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function fail(message, details = []) {
  console.error("PRODUCTION_READY_FAILED");
  console.error(message);

  for (const detail of details.filter(Boolean)) {
    console.error(detail);
  }

  process.exit(1);
}

const branch = git(["branch", "--show-current"]);
const head = git(["rev-parse", "HEAD"]);
const upstream = (() => {
  try {
    return git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch {
    return "";
  }
})();
const dirty = git(["status", "--porcelain"]);

if (branch !== productionBranch) {
  fail(`Yanlis branch: ${branch || "(detached)"}`, [
    `Beklenen branch: ${productionBranch}`,
    "Deploy icin once canli kaynak branch'ine gec.",
  ]);
}

if (!upstream) {
  fail("Bu branch icin upstream tanimli degil.", [
    "Deploy commit'inin GitHub'a gittigini garanti edemiyorum.",
  ]);
}

if (dirty !== "") {
  const changed = dirty.split(/\r?\n/);
  fail("Local worktree kirli. Deploy durduruldu.", [
    `branch=${branch}`,
    `head=${head}`,
    `changed_count=${changed.length}`,
    ...changed.slice(0, 40),
    changed.length > 40 ? `... ${changed.length - 40} dosya daha var` : "",
  ]);
}

let remoteHead = "";
try {
  git(["fetch", "--quiet", "origin", productionBranch]);
  remoteHead = git(["rev-parse", `origin/${productionBranch}`]);
} catch (error) {
  fail("GitHub kontrolu yapilamadi.", [
    error instanceof Error ? error.message : String(error),
  ]);
}

if (head !== remoteHead) {
  fail("Local HEAD GitHub ile ayni degil. Deploy durduruldu.", [
    `local_head=${head}`,
    `origin/${productionBranch}=${remoteHead}`,
    "Once commit'i GitHub'a push et.",
  ]);
}

console.log("PRODUCTION_READY_OK");
console.log(`branch=${branch}`);
console.log(`head=${head}`);
console.log(`upstream=${upstream}`);
