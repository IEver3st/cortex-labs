import { invoke } from "@tauri-apps/api/core";
import { emitPrefsUpdated, loadPrefs, savePrefs } from "./prefs";

const STATE_KEY = "cortex-labs:usage.v1";
const ID_PATTERN = /^[0-9a-f]{32}$/;

export const USAGE_EVENTS = Object.freeze(["open", "livery", "template", "eup", "photo", "siren"]);
export const USAGE_CHANGED_EVENT = "cortex:usage-changed";

const countedOnce = new Set();
let heldThisSession = false;

function inTauri() {
  return typeof window !== "undefined" && typeof window.__TAURI_INTERNALS__?.invoke === "function";
}

function randomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STATE_KEY) || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(patch) {
  const next = { ...readState(), ...patch };
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(next));
  } catch {
    return null;
  }
  window.dispatchEvent(new CustomEvent(USAGE_CHANGED_EVENT));
  return next;
}

export function usageStatsAvailable() {
  return inTauri();
}

export function usageStatsEnabled() {
  return !heldThisSession && loadPrefs()?.defaults?.usageStats !== false;
}

export function holdUsageStats(held) {
  heldThisSession = Boolean(held);
}

export function setUsageStatsEnabled(enabled) {
  holdUsageStats(!enabled);
  const prefs = loadPrefs() || {};
  const defaults = prefs.defaults && typeof prefs.defaults === "object" ? prefs.defaults : {};
  if (!savePrefs({ ...prefs, defaults: { ...defaults, usageStats: Boolean(enabled) } })) return false;
  emitPrefsUpdated();
  return true;
}

export function usageNoticeSeen() {
  return readState().noticeSeen === true;
}

export function markUsageNoticeSeen() {
  if (!usageNoticeSeen()) writeState({ noticeSeen: true });
}

export function usageInstallId() {
  const { installId } = readState();
  if (ID_PATTERN.test(installId || "")) return installId;
  return writeState({ installId: randomId() })?.installId ?? null;
}

export function resetUsageInstallId() {
  return writeState({ installId: randomId() })?.installId ?? null;
}

export function trackUsage(event, count = 1) {
  const amount = Math.floor(Number(count));
  if (!inTauri() || !USAGE_EVENTS.includes(event) || !(amount >= 1)) return false;
  if (!usageStatsEnabled() || !usageNoticeSeen()) return false;
  const installId = usageInstallId();
  if (!installId) return false;
  invoke("usage_ping", { installId, event, count: amount }).catch(() => {});
  return true;
}

export function trackUsageOnce(event, key, count = 1) {
  const id = `${event}\n${key}`;
  if (countedOnce.has(id)) return false;
  if (!trackUsage(event, count)) return false;
  countedOnce.add(id);
  return true;
}
