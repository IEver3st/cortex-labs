import { spawnSync } from "node:child_process";
import path from "node:path";

function runCommand(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    ...options,
  });

  if (typeof result.status === "number") {
    return result.status;
  }

  return 1;
}

const cliPath = path.join(process.cwd(), "node_modules", "@tauri-apps", "cli", "tauri.js");
const tauriArgs = process.argv.slice(2);
const tauriExitCode = runCommand([cliPath, ...tauriArgs]);

if (tauriExitCode !== 0) {
  process.exit(tauriExitCode);
}

if (tauriArgs[0] !== "build") {
  process.exit(0);
}

if (tauriArgs.includes("--help") || tauriArgs.includes("-h") || tauriArgs.includes("--version") || tauriArgs.includes("-V")) {
  process.exit(0);
}

const generatorPath = path.join(process.cwd(), "tools", "generate-latest-json.mjs");
const generatorExitCode = runCommand([generatorPath]);
process.exit(generatorExitCode);
