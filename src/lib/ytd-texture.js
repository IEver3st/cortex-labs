// A texture dictionary (.ytd) used as an ordinary texture: the native side
// exports its textures as DDS files (cached while the .ytd is unchanged) and
// the viewer shows the diffuse one.

import { invoke } from "@tauri-apps/api/core";

const DETAIL_MAP = /(?:^|_)(?:n|nrm|norm|normal|s|spec|specular|bump)(?:_|$)/;

function stem(path) {
  const file = String(path || "").split(/[\\/]/).pop() || "";
  return file.replace(/\.[^.]+$/, "").toLowerCase();
}

/**
 * The texture a dictionary is shown as: the one named after the file (EUP's
 * `uppr_diff_000_a_uni.ytd` holds `uppr_diff_000_a_uni`), else a diffuse map,
 * else the first texture that is not a normal or specular map.
 */
export function pickDictionaryTexture(textures, dictionaryPath) {
  const list = (Array.isArray(textures) ? textures : []).filter((texture) => texture?.name && texture?.path);
  if (!list.length) return null;
  const own = stem(dictionaryPath).split("^").pop();
  const named = (texture) => String(texture.name).toLowerCase();
  return list.find((texture) => named(texture) === own || named(texture).split("^").pop() === own)
    || list.find((texture) => /(?:^|_)diff(?:_|$)/.test(named(texture)))
    || list.find((texture) => !DETAIL_MAP.test(named(texture)))
    || list[0];
}

export function isYtdTexturePath(path) {
  return /\.ytd$/i.test(String(path || ""));
}

/** The exported DDS file a .ytd is shown as. Needs the desktop app. */
export async function resolveYtdTexturePath(path) {
  if (typeof window !== "undefined" && typeof window.__TAURI_INTERNALS__?.invoke !== "function") {
    throw new Error("Texture dictionaries need the desktop app");
  }
  const exported = await invoke("export_ytd", { path });
  const texture = pickDictionaryTexture(exported?.textures, path);
  if (!texture) throw new Error("The texture dictionary holds no textures");
  return texture.path;
}
