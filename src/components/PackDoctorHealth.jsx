import { useEffect, useMemo, useState } from "react";
import { ClipboardCopy, FileDown, RefreshCw } from "lucide-react";
import { formatMiB } from "../lib/pack-doctor.js";
import ForgeCheckButton from "./siren-editor/ForgeCheck";
import { DoctorFinding, DoctorNotChecked, DoctorStatus } from "./workspace/DoctorSheet";
import useDoctorReport, { doctorGenerator } from "./workspace/useDoctorReport";
import { ownDictionaryNames, parentDictionaryNames, readParentDictionaries, readVehicleDoctorData, vehicleDoctorReport } from "./workspace/useVehicleDoctor";
import "./workspace/DoctorSheet.css";
import "./PackDoctorHealth.css";

const fileName = (path) => String(path || "").split(/[\\/]/).pop() || "";
const folderOf = (path) => String(path || "").replace(/[\\/][^\\/]*$/, "");

function useVehicleDoctorData(modelPath, isTauriRuntime, revision) {
  const [data, setData] = useState({ path: "", status: "idle" });
  useEffect(() => {
    if (!isTauriRuntime || !modelPath) {
      setData({ path: modelPath, status: "unavailable" });
      return undefined;
    }
    let cancelled = false;
    setData({ path: modelPath, status: "checking" });
    readVehicleDoctorData(modelPath).then((read) => {
      if (!cancelled) setData({ path: modelPath, status: "ready", ...read });
    });
    return () => { cancelled = true; };
  }, [modelPath, isTauriRuntime, revision]);
  return data.path === modelPath ? data : { path: modelPath, status: isTauriRuntime && modelPath ? "checking" : "unavailable" };
}

function useParentDictionaries(modelPath, parentChain, ownDictionaries, enabled) {
  const [parents, setParents] = useState({ key: "", list: [] });
  const wanted = parentDictionaryNames(parentChain);
  const own = ownDictionaryNames(ownDictionaries);
  const key = enabled && wanted.length ? JSON.stringify([modelPath, wanted, own]) : "";
  useEffect(() => {
    if (!key) {
      setParents({ key, list: [] });
      return undefined;
    }
    let cancelled = false;
    const [path, names, dictionaries] = JSON.parse(key);
    readParentDictionaries(path, names, dictionaries).then((list) => {
      if (!cancelled) setParents({ key, list });
    });
    return () => { cancelled = true; };
  }, [key]);
  return parents.key === key ? parents.list : [];
}

export default function PackDoctorHealth({ modelPath, isTauriRuntime, revision = 0, scan, sim, modelInfo, meshStats, onCountGeometry, onRecheck }) {
  const data = useVehicleDoctorData(modelPath, isTauriRuntime, revision);
  const metaReady = scan?.status === "ready" && scan.path === modelPath;
  const parents = useParentDictionaries(modelPath, sim?.txd?.parentChain, data.dictionaries, data.status === "ready" && metaReady);
  const [generator, setGenerator] = useState("Cortex Studio");
  useEffect(() => { doctorGenerator().then(setGenerator); }, []);

  const report = useMemo(() => {
    if (data.status !== "ready" || !metaReady) return null;
    return vehicleDoctorReport({ modelPath, scan, sim, modelInfo, data, parents, meshStats, generator });
  }, [data, metaReady, modelPath, scan, sim, modelInfo, parents, meshStats, generator]);

  const actions = useDoctorReport(report);
  if (data.status === "unavailable") {
    return (
      <section className="mp-section pd-health">
        <header className="mp-section-head"><h3 className="mp-section-title">Health</h3></header>
        <p className="mp-muted">{isTauriRuntime ? "Open a vehicle model to check it." : "Health checks need the desktop app."}</p>
      </section>
    );
  }

  const checking = !report;
  const shown = report ? report.findings.filter((finding) => finding.area !== "meta") : [];
  const toFix = shown.filter((finding) => finding.severity !== "info").length;
  const metaCount = report ? report.findings.length - shown.length : 0;
  const memory = report?.memory?.files || [];
  const rootOf = report?.root || folderOf(modelPath);

  return (
    <section className="mp-section pd-health" aria-busy={checking}>
      <header className="mp-section-head">
        <h3 className="mp-section-title">Health</h3>
        {checking ? <span className="mp-count">Checking…</span> : toFix ? <span className="mp-status is-warn">{toFix} to review</span> : null}
        <button type="button" className="cx-icon-btn mp-rescan" onClick={onRecheck} disabled={checking || !onRecheck}
          aria-label="Check the vehicle again" title="Check the vehicle again">
          <RefreshCw aria-hidden="true" className={checking ? "is-spinning" : undefined} />
        </button>
      </header>

      {report ? (
        <>
          {shown.length ? (
            <ul className="lv-doctor-list pd-list">
              {shown.map((finding, index) => <DoctorFinding key={`${finding.code}-${index}`} finding={finding} root={rootOf} />)}
            </ul>
          ) : (
            <p className="mp-clear">
              <span className="mp-clear-dot" aria-hidden="true" />
              {report.notChecked.length ? "No texture or memory problems in what was checked." : "No texture or memory problems."}
            </p>
          )}

          <dl className="mp-facts pd-facts">
            {report.facts.map((fact) => (
              <div key={fact.label} className="mp-fact"><dt>{fact.label}</dt><dd>{fact.value}</dd></div>
            ))}
            {memory.map((file) => (
              <div key={file.path} className="mp-fact pd-memory-row" title={file.path}>
                <dt className="pd-file">{fileName(file.path)}</dt>
                <dd className="mp-mono">{formatMiB(file.physical)} / {formatMiB(file.virtual)} MiB</dd>
              </div>
            ))}
          </dl>
          {memory.length ? <p className="mp-muted pd-legend">Streamed memory as FiveM counts it: physical (graphics) / virtual (system). FiveM notes files above 16 MiB and warns about oversized ones above 48 MiB.</p> : null}
          {!meshStats && onCountGeometry ? (
            <button type="button" className="mp-link" onClick={onCountGeometry} title="Turns on Solid wireframe, which counts what the viewer draws">
              Count triangles and textures
            </button>
          ) : null}

          {report.notChecked.length ? <DoctorNotChecked entries={report.notChecked} root={rootOf} /> : null}
          {metaCount ? <p className="mp-muted">The report also lists the {metaCount} meta {metaCount === 1 ? "check" : "checks"} above.</p> : null}

          <div className="pd-actions">
            <button type="button" className="cx-btn lv-btn-sm" onClick={actions.copy} title="Copy the report as Markdown for a forum or Discord post">
              <ClipboardCopy aria-hidden="true" />
              Copy report
            </button>
            <button type="button" className="cx-btn lv-btn-sm" onClick={actions.saveReport} disabled={actions.saving}
              title="Save the report as an HTML page, or as JSON (cortex.packDoctor v1) with a .json name">
              <FileDown aria-hidden="true" />
              {actions.saving ? "Saving…" : "Save report…"}
            </button>
            <ForgeCheckButton path={modelPath} enabled={Boolean(isTauriRuntime && modelPath)} />
          </div>
          <DoctorStatus status={actions.status} />
        </>
      ) : (
        <p className="mp-muted" role="status">Reading the vehicle's texture dictionaries and file headers…</p>
      )}
    </section>
  );
}
