// Plain-language lists of unsaved edits: what a draft changes against the file
// it came from. The format modules (siren-settings.js, els-vcf.js) name their
// fields; this walks the values and formats them.

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPrimitiveList(value) {
  return Array.isArray(value) && value.every((entry) => entry === null || typeof entry !== "object");
}

/** Leaf differences between two plain values: [{ path, before, after }].
    Lists of plain values compare whole; `skip` names keys that never count. */
export function leafChanges(before, after, { skip = [], prefix = "" } = {}) {
  const out = [];
  const walk = (a, b, path) => {
    if (a === b) return;
    if (isObject(a) && isObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (skip.includes(key)) continue;
        walk(a[key], b[key], path ? `${path}.${key}` : key);
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b) && !isPrimitiveList(a) && !isPrimitiveList(b) && a.length === b.length) {
      a.forEach((entry, index) => walk(entry, b[index], `${path}.${index}`));
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, before: a, after: b });
  };
  walk(before, after, prefix);
  return out;
}

export function formatChangeValue(value) {
  if (value === true) return "on";
  if (value === false) return "off";
  if (value == null || value === "") return "none";
  if (typeof value === "number") return String(Math.round(value * 1000) / 1000);
  if (Array.isArray(value)) return value.length ? value.map(formatChangeValue).join(", ") : "none";
  return String(value);
}

/** "1-4, 7, 9-10" from whole numbers. */
export function compactNumbers(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const runs = [];
  for (const value of sorted) {
    const run = runs[runs.length - 1];
    if (run && value === run[1] + 1) run[1] = value;
    else runs.push([value, value]);
  }
  return runs.map(([from, to]) => (from === to ? `${from}` : to === from + 1 ? `${from}, ${to}` : `${from}-${to}`)).join(", ");
}

/** Readable words from a camelCase key. */
export function humanizeKey(key) {
  return String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

/**
 * One line for a set of leaf changes on one item: "colour #0000ff → #ff0000"
 * when one plain value changed, else the changed fields' labels. `label(path)`
 * names a field or returns null to hide it; `quiet(path)` marks values too
 * long to print (patterns).
 */
export function describeFields(changes, label, quiet = () => false) {
  const named = changes.map((change) => ({ ...change, name: label(change.path) })).filter((change) => change.name);
  const names = [...new Set(named.map((change) => change.name))];
  if (!names.length) return "";
  if (named.length === 1 && !quiet(named[0].path)) {
    const [change] = named;
    return `${change.name} ${formatChangeValue(change.before)} → ${formatChangeValue(change.after)}`;
  }
  return names.join(", ");
}

/** Items with the same change in one line: "Sirens 2-5: flash pattern". */
export function groupByChange(entries, noun, plural) {
  const groups = new Map();
  for (const { index, text } of entries) {
    if (!text) continue;
    if (!groups.has(text)) groups.set(text, []);
    groups.get(text).push(index);
  }
  return [...groups.entries()].map(([text, indices]) => `${indices.length === 1 ? noun : plural} ${compactNumbers(indices)}: ${text}`);
}
