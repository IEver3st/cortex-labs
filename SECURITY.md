# Security Policy

## Reporting a vulnerability

Report security problems privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, pull request, or discussion for a security problem.

Include the Cortex Studio version, the affected area, reproduction steps, and the impact you expect. Leave out credentials, paid assets, and personal files.

Reports are handled on a best-effort basis by a single maintainer. There is no bug bounty.

## Scope

- The Cortex Studio desktop app: the React renderer, the Tauri/Rust native layer, its capabilities, and its file access.
- The CodeWalker bridge sidecar in `tools/codewalker-bridge/`.
- The updater: release signing and the `latest.json` manifest.
- The documentation site's server routes in `docs/site/src/app/api/`.

Problems in CodeWalker, Tauri, or other third-party projects belong with those projects, unless Cortex Studio uses them in an unsafe way.

## Supported versions

Only the latest release receives security fixes. The in-app updater installs releases signed with the project's updater key; a build from any other source is not an official release.
