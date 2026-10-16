import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { listResourceModelFiles, readModelResourceMeta, readResourceTextEntries } from "../../lib/resource-meta-files.js";
import { indexModelFiles, listVehicleModkits, resolveModSelection } from "../../lib/vehicle-modkits.js";
import { normalizeModChoices, normalizeSavedBuilds, removeSavedBuild, upsertSavedBuild } from "../../lib/kit-shoot.js";

const IDLE_SCAN = Object.freeze({ path: "", status: "idle", root: "", kits: [], modelIndex: new Map(), errors: [], nameSources: [] });
const NO_SELECTION = Object.freeze({});
const EMPTY_RESOLUTION = Object.freeze({ parts: [], missing: [], hiddenBones: [] });
const BUILDS_KEY = "cortex-labs:modkit-builds.v1";
const NO_BUILDS = Object.freeze([]);
// The bridge's shared texture index takes seconds to build and every mod part
// needs it. A vehicle loaded from the parse cache never started it, so it is
// built in the background once per session, as soon as a kit is found.
let bridgeWarmRequested = false;
function warmBridgeForModParts() {
  if (bridgeWarmRequested) return;
  bridgeWarmRequested = true;
  invoke("warm_codewalker_bridge").catch((error) => {
    console.warn("[modkits] Bridge warm-up failed; the first part will build the texture index:", error);
  });
}

function loadBuildStore() {
  try {
    return normalizeSavedBuilds(JSON.parse(localStorage.getItem(BUILDS_KEY) || "null"));
  } catch {
    return normalizeSavedBuilds(null);
  }
}

export function vehicleModelName(modelPath) {
  return modelPath?.split(/[\\/]/).pop()?.replace(/\.(yft|clmesh)$/i, "").replace(/_hi$/i, "") || "";
}

/* Scans the vehicle's resource for carcols mod kits and their model files once
   the user asks for them, and holds the per-model mod selection that drives the
   viewer. Selections reset when a different model loads. Kit Shoot drives the
   viewer through `setShootOverride` while it runs, leaving the selection alone,
   and named builds persist per vehicle model. The workspace saves
   `savedSelection` and hands it back through `restore` when it reopens. */
export default function useVehicleModkits({ modelPath, enabled }) {
  const [scan, setScan] = useState(IDLE_SCAN);
  const [requestedPath, setRequestedPath] = useState("");
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState({ path: "", kitName: "", mods: NO_SELECTION });
  const [override, setOverride] = useState(null);
  const [buildStore, setBuildStore] = useState(loadBuildStore);
  const [buildsError, setBuildsError] = useState("");
  const eligible = Boolean(enabled && modelPath && /\.yft$/i.test(modelPath));
  const modelName = vehicleModelName(modelPath);
  const requested = eligible && requestedPath === modelPath;

  useEffect(() => {
    if (!requested) {
      setScan(IDLE_SCAN);
      return undefined;
    }
    const controller = new AbortController();
    const { signal } = controller;
    setScan({ ...IDLE_SCAN, path: modelPath, status: "scanning" });
    (async () => {
      await invoke("allow_model_resource", { path: modelPath });
      if (signal.aborted) return;
      const { root, meta } = await readModelResourceMeta(modelPath, { readDir, readTextFile, signal });
      let { kits } = listVehicleModkits(meta, modelName);
      const errors = [...meta.errors];
      let modelIndex = new Map();
      let nameSources = [];
      if (kits.length > 0) {
        const listing = await listResourceModelFiles(root, modelPath, { readDir, signal });
        modelIndex = indexModelFiles(listing.paths);
        errors.push(...listing.errors);
        // Unreadable scripts (often escrowed) only cost names, so they are not reported.
        const text = await readResourceTextEntries(root, { readDir, readTextFile, signal });
        nameSources = text.sources;
        if (text.entries.size > 0) kits = listVehicleModkits(meta, modelName, { textEntries: text.entries }).kits;
      }
      if (signal.aborted) return;
      if (kits.length > 0) warmBridgeForModParts();
      setScan({ path: modelPath, status: "ready", root, kits, modelIndex, errors, nameSources });
    })().catch((error) => {
      if (signal.aborted || error?.name === "AbortError") return;
      setScan({ ...IDLE_SCAN, path: modelPath, status: "error", errors: [{ path: modelPath, message: String(error?.message || error) }] });
    });
    return () => controller.abort();
  }, [requested, modelPath, modelName, revision]);

  const current = scan.path === modelPath ? scan : IDLE_SCAN;
  const ownSelection = selection.path === modelPath ? selection : null;
  const activeKit = current.kits.find((kit) => kit.kitName === ownSelection?.kitName) || current.kits[0] || null;
  const mods = ownSelection?.mods || NO_SELECTION;

  const resolution = useMemo(
    () => (activeKit ? resolveModSelection(activeKit, mods, current.modelIndex) : EMPTY_RESOLUTION),
    [activeKit, mods, current.modelIndex],
  );
  const selectedMods = useMemo(
    () => (resolution.parts.length || resolution.hiddenBones.length
      ? { parts: resolution.parts, hiddenBones: resolution.hiddenBones }
      : null),
    [resolution],
  );
  const shootMods = override?.path === modelPath ? override.mods : null;
  const vehicleMods = shootMods || selectedMods;

  const setShootOverride = useCallback((mods) => {
    setOverride(mods ? { path: modelPath, mods } : null);
  }, [modelPath]);

  const builds = buildStore.vehicles[modelName.toLowerCase()] || NO_BUILDS;
  const persistBuilds = useCallback((next) => {
    setBuildStore(next);
    try {
      localStorage.setItem(BUILDS_KEY, JSON.stringify(next));
      setBuildsError("");
    } catch {
      setBuildsError("Builds couldn't be saved, so they'll be lost when the app closes.");
    }
  }, []);
  const saveBuild = useCallback((name) => {
    if (!activeKit) return;
    persistBuilds(upsertSavedBuild(buildStore, modelName, { name, kitName: activeKit.kitName, mods }));
  }, [activeKit, buildStore, modelName, mods, persistBuilds]);
  const deleteBuild = useCallback((name) => {
    persistBuilds(removeSavedBuild(buildStore, modelName, name));
  }, [buildStore, modelName, persistBuilds]);
  const applyBuild = useCallback((name) => {
    const build = builds.find((entry) => entry.name === name);
    if (!build) return;
    const kitName = current.kits.some((kit) => kit.kitName === build.kitName) ? build.kitName : activeKit?.kitName || "";
    setSelection({ path: modelPath, kitName, mods: { ...build.mods } });
  }, [builds, current.kits, activeKit, modelPath]);

  const request = useCallback(() => {
    if (eligible) setRequestedPath(modelPath);
  }, [eligible, modelPath]);
  const rescan = useCallback(() => setRevision((value) => value + 1), []);
  const setKit = useCallback((kitName) => {
    setSelection({ path: modelPath, kitName, mods: NO_SELECTION });
  }, [modelPath]);
  const setMod = useCallback((slotType, index) => {
    setSelection((prev) => {
      const base = prev.path === modelPath ? prev : { path: modelPath, kitName: activeKit?.kitName || "", mods: NO_SELECTION };
      const next = { ...base.mods };
      if (Number.isInteger(index)) next[slotType] = index;
      else delete next[slotType];
      return { ...base, mods: next };
    });
  }, [modelPath, activeKit]);
  const clear = useCallback(() => {
    setSelection((prev) => (prev.path === modelPath ? { ...prev, mods: NO_SELECTION } : prev));
  }, [modelPath]);

  // The kit and parts chosen on the loaded model, or null when it is all stock.
  const savedSelection = useMemo(
    () => (ownSelection && Object.keys(ownSelection.mods).length
      ? { path: ownSelection.path, kitName: ownSelection.kitName, mods: ownSelection.mods }
      : null),
    [ownSelection],
  );
  /** Brings back a saved selection for its model and scans the resource so the parts load. */
  const restore = useCallback((saved) => {
    const path = typeof saved?.path === "string" ? saved.path : "";
    const restoredMods = normalizeModChoices(saved?.mods);
    if (!path || Object.keys(restoredMods).length === 0) return;
    setSelection({ path, kitName: typeof saved.kitName === "string" ? saved.kitName : "", mods: restoredMods });
    setRequestedPath(path);
  }, []);

  return {
    eligible,
    modelName,
    status: current.status,
    root: current.root,
    errors: current.errors,
    nameSources: current.nameSources,
    kits: current.kits,
    activeKit,
    selection: mods,
    resolution,
    vehicleMods,
    shooting: Boolean(shootMods),
    setShootOverride,
    builds,
    buildsError,
    saveBuild,
    deleteBuild,
    applyBuild,
    modelIndex: current.modelIndex,
    request,
    rescan,
    setKit,
    setMod,
    clear,
    savedSelection,
    restore,
  };
}
