// Renaming a vehicle's model across its resource: the meta entries and script
// strings that name it, and its stream files. Pure; the caller lists, reads,
// backs up and writes the files and renames the stream files.
//
// Matching is exact, never a substring: a meta element whose whole text is the
// old name (<modelName>, <txdName>, <handlingId>, <gameName>, <handlingName>,
// txdRelationships, ...) and a Lua string literal equal to it (ulc.lua names,
// AddTextEntry keys). Mod kits and mod part names that only start with the old
// name are left alone.

const NAME = /^[a-z0-9_]{1,32}$/i;

/** Problems with a new model name, or "" when it is usable. */
export function checkModelName(name, current = "") {
  const value = String(name || "").trim();
  if (!value) return "Enter a new model name.";
  if (!NAME.test(value)) return "Use letters, digits and underscores only, up to 32 characters.";
  if (/_hi$/i.test(value)) return "A model name cannot end in _hi; that suffix names the high-detail model file.";
  if (current && value.toLowerCase() === String(current).toLowerCase()) return "That is already the model's name.";
  return "";
}

/** A warning that does not block renaming, or "". */
export function modelNameWarning(name) {
  return String(name || "").trim().length > 11
    ? "Names over 11 characters can break the vehicle's display name and some lighting scripts in game."
    : "";
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Keeps the case style of the occurrence it replaces.
function cased(found, replacement) {
  if (found === found.toUpperCase() && found !== found.toLowerCase()) return replacement.toUpperCase();
  if (found === found.toLowerCase()) return replacement.toLowerCase();
  return replacement;
}

/** Renames `from` in meta XML text. Returns { text, count }. */
export function renameInMetaText(text, from, to) {
  let count = 0;
  const pattern = new RegExp(`>(\\s*)(${escapeRegExp(from)})(\\s*)<`, "gi");
  const next = String(text).replace(pattern, (match, before, found, after) => {
    count += 1;
    return `>${before}${cased(found, to)}${after}<`;
  });
  return { text: next, count };
}

/** Renames `from` in Lua string literals that hold exactly it. Returns { text, count }. */
export function renameInLuaText(text, from, to) {
  let count = 0;
  const pattern = new RegExp(`(["'])(${escapeRegExp(from)})\\1`, "gi");
  const next = String(text).replace(pattern, (match, quote, found) => {
    count += 1;
    return `${quote}${cased(found, to)}${quote}`;
  });
  return { text: next, count };
}

// Scripts that are not plain text (escrow-encrypted Lua, binaries) are never rewritten.
function isPlainText(text) {
  return typeof text === "string" && !text.includes("\u0000") && !text.includes("�");
}

function baseName(path) {
  return String(path).split(/[\\/]/).pop();
}

function dirName(path) {
  const value = String(path);
  const at = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return at >= 0 ? value.slice(0, at + 1) : "";
}

/**
 * The stream file renames for `from`: the model (`from.yft`, `from_hi.yft`) and
 * its texture dictionaries (`from.ytd`, `from+hi.ytd`). Returns [{ from, to }].
 */
export function planStreamRenames(paths, from, to) {
  const pattern = new RegExp(`^(${escapeRegExp(from)})(_hi|\\+hi)?\\.(yft|ytd)$`, "i");
  return (paths || []).flatMap((path) => {
    const match = pattern.exec(baseName(path));
    if (!match) return [];
    return [{ from: path, to: `${dirName(path)}${cased(match[1], to)}${match[2] || ""}.${match[3]}` }];
  });
}

/**
 * Plans a rename. `files`: [{ path, text }] meta and Lua files of the resource.
 * `streamPaths`: every file path in the resource (stream files are picked from
 * them). `takenNames`: model names other vehicles in the resource use.
 * Returns { error, edits: [{ path, text, count, kind }], renames: [{ from, to }], skipped: [path] }.
 */
export function planVehicleRename({ files = [], streamPaths = [], takenNames = [], from, to }) {
  const oldName = String(from || "").trim();
  const newName = String(to || "").trim();
  const empty = { edits: [], renames: [], skipped: [] };
  const problem = checkModelName(newName, oldName);
  if (!oldName) return { ...empty, error: "No model is loaded." };
  if (problem) return { ...empty, error: problem };
  if (takenNames.some((name) => String(name).toLowerCase() === newName.toLowerCase())) {
    return { ...empty, error: `Another vehicle in this resource is already called ${newName}.` };
  }
  const edits = [];
  const skipped = [];
  for (const file of files) {
    const lua = /\.lua$/i.test(file.path);
    if (lua && /(^|[\\/])(fxmanifest|__resource)\.lua$/i.test(file.path)) continue;
    if (!isPlainText(file.text)) {
      skipped.push(file.path);
      continue;
    }
    const result = lua ? renameInLuaText(file.text, oldName, newName) : renameInMetaText(file.text, oldName, newName);
    if (result.count) edits.push({ path: file.path, text: result.text, count: result.count, kind: lua ? "script" : "meta" });
  }
  const renames = planStreamRenames(streamPaths, oldName, newName);
  const existing = new Set((streamPaths || []).map((path) => String(path).replace(/\\/g, "/").toLowerCase()));
  const clash = renames.find((entry) => existing.has(entry.to.replace(/\\/g, "/").toLowerCase()));
  if (clash) return { ...empty, error: `${baseName(clash.to)} already exists.` };
  if (!edits.length && !renames.length) return { ...empty, skipped, error: `Nothing in this resource names ${oldName}.` };
  return { error: "", edits, renames, skipped };
}
