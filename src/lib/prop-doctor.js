// Pure Prop Quality Auditor ("Prop Doctor") for Prop Studio.
// Inspects visual geometry, LODs, collision bounds alignment & density,
// scale/pivot sanity, missing texture bindings, RSC7 streamed memory and
// optional .ytyp archetype bounds without touching three.js or Tauri.

import { describeStreamedFile, formatMiB, memoryFindings } from "./pack-doctor.js";
import { formatCount, formatLength, PROP_LOD_LABELS, PROP_LODS } from "./prop-studio.js";

export const PROP_DOCTOR_SCHEMA = "cortex.propDoctor";
export const PROP_DOCTOR_VERSION = 1;

const SEVERITY_RANK = Object.freeze({ error: 0, warn: 1, info: 2 });

function finiteVec3(value) {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

function expandBounds(box, x, y, z) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  if (x < box.min[0]) box.min[0] = x;
  if (y < box.min[1]) box.min[1] = y;
  if (z < box.min[2]) box.min[2] = z;
  if (x > box.max[0]) box.max[0] = x;
  if (y > box.max[1]) box.max[1] = y;
  if (z > box.max[2]) box.max[2] = z;
  box.empty = false;
}

function finalizeBox(box) {
  if (!box || box.empty) return null;
  const size = [
    Math.max(0, box.max[0] - box.min[0]),
    Math.max(0, box.max[1] - box.min[1]),
    Math.max(0, box.max[2] - box.min[2]),
  ];
  const center = [
    (box.min[0] + box.max[0]) * 0.5,
    (box.min[1] + box.max[1]) * 0.5,
    (box.min[2] + box.max[2]) * 0.5,
  ];
  const diagonal = Math.hypot(size[0], size[1], size[2]);
  return { min: box.min, max: box.max, size, center, diagonal };
}

/**
 * Computes the GTA-space axis-aligned bounding box of normalized collision
 * data (meshes + box/sphere/capsule/cylinder primitives). Returns null if empty.
 */
export function computeCollisionBounds(collisions) {
  if (!collisions || typeof collisions !== "object") return null;
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], empty: true };

  for (const mesh of Array.isArray(collisions.meshes) ? collisions.meshes : []) {
    const pos = mesh?.positions;
    if (!pos?.length) continue;
    for (let i = 0; i + 2 < pos.length; i += 3) {
      expandBounds(box, pos[i], pos[i + 1], pos[i + 2]);
    }
  }

  for (const primitive of Array.isArray(collisions.primitives) ? collisions.primitives : []) {
    if (primitive.kind === "box" && finiteVec3(primitive.corner) && Array.isArray(primitive.edges) && primitive.edges.length === 3) {
      const [c, [e1, e2, e3]] = [primitive.corner, primitive.edges];
      if (!finiteVec3(e1) || !finiteVec3(e2) || !finiteVec3(e3)) continue;
      for (let mask = 0; mask < 8; mask += 1) {
        const s1 = mask & 1 ? 1 : 0;
        const s2 = mask & 2 ? 1 : 0;
        const s3 = mask & 4 ? 1 : 0;
        expandBounds(
          box,
          c[0] + s1 * e1[0] + s2 * e2[0] + s3 * e3[0],
          c[1] + s1 * e1[1] + s2 * e2[1] + s3 * e3[1],
          c[2] + s1 * e1[2] + s2 * e2[2] + s3 * e3[2],
        );
      }
    } else if (primitive.kind === "sphere" && finiteVec3(primitive.center) && Number.isFinite(primitive.radius)) {
      const [cx, cy, cz] = primitive.center;
      const r = Math.abs(primitive.radius);
      expandBounds(box, cx - r, cy - r, cz - r);
      expandBounds(box, cx + r, cy + r, cz + r);
    } else if ((primitive.kind === "capsule" || primitive.kind === "cylinder") && finiteVec3(primitive.a) && finiteVec3(primitive.b) && Number.isFinite(primitive.radius)) {
      const r = Math.abs(primitive.radius);
      for (const p of [primitive.a, primitive.b]) {
        expandBounds(box, p[0] - r, p[1] - r, p[2] - r);
        expandBounds(box, p[0] + r, p[1] + r, p[2] + r);
      }
    }
  }

  return finalizeBox(box);
}

function normalizeGtaBounds(gtaBounds) {
  if (!gtaBounds || !finiteVec3(gtaBounds.min) || !finiteVec3(gtaBounds.max)) return null;
  const box = { min: [...gtaBounds.min], max: [...gtaBounds.max], empty: false };
  return finalizeBox(box);
}

/**
 * Runs every Prop Doctor quality check against a loaded prop's metrics,
 * collisions, textures, streamed RSC7 memory, and optional .ytyp archetype.
 */
export function analyzePropHealth({
  name = "",
  format = "ydr",
  gtaBounds = null,
  lodStats = null,
  highTriangles = 0,
  highVertices = 0,
  missingBindings = [],
  textureFailures = [],
  collisionsStatus = "idle",
  collisions = null,
  streamedFiles = [],
  ytypArchetype = null,
  ytypFound = false,
  ytypTextureDict = "",
  missingUvMeshes = 0,
  missingNormalMeshes = 0,
  degenerateTriangles = 0,
  invertedWindingMeshes = 0,
} = {}) {
  const findings = [];
  const add = (severity, area, code, message, fix) => {
    findings.push({ severity, area, code, message, fix });
  };

  const visual = normalizeGtaBounds(gtaBounds);
  const maxDim = visual ? Math.max(...visual.size) : 0;
  const minDim = visual ? Math.min(...visual.size) : 0;

  /* ── 1. Scale & Pivot sanity ── */
  if (visual && visual.diagonal > 0) {
    if (maxDim < 0.01) {
      add(
        "warn",
        "geometry",
        "PROP_TOO_SMALL",
        `Largest dimension is only ${formatLength(maxDim)} (${formatLength(visual.size[0])} × ${formatLength(visual.size[1])} × ${formatLength(visual.size[2])}).`,
        "Check your export scale (e.g. Blender Apply Scale / cm vs metres) — tiny props disappear or clip in GTA.",
      );
    } else if (maxDim > 50) {
      add(
        "warn",
        "geometry",
        "PROP_TOO_LARGE",
        `Largest dimension is ${formatLength(maxDim)}, which looks unusually large for a single prop.`,
        "Verify unit scale before exporting (a 100× scale error turns a 20 cm prop into 20 m).",
      );
    }

    // Pivot/origin check: GTA origin is (0, 0, 0). Flag if origin sits well outside the mesh bounds.
    const pad = Math.max(0.05, visual.diagonal * 0.12);
    const outX = 0 < visual.min[0] - pad || 0 > visual.max[0] + pad;
    const outY = 0 < visual.min[1] - pad || 0 > visual.max[1] + pad;
    const outZ = 0 < visual.min[2] - pad || 0 > visual.max[2] + pad;
    if (outX || outY || outZ) {
      const distToCenter = Math.hypot(visual.center[0], visual.center[1], visual.center[2]);
      add(
        "warn",
        "geometry",
        "PROP_PIVOT_OUTSIDE",
        `GTA origin (0, 0, 0) sits ${formatLength(distToCenter)} away from the mesh centre, outside the bounding box.`,
        "Recentre the pivot to the bottom-centre (ground props) or grip point (handheld props) so spawning and placement behave predictably.",
      );
    } else if (Math.abs(visual.min[2]) > Math.max(0.08, visual.size[2] * 0.4) && maxDim >= 0.35) {
      const where = visual.min[2] > 0 ? `${formatLength(visual.min[2])} above` : `${formatLength(Math.abs(visual.min[2]))} below`;
      add(
        "info",
        "geometry",
        "PROP_PIVOT_NOT_FLOOR",
        `Bottom of the mesh sits ${where} Z = 0.`,
        "For floor-placed props, placing the origin at the base (Z = 0) prevents floating or sinking into the ground when spawned.",
      );
    }
  }

  /* ── 2. Poly budget, LODs & mesh integrity ── */
  const tris = Number(highTriangles) || 0;
  const verts = Number(highVertices) || 0;
  if (tris > 0 && visual) {
    const handheld = maxDim > 0 && maxDim < 0.6;
    const medium = maxDim >= 0.6 && maxDim < 3;
    if (tris > 100_000 || (handheld && tris > 30_000)) {
      add(
        "error",
        "geometry",
        "PROP_POLY_EXTREME",
        `High LOD has ${formatCount(tris)} triangles (${formatCount(verts)} vertices) for a ${formatLength(maxDim)} prop.`,
        "Decimate or retopologise the mesh before shipping — dense props hurt FiveM frame times when placed multiple times.",
      );
    } else if ((handheld && tris > 12_000) || (medium && tris > 35_000) || tris > 60_000) {
      add(
        "warn",
        "geometry",
        "PROP_POLY_HIGH",
        `High LOD has ${formatCount(tris)} triangles for a ${formatLength(maxDim)} prop.`,
        "Consider trimming bevels/hidden faces or baking detail into the normal map so repeated placements stay cheap.",
      );
    }
  }

  if (lodStats && typeof lodStats === "object") {
    const present = PROP_LODS.filter((lod) => Number(lodStats[lod]?.triangles) > 0);
    if (present.length === 1 && present[0] === "high" && tris >= 1500) {
      add(
        "info",
        "lod",
        "PROP_NO_LOWER_LODS",
        `Only the High LOD is present (${formatCount(tris)} triangles); Medium, Low and Very low are empty.`,
        "Adding a decimated Medium/Low LOD cuts GPU work when the prop is seen across a street or repeated in an MLO.",
      );
    }
    for (let i = 1; i < present.length; i += 1) {
      const higher = present[i - 1];
      const lower = present[i];
      const highCount = lodStats[higher].triangles;
      const lowCount = lodStats[lower].triangles;
      if (lowCount > highCount) {
        add(
          "warn",
          "lod",
          "PROP_LOD_INVERTED",
          `${PROP_LOD_LABELS[lower]} LOD (${formatCount(lowCount)} tris) has more triangles than ${PROP_LOD_LABELS[higher]} (${formatCount(highCount)} tris).`,
          "Swap or decimate the lower LODs so each step down uses fewer triangles than the level above it.",
        );
      }
    }
  }

  if (missingUvMeshes > 0) {
    add(
      "warn",
      "geometry",
      "PROP_MISSING_UVS",
      `${missingUvMeshes} ${missingUvMeshes === 1 ? "mesh has" : "meshes have"} no UV map.`,
      "Unwrap every textured mesh before export; meshes without UVs sample a single pixel.",
    );
  }
  if (missingNormalMeshes > 0) {
    add(
      "warn",
      "geometry",
      "PROP_MISSING_NORMALS",
      `${missingNormalMeshes} ${missingNormalMeshes === 1 ? "mesh has" : "meshes have"} no vertex normals.`,
      "Export smooth/split normals from your 3D tool so GTA lighting shades seams cleanly.",
    );
  }
  if (degenerateTriangles > 0) {
    add(
      "info",
      "geometry",
      "PROP_DEGENERATE_TRIS",
      `${formatCount(degenerateTriangles)} degenerate (zero-area) triangles were found.`,
      "Run Merge by Distance / Delete Loose / Degenerate Dissolve in Blender before re-exporting.",
    );
  }
  if (invertedWindingMeshes > 0) {
    add(
      "warn",
      "geometry",
      "PROP_INVERTED_WINDING",
      `${invertedWindingMeshes} ${invertedWindingMeshes === 1 ? "closed mesh appears" : "closed meshes appear"} to have inside-out face winding.`,
      "Switch to Backface shading to inspect red faces, then recalculate normals outside (Shift+N in Blender).",
    );
  }

  /* ── 3. Collisions QA ── */
  const isGltf = format === "glb" || format === "gltf";
  if (isGltf) {
    add(
      "info",
      "collisions",
      "PROP_GLTF_PREVIEW",
      "Pre-export glTF/GLB preview — collision bounds and RSC7 memory checks run after Sollumz .ydr/.yft export.",
      "Use Scale reference, Backface, UV check, Channel inspector, and Ped attach to verify before export.",
    );
  } else if (collisionsStatus === "none") {
    add(
      "warn",
      "collisions",
      "PROP_COLLISION_MISSING",
      "No embedded collision bounds were found in this model.",
      "Embed a simplified collision bound (box/capsule/poly) in Sollumz/CodeWalker unless this prop is intentionally non-solid.",
    );
  } else if (collisionsStatus === "ready" && collisions) {
    const colTris = Number(collisions.triangles) || 0;
    const colPrims = Array.isArray(collisions.primitives) ? collisions.primitives.length : 0;
    if (colTris > 8000) {
      add(
        "error",
        "collisions",
        "PROP_COLLISION_HEAVY",
        `Collision mesh has ${formatCount(colTris)} triangles — it looks like the visual mesh was used directly as collision.`,
        "Replace with simple primitives (boxes/capsules) or a decimated hull under ~500–1,000 triangles to avoid GTA physics hitches.",
      );
    } else if (colTris > 2000) {
      add(
        "warn",
        "collisions",
        "PROP_COLLISION_DENSE",
        `Collision mesh has ${formatCount(colTris)} triangles.`,
        "Simplify the collision bound (primitives or a convex/low-poly hull) for cheaper physics and bullet raycasts.",
      );
    }

    const mats = Array.isArray(collisions.materials) ? collisions.materials : [];
    if (mats.length > 0 && mats.every((mat) => mat.index === 0)) {
      add(
        "info",
        "collisions",
        "PROP_COLLISION_DEFAULT_MAT",
        `All collision shapes (${colTris ? `${formatCount(colTris)} tris` : `${colPrims} shapes`}) use material 0 (DEFAULT).`,
        "Assign a real GTA collision material (e.g. METAL_SOLID, WOOD_SOLID, PLASTIC, GLASS) for authentic footstep, impact and bullet sounds.",
      );
    }

    const colBounds = computeCollisionBounds(collisions);
    if (visual && colBounds && visual.diagonal > 0.01) {
      const offset = Math.hypot(
        colBounds.center[0] - visual.center[0],
        colBounds.center[1] - visual.center[1],
        colBounds.center[2] - visual.center[2],
      );
      if (offset > Math.max(0.03, visual.diagonal * 0.15)) {
        add(
          "warn",
          "collisions",
          "PROP_COLLISION_OFFSET",
          `Collision centre is shifted ${formatLength(offset)} from the visual mesh centre.`,
          "Apply transforms (Ctrl+A → Location/Rotation/Scale) on both the mesh and collision bound before exporting.",
        );
      }
      const ratio = colBounds.diagonal / visual.diagonal;
      if (ratio < 0.5 || ratio > 1.8) {
        add(
          "warn",
          "collisions",
          "PROP_COLLISION_SIZE_MISMATCH",
          `Collision bounds (${formatLength(colBounds.size[0])} × ${formatLength(colBounds.size[1])} × ${formatLength(colBounds.size[2])}) are ${Math.round(ratio * 100)}% of the visual mesh size.`,
          "Check that the collision scale and rotation match the visual model (toggle Collisions in the deck to inspect).",
        );
      }
    }
  }

  /* ── 4. Missing or failed textures ── */
  const missingList = Array.isArray(missingBindings) ? missingBindings.filter((entry) => entry?.textureName) : [];
  if (missingList.length > 0) {
    const uniqueNames = [...new Set(missingList.map((entry) => entry.textureName))];
    const preview = uniqueNames.slice(0, 6).join(", ") + (uniqueNames.length > 6 ? ` and ${uniqueNames.length - 6} more` : "");
    add(
      "warn",
      "textures",
      "PROP_MISSING_TEXTURES",
      `${uniqueNames.length} referenced ${uniqueNames.length === 1 ? "texture wasn't" : "textures weren't"} found: ${preview}.`,
      "Embed the textures, place a matching .ytd next to the model, link it in your .ytyp, or add the dictionary in the Textures slot.",
    );
  }
  const failedList = Array.isArray(textureFailures) ? textureFailures : [];
  if (failedList.length > 0) {
    add(
      "error",
      "textures",
      "PROP_TEXTURE_LOAD_FAILED",
      `${failedList.length} ${failedList.length === 1 ? "texture failed" : "textures failed"} to decode.`,
      "Re-export the failing DDS textures as standard DXT1/DXT5 or BC7 with power-of-two dimensions.",
    );
  }

  /* ── 5. Streamed RSC7 memory (reusing Pack Doctor thresholds) ── */
  const described = (Array.isArray(streamedFiles) ? streamedFiles : []).map(describeStreamedFile).filter(Boolean);
  for (const finding of memoryFindings(described)) {
    findings.push(finding);
  }

  /* ── 6. .ytyp archetype validation (when a .ytyp.xml sits in the folder/resource) ── */
  if (ytypFound && !ytypArchetype && name) {
    add(
      "warn",
      "ytyp",
      "PROP_YTYP_MISSING_ARCHETYPE",
      `No archetype named "${name}" was found in the nearby .ytyp.xml.`,
      "Generate or add a CBaseArchetypeDef entry for this prop in the Export / .ytyp panel so FiveM can stream and spawn it.",
    );
  } else if (ytypArchetype && visual) {
    if (finiteVec3(ytypArchetype.bbMin) && finiteVec3(ytypArchetype.bbMax)) {
      const tol = Math.max(0.05, visual.diagonal * 0.08);
      const minDrift = Math.max(
        Math.abs(ytypArchetype.bbMin[0] - visual.min[0]),
        Math.abs(ytypArchetype.bbMin[1] - visual.min[1]),
        Math.abs(ytypArchetype.bbMin[2] - visual.min[2]),
      );
      const maxDrift = Math.max(
        Math.abs(ytypArchetype.bbMax[0] - visual.max[0]),
        Math.abs(ytypArchetype.bbMax[1] - visual.max[1]),
        Math.abs(ytypArchetype.bbMax[2] - visual.max[2]),
      );
      const drift = Math.max(minDrift, maxDrift);
      if (drift > tol) {
        add(
          "warn",
          "ytyp",
          "PROP_YTYP_BOUNDS_DRIFT",
          `.ytyp bounding box differs from the mesh by ${formatLength(drift)} (stale bounds cause props to pop out of view near screen edges).`,
          "Regenerate the archetype bounds in the .ytyp panel and update your .ytyp file.",
        );
      }
    }
    if (ytypTextureDict && ytypArchetype.textureDictionary && ytypArchetype.textureDictionary.toLowerCase() !== ytypTextureDict.toLowerCase()) {
      add(
        "info",
        "ytyp",
        "PROP_YTYP_TXD_MISMATCH",
        `.ytyp textureDictionary is "${ytypArchetype.textureDictionary}", while the sibling dictionary is "${ytypTextureDict}".`,
        "Confirm the prop intentionally shares that dictionary, or update textureDictionary to match.",
      );
    }
  }

  findings.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
  const counts = { error: 0, warn: 0, info: 0 };
  for (const item of findings) {
    if (item.severity in counts) counts[item.severity] += 1;
  }

  const totalMem = described.reduce(
    (sum, file) => (file.checked ? { physical: sum.physical + file.physical, virtual: sum.virtual + file.virtual } : sum),
    { physical: 0, virtual: 0 },
  );

  return {
    schema: PROP_DOCTOR_SCHEMA,
    version: PROP_DOCTOR_VERSION,
    name,
    format,
    counts,
    findings,
    memory: {
      files: described,
      physical: totalMem.physical,
      virtual: totalMem.virtual,
    },
    bounds: visual,
    summary: {
      triangles: tris,
      vertices: verts,
      maxDimension: maxDim,
      minDimension: minDim,
    },
  };
}

/**
 * Formats a Prop Doctor report as compact Markdown suitable for pasting into
 * bug reports, Discord, or an AI authoring workflow (e.g. Opus / Claude).
 */
export function formatPropHealthMarkdown(report) {
  if (!report) return "";
  const lines = [];
  const label = report.name ? `${report.name}.${report.format || "ydr"}` : "Prop";
  lines.push(`## Prop Doctor: ${label}`);
  const stats = [];
  if (report.summary?.triangles) stats.push(`${formatCount(report.summary.triangles)} tris`);
  if (report.summary?.vertices) stats.push(`${formatCount(report.summary.vertices)} verts`);
  if (report.bounds?.size) {
    const [x, y, z] = report.bounds.size;
    stats.push(`${formatLength(x)} × ${formatLength(y)} × ${formatLength(z)}`);
  }
  if (report.memory?.physical || report.memory?.virtual) {
    stats.push(`RSC7 ${formatMiB(report.memory.physical)} MiB GPU · ${formatMiB(report.memory.virtual)} MiB RAM`);
  }
  if (stats.length) lines.push(stats.join(" · "));
  lines.push("");

  if (!report.findings?.length) {
    lines.push("No issues found.");
    return lines.join("\n");
  }

  const tag = { error: "ERROR", warn: "WARN", info: "NOTE" };
  for (const finding of report.findings) {
    lines.push(`- **[${tag[finding.severity] || "INFO"}] ${finding.code}** — ${finding.message}`);
    if (finding.fix) lines.push(`  - Fix: ${finding.fix}`);
  }
  return lines.join("\n");
}

/**
 * Summarizes what changed after a live reload of the same prop file.
 * Returns null if nothing meaningful changed or inputs are incomplete.
 */
export function computePropReloadDelta(previous, next) {
  if (!previous || !next || previous.path !== next.path) return null;
  const parts = [];
  if (Number.isFinite(previous.triangles) && Number.isFinite(next.triangles) && previous.triangles !== next.triangles) {
    const diff = next.triangles - previous.triangles;
    const sign = diff > 0 ? "+" : "";
    const pct = previous.triangles > 0 ? ` (${sign}${Math.round((diff / previous.triangles) * 100)}%)` : "";
    parts.push({
      key: "triangles",
      label: `Tris ${formatCount(previous.triangles)} → ${formatCount(next.triangles)}${pct}`,
      tone: diff < 0 ? "good" : "neutral",
    });
  }
  if (Number.isFinite(previous.vertices) && Number.isFinite(next.vertices) && previous.vertices !== next.vertices && parts.length === 0) {
    parts.push({
      key: "vertices",
      label: `Verts ${formatCount(previous.vertices)} → ${formatCount(next.vertices)}`,
      tone: next.vertices < previous.vertices ? "good" : "neutral",
    });
  }
  if (previous.dims && next.dims) {
    const prevMax = Math.max(previous.dims.x, previous.dims.y, previous.dims.z);
    const nextMax = Math.max(next.dims.x, next.dims.y, next.dims.z);
    if (Math.abs(nextMax - prevMax) > 0.002) {
      parts.push({
        key: "size",
        label: `Size ${formatLength(prevMax)} → ${formatLength(nextMax)}`,
        tone: "neutral",
      });
    }
  }
  if (Number.isFinite(previous.issues) && Number.isFinite(next.issues) && previous.issues !== next.issues) {
    parts.push({
      key: "issues",
      label: `Issues ${previous.issues} → ${next.issues}`,
      tone: next.issues < previous.issues ? "good" : "warn",
    });
  }
  if (!parts.length) return { changed: false, parts: [{ key: "same", label: "Geometry unchanged (textures/materials refreshed)", tone: "neutral" }] };
  return { changed: true, parts };
}
