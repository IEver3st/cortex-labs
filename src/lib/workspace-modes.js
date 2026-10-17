import { Aperture, Car, Flashlight, Link2, Palette, Shirt, Siren, Zap } from "lucide-react";
import { HOTKEY_ACTIONS } from "./hotkeys.js";
import { normalizeTextureMode } from "./workspace-state.js";

// The workspaces a session can start in, in the order Home lists them. Home's
// Start rail, the new-tab menu, the new-tab hotkeys and the first-run
// onboarding all read this list, so a new workspace appears in each and every
// one names its project the same way. `cat` is the --cx-cat-* category marker;
// `page` is the Shell tab type (viewer modes share the viewer page).
export const WORKSPACE_MODES = Object.freeze([
  {
    id: "vehicle",
    page: "viewer",
    label: "Vehicle",
    desc: "Paint, liveries, mods and textures on a vehicle",
    icon: Car,
    cat: "livery",
    group: "vehicles",
    action: HOTKEY_ACTIONS.NEW_TAB_LIVERY,
  },
  {
    id: "eup",
    page: "viewer",
    label: "EUP",
    desc: "Uniform and clothing textures",
    icon: Shirt,
    cat: "eup",
    group: "clothing",
    action: HOTKEY_ACTIONS.NEW_TAB_EUP,
  },
  {
    id: "multi",
    page: "viewer",
    label: "Multi",
    desc: "Line up to six vehicles side by side",
    icon: Link2,
    cat: "multi",
    group: "vehicles",
    action: HOTKEY_ACTIONS.NEW_TAB_MULTI,
  },
  {
    id: "sirens",
    page: "viewer",
    label: "Sirens",
    desc: "Build and preview emergency lights on a vehicle",
    icon: Siren,
    cat: "siren",
    group: "vehicles",
    action: HOTKEY_ACTIONS.NEW_TAB_SIRENS,
  },
  {
    id: "variants",
    page: "variants",
    label: "Variant Builder",
    desc: "Grouped exports from a layered PSD",
    icon: Palette,
    cat: "variant",
    group: "pipeline",
    action: HOTKEY_ACTIONS.NEW_TAB_VARIANTS,
  },
  {
    id: "templategen",
    page: "templategen",
    label: "Template Generator",
    desc: "Layered PSD templates from a .yft",
    icon: Zap,
    cat: "template",
    group: "pipeline",
    action: HOTKEY_ACTIONS.NEW_TAB_TEMPLATE_GEN,
  },
  {
    id: "eupstudio",
    page: "eupstudio",
    label: "EUP Studio",
    desc: "Dress freemode peds with packs and addon pieces",
    icon: Shirt,
    cat: "eup",
    group: "clothing",
    action: HOTKEY_ACTIONS.NEW_TAB_EUP_STUDIO,
  },
  {
    id: "propstudio",
    page: "propstudio",
    label: "Prop Studio",
    desc: "Props with textures, emissives and their own lights",
    icon: Flashlight,
    cat: "prop",
    group: "props",
    action: HOTKEY_ACTIONS.NEW_TAB_PROP_STUDIO,
  },
  {
    id: "photo",
    page: "photo",
    label: "Photo Mode",
    desc: "Stage game vehicles, people and props for photos",
    icon: Aperture,
    cat: "photo",
    group: "photo",
    action: HOTKEY_ACTIONS.NEW_TAB_PHOTO,
  },
]);

export const WORKSPACE_MODE_GROUPS = Object.freeze([
  { id: "vehicles", label: "Vehicles" },
  { id: "clothing", label: "Clothing" },
  { id: "props", label: "Props" },
  { id: "photo", label: "Photos" },
  { id: "pipeline", label: "Templates and exports" },
]);

const MODE_BY_ID = new Map(WORKSPACE_MODES.map((mode) => [mode.id, mode]));
const MODE_BY_ACTION = new Map(WORKSPACE_MODES.map((mode) => [mode.action, mode]));

export function getWorkspaceMode(id) {
  // Livery and All tabs saved before Vehicle mode open in it.
  return MODE_BY_ID.get(normalizeTextureMode(id) || id) || null;
}

/** The workspace a new-tab hotkey action opens, or null. */
export function workspaceModeForAction(action) {
  return MODE_BY_ACTION.get(action) || null;
}

/** The Shell page and viewer mode that open a workspace, or null for an unknown id. */
export function workspaceModeRoute(id) {
  const mode = getWorkspaceMode(id);
  if (!mode) return null;
  return { page: mode.page, textureMode: mode.page === "viewer" ? mode.id : null };
}

/** The canonical name for a Shell page (and viewer mode): new projects and tabs use it. */
export function workspaceLabel(page, textureMode) {
  const mode = getWorkspaceMode(page === "viewer" ? textureMode || "vehicle" : page);
  return mode?.label || "Preview";
}
