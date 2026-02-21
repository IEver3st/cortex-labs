# PDN Parser Overhaul — Implementation Plan

## Phase 1 Audit: Current PSD Pipeline

### PSD Parser Output (`parsePsdLayers`)

Returns: `{ width, height, layers, allLayers, toggleable, variantGroups, locked }`

- `layers`: walked tree with `{ name, visible, opacity, colorLabel, isGroup, depth, children }`
- `allLayers`: flat array with `{ id, name, path, visible, opacity, colorLabel, isGroup, depth, parentId, childIds, category }`
- `toggleable`: `[{ name, enabled, colorLabel }]`
- `variantGroups`: `[{ name, colorLabel, options[], selectedIndex }]`
- `locked`: `[{ name, colorLabel }]`

### PSD Compositor (`compositePsdVariant`)

- Reads the PSD again with `skipLayerImageData: false`
- Applies visibility map via `applyVisibilityToTree()`
- Layer-by-layer canvas compositing with blend modes, opacity, clipping, pass-through groups
- Scales output to `targetWidth × targetHeight`

### UV Alignment

- Canvas dimensions validated (power-of-two warnings, non-square warnings)
- Export sizes: 512, 1024, 2048, 4096
- Vehicle UV mapping handled by Three.js `uv`/`uv2` attributes in `applyLiveryToModel()`
- Texture applied via `setupLiveryShader()` which alpha-blends livery over body color

### Current PDN Gap

- `decodePdn()` returns `{ width, height, data }` — single flattened RGBA composite
- Treated as "flat layer source" — creates one `__layer_source__/image` entry
- No individual layers, no names, no visibility, no blend modes
- Cannot participate in variant builder workflow

## Phase 2: PDN Parser Implementation

### PDN File Structure (from pypdn analysis)

1. `PDN3` magic (4 bytes)
2. Header size (3 bytes LE, padded to 4)
3. XML header (width, height, version, thumbnail)
4. `\x00\x01` indicator
5. NRBF serialized Document object (layer metadata)
6. Per-layer chunked bitmap data (BGRA, optionally gzip-compressed)

### Layer Properties Available

- `name` (string)
- `visible` (boolean)
- `isBackground` (boolean)
- `opacity` (0-255 integer)
- `blendMode` (enum: Normal=0, Multiply=1, Additive=2, ColorBurn=3, ColorDodge=4, Reflect=5, Glow=6, Overlay=7, Difference=8, Negation=9, Lighten=10, Darken=11, Screen=12, XOR=13)

### Blend Mode Mapping (PDN → Canvas2D)

- Normal → source-over
- Multiply → multiply
- Additive → lighter
- ColorBurn → color-burn
- ColorDodge → color-dodge
- Overlay → overlay
- Difference → difference
- Lighten → lighten
- Darken → darken
- Screen → screen
- Reflect/Glow/Negation/XOR → custom pixel-level (fallback to source-over)

### Implementation Strategy

Since full NRBF deserialization is extremely complex, use a **hybrid approach**:

1. Parse the XML header for canvas dimensions (reliable)
2. Extract layer metadata via targeted NRBF string scanning for known .NET class/field names
3. Extract chunked bitmap data using the structured chunk format (format version, chunk size, chunk number, data size)
4. Map each bitmap chunk to its corresponding layer

### New File: `src/lib/pdn.js` (rewrite)

- `decodePdn(bytes)` — keep backward compat, returns composite
- `decodePdnLayers(bytes)` — NEW: returns `{ width, height, layers[] }` with per-layer RGBA + metadata
- Each layer: `{ name, visible, opacity, blendMode, isBackground, image: Uint8Array(RGBA) }`

### Changes: `src/lib/psd-layers.js`

- Remove PDN from `isFlatLayerSourceExtension()`
- Add PDN-specific branch in `parsePsdLayers()` that calls `decodePdnLayers()`
- Add PDN-specific branch in `compositePsdVariant()` for per-layer compositing

## Phase 3: UV Map Integration

- Canvas size validation already exists (power-of-two, square checks)
- PDN canvas dimensions come from XML header (reliable)
- No additional UV logic needed — same texture pipeline

## Phase 4: Integration

- File dialog already accepts `.pdn` (line 388 of VariantsPage.jsx)
- `parsePsdLayers` routing already checks extension
- Just need to upgrade the PDN branch from flat→layered
