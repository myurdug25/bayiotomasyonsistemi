import { exec } from "node:child_process";
import util from "node:util";

const execAsync = util.promisify(exec);

async function run() {
  console.log("=== RUNNING NODE PROCESSES ===");
  try {
    const { stdout } = await execAsync('wmic process where "name=\'node.exe\'" get CommandLine, ExecutablePath, ProcessId /format:list');
    console.log(stdout);
  } catch (err) {
    console.log("WMIC failed, trying PowerShell CimInstance...");
    try {
      const { stdout } = await execAsync('powershell -Command "Get-CimInstance Win32_Process -Filter \\"name=\'node.exe\'\\" | Select-Object ProcessId, CommandLine, Path | Format-List"');
      console.log(stdout);
    } catch (pwshErr) {
      console.error("PowerShell command failed:", pwshErr.message);
    }
  }
}

run();
