import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import {
  DEFAULT_PROP_BONE,
  formatAttachSnippet,
  normalizePropAttachState,
  parseAttachSnippet,
  propLocalFromBoneMatrix,
} from "./prop-attach.js";
import { propAttachmentMatrix } from "./ped-pose.js";

test("normalizePropAttachState clamps out-of-range offsets and unknown options", () => {
  const fresh = normalizePropAttachState(null);
  assert.equal(fresh.enabled, false);
  assert.equal(fresh.bone, DEFAULT_PROP_BONE);
  assert.deepEqual(fresh.position, [0, 0, 0]);
  assert.deepEqual(fresh.rotation, [0, 0, 0]);

  const hostile = normalizePropAttachState({
    enabled: true,
    gender: "robot",
    pose: "flying",
    bone: 999999,
    position: [12, -9, Number.NaN],
    rotation: [500, -400, 45],
    format: "unknown",
  });
  assert.equal(hostile.enabled, true);
  assert.equal(hostile.gender, "male");
  assert.equal(hostile.pose, "idle");
  assert.equal(hostile.bone, DEFAULT_PROP_BONE);
  assert.deepEqual(hostile.position, [2, -2, 0]);
  assert.deepEqual(hostile.rotation, [180, -180, 45]);
  assert.equal(hostile.format, "native");
});

test("formatAttachSnippet generates valid Lua for all four FiveM conventions and round-trips", () => {
  const input = {
    modelName: "C:\\stream\\gsd_radio.ydr",
    bone: 57005,
    position: [0.125, 0.02, -0.04],
    rotation: [15, -90, 180],
  };

  const native = formatAttachSnippet({ ...input, format: "native" });
  assert.match(native, /AttachEntityToEntity/);
  assert.match(native, /GetPedBoneIndex\(ped, 57005\)/);
  assert.deepEqual(parseAttachSnippet(native), {
    bone: 57005,
    position: [0.125, 0.02, -0.04],
    rotation: [15, -90, 180],
  });

  const ox = formatAttachSnippet({ ...input, format: "ox_lib" });
  assert.match(ox, /pos = vec3\(0\.125, 0\.02, -0\.04\)/);
  assert.deepEqual(parseAttachSnippet(ox), {
    bone: 57005,
    position: [0.125, 0.02, -0.04],
    rotation: [15, -90, 180],
  });

  const rp = formatAttachSnippet({ ...input, format: "rpemotes" });
  assert.match(rp, /PropBone = 57005/);
  assert.deepEqual(parseAttachSnippet(rp), {
    bone: 57005,
    position: [0.125, 0.02, -0.04],
    rotation: [15, -90, 180],
  });

  const qb = formatAttachSnippet({ ...input, format: "qb" });
  assert.match(qb, /coords = vec3/);
  assert.deepEqual(parseAttachSnippet(qb), {
    bone: 57005,
    position: [0.125, 0.02, -0.04],
    rotation: [15, -90, 180],
  });

  assert.equal(parseAttachSnippet("nothing usable here"), null);

  const playerPed = `AttachEntityToEntity(obj, PlayerPedId(), GetPedBoneIndex(PlayerPedId(), 28422), 0.1, -0.05, 0.02, 10.0, 20.0, -30.0, true, true, false, true, 2, true)`;
  assert.deepEqual(parseAttachSnippet(playerPed), {
    bone: 28422,
    position: [0.1, -0.05, 0.02],
    rotation: [10, 20, -30],
  });

  const getPlayerPed = `AttachEntityToEntity(obj, GetPlayerPed(-1), GetPedBoneIndex(GetPlayerPed(-1), 60309), 0.03, 0.04, 0.05, 0.0, 90.0, 0.0, true, true, false, true, 2, true)`;
  assert.deepEqual(parseAttachSnippet(getPlayerPed), {
    bone: 60309,
    position: [0.03, 0.04, 0.05],
    rotation: [0, 90, 0],
  });

  const bareAttach = `AttachEntityToEntity(prop, ped, 18905, 0.11, 0.22, 0.33, 5, 10, 15, true, true, false, true, 2, true)`;
  assert.deepEqual(parseAttachSnippet(bareAttach), {
    bone: 18905,
    position: [0.11, 0.22, 0.33],
    rotation: [5, 10, 15],
  });
});

test("propLocalFromBoneMatrix round-trips with propAttachmentMatrix (GTA ZXY rotation order 2)", () => {
  const qBone = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -0.3, 0.2, "XYZ"));
  const skeleton = {
    bones: [
      {
        tag: 28422,
        parent: -1,
        tx: 0.25,
        ty: 0.1,
        tz: 0.9,
        qx: qBone.x,
        qy: qBone.y,
        qz: qBone.z,
        qw: qBone.w,
        worldTx: 0.25,
        worldTy: 0.1,
        worldTz: 0.9,
        worldQx: qBone.x,
        worldQy: qBone.y,
        worldQz: qBone.z,
        worldQw: qBone.w,
      },
    ],
  };
  const input = { bone: 28422, position: [0.12, -0.04, 0.08], rotation: [25, -40, 110] };
  const boneMat = new THREE.Matrix4().compose(new THREE.Vector3(0.25, 0.1, 0.9), qBone, new THREE.Vector3(1, 1, 1));
  const slotMat = propAttachmentMatrix(skeleton, null, input);
  const back = propLocalFromBoneMatrix(boneMat, slotMat);
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(back.position[i] - input.position[i]) < 1e-3, `pos[${i}] mismatch`);
    assert.ok(Math.abs(back.rotation[i] - input.rotation[i]) < 0.2, `rot[${i}] mismatch`);
  }
});
