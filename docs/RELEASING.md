# Releasing Cortex Studio

Releases are built, updater-signed, uploaded, and published by GitHub Actions on a Windows runner. A local release does not need `bun run build`, a signing-password prompt, or manual GitHub uploads.

## One-time signing setup

The Release workflow runs only in the private source repository, `IEver3st/Cortex-Studio`, which needs these GitHub Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `PUBLIC_RELEASE_TOKEN` (contents: write on `IEver3st/cortex-labs`)

Never add them to the public repository. Set or replace a secret without putting it in shell history:

```powershell
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo IEver3st/Cortex-Studio
```

The GitHub CLI prompts for the value securely. The password must unlock the private key stored in `TAURI_SIGNING_PRIVATE_KEY`; do not paste either secret into an issue, commit, workflow file, or `VITE_*` variable.

## Start a release

1. Keep the version identical in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
2. Add the matching `## [x.y.z]` section to `CHANGELOG.md` and commit the release changes on `main`.
3. Run:

```powershell
bun run release
```

The command checks the release metadata and clean worktree, pushes an ahead-only `main`, and dispatches the Release workflow. The workflow runs tests and Rust checks, builds the Windows MSI and NSIS installers, signs the updater artifact, creates `latest.json`, uploads everything to a draft release, verifies the required assets, and only then publishes it.

The same workflow can be started from **GitHub → Actions → Release → Run workflow**. Pushing a matching `v*` tag also starts it, but the one-command path creates the version tag through the release workflow.

## Failure behavior

- A signing, test, build, upload, or asset-verification failure leaves the release as a draft.
- Rerun the workflow after correcting the failure; it reuses the matching release.
- If signing reports `incorrect updater private key password`, replace `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` with the password for the stored private key.
- A published version is immutable through `bun run release`; bump the version before publishing another release.

## Publish the source

The public repository receives one source commit per release on top of its own `main`. The private history is never pushed, because older commits contain game and creator assets.

```powershell
node tools/publish-source.mjs --ref <release-commit>
node tools/publish-source.mjs --ref <release-commit> --push
```

It needs a `public` git remote pointing at `IEver3st/cortex-labs`, `gitleaks` on `PATH`, and an authenticated `gh`. The first run builds the commit without publishing it. The script drops maintainer-only files (`AGENTS.md`, agent rule folders), refuses GTA binary formats, caches, and credential files, and runs `gitleaks` over exactly the changes that would become public. `--push` pushes the commit to a `source/v<x.y.z>` branch and opens a pull request, because `main` requires the CI and asset-policy checks. Merge it with **Rebase and merge** once they pass; `main` rejects force pushes.

Pull requests merged on the public repository have to be applied to the private source before the next release, or the next snapshot will undo them.
