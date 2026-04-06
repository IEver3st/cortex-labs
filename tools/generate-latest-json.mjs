import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const BUNDLE_DIR = path.join(ROOT, "src-tauri", "target", "release", "bundle");
const NSIS_DIR = path.join(BUNDLE_DIR, "nsis");
const MSI_DIR = path.join(BUNDLE_DIR, "msi");
const CONFIG_PATH = path.join(ROOT, "src-tauri", "tauri.conf.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath)
    .map((name) => path.join(dirPath, name))
    .filter((fullPath) => fs.statSync(fullPath).isFile());
}

function newestFile(files) {
  const sorted = [...files].sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return sorted[0] || "";
}

function selectInstaller(version) {
  const preferred = (process.env.TAURI_UPDATER_WINDOWS_ARTIFACT || "nsis").toLowerCase();
  const nsisInstallers = listFiles(NSIS_DIR).filter((file) => file.toLowerCase().endsWith(".exe") && !file.toLowerCase().endsWith(".exe.sig"));
  const msiInstallers = listFiles(MSI_DIR).filter((file) => file.toLowerCase().endsWith(".msi") && !file.toLowerCase().endsWith(".msi.sig"));

  const versionToken = `_${String(version || "").toLowerCase()}_`;
  const matchesVersion = (file) => path.basename(file).toLowerCase().includes(versionToken);

  const nsisForVersion = nsisInstallers.filter(matchesVersion);
  const msiForVersion = msiInstallers.filter(matchesVersion);

  const primary = preferred === "msi" ? newestFile(msiForVersion) : newestFile(nsisForVersion);
  if (primary) return primary;

  const secondary = preferred === "msi" ? newestFile(nsisForVersion) : newestFile(msiForVersion);
  if (secondary) return secondary;

  const preferredPool = preferred === "msi" ? msiInstallers : nsisInstallers;
  const fallbackPool = preferred === "msi" ? nsisInstallers : msiInstallers;
  const available = [...preferredPool, ...fallbackPool]
    .map((file) => path.basename(file))
    .join(", ");

  console.error(
    `[updater] No installer artifact matches app version "${version}" in bundle directory.`
  );
  if (available) {
    console.error(`[updater] Found artifacts: ${available}`);
  }
  return "";
}

function detectArch(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.includes("arm64") || lower.includes("aarch64")) return "aarch64";
  if (lower.includes("x64") || lower.includes("x86_64") || lower.includes("amd64")) return "x86_64";
  if (lower.includes("x86") || lower.includes("i686") || lower.includes("ia32")) return "i686";

  if (process.arch === "arm64") return "aarch64";
  if (process.arch === "ia32") return "i686";
  return "x86_64";
}

function deriveBaseUrl(config) {
  if (process.env.TAURI_UPDATER_BASE_URL) {
    return process.env.TAURI_UPDATER_BASE_URL.replace(/\/+$/, "");
  }

  const endpoint = config?.plugins?.updater?.endpoints?.[0];
  if (!endpoint) return "";

  const normalized = endpoint.replace(/\\/g, "/");
  const withoutLatest = normalized.replace(/\/latest\.json(?:\?.*)?$/i, "");
  return withoutLatest.replace(/\/+$/, "");
}

function resolveReleaseAssetName(installerFileName, baseUrl) {
  if (process.env.TAURI_UPDATER_ASSET_NAME) {
    return process.env.TAURI_UPDATER_ASSET_NAME;
  }

  // GitHub release assets are commonly uploaded with spaces normalized to dots.
  if (/^https:\/\/github\.com\//i.test(baseUrl) && installerFileName.includes(" ")) {
    return installerFileName.replace(/ /g, ".");
  }

  return installerFileName;
}

function signatureMatchesInstaller(signature, installerFileNames) {
  if (!signature || !installerFileNames.length) return false;

  try {
    const decoded = Buffer.from(signature, "base64").toString("utf8");
    return installerFileNames.some((name) => decoded.includes(`file:${name}`));
  } catch {
    return false;
  }
}

function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error("[updater] Skipped latest.json generation: missing src-tauri/tauri.conf.json.");
    return 0;
  }

  const config = readJson(CONFIG_PATH);
  const installerPath = selectInstaller(config.version);
  if (!installerPath) {
    console.error("[updater] Skipped latest.json generation: no installer found in src-tauri/target/release/bundle.");
    return 0;
  }

  const sigPath = `${installerPath}.sig`;
  if (!fs.existsSync(sigPath)) {
    console.error("[updater] Skipped latest.json generation: signature file not found.");
    console.error(`[updater] Expected: ${sigPath}`);
    console.error("[updater] Set TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD for signed updater artifacts.");
    return 0;
  }

  const installerFileName = path.basename(installerPath);
  const arch = detectArch(installerFileName);
  const platformKey = `windows-${arch}`;
  const baseUrl = deriveBaseUrl(config);
  if (!baseUrl) {
    console.error("[updater] Skipped latest.json generation: could not determine updater base URL.");
    console.error("[updater] Set TAURI_UPDATER_BASE_URL to your release download base URL.");
    return 0;
  }

  const signature = fs.readFileSync(sigPath, "utf8").trim();
  const releaseAssetName = resolveReleaseAssetName(installerFileName, baseUrl);
  if (!signatureMatchesInstaller(signature, [installerFileName, releaseAssetName])) {
    console.error("[updater] Signature content does not match installer filename.");
    console.error(`[updater] Installer: ${installerFileName}`);
    console.error(`[updater] Release asset: ${releaseAssetName}`);
    console.error(`[updater] Signature file: ${sigPath}`);
    console.error("[updater] Clean old bundle artifacts and rebuild with signing enabled.");
    return 1;
  }

  const latest = {
    version: config.version,
    notes: process.env.TAURI_UPDATER_NOTES || "",
    pub_date: new Date().toISOString(),
    platforms: {
      [platformKey]: {
        signature,
        url: `${baseUrl}/${releaseAssetName}`,
      },
    },
  };

  const outputPath = process.env.TAURI_UPDATER_LATEST_JSON_PATH
    ? path.resolve(ROOT, process.env.TAURI_UPDATER_LATEST_JSON_PATH)
    : path.join(BUNDLE_DIR, "latest.json");

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
  console.log(`[updater] latest.json generated at ${outputPath}`);
  return 0;
}

process.exit(main());
