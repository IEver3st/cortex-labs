// Publishes a source snapshot of a private commit to the public repository.
//
// The private history contains game and creator assets that must never be
// published, so the public repository receives one new commit per release on
// top of its own main: the private tree minus maintainer-only files, checked
// for forbidden assets and secrets. Without --push it only builds the commit;
// --push opens a pull request for it on the public repository.
//
//   node tools/publish-source.mjs [--ref <commit>] [--message <text>] [--push]
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Maintainer and agent configuration that stays private.
const PRIVATE_PATHS = [
  "AGENTS.md",
  ":(glob)**/CLAUDE.md",
  ":(glob)**/.devin/**",
  ":(glob)**/.claude/**",
  ":(glob)**/.agents/**",
];

// GTA binary formats, caches, and credential files. The public repository must
// never contain them, whatever the private tree holds.
const FORBIDDEN =
  /\.(ydd|ytd|yft|ydr|ymt|ytyp|ymap|ymf|ybn|ynd|ynv|ycd|ypt|ysc|awc|wft|wvd|rpf|clmesh|pem|pfx|p12|key)$|(^|\/)\.env($|\.(?!example$))/i;

function fail(message) {
  console.error(`[publish-source] ${message}`);
  process.exit(1);
}

function git(args, { env, input } = {}) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`Failed to start git: ${result.error.message}`);
  if (result.status !== 0) fail(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function parseArgs(argv) {
  const options = { ref: "HEAD", message: null, push: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--push") options.push = true;
    else if (arg === "--ref" && argv[i + 1]) options.ref = argv[++i];
    else if (arg === "--message" && argv[i + 1]) options.message = argv[++i];
    else fail(`Unknown or incomplete argument: ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

const publicUrl = git(["remote", "get-url", "public"]);
const match = publicUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
if (!match) fail(`The public remote is not a GitHub repository: ${publicUrl}`);
const pushUrl = `https://github.com/${match[1]}/${match[2]}.git`;

git(["fetch", "--quiet", "public", "main"]);
const parent = git(["rev-parse", "public/main"]);
const source = git(["rev-parse", "--verify", `${options.ref}^{commit}`]);
const version = JSON.parse(git(["show", `${source}:package.json`])).version;

// Build the public tree in a throwaway index so the working tree is untouched.
const tempDir = mkdtempSync(path.join(os.tmpdir(), "cortex-publish-"));
const env = { GIT_INDEX_FILE: path.join(tempDir, "index") };
let tree;
try {
  git(["read-tree", source], { env });
  git(["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", ...PRIVATE_PATHS], { env });
  // -z keeps non-ASCII paths unquoted so the extension check sees them.
  const files = git(["ls-files", "-z"], { env }).split("\0").filter(Boolean);
  const forbidden = files.filter((file) => FORBIDDEN.test(file));
  if (forbidden.length > 0) {
    fail(`Refusing to publish forbidden files:\n  ${forbidden.join("\n  ")}`);
  }
  tree = git(["write-tree"], { env });
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

if (tree === git(["rev-parse", `${parent}^{tree}`])) {
  console.log("[publish-source] The public repository already has this tree; nothing to publish.");
  process.exit(0);
}

const message = options.message ?? `Cortex Studio ${version} source`;
const commit = git(["commit-tree", tree, "-p", parent], { input: `${message}\n` });

// Scan exactly what would become public: the new commit's changes.
const scan = spawnSync("gitleaks", ["git", "--no-banner", "--redact", `--log-opts=${parent}..${commit}`, "."], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (scan.error) fail(`gitleaks is required for the secret scan: ${scan.error.message}`);
if (scan.status !== 0) fail(`gitleaks reported possible secrets in ${commit}; nothing was pushed.`);

console.log(`[publish-source] Built ${commit} (${version}) on public/main ${parent.slice(0, 7)}.`);

if (!options.push) {
  console.log(`[publish-source] Review it with: git show --stat ${commit}`);
  console.log("[publish-source] Rerun with --push to publish it.");
  process.exit(0);
}

// main requires passing checks, so the snapshot lands on a branch and reaches
// main through a pull request once CI and the asset policy have run on it.
const branch = `source/v${version}`;
git(["push", pushUrl, `${commit}:refs/heads/${branch}`]);
const pr = spawnSync(
  "gh",
  [
    "pr",
    "create",
    "--repo",
    `${match[1]}/${match[2]}`,
    "--base",
    "main",
    "--head",
    branch,
    "--title",
    message,
    "--body",
    `Source snapshot of Cortex Studio ${version}, built by tools/publish-source.mjs.`,
  ],
  { cwd: repoRoot, encoding: "utf8" },
);
if (pr.error || pr.status !== 0) {
  fail(`Pushed ${branch}, but opening the pull request failed: ${pr.error?.message ?? pr.stderr.trim()}`);
}
console.log(`[publish-source] Pushed ${branch}: ${pr.stdout.trim()}`);
console.log("[publish-source] Merge it with a rebase once its checks pass.");
