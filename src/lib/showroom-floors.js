// Showroom floor finishes, in picker order. viewer-stage.js draws them; this
// module has no three.js so settings, workspace normalisers and node:test can
// share the one list. Saved scenes store the id, so ids never change meaning.
export const SHOWROOM_FLOORS = Object.freeze([
  "concrete",
  "polished",
  "tiles",
  "marble",
  "checker",
  "epoxy",
  "asphalt",
  "wood",
  "tread",
]);

export const SHOWROOM_FLOOR_LABELS = Object.freeze({
  concrete: "Concrete",
  polished: "Polished",
  tiles: "Tiles",
  marble: "Marble",
  checker: "Checker",
  epoxy: "Epoxy",
  asphalt: "Asphalt",
  wood: "Wood",
  tread: "Tread plate",
});

export function normalizeShowroomFloor(value, fallback = "concrete") {
  return SHOWROOM_FLOORS.includes(value) ? value : fallback;
}
