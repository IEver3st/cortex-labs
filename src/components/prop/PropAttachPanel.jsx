import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ClipboardPaste, Copy, Loader2, RotateCcw } from "lucide-react";
import {
  ATTACH_POSES,
  ATTACH_SNIPPET_FORMATS,
  PROP_ATTACH_BONES,
  formatAttachSnippet,
  parseAttachSnippet,
} from "../../lib/prop-attach.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle } from "../ui/toggle";
import { Slider } from "../workspace/parts";

const CUSTOM_BONE_VALUE = "__custom__";

const POS_AXES = [
  { index: 0, label: "Offset X", short: "X" },
  { index: 1, label: "Offset Y", short: "Y" },
  { index: 2, label: "Offset Z", short: "Z" },
];

const ROT_AXES = [
  { index: 0, label: "Rot X", short: "RX" },
  { index: 1, label: "Rot Y", short: "RY" },
  { index: 2, label: "Rot Z", short: "RZ" },
];

export default function PropAttachPanel({
  attach,
  attachStatus,
  gizmoMode = "off",
  onGizmoModeChange,
  modelPath,
  isTauriRuntime,
  onChange,
  onNotify,
}) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteDraft, setPasteDraft] = useState("");
  const [pasteError, setPasteError] = useState("");
  const [copied, setCopied] = useState(false);
  const [customBoneOpen, setCustomBoneOpen] = useState(false);
  const [customBoneDraft, setCustomBoneDraft] = useState(String(attach.bone));
  const [exactOpen, setExactOpen] = useState(false);
  const copyTimerRef = useRef(null);

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  const isKnownBone = useMemo(
    () => PROP_ATTACH_BONES.some((bone) => bone.tag === attach.bone),
    [attach.bone],
  );
  useEffect(() => {
    setCustomBoneDraft(String(attach.bone));
    if (!isKnownBone) setCustomBoneOpen(true);
  }, [attach.bone, isKnownBone]);

  const snippet = useMemo(
    () => formatAttachSnippet({
      modelName: modelPath,
      bone: attach.bone,
      position: attach.position,
      rotation: attach.rotation,
      format: attach.format,
    }),
    [modelPath, attach.bone, attach.position, attach.rotation, attach.format],
  );

  const setAxis = (field, axisIndex, value) => {
    const next = [...attach[field]];
    next[axisIndex] = Number.isFinite(value) ? value : 0;
    onChange({ [field]: next });
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setPasteError("");
      setCopied(true);
      onNotify?.("Copied FiveM attach snippet");
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
      }, 1800);
    } catch {
      setPasteError("Couldn't copy to the clipboard — click inside the window and try again.");
    }
  };

  const handleImportPaste = () => {
    const parsed = parseAttachSnippet(pasteDraft);
    if (!parsed) {
      setPasteError("No bone, pos/coords or AttachEntityToEntity offsets found in that snippet.");
      return;
    }
    setPasteError("");
    onChange({ ...parsed, enabled: true });
    setPasteDraft("");
    setPasteOpen(false);
    onNotify?.("Imported offsets from snippet");
  };

  const isZero = attach.position.every((n) => Math.abs(n) < 1e-5) && attach.rotation.every((n) => Math.abs(n) < 1e-3);

  return (
    <>
      <section className="lv-group">
        <div className="lv-group-head">
          <h3 className="lv-group-title">Ped attachment</h3>
          <Toggle
            checked={attach.enabled}
            disabled={!isTauriRuntime}
            onChange={(enabled) => onChange({ enabled })}
            ariaLabel="Preview prop attached to a freemode ped"
          />
        </div>
        <p className="lv-slot-note">
          Mount this prop onto a GTA V freemode ped bone to dial in FiveM offsets visually (rotation order 2, matching <code>AttachEntityToEntity</code>).
        </p>

        {attachStatus?.state === "loading" ? (
          <p className="lv-slot-note is-idle">
            <Loader2 className="ps-spin ps-inline-icon" aria-hidden="true" />
            <span>{attachStatus.message || "Loading ped…"}</span>
          </p>
        ) : null}
        {attachStatus?.state === "error" ? (
          <p className="lv-slot-note is-error">
            <span className="lv-dot" aria-hidden="true" />
            <span>{attachStatus.message}</span>
          </p>
        ) : null}

        <div className="lv-field">
          <span className="cx-label" id="ps-attach-gender">Ped</span>
          <div className="lv-seg" role="radiogroup" aria-labelledby="ps-attach-gender">
            {[
              { id: "male", label: "Male" },
              { id: "female", label: "Female" },
            ].map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={attach.gender === option.id}
                className={`lv-seg-btn ${attach.gender === option.id ? "is-on" : ""}`}
                onClick={() => onChange({ gender: option.id })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="lv-field">
          <span className="cx-label">Pose</span>
          <Select value={attach.pose} onValueChange={(pose) => onChange({ pose })}>
            <SelectTrigger aria-label="Ped pose"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ATTACH_POSES.map((pose) => (
                <SelectItem key={pose.id} value={pose.id}>{pose.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="lv-field">
          <span className="cx-label">Bone</span>
          <Select
            value={isKnownBone && !customBoneOpen ? String(attach.bone) : CUSTOM_BONE_VALUE}
            onValueChange={(value) => {
              if (value === CUSTOM_BONE_VALUE) {
                setCustomBoneOpen(true);
                return;
              }
              setCustomBoneOpen(false);
              onChange({ bone: Number(value) });
            }}
          >
            <SelectTrigger aria-label="Attachment bone"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PROP_ATTACH_BONES.map((bone) => (
                <SelectItem key={bone.tag} value={String(bone.tag)}>
                  {bone.label} ({bone.tag})
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_BONE_VALUE}>Custom bone ID…</SelectItem>
            </SelectContent>
          </Select>
          {customBoneOpen || !isKnownBone ? (
            <label className="ps-custom-bone">
              <span className="ps-row-meta">Bone ID</span>
              <input
                type="number"
                className="ps-input"
                min={0}
                max={65535}
                step={1}
                value={customBoneDraft}
                aria-label="Custom GTA ped bone ID"
                onChange={(event) => {
                  const raw = event.target.value;
                  setCustomBoneDraft(raw);
                  const parsed = Number.parseInt(raw, 10);
                  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
                    onChange({ bone: parsed });
                  }
                }}
              />
            </label>
          ) : null}
        </div>
      </section>

      <section className="lv-group">
        <div className="lv-group-head">
          <h3 className="lv-group-title">Offset &amp; rotation</h3>
          <div className="ps-head-acts">
            <button
              type="button"
              className="lv-link"
              onClick={() => setExactOpen((v) => !v)}
              title="Type exact metres and degrees"
            >
              {exactOpen ? "Sliders" : "Exact"}
            </button>
            <button
              type="button"
              className="lv-link"
              onClick={() => {
                setPasteOpen((v) => !v);
                setPasteError("");
              }}
              title="Paste an AttachEntityToEntity, ox_lib, rpemotes or QB snippet"
            >
              Paste Lua
            </button>
            {!isZero ? (
              <button
                type="button"
                className="lv-link"
                onClick={() => onChange({ position: [0, 0, 0], rotation: [0, 0, 0] })}
                title="Zero position and rotation"
              >
                <RotateCcw className="ps-inline-icon-sm" aria-hidden="true" />
                Zero
              </button>
            ) : null}
          </div>
        </div>

        {pasteOpen ? (
          <div className="ps-paste-box">
            <textarea
              className="ps-textarea"
              rows={3}
              spellCheck={false}
              placeholder="Paste AttachEntityToEntity, PropPlacement = {...}, or pos = vec3(...)"
              value={pasteDraft}
              onChange={(event) => setPasteDraft(event.target.value)}
            />
            {pasteError ? <p className="lv-slot-note is-error"><span className="lv-dot" aria-hidden="true" /><span>{pasteError}</span></p> : null}
            <div className="ps-btn-row">
              <button type="button" className="cx-btn is-primary" onClick={handleImportPaste}>
                <ClipboardPaste aria-hidden="true" />
                Apply offsets
              </button>
              <button type="button" className="cx-btn is-quiet" onClick={() => setPasteOpen(false)}>Cancel</button>
            </div>
          </div>
        ) : null}

        <div className="lv-field">
          <span className="cx-label" id="ps-attach-gizmo">3D gizmo</span>
          <div className="lv-seg" role="radiogroup" aria-labelledby="ps-attach-gizmo">
            {[
              { id: "off", label: "Off" },
              { id: "translate", label: "Move (G)" },
              { id: "rotate", label: "Rotate (R)" },
            ].map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={gizmoMode === option.id}
                disabled={!attach.enabled}
                className={`lv-seg-btn ${gizmoMode === option.id ? "is-on" : ""}`}
                onClick={() => onGizmoModeChange?.(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {exactOpen ? (
          <div className="ps-exact-grid">
            {POS_AXES.map((axis) => (
              <label key={axis.label} className="lv-field">
                <span className="cx-label">{axis.short} (m)</span>
                <input
                  type="number"
                  className="ps-input"
                  min={-2.5}
                  max={2.5}
                  step={0.005}
                  value={Number(attach.position[axis.index].toFixed(4))}
                  onChange={(event) => {
                    const v = Number(event.target.value);
                    if (Number.isFinite(v)) setAxis("position", axis.index, Math.max(-2.5, Math.min(2.5, v)));
                  }}
                />
              </label>
            ))}
            {ROT_AXES.map((axis) => (
              <label key={axis.label} className="lv-field">
                <span className="cx-label">{axis.short} (°)</span>
                <input
                  type="number"
                  className="ps-input"
                  min={-180}
                  max={180}
                  step={1}
                  value={Number(attach.rotation[axis.index].toFixed(1))}
                  onChange={(event) => {
                    const v = Number(event.target.value);
                    if (Number.isFinite(v)) setAxis("rotation", axis.index, Math.max(-180, Math.min(180, v)));
                  }}
                />
              </label>
            ))}
          </div>
        ) : (
          <>
            {POS_AXES.map((axis) => {
              const bound = Math.min(2.5, Math.max(0.6, Math.ceil(Math.abs(attach.position[axis.index]) * 10) / 10));
              return (
                <Slider
                  key={axis.label}
                  id={`ps-att-pos-${axis.index}`}
                  label={axis.label}
                  value={attach.position[axis.index]}
                  min={-bound}
                  max={bound}
                  step={0.005}
                  format={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(3)} m`}
                  onChange={(v) => setAxis("position", axis.index, v)}
                />
              );
            })}
            {ROT_AXES.map((axis) => (
              <Slider
                key={axis.label}
                id={`ps-att-rot-${axis.index}`}
                label={axis.label}
                value={attach.rotation[axis.index]}
                min={-180}
                max={180}
                step={1}
                format={(v) => `${Math.round(v)}°`}
                onChange={(v) => setAxis("rotation", axis.index, v)}
              />
            ))}
          </>
        )}
      </section>

      <section className="lv-group">
        <div className="lv-group-head">
          <h3 className="lv-group-title">FiveM Lua</h3>
          <button type="button" className="lv-link" onClick={handleCopy}>
            {copied ? "Copied" : "Copy snippet"}
          </button>
        </div>
        <div className="lv-seg ps-seg-wrap" role="radiogroup" aria-label="Lua output format">
          {ATTACH_SNIPPET_FORMATS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={attach.format === option.id}
              className={`lv-seg-btn ${attach.format === option.id ? "is-on" : ""}`}
              onClick={() => onChange({ format: option.id })}
            >
              {option.label}
            </button>
          ))}
        </div>
        {!pasteOpen && pasteError ? <p className="lv-slot-note is-error"><span className="lv-dot" aria-hidden="true" /><span>{pasteError}</span></p> : null}
        <pre className="ps-code" aria-label="Generated FiveM Lua code">{snippet}</pre>
        <button type="button" className="cx-btn is-primary" onClick={handleCopy}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied to clipboard" : "Copy Lua snippet"}
        </button>
      </section>
    </>
  );
}
