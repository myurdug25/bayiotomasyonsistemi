import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const paths = {
  "tools/logo-sync/.env": path.join(scriptDir, ".env"),
  "apps/api/.env": path.join(scriptDir, "..", "..", "apps", "api", ".env"),
  "root/.env": path.join(scriptDir, "..", "..", ".env"),
};

console.log("=== CHECKING ENV FILES ===");
for (const [name, p] of Object.entries(paths)) {
  const exists = fs.existsSync(p);
  console.log(`Path: ${name} (${p}) -> Exists: ${exists}`);
  if (exists) {
    const content = fs.readFileSync(p, "utf-8");
    const parsed = dotenv.parse(content);
    console.log("  - LOGO_SQL_SERVER:", parsed.LOGO_SQL_SERVER ?? "(not set)");
    console.log("  - LOGO_SQL_DATABASE:", parsed.LOGO_SQL_DATABASE ?? "(not set)");
    console.log("  - LOGO_SQL_USER:", parsed.LOGO_SQL_USER ?? "(not set)");
  }
}
