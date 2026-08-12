import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOpenFolderPath, openFolderPath } from "./open-folder.js";

test("normalizes Windows paths and selects the first saved path", () => {
  assert.equal(
    normalizeOpenFolderPath('"C:/Users/Studio/Preview Exports | C:/Users/Studio/Backup"'),
    "C:\\Users\\Studio\\Preview Exports",
  );
  assert.equal(normalizeOpenFolderPath("  "), "");
});

test("uses the Tauri opener as the primary folder action", async () => {
  const calls = [];
  const opened = await openFolderPath("C:/Preview Exports", {
    openPathImpl: async (path) => calls.push(["opener", path]),
    invokeImpl: async (...args) => calls.push(["fallback", ...args]),
  });

  assert.equal(opened, true);
  assert.deepEqual(calls, [["opener", "C:\\Preview Exports"]]);
});

test("falls back to the native app command when the opener fails", async () => {
  const calls = [];
  const opened = await openFolderPath("C:/Preview Exports", {
    openPathImpl: async () => {
      calls.push(["opener"]);
      throw new Error("opener unavailable");
    },
    invokeImpl: async (...args) => calls.push(["fallback", ...args]),
  });

  assert.equal(opened, true);
  assert.deepEqual(calls, [
    ["opener"],
    ["fallback", "open_folder_fallback", { path: "C:\\Preview Exports" }],
  ]);
});

test("reports failure only after both folder actions fail", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const opened = await openFolderPath("C:/Preview Exports", {
      openPathImpl: async () => {
        throw new Error("opener unavailable");
      },
      invokeImpl: async () => {
        throw new Error("native fallback unavailable");
      },
    });

    assert.equal(opened, false);
  } finally {
    console.error = originalConsoleError;
  }
});
