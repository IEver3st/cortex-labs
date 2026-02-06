const PREFS_KEY = "cortex-labs:prefs.v1";
const ONBOARDED_KEY = "cortex-labs:onboarded.v1";
const SESSION_KEY = "cortex-labs:session.v1";

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
  }
}

export function saveSession(session) {
  try {
    if (!session || typeof session !== "object") return;
    const payload = { ...session, savedAt: Date.now() };
    localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  } catch {
  }
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.savedAt && Date.now() - parsed.savedAt > 30 * 24 * 60 * 60 * 1000) {
      clearSession();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
  }
}
