import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { stat } from "@tauri-apps/plugin-fs";
import { CircleAlert, Download, ImageOff, RefreshCw, Trash2, Undo2, X } from "lucide-react";
import { DropButton } from "./parts";
import LiveryWriteDialog from "./LiveryWriteDialog";
import { inspectLiveryImage } from "../../lib/livery-image.js";
import {
  defaultLiveryPattern,
  fileNameOf,
  isLiveryImagePath,
  largestCopy,
  LIVERY_IMAGE_EXTENSIONS,
  liverySlots,
  liveryWriteLabel,
  MAX_LIVERY_NUMBER,
  parseLiveryPattern,
  planLiveryWrite,
  stageLiveryFiles,
} from "../../lib/livery-set.js";
import "./LiveriesPanel.css";

/* Liveries inspector (Vehicle mode): the vehicle's texture liveries as the
   game numbers them, with images staged to replace or add to them and
   existing ones marked for removal. Picking a livery previews it as the
   Livery step's texture. Writing goes through LiveryWriteDialog, which backs
   up and rewrites the vehicle's own texture dictionaries; nothing is written
   until the user confirms there. */

// Image sizes and thumbnails, read once per file version and shared by the
// panel and the dialog. Keyed by path; `stamp` is the file's mtime and size.
const imageCache = new Map();

export function useLiveryImages(paths) {
  const [, setVersion] = useState(0);
  const key = paths.join("\n");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // One at a time: each read holds a whole image in memory.
      for (const path of key ? key.split("\n") : []) {
        if (cancelled) return;
        let stamp = "";
        try {
          const info = await stat(path);
          stamp = `${info.mtime?.getTime?.() ?? ""}:${info.size}`;
        } catch (error) {
          imageCache.set(path, { status: "error", stamp: "", error: "the file is missing or cannot be read" });
          if (!cancelled) setVersion((value) => value + 1);
          continue;
        }
        const cached = imageCache.get(path);
        if (cached && cached.stamp === stamp && cached.status !== "loading") continue;
        imageCache.set(path, { status: "loading", stamp });
        if (!cancelled) setVersion((value) => value + 1);
        try {
          const image = await inspectLiveryImage(path);
          imageCache.set(path, { status: "ready", stamp, ...image });
        } catch (error) {
          imageCache.set(path, { status: "error", stamp, error: String(error?.message || error) });
        }
        if (!cancelled) setVersion((value) => value + 1);
      }
    })();
    return () => { cancelled = true; };
  }, [key]);
  return (path) => imageCache.get(path) || { status: "loading" };
}

function useLiveryDictionaries(modelPath, enabled) {
  const [state, setState] = useState({ status: "idle", list: [], error: "" });
  const [token, setToken] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle", list: [], error: "" });
      return undefined;
    }
    let cancelled = false;
    setState((current) => ({ status: "loading", list: current.list, error: "" }));
    invoke("livery_dictionaries", { modelPath })
      .then((result) => { if (!cancelled) setState({ status: "ready", list: result?.dictionaries || [], error: "" }); })
      .catch((error) => { if (!cancelled) setState({ status: "error", list: [], error: String(error?.message || error) }); });
    return () => { cancelled = true; };
  }, [enabled, modelPath, token]);
  const reload = useCallback(() => setToken((value) => value + 1), []);
  return { ...state, reload };
}

let nextItemId = 0;
const makeItemId = () => `l${Date.now().toString(36)}${(nextItemId += 1).toString(36)}`;

function samePath(a, b) {
  return Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();
}

export function Thumb({ image, label }) {
  if (image?.status === "ready" && image.thumb) return <img className="lv-liv-thumb" src={image.thumb} alt="" draggable={false} />;
  if (image?.status === "error") {
    return (
      <span className="lv-liv-thumb is-empty" title={`${label} could not be read`}>
        <ImageOff aria-hidden="true" />
      </span>
    );
  }
  return <span className="lv-liv-thumb is-loading" aria-hidden="true" />;
}

// What a slot's thumbnail shows: the staged image, else the smallest copy of
// the existing livery (the cheapest to decode).
function thumbPathOf(slot) {
  if (slot.item) return slot.item.path;
  const smallest = [...slot.existing].sort((a, b) => (a.texture.width || 0) - (b.texture.width || 0))[0];
  return smallest?.texture.path || "";
}

function slotDetail(slot, image) {
  const copy = largestCopy(slot);
  const size = copy?.texture.width ? `${copy.texture.width}` : "";
  if (slot.removed) return { tone: "remove", text: "Removed on write" };
  if (!slot.item) return { tone: "", text: ["In the vehicle", size].filter(Boolean).join(" · ") };
  const name = fileNameOf(slot.item.path);
  if (image?.status === "error") return { tone: "error", text: `${name} could not be read` };
  return { tone: "warn", text: name, status: ` · ${slot.existing.length ? "replaces" : "new"}` };
}

/** `head` renders above the list, inside the panel so its footer stays at the bottom. */
export default function LiveriesPanel({ s, head = null }) {
  const modelPath = s.modelPath;
  const isYft = /\.yft$/i.test(modelPath || "");
  const enabled = Boolean(s.isTauriRuntime && modelPath && isYft);
  const dictionaries = useLiveryDictionaries(modelPath, enabled);
  const set = s.liverySet || { pattern: "", items: [], removed: [] };
  const removed = set.removed || [];
  const signPrefix = s.gameLiveries ? s.gameLiveries.signPrefix ?? null : null;
  const pattern = set.pattern || defaultLiveryPattern({ signPrefix, dictionaries: dictionaries.list, modelPath });
  const parsed = parseLiveryPattern(pattern);
  const slots = liverySlots({ dictionaries: dictionaries.list, pattern: parsed, items: set.items, removed });
  // New images follow the liveries that stay, so one added after removing the
  // last livery takes its number and replaces it.
  const existingNumbers = slots.filter((slot) => slot.existing.length && !slot.removed).map((slot) => slot.number);
  const imageOf = useLiveryImages(enabled ? slots.map(thumbPathOf).filter(Boolean) : []);

  const [notes, setNotes] = useState([]);
  const [dropTarget, setDropTarget] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const rootRef = useRef(null);

  const stage = (paths, at = null) => {
    const { items, skipped } = stageLiveryFiles(set.items, paths, { taken: existingNumbers, at, makeId: makeItemId });
    // An image staged on a livery marked for removal replaces it instead.
    s.setLiverySet((current) => ({ ...current, items, removed: (current.removed || []).filter((number) => !items.some((item) => item.number === number)) }));
    setNotes(skipped.map((entry) => `${fileNameOf(entry.path)} ${entry.reason}.`));
  };

  const unstage = (id) => s.setLiverySet((current) => ({ ...current, items: current.items.filter((item) => item.id !== id) }));
  const toggleRemoved = (number) => s.setLiverySet((current) => {
    const marked = current.removed || [];
    return { ...current, removed: marked.includes(number) ? marked.filter((value) => value !== number) : [...marked, number].sort((a, b) => a - b) };
  });
  const clearStaged = () => {
    s.setLiverySet((current) => ({ ...current, items: [], removed: [] }));
    setNotes([]);
  };
  // A removal names one texture, so a new pattern drops the marks rather than
  // moving them to another texture of that number.
  const setPattern = (value) => s.setLiverySet((current) => ({ ...current, pattern: value, removed: [] }));

  const pickImages = async () => {
    try {
      const picked = await open({ multiple: true, filters: [{ name: "Livery images", extensions: LIVERY_IMAGE_EXTENSIONS }] });
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
      if (paths.length) stage(paths);
    } catch (error) {
      setNotes([`The file picker failed: ${error?.message || error}`]);
    }
  };

  // Native drops: Tauri hands over paths with the pointer position, so the
  // slot under the pointer decides whether an image replaces or adds.
  const latest = useRef({ stage, enabled });
  latest.current = { stage, enabled };
  useEffect(() => {
    if (!enabled) return undefined;
    let unlisten = null;
    let disposed = false;
    const targetAt = (position) => {
      const root = rootRef.current;
      if (!root || !position) return null;
      const scale = window.devicePixelRatio || 1;
      const element = document.elementFromPoint(position.x / scale, position.y / scale);
      if (!element || !root.contains(element)) return null;
      const row = element.closest("[data-livery-number]");
      return row ? Number(row.dataset.liveryNumber) : "end";
    };
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const { type, paths, position } = event.payload || {};
        if (type === "leave") {
          setDropTarget(null);
          return;
        }
        const target = targetAt(position);
        if (type === "enter" || type === "over") {
          setDropTarget(target);
          return;
        }
        if (type !== "drop") return;
        setDropTarget(null);
        if (target == null || !latest.current.enabled) return;
        const images = (paths || []).filter(isLiveryImagePath);
        if (!images.length) {
          setNotes(["Drop PNG, JPG, WebP, BMP, TIFF, PSD, PDN or DDS images to add liveries."]);
          return;
        }
        latest.current.stage(images, target === "end" ? null : target);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);

  if (!s.isTauriRuntime) return <p className="lv-slot-note">Writing liveries needs the desktop app.</p>;
  if (!modelPath) return <p className="lv-slot-note">Load a vehicle to see its liveries.</p>;
  if (!isYft) return <>{head}<p className="lv-slot-note">Liveries are written for a .yft vehicle model.</p></>;

  const sources = Object.fromEntries(set.items.map((item) => {
    const image = imageOf(item.path);
    if (image.status === "ready") return [item.id, { width: image.width, height: image.height }];
    if (image.status === "error") return [item.id, { error: image.error }];
    return [item.id, null];
  }).filter(([, value]) => value));
  const plan = planLiveryWrite({ modelPath, dictionaries: dictionaries.list, pattern, items: set.items, removed, sources, signPrefix });

  const preview = (slot) => {
    const path = slot.item ? slot.item.path : largestCopy(slot)?.texture.path;
    if (path) s.onApplyMetaLivery(path);
  };
  const isShown = (slot) => {
    if (!s.texturePath) return false;
    if (slot.item) return samePath(slot.item.path, s.texturePath);
    return slot.existing.some((entry) => samePath(entry.texture.path, s.texturePath));
  };
  // The Livery step's image, when it is not already one of these liveries.
  const loaded = s.texturePath && isLiveryImagePath(s.texturePath)
    && !slots.some((slot) => isShown(slot)) && !/[\\/]ytd-cache[\\/]/i.test(s.texturePath)
    ? s.texturePath
    : "";
  const highest = Math.max(0, ...slots.filter((slot) => !slot.removed).map((slot) => slot.number));
  const nextNumber = highest + 1;
  const count = set.items.length;
  const removals = plan.removals.length;
  const changes = count + removals;
  const kept = slots.filter((slot) => !slot.removed).length;
  const targets = plan.files.map((file) => file.name);
  const backupNote = !changes ? "Add images to write them into the vehicle's own texture dictionaries."
    : targets.length === 2 ? "Both .ytd files are backed up first."
      : targets.length ? `${targets.join(", ")} ${targets.length === 1 ? "is" : "are"} backed up first.` : "";

  return (
    <div className={`lv-liveries ${dropTarget === "end" ? "is-drop-end" : ""}`} ref={rootRef}>
      {head}
      <section className="lv-group" id="panel-liveries">
        <div className="lv-group-head">
          <h3 className="lv-group-title">In game</h3>
          <span className="lv-liv-count">
            {changes ? `${kept} after write` : `${slots.length} ${slots.length === 1 ? "livery" : "liveries"}`}
          </span>
        </div>

        <label className="lv-liv-names">
          <span className="lv-liv-names-label">Names</span>
          <input
            className={`lv-liv-input ${parsed.error ? "is-invalid" : ""}`}
            value={pattern}
            spellCheck={false}
            onChange={(event) => setPattern(event.target.value)}
            aria-invalid={Boolean(parsed.error)}
            aria-describedby={parsed.error ? "lv-liv-names-error" : undefined}
            title="Texture names, with # where the livery number goes"
          />
        </label>
        {parsed.error ? <p id="lv-liv-names-error" className="lv-slot-note is-error"><span>{parsed.error}</span></p> : null}

        {dictionaries.status === "loading" && !dictionaries.list.length ? <p className="lv-slot-note is-busy">Reading the vehicle's texture dictionaries…</p> : null}
        {dictionaries.status === "error" ? (
          <p className="lv-slot-note is-error">
            <span>{`The texture dictionaries couldn't be read: ${dictionaries.error}`}</span>
            <button type="button" className="lv-link lv-native-retry" onClick={dictionaries.reload}>
              <RefreshCw aria-hidden="true" />
              Retry
            </button>
          </p>
        ) : null}
        {dictionaries.status === "ready" && !dictionaries.list.length ? (
          <p className="lv-slot-note"><span>{`${fileNameOf(modelPath)} has no texture dictionary of its own beside it, so liveries cannot be written.`}</span></p>
        ) : null}

        {slots.length ? (
          <ul className="lv-liv-rows" aria-label="Liveries">
            {slots.map((slot) => {
              const image = imageOf(thumbPathOf(slot));
              const detail = slotDetail(slot, slot.item ? image : null);
              const shown = isShown(slot);
              return (
                <li
                  key={slot.number}
                  className={`lv-liv-row ${shown ? "is-selected" : ""} ${slot.removed ? "is-removed" : ""} ${dropTarget === slot.number ? "is-drop" : ""}`}
                  data-livery-number={slot.number}
                >
                  <button type="button" className="lv-liv-main" onClick={() => preview(slot)} aria-pressed={shown}
                    title={slot.item ? `Preview ${fileNameOf(slot.item.path)} as livery ${slot.number}` : `Preview livery ${slot.number}`}>
                    <span className="lv-liv-number cx-display">{slot.number}</span>
                    <Thumb image={image} label={slot.item ? fileNameOf(slot.item.path) : slot.name} />
                    <span className="lv-liv-text">
                      <span className="lv-liv-name" title={slot.name}>{slot.name}</span>
                      <span className={`lv-liv-sub ${detail.tone ? `is-${detail.tone}` : ""}`}
                        title={slot.item && image.status === "error" ? `${slot.item.path}: ${image.error}` : slot.item?.path}>
                        {detail.tone ? <span className="lv-dot" aria-hidden="true" /> : null}
                        <span className="lv-liv-sub-line">
                          <span className="lv-liv-sub-text">{detail.text}</span>
                          {detail.status ? <span className="lv-liv-sub-status">{detail.status}</span> : null}
                        </span>
                      </span>
                    </span>
                  </button>
                  {slot.item ? (
                    <button type="button" className="cx-icon-btn lv-liv-remove" onClick={() => unstage(slot.item.id)}
                      aria-label={`Don't write ${fileNameOf(slot.item.path)}`} title={`Don't write ${fileNameOf(slot.item.path)}`}>
                      <X aria-hidden="true" />
                    </button>
                  ) : (
                    <button type="button" className="cx-icon-btn lv-liv-remove" onClick={() => toggleRemoved(slot.number)} aria-pressed={slot.removed}
                      aria-label={slot.removed ? `Keep livery ${slot.number}` : `Remove livery ${slot.number}`}
                      title={slot.removed ? `Keep livery ${slot.number}` : `Remove livery ${slot.number} from the vehicle when you write`}>
                      {slot.removed ? <Undo2 aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : dictionaries.status === "ready" && dictionaries.list.length ? (
          <p className="lv-slot-note"><span>{`No ${parsed.error ? "liveries" : parsed.nameFor("N")} textures yet. Add images to make liveries 1, 2, 3…`}</span></p>
        ) : null}

        {highest < MAX_LIVERY_NUMBER ? (
          <DropButton
            title="Add liveries"
            hint={`Drop images to add them as ${nextNumber}, ${nextNumber + 1} and on. Drop one on a livery to replace it.`}
            onClick={pickImages}
          />
        ) : null}
        {loaded && highest < MAX_LIVERY_NUMBER ? (
          <button type="button" className="lv-link lv-liv-add-loaded" onClick={() => stage([loaded])}>
            {`Add ${fileNameOf(loaded)} as livery ${nextNumber}`}
          </button>
        ) : null}
        {notes.map((note) => (
          <p key={note} className="lv-slot-note is-warn">
            <CircleAlert aria-hidden="true" className="lv-liv-note-icon" />
            <span>{note}</span>
          </p>
        ))}
      </section>

      <div className="lv-liv-foot">
        <button type="button" className="cx-btn is-primary lv-liv-write" disabled={!changes || dictionaries.status !== "ready"}
          onClick={() => setDialogOpen(true)}
          title={!changes ? "Stage images or mark liveries to remove first" : `Check, then ${liveryWriteLabel(count, removals).toLowerCase()}`}>
          <Download aria-hidden="true" />
          {changes ? `${liveryWriteLabel(count, removals)}…` : "Write liveries…"}
        </button>
        {changes ? (
          <div className="lv-liv-foot-row">
            <p className="lv-liv-foot-note">{backupNote}</p>
            <button type="button" className="lv-link" onClick={clearStaged}>Clear</button>
          </div>
        ) : <p className="lv-liv-foot-note">{backupNote}</p>}
      </div>

      {dialogOpen ? (
        <LiveryWriteDialog
          s={s}
          plan={plan}
          items={set.items}
          onClose={() => setDialogOpen(false)}
          onWritten={() => {
            s.setLiverySet((current) => ({ ...current, items: [], removed: [] }));
            setNotes([]);
            dictionaries.reload();
            return s.reloadModel?.();
          }}
        />
      ) : null}
    </div>
  );
}
