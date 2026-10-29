import { Children, Fragment, isValidElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePaneMotion } from "./usePaneMotion";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Check,
  ChevronUp,
  CircleHelp,
  Contrast,
  Crosshair,
  FolderOpen,
  Frame,
  Grid3x3,
  ImagePlus,
  LampCeiling,
  Loader2,
  Plus,
  RotateCcw,
  Sun,
  Triangle,
  X,
} from "lucide-react";
import { Toggle } from "../ui/toggle";
import { Keycaps, hotkeyLabel } from "../ui/keycaps";
import { HOTKEY_ACTIONS } from "../../lib/hotkeys";
import { collisionMaterialColor, collisionMaterialLabel } from "../../lib/collision-overlay.js";
import { SHOWROOM_FLOORS, SHOWROOM_FLOOR_LABELS } from "../../lib/showroom-floors.js";
import { TURNTABLE_MAX_SPEED, TURNTABLE_MIN_SPEED } from "../../lib/turntable.js";
import LightDome from "../LightDome";
import "./workspace.css";

/* Shared building blocks for the viewer workspaces (Livery, All, Multi):
   the frame, viewfinder chrome, camera deck, and inspector sections. Each
   workspace supplies its own asset dock and its own deck buttons. */

export const CAMERA_SHOTS = [
  { key: "front", label: "Front", action: HOTKEY_ACTIONS.CAMERA_PRESET_FRONT },
  { key: "back", label: "Rear", action: HOTKEY_ACTIONS.CAMERA_PRESET_BACK },
  { key: "side", label: "Side", action: HOTKEY_ACTIONS.CAMERA_PRESET_SIDE },
  { key: "angle", label: "3/4", action: HOTKEY_ACTIONS.CAMERA_PRESET_ANGLE },
  { key: "top", label: "Top", action: HOTKEY_ACTIONS.CAMERA_PRESET_TOP },
];

const SURFACES = [
  { id: "paint", label: "Paint" },
  { id: "chrome", label: "Chrome" },
  { id: "plastic", label: "Plastic" },
  { id: "metal", label: "Metal" },
  { id: "glass", label: "Glass" },
];

const HEX_RE = /^#[0-9a-f]{6}$/i;

export function splitPath(path) {
  if (!path) return { name: "", folder: "" };
  const parts = path.split(/[\\/]/);
  const name = parts.pop() || "";
  return { name, folder: parts.join("\\") };
}

export function withShortcut(label, hotkey) {
  const shortcut = hotkeyLabel(hotkey);
  return shortcut ? `${label} (${shortcut})` : label;
}

/* ─── Small controls ─── */

export function Slider({ label, value, min, max, step, format, onChange, id }) {
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <label className="lv-slider" htmlFor={id}>
      <span className="lv-slider-head">
        <span className="lv-slider-label">{label}</span>
        <output className="lv-slider-value" htmlFor={id}>{format(value)}</output>
      </span>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--fill": fill }}
        onChange={(event) => onChange(Number.parseFloat(event.target.value))}
      />
    </label>
  );
}

function HexInput({ value, onCommit, label }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.startsWith("#") ? draft : `#${draft}`;
    if (HEX_RE.test(next)) onCommit(next.toLowerCase());
    else setDraft(value);
  };
  return (
    <input
      className="lv-hex"
      value={draft}
      spellCheck={false}
      maxLength={7}
      aria-label={`${label} hex value`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function ColorLine({ label, value, onChange, onReset, selected, onSelect }) {
  return (
    <div
      className={`lv-color ${selected ? "is-selected" : ""}`}
      onClick={onSelect}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-pressed={onSelect ? selected : undefined}
      onKeyDown={(event) => {
        if (onSelect && (event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <label className="lv-chip" style={{ "--chip": value }} onClick={(event) => event.stopPropagation()}>
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`${label} colour`}
        />
      </label>
      <span className="lv-color-label">{label}</span>
      <span onClick={(event) => event.stopPropagation()}>
        <HexInput value={value} onCommit={onChange} label={label} />
      </span>
      <button
        type="button"
        className="cx-icon-btn lv-color-reset"
        onClick={(event) => {
          event.stopPropagation();
          onReset();
        }}
        title={`Reset ${label.toLowerCase()}`}
        aria-label={`Reset ${label.toLowerCase()}`}
      >
        <RotateCcw aria-hidden="true" />
      </button>
    </div>
  );
}

/** A set of colour slots plus quick colours that apply to the selected slot. */
export function ColorSlots({ id, title, slots, swatches }) {
  const [selected, setSelected] = useState(slots[0]?.key);
  const current = slots.find((slot) => slot.key === selected) || slots[0];
  return (
    <section className="lv-group" id={id}>
      <h3 className="lv-group-title">{title}</h3>
      <div className="lv-colors">
        {slots.map((slot) => (
          <ColorLine
            key={slot.key}
            label={slot.label}
            value={slot.value}
            onChange={slot.onChange}
            onReset={slot.onReset}
            selected={slots.length > 1 && selected === slot.key}
            onSelect={slots.length > 1 ? () => setSelected(slot.key) : undefined}
          />
        ))}
      </div>
      <div className="lv-swatches" role="group" aria-label="Quick colours">
        {swatches.map((color) => (
          <button
            key={color}
            type="button"
            className="lv-swatch"
            style={{ "--chip": color }}
            onClick={() => current?.onChange(color)}
            title={`Set ${current?.label.toLowerCase()} to ${color}`}
            aria-label={`Set ${current?.label.toLowerCase()} to ${color}`}
          />
        ))}
      </div>
    </section>
  );
}

export function DeckButton({ active, onClick, title, children, disabled, className = "" }) {
  return (
    <button
      type="button"
      className={`lv-deck-btn ${active ? "is-on" : ""} ${className}`.trim()}
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function SelectField({ label, children }) {
  return (
    <div className="lv-field">
      <span className="cx-label">{label}</span>
      {children}
    </div>
  );
}

/* ─── Asset slot ─── */

/** One pipeline step. A loaded file's card carries Replace and Unload;
    `facts` (fact rows about the file) follow it. */
export function AssetSlot({ id, step, title, path, emptyTitle, emptyHint, emptyDetail, hotkey, onPick, onUnload, done, children, trailing, disabled, disabledNote, facts }) {
  const { name, folder } = splitPath(path);
  const subject = title.toLowerCase();
  const fileActions = (
    <>
      <button type="button" className="cx-icon-btn lv-file-act" onClick={onPick}
        title={withShortcut(`Replace the ${subject}`, hotkey)} aria-label={`Replace the ${subject}`}>
        <FolderOpen aria-hidden="true" />
      </button>
      {onUnload ? (
        <button type="button" className="cx-icon-btn lv-file-act" onClick={onUnload}
          title={`Unload the ${subject}`} aria-label={`Unload the ${subject}`}>
          <X aria-hidden="true" />
        </button>
      ) : null}
    </>
  );
  return (
    <section id={id} className={`lv-slot ${path ? "is-filled" : "is-empty"} ${disabled ? "is-disabled" : ""}`}>
      <header className="lv-slot-head">
        <span className={`lv-step ${done ? "is-done" : ""}`} aria-hidden="true">
          {done ? <Check /> : step}
        </span>
        <h3 className="lv-slot-title">{title}</h3>
        {trailing}
      </header>
      {disabled ? (
        disabledNote ? (
          <div className="lv-slot-body">
            <p className="lv-slot-note">{disabledNote}</p>
          </div>
        ) : null
      ) : path ? (
        <div className="lv-slot-body">
          <FileCard path={path} name={name} folder={folder} actions={fileActions} />
          {facts}
          {children}
        </div>
      ) : (
        <div className="lv-slot-body">
          <DropButton title={emptyTitle} hint={emptyHint} detail={emptyDetail} hotkey={hotkey} onClick={onPick} />
          {children}
        </div>
      )}
    </section>
  );
}

/** `actions` (icon buttons for the file itself) sit at the card's right edge. */
export function FileCard({ path, name, folder, title, actions }) {
  const parts = name ? { name, folder } : splitPath(path);
  const text = (
    <>
      <span className="lv-file-name">{parts.name}</span>
      {parts.folder ? <span className="lv-file-folder">{parts.folder}</span> : null}
    </>
  );
  if (!actions) return <div className="lv-file" title={title ?? path}>{text}</div>;
  return (
    <div className="lv-file has-actions">
      <div className="lv-file-text" title={title ?? path}>{text}</div>
      <div className="lv-file-acts">{actions}</div>
    </div>
  );
}

export function StageToggle({ showroom, onChange, title }) {
  return (
    <button
      type="button"
      className={`lv-stage-toggle ${showroom ? "is-on" : ""}`}
      aria-pressed={showroom}
      onClick={() => onChange(!showroom)}
      title={`${title}. ${showroom ? "Click for the workbench." : "Click for the showroom."}`}
    >
      <LampCeiling aria-hidden="true" />
      Showroom
    </button>
  );
}

export function StageEmpty({ icon: Icon, title, line, tone, children }) {
  return (
    <div className={`lv-stage-empty ${tone === "error" ? "is-error" : ""}`} role="status">
      {Icon ? <Icon className="lv-stage-empty-icon" aria-hidden="true" /> : null}
      <p className="lv-stage-empty-title">{title}</p>
      {line ? <p className="lv-stage-empty-line">{line}</p> : null}
      {children ? <div className="lv-stage-empty-actions">{children}</div> : null}
    </div>
  );
}

export function FootFact({ label, children, title }) {
  return (
    <div className="lv-foot-fact" title={title}>
      <span className="cx-label">{label}</span>
      <span className="lv-foot-value">{children}</span>
    </div>
  );
}

export function DropButton({ title, hint, detail, hotkey, onClick }) {
  return (
    <button type="button" className="lv-drop" onClick={onClick} title={detail}>
      <span className="lv-drop-title">
        <Plus aria-hidden="true" />
        {title}
      </span>
      {hint ? <span className="lv-drop-hint">{hint}</span> : null}
      <Keycaps hotkey={hotkey} />
    </button>
  );
}

/* ─── Frame ─── */

// `viewSwitch` leads the frame's context slot; `panelControls` false hides the
// panel toggles while something else (the Pack view) covers the panels.
export function PanelLayout({ start = null, end = null }) {
  const half = (side, panel) => (
    <button
      type="button"
      className={`lv-layout-half is-${side}`}
      onClick={panel.onToggle}
      title={`${panel.label}${panel.hint || ""}`}
      aria-label={panel.label}
      aria-pressed={panel.shown}
    />
  );
  return (
    <div className={`lv-layout ${start && end ? "" : "is-single"}`} role="group" aria-label="Panels">
      <svg className="lv-layout-glyph" viewBox="0 0 22 16" aria-hidden="true">
        <rect className="lv-layout-frame" x="0.75" y="0.75" width="20.5" height="14.5" rx="2.5" />
        {start ? <path className={`lv-layout-col is-start ${start.shown ? "is-on" : ""}`} d="M3.25 0.75H5.25V15.25H3.25A2.5 2.5 0 0 1 0.75 12.75V3.25A2.5 2.5 0 0 1 3.25 0.75Z" /> : null}
        {end ? <path className={`lv-layout-col is-end ${end.shown ? "is-on" : ""}`} d="M16.75 0.75H18.75A2.5 2.5 0 0 1 21.25 3.25V12.75A2.5 2.5 0 0 1 18.75 15.25H16.75Z" /> : null}
        {start ? <path className="lv-layout-edge" d="M5.25 0.75V15.25" /> : null}
        {end ? <path className="lv-layout-edge" d="M16.75 0.75V15.25" /> : null}
      </svg>
      {start ? half(start && end ? "start" : "all", start) : null}
      {end ? half(start && end ? "end" : "all", end) : null}
    </div>
  );
}

export function WorkspaceFrame({ s, inspectorOpen, setInspectorOpen, children, className = "", style = null, viewSwitch = null, panelControls = true }) {
  const focusMode = s.panelCollapsed;
  const hk = s.hotkeys || {};
  const rootRef = useRef(null);
  const [hasDock, setHasDock] = useState(true);
  const [dockOpen, setDockOpen] = useState(true);
  useLayoutEffect(() => {
    const found = Boolean(rootRef.current?.querySelector(":scope > .lv-dock"));
    if (found !== hasDock) setHasDock(found);
  });
  const dockShown = hasDock && dockOpen && !focusMode;
  const inspectorShown = inspectorOpen && !focusMode;
  const focusKey = hotkeyLabel(hk[HOTKEY_ACTIONS.TOGGLE_PANEL]);
  const focusHint = focusKey ? `. ${focusKey} hides both panels` : "";
  const toggleDock = () => {
    if (focusMode) {
      s.setPanelCollapsed(false);
      setDockOpen(true);
      setInspectorOpen(false);
    } else setDockOpen((open) => !open);
  };
  const toggleInspector = () => {
    if (focusMode) {
      s.setPanelCollapsed(false);
      setDockOpen(false);
      setInspectorOpen(true);
    } else setInspectorOpen((open) => !open);
  };
  const rootClass = `lv-root ${focusMode ? "is-focus" : ""} ${hasDock && !dockOpen ? "is-dock-hidden" : ""} ${inspectorOpen ? "" : "is-inspector-closed"} ${className}`;
  usePaneMotion(rootRef, rootClass);
  return (
    <motion.div
      ref={rootRef}
      className={rootClass}
      initial={{ opacity: 0 }}
      animate={s.isBooting ? { opacity: 0 } : { opacity: 1 }}
      transition={{ duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }}
      style={{ ...style, pointerEvents: s.isBooting ? "none" : "auto" }}
    >
      {s.isActive && s.contextBarTarget
        ? createPortal(
            <div className="ctx-bar-inner lv-ctx">
              {viewSwitch}
              {panelControls ? (
                <PanelLayout
                  start={hasDock ? { shown: dockShown, onToggle: toggleDock, label: dockShown ? "Hide the dock" : "Show the dock", hint: focusHint } : null}
                  end={{ shown: inspectorShown, onToggle: toggleInspector, label: inspectorShown ? "Hide the inspector" : "Show the inspector", hint: focusHint }}
                />
              ) : null}
            </div>,
            s.contextBarTarget,
          )
        : null}
      {children}
    </motion.div>
  );
}

/* ─── Viewfinder ─── */

export function CameraShots({ s, disabled }) {
  const hk = s.hotkeys || {};
  return (
    <div className="lv-deck-group" role="group" aria-label="Camera shots">
      {CAMERA_SHOTS.map((shot) => (
        <DeckButton
          key={shot.key}
          onClick={() => s.handleSetCameraPreset(shot.key)}
          title={withShortcut(`${shot.label} view`, hk[shot.action])}
          disabled={disabled}
        >
          {shot.label}
        </DeckButton>
      ))}
      <DeckButton
        onClick={s.handleCenterCamera}
        title={withShortcut("Re-centre on the model", hk[HOTKEY_ACTIONS.RESET_VIEW])}
        disabled={disabled}
        className="is-icon"
      >
        <Crosshair aria-hidden="true" />
      </DeckButton>
    </div>
  );
}

export function RotateButtons({ s, disabled }) {
  return (
    <div className="lv-deck-group" role="group" aria-label="Rotate model 90 degrees">
      {["x", "y", "z"].map((axis) => (
        <DeckButton
          key={axis}
          onClick={() => s.handleRotateModel(axis)}
          title={`Rotate 90° on ${axis.toUpperCase()}`}
          disabled={disabled}
          className={`is-axis is-${axis}`}
        >
          {axis.toUpperCase()}
        </DeckButton>
      ))}
      {s.handleResetRotation ? (
        <DeckButton
          onClick={s.handleResetRotation}
          title="Undo the turns: stand the model as it loaded"
          disabled={disabled || !s.modelRotation}
          className="is-icon"
        >
          <RotateCcw aria-hidden="true" />
        </DeckButton>
      ) : null}
    </div>
  );
}

function HelpPopover() {
  return (
    <div className="lv-help" role="dialog" aria-label="Viewer controls">
      <dl>
        <div><dt><kbd className="cx-keycap">LMB</kbd></dt><dd>Orbit</dd></div>
        <div><dt><kbd className="cx-keycap">RMB</kbd></dt><dd>Look around</dd></div>
        <div><dt>Scroll</dt><dd>Zoom</dd></div>
        <div><dt><kbd className="cx-keycap">W</kbd><kbd className="cx-keycap">A</kbd><kbd className="cx-keycap">S</kbd><kbd className="cx-keycap">D</kbd></dt><dd>Fly</dd></div>
        <div><dt><kbd className="cx-keycap">Q</kbd><kbd className="cx-keycap">E</kbd></dt><dd>Down and up</dd></div>
        <div><dt><kbd className="cx-keycap">Shift</kbd></dt><dd>Faster</dd></div>
        <div><dt><kbd className="cx-keycap">Alt</kbd></dt><dd>Finer</dd></div>
      </dl>
    </div>
  );
}

function flattenNodes(nodes) {
  return Children.toArray(nodes).flatMap((node) =>
    isValidElement(node) && node.type === Fragment ? flattenNodes(node.props.children) : [node]);
}

export function deckButtonItems(nodes) {
  return flattenNodes(nodes).map((node, index) => {
    if (!isValidElement(node) || node.type !== DeckButton) return { key: node?.key ?? `node-${index}`, node };
    const { active, onClick, title, label, hotkey, note, disabled, children } = node.props;
    return { key: node.key ?? title, label: label ?? title, title, hotkey, note, icon: children, on: Boolean(active), onToggle: onClick, disabled };
  });
}

function ViewRow({ item }) {
  return (
    <label className={`lv-view-row ${item.disabled ? "is-disabled" : ""}`} title={item.title && item.title !== item.label ? item.title : undefined}>
      <span className="lv-view-icon" aria-hidden="true">{item.icon}</span>
      <span className="lv-view-text">
        <span className="lv-view-label">{item.label}</span>
        {item.disabled && item.note ? <span className="lv-view-note">{item.note}</span> : null}
      </span>
      <Keycaps hotkey={item.hotkey} />
      <Toggle checked={item.on} onChange={() => item.onToggle()} disabled={item.disabled} ariaLabel={item.label} />
    </label>
  );
}

export function DeckViewMenu({ groups, open: controlled, onOpenChange }) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = onOpenChange ?? setOwn;
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, setOpen]);
  const sections = groups.map((items) => items.filter(Boolean)).filter((items) => items.length);
  return (
    <div
      ref={rootRef}
      className="lv-deck-group lv-view"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={`lv-deck-btn lv-view-btn ${open ? "is-on" : ""}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="View: wireframes, grid, shadow and guides"
      >
        View
        <ChevronUp className="lv-view-chev" aria-hidden="true" />
      </button>
      {open ? (
        <div className="lv-view-menu" role="dialog" aria-label="View">
          {sections.map((items, index) => (
            <div key={index} className="lv-view-section">
              {items.map((item) => (item.node
                ? <div key={item.key} className="lv-view-extra">{item.node}</div>
                : <ViewRow key={item.key} item={item} />))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The 3D view plus everything floating over it. `deckStart` holds the
 * workspace's own deck groups (camera, rotate, snap...), `viewButtons` its
 * view toggles; grid, shadow, guides and help are shared.
 */
export function Viewfinder({ s, viewer, hasModel, alerts, dropHint, deckStart, viewButtons, progress, stageSwitch = true, collisions = null, empty = null }) {
  const [guides, setGuides] = useState(false);
  const [popover, setPopover] = useState(null);
  const helpOpen = popover === "help";
  const hk = s.hotkeys || {};
  const showroom = s.stage === "showroom";
  const capturing = Boolean(progress);
  const modelItems = [
    ...deckButtonItems(viewButtons),
    s.setShowSolidWireframe ? {
      key: "solid",
      label: "Solid wireframe and stats",
      title: "Solid wireframe with the mesh stats slip",
      icon: <Triangle />,
      on: Boolean(s.showSolidWireframe),
      onToggle: () => s.setShowSolidWireframe((v) => !v),
    } : null,
  ];
  const sceneItems = [
    {
      key: "grid",
      label: "Ground grid",
      icon: <Grid3x3 />,
      on: s.showGrid && !showroom,
      onToggle: () => s.toggleRenderEffect("showGrid"),
      disabled: showroom,
      note: "Workbench only",
    },
    {
      key: "shadow",
      label: "Ground shadow",
      icon: <Sun />,
      hotkey: hk[HOTKEY_ACTIONS.TOGGLE_SHADOWS],
      on: s.showShadows || showroom,
      onToggle: () => s.toggleRenderEffect("showShadows"),
      disabled: showroom,
      note: "Always on in the showroom",
    },
    {
      key: "ao",
      label: "Ambient occlusion",
      icon: <Contrast />,
      on: Boolean(s.ambientOcclusion),
      onToggle: () => s.toggleRenderEffect("ambientOcclusion"),
    },
    {
      key: "guides",
      label: "Framing guides",
      icon: <Frame />,
      on: guides,
      onToggle: () => setGuides((v) => !v),
    },
  ];

  return (
    <section
      className={`lv-finder ${s.isDragging ? "is-dragging" : ""} ${capturing ? "is-capturing" : ""}`}
      aria-label="Viewfinder"
      onDragEnter={s.handleDragOver}
      onDragOver={s.handleDragOver}
      onDragLeave={s.handleDragLeave}
      onDrop={s.handleDrop}
    >
      <div className="lv-stage">{viewer}</div>

      <div className="lv-hud">
        {guides ? (
          <div className="lv-guides" aria-hidden="true">
            <span /><span /><span /><span />
            <i />
          </div>
        ) : null}

        {hasModel && stageSwitch ? (
          <StageToggle showroom={showroom} onChange={(on) => s.setStage(on ? "showroom" : "workbench")} title="The vehicle parked in a dark studio on a satin floor under a spotlight you can aim" />
        ) : null}

        {hasModel && ((s.showSolidWireframe && s.meshStats) || collisions) ? (
          <div className={`lv-slip-stack ${stageSwitch ? "" : "is-top"}`}>
            {s.showSolidWireframe && s.meshStats ? <MeshStatsSlip stats={s.meshStats} /> : null}
            {collisions}
          </div>
        ) : null}

        <div className="lv-alerts" role="status" aria-live="polite">
          <AnimatePresence initial={false}>
            {alerts.map((alert) => (
              <motion.div
                key={alert.id}
                className="lv-alert"
                role="alert"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.16 }}
              >
                <AlertTriangle className="lv-alert-icon" aria-hidden="true" />
                <div className="lv-alert-copy">
                  <strong>{alert.label}</strong>
                  <span>{alert.text}</span>
                </div>
                <button type="button" className="cx-icon-btn" onClick={alert.clear} aria-label="Dismiss">
                  <X aria-hidden="true" />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <div className="lv-toasts">
          <AnimatePresence>
            {(s.toasts || []).map((toast) => (
              <motion.div
                key={toast.id}
                className="lv-toast"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 12 }}
                transition={{ duration: 0.18 }}
              >
                <Check aria-hidden="true" />
                <span>{toast.message}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {s.isDragging ? (
          <div className="lv-dropzone" aria-hidden="true">
            <span className="cx-display">Release to load</span>
            <span>{dropHint}</span>
          </div>
        ) : null}

        {hasModel ? null : empty}

        {hasModel ? (
          <div className="lv-deck" id="panel-visibility" role="toolbar" aria-label="Camera and view">
            {deckStart}
            <DeckViewMenu
              groups={[modelItems, sceneItems]}
              open={popover === "view"}
              onOpenChange={(next) => setPopover(next ? "view" : null)}
            />
            <div className="lv-deck-group">
              <DeckButton active={helpOpen} onClick={() => setPopover((open) => (open === "help" ? null : "help"))} title="Mouse and keyboard controls" className="is-icon">
                <CircleHelp aria-hidden="true" />
              </DeckButton>
            </div>
            {helpOpen ? <HelpPopover /> : null}
          </div>
        ) : null}

        {capturing ? (
          <div className="lv-capturing" role="status" aria-live="polite">
            <div className="lv-capturing-pill">
              <span className="lv-rec" aria-hidden="true" />
              <span>Capturing {progress.preset || "…"}</span>
              <span className="lv-capturing-count">
                {progress.current}/{progress.total}
              </span>
            </div>
            <div className="lv-capturing-bar">
              <span style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }} />
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

const formatCount = (value) => Number(value || 0).toLocaleString();
const formatMetres = (value) => value.toFixed(2);
const formatSize = ({ length, width, height }) =>
  Math.max(length, width, height) < 1
    ? `${(length * 100).toFixed(1)} × ${(width * 100).toFixed(1)} × ${(height * 100).toFixed(1)} cm`
    : `${formatMetres(length)} × ${formatMetres(width)} × ${formatMetres(height)} m`;

// Counts what the viewer draws now, so hidden parts and inactive LODs are out.
export function MeshStatsSlip({ stats, belowSwitch, modelsLabel = "Vehicles" }) {
  const rows = [
    stats.models > 1 ? [modelsLabel, formatCount(stats.models)] : null,
    ["Triangles", formatCount(stats.triangles), "GTA drawables are triangle lists, so this is the polygon count"],
    ["Vertices", formatCount(stats.vertices)],
    ["Meshes", formatCount(stats.meshes), "Drawn geometry pieces; each is at least one draw call"],
    stats.shaders === null ? null : ["Shaders", formatCount(stats.shaders), "Distinct GTA shaders in use"],
    stats.textures === null ? null : ["Textures", formatCount(stats.textures), "Distinct textures the drawn shaders reference"],
    stats.size
      ? ["Size", formatSize(stats.size), "Length × width × height"]
      : null,
  ].filter(Boolean);
  return (
    <section className={`lv-slip lv-mesh-stats ${belowSwitch ? "is-below-switch" : ""}`} aria-label="Mesh stats">
      <h3 className="cx-label">Mesh stats</h3>
      <dl>
        {rows.map(([label, value, hint]) => (
          <div key={label} title={hint}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const COLLISION_KINDS = [
  ["box", "Boxes"],
  ["sphere", "Spheres"],
  ["capsule", "Capsules"],
  ["cylinder", "Cylinders"],
];
const COLLISION_MATERIAL_ROWS = 6;

const COLLISION_NOTES = {
  loading: "Reading collisions…",
  none: "This model has no collision bounds.",
  unavailable: "Collisions are read from .yft, .ydr and .ydd files in the desktop app.",
};

export function CollisionSlip({ info, showModel, onShowModelChange }) {
  const data = info?.status === "ready" ? info.data : null;
  const materials = data?.materials || [];
  const shown = materials.slice(0, COLLISION_MATERIAL_ROWS);
  return (
    <section className="lv-slip lv-mesh-stats lv-collisions" aria-label="Collisions">
      <h3 className="cx-label">Collisions</h3>
      {data ? (
        <>
          <dl>
            <div title="Collision mesh triangles">
              <dt>Triangles</dt>
              <dd>{formatCount(data.triangles)}</dd>
            </div>
            {COLLISION_KINDS.filter(([kind]) => data.kinds[kind] > 0).map(([kind, label]) => (
              <div key={kind}>
                <dt>{label}</dt>
                <dd>{formatCount(data.kinds[kind])}</dd>
              </div>
            ))}
          </dl>
          <ul className="lv-collision-materials" aria-label="Collision materials">
            {shown.map((material) => (
              <li key={material.index} title={`${collisionMaterialLabel(material)}: ${formatCount(material.triangles)} triangles, ${formatCount(material.shapes)} shapes`}>
                <span className="lv-collision-chip" style={{ background: `#${collisionMaterialColor(material.slot).getHexString()}` }} aria-hidden="true" />
                <span className="lv-collision-name">{collisionMaterialLabel(material)}</span>
                <span className="lv-collision-count">{formatCount(material.triangles + material.shapes)}</span>
              </li>
            ))}
          </ul>
          {materials.length > shown.length ? (
            <p className="lv-collision-note">{materials.length - shown.length} more materials</p>
          ) : null}
          {data.truncated ? <p className="lv-collision-note">Very large; only part of it is shown.</p> : null}
          {data.warnings.slice(0, 2).map((warning) => (
            <p key={warning} className="lv-collision-note">{warning}</p>
          ))}
          <label className="lv-collision-toggle">
            <span>Show the model</span>
            <Toggle checked={showModel} onChange={onShowModelChange} ariaLabel="Show the model with its collisions" />
          </label>
        </>
      ) : info?.status === "error" ? (
        <p className="lv-collision-note is-error">{info.error || "The collisions couldn't be read."}</p>
      ) : (
        <p className="lv-collision-note">
          {info?.status === "loading" ? <Loader2 className="lv-collision-spin" aria-hidden="true" /> : null}
          {COLLISION_NOTES[info?.status] || COLLISION_NOTES.loading}
        </p>
      )}
    </section>
  );
}

/* ─── Inspector ─── */

export function InspectorTabs({ tabs, active, onChange }) {
  const listRef = useRef(null);
  useEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector(".lv-tab.is-active");
    if (!tab || list.scrollWidth <= list.clientWidth) return;
    const bounds = list.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    if (rect.left < bounds.left) list.scrollLeft -= bounds.left - rect.left + 12;
    else if (rect.right > bounds.right) list.scrollLeft += rect.right - bounds.right + 12;
  }, [active]);
  const labels = tabs.map((tab) => tab.label).join("|");
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const fit = () => {
      list.classList.remove("is-tight");
      list.classList.toggle("is-tight", list.scrollWidth > list.clientWidth);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(list);
    return () => observer.disconnect();
  }, [labels]);
  return (
    <div className="lv-tabs" role="tablist" aria-label="Inspector sections" ref={listRef}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className={`lv-tab ${active === tab.id ? "is-active" : ""}`}
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function SurfaceSection({ s }) {
  return (
    <section className="lv-group" id="panel-materials">
      <h3 className="lv-group-title">Surface</h3>
      <div className="lv-seg" role="radiogroup" aria-label="Surface type">
        {SURFACES.map((surface) => (
          <button
            key={surface.id}
            type="button"
            role="radio"
            aria-checked={s.materialType === surface.id}
            className={`lv-seg-btn ${s.materialType === surface.id ? "is-on" : ""}`}
            onClick={() => s.setMaterialType(surface.id)}
          >
            {surface.label}
          </button>
        ))}
      </div>
      <Slider id="lv-mat-light" label="Light response" value={s.matLightIntensity} min={0} max={3} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={s.setMatLightIntensity} />
      <Slider id="lv-mat-gloss" label="Gloss" value={s.matGlossiness} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={s.setMatGlossiness} />
      <Slider id="lv-mat-rough" label="Roughness" value={s.matRoughness} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={s.setMatRoughness} />
      <Slider id="lv-mat-coat" label="Clearcoat" value={s.matClearcoat} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={s.setMatClearcoat} />
      {s.materialTextures ? (
        <div className="lv-maps">
          <span className="cx-label">Texture maps</span>
          <div className="lv-maps-grid">
            {s.materialTextures.map((texture, index) => (
              <div key={texture.id || index} className="lv-map" title={texture.name}>
                {texture.thumbnail ? (
                  <img src={texture.thumbnail} alt="" />
                ) : (
                  <span className="lv-map-ext">{(texture.name || "").split(".").pop().toUpperCase()}</span>
                )}
                <span className="lv-map-name">{texture.name}</span>
                <button
                  type="button"
                  className="lv-map-remove"
                  onClick={() => s.removeMaterialTexture(index)}
                  aria-label={`Remove ${texture.name || "texture map"}`}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            ))}
            {s.materialTextures.length < 6 ? (
              <button type="button" className="lv-map lv-map-add" onClick={s.selectMaterialTexture}>
                <ImagePlus aria-hidden="true" />
                <span>Add map</span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

const SHOWROOM_LIGHT_OPTIONS = [
  { id: "top", label: "Top" },
  { id: "front", label: "Front" },
  { id: "back", label: "Back" },
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
];

/** Showroom floor finish picker, three finishes to a row. */
export function FloorField({ id, value, onChange }) {
  return (
    <div className="lv-field">
      <span className="cx-label" id={id}>Floor</span>
      <div className="lv-seg lv-seg-grid" role="radiogroup" aria-labelledby={id}>
        {SHOWROOM_FLOORS.map((floor) => (
          <button
            key={floor}
            type="button"
            role="radio"
            aria-checked={value === floor}
            className={`lv-seg-btn ${value === floor ? "is-on" : ""}`}
            onClick={() => onChange(floor)}
          >
            {SHOWROOM_FLOOR_LABELS[floor]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Stage controls. `notes` overrides the stage descriptions; `children` adds showroom-only controls. */
export function StageSection({ s, notes, children }) {
  const showroom = s.stage === "showroom";
  return (
    <section className="lv-group" id="panel-stage">
      <h3 className="lv-group-title">Stage</h3>
      <div className="lv-seg" role="radiogroup" aria-label="Stage">
        {[
          { id: "workbench", label: "Workbench" },
          { id: "showroom", label: "Showroom" },
        ].map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={s.stage === option.id}
            className={`lv-seg-btn ${s.stage === option.id ? "is-on" : ""}`}
            onClick={() => s.setStage(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="lv-slot-note">
        {showroom
          ? notes?.showroom ?? "Parked in a dark studio under one spotlight, on the floor you pick. Captures use it too."
          : notes?.workbench ?? "Your backdrop colour or image, with the grid and shadows from the deck."}
      </p>
      {showroom ? (
        <>
          <div className="lv-field">
            <span className="cx-label" id="lv-stage-light-label">Light from</span>
            <div className="lv-seg" role="radiogroup" aria-labelledby="lv-stage-light-label">
              {SHOWROOM_LIGHT_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={s.stageLight === option.id}
                  className={`lv-seg-btn ${s.stageLight === option.id ? "is-on" : ""}`}
                  onClick={() => s.setStageLight(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <Slider id="lv-stage-spot" label="Spotlight" value={s.stageSpot} min={0} max={2} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={s.setStageSpot} />
          <Slider id="lv-stage-reflect" label="Floor reflections" value={s.stageReflect} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={s.setStageReflect} />
          <div className="lv-toggle-row">
            <span>Light beam</span>
            <Toggle checked={s.stageBeam} onChange={s.setStageBeam} ariaLabel="Show the spotlight beam" />
          </div>
          {children}
        </>
      ) : null}
    </section>
  );
}

export function BackdropSection({ s }) {
  if (s.stage === "showroom") return null;
  return (
    <section className="lv-group">
      <h3 className="lv-group-title">Backdrop</h3>
      <div className="lv-colors">
        <ColorLine
          label="Background"
          value={s.backgroundColor}
          onChange={s.setBackgroundColor}
          onReset={() => s.setBackgroundColor(s.defaultBg)}
        />
      </div>
      {s.backgroundImagePath ? (
        <div className="lv-backdrop-file">
          <FileCard path={s.backgroundImagePath} />
          <div className="lv-slot-actions">
            <button type="button" className="cx-btn lv-btn-sm" onClick={s.selectBackgroundImage}>Replace</button>
            <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={s.clearBackgroundImage}>Remove</button>
          </div>
          <Slider id="lv-bg-blur" label="Blur" value={s.backgroundImageBlur} min={0} max={s.maxBackgroundBlur} step={1} format={(v) => `${v}px`} onChange={s.setBackgroundImageBlur} />
        </div>
      ) : (
        <button type="button" className="lv-drop lv-drop--inline" onClick={s.selectBackgroundImage}>
          <span className="lv-drop-title">
            <ImagePlus aria-hidden="true" />
            Add a background image
          </span>
        </button>
      )}
    </section>
  );
}

export function LightSection({ s }) {
  return (
    <section className="lv-group lv-lighting" id="panel-scene-lighting">
      <div className="lv-group-head">
        <h3 className="lv-group-title">Light</h3>
        <button type="button" className="lv-link" onClick={s.resetLighting}>Reset</button>
      </div>
      <LightDome
        azimuth={s.lightAzimuth}
        elevation={s.lightElevation}
        onAzimuthChange={s.handleLightAzimuthChange}
        onElevationChange={s.handleLightElevationChange}
      />
      <Slider id="lv-light" label="Intensity" value={s.lightIntensity} min={0} max={3} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={s.handleLightIntensityChange} />
    </section>
  );
}

/** `subject` names what spins: "vehicle" or, in EUP, "clothing". */
export function TurntableSection({ s, subject = "vehicle" }) {
  const noun = subject === "vehicle" ? "the vehicle" : subject;
  const Noun = noun[0].toUpperCase() + noun.slice(1);
  return (
    <section className="lv-group" id="panel-turntable">
      <h3 className="lv-group-title">Turntable</h3>
      <div className="lv-toggle-row">
        <span>Spin {noun}</span>
        <Toggle checked={s.turntable} onChange={s.setTurntable} ariaLabel={`Spin ${noun} on a turntable`} />
      </div>
      <Slider
        id="lv-turntable-speed"
        label="Speed"
        value={s.turntableSpeed}
        min={TURNTABLE_MIN_SPEED}
        max={TURNTABLE_MAX_SPEED}
        step={1}
        format={(v) => `${Math.round(v)}°/s`}
        onChange={s.setTurntableSpeed}
      />
      <p className="lv-slot-note">{Noun} turns in place under the lights. Turned off, it settles back facing forward.</p>
    </section>
  );
}

export function CameraSection({ children }) {
  return (
    <section className="lv-group" id="panel-camera">
      <h3 className="lv-group-title">Camera</h3>
      <div className="lv-deck lv-deck--inline">{children}</div>
    </section>
  );
}
