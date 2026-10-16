/**
 * Bundled release notes for What's New. The format and parser live in
 * `./changelog-core.js`; this module binds them to `src/changelog.md`,
 * package.json, the seen-version flag, and the user's preference.
 */

import changelogRaw from "../changelog.md?raw";
import appMeta from "../../package.json";
import { loadPrefs } from "./prefs";
import { parseChangelog, shouldAutoOpen, toMarkdown as releaseToMarkdown } from "./changelog-core";

export { parseChangelog } from "./changelog-core";

const WHATS_NEW_KEY = "cortex-labs:whats-new-seen";

let cachedEntries = null;

/** Every release in `src/changelog.md`, newest first. Parsed once per session. */
export function getChangelog() {
  if (!cachedEntries) cachedEntries = parseChangelog(changelogRaw, { appVersion: appMeta.version });
  return cachedEntries;
}

/** The newest release, or null when the changelog is empty. */
export function getLatestChangelog() {
  return getChangelog()[0] || null;
}

/** True when the newest release notes describe the installed version. */
export function hasNotesForAppVersion() {
  return getLatestChangelog()?.version === appMeta.version;
}

function readSeenVersion() {
  try {
    return localStorage.getItem(WHATS_NEW_KEY);
  } catch {
    return null;
  }
}

/** Check if the user has already seen the What's New for the current version. */
export function hasSeenWhatsNew() {
  return readSeenVersion() === appMeta.version;
}

/** Mark the current version's What's New as seen. */
export function markWhatsNewSeen() {
  try {
    localStorage.setItem(WHATS_NEW_KEY, appMeta.version);
  } catch (err) {
    console.error("[Changelog] Failed to mark as seen:", err);
  }
}

/**
 * Startup rule: open once for the installed version's own notes, unless the
 * user turned off "Show What's New after updates".
 */
export function shouldAutoOpenWhatsNew() {
  return shouldAutoOpen({
    entries: getChangelog(),
    appVersion: appMeta.version,
    seenVersion: readSeenVersion(),
    prefs: loadPrefs(),
  });
}

/** Markdown for a single release. */
export function toMarkdown(entry) {
  return releaseToMarkdown(entry);
}

/** Get the app version string. */
export function getAppVersion() {
  return appMeta.version;
}
