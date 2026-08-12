# Releasing Cortex Studio

Releases are built, updater-signed, uploaded, and published by GitHub Actions on a Windows runner. A local release does not need `bun run build`, a signing-password prompt, or manual GitHub uploads.

## One-time signing setup

The repository needs these GitHub Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Set or replace the password without putting it in shell history:

```powershell
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo IEver3st/cortex-labs
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
