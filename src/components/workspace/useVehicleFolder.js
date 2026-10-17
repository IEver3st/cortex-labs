import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { scanVehicleFolder } from "../../lib/vehicle-folder.js";

const IDLE = Object.freeze({ folder: "", status: "idle", vehicles: [], missing: [], errors: [], truncated: false, error: "" });

/* Lists the vehicles in the folder the Pack view shows (vehicle-folder.js),
   again whenever the folder changes or `rescan` is called. Read access comes
   from the folder picker, which grants the folder and everything under it for
   this session. After a restart, a folder outside the default scope reads
   again only where the open model's resource grant covers it (a one-resource
   pack); otherwise the pack asks for it again. The grant is taken before the
   first listing so the two never race. */
export default function useVehicleFolder(folder, enabled, modelPath) {
  const [scan, setScan] = useState(IDLE);
  const [revision, setRevision] = useState(0);
  const active = Boolean(enabled && folder);
  const modelRef = useRef(modelPath);
  modelRef.current = modelPath;

  useEffect(() => {
    if (!active) {
      setScan(IDLE);
      return undefined;
    }
    const controller = new AbortController();
    setScan({ ...IDLE, folder, status: "scanning" });
    const model = modelRef.current;
    const granted = /\.(yft|clmesh)$/i.test(model || "") ? invoke("allow_model_resource", { path: model }).catch(() => null) : Promise.resolve();
    granted
      .then(() => scanVehicleFolder(folder, { readDir, readTextFile, signal: controller.signal, allowResource: (path) => invoke("allow_model_resource", { path }) }))
      .then((result) => {
        if (controller.signal.aborted) return;
        // A folder the scan could not open at all says so, rather than "no vehicles".
        const unreadable = !result.vehicles.length && result.errors.some((entry) => entry.path === result.folder);
        setScan({
          ...result,
          folder,
          status: unreadable ? "error" : "ready",
          error: unreadable ? result.errors.find((entry) => entry.path === result.folder).message : "",
        });
      })
      .catch((error) => {
        if (controller.signal.aborted || error?.name === "AbortError") return;
        setScan({ ...IDLE, folder, status: "error", error: String(error?.message || error) });
      });
    return () => controller.abort();
  }, [active, folder, revision]);

  const rescan = useCallback(() => setRevision((value) => value + 1), []);
  return { ...(scan.folder === folder ? scan : { ...IDLE, folder, status: active ? "scanning" : "idle" }), rescan };
}
