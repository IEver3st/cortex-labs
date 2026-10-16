// Shared by the capture and export paths: what already exists at a
// destination, which write failures only mean "choose the folder again", how a
// Livery preview run is summarised, and the browser fallback that hands a file
// to the downloads bar. Pure or injectable so they run under node:test.

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function errorText(error) {
  if (typeof error === "string") return error;
  if (error && typeof error.message === "string") return error.message;
  return String(error ?? "");
}

/**
 * How many of `paths` already exist. A check that throws (unreadable or
 * out-of-scope path) counts as absent, matching the EUP export prompts.
 */
export async function countExistingFiles(paths, exists, { concurrency = 8 } = {}) {
  const list = Array.isArray(paths) ? paths.filter((path) => typeof path === "string" && path) : [];
  if (!list.length || typeof exists !== "function") return 0;
  let count = 0;
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const path = list[next];
      next += 1;
      try {
        if (await exists(path)) count += 1;
      } catch {
        // Treated as absent.
      }
    }
  };
  const workers = Math.max(1, Math.min(Number(concurrency) || 1, list.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return count;
}

/**
 * True when tauri-plugin-fs refused a path because it is outside the granted
 * scope ("forbidden path: …"), e.g. a folder picked in an earlier session.
 * Picking the folder again grants it; disk, lock and permission failures are
 * not fixed by a dialog and must be reported instead.
 */
export function isFsScopeError(error) {
  return /\bforbidden path\b/i.test(errorText(error));
}

/** "a", "a and b", "a, b and c". */
function listLabels(labels) {
  if (labels.length <= 1) return labels[0] || "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * What a Livery preview capture run produced, for the capture panel. `written`
 * counts files that reached disk; `skipped` names angles the viewer returned
 * no image for; `error` is the failure that stopped the run, if any.
 */
export function describePreviewRun({ total = 0, written = 0, skipped = [], error = "" } = {}) {
  const skippedLabels = Array.isArray(skipped) ? skipped.filter(Boolean) : [];
  const complete = total > 0 && written === total && skippedLabels.length === 0 && !error;
  const headline = written === 0
    ? "No shots saved"
    : complete
      ? `${plural(written, "shot")} saved`
      : `${written} of ${plural(total, "shot")} saved`;
  return {
    tone: complete ? "done" : written > 0 ? "partial" : "failed",
    headline,
    skippedNote: skippedLabels.length
      ? `The viewer returned no image for ${listLabels(skippedLabels)}, so ${skippedLabels.length === 1 ? "that angle wasn't" : "those angles weren't"} saved.`
      : "",
    error: error ? errorText(error) : "",
  };
}

/**
 * Browser-mode fallback: hands `bytes` to the browser as a download. The
 * object URL is revoked shortly after the click; revoking in the same task can
 * cancel the download in some browsers.
 */
export function downloadBytes(fileName, bytes, {
  mimeType = "application/octet-stream",
  doc = globalThis.document,
  urlApi = globalThis.URL,
  schedule = (fn, ms) => setTimeout(fn, ms),
} = {}) {
  if (!doc?.body || typeof urlApi?.createObjectURL !== "function") {
    throw new Error("This browser can't download files from the page.");
  }
  const url = urlApi.createObjectURL(new Blob([bytes], { type: mimeType }));
  try {
    const anchor = doc.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    doc.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    schedule(() => urlApi.revokeObjectURL(url), 1000);
  }
}
