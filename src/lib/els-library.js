// Where a vehicle's VCF lives and what the user chose for it. ELS scripts read
// VCFs from their own folders (LSPDFR: GTA V/ELS/pack_default; ELS-FiveM:
// resources/ELS-FiveM/vcf; MISS-ELS: resources/MISS-ELS/xmlFiles), named after
// the vehicle's model, so a VCF rarely sits next to the model. The user adds
// those folders once and Cortex looks up <model>.xml in each.
// Pure apart from the injected readDir/readTextFile; storage is passed in.

import { isVcfText } from "./els-vcf.js";

export const ELS_LINKS_KEY = "cortex-studio:els-links.v1";
export const ELS_FOLDERS_KEY = "cortex-studio:els-folders.v1";
const MAX_LINKS = 300;
const MAX_FOLDERS = 12;
const MAX_VCF_BYTES = 2 * 1024 * 1024;
// Folder names vehicle downloads and ELS scripts keep VCFs in.
const VCF_FOLDER_NAMES = /^(vcf|vcfs|xmlfiles|els|pack_default)$/i;

function joinPath(dir, name) {
  const separator = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name}` : `${dir}${separator}${name}`;
}

export function parentDir(path) {
  const text = String(path || "");
  const index = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return index > 0 ? text.slice(0, index) : "";
}

export function baseName(path) {
  return String(path || "").split(/[\\/]/).pop();
}

/** The model name ELS matches VCFs by: the .yft file name without extension. */
export function modelNameFromPath(modelPath) {
  return baseName(modelPath).replace(/\.(yft|clmesh)$/i, "").replace(/_hi$/i, "");
}

export function vcfFileName(modelName) {
  return `${modelName}.xml`;
}

function pathKey(path) {
  return String(path || "").replace(/\\/g, "/").toLowerCase();
}

// ---------------------------------------------------------------------------
// Persistence

function readJson(storage, key, fallback) {
  try {
    const text = storage?.getItem(key);
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

/** { [modelPathKey]: { vcfPath, enabled } }: the user's choices per model. */
export function loadElsLinks(storage = globalThis.localStorage) {
  const raw = readJson(storage, ELS_LINKS_KEY, {});
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    out[key] = {
      vcfPath: typeof entry.vcfPath === "string" ? entry.vcfPath : "",
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : null,
      at: Number.isFinite(entry.at) ? entry.at : 0,
    };
  }
  return out;
}

export function linkFor(links, modelPath) {
  return modelPath ? links?.[pathKey(modelPath)] || null : null;
}

/** New links with `patch` applied to the model's entry; the oldest drop past the cap. */
export function withLink(links, modelPath, patch, now = Date.now()) {
  const key = pathKey(modelPath);
  const next = { ...(links || {}), [key]: { vcfPath: "", enabled: null, ...(links?.[key] || {}), ...patch, at: now } };
  const keys = Object.keys(next);
  if (keys.length > MAX_LINKS) {
    keys.sort((a, b) => (next[a].at || 0) - (next[b].at || 0));
    for (const old of keys.slice(0, keys.length - MAX_LINKS)) delete next[old];
  }
  return next;
}

export function saveElsLinks(links, storage = globalThis.localStorage) {
  return writeJson(storage, ELS_LINKS_KEY, links);
}

/** The user's ELS folders: [{ path, kind }]. */
export function loadElsFolders(storage = globalThis.localStorage) {
  const raw = readJson(storage, ELS_FOLDERS_KEY, []);
  return (Array.isArray(raw) ? raw : [])
    .filter((entry) => entry && typeof entry.path === "string" && entry.path)
    .map((entry) => ({ path: entry.path, kind: typeof entry.kind === "string" ? entry.kind : "folder" }))
    .slice(0, MAX_FOLDERS);
}

export function saveElsFolders(folders, storage = globalThis.localStorage) {
  return writeJson(storage, ELS_FOLDERS_KEY, folders.slice(0, MAX_FOLDERS));
}

export function withFolder(folders, folder) {
  const rest = (folders || []).filter((entry) => pathKey(entry.path) !== pathKey(folder.path));
  return [...rest, folder].slice(-MAX_FOLDERS);
}

export function withoutFolder(folders, path) {
  return (folders || []).filter((entry) => pathKey(entry.path) !== pathKey(path));
}

/**
 * Which script a folder belongs to, from its name and neighbours:
 * "lspdfr" (ELS V8 pack_default), "els-fivem" (vcf/ beside vcf.lua),
 * "miss-els" (xmlFiles/), or "folder".
 */
export function elsFolderKind(path, { hasVcfLua = false } = {}) {
  const name = baseName(path).toLowerCase();
  if (name === "pack_default" || /[\\/]els[\\/]pack_default$/i.test(path)) return "lspdfr";
  if (name === "xmlfiles") return "miss-els";
  if (name === "vcf" && hasVcfLua) return "els-fivem";
  return "folder";
}

export const ELS_FOLDER_LABELS = Object.freeze({
  lspdfr: "ELS V8 (LSPDFR)",
  "els-fivem": "ELS-FiveM",
  "miss-els": "MISS-ELS",
  folder: "VCF folder",
});

// ---------------------------------------------------------------------------
// Discovery

async function listDir(readDir, dir) {
  try {
    return await readDir(dir);
  } catch {
    return [];
  }
}

// `readTextFile` returns the text, or { text, encoding }.
async function readVcf(readTextFile, path) {
  try {
    const read = await readTextFile(path);
    const text = typeof read === "string" ? read : read?.text;
    if (typeof text !== "string" || text.length > MAX_VCF_BYTES || !isVcfText(text)) return null;
    return { text, encoding: typeof read === "string" ? null : read.encoding ?? null };
  } catch {
    return null;
  }
}

async function findIn(readDir, readTextFile, dir, wanted) {
  for (const entry of await listDir(readDir, dir)) {
    if (entry?.isDirectory || String(entry?.name || "").toLowerCase() !== wanted) continue;
    const path = joinPath(dir, entry.name);
    const read = await readVcf(readTextFile, path);
    if (read) return { path, ...read };
  }
  return null;
}

/**
 * Looks for the model's VCF: the linked file, then <model>.xml beside the
 * model, in its resource (and VCF-named subfolders), then in each ELS folder.
 * Returns { path, text, encoding, origin: "linked" | "model" | "resource" | "folder" } or null.
 * Unreadable folders are skipped: discovery never fails, it finds nothing.
 */
export async function findVcf({ modelPath, modelName = modelNameFromPath(modelPath), linkedPath = "", folders = [], readDir, readTextFile }) {
  if (linkedPath) {
    const read = await readVcf(readTextFile, linkedPath);
    if (read) return { path: linkedPath, ...read, origin: "linked" };
  }
  if (!modelName) return null;
  const wanted = vcfFileName(modelName).toLowerCase();
  const modelDir = parentDir(modelPath);
  // The model's folder, its parent (a FiveM resource above stream/), and the
  // VCF-named folders inside either.
  const roots = [modelDir, parentDir(modelDir)].filter(Boolean);
  const seen = new Set();
  for (const [index, dir] of roots.entries()) {
    if (seen.has(pathKey(dir))) continue;
    seen.add(pathKey(dir));
    const hit = await findIn(readDir, readTextFile, dir, wanted);
    if (hit) return { ...hit, origin: index === 0 ? "model" : "resource" };
    for (const entry of await listDir(readDir, dir)) {
      if (!entry?.isDirectory || !VCF_FOLDER_NAMES.test(entry.name || "")) continue;
      const sub = joinPath(dir, entry.name);
      if (seen.has(pathKey(sub))) continue;
      seen.add(pathKey(sub));
      const nested = await findIn(readDir, readTextFile, sub, wanted);
      if (nested) return { ...nested, origin: "resource" };
    }
  }
  for (const folder of folders) {
    const hit = await findIn(readDir, readTextFile, folder.path, wanted);
    if (hit) return { ...hit, origin: "folder" };
  }
  return null;
}

/** Path for a new VCF in `folder`. */
export function vcfPathIn(folder, modelName) {
  return joinPath(folder, vcfFileName(modelName));
}

// ---------------------------------------------------------------------------
// ELS-FiveM registration. ELS-FiveM loads only the files listed in vcf.lua's
// vcf_files table; MISS-ELS and ELS V8 read every file in their folder.

// Lua source with comments blanked and each string literal masked as "s"
// (line breaks kept, so offsets match), plus the strings and comments found.
// Enough to find the vcf_files table without being fooled by commented-out
// entries or a comment at the end of a line.
function scanLua(source) {
  const strings = [];
  const comments = [];
  let code = "";
  let index = 0;
  const mask = (text, fill) => text.replace(/[^\r\n]/g, fill);
  const longClose = (from, level) => {
    const close = source.indexOf(`]${level}]`, from);
    return close === -1 ? { inner: source.length, end: source.length } : { inner: close, end: close + level.length + 2 };
  };
  while (index < source.length) {
    const char = source[index];
    if (char === "-" && source[index + 1] === "-") {
      const long = /^\[(=*)\[/.exec(source.slice(index + 2, index + 264));
      let end;
      if (long) end = longClose(index + 2 + long[0].length, long[1]).end;
      else {
        const newline = source.indexOf("\n", index);
        end = newline === -1 ? source.length : newline;
      }
      comments.push({ start: index, end });
      code += mask(source.slice(index, end), " ");
      index = end;
      continue;
    }
    const long = char === "[" ? /^\[(=*)\[/.exec(source.slice(index, index + 262)) : null;
    if (char === '"' || char === "'" || long) {
      let end;
      let value = "";
      if (long) {
        const close = longClose(index + long[0].length, long[1]);
        value = source.slice(index + long[0].length, close.inner);
        end = close.end;
      } else {
        end = index + 1;
        while (end < source.length && source[end] !== char && source[end] !== "\n") {
          value += source[end] === "\\" ? (source[end + 1] ?? "") : source[end];
          end += source[end] === "\\" ? 2 : 1;
        }
        end = Math.min(end + 1, source.length);
      }
      strings.push({ start: index, end, value });
      code += mask(source.slice(index, end), "s");
      index = end;
      continue;
    }
    code += char;
    index += 1;
  }
  return { code, strings, comments };
}

/**
 * Adds `fileName` to vcf.lua's vcf_files list. Everything else is kept byte
 * for byte; comments are neither read as entries nor written into.
 * Returns { text, changed, listedAs } (listedAs: the entry already there,
 * which may differ in case); throws when the file has no vcf_files table.
 */
export function registerVcfInVcfLua(text, fileName) {
  const source = String(text ?? "");
  const { code, strings, comments } = scanLua(source);
  const match = /(^|[^\w.])vcf_files\s*=\s*\{/.exec(code);
  if (!match) throw new Error("vcf.lua has no vcf_files = { ... } list.");
  const open = match.index + match[0].length - 1;
  let close = -1;
  for (let index = open, depth = 0; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    else if (code[index] === "}" && --depth === 0) {
      close = index;
      break;
    }
  }
  if (close === -1) throw new Error("vcf.lua's vcf_files list has no closing brace.");
  const entries = strings.filter((entry) => entry.start > open && entry.end <= close);
  const existing = entries.find((entry) => entry.value.toLowerCase() === fileName.toLowerCase());
  if (existing) return { text: source, changed: false, listedAs: existing.value };
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const quoted = `"${fileName}"`;
  const lastEntry = entries[entries.length - 1];
  const indent = lastEntry ? /^[ \t]*/.exec(source.slice(source.lastIndexOf("\n", lastEntry.start - 1) + 1))[0] : "    ";
  const insert = (at, value) => ({ text: source.slice(0, at) + value + source.slice(at), changed: true, listedAs: null });
  // The list's last code character, skipping whitespace and comments.
  let last = close - 1;
  while (last > open && /\s/.test(code[last])) last -= 1;
  if (last === open) {
    if (source.slice(open + 1, close).includes("\n")) return insert(open + 1, `${eol}${indent}${quoted},`);
    return /^\s*$/.test(source.slice(open + 1, close))
      ? { text: `${source.slice(0, open + 1)} ${quoted} ${source.slice(close)}`, changed: true, listedAs: null }
      : insert(open + 1, ` ${quoted},`);
  }
  const separated = code[last] === "," || code[last] === ";";
  const comma = separated ? "" : ",";
  const trailing = separated ? "," : "";
  // A new line after the last entry's line, past any comment on it.
  let lineEnd = source.indexOf("\n", last);
  while (lineEnd !== -1 && comments.some((comment) => comment.start < lineEnd && lineEnd < comment.end)) lineEnd = source.indexOf("\n", lineEnd + 1);
  if (lineEnd === -1 || lineEnd > close) {
    // "}" shares that line, { "a.xml", "b.xml" }, or a comment runs on to it.
    return insert(last + 1, `${comma} ${quoted}${trailing}`);
  }
  const at = source[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
  const out = source.slice(0, last + 1) + comma + source.slice(last + 1, at) + `${eol}${indent}${quoted}${trailing}` + source.slice(at);
  return { text: out, changed: true, listedAs: null };
}

// ---------------------------------------------------------------------------
// File bytes. VCFs and vcf.lua are usually UTF-8, but older ones are ANSI
// (Windows-1252). Saving encodes text the way it was read, so the bytes
// outside an edit stay exact.

// Windows-1252 bytes 0x80-0x9F (WHATWG mapping, so five bytes decode to C1
// controls and every byte round-trips); 0xA0-0xFF are U+00A0-U+00FF. Spelled
// out because Node's TextDecoder treats windows-1252 as latin1.
const CP1252_80 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f"
  + "\u0090‘’“”•–—˜™š›œ\u009džŸ";

/** Decodes file bytes as UTF-8 (a BOM stays as U+FEFF), else Windows-1252. Returns { text, encoding }. */
export function decodeVcfBytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data), encoding: "utf-8" };
  } catch {
    const chars = Array.from(data, (byte) => (byte >= 0x80 && byte < 0xa0 ? CP1252_80[byte - 0x80] : String.fromCharCode(byte)));
    return { text: chars.join(""), encoding: "windows-1252" };
  }
}

/** Encodes `text` in the encoding decodeVcfBytes reported; throws for a character that encoding lacks. */
export function encodeVcfText(text, encoding = "utf-8") {
  if (encoding !== "windows-1252") return new TextEncoder().encode(text);
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const high = CP1252_80.indexOf(text[index]);
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) out[index] = code;
    else if (high !== -1) out[index] = 0x80 + high;
    else throw new Error(`"${text[index]}" cannot be saved in this file's ANSI (Windows-1252) encoding.`);
  }
  return out;
}
