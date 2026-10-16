import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeFile } from "@tauri-apps/plugin-fs";
import { cloneSirenSetting, sirenImportTarget, spliceSirenSetting } from "../../lib/siren-settings.js";
import { backupPathFor, linkVariationSirenSetting } from "../../lib/siren-install.js";
import { parseCarcolsMeta } from "../../lib/vehicle-meta.js";
import useSirenIssues from "./useSirenIssues.js";

// Install and Import for the Sirens dock. Install writes the draft into the
// resource's own carcols.meta and links it in carvariations.meta, after saving
// a timestamped .bak of each file it changes. Import reads a setting from any
// carcols.meta into the draft; nothing is written until Save or Install.

export function samePath(a, b) {
  const normalize = (path) => String(path || "").replace(/\\/g, "/").toLowerCase();
  return normalize(a) === normalize(b);
}

export function fileName(path) {
  return String(path || "").split(/[\\/]/).pop();
}

export function errorText(error) {
  return String(error?.message || error || "Unknown error");
}

export async function writeText(path, text) {
  await writeFile(path, new TextEncoder().encode(text));
}

export function useSirenInstall(s, resource) {
  const editor = s.sirenEditor;
  const draft = editor?.draft;
  const context = s.vehicleLights?.sirenContext || null;
  const { blocking } = useSirenIssues(s);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const carcolsPath = (editor?.base?.sourcePath && context?.carcolsPaths?.some((path) => samePath(path, editor.base.sourcePath))
    ? editor.base.sourcePath : "") || context?.carcolsPaths?.[0] || "";
  const variationPath = context?.variationPath || "";

  const disabledReason = !draft ? "No siren setting to install."
    : !s.isTauriRuntime ? "Installing into the resource needs the desktop app."
      : !context ? "Reading the resource's meta files…"
        : !carcolsPath ? "This resource has no carcols.meta yet. Save to carcols.meta… creates one."
          : blocking.length ? blocking[0].message : "";

  const install = useCallback(async () => {
    if (disabledReason || busy) return;
    setBusy(true);
    setStatus({ tone: "busy", lines: [{ text: "Installing…" }] });
    let stage = "read";
    const lines = [];
    try {
      const now = new Date();
      const carcolsText = await readTextFile(carcolsPath);
      const base = editor.base;
      const matchId = base && samePath(base.sourcePath, carcolsPath) ? base.id : draft.id;
      const carcols = spliceSirenSetting(carcolsText, draft, { matchId });
      let link = null;
      let linkError = "";
      let variationText = "";
      if (variationPath) {
        variationText = await readTextFile(variationPath);
        try {
          link = linkVariationSirenSetting(variationText, resource.modelName, draft.id);
        } catch (error) {
          linkError = errorText(error);
        }
      } else linkError = `no carvariations.meta entry for ${resource.modelName}`;

      stage = "backup";
      const backups = [backupPathFor(carcolsPath, now)];
      await writeText(backups[0], carcolsText);
      if (link && link.mode !== "unchanged") {
        backups.push(backupPathFor(variationPath, now));
        await writeText(backups[1], variationText);
      }

      stage = "carcols";
      await writeText(carcolsPath, carcols.text);
      editor.markSaved(carcolsPath);
      lines.push({ tone: "ok", text: carcols.mode === "replaced" ? `carcols.meta: setting ${draft.id} updated` : `carcols.meta: setting ${draft.id} added`, path: carcolsPath });

      stage = "link";
      if (link?.mode === "unchanged") lines.push({ tone: "ok", text: `carvariations.meta already links id ${draft.id}` });
      else if (link) {
        try {
          await writeText(variationPath, link.text);
          lines.push({ tone: "ok", text: link.previous != null ? `carvariations.meta: linked id ${draft.id} (was ${link.previous})` : `carvariations.meta: linked id ${draft.id}`, path: variationPath });
        } catch (error) {
          lines.push({ tone: "error", text: `carvariations.meta was not linked: ${errorText(error)}`, path: variationPath });
        }
      } else lines.push({ tone: "warn", text: `Not linked: ${linkError}. Add <sirenSettings value="${draft.id}" /> to the model's carvariations entry.` });
      lines.push({ tone: "ok", text: backups.length === 1 ? "Backup saved" : `${backups.length} backups saved`, path: backups.join("\n") });
      s.requestMetaRescan?.();
      const tone = lines.some((line) => line.tone === "error") ? "error" : lines.some((line) => line.tone === "warn") ? "warn" : "ok";
      setStatus({ tone, lines });
    } catch (error) {
      const message = errorText(error);
      const text = stage === "read" ? `Install stopped before writing anything: ${message}`
        : stage === "backup" ? `Install stopped: a backup could not be saved (${message}). carcols.meta and carvariations.meta were not changed.`
          : `carcols.meta was not written: ${message}. carvariations.meta was not changed.`;
      setStatus({ tone: "error", lines: [...lines, { tone: "error", text }] });
    } finally {
      setBusy(false);
    }
  }, [busy, carcolsPath, disabledReason, draft, editor, resource.modelName, s, variationPath]);

  return { install, busy, status, clearStatus: () => setStatus(null), disabledReason, carcolsPath, variationPath };
}

export function useCarcolsImport(s, resource) {
  const editor = s.sirenEditor;
  const context = s.vehicleLights?.sirenContext || null;
  const [choices, setChoices] = useState(null);
  const [status, setStatus] = useState(null);

  const apply = useCallback((setting, path) => {
    const imported = cloneSirenSetting(setting);
    const label = `"${setting.name || `id ${setting.id}`}" (${setting.sirens.length} ${setting.sirens.length === 1 ? "siren" : "sirens"})`;
    setChoices(null);
    const target = sirenImportTarget({
      imported, path, draft: editor.draft, resourceSettings: context?.settings || [], linkedId: resource.variationId,
    });
    if (target.mode === "adopt") {
      const own = { ...imported, sourcePath: path };
      const text = `Opened ${label}, this resource's own setting in ${fileName(path)}, so Install updates id ${target.id} instead of adding a copy.`;
      // Nothing to lose: open it as the file's setting. Otherwise as an undoable edit.
      if (!editor.draft || !editor.canUndo) {
        editor.start(own, { asFile: true });
        setStatus({ tone: "ok", text });
      } else {
        editor.edit(() => own);
        setStatus({ tone: "ok", text: `${text} Undo takes it back.` });
      }
      return;
    }
    if (target.mode === "pattern") {
      // The pattern is imported; the model keeps its own id, name and file.
      editor.edit((current) => ({ ...imported, id: current.id, name: current.name, sourcePath: current.sourcePath }));
      setStatus({ tone: "ok", text: `Imported ${label} from ${fileName(path)}. Id, name and file stay this model's; Undo or Revert takes it back.` });
      return;
    }
    editor.start({ ...imported, id: target.id, sourcePath: "" });
    setStatus({ tone: "ok", text: `Imported ${label} from ${fileName(path)} as a new setting with id ${target.id}.` });
  }, [context, editor, resource.variationId]);

  const pick = useCallback(async () => {
    setStatus(null);
    let path = null;
    try {
      path = await open({ multiple: false, directory: false, title: "Import a siren setting", filters: [{ name: "carcols.meta", extensions: ["meta"] }] });
    } catch (error) {
      setStatus({ tone: "error", text: `Could not open the file dialog: ${errorText(error)}` });
      return;
    }
    if (!path || Array.isArray(path)) return;
    try {
      const { sirens } = parseCarcolsMeta(await readTextFile(path), path);
      if (!sirens.length) setStatus({ tone: "error", text: `${fileName(path)} has no siren settings.` });
      else if (sirens.length === 1) apply(sirens[0], path);
      else setChoices({ path, sirens });
    } catch (error) {
      setStatus({ tone: "error", text: `${fileName(path)} could not be read as a carcols.meta: ${errorText(error)}` });
    }
  }, [apply]);

  return {
    pick,
    choices,
    choose: (setting) => apply(setting, choices?.path),
    cancel: () => setChoices(null),
    status,
    clearStatus: () => setStatus(null),
    disabledReason: !s.isTauriRuntime ? "Importing needs the desktop app." : !s.modelPath ? "Load a vehicle first." : "",
  };
}
