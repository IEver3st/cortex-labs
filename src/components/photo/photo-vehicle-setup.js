import { invoke } from "@tauri-apps/api/core";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { listResourceModelFiles, readModelResourceMeta, readResourceTextEntries } from "../../lib/resource-meta-files.js";
import { simulateVehicle } from "../../lib/vehicle-meta.js";
import { indexModelFiles, joaat, listVehicleModkits } from "../../lib/vehicle-modkits.js";
import { vehicleModelName } from "../workspace/useVehicleModkits.js";

/* What a Photo Mode vehicle can change beyond paint and doors, read from its
   resource the way the All workspace reads one: mod kits, a convertible roof
   and the steering lock. A game vehicle's resource is the cache folder
   export_game_vehicle lays out, so both kinds take the same path. */

const MAX_TEXT_LABELS = 2048;

/** Mod and slot labels the game has English text for, as joaat(label) -> text. */
async function gameTextFor(labels) {
  const hashes = [...new Set(labels.filter(Boolean).map((label) => joaat(label)))].slice(0, MAX_TEXT_LABELS);
  if (!hashes.length) return new Map();
  const result = await invoke("lookup_game_text", { hashes });
  return new Map(Object.entries(result?.texts || {}).map(([hash, text]) => [Number(hash), String(text)]));
}

function kitLabels(meta) {
  const labels = [];
  for (const kit of meta?.kits || []) {
    for (const mod of kit.visibleMods || []) labels.push(mod.modShopLabel);
    for (const entry of kit.slotNames || []) labels.push(entry.name);
  }
  return labels;
}

/**
 * Reads a loaded vehicle's resource. Returns { root, modelName, kits, roof,
 * steeringLock, sirenSetting, warnings }; `roof` is the vehicles.meta
 * convertible roof clip ({ dict, clip }) or null, `steeringLock` degrees or
 * null when unknown.
 */
export async function readVehicleSetup({ object, modelPath, signal }) {
  if (object.source === "file") await invoke("allow_model_resource", { path: modelPath });
  const { root, meta } = await readModelResourceMeta(modelPath, { readDir, readTextFile, signal });
  const modelName = object.source === "game" ? object.name : vehicleModelName(modelPath);
  const warnings = (meta.errors || []).map((error) => error.message).filter(Boolean);
  let { kits } = listVehicleModkits(meta, modelName);
  if (kits.length) {
    // Names: what the resource registers in its scripts, else the game's own text.
    let entries = new Map();
    try {
      entries = await gameTextFor(kitLabels(meta));
    } catch (error) {
      warnings.push(`Mod names from the game files are unavailable: ${error?.message || error}`);
    }
    if (object.source === "file") {
      const resourceText = await readResourceTextEntries(root, { readDir, readTextFile, signal });
      for (const [hash, text] of resourceText.entries) entries.set(hash, text);
    }
    if (entries.size) kits = listVehicleModkits(meta, modelName, { textEntries: entries }).kits;
  }
  const simulation = simulateVehicle(meta, modelName, {});
  const lock = Number(simulation?.steering?.lockDegrees);
  return {
    root,
    modelName,
    kits,
    roof: simulation?.convertibleRoof?.dict && simulation.convertibleRoof.clip ? simulation.convertibleRoof : null,
    steeringLock: Number.isFinite(lock) && lock > 0 ? lock : null,
    // The carcols siren setting the vehicle's variation names, or null.
    sirenSetting: simulation?.sirenSetting || null,
    warnings,
  };
}

/**
 * Indexes the vehicle's mod part models. A game vehicle's parts are extracted
 * into its cache folder first (once; tens of megabytes for a tuner car).
 */
export async function readVehicleModFiles({ object, root, modelPath, signal }) {
  let missing = [];
  if (object.source === "game") {
    const exported = await invoke("export_game_vehicle_mods", { name: object.name });
    missing = Array.isArray(exported?.missing) ? exported.missing : [];
  }
  const listing = await listResourceModelFiles(root, modelPath, { readDir, signal });
  return { modelIndex: indexModelFiles(listing.paths), missing, errors: listing.errors };
}

/** The convertible roof clip from the vehicle's resource, else the game. */
export function exportRoofClip({ modelPath, roof }) {
  return invoke("export_model_clip", { modelPath, dict: roof.dict, clip: roof.clip });
}
