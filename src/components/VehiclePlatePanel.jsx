import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ImagePlus, Shuffle } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { FileCard, SelectField } from "./workspace/parts";
import { loadPlateAssets } from "../lib/license-plate-assets.js";
import {
  PLATE_IMAGE_EXTENSIONS,
  PLATE_MAX_LENGTH,
  PLATE_STYLE_NAMES,
  normalizePlateImage,
  normalizePlateText,
} from "../lib/license-plate.js";
import "./VehicleLightsPanel.css";

// Plate style, text and optional custom background image for the loaded
// vehicle. Styles and fonts come from the game files through the bridge; the
// viewer draws the result on the model. The user's image is only read.

function randomPlateText() {
  const digit = () => String(Math.floor(Math.random() * 10));
  const letter = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `${digit()}${digit()}${letter()}${letter()}${letter()}${digit()}${digit()}${digit()}`;
}

export default function VehiclePlatePanel({ plate, onChange, status, isTauriRuntime, hasPlate }) {
  const [styles, setStyles] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [dropped, setDropped] = useState(false);
  const [pickError, setPickError] = useState("");

  useEffect(() => {
    if (!isTauriRuntime) return undefined;
    let cancelled = false;
    loadPlateAssets(invoke)
      .then(({ definitions }) => { if (!cancelled) { setStyles(definitions.plates); setLoadError(""); } })
      .catch((error) => { if (!cancelled) setLoadError(String(error?.message || error)); });
    return () => { cancelled = true; };
  }, [isTauriRuntime]);

  const text = plate?.text ?? "";
  const style = plate?.style ?? 0;
  const options = styles || PLATE_STYLE_NAMES.map((name, index) => ({ index, name }));
  const unavailable = !isTauriRuntime
    ? "Plates are drawn from your GTA V files, which the desktop app reads."
    : !hasPlate ? "This model has no license plate mesh." : loadError;
  const error = unavailable || pickError || (status && !status.ok ? status.error : "");
  const image = normalizePlateImage(plate?.image);

  const pickImage = async () => {
    setPickError("");
    try {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Plate image", extensions: [...PLATE_IMAGE_EXTENSIONS] }],
      });
      // A new stamp redraws the plate even when the same file is picked again after editing.
      if (typeof path === "string" && path) onChange?.({ image: { path, stamp: Date.now() } });
    } catch (pickFailure) {
      setPickError(`Couldn't open the file picker: ${pickFailure?.message || pickFailure}`);
    }
  };

  return (
    <section className="vl-root" aria-label="License plate">
      <header className="vl-head">
        <h3 className="vl-title">Plate</h3>
        <span className="vl-count">{normalizePlateText(text).length}/{PLATE_MAX_LENGTH}</span>
      </header>
      <div className="vl-plate-image">
        <span className="cx-label">Image</span>
        {image ? (
          <>
            <FileCard path={image.path} />
            <div className="lv-slot-actions">
              <button type="button" className="cx-btn lv-btn-sm" onClick={pickImage} disabled={Boolean(unavailable)}>Replace</button>
              <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={() => { setPickError(""); onChange?.({ image: null }); }}>
                Remove
              </button>
            </div>
            <span className="vl-plate-hint">The style below sets the text colour and position. Clear the text for an image-only plate.</span>
          </>
        ) : (
          <button type="button" className="lv-drop lv-drop--inline" onClick={pickImage} disabled={Boolean(unavailable)}>
            <span className="lv-drop-title">
              <ImagePlus aria-hidden="true" />
              Import a plate image
            </span>
            <span className="lv-drop-hint">PNG, JPG, WebP or DDS. Replaces the style's background.</span>
          </button>
        )}
      </div>
      <SelectField label={image ? "Text style" : "Style"}>
        <Select value={String(style)} onValueChange={(value) => onChange?.({ style: Number(value) })} disabled={Boolean(unavailable)}>
          <SelectTrigger aria-label="Plate style">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((entry) => (
              <SelectItem key={entry.index} value={String(entry.index)}>{entry.index} · {entry.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SelectField>
      <div className="vl-plate-text">
        <label className="cx-label" htmlFor="vl-plate-input">Text</label>
        <div className="vl-plate-row">
          <input
            id="vl-plate-input"
            className="vl-plate-input"
            value={text}
            maxLength={PLATE_MAX_LENGTH}
            spellCheck={false}
            autoComplete="off"
            disabled={Boolean(unavailable)}
            onChange={(event) => {
              const next = normalizePlateText(event.target.value);
              setDropped(next !== event.target.value.toUpperCase().slice(0, PLATE_MAX_LENGTH));
              onChange?.({ text: next });
            }}
          />
          <button
            type="button"
            className="cx-icon-btn"
            onClick={() => { setDropped(false); onChange?.({ text: randomPlateText() }); }}
            disabled={Boolean(unavailable)}
            aria-label="Random plate text"
            title="Random plate in the game's format"
          >
            <Shuffle aria-hidden="true" />
          </button>
        </div>
        <span className={dropped ? "vl-plate-hint is-warn" : "vl-plate-hint"}>
          {dropped ? "Plates only take A-Z, 0-9 and spaces." : "Up to 8 characters. Shorter text is centred, as in game."}
        </span>
      </div>
      {error ? <p className="vl-muted vl-plate-error" role="status">{error}</p> : null}
    </section>
  );
}
