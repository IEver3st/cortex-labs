import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ScanSearch } from "lucide-react";
import { errorText } from "./useSirenTools.js";

const FORGE_HINT = "Open this resource in Cortex Forge to check it against your server.";

let forgeFound = null;

async function findForge() {
  forgeFound ??= await invoke("forge_find").catch(() => null);
  return forgeFound;
}

function useForgeFolder(path, enabled) {
  const [found, setFound] = useState({ path: "", folder: "" });
  useEffect(() => {
    if (!enabled || !path) return undefined;
    let cancelled = false;
    (async () => {
      const forge = await findForge();
      const folder = forge ? await invoke("forge_resource_folder", { path }).catch(() => null) : null;
      if (!cancelled) setFound({ path, folder: folder || "" });
    })();
    return () => { cancelled = true; };
  }, [enabled, path]);
  return enabled && found.path === path ? found.folder : "";
}

export function useForgeCheck(path, enabled = true) {
  const folder = useForgeFolder(path, enabled);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  useEffect(() => setError(""), [folder]);
  const check = async () => {
    setError("");
    setStarting(true);
    try {
      await invoke("forge_check_resource", { folder });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setStarting(false);
    }
  };
  return { folder, error, starting, check, hint: `${FORGE_HINT}
${folder}` };
}

export default function ForgeCheckButton({ path, enabled = true, disabledReason = "", className = "cx-btn lv-btn-sm" }) {
  const forge = useForgeCheck(path, enabled);
  if (!forge.folder) return null;
  return (
    <>
      <button type="button" className={className} onClick={forge.check} disabled={Boolean(disabledReason) || forge.starting}
        title={disabledReason || forge.hint}>
        <ScanSearch aria-hidden="true" />
        Check in Forge
      </button>
      {forge.error ? <p className="lv-slot-note is-error">{forge.error}</p> : null}
    </>
  );
}
