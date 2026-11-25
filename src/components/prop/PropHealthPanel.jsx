import { useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { AlertTriangle, Check, Copy, FileCode2, FolderOpen, Info, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import { formatMiB } from "../../lib/pack-doctor.js";
import { formatPropHealthMarkdown } from "../../lib/prop-doctor.js";
import { formatScriptAuditMarkdown } from "../../lib/prop-script-audit.js";
import { formatVram, summarizeTextureVram } from "../../lib/texture-vram.js";
import { formatCount, formatLength, PROP_LOD_LABELS } from "../../lib/prop-studio.js";
import {
  YTYP_FLAG_PRESETS,
  buildArchetypeDef,
  buildPropFxManifest,
  renderYtypXml,
  sanitizeArchetypeName,
} from "../../lib/prop-ytyp.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { splitPath } from "../workspace/parts";

const SEVERITY_LABEL = { error: "Error", warn: "Warning", info: "Note" };

function formatCountSummary(counts) {
  const parts = [];
  if (counts?.error) parts.push(`${counts.error} ${counts.error === 1 ? "error" : "errors"}`);
  if (counts?.warn) parts.push(`${counts.warn} ${counts.warn === 1 ? "warning" : "warnings"}`);
  if (counts?.info) parts.push(`${counts.info} ${counts.info === 1 ? "note" : "notes"}`);
  return parts.join(" · ");
}

function copyText(text) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error("Clipboard is unavailable."));
}

export default function PropHealthPanel({
  prop,
  modelPath,
  load,
  dims,
  info,
  lods,
  materialGroups,
  modelLights,
  nativeStatus,
  textureMetas = [],
  health,
  collisionsStatus,
  hasVertexColors,
  siblingYtdName,
  folderScan = null,
  scriptAudit = null,
  scriptAuditBusy = false,
  onRunScriptAudit = null,
  isTauriRuntime,
  onOpenCollisions,
  onInspectBackface,
  onInspectUvs,
  onOpenMaterials,
  onOpenFolder,
  onNotify,
}) {
  const defaultStem = useMemo(() => sanitizeArchetypeName(modelPath), [modelPath]);
  const [ytypName, setYtypName] = useState(defaultStem);
  const [txdName, setTxdName] = useState(siblingYtdName || defaultStem);
  const [flagPreset, setFlagPreset] = useState("static");
  const [customLodDist, setCustomLodDist] = useState("");
  const [copiedKey, setCopiedKey] = useState("");
  const [saveError, setSaveError] = useState("");
  const copyTimerRef = useRef(null);

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  useEffect(() => {
    setYtypName(defaultStem);
    setTxdName(siblingYtdName || defaultStem);
    setCustomLodDist("");
    setSaveError("");
  }, [defaultStem, siblingYtdName]);

  const gtaBounds = health?.bounds || null;
  const archetype = useMemo(() => {
    const preset = YTYP_FLAG_PRESETS.find((item) => item.id === flagPreset) || YTYP_FLAG_PRESETS[0];
    const lodNum = Number(customLodDist);
    return buildArchetypeDef({
      name: ytypName || defaultStem,
      format: prop?.format || "ydr",
      gtaBounds,
      textureDictionary: txdName || defaultStem,
      lodDist: Number.isFinite(lodNum) && lodNum > 0 ? lodNum : null,
      flags: preset.flags,
    });
  }, [ytypName, defaultStem, prop?.format, gtaBounds, txdName, customLodDist, flagPreset]);

  const ytypXml = useMemo(
    () => renderYtypXml([archetype], { name: ytypName || defaultStem }),
    [archetype, ytypName, defaultStem],
  );

  const fxManifest = useMemo(
    () => buildPropFxManifest({ ytypName: ytypName || defaultStem }),
    [ytypName, defaultStem],
  );

  const handleCopy = async (key, text, label) => {
    try {
      await copyText(text);
      setSaveError("");
      setCopiedKey(key);
      onNotify?.(`Copied ${label}`);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopiedKey((current) => (current === key ? "" : current));
      }, 1800);
    } catch (error) {
      setSaveError(error?.message ? `${error.message} Click inside the window and try again.` : "Couldn't write to the clipboard — click inside the window and try again.");
    }
  };

  const handleSaveYtyp = async () => {
    if (!isTauriRuntime) return;
    setSaveError("");
    try {
      const target = await save({
        defaultPath: `${sanitizeArchetypeName(ytypName || defaultStem)}.ytyp.xml`,
        filters: [{ name: "CodeWalker YTYP XML", extensions: ["xml"] }],
        title: "Save .ytyp.xml",
      });
      if (!target) return;
      await writeFile(target, new TextEncoder().encode(ytypXml));
      onNotify?.(`Saved ${splitPath(target).name}`);
    } catch (error) {
      setSaveError(error?.message || String(error));
    }
  };

  const counts = health?.counts || { error: 0, warn: 0, info: 0 };
  const totalIssues = counts.error + counts.warn + counts.info;
  const findings = health?.findings || [];
  const memFiles = health?.memory?.files || [];
  const maxDim = dims ? Math.max(dims.x, dims.y, dims.z) : 1;
  const vram = useMemo(
    () => summarizeTextureVram(textureMetas, { smallProp: maxDim > 0 && maxDim < 0.6 }),
    [textureMetas, maxDim],
  );
  const FORMAT_NAMES = { ydr: "Drawable", ydd: "Drawable dictionary", yft: "Fragment", glb: "glTF binary", gltf: "glTF" };

  return (
    <>
      <section className="lv-group">
        <div className="lv-group-head">
          <h3 className="lv-group-title">Prop Doctor</h3>
          <button
            type="button"
            className="lv-link"
            onClick={() => handleCopy("qa", formatPropHealthMarkdown(health), "QA report")}
            title="Copy Markdown QA report (ready to paste into notes or team chat)"
          >
            {copiedKey === "qa" ? "Copied" : "Copy report"}
          </button>
        </div>

        <div className={`ps-qa-summary ${counts.error ? "is-error" : counts.warn ? "is-warn" : "is-ok"}`}>
          <span className="ps-qa-summary-lead">
            {counts.error ? <ShieldAlert aria-hidden="true" /> : counts.warn ? <AlertTriangle aria-hidden="true" /> : <Check aria-hidden="true" />}
            <strong>
              {totalIssues === 0 ? "All checks passed" : formatCountSummary(counts)}
            </strong>
          </span>
          {collisionsStatus === "idle" || collisionsStatus === "loading" ? (
            <span className="ps-qa-summary-sub">Checking collisions…</span>
          ) : null}
        </div>

        {findings.length > 0 ? (
          <ul className="ps-qa-list">
            {findings.map((finding, index) => (
              <li key={`${finding.code}-${index}`} className={`ps-qa-item is-${finding.severity}`}>
                <div className="ps-qa-head">
                  <span className="ps-qa-dot" aria-hidden="true" />
                  <span className="ps-qa-sev">{SEVERITY_LABEL[finding.severity] || "Note"}</span>
                  <span className="ps-qa-code">{finding.code}</span>
                </div>
                <p className="ps-qa-msg">{finding.message}</p>
                {finding.fix ? <p className="ps-qa-fix">{finding.fix}</p> : null}
                {finding.area === "collisions" && collisionsStatus === "ready" && onOpenCollisions ? (
                  <button type="button" className="lv-link ps-qa-act" onClick={onOpenCollisions}>
                    Show collisions in viewport
                  </button>
                ) : null}
                {finding.code === "PROP_INVERTED_WINDING" && onInspectBackface ? (
                  <button type="button" className="lv-link ps-qa-act" onClick={onInspectBackface}>
                    Switch to Backface view
                  </button>
                ) : null}
                {finding.code === "PROP_MISSING_UVS" && onInspectUvs ? (
                  <button type="button" className="lv-link ps-qa-act" onClick={onInspectUvs}>
                    Switch to UV check view
                  </button>
                ) : null}
                {finding.area === "textures" && onOpenMaterials ? (
                  <button type="button" className="lv-link ps-qa-act" onClick={onOpenMaterials}>
                    Inspect materials
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {memFiles.length > 0 ? (
          <div className="ps-mem-box">
            <span className="cx-label">Streamed memory (RSC7)</span>
            <dl className="ps-facts">
              {memFiles.map((file) => (
                <div key={file.path}>
                  <dt title={file.path}>{splitPath(file.path).name}</dt>
                  <dd>
                    {file.checked
                      ? `${formatMiB(file.physical)} MiB GPU · ${formatMiB(file.virtual)} MiB RAM`
                      : file.reason || "Unread"}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}

        {vram.count > 0 ? (
          <div className="ps-mem-box">
            <div className="lv-group-head">
              <span className="cx-label">Texture VRAM ({vram.count})</span>
              <span className="ps-row-meta">{formatVram(vram.totalBytes)}</span>
            </div>
            <ul className="ps-vram-list">
              {vram.items.slice(0, 12).map((tex) => (
                <li key={`${tex.name}-${tex.path}`} className={tex.flags.length ? "is-flagged" : ""}>
                  <span className="ps-vram-name" title={tex.path || tex.name}>{tex.name}</span>
                  <span className="ps-vram-meta">
                    {tex.width}×{tex.height} · {tex.format} · {formatVram(tex.vramBytes)}
                    {tex.flags.length ? ` · ${tex.flags.join(", ")}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {folderScan && folderScan.models?.length > 0 ? (
        <section className="lv-group">
          <div className="lv-group-head">
            <h3 className="lv-group-title">Script audit</h3>
            <div className="ps-head-acts">
              {scriptAudit ? (
                <button
                  type="button"
                  className="lv-link"
                  onClick={() => handleCopy("script", formatScriptAuditMarkdown(scriptAudit), "script audit")}
                >
                  {copiedKey === "script" ? "Copied" : "Copy report"}
                </button>
              ) : null}
              <button
                type="button"
                className="lv-link"
                disabled={scriptAuditBusy || !onRunScriptAudit}
                onClick={onRunScriptAudit}
              >
                {scriptAuditBusy ? "Auditing…" : scriptAudit ? "Re-run" : `Audit ${folderScan.models.length} models`}
              </button>
            </div>
          </div>
          {scriptAuditBusy ? (
            <p className="lv-slot-note is-idle">
              <Loader2 className="ps-spin ps-inline-icon" aria-hidden="true" />
              <span>Scanning fxmanifest, .ytyp.xml and RSC7 sizes…</span>
            </p>
          ) : scriptAudit ? (
            <>
              <div className={`ps-qa-summary ${scriptAudit.counts.error ? "is-error" : scriptAudit.counts.warn ? "is-warn" : "is-ok"}`}>
                <span className="ps-qa-summary-lead">
                  {scriptAudit.counts.error ? <ShieldAlert aria-hidden="true" /> : scriptAudit.counts.warn ? <AlertTriangle aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
                  <strong>
                    {scriptAudit.findings.length === 0
                      ? `${scriptAudit.label}: all checks passed`
                      : formatCountSummary(scriptAudit.counts)}
                  </strong>
                </span>
                <span className="ps-qa-summary-sub">
                  {scriptAudit.modelCount} models · {formatMiB(scriptAudit.totalPhysical)} MiB GPU · {formatMiB(scriptAudit.totalVirtual)} MiB RAM
                </span>
              </div>
              {scriptAudit.findings.length > 0 ? (
                <ul className="ps-qa-list">
                  {scriptAudit.findings.map((finding, idx) => (
                    <li key={`${finding.code}-${idx}`} className={`ps-qa-item is-${finding.severity}`}>
                      <div className="ps-qa-head">
                        <span className="ps-qa-dot" aria-hidden="true" />
                        <span className="ps-qa-sev">{SEVERITY_LABEL[finding.severity] || "Note"}</span>
                        <span className="ps-qa-code">{finding.code}</span>
                      </div>
                      <p className="ps-qa-msg">{finding.message}</p>
                      {finding.fix ? <p className="ps-qa-fix">{finding.fix}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className="lv-slot-note">
              Checks fxmanifest.lua <code>DLC_ITYP_REQUEST</code>, missing/orphan <code>.ytyp.xml</code> entries, and 16 MiB RSC7 limits across <strong>{folderScan.label}</strong>.
            </p>
          )}
        </section>
      ) : null}

      <section className="lv-group">
        <div className="lv-group-head">
          <h3 className="lv-group-title">.ytyp generator</h3>
          <span className="ps-row-meta">bsRadius {archetype.bsRadius.toFixed(3)} m</span>
        </div>
        <div className="ps-ytyp-grid">
          <label className="lv-field">
            <span className="cx-label">Archetype name</span>
            <input
              type="text"
              className="ps-input"
              value={ytypName}
              spellCheck={false}
              onChange={(event) => setYtypName(event.target.value)}
            />
          </label>
          <label className="lv-field">
            <span className="cx-label">Texture dictionary</span>
            <input
              type="text"
              className="ps-input"
              value={txdName}
              spellCheck={false}
              onChange={(event) => setTxdName(event.target.value)}
            />
          </label>
          <div className="lv-field">
            <span className="cx-label">Flags</span>
            <Select value={flagPreset} onValueChange={setFlagPreset}>
              <SelectTrigger aria-label="Archetype flags"><SelectValue /></SelectTrigger>
              <SelectContent>
                {YTYP_FLAG_PRESETS.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>{preset.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="lv-field">
            <span className="cx-label">LOD distance (m)</span>
            <input
              type="number"
              className="ps-input"
              min={5}
              max={1000}
              step={5}
              placeholder={String(archetype.lodDist)}
              value={customLodDist}
              onChange={(event) => setCustomLodDist(event.target.value)}
            />
          </label>
        </div>
        <pre className="ps-code" aria-label="Generated .ytyp.xml preview">
          {`bbMin: (${archetype.bbMin.map((v) => v.toFixed(3)).join(", ")})\nbbMax: (${archetype.bbMax.map((v) => v.toFixed(3)).join(", ")})\nbsCentre: (${archetype.bsCentre.map((v) => v.toFixed(3)).join(", ")})  r=${archetype.bsRadius.toFixed(3)}\nlodDist: ${archetype.lodDist}  hdTextureDist: ${archetype.hdTextureDist}  flags: ${archetype.flags}`}
        </pre>
        <div className="ps-btn-row">
          <button type="button" className="cx-btn" onClick={() => handleCopy("ytyp", ytypXml, ".ytyp.xml")}>
            {copiedKey === "ytyp" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            Copy XML
          </button>
          <button type="button" className="cx-btn" onClick={handleSaveYtyp} disabled={!isTauriRuntime}>
            <FileCode2 aria-hidden="true" />
            Save .ytyp.xml…
          </button>
          <button type="button" className="cx-btn is-quiet" onClick={() => handleCopy("fx", fxManifest, "fxmanifest.lua")}>
            {copiedKey === "fx" ? <Check aria-hidden="true" /> : <Info aria-hidden="true" />}
            fxmanifest
          </button>
        </div>
        {saveError ? <p className="lv-slot-note is-error"><span className="lv-dot" aria-hidden="true" /><span>{saveError}</span></p> : null}
      </section>

      <section className="lv-group">
        <h3 className="lv-group-title">Model facts</h3>
        <dl className="ps-facts">
          <div><dt>Format</dt><dd>.{prop.format} · {FORMAT_NAMES[prop.format] || prop.format}</dd></div>
          <div><dt>Read by</dt><dd>{load.parser === "bridge" ? `CodeWalker bridge${load.cached ? " (cached)" : ""}` : "Built-in parser"}</dd></div>
          {dims ? (
            <div><dt>Size (GTA)</dt><dd>{formatLength(dims.x)} × {formatLength(dims.y)} × {formatLength(dims.z)}</dd></div>
          ) : null}
          {info.stats ? (
            <>
              <div><dt>Meshes shown</dt><dd>{formatCount(info.stats.meshes)} of {formatCount(info.stats.totalMeshes)}</dd></div>
              <div><dt>Vertices</dt><dd>{formatCount(info.stats.vertices)}</dd></div>
              <div><dt>Triangles</dt><dd>{formatCount(info.stats.triangles)}</dd></div>
            </>
          ) : null}
          <div><dt>Drawables</dt><dd>{formatCount(Math.max(prop.drawables.length, 1))}</dd></div>
          <div><dt>LODs</dt><dd>{lods.length ? lods.map((lod) => PROP_LOD_LABELS[lod]).join(", ") : "–"}</dd></div>
          <div><dt>Materials</dt><dd>{formatCount(materialGroups.length)}</dd></div>
          <div><dt>Vertex colours</dt><dd>{hasVertexColors ? "Present" : "None"}</dd></div>
          <div><dt>Lights</dt><dd>{formatCount(modelLights.length)}</dd></div>
          {nativeStatus.state === "ready" ? (
            <div><dt>Textures</dt><dd>{nativeStatus.loaded} loaded{nativeStatus.missing ? `, ${nativeStatus.missing} not found` : ""}{nativeStatus.failed ? `, ${nativeStatus.failed} failed` : ""}</dd></div>
          ) : null}
        </dl>
        {nativeStatus.failures?.length ? (
          <ul className="ps-failures">
            {nativeStatus.failures.slice(0, 6).map((failure) => (
              <li key={failure.path} title={failure.message}>
                <code>{splitPath(failure.path).name}</code> {failure.message}
              </li>
            ))}
          </ul>
        ) : null}
        <button type="button" className="lv-link ps-open-folder" onClick={onOpenFolder}>
          <FolderOpen className="ps-inline-icon" aria-hidden="true" />
          Open the model&apos;s folder
        </button>
      </section>
    </>
  );
}
