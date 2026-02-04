const PREFS_KEY = "cortex-labs:prefs.v1";
const ONBOARDED_KEY = "cortex-labs:onboarded.v1";

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

export function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
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
  } catch {
    // ignore
  }
}
