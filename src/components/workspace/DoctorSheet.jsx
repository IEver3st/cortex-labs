import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Car, Check, ChevronDown, ClipboardCopy, FileDown, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { MEMORY_BANDS_MIB, OVERSIZED_MIB, formatMiB, groupDoctorFindings, isInside, memoryBand, namesSubject, relativePath } from "../../lib/pack-doctor";
import { packName } from "../../lib/vehicle-snapshots";
import ForgeCheckButton from "../siren-editor/ForgeCheck";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import useDoctorReport from "./useDoctorReport";
import "./PackSheet.css";
import "./DoctorSheet.css";

const SEVERITY_LABEL = { error: "Error", warn: "Warning", info: "Note" };
const FILTERS = [
  { id: "all", label: "All" },
  { id: "error", label: "Errors", empty: "errors" },
  { id: "warn", label: "Warnings", empty: "warnings" },
  { id: "info", label: "Notes", empty: "notes" },
];
const ALL_RESOURCES = "__all__";
const MEMORY_ROWS = 10;
const MEMORY_SCALE_MIB = MEMORY_BANDS_MIB[0];
const MIB = 1024 * 1024;

const baseName = (path) => String(path || "").split(/[\\/]/).pop() || "";
const modelKey = (path) => baseName(path).toLowerCase().replace(/\.(yft|ytd)$/, "").replace(/(_hi|\+hi)$/, "");
const shownPath = (root, path) => (path ? (isInside(root, path) ? relativePath(root, path) : baseName(path)) : "");

export function DoctorFinding({ finding, root }) {
  const file = shownPath(root, finding.path);
  return (
    <li className={`lv-doctor-row is-${finding.severity}`}>
      <span className="lv-doctor-dot" aria-hidden="true" />
      <div className="lv-doctor-row-body">
        <p className="lv-doctor-message">
          <span className="lv-doctor-sr">{SEVERITY_LABEL[finding.severity]}: </span>
          {finding.message}
        </p>
        {finding.fix ? <p className="lv-doctor-fix">{finding.fix}</p> : null}
        <p className="lv-doctor-where">
          {file ? <span className="lv-doctor-file" title={finding.path}>{file}</span> : null}
          <span className="lv-doctor-code">{finding.code}</span>
        </p>
      </div>
    </li>
  );
}

export function DoctorNotChecked({ entries, root }) {
  if (!entries.length) return null;
  return (
    <ul className="lv-doctor-list">
      {entries.map((entry, index) => (
        <li key={`${entry.what}-${index}`} className="lv-doctor-row is-idle">
          <span className="lv-doctor-dot" aria-hidden="true" />
          <div className="lv-doctor-row-body">
            <p className="lv-doctor-message">{entry.what}</p>
            <p className="lv-doctor-fix">Not checked: {entry.reason}</p>
            {entry.path && relativePath(root, entry.path) !== entry.what ? (
              <p className="lv-doctor-where"><span className="lv-doctor-file" title={entry.path}>{relativePath(root, entry.path)}</span></p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function DoctorStatus({ status }) {
  if (!status) return null;
  return (
    <p className={`lv-doctor-status ${status.tone === "error" ? "is-error" : "is-ok"}`} role={status.tone === "error" ? "alert" : "status"}>
      {status.tone === "error" ? <AlertTriangle aria-hidden="true" /> : <Check aria-hidden="true" />}
      <span>{status.text}</span>
      {status.path ? " " : null}
      {status.path ? <span className="lv-doctor-status-path" title={status.path}>{status.path}</span> : null}
    </p>
  );
}

function memoryTone(bytes) {
  const band = memoryBand(bytes);
  return band >= OVERSIZED_MIB ? "is-error" : band ? "is-warn" : "";
}

function CheckGroup({ group, open, onToggle, root, vehicleFor, openVehicle }) {
  const subjects = [...new Set(group.items.map(({ finding }) => finding.subject || baseName(finding.path)).filter(Boolean))];
  const panelId = `lv-dr-${group.key.replace(/[^a-z0-9]+/gi, "-")}`;
  return (
    <li className={`lv-dr-check is-${group.severity} ${open ? "is-open" : ""}`}>
      <button type="button" className="lv-dr-check-head" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={onToggle}>
        <span className="lv-doctor-dot" aria-hidden="true" />
        <span className="lv-dr-check-id">
          <span className="lv-dr-check-title">
            <span className="lv-doctor-sr">{SEVERITY_LABEL[group.severity]}: </span>
            {group.title}
          </span>
          {!open && subjects.length ? (
            <span className="lv-dr-check-subjects" title={subjects.join(", ")}>
              {subjects.slice(0, 4).join(", ")}{subjects.length > 4 ? `, +${subjects.length - 4}` : ""}
            </span>
          ) : null}
        </span>
        <span className="lv-dr-check-num">{group.items.length}</span>
        <ChevronDown className="lv-dr-check-chev" aria-hidden="true" />
      </button>
      {open ? (
        <div className="lv-dr-check-body" id={panelId}>
          {group.explanation || group.fix ? (
            <div className="lv-dr-check-why">
              {group.explanation ? <p>{group.explanation}</p> : null}
              {group.fix ? <p className="lv-dr-fix"><span className="cx-label">Fix</span>{group.fix}</p> : null}
            </div>
          ) : null}
          <ul className="lv-dr-items">
            {group.items.map(({ finding, text, fix }, index) => {
              const file = shownPath(root, finding.path);
              const vehicle = vehicleFor(finding);
              return (
                <li key={`${finding.path}-${index}`} className="lv-dr-item">
                  <div className="lv-dr-item-body">
                    <p className="lv-dr-item-text">
                      {namesSubject(finding) ? <><span className="lv-dr-item-subject">{finding.subject}</span><span className="lv-doctor-sr">: </span></> : null}
                      {text}
                    </p>
                    {fix ? <p className="lv-dr-item-fix">{fix}</p> : null}
                    {file ? <p className="lv-dr-item-file" title={finding.path}><bdi dir="ltr">{file}</bdi></p> : null}
                  </div>
                  {vehicle ? (
                    <button type="button" className="cx-btn is-quiet lv-dr-open" onClick={() => openVehicle(vehicle)}
                      aria-label={`Open ${vehicle.name}`} title={`Open ${vehicle.name} in the Vehicle view`}>
                      <Car aria-hidden="true" />
                      Open
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

function MemoryList({ memory, root }) {
  const [all, setAll] = useState(false);
  if (!memory?.files.length) return null;
  const rows = all ? memory.files : memory.files.slice(0, MEMORY_ROWS);
  return (
    <section className="lv-dr-side-group" aria-label="Streamed memory">
      <h3 className="cx-label lv-dr-side-head">
        <span>Streamed memory</span>
        <span className="lv-dr-side-count">{memory.files.length}</span>
      </h3>
      <div className="lv-dr-mem-cols" aria-hidden="true">
        <span>File</span>
        <span>Graphics</span>
        <span>System</span>
      </div>
      <ul className="lv-dr-mem">
        {rows.map((file) => {
          const peak = Math.max(file.physical, file.virtual);
          return (
            <li key={file.path} className="lv-dr-mem-row" title={relativePath(root, file.path)}>
              <span className="lv-dr-mem-name">{baseName(file.path)}</span>
              <span className={`lv-dr-mem-num ${memoryTone(file.physical)}`} title={`${formatMiB(file.physical)} MiB of graphics memory`}>{formatMiB(file.physical)}</span>
              <span className={`lv-dr-mem-num ${memoryTone(file.virtual)}`} title={`${formatMiB(file.virtual)} MiB of system memory`}>{formatMiB(file.virtual)}</span>
              <span className="lv-dr-mem-track" aria-hidden="true">
                {MEMORY_BANDS_MIB.slice(1).map((band) => <i key={band} className="lv-dr-mem-tick" style={{ left: `${(band / MEMORY_SCALE_MIB) * 100}%` }} />)}
                <span className={`lv-dr-mem-fill ${memoryTone(peak)}`} style={{ width: `${Math.min(100, (peak / (MEMORY_SCALE_MIB * MIB)) * 100)}%` }} />
              </span>
            </li>
          );
        })}
      </ul>
      <p className="lv-dr-side-foot">
        <span>
          {memory.total
            ? <>Total <b>{formatMiB(memory.total.physical)}</b> MiB graphics, <b>{formatMiB(memory.total.virtual)}</b> MiB system</>
            : "No total: the folder is too large to measure in full."}
        </span>
        {memory.files.length > MEMORY_ROWS ? (
          <button type="button" className="lv-link" onClick={() => setAll((open) => !open)} aria-expanded={all}>
            {all ? "Show the largest" : `Show all ${memory.files.length}`}
          </button>
        ) : null}
      </p>
    </section>
  );
}

function SideNotChecked({ entries, root }) {
  if (!entries.length) return null;
  return (
    <section className="lv-dr-side-group" aria-label="Not checked">
      <h3 className="cx-label lv-dr-side-head">
        <span>Not checked</span>
        <span className="lv-dr-side-count">{entries.length}</span>
      </h3>
      <ul className="lv-dr-plain">
        {entries.map((entry, index) => (
          <li key={`${entry.what}-${index}`} title={entry.path ? relativePath(root, entry.path) : undefined}>
            <span className="lv-dr-plain-what">{entry.what}</span>
            <span className="lv-dr-plain-why">{entry.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function DoctorSheet({ s, doctor }) {
  const scan = s.folderScan;
  const folder = scan.folder || s.vehicleFolder;
  const report = doctor.report;
  const actions = useDoctorReport(report);
  const running = doctor.status === "running";
  const root = report?.root || folder;
  const [filter, setFilter] = useState("all");
  const [resourceFilter, setResourceFilter] = useState(ALL_RESOURCES);
  const [openKeys, setOpenKeys] = useState(() => new Set());

  const resourceRows = useMemo(() => (report ? report.resources.filter((resource) => !resource.escrowed) : []), [report]);
  const vehicleIndex = useMemo(() => {
    const byPath = new Map(scan.vehicles.map((vehicle) => [vehicle.path, vehicle]));
    const byModel = new Map();
    for (const vehicle of scan.vehicles) {
      const key = modelKey(vehicle.path);
      byModel.set(key, byModel.has(key) ? null : vehicle);
    }
    return { byPath, byModel };
  }, [scan.vehicles]);
  const vehicleFor = (finding) => {
    if (finding.vehiclePath) return vehicleIndex.byPath.get(finding.vehiclePath) || null;
    if (!/\.(ytd|yft)$/i.test(finding.path || "")) return null;
    return vehicleIndex.byPath.get(finding.path) || vehicleIndex.byModel.get(modelKey(finding.path)) || null;
  };

  const scoped = useMemo(() => {
    if (!report) return [];
    if (resourceFilter === ALL_RESOURCES) return report.findings;
    return report.findings.filter((finding) => !finding.resource || finding.resource === resourceFilter);
  }, [report, resourceFilter]);
  const counts = useMemo(() => {
    const next = { all: scoped.length, error: 0, warn: 0, info: 0 };
    for (const finding of scoped) next[finding.severity] = (next[finding.severity] || 0) + 1;
    return next;
  }, [scoped]);
  const groups = useMemo(() => groupDoctorFindings(filter === "all" ? scoped : scoped.filter((finding) => finding.severity === filter)), [scoped, filter]);

  useEffect(() => {
    if (!report) return;
    const all = groupDoctorFindings(report.findings);
    setOpenKeys(new Set(all.length <= 3 ? all.map((group) => group.key) : all.filter((group) => group.severity === "error").map((group) => group.key)));
    setFilter("all");
    setResourceFilter(ALL_RESOURCES);
  }, [report]);

  const toggle = (key) => setOpenKeys((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const allOpen = groups.length > 0 && groups.every((group) => openKeys.has(group.key));
  const setAllOpen = (open) => setOpenKeys((current) => {
    const next = new Set(current);
    for (const group of groups) {
      if (open) next.add(group.key);
      else next.delete(group.key);
    }
    return next;
  });

  const forgePath = resourceFilter !== ALL_RESOURCES ? resourceFilter : resourceRows.length === 1 ? resourceRows[0].path : "";
  const progress = doctor.total ? Math.round((doctor.done / doctor.total) * 100) : null;
  const hasSide = Boolean(report && (report.memory?.files.length || report.notChecked.length || report.escrowed.length));
  const name = packName(folder, scan.vehicles);
  const activeFilter = FILTERS.find((entry) => entry.id === filter) || FILTERS[0];
  const scopeName = resourceFilter !== ALL_RESOURCES ? resourceRows.find((resource) => resource.path === resourceFilter)?.name || "" : "";
  const emptyText = filter !== "all" || scopeName
    ? `No ${activeFilter.empty || "findings"} in ${scopeName || "this folder"}.`
    : report?.complete ? "No problems found." : "No problems found in what Pack Doctor could check.";

  return (
    <section className="lv-pack lv-doctor" aria-label="Pack Doctor">
      <header className="lv-pack-head">
        <div className="lv-pack-id">
          <h2 className="cx-display lv-pack-title" title={`${name}\n${folder}`}>{name}</h2>
          <div className="lv-pack-where">
            <span className="lv-pack-path" title={folder}>{folder}</span>
            <button type="button" className="cx-icon-btn" onClick={doctor.run} disabled={running || scan.status !== "ready"}
              aria-label="Check the folder again" title="Check the folder again">
              <RefreshCw aria-hidden="true" />
            </button>
            <button type="button" className="cx-icon-btn" onClick={s.openVehicleFolder} aria-label="Open another folder" title="Open another folder">
              <FolderOpen aria-hidden="true" />
            </button>
          </div>
        </div>
        {report && !running ? (
          <div className="lv-pack-tools">
            <p className="lv-pack-stats">
              <span><b>{scan.vehicles.length}</b> {scan.vehicles.length === 1 ? "vehicle" : "vehicles"}</span>
              <span><b>{resourceRows.length}</b> {resourceRows.length === 1 ? "resource" : "resources"}</span>
            </p>
            <div className="lv-doctor-actions">
              <button type="button" className="cx-btn lv-pack-btn" onClick={actions.copy} title="Copy the report as Markdown for a forum or Discord post">
                <ClipboardCopy aria-hidden="true" />
                Copy report
              </button>
              <button type="button" className="cx-btn lv-pack-btn" onClick={actions.saveReport} disabled={actions.saving}
                title="Save the report as an HTML page, or as JSON (cortex.packDoctor v1) with a .json name">
                <FileDown aria-hidden="true" />
                {actions.saving ? "Saving…" : "Save report…"}
              </button>
            </div>
          </div>
        ) : null}
      </header>

      {scan.status === "error" ? (
        <div className="lv-pack-scroll custom-scrollbar">
          <div className="lv-pack-empty" role="alert">
            <p className="lv-pack-empty-title is-error">Couldn't read this folder</p>
            <p className="lv-pack-empty-hint" title={scan.error}>Cortex reads a folder you open for this session. Open it again to check it.</p>
            <button type="button" className="cx-btn lv-pack-btn" onClick={s.openVehicleFolder}>
              <FolderOpen aria-hidden="true" />
              Open folder…
            </button>
          </div>
        </div>
      ) : running || (doctor.listing && doctor.status !== "cancelled") ? (
        <div className="lv-pack-scroll custom-scrollbar">
          <div className="lv-doctor-run" role="status" aria-busy="true">
            <p className="lv-pack-state">
              <Loader2 className="lv-pack-spin" aria-hidden="true" />
              {running ? doctor.stage : "Listing the folder"}…
              {doctor.total ? <span className="lv-pack-figure">{doctor.done} / {doctor.total}</span> : null}
            </p>
            {progress != null ? (
              <div className="lv-doctor-bar" role="progressbar" aria-label={doctor.stage} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                <span style={{ width: `${progress}%` }} />
              </div>
            ) : null}
            <button type="button" className="cx-btn lv-pack-btn" onClick={doctor.cancel} disabled={doctor.stage === "Cancelling"}>Cancel</button>
          </div>
        </div>
      ) : !report ? (
        <div className="lv-pack-scroll custom-scrollbar">
          <div className="lv-pack-empty">
            <p className="lv-pack-empty-title">{doctor.status === "cancelled" ? "Check cancelled" : "Not checked yet"}</p>
            <p className="lv-pack-empty-hint">Pack Doctor reads the folder's meta, manifests and streamed file headers. It never changes a file.</p>
            <button type="button" className="cx-btn lv-pack-btn" onClick={doctor.run} disabled={scan.status !== "ready"}>
              <RefreshCw aria-hidden="true" />
              Check the folder
            </button>
          </div>
        </div>
      ) : (
        <div className={`lv-dr-layout ${hasSide ? "has-side" : ""}`}>
          <div className="lv-dr-main custom-scrollbar">
            <div className="lv-dr-bar">
              <div className="lv-dr-filters" role="group" aria-label="Show findings">
                {FILTERS.map((entry) => (
                  <button key={entry.id} type="button" className={`lv-dr-filter is-${entry.id} ${filter === entry.id ? "is-active" : ""}`}
                    aria-pressed={filter === entry.id} disabled={entry.id !== "all" && !counts[entry.id] && filter !== entry.id} onClick={() => setFilter(entry.id)}>
                    {entry.id !== "all" ? <span className="lv-doctor-dot" aria-hidden="true" /> : null}
                    {entry.label}
                    <span className="lv-dr-filter-num">{counts[entry.id]}</span>
                  </button>
                ))}
              </div>
              <div className="lv-dr-bar-tools">
                {resourceRows.length > 1 ? (
                  <Select value={resourceFilter} onValueChange={setResourceFilter}>
                    <SelectTrigger className="lv-dr-resource" aria-label="Resource">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_RESOURCES}>All resources</SelectItem>
                      {resourceRows.map((resource) => <SelectItem key={resource.path} value={resource.path}>{resource.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : null}
                {groups.length > 1 ? (
                  <button type="button" className="cx-btn is-quiet lv-pack-btn" onClick={() => setAllOpen(!allOpen)}>
                    {allOpen ? "Collapse all" : "Expand all"}
                  </button>
                ) : null}
                {forgePath ? <ForgeCheckButton path={forgePath} className="cx-btn lv-pack-btn" /> : null}
              </div>
            </div>

            <DoctorStatus status={actions.status} />
            {doctor.status === "cancelled" ? (
              <p className="lv-doctor-callout" role="status">Cancelled. What was read before you cancelled is below; the rest reads as not checked.</p>
            ) : null}

            {groups.length ? (
              <ul className="lv-dr-checks">
                {groups.map((group) => (
                  <CheckGroup key={group.key} group={group} open={openKeys.has(group.key)} onToggle={() => toggle(group.key)}
                    root={root} vehicleFor={vehicleFor} openVehicle={s.openFolderVehicle} />
                ))}
              </ul>
            ) : (
              <p className="lv-doctor-clear">
                <span className="lv-doctor-dot is-confirm" aria-hidden="true" />
                {emptyText}
              </p>
            )}

            <p className="lv-doctor-hint">
              Read on this PC. {report.scopeNote ? `${report.scopeNote} ` : ""}Pack Doctor changes nothing; Check in Forge compares a resource with what your server already runs.
            </p>
          </div>

          {hasSide ? (
            <aside className="lv-dr-side custom-scrollbar" aria-label="Pack details">
              {scopeName ? <p className="lv-dr-side-note lv-dr-side-scope">These cover the whole folder, not only {scopeName}.</p> : null}
              <MemoryList memory={report.memory} root={root} />
              {report.escrowed.length ? (
                <section className="lv-dr-side-group" aria-label="Escrowed, not checked">
                  <h3 className="cx-label lv-dr-side-head">
                    <span>Escrowed, not checked</span>
                    <span className="lv-dr-side-count">{report.escrowed.length}</span>
                  </h3>
                  <p className="lv-dr-side-note">These hold .fxap (Asset Escrow), so Pack Doctor does not read them.</p>
                  <ul className="lv-dr-plain">
                    {report.escrowed.map((entry) => <li key={entry.path} title={entry.path}><span className="lv-dr-plain-what">{entry.name}</span></li>)}
                  </ul>
                </section>
              ) : null}
              <SideNotChecked entries={report.notChecked} root={root} />
            </aside>
          ) : null}
        </div>
      )}
    </section>
  );
}
