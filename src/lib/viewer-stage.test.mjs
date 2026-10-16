import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { STAGE_BAY_LIMIT, createViewerStage } from "./viewer-stage.js";

// The bay layout needs no GL context: the floor and studio environment are
// only built on entering the showroom, which these tests do not do.
function fakeRenderer() {
  return {
    shadowMap: { enabled: false, needsUpdate: false },
    getDrawingBufferSize: (target) => target.set(800, 600),
  };
}

function vehicle(x, z) {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(2, 1.5, 4.5)));
  group.position.set(x, 0.75, z);
  group.updateMatrixWorld(true);
  return group;
}

function lineupBounds(models) {
  const box = new THREE.Box3();
  for (const model of models) box.expandByObject(model);
  return box;
}

const baySpots = (scene) => {
  const spots = [];
  scene.traverse((child) => {
    if (/^stage-bay-spot-/.test(child.name)) spots.push(child);
  });
  return spots;
};
const stageSpot = (scene) => scene.getObjectByName("stage-spot");

test("a lineup gets one spot per vehicle, aimed at each vehicle", () => {
  const scene = new THREE.Scene();
  const stage = createViewerStage({ renderer: fakeRenderer(), scene });
  const cars = [vehicle(-3, 0), vehicle(0, 0), vehicle(3, 0)];
  stage.fit(lineupBounds(cars), cars, { bays: true });
  const spots = baySpots(scene).filter((spot) => spot.visible);
  assert.equal(spots.length, 3);
  assert.equal(stageSpot(scene).visible, false, "the single stage spot is off");
  spots.forEach((spot, index) => {
    assert.ok(Math.abs(spot.target.position.x - cars[index].position.x) < 1e-6, `bay ${index} aims at its vehicle`);
    assert.ok(spot.intensity > 0);
    assert.ok(spot.castShadow);
  });
});

test("moving a vehicle moves its bay", () => {
  const scene = new THREE.Scene();
  const stage = createViewerStage({ renderer: fakeRenderer(), scene });
  const cars = [vehicle(-3, 0), vehicle(3, 0)];
  const bounds = lineupBounds(cars);
  stage.fit(bounds, cars, { bays: true });
  cars[1].position.x = 6;
  cars[1].updateMatrixWorld(true);
  // Same framing bounds: the gizmo moves vehicles without a camera refit.
  stage.fit(bounds, cars, { bays: true });
  assert.ok(Math.abs(scene.getObjectByName("stage-bay-spot-1").target.position.x - 6) < 1e-6);
});

test("hidden vehicles, a single vehicle, or bays off fall back to the stage spot", () => {
  const scene = new THREE.Scene();
  const stage = createViewerStage({ renderer: fakeRenderer(), scene });
  const cars = [vehicle(-3, 0), vehicle(3, 0)];
  stage.fit(lineupBounds(cars), cars, { bays: true });
  assert.equal(baySpots(scene).filter((spot) => spot.visible).length, 2);

  stage.setShowroom({ bayLights: false });
  assert.equal(baySpots(scene).filter((spot) => spot.visible).length, 0);
  assert.equal(stageSpot(scene).visible, true);

  stage.setShowroom({ bayLights: true });
  cars[1].visible = false;
  stage.fit(lineupBounds(cars), cars, { bays: true });
  assert.equal(baySpots(scene).filter((spot) => spot.visible).length, 0, "one visible vehicle uses the stage spot");
  assert.equal(stageSpot(scene).visible, true);
});

test("bays are capped and other subjects ignore them", () => {
  const scene = new THREE.Scene();
  const stage = createViewerStage({ renderer: fakeRenderer(), scene });
  const cars = Array.from({ length: STAGE_BAY_LIMIT + 2 }, (_, i) => vehicle(i * 3, 0));
  stage.fit(lineupBounds(cars), cars, { bays: true });
  assert.equal(baySpots(scene).filter((spot) => spot.visible).length, STAGE_BAY_LIMIT);

  const pedScene = new THREE.Scene();
  const pedStage = createViewerStage({ renderer: fakeRenderer(), scene: pedScene, subject: "ped" });
  pedStage.fit(lineupBounds(cars.slice(0, 2)), cars.slice(0, 2), { bays: true });
  assert.equal(baySpots(pedScene).length, 0);
  assert.equal(stageSpot(pedScene).visible, true);
});

test("dispose releases the bay lights", () => {
  const scene = new THREE.Scene();
  const stage = createViewerStage({ renderer: fakeRenderer(), scene });
  const cars = [vehicle(-3, 0), vehicle(3, 0)];
  stage.fit(lineupBounds(cars), cars, { bays: true });
  stage.dispose();
  assert.equal(scene.getObjectByName("viewer-stage"), undefined);
});
