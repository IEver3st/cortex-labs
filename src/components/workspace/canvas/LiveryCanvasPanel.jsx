import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronsRight,
  CircleAlert,
  Copy,
  Download,
  Equal,
  Eye,
  EyeOff,
  FlipHorizontal2,
  FolderOpen,
  Grid2x2,
  Grid3x3,
  ImagePlus,
  Link2,
  Lock,
  LockOpen,
  Minus,
  PackageOpen,
  Redo2,
  Save,
  Scan,
  Square,
  Trash2,
  Type,
  Undo2,
  Unlink,
  X,
} from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { Toggle } from "../../ui/toggle";
import { ColorLine, Slider } from "../parts";
import LiveryWriteDialog from "../LiveryWriteDialog";
import { CANVAS_FONTS, itemMeters } from "../../../lib/livery-canvas.js";
import { PATTERN_KINDS, SHAPE_DEFAULTS, SHAPE_KINDS, SHAPE_PARAM_LIMITS } from "../../../lib/livery-canvas-shapes.js";
import { islandPlacementIssue } from "../../../lib/livery-canvas-geometry.js";
import { fileNameOf } from "../../../lib/livery-set.js";
import "./LiveryCanvas.css";

const SHAPE_META = {
  stripe: { label: "Stripes", icon: Equal },
  band: { label: "Band", icon: Minus },
  chevron: { label: "Chevrons", icon: ChevronsRight },
  outline: { label: "Outline", icon: Square },
  battenburg: { label: "Battenburg", icon: Grid2x2 },
  check: { label: "Check", icon: Grid3x3 },
};

const PARAM_META = {
  count: { label: "Count", step: 1, format: (value) => `${value}` },
  gap: { label: "Gap", step: 0.05, format: (value) => value.toFixed(2) },
  slant: { label: "Slant", step: 1, format: (value) => `${Math.round(value)}°` },
  thickness: { label: "Thickness", step: 0.01, format: (value) => `${Math.round(value * 100)}%` },
  angle: { label: "Angle", step: 1, format: (value) => `${Math.round(value)}°` },
  rows: { label: "Rows", step: 1, format: (value) => `${value}` },
  cellAspect: { label: "Block shape", step: 0.05, format: (value) => `${value.toFixed(2)} : 1` },
  phase: { label: "Offset", step: 0.05, format: (value) => `${Math.round(value * 100)}%` },
};

const KIND_ICON = { image: ImagePlus, text: Type };
const DEFAULT_FONT = { id: CANVAS_FONTS[0].id, family: CANVAS_FONTS[0].family, weight: CANVAS_FONTS[0].weight, style: CANVAS_FONTS[0].style };

const toDegrees = (radians) => (radians * 180) / Math.PI;
const toRadians = (degrees) => (degrees * Math.PI) / 180;

function FontSelect({ value, onChange, onPickFile, id }) {
  const current = value?.path ? "file" : value?.id || CANVAS_FONTS[0].id;
  return (
    <Select
      value={current}
      onValueChange={async (next) => {
        if (next === "pick") {
          const font = await onPickFile();
          if (font) onChange(font);
          return;
        }
        if (next === "file") return;
        const font = CANVAS_FONTS.find((entry) => entry.id === next);
        if (font) onChange({ id: font.id, family: font.family, weight: font.weight, style: font.style });
      }}
    >
      <SelectTrigger className="lv-select" id={id} aria-label="Font">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="lv-select-content">
        {CANVAS_FONTS.map((font) => <SelectItem key={font.id} value={font.id}>{font.label}</SelectItem>)}
        {value?.path ? <SelectItem value="file">{fileNameOf(value.path)}</SelectItem> : null}
        <SelectItem value="pick">Your font file…</SelectItem>
      </SelectContent>
    </Select>
  );
}

function Note({ tone = "", children }) {
  return (
    <p className={`lv-slot-note ${tone ? `is-${tone}` : ""}`}>
      {tone === "warn" || tone === "error" ? <CircleAlert aria-hidden="true" className="lv-cv-note-icon" /> : null}
      <span>{children}</span>
    </p>
  );
}

function placingLabel(placing) {
  if (placing.name) return placing.name;
  if (placing.kind === "text") return `“${placing.source.text}”`;
  if (placing.kind === "shape") return SHAPE_META[placing.shape].label.toLowerCase();
  return fileNameOf(placing.source.path);
}

function AddSection({ canvas }) {
  const [text, setText] = useState("");
  const [font, setFont] = useState(DEFAULT_FONT);
  const [color, setColor] = useState("#ffffff");
  const placing = canvas.placing;
  return (
    <div className="lv-cv-block">
      <span className="cx-label">Add</span>
      <div className="lv-cv-add-row">
        <button type="button" className="cx-btn lv-cv-add" onClick={canvas.pickImage} disabled={Boolean(canvas.busy)} title="Place a PNG, JPG, WebP or SVG of your own">
          <ImagePlus aria-hidden="true" />
          Image…
        </button>
        <button type="button" className="cx-btn lv-cv-add" onClick={canvas.openKit} title="Place a decal set you saved from another vehicle">
          <PackageOpen aria-hidden="true" />
          Decal set…
        </button>
      </div>
      <div className="lv-cv-shapes" role="group" aria-label="Shapes">
        {SHAPE_KINDS.map((shape) => {
          const meta = SHAPE_META[shape];
          const Icon = meta.icon;
          const on = placing?.kind === "shape" && placing.shape === shape;
          return (
            <button key={shape} type="button" className={`lv-cv-shape ${on ? "is-on" : ""}`} aria-pressed={on}
              onClick={() => (on ? canvas.cancelPlacing() : canvas.startShape(shape))}
              title={PATTERN_KINDS.includes(shape) ? `${meta.label}: fills the part you click` : `Place ${meta.label.toLowerCase()}`}>
              <Icon aria-hidden="true" />
              <span>{meta.label}</span>
            </button>
          );
        })}
      </div>
      <form
        className="lv-cv-text-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) canvas.startText({ text: text.trim(), font, color, letterSpacing: 0 });
        }}
      >
        <input className="lv-liv-input lv-cv-text-input" value={text} maxLength={200} placeholder="Text, such as POLICE" spellCheck={false}
          onChange={(event) => setText(event.target.value)} aria-label="Text to place" />
        <div className="lv-cv-text-row">
          <FontSelect value={font} onChange={setFont} onPickFile={canvas.pickFont} id="lv-cv-add-font" />
          <button type="submit" className="cx-btn" disabled={!text.trim() || Boolean(canvas.busy)}>
            <Type aria-hidden="true" />
            Place
          </button>
        </div>
        <ColorLine label="Text colour" value={color} onChange={setColor} onReset={() => setColor("#ffffff")} />
      </form>
      {placing ? (
        <div className="lv-cv-placing" role="status">
          <span>
            {placing.total ? `${placing.kit}: ${placing.step} of ${placing.total}. ` : ""}
            {`Click a part on the vehicle${canvas.stage === "model" ? "" : " or the sheet"} to place ${placingLabel(placing)}.`}
          </span>
          <button type="button" className="lv-link" onClick={canvas.cancelPlacing}>Cancel</button>
        </div>
      ) : null}
    </div>
  );
}

function ItemRow({ canvas, item, index, count }) {
  const selected = canvas.selectedId === item.id;
  const Icon = item.kind === "shape" ? SHAPE_META[item.source.shape].icon : KIND_ICON[item.kind];
  const clipped = canvas.preview.clipped[item.id];
  const missing = item.kind === "image" && canvas.sources[item.source.path]?.error;
  const label = canvas.itemLabel(item);
  return (
    <li className={`lv-cv-row ${selected ? "is-selected" : ""} ${item.hidden ? "is-hidden" : ""}`}>
      <button type="button" className="lv-cv-row-main" onClick={() => canvas.select(selected ? null : item.id)} aria-pressed={selected}>
        <Icon aria-hidden="true" className="lv-cv-row-icon" />
        <span className="lv-cv-row-name">{label}</span>
        {item.symmetry ? <Link2 aria-label="Linked to the other side" className="lv-cv-row-flag" /> : null}
        {missing ? <CircleAlert aria-label="Image missing" className="lv-cv-row-flag is-error" /> : clipped ? <CircleAlert aria-label="Partly cut off" className="lv-cv-row-flag is-warn" /> : null}
      </button>
      <button type="button" className="cx-icon-btn" onClick={() => canvas.update(item.id, { hidden: !item.hidden })}
        aria-label={item.hidden ? `Show ${label}` : `Hide ${label}`} title={item.hidden ? "Show" : "Hide"}>
        {item.hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </button>
      <button type="button" className="cx-icon-btn" onClick={() => canvas.update(item.id, { locked: !item.locked })}
        aria-label={item.locked ? `Unlock ${label}` : `Lock ${label}`} title={item.locked ? "Unlock" : "Lock"}>
        {item.locked ? <Lock aria-hidden="true" /> : <LockOpen aria-hidden="true" />}
      </button>
      {selected ? (
        <span className="lv-cv-row-order">
          <button type="button" className="cx-icon-btn" disabled={index === count - 1} onClick={() => canvas.reorder(item.id, 1)} aria-label="Bring forward" title="Bring forward">
            <ArrowUp aria-hidden="true" />
          </button>
          <button type="button" className="cx-icon-btn" disabled={index === 0} onClick={() => canvas.reorder(item.id, -1)} aria-label="Send backward" title="Send backward">
            <ArrowDown aria-hidden="true" />
          </button>
        </span>
      ) : null}
    </li>
  );
}

function SizeSlider({ canvas, item }) {
  const meters = itemMeters(item);
  const t = item.uvTransform;
  const resize = (ratio, key) => canvas.update(item.id, (current) => ({
    ...current,
    uvTransform: { ...current.uvTransform, width: t.width * ratio, height: t.height * ratio },
  }), key);
  if (meters) {
    return (
      <Slider id={`lv-cv-size-${item.id}`} label="Width" value={Math.min(4, Math.max(0.05, meters.width))} min={0.05} max={4} step={0.01}
        format={(value) => `${value.toFixed(2)} m`}
        onChange={(value) => resize(value / Math.max(1e-6, meters.width), `size:${item.id}`)} />
    );
  }
  return (
    <Slider id={`lv-cv-size-${item.id}`} label="Width" value={Math.min(100, Math.max(1, t.width * 100))} min={1} max={100} step={0.5}
      format={(value) => `${value.toFixed(1)}% of the sheet`}
      onChange={(value) => resize(value / 100 / Math.max(1e-6, t.width), `size:${item.id}`)} />
  );
}

function ItemInspector({ canvas, item }) {
  const t = item.uvTransform;
  const linked = Boolean(item.symmetry);
  const island = item.island ? canvas.islandInfo(item.island.mesh, item.island.index) : null;
  const issue = islandPlacementIssue(island, item.kind);
  const clipped = canvas.preview.clipped[item.id];
  const hasTwin = canvas.doc.items.some((entry) => entry.symmetry?.of === item.id);
  const original = linked ? canvas.doc.items.find((entry) => entry.id === item.symmetry.of) : null;
  const shape = item.kind === "shape" ? item.source.shape : null;
  const setSource = (patch, key) => canvas.update(item.id, (current) => ({ ...current, source: { ...current.source, ...patch } }), key);
  return (
    <div className="lv-cv-block lv-cv-inspector">
      <div className="lv-cv-inspector-head">
        <span className="cx-label">{canvas.itemLabel(item)}</span>
        <button type="button" className="cx-icon-btn" onClick={() => canvas.select(null)} aria-label="Deselect" title="Deselect (Esc)">
          <X aria-hidden="true" />
        </button>
      </div>

      {issue.text ? <Note tone="warn">{issue.text}</Note> : null}
      {!item.island ? <Note>Not on a livery part, so it isn't clipped and won't follow a part.</Note> : null}
      {clipped ? <Note tone="warn">{`${Math.round(clipped * 100)}% of it falls outside its part and is cut off. Canvas doesn't carry items across UV seams; place a second copy on the neighbouring part if it must continue.`}</Note> : null}
      {original ? <Note>{`Follows ${canvas.itemLabel(original)} on the other side${item.symmetry.mode === "mirrored" ? " as a mirror image" : ""}. Its look follows the original; Re-mirror moves it to match the original's place.`}</Note> : null}

      {item.kind === "text" ? (
        <>
          <TextField key={item.id} item={item} canvas={canvas} disabled={linked} />
          <FontSelect value={item.source.font} onChange={(font) => canvas.updateText(item.id, { font })} onPickFile={canvas.pickFont} id={`lv-cv-font-${item.id}`} />
          <ColorLine label="Colour" value={item.source.color} onChange={(color) => setSource({ color }, `color:${item.id}`)} onReset={() => setSource({ color: "#ffffff" })} />
          <Slider id={`lv-cv-spacing-${item.id}`} label="Letter spacing" value={item.source.letterSpacing} min={-0.2} max={1} step={0.01}
            format={(value) => `${Math.round(value * 100)}%`} onChange={(value) => canvas.updateText(item.id, { letterSpacing: value })} />
        </>
      ) : null}

      {shape ? (
        <>
          <ColorLine label={PATTERN_KINDS.includes(shape) ? "First colour" : "Colour"} value={item.source.color} onChange={(color) => setSource({ color }, `color:${item.id}`)} onReset={() => setSource({ color: "#ffffff" })} />
          {PATTERN_KINDS.includes(shape) ? (
            <ColorLine label="Second colour" value={item.source.color2 || "#1d3f9e"} onChange={(color2) => setSource({ color2 }, `color2:${item.id}`)} onReset={() => setSource({ color2: "#1d3f9e" })} />
          ) : null}
          {Object.keys(SHAPE_DEFAULTS[shape]).map((param) => {
            const [min, max] = SHAPE_PARAM_LIMITS[param];
            const meta = PARAM_META[param];
            return (
              <Slider key={param} id={`lv-cv-${param}-${item.id}`} label={meta.label} value={item.source.params[param]} min={min} max={max} step={meta.step}
                format={meta.format} onChange={(value) => setSource({ params: { ...item.source.params, [param]: value } }, `${param}:${item.id}`)} />
            );
          })}
        </>
      ) : null}

      <SizeSlider canvas={canvas} item={item} />
      <Slider id={`lv-cv-rotation-${item.id}`} label="Rotation" value={Math.round(toDegrees(t.rotation))} min={-180} max={180} step={1}
        format={(value) => `${Math.round(value)}°`} onChange={(value) => canvas.update(item.id, (current) => ({ ...current, uvTransform: { ...current.uvTransform, rotation: toRadians(value) } }), `rotation:${item.id}`)} />
      <Slider id={`lv-cv-opacity-${item.id}`} label="Opacity" value={Math.round(item.opacity * 100)} min={0} max={100} step={1}
        format={(value) => `${Math.round(value)}%`} onChange={(value) => canvas.update(item.id, { opacity: value / 100 }, `opacity:${item.id}`)} />

      <div className="lv-cv-toggles">
        <div className="lv-seg" role="radiogroup" aria-label="Blend">
          {[["normal", "Normal"], ["multiply", "Multiply"]].map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={item.blend === value} className={`lv-seg-btn ${item.blend === value ? "is-on" : ""}`}
              onClick={() => canvas.update(item.id, { blend: value })} disabled={linked}>
              {label}
            </button>
          ))}
        </div>
        <div className="lv-seg" role="group" aria-label="Item options">
          <button type="button" className={`lv-seg-btn ${item.clip ? "is-on" : ""}`} aria-pressed={item.clip} disabled={linked || !item.island}
            onClick={() => canvas.update(item.id, { clip: !item.clip })} title="Cut the item to its part's edges">
            Clip to part
          </button>
          <button type="button" className={`lv-seg-btn ${t.flipX ? "is-on" : ""}`} aria-pressed={t.flipX}
            onClick={() => canvas.update(item.id, (current) => ({ ...current, uvTransform: { ...current.uvTransform, flipX: !current.uvTransform.flipX } }))}
            title="Flip left to right">
            Flip
          </button>
        </div>
      </div>

      <div className="lv-cv-actions">
        <button type="button" className="cx-btn" onClick={() => canvas.fitToPart(item.id)} disabled={!item.island} title="Stretch it over its whole part, lined up with the vehicle">
          <Scan aria-hidden="true" />
          Fit to part
        </button>
        {linked ? (
          <>
            <button type="button" className="cx-btn" onClick={() => canvas.remirror(item.id)} title="Place it again from the original's position">
              <Link2 aria-hidden="true" />
              Re-mirror
            </button>
            <button type="button" className="cx-btn" onClick={() => canvas.unlink(item.id)} title="Stop following the original">
              <Unlink aria-hidden="true" />
              Unlink
            </button>
          </>
        ) : (
          <>
            <button type="button" className="cx-btn" onClick={() => canvas.mirror(item.id, "readable")} disabled={!item.anchor}
              title={hasTwin ? "Move the other side's copy to match" : "Copy it to the matching spot on the other side, reading the right way"}>
              <Link2 aria-hidden="true" />
              {hasTwin ? "Update other side" : "Other side"}
            </button>
            <button type="button" className="cx-btn" onClick={() => canvas.mirror(item.id, "mirrored")} disabled={!item.anchor || item.kind === "text"}
              title={item.kind === "text" ? "Text would read backwards" : "Copy it to the other side as a mirror image, so it points the same way along the vehicle"}>
              <FlipHorizontal2 aria-hidden="true" />
              Mirror image
            </button>
          </>
        )}
        <button type="button" className="cx-btn" onClick={() => canvas.duplicate(item.id)} title="Duplicate">
          <Copy aria-hidden="true" />
          Duplicate
        </button>
        <button type="button" className="cx-btn is-danger" onClick={() => canvas.remove([item.id])} title="Delete (Del)">
          <Trash2 aria-hidden="true" />
          Delete
        </button>
      </div>
    </div>
  );
}

function TextField({ item, canvas, disabled }) {
  const committed = item.source.text;
  const [draft, setDraft] = useState(committed);
  useEffect(() => {
    setDraft((current) => (current.trim() ? committed : current));
  }, [committed]);
  return (
    <input className="lv-liv-input" value={draft} maxLength={200} spellCheck={false} aria-label="Text" disabled={disabled}
      onChange={(event) => {
        setDraft(event.target.value);
        canvas.updateText(item.id, { text: event.target.value });
      }}
      onBlur={() => setDraft(committed)} />
  );
}

function OutputSection({ canvas, s }) {
  const owned = canvas.base.classification.owned;
  const layersBlocked = canvas.outputBlocker(false);
  const flatBlocked = canvas.outputBlocker(true);
  const slots = canvas.slots;
  const [slot, setSlot] = useState("");
  const chosen = slots.find((entry) => String(entry.number) === slot)
    || slots.find((entry) => entry.number === canvas.base.slot)
    || slots[0] || null;
  const number = chosen ? chosen.number : null;
  const planned = number != null
    ? canvas.slotPlan(number)
    : { blocked: "This vehicle has no liveries in its own dictionaries yet. Add one in the list above, then write the canvas over it." };
  const hasItems = Boolean(canvas.doc.items.length);
  const writable = Boolean(s.isTauriRuntime && /\.yft$/i.test(s.modelPath || ""));
  return (
    <div className="lv-cv-block">
      <span className="cx-label">Export</span>
      <div className="lv-cv-actions">
        <button type="button" className="cx-btn" onClick={() => canvas.runExport("stack")} disabled={Boolean(layersBlocked || canvas.busy)} title={layersBlocked || "The canvas alone, on transparency, to put over a base in your editor"}>
          <Download aria-hidden="true" />
          PNG
        </button>
        <button type="button" className="cx-btn" onClick={() => canvas.runExport("psd")} disabled={Boolean(layersBlocked || canvas.busy)} title={layersBlocked || "One raster layer per item. Text is exported as pixels"}>
          <Download aria-hidden="true" />
          Layered PSD
        </button>
        <button type="button" className="cx-btn" onClick={() => canvas.runExport("flat")} disabled={Boolean(flatBlocked || canvas.busy)}
          title={flatBlocked || "The canvas flattened onto your base"}>
          <Download aria-hidden="true" />
          Flattened PNG
        </button>
      </div>
      <div className="lv-cv-actions">
        <button type="button" className="cx-btn" onClick={canvas.saveCanvas} title="Save the canvas as a file you can open again">
          <Save aria-hidden="true" />
          Save canvas…
        </button>
        <button type="button" className="cx-btn" onClick={canvas.openCanvas} title="Open a saved canvas">
          <FolderOpen aria-hidden="true" />
          Open canvas…
        </button>
        <button type="button" className="cx-btn" onClick={() => canvas.saveKit(canvas.selectedId ? [canvas.selectedId] : [])} disabled={!hasItems}
          title={canvas.selectedId ? "Save the selected item as a decal set for other vehicles" : "Save every item as a decal set for other vehicles"}>
          <PackageOpen aria-hidden="true" />
          {canvas.selectedId ? "Save item as decal set…" : "Save decal set…"}
        </button>
      </div>

      {writable ? (
        <>
          <span className="cx-label lv-cv-write-label">Write into the vehicle</span>
          {slots.length ? (
            <div className="lv-cv-write-row">
              <Select value={String(number)} onValueChange={setSlot}>
                <SelectTrigger className="lv-select" aria-label="Livery to replace">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="lv-select-content">
                  {slots.map((entry) => <SelectItem key={entry.number} value={String(entry.number)}>{`Livery ${entry.number}`}</SelectItem>)}
                </SelectContent>
              </Select>
              <button type="button" className="cx-btn is-primary" disabled={Boolean(planned.blocked || flatBlocked || canvas.busy)} onClick={() => canvas.openWrite(number)}
                title={planned.blocked || flatBlocked || `Replace livery ${number} with the canvas over your base`}>
                <Download aria-hidden="true" />
                {`Replace livery ${number}…`}
              </button>
            </div>
          ) : null}
          {owned && planned.blocked ? <Note>{planned.blocked}</Note>
            : owned && hasItems && flatBlocked ? <Note tone="warn">{flatBlocked}</Note> : null}
        </>
      ) : null}

      {canvas.writeDialog ? (
        <LiveryWriteDialog
          s={s}
          plan={canvas.writeDialog.plan}
          items={canvas.writeDialog.items}
          build={canvas.buildForWrite}
          onClose={canvas.closeWrite}
          onWritten={canvas.afterWrite}
        />
      ) : null}
    </div>
  );
}

export default function LiveryCanvasPanel({ canvas, s }) {
  if (!canvas?.available) return null;
  if (!canvas.engaged) {
    return (
      <section className="lv-group lv-cv-panel" aria-labelledby="lv-cv-title">
        <div className="lv-group-head">
          <h3 className="lv-group-title" id="lv-cv-title">Canvas</h3>
        </div>
        <p className="lv-cv-intro">Place your own images, text and stripes on the vehicle, and see them on the model and the flat sheet as you go. Nothing is written until you export or replace a livery.</p>
        <div className="lv-cv-actions">
          <button type="button" className="cx-btn is-primary" onClick={canvas.start}>Start a canvas</button>
          <button type="button" className="cx-btn" onClick={canvas.openCanvas}>
            <FolderOpen aria-hidden="true" />
            Open canvas…
          </button>
        </div>
      </section>
    );
  }

  const { doc, model, base } = canvas;
  const items = doc.items;
  const baseNote = base.status === "error" ? { tone: "error", text: base.error }
    : base.classification.kind === "none" ? { tone: "warn", text: "No base yet: preview a livery above or choose one in the Livery step to see the canvas on the vehicle." }
      : base.classification.owned ? { tone: "", text: `Base: ${base.classification.label}` }
        : { tone: "warn", text: base.classification.reason };
  const modelTone = model.status === "error" || model.status === "none" ? "warn" : model.status === "loading" ? "busy" : "";

  return (
    <section className="lv-group lv-cv-panel" aria-labelledby="lv-cv-title">
      <div className="lv-group-head">
        <h3 className="lv-group-title" id="lv-cv-title">Canvas</h3>
        <span className="lv-cv-head-tools">
          <button type="button" className="cx-icon-btn" onClick={canvas.undo} disabled={!canvas.history.canUndo} aria-label="Undo" title="Undo (Ctrl+Z)">
            <Undo2 aria-hidden="true" />
          </button>
          <button type="button" className="cx-icon-btn" onClick={canvas.redo} disabled={!canvas.history.canRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
            <Redo2 aria-hidden="true" />
          </button>
          <button type="button" className="cx-icon-btn" onClick={canvas.close} aria-label="Close the canvas" title="Close the canvas and clear it from this vehicle">
            <X aria-hidden="true" />
          </button>
        </span>
      </div>

      {model.text ? <Note tone={modelTone}>{model.text}</Note> : null}
      {model.problems.slice(0, 3).map((problem) => <Note key={problem} tone="warn">{problem}</Note>)}
      <Note tone={baseNote.tone}>{baseNote.text}</Note>
      {canvas.preview.error ? <Note tone="error">{canvas.preview.error}</Note> : null}

      <div className="lv-cv-check">
        <span>Show on the vehicle</span>
        <Toggle checked={canvas.showOnModel} onChange={canvas.setShowOnModel} ariaLabel="Show the canvas on the vehicle" />
      </div>

      <AddSection canvas={canvas} />

      {canvas.notice ? (
        <p className={`lv-slot-note ${canvas.notice.tone ? `is-${canvas.notice.tone}` : ""}`} role="status">
          <span>{canvas.notice.text}</span>
          <button type="button" className="cx-icon-btn lv-cv-notice-close" onClick={canvas.clearNotice} aria-label="Dismiss">
            <X aria-hidden="true" />
          </button>
        </p>
      ) : null}
      {canvas.busy ? <Note tone="busy">{canvas.busy}</Note> : null}

      {canvas.missing.length ? (
        <div className="lv-cv-block">
          <span className="cx-label">Missing files</span>
          <ul className="lv-cv-missing">
            {canvas.missing.map((entry) => (
              <li key={`${entry.kind}:${entry.path}`}>
                <span className="lv-cv-missing-name" title={`${entry.path}: ${entry.error}`}>{fileNameOf(entry.path)}</span>
                <button type="button" className="lv-link" onClick={() => canvas.locate(entry)}>Locate…</button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {items.length ? (
        <div className="lv-cv-block">
          <span className="cx-label">{`Items · ${items.length}`}</span>
          <ul className="lv-cv-rows" aria-label="Canvas items, top first">
            {[...items].reverse().map((item, reversedIndex) => (
              <ItemRow key={item.id} canvas={canvas} item={item} index={items.length - 1 - reversedIndex} count={items.length} />
            ))}
          </ul>
        </div>
      ) : <p className="lv-cv-intro">Add an image, text or a shape, then click where it goes on the vehicle or the sheet.</p>}

      {canvas.selected ? <ItemInspector canvas={canvas} item={canvas.selected} /> : null}

      <OutputSection canvas={canvas} s={s} />
    </section>
  );
}
