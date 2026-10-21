import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  compareSemver,
  filterItems,
  formatReleaseDate,
  groupByKind,
  normalizeKind,
  parseChangelog,
  shouldAutoOpen,
  splitInlineCode,
  toMarkdown,
} from "./changelog-core.js";

const SAMPLE = `# PRISM
version: 4.1.0
date: 2026-08-12
> Cleans up the Studio.

## New
- Themes | 12 presets
## Improved
- Lighting | Easier to adjust
## Fixed
- Seams | Tabs connect
---
# ROAN
version: 4.0.0
date: 2026-07-02

## Added
- Slot colors | Per-slot paint
`;

test("reads per-release version, date, name, summary, and items", () => {
  const [prism, roan] = parseChangelog(SAMPLE, { appVersion: "5.0.0" });
  assert.equal(prism.version, "4.1.0");
  assert.equal(prism.date, "2026-08-12");
  assert.equal(prism.name, "PRISM");
  assert.equal(prism.summary, "Cleans up the Studio.");
  assert.deepEqual(prism.counts, { new: 1, improved: 1, fixed: 1 });
  assert.deepEqual(prism.items[0], { id: "4.1.0:0", kind: "new", title: "Themes", desc: "12 presets" });
  assert.equal(roan.version, "4.0.0");
  assert.equal(roan.items[0].kind, "new");
});

test("does not stamp every block with the app version", () => {
  const versions = parseChangelog(SAMPLE, { appVersion: "5.0.0" }).map((e) => e.version);
  assert.deepEqual(versions, ["4.1.0", "4.0.0"]);
});

test("only the first block may fall back to the app version", () => {
  const raw = `# NEXT\n- A | a\n---\n# LOST\n- B | b\n---\nversion: 1.0.0\n- C | c`;
  const entries = parseChangelog(raw, { appVersion: "v2.0.0" });
  assert.deepEqual(entries.map((e) => e.version), ["2.0.0", "1.0.0"]);
  assert.equal(entries[0].name, "NEXT");
  assert.equal(entries.find((e) => e.name === "LOST"), undefined);
});

test("first block without version and no app version is dropped", () => {
  assert.deepEqual(parseChangelog("# X\n- A | a"), []);
});

test("tolerates missing name, date, and summary", () => {
  const [entry] = parseChangelog("version: 3.8.1\n## Fixed\n- Camera bug fixes");
  assert.equal(entry.name, "");
  assert.equal(entry.date, "");
  assert.equal(entry.summary, "");
  assert.deepEqual(entry.items[0], { id: "3.8.1:0", kind: "fixed", title: "Camera bug fixes", desc: "" });
});

test("normalizes section aliases and ignores unknown sections", () => {
  assert.equal(normalizeKind("Added"), "new");
  assert.equal(normalizeKind("changed"), "improved");
  assert.equal(normalizeKind(" Enhanced: "), "improved");
  assert.equal(normalizeKind("Performance"), "improved");
  assert.equal(normalizeKind("Fix"), "fixed");
  assert.equal(normalizeKind("BUGFIX"), "fixed");
  assert.equal(normalizeKind("Bug fixes"), "fixed");
  assert.equal(normalizeKind("Removed"), null);
  assert.equal(normalizeKind(undefined), null);

  const [entry] = parseChangelog(
    "version: 1.2.0\n- Early | before any section\n## Removed\n- Dropped | x\n## Bugfix\n- Kept | y",
  );
  assert.deepEqual(entry.items.map((i) => [i.kind, i.title]), [["new", "Early"], ["fixed", "Kept"]]);
});

test("ignores malformed lines without crashing", () => {
  const raw = [
    "version: not-a-version",
    "version: 2.1.0",
    "date: 2026-13-40",
    "date: 2026-02-01",
    "random prose line",
    "###",
    "## ",
    "-",
    "- ",
    "- | description without a title",
    "- Pipe only |",
    "* Star bullet | ok",
    "> ",
    "-not a bullet",
  ].join("\n");
  const [entry] = parseChangelog(raw);
  assert.equal(entry.version, "2.1.0");
  assert.equal(entry.date, "2026-02-01");
  assert.deepEqual(entry.items.map((i) => [i.title, i.desc]), [["Pipe only", ""], ["Star bullet", "ok"]]);

  for (const bad of [undefined, null, 42, {}, "", "   ", "---\n---\n---", "\u0000\n|||"]) {
    assert.doesNotThrow(() => parseChangelog(bad, { appVersion: "1.0.0" }));
  }
  assert.deepEqual(parseChangelog("---\n---", { appVersion: "1.0.0" }), []);
});

test("handles CRLF line endings and duplicate versions", () => {
  const raw = "# A\r\nversion: 1.0.0\r\n- One | 1\r\n---\r\n# B\r\nversion: 1.0.0\r\n- Two | 2\r\n";
  const entries = parseChangelog(raw);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "A");
  assert.equal(entries[0].items[0].desc, "1");
});

test("sorts newest first by semver, not by string or file order", () => {
  const raw = ["1.9.0", "1.10.0", "2.0.0-beta.2", "2.0.0", "2.0.0-beta.10", "0.9.9"]
    .map((v) => `version: ${v}\n- Item`)
    .join("\n---\n");
  assert.deepEqual(
    parseChangelog(raw).map((e) => e.version),
    ["2.0.0", "2.0.0-beta.10", "2.0.0-beta.2", "1.10.0", "1.9.0", "0.9.9"],
  );
  assert.equal(compareSemver("v1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("bad", "1.0.0"), -1);
});

test("formats full and month-only dates without locale", () => {
  assert.equal(formatReleaseDate("2026-08-12"), "Aug 12, 2026");
  assert.equal(formatReleaseDate("2025-12"), "Dec 2025");
  assert.equal(formatReleaseDate("soon"), "");
  assert.equal(formatReleaseDate(undefined), "");
});

test("filters by kind and query, and groups in display order", () => {
  const [entry] = parseChangelog(SAMPLE);
  assert.equal(filterItems(entry, { kind: "fixed" }).length, 1);
  assert.equal(filterItems(entry, { query: "PRESETS" }).length, 1);
  assert.equal(filterItems(entry, { kind: "fixed", query: "presets" }).length, 0);
  assert.equal(filterItems(entry, { query: "   " }).length, 3);
  assert.deepEqual(filterItems(null), []);
  assert.deepEqual(groupByKind(entry.items).map((g) => g.kind), ["new", "improved", "fixed"]);
  assert.deepEqual(groupByKind(filterItems(entry, { kind: "improved" })).map((g) => g.label), ["Improved"]);
});

test("splits inline code spans", () => {
  assert.deepEqual(splitInlineCode("Supports `.ydd` files"), [
    { code: false, text: "Supports " },
    { code: true, text: ".ydd" },
    { code: false, text: " files" },
  ]);
  assert.deepEqual(splitInlineCode("unclosed `tick"), [{ code: false, text: "unclosed `tick" }]);
  assert.deepEqual(splitInlineCode(""), []);
});

test("auto-open only for the installed version's unseen notes when allowed", () => {
  const entries = parseChangelog(SAMPLE);
  const base = { entries, appVersion: "4.1.0", seenVersion: null, prefs: null };
  assert.equal(shouldAutoOpen(base), true);
  assert.equal(shouldAutoOpen({ ...base, seenVersion: "4.1.0" }), false);
  assert.equal(shouldAutoOpen({ ...base, seenVersion: "4.0.0" }), true);
  assert.equal(shouldAutoOpen({ ...base, appVersion: "5.0.0" }), false);
  assert.equal(shouldAutoOpen({ ...base, prefs: { defaults: { showWhatsNewOnUpdate: false } } }), false);
  assert.equal(shouldAutoOpen({ ...base, prefs: { defaults: { showWhatsNewOnUpdate: true } } }), true);
  assert.equal(shouldAutoOpen({ ...base, prefs: { defaults: {} } }), true);
  assert.equal(shouldAutoOpen({ ...base, entries: [] }), false);
  assert.equal(shouldAutoOpen(), false);
});

test("toMarkdown renders one release", () => {
  const [entry] = parseChangelog(SAMPLE);
  const md = toMarkdown(entry);
  assert.match(md, /^## Cortex Studio 4\.1\.0 PRISM\n_Released Aug 12, 2026_/);
  assert.match(md, /### New\n- \*\*Themes\*\*: 12 presets/);
  assert.match(md, /### Fixed\n- \*\*Seams\*\*: Tabs connect$/);
  assert.equal(toMarkdown(null), "");
});

test("bundled src/changelog.md parses into ordered, dated releases", () => {
  const raw = readFileSync(fileURLToPath(new URL("../changelog.md", import.meta.url)), "utf8");
  const entries = parseChangelog(raw, { appVersion: "5.4.0" });
  const versions = entries.map((e) => e.version);
  assert.deepEqual(versions, [
    "5.4.0", "5.3.5", "5.3.0", "5.2.0", "5.1.1", "5.1.0", "5.0.4", "5.0.3", "5.0.2", "5.0.1", "5.0.0", "4.1.0", "4.0.0", "3.8.1", "3.8.0", "3.7.0", "3.5.0", "3.1.1", "3.1.0", "3.0.0", "2.3.3", "1.0.0",
  ]);
  for (const entry of entries) {
    assert.ok(entry.date, `${entry.version} has a date`);
    assert.ok(entry.items.length > 0, `${entry.version} has items`);
    for (const item of entry.items) assert.ok(item.title, `${entry.version} item has a title`);
  }
  // The installed version's notes come first, so they open after an update.
  assert.equal(entries[0].version, "5.4.0");
  assert.ok(entries[0].summary, "5.4.0 has a summary");
  assert.equal(entries[11].name, "PRISM");
  assert.equal(entries[12].name, "ROAN");
});
