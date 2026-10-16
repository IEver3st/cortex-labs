import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  HOTKEY_CATEGORIES,
  HOTKEY_LABELS,
  findDuplicateHotkeys,
  findHotkeyConflict,
  findMatchingAction,
  formatHotkey,
  hotkeyProblem,
  isValidHotkey,
  mergeHotkeys,
  sameHotkey,
} from "./hotkeys.js";
import {
  WORKSPACE_MODES,
  workspaceLabel,
  workspaceModeForAction,
  workspaceModeRoute,
} from "./workspace-modes.js";

const bind = (key, mods = {}) => ({ key, ctrl: false, alt: false, shift: false, ...mods });
const press = (key, code, mods = {}) => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

test("every action has a label, a default and one category", () => {
  const categorized = Object.values(HOTKEY_CATEGORIES).flatMap((category) => category.actions);
  for (const action of Object.values(HOTKEY_ACTIONS)) {
    assert.ok(HOTKEY_LABELS[action], `${action} has no label`);
    assert.ok(DEFAULT_HOTKEYS[action]?.key, `${action} has no default`);
    assert.equal(categorized.filter((entry) => entry === action).length, 1, `${action} must be in one category`);
  }
});

test("default bindings are valid and unique", () => {
  for (const [action, hotkey] of Object.entries(DEFAULT_HOTKEYS)) {
    assert.equal(hotkeyProblem(hotkey), "", `${action} default ${formatHotkey(hotkey)} is invalid`);
  }
  assert.deepEqual(findDuplicateHotkeys(DEFAULT_HOTKEYS), {});
});

test("letters, digits and space need a modifier", () => {
  assert.equal(hotkeyProblem(bind("P")), "needsModifier");
  assert.equal(hotkeyProblem(bind("7")), "needsModifier");
  assert.equal(isValidHotkey(bind("P", { shift: true })), true);
  assert.equal(isValidHotkey(bind("P", { alt: true })), true);
  assert.equal(hotkeyProblem(bind(" ")), "needsCtrlOrAlt");
  assert.equal(hotkeyProblem(bind(" ", { shift: true })), "needsCtrlOrAlt");
  assert.equal(isValidHotkey(bind(" ", { ctrl: true })), true);
});

test("focus and navigation keys need Ctrl or Alt", () => {
  for (const key of ["Tab", "Enter", "Backspace", "Delete", "ArrowLeft", "ArrowDown", "Home", "End", "PageUp", "PageDown"]) {
    assert.equal(hotkeyProblem(bind(key)), "needsCtrlOrAlt", `${key} alone`);
    assert.equal(hotkeyProblem(bind(key, { shift: true })), "needsCtrlOrAlt", `Shift + ${key}`);
    assert.equal(isValidHotkey(bind(key, { ctrl: true })), true, `Ctrl + ${key}`);
    assert.equal(isValidHotkey(bind(key, { alt: true })), true, `Alt + ${key}`);
  }
});

test("reserved keys and empty bindings are refused", () => {
  for (const key of ["Escape", "CapsLock", "NumLock", "Dead", "Unidentified", "Control", "Shift"]) {
    assert.equal(hotkeyProblem(bind(key, { ctrl: true })), "reserved", key);
  }
  assert.equal(hotkeyProblem(bind("")), "missing");
  assert.equal(hotkeyProblem(null), "missing");
});

test("punctuation and function keys may stand alone", () => {
  assert.equal(isValidHotkey(bind("\\")), true);
  assert.equal(isValidHotkey(bind("[")), true);
  assert.equal(isValidHotkey(bind("F5")), true);
});

test("sameHotkey compares the press, not the stored spelling", () => {
  assert.equal(sameHotkey(bind("S", { alt: true }), bind("s", { alt: true })), true);
  assert.equal(sameHotkey(bind("S", { alt: true }), bind("S", { alt: true, shift: true })), false);
  assert.equal(sameHotkey(bind("", { alt: true }), bind("", { alt: true })), false);
});

test("findHotkeyConflict names the other action and ignores the one being edited", () => {
  const hotkeys = { ...DEFAULT_HOTKEYS };
  assert.equal(findHotkeyConflict(hotkeys, HOTKEY_ACTIONS.TOGGLE_PANEL, bind("r", { alt: true })), HOTKEY_ACTIONS.RESET_VIEW);
  assert.equal(findHotkeyConflict(hotkeys, HOTKEY_ACTIONS.RESET_VIEW, bind("R", { alt: true })), null);
  assert.equal(findHotkeyConflict(hotkeys, HOTKEY_ACTIONS.RESET_VIEW, bind("Q", { alt: true })), null);
  assert.equal(findHotkeyConflict(hotkeys, HOTKEY_ACTIONS.RESET_VIEW, bind("")), null);
});

test("findDuplicateHotkeys reports both sides of a stored clash", () => {
  const hotkeys = { ...DEFAULT_HOTKEYS, [HOTKEY_ACTIONS.RESET_VIEW]: bind("1", { alt: true }) };
  assert.deepEqual(findDuplicateHotkeys(hotkeys), {
    [HOTKEY_ACTIONS.NEW_TAB_LIVERY]: [HOTKEY_ACTIONS.RESET_VIEW],
    [HOTKEY_ACTIONS.RESET_VIEW]: [HOTKEY_ACTIONS.NEW_TAB_LIVERY],
  });
});

test("findMatchingAction can be limited to the actions a page handles", () => {
  const hotkeys = { ...DEFAULT_HOTKEYS, [HOTKEY_ACTIONS.NEW_TAB_LIVERY]: bind("R", { alt: true }) };
  const event = press("r", "KeyR", { altKey: true });
  assert.equal(findMatchingAction(hotkeys, event), HOTKEY_ACTIONS.NEW_TAB_LIVERY);
  assert.equal(findMatchingAction(hotkeys, event, [HOTKEY_ACTIONS.RESET_VIEW]), HOTKEY_ACTIONS.RESET_VIEW);
  assert.equal(findMatchingAction(hotkeys, event, [HOTKEY_ACTIONS.TOGGLE_PANEL]), null);
  assert.equal(findMatchingAction(hotkeys, press("\\", "Backslash")), HOTKEY_ACTIONS.TOGGLE_PANEL);
  assert.equal(findMatchingAction(hotkeys, { code: "", altKey: true }), null, "a keydown without a key");
});

test("mergeHotkeys keeps stored bindings and leaves a new default unset when its keys are taken", () => {
  const stored = { ...DEFAULT_HOTKEYS };
  delete stored[HOTKEY_ACTIONS.CAPTURE_VIEW];
  stored[HOTKEY_ACTIONS.RESET_VIEW] = bind("P", { alt: true });
  const merged = mergeHotkeys(stored, DEFAULT_HOTKEYS);
  assert.deepEqual(merged[HOTKEY_ACTIONS.RESET_VIEW], bind("P", { alt: true }));
  assert.equal(merged[HOTKEY_ACTIONS.CAPTURE_VIEW].key, "");

  delete stored[HOTKEY_ACTIONS.RESET_VIEW];
  const fresh = mergeHotkeys(stored, DEFAULT_HOTKEYS);
  assert.deepEqual(fresh[HOTKEY_ACTIONS.CAPTURE_VIEW], DEFAULT_HOTKEYS[HOTKEY_ACTIONS.CAPTURE_VIEW]);
  assert.deepEqual(mergeHotkeys(null, DEFAULT_HOTKEYS), DEFAULT_HOTKEYS);
  assert.equal(mergeHotkeys({ unknownAction: bind("Z", { ctrl: true }) }, DEFAULT_HOTKEYS).unknownAction, undefined);
});

test("every new-tab action opens one workspace with its canonical name", () => {
  const tabActions = HOTKEY_CATEGORIES.tabs.actions;
  assert.equal(tabActions.length, WORKSPACE_MODES.length);
  for (const action of tabActions) {
    const mode = workspaceModeForAction(action);
    assert.ok(mode, `${action} opens no workspace`);
    const route = workspaceModeRoute(mode.id);
    assert.equal(workspaceLabel(route.page, route.textureMode), mode.label);
    assert.equal(HOTKEY_LABELS[action], `New ${mode.label} Tab`, "the hotkey label uses the workspace name");
  }
  assert.deepEqual(workspaceModeRoute("everything"), { page: "viewer", textureMode: "everything" });
  assert.deepEqual(workspaceModeRoute("templategen"), { page: "templategen", textureMode: null });
  assert.equal(workspaceModeRoute("nope"), null);
  assert.equal(workspaceLabel("viewer"), "Livery");
  assert.equal(workspaceLabel("variants"), "Variant Builder");
});

test("the hotkeys page lists every action with its default", () => {
  const doc = readFileSync(new URL("../../docs/site/content/docs/user-guide/hotkeys.mdx", import.meta.url), "utf8");
  const rows = new Map();
  for (const line of doc.split(/\r?\n/)) {
    const match = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/.exec(line);
    if (!match || match[1] === "Action" || /^-+$/.test(match[1])) continue;
    rows.set(match[1], match[2]);
  }
  const labels = new Set(Object.values(HOTKEY_LABELS));
  for (const [action, label] of Object.entries(HOTKEY_LABELS)) {
    // MDX needs a backslash escaped to show one.
    const expected = formatHotkey(DEFAULT_HOTKEYS[action]).replace(/\\/g, "\\\\");
    assert.equal(rows.get(label), expected, `hotkeys.mdx: ${label} should read ${expected}`);
  }
  for (const label of rows.keys()) {
    assert.ok(labels.has(label), `hotkeys.mdx lists "${label}", which is not a shortcut`);
  }
});
