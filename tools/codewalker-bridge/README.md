# CodeWalker Bridge

This sidecar parses `.yft` files using CodeWalker.Core and emits a `.clmesh` cache used by the UI. It also indexes the installed GTA V archives so the app can list and extract freemode ped assets and export `.ytd` texture dictionaries to DDS.

## Build (dev)

```
dotnet build -c Release
```

The executable will usually be at:

```
tools/codewalker-bridge/bin/Release/net10.0/CodeWalkerBridge.exe
```

Debug builds of Cortex Studio look here (and in the Debug/net8.0 variants) after the bundled resource path, and will run `dotnet build -c Release` automatically on first use when no executable exists.

## Publish (bundled builds)

```
node tools/publish-bridge.mjs
```

This runs `dotnet publish -c Release -r win-x64 --self-contained true -p:PublishReadyToRun=true -p:PublishSingleFile=false` and writes the result to `src-tauri/bin/codewalker-bridge/`, which `tauri.conf.json` bundles as a resource (`bin/codewalker-bridge/**`). `beforeBuildCommand` runs this script, so `bun run tauri build` publishes the bridge automatically. Add an npm script alias if convenient:

```
"bridge:publish": "node tools/publish-bridge.mjs"
```

Release builds of Cortex Studio only look at the bundled resource path and report that path when the bridge is missing; they never try to build it.

## Modes

### One-shot

```
CodeWalkerBridge.exe --input <file.yft> --output <file.clmesh>
```

Prints a JSON meta object to stdout and exits. Used as a fallback when serve mode fails.

### Serve

```
CodeWalkerBridge.exe --serve
```

Reads one JSON request per stdin line and writes one JSON response per stdout line. The GTA archive index (`RpfManager`, YTD lookup, txd parent relationships) and the Jenkins string index are built once and reused across requests, which removes the per-parse RPF rescan. Diagnostics go to stderr only. See `docs/yft-cli-contract.md` for the protocol and op list.

## Dependencies

This project references CodeWalker.Core from `external/CodeWalker/CodeWalker.Core` (sibling of the repository root).
Clone the CodeWalker repository into `external/CodeWalker` before building.
