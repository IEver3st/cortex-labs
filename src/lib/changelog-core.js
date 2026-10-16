/**
 * In-app release notes: a pure parser and helpers for `src/changelog.md`.
 *
 * This module has no Vite, DOM, or storage dependencies so it can run under
 * `node --test`. `src/lib/changelog.js` wires it to the bundled markdown,
 * package.json, and localStorage.
 *
 * `src/changelog.md` is the What's New source. It is deliberately separate
 * from the repository `CHANGELOG.md`: short, user-facing, one line per change.
 *
 * FORMAT. Releases are separated by a line containing only `---`.
 *
 *   # PRISM                                 first H1: release codename (optional)
 *   version: 4.1.0                          semver, `v` prefix allowed
 *   date: 2026-08-12                        YYYY-MM-DD or YYYY-MM (optional)
 *   > One-sentence summary.                 blockquote lines join into the summary (optional)
 *
 *   ## New                                  section: New | Added | Features
 *   - Title | One-line description          pipe splits title from description
 *   - Title only                            description is optional
 *
 *   ## Improved                             Improved | Changed | Enhanced | Performance | Updated
 *   ## Fixed                                Fixed | Fix | Fixes | Bugfix | Bugfixes
 *
 * Rules:
 * - Metadata keys are case-insensitive; the first valid value wins.
 * - Only the first block may omit `version:`; it then takes the app version.
 *   Any later block without a valid version is dropped, because it cannot be
 *   placed on the timeline.
 * - Items before any section header count as New. Items under an
 *   unrecognised section header are ignored rather than guessed.
 * - Unrecognised lines, empty bullets, and bullets without a title are
 *   ignored. Parsing never throws on string input.
 * - Duplicate versions keep the first block. Releases sort newest first by
 *   semver; a pre-release sorts below its release.
 * - Inline `code` spans stay in the text; `splitInlineCode` renders them.
 */

export const KINDS = Object.freeze(["new", "improved", "fixed"]);

export const KIND_LABELS = Object.freeze({
  new: "New",
  improved: "Improved",
  fixed: "Fixed",
});

const KIND_ALIASES = {
  new: "new",
  added: "new",
  add: "new",
  feature: "new",
  features: "new",
  improved: "improved",
  improvements: "improved",
  changed: "improved",
  changes: "improved",
  enhanced: "improved",
  enhancements: "improved",
  performance: "improved",
  updated: "improved",
  fixed: "fixed",
  fix: "fixed",
  fixes: "fixed",
  bugfix: "fixed",
  bugfixes: "fixed",
  "bug fixes": "fixed",
};

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const DATE_RE = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Map a section header to a kind, or null when it is not a release-notes section. */
export function normalizeKind(header) {
  if (typeof header !== "string") return null;
  const key = header.trim().toLowerCase().replace(/[:\s]+$/, "").replace(/\s+/g, " ");
  return KIND_ALIASES[key] || null;
}

/** Parse a semver string into comparable parts, or null when invalid. */
export function parseSemver(value) {
  if (typeof value !== "string") return null;
  const match = SEMVER_RE.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] || "",
    text: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`,
  };
}

/** Normalise a version string (`v4.1.0` -> `4.1.0`), or "" when invalid. */
export function normalizeVersion(value) {
  return parseSemver(value)?.text || "";
}

function comparePre(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]) ? Number(pa[i]) : null;
    const nb = /^\d+$/.test(pb[i]) ? Number(pb[i]) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (na !== null) {
      return -1;
    } else if (nb !== null) {
      return 1;
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

/** Compare two version strings. Invalid versions sort below valid ones. */
export function compareSemver(a, b) {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  if (!va || !vb) return (va ? 1 : 0) - (vb ? 1 : 0);
  return (
    Math.sign(va.major - vb.major)
    || Math.sign(va.minor - vb.minor)
    || Math.sign(va.patch - vb.patch)
    || comparePre(va.pre, vb.pre)
  );
}

function normalizeDate(value) {
  const match = DATE_RE.exec(value.trim());
  if (!match) return "";
  const month = Number(match[2]);
  if (month < 1 || month > 12) return "";
  if (match[3] !== undefined) {
    const day = Number(match[3]);
    if (day < 1 || day > 31) return "";
  }
  return match[0];
}

/** Format `2026-08-12` as `Aug 12, 2026` and `2026-01` as `Jan 2026`. Locale-independent. */
export function formatReleaseDate(date) {
  if (typeof date !== "string") return "";
  const match = DATE_RE.exec(date.trim());
  if (!match) return "";
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return "";
  return match[3] ? `${month} ${Number(match[3])}, ${match[1]}` : `${month} ${match[1]}`;
}

/** Split text into plain and inline-code segments for rendering. */
export function splitInlineCode(text) {
  if (typeof text !== "string" || !text) return [];
  const segments = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) segments.push({ code: false, text: text.slice(last, match.index) });
    segments.push({ code: true, text: match[1] });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ code: false, text: text.slice(last) });
  return segments;
}

/** Count items by kind. */
export function countKinds(items) {
  const counts = { new: 0, improved: 0, fixed: 0 };
  if (!Array.isArray(items)) return counts;
  for (const item of items) {
    if (item && Object.hasOwn(counts, item.kind)) counts[item.kind] += 1;
  }
  return counts;
}

function parseBlock(block) {
  let name = "";
  let version = "";
  let date = "";
  const summary = [];
  const items = [];
  let kind = "new";

  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1) {
      if (!name) name = h1[1].trim();
      continue;
    }

    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      kind = normalizeKind(h2[1]);
      continue;
    }

    const meta = /^(version|date)\s*:\s*(.*)$/i.exec(line);
    if (meta) {
      const key = meta[1].toLowerCase();
      if (key === "version" && !version) version = normalizeVersion(meta[2]);
      if (key === "date" && !date) date = normalizeDate(meta[2]);
      continue;
    }

    if (line.startsWith(">")) {
      const text = line.replace(/^>\s*/, "").trim();
      if (text) summary.push(text);
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!kind) continue;
      const content = bullet[1].trim();
      const pipe = content.indexOf("|");
      const title = (pipe === -1 ? content : content.slice(0, pipe)).trim();
      const desc = pipe === -1 ? "" : content.slice(pipe + 1).trim();
      if (!title) continue;
      items.push({ kind, title, desc });
    }
  }

  return { name, version, date, summary: summary.join(" "), items };
}

/**
 * Parse changelog markdown into releases, newest first.
 * @param {string} raw
 * @param {{ appVersion?: string }} [options]
 * @returns {Array<{ version: string, name: string, date: string, summary: string,
 *   items: Array<{ id: string, kind: "new"|"improved"|"fixed", title: string, desc: string }>,
 *   counts: { new: number, improved: number, fixed: number } }>}
 */
export function parseChangelog(raw, { appVersion = "" } = {}) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const fallbackVersion = normalizeVersion(appVersion);
  const blocks = raw
    .split(/^\s*---+\s*$/m)
    .map((block) => block.trim())
    .filter(Boolean);

  const seen = new Set();
  const entries = [];
  blocks.forEach((block, index) => {
    const parsed = parseBlock(block);
    if (!parsed.name && !parsed.summary && !parsed.items.length) return;
    const version = parsed.version || (index === 0 ? fallbackVersion : "");
    if (!version || seen.has(version)) return;
    seen.add(version);
    const items = parsed.items.map((item, i) => ({ id: `${version}:${i}`, ...item }));
    entries.push({
      version,
      name: parsed.name,
      date: parsed.date,
      summary: parsed.summary,
      items,
      counts: countKinds(items),
    });
  });

  return entries.sort((a, b) => compareSemver(b.version, a.version));
}

/** Case-insensitive search over title and description. Empty query matches everything. */
export function matchesQuery(item, query) {
  const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!needle) return true;
  if (!item) return false;
  return `${item.title || ""} ${item.desc || ""}`.toLowerCase().includes(needle);
}

/** Items of one release matching a kind filter ("all" or a kind) and a search query. */
export function filterItems(entry, { kind = "all", query = "" } = {}) {
  if (!entry || !Array.isArray(entry.items)) return [];
  return entry.items.filter(
    (item) => (kind === "all" || item.kind === kind) && matchesQuery(item, query),
  );
}

/** Group items by kind in display order, omitting empty groups. */
export function groupByKind(items) {
  const groups = KINDS.map((kind) => ({ kind, label: KIND_LABELS[kind], items: [] }));
  for (const item of items || []) {
    groups.find((group) => group.kind === item?.kind)?.items.push(item);
  }
  return groups.filter((group) => group.items.length);
}

/**
 * Decide whether release notes open by themselves at startup: only for the
 * installed version's own notes, once, and only when the user allows it.
 */
export function shouldAutoOpen({ entries, appVersion, seenVersion, prefs } = {}) {
  if (prefs?.defaults?.showWhatsNewOnUpdate === false) return false;
  const current = normalizeVersion(appVersion);
  if (!current || !Array.isArray(entries) || !entries.length) return false;
  if (entries[0].version !== current) return false;
  return seenVersion !== appVersion && seenVersion !== current;
}

/** Markdown for one release, suitable for Discord or a GitHub release body. */
export function toMarkdown(entry) {
  if (!entry || !Array.isArray(entry.items)) return "";
  const heading = [`Cortex Studio ${entry.version}`, entry.name].filter(Boolean).join(" ");
  const lines = [`## ${heading}`];
  if (entry.date) lines.push(`_Released ${formatReleaseDate(entry.date) || entry.date}_`);
  lines.push("");
  if (entry.summary) lines.push(entry.summary, "");
  for (const group of groupByKind(entry.items)) {
    lines.push(`### ${group.label}`);
    for (const item of group.items) {
      lines.push(item.desc ? `- **${item.title}**: ${item.desc}` : `- ${item.title}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
