This folder is bundled into Cortex Studio as a Tauri resource.

Run `node tools/publish-bridge.mjs` (or `bun run tauri build`, which runs it
through beforeBuildCommand) to publish the self-contained CodeWalkerBridge.exe
and its runtime here. Published files are git-ignored; this README keeps the
resource glob valid for dev builds that use the tools/codewalker-bridge output.
