// Pure animation motion QA & upper-body pose masking for GTA V / FiveM clips.
// Works directly on the CodeWalker bridge's sampled clip format ({ duration,
// samples, sampleRate, rotations, translations }) and ped skeleton, so it runs
// under node:test without three.js rendering or Tauri.

import * as THREE from "three";
import { computePosedBoneMatrix, sampleClipPose } from "./ped-pose.js";

export const GTA_BONE_NAMES = Object.freeze({
  0: "SKEL_ROOT",
  11816: "SKEL_Pelvis",
  58271: "SKEL_L_Thigh",
  63931: "SKEL_L_Calf",
  14201: "SKEL_L_Foot",
  2108: "SKEL_L_Toe0",
  51826: "SKEL_R_Thigh",
  36864: "SKEL_R_Calf",
  52301: "SKEL_R_Foot",
  20781: "SKEL_R_Toe0",
  23553: "SKEL_Spine0",
  24816: "SKEL_Spine1",
  24817: "SKEL_Spine2",
  24818: "SKEL_Spine3",
  39317: "SKEL_Neck_1",
  31086: "SKEL_Head",
  64729: "SKEL_L_Clavicle",
  45509: "SKEL_L_UpperArm",
  61163: "SKEL_L_Forearm",
  18905: "SKEL_L_Hand",
  60309: "PH_L_Hand",
  10706: "SKEL_R_Clavicle",
  40269: "SKEL_R_UpperArm",
  28252: "SKEL_R_Forearm",
  57005: "SKEL_R_Hand",
  28422: "PH_R_Hand",
});

const UPPER_BODY_ROOT_TAGS = new Set([23553, 24816, 24817, 24818, 39317, 31086, 64729, 10706]);
const FALLBACK_UPPER_BODY_TAGS = new Set([
  ...UPPER_BODY_ROOT_TAGS,
  45509, 61163, 18905, 60309, 40269, 28252, 57005, 28422, 6286, 36029,
]);
const LOWER_BODY_TAGS = new Set([58271, 63931, 14201, 2108, 51826, 36864, 52301, 20781]);
const FOOT_LEFT_TAG = 14201;
const FOOT_RIGHT_TAG = 52301;
const PELVIS_TAG = 11816;
const RAD_TO_DEG = 180 / Math.PI;

export function boneDisplayName(tag) {
  return GTA_BONE_NAMES[tag] || `Bone_${tag}`;
}

function quatAngleDeg(ax, ay, az, aw, bx, by, bz, bw) {
  const al = Math.hypot(ax, ay, az, aw);
  const bl = Math.hypot(bx, by, bz, bw);
  if (al < 1e-8 || bl < 1e-8) return 0;
  let dot = (ax * bx + ay * by + az * bz + aw * bw) / (al * bl);
  if (dot < 0) dot = -dot;
  dot = Math.min(1, Math.max(0, dot));
  return 2 * Math.acos(dot) * RAD_TO_DEG;
}

function medianOf(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
}

const upperIndicesCache = new WeakMap();

function upperBodyIndices(skeleton) {
  const bones = skeleton?.bones;
  if (!Array.isArray(bones) || !bones.length) return null;
  let cached = upperIndicesCache.get(skeleton);
  if (cached && cached.bones === bones && cached.length === bones.length) return cached.indices;
  const indices = new Set();
  for (let i = 0; i < bones.length; i += 1) {
    let cur = i;
    let guard = 0;
    while (cur >= 0 && cur < bones.length && guard < 64) {
      if (UPPER_BODY_ROOT_TAGS.has(bones[cur].tag)) {
        indices.add(i);
        break;
      }
      const next = bones[cur].parent ?? bones[cur].parentIndex;
      if (!Number.isInteger(next) || next < 0 || next >= bones.length || next === cur) break;
      cur = next;
      guard += 1;
    }
  }
  cached = { bones, length: bones.length, indices };
  upperIndicesCache.set(skeleton, cached);
  return indices;
}

/**
 * Returns the set of bone tags belonging to the upper body (spine0+ and all
 * descendants: spine, neck, head, clavicles, arms, hands, fingers, PH_hands).
 */
export function upperBodyBoneTags(skeleton) {
  const bones = skeleton?.bones;
  const indices = upperBodyIndices(skeleton);
  if (!indices) return new Set(UPPER_BODY_ROOT_TAGS);
  const tags = new Set();
  for (const idx of indices) tags.add(bones[idx].tag);
  return tags;
}

/**
 * Combines an upper-body animation pose (`clipPose`) over a lower-body/base
 * pose (`basePose`, e.g. idle or walk), matching GTA V upper-body flags 48/49/51.
 */
export function maskUpperBodyPose(clipPose, basePose, skeleton) {
  const upperIndices = upperBodyIndices(skeleton);
  if (!upperIndices) return clipPose || basePose || null;

  const rotations = new Map();
  const translations = new Map();

  const baseRots = basePose instanceof Map ? basePose : basePose?.rotations;
  const baseTrans = basePose instanceof Map ? null : basePose?.translations;
  const clipRots = clipPose instanceof Map ? clipPose : clipPose?.rotations;
  const clipTrans = clipPose instanceof Map ? null : clipPose?.translations;

  if (baseRots) {
    for (const [idx, q] of baseRots) {
      if (!upperIndices.has(idx)) rotations.set(idx, q);
    }
  }
  if (baseTrans) {
    for (const [idx, t] of baseTrans) {
      if (!upperIndices.has(idx)) translations.set(idx, t);
    }
  }
  if (clipRots) {
    for (const [idx, q] of clipRots) {
      if (upperIndices.has(idx)) rotations.set(idx, q);
    }
  }
  if (clipTrans) {
    for (const [idx, t] of clipTrans) {
      if (upperIndices.has(idx)) translations.set(idx, t);
    }
  }

  return { rotations, translations };
}

/**
 * Analyzes a sampled GTA V clip for loop seams, velocity pops, root drift,
 * upper/lower body coverage, and foot floor clipping.
 */
export function analyzeClipMotion(clip, skeleton = null) {
  if (!clip || !Number.isInteger(clip.samples) || clip.samples < 2) return null;
  const samples = clip.samples;
  const duration = Number(clip.duration) || 0;
  const sampleRate = Number(clip.sampleRate) || (duration > 0 ? (samples - 1) / duration : 30);
  const rotTracks = Array.isArray(clip.rotations) ? clip.rotations : [];
  const transTracks = Array.isArray(clip.translations) ? clip.translations : [];

  const seamBones = [];
  const spikes = [];
  const movingUpper = [];
  const movingLower = [];
  const upperTags = skeleton ? upperBodyBoneTags(skeleton) : null;

  for (const track of rotTracks) {
    const v = track?.values;
    if (!v || v.length < samples * 4) continue;
    const tag = track.bone ?? track.tag;
    const last = (samples - 1) * 4;
    const seamDeg = quatAngleDeg(v[0], v[1], v[2], v[3], v[last], v[last + 1], v[last + 2], v[last + 3]);
    if (seamDeg > 0.5) seamBones.push({ tag, name: boneDisplayName(tag), degrees: Number(seamDeg.toFixed(1)) });

    const steps = [];
    let maxRangeFromStart = 0;
    for (let i = 1; i < samples; i += 1) {
      const prev = (i - 1) * 4;
      const cur = i * 4;
      const stepDeg = quatAngleDeg(v[prev], v[prev + 1], v[prev + 2], v[prev + 3], v[cur], v[cur + 1], v[cur + 2], v[cur + 3]);
      steps.push(stepDeg);
      const fromStart = quatAngleDeg(v[0], v[1], v[2], v[3], v[cur], v[cur + 1], v[cur + 2], v[cur + 3]);
      if (fromStart > maxRangeFromStart) maxRangeFromStart = fromStart;
    }

    if (maxRangeFromStart > 3) {
      const isUpper = upperTags ? upperTags.has(tag) : FALLBACK_UPPER_BODY_TAGS.has(tag);
      const isLower = LOWER_BODY_TAGS.has(tag);
      if (isUpper) movingUpper.push(boneDisplayName(tag));
      else if (isLower) movingLower.push(boneDisplayName(tag));
    }

    const med = medianOf(steps);
    const spikeThreshold = Math.max(25, med * 3.5);
    let worstStep = 0;
    let worstFrame = -1;
    for (let i = 0; i < steps.length; i += 1) {
      if (steps[i] > spikeThreshold && steps[i] > worstStep) {
        worstStep = steps[i];
        worstFrame = i + 1;
      }
    }
    if (worstFrame >= 0) {
      spikes.push({
        tag,
        name: boneDisplayName(tag),
        frame: worstFrame,
        time: Number((worstFrame / sampleRate).toFixed(2)),
        degrees: Number(worstStep.toFixed(1)),
      });
    }
  }

  let rootSeamCm = 0;
  let rootDriftCm = 0;
  let rootTrack = transTracks.find((t) => (t.bone ?? t.tag) === PELVIS_TAG)
    || transTracks.find((t) => (t.bone ?? t.tag) === 0)
    || null;
  if (rootTrack?.values && rootTrack.values.length >= samples * 3) {
    const v = rootTrack.values;
    const last = (samples - 1) * 3;
    const dx = v[last] - v[0];
    const dy = v[last + 1] - v[1];
    const dz = v[last + 2] - v[2];
    rootSeamCm = Number((Math.hypot(dx, dy, dz) * 100).toFixed(1));
    rootDriftCm = Number((Math.hypot(dx, dy) * 100).toFixed(1));
  }

  // Foot floor-clipping check when the skeleton is available.
  let footClip = null;
  const bones = skeleton?.bones;
  if (Array.isArray(bones) && bones.length) {
    const lIdx = bones.findIndex((b) => b.tag === FOOT_LEFT_TAG);
    const rIdx = bones.findIndex((b) => b.tag === FOOT_RIGHT_TAG);
    if (lIdx >= 0 || rIdx >= 0) {
      const checkCount = Math.min(samples, 24);
      const pos = new THREE.Vector3();
      const sampleFootZ = (timeSec) => {
        const pose = sampleClipPose(skeleton, clip, timeSec);
        let minZ = Infinity;
        for (const idx of [lIdx, rIdx]) {
          if (idx < 0) continue;
          const mat = computePosedBoneMatrix(skeleton, pose, idx);
          if (!mat) continue;
          pos.setFromMatrixPosition(mat);
          if (pos.z < minZ) minZ = pos.z;
        }
        return minZ;
      };
      const baseZ = sampleFootZ(0);
      if (Number.isFinite(baseZ)) {
        let worstDip = 0;
        let worstTime = 0;
        const maxSampleTime = duration > 0 ? duration * (1 - 1e-5) : 0;
        for (let i = 1; i < checkCount; i += 1) {
          const t = Math.min(maxSampleTime, (duration * i) / Math.max(1, checkCount - 1));
          const z = sampleFootZ(t);
          const dip = baseZ - z;
          if (dip > worstDip) {
            worstDip = dip;
            worstTime = t;
          }
        }
        if (worstDip > 0.03) {
          footClip = {
            dipCm: Number((worstDip * 100).toFixed(1)),
            time: Number(worstTime.toFixed(2)),
          };
        }
      }
    }
  }

  seamBones.sort((a, b) => b.degrees - a.degrees);
  spikes.sort((a, b) => b.degrees - a.degrees);

  const maxSeamDeg = seamBones[0]?.degrees || 0;
  const findings = [];
  if (maxSeamDeg >= 12) {
    findings.push({
      severity: maxSeamDeg >= 30 ? "warn" : "info",
      code: "LOOP_SEAM",
      message: `Loop seam jump: ${seamBones[0].name} shifts ${maxSeamDeg}° between the last frame and frame 0${rootSeamCm >= 3 ? ` (pelvis ${rootSeamCm} cm)` : ""}.`,
      fix: "Crossfade the final 4–8 frames back into frame 0 (or ensure frame 0 and the last frame share identical keyframes) so looped emotes don't snap.",
    });
  }
  if (spikes.length > 0) {
    const top = spikes[0];
    findings.push({
      severity: "warn",
      code: "VELOCITY_SPIKE",
      message: `Sudden motion pop on ${top.name}: ${top.degrees}° in one frame at frame ${top.frame} (${top.time}s).`,
      fix: "Check quaternion sign flips or un-smoothed keyframes around that frame.",
    });
  }
  if (rootDriftCm >= 8) {
    findings.push({
      severity: "info",
      code: "ROOT_DRIFT",
      message: `Pelvis drifts ${rootDriftCm} cm horizontally across the clip.`,
      fix: "If this is a stationary loop/emote, lock XY root translation so the ped doesn't snap back on repeat.",
    });
  }
  if (footClip) {
    findings.push({
      severity: "warn",
      code: "FOOT_CLIP",
      message: `Foot drops ${footClip.dipCm} cm below its frame-0 floor level around ${footClip.time}s.`,
      fix: "Raise the pelvis/foot curve near that timestamp so boots don't sink into the ground.",
    });
  }

  return {
    duration: Number(duration.toFixed(3)),
    samples,
    fps: Number(sampleRate.toFixed(1)),
    rotationTracks: rotTracks.length,
    translationTracks: transTracks.length,
    maxSeamDeg,
    rootSeamCm,
    rootDriftCm,
    seamBones: seamBones.slice(0, 5),
    spikes: spikes.slice(0, 5),
    footClip,
    upperBodyActive: movingUpper.length > 0,
    lowerBodyActive: movingLower.length > 0,
    findings,
  };
}

export function formatClipCritiqueMarkdown(report, { name = "clip", dict = "" } = {}) {
  if (!report) return "";
  const lines = [
    `# Animation Critique — \`${dict ? `${dict} / ${name}` : name}\``,
    "",
    `- **Duration:** ${report.duration}s (${report.samples} samples @ ${report.fps} fps)`,
    `- **Tracks:** ${report.rotationTracks} rotation, ${report.translationTracks} translation`,
    `- **Active regions:** ${[report.upperBodyActive ? "Upper body" : "", report.lowerBodyActive ? "Lower body" : ""].filter(Boolean).join(" + ") || "Minimal / static pose"}`,
    `- **Loop seam:** max ${report.maxSeamDeg}°${report.seamBones[0] ? ` (${report.seamBones[0].name})` : ""}${report.rootSeamCm > 0 ? ` · root ${report.rootSeamCm} cm` : ""}`,
  ];
  if (report.rootDriftCm > 0) lines.push(`- **Root horizontal drift:** ${report.rootDriftCm} cm`);
  if (report.footClip) lines.push(`- **Foot floor dip:** ${report.footClip.dipCm} cm at ${report.footClip.time}s`);
  lines.push("");

  if (!report.findings.length) {
    lines.push("All motion checks passed (clean loop seam, no velocity spikes, no foot dip).");
  } else {
    lines.push("## Findings");
    for (const f of report.findings) {
      lines.push(`- **[${f.severity.toUpperCase()} · ${f.code}]** ${f.message}`);
      if (f.fix) lines.push(`  - *Fix:* ${f.fix}`);
    }
  }

  if (report.seamBones.length > 1) {
    lines.push("", "## Top loop-seam deltas", ...report.seamBones.map((b) => `- \`${b.name}\`: ${b.degrees}°`));
  }
  if (report.spikes.length > 0) {
    lines.push("", "## Sharpest frame-to-frame spikes", ...report.spikes.map((s) => `- \`${s.name}\`: ${s.degrees}° at frame ${s.frame} (${s.time}s)`));
  }
  return lines.join("\n");
}
