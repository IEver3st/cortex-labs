export const HOTKEY_ACTIONS = {
  TOGGLE_EXTERIOR_ONLY: "toggleExteriorOnly",
  TOGGLE_SHADOWS: "toggleShadows",
  NEW_TAB_LIVERY: "newTabLivery",
  NEW_TAB_ALL: "newTabAll",
  NEW_TAB_EUP: "newTabEup",
  NEW_TAB_MULTI: "newTabMulti",
  NEW_TAB_VARIANTS: "newTabVariants",
  NEW_TAB_TEMPLATE_GEN: "newTabTemplateGen",
  NEW_TAB_EUP_STUDIO: "newTabEupStudio",
  NEW_TAB_PROP_STUDIO: "newTabPropStudio",
  NEW_TAB_PHOTO: "newTabPhoto",
  NEW_TAB_SIRENS: "newTabSirens",
  TOGGLE_PANEL: "togglePanel",
  RESET_VIEW: "resetView",
  CAMERA_PRESET_FRONT: "cameraPresetFront",
  CAMERA_PRESET_BACK: "cameraPresetBack",
  CAMERA_PRESET_SIDE: "cameraPresetSide",
  CAMERA_PRESET_ANGLE: "cameraPresetAngle",
  CAMERA_PRESET_TOP: "cameraPresetTop",
  CAPTURE_VIEW: "captureView",
  SELECT_MODEL: "selectModel",
  SELECT_LIVERY: "selectLivery",
  SELECT_GLASS: "selectGlass",
  TOGGLE_DUAL_GIZMO: "toggleDualGizmo",
  SWAP_DUAL_SLOT: "swapDualSlot",
};

export const HOTKEY_LABELS = {
  [HOTKEY_ACTIONS.TOGGLE_EXTERIOR_ONLY]: "Toggle Exterior Only",
  [HOTKEY_ACTIONS.TOGGLE_SHADOWS]: "Toggle Ground Shadows",
  [HOTKEY_ACTIONS.NEW_TAB_LIVERY]: "New Livery Tab",
  [HOTKEY_ACTIONS.NEW_TAB_ALL]: "New All Tab",
  [HOTKEY_ACTIONS.NEW_TAB_EUP]: "New EUP Tab",
  [HOTKEY_ACTIONS.NEW_TAB_MULTI]: "New Multi Tab",
  [HOTKEY_ACTIONS.NEW_TAB_VARIANTS]: "New Variant Builder Tab",
  [HOTKEY_ACTIONS.NEW_TAB_TEMPLATE_GEN]: "New Template Generator Tab",
  [HOTKEY_ACTIONS.NEW_TAB_EUP_STUDIO]: "New EUP Studio Tab",
  [HOTKEY_ACTIONS.NEW_TAB_PROP_STUDIO]: "New Prop Studio Tab",
  [HOTKEY_ACTIONS.NEW_TAB_PHOTO]: "New Photo Mode Tab",
  [HOTKEY_ACTIONS.NEW_TAB_SIRENS]: "New Sirens Tab",
  [HOTKEY_ACTIONS.TOGGLE_PANEL]: "Toggle Control Panel",
  [HOTKEY_ACTIONS.RESET_VIEW]: "Reset View",
  [HOTKEY_ACTIONS.CAMERA_PRESET_FRONT]: "Camera Preset: Front",
  [HOTKEY_ACTIONS.CAMERA_PRESET_BACK]: "Camera Preset: Back",
  [HOTKEY_ACTIONS.CAMERA_PRESET_SIDE]: "Camera Preset: Side",
  [HOTKEY_ACTIONS.CAMERA_PRESET_ANGLE]: "Camera Preset: 3/4",
  [HOTKEY_ACTIONS.CAMERA_PRESET_TOP]: "Camera Preset: Top",
  [HOTKEY_ACTIONS.CAPTURE_VIEW]: "Save This View",
  [HOTKEY_ACTIONS.SELECT_MODEL]: "Select Model",
  [HOTKEY_ACTIONS.SELECT_LIVERY]: "Select Livery/Texture",
  [HOTKEY_ACTIONS.SELECT_GLASS]: "Select Glass/Window",
  [HOTKEY_ACTIONS.TOGGLE_DUAL_GIZMO]: "Toggle Multi Gizmo",
  [HOTKEY_ACTIONS.SWAP_DUAL_SLOT]: "Next Vehicle in Multi",
};

export const HOTKEY_CATEGORIES = {
  tabs: {
    label: "New Tabs",
    actions: [
      HOTKEY_ACTIONS.NEW_TAB_LIVERY,
      HOTKEY_ACTIONS.NEW_TAB_ALL,
      HOTKEY_ACTIONS.NEW_TAB_EUP,
      HOTKEY_ACTIONS.NEW_TAB_MULTI,
      HOTKEY_ACTIONS.NEW_TAB_VARIANTS,
      HOTKEY_ACTIONS.NEW_TAB_TEMPLATE_GEN,
      HOTKEY_ACTIONS.NEW_TAB_EUP_STUDIO,
      HOTKEY_ACTIONS.NEW_TAB_PROP_STUDIO,
      HOTKEY_ACTIONS.NEW_TAB_SIRENS,
      HOTKEY_ACTIONS.NEW_TAB_PHOTO,
    ],
  },
  view: {
    label: "View Controls",
    actions: [
      HOTKEY_ACTIONS.TOGGLE_EXTERIOR_ONLY,
      HOTKEY_ACTIONS.TOGGLE_SHADOWS,
      HOTKEY_ACTIONS.TOGGLE_PANEL,
    ],
  },
  camera: {
    label: "Camera",
    actions: [
      HOTKEY_ACTIONS.RESET_VIEW,
      HOTKEY_ACTIONS.CAMERA_PRESET_FRONT,
      HOTKEY_ACTIONS.CAMERA_PRESET_BACK,
      HOTKEY_ACTIONS.CAMERA_PRESET_SIDE,
      HOTKEY_ACTIONS.CAMERA_PRESET_ANGLE,
      HOTKEY_ACTIONS.CAMERA_PRESET_TOP,
      HOTKEY_ACTIONS.CAPTURE_VIEW,
    ],
  },
  multi: {
    label: "Multi",
    actions: [
      HOTKEY_ACTIONS.TOGGLE_DUAL_GIZMO,
      HOTKEY_ACTIONS.SWAP_DUAL_SLOT,
    ],
  },
  files: {
    label: "File Selection",
    actions: [
      HOTKEY_ACTIONS.SELECT_MODEL,
      HOTKEY_ACTIONS.SELECT_LIVERY,
      HOTKEY_ACTIONS.SELECT_GLASS,
    ],
  },
};

export const DEFAULT_HOTKEYS = {
  [HOTKEY_ACTIONS.TOGGLE_EXTERIOR_ONLY]: { key: "E", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.TOGGLE_SHADOWS]: { key: "S", ctrl: false, alt: true, shift: true },
  [HOTKEY_ACTIONS.NEW_TAB_LIVERY]: { key: "1", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.NEW_TAB_ALL]: { key: "2", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.NEW_TAB_EUP]: { key: "3", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.NEW_TAB_MULTI]: { key: "4", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.NEW_TAB_VARIANTS]: { key: "5", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.NEW_TAB_TEMPLATE_GEN]: { key: "6", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.NEW_TAB_EUP_STUDIO]: { key: "7", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.NEW_TAB_PROP_STUDIO]: { key: "8", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.NEW_TAB_SIRENS]: { key: "9", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.NEW_TAB_PHOTO]: { key: "0", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.TOGGLE_PANEL]: { key: "\\", ctrl: false, alt: false, shift: false },
  [HOTKEY_ACTIONS.RESET_VIEW]: { key: "R", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.CAMERA_PRESET_FRONT]: { key: "F", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.CAMERA_PRESET_BACK]: { key: "B", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.CAMERA_PRESET_SIDE]: { key: "S", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.CAMERA_PRESET_ANGLE]: { key: "A", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.CAMERA_PRESET_TOP]: { key: "T", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.CAPTURE_VIEW]: { key: "P", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.SELECT_MODEL]: { key: "O", ctrl: true, alt: false, shift: false },
  [HOTKEY_ACTIONS.SELECT_LIVERY]: { key: "L", ctrl: true, alt: false, shift: false },
  [HOTKEY_ACTIONS.SELECT_GLASS]: { key: "G", ctrl: true, alt: false, shift: false },
  [HOTKEY_ACTIONS.TOGGLE_DUAL_GIZMO]: { key: "G", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.SWAP_DUAL_SLOT]: { key: "X", ctrl: false, alt: true, shift: false },
};

export function formatHotkey(hotkey) {
  if (!hotkey || !hotkey.key) return "Not set";
  const parts = [];
  if (hotkey.ctrl) parts.push("Ctrl");
  if (hotkey.alt) parts.push("Alt");
  if (hotkey.shift) parts.push("Shift");

  let keyDisplay = hotkey.key;
  if (keyDisplay === " ") keyDisplay = "Space";
  else if (keyDisplay === "\\") keyDisplay = "\\";
  else if (keyDisplay.length === 1) keyDisplay = keyDisplay.toUpperCase();

  parts.push(keyDisplay);
  return parts.join(" + ");
}

export function parseKeyEvent(event) {
  return {
    key: event.key,
    ctrl: event.ctrlKey || event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
}

const PUNCTUATION_CODES = {
  "\\": "Backslash",
  "/": "Slash",
  "[": "BracketLeft",
  "]": "BracketRight",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
};

function keyToCode(key) {
  if (key === " ") return "Space";
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return PUNCTUATION_CODES[key] || key;
}

export function hotkeyMatches(hotkey, event) {
  if (!hotkey || !hotkey.key) return false;
  // Autofill and IME keydowns can arrive without a key.
  if (typeof event?.key !== "string") return false;

  const eventKey = event.key.toLowerCase();
  const hotkeyKey = hotkey.key.toLowerCase();

  const keyMatches = eventKey === hotkeyKey || event.code === keyToCode(hotkey.key);
  const ctrlMatches = Boolean(hotkey.ctrl) === Boolean(event.ctrlKey || event.metaKey);
  const altMatches = Boolean(hotkey.alt) === Boolean(event.altKey);
  const shiftMatches = Boolean(hotkey.shift) === Boolean(event.shiftKey);

  return keyMatches && ctrlMatches && altMatches && shiftMatches;
}

/**
 * The first action whose binding matches the event. `actions` limits the
 * search to the actions a surface handles, so a binding shared with an action
 * that does nothing there cannot shadow one that does.
 */
export function findMatchingAction(hotkeys, event, actions = null) {
  const candidates = actions ? actions.map((action) => [action, hotkeys?.[action]]) : Object.entries(hotkeys || {});
  for (const [action, hotkey] of candidates) {
    if (hotkeyMatches(hotkey, event)) {
      return action;
    }
  }
  return null;
}

// Single-character keys that may be bound without a modifier.
const UNMODIFIED_PUNCTUATION = new Set(["\\", "/", "[", "]", ";", "'", ",", ".", "-", "=", "`"]);
// Keys that move focus, edit text, or scroll. Shift alone still selects or
// moves backwards with them, so they need Ctrl or Alt.
const NAVIGATION_KEYS = new Set([
  " ", "Tab", "Enter", "Backspace", "Delete",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown", "ContextMenu",
]);
// Keys that cancel, toggle a lock, or never reach the page as themselves.
const RESERVED_KEYS = new Set([
  "Escape", "CapsLock", "NumLock", "ScrollLock", "Dead", "Unidentified", "Process", "Compose",
  "Control", "Alt", "Shift", "Meta", "AltGraph", "OS", "Fn", "FnLock",
]);

/**
 * Why a binding can't be used, or "" when it can: "missing", "reserved",
 * "needsCtrlOrAlt" (focus and navigation keys), or "needsModifier" (letters,
 * digits and other typing keys).
 */
export function hotkeyProblem(hotkey) {
  if (!hotkey || typeof hotkey.key !== "string" || hotkey.key.length === 0) return "missing";
  const { key } = hotkey;
  if (RESERVED_KEYS.has(key)) return "reserved";
  if (NAVIGATION_KEYS.has(key)) return hotkey.ctrl || hotkey.alt ? "" : "needsCtrlOrAlt";
  if (key.length === 1 && !UNMODIFIED_PUNCTUATION.has(key) && !hotkey.ctrl && !hotkey.alt && !hotkey.shift) {
    return "needsModifier";
  }
  return "";
}

export function isValidHotkey(hotkey) {
  return hotkeyProblem(hotkey) === "";
}

/** Whether two bindings fire on the same key press. */
export function sameHotkey(a, b) {
  if (!a?.key || !b?.key) return false;
  if (Boolean(a.ctrl) !== Boolean(b.ctrl)) return false;
  if (Boolean(a.alt) !== Boolean(b.alt)) return false;
  if (Boolean(a.shift) !== Boolean(b.shift)) return false;
  return a.key.toLowerCase() === b.key.toLowerCase() || keyToCode(a.key) === keyToCode(b.key);
}

/** The other action already bound to `hotkey`, or null. */
export function findHotkeyConflict(hotkeys, action, hotkey) {
  if (!hotkey?.key) return null;
  for (const [other, binding] of Object.entries(hotkeys || {})) {
    if (other !== action && sameHotkey(binding, hotkey)) return other;
  }
  return null;
}

/** Every action that shares its binding with another, mapped to those others. */
export function findDuplicateHotkeys(hotkeys) {
  const duplicates = {};
  const entries = Object.entries(hotkeys || {});
  for (const [action, binding] of entries) {
    const others = entries
      .filter(([other, otherBinding]) => other !== action && sameHotkey(binding, otherBinding))
      .map(([other]) => other);
    if (others.length) duplicates[action] = others;
  }
  return duplicates;
}

/**
 * Stored bindings over the defaults. A default for an action the user never
 * saved (one added in a later version) stays unset when the user already uses
 * its keys for something else.
 */
export function mergeHotkeys(stored, defaults) {
  const result = { ...defaults };
  if (!stored || typeof stored !== "object") return result;
  const storedActions = new Set();
  for (const [action, hotkey] of Object.entries(stored)) {
    if (action in defaults && hotkey && typeof hotkey === "object") {
      result[action] = { ...hotkey };
      storedActions.add(action);
    }
  }
  for (const action of Object.keys(defaults)) {
    if (storedActions.has(action)) continue;
    const taken = [...storedActions].some((other) => sameHotkey(result[other], result[action]));
    if (taken) result[action] = { key: "", ctrl: false, alt: false, shift: false };
  }
  return result;
}
