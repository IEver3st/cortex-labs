import test from "node:test";
import assert from "node:assert/strict";
import {
  BRIDGE_CANCELLED,
  createBridgeParses,
  createBridgeRequestToken,
  getBridgeParseIdentity,
  getLoadedModelCacheKey,
  getModelCacheKey,
  isBridgeCancelled,
  readBridgeWarnings,
} from "./model-load.js";

test("a model saved again gets a new cache key", () => {
  const before = getModelCacheKey("C:/mods/car.yft", { mtime: new Date(1_700_000_000_000), size: 1024 });
  const resaved = getModelCacheKey("C:/mods/car.yft", { mtime: new Date(1_700_000_005_000), size: 1024 });
  const resized = getModelCacheKey("C:/mods/car.yft", { mtime: new Date(1_700_000_000_000), size: 2048 });
  assert.ok(before);
  assert.notEqual(before, resaved);
  assert.notEqual(before, resized);
  assert.equal(before, getModelCacheKey("C:/mods/car.yft", { mtime: new Date(1_700_000_000_000), size: 1024 }));
});

test("numeric mtimes and variants are part of the key", () => {
  const info = { mtime: 1_700_000_000_000, size: 10 };
  assert.equal(getModelCacheKey("car.yft", info), "car.yft::1700000000000::10");
  assert.equal(getModelCacheKey("car.yft", info, "bridge"), "car.yft::1700000000000::10::bridge");
  assert.notEqual(getModelCacheKey("car.yft", info, "bridge"), getModelCacheKey("car.yft", info, "direct"));
});

test("an unknown file identity disables caching", () => {
  assert.equal(getModelCacheKey("car.yft", null), null);
  assert.equal(getModelCacheKey("car.yft", { mtime: null, size: 10 }), null);
  assert.equal(getModelCacheKey("car.yft", { mtime: new Date(0), size: null }), null);
  assert.equal(getModelCacheKey("car.yft", { mtime: new Date(Number.NaN), size: 10 }), null);
  assert.equal(getModelCacheKey("", { mtime: new Date(0), size: 10 }), null);
});

test("a model is cached per bridge parse, not only per model file", () => {
  // Same .yft, so the same bridge cache key, but the native side parsed again
  // after a texture dictionary changed and rewrote the manifest (D1).
  const result = { cacheKey: "d7ac526398e6f49a", cached: false }; // gitleaks:allow (fake bridge cache hash)
  const model = { mtime: 1_700_000_000_000, size: 1_237_176 };
  const first = getBridgeParseIdentity(result, { mtime: new Date(1_700_000_100_000), size: 64_000 });
  const reparsed = getBridgeParseIdentity({ ...result }, { mtime: new Date(1_700_000_200_000), size: 64_000 });
  const cacheHit = getBridgeParseIdentity({ ...result, cached: true }, { mtime: new Date(1_700_000_100_000), size: 64_000 });
  assert.equal(first, "d7ac526398e6f49a::1700000100000::64000");
  assert.notEqual(first, reparsed);
  assert.equal(first, cacheHit);
  assert.notEqual(
    getModelCacheKey("car.yft", model, `bridge:${first}`),
    getModelCacheKey("car.yft", model, `bridge:${reparsed}`),
  );
  assert.notEqual(getBridgeParseIdentity({ cacheKey: "other" }, { mtime: 1, size: 2 }), getBridgeParseIdentity({ cacheKey: "d7ac" }, { mtime: 1, size: 2 }));
});

test("a reopened model is looked up under the parse the bridge returned", () => {
  const model = { mtime: 1_700_000_000_000, size: 1_237_176 };
  const parse = { cacheKey: "f2723e598a3cf765", cached: true };
  const first = getLoadedModelCacheKey("C:/res/stream/police3_hi.yft", model, { bridgeResult: parse, manifestInfo: { mtime: 1_700_000_100_000, size: 64_000 } });
  const again = getLoadedModelCacheKey("C:/res/stream/police3_hi.yft", model, { bridgeResult: parse, manifestInfo: { mtime: 1_700_000_100_000, size: 64_000 } });
  // police3.ytd was edited: same .yft, re-parsed under the same bridge key.
  const edited = getLoadedModelCacheKey("C:/res/stream/police3_hi.yft", model, { bridgeResult: { ...parse, cached: false }, manifestInfo: { mtime: 1_700_000_200_000, size: 64_010 } });
  assert.equal(first, again);
  assert.notEqual(first, edited);
  assert.ok(first.startsWith("C:/res/stream/police3_hi.yft::1700000000000::1237176::bridge:"));
  // No bridge (browser, bridge failure, JS fallback): the JS parse of the file version.
  assert.equal(getLoadedModelCacheKey("car.yft", model), "car.yft::1700000000000::1237176::direct");
  assert.notEqual(getLoadedModelCacheKey("car.yft", model), first);
  // A bridge result whose manifest could not be stat'ed is never cached.
  assert.equal(getLoadedModelCacheKey("car.yft", model, { bridgeResult: parse, manifestInfo: null }), null);
  assert.equal(getLoadedModelCacheKey("car.yft", null, { bridgeResult: parse, manifestInfo: { mtime: 1, size: 2 } }), null);
});

test("an unknown bridge parse identity disables caching", () => {
  assert.equal(getBridgeParseIdentity(null, { mtime: 1, size: 2 }), null);
  assert.equal(getBridgeParseIdentity({ cacheKey: "" }, { mtime: 1, size: 2 }), null);
  assert.equal(getBridgeParseIdentity({ cacheKey: "abc" }, null), null);
  assert.equal(getBridgeParseIdentity({ cacheKey: "abc" }, { mtime: null, size: 2 }), null);
});

test("bridge warnings are read defensively", () => {
  assert.deepEqual(readBridgeWarnings(undefined), []);
  assert.deepEqual(readBridgeWarnings({ meshPath: "a.clmesh" }), []);
  assert.deepEqual(readBridgeWarnings({ warnings: [] }), []);
  assert.deepEqual(readBridgeWarnings({ warnings: "not a list" }), []);
  assert.deepEqual(
    readBridgeWarnings({ warnings: ["  LOD high missing, showing medium ", "", 7, null, "LOD high missing, showing medium"] }),
    ["LOD high missing, showing medium"],
  );
});

/* ── Shared bridge parses ── */

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A fake bridge: parses stay pending until the test finishes them; a cancel
    of a registered token rejects that parse the way the native side does. */
function fakeBridge({ cancelAnswers = [] } = {}) {
  const parses = [];
  const cancels = [];
  const timers = new Map();
  let nextTimer = 1;
  const invoke = async (command, args) => {
    if (command === "parse_yft") {
      return new Promise((resolve, reject) => {
        parses.push({ args, resolve, reject, settled: false });
      });
    }
    if (command === "cancel_bridge_request") {
      cancels.push(args.token);
      const answer = cancelAnswers.length ? cancelAnswers.shift() : "running";
      if (answer !== "none") {
        const parse = parses.find((entry) => entry.args.requestToken === args.token && !entry.settled);
        if (parse) {
          parse.settled = true;
          parse.reject(BRIDGE_CANCELLED);
        }
      }
      return answer;
    }
    throw new Error(`unexpected ${command}`);
  };
  const finish = (index, value = { meshPath: `mesh-${index}` }) => {
    parses[index].settled = true;
    parses[index].resolve(value);
  };
  const runTimers = async () => {
    for (const [id, fn] of [...timers]) {
      timers.delete(id);
      fn();
    }
    await flush();
  };
  const parsesFor = createBridgeParses({
    invoke,
    setTimer: (fn) => {
      const id = nextTimer++;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  return { parse: parsesFor, parses, cancels, finish, runTimers, timers };
}

test("bridge request tokens fit the native contract and are unique", () => {
  const tokens = new Set(Array.from({ length: 50 }, () => createBridgeRequestToken()));
  assert.equal(tokens.size, 50);
  for (const token of tokens) assert.match(token, /^[A-Za-z0-9_-]{1,64}$/);
});

test("isBridgeCancelled recognises the cancel rejection only", () => {
  assert.equal(isBridgeCancelled("Bridge request cancelled."), true);
  assert.equal(isBridgeCancelled(new Error("Bridge request cancelled.")), true);
  assert.equal(isBridgeCancelled("CodeWalker bridge is unavailable."), false);
  assert.equal(isBridgeCancelled(null), false);
});

test("a replaced load stops its parse when the next model's parse starts", async () => {
  const bridge = fakeBridge();
  const first = new AbortController();
  const replaced = bridge.parse("C:/mods/a.yft", { signal: first.signal });
  await flush();
  assert.equal(bridge.parses.length, 1);
  const token = bridge.parses[0].args.requestToken;
  assert.match(token, /^[A-Za-z0-9_-]{1,64}$/);

  first.abort();
  await assert.rejects(replaced, { name: "AbortError" });
  assert.deepEqual(bridge.cancels, [], "not cancelled before anything needs the bridge");

  const next = bridge.parse("C:/mods/b.yft", { signal: new AbortController().signal });
  await flush();
  assert.deepEqual(bridge.cancels, [token]);
  assert.equal(bridge.parses[1].args.path, "C:/mods/b.yft");
  assert.notEqual(bridge.parses[1].args.requestToken, token);
  bridge.finish(1);
  assert.deepEqual(await next, { meshPath: "mesh-1" });
});

test("an abandoned parse is cancelled after the grace period", async () => {
  const bridge = fakeBridge();
  const load = new AbortController();
  const pending = bridge.parse("C:/mods/a.yft", { signal: load.signal });
  await flush();
  load.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await bridge.runTimers();
  assert.deepEqual(bridge.cancels, [bridge.parses[0].args.requestToken]);
});

test("a remounted viewer loading the same model joins the parse instead of cancelling it", async () => {
  const bridge = fakeBridge();
  const unmounted = new AbortController();
  const before = bridge.parse("C:/mods/a.yft", { signal: unmounted.signal });
  await flush();
  unmounted.abort();
  await assert.rejects(before, { name: "AbortError" });

  const after = bridge.parse("C:/mods/a.yft", { signal: new AbortController().signal });
  await bridge.runTimers();
  assert.equal(bridge.parses.length, 1, "one parse for both loads");
  assert.deepEqual(bridge.cancels, []);
  bridge.finish(0);
  assert.deepEqual(await after, { meshPath: "mesh-0" });
});

test("a finished parse is never cancelled", async () => {
  const bridge = fakeBridge();
  const load = new AbortController();
  const done = bridge.parse("C:/mods/a.yft", { signal: load.signal });
  await flush();
  bridge.finish(0);
  await done;
  load.abort();
  bridge.parse("C:/mods/b.yft");
  await bridge.runTimers();
  assert.deepEqual(bridge.cancels, []);
});

test("a parse another load still waits for is not cancelled", async () => {
  const bridge = fakeBridge();
  const leaving = new AbortController();
  const left = bridge.parse("C:/mods/a.yft", { signal: leaving.signal });
  const staying = bridge.parse("C:/mods/a.yft");
  await flush();
  leaving.abort();
  await assert.rejects(left, { name: "AbortError" });
  bridge.parse("C:/mods/b.yft");
  await bridge.runTimers();
  assert.deepEqual(bridge.cancels, []);
  bridge.finish(0);
  assert.deepEqual(await staying, { meshPath: "mesh-0" });
});

test("a cancel sent before the parse registered its token is repeated", async () => {
  const bridge = fakeBridge({ cancelAnswers: ["none", "queued"] });
  const load = new AbortController();
  const pending = bridge.parse("C:/mods/a.yft", { signal: load.signal });
  await flush();
  load.abort();
  await assert.rejects(pending, { name: "AbortError" });
  bridge.parse("C:/mods/b.yft");
  await flush();
  assert.equal(bridge.cancels.length, 1);
  await bridge.runTimers(); // the retry delay
  await flush();
  assert.equal(bridge.cancels.length, 2);
  assert.equal(bridge.cancels[0], bridge.cancels[1]);
});

test("forced parses pass force and also serve a plain load of the same file", async () => {
  const bridge = fakeBridge();
  const forced = bridge.parse("C:/mods/a.yft", { force: true });
  const plain = bridge.parse("C:/mods/a.yft");
  await flush();
  assert.equal(bridge.parses.length, 1);
  assert.equal(bridge.parses[0].args.force, true);
  bridge.finish(0);
  assert.deepEqual(await forced, await plain);

  // A forced load does not join a plain parse: it wants a fresh one.
  bridge.parse("C:/mods/c.yft");
  bridge.parse("C:/mods/c.yft", { force: true });
  await flush();
  assert.equal(bridge.parses.length, 3);
});
