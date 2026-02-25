# Spatial Coloring Upgrade — Implementation Plan

## Overview

Replace the current **hash-based per-island gradient** system with a **3D position-based coloring** system. Instead of each UV island getting a random-but-deterministic color from a 4-palette pool, every point on the template is colored based on **where it sits on the vehicle body** in 3D space. This produces an intuitive visual language:

| Vehicle region | Color | Approx HSV |
|---|---|---|
| **Left side** (−X) | Cyan-blue with green hints | H≈195, S≈0.65, V≈0.90 |
| **Right side** (+X) | Rose-pink / salmon | H≈330, S≈0.55, V≈0.92 |
| **Front** (+Y) | Green / lime | H≈140, S≈0.62, V≈0.90 |
| **Back** (−Y) | Purple / magenta-blue mix | H≈280, S≈0.58, V≈0.88 |
| **Top / roof** (+Z) | Periwinkle blue | H≈225, S≈0.50, V≈0.95 |
| **Bottom** (−Z) | Deep teal (subtle) | H≈200, S≈0.45, V≈0.55 |

Edges between parts **blend smoothly** — exactly as shown in the reference image where the front-left fender transitions from cyan to green, and the rear-right quarter panel transitions from pink to purple.

---

## Reference Image Analysis

The attached reference image shows a vehicle UV template with position-aware coloring:

- **Side profile views (left & right):** Left side is a continuous cyan-blue gradient with green tint creeping in at the front wheel arch. Right side is rose-pink with the same front-green and rear-purple transitions.
- **Top-down views (roof & hood):** Blue/periwinkle tones, slightly lighter in value. The hood shows traces of green at the front edge where it meets the front bumper.
- **Front bumper:** Distinctly green/lime, blending into cyan on the left edge and into pink on the right edge.
- **Rear bumper/trunk:** Purple-magenta base, transitioning to cyan on the left and pink on the right.
- **Blending at boundaries:** A part at the front-left corner of the vehicle shows a color that's the *blend* of cyan (left) and green (front). This isn't achieved by per-island coloring — it requires **per-vertex** 3D position sampling.

---

## Current Architecture

```
Shell (UV island)
  → hash(shellName)
  → pick 1 of 4 palettes + small jitter
  → PCA axis of UV points
  → Canvas2D LinearGradient along PCA axis
  → fill all triangles in the shell with that gradient
```

**Limitation:** Colors carry no spatial meaning. Two adjacent islands on the same body panel may get wildly different colors. A hood and a front fender that meet in 3D get independent random colors instead of a natural color transition.

---

## Proposed Architecture

```
ProxyMesh (3D positions per triangle, already extracted)
  → Build UV-vertex → 3D-position lookup table
  → For each UV triangle on the template canvas:
      → Look up the 3D centroid of the corresponding proxy triangle
      → Normalize centroid into [0,1]³ relative to vehicle bounding box
      → Evaluate directional color field → get HSV color
      → Fill the UV triangle with that color
```

This is broken into **5 phases** below.

---

## Phase 1: UV → 3D Position Bridge

**File:** `src/lib/template-map.js`

### Problem
The proxy mesh data (`proxyMeshes`) already contains 3D positions and UV coordinates for every triangle, but there's no fast lookup from a UV triangle (as stored in a shell) to its corresponding 3D proxy triangle. The shell triangles and proxy triangles come from the same geometry but are stored in separate data structures.

### Solution
Build a **UV centroid → 3D centroid** lookup map during `buildYftTemplatePsdSource()` and attach it to the output.

#### New data structure: `spatialIndex`
```js
{
  // Global 3D bounding box of all included proxy geometry
  bounds: { minX, minY, minZ, maxX, maxY, maxZ },

  // Map: meshName → Map<quantizedUvCentroidKey, {x, y, z}>
  // The quantized key is derived from the UV centroid of each proxy triangle
  meshLookups: Map<string, Map<string, [number, number, number]>>
}
```

#### Algorithm
For each `proxyMesh` in the template PSD source:
1. Iterate its `.triangles[]`
2. For triangles that have `.uv` (not null):
   - Compute UV centroid: `ucx = (u0+u1+u2)/3`, `ucy = (v0+v1+v2)/3`
   - Compute 3D centroid: `cx = (x0+x1+x2)/3`, `cy = (y0+y1+y2)/3`, `cz = (z0+z1+z2)/3`
   - Quantize the UV centroid to a grid key (same `VERTEX_KEY_SCALE` as existing code)
   - Store in the mesh lookup: `meshLookups[meshName].set(key, [cx, cy, cz])`
3. Accumulate the global 3D bounding box across all proxy meshes

#### Placement in code
Add a new exported function:
```js
export function buildSpatialIndex(templatePsdSource)
```
Called from `buildAutoTemplatePsd()` after `selectTemplateMeshes()`.

This keeps the spatial index out of the serialized PSD source data (it's transient, computed on the fly) and avoids bloating the data structure.

#### Fallback
If a UV triangle can't find a 3D match (rare edge case), fall back to the shell's **average 3D position** (precomputed per shell), or ultimately to the shell's UV centroid mapped to a default color.

---

## Phase 2: Directional Color Field Engine

**File:** `src/lib/template-psd.js` (new section, replaces palette system)

### Color Model: 6-Direction Weighted HSV Blend

Define 6 cardinal colors for the vehicle's orthogonal directions:

```js
const SPATIAL_COLORS = [
  { dir: [-1,  0,  0], h: 195, s: 0.65, v: 0.90, label: 'left'   },  // cyan-blue
  { dir: [+1,  0,  0], h: 330, s: 0.55, v: 0.92, label: 'right'  },  // rose-pink
  { dir: [ 0, +1,  0], h: 140, s: 0.62, v: 0.90, label: 'front'  },  // green
  { dir: [ 0, -1,  0], h: 280, s: 0.58, v: 0.88, label: 'back'   },  // purple
  { dir: [ 0,  0, +1], h: 225, s: 0.50, v: 0.95, label: 'top'    },  // periwinkle
  { dir: [ 0,  0, -1], h: 200, s: 0.45, v: 0.55, label: 'bottom' },  // deep teal
];
```

### Blending Algorithm: Axis-Weighted Trilinear Interpolation

Given a normalized position `(nx, ny, nz)` in `[0, 1]³`:

```js
function spatialPositionToColor(nx, ny, nz) {
  // Weights for each axis pair (always sum to 1 per axis)
  const wLeft  = 1 - nx;    const wRight = nx;
  const wBack  = 1 - ny;    const wFront = ny;
  const wBottom = 1 - nz;   const wTop   = nz;

  // Weighted average of all 6 directional colors
  // Each direction's contribution = its axis weight
  // Total weight = 3 (since 3 axis pairs each sum to 1)
  let hSin = 0, hCos = 0, sSum = 0, vSum = 0;
  const entries = [
    [wLeft,   SPATIAL_COLORS[0]],
    [wRight,  SPATIAL_COLORS[1]],
    [wFront,  SPATIAL_COLORS[2]],
    [wBack,   SPATIAL_COLORS[3]],
    [wTop,    SPATIAL_COLORS[4]],
    [wBottom, SPATIAL_COLORS[5]],
  ];

  for (const [w, c] of entries) {
    const hRad = c.h * Math.PI / 180;
    hSin += w * Math.sin(hRad);
    hCos += w * Math.cos(hRad);
    sSum += w * c.s;
    vSum += w * c.v;
  }

  // Circular mean for hue (handles wrap-around correctly)
  const h = ((Math.atan2(hSin, hCos) * 180 / Math.PI) + 360) % 360;
  const s = sSum / 3;
  const v = vSum / 3;

  return { h, s, v };
}
```

### Why circular mean for hue?
Hue is an angle on the color wheel. Naive averaging of 280° (purple) and 30° (orange) gives 155° (green) — completely wrong. The circular mean via sin/cos gives the correct perceptual midpoint. This is the same trick used by wind direction averaging in meteorology.

### Sharpness Tuning
The raw linear weights produce gentle blending. For more "zoned" coloring with sharper transitions (if desired later), apply a power curve:

```js
function sharpen(w, power) {
  return Math.pow(w, power);  // power > 1 = sharper, < 1 = softer
}
```

Default `power = 1.0` gives the smooth blending shown in the reference image.

---

## Phase 3: Per-Triangle Spatial Fill

**File:** `src/lib/template-psd.js`

### New function: `paintSpatialFillLayer()`

Replaces `paintMeshFillLayer()` as the default fill painter.

```js
function paintSpatialFillLayer(canvas, shells, mapper, spatialIndex) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const { bounds, meshLookups } = spatialIndex;
  const spanX = bounds.maxX - bounds.minX || 1;
  const spanY = bounds.maxY - bounds.minY || 1;
  const spanZ = bounds.maxZ - bounds.minZ || 1;

  shells.forEach((shell, shellIndex) => {
    const triangles = shell.triangles;
    if (!triangles || triangles.length < 6) return;

    const lookup = meshLookups.get(shell.meshName);

    for (let i = 0; i + 5 < triangles.length; i += 6) {
      const u0 = triangles[i],     v0 = triangles[i + 1];
      const u1 = triangles[i + 2], v1 = triangles[i + 3];
      const u2 = triangles[i + 4], v2 = triangles[i + 5];

      // Map to pixel coordinates
      const [px0, py0] = mapper.toPoint(shellIndex, u0, v0);
      const [px1, py1] = mapper.toPoint(shellIndex, u1, v1);
      const [px2, py2] = mapper.toPoint(shellIndex, u2, v2);

      // Skip degenerate triangles
      const area = Math.abs((px1-px0)*(py2-py0) - (px2-px0)*(py1-py0)) * 0.5;
      if (area < MIN_TRIANGLE_AREA_PIXELS) continue;

      // Look up 3D centroid from UV centroid
      const ucx = (u0 + u1 + u2) / 3;
      const ucy = (v0 + v1 + v2) / 3;
      const pos3d = lookup?.get(quantizeUvCentroid(ucx, ucy));

      let color;
      if (pos3d) {
        // Normalize to [0,1]³
        const nx = (pos3d[0] - bounds.minX) / spanX;
        const ny = (pos3d[1] - bounds.minY) / spanY;
        const nz = (pos3d[2] - bounds.minZ) / spanZ;
        color = spatialPositionToColor(nx, ny, nz);
      } else {
        // Fallback: use shell average position or hash-based color
        color = fallbackShellColor(shell, shellIndex);
      }

      ctx.fillStyle = hsvToCss(color.h, color.s, color.v);
      ctx.beginPath();
      ctx.moveTo(px0, py0);
      ctx.lineTo(px1, py1);
      ctx.lineTo(px2, py2);
      ctx.closePath();
      ctx.fill();
    }
  });

  return canvas;
}
```

### Why per-triangle instead of per-island?

The key requirement is **edge blending**. A front fender UV island spans from the green front zone into the cyan left zone. With per-island coloring, the entire fender gets one color. With per-triangle coloring, each triangle gets the color of its 3D position, so the fender naturally transitions from green at the front to cyan at the side — exactly matching the reference image.

GTA V vehicle meshes are **highly tessellated** (hundreds to thousands of triangles per body panel), so per-centroid solid fills look smooth to the eye. Adjacent triangles have nearly identical centroids, producing a continuous gradient effect without needing per-pixel interpolation.

### Smoothness Enhancement (Optional, Phase 5)

For an even smoother result, compute colors at the 3 vertices of each triangle and use a tiny Canvas2D trick: render 3 overlapping semi-transparent radial gradients to approximate Gouraud shading. But per-centroid is the pragmatic MVP and already looks excellent at 2048px+ resolution.

---

## Phase 4: Integration & Wiring

### 4a. Update `buildAutoTemplatePsd()` in `template-psd.js`

```diff
  const renderMeshes = buildRenderShellsWithCleanWire(selectedMeshes, size);
  const mapper = createShellMapper(size, renderMeshes);

+ // Build spatial index from proxy geometry for position-based coloring
+ const spatialIndex = buildSpatialIndex(templatePsdSource, renderMeshes);

  const backgroundCanvas = paintBackgroundLayer(createCanvas(size));
- const fillCanvas = paintMeshFillLayer(createCanvas(size), renderMeshes, mapper);
+ const fillCanvas = spatialIndex
+   ? paintSpatialFillLayer(createCanvas(size), renderMeshes, mapper, spatialIndex)
+   : paintMeshFillLayer(createCanvas(size), renderMeshes, mapper);  // fallback if no proxy data
```

If `spatialIndex` is null (no proxy geometry available — rare edge case for non-YFT models), gracefully fall back to the current hash-based system.

### 4b. Update `buildSpatialIndex()` in `template-map.js` or `template-psd.js`

```js
export function buildSpatialIndex(templatePsdSource, filteredShells) {
  const proxyMeshes = templatePsdSource?.proxyMeshes;
  if (!Array.isArray(proxyMeshes) || proxyMeshes.length === 0) return null;

  // Only include proxy meshes whose meshName appears in the filtered shells
  const shellMeshNames = new Set(filteredShells.map(s => s.meshName));

  const meshLookups = new Map();
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const proxy of proxyMeshes) {
    if (!shellMeshNames.has(proxy.meshName)) continue;

    const lookup = new Map();
    for (const tri of proxy.triangles) {
      if (!tri.uv || !tri.positions) continue;
      const [u0,v0, u1,v1, u2,v2] = tri.uv;
      const p = tri.positions; // [x0,y0,z0, x1,y1,z1, x2,y2,z2]

      const ucx = (u0 + u1 + u2) / 3;
      const ucy = (v0 + v1 + v2) / 3;
      const cx = (p[0] + p[3] + p[6]) / 3;
      const cy = (p[1] + p[4] + p[7]) / 3;
      const cz = (p[2] + p[5] + p[8]) / 3;

      lookup.set(quantizeUvCentroid(ucx, ucy), [cx, cy, cz]);

      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      minZ = Math.min(minZ, cz); maxZ = Math.max(maxZ, cz);
    }

    if (lookup.size > 0) {
      meshLookups.set(proxy.meshName, lookup);
    }
  }

  if (meshLookups.size === 0) return null;

  return {
    bounds: { minX, minY, minZ, maxX, maxY, maxZ },
    meshLookups,
  };
}
```

### 4c. Quantization Key Function

```js
const UV_CENTROID_SCALE = 1e5; // slightly coarser than vertex key to handle floating-point centroid drift

function quantizeUvCentroid(u, v) {
  return `${Math.round(u * UV_CENTROID_SCALE)},${Math.round(v * UV_CENTROID_SCALE)}`;
}
```

Using a slightly coarser grid than the vertex quantization (`1e5` vs `1e6`) because centroids from the shell triangles and proxy triangles may have tiny floating-point differences despite originating from the same geometry. The coarser grid ensures reliable matching.

### 4d. Pass `templatePsdSource` Through

The `templatePsdSource` is already available inside `buildAutoTemplatePsd()` as `options.templatePsdSource`. It contains `.proxyMeshes`. No changes needed to the call site in `TemplateGenerationPage.jsx`.

---

## Phase 5: Polish & Edge Cases

### 5a. Dilation for Spatial Fill

The existing `dilateCanvas()` function should be applied after spatial fill to bleed painted pixels outward into UV seam gaps. This prevents visible black seam lines in the game engine where adjacent UV islands have a tiny gap between them.

```diff
  const fillCanvas = spatialIndex
    ? paintSpatialFillLayer(createCanvas(size), renderMeshes, mapper, spatialIndex)
    : paintMeshFillLayer(createCanvas(size), renderMeshes, mapper);
+ dilateCanvas(fillCanvas, dilateSizeForCanvas(size));
```

### 5b. Coordinate System Verification

GTA V vehicles use:
- **X** = lateral (negative = driver/left side, positive = passenger/right side)
- **Y** = longitudinal (positive = front, negative = rear) — *need to verify in YFT parser*
- **Z** = vertical (positive = up)

The `maybeAutoFixYftUpAxis()` function may rotate models that have Y-up instead of Z-up, but proxy geometry is extracted *after* the Three.js scene graph transformation, so positions should already be in the correct orientation.

**Action item:** Test with a real .yft and log the bounding box to confirm axis assignments. If Y and Z are swapped, adjust `SPATIAL_COLORS` direction vectors accordingly.

### 5c. Shell Fallback Color

When a shell has no matching proxy data (e.g., a mesh that's paintable but not in the proxy list), fall back to the **shell's UV-space centroid** mapped to a neutral midpoint color, or retain the legacy hash-based color:

```js
function fallbackShellColor(shell, shellIndex) {
  const palette = getIslandPalette(shell, shellIndex);
  return {
    h: hueLerp(palette.left.h, palette.right.h, 0.5),
    s: (palette.left.s + palette.right.s) / 2,
    v: (palette.left.v + palette.right.v) / 2,
  };
}
```

### 5d. Update Python Reference (`tools/uv_island_gradient.py`)

Add a `--spatial` mode that accepts the global bounding box and per-triangle 3D centroids. Replicates the same 6-direction HSV blend with circular hue mean. This keeps the Python reference in sync as the canonical specification.

### 5e. Color Reference Swatch Layer

Update `paintColorSwatchLayer()` to show the 6 directional colors with their labels (Left, Right, Front, Back, Top, Bottom) instead of the current per-island swatches. This helps livery artists understand the spatial color language.

---

## Performance Considerations

| Operation | Current | After upgrade |
|---|---|---|
| Spatial index build | N/A | One-time O(n) scan of proxy triangles. ~50k triangles for a typical vehicle → 2-5ms |
| Fill painting | O(n) gradient lookups per shell | O(n) map lookups per triangle. Slightly more `ctx.fillStyle` changes but no gradient creation → **comparable or faster** |
| Memory | 4 palette objects | One `Map<string, [number,number,number]>` per mesh. ~50k entries × ~40 bytes ≈ **2 MB** transient |

The per-triangle approach does more `fillStyle` swaps than the per-island approach, but each swap is a simple CSS color string (cached by browser) rather than a Canvas gradient object. Real-world performance should be similar; canvas triangle rasterization dominates.

---

## Files Modified

| File | Changes |
|---|---|
| [src/lib/template-psd.js](src/lib/template-psd.js) | New: `SPATIAL_COLORS`, `spatialPositionToColor()`, `paintSpatialFillLayer()`, `fallbackShellColor()`, `quantizeUvCentroid()`. Modified: `buildAutoTemplatePsd()` to use spatial fill. Updated: `paintColorSwatchLayer()` |
| [src/lib/template-map.js](src/lib/template-map.js) | New: `buildSpatialIndex()` export (or place in template-psd.js) |
| [tools/uv_island_gradient.py](tools/uv_island_gradient.py) | New: `--spatial` mode with 6-direction color field |

No changes needed to:
- `TemplateGenerationPage.jsx` (proxy data already flows through)
- `Viewer.jsx` (3D rendering unaffected)
- `viewer-utils.js` (material system unaffected)
- `template-map.js` `buildYftTemplatePsdSource()` (proxy extraction already works)

---

## Testing Strategy

1. **Unit test `spatialPositionToColor()`** with known corner positions:
   - `(0, 0.5, 0.5)` → should be close to cyan (left)
   - `(1, 0.5, 0.5)` → should be close to pink (right)
   - `(0.5, 1, 0.5)` → should be close to green (front)
   - `(0.5, 0, 0.5)` → should be close to purple (back)
   - `(0.5, 0.5, 1)` → should be close to blue (top)
   - `(0, 1, 0.5)` → should blend cyan+green (front-left)
   - `(1, 0, 0.5)` → should blend pink+purple (back-right)

2. **Visual comparison** against the reference image using a known vehicle .yft

3. **Fallback path** — verify that a model with no proxy geometry still produces a valid template using the legacy hash-based system

4. **Python parity** — the Python `--spatial` output for the same input data should produce identical colors (within floating-point tolerance)

---

## Migration Path

The old hash-based system is **kept as a fallback**, not deleted. This ensures:
- Non-YFT models (DFF, etc.) that lack proxy geometry still get colored templates
- If the spatial index fails to build for any reason, the template still generates
- The upgrade is purely additive — no breaking changes

---

## Summary

This upgrade transforms template coloring from "each island gets a random pretty color" to "colors tell you where on the vehicle each piece lives." The implementation leverages the **existing proxy geometry infrastructure** that was built precisely for this purpose — the 3D positions, normals, and UV-island IDs are already extracted and available. The main new work is:

1. **~50 lines:** Spatial index builder (UV centroid → 3D centroid lookup)
2. **~30 lines:** Directional color field with circular hue blending
3. **~40 lines:** Per-triangle spatial fill painter
4. **~10 lines:** Wiring in `buildAutoTemplatePsd()`
5. **~20 lines:** Polish (dilation, fallback, swatch update)

Total: **~150 lines** of new/modified code for a dramatic visual upgrade that gives livery artists an instant spatial understanding of every template piece.
