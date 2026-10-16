// Installing a siren setting into a vehicle resource: the carcols.meta write is
// spliceSirenSetting's; this links the model to the setting in
// carvariations.meta and names the backups taken before either file changes.
// Pure; the caller reads and writes files.

import { detectXmlStyle } from "./siren-settings.js";
import { findChild, findChildren, numberValue, parseXml } from "./xml-lite.js";

function lineIndent(text, offset) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lead = text.slice(lineStart, offset);
  return /^[ \t]*$/.test(lead) ? lead : null;
}

/**
 * Points the model's carvariations entry at siren setting `id`: rewrites the
 * value of an existing <sirenSettings>, or adds one after <lightSettings> (or
 * at the end of the entry). Everything else stays byte for byte.
 * Returns { text, mode: "updated" | "added" | "unchanged", previous }.
 * Throws when the file is not a carvariations.meta or has no entry for the model.
 */
export function linkVariationSirenSetting(sourceText, modelName, id) {
  if (typeof sourceText !== "string") throw new TypeError("carvariations.meta text is required");
  if (!Number.isInteger(id) || id < 0) throw new RangeError("the siren setting id must be a whole number");
  const bom = sourceText.charCodeAt(0) === 0xfeff ? "﻿" : "";
  const text = bom ? sourceText.slice(1) : sourceText;
  const root = parseXml(text, { positions: true });
  if (root.name !== "CVehicleModelInfoVariation") {
    throw new Error(`expected a <CVehicleModelInfoVariation> carvariations root, found <${root.name}>`);
  }
  const wanted = String(modelName || "").trim().toLowerCase();
  const item = findChildren(findChild(root, "variationData"), "Item")
    .find((entry) => (findChild(entry, "modelName")?.text || "").trim().toLowerCase() === wanted);
  if (!item) throw new Error(`carvariations.meta has no entry for ${modelName}`);

  const existing = findChild(item, "sirenSettings");
  if (existing) {
    const previous = numberValue(existing, Number.NaN);
    if (Number.isFinite(previous) && Math.trunc(previous) === id) return { text: sourceText, mode: "unchanged", previous: id };
    const raw = text.slice(existing.start, existing.end);
    const attr = /\bvalue\s*=\s*(["'])(.*?)\1/.exec(raw);
    if (attr) {
      const at = existing.start + attr.index + attr[0].indexOf(attr[1]) + 1;
      return { text: bom + text.slice(0, at) + id + text.slice(at + attr[2].length), mode: "updated", previous: Number.isFinite(previous) ? Math.trunc(previous) : null };
    }
    // <sirenSettings>12</sirenSettings> or an empty element: replace it whole.
    const close = detectXmlStyle(text).close;
    return { text: bom + text.slice(0, existing.start) + `<sirenSettings value="${id}"${close}` + text.slice(existing.end), mode: "updated", previous: Number.isFinite(previous) ? Math.trunc(previous) : null };
  }

  const raw = text.slice(item.start, item.end);
  if (/\/>$/.test(raw)) throw new Error(`the carvariations entry for ${modelName} is empty`);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const close = detectXmlStyle(text).close;
  const element = `<sirenSettings value="${id}"${close}`;
  const anchor = findChild(item, "lightSettings");
  const sibling = anchor || item.children[0];
  const childIndent = (sibling && lineIndent(text, sibling.start)) ?? null;
  if (anchor && childIndent != null) {
    return { text: bom + text.slice(0, anchor.end) + eol + childIndent + element + text.slice(anchor.end), mode: "added", previous: null };
  }
  const closeAt = text.lastIndexOf("</", item.end - 1);
  const closeIndent = lineIndent(text, closeAt);
  if (closeIndent == null) {
    return { text: bom + text.slice(0, closeAt) + element + text.slice(closeAt), mode: "added", previous: null };
  }
  const indent = childIndent ?? `${closeIndent}  `;
  const at = closeAt - closeIndent.length;
  return { text: bom + text.slice(0, at) + indent + element + eol + text.slice(at), mode: "added", previous: null };
}

/** `yyyymmdd-hhmmss` in local time, the stamp in backup names. */
export function backupStamp(date = new Date()) {
  const two = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

/** `<path>.<yyyymmdd-hhmmss>.bak`, beside the file, in local time. */
export function backupPathFor(path, date = new Date()) {
  return `${path}.${backupStamp(date)}.bak`;
}
