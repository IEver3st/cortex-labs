import { useEffect, useMemo, useState } from "react";
import { Camera, FileText, FolderOpen, Stethoscope, X } from "lucide-react";
import { parsePaintList } from "../../lib/kit-shoot.js";
import { getVehicleColor } from "../../lib/data/gta-vehicle-colors.js";
import { HERO_ANGLES, LIGHTS_SECONDS, STORE_FORMATS, TURNTABLE_SECONDS } from "../../lib/listing-shoot.js";
import { CardThumb, Chips, LiveRun, Seg, ToggleRow, plural } from "./KitShootPanel";
import { createShootFileCache } from "./shootFiles.js";
import useVehicleDoctor from "./useVehicleDoctor.js";
import useSirenResource from "../siren-editor/useSirenResource.js";
import "./ListingPanel.css";

const STORE_ITEMS = STORE_FORMATS.map((format) => ({ id: format.id, label: format.label, title: `${format.width}×${format.height}` }));
const FORMAT_OPTIONS = STORE_FORMATS.map((format) => ({ id: format.id, label: format.label, title: `${format.width}×${format.height}` }));

function Note({ tone, children }) {
  return (
    <p className={`lv-slot-note${tone ? ` is-${tone}` : ""}`}>
      {tone ? <span className="lv-dot" aria-hidden="true" /> : null}
      <span>{children}</span>
    </p>
  );
}

function describeDoctor(doctor) {
  if (doctor.status === "checking") return { tone: "busy", text: "Pack Doctor is checking the vehicle's files…" };
  if (!doctor.report) return { tone: "idle", text: `${doctor.reason} The report says so.` };
  const { error = 0, warn = 0, info = 0, notChecked = 0 } = doctor.report.counts;
  const found = [
    error ? plural(error, "error") : "",
    warn ? plural(warn, "warning") : "",
    info ? plural(info, "note") : "",
  ].filter(Boolean).join(", ");
  const skipped = notChecked ? `, ${notChecked} not checked` : "";
  if (!found) return { tone: "ok", text: `Pack Doctor: no problems found${skipped}.` };
  return { tone: error ? "error" : warn ? "warn" : "idle", text: `Pack Doctor: ${found}${skipped}. They go in the report and don't stop the shoot.` };
}

function DoctorSummary({ doctor, onShowHealth }) {
  const { tone, text } = describeDoctor(doctor);
  const showHealth = (event) => {
    const scroller = event.currentTarget.closest(".lv-inspector-scroll");
    onShowHealth();
    let frames = 0;
    let settled = 0;
    const follow = () => {
      const target = scroller?.querySelector(".pd-health") || scroller?.querySelector(".mp-root");
      const offset = target ? target.getBoundingClientRect().top - scroller.getBoundingClientRect().top : 0;
      if (Math.abs(offset) > 1) scroller.scrollTop += offset;
      settled = target && Math.abs(offset) <= 1 ? settled + 1 : 0;
      frames += 1;
      if (settled < 6 && frames < 60) requestAnimationFrame(follow);
    };
    requestAnimationFrame(follow);
  };
  return (
    <div className="lv-listing-doctor">
      <p className={`lv-slot-note is-${tone}`} role="status">
        {tone === "busy" ? null : <span className="lv-dot" aria-hidden="true" />}
        <span>{text}</span>
      </p>
      {doctor.report && onShowHealth ? (
        <button type="button" className="cx-btn lv-btn-sm" onClick={showHealth} title="Open Health in the Meta tab, which lists every finding with its fix">
          <Stethoscope aria-hidden="true" />
          Show in Health
        </button>
      ) : null}
    </div>
  );
}

function ListingResult({ shoot }) {
  const { result } = shoot;
  const [cache, setCache] = useState(null);
  useEffect(() => {
    if (!result.folder) return undefined;
    const next = createShootFileCache(result.folder);
    setCache(next);
    return () => next.dispose();
  }, [result.folder]);

  const counts = { error: 0, warning: 0, info: 0 };
  for (const entry of result.issues) {
    if (entry.code !== "NOT_MADE") counts[entry.severity] = (counts[entry.severity] || 0) + 1;
  }
  const findings = [
    counts.error ? { tone: "error", text: plural(counts.error, "error") } : null,
    counts.warning ? { tone: "warn", text: plural(counts.warning, "warning") } : null,
    counts.info ? { tone: "idle", text: plural(counts.info, "note") } : null,
  ].filter(Boolean);
  const done = result.summary.tone === "done" && !result.cancelled;
  const made = [
    result.stills ? plural(result.stills, "still") : "",
    result.videos ? plural(result.videos, "video") : "",
    result.kitShots ? `${plural(result.kitShots, "kit shot")}` : "",
  ].filter(Boolean).join(", ");

  return (
    <div className={`lv-shot-card ${done ? "" : "is-partial"}`} role="status">
      <div className="lv-shot-card-head">
        <strong>{result.summary.headline}</strong>
        <button type="button" className="cx-icon-btn lv-shot-dismiss" aria-label="Dismiss" title="Dismiss" onClick={shoot.dismissResult}>
          <X aria-hidden="true" />
        </button>
      </div>
      {made ? <p className="lv-slot-note">{made}</p> : null}
      {result.cancelled ? <Note tone="warn">Cancelled. What was made before that is saved, and your livery, paint and parts are back.</Note> : null}
      {result.fatal ? <p className="lv-done-error" role="alert">{`The shoot stopped: ${result.fatal}`}</p> : null}
      {result.failed > 0 ? <p className="lv-done-error" role="alert">{`${plural(result.failed, "file")} couldn't be written: ${result.firstError}`}</p> : null}
      {result.folder && !result.manifestSaved ? <p className="lv-done-error" role="alert">listing.json wasn't written.</p> : null}
      {result.thumbs.length ? (
        <div className="lv-shot-strip" aria-label="Shots from this run">
          {result.thumbs.map((item) => <CardThumb key={item.id} cache={cache} path={item.path} label={item.label} />)}
        </div>
      ) : null}
      {result.folder ? (
        <p className="lv-shot-findings">
          {findings.length
            ? findings.map((entry) => <span key={entry.tone} className={`lv-slot-note is-${entry.tone}`}><span className="lv-dot" aria-hidden="true" />{entry.text}</span>)
            : <span className="lv-slot-note is-ok"><span className="lv-dot" aria-hidden="true" />No problems found</span>}
        </p>
      ) : null}
      {result.folder ? <p className="lv-shot-path" title={result.folder}>{result.folder}</p> : null}
      {result.folder && result.reportSaved ? <p className="lv-slot-note">Every check is listed in report.html in that folder.</p> : null}
      {shoot.openError ? <p className="lv-done-error" role="alert">{shoot.openError}</p> : null}
      {result.folder ? (
        <div className="lv-shot-actions">
          <button type="button" className="cx-btn lv-btn-sm" onClick={shoot.openResultFolder}>
            <FolderOpen aria-hidden="true" />
            Folder
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function ListingPanel({ s, onShowHealth }) {
  const shoot = s.listingShoot;
  const doctor = useVehicleDoctor({
    modelPath: s.modelPath,
    modelInfo: s.metaModelInfo,
    meshStats: s.meshStats,
    isTauriRuntime: s.isTauriRuntime,
    enabled: Boolean(shoot && s.isTauriRuntime && s.modelPath),
  });
  const modkits = s.modkits;
  const request = modkits?.request;
  useEffect(() => {
    request?.();
  }, [request]);
  const hasSirenMeshes = Boolean(s.metaModelInfo?.lights?.sirens?.length);
  const sirenResource = useSirenResource({
    modelPath: hasSirenMeshes ? s.modelPath : "",
    modelInfo: s.metaModelInfo,
    isTauriRuntime: s.isTauriRuntime,
    rescanToken: s.metaRescanToken,
    onLightsChange: s.updateVehicleLights,
  });
  const settings = shoot?.settings;
  const [paintText, setPaintText] = useState(() => (settings?.paints || []).join(", "));
  const paints = useMemo(() => parsePaintList(paintText), [paintText]);

  if (!shoot) return null;
  if (!s.isTauriRuntime) return <p className="lv-slot-note">Listing Shoot writes a folder of files, so it needs the desktop app.</p>;
  if (!s.modelPath) return <p className="lv-slot-note">Load a vehicle to shoot its store media.</p>;

  const { plan, update, running } = shoot;
  const busy = running || Boolean(s.kitShoot?.running);
  const toggleIn = (key, id) => update((current) => ({
    [key]: current[key].includes(id) ? current[key].filter((entry) => entry !== id) : [...current[key], id],
  }));
  const reason = (item) => plan.skipped.find((entry) => entry.item === item)?.reason || "";
  const kitScanning = modkits?.eligible && (modkits.status === "idle" || modkits.status === "scanning");
  const hasKit = Boolean(modkits?.eligible && modkits.status === "ready" && modkits.activeKit);
  const lineupCount = plan.lineup?.items.length || 0;
  const heroSize = plan.heroSize;
  const outputs = [
    plan.stillCount ? plural(plan.stillCount, "still") : "",
    plan.videos.length ? plural(plan.videos.length, "video") : "",
    plan.kit ? "mod kit shots" : "",
  ].filter(Boolean).join(", ");
  const canStart = !plan.empty && s.viewerReady && !busy;
  const startTitle = !s.viewerReady ? "The viewer is still loading" : s.kitShoot?.running ? "A kit shoot is running" : plan.empty ? "Pick something to make" : undefined;
  const liveFormat = { width: 16, height: 9 };

  return (
    <section className="lv-group lv-shoot lv-listing" id="panel-listing-shoot">
      <div className="lv-group-head">
        <h3 className="lv-group-title">Listing shoot</h3>
        <span className="lv-mod-meta">{plan.empty ? "Nothing picked" : outputs}</span>
      </div>
      <p className="lv-slot-note">One run makes the store media for a Tebex or Cfx Marketplace listing from the vehicle as it is now. Your livery, paint and parts come back when it ends.</p>

      <Chips
        label="Hero stills"
        items={HERO_ANGLES}
        isOn={(id) => settings.heroAngles.includes(id)}
        onToggle={(id) => toggleIn("heroAngles", id)}
        allOn={settings.heroAngles.length === HERO_ANGLES.length}
        onAll={() => update({ heroAngles: settings.heroAngles.length === HERO_ANGLES.length ? [] : HERO_ANGLES.map((angle) => angle.id) })}
        disabled={busy}
      />
      <p className="lv-slot-note">
        {shoot.heroSizeFixed
          ? `At your capture size, ${heroSize.width}×${heroSize.height}.`
          : `Capture size is set to the window, so stills are ${heroSize.width}×${heroSize.height}. Settings picks a fixed size.`}
      </p>

      <Chips
        label="Store formats"
        items={STORE_ITEMS}
        isOn={(id) => settings.storeFormats.includes(id)}
        onToggle={(id) => toggleIn("storeFormats", id)}
        disabled={busy}
      />
      <p className="lv-slot-note">Each format is framed for its own shape, at every hero angle, never cropped from another shot.</p>

      <ToggleRow label="Livery lineup" checked={settings.lineup} disabled={busy} onChange={(lineup) => update({ lineup })} />
      {settings.lineup ? (
        lineupCount
          ? <p className="lv-slot-note">{`${plural(lineupCount, "livery", "liveries")}, one frame each${lineupCount > 1 ? ", plus a labelled sheet" : ""}. Identical frames are flagged.`}</p>
          : <Note tone="idle">{kitScanning ? "Reading the mod kit for livery mods…" : reason("Livery lineup")}</Note>
      ) : null}

      <ToggleRow label="Before and after" checked={settings.beforeAfter} disabled={busy} onChange={(beforeAfter) => update({ beforeAfter })} />
      {settings.beforeAfter ? (
        plan.beforeAfter ? (
          <Seg
            label="Style"
            value={settings.beforeAfterStyle}
            disabled={busy}
            options={[{ id: "side", label: "Side by side" }, { id: "wipe", label: "Wipe" }]}
            onChange={(beforeAfterStyle) => update({ beforeAfterStyle })}
          />
        ) : <Note tone="idle">{reason("Before and after")}</Note>
      ) : null}

      <ToggleRow label="Paint sheet" checked={settings.paintSheet} disabled={busy} onChange={(paintSheet) => update({ paintSheet })} />
      {settings.paintSheet ? (
        <div className="lv-field">
          <label className="cx-label" htmlFor="lv-listing-paints">Paints</label>
          <input
            id="lv-listing-paints"
            type="text"
            className="lv-text-input is-mono"
            value={paintText}
            placeholder="GTA colour indices, e.g. 0, 111, 27"
            disabled={busy}
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
          {paints.invalid.length
            ? <Note tone="warn">{`Not a GTA colour index: ${paints.invalid.join(", ")}`}</Note>
            : <p className="lv-slot-note">The first hero angle in up to 8 primary colours, as stills and a sheet.</p>}
        </div>
      ) : null}

      {hasKit ? (
        <>
          <ToggleRow label="Mod kit parts" checked={settings.kitParts} disabled={busy} onChange={(kitParts) => update({ kitParts })}
            note={settings.kitParts ? "Every part of every slot, best angle, with before and after and a sheet per slot, under kit/parts." : ""} />
          <ToggleRow label="Builds" checked={settings.kitBuilds} disabled={busy} onChange={(kitBuilds) => update({ kitBuilds })}
            note={settings.kitBuilds ? `The current build${modkits.builds.length ? ` and ${plural(modkits.builds.length, "saved build")}` : ""} at the hero angles, against stock, under kit/builds.` : ""} />
        </>
      ) : kitScanning ? (
        <p className="lv-slot-note is-busy">Reading the resource's mod kit…</p>
      ) : null}

      <ToggleRow
        label="Turntable video"
        checked={settings.turntable && shoot.videoSupported}
        disabled={busy || !shoot.videoSupported}
        onChange={(turntable) => update({ turntable })}
        note={shoot.videoSupported ? "" : "This runtime can't record video."}
      />
      {settings.turntable && shoot.videoSupported ? (
        <>
          <Seg label="Video format" value={settings.turntableFormat} disabled={busy} options={FORMAT_OPTIONS} onChange={(turntableFormat) => update({ turntableFormat })} />
          <Seg
            label="Length"
            value={settings.turntableSeconds}
            disabled={busy}
            options={TURNTABLE_SECONDS.map((seconds) => ({ id: seconds, label: `${seconds} s` }))}
            onChange={(turntableSeconds) => update({ turntableSeconds })}
          />
          <p className="lv-slot-note">One full turn at 30 fps, recorded in real time. It keeps recording if you minimise the window.</p>
        </>
      ) : null}

      <ToggleRow
        label="Night lights clip"
        checked={settings.lights && shoot.lights.available && shoot.videoSupported}
        disabled={busy || !shoot.lights.available || !shoot.videoSupported}
        onChange={(lights) => update({ lights })}
        note={!shoot.lights.available ? (sirenResource.status === "scanning" ? "Reading the resource's meta files…" : shoot.lights.reason) : !shoot.videoSupported ? "This runtime can't record video." : ""}
      />
      {settings.lights && shoot.lights.available && shoot.videoSupported ? (
        <>
          <Seg
            label="Clip length"
            value={settings.lightsSeconds}
            disabled={busy}
            options={LIGHTS_SECONDS.map((seconds) => ({ id: seconds, label: `${seconds} s` }))}
            onChange={(lightsSeconds) => update({ lightsSeconds })}
          />
          <p className="lv-slot-note">{`At night with the ${shoot.lights.system === "els" ? "ELS lights at full stage" : "sirens"} and headlights on, from the front 3/4. Your light switches come back after.`}</p>
        </>
      ) : null}

      <p className="lv-sheet-dest" title={s.previewFolder || undefined}>
        <FolderOpen aria-hidden="true" />
        {s.previewFolder ? <span className="is-path">{s.previewFolder}</span> : <span>You'll choose a folder when you shoot.</span>}
      </p>
      <p className="lv-slot-note">
        <FileText className="lv-shoot-icon" aria-hidden="true" />
        <span>{plan.empty ? "Pick something to make." : `${outputs}, plus listing.json and report.html in a new listing folder.`}</span>
      </p>
      <DoctorSummary doctor={doctor} onShowHealth={onShowHealth} />

      {running ? (
        <>
          <LiveRun shoot={shoot} format={liveFormat} />
          {shoot.recordingPaused ? <Note tone="warn">Recording paused while the window is hidden. It carries on when you come back.</Note> : null}
        </>
      ) : (
        <button type="button" className="cx-btn is-primary lv-capture-btn" disabled={!canStart} title={startTitle} onClick={() => shoot.start({ checkDoctor: doctor.check })}>
          <Camera aria-hidden="true" />
          {plan.empty ? "Pick something to make" : "Shoot the listing"}
        </button>
      )}

      {shoot.result && !running ? <ListingResult shoot={shoot} /> : null}
    </section>
  );
}
