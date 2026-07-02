# YFT Parser CLI Contract

The app previews `.yft` (GTA V / FiveM) by parsing the fragment data with a CodeWalker-based sidecar and writing a mesh cache (`.clmesh`) plus a manifest (`manifest.json`).

This document defines the required CLI contract for the parser sidecar.

## Executable

- Windows: `CodeWalkerBridge.exe`

The app looks for the binary in:

- Dev: `tools/codewalker-bridge/bin/Release/net10.0/CodeWalkerBridge.exe`
- Dev (fallback): `tools/codewalker-bridge/bin/Debug/net10.0/CodeWalkerBridge.exe`
- Dev: `tools/codewalker-bridge/bin/Release/net8.0/CodeWalkerBridge.exe`
- Dev (fallback): `tools/codewalker-bridge/bin/Debug/net8.0/CodeWalkerBridge.exe`
- Bundled: `<resourceDir>/bin/codewalker-bridge/CodeWalkerBridge.exe`

## Command

```
CodeWalkerBridge.exe --input <path-to-yft> --output <path-to-clmesh>
```

### Output

- Writes the mesh cache to the `--output` path.
- Writes `manifest.json` in the same cache folder as the mesh output.
- Writes extracted texture DDS files under `textures/` in the same cache folder when embedded or sibling `.ytd` textures are available.
- Prints a JSON object to stdout with counts:

```json
{
  "meshCount": 12,
  "vertexCount": 44123,
  "indexCount": 88246,
  "materialCount": 8,
  "textureCount": 19,
  "manifestPath": "C:/Users/.../model-cache/manifest.json"
}
```

### Manifest

The bridge writes `manifest.json` next to `model.clmesh` with per-geometry metadata needed for higher-fidelity texture resolution.

Current manifest fields:

- `version`: manifest schema version.
- `inputPath`: original YFT input path.
- `generatedAtUtc`: manifest generation timestamp.
- `meshCount`: number of emitted geometry records.
- `textureCount`: number of exported texture DDS files in the cache.
- `textures[]`:
  - `name`: texture name from CodeWalker metadata.
  - `source`: `ytd` for sibling dictionary textures or `embedded` for drawable-embedded textures.
  - `relativePath`: path relative to the cache root, suitable for joining against `manifest.json`.
  - `nameHash`: original texture name hash when available.
- `meshes[]`:
  - `name`: cache mesh name.
  - `materialName`: legacy material name used by `.clmesh`.
  - `shaderName`: CodeWalker shader name.
  - `shaderHash`: raw shader hash.
  - `shaderFileName`: shader preset file name when available.
  - `renderBucket`: render bucket from the drawable shader.
  - `drawableIndex`, `modelIndex`, `geometryIndex`: original drawable/model/geometry coordinates.
  - `uvSets`: availability flags for `uv0` through `uv3`.
  - `textureBindings[]`:
    - `paramName`: raw shader sampler parameter name.
    - `textureName`: texture name resolved from CodeWalker metadata.
    - `relativePath`: exported DDS path relative to the cache root when resolution succeeded.
    - `source`: `ytd` or `embedded` when the bridge resolved the texture.
    - `nameHash`: original texture name hash when available.
    - `usage`: bridge-classified usage such as `baseColor`, `normal`, `emissive`, `specular`, `detail`, `mask`, or `ambientOcclusion`.
    - `uvSet`: optional UV-set index when known.
  - `textureRefs`: sampler-name to texture-name mapping extracted from shader parameters.
  - `resolvedTexturePaths`: sampler-name to exported DDS relative path mapping when the bridge could resolve a concrete texture file.

### Mesh cache schema

- `.clmesh` magic remains `CLM1`.
- Version `1` stores positions, optional normals, optional `uv0`, and indices.
- Version `2` extends the cache with optional `uv1`, `uv2`, and `uv3` payloads after `uv0`, preserving the same vertex/index ordering.

### Exit codes

- `0`: success; output file exists.
- non-zero: failure; app will surface stderr/stdout.

### Output streams

- `stderr`: human-readable progress logs or errors.
- `stdout`: JSON metadata (see above).

## Notes

- The app caches parsed meshes based on input path + modified time + file size.
- The `.clmesh` cache is parsed in the frontend into Three.js geometry.
- `manifest.json` drives shader-aware texture resolution in the frontend, while manual texture overrides still remain optional.
- Current frontend binding is best-effort Three.js material assignment rather than full GTA shader parity.
