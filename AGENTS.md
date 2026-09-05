# Cortex Studio

Cortex Studio is a Windows-first livery development environment for GTA V and FiveM. The shipped product is a Tauri 2 desktop app: React owns the workflow UI, Three.js owns real-time previews, Rust owns native file/process integration, and the CodeWalker bridge converts supported game assets into the cache format consumed by the renderer.

Favor ambitious product improvements, but keep the implementation legible and the user's edit-preview-export loop obvious. Solve the actual constraint with the smallest complete model; do not preserve accidental complexity or introduce architecture for its own sake.

## Product promises

These are the properties ordinary changes must protect.

### 1. User assets remain authoritative

- Treat selected models, textures, PSDs, PDNs, and workspace inputs as user-owned source material.
- Never silently overwrite, move, rename, or delete source assets. Caches and exports belong in explicit derived destinations.
- File writes must be user-initiated or part of a clearly selected export workflow. Surface partial writes and failures instead of reporting success.

### 2. Fidelity comes before convenient guesses

- Preserve geometry ordering, indices, UV channels, drawable identity, material bindings, texture metadata, layer visibility, and explicit user selections across conversions.
- Validate binary offsets, counts, dimensions, and versions before allocation or traversal. Reject malformed or unsupported input with an actionable error instead of fabricating plausible output.
- Native material assignment is a best-effort preview, not GTA shader parity. Manual texture selections remain the final override on targeted meshes.
- Contract or cache changes require a compatibility decision. Do not reinterpret an existing `.clmesh` or manifest version in place.

### 3. The preview loop stays responsive

- Keep decoding, parsing, template generation, and filesystem work out of render-frame and input-hot paths. Prefer the existing worker, native, and cache boundaries.
- Dispose replaced Three.js geometries, materials, textures, render targets, controls, and renderers. Revoke object URLs and stop workers, watchers, timers, listeners, and animation frames during replacement or unmount.
- Avoid repeated parsing, GPU uploads, broad React rerenders, and continuously repainting decorative effects. Users notice dropped frames while iterating on large assets.

### 4. Desktop behavior is the real integration boundary

- `bun run dev` is useful for UI-only work, but browser mode does not prove native dialogs, watches, sidecars, file associations, updater behavior, or filesystem access.
- Gate Tauri-only calls and preserve a clear browser fallback or unavailable state where the current workflow supports one.
- Changes that cross the frontend/native boundary must keep the JavaScript invoke name and payload, Rust command, Tauri capability, and CSP implications aligned.

## The easiest ways to cause damage

1. **Writing outside the selected workflow.** `src-tauri/capabilities/default.json` permits broad user-directory access, and Rust commands receive paths from the renderer. Validate intent and paths at the narrowest useful boundary; do not turn a picker-scoped operation into an ambient filesystem mutation.
2. **Leaking credentials.** `.env` is ignored and may contain GitHub or release credentials. Do not read, print, expose, or commit it. Anything named `VITE_*` is compiled into client code and must be public. Keep `GITHUB_TOKEN` and signing keys in the Rust/Next.js server or release environment only.
3. **Drifting the sidecar contract.** A bridge change can appear correct while breaking cache lookup, manifest resolution, LOD choice, or the frontend parser. Treat the C# bridge, Rust runner/cache, JavaScript parser/material pipeline, and contract docs as one interface.
4. **Faking a release.** A local build does not prove a signed updater release. Version metadata, signing, generated `latest.json`, uploaded assets, and the GitHub release must agree before calling a release complete.
5. **Killing shared processes by name.** Do not stop Vite, Tauri, Node, Bun, `dotnet`, or Cortex processes by name or pattern. Stop only a process you started and identified directly.

## Check every affected surface

Most regressions here come from completing one path while missing its sibling. Before calling a change done, decide which of these apply:

- **Runtime:** browser UI and the Tauri desktop host.
- **Entry points:** shell/tab flow, onboarding, Settings, context menus, hotkeys, file association/open-with, and drag/drop or pickers.
- **Workflows:** Livery, All Textures, EUP, Multi, Variant Builder, Template Generator, preview capture, and export.
- **Format paths:** JavaScript parser, native fallback, CodeWalker sidecar, cache/manifest reload, and manual override behavior.
- **Persistence:** defaults, normalization of older localStorage data, workspace/session restore, and save-failure reporting.
- **Lifecycle:** initial load, replacement, cancellation, unmount, watcher restart, and error recovery—not only the success path.
- **Documentation:** user-visible behavior in `README.md` and `docs/site/content/docs/`; contributor architecture or contract details in developer/reference docs.

State which surfaces were not applicable when the omission would otherwise be ambiguous.

## Architecture boundaries

- `src/Shell.jsx` owns application chrome, tabs, onboarding, settings integration, and top-level navigation.
- `src/App.jsx` coordinates the primary viewer workflows, file selection, watches, texture reload, capture, and export.
- `src/components/Viewer.jsx` and `DualModelViewer.jsx` own Three.js renderer lifecycles. Shared rendering or parsing behavior belongs in `src/lib/` when it is not component-specific.
- `src/lib/` contains format parsers, texture/material logic, template generation, persistence, updater, capture, and reusable viewer behavior. Keep parser/math helpers deterministic enough for direct Node tests.
- `src-tauri/src/lib.rs` is the native trust boundary for dialogs, watchers, sidecar execution, PDN fallback, folder opening, updater inspection, and native bug submission.
- `tools/codewalker-bridge/` is the .NET sidecar. Its public interface is the CLI/stdout/stderr/cache/manifest contract, not its internal CodeWalker representation.
- `docs/site/` is an independent Bun/Next.js/Fumadocs project. Its API routes are server code; its rendered pages are public client content.

Keep `docs/yft-cli-contract.md` and `docs/site/content/docs/reference/yft-cli-contract.mdx` semantically synchronized when the sidecar, manifest, cache schema, discovery, or fallback behavior changes. The MDX copy may use site-specific frontmatter and tighter presentation.

`CHANGELOG.md` is release history. `src/changelog.md` is the separately formatted in-app What's New source parsed by `src/lib/changelog.js`; do not make their formats interchangeable.

Generated output includes `dist/`, `src-tauri/target/`, `src-tauri/gen/`, `docs/site/.next/`, and `docs/site/.source/`. Regenerate these through their owners and do not hand-edit or commit them.

## Working in the repository

Use Bun in the app and `docs/site`, preserving their lockfiles. Root test scripts intentionally use Node's test runner; `package.json` owns focused suites such as `test:clmesh`, `test:native-materials`, `test:pdn`, and `test:template`.

Use `bun run build` for the renderer. For Rust changes, use Cargo fmt/check/clippy against `src-tauri/Cargo.toml` as applicable. Docs have their own `types:check`, `build`, and changed-file lint scripts under `docs/site`.

The CodeWalker bridge targets .NET 10 and needs `external/CodeWalker/CodeWalker.Core` outside this repository. When available and relevant, build `tools/codewalker-bridge/CodeWalkerBridge.csproj` in Release. A missing external checkout is not an unrelated app failure. Native verification follows global monitor and process-ownership restrictions.

## Verification

Use the smallest focused proof first, then cover the integration boundary actually changed.

- Parser, material, or template behavior: add or update a direct `node:test` regression and run its package script. Include malformed/boundary input when changing binary parsing.
- React or renderer behavior: run the relevant focused tests and `bun run build`; exercise the affected workflow in `bun run tauri dev` when native files, watches, exports, or dialogs are involved.
- Rust commands, capabilities, or CSP: run Rust formatting and checks plus the renderer build. Exercise both the successful call and its failure state.
- Sidecar or `.clmesh`/manifest behavior: build the sidecar when dependencies exist, run the focused CLMESH/material tests, and verify one non-sensitive representative asset through the CLI-to-viewer path.
- Documentation content changes: run the type check; build when routing, MDX configuration, API routes, or dependencies change. For docs-site code or config, lint only the changed Biome-owned paths unless the task is explicitly a repository-wide formatting cleanup.
- Release changes: keep `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` versions identical. Use `bun run tauri build` only when packaging is in scope and the required signing environment is available.

Do not weaken assertions, silently skip a failing path, or replace an end-to-end contract check with a mocked success merely to make a gate green. If a required gate cannot run, report the exact missing prerequisite and what remains unverified.

## Implementation taste

- Before any UI, layout, styling, or visual review work, read `DESIGN.md` completely and apply its project signature, decision order, stress cases, and native-rendered proof requirements.
- Follow the surrounding ESM JavaScript/JSX and Rust style. Avoid broad formatting or unrelated cleanup in a focused change.
- Extend existing CSS custom properties and controls before inventing a parallel visual system. Keep dense desktop workflows readable at the supported minimum window size.
- Preserve explicit user choices across regeneration and reload. A heuristic may suggest a default; it must not erase a manual choice.
- Keep format-specific policy close to the format boundary and generic orchestration free of filename or material-name folklore.
- Errors should identify the failed operation and relevant format/path context without including credentials or file contents.
- Comments explain non-obvious contracts, ownership, or why a workaround must exist. Do not narrate ordinary code.
- Add dependencies only when the capability cannot be expressed cleanly with the existing stack; account for desktop bundle size and offline behavior.

## Changes, documentation, and releases

- Add user-visible changes to `CHANGELOG.md` under `Unreleased`. Update `src/changelog.md` only when preparing the in-app What's New content for a release.
- Update supported-format, workflow, troubleshooting, or CLI-contract docs when behavior changes; do not document planned behavior as shipped.
- Do not commit, push, tag, publish, or open a pull request unless explicitly asked.
- A green local build is implementation evidence, not authority to claim that signing, updater publication, clean-machine installation, or the public release succeeded.
