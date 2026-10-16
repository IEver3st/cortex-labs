import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LINEUP_SLOTS,
  createSlot,
  duplicateSlot,
  isVehicleModelPath,
  lineUpOffsets,
  lineupWatchPaths,
  migrateDualState,
  nextSlotId,
  normalizeLineup,
  normalizeYaw,
  normalizeLineupShowroom,
  resolveWindowTarget,
  slotLetter,
} from "./multi-lineup.js";

test("normalizeLineup always returns at least one slot", () => {
  const lineup = normalizeLineup(null, { bodyColor: "#112233" });
  assert.equal(lineup.slots.length, 1);
  assert.equal(lineup.selectedId, lineup.slots[0].id);
  assert.deepEqual(lineup.slots[0].paint.primary, { index: null, color: "#112233", finish: 0 });
  assert.equal(lineup.slots[0].paint.wheels.index, 156);
  assert.equal(lineup.slots[0].windowTarget, "auto");
});

test("normalizeLineup drops malformed and duplicate slots and caps the list", () => {
  const raw = [
    { id: "slot-1", modelPath: "C:\\cars\\a_hi.yft" },
    { id: "slot-1", modelPath: "C:\\cars\\dupe_hi.yft" },
    { id: "bad id", modelPath: "C:\\cars\\b_hi.yft" },
    null,
    ...Array.from({ length: 10 }, (_, i) => ({ id: `slot-${i + 2}` })),
  ];
  const lineup = normalizeLineup({ slots: raw, selectedId: "slot-99" });
  assert.equal(lineup.slots.length, MAX_LINEUP_SLOTS);
  assert.equal(lineup.slots[0].modelPath, "C:\\cars\\a_hi.yft");
  assert.deepEqual(new Set(lineup.slots.map((slot) => slot.id)).size, MAX_LINEUP_SLOTS);
  assert.equal(lineup.selectedId, "slot-1");
});

test("normalizeLineup keeps vehicles and rejects clothing models", () => {
  const lineup = normalizeLineup({
    slots: [
      { id: "slot-1", modelPath: "C:\\eup\\jbib_000_u.ydd", liveryPath: "C:\\eup\\design.psd" },
      { id: "slot-2", modelPath: "C:\\cars\\police.clmesh", windowTarget: "material:vehicle_vehglass" },
    ],
  });
  assert.equal(lineup.slots[0].modelPath, "");
  assert.equal(lineup.slots[0].liveryPath, "C:\\eup\\design.psd");
  assert.equal(lineup.slots[1].modelPath, "C:\\cars\\police.clmesh");
  assert.equal(lineup.slots[1].windowTarget, "material:vehicle_vehglass");
});

test("normalizeLineup validates colours, positions and window targets", () => {
  const [slot] = normalizeLineup({
    slots: [{
      id: "slot-3",
      paint: { primary: "#ABCDEF", secondary: "red", accent: 5 },
      position: [1, "2", 3],
      windowTarget: "javascript:alert(1)",
      visible: false,
    }],
  }, { bodyColor: "#000000" }).slots;
  // Hex-per-slot paint from before the game palette migrates; accent is dropped.
  assert.equal(slot.paint.primary.color, "#abcdef");
  assert.equal(slot.paint.secondary.color, "#000000");
  assert.equal(slot.paint.accent, undefined);
  assert.equal(slot.position, null);
  assert.equal(slot.windowTarget, "auto");
  assert.equal(slot.visible, false);
});

test("migrateDualState carries A/B vehicle slots over", () => {
  const { lineup, droppedClothing } = migrateDualState({
    dualTextureMode: "livery",
    dualModelAPath: "C:\\cars\\a_hi.yft",
    dualTextureAPath: "C:\\liveries\\a.png",
    dualBodyColorA: "#ff0000",
    dualModelAPos: [0, 0, 0],
    dualModelBPath: "C:\\cars\\b_hi.yft",
    dualWindowTextureBPath: "C:\\liveries\\b_glass.png",
    dualWindowTextureBTarget: "all",
    dualModelBPos: [0, 0, 3],
    dualSelectedSlot: "B",
  });
  assert.equal(droppedClothing, false);
  assert.equal(lineup.slots.length, 2);
  assert.equal(lineup.slots[0].liveryPath, "C:\\liveries\\a.png");
  assert.equal(lineup.slots[0].paint.primary.color, "#ff0000");
  assert.deepEqual(lineup.slots[1].position, [0, 0, 3]);
  assert.equal(lineup.slots[1].windowTarget, "all");
  assert.equal(lineup.selectedId, lineup.slots[1].id);
});

test("migrateDualState drops clothing comparisons and reports it", () => {
  const { lineup, droppedClothing } = migrateDualState({
    dualTextureMode: "eup",
    dualModelAPath: "C:\\eup\\uppr_000_u.ydd",
    dualTextureAPath: "C:\\eup\\uniform.psd",
  });
  assert.equal(droppedClothing, true);
  assert.equal(lineup.slots.length, 1);
  assert.equal(lineup.slots[0].modelPath, "");
  assert.equal(lineup.slots[0].liveryPath, "");
});

test("migrateDualState prefers a saved lineup", () => {
  const { lineup } = migrateDualState({
    lineup: { slots: [{ id: "slot-4", modelPath: "C:\\cars\\x_hi.yft" }], selectedId: "slot-4" },
    dualModelAPath: "C:\\cars\\old_hi.yft",
  });
  assert.equal(lineup.slots.length, 1);
  assert.equal(lineup.slots[0].id, "slot-4");
});

test("slot ids stay unique after removals", () => {
  const slots = [{ id: "slot-1" }, { id: "slot-4" }];
  assert.equal(nextSlotId(slots), "slot-5");
  assert.equal(createSlot(slots).id, "slot-5");
  assert.equal(nextSlotId([]), "slot-1");
});

test("duplicateSlot copies settings without the position", () => {
  const slots = [createSlot([], { modelPath: "C:\\cars\\a_hi.yft", liveryPath: "C:\\l.png", position: [0, 0, 2], yaw: 90 })];
  const copy = duplicateSlot(slots, "slot-1");
  assert.equal(copy.yaw, 90);
  assert.equal(copy.id, "slot-2");
  assert.equal(copy.modelPath, "C:\\cars\\a_hi.yft");
  assert.equal(copy.liveryPath, "C:\\l.png");
  assert.equal(copy.position, null);
  copy.paint.primary = "#000000";
  assert.notEqual(slots[0].paint.primary, "#000000");
  const full = Array.from({ length: MAX_LINEUP_SLOTS }, (_, i) => ({ id: `slot-${i + 1}` }));
  assert.equal(duplicateSlot(full, "slot-1"), null);
  assert.equal(duplicateSlot(slots, "slot-9"), null);
});

test("lineUpOffsets places vehicles side by side, centred", () => {
  assert.deepEqual(lineUpOffsets([]), []);
  assert.deepEqual(lineUpOffsets([2]), [0]);
  const offsets = lineUpOffsets([2, 2, 2], 1);
  assert.deepEqual(offsets, [-3, 0, 3]);
  const mixed = lineUpOffsets([2, 4], 0.5);
  // Edge to edge distance equals the gap.
  assert.equal(mixed[1] - 2 - (mixed[0] + 1), 0.5);
  assert.equal(mixed[0] + mixed[1], 0);
  // An unmeasured vehicle counts as zero width.
  assert.deepEqual(lineUpOffsets([Number.NaN, 2], 0), [-0.5, 0.5]);
});

test("lineupWatchPaths lists every livery and window file once", () => {
  const paths = lineupWatchPaths([
    { liveryPath: "C:\\l\\a.png", windowPath: "" },
    { liveryPath: "c:/l/A.png", windowPath: "C:\\l\\glass.psd" },
    { liveryPath: "", windowPath: "" },
  ]);
  assert.deepEqual(paths, ["C:\\l\\a.png", "C:\\l\\glass.psd"]);
});

test("normalizeLineupShowroom defaults to a light per vehicle on concrete", () => {
  assert.deepEqual(normalizeLineupShowroom(null), { lights: "each", floor: "concrete" });
  assert.deepEqual(normalizeLineupShowroom({ lights: "one", floor: "tiles" }), { lights: "one", floor: "tiles" });
  assert.deepEqual(normalizeLineupShowroom({ lights: "all", floor: "lava" }), { lights: "each", floor: "concrete" });
  assert.equal(normalizeLineupShowroom({ floor: "tread" }).floor, "tread");
});

test("normalizeLineupShowroom starts new lineups on the Settings vehicle floor and keeps saved floors", () => {
  // A new lineup takes the Vehicles floor from Settings > Studio.
  assert.deepEqual(normalizeLineupShowroom(null, "marble"), { lights: "each", floor: "marble" });
  // A saved lineup keeps its own floor whatever the setting says.
  assert.equal(normalizeLineupShowroom({ lights: "one", floor: "concrete" }, "marble").floor, "concrete");
  assert.equal(normalizeLineupShowroom({ floor: "wood" }, "marble").floor, "wood");
  // Saved before the floor existed, or with a floor this version does not know: the setting fills it.
  assert.equal(normalizeLineupShowroom({ lights: "one" }, "epoxy").floor, "epoxy");
  assert.equal(normalizeLineupShowroom({ floor: "lava" }, "epoxy").floor, "epoxy");
  // A malformed default falls back to concrete instead of reaching the viewer.
  assert.equal(normalizeLineupShowroom(null, "lava").floor, "concrete");
  assert.equal(normalizeLineupShowroom(null, undefined).floor, "concrete");
});

test("helpers", () => {
  assert.equal(slotLetter(0), "A");
  assert.equal(slotLetter(5), "F");
  assert.equal(isVehicleModelPath("x_hi.YFT"), true);
  assert.equal(isVehicleModelPath("x.ydd"), false);
  assert.equal(resolveWindowTarget("auto", "material:glass"), "material:glass");
  assert.equal(resolveWindowTarget("auto", ""), "none");
  assert.equal(resolveWindowTarget("all", "material:glass"), "all");
});

test("slot facing is kept in degrees [0, 360) and defaults to front", () => {
  assert.equal(createSlot([]).yaw, 0);
  assert.equal(normalizeYaw(-90), 270);
  assert.equal(normalizeYaw(720.5), 0.5);
  assert.equal(normalizeYaw(359.999), 0);
  assert.equal(normalizeYaw("45"), 0);
  assert.equal(normalizeYaw(Number.NaN), 0);
  const lineup = normalizeLineup({
    slots: [
      { id: "slot-1", modelPath: "C:\cars\a_hi.yft", yaw: -45 },
      { id: "slot-2", modelPath: "C:\cars\b_hi.yft" },
    ],
  });
  assert.deepEqual(lineup.slots.map((slot) => slot.yaw), [315, 0]);
});
