/**
 * Changelog parser — reads structured markdown from changelog.md.
 *
 * FORMAT per version block (separated by `---`):
 *
 *   # Hero Title                          ← first H1 = hero title
 *   > Hero description sentence.          ← blockquote = hero description
 *
 *   ## New                                 ← H2 = section header (New / Improved / Fixed)
 *   - Short Title | One-line description   ← pipe separates title from desc
 *   - Another Item | Description here
 *
 *   ## Improved
 *   - Item Title | Description
 *
 *   ## Fixed
 *   - Bug Title | What was fixed
 *
 * Version is auto-read from package.json — never typed in the markdown.
 */

import changelogRaw from "../changelog.md?raw";
import appMeta from "../../package.json";

const WHATS_NEW_KEY = "cortex-labs:whats-new-seen";

/**
 * @typedef {Object} ChangeItem
 * @property {string} title   - Short title (≤6 words)
 * @property {string} desc    - One-line description (≤120 chars)
 * @property {string} tag     - "new" | "improved" | "fixed"
 */

/**
 * @typedef {Object} ChangelogEntry
 * @property {string}       version
 * @property {string}       heroTitle
 * @property {string}       heroDesc
 * @property {ChangeItem[]} items
 */

const TAG_MAP = {
  new: "new",
  added: "new",
  improved: "improved",
  changed: "improved",
  enhanced: "improved",
  fixed: "fixed",
  fix: "fixed",
  bugfix: "fixed",
};

function normalizeTag(headerText) {
  const key = headerText.trim().toLowerCase();
  return TAG_MAP[key] || "new";
}

/**
 * Parse a single version block into a structured entry.
 */
function parseBlock(block) {
  const lines = block.split("\n");
  let heroTitle = "";
  let heroDesc = "";
  let currentTag = "new";
  const items = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // H1 → hero title
    if (/^#\s+/.test(line) && !heroTitle) {
      heroTitle = line.replace(/^#\s+/, "");
      continue;
    }

    // Blockquote → hero description
    if (/^>\s*/.test(line)) {
      heroDesc = line.replace(/^>\s*/, "");
      continue;
    }

    // H2 → section tag
    if (/^##\s+/.test(line)) {
      currentTag = normalizeTag(line.replace(/^##\s+/, ""));
      continue;
    }

    // Bullet item
    if (/^[-*]\s+/.test(line)) {
      const content = line.replace(/^[-*]\s+/, "");
      const pipeIdx = content.indexOf("|");
      if (pipeIdx !== -1) {
        items.push({
          title: content.slice(0, pipeIdx).trim(),
          desc: content.slice(pipeIdx + 1).trim(),
          tag: currentTag,
        });
      } else {
        items.push({ title: content, desc: "", tag: currentTag });
      }
    }
  }

  return { heroTitle, heroDesc, items };
}

/**
 * Parse all version blocks from the raw changelog markdown.
 * Returns an array of ChangelogEntry ordered newest-first.
 */
export function parseChangelog(raw) {
  const blocks = raw
    .split(/^---$/m)
    .map((b) => b.trim())
    .filter(Boolean);

  return blocks.map((block) => {
    const parsed = parseBlock(block);
    return { version: appMeta.version, ...parsed };
  });
}

/**
 * Get the latest changelog entry with auto-versioning from package.json.
 * @returns {ChangelogEntry | null}
 */
export function getLatestChangelog() {
  const entries = parseChangelog(changelogRaw);
  if (!entries.length) return null;
  return entries[0];
}

/**
 * Check if the user has already seen the What's New for the current version.
 */
export function hasSeenWhatsNew() {
  try {
    const seen = localStorage.getItem(WHATS_NEW_KEY);
    return seen === appMeta.version;
  } catch {
    return false;
  }
}

/**
 * Mark the current version's What's New as seen.
 */
export function markWhatsNewSeen() {
  try {
    localStorage.setItem(WHATS_NEW_KEY, appMeta.version);
  } catch (err) {
    console.error("[Changelog] Failed to mark as seen:", err);
  }
}

/**
 * Generate a Discord-friendly markdown string from a changelog entry.
 */
export function toMarkdown(entry) {
  if (!entry) return "";
  const lines = [`## What's New in Cortex Studio v${entry.version}`, ""];

  if (entry.heroTitle) {
    lines.push(`**${entry.heroTitle}**`);
    if (entry.heroDesc) lines.push(entry.heroDesc);
    lines.push("");
  }

  const groups = { new: [], improved: [], fixed: [] };
  for (const item of entry.items) {
    const bucket = groups[item.tag] || groups.new;
    bucket.push(item);
  }

  const labels = { new: "New", improved: "Improved", fixed: "Fixed" };
  for (const [key, label] of Object.entries(labels)) {
    if (groups[key].length === 0) continue;
    lines.push(`### ${label}`);
    for (const item of groups[key]) {
      lines.push(item.desc ? `- **${item.title}** — ${item.desc}` : `- ${item.title}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Get the app version string.
 */
export function getAppVersion() {
  return appMeta.version;
}
