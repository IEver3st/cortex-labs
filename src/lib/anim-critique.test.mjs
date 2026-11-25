import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { analyzeClipMotion, formatClipCritiqueMarkdown, maskUpperBodyPose } from "./anim-critique.js";

function qFromEulerDeg(x, y, z) {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(THREE.MathUtils.degToRad(x), THREE.MathUtils.degToRad(y), THREE.MathUtils.degToRad(z), "XYZ"),
  );
  return [q.x, q.y, q.z, q.w];
}

test("analyzeClipMotion detects loop seam jumps and single-frame velocity spikes", () => {
  const samples = 10;
  const rotValues = [];
  for (let i = 0; i < samples; i += 1) {
    // Smoothly ramp to 45 deg, with a sudden 40 deg pop at frame 5.
    const deg = i === 5 ? 60 : i * 5;
    rotValues.push(...qFromEulerDeg(0, 0, deg));
  }
  const clip = {
    duration: 0.3,
    samples,
    sampleRate: 30,
    rotations: [{ tag: 40269, values: rotValues }], // SKEL_R_UpperArm
    translations: [
      {
        tag: 11816,
        values: Array.from({ length: samples }, (_, i) => [i * 0.02, 0, 0]).flat(),
      },
    ],
  };

  const report = analyzeClipMotion(clip);
  assert.ok(report);
  assert.ok(report.maxSeamDeg >= 40, `expected loop seam >= 40°, got ${report.maxSeamDeg}`);
  assert.ok(report.spikes.length >= 1, "expected velocity spike detection");
  assert.equal(report.spikes[0].name, "SKEL_R_UpperArm");
  assert.ok(report.rootDriftCm >= 15);
  assert.ok(report.findings.some((f) => f.code === "LOOP_SEAM"));
  assert.ok(report.findings.some((f) => f.code === "VELOCITY_SPIKE"));
  assert.ok(report.findings.some((f) => f.code === "ROOT_DRIFT"));

  const md = formatClipCritiqueMarkdown(report, { name: "wave_hi", dict: "custom_anim" });
  assert.match(md, /Animation Critique/);
  assert.match(md, /SKEL_R_UpperArm/);
  assert.match(md, /LOOP_SEAM/);
});

test("analyzeClipMotion passes cleanly on a smooth closed loop", () => {
  const samples = 16;
  const rotValues = [];
  for (let i = 0; i < samples; i += 1) {
    const angle = Math.sin((i / (samples - 1)) * Math.PI * 2) * 15;
    rotValues.push(...qFromEulerDeg(angle, 0, 0));
  }
  const report = analyzeClipMotion({
    duration: 0.5,
    samples,
    sampleRate: 30,
    rotations: [{ tag: 31086, values: rotValues }],
    translations: [],
  });
  assert.equal(report.findings.length, 0);
  assert.ok(report.maxSeamDeg < 1);
});

test("maskUpperBodyPose keeps spine/arm rotations from clip and pelvis/legs from base pose", () => {
  const skeleton = {
    bones: [
      { tag: 0, parent: -1 },
      { tag: 11816, parent: 0 }, // pelvis
      { tag: 58271, parent: 1 }, // L thigh
      { tag: 23553, parent: 1 }, // Spine0
      { tag: 40269, parent: 3 }, // R UpperArm
    ],
  };
  const basePose = {
    rotations: new Map([
      [1, new THREE.Quaternion(0, 0, 0, 1)],
      [2, new THREE.Quaternion(0.1, 0, 0, 0.99)],
      [4, new THREE.Quaternion(0.2, 0, 0, 0.98)],
    ]),
    translations: new Map([[1, new THREE.Vector3(0, 0, 1)]]),
  };
  const clipPose = {
    rotations: new Map([
      [1, new THREE.Quaternion(0.5, 0, 0, 0.86)],
      [2, new THREE.Quaternion(0.6, 0, 0, 0.8)],
      [4, new THREE.Quaternion(0, 0.7, 0, 0.7)],
    ]),
    translations: new Map([[1, new THREE.Vector3(2, 0, 1)]]),
  };

  const masked = maskUpperBodyPose(clipPose, basePose, skeleton);
  assert.equal(masked.rotations.get(1), basePose.rotations.get(1));
  assert.equal(masked.rotations.get(2), basePose.rotations.get(2));
  assert.equal(masked.rotations.get(4), clipPose.rotations.get(4));
  assert.equal(masked.translations.get(1), basePose.translations.get(1));
});

test("analyzeClipMotion marks upperBodyActive for arm-only clips and catches final-frame foot dip", () => {
  const samples = 8;
  const armRot = [];
  for (let i = 0; i < samples; i += 1) {
    armRot.push(...qFromEulerDeg(0, 0, i * 3));
  }
  const armOnly = analyzeClipMotion({
    duration: 0.25,
    samples,
    sampleRate: 30,
    rotations: [{ tag: 40269, values: armRot }], // SKEL_R_UpperArm (no spine track)
    translations: [],
  });
  assert.equal(armOnly.upperBodyActive, true);

  // Skeleton with pelvis and left foot; foot dips below start floor on the final frame.
  const skeleton = {
    bones: [
      { tag: 11816, parentIndex: 0xffff, tx: 0, ty: 0, tz: 1.0, qx: 0, qy: 0, qz: 0, qw: 1 },
      { tag: 14201, parentIndex: 0, tx: 0, ty: 0, tz: -1.0, qx: 0, qy: 0, qz: 0, qw: 1 },
    ],
  };
  const pelvisTrans = [];
  for (let i = 0; i < samples; i += 1) {
    pelvisTrans.push(0, 0, i === samples - 1 ? 0.85 : 1.0);
  }
  const footDip = analyzeClipMotion(
    {
      duration: 0.7,
      samples,
      sampleRate: 10,
      rotations: [],
      translations: [{ bone: 11816, values: pelvisTrans }],
    },
    skeleton,
  );
  assert.ok(footDip.footClip && footDip.footClip.dipCm >= 10, `expected final-frame foot dip >= 10 cm, got ${JSON.stringify(footDip.footClip)}`);
  assert.ok(footDip.findings.some((f) => f.code === "FOOT_CLIP"));
});
