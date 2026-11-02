import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { downloadLabel, isImportPath } from "../../lib/engine-sounds.js";
import { isAudioPath } from "../../lib/siren-tones.js";
import { splitPath } from "../workspace/parts";
import { errorText } from "./parts";

function countSounds(entry) {
  let engines = 0;
  let tones = 0;
  for (const source of entry.sources || []) engines += (source.engines || []).length;
  for (const source of entry.sirens || []) tones += (source.tones || []).length;
  return { engines, tones };
}

function importSummary(engines, tones) {
  const parts = [];
  if (engines) parts.push(`${engines} engine ${engines === 1 ? "sound" : "sounds"}`);
  if (tones) parts.push(`${tones} siren ${tones === 1 ? "tone" : "tones"}`);
  return parts.join(" and ") || "the download";
}

export function useSoundLibrary({ desktop, isActive, flash, pushAlert, onImported, onRemoved, onDropAudio, gtaFolder = "" }) {
  const [library, setLibrary] = useState([]);
  const [libraryReady, setLibraryReady] = useState(false);
  const [importing, setImporting] = useState(null);
  const [importErrors, setImportErrors] = useState([]);
  const [dragging, setDragging] = useState(false);
  const queueRef = useRef(Promise.resolve());
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;
  const onRemovedRef = useRef(onRemoved);
  onRemovedRef.current = onRemoved;
  const onDropAudioRef = useRef(onDropAudio);
  const gtaFolderRef = useRef(gtaFolder);
  gtaFolderRef.current = gtaFolder;
  onDropAudioRef.current = onDropAudio;

  useEffect(() => {
    if (!desktop) return;
    invoke("engine_sounds_library")
      .then((entries) => setLibrary(Array.isArray(entries) ? entries : []))
      .catch((error) => pushAlert("Library didn't load", errorText(error)))
      .finally(() => setLibraryReady(true));
  }, [desktop, pushAlert]);

  const importPaths = useCallback((paths) => {
    const list = [...new Set((paths || []).filter(Boolean))];
    if (!list.length) return;
    queueRef.current = queueRef.current.then(async () => {
      setImportErrors([]);
      const failures = [];
      let imported = 0;
      let engines = 0;
      let tones = 0;
      let lastName = "";
      for (const [index, path] of list.entries()) {
        setImporting({ path, index: index + 1, total: list.length });
        try {
          const entry = await invoke("engine_sounds_import", { path, gtaFolder: gtaFolderRef.current || null });
          setLibrary((prev) => [entry, ...prev.filter((item) => item.id !== entry.id)]);
          onImportedRef.current?.(entry, imported === 0);
          imported += 1;
          lastName = downloadLabel(entry.name);
          const counts = countSounds(entry);
          engines += counts.engines;
          tones += counts.tones;
        } catch (error) {
          failures.push(list.length > 1 ? `${splitPath(path).name}: ${errorText(error)}` : errorText(error));
        }
      }
      setImporting(null);
      setImportErrors(failures);
      if (imported) {
        const what = importSummary(engines, tones);
        flash(imported === 1 ? `Imported ${what} from ${lastName}` : `Imported ${what} from ${imported} downloads`);
      }
    });
  }, [flash]);

  const pickDownload = useCallback(async () => {
    const picked = await open({
      multiple: true,
      directory: false,
      title: "Import sound downloads",
      filters: [{ name: "Sound downloads", extensions: ["zip", "rar", "7z", "oiv", "rpf"] }],
    }).catch(() => null);
    importPaths(Array.isArray(picked) ? picked : [picked]);
  }, [importPaths]);

  const pickFolder = useCallback(async () => {
    const path = await open({ multiple: false, directory: true, title: "Import an unpacked sound folder" }).catch(() => null);
    if (typeof path === "string") importPaths([path]);
  }, [importPaths]);

  const removeEntry = useCallback(async (id) => {
    try {
      await invoke("engine_sounds_remove", { id });
      setLibrary((prev) => prev.filter((entry) => entry.id !== id));
      onRemovedRef.current?.(id);
    } catch (error) {
      pushAlert("Couldn't remove it", errorText(error));
    }
  }, [pushAlert]);

  useEffect(() => {
    if (!desktop) return undefined;
    let unlisten = null;
    let disposed = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (!isActiveRef.current) return;
        const { type, paths } = event.payload || {};
        if (type === "enter") setDragging(Boolean(paths?.length));
        else if (type === "leave") setDragging(false);
        else if (type === "drop") {
          setDragging(false);
          const list = paths || [];
          const downloads = list.filter((path) => isImportPath(path));
          const audio = list.filter((path) => isAudioPath(path));
          if (audio.length && onDropAudioRef.current) onDropAudioRef.current(audio);
          if (downloads.length) importPaths(downloads);
          else if (!audio.length || !onDropAudioRef.current) importPaths(list.slice(0, 1));
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop, importPaths]);

  return { library, setLibrary, libraryReady, importing, importErrors, dragging, importPaths, pickDownload, pickFolder, removeEntry };
}
