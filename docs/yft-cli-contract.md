# YFT Parser CLI Contract

The app previews `.yft` fragments, `.ydr` drawables and `.ydd` drawable dictionaries (GTA V / FiveM) by parsing them with a CodeWalker-based sidecar and writing a mesh cache (`.clmesh`) plus a manifest (`manifest.json`). The same sidecar indexes the installed GTA V archives for freemode ped assets and exports `.ytd` texture dictionaries to DDS.

This document defines the required contract for the sidecar: executable discovery, the one-shot CLI, the long-lived serve protocol, the Tauri commands that wrap it, and cache behavior.

## Executable

- Windows: `CodeWalkerBridge.exe`

Discovery order (first existing path wins):

1. Bundled: `<resourceDir>/bin/codewalker-bridge/CodeWalkerBridge.exe` (always checked first).
2. Debug builds only: `src-tauri/bin/codewalker-bridge/CodeWalkerBridge.exe`, then `tools/codewalker-bridge/bin/{Release,Debug}/{net10.0,net8.0}/[publish/]CodeWalkerBridge.exe`.

Debug builds run `dotnet build -c Release` on the bridge project when no executable is found. Release builds never build; they return an error naming the expected bundled path.

### Bundling

`node tools/publish-bridge.mjs` publishes a self-contained win-x64 ReadyToRun build into `src-tauri/bin/codewalker-bridge/`. `tauri.conf.json` bundles that folder as a resource (`bin/codewalker-bridge/**/*`) and `beforeBuildCommand` runs the publish script before every `tauri build`. Only `src-tauri/bin/codewalker-bridge/README.txt` is tracked (it keeps the resource glob valid for dev builds); published binaries are git-ignored. Suggested npm alias: `"bridge:publish": "node tools/publish-bridge.mjs"`.

## One-shot command

```
CodeWalkerBridge.exe --input <path-to-yft|ydr|ydd> --output <path-to-clmesh>
```

The app uses this only as a fallback when the serve process fails at the transport level during `parseYft`: it crashed, timed out, or wrote a line that breaks the protocol. An error the bridge reports for the model (unsupported or malformed input), a cancelled request, and a missing bridge are returned as they are, without a second run. The one-shot run gets the same 600 s timeout as a serve parse and is killed on timeout, cancel, or app exit. Exit code 0 with stdout that is not a JSON object is an error.

### Output

- Writes the mesh cache to the `--output` path.
- Writes `manifest.json` in the same cache folder as the mesh output.
- Both files are written to `<name>.tmp` and moved into place, so an interrupted run never leaves a truncated file under the final name.
- Writes extracted texture DDS files under `textures/` in the same cache folder when embedded, sibling, resource, or shared game `.ytd` textures are available.
- Texture names resolve to the first dictionary that has them: sibling `.ytd` files (`source: ytd`), then the resource's `stream/` dictionaries named by the vehicle's texture chain, then the game archives for the chain's names, their parents and `vehshare` (`source: shared`). A dictionary the resource streams itself, a sibling or resource `.ytd` with the same file name as a chain name, replaces the game's dictionary of that name, as streaming does in game. The game copy of that name is not read, so a texture missing from the resource's dictionary stays missing instead of showing the game's version; its parents and `vehshare` still come from the game files. Before manifest v12 the game copy was read too and filled names the resource's dictionary lacked.
- For `.ydr` and `.ydd` input, the vehicle `vehicles.meta` chain is skipped. Instead the bridge reads the `.ytyp` files in the resource (the folder holding `fxmanifest.lua` or `__resource.lua`, searched up to six levels deep; without one, only the model's own folder) for archetypes whose name matches the model, or whose drawable dictionary matches a `.ydd`. It exports the `.ytd` each archetype names from the resource (`source: ytd`) and, by name or hash, from the game archives with its parent dictionaries, plus a game dictionary named after the model (`source: shared`). A dictionary the resource streams is not read from the game archives, as for vehicles. At most 256 `.ytyp` files of up to 32 MB each are read.
- Prints a JSON object to stdout with counts, warnings and inputs:

```json
{
  "meshCount": 12,
  "vertexCount": 44123,
  "indexCount": 88246,
  "materialCount": 8,
  "textureCount": 19,
  "manifestPath": "C:/Users/.../model-cache/manifest.json",
  "warnings": ["car.ytd could not be read, so its textures are missing: ..."],
  "inputs": [
    { "path": "C:/.../stream/car.ytd", "mtimeMs": 1791487853205, "size": 3893340 },
    { "path": "C:/.../stream/car+hi.ytd", "missing": true }
  ]
}
```

- `warnings`: what the parse skipped instead of failing, one short sentence each naming the file or texture, never file contents: a texture that could not be exported, a sibling, resource or game `.ytd` that could not be read, a `vehicles.meta`, `gtxd.meta` or `.ytyp` that could not be read, and a wheel or light bone left out because its transform holds NaN or infinite values. At most 200.
- `inputs`: every file the parse depended on besides the model itself, stated before it was read: sibling `.ytd` candidates, resource `stream/` dictionaries named by the vehicle's texture chain, `vehicles.meta` and `gtxd.meta` under the resource's `data/` folder, scanned `.ytyp` files, and resource `.ytd` files found by archetype hash. `mtimeMs` is the last write time in whole milliseconds since the Unix epoch and `size` the length in bytes, as the host's file stat reports them. `missing: true` marks a candidate the bridge looked for and did not find. An entry with only `path` could not be inspected. Files found by scanning a folder are recorded only when they existed at parse time, and the game archives are not recorded.

### Exit codes

- `0`: success; output file exists.
- `2`: usage error.
- `3`: no meshes extracted, or the model is malformed: more than 65535 meshes (the `.clmesh` count is 16-bit), or a NaN or infinite number left in data the manifest stores (skeleton, joint limits, light or material values).
- other non-zero: failure; app will surface stderr/stdout.

### Output streams

- `stderr`: human-readable progress logs, warnings, and errors, including CodeWalker.Core diagnostics.
- `stdout`: the JSON summary only (see above).

## Serve mode

```
CodeWalkerBridge.exe --serve
```

The app spawns one serve-mode process per session (hidden window, `CREATE_NO_WINDOW`) on the first bridge request. Every bridge process, serve or one-shot, joins a Windows job object created with kill-on-close, so it dies with the app even after a crash or end-task. On a normal exit the app kills the bridge processes directly without waiting for a request in flight, and no request starts afterwards. The process caches the Jenkins string index and the GTA archive index (`RpfManager`, `.ytd` lookup with priority, txd parent relationships) after the first request that needs them, so later parses skip the RPF rescan.

Protocol: one JSON object per stdin line, one JSON object per stdout line. `stdout` carries protocol lines only; all diagnostics (including CodeWalker.Core output) go to `stderr`.

```json
{"id": 1, "op": "parseYft", "input": "C:/.../car.yft", "output": "C:/.../model.clmesh"}
{"id": 1, "ok": true, "result": { "meshCount": 12, "...": "..." }}
{"id": 2, "ok": false, "error": "Unknown op 'x'."}
```

Requests are processed sequentially. The app serializes access and applies a timeout per op:

- 120 s for ops that never touch the game archives: `exportYtd`, `writeYtdTextures`, `readPedVariation`, `writePedVariation`, `writeCreatureMetadata`, `listClipFile`, `exportClipFile`, `describePedFiles`, and `exportModelClip` when the clip comes from a resource `.ycd`.
- 600 s for `parseYft` and every op that may trigger the one-time archive scan: `warmSharedTextures`, `listPedAssets`, `exportPedAsset`, `searchPeds`, `describeGamePed`, `listPedClips`, `exportPedClip`, `searchAnimDicts`, `searchGameProps`, `exportGameProp`, `listGameVehicles`, `exportGameVehicle`, `exportGameVehicleMods`, `lookupGameText`, `exportPlateTextures`, `readCollisions` (it reads the game's collision material names), and `exportModelClip` from the game files.

The app recycles the process after any transport failure, timeout, or cancel; the next command respawns it, which repeats the archive scan when an op needs it.

### Cancelling a parse

`parse_yft` accepts an optional `requestToken`: 1-64 characters of `A-Z`, `a-z`, `0-9`, `_` and `-`, unique among requests in flight (for example `crypto.randomUUID()`). `cancel_bridge_request({ token })` stops only the request registered with that token:

- `"running"`: the bridge was working on it. The serve process (or the one-shot fallback) is killed, and the parse rejects with exactly `Bridge request cancelled.`
- `"queued"`: it had not reached the bridge yet. It rejects with the same text when its turn comes, without starting the bridge.
- `"none"`: no request with that token is in flight; it already finished or never existed.

A cancelled parse leaves no cache entry. Because cancelling a running parse kills the serve process, the next archive op pays the archive scan again.

How the app uses it: model loads in the single viewer, Multi, Prop Studio, Photo Mode and EUP held props go through `requestBridgeParse` (`src/lib/model-load.js`), and loads of the same model share one parse (a forced parse also serves a plain load). A load that is replaced or closed lets go of its parse. A parse nobody waits for any more is cancelled when a parse of another model starts, which would otherwise queue behind it, or after 2 s; a load of the same model within that time, such as a viewer remounting on a mode switch, joins it instead. A cancel answered with `"none"` while the parse is still pending (it had not registered its token yet) is repeated a few times. A parse that has finished is never cancelled. Mod kit part parses carry no token.

### Ops

| op | params | result |
| --- | --- | --- |
| `ping` | none | `{}` |
| `warmSharedTextures` | none | `{ "available": true }`; builds the shared GTA texture index (the slow RPF scan) ahead of the first parse that needs it. `available` is false when no GTA V install was detected. The app sends it in the background when a vehicle's mod kits are found. |
| `parseYft` | `input`, `output` | same meta object as the one-shot CLI, including `warnings` and `inputs` |
| `listPedAssets` | `ped` | `{ "ped": "mp_m_freemode_01", "entries": [ { "folder": "mp_m_freemode_01", "file": "uppr_000_r.ydd", "kind": "ydd", "rpfPath": "x64v.rpf\\models\\cdimages\\streamedpeds_mp.rpf\\mp_m_freemode_01\\uppr_000_r.ydd", "size": 398208 } ], "collections": [ { "folder": "mp_m_freemode_01", "pack": "", "order": -1 }, { "folder": "mp_m_freemode_01_male_freemode_beach", "pack": "mpbeach", "order": 0 } ] }` |
| `searchPeds` | `query` | `{ "query": "cop", "peds": [ "s_m_y_cop_01" ], "total": 8 }` |
| `describeGamePed` | `ped` | a ped description (below) with `"source": "game"` |
| `describePedFiles` | `files` (absolute paths), `ped` (`""` to detect) | a ped description with `"source": "files"`, or `{ "ped": "", "candidates": [ "a_c_chop", "s_m_y_cop_01" ] }` when the files hold several peds and `ped` is empty |
| `listPedClips` | `dict` | `{ "dict": "move_m@generic", "clips": [ { "name": "walk", "duration": 2.1 } ] }` |
| `exportPedClip` | `dict`, `clip` | `{ "dict": "...", "clip": "walk", "duration": 2.1, "sampleRate": 30, "samples": 64, "rotations": [ { "bone": 0, "values": [x, y, z, w, ...] } ], "translations": [ { "bone": 0, "values": [x, y, z, ...] } ], "moverVelocity": [x, y, z] }` |
| `exportModelClip` | `dict`, `clip`, `ycdPath` | same shape as `exportPedClip`; `ycdPath` is a resource `.ycd` file, or `""` to read `<dict>.ycd` from the game files |
| `searchAnimDicts` | `query` | `{ "query": "cop idles", "dicts": [ "amb@world_human_cop_idles@male@base" ], "total": 6 }` |
| `listClipFile` | `ycdPath` | `{ "dict": "<file stem>", "clips": [ { "name": "salute", "duration": 1.6 } ] }` |
| `exportClipFile` | `ycdPath`, `clip` | same shape as `exportPedClip`, read from the `.ycd` at `ycdPath` |
| `searchGameProps` | `query` | `{ "query": "phone", "props": [ "prop_npc_phone_02" ], "total": 41 }` |
| `exportGameProp` | `name`, `outputDir` | `{ "path": "<outputDir>/<name>/<name>.ydr", "name": "prop_npc_phone_02", "rpfPath": "..." }` |
| `listGameVehicles` | none | `{ "vehicles": [ { "name": "police", "gameName": "POLICE", "make": "", "vehicleClass": "VC_EMERGENCY", "type": "VEHICLE_TYPE_CAR", "pack": "" } ], "total": 935 }` |
| `exportGameVehicle` | `name`, `outputDir` | `{ "path": "<outputDir>/<name>/stream/<name>_hi.yft", "name": "police", "rpfPath": "..." }` |
| `exportGameVehicleMods` | `name`, `outputDir` | `{ "name": "elegy", "kits": 1, "models": 225, "written": 225, "reused": 0, "missing": [] }` |
| `lookupGameText` | `hashes` (array of label hashes) | `{ "texts": { "1234567890": "Short Lip Spoiler" } }` |
| `exportPedAsset` | `ped`, `folder`, `file`, `outputDir` | `.ydd`: `{ "path": "<outputDir>/<folder>/<file>" }`; `.ytd`: `{ "dir": "<outputDir>/<folder>/<file-stem>", "textures": [ { "name": "uppr_diff_000_a_whi", "path": "<abs dds path>" } ] }` |
| `exportYtd` | `path`, `outputDir` | `{ "dir": "<outputDir>", "textures": [ { "name": "...", "path": "<abs dds path>" } ], "warnings": [ "Texture 'x' could not be exported: ..." ] }`; a dictionary that cannot be read fails with its file name and the reason |
| `writeYtdTextures` | `input`, `output`, `textures` (`[ { "name", "path", "mode", "source", "like" } ]`) | `{ "output": "<output>", "size": 4581900, "textureCount": 14, "textures": [ { "name": "nForce_Emis", "replaced": false, "width": 1024, "height": 1024, "levels": 11, "format": "D3DFMT_DXT5" } ] }` |
| `readPedVariation` | `path` | `{ "path": "<path>", "xml": "<CPedVariationInfo>...</CPedVariationInfo>" }` |
| `writePedVariation` | `xml`, `output` | `{ "output": "<output>", "size": 18432 }` |
| `writeCreatureMetadata` | `xml`, `output` | `{ "output": "<output>", "size": 468 }` |
| `exportPlateTextures` | `outputDir` | `{ "dir": "<outputDir>", "textures": [ { "name": "plate01", "path": "<abs dds path>" } ], "definitions": { "source": "update\update.rpf\x64\data\carcols.ymt", "defaultIndex": 0, "numericOffset": 0, "alphabeticOffset": 10, "spaceOffset": 63, "plates": [ { "index": 0, "diffuse": "plate01", "normal": "plate01_n", "fontExtents": [0.08, 0.355, 0.92, 0.816], "maxLetters": [7, 1], "fontColor": "#0f2352", "fontOutlineColor": "#ffffff", "fontOutline": false, "fontOutlineDepth": [0.475, 0.5] } ] } }` |
| `readCollisions` | `input` | `{ "format": "yft", "meshes": [ { "source": "physics", "drawableIndex": null, "child": 3, "material": 12, "positions": [x, y, z, ...], "indices": [0, 1, 2, ...] } ], "primitives": [ { "kind": "cylinder", "source": "physics", "drawableIndex": null, "child": 7, "material": 12, "a": [x, y, z], "b": [x, y, z], "radius": 0.36 } ], "materials": [ { "index": 12, "name": "CAR_METAL" } ], "triangles": 606, "truncated": false, "warnings": [] }` |

`listPedAssets` scans every RPF entry and keeps `.ydd`/`.ytd` files whose parent folder equals `<ped>` or starts with `<ped>_` (base components, DLC component packs such as `mp_m_freemode_01_male_freemode_beach`, and prop folders such as `mp_m_freemode_01_p`), plus the ped's own `<ped>.yft`/`.ydd`/`.ytd`/`.ymt` and `<ped>_p.ydd`/`<ped>_p.ytd` entries (reported with `folder: ""`; component peds keep all their drawables, textures and props in these). Duplicate `folder/file` pairs resolve to the higher-priority archive (`mods\` > `update\` > `dlcpacks` > base). `folder`, `file`, and `kind` are lowercase. The first call takes several seconds (archive scan plus a full entry walk); the per-ped index is cached afterwards.

`collections` lists every clothing folder of the ped (`.ydd` holders) in the order the game numbers drawables: the ped's own folders first (`order: -1`), then each DLC folder by the earliest pack that contains it, ranked by its position in `update\update.rpf\common\data\dlclist.xml` (`setup2.xml` `order` breaks ties for unlisted packs). Patch packs that replace files in an existing folder appear later in the list and never move it. The app turns this into in-game drawable numbers: each DLC folder numbers its files from `000`, and its range starts where the previous folder's ended.

`readCollisions` reads the collision bounds a model carries and writes nothing. A `.yft` reports its fragment physics bounds (`PhysicsLOD1`) as `source: "physics"` with `drawableIndex: null`; every drawable's own bound (a `.ydr`, each `.ydd` drawable, and a fragment's drawable) is reported as `source: "drawable"` with its `drawableIndex`; a bound already reported (a drawable sharing the physics bound) is reported once. Composite bounds are walked up to eight levels deep with each child's transform applied, and `child` is the index of the top-level composite child the shape belongs to, or null. All positions are in the model's own space, the same space as the `.clmesh` before any viewer turn. Triangle polygons become `meshes`, one per source, drawable, child and material, with their own compact vertex list. Box, sphere, capsule and cylinder bounds and polygons become `primitives`: a `sphere` has `center` and `radius`; a `capsule` or `cylinder` runs from `a` to `b` with `radius`; a `box` has `corner` and three `edges` spanning it, so it may be turned. Polygon vertices are placed at the stored vertex plus the bound's `CenterGeom`; box, capsule, cylinder and disc shapes are derived as CodeWalker draws them. `material` is the collision material type index, and `materials` names each index used from the game's `materials.dat` (`name` is null when no GTA V install was found). At most 1,000,000 triangles and 100,000 primitives are returned; past that, `truncated` is true. Bounds of other types, triangles and shapes with out-of-range indices or non-finite values, and nesting past the limit are skipped with a warning.

### Ped descriptions

`searchPeds`, `describeGamePed` and `describePedFiles` let EUP Studio stage any ped, not only the freemode peds. A ped is a model name with a `<ped>.ymt` (its `CPedVariationInfo`) and a `<ped>.yft` (its skeleton). `searchPeds` lists such names from the game files; `query` follows the `searchAnimDicts` rules and results are ranked and capped the same way.

A description reads the variation file and names the drawable and texture each variation resolves to, following CodeWalker's ped naming. It never writes anything:

```json
{
  "ped": "s_m_y_cop_01",
  "source": "game",
  "skeleton": { "bones": [ { "name": "SKEL_ROOT", "tag": 0, "parent": -1, "translation": [0, 0.0071, -0.0187], "rotation": [0, 0, 1, 0] } ] },
  "skeletonFile": "s_m_y_cop_01.yft",
  "files": [
    { "kind": "ydd", "dictionary": true, "folder": "", "file": "s_m_y_cop_01.ydd" },
    { "kind": "ytd", "dictionary": true, "folder": "", "file": "s_m_y_cop_01.ytd" }
  ],
  "components": [
    { "component": "uppr", "id": 3, "drawables": [
      { "index": 0, "name": "uppr_000_r", "drawable": { "name": "uppr_000_r", "hash": 1471150075, "file": 0 },
        "textures": [ { "letter": "a", "texId": 1, "diffuse": { "name": "uppr_diff_000_a_whi", "file": 1 } } ],
        "normal": { "name": "uppr_normal_000", "file": 1 }, "specular": { "name": "uppr_spec_000", "file": 1 } } ] }
  ],
  "props": [
    { "anchor": "p_head", "anchorId": 0, "props": [
      { "index": 0, "name": "p_head_000", "drawable": { "name": "p_head_000", "hash": 3386910804, "file": 2 },
        "textures": [ { "letter": "a", "texId": 0, "diffuse": { "name": "p_head_diff_000_a", "file": 3 } } ], "normal": null, "specular": null } ] }
  ],
  "warnings": []
}
```

- `skeleton.bones` uses the manifest skeleton format: bones in index order, `parent` a bone index or `-1`, `translation` and `rotation` (`[x, y, z, w]`) local to the parent. It comes from `<ped>.yft`; without one, from a drawable in the ped's files that embeds a skeleton. At most 1024 bones; a non-finite transform fails with exit code 3.
- `files` lists every file the description refers to, once. Game files are `{ kind, dictionary, folder, file }` and are fetched with `exportPedAsset` (`folder` is `""` for the ped's own `<ped>.ydd`/`.ytd`/`<ped>_p.*`, `<ped>` or `<ped>_p` for streamed per-drawable files). The user's files are `{ kind, dictionary, path }`. `dictionary` is true for a whole-ped `.ydd`/`.ytd`; a drawable in one is selected by `drawable.hash` (the Jenkins hash of its name), matching the dictionary's hash table.
- `components` holds the components `availComp` makes available, in component id order. A drawable is `<comp>_<nnn>_<u|r|m>` by the `propMask` type bits (the other suffixes are tried when the files use one). Each texture letter's diffuse is `<comp>_diff_<nnn>_<letter>_<race>`, with the race taken from `texId` (0 `uni`, 1 `whi`, 2 `bla`, 3 `chi`, 4 `lat`, 5 `ara`, 6 `bal`, 7 `jew`, 8 `kor`, 10 `pak`), then any race the files carry, then no race. `drawable`, `diffuse`, `normal` and `specular` are null when the files lack them, so a listed variation that isn't shipped stays visible as such.
- `props` groups `propInfo` props by anchor (`anchorId` in eAnchorPoints order: `p_head`, `p_eyes`, `p_ears`, `p_mouth`, `p_lhand`, `p_rhand`, `p_lwrist`, `p_rwrist`, `p_lhip` or `p_hip`, `p_lfoot`, `p_rfoot`, `ph_lhand`, `ph_rhand`). `index` is the prop id.
- `warnings` names files the selection could not use. When the user's files hold two copies of one ped file (the same ped and file name, for example one in a `backup` folder), the copy fewer folders deep, nearest the picked folder, is used, the first by path on a tie, and the warning names both paths: `Two copies of my_ped.ydd: using <path>, not <path>.` Game files keep the archive's first entry without a warning.

`describeGamePed` reads the highest-priority copy of each file and caches the description for the life of the process. It fails with `Ped '<ped>' was not found in the game files (no <ped>.ymt).` for an unknown name.

`describePedFiles` classifies each file by name: `<ped>.ymt`/`.yft`/`.ydd`/`.ytd` and `<ped>_p.ydd`/`.ytd` belong to `<ped>`; a file named like a component or prop (`uppr_000_u.ydd`, `p_head_diff_000_a.ytd`) belongs to the ped its folder is named after (`<ped>` or `<ped>_p`); FiveM split files `<ped>^<file>` belong to the part before `^`. The candidates are the `.ymt` stems. With several and an empty `ped`, the op returns them without describing; a `ped` that isn't among them fails with the list. Missing paths fail with `Ped files not found: <names>.`; a selection without a `.ymt` fails with an actionable message. At most 4096 files. `.ymt` files are read as resource (RSC7) or raw meta/PSO data.

`listPedClips` and `exportPedClip` read animation dictionaries (`<dict>.ycd`, highest-priority archive wins). `dict` and `clip` are lowercase game names of `a-z`, `0-9`, `_`, `@`, `.`, `-` (1-128 characters, no `..`). `exportPedClip` samples the clip at 30 fps across its duration; the last sample sits just before the loop point. `rotations` holds each bone's local quaternion per sample (track 1), `translations` each translated bone's local position (track 0), both keyed by bone tag. Root motion (tracks 5 and 6) is not sampled per bone; `moverVelocity` is its average velocity in metres per second, so the preview can play locomotion in place.

`exportModelClip` samples a model's own clip the same way, for convertible roofs named by `vehicles.meta` `animConvRoofDictName`/`animConvRoofName`. Sample 0 is the bind pose (roof up) and the last sample is the stowed roof; tracks are keyed by bone tag and replace the bone's local bind transform. The bridge rejects a `ycdPath` that is not an existing `.ycd` file.

`listClipFile` and `exportClipFile` read a `.ycd` the user picked (their own animation, or one from a resource) and sample it like `exportPedClip`. `ycdPath` must be an existing `.ycd`; `clip` is matched against the dictionary's clip names (1-128 printable characters) and is never used as a path. Nothing is written.

`searchAnimDicts` and `searchGameProps` return game `.ycd` dictionary names and `.ydr` drawable names (highest-priority archive wins) that contain every space-separated token of `query` (1-64 characters of `a-z`, `0-9`, `_`, `@`, `.`, `-` and spaces). Names that start with the first token, or carry it after `_` or `@`, rank first, then shorter names; at most 80 are returned and `total` counts every match.

`exportGameProp` writes `<name>.ydr` as a raw resource file into `<outputDir>/<name>/`, and, when a `.ytyp` in the same archive (or a parent archive) gives the prop an archetype with a texture dictionary, writes that `.ytyp` beside it so `parseYft` resolves the dictionary from the game files. The model is written last and an existing model is reused. `name` is `a-z`, `0-9`, `_`, `-` (1-128 characters).

`listGameVehicles` reads every `vehicles.meta` in the archives and lists each `InitDatas` entry whose model has a `.yft`, preferring `<model>_hi.yft` when the game ships one. The higher-priority archive wins for both the meta entry and the model. `pack` is the DLC pack folder, empty for the base game; `vehicleClass` is the game's value as written, and the game spells compacts both `VC_COMPACT` and `VC_COMPACTS`. The catalogue is cached for the life of the process.

`exportGameVehicle` lays the vehicle out as a minimal resource in `<outputDir>/<name>/`: `fxmanifest.lua` (a comment naming it a Cortex Studio cache, so `parseYft` finds a resource root), `data/vehicles.meta` (the game file that defines the model), `data/carvariations.meta` and `data/carcols.meta` (the model's variation entry and the mod kits it names, from the highest-priority file; `dlc_patch` data outranks its DLC pack, and base-game `.ymt` files are converted to XML with model names resolved), and `stream/` with `<name>.ytd` and `<name>+hi.ytd` when the game has them, then the fragment last. `parseYft` resolves the vehicle's `txdName`, its parents and `vehshare` as it does for a FiveM resource. An existing fragment is reused. `name` follows the `exportGameProp` rule. `carcols.meta` also carries the `Lights` and `Sirens` items the variation's `lightSettings` and `sirenSettings` ids name, and starts with a version comment; an export without the current comment has both kit files rewritten on the next call.

`exportGameVehicleMods` extracts every model the vehicle's kits use (each visible mod's `modelName` and its `linkedModels`) into `<outputDir>/<name>/stream/mods/<model>.yft`, reusing files already there. `missing` lists model names the archives don't contain. A tuner car's kit can be tens of megabytes, so the app calls it only when a mod is first picked.

`lookupGameText` returns the game's English text (every `american` `.gxt2`, higher-priority archive first) for label hashes, the joaat hash of a text label such as a mod's `modShopLabel`; labels without text are left out. At most 2048 hashes per request. The text index is built on first use and cached.

`writeYtdTextures` rebuilds the texture dictionary at `input` with new textures and writes the result to `output`; `input` is only read. Each texture is a DDS file at `path` named `name`: `mode: "replace"` swaps the texture of that name (matched without case), keeping its name, name hash and usage flags, and fails with `<file> no longer holds <name>, so it cannot be replaced.` when it is gone; `mode: "add"` and `mode: "insert"` add it under `name` with the Jenkins hash of the lowercase name, and fail with `<file> already holds <name>, so it cannot be added again.` when one exists. An `add` texture is a recoloured copy: `source` names the texture dictionary it was copied from, which must exist and hold a texture named `name` (`<name> is added without the dictionary it is copied from.`, `<source file> does not hold <name>, so it cannot be copied. Check the lenses again.`). The app checks where `source` is before it calls the bridge. An `insert` texture is the user's own image and is copied from nowhere: an optional `like` names a texture in the same dictionary whose usage flags it takes, as a new `<prefix>_sign_N` livery takes those of `<prefix>_sign_1` (`<file> no longer holds <like>, the texture <name> is modelled on.`). `mode: "delete"` removes the texture of that name, as CodeWalker's Remove does, and ignores `path` (the app sends `null`); it fails with `<file> no longer holds <name>, so it cannot be removed.` when it is gone, and its result entry is `{ "name", "removed": true }`. Textures are applied in list order, and a dictionary left with no textures is refused: `Removing these would leave <file> with no textures, so it is not written.` Only legacy GTA V dictionaries (RSC7 version 13) are accepted: `<file> is not a legacy GTA V texture dictionary, so it cannot be written.` The rebuilt dictionary is read back before it is written, and must hold every texture it should. The app uses this for the lens colour write (`write_lens_textures`, `replace` and `add`) the livery write (`livery_write_commit`, `replace`, `insert` and `delete`) and the clothing texture write (`clothing_write_commit`, `replace` and `insert`); it never points `output` at the user's file.

`readPedVariation` returns a clothing pack's ped variation file (`<ped>_<dlc>.ymt`, a `CPedVariationInfo`) as CodeWalker's metadata XML, which the app reads and edits in `src/lib/ped-variation-xml.js`; the file is only read. Only legacy GTA V metadata files (RSC7 version 2) of at most 16 MB are read. Escrow-encrypted and Enhanced files are refused with `<file> is not a legacy GTA V metadata file, so Cortex cannot read it.` and never decrypted, and other metadata fails with `<file> is not a ped variation file.` `writePedVariation` builds a `.ymt` from such XML (at most 32 M characters, DTDs refused, root element `CPedVariationInfo`) and reads the result back before it writes `output`. A build that does not load fails with `The rebuilt <file> does not read back: <reason>`, and one whose XML reads back other than `xml` (compared after making line endings, the XML declaration and the spelling of the `dlcName`, `pedXml_audioID`, `pedXml_audioID2` and `audioId` hashes uniform) fails with `The rebuilt <file> reads back differently at line <n>, so it is not written.`; either way nothing is written. The app uses them for the clothing texture write (`clothing_item`, `clothing_write_commit`) and the addon pack build (`read_pack_ymt`, `clothing_pack_build`), and always points `output` into a staging folder, never at the user's file. `writeCreatureMetadata` builds creature metadata (`mp_creaturemetadata_<dlc>.ymt`) the same way from XML whose root element is `CCreatureMetaData`, with the same limits, read-back check and errors (`The XML for <file> is not creature metadata.` for another root, `The creature metadata XML is too large.` past the limit). The addon pack build generates that XML from the pack's own hats and shoes; a source pack's creature metadata is never read or copied.

`exportPedAsset` writes `.ydd` entries as raw resource files: the RSC7 header followed by the deflated body, byte-compatible with CodeWalker RPF Explorer "Extract raw" and readable by the app's `.ydd` parser. `.ytd` entries are exported as one DDS per texture. Both ops skip work when output already exists: a `.ydd` file is reused when present; a texture folder is reused when its `textures.json` listing exists and every listed DDS is still on disk. `folder` and `file` must be single path segments (no separators, `..`, or drive letters).

## Tauri commands

All commands run their filesystem and bridge work on a blocking thread so the main thread and window stay responsive.

- `parse_yft({ path, force?, requestToken? })` → `{ meshPath, manifestPath, cacheKey, cached, meta, warnings }`. Accepts `.yft`, `.ydr` and `.ydd`. Uses serve-mode `parseYft`, falling back to the one-shot CLI once only on a transport failure (see [One-shot command](#one-shot-command)). `meta` is the bridge meta object plus `inputPath`. `warnings` is always an array of strings, also on a cache hit (stored in `meta.json`); more than 100 are cut to 99 plus a count line. `force: true` discards an existing cache entry and parses again. Without it an entry is reused only while the model and every recorded input are unchanged, so editing a sibling, resource or archetype `.ytd` (or adding a candidate that was missing) refreshes the parse. `requestToken` makes the parse cancellable (see [Cancelling a parse](#cancelling-a-parse)).
- `cancel_bridge_request({ token })` → `"running"`, `"queued"` or `"none"`. Cancels only the request registered with `token`.
- `list_ped_assets({ ped })` → the `listPedAssets` result. `ped` must match `^[a-z0-9_]+$`.
- `search_peds({ query })` and `describe_game_ped({ ped })` → the `searchPeds` / `describeGamePed` results. `query` and `ped` are validated in Rust and again in the bridge; nothing is written.
- `describe_ped_files({ paths, ped? })` → the `describePedFiles` result. `paths` are the absolute files or folders the user picked; Rust walks picked folders (at most six levels, never through links inside them) for `.ymt`, `.yft`, `.ydd` and `.ytd`, rejects more than 4096 files or one above 512 MB, and fails with `Missing ped files: <paths>` when a pick no longer exists, so a restored character can be located again. A picked folder that can't be read fails with its path; a subfolder that can't be read is skipped, and the description's `warnings` starts with `Couldn't read <folder>, so its files were left out.` (these walk warnings are added on every call, never cached). The walk looks at no more than 50,000 files and folders, then fails asking for the ped's own folder. It caches the result in `ped-cache/describe-v1/` while every collected file keeps its modified time and size. Nothing is added to the fs plugin's scope: after a description succeeds (fresh or cached), the `.ydd` paths in its `files` that the walk collected can be read through `read_ped_drawable`.
- `read_ped_drawable({ path })` → the raw bytes (an `ArrayBuffer`) of one of the user's ped drawables. Only a `.ydd` path that a `describe_ped_files` result named this session is served, compared without case; any other path, a missing file or one above 512 MB fails with its name. The viewer parses the user's ped drawables itself, and the fs plugin's runtime scope can't grant read access without write, so they are read here.
- `list_ped_clips({ dict })` and `export_ped_clip({ dict, clip })` → the `listPedClips` / `exportPedClip` results. Names are validated in Rust and again in the bridge; nothing is written to disk.
- `export_model_clip({ modelPath, dict, clip })` → the `exportModelClip` result plus `source` (`"resource"` or `"game"`). Rust looks for `<dict>.ycd` in the model's folder, then elsewhere in its resource (at most six folders deep, never through links or outside the resource), and falls back to the game files when none exists.
- `search_anim_dicts({ query })` and `search_game_props({ query })` → the `searchAnimDicts` / `searchGameProps` results. `query` is validated in Rust and again in the bridge.
- `list_ycd_file_clips({ path })` and `export_ycd_file_clip({ path, clip })` → the `listClipFile` / `exportClipFile` results. `path` must be an absolute path to an existing, non-empty `.ycd` file of at most 256 MB; the file is only read.
- `export_game_prop({ name })` → the `exportGameProp` result with `outputDir = <appCacheDir>/cortex-labs/prop-cache`.
- `list_game_vehicles()` → the `listGameVehicles` result.
- `export_game_vehicle({ name })` → the `exportGameVehicle` result with `outputDir = <appCacheDir>/cortex-labs/vehicle-cache`. `name` is validated in Rust and again in the bridge.
- `export_game_vehicle_mods({ name })` → the `exportGameVehicleMods` result with the same `outputDir`.
- `lookup_game_text({ hashes })` → the `lookupGameText` result. Rust rejects more than 2048 hashes.
- `export_ped_asset({ ped, folder, file })` → the `exportPedAsset` result with `outputDir = <appCacheDir>/cortex-labs/ped-cache`. Only `.ydd`/`.ytd` files are accepted; `folder`/`file` are validated in Rust and again in the bridge.
- `export_plate_textures()` → the `exportPlateTextures` result with `outputDir = <appCacheDir>/cortex-labs/plate-cache/v1`. Returns the stored `plates.json` without contacting the bridge when every listed DDS exists.
- `read_model_collisions({ path })` → the `readCollisions` result. `path` must be an existing `.yft`, `.ydr` or `.ydd`; the file is only read, and nothing is cached. Windows only. The single viewer and Prop Studio draw it as an overlay in the model's space, coloured by material.
- `export_ytd({ path })` → the `exportYtd` result with `outputDir = <appCacheDir>/cortex-labs/ytd-cache/<hash(path, mtime, size)>`. Returns the stored `textures.json` listing without contacting the bridge when every listed DDS exists; `warnings` is always an array (empty for listings stored before warnings existed). A failed export removes its output folder unless a complete listing is already there.
- `write_lens_textures(<raw body>)` → `{ files: [ { path, backup, textures } ] }`, where `textures` is the `writeYtdTextures` result's list. The body is raw bytes, not JSON: a little-endian u32 header length, the JSON header `{ modelPath, stamp, ytds: [ { path, textures: [ { name, mode, source, length } ] } ] }`, then each texture's DDS in header order; the lengths must account for every byte, and Rust caps it at 8 dictionaries, 64 textures and 512 MB. `modelPath` must be a model the app opened (in the fs scope), and each `path` one of its own dictionaries beside it (`<stem>.ytd`, `<stem>+hi.ytd`, and for a `_hi` model the same names without `_hi`), a regular file, listed once. An `add` texture names `source`, the dictionary it is copied from, and a `replace` names none. `source` must be a regular `.ytd` inside the vehicle's resource (under the nearest folder above the model with `fxmanifest.lua` or `__resource.lua`, or beside the model when there is none) and not one of the vehicle's own dictionaries, so textures are never copied from the game's files or another resource. Every dictionary is rebuilt by `writeYtdTextures` into a staging folder first; a failure there changes nothing. Then each file is copied to `<name>.<stamp>.bak` (never over an existing file) and replaced through a staged `<name>.<stamp>.new`; if a later file fails, the earlier ones are put back from their backups. `stamp` is `yyyymmdd-hhmmss`. The staging folder is removed either way.
- `livery_dictionaries({ modelPath })` → `{ dictionaries: [ { path, name, legacy, textures: [ { name, path, width, height, levels, format } ] } ] }` for a `.yft`'s own dictionaries beside it (the names `write_lens_textures` accepts). Each is listed through `export_ytd`, so a texture's `path` is its cached DDS; `width`, `height`, `levels` and `format` come from that DDS header and are null when it can't be read. `legacy` is true for RSC7 version 13, the only dictionaries the livery write accepts. Nothing beside the model is written.
- `livery_write_begin({ modelPath })` → `{ token }`, `livery_write_stage(<raw body>)`, `livery_write_commit({ request })` → `{ files: [ { path, backup, textures } ] }` and `livery_write_cancel({ token })` write liveries in a session, because a batch of 4K textures is too large for one message. `begin` needs a `.yft` the app opened and makes the session folder `<appCacheDir>/cortex-labs/livery-write/<token>`, where the token is `<pid>-<nanos>`; a new session ends the previous one and removes folders left by earlier runs. Each `stage` body is raw bytes, not JSON: a little-endian u32 header length, the JSON header `{ token, id }` (`id` is 1-64 characters of `A-Z`, `a-z`, `0-9`, `_` and `-`), then one DDS of 128 bytes to 384 MB; a session holds at most 512. `request` is `{ token, stamp, ytds: [ { path, textures: [ { name, mode, id, like } ] } ] }`: 1-8 of the model's own dictionaries, each listed once, with 1-128 textures each, names unique without case, `mode` `replace`, `insert` or `delete` (never `add`, so nothing is copied from another dictionary), `like` only on `insert` and never the texture's own name, and a staged `id` on every `replace` and `insert`. A `delete` removes a livery the dictionary holds and names no `id`, so a commit that only removes liveries stages nothing; the app lists removals after the new textures. The commit ends the session; a wrong token leaves it. Every dictionary is rebuilt by `writeYtdTextures` into the session folder first, and a failure there ends with `Nothing was changed.`; then the files are backed up to `<name>.<stamp>.bak` and replaced all or nothing, as `write_lens_textures` does. The session folder is removed when the commit ends, on `cancel`, and when another session starts.
- `clothing_item({ drawablePath })` → `{ item, textures: [ { path, legacy, texture, error } ], ymt }` for a clothing `.ydd` the app opened (in the fs scope). `item` is its name read as `<prefix>^<slot>_<NNN>_<u|r>.ydd` (props `<prefix>^p_<anchor>_<NNN>.ydd`): `{ prefix, ped, dlc, isProp, slot, index }`, where `prefix` is `<ped>_<dlc>` or `<ped>_p_<dlc>` for the freemode peds and empty for a name without a pack, and `ped`/`dlc` are null when the prefix has none. A file not named that way fails with `<name> is not named as a clothing item (such as jbib_000_u.ydd), so Cortex cannot tell which textures are its own.` `textures` lists the item's texture files beside it (`<prefix>^<slot>_diff_<NNN>_<letter>_<race>.ytd`, props without the race), sorted by name: `legacy` is false for a file `writeYtdTextures` cannot rebuild, and `texture` is the one a write replaces in it (the first `_diff_` texture, else the first), `{ name, width, height, levels, format, file }`, where `file` is its DDS in the `export_ytd` cache. `ymt` is `{ path, xml }` (from `readPedVariation`) for the pack's `<ped>_<dlc>.ymt`, searched in the item's resource (the nearest folder within six levels above with `fxmanifest.lua` or `__resource.lua`, searched six levels deep, else the item's folder and the one above it), at most 20000 entries and never through links; `{ path, error }` when it can't be read or is outside the fs scope (the search can reach above the folder the item was opened from, and such a file is neither read nor written); `{ error }` when the search fails, including when the name is there more than once; and null for an item without a pack or a pack without a `.ymt`.
- `clothing_write_begin({ drawablePath })` → `{ token }`, `clothing_write_stage(<raw body>)`, `clothing_write_commit({ request })` → `{ created, replaced: [ { path, backup } ], files: [ { path, textures } ] }` and `clothing_write_cancel({ token })` write an item's textures in a session, like the livery write: `begin` needs a clothing `.ydd` the app opened and uses `<appCacheDir>/cortex-labs/clothing-write/<token>`, and `stage` takes the same raw body. `request` is `{ token, stamp, ymt, ytds: [ { path, mode, template, textures: [ { name, mode, id, like } ] } ] }` with 1-26 texture files, each checked as the livery write checks its dictionaries. Every `path` must be one of the item's texture files in the item's own folder: `mode: "replace"` names one that exists and no `template`; `mode: "create"` names one that does not exist yet and a `template`, an existing texture file of the item that is rebuilt into it. `ymt` is `{ path, xml, base }` exactly when a file is created: `path` must be the file `clothing_item` found and in the fs scope, `xml` the new file (at most 32 MB), and `base` the XML `clothing_item` returned, which `xml` was made from. The commit reads the file again first and stops with `<path> changed since Cortex read it, so nothing was changed. Close this to read it again, then write.` when it no longer reads as `base`, so an edit made outside Cortex is never lost. Every texture file is rebuilt by `writeYtdTextures` (from its `template` for a new one) and the `.ymt` by `writePedVariation` into the session folder first, and a failure there ends with `Nothing was changed.` Then the new files are written without replacing anything (a file that appeared meanwhile is refused), and the rest are backed up and replaced as `write_lens_textures` does, the `.ymt` last, so the game never counts a texture file that is not there. If replacing fails, the replaced files are put back and the new ones removed. `created` lists the new files' paths.
- `clothing_folder({ folder })` → `{ files: [ { path, escrowed } ], truncated }`, the `.ydd`, `.ytd`, `.yld` and `.ymt` files in a folder the user picked (in the fs scope), eight levels deep, never through links, sorted by path, under the path as picked. `escrowed` is true for a file in a folder that holds `.fxap` or anywhere below one; such files are listed so the app can say why they are left out, and never copied. A folder inside the GTA V install (a folder above holds `GTA5.exe`, `GTA5_Enhanced.exe` or `PlayGTAV.exe`) or FiveM's own data (`FiveM.app`, `FiveM Application Data`) is refused. `truncated` is true past 20000 entries.
- `read_pack_ymt({ path })` → `{ path, xml }`, the `readPedVariation` result for a `.ymt` in a picked folder; the same protected and escrowed files are refused.
- `clothing_identical_files({ paths })` → one entry per path: a group number shared by the files with the same bytes, or null for a file like no other. Files are grouped by size, then hashed, then compared byte for byte. Every path must be in the fs scope and outside the protected folders.
- `clothing_pack_build({ request })` → `{ path, files }` builds a new resource. `request` is `{ parent, name, copies: [ { from, to } ], ymts: [ { to, xml } ], texts: [ { to, text } ], creatures: [ { to, text } ] }`: `parent` a folder the user picked outside the protected folders, `name` 1-64 of `A-Z`, `a-z`, `0-9`, `_` and `-`, and `parent/name` must not exist. It writes 1-20000 files, each `to` a relative `/`-separated path of up to four plain names, written once (without case). A copy is a `.ydd`, `.ytd` or `.yld` into `stream/` with its source's extension, and its source must be a regular file in the fs scope, outside the protected folders and escrowed resources, and legacy GTA V (RSC7; `.ytd` version 13, `.ydd` version 165, `.yld` version 8). A file is escrowed when any folder above it holds `.fxap`, however deep. `ymts` go to `stream/<name>.ymt` through `writePedVariation` (at most 32 MB of XML). `creatures` is optional and goes to `stream/mp_creaturemetadata_<dlc>.ymt` through `writeCreatureMetadata` (at most 32 MB of XML each); another `to` fails with `<to> is not creature metadata in the stream folder.` `texts` are `fxmanifest.lua`, which is required, and `.meta` files at the top of the resource, at most 1 MB each. Everything is written into a hidden `.cortex-build-<name>-<nanos>` folder in `parent`, which is renamed to `name` at the end; a failure, or a `name` that appeared meanwhile, removes the hidden folder. Every error ends with `Nothing was written.`, or names the hidden folder when it could not be removed. Emits `clothing-pack-progress` `{ done, total }` as files are written.

## Caches

Layout under `<appCacheDir>/cortex-labs/`:

- `yft-cache/<key>/` with `model.clmesh`, `manifest.json`, `meta.json`, `textures/`. `<key>` hashes the parser revision (`parse_yft_v19`), input path, modified time, and size.
- `yft-cache/.shared-textures/<sha256>.dds` stores each shared DDS once. Manifest paths such as `../.shared-textures/<sha256>.dds` resolve from the model entry directory.
- `ytd-cache/<key>/` with DDS files and `textures.json`.
- `lens-write/<pid>-<nanos>/`: a lens write's staged DDS files and rebuilt dictionaries, removed when the write ends.
- `plate-cache/v1/` with `plates.json` and the plate DDS files under `vehshare_<n>/`.
- `ped-cache/<folder>/<file>` for `.ydd` and `ped-cache/<folder>/<file-stem>/` for `.ytd` exports. A component ped's own dictionaries (`folder: ""`) land in `ped-cache/<file>` and `ped-cache/<file-stem>/`.
- `ped-cache/describe-v1/<hash>.json` with `{ identity, result }` for `describe_ped_files`. `<hash>` covers the revision (`describe_ped_files_v1`), the chosen ped and every collected path; `identity` lists each file's path, modified time and size, and an entry is used only while it matches exactly.
- `prop-cache/<name>/` with `<name>.ydr` and, when found, the archetype `.ytyp` for game props held in EUP Studio.
- `vehicle-cache/<name>/` with the minimal resource `exportGameVehicle` writes for a game vehicle, and `stream/mods/` with the models `exportGameVehicleMods` extracted for it.

A `yft-cache` entry is complete only when `model.clmesh`, `manifest.json` and `meta.json` all exist. `meta.json` is the bridge summary plus `inputPath`, normalized `warnings` and `inputs`, and is written last (through a `.tmp` file), so an entry interrupted by a crash, kill, or cancel is never reused. A parse that fails or is cancelled deletes its entry. Before reusing a complete entry the app checks every recorded input: a file must still have the recorded `mtimeMs` and `size`, and a `missing` candidate must still be absent; otherwise the model is parsed again. An entry without `inputs` is never reused.

Compatibility: v19 changed which game dictionaries a parse reads (manifest v12), so the revision moved from `parse_yft_v18` to `parse_yft_v19` instead of reusing v18 entries that list the game copy of a dictionary the resource streams. v18 entries are never looked up again; the first v19 parse of a model deletes its v18 entry and maintenance trims the rest, so every cached model parses once after the upgrade. v18 changed what a complete entry is, so the revision moved from `parse_yft_v17` to `parse_yft_v18` instead of reinterpreting v17 entries. v17 entries are never looked up again; the first v18 parse of a model deletes its v17 entry and maintenance trims the rest.

Eviction:

- Every cache hit touches the entry directory (mtime, or a `last-used` marker file when the mtime cannot be set) so recency reflects use.
- When `parse_yft` creates a new entry, older complete `yft-cache` entries for the same input path (read from `meta.json`) are deleted immediately. Entries without `meta.json` are still being written and are left alone.
- At startup and after new exports, background maintenance removes duplicate model entries and trims caches: YFT above 1.5 GB targets 1 GB; YTD above 500 MB targets 350 MB. Shared DDS files count toward the YFT budget, and unreferenced objects are removed. Entries and shared objects used in the last ten minutes are protected, so the cap is soft during active exports. Maintenance reads sizes and manifests once without holding the cache lock and takes the lock only for each deletion, re-checking that the entry was not used since the scan, so parses and cache hits are not blocked behind a large cache walk.
- `ped-cache`, `prop-cache`, `vehicle-cache` and `plate-cache` are never evicted automatically.

## Manifest

The bridge writes `manifest.json` next to `model.clmesh` with per-geometry metadata needed for higher-fidelity texture resolution.

Current manifest fields:

- `version`: manifest schema version. The current schema is `12`. v12 has the same fields as v11; it marks parses that no longer read the game copy of a dictionary the resource streams (see [Output](#output)).
- `inputs[]`: the files the parse depended on, as in the bridge summary (`{ path, mtimeMs, size }` or `{ path, missing: true }`). Added in manifest v11.
- `sourceFormat`: `yft`, `ydr` or `ydd`, from the input extension. Added in manifest v9.
- `drawables[]`: `{ index, name }` for each drawable in file order; `index` is the meshes' `drawableIndex`. A fragment lists its main drawable and drawable array (wheel instances are not listed); a dictionary lists its drawables with names resolved from their hashes where known. Added in manifest v9.
- `lights[]`: lights authored into the drawables (`.ydr`/`.ydd`) or the fragment (`.yft`). Each entry has `drawableIndex`, `index` (position in its light list), `type` (`point`, `spot` or `capsule`), `position`, `direction` and `tangent` (`[x, y, z]` in model space; a light on a bone is moved by the bone's bind transform, as CodeWalker renders it), `color` (`[r, g, b]`, 0-255), `intensity`, `falloff` (range in metres), `falloffExponent`, `coneInnerAngle` and `coneOuterAngle` (degrees as stored, inner ≤ outer), `extent`, `flags`, `timeFlags`, `flashiness`, `coronaSize`, `coronaIntensity`, `volumeIntensity`, `volumeSizeScale`, and `boneTag` (null when the light is not on a skeleton bone). Lights with non-finite vectors or an unknown type are omitted. Added in manifest v9.
- `inputPath`: original YFT input path.
- `generatedAtUtc`: manifest generation timestamp.
- `meshCount`: number of emitted geometry records.
- `textureCount`: number of exported texture DDS files in the cache.
- `lightBones[]`: vehicle light bones from the skeleton, for siren and lamp placement. Each entry has `name` (lowercase: `siren1`..`siren32`, `siren_glass1`.., `headlight_l`, `taillight_r`, `indicator_lf`, `brakelight_m`, `reversinglight_l`, `extralight_1`.., `interiorlight`), `index` (skeleton bone index), `position` (`[x, y, z]` in vehicle space) and `rotation` (`[x, y, z, w]` quaternion in vehicle space). Empty when the model has no skeleton or no light bones. A bone whose transform holds NaN or infinite values is left out with a warning. Added in manifest v8.
- `skeleton`: the main drawable's skeleton for `.yft` models, null otherwise. `bones[]` lists every bone in index order as `{ name, tag, parent, translation, rotation }`: `parent` is a bone index or `-1`, `translation` (`[x, y, z]`) and `rotation` (`[x, y, z, w]`) are the bind transform local to the parent. `joints[]` holds the limits the game clamps animated bones to, as `{ bone, kind, min, max }`: `bone` is the bone tag, `kind` is `rotation` (XYZ Euler radians in the bone's own frame) or `translation` (metres), and `min`/`max` are `[x, y, z]`. The viewer turns each joint into a door, bonnet, boot or other moving part. Added in manifest v10.
- `textures[]`:
  - `name`: texture name from CodeWalker metadata.
  - `source`: `ytd` for sibling dictionary textures, `shared` for resource/game texture dictionaries, or `embedded` for drawable-embedded textures.
  - `relativePath`: path relative to the cache root, suitable for joining against `manifest.json`.
  - `nameHash`: original texture name hash when available.
- `meshes[]`: one entry per `.clmesh` mesh, in the same order. Names are not unique (subsets split by light id can share a bone name), so readers pair entries by index.
  - `name`: cache mesh name.
  - `materialName`: legacy material name used by `.clmesh`.
  - `shaderName`: CodeWalker shader name.
  - `shaderHash`: raw shader hash.
  - `shaderFileName`: shader preset file name when available.
  - `renderBucket`: render bucket from the drawable shader.
  - `drawableIndex`, `modelIndex`, `geometryIndex`: original drawable/flattened-model/geometry coordinates.
  - `lodLevel`: explicit drawable LOD bucket (`high`, `med`, `low`, `vlow`, `extra`, or `unknown`). Added in manifest v4.
  - `lodModelIndex`: model index within the explicit LOD bucket. Added in manifest v4.
  - `extraIndex`: optional extra number from rigid or skinned attachment bones. The bridge separates triangles attached to each extra and compacts their vertex buffers. Mixed attachment triangles remain on the body. Added in manifest v5.
  - `part` / `partName`: `"wheel"` and the wheel bone (`wheel_lf`, `wheel_rr`, ...) for wheel meshes; null for body meshes. GTA stores wheels as fragment physics children rather than in the main drawable. The bridge places each wheel with its child transform plus the physics LOD position offset, instances the front or rear wheel geometry onto bones without their own drawable, and rotates right-side wheels 180 degrees about the forward axis (matching CodeWalker). Positions and normals are baked into vehicle space. Wheels whose child transform is missing are omitted rather than guessed. Each wheel gets its own `drawableIndex` after the main drawables. Body triangles skinned or attached to the front `hub_lf`/`hub_rf`/`wheel_lf`/`wheel_rf` bones (brake calipers, rotors) are split into their own meshes with `part` `"hub"` and that bone as `partName`, so they steer with the wheel; their mesh names end in `_brake_<bone>`. Added in manifest v6.
  - `partOrigin`: vehicle-space `[x, y, z]` of the wheel hub, the pivot the viewer steers front wheels around. Null for body meshes. Added in manifest v6.
  - `paintLayer`: game paint layer decoded from the shader's `matDiffuseColor` value `(2, layer, 0)`: 1 primary, 2 secondary, 3 pearlescent, 4 wheel, 5 default (not paintable), 6 interior trim, 7 dashboard. Null when the material is not paintable. The viewer paints layers 1-4, 6 and 7 with the matching paint slot and leaves layer 5 unpainted. Added in manifest v6.
  - `boneChain`: the skeleton bone every vertex of the mesh is dominantly bound to, followed by its ancestors up to the root (for example `["misc_z", "misc_console", "chassis"]`). Rigid models use the model bone; wheel meshes use their wheel bone. Skinned body geometry (no extra, light bone, light id or steer bone) is split by the bone all three vertices of a triangle share, so parts skinned into one geometry (doors, bonnet, unit numbers) can be hidden separately; once split, each bone group is named `_body_<bone>` (or `_body_bone<index>` for an unnamed bone) and triangles spanning bones stay in `_body`. Null when the mesh spans several bones or the bone is unknown. The viewer hides a stock mesh when any bone in its chain appears in a selected mod's carcols `turnOffBones`. Added in manifest v7.
  - `boneIndex`: the `skeleton` bone the whole mesh follows (the bone of `boneChain[0]`), so the viewer can pose it rigidly. Null when the mesh spans several bones or its drawable does not own the manifest skeleton. Added in manifest v10.
  - `lightBone`: lowercase light bone (see `lightBones`) that every vertex of the mesh is attached to, directly or through an ancestor; null otherwise. Added in manifest v8.
  - `lightId`: the vehicle light id every vertex shares, read from the alpha of vertex colour 0 on `vehicle_lightsemissive*` shaders: 0 the default light (siren geometry carries 0 and is driven by its `sirenN` bone, id 0 on an extra is a steady burn, and anywhere else it is a running light, marker or screen lit while the vehicle runs), 1 `headlight_l`, 2 `headlight_r`, 3 `taillight_l`, 4 `taillight_r`, 5 `indicator_lf`, 6 `indicator_rf`, 7 `indicator_lr`, 8 `indicator_rr`, 9 `brakelight_l`, 10 `brakelight_r`, 11 `brakelight_m`, 12 `reversinglight_l`, 13 `reversinglight_r`, 14-17 `extralight_1`-`extralight_4`. Null for other shaders or when vertices disagree. The bridge splits triangles by extra, light bone, and light id (in addition to the hub split), so each light is its own mesh; split meshes are named `_<lightBone>` or `_light<id>` after the extra suffix. The game picks a lamp by light id, so the viewer prefers `lightId` over `lightBone` for lamps and uses the bone for sirens. Added in manifest v8.
  - `diffuseColor`: raw `matDiffuseColor` `[x, y, z, w]` when it is a fixed color rather than a paint layer; null otherwise. The viewer multiplies the native material by it as a linear color. Added in manifest v6.
  - `emissiveMultiplier`: the shader's `emissiveMultiplier` (x component); null when the shader has none. Added in manifest v9.
  - `uvSets`: availability flags for `uv0` through `uv3`.
  - `textureBindings[]`:
    - `paramName`: raw shader sampler parameter name.
    - `textureName`: texture name resolved from CodeWalker metadata.
    - `relativePath`: exported DDS path relative to the cache root when resolution succeeded.
    - `source`: `ytd`, `shared`, or `embedded` when the bridge resolved the texture.
    - `nameHash`: original texture name hash when available.
    - `usage`: bridge-classified usage such as `baseColor`, `normal`, `emissive`, `specular`, `detail`, `mask`, or `ambientOcclusion`.
    - `uvSet`: optional UV-set index when known.
  - `textureRefs`: sampler-name to texture-name mapping extracted from shader parameters.
  - `resolvedTexturePaths`: sampler-name to exported DDS relative path mapping when the bridge could resolve a concrete texture file.

### Mesh cache schema

- `.clmesh` magic remains `CLM1`. The header stores the mesh count as `uint16`; the bridge fails a model with more than 65535 meshes (exit code 3) instead of writing a wrapped count.
- The frontend parser rejects a cache whose data is truncated or whose index points past its mesh's vertex count.
- Version `1` stores positions, optional normals, optional `uv0`, and indices.
- Version `2` extends the cache with optional `uv1`, `uv2`, and `uv3` payloads after `uv0`, preserving the same vertex/index ordering.
- Version `3` adds an optional skin channel (flag `0x20`) after `uv3`: four `uint16` skeleton bone indices then four `uint8` weights (0-255) per vertex. The bridge writes it only for meshes where some vertex blends several bones, such as soft convertible roofs; every other mesh poses rigidly from `boneIndex`.

## Notes

- The app caches parsed meshes based on input path + modified time + file size plus the internal `parse_yft_v19` revision, and reuses an entry only while its recorded `inputs` are unchanged.
- The single viewer calls `parse_yft` on every open, even when it still holds the model in memory, and keys that in-memory model by the returned `cacheKey` plus the modified time and size of its `manifest.json`. A parse redone after a `.ytd` or meta edit rewrites the manifest under the same key, so the viewer never shows a model built from an older parse. A model the JS parser read is kept by the file's path, modified time and size.
- Manifest numbers are always finite. A `matDiffuseColor` with NaN or infinite components is reported as `diffuseColor: null` (the material's own colour applies); wheels and light bones with such transforms are left out with a warning; anything else fails the parse with exit code 3.
- The `.clmesh` cache is parsed in the frontend into Three.js geometry.
- The viewer displays the highest available LOD per drawable in both manual and native material modes. **Vehicle → Model's own textures** uses `manifest.json` for shader-aware texture resolution.
- Manual texture selections take priority over native maps on their targeted meshes.
- Advanced dirt/detail/mask bindings that require GTA-specific shader controls are reported as deferred instead of being applied with guessed semantics.
- Current frontend binding is best-effort Three.js material assignment rather than full GTA shader parity.
