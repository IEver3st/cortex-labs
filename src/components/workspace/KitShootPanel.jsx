import { useEffect, useMemo, useState } from "react";
import { Camera, FileText, FolderOpen, History, Images, RefreshCw, Trash2, X } from "lucide-react";
import { Toggle } from "../ui/toggle";
import { EXPORT_FORMATS } from "../../lib/eup-export.js";
import {
  BUILD_ANGLES,
  CURRENT_BUILD,
  parsePaintList,
  planBuildsShoot,
  planPartsShoot,
  reviewGroups,
} from "../../lib/kit-shoot.js";
import { getVehicleColor } from "../../lib/data/gta-vehicle-colors.js";
import { createShootFileCache, useShootFile } from "./shootFiles.js";

/* Saved builds and Kit Shoot for the Mods tab. Builds are named mod
   selections per vehicle; Kit Shoot photographs every part of a kit, or each
   build, and writes the shots with a manifest and report. State and the run
   itself live in useVehicleModkits and useKitShoot. */

function Seg({ label, value, options, onChange, disabled }) {
  return (
    <div className="lv-field">
      <span className="cx-label">{label}</span>
      <div className="lv-seg" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`lv-seg-btn ${value === option.id ? "is-on" : ""}`}
            aria-pressed={value === option.id}
            disabled={disabled || option.disabled}
            title={option.title}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Chips({ label, items, isOn, onToggle, onAll, allOn, disabled }) {
  return (
    <div className="lv-sheet-angles">
      <div className="lv-sheet-angles-head">
        <span className="cx-label">{label}</span>
        {onAll ? (
          <button type="button" className="lv-link" onClick={onAll} disabled={disabled}>
            {allOn ? "Clear" : "Select all"}
          </button>
        ) : null}
      </div>
      <div className="lv-chips">
        {items.map((item) => {
          const on = isOn(item.id);
          return (
            <button
              key={item.id}
              type="button"
              className={`lv-chip-btn ${on ? "is-on" : ""}`}
              aria-pressed={on}
              disabled={disabled}
              title={item.title}
              onClick={() => onToggle(item.id)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ToggleRow({ label, checked, onChange, disabled, note }) {
  return (
    <>
      <div className="lv-toggle-row">
        <span>{label}</span>
        <Toggle checked={checked} onChange={onChange} ariaLabel={label} disabled={disabled} />
      </div>
      {note ? <p className="lv-slot-note">{note}</p> : null}
    </>
  );
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

export function BuildsSection({ modkits, disabled }) {
  const [name, setName] = useState("");
  const selectedCount = Object.keys(modkits.selection).length;
  const trimmed = name.trim();
  const exists = modkits.builds.some((build) => build.name === trimmed);
  const save = (event) => {
    event.preventDefault();
    if (!trimmed) return;
    modkits.saveBuild(trimmed);
    setName("");
  };
  return (
    <section className="lv-group" id="panel-modkit-builds">
      <div className="lv-group-head">
        <h3 className="lv-group-title">Builds</h3>
        {modkits.builds.length ? <span className="lv-mod-meta">{modkits.builds.length}</span> : null}
      </div>
      {modkits.builds.length ? (
        <ul className="lv-build-list">
          {modkits.builds.map((build) => {
            const count = Object.keys(build.mods).length;
            return (
              <li key={build.name} className="lv-build-row">
                <span className="lv-build-name" title={build.name}>{build.name}</span>
                <span className="lv-mod-meta">{count ? plural(count, "part") : "stock"}</span>
                <button type="button" className="lv-link" disabled={disabled} onClick={() => modkits.applyBuild(build.name)}>
                  Apply
                </button>
                <button
                  type="button"
                  className="cx-icon-btn lv-build-delete"
                  disabled={disabled}
                  aria-label={`Delete ${build.name}`}
                  title={`Delete ${build.name}`}
                  onClick={() => modkits.deleteBuild(build.name)}
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="lv-slot-note">Save a set of parts to shoot it again later or compare it with stock.</p>
      )}
      <form className="lv-build-save" onSubmit={save}>
        <input
          type="text"
          className="lv-text-input"
          value={name}
          maxLength={60}
          placeholder="Build name"
          aria-label="Build name"
          disabled={disabled}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <button type="submit" className="cx-btn lv-btn-sm" disabled={disabled || !trimmed}>
          {exists ? "Replace" : "Save"}
        </button>
      </form>
      <p className="lv-slot-note">
        {selectedCount ? `Saves the ${plural(selectedCount, "part")} picked above.` : "Nothing is picked above, so this saves a stock build."}
      </p>
      {modkits.buildsError ? <p className="lv-slot-note is-error" role="alert"><span className="lv-dot" aria-hidden="true" />{modkits.buildsError}</p> : null}
    </section>
  );
}

function CardThumb({ cache, path, label }) {
  const file = useShootFile(cache, path);
  return (
    <span className="lv-shot-thumb" title={label}>
      {file.url ? <img src={file.url} alt="" draggable={false} /> : null}
    </span>
  );
}

/* The finished run: a strip of its shots, what the checks found, and the way
   into the review. Failures and partial runs say so before anything else. */
function ResultCard({ shoot }) {
  const { result } = shoot;
  const [cache, setCache] = useState(null);
  useEffect(() => {
    if (!result.folder) return undefined;
    const next = createShootFileCache(result.folder);
    setCache(next);
    return () => next.dispose();
  }, [result.folder]);

  const review = useMemo(() => (result.manifest ? reviewGroups(result.manifest) : null), [result.manifest]);
  // One shot per slot (the first part, not the base) reads as a contact strip.
  const picks = (review?.groups || [])
    .map((group) => group.items.find((item) => !item.isBase && item.file) || group.items.find((item) => item.file))
    .filter(Boolean)
    .slice(0, 4);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const entry of result.issues) counts[entry.severity] = (counts[entry.severity] || 0) + 1;
  const partial = result.cancelled || result.fatal || result.failed > 0;
  const slots = review?.groups.length || 0;
  const headline = result.shots === 0
    ? "Nothing was saved"
    : `${plural(result.shots, "shot")}${slots ? ` across ${plural(slots, result.manifest?.settings?.mode === "builds" ? "build" : "slot")}` : ""}`;
  const findings = [
    counts.error ? { tone: "error", text: plural(counts.error, "error") } : null,
    counts.warning ? { tone: "warn", text: plural(counts.warning, "warning") } : null,
    counts.info ? { tone: "idle", text: plural(counts.info, "note") } : null,
  ].filter(Boolean);

  return (
    <div className={`lv-shot-card ${partial ? "is-partial" : ""}`} role="status">
      <div className="lv-shot-card-head">
        <strong>{headline}</strong>
        <button type="button" className="cx-icon-btn lv-shot-dismiss" aria-label="Dismiss" title="Dismiss" onClick={shoot.dismissResult}>
          <X aria-hidden="true" />
        </button>
      </div>
      {result.cancelled ? <p className="lv-slot-note is-warn"><span className="lv-dot" aria-hidden="true" />Cancelled. What was shot before that is saved.</p> : null}
      {result.fatal ? <p className="lv-done-error" role="alert">{`The shoot stopped: ${result.fatal}`}</p> : null}
      {result.failed > 0 ? <p className="lv-done-error" role="alert">{`${plural(result.failed, "file")} couldn't be written: ${result.firstError}`}</p> : null}
      {result.files > 0 && !result.manifestSaved ? <p className="lv-done-error" role="alert">kit-shoot.json wasn't written, so this run can't be reviewed or imported.</p> : null}

      {picks.length ? (
        <button
          type="button"
          className="lv-shot-strip"
          onClick={shoot.openReview}
          disabled={!result.manifest}
          aria-label="Review shots"
        >
          {picks.map((item) => <CardThumb key={item.id} cache={cache} path={item.thumb} label={item.title} />)}
        </button>
      ) : null}

      {result.shots > 0 ? (
        <p className="lv-shot-findings">
          {findings.length
            ? findings.map((entry) => (
                <span key={entry.tone} className={`lv-slot-note is-${entry.tone}`}><span className="lv-dot" aria-hidden="true" />{entry.text}</span>
              ))
            : <span className="lv-slot-note is-ok"><span className="lv-dot" aria-hidden="true" />No problems found</span>}
        </p>
      ) : null}
      {result.folder ? <p className="lv-shot-path" title={result.folder}>{result.folder}</p> : null}
      {shoot.openError ? <p className="lv-done-error" role="alert">{shoot.openError}</p> : null}

      <div className="lv-shot-actions">
        {result.manifest ? (
          <button type="button" className="cx-btn is-primary lv-btn-sm" onClick={shoot.openReview}>
            <Images aria-hidden="true" />
            Review shots
          </button>
        ) : null}
        {result.folder ? (
          <button type="button" className="cx-btn lv-btn-sm" onClick={shoot.openResultFolder}>
            <FolderOpen aria-hidden="true" />
            Folder
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* While a run goes: the frame just written, so the user sees the shoot
   happen, with where it is and a way out. */
function LiveRun({ shoot, format }) {
  const percent = shoot.progress.total ? Math.round((shoot.progress.current / shoot.progress.total) * 100) : 0;
  return (
    <div className="lv-shoot-run" role="status">
      <div className="lv-shot-live" style={{ aspectRatio: `${format.width} / ${format.height}` }}>
        {shoot.live?.url ? <img src={shoot.live.url} alt={shoot.live.label} /> : <span>Finding the first angle…</span>}
        <span className="lv-shot-live-count">{`${shoot.progress.current}/${shoot.progress.total}`}</span>
      </div>
      <div className="lv-progress" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div>
      <p className="lv-slot-note is-busy">
        <span className="lv-shoot-label" title={shoot.progress.label}>{shoot.progress.label || "Starting…"}</span>
      </p>
      <button type="button" className="cx-btn lv-capture-btn" onClick={shoot.cancel}>
        Cancel
      </button>
    </div>
  );
}

export function KitShootSection({ s, modkits }) {
  const shoot = s.kitShoot;
  const { settings, update, running } = shoot;
  const kit = modkits.activeKit;
  const [paintText, setPaintText] = useState(() => settings.paints.join(", "));
  const paints = useMemo(() => parsePaintList(paintText), [paintText]);

  const plan = useMemo(() => {
    if (!kit) return null;
    if (settings.mode === "parts") {
      const base = settings.base === "build" ? modkits.selection : {};
      const parts = planPartsShoot({ kit, base, slotTypes: settings.slots });
      const pairs = settings.beforeAfter ? parts.slots.reduce((sum, slot) => sum + slot.shots.length - 1, 0) : 0;
      const multi = parts.slots.filter((slot) => slot.shots.length > 1).length;
      return { shots: parts.shotCount, pairs, sheets: settings.sheets ? multi : 0, videos: settings.videos && shoot.videoSupported ? multi : 0 };
    }
    const builds = settings.builds
      .map((name) => (name === CURRENT_BUILD ? { name: "Current build", mods: modkits.selection } : modkits.builds.find((build) => build.name === name)))
      .filter(Boolean);
    const planned = planBuildsShoot({ kit, builds, angles: settings.angles, paints: settings.paints, stockBefore: settings.beforeAfter });
    const buildShots = planned.builds.reduce((sum, build) => sum + build.shots.length, 0);
    const several = planned.builds.length > 1 && planned.angles.length > 0;
    return {
      shots: planned.shotCount,
      pairs: settings.beforeAfter ? buildShots : 0,
      sheets: settings.sheets && several ? 1 : 0,
      videos: settings.videos && shoot.videoSupported && several ? 1 : 0,
      empty: planned.builds.length === 0 ? "Pick a build to shoot." : planned.angles.length === 0 ? "Pick an angle." : "",
    };
  }, [kit, settings, modkits.selection, modkits.builds, shoot.videoSupported]);

  const { refreshPreview } = shoot;
  useEffect(() => {
    if (running) return undefined;
    const timer = setTimeout(refreshPreview, 150);
    return () => clearTimeout(timer);
  }, [refreshPreview, running]);

  if (!kit) return null;

  const slotItems = kit.slots.map((slot) => ({ id: slot.type, label: slot.displayName, title: `${slot.label} · ${plural(slot.mods.length, "part")}` }));
  const slotOn = (type) => settings.slots == null || settings.slots.includes(type);
  const allSlotsOn = kit.slots.every((slot) => slotOn(slot.type));
  const toggleSlot = (type) => update((current) => {
    const list = current.slots == null ? kit.slots.map((slot) => slot.type) : current.slots;
    return { slots: list.includes(type) ? list.filter((entry) => entry !== type) : [...list, type] };
  });
  const toggleIn = (key, id) => update((current) => ({
    [key]: current[key].includes(id) ? current[key].filter((entry) => entry !== id) : [...current[key], id],
  }));
  const buildItems = [
    { id: CURRENT_BUILD, label: "Current build", title: "The parts picked above when the shoot starts" },
    ...modkits.builds.map((build) => ({ id: build.name, label: build.name })),
  ];
  const selectedCount = Object.keys(modkits.selection).length;
  const nothingToShoot = !plan || plan.shots === 0 || Boolean(plan.empty);
  const outputs = [
    plural(plan?.shots || 0, "shot"),
    plan?.pairs ? plural(plan.pairs, "before/after", "before/afters") : "",
    plan?.sheets ? plural(plan.sheets, "sheet") : "",
    plan?.videos ? plural(plan.videos, "video") : "",
  ].filter(Boolean).join(", ");
  const format = EXPORT_FORMATS.find((entry) => entry.id === settings.format) || EXPORT_FORMATS[0];

  return (
    <section className="lv-group lv-shoot" id="panel-kit-shoot">
      <div className="lv-group-head">
        <h3 className="lv-group-title">Kit shoot</h3>
      </div>

      <Seg
        label="Shoot"
        value={settings.mode}
        disabled={running}
        options={[{ id: "parts", label: "Every part" }, { id: "builds", label: "Builds" }]}
        onChange={(mode) => update({ mode })}
      />

      {settings.mode === "parts" ? (
        <>
          <Seg
            label="Parts go on"
            value={settings.base}
            disabled={running}
            options={[
              { id: "stock", label: "Stock" },
              { id: "build", label: "Current build", title: "Each slot is swapped on top of the parts picked above" },
            ]}
            onChange={(base) => update({ base })}
          />
          {settings.base === "build" && selectedCount === 0 ? (
            <p className="lv-slot-note">Nothing is picked above, so this is the same as stock.</p>
          ) : null}
          <Seg
            label="Camera"
            value={settings.camera}
            disabled={running}
            options={[
              { id: "auto", label: "Best angle", title: "Finds the angle and close-up that show each slot's parts best" },
              { id: "view", label: "This view", title: "Every shot uses the viewfinder as framed when the shoot starts" },
            ]}
            onChange={(camera) => update({ camera })}
          />
          {settings.camera === "auto" ? (
            <p className="lv-slot-note">Each slot is tried from every side, then shot close up from the angle that shows its parts best. Engine bay and trunk shots hide the hood or boot.</p>
          ) : null}
          <Chips
            label="Slots"
            items={slotItems}
            isOn={slotOn}
            onToggle={toggleSlot}
            allOn={allSlotsOn}
            onAll={() => update({ slots: allSlotsOn ? [] : null })}
            disabled={running}
          />
        </>
      ) : (
        <>
          <Chips
            label="Builds"
            items={buildItems}
            isOn={(id) => settings.builds.includes(id)}
            onToggle={(id) => toggleIn("builds", id)}
            disabled={running}
          />
          <Chips
            label="Angles"
            items={BUILD_ANGLES}
            isOn={(id) => settings.angles.includes(id)}
            onToggle={(id) => toggleIn("angles", id)}
            allOn={settings.angles.length === BUILD_ANGLES.length}
            onAll={() => update({ angles: settings.angles.length === BUILD_ANGLES.length ? [] : BUILD_ANGLES.map((angle) => angle.id) })}
            disabled={running}
          />
          <div className="lv-field">
            <label className="cx-label" htmlFor="lv-shoot-paints">Extra paints</label>
            <input
              id="lv-shoot-paints"
              type="text"
              className="lv-text-input is-mono"
              value={paintText}
              placeholder="GTA colour indices, e.g. 0, 27, 64"
              disabled={running}
              onChange={(event) => {
                const text = event.currentTarget.value;
                setPaintText(text);
                update({ paints: parsePaintList(text).indices });
              }}
            />
            {paints.indices.length ? (
              <div className="lv-shoot-paints">
                {paints.indices.map((index) => {
                  const color = getVehicleColor(index);
                  return (
                    <span key={index} className="lv-shoot-paint" title={`${index} · ${color.name}`}>
                      <span className="lv-shoot-swatch" style={{ "--chip": color.hex }} aria-hidden="true" />
                      {color.name}
                    </span>
                  );
                })}
              </div>
            ) : null}
            {paints.invalid.length ? (
              <p className="lv-slot-note is-warn"><span className="lv-dot" aria-hidden="true" />{`Not a GTA colour index: ${paints.invalid.join(", ")}`}</p>
            ) : (
              <p className="lv-slot-note">Each build is also shot in these primary colours, after its current paint.</p>
            )}
          </div>
        </>
      )}

      <Seg
        label="Format"
        value={settings.format}
        disabled={running}
        options={EXPORT_FORMATS.map((format) => ({ id: format.id, label: format.label, title: `${format.width}×${format.height}` }))}
        onChange={(format) => update({ format })}
      />
      <ToggleRow label="Double size" checked={settings.high} disabled={running} onChange={(high) => update({ high })} />

      <ToggleRow
        label={settings.mode === "parts" ? "Before and after" : "Before and after with stock"}
        checked={settings.beforeAfter}
        disabled={running}
        onChange={(beforeAfter) => update({ beforeAfter })}
      />
      {settings.beforeAfter ? (
        <>
          <Seg
            label="Style"
            value={settings.beforeAfterStyle}
            disabled={running}
            options={[
              { id: "side", label: "Side by side" },
              { id: "wipe", label: "Wipe", title: "One frame divided through the change" },
            ]}
            onChange={(beforeAfterStyle) => update({ beforeAfterStyle })}
          />
          <ToggleRow label="Zoom to the change" checked={settings.zoomToChange} disabled={running} onChange={(zoomToChange) => update({ zoomToChange })} />
        </>
      ) : null}
      <ToggleRow label={settings.mode === "parts" ? "Sheet per slot" : "Sheet of builds"} checked={settings.sheets} disabled={running} onChange={(sheets) => update({ sheets })} />
      <ToggleRow
        label={settings.mode === "parts" ? "Cycle video per slot" : "Cycle video of builds"}
        checked={settings.videos && shoot.videoSupported}
        disabled={running || !shoot.videoSupported}
        onChange={(videos) => update({ videos })}
        note={shoot.videoSupported
          ? (settings.videos ? `Videos record in real time, about a second per ${settings.mode === "parts" ? "part" : "build"}.` : "")
          : "This runtime can't record video."}
      />

      {shoot.preview.url ? (
        <div className="lv-shoot-preview">
          <div className="lv-sheet-preview" style={{ aspectRatio: `${format.width} / ${format.height}` }}>
            <img src={shoot.preview.url} alt="Framing of the first shot" />
          </div>
          <p className="lv-slot-note">
            <span>{shoot.preview.note}</span>
            <button type="button" className="lv-link lv-native-retry" disabled={running} onClick={refreshPreview}>
              <RefreshCw aria-hidden="true" />
              Refresh
            </button>
          </p>
        </div>
      ) : shoot.preview.note ? (
        <p className="lv-slot-note">{shoot.preview.note}</p>
      ) : null}

      <p className="lv-sheet-dest" title={s.previewFolder || undefined}>
        <FolderOpen aria-hidden="true" />
        {s.previewFolder ? <span className="is-path">{s.previewFolder}</span> : <span>You'll choose a folder when you shoot.</span>}
      </p>
      <p className="lv-slot-note">
        <FileText className="lv-shoot-icon" aria-hidden="true" />
        <span>{plan?.empty || `${outputs}, plus kit-shoot.json and report.html in a new folder.`}</span>
      </p>

      {running ? (
        <LiveRun shoot={shoot} format={format} />
      ) : (
        <button
          type="button"
          className="cx-btn is-primary lv-capture-btn"
          disabled={nothingToShoot || !s.viewerReady}
          title={!s.viewerReady ? "The viewer is still loading" : undefined}
          onClick={shoot.start}
        >
          <Camera aria-hidden="true" />
          {nothingToShoot ? (plan?.empty || "Pick a slot") : `Shoot ${plural(plan.shots, "shot")}`}
        </button>
      )}

      {shoot.result && !running ? <ResultCard shoot={shoot} /> : null}

      {!running ? (
        <button type="button" className="lv-link lv-shot-previous" onClick={shoot.openPreviousRun}>
          <History aria-hidden="true" />
          Open an earlier shoot
        </button>
      ) : null}
      {shoot.reviewError ? <p className="lv-done-error" role="alert">{shoot.reviewError}</p> : null}
    </section>
  );
}
