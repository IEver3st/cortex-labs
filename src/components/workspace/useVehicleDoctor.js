import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { buildVehicleReport } from "../../lib/pack-doctor.js";
import { readModelResourceMeta } from "../../lib/resource-meta-files.js";
import { createEmptyResourceMeta, kitMatchesName, simulateVehicle } from "../../lib/vehicle-meta.js";
import { doctorGenerator, errorText } from "./useDoctorReport.js";

const VANILLA_PARENT = /^(vehshare|vehicles_)/i;
const fileName = (path) => String(path || "").split(/[\\/]/).pop() || "";
const folderOf = (path) => String(path || "").replace(/[\\/][^\\/]*$/, "");

export const vehicleModelName = (modelPath) => fileName(modelPath).replace(/\.(yft|clmesh)$/i, "").replace(/_hi$/i, "");

export async function readModelTextures(modelPath, meta, modelName) {
  const txdName = simulateVehicle(meta, modelName).txd.txdName || modelName;
  const dir = modelPath.replace(/[\\/][^\\/]+$/, "");
  const entries = await readDir(dir);
  const dictionaries = entries.filter((entry) => !entry.isDirectory &&
    [txdName.toLowerCase(), `${txdName.toLowerCase()}+hi`, modelName.toLowerCase()].includes(entry.name.replace(/\.ytd$/i, "").toLowerCase()) && /\.ytd$/i.test(entry.name));
  if (!dictionaries.length) return null;
  const exported = await Promise.all(dictionaries.map((entry) => invoke("export_ytd", { path: `${dir}/${entry.name}` })));
  return exported.flatMap((listing) => listing.textures || []);
}

export function simulateModel(scan, modelName, textures, modelInfo) {
  return simulateVehicle(scan.meta, modelName, {
    availableTextureNames: textures?.map((texture) => texture.name),
    liveryTexturePrefix: modelInfo?.liveryTexturePrefix,
    lightBones: modelInfo?.lights?.lightBones,
  });
}

export async function readVehicleDoctorData(modelPath) {
  if (!/\.yft$/i.test(modelPath)) {
    return { dictionaries: null, dictionariesError: "Only .yft models list their own dictionaries", assets: null, assetsError: "Only .yft models are measured", checkedAt: new Date().toISOString() };
  }
  await invoke("allow_model_resource", { path: modelPath }).catch(() => null);
  const [dictionaries, assets] = await Promise.allSettled([
    invoke("livery_dictionaries", { modelPath }),
    invoke("describe_streamed_assets", { models: [modelPath] }),
  ]);
  return {
    dictionaries: dictionaries.status === "fulfilled" ? dictionaries.value?.dictionaries || [] : null,
    dictionariesError: dictionaries.status === "rejected" ? errorText(dictionaries.reason) : "",
    assets: assets.status === "fulfilled" ? assets.value : null,
    assetsError: assets.status === "rejected" ? errorText(assets.reason) : "",
    checkedAt: new Date().toISOString(),
  };
}

export const parentDictionaryNames = (parentChain) => (parentChain || []).filter((name) => name && !VANILLA_PARENT.test(name));
export const ownDictionaryNames = (dictionaries) => (dictionaries || []).map((entry) => String(entry.name || fileName(entry.path)).toLowerCase());

export async function readParentDictionaries(modelPath, wanted, own) {
  const dir = folderOf(modelPath);
  let entries = [];
  try { entries = await readDir(dir); } catch { entries = []; }
  const list = [];
  for (const name of wanted) {
    const file = entries.find((entry) => !entry.isDirectory && entry.name.toLowerCase() === `${name.toLowerCase()}.ytd`);
    if (!file || own.includes(file.name.toLowerCase())) continue;
    const path = `${dir}/${file.name}`;
    try {
      const listing = await invoke("export_ytd", { path });
      list.push({ name, path, textures: (listing?.textures || []).map((texture) => texture.name).filter(Boolean) });
    } catch (error) {
      list.push({ name, path, textures: null, error: String(error?.message || error || "It could not be read") });
    }
  }
  return list;
}

export function vehicleDoctorReport({ modelPath, scan, sim, modelInfo, data, parents, meshStats, generator }) {
  const names = sim?.variation?.kits || [];
  const kits = (scan?.meta?.kits || []).filter((kit) => names.some((name) => kitMatchesName(kit, name)));
  return buildVehicleReport({
    modelPath,
    root: scan.root || folderOf(modelPath),
    sim,
    metaStatus: scan.meta?.sources?.length ? "ready" : scan.meta?.errors?.length ? "error" : "none",
    liveryPrefix: modelInfo?.liveryTexturePrefix || "",
    kits,
    dictionaries: data.dictionaries,
    dictionariesError: data.dictionariesError,
    parents,
    assets: data.assets,
    assetsError: data.assetsError,
    meshStats,
    createdAt: data.checkedAt,
    generator,
  });
}

async function readVehicleScan(modelPath, modelName) {
  const empty = { path: modelPath, status: "ready", root: "", meta: createEmptyResourceMeta() };
  if (!/\.(yft|clmesh)$/i.test(modelPath)) return { scan: empty, textures: null };
  let scan = empty;
  let textures = null;
  try {
    await invoke("allow_model_resource", { path: modelPath });
    scan = { path: modelPath, status: "ready", ...(await readModelResourceMeta(modelPath, { readDir, readTextFile })) };
    textures = await readModelTextures(modelPath, scan.meta, modelName);
  } catch (error) {
    scan = { ...scan, meta: { ...scan.meta, errors: [...scan.meta.errors, { path: modelPath, message: errorText(error) }] } };
  }
  return { scan, textures };
}

export async function collectVehicleDoctor({ modelPath, modelInfo }) {
  const modelName = vehicleModelName(modelPath);
  const { scan, textures } = await readVehicleScan(modelPath, modelName);
  const sim = modelName ? simulateModel(scan, modelName, textures, modelInfo) : null;
  const data = await readVehicleDoctorData(modelPath);
  const wanted = parentDictionaryNames(sim?.txd?.parentChain);
  const parents = wanted.length ? await readParentDictionaries(modelPath, wanted, ownDictionaryNames(data.dictionaries)) : [];
  return { modelPath, scan, sim, modelInfo, data, parents, generator: await doctorGenerator() };
}

const unavailable = (reason) => ({ status: "unavailable", reason, report: null });

export default function useVehicleDoctor({ modelPath, modelInfo, meshStats, isTauriRuntime, enabled = true }) {
  const [state, setState] = useState({ modelPath: "", status: "idle", inputs: null, reason: "" });
  const meshRef = useRef(meshStats);
  meshRef.current = meshStats;
  const runRef = useRef(0);

  const check = useCallback(async () => {
    if (!isTauriRuntime) return unavailable("Pack Doctor reads the vehicle's files, so it needs the desktop app.");
    if (!modelPath) return unavailable("No vehicle is loaded.");
    const id = ++runRef.current;
    setState({ modelPath, status: "checking", inputs: null, reason: "" });
    try {
      const inputs = await collectVehicleDoctor({ modelPath, modelInfo });
      if (runRef.current === id) setState({ modelPath, status: "ready", inputs, reason: "" });
      return { status: "ready", reason: "", report: vehicleDoctorReport({ ...inputs, meshStats: meshRef.current }) };
    } catch (error) {
      const reason = `Pack Doctor couldn't read the vehicle's files: ${errorText(error)}`;
      if (runRef.current === id) setState({ modelPath, status: "unavailable", inputs: null, reason });
      return unavailable(reason);
    }
  }, [modelPath, modelInfo, isTauriRuntime]);

  useEffect(() => {
    if (enabled) check();
  }, [check, enabled]);

  const report = useMemo(() => (state.inputs && state.modelPath === modelPath ? vehicleDoctorReport({ ...state.inputs, meshStats }) : null), [state, modelPath, meshStats]);
  if (!isTauriRuntime) return { ...unavailable("Pack Doctor reads the vehicle's files, so it needs the desktop app."), check };
  if (state.modelPath !== modelPath || state.status === "idle") return { status: "checking", reason: "", report: null, check };
  return { status: state.status, reason: state.reason, report, check };
}
