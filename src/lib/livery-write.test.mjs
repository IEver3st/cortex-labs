import test from "node:test";
import assert from "node:assert/strict";
import { encodeStageBody, liveryBuildJobs, liveryCommitRequest, writeLiveries } from "./livery-write.js";

const items = [{ id: "a", path: "C:\\l\\a.png", number: 2 }, { id: "b", path: "C:\\l\\b.png", number: 3 }];
const plan = {
  blocked: null,
  files: [
    {
      path: "C:\\r\\car+hi.ytd",
      textures: [
        { itemId: "a", number: 2, name: "car_sign_2", mode: "replace", like: null, width: 4096, height: 4096, levels: 1 },
        { itemId: "b", number: 3, name: "car_sign_3", mode: "insert", like: "car_sign_1", width: 4096, height: 4096, levels: 1 },
      ],
    },
    {
      path: "C:\\r\\car.ytd",
      textures: [
        { itemId: "a", number: 2, name: "car_sign_2", mode: "replace", like: null, width: 1024, height: 1024, levels: 11 },
        { itemId: "b", number: 3, name: "car_sign_3", mode: "insert", like: "car_sign_1", width: 4096, height: 4096, levels: 1 },
      ],
    },
  ],
};

function fakeHost({ failStage = false } = {}) {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === "livery_write_begin") return { token: "t1" };
    if (command === "livery_write_stage" && failStage) throw new Error("disk full");
    if (command === "livery_write_commit") return { files: [] };
    return null;
  };
  return { calls, invoke };
}

const build = async (item, targets) => targets.map((target) => ({ bytes: new Uint8Array([target.width & 255, item.number]) }));

test("each image is built once per distinct size", () => {
  const jobs = liveryBuildJobs(plan, items);
  assert.deepEqual(jobs.map((job) => [job.item.id, job.targets.map((target) => target.id)]), [
    ["a", ["a-4096x4096-1", "a-1024x1024-11"]],
    ["b", ["b-4096x4096-1"]],
  ]);
  const request = liveryCommitRequest(plan, "t1", "20261016-120000");
  assert.deepEqual(request.ytds[1].textures[1], { name: "car_sign_3", mode: "insert", id: "b-4096x4096-1", like: "car_sign_1" });
  assert.equal("like" in request.ytds[0].textures[0], false);
});

test("a stage body is the header length, the JSON header, then the DDS", () => {
  const body = encodeStageBody("t1", "a-1", new Uint8Array([68, 68, 83, 32]));
  const length = new DataView(body.buffer).getUint32(0, true);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + length))), { token: "t1", id: "a-1" });
  assert.deepEqual([...body.subarray(4 + length)], [68, 68, 83, 32]);
});

test("a write begins, stages every texture, then commits with a backup stamp", async () => {
  const host = fakeHost();
  const progress = [];
  await writeLiveries({ invoke: host.invoke, plan, items, modelPath: "C:\\r\\car_hi.yft", build, onProgress: (p) => progress.push(p.done), date: new Date(2026, 9, 16, 12, 0, 5) });
  assert.deepEqual(host.calls.map(([command]) => command), [
    "livery_write_begin", "livery_write_stage", "livery_write_stage", "livery_write_stage", "livery_write_commit",
  ]);
  assert.deepEqual(host.calls[0][1], { modelPath: "C:\\r\\car_hi.yft" });
  const commit = host.calls.at(-1)[1].request;
  assert.equal(commit.token, "t1");
  assert.equal(commit.stamp, "20261016-120005");
  assert.equal(progress.at(-1), 3);
});

test("a failure or cancel before the commit drops the session and says nothing changed", async () => {
  const host = fakeHost({ failStage: true });
  await assert.rejects(
    writeLiveries({ invoke: host.invoke, plan, items, modelPath: "m.yft", build }),
    /disk full\. Nothing was changed\./,
  );
  assert.deepEqual(host.calls.at(-1), ["livery_write_cancel", { token: "t1" }]);

  const cancelled = fakeHost();
  await assert.rejects(
    writeLiveries({ invoke: cancelled.invoke, plan, items, modelPath: "m.yft", build, isCancelled: () => true }),
    /cancelled\. Nothing was changed\./,
  );
  assert.ok(!cancelled.calls.some(([command]) => command === "livery_write_commit"));
});
