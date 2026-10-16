import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILD_ANGLES,
  CURRENT_BUILD,
  buildKitShootManifest,
  buildSelectionForKit,
  changeCrop,
  collectShotIssues,
  diffImages,
  findDuplicateShots,
  modTypeId,
  normalizeKitShootSettings,
  normalizeSavedBuilds,
  parsePaintList,
  partFileName,
  partsCrop,
  pickProbe,
  probeCandidates,
  scoreProbe,
  thumbPath,
  unionBoxes,
  planBuildsShoot,
  planFocusShot,
  planPartsShoot,
  removeSavedBuild,
  renderKitShootReport,
  revealBonesForSlot,
  reviewGroups,
  slotFolderName,
  upsertSavedBuild,
  wipeSplit,
} from "./kit-shoot.js";

function mod(index, displayName, extra = {}) {
  return {
    index,
    modelName: `car_${displayName.toLowerCase().replace(/\W+/g, "_")}`,
    label: `CAR_MOD_${index}`,
    displayName,
    named: true,
    linkedModels: [],
    turnOffBones: [],
    bone: "",
    ...extra,
  };
}

const KIT = {
  kitName: "123_mycar_modkit",
  id: 123,
  linked: true,
  slots: [
    { type: "VMT_SPOILER", label: "Spoiler", displayName: "Wings", mods: [mod(0, "Ducktail"), mod(1, "GT Wing"), mod(3, "Carbon Wing")] },
    { type: "VMT_BUMPER_F", label: "Front bumper", displayName: "Front bumper", mods: [mod(0, "Splitter", { turnOffBones: ["bumper_f"] })] },
  ],
};

test("modTypeId follows the game's eVehicleModType numbering", () => {
  assert.equal(modTypeId("VMT_SPOILER"), 0);
  assert.equal(modTypeId("vmt_bumper_f"), 1);
  assert.equal(modTypeId("VMT_PLTHOLDER"), 25);
  assert.equal(modTypeId("VMT_SEATS"), 32);
  assert.equal(modTypeId("VMT_LIVERY_MOD"), 48);
  assert.equal(modTypeId("VMT_LIGHTBAR"), 49);
  assert.equal(modTypeId("VMT_NOT_A_SLOT"), null);
});

test("slot folders and part files sort in game order", () => {
  assert.equal(slotFolderName({ type: "VMT_BUMPER_F", label: "Front bumper" }), "01-front-bumper");
  assert.equal(slotFolderName({ type: "VMT_CUSTOM", label: "" }), "zz-vmt-custom");
  assert.equal(partFileName(null, "Stock"), "stock.png");
  assert.equal(partFileName(3, "Carbon Wing!"), "03-carbon-wing.png");
});

test("planPartsShoot starts each slot with its base and keeps carcols indices", () => {
  const plan = planPartsShoot({ kit: KIT });
  assert.equal(plan.slots.length, 2);
  assert.equal(plan.shotCount, 6);
  const spoiler = plan.slots[0];
  assert.equal(spoiler.modType, 0);
  assert.deepEqual(spoiler.shots.map((shot) => shot.modIndex), [null, 0, 1, 3]);
  assert.equal(spoiler.shots[0].isBase, true);
  assert.equal(spoiler.shots[0].file, "00-spoiler/stock.png");
  assert.deepEqual(spoiler.shots[3].selection, { VMT_SPOILER: 3 });
  assert.equal(spoiler.shots[3].file, "00-spoiler/03-carbon-wing.png");
});

test("planPartsShoot on a build swaps one slot at a time and does not repeat the base part", () => {
  const plan = planPartsShoot({ kit: KIT, base: { VMT_SPOILER: 1, VMT_BUMPER_F: 0 }, slotTypes: ["vmt_spoiler"] });
  assert.equal(plan.slots.length, 1);
  const shots = plan.slots[0].shots;
  assert.deepEqual(shots.map((shot) => shot.modIndex), [1, 0, 3]);
  assert.deepEqual(shots[0].selection, { VMT_SPOILER: 1, VMT_BUMPER_F: 0 });
  assert.deepEqual(shots[1].selection, { VMT_SPOILER: 0, VMT_BUMPER_F: 0 });
});

test("planPartsShoot ignores a base index the slot does not have", () => {
  const plan = planPartsShoot({ kit: KIT, base: { VMT_SPOILER: 9 } });
  assert.equal(plan.slots[0].baseIndex, null);
  assert.deepEqual(plan.slots[0].shots[0].selection, {});
});

test("planBuildsShoot crosses builds, paints and angles and plans stock befores", () => {
  const plan = planBuildsShoot({
    kit: KIT,
    builds: [{ name: "Track", mods: { VMT_SPOILER: 3, VMT_GONE: 2 } }, { name: "Track", mods: {} }],
    angles: ["rear34", "front34", "nope"],
    paints: [27, 9999],
    stockBefore: true,
  });
  assert.deepEqual(plan.angles.map((angle) => angle.id), ["front34", "rear34"]);
  assert.deepEqual(plan.paints, [null, 27]);
  assert.equal(plan.stock.length, 4);
  assert.equal(plan.builds[0].stem, "track");
  assert.equal(plan.builds[1].stem, "track-2");
  assert.deepEqual(plan.builds[0].selection, { VMT_SPOILER: 3 });
  assert.equal(plan.builds[0].shots[0].file, "builds/track/front34.png");
  assert.match(plan.builds[0].shots[2].file, /^builds\/track\/front34-paint-27-/);
  assert.equal(plan.shotCount, 12);
});

test("buildSelectionForKit drops slots and indices the kit lacks", () => {
  assert.deepEqual(buildSelectionForKit(KIT, { VMT_SPOILER: 1, VMT_BUMPER_F: 4, VMT_ROOF: 0 }), { VMT_SPOILER: 1 });
});

test("normalizeKitShootSettings keeps known values and repairs the rest", () => {
  const settings = normalizeKitShootSettings({
    mode: "builds",
    camera: "bogus",
    slots: ["vmt_spoiler", "VMT_SPOILER", ""],
    format: "square",
    angles: ["top", "front34", "x"],
    paints: [0, 0, 27, -1, 1.5],
    beforeAfterStyle: "wipe",
  });
  assert.equal(settings.mode, "builds");
  assert.equal(settings.camera, "auto");
  assert.deepEqual(settings.slots, ["VMT_SPOILER"]);
  assert.equal(settings.format, "square");
  assert.deepEqual(settings.angles, ["front34", "top"]);
  assert.deepEqual(settings.paints, [0, 27]);
  assert.equal(settings.beforeAfterStyle, "wipe");
  assert.equal(normalizeKitShootSettings(null).slots, null);
  assert.deepEqual(normalizeKitShootSettings(null).builds, [CURRENT_BUILD]);
});

test("parsePaintList accepts GTA colour indices and reports the rest", () => {
  assert.deepEqual(parsePaintList("0, 27 27;abc 99999"), { indices: [0, 27], invalid: ["abc", "99999"] });
});

const VEHICLE = { min: [-1, 0, -2.4], max: [1, 1.4, 2.4] };

function close(actual, expected) {
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-6, `${actual} != ${expected}`));
}

test("planFocusShot looks from the side of the vehicle the parts sit on", () => {
  const spoiler = planFocusShot({ slotType: "VMT_SPOILER", focus: { min: [-0.8, 1.1, 1.9], max: [0.8, 1.4, 2.4] }, vehicle: VEHICLE });
  assert.ok(spoiler.direction[2] > 0, "rear parts are shot from behind");
  assert.ok(spoiler.direction[1] > 0.4, "high parts are shot from above");
  const bumper = planFocusShot({ slotType: "VMT_BUMPER_F", focus: { min: [-1, 0.1, -2.4], max: [1, 0.5, -2] }, vehicle: VEHICLE });
  assert.ok(bumper.direction[2] < 0, "front parts are shot from the front");
  const leftWing = planFocusShot({ slotType: "VMT_WING_L", focus: { min: [-1, 0.4, -1.8], max: [-0.6, 0.8, -1] }, vehicle: VEHICLE });
  assert.ok(leftWing.direction[0] < 0, "parts on -x are shot from -x");
  assert.equal(Math.hypot(...bumper.direction).toFixed(6), "1.000000");
});

test("planFocusShot keeps small parts in context and puts interior cameras in the cabin", () => {
  const knob = { min: [0, 0.6, -0.2], max: [0.05, 0.65, -0.15] };
  const exterior = planFocusShot({ slotType: "VMT_PLTVANITY", focus: knob, vehicle: VEHICLE });
  assert.ok(exterior.box.max[0] - exterior.box.min[0] >= 4.8 * 0.38 - 1e-9);
  const interior = planFocusShot({ slotType: "VMT_KNOB", focus: knob, vehicle: VEHICLE });
  assert.equal(interior.interior, true);
  assert.equal(interior.fov, 70);
  assert.ok(interior.maxDistance <= 1.2);
  close(interior.box.min.map((v, i) => (v + interior.box.max[i]) / 2), [0.025, 0.625, -0.175]);
  const engine = planFocusShot({ slotType: "VMT_ENGINEBAY1", focus: null, vehicle: VEHICLE });
  assert.ok(engine.direction[1] > 0.7, "engine bays are shot from above");
  assert.deepEqual(revealBonesForSlot("vmt_enginebay2"), ["bonnet"]);
  assert.deepEqual(revealBonesForSlot("VMT_SPOILER"), []);
});

function solid(width, height, rgb) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) pixels.set([...rgb, 255], i * 4);
  return pixels;
}

test("diffImages finds the box around a change and ignores noise", () => {
  const a = solid(20, 10, [100, 100, 100]);
  const b = solid(20, 10, [100, 100, 100]);
  for (let y = 2; y <= 4; y += 1) for (let x = 5; x <= 9; x += 1) b.set([200, 40, 40], (y * 20 + x) * 4);
  const result = diffImages(a, b, 20, 10);
  assert.equal(result.changed, 15);
  assert.deepEqual(result.box, { x: 5, y: 2, width: 5, height: 3 });
  const noisy = solid(20, 10, [110, 110, 110]);
  assert.equal(diffImages(a, noisy, 20, 10).box, null);
  assert.throws(() => diffImages(a, solid(10, 10, [0, 0, 0]), 20, 10));
});

test("changeCrop keeps the frame aspect, pads the change, and stays inside", () => {
  const crop = changeCrop({ box: { x: 1800, y: 900, width: 100, height: 100 }, width: 1920, height: 1080 });
  assert.ok(Math.abs(crop.width / crop.height - 1920 / 1080) < 0.01);
  assert.ok(crop.width >= 1920 * 0.4 - 1);
  assert.ok(crop.x + crop.width <= 1920 && crop.y + crop.height <= 1080);
  assert.ok(crop.x <= 1800 && crop.y <= 900);
  assert.deepEqual(changeCrop({ box: null, width: 100, height: 50 }), { x: 0, y: 0, width: 100, height: 50 });
  assert.equal(wipeSplit({ x: 0, width: 10 }, 1000), 250);
  assert.equal(wipeSplit({ x: 500, width: 100 }, 1000), 550);
  assert.equal(wipeSplit(null, 1000), 500);
});

test("findDuplicateShots maps later identical frames to the first", () => {
  const a = solid(8, 8, [10, 10, 10]);
  const b = solid(8, 8, [200, 10, 10]);
  const duplicates = findDuplicateShots([
    { id: "one", pixels: a },
    { id: "two", pixels: b },
    { id: "three", pixels: solid(8, 8, [10, 10, 10]) },
  ], 8, 8);
  assert.deepEqual([...duplicates], [["three", "one"]]);
});

test("collectShotIssues reports what the run observed", () => {
  const plan = planPartsShoot({ kit: { ...KIT, linked: false } });
  const [spoiler, bumper] = plan.slots;
  Object.assign(spoiler.shots[1], { changeFraction: 0.0001 });
  Object.assign(spoiler.shots[2], { duplicateOf: "Wings: Ducktail", changeFraction: 0.2 });
  Object.assign(spoiler.shots[3], { missing: ["car_carbon_wing"], mod: { ...spoiler.shots[3].mod, named: false } });
  Object.assign(bumper.shots[1], { boneDataAvailable: true, hiddenMeshCount: 0, textures: { failed: 1, missing: 2 } });
  const codes = collectShotIssues({ kit: { ...KIT, linked: false }, slots: plan.slots }).map((entry) => entry.code);
  assert.deepEqual(codes, [
    "KIT_NOT_LINKED",
    "NO_VISIBLE_CHANGE",
    "DUPLICATE_PART",
    "MODEL_MISSING",
    "UNNAMED_PART",
    "TEXTURES_FAILED",
    "TEXTURES_MISSING",
    "STOCK_NOT_HIDDEN",
  ]);
  const quiet = collectShotIssues({ kit: KIT, slots: plan.slots, namesAvailable: false }).map((entry) => entry.code);
  assert.ok(!quiet.includes("UNNAMED_PART"));
});

test("the manifest keys parts by modType and modIndex and the report escapes names", () => {
  const plan = planPartsShoot({ kit: KIT });
  plan.slots[0].shots.forEach((shot) => { shot.saved = true; });
  plan.slots[0].shots[1].beforeAfter = "00-spoiler/before-after/00-ducktail.png";
  plan.slots[0].sheet = "sheets/00-spoiler.png";
  plan.slots[0].displayName = "<Wings>";
  const manifest = buildKitShootManifest({
    createdAt: "2026-10-07T12:00:00.000Z",
    appVersion: "5.0.0",
    modelName: "mycar",
    kit: KIT,
    settings: normalizeKitShootSettings({}),
    size: { width: 1920, height: 1080 },
    complete: true,
    base: { VMT_SPOILER: 1 },
    parts: plan.slots,
    issues: [],
  });
  assert.equal(manifest.schema, "cortex.kitShoot");
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.base, [{ slotType: "VMT_SPOILER", modType: 0, modIndex: 1 }]);
  assert.equal(manifest.slots[0].parts[0].modIndex, -1);
  assert.equal(manifest.slots[0].parts[3].file, "00-spoiler/03-carbon-wing.png");
  assert.equal(manifest.slots[1].parts[0].file, null, "unsaved shots have no file");
  const html = renderKitShootReport(manifest);
  assert.match(html, /&lt;Wings&gt;/);
  assert.doesNotMatch(html, /<Wings>/);
  assert.match(html, /src="00-spoiler\/03-carbon-wing.png"/);
  assert.match(html, /No problems found/);
});

test("saved builds normalise, upsert by name, and remove", () => {
  let store = normalizeSavedBuilds({ vehicles: { MyCar: [{ name: " Track ", mods: { vmt_spoiler: 1, bad: -1 } }, { name: "" }, { name: CURRENT_BUILD }] } });
  assert.deepEqual(store.vehicles.mycar, [{ name: "Track", kitName: "", mods: { VMT_SPOILER: 1 } }]);
  store = upsertSavedBuild(store, "mycar", { name: "Track", kitName: "kit", mods: { VMT_SPOILER: 3 } });
  store = upsertSavedBuild(store, "mycar", { name: "Street", kitName: "kit", mods: {} });
  assert.deepEqual(store.vehicles.mycar.map((build) => [build.name, build.mods.VMT_SPOILER]), [["Track", 3], ["Street", undefined]]);
  store = removeSavedBuild(store, "mycar", "Track");
  store = removeSavedBuild(store, "mycar", "Street");
  assert.deepEqual(store.vehicles, {});
  assert.equal(BUILD_ANGLES[0].id, "view");
});

test("probeCandidates covers the vehicle and adds a cabin camera for interior slots", () => {
  const exterior = probeCandidates("VMT_SPOILER");
  assert.equal(exterior.length, 17);
  assert.ok(exterior.every((candidate) => Math.abs(Math.hypot(...candidate.direction) - 1) < 1e-9));
  const front = exterior.find((candidate) => candidate.id === "front-low");
  assert.ok(front.direction[2] < -0.9, "front looks from -z");
  const right = exterior.find((candidate) => candidate.id === "right-low");
  assert.ok(right.direction[0] > 0.9, "right looks from +x");
  const diagonal = exterior.find((candidate) => candidate.id === "front-right-low");
  assert.ok(diagonal.prior > front.prior, "3/4 views win ties");
  const interior = probeCandidates("VMT_SEATS");
  assert.equal(interior.at(-1).kind, "cabin");
});

test("scoreProbe prefers seeing more parts, then bigger changes", () => {
  const twoSmall = scoreProbe([{ fraction: 0.001 }, { fraction: 0.001 }, { fraction: 0 }]);
  const oneBig = scoreProbe([{ fraction: 0.2 }, { fraction: 0 }, { fraction: 0 }]);
  assert.ok(twoSmall > oneBig);
  assert.ok(scoreProbe([{ fraction: 0.01 }]) > scoreProbe([{ fraction: 0.001 }]));
  assert.equal(scoreProbe([{ fraction: 0.0001 }], 0.2), 0);
});

test("pickProbe chooses the candidate that shows the most and returns -1 when nothing shows", () => {
  const candidates = [{ prior: 0.18 }, { prior: 0 }, { prior: 0.04 }];
  const results = [
    [{ fraction: 0.002 }, { fraction: 0 }],
    [{ fraction: 0.002 }, { fraction: 0.003 }],
    [{ fraction: 0 }, { fraction: 0 }],
  ];
  assert.equal(pickProbe(candidates, results), 1);
  assert.equal(pickProbe(candidates, [[{ fraction: 0 }], [], [{ fraction: 0.0001 }]]), -1);
});

test("partsCrop frames the union of the changes with padding, in frame fractions", () => {
  assert.deepEqual(unionBoxes([{ x: 10, y: 10, width: 10, height: 10 }, null, { x: 40, y: 5, width: 5, height: 5 }]), { x: 10, y: 5, width: 35, height: 15 });
  const crop = partsCrop({ boxes: [{ x: 120, y: 60, width: 10, height: 6 }, { x: 150, y: 70, width: 8, height: 6 }], width: 256, height: 144 });
  assert.ok(Math.abs((crop.width * 256) / (crop.height * 144) - 256 / 144) < 0.02, "keeps the frame aspect");
  assert.ok(crop.width >= 0.26 - 1e-9 && crop.width < 1);
  assert.ok(crop.x <= 120 / 256 && crop.x + crop.width >= 158 / 256);
  assert.ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= 1 + 1e-9 && crop.y + crop.height <= 1 + 1e-9);
  assert.equal(partsCrop({ boxes: [], width: 10, height: 10 }), null);
  assert.equal(thumbPath("00-spoiler/03-wing.png"), "thumbs/00-spoiler/03-wing.jpg");
});

test("reviewGroups pairs parts with their slot base and builds with stock at the same angle", () => {
  const plan = planPartsShoot({ kit: KIT });
  plan.slots.forEach((slot) => slot.shots.forEach((shot) => { shot.saved = true; shot.thumb = thumbPath(shot.file); }));
  const builds = planBuildsShoot({ kit: KIT, builds: [{ name: "Track", mods: { VMT_SPOILER: 1 } }], angles: ["front34"], paints: [27], stockBefore: true });
  [...builds.stock, ...builds.builds[0].shots].forEach((shot) => { shot.saved = true; });
  const manifest = buildKitShootManifest({
    createdAt: "x",
    modelName: "mycar",
    kit: KIT,
    settings: normalizeKitShootSettings({}),
    size: { width: 1920, height: 1080 },
    complete: true,
    parts: plan.slots,
    builds: [{ name: "Stock", selection: {}, shots: builds.stock }, ...builds.builds],
    issues: [
      { code: "DUPLICATE_PART", severity: "warning", message: "dup", slotType: "VMT_SPOILER", modIndex: 3 },
      { code: "KIT_NOT_LINKED", severity: "warning", message: "kit" },
    ],
  });
  const review = reviewGroups(manifest);
  const spoiler = review.groups[0];
  assert.equal(spoiler.title, "Wings");
  assert.equal(spoiler.items[0].compareTo, null, "the base compares with nothing");
  assert.equal(spoiler.items[2].compareTo, spoiler.items[0]);
  assert.equal(spoiler.items[3].issues[0].code, "DUPLICATE_PART");
  assert.equal(spoiler.issueCount, 1);
  assert.equal(spoiler.items[1].thumb, "thumbs/00-spoiler/00-ducktail.jpg");
  assert.deepEqual(review.general.map((entry) => entry.code), ["KIT_NOT_LINKED"]);
  const track = review.groups.find((group) => group.id === "build:Track");
  const stock = review.groups.find((group) => group.id === "build:Stock");
  assert.equal(track.items.length, 2);
  assert.equal(track.items[1].title, "Front 3/4 · Metallic Red");
  assert.equal(track.items[1].compareTo, stock.items[1], "paint variants compare with stock in the same paint");
  assert.equal(review.shotCount, 6 + 4);
});
