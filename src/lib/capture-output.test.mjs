import assert from "node:assert/strict";
import test from "node:test";
import { countExistingFiles, describePreviewRun, downloadBytes, isFsScopeError } from "./capture-output.js";

test("counts only the paths that exist", async () => {
  const present = new Set(["C:/out/car_front.png", "C:/out/car_top.png"]);
  const count = await countExistingFiles(
    ["C:/out/car_front.png", "C:/out/car_back.png", "C:/out/car_top.png"],
    async (path) => present.has(path),
  );
  assert.equal(count, 2);
});

test("a failed existence check counts as absent instead of failing the export", async () => {
  const count = await countExistingFiles(["a.png", "b.png", "c.png"], async (path) => {
    if (path === "b.png") throw new Error("forbidden path: b.png");
    return true;
  });
  assert.equal(count, 2);
});

test("existence checks stay within the concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  const paths = Array.from({ length: 20 }, (_, index) => `${index}.png`);
  const count = await countExistingFiles(paths, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return false;
  }, { concurrency: 3 });
  assert.equal(count, 0);
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
});

test("no paths or no checker means nothing to replace", async () => {
  assert.equal(await countExistingFiles([], async () => true), 0);
  assert.equal(await countExistingFiles(["a.png"], null), 0);
  assert.equal(await countExistingFiles(["", null, "a.png"], async () => true), 1);
});

test("only a refused fs scope counts as a scope error", () => {
  assert.equal(isFsScopeError("forbidden path: F:\\Templates\\car.psd"), true);
  assert.equal(isFsScopeError(new Error("forbidden path: F:\\x, maybe it is not allowed on the scope")), true);
  assert.equal(isFsScopeError("failed to open file at path: C:\\x.psd with error: The process cannot access the file because it is being used by another process. (os error 32)"), false);
  assert.equal(isFsScopeError(new Error("There is not enough space on the disk. (os error 112)")), false);
  assert.equal(isFsScopeError(null), false);
});

test("a complete run reports every shot saved", () => {
  const run = describePreviewRun({ total: 5, written: 5 });
  assert.equal(run.tone, "done");
  assert.equal(run.headline, "5 shots saved");
  assert.equal(run.skippedNote, "");
  assert.equal(run.error, "");
  assert.equal(describePreviewRun({ total: 1, written: 1 }).headline, "1 shot saved");
});

test("skipped angles are not counted as saved", () => {
  const run = describePreviewRun({ total: 5, written: 3, skipped: ["Front", "Top"] });
  assert.equal(run.tone, "partial");
  assert.equal(run.headline, "3 of 5 shots saved");
  assert.equal(run.skippedNote, "The viewer returned no image for Front and Top, so those angles weren't saved.");

  const one = describePreviewRun({ total: 3, written: 2, skipped: ["3/4"] });
  assert.equal(one.skippedNote, "The viewer returned no image for 3/4, so that angle wasn't saved.");

  const three = describePreviewRun({ total: 5, written: 2, skipped: ["Front", "Side", "Top"] });
  assert.match(three.skippedNote, /Front, Side and Top/);
});

test("a stopped run keeps its written count and the reason", () => {
  const run = describePreviewRun({ total: 5, written: 2, error: "Couldn't write car_side.png: disk full" });
  assert.equal(run.tone, "partial");
  assert.equal(run.headline, "2 of 5 shots saved");
  assert.equal(run.error, "Couldn't write car_side.png: disk full");

  const none = describePreviewRun({ total: 5, written: 0, error: "Capturing angles to a folder needs the desktop app." });
  assert.equal(none.tone, "failed");
  assert.equal(none.headline, "No shots saved");
});

test("downloads hand the bytes to an anchor and revoke the URL afterwards", () => {
  const events = [];
  const scheduled = [];
  const anchor = {
    style: {},
    click: () => events.push(["click", anchor.href, anchor.download]),
    remove: () => events.push(["remove"]),
  };
  const doc = {
    body: { appendChild: (node) => events.push(["append", node === anchor]) },
    createElement: (tag) => {
      events.push(["create", tag]);
      return anchor;
    },
  };
  const urlApi = {
    createObjectURL: (blob) => {
      events.push(["url", blob.type, blob.size]);
      return "blob:test";
    },
    revokeObjectURL: (url) => events.push(["revoke", url]),
  };

  downloadBytes("car_photo.png", new Uint8Array([1, 2, 3]), {
    mimeType: "image/png",
    doc,
    urlApi,
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
  });

  assert.deepEqual(events, [
    ["url", "image/png", 3],
    ["create", "a"],
    ["append", true],
    ["click", "blob:test", "car_photo.png"],
    ["remove"],
  ]);
  assert.equal(scheduled.length, 1);
  scheduled[0].fn();
  assert.deepEqual(events.at(-1), ["revoke", "blob:test"]);
});

test("downloads fail loudly where the page can't download", () => {
  assert.throws(() => downloadBytes("a.png", new Uint8Array([1]), { doc: null }), /can't download/);
});
