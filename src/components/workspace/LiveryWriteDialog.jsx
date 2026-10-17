import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ToolDialog, StatusLines } from "../siren-editor/SirenToolDialogs";
import { buildLiveryTextures } from "../../lib/livery-image.js";
import { canWriteLiveries, fileNameOf } from "../../lib/livery-set.js";
import { writeLiveries } from "../../lib/livery-write.js";
import "../siren-editor/SirenEditor.css";
import "./LiveriesPanel.css";

/* Confirms and runs a livery write: which of the vehicle's texture
   dictionaries change, how many textures each gains or replaces and at what
   size, and the checks that need the user's eye. The write stages every
   texture, then the host rebuilds the dictionaries and replaces them after a
   backup, all or nothing. Stopping before that last step changes nothing. */

function joinList(items) {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function liveryWord(count) {
  return `${count} ${count === 1 ? "livery" : "liveries"}`;
}

function textureCounts(file) {
  return [file.added ? `${file.added} new` : "", file.replaced ? `${file.replaced} replaced` : ""].filter(Boolean).join(", ");
}

// "4096", or "4096 × 2048", for each size the file's textures take.
function sizeText(file) {
  const sizes = [...new Set(file.textures.map((texture) => (texture.width === texture.height ? `${texture.width}` : `${texture.width} × ${texture.height}`)))];
  const levels = [...new Set(file.textures.map((texture) => texture.levels))];
  const mips = levels.length === 1 && levels[0] === 1 ? "no mips" : "mips";
  return `${sizes.join(", ")} · ${mips}`;
}

const TONES = { confirm: "is-confirm", caution: "is-caution", destructive: "is-destructive" };

export default function LiveryWriteDialog({ s, plan: livePlan, items: liveItems, onClose, onWritten }) {
  // The write runs on the plan as it was when it started; the panel's plan
  // empties once the staged images are written.
  const [run, setRun] = useState({ phase: "ready", plan: null, items: null, progress: null, lines: [] });
  const cancelled = useRef(false);
  const plan = run.plan || livePlan;
  const items = run.items || liveItems;
  const busy = run.phase === "building" || run.phase === "writing";
  const done = run.phase === "done";
  const ready = canWriteLiveries(livePlan);
  const count = items.length;

  const write = useCallback(async () => {
    if (!canWriteLiveries(livePlan) || busy) return;
    cancelled.current = false;
    const frozen = { plan: livePlan, items: liveItems };
    setRun({ phase: "building", ...frozen, progress: null, lines: [] });
    let result;
    try {
      result = await writeLiveries({
        invoke,
        plan: livePlan,
        items: liveItems,
        modelPath: s.modelPath,
        build: (item, targets) => buildLiveryTextures(item.path, targets),
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
    const files = (result?.files || []).map((file) => String(file.path));
    setRun({
      phase: "done",
      ...frozen,
      progress: null,
      lines: [{ tone: "ok", text: `Wrote ${liveryWord(liveItems.length)}; each file has a .bak beside it`, path: files.join("\n") }],
    });
    try {
      await onWritten();
    } catch (error) {
      console.warn("[liveries] Reloading after the write failed:", error);
    }
  }, [busy, liveItems, livePlan, onWritten, s.modelPath]);

  const progress = run.progress;
  const keepsSizes = plan.files.some((file) => file.replaced || file.textures.some((texture) => texture.like));
  const disabledReason = done || busy ? "" : plan.blocked || (!ready ? "Reading the images…" : "");
  const status = run.phase === "building" && progress
    ? `Preparing ${fileNameOf(progress.label)} (${progress.item} of ${progress.items})`
    : run.phase === "building" ? "Starting the write…"
      : run.phase === "writing" ? `Writing ${joinList(plan.files.map((file) => file.name))}…` : "";

  return (
    <ToolDialog title="Write liveries" titleId="lv-liv-write-title" busy={busy} onClose={onClose}>
      <div className="se-dialog-body">
        <p className="se-note">
          {`Writes ${liveryWord(count)} into ${fileNameOf(s.modelPath)}'s own texture ${plan.files.length === 1 ? "dictionary" : "dictionaries"}, so the game shows ${count === 1 ? "it" : "them"} as liveries.`}
        </p>

        {plan.files.length ? (
          <table className="lv-liv-plan">
            <thead>
              <tr>
                <th scope="col">Writes to</th>
                <th scope="col">Textures</th>
                <th scope="col">Size</th>
              </tr>
            </thead>
            <tbody>
              {plan.files.map((file) => (
                <tr key={file.path}>
                  <td className="lv-liv-plan-file" title={file.path}>{file.name}</td>
                  <td>{textureCounts(file)}</td>
                  <td className="lv-liv-plan-size">{file.textures.every((texture) => texture.width) ? sizeText(file) : "…"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {plan.files.length && !done ? (
          <p className="se-note">
            {keepsSizes ? "Each file keeps the size its liveries already use, so your images are scaled to fit. " : ""}
            Images are written as DXT5; a DDS already at that size goes in as it is.
          </p>
        ) : null}

        {plan.checks.length && !done ? (
          <section className="lv-liv-checks" aria-labelledby="lv-liv-checks-title">
            <h3 id="lv-liv-checks-title" className="cx-label">Checks</h3>
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
        {done ? null : <p className="se-note">If you bought or downloaded this vehicle, its licence decides whether you may change it.</p>}
        {done ? <p className="se-note">Restart the resource in game to load the new liveries. Each .bak holds the file as it was.</p> : null}
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
            <p className="lv-liv-backup">Each .ytd gets a dated .bak copy first.</p>
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
              {busy ? "Writing…" : run.phase === "error" ? "Try again" : `Write ${liveryWord(count)}`}
            </button>
          )}
        </div>
      </footer>
    </ToolDialog>
  );
}
