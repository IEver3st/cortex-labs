import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { createEmptyResourceMeta, simulateVehicle } from "../lib/vehicle-meta.js";
import { readModelResourceMeta } from "../lib/resource-meta-files.js";
import { findUlcConfig } from "../lib/ulc-config.js";
import MetaPanel from "./MetaPanel";
import VehicleLightsPanel from "./VehicleLightsPanel";
import VehiclePlatePanel from "./VehiclePlatePanel";
import VehiclePartsPanel from "./VehiclePartsPanel";

export default function VehicleMetaPanel({ modelPath, modelInfo, isTauriRuntime, onApplyLivery, onApplyColors, onToggleExtra, steeringAngle = 0, onSteeringChange, vehicleParts = null, vehiclePartControls = null, roofClip = null, lights, onLightsChange, getLightTime, plate, onPlateChange, plateStatus, extrasPlan, extrasState, onExtrasStateChange, els = null }) {
  const [scan, setScan] = useState(() => ({ path: "", status: "idle", root: "", meta: createEmptyResourceMeta() }));
  const [revision, setRevision] = useState(0);
  const [textures, setTextures] = useState(null);
  const [liveryIndex, setLiveryIndex] = useState(0);
  const [colorIndex, setColorIndex] = useState(null);
  const [notice, setNotice] = useState("");
  const [extras, setExtras] = useState([]);
  useEffect(() => { setExtras(modelInfo?.extras || []); }, [modelInfo]);
  const modelName = modelPath?.split(/[\\/]/).pop()?.replace(/\.(yft|clmesh)$/i, "").replace(/_hi$/i, "") || "";
  useEffect(() => {
    setLiveryIndex(0);
    setColorIndex(null);
    setNotice("");
    setTextures(null);
    if (!isTauriRuntime || !modelPath || !/\.(yft|clmesh)$/i.test(modelPath)) {
      setScan({ path: modelPath, status: "idle", root: "", meta: createEmptyResourceMeta() });
      return;
    }
    const controller = new AbortController();
    setScan({ path: modelPath, status: "scanning", root: "", meta: createEmptyResourceMeta() });
    (async () => {
      await invoke("allow_model_resource", { path: modelPath });
      if (controller.signal.aborted) return;
      const result = await readModelResourceMeta(modelPath, { readDir, readTextFile, signal: controller.signal });
      if (controller.signal.aborted) return;
      setScan({ path: modelPath, status: "ready", ...result });
      const txdName = simulateVehicle(result.meta, modelName).txd.txdName || modelName;
      const dir = modelPath.replace(/[\\/][^\\/]+$/, "");
      const entries = await readDir(dir);
      const dictionaries = entries.filter((entry) => !entry.isDirectory &&
        [txdName.toLowerCase(), `${txdName.toLowerCase()}+hi`, modelName.toLowerCase()].includes(entry.name.replace(/\.ytd$/i, "").toLowerCase()) && /\.ytd$/i.test(entry.name));
      if (!dictionaries.length) return;
      const exported = await Promise.all(dictionaries.map((entry) => invoke("export_ytd", { path: `${dir}/${entry.name}` })));
      if (!controller.signal.aborted) setTextures(exported.flatMap((listing) => listing.textures || []));
    })().catch((error) => {
      if (controller.signal.aborted) return;
      const message = String(error?.message || error);
      setScan((current) => ({ ...current, status: "ready", meta: { ...current.meta, errors: [...current.meta.errors, { path: modelPath, message }] } }));
    });
    return () => controller.abort();
  }, [modelPath, modelName, isTauriRuntime, revision]);
  const sim = useMemo(() => modelName && scan.path === modelPath ? simulateVehicle(scan.meta, modelName, {
    availableTextureNames: textures?.map((texture) => texture.name),
    liveryTexturePrefix: modelInfo?.liveryTexturePrefix,
    lightBones: modelInfo?.lights?.lightBones,
  }) : null, [scan, modelName, modelPath, textures, modelInfo]);
  // The resource's ULC config for this model, if its lighting script has one.
  const ulcResult = useMemo(() => {
    for (const file of scan.path === modelPath ? scan.ulcFiles || [] : []) {
      try {
        const config = findUlcConfig(file.text, modelName);
        if (config) return { config, path: file.path, error: "" };
      } catch (error) {
        return { config: null, path: file.path, error: String(error?.message || error) };
      }
    }
    return { config: null, path: "", error: "" };
  }, [scan, modelPath, modelName]);
  // Hand the model's carcols siren setting and ULC config to the viewer's light preview.
  const sirenSetting = sim?.sirenSetting || null;
  const scanReady = scan.status === "ready" && scan.path === modelPath;
  useEffect(() => {
    if (scanReady) onLightsChange?.({ setting: sirenSetting, ulc: ulcResult.config });
    // onLightsChange changes identity with the model path, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sirenSetting, ulcResult, scanReady, modelPath]);
  const extrasView = extrasPlan
    ? extras.map((extra) => {
      const reason = extrasPlan.reasons?.[extra.index];
      return { ...extra, visible: extrasPlan.on.includes(extra.index), label: reason ? `Extra ${extra.index} · ${reason}` : `Extra ${extra.index}` };
    })
    : extras;
  const applyLivery = (index) => {
    const expectedName = sim?.textureLiveries.expectedTextureNames[index];
    const texture = textures?.find((entry) => entry.name?.toLowerCase() === expectedName?.toLowerCase());
    if (!texture?.path) { setNotice(`Cannot preview ${expectedName}: texture was not found in a nearby YTD.`); return; }
    onApplyLivery(texture.path);
    setLiveryIndex(index);
    setNotice("");
  };
  return <>
    {!isTauriRuntime ? <p className="mp-note">Meta files require the desktop app.</p> : null}
    {notice ? <p className="mp-note" role="status">{notice}</p> : null}
    {onLightsChange ? (
      <VehicleLightsPanel lights={lights} onChange={onLightsChange} modelLights={modelInfo?.lights}
        setting={lights?.setting || null} getTime={getLightTime}
        ulc={lights?.ulc || null} ulcPath={ulcResult.path} ulcError={ulcResult.error}
        extrasPlan={extrasPlan} extrasState={extrasState} onExtrasStateChange={onExtrasStateChange} els={els}
        sirenStatus={!isTauriRuntime ? "Siren patterns come from carcols.meta, which the desktop app reads."
          : scan.status === "scanning" ? "Reading carcols.meta…"
            : sim?.ids?.sirenIds?.length ? `Siren setting id ${sim.ids.sirenIds[0]} is not defined in this resource's carcols.meta.`
              : "carvariations.meta sets no sirenSettings for this model."} />
    ) : null}
    {onPlateChange && modelInfo?.licensePlates != null ? (
      <VehiclePlatePanel plate={plate} onChange={onPlateChange} status={plateStatus}
        isTauriRuntime={isTauriRuntime} hasPlate={modelInfo.licensePlates > 0} />
    ) : null}
    <VehiclePartsPanel parts={vehicleParts} controls={vehiclePartControls} roofClip={roofClip} />
    <MetaPanel status={scan.status} resourceRoot={scan.root} sources={scan.meta.sources} errors={scan.meta.errors}
      sim={sim} liveryIndex={liveryIndex} onLiveryIndexChange={textures?.length ? applyLivery : undefined}
      selectedColorPreset={colorIndex} onApplyColorPreset={(preset) => { onApplyColors(preset); setColorIndex(preset.index); }}
      extras={extrasView} onToggleExtra={(index, visible) => {
        if (onToggleExtra(index, visible)) setExtras((current) => current.map((entry) => entry.index === index ? { ...entry, visible } : entry));
      }} steerableWheels={Boolean(modelInfo?.steerableWheels)} steeringAngle={steeringAngle} onSteeringChange={onSteeringChange}
      onRescan={() => setRevision((value) => value + 1)} onOpenFile={(path) => {
        invoke("open_model_meta_file", { modelPath, path })
          .then(() => setNotice(""))
          .catch((error) => setNotice(`Open file failed: ${String(error)}`));
      }} />
  </>;
}
