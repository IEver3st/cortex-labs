// Pure GTA V .ytyp.xml archetype generator, parser and fxmanifest helper.
// Produces CodeWalker-ready CMapTypes XML from true GTA-space mesh bounds so
// prop makers never hand-calculate bbMin/bbMax/bsCentre/bsRadius.

export const YTYP_FLAG_PRESETS = Object.freeze([
  { id: "static", label: "Static prop (32)", flags: 32, note: "Standard world / MLO static object." },
  { id: "dynamic", label: "Dynamic prop (0)", flags: 0, note: "Movable, physics-enabled or handheld prop." },
]);

const ASSET_TYPES = Object.freeze({
  ydr: "ASSET_TYPE_DRAWABLE",
  ydd: "ASSET_TYPE_DRAWABLEDICTIONARY",
  yft: "ASSET_TYPE_FRAGMENT",
});

function finiteVec3(value) {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function fmt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) < 1e-7) return "0.000000";
  return n.toFixed(6);
}

/** Sanitized GTA archetype identifier derived from a model filename stem. */
export function sanitizeArchetypeName(raw) {
  const stem = String(raw || "")
    .split(/[\\/]/)
    .pop()
    .replace(/\.[^.]+$/, "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "_");
  return stem || "custom_prop";
}

/** Suggested GTA lodDist (metres) scaled from the bounding sphere radius. */
export function suggestLodDist(radius) {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 0.5;
  return Math.round(Math.min(300, Math.max(30, r * 35)));
}

/** Suggested hdTextureDist (metres) scaled from the bounding sphere radius. */
export function suggestHdTextureDist(radius) {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 0.5;
  return Math.round(Math.min(120, Math.max(15, r * 14)));
}

/**
 * Builds one CBaseArchetypeDef record from a prop's GTA-space bounds.
 * `gtaBounds` is `{ min: [x,y,z], max: [x,y,z] }` in GTA Z-up metres.
 */
export function buildArchetypeDef({
  name,
  format = "ydr",
  gtaBounds,
  textureDictionary = "",
  physicsDictionary = "",
  lodDist = null,
  hdTextureDist = null,
  flags = 32,
  specialAttribute = 0,
} = {}) {
  const cleanName = sanitizeArchetypeName(name);
  const min = finiteVec3(gtaBounds?.min) ? gtaBounds.min : [-0.5, -0.5, 0];
  const max = finiteVec3(gtaBounds?.max) ? gtaBounds.max : [0.5, 0.5, 1];
  const bsCentre = [
    (min[0] + max[0]) * 0.5,
    (min[1] + max[1]) * 0.5,
    (min[2] + max[2]) * 0.5,
  ];
  const bsRadius = Math.max(
    0.01,
    Math.hypot(max[0] - bsCentre[0], max[1] - bsCentre[1], max[2] - bsCentre[2]),
  );
  const resolvedFormat = format in ASSET_TYPES ? format : "ydr";
  const txd = String(textureDictionary || "").trim() || cleanName;
  const phys = String(physicsDictionary || "").trim() || (resolvedFormat === "yft" ? cleanName : "");
  const resolvedLod = Number.isFinite(Number(lodDist)) && Number(lodDist) > 0
    ? Math.round(Number(lodDist))
    : suggestLodDist(bsRadius);
  const resolvedHd = Number.isFinite(Number(hdTextureDist)) && Number(hdTextureDist) > 0
    ? Math.round(Number(hdTextureDist))
    : suggestHdTextureDist(bsRadius);
  const resolvedFlags = Number.isInteger(Number(flags)) && Number(flags) >= 0 ? Number(flags) : 32;
  const resolvedSpecial = Number.isInteger(Number(specialAttribute)) && Number(specialAttribute) >= 0
    ? Number(specialAttribute)
    : 0;

  return {
    name: cleanName,
    assetName: cleanName,
    assetType: ASSET_TYPES[resolvedFormat],
    textureDictionary: txd,
    physicsDictionary: phys,
    clipDictionary: "",
    drawableDictionary: resolvedFormat === "ydd" ? cleanName : "",
    bbMin: min,
    bbMax: max,
    bsCentre,
    bsRadius,
    lodDist: resolvedLod,
    hdTextureDist: resolvedHd,
    flags: resolvedFlags,
    specialAttribute: resolvedSpecial,
  };
}

function renderArchetypeItem(def) {
  const physLine = def.physicsDictionary
    ? `      <physicsDictionary>${escapeXml(def.physicsDictionary)}</physicsDictionary>`
    : "      <physicsDictionary />";
  const clipLine = def.clipDictionary
    ? `      <clipDictionary>${escapeXml(def.clipDictionary)}</clipDictionary>`
    : "      <clipDictionary />";
  const drawLine = def.drawableDictionary
    ? `      <drawableDictionary>${escapeXml(def.drawableDictionary)}</drawableDictionary>`
    : "      <drawableDictionary />";
  return [
    `    <Item type="CBaseArchetypeDef">`,
    `      <lodDist value="${fmt(def.lodDist)}" />`,
    `      <flags value="${def.flags}" />`,
    `      <specialAttribute value="${def.specialAttribute}" />`,
    `      <bbMin x="${fmt(def.bbMin[0])}" y="${fmt(def.bbMin[1])}" z="${fmt(def.bbMin[2])}" />`,
    `      <bbMax x="${fmt(def.bbMax[0])}" y="${fmt(def.bbMax[1])}" z="${fmt(def.bbMax[2])}" />`,
    `      <bsCentre x="${fmt(def.bsCentre[0])}" y="${fmt(def.bsCentre[1])}" z="${fmt(def.bsCentre[2])}" />`,
    `      <bsRadius value="${fmt(def.bsRadius)}" />`,
    `      <hdTextureDist value="${fmt(def.hdTextureDist)}" />`,
    `      <name>${escapeXml(def.name)}</name>`,
    `      <textureDictionary>${escapeXml(def.textureDictionary)}</textureDictionary>`,
    clipLine,
    drawLine,
    physLine,
    `      <assetType>${def.assetType}</assetType>`,
    `      <assetName>${escapeXml(def.assetName)}</assetName>`,
    `      <extensions />`,
    `    </Item>`,
  ].join("\n");
}

/**
 * Renders one or more CBaseArchetypeDef objects as a complete CodeWalker
 * `.ytyp.xml` document (`<CMapTypes>`).
 */
export function renderYtypXml(archetypes, { name = "custom_props" } = {}) {
  const list = (Array.isArray(archetypes) ? archetypes : [archetypes]).filter(Boolean);
  const packName = sanitizeArchetypeName(name);
  const items = list.map(renderArchetypeItem).join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<CMapTypes>`,
    `  <extensions />`,
    `  <archetypes>`,
    items,
    `  </archetypes>`,
    `  <name>${escapeXml(packName)}</name>`,
    `  <dependencies />`,
    `  <compositeEntityTypes />`,
    `</CMapTypes>`,
    "",
  ].join("\n");
}

function readTagText(block, tag) {
  const match = new RegExp(`<${tag}\\s*>([^<]*)</${tag}>`, "i").exec(block);
  return match ? match[1].trim() : "";
}

function readAttrValue(block, tag) {
  const match = new RegExp(`<${tag}[^>]*\\bvalue\\s*=\\s*"([^"]+)"`, "i").exec(block);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : null;
}

function readVec3Attr(block, tag) {
  const match = new RegExp(`<${tag}\\b([^>]*)/?>`, "i").exec(block);
  if (!match) return null;
  const attrs = match[1];
  const x = /\bx\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
  const y = /\by\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
  const z = /\bz\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
  const vec = [Number(x), Number(y), Number(z)];
  return vec.every(Number.isFinite) ? vec : null;
}

/**
 * Parses CBaseArchetypeDef / CTimeArchetypeDef entries from a CodeWalker
 * `.ytyp.xml` string so Prop Doctor can validate bounds and dictionary names.
 */
export function parseYtypXml(xmlText) {
  const text = String(xmlText || "");
  if (!text.trim()) return [];
  const out = [];
  // Track balanced <Item> nesting so archetypes containing <extensions><Item ...>
  // do not truncate on the first inner </Item>.
  const openPattern = /<Item\b[^>]*type\s*=\s*"([^"]*ArchetypeDef)"[^>]*>/gi;
  const tagPattern = /<(\/?)Item\b[^>]*?(\/?)>/gi;
  let match;
  while ((match = openPattern.exec(text)) !== null) {
    const start = match.index + match[0].length;
    if (match[0].endsWith("/>")) continue;
    tagPattern.lastIndex = start;
    let depth = 1;
    let end = -1;
    let inner;
    while ((inner = tagPattern.exec(text)) !== null) {
      if (inner[1] === "/") {
        depth -= 1;
        if (depth === 0) {
          end = inner.index;
          openPattern.lastIndex = inner.index + inner[0].length;
          break;
        }
      } else if (inner[2] !== "/") {
        depth += 1;
      }
    }
    if (end < 0) break;
    const block = text.slice(start, end);
    const name = readTagText(block, "name");
    if (!name) continue;
    out.push({
      type: match[1],
      name,
      assetName: readTagText(block, "assetName") || name,
      textureDictionary: readTagText(block, "textureDictionary"),
      physicsDictionary: readTagText(block, "physicsDictionary"),
      bbMin: readVec3Attr(block, "bbMin"),
      bbMax: readVec3Attr(block, "bbMax"),
      bsCentre: readVec3Attr(block, "bsCentre"),
      bsRadius: readAttrValue(block, "bsRadius"),
      lodDist: readAttrValue(block, "lodDist"),
      hdTextureDist: readAttrValue(block, "hdTextureDist"),
      flags: readAttrValue(block, "flags"),
    });
  }
  return out;
}

/** Generates a clean FiveM fxmanifest.lua snippet for streaming the .ytyp. */
export function buildPropFxManifest({ ytypName = "custom_props", streamPrefix = "stream/" } = {}) {
  const stem = sanitizeArchetypeName(ytypName).replace(/\.ytyp$/i, "");
  const filePath = `${streamPrefix}${stem}.ytyp`;
  return [
    `fx_version 'cerulean'`,
    `game 'gta5'`,
    ``,
    `files {`,
    `  '${filePath}',`,
    `}`,
    ``,
    `data_file 'DLC_ITYP_REQUEST' '${filePath}'`,
    ``,
  ].join("\n");
}
