import { parseClmesh } from "./clmesh.js";
import { collectDiffuseUsers, planLensTextures, recolourLensTexture, siblingYtdNames } from "./lens-texture.js";
import { backupStamp } from "./siren-install.js";

// The lens colour write for an open model. `prepareLensWrite` reads the
// model's bridge parse and its own texture dictionaries and builds every new
// texture, so the confirmation lists exactly what will change; nothing is
// written until `writeLensTextures` sends the result to the desktop host
// (src-tauri lens_write.rs), which backs up and replaces the files.
//
// A texture the vehicle's own dictionaries hold is replaced in each of them,
// recoloured from that copy. A texture they lack gets a recoloured copy added
// to each of them only when it comes from a pack-wide dictionary inside the
// vehicle's own resource: the game looks in the vehicle's dictionaries before
// their parents, so only this vehicle changes and the shared dictionary is
// never written. Textures from the game's files or another resource are not
// copied; their sirens are listed in `outside` and keep the texture's colour.

function directoryOf(path) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(0, index) : "";
}

function baseName(path) {
  return String(path || "").split(/[\\/]/).pop() || "";
}

// `relative` uses "/" and may climb out with "..", as manifest paths do.
function joinPath(directory, relative) {
  const separator = directory.includes("\\") ? "\\" : "/";
  const parts = directory.split(/[\\/]/);
  for (const part of relative.split(/[\\/]/)) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join(separator);
}

const comparable = (path) => String(path || "").replace(/[\\/]+/g, "/").toLowerCase();

// The bridge files a pack dictionary's textures under textures/shared/<folder>,
// the folder being the .ytd's name made safe the way SanitizeFolderName does.
function sharedFolderName(stem) {
  const value = stem.trim() || "shared";
  return value.replace(/[\\/<>:"|?*\u0000-\u001f]/g, "_");
}

// The vehicle's resource: the nearest folder above the model with a resource
// manifest, as the bridge and the desktop host find it.
async function resourceRootOf(modelPath, exists) {
  const separator = modelPath.includes("\\") ? "\\" : "/";
  for (let directory = directoryOf(modelPath); directory;) {
    for (const name of ["fxmanifest.lua", "__resource.lua"]) {
      try {
        if (await exists(`${directory}${separator}${name}`)) return directory;
      } catch {
        // A folder that cannot be checked is not a resource root.
      }
    }
    const parent = directoryOf(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/**
 * Where a texture the vehicle's dictionaries lack would be copied from:
 * `{ label, path }` with `path` a dictionary inside the vehicle's resource, or
 * `{ label, reason }` when it must not be copied. This compares paths as
 * written; the desktop host checks the resolved path again, so a link that
 * leads out of the resource is refused there.
 */
function copySource(relativePath, { manifest, modelPath, root, siblings }) {
  if (relativePath.startsWith("../.shared-textures/")) return { label: "the game's files", reason: "which comes from the game's files" };
  const shared = /^textures\/shared\/([^/]+)\//i.exec(relativePath);
  if (!shared) return null;
  const label = `${shared[1]}.ytd`;
  const own = new Set(siblings.map((sibling) => comparable(sibling.path)));
  const paths = [...new Set((manifest?.inputs || [])
    .filter((input) => input && !input.missing && /\.ytd$/i.test(String(input.path || "")))
    .map((input) => String(input.path))
    .filter((path) => !own.has(comparable(path)) && comparable(sharedFolderName(baseName(path).slice(0, -4))) === comparable(shared[1])))];
  if (paths.length !== 1) return { label, reason: `which comes from ${label}, and Cortex cannot tell which file that is` };
  const inside = root
    ? comparable(paths[0]).startsWith(`${comparable(root)}/`)
    : comparable(directoryOf(paths[0])) === comparable(directoryOf(modelPath));
  if (!inside) return { label, reason: `which comes from ${label}, outside this vehicle's resource` };
  return { label, path: paths[0] };
}

function sirenList(sirens) {
  const sorted = [...new Set(sirens)].sort((a, b) => a - b);
  if (sorted.length === 1) return `siren ${sorted[0]}`;
  return `sirens ${sorted.slice(0, -1).join(", ")} and ${sorted[sorted.length - 1]}`;
}

/** Reads a model's bridge parse: `parse` is requestBridgeParse bound to invoke. */
export function bridgeModelReader({ parse, readFile, readText }) {
  return async (modelPath) => {
    const parsed = await parse(modelPath);
    const meshPath = String(parsed?.meshPath || "").trim();
    const manifestPath = String(parsed?.manifestPath || "").trim();
    if (!meshPath || !manifestPath) throw new Error("The model's CodeWalker parse is unavailable, so its lens textures cannot be read.");
    return {
      meshes: parseClmesh(await readFile(meshPath)),
      manifest: JSON.parse(await readText(manifestPath)),
      manifestPath,
    };
  };
}

/**
 * Builds the write for `colours` (siren number to "#rrggbb"). Returns
 * `{ modelPath, files, textures, conflicts, shares, outside, problems, blocked }`:
 * `files` are the dictionaries to write with their new textures, `textures`
 * describes each changed texture for the confirmation, `outside` lists
 * `{ texture, sirens, reason }` for tinted textures that would have to be copied
 * from outside the vehicle's resource, and any conflict, outside texture,
 * problem or `blocked` reason means the write must not be sent (see canWriteLens).
 * `readModel(path)` gives `{ meshes, manifest, manifestPath }`; `exists`
 * checks a path; `exportYtd(path)` lists a dictionary's textures as
 * `{ textures: [{ name, path }] }` with each `path` a DDS file.
 */
export async function prepareLensWrite({ modelPath, colours, readModel, readFile, exists, exportYtd, pause = () => new Promise((resolve) => setTimeout(resolve)) }) {
  const result = { modelPath, files: [], textures: [], conflicts: [], shares: [], outside: [], problems: [], blocked: null };
  const { meshes, manifest, manifestPath } = await readModel(modelPath);
  const plan = planLensTextures(collectDiffuseUsers(meshes, manifest), colours);
  if (!plan.length) {
    result.blocked = "None of these sirens has a lit lens that samples a texture.";
    return result;
  }

  const separator = modelPath.includes("\\") ? "\\" : "/";
  const siblings = [];
  for (const name of siblingYtdNames(modelPath)) {
    const path = `${directoryOf(modelPath)}${separator}${name}`;
    if (!(await exists(path))) continue;
    const listing = await exportYtd(path);
    siblings.push({ path, name, textures: Array.isArray(listing?.textures) ? listing.textures : [] });
  }
  if (!siblings.length) {
    result.blocked = `${baseName(modelPath)} has no texture dictionary of its own (${siblingYtdNames(modelPath).at(-1)}) to hold recoloured lenses.`;
    return result;
  }

  const manifestNames = new Map((manifest?.textures || []).map((entry) => [entry?.relativePath, entry?.name]));
  const root = await resourceRootOf(modelPath, exists);
  const files = new Map();
  for (const texture of plan) {
    const key = texture.name.toLowerCase();
    const tinted = texture.users.filter((user) => user.colour).map((user) => user.siren);
    const holders = siblings.flatMap((sibling) => {
      const entry = sibling.textures.find((item) => String(item?.name || "").toLowerCase() === key);
      return entry ? [{ sibling, name: entry.name, source: entry.path, mode: "replace" }] : [];
    });
    let targets = holders;
    let from = null;
    if (!holders.length) {
      if (texture.source === "embedded" || /^textures\/embedded\//i.test(texture.relativePath)) {
        result.problems.push(`${texture.name} (${sirenList(tinted)}) is stored inside ${baseName(modelPath)}, which Cortex does not rewrite.`);
        continue;
      }
      const copy = texture.relativePath ? copySource(texture.relativePath, { manifest, modelPath, root, siblings }) : null;
      if (!copy) {
        result.problems.push(`${texture.name} (${sirenList(tinted)}) was not found in any texture dictionary.`);
        continue;
      }
      if (copy.reason) {
        result.outside.push({ texture: texture.name, sirens: [...new Set(tinted)].sort((a, b) => a - b), reason: copy.reason });
        continue;
      }
      from = copy.label;
      const name = manifestNames.get(texture.relativePath) || texture.name;
      const source = joinPath(directoryOf(manifestPath), texture.relativePath);
      targets = siblings.map((sibling) => ({ sibling, name, source, copyFrom: copy.path, mode: "add" }));
    }

    const summary = { name: texture.name, from, sirens: [...new Set(tinted)].sort((a, b) => a - b), alsoSirens: [], alsoOther: 0, files: [], converted: null };
    let checked = false;
    for (const target of targets) {
      await pause();
      let built;
      try {
        built = recolourLensTexture(await readFile(target.source), texture.users);
      } catch (error) {
        result.problems.push(`${texture.name} in ${target.sibling.name} cannot be recoloured: ${error?.message || error}.`);
        continue;
      }
      if (!checked) {
        // Users overlap the same way at any copy's size; report them once.
        checked = true;
        const pair = ({ a, b }) => ({ texture: texture.name, sirens: [texture.users[a].siren, texture.users[b].siren].sort((x, y) => x - y) });
        result.conflicts.push(...built.conflicts.map(pair));
        result.shares.push(...built.shares.map(pair));
        for (const index of built.alsoRecoloured) {
          const siren = texture.users[index].siren;
          if (siren != null) summary.alsoSirens.push(siren);
          else summary.alsoOther += 1;
        }
        summary.alsoSirens = [...new Set(summary.alsoSirens)].sort((a, b) => a - b);
      }
      if (built.sourceFormat !== built.format && built.format === "DXT5") summary.converted = built.sourceFormat;
      summary.files.push(target.sibling.name);
      if (!files.has(target.sibling.path)) files.set(target.sibling.path, { path: target.sibling.path, name: target.sibling.name, textures: [] });
      files.get(target.sibling.path).textures.push({
        name: target.name,
        mode: target.mode,
        source: target.copyFrom,
        bytes: built.bytes,
        width: built.width,
        height: built.height,
        format: built.format,
      });
    }
    if (summary.files.length) result.textures.push(summary);
  }
  result.files = [...files.values()];
  return result;
}

export function canWriteLens(prepared) {
  return Boolean(prepared && !prepared.blocked && !prepared.conflicts.length && !prepared.outside?.length
    && !prepared.problems.length && prepared.files.length);
}

/**
 * Pairwise conflicts merged into groups of sirens that must share one colour,
 * each with the textures in conflict and the colours its sirens have now.
 * `shares` (same-colour pairs) pull in sirens that already match one side, so
 * picking the other colour does not leave them in a new conflict.
 */
export function lensConflictGroups(conflicts, colours, shares = []) {
  const parent = new Map();
  const find = (siren) => {
    while (parent.get(siren) !== siren) siren = parent.get(siren);
    return siren;
  };
  for (const { sirens } of [...conflicts, ...shares]) {
    for (const siren of sirens) if (!parent.has(siren)) parent.set(siren, siren);
    for (const siren of sirens.slice(1)) parent.set(find(siren), find(sirens[0]));
  }
  const groups = new Map();
  for (const conflict of conflicts) {
    const root = find(conflict.sirens[0]);
    if (!groups.has(root)) groups.set(root, { sirens: [], textures: new Set() });
    groups.get(root).textures.add(conflict.texture);
  }
  for (const siren of parent.keys()) groups.get(find(siren))?.sirens.push(siren);
  return [...groups.values()].map((group) => {
    const sirens = group.sirens.sort((a, b) => a - b);
    const options = new Map();
    for (const siren of sirens) {
      const colour = colours[siren];
      if (!colour) continue;
      if (!options.has(colour)) options.set(colour, []);
      options.get(colour).push(siren);
    }
    return { sirens, textures: [...group.textures], options: [...options].map(([colour, users]) => ({ colour, sirens: users })) };
  });
}

/**
 * The raw body of `write_lens_textures`: a little-endian u32 header length,
 * the JSON header, then each texture's DDS in header order. An added texture
 * names the dictionary it is copied from, which the host checks again.
 */
export function encodeLensWriteBody(prepared, stamp) {
  const header = {
    modelPath: prepared.modelPath,
    stamp,
    ytds: prepared.files.map((file) => ({
      path: file.path,
      textures: file.textures.map((texture) => ({ name: texture.name, mode: texture.mode, source: texture.source, length: texture.bytes.length })),
    })),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const payload = prepared.files.reduce((sum, file) => sum + file.textures.reduce((inner, texture) => inner + texture.bytes.length, 0), 0);
  const body = new Uint8Array(4 + json.length + payload);
  new DataView(body.buffer).setUint32(0, json.length, true);
  body.set(json, 4);
  let offset = 4 + json.length;
  for (const file of prepared.files) {
    for (const texture of file.textures) {
      body.set(texture.bytes, offset);
      offset += texture.bytes.length;
    }
  }
  return body;
}

/** Sends a prepared write. Resolves `{ files: [{ path, backup, textures }] }`. */
export function writeLensTextures({ invoke, prepared, date = new Date() }) {
  if (!canWriteLens(prepared)) return Promise.reject(new Error("This lens write has unresolved problems."));
  return invoke("write_lens_textures", encodeLensWriteBody(prepared, backupStamp(date)));
}
