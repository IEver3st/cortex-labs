import { PREFS_UPDATED_EVENT, loadPrefs } from "./prefs.js";

export const STAGE_TONES = Object.freeze(["theme", "dark", "light"]);

export function normalizeStageTone(value) {
  return STAGE_TONES.includes(value) ? value : "theme";
}

export function resolveStageTone(preference = loadPrefs()?.defaults?.stageTone) {
  const tone = normalizeStageTone(preference);
  if (tone !== "theme") return tone;
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function watchStageTone(onChange) {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  let current = resolveStageTone();
  onChange(current);
  const check = () => {
    const next = resolveStageTone();
    if (next === current) return;
    current = next;
    onChange(next);
  };
  const observer = new MutationObserver(check);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener(PREFS_UPDATED_EVENT, check);
  return () => {
    observer.disconnect();
    window.removeEventListener(PREFS_UPDATED_EVENT, check);
  };
}
