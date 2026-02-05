// Hotkey configuration and utilities

export const HOTKEY_ACTIONS = {
  TOGGLE_EXTERIOR_ONLY: "toggleExteriorOnly",
  MODE_LIVERY: "modeLivery",
  MODE_ALL: "modeAll",
  MODE_EUP: "modeEup",
  CYCLE_MODE: "cycleMode",
  TOGGLE_PANEL: "togglePanel",
  SELECT_MODEL: "selectModel",
  SELECT_LIVERY: "selectLivery",
  SELECT_GLASS: "selectGlass",
  TOGGLE_DUAL_GIZMO: "toggleDualGizmo",
  SWAP_DUAL_SLOT: "swapDualSlot",
};

export const HOTKEY_LABELS = {
  [HOTKEY_ACTIONS.TOGGLE_EXTERIOR_ONLY]: "Toggle Exterior Only",
  [HOTKEY_ACTIONS.MODE_LIVERY]: "Switch to Livery Mode",
  [HOTKEY_ACTIONS.MODE_ALL]: "Switch to All Mode",
  [HOTKEY_ACTIONS.MODE_EUP]: "Switch to EUP Mode",
  [HOTKEY_ACTIONS.CYCLE_MODE]: "Cycle Modes",
  [HOTKEY_ACTIONS.TOGGLE_PANEL]: "Toggle Control Panel",
  [HOTKEY_ACTIONS.SELECT_MODEL]: "Select Model",
  [HOTKEY_ACTIONS.SELECT_LIVERY]: "Select Livery/Texture",
  [HOTKEY_ACTIONS.SELECT_GLASS]: "Select Glass/Window",
  [HOTKEY_ACTIONS.TOGGLE_DUAL_GIZMO]: "Toggle Multi Gizmo",
  [HOTKEY_ACTIONS.SWAP_DUAL_SLOT]: "Swap Selected Slot",
};

export const HOTKEY_CATEGORIES = {
  modes: {
    label: "Mode Switching",
    actions: [
      HOTKEY_ACTIONS.CYCLE_MODE,
      HOTKEY_ACTIONS.MODE_LIVERY,
      HOTKEY_ACTIONS.MODE_ALL,
      HOTKEY_ACTIONS.MODE_EUP,
    ],
  },
  view: {
    label: "View Controls",
    actions: [
      HOTKEY_ACTIONS.TOGGLE_EXTERIOR_ONLY,
      HOTKEY_ACTIONS.TOGGLE_PANEL,
    ],
  },
  multi: {
    label: "Multi-Model",
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
  [HOTKEY_ACTIONS.MODE_LIVERY]: { key: "1", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.MODE_ALL]: { key: "2", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.MODE_EUP]: { key: "3", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.CYCLE_MODE]: { key: "Tab", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.TOGGLE_PANEL]: { key: "\\", ctrl: false, alt: false, shift: false },
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

export function hotkeyMatches(hotkey, event) {
  if (!hotkey || !hotkey.key) return false;

  const eventKey = event.key.toLowerCase();
  const hotkeyKey = hotkey.key.toLowerCase();

  const keyMatches = eventKey === hotkeyKey || event.code === `Key${hotkey.key.toUpperCase()}`;
  const ctrlMatches = Boolean(hotkey.ctrl) === Boolean(event.ctrlKey || event.metaKey);
  const altMatches = Boolean(hotkey.alt) === Boolean(event.altKey);
  const shiftMatches = Boolean(hotkey.shift) === Boolean(event.shiftKey);

  return keyMatches && ctrlMatches && altMatches && shiftMatches;
}

export function findMatchingAction(hotkeys, event) {
  for (const [action, hotkey] of Object.entries(hotkeys)) {
    if (hotkeyMatches(hotkey, event)) {
      return action;
    }
  }
  return null;
}

export function isValidHotkey(hotkey) {
  if (!hotkey || !hotkey.key) return false;
  if (hotkey.key.length === 0) return false;
  // Require at least one modifier for single character keys (except special keys)
  const specialKeys = ["Tab", "Escape", "Enter", "Backspace", "Delete", "\\", "/", "[", "]", ";", "'", ",", ".", "-", "=", "`"];
  if (hotkey.key.length === 1 && !specialKeys.includes(hotkey.key)) {
    if (!hotkey.ctrl && !hotkey.alt && !hotkey.shift) {
      return false;
    }
  }
  return true;
}

export function mergeHotkeys(stored, defaults) {
  const result = { ...defaults };
  if (stored && typeof stored === "object") {
    for (const [action, hotkey] of Object.entries(stored)) {
      if (action in defaults && hotkey && typeof hotkey === "object") {
        result[action] = { ...hotkey };
      }
    }
  }
  return result;
}
