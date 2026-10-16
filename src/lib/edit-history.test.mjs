import assert from "node:assert/strict";
import test from "node:test";
import { createEditHistory, editHistoryKey, recordEdit, redoEdit, undoEdit } from "./edit-history.js";

test("undo restores the state before each edit and redo replays it", () => {
  let history = createEditHistory();
  history = recordEdit(history, ["a"], { now: 0 });
  history = recordEdit(history, ["a", "b"], { now: 1000 });
  const current = ["a", "b", "c"];

  const first = undoEdit(history, current);
  assert.deepEqual(first.snapshot, ["a", "b"]);
  const second = undoEdit(first.history, first.snapshot);
  assert.deepEqual(second.snapshot, ["a"]);
  assert.equal(undoEdit(second.history, second.snapshot), null);

  const again = redoEdit(second.history, second.snapshot);
  assert.deepEqual(again.snapshot, ["a", "b"]);
  const last = redoEdit(again.history, again.snapshot);
  assert.deepEqual(last.snapshot, current);
  assert.equal(redoEdit(last.history, last.snapshot), null);
});

test("a new edit after undo drops the redo branch", () => {
  let history = recordEdit(createEditHistory(), 1, { now: 0 });
  const undone = undoEdit(history, 2);
  history = recordEdit(undone.history, undone.snapshot, { now: 5000 });
  assert.equal(history.future.length, 0);
  assert.equal(redoEdit(history, 3), null);
});

test("history is bounded and keeps the newest steps", () => {
  let history = createEditHistory();
  for (let index = 0; index < 10; index += 1) history = recordEdit(history, index, { now: index * 1000, limit: 4 });
  assert.deepEqual(history.past, [6, 7, 8, 9]);
  const undone = undoEdit(history, 10, { limit: 2 });
  assert.deepEqual(undone.history.future, [10]);
});

test("rapid edits with the same key undo as one step; other keys or pauses split them", () => {
  let history = createEditHistory();
  history = recordEdit(history, "start", { key: "nudge:a", now: 0 });
  history = recordEdit(history, "moved once", { key: "nudge:a", now: 300 });
  history = recordEdit(history, "moved twice", { key: "nudge:a", now: 600 });
  assert.deepEqual(history.past, ["start"]);

  history = recordEdit(history, "moved thrice", { key: "nudge:b", now: 700 });
  history = recordEdit(history, "after pause", { key: "nudge:b", now: 5000 });
  assert.deepEqual(history.past, ["start", "moved thrice", "after pause"]);

  // Unkeyed edits never merge.
  history = recordEdit(history, "x", { now: 5001 });
  history = recordEdit(history, "y", { now: 5002 });
  assert.equal(history.past.length, 5);
});

test("undo ends a coalescing run", () => {
  let history = recordEdit(createEditHistory(), "start", { key: "k", now: 0 });
  const undone = undoEdit(history, "moved");
  history = recordEdit(undone.history, "start", { key: "k", now: 100 });
  assert.deepEqual(history.past, ["start"]);
  history = recordEdit(history, "moved", { key: "k", now: 200 });
  assert.deepEqual(history.past, ["start"]);
});

test("undo and redo keys", () => {
  assert.equal(editHistoryKey({ ctrlKey: true, key: "z" }), "undo");
  assert.equal(editHistoryKey({ metaKey: true, key: "Z", shiftKey: true }), "redo");
  assert.equal(editHistoryKey({ ctrlKey: true, key: "y" }), "redo");
  assert.equal(editHistoryKey({ ctrlKey: true, altKey: true, key: "z" }), null);
  assert.equal(editHistoryKey({ key: "z" }), null);
  assert.equal(editHistoryKey({ ctrlKey: true, key: "e" }), null);
});
