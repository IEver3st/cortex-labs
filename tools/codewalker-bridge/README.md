# CodeWalker Bridge

This sidecar parses `.yft` files using CodeWalker.Core and emits a `.clmesh` cache used by the UI.

## Build

```
dotnet build -c Release
```

The executable will usually be at:

```
tools/codewalker-bridge/bin/Release/net10.0/CodeWalkerBridge.exe
```

If you use `dotnet publish -c Release`, the published executable will be under:

```
tools/codewalker-bridge/bin/Release/net10.0/publish/CodeWalkerBridge.exe
```

For bundled builds, copy the output to:

```
src-tauri/bin/codewalker-bridge/CodeWalkerBridge.exe
```

For source dev builds, Cortex will also try to auto-build the bridge on first `.yft` parse if the source project exists and `dotnet` is available on `PATH`.

## Dependencies

This project references CodeWalker.Core from `external/CodeWalker/CodeWalker.Core`.
Clone the CodeWalker repository into `external/CodeWalker` before building.
