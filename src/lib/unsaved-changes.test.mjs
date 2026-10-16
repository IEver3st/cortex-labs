import assert from "node:assert/strict";
import test from "node:test";
import { setUnsavedChanges, subscribeUnsavedChanges, unsavedChangeKeys } from "./unsaved-changes.js";

test("tabs report unsaved edits and clear them", () => {
  let calls = 0;
  const unsubscribe = subscribeUnsavedChanges(() => { calls += 1; });
  try {
    setUnsavedChanges("tab-a", "siren");
    setUnsavedChanges("tab-a", "siren");
    setUnsavedChanges("tab-b", "siren");
    setUnsavedChanges("", "siren");
    assert.deepEqual(unsavedChangeKeys(), ["tab-a", "tab-b"]);
    assert.deepEqual(unsavedChangeKeys(["tab-c", "tab-b", "tab-a"]), ["tab-b", "tab-a"]);
    assert.deepEqual(unsavedChangeKeys([]), []);
    assert.equal(calls, 2, "repeating the same state does not notify");

    setUnsavedChanges("tab-a", null);
    setUnsavedChanges("tab-a", false);
    assert.deepEqual(unsavedChangeKeys(), ["tab-b"]);
    assert.equal(calls, 3);
  } finally {
    unsubscribe();
    setUnsavedChanges("tab-b", null);
  }
  setUnsavedChanges("tab-z", "siren");
  assert.equal(calls, 3, "an unsubscribed listener is not called");
  setUnsavedChanges("tab-z", null);
  assert.deepEqual(unsavedChangeKeys(), []);
});
