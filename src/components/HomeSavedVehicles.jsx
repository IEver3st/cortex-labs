import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { exists } from "@tauri-apps/plugin-fs";
import { Trash2 } from "lucide-react";
import { isTauriRuntime } from "../lib/bug-report";
import { WORKSPACE_MODES } from "../lib/workspace-modes";
import {
  loadSavedVehicles,
  MAX_SAVED_VEHICLES,
  relinkSavedVehicle,
  removeSavedVehicle,
  restoreSavedVehicle,
  SAVED_VEHICLES_EVENT,
  SAVED_VEHICLES_KEY,
  savedVehicleFileName,
  writeSavedVehicles,
} from "../lib/saved-vehicles";

/* Home's saved vehicles: setups saved from a workspace's Model step. Opening
   one starts a new tab on the same model with its mods, paint, extras and
   plate. A model that moved shows as missing with Locate, which repoints the
   entry and keeps every other choice. Delete has an Undo instead of a dialog
   because nothing on disk is touched. The band stays hidden until something
   is saved; the Save vehicle button in each vehicle workspace introduces it. */

const MODE_BY_ID = new Map(WORKSPACE_MODES.map((mode) => [mode.id, mode]));

function folderOf(path) {
  const parts = String(path || "").split(/[\\/]/);
  parts.pop();
  return parts.join("\\");
}

export default function HomeSavedVehicles({ isActive, onOpen }) {
  const [store, setStore] = useState(loadSavedVehicles);
  const [missing, setMissing] = useState(() => new Set());
  const [deleted, setDeleted] = useState(null);
  // Set when Undo found the library full; the next delete makes room for it.
  const [undoBlocked, setUndoBlocked] = useState(false);
  const [error, setError] = useState("");
  const vehicles = store.vehicles;

  useEffect(() => {
    const reload = () => setStore(loadSavedVehicles());
    const onStorage = (event) => {
      if (event.key === SAVED_VEHICLES_KEY) reload();
    };
    window.addEventListener(SAVED_VEHICLES_EVENT, reload);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SAVED_VEHICLES_EVENT, reload);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Recheck model files whenever Home comes back into view. A path the fs
  // scope won't answer for counts as present; opening it reports the real error.
  useEffect(() => {
    if (!isActive || !isTauriRuntime() || vehicles.length === 0) return undefined;
    let cancelled = false;
    Promise.all(vehicles.map((entry) => exists(entry.modelPath).then((found) => (found ? null : entry.id), () => null)))
      .then((ids) => {
        if (!cancelled) setMissing(new Set(ids.filter(Boolean)));
      });
    return () => { cancelled = true; };
  }, [isActive, vehicles]);

  const commit = useCallback((next) => {
    if (!writeSavedVehicles(next)) {
      setError("Saved vehicles couldn't be updated: app storage refused the write.");
      return false;
    }
    setError("");
    setStore(loadSavedVehicles());
    return true;
  }, []);

  const remove = (entry) => {
    let next = removeSavedVehicle(store, entry.id);
    // A vehicle whose Undo was refused for lack of room comes back now that
    // this delete freed a slot, so deleting to make room never loses it.
    const waiting = undoBlocked && deleted ? restoreSavedVehicle(next, deleted) : null;
    if (waiting?.entry) next = waiting.store;
    if (!commit(next)) return;
    setDeleted(entry);
    setUndoBlocked(false);
  };
  // Restores under the deleted entry's id; a vehicle saved since under the same
  // name stays, and the restored one is renamed instead.
  const undo = () => {
    if (!deleted) return;
    const result = restoreSavedVehicle(loadSavedVehicles(), deleted);
    if (!result.entry) {
      setError(result.error === "full"
        ? `Couldn't restore ${deleted.name}: Home keeps up to ${MAX_SAVED_VEHICLES} saved vehicles. Delete one and ${deleted.name} comes back.`
        : `Couldn't restore ${deleted.name}.`);
      setUndoBlocked(result.error === "full");
      return;
    }
    if (commit(result.store)) {
      setDeleted(null);
      setUndoBlocked(false);
    }
  };
  const locate = async (entry) => {
    let picked = null;
    try {
      picked = await open({
        multiple: false,
        directory: false,
        defaultPath: folderOf(entry.modelPath) || undefined,
        filters: [{ name: "Vehicle model", extensions: ["yft", "clmesh", "dff"] }],
      });
    } catch (pickError) {
      setError(`Couldn't open the file picker: ${String(pickError?.message || pickError)}`);
      return;
    }
    if (typeof picked !== "string" || !picked) return;
    commit(relinkSavedVehicle(store, entry.id, picked, Date.now()));
  };

  if (vehicles.length === 0 && !deleted && !error) return null;
  return (
    <section className="hp-saved" aria-labelledby="hp-saved-title">
      <h2 className="hp-saved-title" id="hp-saved-title">
        Saved vehicles
        {vehicles.length ? <span className="hp-saved-count">{vehicles.length}</span> : null}
      </h2>
      {vehicles.length ? (
        <ul className="hp-saved-list custom-scrollbar">
          {vehicles.map((entry) => {
            const mode = MODE_BY_ID.get(entry.mode) || MODE_BY_ID.get("everything");
            const Icon = mode.icon;
            const parts = entry.mods ? Object.keys(entry.mods.mods).length : 0;
            const lost = missing.has(entry.id);
            const meta = [savedVehicleFileName(entry.modelPath), mode.label, parts ? `${parts} ${parts === 1 ? "part" : "parts"}` : ""].filter(Boolean).join(" · ");
            return (
              <li key={entry.id} className={`hp-saved-row ${lost ? "is-missing" : ""}`} data-cat={mode.cat}>
                <button
                  type="button"
                  className="hp-saved-open"
                  onClick={() => onOpen(entry)}
                  disabled={lost}
                  title={lost ? `Model not found at ${entry.modelPath}` : `Open ${entry.name}\n${entry.modelPath}`}
                >
                  <Icon className="hp-saved-icon" aria-hidden="true" />
                  <span className="hp-saved-name">{entry.name}</span>
                  <span className="hp-saved-meta">{meta}</span>
                </button>
                <button
                  type="button"
                  className="cx-icon-btn hp-saved-delete"
                  aria-label={`Delete ${entry.name}`}
                  title={`Delete ${entry.name}`}
                  onClick={() => remove(entry)}
                >
                  <Trash2 aria-hidden="true" />
                </button>
                {lost ? (
                  <p className="hp-saved-missing">
                    <span className="hp-saved-dot" aria-hidden="true" />
                    <span>Model not found.</span>
                    <button type="button" className="hp-saved-link" onClick={() => locate(entry)}>Locate</button>
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {deleted ? (
        <p className="hp-saved-note" role="status">
          {`Deleted ${deleted.name}. `}
          <button type="button" className="hp-saved-link" onClick={undo}>Undo</button>
        </p>
      ) : null}
      {error ? <p className="hp-saved-note is-error" role="alert">{error}</p> : null}
    </section>
  );
}
