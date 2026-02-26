export const HOTKEY_ACTIONS = {
  TOGGLE_EXTERIOR_ONLY: "toggleExteriorOnly",
  NEW_TAB_LIVERY: "newTabLivery",
  NEW_TAB_ALL: "newTabAll",
  NEW_TAB_EUP: "newTabEup",
  NEW_TAB_MULTI: "newTabMulti",
  NEW_TAB_VARIANTS: "newTabVariants",
  NEW_TAB_TEMPLATE_GEN: "newTabTemplateGen",
  TOGGLE_PANEL: "togglePanel",
  RESET_VIEW: "resetView",
  CAMERA_PRESET_FRONT: "cameraPresetFront",
  CAMERA_PRESET_BACK: "cameraPresetBack",
  CAMERA_PRESET_SIDE: "cameraPresetSide",
  CAMERA_PRESET_ANGLE: "cameraPresetAngle",
  CAMERA_PRESET_TOP: "cameraPresetTop",
  SELECT_MODEL: "selectModel",
  SELECT_LIVERY: "selectLivery",
  SELECT_GLASS: "selectGlass",
  TOGGLE_DUAL_GIZMO: "toggleDualGizmo",
  SWAP_DUAL_SLOT: "swapDualSlot",
};

export const HOTKEY_LABELS = {
  [HOTKEY_ACTIONS.TOGGLE_EXTERIOR_ONLY]: "Toggle Exterior Only",
  [HOTKEY_ACTIONS.NEW_TAB_LIVERY]: "New Livery Tab",
  [HOTKEY_ACTIONS.NEW_TAB_ALL]: "New All Tab",
  [HOTKEY_ACTIONS.NEW_TAB_EUP]: "New EUP Tab",
  [HOTKEY_ACTIONS.NEW_TAB_MULTI]: "New Multi Tab",
  [HOTKEY_ACTIONS.NEW_TAB_VARIANTS]: "New Variant Builder Tab",
  [HOTKEY_ACTIONS.NEW_TAB_TEMPLATE_GEN]: "New Template Generator Tab",
  [HOTKEY_ACTIONS.TOGGLE_PANEL]: "Toggle Control Panel",
  [HOTKEY_ACTIONS.RESET_VIEW]: "Reset View",
  [HOTKEY_ACTIONS.CAMERA_PRESET_FRONT]: "Camera Preset: Front",
  [HOTKEY_ACTIONS.CAMERA_PRESET_BACK]: "Camera Preset: Back",
  [HOTKEY_ACTIONS.CAMERA_PRESET_SIDE]: "Camera Preset: Side",
  [HOTKEY_ACTIONS.CAMERA_PRESET_ANGLE]: "Camera Preset: 3/4",
  [HOTKEY_ACTIONS.CAMERA_PRESET_TOP]: "Camera Preset: Top",
  [HOTKEY_ACTIONS.SELECT_MODEL]: "Select Model",
  [HOTKEY_ACTIONS.SELECT_LIVERY]: "Select Livery/Texture",
  [HOTKEY_ACTIONS.SELECT_GLASS]: "Select Glass/Window",
  [HOTKEY_ACTIONS.TOGGLE_DUAL_GIZMO]: "Toggle Multi Gizmo",
  [HOTKEY_ACTIONS.SWAP_DUAL_SLOT]: "Swap Selected Slot",
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
    ],
  },
  view: {
    label: "View Controls",
    actions: [
      HOTKEY_ACTIONS.TOGGLE_EXTERIOR_ONLY,
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
  [HOTKEY_ACTIONS.NEW_TAB_LIVERY]: { key: "1", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.NEW_TAB_ALL]: { key: "2", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.NEW_TAB_EUP]: { key: "3", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.NEW_TAB_MULTI]: { key: "4", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.NEW_TAB_VARIANTS]: { key: "5", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.NEW_TAB_TEMPLATE_GEN]: { key: "6", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.TOGGLE_PANEL]: { key: "\\", ctrl: false, alt: false, shift: false },
  [HOTKEY_ACTIONS.RESET_VIEW]: { key: "R", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.CAMERA_PRESET_FRONT]: { key: "F", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.CAMERA_PRESET_BACK]: { key: "B", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.CAMERA_PRESET_SIDE]: { key: "S", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.CAMERA_PRESET_ANGLE]: { key: "A", ctrl: false, alt: true, shift: false },
  [HOTKEY_ACTIONS.CAMERA_PRESET_TOP]: { key: "T", ctrl: false, alt: true, shift: false },
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
