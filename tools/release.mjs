import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHECK_ONLY = process.argv.includes("--check");

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), "utf8");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    ...options,
  });

  if (result.status !== 0) {
    const detail = options.capture ? (result.stderr || result.stdout || "").trim() : "";
    fail(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}.`);
  }

  return options.capture ? result.stdout.trim() : "";
}

function git(...args) {
  return run("git", args, { capture: true });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadRelease() {
  const packageVersion = JSON.parse(read("package.json")).version;
  const tauriVersion = JSON.parse(read("src-tauri/tauri.conf.json")).version;
  const cargoMatch = read("src-tauri/Cargo.toml").match(/^version\s*=\s*"([^"]+)"/m);
  const cargoVersion = cargoMatch?.[1] || "";

  if (!packageVersion || packageVersion !== tauriVersion || packageVersion !== cargoVersion) {
    fail(
      `Version mismatch: package.json=${packageVersion || "missing"}, ` +
        `tauri.conf.json=${tauriVersion || "missing"}, Cargo.toml=${cargoVersion || "missing"}.`,
    );
  }

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageVersion)) {
    fail(`Unsupported release version "${packageVersion}".`);
  }

  const changelog = read("CHANGELOG.md");
  const headingPattern = new RegExp(`^## \\[${escapeRegex(packageVersion)}\\][^\\r\\n]*$`, "m");
  const headingMatch = headingPattern.exec(changelog);
  if (!headingMatch) {
    fail(`CHANGELOG.md has no release section for ${packageVersion}.`);
  }

  const afterHeading = changelog.slice(headingMatch.index + headingMatch[0].length).replace(/^\r?\n/, "");
  const nextSection = afterHeading.search(/^---\s*$|^##\s/m);
  const notes = (nextSection === -1 ? afterHeading : afterHeading.slice(0, nextSection)).trim();
  if (!notes) {
    fail(`CHANGELOG.md release section ${packageVersion} has no notes.`);
  }

  return {
    version: packageVersion,
    tag: `v${packageVersion}`,
    name: `Cortex Studio v${packageVersion}`,
    notes,
  };
}

function writeGithubOutput(release) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;

  let releaseDraft = "true";
  if (process.env.GITHUB_REPOSITORY) {
    const result = spawnSync(
      "gh",
      ["release", "view", release.tag, "--repo", process.env.GITHUB_REPOSITORY, "--json", "isDraft"],
      { cwd: ROOT, encoding: "utf8", stdio: "pipe" },
    );
    if (result.status === 0) {
      releaseDraft = JSON.parse(result.stdout).isDraft ? "true" : "false";
    }
  }

  const delimiter = `release_notes_${crypto.randomUUID()}`;
  fs.appendFileSync(
    outputPath,
    [
      `version=${release.version}`,
      `tag=${release.tag}`,
      `name=${release.name}`,
      `release_draft=${releaseDraft}`,
      `notes<<${delimiter}`,
      release.notes,
      delimiter,
      "",
    ].join("\n"),
  );
}

function validateWorkflowRef(release) {
  if (process.env.GITHUB_EVENT_NAME === "push" && process.env.GITHUB_REF_NAME !== release.tag) {
    fail(`Git tag ${process.env.GITHUB_REF_NAME} does not match app version ${release.tag}.`);
  }
  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch" && process.env.GITHUB_REF_NAME !== "main") {
    fail(`Manual releases must run from main, not ${process.env.GITHUB_REF_NAME || "an unknown ref"}.`);
  }
}

function repositoryFromOrigin() {
  const remote = git("remote", "get-url", "origin");
  const match = remote.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  if (!match) fail(`Could not identify a GitHub repository from origin (${remote}).`);
  return match[1];
}

function dispatch(release) {
  if (git("status", "--porcelain")) {
    fail("The working tree is not clean. Commit or stash changes before releasing.");
  }

  const branch = git("branch", "--show-current");
  if (branch !== "main") {
    fail(`Releases must be started from main; current branch is ${branch || "detached"}.`);
  }

  const repository = repositoryFromOrigin();
  run("gh", ["auth", "status"], { capture: true });

  const secretNames = JSON.parse(
    run("gh", ["api", `repos/${repository}/actions/secrets`, "--jq", "[.secrets[].name]"], { capture: true }),
  );
  for (const required of ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"]) {
    if (!secretNames.includes(required)) fail(`GitHub Actions secret ${required} is missing.`);
  }

  const existingRelease = spawnSync(
    "gh",
    ["release", "view", release.tag, "--repo", repository, "--json", "isDraft,url"],
    { cwd: ROOT, encoding: "utf8", stdio: "pipe" },
  );
  if (existingRelease.status === 0 && !JSON.parse(existingRelease.stdout).isDraft) {
    fail(`${release.tag} is already published. Bump the app version before starting another release.`);
  }

  run("git", ["fetch", "origin", "main", "--tags"]);
  const localHead = git("rev-parse", "HEAD");
  const remoteHead = git("rev-parse", "origin/main");
  if (localHead !== remoteHead) {
    const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], {
      cwd: ROOT,
      stdio: "ignore",
    });
    if (ancestor.status !== 0) {
      fail("Local main and origin/main have diverged. Reconcile them before releasing.");
    }
    run("git", ["push", "origin", "HEAD:main"]);
  }

  run("gh", ["workflow", "run", "release.yml", "--repo", repository, "--ref", "main"]);
  console.log(`[release] ${release.tag} queued: https://github.com/${repository}/actions/workflows/release.yml`);
}

const release = loadRelease();
validateWorkflowRef(release);
writeGithubOutput(release);
console.log(`[release] Validated ${release.tag}.`);

if (!CHECK_ONLY) dispatch(release);
