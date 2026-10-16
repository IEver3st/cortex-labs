import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { exists, readDir, readFile, writeFile } from "@tauri-apps/plugin-fs";
import { checkVcf, createVcf, createVcfText, isVcfText, parseVcf, serializeVcf } from "../../lib/els-vcf.js";
import { loadPatternPack, packFromElsFivem, savePatternPack, summarizePatternPack } from "../../lib/els-patterns.js";
import { defaultElsPreview, normalizeElsPreview } from "../../lib/els-lights.js";
import {
  baseName,
  decodeVcfBytes,
  elsFolderKind,
  encodeVcfText,
  findVcf,
  linkFor,
  loadElsFolders,
  loadElsLinks,
  modelNameFromPath,
  parentDir,
  registerVcfInVcfLua,
  saveElsFolders,
  saveElsLinks,
  vcfPathIn,
  withFolder,
  withLink,
  withoutFolder,
} from "../../lib/els-library.js";
import { backupPathFor } from "../../lib/siren-install.js";

// ELS lighting for the loaded vehicle: finds its VCF (els-library.js), keeps
// the edit draft with undo, previews it through the viewer's light rig, and
// writes it back only on an explicit Save, after a timestamped .bak of the
// file it replaces. Files are read as bytes and written back in the encoding
// they came in, so a backup is an exact copy and untouched text keeps its
// bytes. The open file is watched, so a change made elsewhere reaches the
// lights. Sirens edits the VCF and switches between carcols sirens and ELS;
// Livery and All switch it from their Lights panel. Nothing here reads files
// outside those workspaces.

const HISTORY_LIMIT = 200;
const COALESCE_MS = 700;
const VCF_FILTERS = [{ name: "ELS vehicle configuration", extensions: ["xml"] }];

const EMPTY = Object.freeze({
  path: "",
  status: "idle",
  file: null,
  base: null,
  draft: null,
  past: [],
  future: [],
  lastKey: null,
  lastAt: 0,
  error: "",
  saved: null,
  // The open file changed on disk: { text, encoding } held back while there
  // are unsaved edits, or { error } when the new contents can't be read.
  onDisk: null,
  preview: defaultElsPreview(),
});

// Debounce for file events: editors write in several steps.
const WATCH_DEBOUNCE_MS = 250;
let watchSerial = 0;

function errorText(error) {
  return String(error?.message || error || "Unknown error");
}

function joinPath(dir, name) {
  if (!name) return dir;
  const separator = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${separator}${name.replace(/\//g, separator)}`;
}

async function readDecoded(path) {
  return decodeVcfBytes(await readFile(path));
}

function fingerprint(config) {
  return config ? JSON.stringify(config) : "";
}

/** The entry with the open file's new contents from disk as base and draft.
    Preview switches stay, so the lights keep playing on the new values. */
function fromDisk(current, { text, encoding }) {
  const path = current.file.path;
  try {
    const config = parseVcf(text, path);
    return { ...current, file: { ...current.file, text, encoding }, base: config, draft: config, past: [], future: [], lastKey: null, error: "", saved: null, onDisk: null };
  } catch (error) {
    return { ...current, onDisk: { error: `${baseName(path)} changed on disk and can't be read: ${errorText(error)}. The lights show the last version that loaded.` } };
  }
}

function storage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/**
 * `modelExtras`: extra numbers on the loaded model. `active`: a vehicle
 * workspace that ELS can drive (Sirens, Livery, All) is showing, so discovery
 * may read files.
 */
export default function useEls({ modelPath, isTauriRuntime, modelExtras = [], active = false }) {
  const [links, setLinks] = useState(() => loadElsLinks(storage()));
  const [folders, setFolders] = useState(() => loadElsFolders(storage()));
  const [pack, setPack] = useState(() => loadPatternPack(storage()));
  const [entry, setEntry] = useState(EMPTY);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState("");
  const [folderErrors, setFolderErrors] = useState({});
  const [rescanToken, setRescanToken] = useState(0);
  const state = entry.path === modelPath ? entry : { ...EMPTY, path: modelPath };
  const dirty = Boolean(state.draft) && fingerprint(state.draft) !== fingerprint(state.base);
  const modelName = modelNameFromPath(modelPath);
  const link = linkFor(links, modelPath);
  const linksRef = useRef(links);
  linksRef.current = links;
  const foldersRef = useRef(folders);
  foldersRef.current = folders;

  const modelRef = useRef(modelPath);
  modelRef.current = modelPath;
  // Bumped when the user opens, creates or saves a VCF: a scan that started
  // earlier must not replace that choice.
  const choice = useRef(0);
  // A load or save finishing after a vehicle switch leaves the new vehicle's scan alone.
  const claim = useCallback(() => {
    if (modelRef.current === modelPath) choice.current += 1;
  }, [modelPath]);

  const update = useCallback((recipe) => {
    setEntry((current) => {
      if (current.path === modelPath) return recipe(current);
      // A load or save finishing after the vehicle changed leaves the new one alone.
      return modelRef.current === modelPath ? recipe({ ...EMPTY, path: modelPath }) : current;
    });
  }, [modelPath]);

  const remember = useCallback((patch) => {
    const next = withLink(linksRef.current, modelPath, patch);
    linksRef.current = next;
    setLinks(next);
    const result = saveElsLinks(next, storage());
    if (!result.ok) setStatus({ tone: "error", text: `Could not remember the ELS choice for this vehicle: ${result.error}` });
  }, [modelPath]);

  // Discovery: once per model while a vehicle workspace shows, and on Rescan.
  // Unsaved edits are never replaced by what is on disk.
  const scanned = useRef("");
  useEffect(() => {
    if (!active || !modelPath || !isTauriRuntime) return undefined;
    const key = `${modelPath}|${rescanToken}`;
    if (scanned.current === key) return undefined;
    scanned.current = key;
    const choiceAtStart = choice.current;
    let cancelled = false;
    setEntry((current) => ({ ...(current.path === modelPath ? current : EMPTY), path: modelPath, status: "scanning" }));
    (async () => {
      await invoke("allow_model_resource", { path: modelPath }).catch(() => {});
      // Picker grants last one session; reopen saved folders for this one.
      const errors = {};
      for (const folder of foldersRef.current) {
        await invoke("allow_els_folder", { path: folder.path }).catch((error) => { errors[folder.path] = errorText(error); });
      }
      const linkedPath = linkFor(linksRef.current, modelPath)?.vcfPath || "";
      if (linkedPath) await invoke("allow_els_folder", { path: linkedPath }).catch(() => {});
      const found = await findVcf({ modelPath, linkedPath, folders: foldersRef.current, readDir, readTextFile: readDecoded });
      if (cancelled) return;
      setFolderErrors(errors);
      setEntry((current) => {
        if (current.path !== modelPath) return current;
        const editing = Boolean(current.draft) && fingerprint(current.draft) !== fingerprint(current.base);
        if (editing || !found || choice.current !== choiceAtStart) return { ...current, status: "ready" };
        try {
          const config = parseVcf(found.text, found.path);
          return { ...current, status: "ready", file: found, base: config, draft: config, past: [], future: [], error: "", onDisk: null };
        } catch (error) {
          return { ...current, status: "ready", file: found, base: null, draft: null, error: `${baseName(found.path)}: ${errorText(error)}` };
        }
      });
    })();
    return () => {
      cancelled = true;
      if (scanned.current === key) scanned.current = "";
    };
  }, [active, modelPath, isTauriRuntime, rescanToken]);

  // Carcols stays the default: ELS takes over a vehicle's lights only once the
  // user picks it (or opens or creates a VCF) for that vehicle.
  const enabled = link?.enabled === true;
  const setEnabled = useCallback((value) => remember({ enabled: Boolean(value) }), [remember]);

  const edit = useCallback((recipe, key = null) => {
    update((current) => {
      if (!current.draft) return current;
      const next = JSON.parse(JSON.stringify(current.draft));
      const result = recipe(next);
      const draft = result && typeof result === "object" ? result : next;
      if (fingerprint(draft) === fingerprint(current.draft)) return current;
      const now = Date.now();
      const coalesce = key && current.lastKey === key && now - current.lastAt < COALESCE_MS;
      const past = coalesce ? current.past : [...current.past, current.draft].slice(-HISTORY_LIMIT);
      return { ...current, draft, past, future: [], lastKey: key, lastAt: now, saved: null };
    });
  }, [update]);

  const undo = useCallback(() => update((current) => {
    if (!current.past.length) return current;
    const draft = current.past[current.past.length - 1];
    return { ...current, draft, past: current.past.slice(0, -1), future: [current.draft, ...current.future], lastKey: null };
  }), [update]);

  const redo = useCallback(() => update((current) => {
    if (!current.future.length) return current;
    const [draft, ...future] = current.future;
    return { ...current, draft, past: [...current.past, current.draft], future, lastKey: null };
  }), [update]);

  // Back to the file: its newer contents when it changed on disk meanwhile.
  const revert = useCallback(() => update((current) => (current.onDisk?.text != null ? fromDisk(current, current.onDisk) : {
    ...current,
    draft: current.base,
    past: current.draft ? [...current.past, current.draft].slice(-HISTORY_LIMIT) : current.past,
    future: [],
    file: current.base ? current.file : null,
  })), [update]);

  // Live reload: the open VCF is watched while ELS can drive this vehicle, so
  // an edit in a text editor or a Save in another tab reaches the lights. With
  // no unsaved edits here the change loads; with edits it waits for the user.
  const filePath = state.file?.path || "";
  const [watch, setWatch] = useState({ path: "", status: "off", error: "" });
  const reloadFromDisk = useCallback(async (path) => {
    let read;
    try {
      read = await readDecoded(path);
    } catch (error) {
      // Mid-save or deleted: the next event reads it again.
      update((current) => (current.file?.path === path
        ? { ...current, onDisk: { error: `${baseName(path)} can't be read: ${errorText(error)}. The lights show the last version that loaded.` } }
        : current));
      return;
    }
    update((current) => {
      if (current.file?.path !== path) return current;
      if (current.file.text === read.text) return current.onDisk ? { ...current, onDisk: null } : current;
      if (fingerprint(current.draft) !== fingerprint(current.base)) return { ...current, onDisk: read };
      return fromDisk(current, read);
    });
  }, [update]);
  const reloadRef = useRef(reloadFromDisk);
  reloadRef.current = reloadFromDisk;
  useEffect(() => {
    if (!active || !isTauriRuntime || !filePath) return undefined;
    // A fresh id per run, so a late stop for the previous run can't end this one.
    watchSerial += 1;
    const id = `els-${watchSerial}-${Math.random().toString(36).slice(2, 8)}`;
    let disposed = false;
    let unlisten = null;
    let timer = null;
    (async () => {
      try {
        // The keyed file watcher EUP and Prop Studio use; events name their id.
        unlisten = await listen("eup:update", (event) => {
          if (event.payload?.id !== id) return;
          clearTimeout(timer);
          timer = setTimeout(() => reloadRef.current(filePath), WATCH_DEBOUNCE_MS);
        });
        if (disposed) {
          unlisten();
          return;
        }
        await invoke("start_eup_watch", { id, paths: [filePath] });
        if (!disposed) setWatch({ path: filePath, status: "on", error: "" });
      } catch (error) {
        if (!disposed) setWatch({ path: filePath, status: "error", error: errorText(error) });
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(timer);
      unlisten?.();
      invoke("stop_eup_watch", { id }).catch(() => {});
    };
  }, [active, isTauriRuntime, filePath]);
  const loadFromDisk = useCallback(() => update((current) => (current.onDisk?.text != null ? fromDisk(current, current.onDisk) : current)), [update]);

  const setPreview = useCallback((patch) => update((current) => ({
    ...current,
    preview: normalizeElsPreview({ ...current.preview, ...(typeof patch === "function" ? patch(current.preview) : patch) }),
  })), [update]);

  const createNew = useCallback((dialect) => {
    const config = createVcf(dialect, { extras: modelExtras, modelName });
    claim();
    update((current) => ({ ...current, file: null, base: null, draft: config, past: [], future: [], error: "", saved: null, onDisk: null }));
    remember({ enabled: true });
    setStatus(null);
  }, [claim, modelExtras, modelName, remember, update]);

  const loadFile = useCallback(async (path) => {
    await invoke("allow_els_folder", { path }).catch(() => {});
    const { text, encoding } = await readDecoded(path);
    if (!isVcfText(text)) throw new Error(`${baseName(path)} is not an ELS VCF (no <vcfroot>).`);
    const config = parseVcf(text, path);
    claim();
    update((current) => ({ ...current, file: { path, text, encoding, origin: "linked" }, base: config, draft: config, past: [], future: [], error: "", saved: null, onDisk: null }));
    remember({ vcfPath: path, enabled: true });
  }, [claim, remember, update]);

  const openDialog = useCallback(async () => {
    // Opening replaces the draft and its undo history, so unsaved edits stop it.
    if (dirty) {
      setStatus({ tone: "warn", text: "Save or discard your VCF edits before opening another file." });
      return;
    }
    setStatus(null);
    const defaultPath = folders[0]?.path || parentDir(modelPath) || undefined;
    const picked = await open({ multiple: false, directory: false, filters: VCF_FILTERS, defaultPath, title: "Open an ELS VCF" }).catch((error) => {
      setStatus({ tone: "error", text: `Open failed: ${errorText(error)}` });
      return null;
    });
    if (!picked || Array.isArray(picked)) return;
    try {
      await loadFile(picked);
      setStatus({ tone: "ok", text: "Opened", path: picked });
    } catch (error) {
      setStatus({ tone: "error", text: `Could not open ${baseName(picked)}: ${errorText(error)}` });
    }
  }, [dirty, folders, loadFile, modelPath]);

  // ELS-FiveM reads only the VCFs vcf.lua lists; a new file in its vcf folder
  // is added there too. Returns status lines, or null when not ELS-FiveM.
  const registerIfElsFivem = useCallback(async (path) => {
    const folder = parentDir(path);
    if (baseName(folder).toLowerCase() !== "vcf") return null;
    const listPath = joinPath(parentDir(folder), "vcf.lua");
    if (!(await exists(listPath).catch(() => false))) return null;
    const { text: before, encoding } = await readDecoded(listPath);
    const name = baseName(path);
    const { text, changed, listedAs } = registerVcfInVcfLua(before, name);
    if (!changed) {
      return [listedAs === name
        ? { tone: "ok", text: "Already listed in vcf.lua" }
        : { tone: "warn", text: `vcf.lua lists it as "${listedAs}"; servers on Linux need the exact name "${name}".`, path: listPath }];
    }
    // The backup sits beside vcf.lua, outside the folders the renderer may
    // write; the native side copies it after checking the name.
    const backup = backupPathFor(listPath);
    await invoke("backup_vcf_list", { list: listPath, backup });
    await writeFile(listPath, encodeVcfText(text, encoding));
    return [
      { tone: "ok", text: "Backed up vcf.lua", path: backup },
      { tone: "ok", text: "Listed in vcf.lua", path: listPath },
    ];
  }, []);

  const writeTo = useCallback(async (path, { expectText = null } = {}) => {
    const draft = state.draft;
    const file = state.file;
    const lines = [];
    const bytes = (await exists(path)) ? await readFile(path) : null;
    const before = bytes ? decodeVcfBytes(bytes).text : null;
    if (expectText != null && before != null && before !== expectText) {
      throw new Error(`${baseName(path)} changed on disk since it was opened. Load it from disk, or Save as to keep both.`);
    }
    // The edits patch the file they were made on, wherever it is saved, so its
    // interface, sounds, comments and unknown sections come along. A file
    // already at a Save as target is replaced after its backup.
    const text = file?.text ? serializeVcf(draft, file.text) : createVcfText(draft);
    const encoding = file?.encoding || "utf-8";
    // Encoding first: a character the file's encoding lacks stops the save before any write.
    const encoded = encodeVcfText(text, encoding);
    if (bytes) {
      const backup = backupPathFor(path);
      await writeFile(backup, bytes);
      lines.push({ tone: "ok", text: `Backed up ${baseName(path)}`, path: backup });
    }
    await writeFile(path, encoded);
    lines.push({ tone: "ok", text: before == null ? "Created" : "Saved", path });
    if (before == null) {
      // The folder holds a VCF now: open it (and an ELS-FiveM vcf.lua beside
      // it) so later saves can write their backups there.
      await invoke("allow_els_folder", { path }).catch(() => {});
      let registered = null;
      try {
        registered = await registerIfElsFivem(path);
        if (registered) lines.push(...registered);
      } catch (error) {
        lines.push({ tone: "warn", text: `Saved, but vcf.lua was not updated: ${errorText(error)}. Add "${baseName(path)}" to its vcf_files list.` });
      }
      // A new file outside the folders ELS scripts read is found by Cortex
      // but not by the game; say where it has to go.
      const folder = parentDir(path);
      const known = foldersRef.current.some((entry) => entry.path.replace(/\\/g, "/").toLowerCase() === folder.replace(/\\/g, "/").toLowerCase());
      if (!registered && !known && elsFolderKind(folder) === "folder") {
        lines.push({
          tone: "warn",
          text: draft.dialect === "miss-els"
            ? "MISS-ELS reads VCFs from resources/MISS-ELS/xmlFiles. Copy it there for the game to use it."
            : "ELS reads VCFs from its own folder: GTA V/ELS/pack_default for LSPDFR, resources/ELS-FiveM/vcf (listed in vcf.lua) for FiveM. Copy it there for the game to use it.",
        });
      }
    }
    const config = parseVcf(text, path);
    claim();
    update((current) => ({
      ...current,
      file: { path, text, encoding, origin: "linked" },
      base: config,
      draft: fingerprint(current.draft) === fingerprint(draft) ? config : current.draft,
      saved: path,
      onDisk: null,
    }));
    remember({ vcfPath: path, enabled: true });
    return lines;
  }, [claim, registerIfElsFivem, remember, state.draft, state.file, update]);

  const issues = useMemo(() => checkVcf(state.draft, { modelExtras }), [state.draft, modelExtras]);
  const blocking = issues.filter((entry) => entry.level === "error");

  const saveAs = useCallback(async () => {
    if (!state.draft) return;
    setStatus(null);
    // The open file, else an ELS folder for this dialect, else beside the
    // model, where discovery looks first.
    const folder = folders.find((entry) => (state.draft.dialect === "miss-els" ? entry.kind === "miss-els" : entry.kind !== "miss-els")) || folders[0];
    const name = modelName || "vehicle";
    const defaultPath = state.file?.path
      || (folder ? vcfPathIn(folder.path, name) : parentDir(modelPath) ? vcfPathIn(parentDir(modelPath), name) : `${name}.xml`);
    const path = await save({ defaultPath, filters: VCF_FILTERS, title: "Save the ELS VCF" }).catch((error) => {
      setStatus({ tone: "error", text: `Save failed: ${errorText(error)}` });
      return null;
    });
    if (!path) return;
    setBusy("save");
    try {
      await invoke("allow_els_folder", { path: parentDir(path) }).catch(() => {});
      const lines = await writeTo(path);
      setStatus({ lines });
    } catch (error) {
      setStatus({ tone: "error", text: `Save failed: ${errorText(error)}` });
    } finally {
      setBusy("");
    }
  }, [folders, modelName, modelPath, state.draft, state.file, writeTo]);

  const saveFile = useCallback(async () => {
    if (!state.draft) return;
    if (!state.file?.path) {
      await saveAs();
      return;
    }
    setStatus(null);
    setBusy("save");
    try {
      const lines = await writeTo(state.file.path, { expectText: state.file.text });
      setStatus({ lines });
    } catch (error) {
      setStatus({ tone: "error", text: `Save failed: ${errorText(error)}` });
    } finally {
      setBusy("");
    }
  }, [saveAs, state.draft, state.file, writeTo]);

  const copyXml = useCallback(async () => {
    if (!state.draft) return;
    try {
      const text = state.file?.text ? serializeVcf(state.draft, state.file.text) : createVcfText(state.draft);
      await navigator.clipboard.writeText(text);
      setStatus({ tone: "ok", text: "VCF copied to the clipboard" });
    } catch (error) {
      setStatus({ tone: "error", text: `Copy failed: ${errorText(error)}` });
    }
  }, [state.draft, state.file]);

  const importPatterns = useCallback(async () => {
    setStatus(null);
    // The picker grants the folder alone; the native side reads just the
    // three table files from it or its client/_patternTypes.
    const picked = await open({ directory: true, multiple: false, title: "Pick your ELS-FiveM resource folder" }).catch((error) => {
      setStatus({ tone: "error", text: `Import failed: ${errorText(error)}` });
      return null;
    });
    if (!picked || Array.isArray(picked)) return;
    setBusy("patterns");
    try {
      const { dir: from, files } = await invoke("read_els_pattern_tables", { path: picked });
      const next = packFromElsFivem(files, { path: from, importedAt: new Date().toISOString() });
      const result = savePatternPack(next, storage());
      setPack(next);
      const total = summarizePatternPack(next).total;
      setStatus(result.ok
        ? { tone: "ok", text: `Imported ${total} patterns from ELS-FiveM`, path: from }
        : { tone: "warn", text: `Imported ${total} patterns for this session, but they could not be stored: ${result.error}` });
    } catch (error) {
      setStatus({ tone: "error", text: `Import failed: ${errorText(error)}` });
    } finally {
      setBusy("");
    }
  }, []);

  const clearPatterns = useCallback(() => {
    const result = savePatternPack(null, storage());
    setPack(null);
    setStatus(result.ok ? { tone: "ok", text: "Pattern tables removed" } : { tone: "error", text: `Could not remove the tables: ${result.error}` });
  }, []);

  const addFolder = useCallback(async () => {
    setStatus(null);
    const picked = await open({ directory: true, multiple: false, title: "Pick a folder of ELS VCFs (for example GTA V/ELS/pack_default)" }).catch((error) => {
      setStatus({ tone: "error", text: `Add folder failed: ${errorText(error)}` });
      return null;
    });
    if (!picked || Array.isArray(picked)) return;
    try {
      const path = await invoke("allow_els_folder", { path: picked });
      const hasVcfLua = await exists(joinPath(parentDir(path), "vcf.lua")).catch(() => false);
      const next = withFolder(foldersRef.current, { path, kind: elsFolderKind(path, { hasVcfLua }) });
      foldersRef.current = next;
      setFolders(next);
      const result = saveElsFolders(next, storage());
      setStatus(result.ok ? { tone: "ok", text: "ELS folder added", path } : { tone: "warn", text: `Folder added for this session, but not stored: ${result.error}` });
      setRescanToken((value) => value + 1);
    } catch (error) {
      setStatus({ tone: "error", text: errorText(error) });
    }
  }, []);

  const removeFolder = useCallback((path) => {
    const next = withoutFolder(foldersRef.current, path);
    foldersRef.current = next;
    setFolders(next);
    saveElsFolders(next, storage());
  }, []);

  const rescan = useCallback(() => setRescanToken((value) => value + 1), []);
  // Stable while nothing changes: the viewer hands this to its light rig.
  const live = useMemo(
    () => (enabled && state.draft ? { config: state.draft, preview: state.preview, pack } : null),
    [enabled, state.draft, state.preview, pack],
  );

  return {
    modelName,
    status: state.status,
    file: state.file,
    base: state.base,
    draft: state.draft,
    error: state.error,
    saved: state.saved,
    onDisk: state.onDisk,
    // Live reload of the open file: "on", "error" (watchError says why) or "off".
    liveReload: filePath && watch.path === filePath ? watch.status : "off",
    watchError: watch.path === filePath ? watch.error : "",
    preview: state.preview,
    dirty,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    enabled,
    // The rig state while ELS is in charge of this vehicle's lights.
    live,
    issues,
    blocking,
    pack,
    folders,
    folderErrors,
    busy,
    toolStatus: status,
    clearStatus: () => setStatus(null),
    setEnabled,
    edit,
    undo,
    redo,
    revert,
    loadFromDisk,
    setPreview,
    createNew,
    openDialog,
    saveFile,
    saveAs,
    copyXml,
    importPatterns,
    clearPatterns,
    addFolder,
    removeFolder,
    rescan,
  };
}
