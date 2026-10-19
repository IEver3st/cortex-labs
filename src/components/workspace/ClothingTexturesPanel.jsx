import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { CircleAlert, Download, RefreshCw, X } from "lucide-react";
import { DropButton } from "./parts";
import { Thumb, useLiveryImages } from "./LiveriesPanel";
import ClothingWriteDialog from "./ClothingWriteDialog";
import { isLiveryImagePath, LIVERY_IMAGE_EXTENSIONS } from "../../lib/livery-set.js";
import {
  fileNameOf,
  groupClothingFiles,
  letterOf,
  MAX_ITEM_TEXTURES,
  planClothingTextureWrite,
  slotLabel,
  stageClothingTextures,
} from "../../lib/clothing-pack.js";
import { parsePedVariationXml } from "../../lib/ped-variation-xml.js";
import "./LiveriesPanel.css";

/* Textures inspector (EUP mode): the open clothing item's textures by letter,
   as the game numbers them, with images staged to replace them or to add more.
   Picking one previews it as the Uniform step's texture. Writing goes through
   ClothingWriteDialog, which backs up and rewrites the item's own texture files
   and its pack's .ymt; nothing is written until the user confirms there. */

function useClothingItem(drawablePath, enabled) {
  const [state, setState] = useState({ status: "idle", path: "", data: null, error: "" });
  const [token, setToken] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle", path: "", data: null, error: "" });
      return undefined;
    }
    let cancelled = false;
    // A reload keeps showing the item; another item never shows this one's textures.
    setState((current) => ({ status: "loading", path: drawablePath, data: current.path === drawablePath ? current.data : null, error: "" }));
    // A restored session reopens the item without the picker, so its resource
    // is allowed again, as Vehicle mode does for a restored model.
    invoke("allow_model_resource", { path: drawablePath })
      .catch(() => {})
      .then(() => invoke("clothing_item", { drawablePath }))
      .then((data) => { if (!cancelled) setState({ status: "ready", path: drawablePath, data, error: "" }); })
      .catch((error) => { if (!cancelled) setState({ status: "error", path: drawablePath, data: null, error: String(error?.message || error) }); });
    return () => { cancelled = true; };
  }, [drawablePath, enabled, token]);
  const reload = useCallback(() => setToken((value) => value + 1), []);
  return { ...state, reload };
}

let nextItemId = 0;
const makeItemId = () => `c${Date.now().toString(36)}${(nextItemId += 1).toString(36)}`;

const samePath = (a, b) => Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();

// The item as the planner reads it, from the host's listing. A name without a
// pack carries no ped; the fallback only names new files, which such an item
// cannot add.
function itemFrom(drawablePath, data) {
  const files = [{ path: drawablePath }, ...(data?.textures || []).map((texture) => ({ path: texture.path }))];
  return groupClothingFiles(files, { ped: "mp_m_freemode_01" }).packs[0]?.items.find((item) => samePath(item.drawable, drawablePath)) || null;
}

function rowDetail(row, image) {
  const size = row.texture?.width ? `${row.texture.width}` : "";
  if (!row.staged) {
    if (row.legacy === false) return { tone: "error", text: "Not a legacy GTA V texture file" };
    if (row.error) return { tone: "error", text: "Could not be read" };
    return { tone: "", text: ["In the item", size].filter(Boolean).join(" · ") };
  }
  const name = fileNameOf(row.staged.path);
  if (image?.status === "error") return { tone: "error", text: `${name} could not be read` };
  return { tone: "warn", text: name, status: ` · ${row.file ? "replaces" : "new"}` };
}

/** Rows by letter: the item's textures, then new ones staged after them. */
function textureRows(item, data, staged) {
  const byPath = new Map((data?.textures || []).map((texture) => [texture.path.toLowerCase(), texture]));
  const rows = new Map();
  for (const texture of item?.textures || []) {
    if (rows.has(texture.letter)) continue;
    const info = byPath.get(texture.path.toLowerCase());
    rows.set(texture.letter, { letter: texture.letter, file: texture.path, legacy: info?.legacy, texture: info?.texture || null, error: info?.error || "", staged: null });
  }
  for (const entry of staged) {
    const row = rows.get(entry.letter) || { letter: entry.letter, file: null, legacy: null, texture: null, error: "", staged: null };
    rows.set(entry.letter, { ...row, staged: entry });
  }
  return [...rows.values()].sort((a, b) => a.letter.localeCompare(b.letter));
}

export default function ClothingTexturesPanel({ s }) {
  const drawablePath = s.modelPath;
  const isYdd = /\.ydd$/i.test(drawablePath || "");
  const enabled = Boolean(s.isTauriRuntime && drawablePath && isYdd);
  const listing = useClothingItem(drawablePath, enabled);
  const data = listing.data;
  const item = useMemo(() => (enabled && data ? itemFrom(drawablePath, data) : null), [enabled, data, drawablePath]);
  const staged = s.clothingSet?.items || [];
  const rows = textureRows(item, data, staged);
  const count = item ? new Set(item.textures.map((texture) => texture.letter)).size : 0;
  const imageOf = useLiveryImages(enabled ? rows.map((row) => row.staged?.path || row.texture?.file).filter(Boolean) : []);

  const model = useMemo(() => {
    if (!data?.ymt?.xml) return { value: null, error: data?.ymt?.error || "" };
    try {
      return { value: parsePedVariationXml(data.ymt.xml), error: "" };
    } catch (error) {
      return { value: null, error: String(error?.message || error) };
    }
  }, [data]);

  const [notes, setNotes] = useState([]);
  const [dropTarget, setDropTarget] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const rootRef = useRef(null);

  // Letters are numbered from the item's textures, so nothing is staged while they are read.
  const ready = listing.status === "ready";
  const stage = (paths, at = null) => {
    if (!item || !ready) return;
    const result = stageClothingTextures(staged, paths, { count, at, makeId: makeItemId });
    s.setClothingSet({ items: result.staged });
    setNotes(result.skipped.map((entry) => `${fileNameOf(entry.path)} ${entry.reason}.`));
  };
  const unstage = (id) => s.setClothingSet((current) => {
    const items = current.items.filter((entry) => entry.id !== id);
    // New textures close up behind a removed one, so their letters stay in a row.
    let next = count;
    return {
      ...current,
      items: items.map((entry) => (entry.letter.charCodeAt(0) - 97 < count ? entry : { ...entry, letter: letterOf(next++) })),
    };
  });
  const clearStaged = () => {
    s.setClothingSet(null);
    setNotes([]);
  };

  const pickImages = async () => {
    try {
      const picked = await open({ multiple: true, filters: [{ name: "Texture images", extensions: LIVERY_IMAGE_EXTENSIONS }] });
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
      if (paths.length) stage(paths);
    } catch (error) {
      setNotes([`The file picker failed: ${error?.message || error}`]);
    }
  };

  // Native drops, as in the Liveries tab: the row under the pointer decides
  // whether an image replaces that texture or adds a new one.
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
      const row = element.closest("[data-texture-letter]");
      return row ? row.dataset.textureLetter : "end";
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
          setNotes(["Drop PNG, JPG, WebP, BMP, TIFF, PSD, PDN or DDS images to add textures."]);
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

  if (!s.isTauriRuntime) return <p className="lv-slot-note">Writing clothing textures needs the desktop app.</p>;
  if (!drawablePath) return <p className="lv-slot-note">Load a clothing item to see its textures.</p>;
  if (!isYdd) return <p className="lv-slot-note">Textures are written for a .ydd clothing item.</p>;

  const sources = Object.fromEntries(staged.map((entry) => {
    const image = imageOf(entry.path);
    if (image.status === "ready") return [entry.id, { width: image.width, height: image.height }];
    if (image.status === "error") return [entry.id, { error: image.error }];
    return [entry.id, null];
  }).filter(([, value]) => value));
  const variants = Object.fromEntries((data?.textures || []).filter((texture) => !texture.error).map((texture) => [texture.path, { legacy: texture.legacy, texture: texture.texture }]));
  const plan = planClothingTextureWrite({ item, model: model.value, ymtPath: data?.ymt?.path || null, ymtXml: data?.ymt?.xml || null, variants, staged, sources });
  const readErrors = (data?.textures || []).filter((texture) => texture.error);
  const blockedBy = readErrors.length ? `${readErrors.map((texture) => fileNameOf(texture.path)).join(", ")} could not be read.` : "";

  const previewPath = (row) => row.staged?.path || row.texture?.file || "";
  const preview = (row) => {
    const path = previewPath(row);
    if (path) s.onApplyMetaLivery(path);
  };
  const shown = (row) => samePath(previewPath(row), s.texturePath);
  // The Uniform step's image, when it is not already one of these textures.
  const loaded = s.texturePath && isLiveryImagePath(s.texturePath) && !rows.some((row) => shown(row)) && !/[\\/]ytd-cache[\\/]/i.test(s.texturePath)
    ? s.texturePath
    : "";
  const last = rows.length ? rows[rows.length - 1].letter.charCodeAt(0) - 96 : 0;
  const next = letterOf(last);
  const changes = staged.length;
  const adding = staged.filter((entry) => !rows.find((row) => row.letter === entry.letter)?.file).length;
  const ymtName = data?.ymt?.path ? fileNameOf(data.ymt.path) : "";
  const backupNote = !changes ? "Add images to write them as this item's textures."
    : adding && ymtName ? `Changed texture files and ${ymtName} are backed up first.`
      : "Changed texture files are backed up first.";
  const ymtNote = !item ? "" : !item.dlc ? "This item's name has no pack in it, so textures can be replaced but not added."
    : data?.ymt === null ? "The pack's .ymt is not in this resource, so textures can be replaced but not added."
      : model.error ? `The pack's .ymt couldn't be read: ${model.error}` : "";
  const itemLabel = item ? `${slotLabel(item.slot)} ${item.index}${item.dlc ? ` · ${item.dlc}` : ""}` : "";

  return (
    <div className={`lv-liveries ${dropTarget === "end" ? "is-drop-end" : ""}`} ref={rootRef}>
      <section className="lv-group" id="panel-clothing-textures">
        <div className="lv-group-head">
          <h3 className="lv-group-title">Textures</h3>
          <span className="lv-liv-count">
            {changes ? `${count + adding} after write` : `${count} ${count === 1 ? "texture" : "textures"}`}
          </span>
        </div>
        {itemLabel ? <p className="lv-slot-note"><span title={drawablePath}>{itemLabel}</span></p> : null}

        {listing.status === "loading" && !data ? <p className="lv-slot-note is-busy">Reading the item's textures…</p> : null}
        {listing.status === "error" ? (
          <p className="lv-slot-note is-error">
            <span>{`The item's textures couldn't be read: ${listing.error}`}</span>
            <button type="button" className="lv-link lv-native-retry" onClick={listing.reload}>
              <RefreshCw aria-hidden="true" />
              Retry
            </button>
          </p>
        ) : null}
        {readErrors.map((texture) => (
          <p key={texture.path} className="lv-slot-note is-error" title={texture.error}>
            <span>{`${fileNameOf(texture.path)} couldn't be read: ${texture.error}`}</span>
          </p>
        ))}

        {rows.length ? (
          <ul className="lv-liv-rows" aria-label="Textures">
            {rows.map((row) => {
              const image = imageOf(previewPath(row));
              const detail = rowDetail(row, row.staged ? image : null);
              const isShown = shown(row);
              // The pack prefix before ^ is the same on every row, so the row shows what follows it.
              const name = row.file ? fileNameOf(row.file).split("^").pop() : `New texture ${row.letter}`;
              return (
                <li key={row.letter} className={`lv-liv-row ${isShown ? "is-selected" : ""} ${dropTarget === row.letter ? "is-drop" : ""}`} data-texture-letter={row.letter}>
                  <button type="button" className="lv-liv-main" onClick={() => preview(row)} aria-pressed={isShown}
                    title={row.staged ? `Preview ${fileNameOf(row.staged.path)} as texture ${row.letter}` : `Preview texture ${row.letter}`}>
                    <span className="lv-liv-number cx-display">{row.letter}</span>
                    <Thumb image={image} label={row.staged ? fileNameOf(row.staged.path) : name} />
                    <span className="lv-liv-text">
                      <span className="lv-liv-name" title={row.file || name}>{name}</span>
                      <span className={`lv-liv-sub ${detail.tone ? `is-${detail.tone}` : ""}`}
                        title={row.staged && image.status === "error" ? `${row.staged.path}: ${image.error}` : row.staged?.path || row.error || undefined}>
                        {detail.tone ? <span className="lv-dot" aria-hidden="true" /> : null}
                        <span className="lv-liv-sub-line">
                          <span className="lv-liv-sub-text">{detail.text}</span>
                          {detail.status ? <span className="lv-liv-sub-status">{detail.status}</span> : null}
                        </span>
                      </span>
                    </span>
                  </button>
                  {row.staged ? (
                    <button type="button" className="cx-icon-btn lv-liv-remove" onClick={() => unstage(row.staged.id)}
                      aria-label={`Don't write ${fileNameOf(row.staged.path)}`} title={`Don't write ${fileNameOf(row.staged.path)}`}>
                      <X aria-hidden="true" />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : listing.status === "ready" ? (
          <p className="lv-slot-note"><span>{`${fileNameOf(drawablePath)} has no texture files beside it. Its textures are named like ${item ? fileNameOf(`${item.slot}_diff_${String(item.index).padStart(3, "0")}_a_uni.ytd`) : "jbib_diff_000_a_uni.ytd"}.`}</span></p>
        ) : null}

        {item && ready && last < MAX_ITEM_TEXTURES ? (
          <DropButton
            title="Add textures"
            hint={`Drop images to add them as ${next}, ${letterOf(last + 1) || "…"} and on. Drop one on a texture to replace it.`}
            onClick={pickImages}
          />
        ) : null}
        {loaded && item && ready && last < MAX_ITEM_TEXTURES ? (
          <button type="button" className="lv-link lv-liv-add-loaded" onClick={() => stage([loaded])}>
            {`Add ${fileNameOf(loaded)} as texture ${next}`}
          </button>
        ) : null}
        {ymtNote ? <p className="lv-slot-note"><span>{ymtNote}</span></p> : null}
        {notes.map((note) => (
          <p key={note} className="lv-slot-note is-warn">
            <CircleAlert aria-hidden="true" className="lv-liv-note-icon" />
            <span>{note}</span>
          </p>
        ))}
      </section>

      <div className="lv-liv-foot">
        <button type="button" className="cx-btn is-primary lv-liv-write" disabled={!changes || listing.status !== "ready" || Boolean(blockedBy)}
          onClick={() => setDialogOpen(true)}
          title={blockedBy || (!changes ? "Stage images first" : "Check, then write the textures")}>
          <Download aria-hidden="true" />
          {changes ? `Write ${changes} ${changes === 1 ? "texture" : "textures"}…` : "Write textures…"}
        </button>
        {changes ? (
          <div className="lv-liv-foot-row">
            <p className="lv-liv-foot-note">{backupNote}</p>
            <button type="button" className="lv-link" onClick={clearStaged}>Clear</button>
          </div>
        ) : <p className="lv-liv-foot-note">{backupNote}</p>}
      </div>

      {dialogOpen ? (
        <ClothingWriteDialog
          s={s}
          plan={plan}
          items={staged}
          // Read again on close: a write that stopped because the files changed is then planned from them.
          onClose={() => {
            setDialogOpen(false);
            listing.reload();
          }}
          onWritten={() => {
            s.setClothingSet(null);
            setNotes([]);
            listing.reload();
          }}
        />
      ) : null}
    </div>
  );
}
