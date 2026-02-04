# CodeWalker Bridge

This sidecar parses `.yft` files using CodeWalker.Core and emits a `.clmesh` cache used by the UI.

## Build

```
dotnet publish -c Release
```

The executable will be at:

```
tools/codewalker-bridge/bin/Release/net8.0/CodeWalkerBridge.exe
```

For bundled builds, copy the output to:

```
src-tauri/bin/codewalker-bridge/CodeWalkerBridge.exe
```

## Dependencies

This project references CodeWalker.Core from `external/CodeWalker/CodeWalker.Core`.
Clone the CodeWalker repository into `external/CodeWalker` before building.
