import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { createEmptyResourceMeta, simulateVehicle } from "../../lib/vehicle-meta.js";
import { readModelResourceMeta } from "../../lib/resource-meta-files.js";
import { findUlcConfig } from "../../lib/ulc-config.js";
import { createSirenSetting, nextFreeSirenId } from "../../lib/siren-settings.js";

// The Sirens workspace's view of the model's resource: the carcols siren
// setting carvariations links to the model, the ULC config, and what the editor
// needs to check and save a setting. It hands the setting and ULC config to the
// light preview the same way the Meta tab does in Vehicle.

const EMPTY_SCAN = Object.freeze({ path: "", status: "idle", root: "", meta: createEmptyResourceMeta(), ulcFiles: [] });

export function modelNameFromPath(modelPath) {
  return String(modelPath || "").split(/[\\/]/).pop()?.replace(/\.(yft|clmesh)$/i, "").replace(/_hi$/i, "") || "";
}

export function sirenBonesFrom(modelLights) {
  return (modelLights?.lightBones || []).flatMap((name) => /^siren(\d+)$/i.exec(name)?.slice(1).map(Number) ?? []);
}

export default function useSirenResource({ modelPath, modelInfo, isTauriRuntime, rescanToken = 0, onLightsChange }) {
  const [scan, setScan] = useState(EMPTY_SCAN);
  const [revision, setRevision] = useState(0);
  const modelName = modelNameFromPath(modelPath);
  const readable = Boolean(isTauriRuntime && modelPath && /\.(yft|clmesh)$/i.test(modelPath));

  useEffect(() => {
    if (!readable) {
      setScan({ ...EMPTY_SCAN, path: modelPath });
      return undefined;
    }
    const controller = new AbortController();
    // A rescan of the same model keeps the last result on screen until the new
    // one lands; blanking it makes dialogs flash "no resource" after every save.
    setScan((previous) => (previous.path === modelPath && previous.status === "ready"
      ? previous
      : { ...EMPTY_SCAN, path: modelPath, status: "scanning" }));
    (async () => {
      await invoke("allow_model_resource", { path: modelPath });
      if (controller.signal.aborted) return;
      const result = await readModelResourceMeta(modelPath, { readDir, readTextFile, signal: controller.signal });
      if (!controller.signal.aborted) setScan({ ulcFiles: [], ...result, path: modelPath, status: "ready" });
    })().catch((error) => {
      if (controller.signal.aborted) return;
      const message = String(error?.message || error);
      setScan({ ...EMPTY_SCAN, path: modelPath, status: "ready", meta: { ...createEmptyResourceMeta(), errors: [{ path: modelPath, message }] } });
    });
    return () => controller.abort();
  }, [modelPath, readable, revision, rescanToken]);

  const current = scan.path === modelPath;
  const scanReady = current && scan.status === "ready";
  const lightBones = modelInfo?.lights?.lightBones;
  const sim = useMemo(() => (modelName && current
    ? simulateVehicle(scan.meta, modelName, { lightBones })
    : null), [scan, modelName, current, lightBones]);

  const ulcResult = useMemo(() => {
    for (const file of current ? scan.ulcFiles || [] : []) {
      try {
        const config = findUlcConfig(file.text, modelName);
        if (config) return { config, path: file.path, text: file.text, error: "" };
      } catch (error) {
        return { config: null, path: file.path, text: file.text, error: String(error?.message || error) };
      }
    }
    // No config for this model: a ulc.lua the resource already has is where the builder adds one.
    const file = current ? scan.ulcFiles?.[0] : null;
    return { config: null, path: file?.path || "", text: file?.text || "", error: "" };
  }, [scan, current, modelName]);

  const setting = sim?.sirenSetting || null;
  const variationId = sim?.ids?.sirenIds?.[0] ?? null;
  const variationPath = sim?.variation?.sourcePath || "";
  const sirenContext = useMemo(() => (scanReady ? {
    modelName,
    resourceRoot: scan.root,
    carcolsPaths: scan.meta.sources.filter((source) => source.kind === "carcols").map((source) => source.path),
    settings: scan.meta.sirens.map(({ id, name, sourcePath }) => ({ id, name, sourcePath })),
    variationId,
    variationPath,
  } : null), [scanReady, scan, modelName, variationId, variationPath]);

  useEffect(() => {
    if (scanReady) onLightsChange?.({ setting, ulc: ulcResult.config, sirenContext });
    // onLightsChange changes identity with the model path, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setting, ulcResult, scanReady, modelPath, sirenContext]);

  /** A new setting: one siren per sirenN bone, the linked id when it is free, the model's name. */
  const createSetting = () => {
    const count = Math.max(0, ...sirenBonesFrom(modelInfo?.lights), ...(modelInfo?.lights?.sirens || []));
    const used = (sirenContext?.settings || []).map((entry) => entry.id);
    return createSirenSetting({
      id: nextFreeSirenId(used, variationId ?? 100),
      name: modelName,
      count: count || 2,
      headings: modelInfo?.lights?.sirenHeadings,
    });
  };

  // Why the model has no setting, in one line.
  const missingReason = !isTauriRuntime
    ? "Siren settings come from carcols.meta, which the desktop app reads."
    : !readable ? "Open a .yft vehicle to read its siren setting."
      : !scanReady ? "Reading the resource's meta files…"
        : variationId != null ? `carvariations.meta links siren setting ${variationId}, but no carcols.meta in this resource defines it.`
          : "carvariations.meta links no siren setting to this model.";

  return {
    status: current ? scan.status : "idle",
    root: current ? scan.root : "",
    sources: current ? scan.meta.sources : [],
    // Model names every vehicle in the resource registers (for the renamer).
    modelNames: current ? scan.meta.vehicles.map((vehicle) => vehicle.modelName).filter(Boolean) : [],
    vehicleEntry: current ? scan.meta.vehicles.find((vehicle) => vehicle.modelName.toLowerCase() === modelName.toLowerCase()) || null : null,
    errors: current ? scan.meta.errors : [],
    setting,
    variationId,
    ulcResult,
    sirenContext,
    modelName,
    missingReason,
    createSetting,
    rescan: () => setRevision((value) => value + 1),
  };
}
