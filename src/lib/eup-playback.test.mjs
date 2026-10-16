import test from "node:test";
import assert from "node:assert/strict";

import {
  PLAYBACK_SPEEDS,
  advanceClipTime,
  clampClipTime,
  clipEndTime,
  clipFrame,
  formatClipSeconds,
  isClipAtEnd,
  normalizePlayback,
} from "./eup-playback.js";
import { PED_BONE_TAGS, sampleClipPose } from "./ped-pose.js";

test("a looping clip advances exactly as the figures always have", () => {
  for (const [time, dt, duration] of [[0, 0.016, 2.1], [2.09, 0.05, 2.1], [0.5, 0.1, 1], [1.9, 0.3, 2]]) {
    assert.equal(advanceClipTime(time, dt, duration, true), (time + dt) % duration);
  }
  assert.equal(advanceClipTime(1, 0.1, 0, true), 0, "a clip without a duration stays at 0");
});

test("with loop off the clip holds its last frame instead of wrapping", () => {
  const duration = 2;
  const end = clipEndTime(duration);
  assert.ok(end < duration && end > duration - 1e-4);
  assert.equal(advanceClipTime(1.95, 0.1, duration, false), end);
  assert.equal(advanceClipTime(end, 0.1, duration, false), end, "stays put once there");
  assert.equal(advanceClipTime(0.5, 0.25, duration, false), 0.75);
  assert.ok(isClipAtEnd(end, duration));
  assert.ok(!isClipAtEnd(1.5, duration));
  assert.ok(!isClipAtEnd(5, 0), "no clip is never at its end");
});

test("the end time shows the clip's last sample, not the first", () => {
  // Two samples: the hand's parent thigh turns from rest to a quarter turn.
  const bone = (tag, parentIndex, t) => ({ tag, parentIndex, tx: t[0], ty: t[1], tz: t[2], qx: 0, qy: 0, qz: 0, qw: 1 });
  const skeleton = { bones: [bone(PED_BONE_TAGS.root, 0xffff, [0, 0, 0]), bone(PED_BONE_TAGS.lThigh, 0, [0, 0, 1])] };
  const quarter = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  const clip = {
    duration: 1,
    sampleRate: 1,
    samples: 2,
    rotations: [{ bone: PED_BONE_TAGS.lThigh, values: [0, 0, 0, 1, ...quarter] }],
    translations: [],
  };
  const atEnd = sampleClipPose(skeleton, clip, clampClipTime(5, clip.duration)).rotations.get(1);
  const wrapped = sampleClipPose(skeleton, clip, clip.duration).rotations.get(1);
  assert.ok(Math.abs(atEnd.x - Math.SQRT1_2) < 1e-4, "clamped time samples the final pose");
  assert.ok(Math.abs(wrapped.x) < 1e-9, "the raw duration would wrap to the first pose");
});

test("clampClipTime keeps scrub times inside the clip", () => {
  assert.equal(clampClipTime(-1, 2), 0);
  assert.equal(clampClipTime(Number.NaN, 2), 0);
  assert.equal(clampClipTime("0.5", 2), 0.5);
  assert.equal(clampClipTime(3, 2), clipEndTime(2));
  assert.equal(clampClipTime(1, 0), 0);
});

test("clipFrame reports the nearest sample and the last sample index", () => {
  const clip = { samples: 64, sampleRate: 30 };
  assert.deepEqual(clipFrame(0, clip), { frame: 0, frames: 63 });
  assert.deepEqual(clipFrame(0.5, clip), { frame: 15, frames: 63 });
  assert.deepEqual(clipFrame(10, clip), { frame: 63, frames: 63 });
  assert.deepEqual(clipFrame(-1, clip), { frame: 0, frames: 63 });
  assert.deepEqual(clipFrame(1, null), { frame: 0, frames: 0 });
  assert.deepEqual(clipFrame(1, { samples: 1, sampleRate: 30 }), { frame: 0, frames: 0 });
});

test("normalizePlayback defaults older workspaces to 1x, looping, playing", () => {
  assert.deepEqual(normalizePlayback(undefined), { speed: 1, loop: true, paused: false, time: 0 });
  assert.deepEqual(normalizePlayback({ speed: 0.5, loop: false, paused: true, time: 1.23456 }), {
    speed: 0.5,
    loop: false,
    paused: true,
    time: 1.235,
  });
  assert.equal(normalizePlayback({ speed: 3 }).speed, 1, "only the offered speeds");
  assert.equal(normalizePlayback({ speed: "2" }).speed, 1);
  assert.equal(normalizePlayback({ time: -2 }).time, 0);
  assert.equal(normalizePlayback({ time: "1" }).time, 0);
  assert.equal(normalizePlayback({ time: 1e9 }).time, 3600);
  assert.equal(normalizePlayback({ paused: "yes" }).paused, false);
  for (const speed of PLAYBACK_SPEEDS) assert.equal(normalizePlayback({ speed }).speed, speed);
});

test("formatClipSeconds", () => {
  assert.equal(formatClipSeconds(0.4166), "0.42\u00a0s");
  assert.equal(formatClipSeconds(-1), "0.00\u00a0s");
  assert.equal(formatClipSeconds(undefined), "0.00\u00a0s");
});
