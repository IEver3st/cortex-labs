import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { exists, readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { ArrowRight, Check, CircleAlert, ClipboardCopy, FolderOpen, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { Toggle } from "../ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { NumberInput } from "./SirenInspector";
import { ULC_BUTTON_COLORS, buildUlcTable, defaultUlcConfig, parseLuaTable, serializeLua, upsertUlcConfig } from "../../lib/ulc-config.js";
import { backupPathFor } from "../../lib/siren-install.js";
import { checkModelName, modelNameWarning, planVehicleRename } from "../../lib/vehicle-rename.js";
import { readResourceForRename } from "../../lib/resource-meta-files.js";
import { errorText, fileName, samePath, writeText } from "./useSirenTools.js";
import { openFolderPath } from "../../lib/open-folder.js";
import ForgeCheckButton from "./ForgeCheck";

// Resource tools in the Sirens dock: the ULC config builder and the vehicle
// renamer. Both preview what they will write, keep a timestamped .bak of every
// text file they change, and report partial writes as partial.

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function relative(path, root) {
  const value = String(path || "").replace(/\\/g, "/");
  const base = String(root || "").replace(/\\/g, "/").replace(/\/$/, "");
  return base && value.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? value.slice(base.length + 1) : fileName(value);
}

export function ToolDialog({ title, titleId, busy, onClose, children, wide = false }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);
  return createPortal(
    <div className="se-scrim" onPointerDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className={cx("se-dialog", wide && "is-wide")} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="se-dialog-head">
          <h2 id={titleId} className="cx-display se-dialog-title">{title}</h2>
          <button type="button" className="cx-icon-btn" onClick={onClose} disabled={busy} aria-label="Close" title="Close">
            <X aria-hidden="true" />
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}

const TONE_ICONS = { ok: Check, warn: TriangleAlert, error: CircleAlert, busy: LoaderCircle };

// A written file opens its folder; anything else (a rename "a → b") is plain text.
function LinePath({ path }) {
  if (!/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(path)) return <span className="se-line-path">{path}</span>;
  return (
    <button type="button" className="se-line-path is-link" title={`${path}\nOpen the folder`}
      onClick={() => openFolderPath(path.replace(/[\\/][^\\/]*$/, ""))}>
      <span>{fileName(path)}</span>
      <FolderOpen aria-hidden="true" />
    </button>
  );
}

/** Tool results: one row per step, a tone icon, and the files it touched. */
export function StatusLines({ lines }) {
  if (!lines?.length) return null;
  return (
    <ul className="se-dialog-lines" role="status" aria-live="polite">
      {lines.map((line, index) => {
        const tone = line.tone || "ok";
        const Icon = TONE_ICONS[tone] || Check;
        return (
          <li key={index} className={`is-${tone}`}>
            <Icon className="se-line-icon" aria-hidden="true" />
            <span className="se-line-text">{line.text}</span>
            {String(line.path || "").split("\n").filter(Boolean).map((path) => <LinePath key={path} path={path} />)}
          </li>
        );
      })}
    </ul>
  );
}

/* ─── ULC builder ─── */

function ExtraChips({ label, extras, value, onChange, disabled }) {
  const chosen = new Set(value || []);
  return (
    <div className="se-chips" role="group" aria-label={label}>
      {extras.map((extra) => (
        <button key={extra} type="button" className={cx("se-chip", chosen.has(extra) && "is-on")} aria-pressed={chosen.has(extra)} disabled={disabled}
          onClick={() => onChange(chosen.has(extra) ? (value || []).filter((entry) => entry !== extra) : [...(value || []), extra].sort((a, b) => a - b))}>
          {extra}
        </button>
      ))}
    </div>
  );
}

function FeatureGroup({ title, hint, enabled, onToggle, children }) {
  return (
    <section className="se-group">
      <header className="se-group-head">
        <h4 className="cx-label" title={hint}>{title}</h4>
        {onToggle ? <Toggle checked={enabled} onChange={onToggle} ariaLabel={title} /> : null}
      </header>
      {children}
    </section>
  );
}

function extraSummary(extra, lightExtras) {
  const info = lightExtras?.[extra];
  if (info?.sirens?.length) {
    const first = info.sirens[0];
    const last = info.sirens[info.sirens.length - 1];
    return first === last ? `siren ${first}` : `sirens ${first}-${last}`;
  }
  return info?.steady ? "steady light" : "no lights";
}

export function UlcBuilderDialog({ s, resource, onClose }) {
  const modelName = resource.modelName;
  const extras = useMemo(() => [...new Set((s.metaModelInfo?.extras || []).map((extra) => extra.index))].sort((a, b) => a - b), [s.metaModelInfo]);
  const lightExtras = s.metaModelInfo?.lights?.extras || {};
  const existing = resource.ulcResult;
  const [config, setConfig] = useState(() => existing.config
    ? structuredClone(existing.config)
    : defaultUlcConfig(modelName, extras, lightExtras));
  const [namesText, setNamesText] = useState(() => config.names.join(", "));
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState([]);
  const target = existing.path || (resource.root ? `${resource.root.replace(/[\\/]$/, "")}/ulc.lua` : "");
  const readError = existing.error;

  const update = (key, patch) => setConfig((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  const buttonFor = (extra) => config.buttons.find((button) => button.extra === extra) || null;
  const setButton = (extra, patch) => setConfig((current) => ({
    ...current,
    buttons: current.buttons.map((button) => (button.extra === extra ? { ...button, ...patch } : button)),
  }));
  const toggleButton = (extra, on) => setConfig((current) => {
    if (!on) return { ...current, buttons: current.buttons.filter((button) => button.extra !== extra) };
    const keys = new Set(current.buttons.map((button) => button.key));
    let key = 1;
    while (keys.has(key)) key += 1;
    const buttons = [...current.buttons, { label: `Extra ${extra}`, key, color: "green", extra, linked: [], opposite: [], off: [] }];
    return { ...current, buttons: buttons.sort((a, b) => a.extra - b.extra) };
  });

  const preview = useMemo(() => {
    try {
      let base = {};
      if (existing.config && existing.text) {
        const parsed = parseLuaTable(existing.text);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        base = list.find((raw) => (raw?.names || []).some?.((name) => String(name).toLowerCase() === modelName.toLowerCase())) || {};
      }
      return { text: `return ${serializeLua(buildUlcTable(config, base))}`, error: "" };
    } catch (error) {
      return { text: "", error: errorText(error) };
    }
  }, [config, existing, modelName]);

  const disabledReason = !s.isTauriRuntime ? "Writing ulc.lua needs the desktop app. Copy works here."
    : !target ? (resource.status === "scanning" ? "Reading the resource folder…" : "The resource folder is not known yet.")
      : readError ? `${fileName(existing.path)} could not be read (${readError}). Fix or move it before writing a new config.`
        : !config.names.length ? "Name at least one vehicle."
          : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(preview.text);
      setLines([{ tone: "ok", text: "Copied the config table." }]);
    } catch (error) {
      setLines([{ tone: "error", text: `Copy failed: ${errorText(error)}` }]);
    }
  };

  const save = async () => {
    if (disabledReason || busy) return;
    setBusy(true);
    const out = [];
    try {
      const had = await exists(target);
      const before = had ? await readTextFile(target) : "";
      const { text, mode } = upsertUlcConfig(before, modelName, config);
      if (had) {
        const backup = backupPathFor(target, new Date());
        await writeText(backup, before);
        out.push({ tone: "ok", text: "Backup saved", path: backup });
      }
      await writeText(target, text);
      out.unshift({ tone: "ok", text: mode === "created" ? "Created ulc.lua" : mode === "added" ? `Added ${modelName} to ulc.lua` : `Updated ${modelName} in ulc.lua`, path: target });
      if (had && /--/.test(before)) out.push({ tone: "warn", text: "Comments from the old file are only in the backup." });
      const manifest = await readTextFile(`${resource.root.replace(/[\\/]$/, "")}/fxmanifest.lua`).catch(() => "");
      if (!/ulc\.lua/i.test(manifest)) out.push({ tone: "warn", text: "fxmanifest.lua does not list ulc.lua yet. ULC's install guide covers it." });
      s.requestMetaRescan?.();
    } catch (error) {
      out.push({ tone: "error", text: `ulc.lua was not written: ${errorText(error)}` });
    } finally {
      setLines(out);
      setBusy(false);
    }
  };

  return (
    <ToolDialog title="ULC builder" titleId="se-ulc-title" busy={busy} onClose={onClose} wide>
      <div className="se-dialog-body se-dialog-split">
        <div className="se-dialog-form custom-scrollbar">
          <p className="se-note">
            {existing.config ? `Editing ${modelName}'s config from ${fileName(existing.path)}.` : `No ULC config covers ${modelName} yet. This starts one with a button per extra that carries lights.`}
            {" "}The preview drives the Lights tab once saved.
          </p>
          <div className="se-field">
            <span className="se-field-label" title="Vehicle model names this config covers">Vehicles</span>
            <div className="se-field-control">
              <input className="se-text" value={namesText} spellCheck={false} aria-label="Vehicle model names, comma separated"
                onChange={(event) => {
                  setNamesText(event.target.value);
                  setConfig((current) => ({ ...current, names: event.target.value.split(/[\s,]+/).map((name) => name.trim().toLowerCase()).filter(Boolean) }));
                }} />
            </div>
          </div>

          <FeatureGroup title="Buttons" hint="Extras the driver switches from the ULC panel">
            {extras.length ? (
              <div className="se-ulc-buttons" role="table" aria-label="ULC buttons">
                {extras.map((extra) => {
                  const button = buttonFor(extra);
                  return (
                    <div key={extra} className={cx("se-ulc-button", button && "is-on")} role="row">
                      <Toggle checked={Boolean(button)} onChange={(on) => toggleButton(extra, on)} ariaLabel={`Button for extra ${extra}`} />
                      <span className="se-ulc-extra" title={extraSummary(extra, lightExtras)}>
                        <span className="cx-display">{extra}</span>
                        <span className="se-ulc-carries">{extraSummary(extra, lightExtras)}</span>
                      </span>
                      <input className="se-text" value={button?.label ?? ""} disabled={!button} placeholder="Label" aria-label={`Extra ${extra} label`} spellCheck={false}
                        onChange={(event) => setButton(extra, { label: event.target.value })} />
                      <NumberInput value={button?.key ?? null} min={1} max={9} integer label={`Extra ${extra} key`}
                        onChange={(key) => button && setButton(extra, { key })} />
                      <Select value={button?.color || "green"} disabled={!button} onValueChange={(color) => setButton(extra, { color })}>
                        <SelectTrigger aria-label={`Extra ${extra} colour`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {ULC_BUTTON_COLORS.map((color) => <SelectItem key={color} value={color}>{color}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  );
                })}
              </div>
            ) : <p className="se-note">This model has no extras, so there is nothing to put on buttons.</p>}
          </FeatureGroup>

          {extras.length ? (
            <>
              <FeatureGroup title="Park pattern" hint="Different extras while parked and while driving" enabled={config.park.enabled}
                onToggle={(enabled) => update("park", { enabled })}>
                <div className="se-field"><span className="se-field-label">Parked</span>
                  <ExtraChips label="Extras while parked" extras={extras} value={config.park.parkExtras} disabled={!config.park.enabled} onChange={(parkExtras) => update("park", { parkExtras })} /></div>
                <div className="se-field"><span className="se-field-label">Driving</span>
                  <ExtraChips label="Extras while driving" extras={extras} value={config.park.driveExtras} disabled={!config.park.enabled} onChange={(driveExtras) => update("park", { driveExtras })} /></div>
              </FeatureGroup>
              <FeatureGroup title="Steady burn" hint="Extras on with the headlights">
                <div className="se-field"><span className="se-field-label">Extras</span>
                  <ExtraChips label="Steady burn extras" extras={extras} value={config.steadyBurn.extras} onChange={(value) => update("steadyBurn", { extras: value })} /></div>
                <div className="se-field"><span className="se-field-label">Always on</span><Toggle checked={config.steadyBurn.forceOn} onChange={(forceOn) => update("steadyBurn", { forceOn })} ariaLabel="Steady burn always on" /></div>
                <div className="se-field"><span className="se-field-label">Off with lights</span><Toggle checked={config.steadyBurn.disableWithLights} onChange={(disableWithLights) => update("steadyBurn", { disableWithLights })} ariaLabel="Steady burn off while the lights run" /></div>
              </FeatureGroup>
              {[["brake", "Brakes", "Extras on while braking"], ["reverse", "Reverse", "Extras on in reverse"], ["horn", "Horn", "Extras on with the horn"]].map(([key, title, hint]) => (
                <FeatureGroup key={key} title={title} hint={hint} enabled={config[key].enabled} onToggle={(enabled) => update(key, { enabled })}>
                  <div className="se-field"><span className="se-field-label">On</span>
                    <ExtraChips label={`${title} extras`} extras={extras} value={config[key].extras} disabled={!config[key].enabled} onChange={(value) => update(key, { extras: value })} /></div>
                  <div className="se-field"><span className="se-field-label">Off</span>
                    <ExtraChips label={`${title} turns off`} extras={extras} value={config[key].disable} disabled={!config[key].enabled} onChange={(value) => update(key, { disable: value })} /></div>
                </FeatureGroup>
              ))}
            </>
          ) : null}
        </div>

        <div className="se-dialog-preview">
          <div className="se-group-head">
            <h4 className="cx-label">ulc.lua</h4>
            <span className="sw-meta" title={target}>{target ? relative(target, resource.root) : "no resource"}</span>
          </div>
          {preview.error ? <p className="se-note is-error">{preview.error}</p> : <pre className="se-code custom-scrollbar">{preview.text}</pre>}
        </div>
      </div>
      <footer className="se-dialog-foot is-row">
        <div className="se-dialog-foot-status">
          <StatusLines lines={lines} />
          {disabledReason && s.isTauriRuntime ? <p className={cx("se-note", resource.status !== "scanning" && "is-error")}>{disabledReason}</p> : null}
        </div>
        <div className="se-dialog-actions">
          <button type="button" className="settings-secondary" onClick={copy} disabled={!preview.text}>
            <ClipboardCopy aria-hidden="true" />
            Copy
          </button>
          <button type="button" className="settings-primary" onClick={save} disabled={Boolean(disabledReason) || busy || Boolean(preview.error)} title={disabledReason || `Write to ${target}`}>
            {busy ? "Saving…" : existing.path ? "Save to ulc.lua" : "Create ulc.lua"}
          </button>
        </div>
      </footer>
    </ToolDialog>
  );
}

/* ─── Vehicle renamer ─── */

export function VehicleRenameDialog({ s, resource, onClose }) {
  const from = resource.modelName;
  const [name, setName] = useState("");
  const [scan, setScan] = useState({ status: "scanning", paths: [], files: [], errors: [], complete: false });
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!resource.root || !s.isTauriRuntime) {
      setScan({ status: "error", paths: [], files: [], errors: [{ path: "", message: "The resource folder is not known." }], complete: false });
      return undefined;
    }
    const controller = new AbortController();
    readResourceForRename(resource.root, { readDir, readTextFile, signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setScan({ status: "ready", ...result }); })
      .catch((error) => {
        if (!controller.signal.aborted) setScan({ status: "error", paths: [], files: [], errors: [{ path: resource.root, message: errorText(error) }], complete: false });
      });
    return () => controller.abort();
  }, [resource.root, s.isTauriRuntime]);

  const takenNames = useMemo(() => resource.modelNames.filter((entry) => entry.toLowerCase() !== from.toLowerCase()), [resource.modelNames, from]);
  const trimmed = name.trim();
  const plan = useMemo(() => (scan.status === "ready" && trimmed
    ? planVehicleRename({ files: scan.files, streamPaths: scan.paths, takenNames, from, to: trimmed })
    : null), [scan, trimmed, takenNames, from]);
  const nameProblem = trimmed ? checkModelName(trimmed, from) : "";
  const warning = trimmed ? modelNameWarning(trimmed) : "";
  const dirty = Boolean(s.sirenEditor?.dirty);

  const disabledReason = done ? "" : !s.isTauriRuntime ? "Renaming needs the desktop app."
    : scan.status === "scanning" ? "Reading the resource…"
      : scan.status === "error" ? "The resource could not be read."
        : !scan.complete ? "The resource is too large to check every file, so it cannot be renamed safely here."
          : dirty ? "Save or revert the siren edits first; the model reloads under its new name."
            : !trimmed ? "Enter a new model name."
              : plan?.error || "";

  const apply = useCallback(async () => {
    if (disabledReason || busy || !plan) return;
    setBusy(true);
    const out = [];
    let newModelPath = "";
    try {
      // Stream files first: the native side renames all or none.
      if (plan.renames.length) {
        const renamed = await invoke("rename_model_stream_files", {
          modelPath: s.modelPath,
          renames: plan.renames.map((entry) => ({ from: entry.from, toName: fileName(entry.to) })),
        });
        out.push({ tone: "ok", text: `Renamed ${plan.renames.length} stream ${plan.renames.length === 1 ? "file" : "files"}`, path: plan.renames.map((entry) => `${fileName(entry.from)} → ${fileName(entry.to)}`).join("\n") });
        const loaded = s.modelSourcePath || s.modelPath;
        const index = plan.renames.findIndex((entry) => samePath(entry.from, loaded));
        if (index >= 0) newModelPath = renamed[index];
      }
    } catch (error) {
      // rolledBack is false only when undoing the earlier renames also failed.
      const text = error?.rolledBack === false
        ? `The rename stopped partway: ${errorText(error)} Check the stream folder before trying again.`
        : `Nothing was renamed: ${errorText(error)}`;
      setLines([{ tone: "error", text }]);
      setBusy(false);
      return;
    }
    const now = new Date();
    let failed = 0;
    for (const edit of plan.edits) {
      const original = scan.files.find((file) => file.path === edit.path)?.text ?? "";
      try {
        await writeText(backupPathFor(edit.path, now), original);
        await writeText(edit.path, edit.text);
      } catch (error) {
        failed += 1;
        out.push({ tone: "error", text: `${relative(edit.path, resource.root)} was not updated: ${errorText(error)}` });
      }
    }
    const written = plan.edits.length - failed;
    if (written) out.push({ tone: "ok", text: `Updated ${written} ${written === 1 ? "file" : "files"}; each has a .bak beside it` });
    if (failed) out.push({ tone: "error", text: "The rename is partial. Restore the .bak files, or finish those files by hand." });
    setLines(out);
    setDone(true);
    setBusy(false);
    s.requestMetaRescan?.();
    if (newModelPath) (s.reloadMovedModel || s.loadModel)?.(newModelPath);
  }, [busy, disabledReason, plan, resource.root, s, scan.files]);

  return (
    <ToolDialog title="Rename vehicle" titleId="se-rename-title" busy={busy} onClose={onClose}>
      <div className="se-dialog-body">
        <div className="se-rename-names">
          <span className="se-rename-from cx-display" title="Current model name">{from || "—"}</span>
          <ArrowRight aria-hidden="true" />
          <input className="se-text se-rename-input" value={name} autoFocus spellCheck={false} placeholder="new_name" aria-label="New model name"
            disabled={busy || done} aria-invalid={Boolean(nameProblem)} onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") apply(); }} />
        </div>
        <p className="se-note">Renames the spawn name in every meta file and script string that uses it, and the model's .yft and .ytd files. Mod kits and parts that only start with the name are left alone. Each changed text file gets a .bak beside it.</p>
        {nameProblem ? <p className="se-note is-error">{nameProblem}</p> : null}
        {warning ? <p className="se-note is-warn">{warning}</p> : null}
        {scan.status === "scanning" ? <p className="lv-slot-note is-busy">Reading the resource…</p> : null}
        {plan && !plan.error && !done ? (
          <ul className="se-rename-plan" aria-label="Changes">
            {plan.edits.map((edit) => (
              <li key={edit.path}>
                <Check aria-hidden="true" />
                <span className="se-rename-path" title={edit.path}>{relative(edit.path, resource.root)}</span>
                <span className="sw-meta">{edit.count} {edit.count === 1 ? "change" : "changes"}</span>
              </li>
            ))}
            {plan.renames.map((entry) => (
              <li key={entry.from}>
                <Check aria-hidden="true" />
                <span className="se-rename-path" title={entry.from}>{relative(entry.from, resource.root)}</span>
                <span className="sw-meta">→ {fileName(entry.to)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {plan?.skipped?.length ? <p className="se-note is-warn">Not plain text, so not checked: {plan.skipped.map((path) => relative(path, resource.root)).join(", ")}</p> : null}
        {scan.errors.length ? <p className="se-note is-warn" title={scan.errors.map((entry) => `${entry.path}: ${entry.message}`).join("\n")}>{scan.errors.length === 1 ? `${relative(scan.errors[0].path, resource.root) || "The resource"}: ${scan.errors[0].message}` : `${scan.errors.length} files could not be read.`}</p> : null}
        <StatusLines lines={lines} />
        {disabledReason && trimmed && !nameProblem && scan.status !== "scanning" ? <p className="se-note is-error">{disabledReason}</p> : null}
        <footer className="se-dialog-actions">
          {done && !lines.some((line) => line.tone === "error") ? (
            <ForgeCheckButton path={resource.root} enabled={s.isTauriRuntime} className="settings-secondary" />
          ) : null}
          <button type="button" className="settings-secondary" onClick={onClose} disabled={busy}>{done ? "Close" : "Cancel"}</button>
          {done ? null : (
            <button type="button" className="settings-primary" onClick={apply} disabled={Boolean(disabledReason) || busy} title={disabledReason || undefined}>
              {busy ? "Renaming…" : "Rename"}
            </button>
          )}
        </footer>
      </div>
    </ToolDialog>
  );
}
