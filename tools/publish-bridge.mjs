// Publishes the CodeWalker bridge as a self-contained win-x64 build into
// src-tauri/bin/codewalker-bridge so `tauri build` bundles it as a resource.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectFile = path.join(repoRoot, "tools", "codewalker-bridge", "CodeWalkerBridge.csproj");
const outputDir = path.join(repoRoot, "src-tauri", "bin", "codewalker-bridge");
const exeName = process.platform === "win32" ? "CodeWalkerBridge.exe" : "CodeWalkerBridge";

function fail(message) {
  console.error(`[publish-bridge] ${message}`);
  process.exit(1);
}

if (!existsSync(projectFile)) {
  fail(`Bridge project not found at ${projectFile}`);
}

const codewalkerCore = path.resolve(repoRoot, "..", "external", "CodeWalker", "CodeWalker.Core", "CodeWalker.Core.csproj");
if (!existsSync(codewalkerCore)) {
  fail(`CodeWalker.Core checkout missing at ${codewalkerCore}. Clone CodeWalker into ../external/CodeWalker first.`);
}

mkdirSync(outputDir, { recursive: true });

const args = [
  "publish",
  projectFile,
  "-c",
  "Release",
  "-r",
  "win-x64",
  "--self-contained",
  "true",
  "-p:PublishReadyToRun=true",
  "-p:PublishSingleFile=false",
  "--nologo",
  "-o",
  outputDir,
];

console.log(`[publish-bridge] dotnet ${args.join(" ")}`);
// No shell: dotnet is a native executable and the repo path may contain spaces.
const result = spawnSync("dotnet", args, { cwd: repoRoot, stdio: "inherit" });

if (result.error) {
  fail(`Failed to start dotnet: ${result.error.message}`);
}
if (result.status !== 0) {
  fail(`dotnet publish exited with code ${result.status}`);
}

const exePath = path.join(outputDir, exeName);
if (!existsSync(exePath)) {
  fail(`Publish finished but ${exePath} is missing`);
}
if (!existsSync(path.join(outputDir, "strings.txt"))) {
  fail(`Publish finished but strings.txt was not copied next to ${exeName}`);
}

console.log(`[publish-bridge] Bridge published to ${outputDir}`);
