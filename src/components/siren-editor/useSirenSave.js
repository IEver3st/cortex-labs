import { useCallback, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { exists, readTextFile, writeFile } from "@tauri-apps/plugin-fs";
import { createCarcolsFile, serializeSirenSetting, spliceSirenSetting } from "../../lib/siren-settings.js";
import useSirenIssues from "./useSirenIssues.js";

// Save and Copy XML for the siren draft. Save writes only to the carcols.meta
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
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);

  const modelDir = String(s.modelPath || "").replace(/[\\/][^\\/]+$/, "");
  const defaultPath = editor?.base?.sourcePath || context?.carcolsPaths?.[0]
    || `${(context?.resourceRoot || modelDir).replace(/[\\/]$/, "")}/carcols.meta`;
  const disabledReason = !draft ? "No siren setting to save."
    : !s.isTauriRuntime ? "Saving carcols.meta needs the desktop app. Copy XML works here."
      : blocking.length ? blocking[0].message : "";

  const saveToFile = useCallback(async () => {
    if (disabledReason || saving) return;
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
    setSaving(true);
    setStatus({ tone: "busy", text: `Saving to ${fileName(target)}…` });
    try {
      let text;
      let mode = "created";
      if (await exists(target)) {
        const source = await readTextFile(target);
        const base = editor.base;
        // The file the setting came from: replace it in place even if its id changed.
        const matchId = base && normalizePath(base.sourcePath) === normalizePath(target) ? base.id : draft.id;
        ({ text, mode } = spliceSirenSetting(source, draft, { matchId }));
      } else {
        text = createCarcolsFile(draft);
      }
      await writeFile(target, new TextEncoder().encode(text));
      editor.markSaved(target);
      s.requestMetaRescan?.();
      setStatus({
        tone: "ok",
        text: mode === "replaced" ? `Replaced setting ${draft.id} in` : mode === "appended" ? `Added setting ${draft.id} to` : "Created",
        path: target,
      });
    } catch (error) {
      setStatus({ tone: "error", text: `${fileName(target)} was not saved: ${String(error?.message || error)}` });
    } finally {
      setSaving(false);
    }
  }, [defaultPath, disabledReason, draft, editor, s, saving]);

  const copyXml = useCallback(async () => {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(serializeSirenSetting(draft));
      setStatus({ tone: "ok", text: `Copied the <Sirens> Item for id ${draft.id ?? "?"}.` });
    } catch (error) {
      setStatus({ tone: "error", text: `Copy failed: ${String(error?.message || error)}` });
    }
  }, [draft]);

  return { saveToFile, copyXml, saving, status, clearStatus: () => setStatus(null), disabledReason };
}
