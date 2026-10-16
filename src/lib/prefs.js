const PREFS_KEY = "cortex-labs:prefs.v1";
const ONBOARDED_KEY = "cortex-labs:onboarded.v1";
const SESSION_KEY = "cortex-labs:session.v1";
export const PREFS_UPDATED_EVENT = "cortex:prefs-updated";
// A viewer render effect (shadows, AO) changed. Open viewers apply just that
// effect; the full prefs reload would reset their unsaved view state.
export const RENDER_EFFECT_EVENT = "cortex:render-effect";

// Default keys earlier versions stored that nothing reads any more. They are
// dropped on load so saving Settings does not write them back.
export const RETIRED_DEFAULT_KEYS = Object.freeze([
  "showAmbientOcclusion",
  "autoModelTexturesEnabled",
  "hideRotText",
  "experimentalSettings",
  "cameraWASD",
  "showHints",
  "toolbarInTitlebar",
  "glossiness",
]);

/** Stored `defaults` without retired keys; anything that is not an object reads as `{}`. */
export function sanitizeStoredDefaults(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const rest = { ...stored };
  for (const key of RETIRED_DEFAULT_KEYS) delete rest[key];
  return rest;
}

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Returns false when the preferences could not be written (for example, storage is full). */
export function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    return true;
  } catch (err) {
    console.error("[Prefs] Failed to save preferences:", err);
    return false;
  }
}

export function emitPrefsUpdated() {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent(PREFS_UPDATED_EVENT));
}

export function emitRenderEffectChanged(key, value) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent(RENDER_EFFECT_EVENT, { detail: { key, value } }));
}

export function loadOnboarded() {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setOnboarded() {
  try {
    localStorage.setItem(ONBOARDED_KEY, "1");
  } catch (err) {
    console.error("[Prefs] Failed to set onboarded flag:", err);
  }
}

// Older versions wrote a single-tab session snapshot here that nothing read;
// open tabs now restore from their workspaces (lib/workspace.js).
export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (err) {
    console.error("[Prefs] Failed to clear session:", err);
  }
}
