/**
 * Lightweight update checker — polls the GitHub Releases API for the latest
 * version and compares it against the running app version.
 *
 * Returns { available, latest, url, notes } when a newer release exists.
 */
import { useEffect, useRef, useState } from "react";

const GITHUB_OWNER = "IEver3st";
const GITHUB_REPO = "cortex-labs";
const CHECK_INTERVAL = 30 * 60 * 1000; // re-check every 30 minutes

/**
 * Compare two semver strings.  Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareSemver(a, b) {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/**
 * Fetch the latest release from GitHub.
 */
async function fetchLatestRelease() {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
    { headers: { Accept: "application/vnd.github+json" } },
  );
  if (!res.ok) return null;
  const data = await res.json();
  return {
    tag: data.tag_name,           // e.g. "v2.0.0"
    version: data.tag_name.replace(/^v/, ""),
    url: data.html_url,           // release page URL
    notes: data.body || "",
    name: data.name || data.tag_name,
  };
}

/**
 * React hook — checks for updates on mount and periodically afterwards.
 *
 * @param {string} currentVersion  The running app version (e.g. "1.9.9")
 * @returns {{ available: boolean, latest: string|null, url: string|null, name: string|null, dismissed: boolean, dismiss: () => void }}
 */
export function useUpdateChecker(currentVersion) {
  const [state, setState] = useState({
    available: false,
    latest: null,
    url: null,
    name: null,
  });
  const [dismissed, setDismissed] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!currentVersion) return;

    let cancelled = false;

    const check = async () => {
      try {
        const release = await fetchLatestRelease();
        if (cancelled || !release) return;

        if (compareSemver(release.version, currentVersion) > 0) {
          setState({
            available: true,
            latest: release.version,
            url: release.url,
            name: release.name,
          });
        }
      } catch {
        // Network error — silently ignore, will retry next interval
      }
    };

    // Initial check after a short delay so it doesn't compete with boot
    const initialDelay = setTimeout(check, 5000);

    // Periodic re-check
    timerRef.current = setInterval(check, CHECK_INTERVAL);

    return () => {
      cancelled = true;
      clearTimeout(initialDelay);
      clearInterval(timerRef.current);
    };
  }, [currentVersion]);

  const dismiss = () => setDismissed(true);

  return { ...state, dismissed, dismiss };
}
