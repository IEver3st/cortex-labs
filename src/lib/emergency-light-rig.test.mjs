import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { createEmergencyLightRig } from "./emergency-light-rig.js";
import { createSirenSetting } from "./siren-settings.js";
import { FLOOR_LIGHT_LAYER } from "./viewer-render-effects.js";

// A vehicle-space group with two lit siren heads on the roof, as the bridge
// delivers them (GTA space: +Z up).
function vehicle() {
  const space = new THREE.Group();
  for (const [index, x] of [[1, -0.5], [2, 0.5]]) {
    const geometry = new THREE.BoxGeometry(0.2, 0.2, 0.1);
    geometry.translate(x, 0.5, 1.8);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    mesh.userData.nativeMaterial = { lightBone: `siren${index}`, shaderName: "vehicle_emissive_opaque" };
    space.add(mesh);
  }
  const body = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 1.5).translate(0, 0, 0.75), new THREE.MeshStandardMaterial());
  space.add(body);
  space.rotation.x = -Math.PI / 2;
  const model = new THREE.Group().add(space);
  model.updateMatrixWorld(true);
  return model;
}

function litSetting() {
  const setting = createSirenSetting({ count: 2 });
  for (const siren of setting.sirens) {
    siren.light = true;
    siren.spotLight = true;
    siren.intensity = 2.5;
    siren.flashiness.sequencer = 0xffffffff;
  }
  return setting;
}

function named(rig, prefix) {
  return rig.group.children.filter((child) => child.name.startsWith(prefix));
}

test("the ground pool renders on the floor light layer the showroom mirror skips", () => {
  const scene = new THREE.Scene();
  const rig = createEmergencyLightRig({ scene, model: vehicle() });
  rig.setState({ setting: litSetting(), switches: { sirens: true } });
  rig.update(new THREE.PerspectiveCamera(), 0);
  const [pool] = named(rig, "light-ground-pool");
  assert.ok(pool, "spill builds a ground pool");
  assert.equal(pool.layers.mask, 1 << FLOOR_LIGHT_LAYER);
  assert.equal(pool.layers.isEnabled(0), false, "a layer-0 camera (the floor's mirror) does not draw it");
  rig.dispose();
});

test("body spill lights hold still while alternating heads flash", () => {
  // Two heads on the same side, far apart along the body, flashing in turn.
  const model = vehicle();
  const [space] = model.children;
  space.children[1].geometry.translate(-1, 1.4, 0);
  model.updateMatrixWorld(true);
  const setting = litSetting();
  setting.sirens[0].flashiness.sequencer = 0xaaaaaaaa;
  setting.sirens[1].flashiness.sequencer = 0x55555555;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const rig = createEmergencyLightRig({ scene, model });
  rig.setState({ setting, switches: { sirens: true } });
  const positions = new Set();
  for (let now = 0; now < 2000; now += 23) {
    rig.update(camera, now);
    for (const light of rig.group.children) {
      if (light.isPointLight && light.intensity > 0) positions.add(light.position.toArray().map((value) => value.toFixed(4)).join(","));
    }
  }
  assert.equal(positions.size, 1, "the lit body light keeps one position across pattern steps");
  rig.dispose();
});

test("coronas sit on each group of heads, not on the siren bone", () => {
  // Siren 1 lights a roof head and a bumper head; its bone sits mid-body.
  const model = vehicle();
  const [space] = model.children;
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.1).translate(-0.5, 2, 0.5), new THREE.MeshStandardMaterial());
  bumper.userData.nativeMaterial = { lightBone: "siren1", shaderName: "vehicle_emissive_opaque" };
  space.add(bumper);
  space.userData.lightBones = [{ name: "siren1", position: [0, -1, 0.8] }];
  model.updateMatrixWorld(true);
  const setting = litSetting();
  for (const siren of setting.sirens) {
    siren.scale = false;
    siren.corona = { ...siren.corona, size: 1, intensity: 30, faceCamera: true };
  }
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1, 10);
  const rig = createEmergencyLightRig({ scene, model });
  rig.setState({ setting, switches: { sirens: true } });
  rig.update(camera, 0);
  const shown = named(rig, "light-corona:siren1").filter((sprite) => sprite.visible);
  assert.equal(shown.length, 2, "one corona per head group");
  // World space is GTA space turned to +Y up: (x, y, z) -> (x, z, -y).
  const [bumperCorona, roofCorona] = shown.map((sprite) => sprite.position).sort((a, b) => a.y - b.y);
  assert.ok(Math.abs(bumperCorona.y - 0.5) < 0.05 && bumperCorona.z < -1.5, "bumper corona at the bumper head");
  assert.ok(Math.abs(roofCorona.y - 1.8) < 0.05 && roofCorona.z > -1, "roof corona at the roof head");
  rig.dispose();
});

test("fog beams exist only with fog on and follow the lit spot sirens", () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const rig = createEmergencyLightRig({ scene, model: vehicle() });
  rig.setState({ setting: litSetting(), switches: { sirens: true }, haze: 0 });
  rig.update(camera, 0);
  assert.equal(named(rig, "light-haze").length, 0, "no fog, no beams");

  rig.setState({ setting: litSetting(), switches: { sirens: true }, haze: 1 });
  rig.update(camera, 16);
  const beams = named(rig, "light-haze");
  assert.ok(beams.length > 0);
  const shown = beams.filter((beam) => beam.visible);
  assert.equal(shown.length, 2, "one beam per lit spot head");
  for (const beam of shown) {
    const u = beam.material.uniforms;
    assert.ok(u.uStrength.value > 0);
    assert.ok(u.uAxis.value.y < 0, "beams tilt down towards the floor");
    assert.ok(u.uApex.value.y > 1.5, "beams start at the siren heads");
  }

  rig.setState({ setting: litSetting(), switches: { sirens: false }, haze: 1 });
  rig.update(camera, 32);
  assert.equal(named(rig, "light-haze").length, 0, "sirens off removes the beams");
  rig.dispose();
  assert.equal(scene.children.length, 0, "dispose removes the rig group");
});

test("hazards flash in real time while siren playback is paused", () => {
  const space = new THREE.Group();
  for (const [lightId, x] of [[5, -0.8], [6, 0.8]]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.1).translate(x, 2, 0.8), new THREE.MeshStandardMaterial());
    mesh.userData.nativeMaterial = { lightId, shaderName: "vehicle_lightsemissive" };
    space.add(mesh);
  }
  const model = new THREE.Group().add(space);
  model.updateMatrixWorld(true);
  const rig = createEmergencyLightRig({ scene: new THREE.Scene(), model });
  rig.setState({ setting: litSetting(), switches: { sirens: true, indicators: "hazard" }, speed: 0 });
  const camera = new THREE.PerspectiveCamera();
  const lit = new Set();
  for (let now = 0; now <= 1500; now += 100) {
    assert.equal(rig.update(camera, now), true, "the loop keeps running for the indicators");
    lit.add(named(rig, "light-glow").every((glow) => glow.visible));
  }
  assert.deepEqual([...lit].sort(), [false, true], "both indicators turn on and off");
  assert.equal(rig.time, 0, "the paused siren clock does not move");
  rig.dispose();
});

test("sirens turn their meshes from the bone's rest heading to the carcols delta", () => {
  // A rear head on siren 1 (delta pi, scale x10) whose final spot is the bumper
  // at (0.5, -3, 0.4), 14 cm in from its bone. One pack models the emitter
  // facing forward on an unturned bone and relies on the turn; the other
  // pre-turns the bone to pi and models the emitter in place.
  const bone = new THREE.Vector3(0.6, -2.9, 0.4);
  const target = new THREE.Vector3(0.5, -3, 0.4);
  function rearHead(boneRotation, restOffset) {
    const space = new THREE.Group();
    const center = bone.clone().add(restOffset);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.0002, 0.002).translate(center.x, center.y, center.z), new THREE.MeshStandardMaterial());
    mesh.userData.nativeMaterial = { lightBone: "siren1", shaderName: "vehicle_emissive_opaque" };
    space.add(mesh);
    space.userData.lightBones = [{ name: "siren1", position: bone.toArray(), rotation: boneRotation }];
    const model = new THREE.Group().add(space);
    model.updateMatrixWorld(true);
    return { model, mesh };
  }
  const setting = litSetting();
  setting.sirens = setting.sirens.slice(0, 1);
  Object.assign(setting.sirens[0], { scale: true, scaleFactor: 10 });
  setting.sirens[0].flashiness.delta = Math.PI;
  const camera = new THREE.PerspectiveCamera();
  const cases = [
    ["unturned bone", [0, 0, 0, 1], new THREE.Vector3(0.01, 0.01, 0)],
    ["bone pre-turned to the delta", [0, 0, 1, 0], new THREE.Vector3(-0.01, -0.01, 0)],
  ];
  for (const [label, rotation, restOffset] of cases) {
    const { model, mesh } = rearHead(rotation, restOffset);
    const rig = createEmergencyLightRig({ scene: new THREE.Scene(), model });
    rig.setState({ setting, switches: { sirens: true } });
    rig.update(camera, 0);
    const center = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    assert.ok(center.distanceTo(target) < 1e-3, `${label}: head on the bumper, got ${center.toArray()}`);
    const [anchor] = rig.getSirenAnchors();
    assert.ok(anchor.position.distanceTo(target) < 1e-3, `${label}: marker on the head`);
    rig.dispose();
    assert.ok(mesh.position.lengthSq() < 1e-12 && mesh.quaternion.w === 1, `${label}: dispose restores the mesh`);
  }
});

// ELS: a vehicle whose lightbar heads are emissive meshes on extras 1 and 2,
// each extra also carrying a plain housing mesh.
function elsVehicle() {
  const space = new THREE.Group();
  for (const [extra, x] of [[1, -0.5], [2, 0.5]]) {
    for (const shaderName of ["vehicle_emissive_opaque", "vehicle_paint1"]) {
      const geometry = new THREE.BoxGeometry(0.2, 0.2, 0.1).translate(x, 0.5, 1.8);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
      mesh.userData.nativeMaterial = { shaderName, extraIndex: extra };
      mesh.userData.extraIndex = extra;
      mesh.userData.metaExtraVisible = true;
      space.add(mesh);
    }
  }
  space.add(new THREE.Mesh(new THREE.BoxGeometry(2, 4, 1.5).translate(0, 0, 0.75), new THREE.MeshStandardMaterial()));
  space.rotation.x = -Math.PI / 2;
  const model = new THREE.Group().add(space);
  model.updateMatrixWorld(true);
  return model;
}

function missConfig() {
  return {
    dialect: "miss-els",
    description: "",
    author: "",
    rootAttrs: {},
    lights: [
      { kind: "extra", id: 1, controlled: true, envLight: true, color: "red", offset: [0, 0, 0], attrs: {} },
      { kind: "extra", id: 2, controlled: true, envLight: true, color: "blue", offset: [0, 0, 0], attrs: {} },
    ],
    v8: null,
    miss: {
      statics: [],
      patterns: {
        primary: { isEmergency: true, flashHighBeam: null, warningBeep: null, attrs: {}, flashes: [{ duration: 100, extras: [1], miscs: [] }, { duration: 100, extras: [2], miscs: [] }] },
        secondary: null,
        rearReds: null,
      },
    },
  };
}

const extraMeshes = (model, extra) => {
  const out = [];
  model.traverse((child) => { if (child.isMesh && child.userData.extraIndex === extra) out.push(child); });
  return out;
};

test("an ELS preview flashes whole extras and hands them back when it stops", () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const model = elsVehicle();
  const rig = createEmergencyLightRig({ scene, model });
  assert.ok(rig, "emissive meshes on extras make a rig");
  const preview = { miss: { primary: true } };
  rig.setState({ els: { config: missConfig(), preview } });
  assert.equal(rig.active, true);
  assert.equal(rig.update(camera, 0), true, "flashing keeps the loop running");
  // t = 0: extra 1 lit, extra 2 dark (housing included: ELS switches the extra).
  assert.ok(extraMeshes(model, 1).every((mesh) => mesh.visible));
  assert.ok(extraMeshes(model, 2).every((mesh) => !mesh.visible));
  const glows = rig.group.children.filter((child) => child.isMesh && child.visible && child.layers.mask !== 0);
  assert.ok(glows.length >= 1, "the lit head glows");
  // 150 ms later the pattern is on extra 2.
  rig.update(camera, 150);
  assert.ok(extraMeshes(model, 1).every((mesh) => !mesh.visible));
  assert.ok(extraMeshes(model, 2).every((mesh) => mesh.visible));
  const pool = rig.group.children.find((child) => child.name.startsWith("light-ground-pool"));
  assert.ok(pool?.visible, "environment light spills on the ground");
  // Stopping hands both extras back to the extras plan (extra 2 planned off).
  extraMeshes(model, 2).forEach((mesh) => { mesh.userData.metaExtraVisible = false; });
  rig.setState({ els: { config: missConfig(), preview: { miss: { primary: false } } } });
  assert.equal(rig.update(camera, 300), false);
  assert.ok(extraMeshes(model, 1).every((mesh) => mesh.visible));
  assert.ok(extraMeshes(model, 2).every((mesh) => !mesh.visible));
  rig.dispose();
});

test("without an ELS preview, emissive extras keep their visibility and stay dark", () => {
  const scene = new THREE.Scene();
  const model = elsVehicle();
  extraMeshes(model, 2).forEach((mesh) => { mesh.visible = false; mesh.userData.metaExtraVisible = false; });
  const rig = createEmergencyLightRig({ scene, model });
  rig.setState({ switches: { headlights: "on" } });
  rig.update(new THREE.PerspectiveCamera(), 0);
  // ELS overlays and extra bookkeeping wait for an ELS preview.
  assert.equal(rig.group.children.filter((child) => child.isMesh).length, 0, "no ELS overlays are built");
  assert.ok(extraMeshes(model, 1).every((mesh) => mesh.visible));
  assert.ok(extraMeshes(model, 2).every((mesh) => !mesh.visible));
  assert.equal(rig.group.children.filter((child) => child.isMesh && child.visible).length, 0, "no glow without ELS");
  assert.equal(rig.active, true);
  rig.setState({});
  assert.equal(rig.update(new THREE.PerspectiveCamera(), 16), false);
  rig.dispose();
});

test("an ELS VCF decides when the carcols siren lights run", () => {
  const scene = new THREE.Scene();
  const rig = createEmergencyLightRig({ scene, model: vehicle() });
  const config = { ...missConfig(), dialect: "els-v8", miss: null, v8: { primary: null, secondary: null, warning: null, cruise: null, misc: { sirenLightsAtStage: 3, takedowns: {}, sceneLights: {} } } };
  // The Sirens switch is on, but ELS is at stage 2 of a VCF that runs sirens at 3.
  rig.setState({ setting: litSetting(), switches: { sirens: true }, els: { config, preview: { stage: 2 } } });
  rig.update(new THREE.PerspectiveCamera(), 0);
  assert.equal(named(rig, "light-ground-pool")[0]?.material.uniforms.uCount.value ?? 0, 0);
  rig.setState({ setting: litSetting(), switches: { sirens: false }, els: { config, preview: { stage: 3 } } });
  rig.update(new THREE.PerspectiveCamera(), 0);
  assert.ok(named(rig, "light-ground-pool")[0].material.uniforms.uCount.value > 0, "stage 3 runs the siren lights");
  rig.dispose();
});

test("a preview lens tint recolours a siren's glow and leaves the rest alone", () => {
  const model = vehicle();
  const [space] = model.children;
  const [textured, solid] = space.children;
  // Siren 1's lens texture is a red atlas block, as most veh_lits lenses are.
  textured.material.map = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
  const setting = litSetting();
  for (const siren of setting.sirens) siren.color = "#0000ff";
  const rig = createEmergencyLightRig({ scene: new THREE.Scene(), model });
  const glow = (mesh) => rig.group.children.find((child) => child.isMesh && child.geometry === mesh.geometry);
  const hue = (overlay) => overlay.material.color.toArray().map((value) => Math.round(value * 100) / 100);
  const frame = (lens) => {
    rig.setState({ setting, switches: { sirens: true }, lens });
    rig.update(new THREE.PerspectiveCamera(), 0);
  };

  frame(null);
  const [r, g, b] = hue(glow(textured));
  assert.ok(r > 0 && r === g && g === b, "untinted, the material is white and the texture keeps its red");
  assert.equal(glow(textured).material.userData.glowKeepHue.value, 1);
  assert.ok(hue(glow(solid))[2] > hue(glow(solid))[0], "an untextured lens glows in the siren colour");

  frame({ 1: "#00ff00", 2: "#00ff00" });
  const tinted = hue(glow(textured));
  assert.ok(tinted[1] > tinted[0] && tinted[1] > tinted[2], "the picked colour drives the textured glow");
  assert.equal(glow(textured).material.userData.glowKeepHue.value, 0, "and the texture's hue is set aside");
  const solidTint = hue(glow(solid));
  assert.ok(solidTint[1] > solidTint[2], "an untextured lens takes the tint too");

  frame({ 1: "siren" });
  const follows = hue(glow(textured));
  assert.ok(follows[2] > follows[0] && follows[2] > follows[1], "Match siren colour follows the carcols colour");
  assert.equal(glow(solid).material.userData.glowKeepHue.value, 1, "siren 2 without a tint is untouched");

  frame({ 1: "#00ff00" });
  rig.setState({ setting, switches: { sirens: true }, muted: [1], lens: { 1: "#00ff00" } });
  rig.update(new THREE.PerspectiveCamera(), 16);
  assert.equal(glow(textured).visible, false, "a muted siren stays dark whatever its tint");
  rig.dispose();
});

test("an ELS extra authored as an extralight lamp glows while ELS lights it", () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const model = elsVehicle();
  // Extra 1's head uses the lamp shader and extralight_1's id, as many ELS packs do.
  const head = extraMeshes(model, 1).find((mesh) => mesh.userData.nativeMaterial.shaderName === "vehicle_emissive_opaque");
  head.userData.nativeMaterial = { shaderName: "vehicle_lightsemissive", lightId: 14, extraIndex: 1 };
  const rig = createEmergencyLightRig({ scene, model });
  rig.setState({ els: { config: missConfig(), preview: { miss: { primary: true } } } });
  rig.update(camera, 0);
  assert.ok(head.visible);
  assert.ok(rig.group.children.some((child) => child.isMesh && child.visible && child.geometry === head.geometry), "the lamp-authored head glows");
  rig.dispose();
});
