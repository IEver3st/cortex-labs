import { decodeDDSLevels, describeDdsPixelFormat, parseDDSHeader, readCompressedMipmaps } from "./dds-decode.js";
import { encodeDxt5, mipLevelSizes, rgbaToBgra, writeDds } from "./dds-encode.js";
import { classifyLightMesh } from "./emergency-lights.js";

// Writing a lens glow colour into the texture a siren's lit mesh samples.
// GTA lens textures are colour atlases: a lit mesh glows in the colour of the
// texels its UVs cover, and several meshes often share one patch. So a write
// recolours exactly the texels tinted sirens cover, refuses when two sirens
// of different colours share texels, and reports every other mesh that will
// change with them. Pure: the caller reads and writes the files.

const HEX = /^#[0-9a-f]{6}$/;
// Overlaps smaller than this share of the smaller island are seams, not shared texels.
const SHARED_SHARE = 0.05;
const SHARED_MIN_TEXELS = 4;
// Texels past a lens island that take its colour, so filtering and mips do not
// pull the old colour back in at its edges.
const BLEED_TEXELS = 2;

/**
 * The vehicle's own texture dictionaries for a model file, in the order the
 * bridge reads them (EnumerateSiblingYtdPaths): `x_hi.yft` uses `x_hi.ytd`,
 * `x+hi.ytd` and `x.ytd`.
 */
export function siblingYtdNames(modelFileName) {
  const base = String(modelFileName || "").split(/[\\/]/).pop() || "";
  const stem = base.replace(/\.[^.]*$/, "");
  if (!stem) return [];
  if (/_hi$/i.test(stem)) return [`${stem}.ytd`, `${stem.slice(0, -3)}+hi.ytd`, `${stem.slice(0, -3)}.ytd`];
  if (/\+hi$/i.test(stem)) return [`${stem}.ytd`, `${stem.slice(0, -3)}_hi.ytd`, `${stem.slice(0, -3)}.ytd`];
  return [`${stem}.ytd`, `${stem}+hi.ytd`];
}

/**
 * Every diffuse texture in a bridge parse with the meshes that sample it.
 * `meshes` are parsed .clmesh meshes; manifest entries follow their order
 * (paired by index, then by name, as applyNativeManifestToMeshes does).
 * Returns Map<lower-case name, { name, relativePath, source, users }>, each
 * user `{ index, name, siren, uvs, indices }`; `siren` is set only for a
 * siren's lit mesh, the ones a lens tint colours.
 */
export function collectDiffuseUsers(meshes, manifest) {
  const entries = Array.isArray(manifest?.meshes) ? manifest.meshes : [];
  const byName = new Map(entries.map((entry) => [entry?.name, entry]));
  const textures = new Map();
  (meshes || []).forEach((mesh, index) => {
    const entry = entries[index]?.name === mesh?.name ? entries[index] : byName.get(mesh?.name);
    const binding = entry?.textureBindings?.find?.((item) => String(item?.paramName || "").toLowerCase() === "diffusesampler");
    const name = String(binding?.textureName || "").trim();
    if (!name) return;
    const uvs = [mesh.uvs, mesh.uvs2, mesh.uvs3, mesh.uvs4][Number(binding.uvSet) || 0];
    if (!uvs || !mesh.indices?.length) return;
    const key = name.toLowerCase();
    if (!textures.has(key)) {
      textures.set(key, { name, relativePath: String(binding.relativePath || ""), source: String(binding.source || ""), users: [] });
    }
    const light = classifyLightMesh(entry);
    textures.get(key).users.push({
      index,
      name: String(entry.name || ""),
      siren: light?.kind === "siren" && light.lit ? light.siren : null,
      uvs,
      indices: mesh.indices,
    });
  });
  return textures;
}

/**
 * The textures a write changes: those a tinted siren's lit mesh samples, with
 * each user's colour (`colours` maps siren number to "#rrggbb"; preview
 * "siren" tints are resolved by the caller). Sorted by name.
 */
export function planLensTextures(textures, colours) {
  const plan = [];
  for (const texture of textures.values()) {
    const users = texture.users.map((user) => {
      const colour = user.siren != null ? String(colours?.[user.siren] || "").toLowerCase() : "";
      return { ...user, colour: HEX.test(colour) ? colour : null };
    });
    if (users.some((user) => user.colour)) plan.push({ ...texture, users });
  }
  return plan.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Calls `visit(texel)` for every texel whose centre a mesh's UV triangles
 * cover (game UVs: v = 0 is the top row). UVs past 0..1 wrap, as the sampler
 * does. A triangle too small to cover a centre marks the texel at its centroid.
 */
export function forEachCoveredTexel(width, height, uvs, indices, visit) {
  const limit = width * height * 4;
  const wrap = (x, y) => ((((y % height) + height) % height) * width) + (((x % width) + width) % width);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 2;
    const b = indices[i + 1] * 2;
    const c = indices[i + 2] * 2;
    const x0 = uvs[a] * width, y0 = uvs[a + 1] * height;
    const x1 = uvs[b] * width, y1 = uvs[b + 1] * height;
    const x2 = uvs[c] * width, y2 = uvs[c + 1] * height;
    if (![x0, y0, x1, y1, x2, y2].every(Number.isFinite)) continue;
    const startX = Math.ceil(Math.min(x0, x1, x2) - 0.5);
    const endX = Math.floor(Math.max(x0, x1, x2) - 0.5);
    const startY = Math.ceil(Math.min(y0, y1, y2) - 0.5);
    const endY = Math.floor(Math.max(y0, y1, y2) - 0.5);
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    let hit = false;
    if (area !== 0 && (endX - startX + 1) * (endY - startY + 1) <= limit) {
      const sign = area > 0 ? 1 : -1;
      for (let y = startY; y <= endY; y += 1) {
        const cy = y + 0.5;
        for (let x = startX; x <= endX; x += 1) {
          const cx = x + 0.5;
          if (sign * ((x1 - x0) * (cy - y0) - (y1 - y0) * (cx - x0)) < 0) continue;
          if (sign * ((x2 - x1) * (cy - y1) - (y2 - y1) * (cx - x1)) < 0) continue;
          if (sign * ((x0 - x2) * (cy - y2) - (y0 - y2) * (cx - x2)) < 0) continue;
          visit(wrap(x, y));
          hit = true;
        }
      }
    }
    if (!hit) visit(wrap(Math.floor((x0 + x1 + x2) / 3), Math.floor((y0 + y1 + y2) / 3)));
  }
}

/**
 * Which texels each lens colour owns at one texture size.
 * Returns `{ owner, colours, conflicts, shares, alsoRecoloured }`: `owner` holds an
 * index into `colours` per texel (-1 keeps the texel), widened by a small
 * bleed into texels no mesh uses; `conflicts` pairs users of different colours
 * that share texels; `shares` pairs same-colour users that share texels, so a
 * fix for a conflict can cover every siren on those texels; `alsoRecoloured`
 * lists untinted users whose texels change.
 */
export function rasterizeLensOwners(width, height, users) {
  const size = width * height;
  const owner = new Int16Array(size).fill(-1);
  const firstUser = new Int32Array(size).fill(-1);
  const covered = new Uint8Array(size);
  const seen = new Int32Array(size).fill(-1);
  const colours = [];
  const coverage = new Array(users.length).fill(0);
  const changed = new Array(users.length).fill(0);
  const overlaps = new Map();
  const sameOverlaps = new Map();
  // Tinted users first, so every untinted user is checked against all of them.
  const order = users.map((_, index) => index).sort((a, b) => Number(!users[a].colour) - Number(!users[b].colour));
  for (const index of order) {
    const user = users[index];
    let colour = -1;
    if (user.colour) {
      colour = colours.indexOf(user.colour);
      if (colour < 0) colour = colours.push(user.colour) - 1;
    }
    forEachCoveredTexel(width, height, user.uvs, user.indices, (texel) => {
      if (seen[texel] === index) return;
      seen[texel] = index;
      coverage[index] += 1;
      covered[texel] = 1;
      if (colour >= 0) {
        if (owner[texel] < 0) {
          owner[texel] = colour;
          firstUser[texel] = index;
        } else if (firstUser[texel] !== index) {
          const key = `${firstUser[texel]}:${index}`;
          const pairs = owner[texel] === colour ? sameOverlaps : overlaps;
          pairs.set(key, (pairs.get(key) || 0) + 1);
        }
      } else if (owner[texel] >= 0) {
        changed[index] += 1;
      }
    });
  }
  const shared = (count, of) => count >= SHARED_MIN_TEXELS && count >= SHARED_SHARE * of;
  const sharedPairs = (pairs) => [...pairs].flatMap(([key, count]) => {
    const [a, b] = key.split(":").map(Number);
    return shared(count, Math.min(coverage[a], coverage[b])) ? [{ a, b, texels: count }] : [];
  });
  const conflicts = sharedPairs(overlaps);
  const shares = sharedPairs(sameOverlaps);
  const alsoRecoloured = users.flatMap((user, index) => (!user.colour && shared(changed[index], coverage[index]) ? [index] : []));
  bleed(owner, covered, width, height);
  return { owner, colours, conflicts, shares, alsoRecoloured };
}

function bleed(owner, covered, width, height) {
  let frontier = [];
  for (let texel = 0; texel < owner.length; texel += 1) if (owner[texel] >= 0) frontier.push(texel);
  for (let pass = 0; pass < BLEED_TEXELS && frontier.length; pass += 1) {
    const next = [];
    for (const texel of frontier) {
      const x = texel % width;
      const y = (texel - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbour = ny * width + nx;
          if (owner[neighbour] >= 0 || covered[neighbour]) continue;
          owner[neighbour] = owner[texel];
          next.push(neighbour);
        }
      }
    }
    frontier = next;
  }
}

/** "#rrggbb" scaled so its brightest channel is 1: the lens keeps each texel's brightness. */
function lensHue(hex) {
  const rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const peak = Math.max(...rgb);
  return peak > 0 ? rgb.map((value) => value / peak) : [0, 0, 0];
}

/**
 * Recoloured copies of decoded levels (top row first). An owned texel becomes
 * its colour times its brightest channel, alpha kept; lower levels blend by
 * the share of each texel's footprint every colour owns. Also returns, per
 * level, which texels changed.
 */
export function recolourLevels(levels, owner, colours) {
  const hues = colours.map(lensHue);
  const count = hues.length;
  const out = [];
  const changed = [];
  let weights = null;
  let previous = null;
  levels.forEach((level, index) => {
    const { width, height, data } = level;
    const next = new Uint8Array(data);
    const touched = new Uint8Array(width * height);
    if (index === 0) {
      for (let texel = 0; texel < width * height; texel += 1) {
        const colour = owner[texel];
        if (colour < 0) continue;
        const o = texel * 4;
        const peak = Math.max(data[o], data[o + 1], data[o + 2]);
        const hue = hues[colour];
        next[o] = Math.round(hue[0] * peak);
        next[o + 1] = Math.round(hue[1] * peak);
        next[o + 2] = Math.round(hue[2] * peak);
        touched[texel] = 1;
      }
    } else {
      weights = reduceWeights(index === 1 ? null : weights, owner, previous, width, height, count);
      for (let texel = 0; texel < width * height; texel += 1) {
        let total = 0;
        for (let c = 0; c < count; c += 1) total += weights[texel * count + c];
        if (total <= 0) continue;
        const o = texel * 4;
        const peak = Math.max(data[o], data[o + 1], data[o + 2]);
        for (let channel = 0; channel < 3; channel += 1) {
          let value = data[o + channel] * (1 - total);
          for (let c = 0; c < count; c += 1) value += weights[texel * count + c] * hues[c][channel] * peak;
          next[o + channel] = Math.max(0, Math.min(255, Math.round(value)));
        }
        touched[texel] = 1;
      }
    }
    previous = { width, height };
    out.push({ width, height, data: next });
    changed.push(touched);
  });
  return { levels: out, changed };
}

// Each colour's share of a texel's 2x2 footprint one level up; level 1 reads the owner map.
function reduceWeights(upper, owner, size, width, height, count) {
  const result = new Float32Array(width * height * count);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const texel = y * width + x;
      for (let dy = 0; dy < 2; dy += 1) {
        const sy = Math.min(size.height - 1, y * 2 + dy);
        for (let dx = 0; dx < 2; dx += 1) {
          const source = sy * size.width + Math.min(size.width - 1, x * 2 + dx);
          if (upper) {
            for (let c = 0; c < count; c += 1) result[texel * count + c] += 0.25 * upper[source * count + c];
          } else if (owner[source] >= 0) {
            result[texel * count + owner[source]] += 0.25;
          }
        }
      }
    }
  }
  return result;
}

function halveLevel({ width, height, data }) {
  const w = Math.max(1, width >> 1);
  const h = Math.max(1, height >> 1);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        let sum = 0;
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            sum += data[(Math.min(height - 1, y * 2 + dy) * width + Math.min(width - 1, x * 2 + dx)) * 4 + channel];
          }
        }
        out[(y * w + x) * 4 + channel] = Math.round(sum / 4);
      }
    }
  }
  return { width: w, height: h, data: out };
}

const COLOUR_FORMATS = new Map([
  ["DXT1", "DXT5"], ["DXT3", "DXT5"], ["DXT5", "DXT5"], ["BC7", "DXT5"],
  ["BGRA", "BGRA"], ["RGBA", "BGRA"], ["MASKED", "BGRA"], ["L8", "BGRA"],
]);

// The source block to keep when none of its texels change: DXT5 blocks as
// they are, DXT1 four-colour blocks under an opaque alpha block.
function keptBlocks(format, raw, touched, width, height) {
  if (!raw || (format !== "DXT5" && format !== "DXT1")) return null;
  const blocksX = Math.ceil(width / 4);
  const stride = format === "DXT5" ? 16 : 8;
  return (index) => {
    const bx = index % blocksX;
    const by = (index - bx) / blocksX;
    for (let y = by * 4; y < Math.min(height, by * 4 + 4); y += 1) {
      for (let x = bx * 4; x < Math.min(width, bx * 4 + 4); x += 1) {
        if (touched[y * width + x]) return null;
      }
    }
    const source = raw.subarray(index * stride, index * stride + stride);
    if (format === "DXT5") return source;
    if ((source[0] | (source[1] << 8)) <= (source[2] | (source[3] << 8))) return null;
    const block = new Uint8Array(16);
    block[0] = 255;
    block[1] = 255;
    block.set(source, 8);
    return block;
  };
}

/**
 * One texture copy with its lens colours written in: `dds` is the copy's DDS
 * file, `users` its planned users (planLensTextures). Keeps the size and mip
 * count; block-compressed copies are written as DXT5 and uncompressed ones as
 * 32-bit BGRA. Throws for formats without colour or files it cannot read.
 */
export function recolourLensTexture(dds, users) {
  const bytes = dds instanceof Uint8Array ? dds : new Uint8Array(dds);
  const header = parseDDSHeader(bytes);
  if (!header) throw new Error(`it is not a DDS this can read (${describeDdsPixelFormat(bytes)})`);
  const format = COLOUR_FORMATS.get(header.fmt);
  if (!format) throw new Error(`it is stored as ${header.fmt}, which holds no colour to change`);
  const decoded = decodeDDSLevels(bytes, { header, flipY: false });
  if (!decoded?.levels?.length) throw new Error("its pixels could not be read");
  const raster = rasterizeLensOwners(header.width, header.height, users);
  const { levels, changed } = recolourLevels(decoded.levels, raster.owner, raster.colours);
  // Levels the decoder could not read (or the file lacks) are rebuilt from
  // the one above, so the copy keeps the mip count the game streams.
  const expected = mipLevelSizes(header.width, header.height, Math.max(1, header.mipMapCount)).length;
  while (levels.length < expected) levels.push(halveLevel(levels[levels.length - 1]));
  const raw = header.blockSize > 1 ? readCompressedMipmaps(bytes, header) : [];
  const encoded = levels.map((level, index) => (format === "DXT5"
    ? encodeDxt5(level.data, level.width, level.height, {
      reuse: changed[index] ? keptBlocks(header.fmt, raw[index]?.data, changed[index], level.width, level.height) : null,
    })
    : rgbaToBgra(level.data)));
  return {
    bytes: writeDds({ format, width: header.width, height: header.height, levels: encoded }),
    width: header.width,
    height: header.height,
    format,
    sourceFormat: header.fmt,
    levels: levels.length,
    texels: changed[0].reduce((sum, value) => sum + value, 0),
    conflicts: raster.conflicts,
    shares: raster.shares,
    alsoRecoloured: raster.alsoRecoloured,
  };
}
