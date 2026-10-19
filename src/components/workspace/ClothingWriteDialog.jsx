import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ToolDialog, StatusLines } from "../siren-editor/SirenToolDialogs";
import { buildLiveryTextures } from "../../lib/livery-image.js";
import { canWriteClothingTextures, fileNameOf } from "../../lib/clothing-pack.js";
import { writeClothingTextures } from "../../lib/clothing-write.js";
import "../siren-editor/SirenEditor.css";
import "./LiveriesPanel.css";

/* Confirms and runs a clothing texture write: which texture files change or
   are added beside the item, at what size, how the pack's .ymt counts them,
   and the checks that need the user's eye. The write stages every texture,
   then the host builds the files and the .ymt, adds the new files and replaces
   the rest after a backup, all or nothing. Stopping before that changes nothing. */

function joinList(items) {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const textureWord = (count) => `${count} ${count === 1 ? "texture" : "textures"}`;

function sizeText(file) {
  const [texture] = file.textures;
  if (!texture?.width) return "…";
  const size = texture.width === texture.height ? `${texture.width}` : `${texture.width} × ${texture.height}`;
  return `${size} · ${texture.levels === 1 ? "no mips" : "mips"}`;
}

const TONES = { confirm: "is-confirm", caution: "is-caution", destructive: "is-destructive" };

export default function ClothingWriteDialog({ s, plan: livePlan, items: liveItems, onClose, onWritten }) {
  // The write runs on the plan as it was when it started; the panel's plan
  // empties once the staged images are written.
  const [run, setRun] = useState({ phase: "ready", plan: null, items: null, progress: null, lines: [] });
  const cancelled = useRef(false);
  const plan = run.plan || livePlan;
  const busy = run.phase === "building" || run.phase === "writing";
  const done = run.phase === "done";
  const ready = canWriteClothingTextures(livePlan);
  const replaced = plan.files.filter((file) => file.mode === "replace");
  const created = plan.files.filter((file) => file.mode === "create");
  const item = fileNameOf(s.modelPath);

  const write = useCallback(async () => {
    if (!canWriteClothingTextures(livePlan) || busy) return;
    cancelled.current = false;
    const frozen = { plan: livePlan, items: liveItems };
    setRun({ phase: "building", ...frozen, progress: null, lines: [] });
    let result;
    try {
      result = await writeClothingTextures({
        invoke,
        plan: livePlan,
        items: liveItems,
        drawablePath: s.modelPath,
        build: (entry, targets) => buildLiveryTextures(entry.path, targets),
        isCancelled: () => cancelled.current,
        onProgress: (progress) => setRun((current) => ({
          ...current,
          phase: progress.done === progress.total ? "writing" : "building",
          progress,
        })),
      });
    } catch (error) {
      setRun({ phase: "error", plan: null, items: null, progress: null, lines: [{ tone: "error", text: String(error?.message || error) }] });
      return;
    }
    // The files are written from here on, so a failed reload must not read as a failed write.
    const added = (result?.created || []).map(String);
    const changed = (result?.replaced || []).map((file) => String(file.path));
    const lines = [];
    if (changed.length) lines.push({ tone: "ok", text: `Replaced ${changed.length === 1 ? "1 file" : `${changed.length} files`}; each has a .bak beside it`, path: changed.join("\n") });
    if (added.length) lines.push({ tone: "ok", text: `Added ${added.length === 1 ? "1 texture file" : `${added.length} texture files`}`, path: added.join("\n") });
    setRun({ phase: "done", ...frozen, progress: null, lines });
    try {
      await onWritten();
    } catch (error) {
      console.warn("[clothing] Reloading after the write failed:", error);
    }
  }, [busy, liveItems, livePlan, onWritten, s.modelPath]);

  const progress = run.progress;
  const disabledReason = done || busy ? "" : plan.blocked || (!ready ? "Reading the images…" : "");
  const status = run.phase === "building" && progress
    ? `Preparing ${fileNameOf(progress.label)} (${progress.item} of ${progress.items})`
    : run.phase === "building" ? "Starting the write…"
      : run.phase === "writing" ? `Writing ${joinList([...plan.files.map((file) => file.name), ...(plan.ymt ? [plan.ymt.name] : [])])}…` : "";
  const summary = [
    replaced.length ? `replaces ${replaced.length === 1 ? "texture" : "textures"} ${joinList(replaced.map((file) => file.letter))}` : "",
    created.length ? `adds ${joinList(created.map((file) => file.letter))} as new texture ${created.length === 1 ? "file" : "files"}` : "",
  ].filter(Boolean).join(" and ");

  return (
    <ToolDialog title="Write textures" titleId="lv-clothing-write-title" busy={busy} onClose={onClose}>
      <div className="se-dialog-body">
        {summary ? <p className="se-note">{`Writes ${textureWord(plan.files.length)} for ${item}: ${summary}.`}</p> : null}

        {plan.files.length ? (
          <table className="lv-liv-plan">
            <thead>
              <tr>
                <th scope="col">Writes to</th>
                <th scope="col">Change</th>
                <th scope="col">Size</th>
              </tr>
            </thead>
            <tbody>
              {plan.files.map((file) => (
                <tr key={file.path}>
                  <td className="lv-liv-plan-file" title={file.path}>{file.name}</td>
                  <td>{file.mode === "create" ? "new file" : "replaced"}</td>
                  <td className="lv-liv-plan-size">{sizeText(file)}</td>
                </tr>
              ))}
              {plan.ymt ? (
                <tr>
                  <td className="lv-liv-plan-file" title={plan.ymt.path}>{plan.ymt.name}</td>
                  <td>{`counts ${plan.ymt.before} → ${plan.ymt.after}`}</td>
                  <td className="lv-liv-plan-size" />
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
        {plan.files.length && !done ? (
          <p className="se-note">
            {created.length ? `New textures start as a copy of ${fileNameOf(created[0].template)} and take its size. ` : ""}
            Images are scaled to the size each texture already uses and written as DXT5.
          </p>
        ) : null}

        {plan.checks.length && !done ? (
          <section className="lv-liv-checks" aria-labelledby="lv-clothing-checks-title">
            <h3 id="lv-clothing-checks-title" className="cx-label">Checks</h3>
            <ul>
              {plan.checks.map((check) => (
                <li key={check.text} className={TONES[check.tone] || ""}>
                  <span className="lv-dot" aria-hidden="true" />
                  <span>{check.text}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {plan.blocked && !busy && !done ? <p className="se-note is-error">{plan.blocked}</p> : null}
        {done ? null : <p className="se-note">If you bought or downloaded this clothing, its licence decides whether you may change it.</p>}
        {done ? <p className="se-note">Restart the resource in game to load the changed textures. Each .bak holds the file as it was.</p> : null}
      </div>
      <footer className="se-dialog-foot is-row">
        <div className="se-dialog-foot-status">
          <StatusLines lines={run.lines} />
          {status ? (
            <div className="lv-liv-progress" role="status">
              <p className="lv-slot-note is-busy"><span>{status}</span></p>
              {progress?.total ? (
                <div className="lv-progress" aria-hidden="true">
                  <span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
                </div>
              ) : null}
            </div>
          ) : null}
          {!busy && !done && !run.lines.length ? (
            <p className="lv-liv-backup">{plan.ymt ? "Replaced files and the .ymt get a dated .bak copy first." : "Each replaced .ytd gets a dated .bak copy first."}</p>
          ) : null}
          {disabledReason && run.phase === "ready" ? <p className="se-note">{disabledReason}</p> : null}
        </div>
        <div className="se-dialog-actions">
          {run.phase === "building" ? (
            <button type="button" className="settings-secondary" disabled={run.stopping}
              onClick={() => {
                cancelled.current = true;
                setRun((current) => ({ ...current, stopping: true }));
              }}>
              {run.stopping ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <button type="button" className="settings-secondary" onClick={onClose} disabled={busy}>{done ? "Close" : "Cancel"}</button>
          )}
          {done ? null : (
            <button type="button" className="settings-primary" onClick={write} disabled={Boolean(disabledReason) || busy || !ready}
              title={disabledReason || `Write into ${joinList(livePlan.files.map((file) => file.name))}`}>
              {busy ? "Writing…" : run.phase === "error" ? "Try again" : `Write ${textureWord(livePlan.files.length)}`}
            </button>
          )}
        </div>
      </footer>
    </ToolDialog>
  );
}
