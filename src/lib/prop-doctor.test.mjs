import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzePropHealth,
  computeCollisionBounds,
  computePropReloadDelta,
  formatPropHealthMarkdown,
} from "./prop-doctor.js";

test("computeCollisionBounds covers meshes and all primitive shapes", () => {
  const bounds = computeCollisionBounds({
    meshes: [{ positions: new Float32Array([-0.5, -0.5, 0, 0.5, 0.5, 1]) }],
    primitives: [
      { kind: "sphere", center: [2, 0, 0.5], radius: 0.5 },
      { kind: "capsule", a: [0, 0, 0], b: [0, 0, 2], radius: 0.2 },
    ],
  });
  assert.ok(bounds);
  assert.deepEqual(bounds.min.map((n) => Number(n.toFixed(2))), [-0.5, -0.5, -0.2]);
  assert.deepEqual(bounds.max.map((n) => Number(n.toFixed(2))), [2.5, 0.5, 2.2]);
  assert.equal(computeCollisionBounds({ meshes: [], primitives: [] }), null);
});

test("Prop Doctor flags missing collision, collision mismatch, dense collision and default material", () => {
  const visual = { min: [-0.2, -0.2, 0], max: [0.2, 0.2, 0.4] };

  const missing = analyzePropHealth({ name: "prop_cup", gtaBounds: visual, collisionsStatus: "none" });
  assert.ok(missing.findings.some((f) => f.code === "PROP_COLLISION_MISSING"));

  const shiftedAndHeavy = analyzePropHealth({
    name: "prop_cup",
    gtaBounds: visual,
    collisionsStatus: "ready",
    collisions: {
      triangles: 9500,
      meshes: [{ positions: new Float32Array([1.0, 1.0, 0, 3.0, 3.0, 2.0]) }],
      primitives: [],
      materials: [{ index: 0, name: "DEFAULT" }],
    },
  });
  const codes = new Set(shiftedAndHeavy.findings.map((f) => f.code));
  assert.ok(codes.has("PROP_COLLISION_HEAVY"));
  assert.ok(codes.has("PROP_COLLISION_DEFAULT_MAT"));
  assert.ok(codes.has("PROP_COLLISION_OFFSET"));
  assert.ok(codes.has("PROP_COLLISION_SIZE_MISMATCH"));
  assert.equal(shiftedAndHeavy.counts.error, 1);
});

test("Prop Doctor flags scale errors, outside pivots, inverted LODs and missing textures", () => {
  const report = analyzePropHealth({
    name: "prop_radio",
    format: "ydr",
    gtaBounds: { min: [2, 2, 2], max: [2.004, 2.004, 2.004] },
    highTriangles: 45000,
    highVertices: 30000,
    lodStats: { high: { triangles: 45000 }, med: { triangles: 50000 } },
    missingBindings: [
      { material: "body", paramName: "DiffuseSampler", textureName: "radio_diff" },
      { material: "body", paramName: "BumpSampler", textureName: "radio_nrm" },
    ],
    missingUvMeshes: 1,
    missingNormalMeshes: 1,
    degenerateTriangles: 14,
    invertedWindingMeshes: 1,
    ytypFound: true,
    ytypArchetype: null,
  });
  const codes = new Set(report.findings.map((f) => f.code));
  assert.ok(codes.has("PROP_TOO_SMALL"));
  assert.ok(codes.has("PROP_PIVOT_OUTSIDE"));
  assert.ok(codes.has("PROP_POLY_EXTREME"));
  assert.ok(codes.has("PROP_LOD_INVERTED"));
  assert.ok(codes.has("PROP_MISSING_TEXTURES"));
  assert.ok(codes.has("PROP_MISSING_UVS"));
  assert.ok(codes.has("PROP_MISSING_NORMALS"));
  assert.ok(codes.has("PROP_DEGENERATE_TRIS"));
  assert.ok(codes.has("PROP_INVERTED_WINDING"));
  assert.ok(codes.has("PROP_YTYP_MISSING_ARCHETYPE"));

  const md = formatPropHealthMarkdown(report);
  assert.match(md, /## Prop Doctor: prop_radio\.ydr/);
  assert.match(md, /radio_diff, radio_nrm/);
});

test("Prop Doctor validates .ytyp bounds drift and dictionary mismatch", () => {
  const report = analyzePropHealth({
    name: "prop_crate",
    gtaBounds: { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 1] },
    ytypFound: true,
    ytypTextureDict: "prop_crate",
    ytypArchetype: {
      name: "prop_crate",
      textureDictionary: "shared_crates",
      bbMin: [-2, -2, 0],
      bbMax: [2, 2, 4],
    },
  });
  const codes = new Set(report.findings.map((f) => f.code));
  assert.ok(codes.has("PROP_YTYP_BOUNDS_DRIFT"));
  assert.ok(codes.has("PROP_YTYP_TXD_MISMATCH"));
});

test("clean well-built prop passes with zero warnings or errors", () => {
  const report = analyzePropHealth({
    name: "prop_lamp",
    format: "ydr",
    gtaBounds: { min: [-0.15, -0.15, 0], max: [0.15, 0.15, 0.45] },
    highTriangles: 850,
    highVertices: 540,
    lodStats: { high: { triangles: 850 }, med: { triangles: 320 } },
    collisionsStatus: "ready",
    collisions: {
      triangles: 48,
      meshes: [{ positions: new Float32Array([-0.15, -0.15, 0, 0.15, 0.15, 0.45]) }],
      primitives: [],
      materials: [{ index: 12, name: "METAL_SOLID_SMALL" }],
    },
    ytypFound: true,
    ytypTextureDict: "prop_lamp",
    ytypArchetype: {
      name: "prop_lamp",
      textureDictionary: "prop_lamp",
      bbMin: [-0.15, -0.15, 0],
      bbMax: [0.15, 0.15, 0.45],
    },
  });
  assert.equal(report.counts.error, 0);
  assert.equal(report.counts.warn, 0);
  assert.equal(report.counts.info, 0);
  assert.match(formatPropHealthMarkdown(report), /No issues found/);
});

test("computePropReloadDelta summarizes geometry and QA changes across reloads", () => {
  const delta = computePropReloadDelta(
    { path: "a.ydr", triangles: 4000, vertices: 2200, dims: { x: 0.4, y: 0.4, z: 0.4 }, issues: 3 },
    { path: "a.ydr", triangles: 2000, vertices: 1200, dims: { x: 0.2, y: 0.2, z: 0.2 }, issues: 0 },
  );
  assert.equal(delta.changed, true);
  assert.ok(delta.parts.some((part) => part.key === "triangles" && part.label.includes("-50%")));
  assert.ok(delta.parts.some((part) => part.key === "issues" && part.tone === "good"));
  assert.equal(computePropReloadDelta({ path: "a.ydr" }, { path: "b.ydr" }), null);
});

test("Prop Doctor reports PROP_GLTF_PREVIEW info finding for glTF/GLB previews", () => {
  const report = analyzePropHealth({
    name: "blender_prop",
    format: "glb",
    gtaBounds: { min: [-0.2, -0.2, 0], max: [0.2, 0.2, 0.5] },
    highTriangles: 1200,
    highVertices: 700,
  });
  assert.ok(report.findings.some((f) => f.code === "PROP_GLTF_PREVIEW" && f.severity === "info"));
});
