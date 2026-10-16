import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ImagePlus, Trash2 } from "lucide-react";
import { Toggle } from "./ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { ColorField } from "./SettingsColorField";
import { Segmented, SliderRow } from "./SettingsControls";
import {
  DEFAULT_WATERMARK,
  WATERMARK_ANCHORS,
  WATERMARK_FONTS,
  WATERMARK_IMAGE_ACCEPT,
  WATERMARK_KINDS,
  WATERMARK_PRESETS,
  WATERMARK_STYLES,
  WATERMARK_WEIGHTS,
  importWatermarkImage,
  normalizeWatermarkConfig,
  renderWatermarkPreviewCanvas,
  resolveWatermarkContent,
} from "../lib/watermark";

const PREVIEW_WIDTH = 1280;
const PREVIEW_HEIGHT = 720;

function presetIsActive(preset, cfg) {
  return Object.entries(preset.patch).every(([key, value]) => cfg[key] === value);
}

/**
 * Watermark section of Settings. Edits the draft only; Settings' Save writes it.
 */
export default function WatermarkSettings({ value, onChange }) {
  const cfg = normalizeWatermarkConfig(value);
  // Hex fields show the raw draft so a half-typed color is not snapped back.
  const raw = value && typeof value === "object" ? value : {};
  const content = resolveWatermarkContent(cfg);
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const renderTokenRef = useRef(0);
  const [backdrop, setBackdrop] = useState("dark");
  const [importState, setImportState] = useState({ busy: false, error: "" });

  const update = useCallback((patch) => onChange({ ...cfg, ...patch }), [cfg, onChange]);

  // Rendered offscreen, then copied if it is still the newest request.
  const cfgKey = JSON.stringify({ ...cfg, image: cfg.image ? cfg.image.dataUrl.length + cfg.image.name : null });
  useEffect(() => {
    const token = ++renderTokenRef.current;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const frame = await renderWatermarkPreviewCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT, cfg, { backdrop });
        if (cancelled || token !== renderTokenRef.current) return;
        const ctx = canvasRef.current?.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
        ctx.drawImage(frame, 0, 0);
      } catch (err) {
        console.error("[Watermark] Preview failed:", err);
      }
    }, 40);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // cfgKey stands in for cfg so the large logo data URL is not compared per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgKey, backdrop]);

  const handleImport = async (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setImportState({ busy: true, error: "" });
    try {
      const image = await importWatermarkImage(file);
      update({ image, kind: cfg.kind === "text" ? "image" : cfg.kind });
      setImportState({ busy: false, error: "" });
    } catch (err) {
      setImportState({ busy: false, error: err?.message || "Could not import that image." });
    }
  };

  const fontMeta = WATERMARK_FONTS.find((font) => font.value === cfg.font);
  const fontOptions = fontMeta ? WATERMARK_FONTS : [{ value: cfg.font, label: cfg.font }, ...WATERMARK_FONTS];
  const usesText = cfg.kind !== "image";
  const usesImage = cfg.kind !== "text";
  const isTiled = cfg.position === "tiled";

  let statusText = "Off. Captures are saved without a watermark.";
  if (cfg.enabled && content.isEmpty) {
    statusText = cfg.kind === "text" ? "On, but the text is empty, so nothing is added." : "On, but no logo is imported yet, so nothing is added.";
  } else if (cfg.enabled) {
    statusText = "On. Added to every preview capture.";
  }

  return (
    <div className="settings-stack settings-wm">
      <section className="settings-panel settings-wm-stage" aria-label="Watermark preview and presets">
        <div className="settings-wm-preview-col">
          <div className="settings-panel-heading-row">
            <div className="settings-panel-title">Preview</div>
            <Segmented
              label="Preview backdrop"
              value={backdrop}
              onChange={setBackdrop}
              options={[{ value: "dark", label: "Dark scene" }, { value: "light", label: "Light scene" }]}
            />
          </div>
          <div className={`settings-wm-canvas-wrap ${cfg.enabled ? "" : "is-off"}`.trim()}>
            <canvas
              ref={canvasRef}
              width={PREVIEW_WIDTH}
              height={PREVIEW_HEIGHT}
              className="settings-wm-canvas"
              role="img"
              aria-label="Watermark preview on a 16:9 capture"
            />
          </div>
          <div className="settings-wm-status" role="status">
            <span className={`settings-wm-dot ${cfg.enabled && !content.isEmpty ? "is-on" : content.isEmpty && cfg.enabled ? "is-warn" : ""}`} aria-hidden="true" />
            <span>{statusText}</span>
            <span className="settings-wm-res">16:9 preview, sizes scale with the capture</span>
          </div>
        </div>

        <div className="settings-wm-presets">
          <div className="settings-panel-title">Presets</div>
          <div className="settings-wm-preset-list" role="list">
            {WATERMARK_PRESETS.map((preset) => {
              const blocked = preset.needsImage && !cfg.image;
              const active = !blocked && presetIsActive(preset, cfg);
              return (
                <button
                  key={preset.id}
                  type="button"
                  role="listitem"
                  className={`settings-wm-preset ${active ? "is-selected" : ""}`}
                  onClick={() => update(preset.patch)}
                  disabled={blocked}
                  aria-pressed={active}
                  title={blocked ? "Import a logo first" : preset.description}
                >
                  <span className="settings-wm-preset-name">{preset.label}</span>
                  <span className="settings-wm-preset-desc">
                    {blocked ? "Import a logo to use this" : preset.description}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section className="settings-panel">
        <div className="settings-panel-title">Watermark</div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-title">Stamp captures</div>
            <div className="settings-row-desc">Add the watermark to photos, saved views, captured angles and render shots. Textures, templates, videos, EUP thumbnails and Prop Studio image exports stay unmarked.</div>
          </div>
          <Toggle checked={cfg.enabled} onChange={(enabled) => update({ enabled })} ariaLabel="Stamp captures with the watermark" />
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-title">Content</div>
            <div className="settings-row-desc">Text, your own logo, or both side by side</div>
          </div>
          <Segmented label="Watermark content" options={WATERMARK_KINDS} value={cfg.kind} onChange={(kind) => update({ kind })} />
        </div>
        {usesText ? (
          <div className="settings-row">
            <div className="settings-row-label">
              <div className="settings-row-title">Text</div>
              <div className="settings-row-desc">Your name, studio, or a copyright line</div>
            </div>
            <input
              className="settings-input"
              value={cfg.text}
              maxLength={120}
              onChange={(event) => update({ text: event.currentTarget.value })}
              placeholder="© Your name"
              aria-label="Watermark text"
            />
          </div>
        ) : null}
        {usesImage ? (
          <>
            <div className="settings-row settings-wm-logo-row">
              <div className="settings-row-label">
                <div className="settings-row-title">Logo</div>
                <div className="settings-row-desc">PNG, WebP, SVG, or JPEG. Transparent PNGs look cleanest. A copy is kept in your settings; the original file is not changed.</div>
              </div>
              <div className="settings-wm-logo">
                {cfg.image ? (
                  <div className="settings-wm-logo-card">
                    <span className={`settings-wm-logo-thumb is-${backdrop}`}>
                      <img src={cfg.image.dataUrl} alt="" draggable={false} />
                    </span>
                    <span className="settings-wm-logo-copy">
                      <span className="settings-wm-logo-name" title={cfg.image.name}>{cfg.image.name}</span>
                      <span className="settings-wm-logo-meta">{cfg.image.width} × {cfg.image.height}</span>
                    </span>
                  </div>
                ) : null}
                <div className="settings-row-actions">
                  <button
                    type="button"
                    className="settings-mini"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={importState.busy}
                  >
                    <ImagePlus aria-hidden="true" />
                    {importState.busy ? "Importing…" : cfg.image ? "Replace" : "Import logo"}
                  </button>
                  {cfg.image ? (
                    <button
                      type="button"
                      className="settings-mini is-danger"
                      onClick={() => update({ image: null })}
                      aria-label="Remove logo"
                    >
                      <Trash2 aria-hidden="true" />
                      Remove
                    </button>
                  ) : null}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={WATERMARK_IMAGE_ACCEPT}
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={handleImport}
                />
              </div>
            </div>
            {importState.error ? (
              <div className="settings-row-error settings-wm-error" role="alert">
                <AlertCircle aria-hidden="true" />
                {importState.error}
              </div>
            ) : null}
            <div className="settings-row">
              <div className="settings-row-label">
                <div className="settings-row-title">Match watermark color</div>
                <div className="settings-row-desc">Fill the logo with the watermark color, for one-color marks</div>
              </div>
              <Toggle checked={cfg.imageTint} onChange={(imageTint) => update({ imageTint })} ariaLabel="Fill the logo with the watermark color" />
            </div>
            {cfg.kind === "image" ? (
              <SliderRow
                title="Logo size"
                desc="Height as a share of the image's short side"
                min={2}
                max={40}
                step={0.5}
                value={cfg.imageSize}
                onChange={(imageSize) => update({ imageSize })}
                format={(v) => `${v.toFixed(1)}%`}
              />
            ) : null}
          </>
        ) : null}
      </section>

      {usesText ? (
        <section className="settings-panel">
          <div className="settings-panel-title">Type</div>
          <div className="settings-row">
            <div className="settings-row-label">
              <div className="settings-row-title">Font</div>
            </div>
            <Select value={cfg.font} onValueChange={(font) => update({ font })}>
              <SelectTrigger className="settings-select" aria-label="Watermark font"><SelectValue /></SelectTrigger>
              <SelectContent>
                {fontOptions.map((font) => (
                  <SelectItem key={font.value} value={font.value}>{font.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="settings-row">
            <div className="settings-row-label">
              <div className="settings-row-title">Weight</div>
            </div>
            <Segmented label="Font weight" options={WATERMARK_WEIGHTS} value={cfg.weight} onChange={(weight) => update({ weight })} />
          </div>
          <div className="settings-row">
            <div className="settings-row-label">
              <div className="settings-row-title">Italic</div>
              {fontMeta?.italicOnly ? <div className="settings-row-desc">{fontMeta.label} is italic only</div> : null}
            </div>
            <Toggle
              checked={cfg.italic || Boolean(fontMeta?.italicOnly)}
              onChange={(italic) => update({ italic })}
              disabled={Boolean(fontMeta?.italicOnly)}
              ariaLabel="Italic watermark text"
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-label">
              <div className="settings-row-title">Capitals</div>
              <div className="settings-row-desc">Set the text in uppercase</div>
            </div>
            <Toggle checked={cfg.uppercase} onChange={(uppercase) => update({ uppercase })} ariaLabel="Uppercase watermark text" />
          </div>
          <SliderRow
            title="Size"
            desc="Type height as a share of the image's short side"
            min={0.5}
            max={20}
            step={0.1}
            value={cfg.size}
            onChange={(size) => update({ size })}
            format={(v) => `${v.toFixed(1)}%`}
          />
          <SliderRow
            title="Letter spacing"
            min={0}
            max={30}
            step={1}
            value={cfg.letterSpacing}
            onChange={(letterSpacing) => update({ letterSpacing })}
            format={(v) => `${(v / 100).toFixed(2)}em`}
          />
        </section>
      ) : null}

      <section className="settings-panel">
        <div className="settings-panel-title">Style</div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-title">Finish</div>
            <div className="settings-row-desc">Shadow and plate keep marks readable on busy scenes</div>
          </div>
          <Segmented label="Watermark finish" options={WATERMARK_STYLES} value={cfg.style} onChange={(style) => update({ style })} />
        </div>
        <div className="settings-color-grid settings-wm-colors">
          <ColorField
            label={usesText ? "Color" : "Tint color"}
            value={typeof raw.color === "string" ? raw.color : cfg.color}
            onChange={(color) => update({ color })}
            onReset={() => update({ color: DEFAULT_WATERMARK.color })}
          />
          {cfg.style === "plate" ? (
            <ColorField
              label="Plate color"
              value={typeof raw.plateColor === "string" ? raw.plateColor : cfg.plateColor}
              onChange={(plateColor) => update({ plateColor })}
              onReset={() => update({ plateColor: DEFAULT_WATERMARK.plateColor })}
            />
          ) : null}
        </div>
        <SliderRow
          title="Opacity"
          min={0.05}
          max={1}
          step={0.01}
          value={cfg.opacity}
          onChange={(opacity) => update({ opacity })}
          format={(v) => `${Math.round(v * 100)}%`}
        />
      </section>

      <section className="settings-panel">
        <div className="settings-panel-title">Placement</div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-title">Position</div>
            <div className="settings-row-desc">Anchor to an edge or corner, or tile it across the image</div>
          </div>
          <div className="settings-wm-placement">
            <div className="settings-wm-grid" role="radiogroup" aria-label="Watermark anchor">
              {WATERMARK_ANCHORS.map((anchor) => (
                <button
                  key={anchor}
                  type="button"
                  role="radio"
                  aria-checked={cfg.position === anchor}
                  aria-label={anchor.replace("-", " ")}
                  title={anchor.replace("-", " ")}
                  className={`settings-wm-cell ${cfg.position === anchor ? "is-on" : ""}`}
                  onClick={() => update({ position: anchor })}
                >
                  <span aria-hidden="true" />
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`settings-wm-tile ${isTiled ? "is-on" : ""}`}
              aria-pressed={isTiled}
              onClick={() => update({ position: isTiled ? "bottom-right" : "tiled" })}
            >
              Tile
            </button>
          </div>
        </div>
        {isTiled ? (
          <SliderRow
            title="Tile spacing"
            min={20}
            max={400}
            step={5}
            value={cfg.tileGap}
            onChange={(tileGap) => update({ tileGap })}
            format={(v) => `${Math.round(v)}%`}
          />
        ) : (
          <SliderRow
            title="Edge margin"
            desc="Distance from the edge as a share of the short side"
            min={0}
            max={20}
            step={0.5}
            value={cfg.margin}
            onChange={(margin) => update({ margin })}
            format={(v) => `${v.toFixed(1)}%`}
          />
        )}
        <SliderRow
          title="Rotation"
          min={-180}
          max={180}
          step={1}
          value={cfg.rotation}
          onChange={(rotation) => update({ rotation: Math.round(rotation) })}
          format={(v) => `${Math.round(v)}°`}
        />
      </section>
    </div>
  );
}
