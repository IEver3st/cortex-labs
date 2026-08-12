import assert from "node:assert/strict";
import test from "node:test";
import {
  getLightCompassLabel,
  lightDirectionFromPoint,
  normalizeLightAzimuth,
  projectLightDirection,
} from "./light-direction.js";

test("projects the horizon and zenith into the light dome", () => {
  assert.deepEqual(projectLightDirection(0, 0), { x: 50, y: 10 });
  assert.deepEqual(projectLightDirection(90, 0), { x: 90, y: 50 });
  assert.deepEqual(projectLightDirection(225, 90), { x: 50, y: 50 });
});

test("maps pointer positions back to bounded light directions", () => {
  assert.deepEqual(lightDirectionFromPoint(50, 10), { azimuth: 0, elevation: 0 });
  assert.deepEqual(lightDirectionFromPoint(90, 50), { azimuth: 90, elevation: 0 });
  assert.deepEqual(lightDirectionFromPoint(50, 50), { azimuth: 0, elevation: 90 });
  assert.deepEqual(lightDirectionFromPoint(200, 50), { azimuth: 90, elevation: 0 });
});

test("normalizes azimuth values and exposes a stable compass label", () => {
  assert.equal(normalizeLightAzimuth(-45), 315);
  assert.equal(normalizeLightAzimuth(405), 45);
  assert.equal(getLightCompassLabel(226), "SW");
});
