import { useCallback, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { exists, readTextFile, writeFile } from "@tauri-apps/plugin-fs";
import { createCarcolsFile, serializeSirenSetting, spliceSirenSetting } from "../../lib/siren-settings.js";
import { trackUsageOnce } from "../../lib/usage.js";
import { backupPathFor } from "../../lib/siren-install.js";
import { parseCarcolsMeta } from "../../lib/vehicle-meta.js";
import useSirenIssues from "./useSirenIssues.js";
import useScopedStatus from "./useScopedStatus.js";

// Save and Copy XML for the siren draft. Save as writes only to the carcols.meta
// the user picks in the dialog: an existing file gets this setting replaced or
// added with everything else kept byte for byte; a new file holds only it.

function normalizePath(path) {
  return String(path || "").replace(/\\/g, "/").toLowerCase();
}

function fileName(path) {
  return String(path || "").split(/[\\/]/).pop();
}

export default function useSirenSave(s) {
  const editor = s.sirenEditor;
  const draft = editor?.draft;
  const context = s.vehicleLights?.sirenContext || null;
  const { blocking } = useSirenIssues(s);
  const [status, setStatus] = useScopedStatus(s.modelPath);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState(null);
  const backedUp = useRef(new Set());

  const modelDir = String(s.modelPath || "").replace(/[\\/][^\\/]+$/, "");
  const defaultPath = !s.modelPath ? (editor?.base?.sourcePath || "carcols.meta") : editor?.base?.sourcePath || context?.carcolsPaths?.[0]
    || `${(context?.resourceRoot || modelDir).replace(/[\\/]$/, "")}/carcols.meta`;
  const disabledReason = !draft ? "No siren setting to save."
    : !s.isTauriRuntime ? "Saving carcols.meta needs the desktop app. Copy XML works here."
      : blocking.length ? blocking[0].message : "";
  const fileTarget = s.isTauriRuntime ? editor?.base?.sourcePath || "" : "";

  const write = useCallback(async (target, confirmed) => {
    setSaving(true);
    setStatus({ tone: "busy", text: `Saving to ${fileName(target)}…` });
    try {
      let text;
      let mode = "created";
      let backup = "";
      if (await exists(target)) {
        const source = await readTextFile(target);
        const base = editor.base;
        // The file the setting came from: replace it in place even if its id changed.
        const fromFile = Boolean(base) && normalizePath(base.sourcePath) === normalizePath(target);
        ({ text, mode } = spliceSirenSetting(source, draft, { matchId: fromFile ? base.id : draft.id }));
        if (mode === "replaced" && !fromFile && !confirmed) {
          setPending({ target, id: draft.id });
          setStatus({
            tone: "warn",
            text: `${fileName(target)} already has a setting with id ${draft.id}. Replace it with this one, or change this setting's id in Setting and save again.`,
            path: target,
            confirm: "Replace it",
          });
          return;
        }
        if (!backedUp.current.has(normalizePath(target))) {
          backup = backupPathFor(target);
          await writeFile(backup, new TextEncoder().encode(source));
          backedUp.current.add(normalizePath(target));
        }
      } else {
        text = createCarcolsFile(draft);
      }
      await writeFile(target, new TextEncoder().encode(text));
      trackUsageOnce("siren", `${target}\n${draft.id}`);
      editor.markSaved(target);
      s.requestMetaRescan?.();
      const done = mode === "replaced" ? `Replaced setting ${draft.id} in` : mode === "appended" ? `Added setting ${draft.id} to` : "Created";
      setStatus({
        tone: "ok",
        text: backup ? `Saved a .bak of the old file, then ${done.charAt(0).toLowerCase()}${done.slice(1)}` : done,
        path: target,
      });
    } catch (error) {
      setStatus({ tone: "error", text: `${fileName(target)} was not saved: ${String(error?.message || error)}` });
    } finally {
      setSaving(false);
    }
  }, [draft, editor, s]);

  const saveToFile = useCallback(async () => {
    if (disabledReason || saving) return;
    setPending(null);
    let target = null;
    try {
      target = await save({
        defaultPath,
        title: "Save siren setting to carcols.meta",
        filters: [{ name: "carcols.meta", extensions: ["meta"] }],
      });
    } catch (error) {
      setStatus({ tone: "error", text: `Could not open the save dialog: ${String(error?.message || error)}` });
      return;
    }
    if (!target) return;
    await write(target, false);
  }, [defaultPath, disabledReason, saving, setStatus, write]);

  const saveInPlace = useCallback(async () => {
    if (!fileTarget) return saveToFile();
    if (disabledReason || saving) return;
    setPending(null);
    const name = fileName(fileTarget);
    let present = false;
    try {
      present = await exists(fileTarget);
    } catch (error) {
      setStatus({ tone: "error", text: `${name} could not be checked: ${String(error?.message || error)}` });
      return;
    }
    if (!present) {
      setStatus({ tone: "warn", text: `${name} is no longer there. Pick where to save.`, path: fileTarget });
      return saveToFile();
    }
    let onDisk = null;
    try {
      onDisk = parseCarcolsMeta(await readTextFile(fileTarget), fileTarget).sirens.find((entry) => entry.id === editor.base.id) || null;
    } catch (error) {
      setStatus({ tone: "error", text: `${name} could not be read: ${String(error?.message || error)}` });
      return;
    }
    const changedOutside = !onDisk || serializeSirenSetting(onDisk) !== serializeSirenSetting(editor.base);
    if (changedOutside && !editor.dirty) {
      s.requestMetaRescan?.();
      setStatus({
        tone: "warn",
        text: onDisk
          ? `Setting ${editor.base.id} in ${name} changed outside Cortex Studio. Nothing was written; the meta files are being read again.`
          : `${name} no longer has setting ${editor.base.id}. Nothing was written; Save as keeps a copy.`,
        path: fileTarget,
      });
      return;
    }
    if (changedOutside) {
      backedUp.current.delete(normalizePath(fileTarget));
      setPending({ target: fileTarget, id: draft.id });
      setStatus({
        tone: "warn",
        text: onDisk
          ? `Setting ${editor.base.id} in ${name} changed outside Cortex Studio since you opened it. Overwrite it with yours, or use Save as to keep both.`
          : `${name} no longer has setting ${editor.base.id}. Add yours to it, or use Save as.`,
        path: fileTarget,
        confirm: onDisk ? "Overwrite it" : "Add it",
      });
      return;
    }
    if (!editor.dirty) {
      setStatus({ tone: "ok", text: "No changes to save. Already saved in", path: fileTarget });
      return;
    }
    await write(fileTarget, false);
  }, [disabledReason, draft, editor, fileTarget, s, saveToFile, saving, setStatus, write]);

  const confirmReplace = useCallback(() => {
    if (!pending || saving || disabledReason) return;
    setPending(null);
    write(pending.target, pending.id === draft?.id);
  }, [disabledReason, draft?.id, pending, saving, write]);

  const copyXml = useCallback(async () => {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(serializeSirenSetting(draft));
      setStatus({ tone: "ok", text: `Copied the <Sirens> Item for id ${draft.id ?? "?"}.` });
    } catch (error) {
      setStatus({ tone: "error", text: `Copy failed: ${String(error?.message || error)}` });
    }
  }, [draft]);

  const clearStatus = () => { setPending(null); setStatus(null); };
  return { saveInPlace, saveToFile, fileTarget, confirmReplace, copyXml, saving, status, clearStatus, disabledReason };
}
