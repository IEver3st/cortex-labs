import { useEffect, useMemo, useRef, useState } from "react";
import { Check, LoaderCircle, WandSparkles, X } from "lucide-react";
import { normalizeLightSwitches } from "../../lib/emergency-lights.js";
import { callJuno, useJunoSignedIn } from "../../lib/juno.js";
import {
  DISCARD_NOTE,
  JUNO_ASK_LIMIT,
  applySirenPattern,
  darkLightsNote,
  describeVehicle,
  flashRows,
  rotatingOnlyCount,
  sirenAsk,
} from "../../lib/juno-sirens.js";

function folderName(path) {
  return String(path || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

function settingKey(setting) {
  return JSON.stringify([setting?.sourcePath || "", setting?.id ?? "", setting?.name || "", setting?.sequencerBpm ?? "", setting?.sirens || []]);
}

const LIMIT_CODES = new Set(["client_daily_limit", "daily_limit", "usage_limit", "insufficient_credits", "rate_limited", "slow_down", "ai_busy"]);

function Note({ tone, children }) {
  return (
    <p className={`lv-slot-note is-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <span className="lv-dot" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

export default function JunoDescribe({ s, resource }) {
  const editor = s.sirenEditor;
  const draft = editor.draft;
  const signedIn = useJunoSignedIn(Boolean(s.isTauriRuntime));
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [note, setNote] = useState(null);
  const outcome = useRef(null);
  const currentKey = useRef("");
  const setTrial = s.setSirenTrial;
  const key = draft?.sirens?.length ? settingKey(draft) : "";
  currentKey.current = key;
  const preview = useMemo(
    () => (signedIn && result && result.key === key ? applySirenPattern(draft, result.answer) : null),
    [signedIn, draft, result, key],
  );

  useEffect(() => {
    setTrial?.(preview);
  }, [preview, setTrial]);
  useEffect(() => () => setTrial?.(null), [setTrial]);
  useEffect(() => {
    if (!result || preview || !signedIn) return;
    setResult(null);
    setNote({ tone: "idle", text: "The sirens changed, so the preview was dropped. Generate again for the new layout." });
  }, [result, preview, signedIn]);

  const shown = Boolean(result && preview);
  useEffect(() => {
    const box = outcome.current;
    const rail = box?.closest(".se-rail-scroll");
    if (!(shown || note) || !rail) return;
    const floor = rail.getBoundingClientRect().bottom;
    const over = box.getBoundingClientRect().bottom - floor;
    if (over > 0) rail.scrollBy({ top: over + 12 });
  }, [shown, note]);

  if (!signedIn || !draft?.sirens?.length) return null;

  const rows = flashRows(draft);
  const rotating = rotatingOnlyCount(draft);
  if (!rows.length) {
    return (
      <div className="se-rail-block se-juno">
        <span className="cx-label">Describe the lights</span>
        <Note tone="idle">Juno writes flash patterns; this setting has only rotating lights.</Note>
      </div>
    );
  }

  const generate = async () => {
    const text = ask.trim();
    if (!text || busy) return;
    const asked = key;
    const located = s.getSirenLocalPoints?.(draft.sirens) ?? null;
    const request = sirenAsk({
      setting: draft,
      located,
      vehicle: describeVehicle({ modelName: resource.modelName, entry: resource.vehicleEntry, resourceName: folderName(resource.root) }),
      ask: text,
    });
    setBusy(true);
    setNote(null);
    setResult(null);
    try {
      const answer = await callJuno("juno_siren_pattern", { request });
      if (currentKey.current !== asked) {
        setNote({ tone: "idle", text: "The siren setting changed while Juno was writing, so its pattern was dropped. Generate again for this setting." });
        return;
      }
      setResult({ answer, key: asked });
      const lights = s.vehicleLights || {};
      const switches = normalizeLightSwitches(lights.switches);
      const speed = Number.isFinite(lights.speed) ? lights.speed : 1;
      if (!switches.sirens || !(speed > 0)) s.updateVehicleLights({ switches: { ...switches, sirens: true }, speed: speed > 0 ? speed : 1 });
    } catch (error) {
      if (error.code === "unauthorized") s.showToast?.(error.message, "error");
      else setNote({ tone: LIMIT_CODES.has(error.code) ? "warn" : "error", text: error.message });
    } finally {
      setBusy(false);
    }
  };

  const keep = () => {
    if (!result) return;
    editor.edit((current) => applySirenPattern(current, result.answer) || current);
    setResult(null);
    setNote({ tone: "ok", text: "Kept. Undo takes it back; nothing is written until you save." });
  };

  const discard = () => {
    setResult(null);
    setNote({ tone: "idle", text: DISCARD_NOTE });
  };

  const dark = preview ? darkLightsNote(preview) : "";

  return (
    <div className="se-rail-block se-juno" role="group" aria-label="Describe the lights">
      <div className="se-rail-head">
        <label className="cx-label" htmlFor="se-juno-ask">Describe the lights</label>
        <span className="se-rail-meta">{ask.length}/{JUNO_ASK_LIMIT}</span>
      </div>
      <div className={`se-juno-field${ask.trim() && !busy ? " is-ready" : ""}${busy ? " is-busy" : ""}`}>
        <textarea id="se-juno-ask" className="se-juno-ask" rows={3} maxLength={JUNO_ASK_LIMIT} value={ask} disabled={busy}
          placeholder="Front takedowns steady white, roof reds left quad flash, blues right"
          onChange={(event) => setAsk(event.target.value.slice(0, JUNO_ASK_LIMIT))}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              generate();
            }
          }} />
        <div className="se-juno-actions">
          <span className="se-rail-meta">{rows.length} {rows.length === 1 ? "light" : "lights"}</span>
          <span className="se-juno-keys" aria-hidden="true">
            <kbd className="cx-keycap">Ctrl</kbd>
            <kbd className="cx-keycap">Enter</kbd>
          </span>
          <button type="button" className={`cx-btn se-juno-go${ask.trim() && !shown ? " is-primary" : ""}`} onClick={generate} disabled={!ask.trim() || busy}
            title={ask.trim() ? `Juno writes a pattern for ${rows.length} flashing ${rows.length === 1 ? "light" : "lights"} (Ctrl+Enter)` : "Describe the lights first"}>
            {busy ? <LoaderCircle className="se-juno-spin" aria-hidden="true" /> : <WandSparkles aria-hidden="true" />}
            {busy ? "Writing" : "Generate"}
          </button>
        </div>
      </div>
      <div ref={outcome} className="se-juno-outcome">
      {busy ? <Note tone="idle">Juno is writing the pattern…</Note> : null}
      {note ? <Note tone={note.tone}>{note.text}</Note> : null}
      {shown ? (
        <div className="se-juno-result" role="group" aria-label="Juno's pattern">
          <p className="se-juno-name">{result.answer.name || "Juno's pattern"}</p>
          {result.answer.why ? <p className="se-juno-why">{result.answer.why}</p> : null}
          <Note tone="live">Playing on the car. Nothing changes until you keep it.</Note>
          {rotating ? <Note tone="idle">{rotating} rotating {rotating === 1 ? "light" : "lights"} left as {rotating === 1 ? "it is" : "they are"}.</Note> : null}
          {dark ? <Note tone="idle">{dark}</Note> : null}
          <div className="se-rail-grid">
            <button type="button" className="cx-btn is-primary lv-btn-sm" onClick={keep} title="Apply the pattern to the setting as one undo step">
              <Check aria-hidden="true" />
              Keep
            </button>
            <button type="button" className="cx-btn lv-btn-sm" onClick={discard} title="Drop the preview; the setting stays as it was">
              <X aria-hidden="true" />
              Discard
            </button>
          </div>
        </div>
      ) : null}
      </div>
    </div>
  );
}
