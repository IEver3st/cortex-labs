import { useEffect, useMemo, useRef } from "react";
import { AlertTriangle, Camera, Check, ChevronDown, ChevronUp, FolderOpen, Loader2, RefreshCw, Search, X } from "lucide-react";
import { HOTKEY_ACTIONS } from "../../lib/hotkeys";
import { stepVehicle, vehicleIndexOf } from "../../lib/vehicle-folder";
import { packName, plateLabel, stagedLiveryCount } from "../../lib/vehicle-snapshots";
import { Fact, FactDisclosure, FactList, Facts } from "./DockFacts";
import { splitPath, withShortcut } from "./parts";
import "./PackSheet.css";

/* The Pack view: every vehicle in the folder the user opened, as snapshots
   grouped by resource, in place of the workspace. A tile opens its vehicle in
   the Vehicle view as if picked in the Model step. Snapshots are still
   images the viewer took (usePackSnapshots), so the sheet never renders 3D. */

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const slashes = (path) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");

function relativeTo(root, path) {
  const base = slashes(root);
  const own = slashes(path);
  return own.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? own.slice(base.length + 1) : own;
}

// Vehicles arrive sorted by resource, so each resource's run is contiguous.
function groupByResource(vehicles) {
  const groups = [];
  for (const vehicle of vehicles) {
    const last = groups[groups.length - 1];
    if (last && last.path === vehicle.resourcePath) last.vehicles.push(vehicle);
    else groups.push({ path: vehicle.resourcePath, name: vehicle.resource, vehicles: [vehicle] });
  }
  return groups;
}

// "08 / 18": the position padded to the total's width, so the figure holds still.
function position(at, total) {
  return `${String(at + 1).padStart(String(total).length, "0")}`;
}

function VehicleTile({ vehicle, plate, url, open, busy, staged, onOpen, tileRef }) {
  const file = splitPath(vehicle.path).name;
  const named = vehicle.gameName && vehicle.gameName.toLowerCase() !== vehicle.name.toLowerCase();
  const problems = vehicle.problems || [];
  return (
    <li className={`lv-pack-tile ${open ? "is-open" : ""}`} ref={open ? tileRef : undefined}>
      <button type="button" className="lv-pack-tile-btn" onClick={onOpen} aria-current={open ? "true" : undefined} title={vehicle.path}>
        <span className="lv-pack-shot">
          {url ? (
            <img src={url} alt="" loading="lazy" decoding="async" draggable={false} />
          ) : (
            <span className="cx-display lv-pack-plate" aria-hidden="true">{plate}</span>
          )}
          {busy ? <Loader2 className="lv-pack-busy" role="img" aria-label="Loading" /> : null}
        </span>
        <span className="lv-pack-cap">
          <span className="lv-pack-name">{vehicle.name}</span>
          {problems.length ? (
            <span className="lv-pack-warn" role="img" aria-label={`Meta errors: ${problems.join(" ")}`} title={problems.join("\n")}>
              <AlertTriangle aria-hidden="true" />
            </span>
          ) : null}
          {staged ? <span className="lv-pack-staged" title="Liveries staged in the Liveries tab and not written yet">{staged} staged</span> : null}
        </span>
        <span className="lv-pack-sub">{named ? vehicle.gameName : file}</span>
      </button>
    </li>
  );
}

function FolderNotes({ scan }) {
  const { missing, errors, truncated } = scan;
  if (!missing.length && !errors.length && !truncated) return null;
  return (
    <div className="lv-pack-notes">
      <Facts label="Folder">
        {missing.length ? (
          <FactDisclosure label="Missing models" value={missing.length} tone="warn" title="Named in a vehicles.meta, with no model in the folder">
            <FactList items={missing.map((entry) => ({ key: `${entry.resource}/${entry.name}`, text: `${entry.name} in ${entry.resource}` }))} />
          </FactDisclosure>
        ) : null}
        {errors.length ? (
          <FactDisclosure label="Couldn't read" value={errors.length} tone="warn" title="Folders and meta files the list skipped">
            <FactList items={errors.map((entry) => ({ key: entry.path, text: `${relativeTo(scan.folder, entry.path) || entry.path}: ${entry.message}`, tone: "warn" }))} />
          </FactDisclosure>
        ) : null}
        {truncated ? (
          <Fact label="Listing" tone="warn" text note="The folder is too large to list in full. Open one resource or category folder to see all of it.">
            Partial
          </Fact>
        ) : null}
      </Facts>
    </div>
  );
}

function SnapshotControl({ s, missing, total }) {
  const run = s.snapshotRun;
  if (run) {
    return (
      <div className="lv-pack-run">
        <p className="lv-pack-run-text" role="status">
          <Loader2 className="lv-pack-spin" aria-hidden="true" />
          Taking snapshots
          <span className="lv-pack-figure">{Math.min(run.done + run.failed + 1, run.total)} / {run.total}</span>
        </p>
        <button type="button" className="cx-btn is-quiet lv-pack-btn" onClick={s.stopSnapshots}>Stop</button>
      </div>
    );
  }
  const result = s.snapshotResult;
  return (
    <div className="lv-pack-run">
      {result && (result.done || result.failed) ? (
        <p className={`lv-pack-run-text ${result.failed ? "is-warn" : "is-done"}`} role="status">
          {result.failed ? <AlertTriangle aria-hidden="true" /> : <Check aria-hidden="true" />}
          {result.failed
            ? `${plural(result.done, "snapshot")} taken, ${plural(result.failed, "vehicle")} didn't load`
            : `${plural(result.done, "snapshot")} taken`}
        </p>
      ) : null}
      {missing ? (
        <button
          type="button"
          className="cx-btn lv-pack-btn"
          onClick={s.takeSnapshots}
          title="Opens each vehicle without a snapshot in turn and takes one, then goes back to the vehicle you had open"
        >
          <Camera aria-hidden="true" />
          Take snapshots
          <span className="lv-pack-figure">{missing}</span>
        </button>
      ) : total ? (
        <button
          type="button"
          className="cx-btn is-quiet lv-pack-btn"
          onClick={s.takeSnapshots}
          title="Opens every vehicle in turn and takes its snapshot again, such as after you write liveries or turn the model's own textures on or off, then goes back to the vehicle you had open"
        >
          <Camera aria-hidden="true" />
          Retake snapshots
          <span className="lv-pack-figure">{total}</span>
        </button>
      ) : null}
    </div>
  );
}

export default function PackSheet({ s }) {
  const scan = s.folderScan;
  const visible = s.folderVehicles;
  const query = s.vehicleFilter;
  const current = s.modelSourcePath || s.modelPath;
  const at = vehicleIndexOf(visible, current);
  const openPath = at >= 0 ? visible[at].path : "";
  const tileRef = useRef(null);
  const folder = scan.folder || s.vehicleFolder;
  const snapshots = s.packSnapshots;
  const run = s.snapshotRun;

  // The open vehicle stays in view as the filter or the folder changes.
  useEffect(() => {
    tileRef.current?.scrollIntoView({ block: "nearest" });
  }, [openPath, visible.length]);

  const names = useMemo(() => scan.vehicles.map((vehicle) => vehicle.name), [scan.vehicles]);
  const groups = groupByResource(visible);
  // Headers name resources only when the folder holds more than one.
  const showGroups = new Set(scan.vehicles.map((vehicle) => vehicle.resourcePath)).size > 1;
  const staged = (path) => stagedLiveryCount(s.liverySetEntries?.[path]);
  const stagedTotal = scan.vehicles.reduce((sum, vehicle) => sum + staged(vehicle.path), 0);
  const withProblems = scan.vehicles.filter((vehicle) => vehicle.problems?.length).length;
  const missing = snapshots.ready ? scan.vehicles.filter((vehicle) => snapshots.taken[vehicle.path] == null).length : 0;
  const ready = scan.status === "ready";

  return (
    <section className="lv-pack" aria-label="Vehicles in the folder">
      <header className="lv-pack-head">
        <div className="lv-pack-id">
          <h2 className="cx-display lv-pack-title" title={folder}>{packName(folder, scan.vehicles)}</h2>
          <div className="lv-pack-where">
            <span className="lv-pack-path" title={folder}>{folder}</span>
            <button type="button" className="cx-icon-btn" onClick={scan.rescan} disabled={scan.status === "scanning" || Boolean(run)}
              aria-label="List the folder again" title="List the folder again">
              <RefreshCw aria-hidden="true" />
            </button>
            <button type="button" className="cx-icon-btn" onClick={s.openVehicleFolder} aria-label="Open another folder" title="Open another folder">
              <FolderOpen aria-hidden="true" />
            </button>
            <button type="button" className="cx-icon-btn" onClick={s.closeVehicleFolder} aria-label="Close the folder" title="Close the folder">
              <X aria-hidden="true" />
            </button>
          </div>
        </div>

        {ready && scan.vehicles.length ? (
          <div className="lv-pack-tools">
            <p className="lv-pack-stats">
              <span>
                <b>{query.trim() ? `${visible.length} of ${scan.vehicles.length}` : scan.vehicles.length}</b>
                {scan.vehicles.length === 1 ? " vehicle" : " vehicles"}
              </span>
              {stagedTotal ? (
                <span className="is-caution" title="Liveries staged in the Liveries tab and not written yet">
                  <b>{stagedTotal}</b> {stagedTotal === 1 ? "livery" : "liveries"} staged
                </span>
              ) : null}
              {withProblems ? (
                <span className="is-caution" title="Vehicles whose meta has errors the Meta tab explains">
                  <b>{withProblems}</b> with meta errors
                </span>
              ) : null}
            </p>
            <SnapshotControl s={s} missing={missing} total={snapshots.ready ? scan.vehicles.length : 0} />
            <label className="lv-pack-search">
              <Search className="lv-pack-search-icon" aria-hidden="true" />
              <input
                type="text"
                className="lv-pack-search-input"
                placeholder="Filter vehicles"
                aria-label="Filter vehicles"
                spellCheck={false}
                value={query}
                onChange={(event) => s.setVehicleFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query) {
                    event.preventDefault();
                    s.setVehicleFilter("");
                  }
                }}
              />
              {query ? (
                <button type="button" className="lv-pack-search-clear" onClick={() => s.setVehicleFilter("")} aria-label="Clear the filter" title="Clear the filter">
                  <X aria-hidden="true" />
                </button>
              ) : null}
            </label>
          </div>
        ) : null}
      </header>

      <div className="lv-pack-scroll custom-scrollbar">
        {scan.status === "scanning" ? (
          <p className="lv-pack-state" role="status">
            <Loader2 className="lv-pack-spin" aria-hidden="true" />
            Listing vehicles…
          </p>
        ) : scan.status === "error" ? (
          <div className="lv-pack-empty" role="alert">
            <p className="lv-pack-empty-title is-error">Couldn't read this folder</p>
            <p className="lv-pack-empty-hint" title={scan.error}>
              Cortex reads a folder you open for this session. Open it again to list it.
            </p>
            <button type="button" className="cx-btn lv-pack-btn" onClick={s.openVehicleFolder}>
              <FolderOpen aria-hidden="true" />
              Open folder…
            </button>
          </div>
        ) : !scan.vehicles.length ? (
          <div className="lv-pack-empty">
            <p className="lv-pack-empty-title">No vehicles in this folder</p>
            <p className="lv-pack-empty-hint">
              Cortex lists the models each vehicles.meta names, or every .yft when there is none, leaving out mod kit parts.
            </p>
            <button type="button" className="cx-btn lv-pack-btn" onClick={s.openVehicleFolder}>
              <FolderOpen aria-hidden="true" />
              Open another folder…
            </button>
          </div>
        ) : !visible.length ? (
          <div className="lv-pack-empty">
            <p className="lv-pack-empty-title">No vehicles match “{query.trim()}”</p>
            <button type="button" className="lv-link" onClick={() => s.setVehicleFilter("")}>Clear the filter</button>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.path} className="lv-pack-group" aria-label={showGroups ? group.name : undefined}>
              {showGroups ? (
                <h3 className="cx-label lv-pack-group-head" title={group.path}>
                  <span className="lv-pack-group-name">{group.name}</span>
                  <span className="lv-pack-group-count">{group.vehicles.length}</span>
                </h3>
              ) : null}
              <ul className="lv-pack-grid">
                {group.vehicles.map((vehicle) => {
                  const open = vehicle.path === openPath;
                  return (
                    <VehicleTile
                      key={vehicle.path}
                      vehicle={vehicle}
                      plate={plateLabel(vehicle.name, names)}
                      url={snapshots.urls[vehicle.path]}
                      open={open}
                      busy={run ? run.current === vehicle.path : open && s.modelLoading}
                      staged={staged(vehicle.path)}
                      onOpen={() => s.openFolderVehicle(vehicle)}
                      tileRef={tileRef}
                    />
                  );
                })}
              </ul>
            </section>
          ))
        )}
        {ready ? <FolderNotes scan={scan} /> : null}
      </div>
    </section>
  );
}

/* The Vehicle view's way back to the pack: where the open vehicle sits in the
   folder, and the steps either side of it. */
export function PackBar({ s }) {
  const visible = s.folderVehicles;
  const scan = s.folderScan;
  const hk = s.hotkeys || {};
  const current = s.modelSourcePath || s.modelPath;
  const at = vehicleIndexOf(visible, current);
  const ready = scan.status === "ready";
  const canStep = (delta) => ready && Boolean(stepVehicle(visible, current, delta));
  const name = packName(scan.folder || s.vehicleFolder, scan.vehicles);
  return (
    <div className="lv-packbar" role="group" aria-label="Folder of vehicles">
      <button type="button" className="lv-packbar-pack" onClick={() => s.setFolderView("pack")} title="Show every vehicle in the folder">
        {ready ? (
          <span className="cx-display lv-packbar-figure" aria-label={at >= 0 ? `Vehicle ${at + 1} of ${visible.length}` : plural(visible.length, "vehicle")}>
            {at >= 0 ? <>{position(at, visible.length)} <span className="lv-packbar-total">/ {visible.length}</span></> : visible.length}
          </span>
        ) : null}
        <span className="lv-packbar-name">{name}</span>
      </button>
      <button
        type="button"
        className="cx-icon-btn"
        onClick={() => s.stepFolderVehicle(-1)}
        disabled={!canStep(-1)}
        aria-label="Previous vehicle"
        title={withShortcut("Previous vehicle", hk[HOTKEY_ACTIONS.PREVIOUS_VEHICLE])}
      >
        <ChevronUp aria-hidden="true" />
      </button>
      <button
        type="button"
        className="cx-icon-btn"
        onClick={() => s.stepFolderVehicle(1)}
        disabled={!canStep(1)}
        aria-label="Next vehicle"
        title={withShortcut("Next vehicle", hk[HOTKEY_ACTIONS.NEXT_VEHICLE])}
      >
        <ChevronDown aria-hidden="true" />
      </button>
    </div>
  );
}
