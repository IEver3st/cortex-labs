import { useEffect, useRef, useState } from "react";

const GITHUB_OWNER = "IEver3st";
const GITHUB_REPO = "cortex-labs";
const CHECK_INTERVAL = 30 * 60 * 1000;

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

async function fetchLatestRelease() {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
    { headers: { Accept: "application/vnd.github+json" } },
  );
  if (!res.ok) return null;
  const data = await res.json();
  return {
    tag: data.tag_name,
    version: data.tag_name.replace(/^v/, ""),
    url: data.html_url,
    notes: data.body || "",
    name: data.name || data.tag_name,
  };
}

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
      }
    };

    const initialDelay = setTimeout(check, 5000);

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
