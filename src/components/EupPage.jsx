import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { exists, readDir, readFile, stat, writeFile } from "@tauri-apps/plugin-fs";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Group, MathUtils } from "three";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Aperture, Check, CircleHelp, Crosshair, Grid3x3, Images, LampCeiling, Loader2, Monitor, Pause, Play, Sun, X } from "lucide-react";
import {
  EXPORT_FORMATS,
  VIDEO_FPS,
  contactSheetLayout,
  exportFileStem,
  formatSize,
  normalizeExportSettings,
  pickVideoType,
  sheetCellSize,
} from "../lib/eup-export";
import { loadPrefs } from "../lib/prefs";
import { HOTKEY_ACTIONS } from "../lib/hotkeys";
import { useWorkspaceHotkeys } from "../lib/use-workspace-hotkeys";
import { openFolderPath } from "../lib/open-folder";
import { applyWatermarkToDataUrl, stampCanvas } from "../lib/watermark";
import {
  COMPONENT_IDS,
  DEFAULT_BASE_OUTFIT,
  PED_FOR_GENDER,
  PROP_IDS,
  baseName,
  buildGameDrawableIndex,
  buildOutfitLabel,
  buildOutfitLua,
  buildServerPackListing,
  extendPedListing,
  componentDisplayName,
  cycleValue,
  formatIndex,
  groupEupAssets,
  isPropComponent,
  isSkinTintSlot,
  listDrawableIndices,
  listPackRaces,
  listTextureVariants,
  listThumbnailJobs,
  MAX_OUTFIT_PRESETS,
  bodyPresetsFor,
  pathKey,
  resolveOutfitSelections,
  selectionsWithPaths,
  resolveDrawableNumber,
  resolveTextureForDrawable,
  validateEupNames,
  MAX_ADDON_PIECES,
  PIECE_TEXTURE_EXTENSIONS,
  detectPieceComponent,
  detectPieceGender,
  pieceDrawableIndex,
  pieceTextureCandidates,
  setAddonPieceComponent,
  wearAddonPiece,
  wornAddonPieces,
} from "../lib/eup";
import {
  CAST_SEATS,
  applyCastPieces,
  castLetter,
  castOffsets,
  castSnapshot,
  createCastMember,
  projectPieces,
  restoreCast,
} from "../lib/eup-cast";
import {
  applyPropAttachment,
  buildSlotGroup,
  createPedRoot,
  disposeSlotGroup,
  findPedSkeleton,
  invalidatePedDrawables,
  setGroupHairColor,
  setGroupPose,
  setGroupSkinTint,
} from "../lib/ped-assembly";
import { SHOWROOM_FLOORS, SHOWROOM_LIGHT_KEYS } from "../lib/viewer-stage.js";
import { normalizeShowroomSubject } from "../lib/studio-defaults.js";
import EupViewport, { EUP_CAMERA_PRESETS } from "./eup/EupViewport";
import EupCastPanel from "./eup/EupCastPanel";
import EupComponentList from "./eup/EupComponentList";
import EupSourcePanel from "./eup/EupSourcePanel";
import EupIssuesPanel from "./eup/EupIssuesPanel";
import EupOutfitPanel from "./eup/EupOutfitPanel";
import EupPosePanel from "./eup/EupPosePanel";
import EupPiecesPanel from "./eup/EupPiecesPanel";
import EupBasePanel from "./eup/EupBasePanel";
import EupCharacterBody from "./eup/EupCharacterBody";
import { useEupCharacter } from "./eup/useEupCharacter";
import EupCharacterImportDialog from "./eup/EupCharacterImportDialog";
import { headRacesFromListing } from "../lib/character-import";
import EupThumbnailDialog from "./eup/EupThumbnailDialog";
import EupExportPanel from "./eup/EupExportPanel";
import EupPackPanel, { EupPackFooter } from "./eup/EupPackPanel";
import { usePackProject } from "./eup/usePackProject";
import { normalizePackProject, slotOrderKey } from "../lib/clothing-pack.js";
import { hairSquash, hatFlatten, previewHairCrush } from "../lib/clothing-properties.js";
import {
  exportYtd,
  forgetPedGameFiles,
  getPedListing,
  listGameClips,
  listYcdFileClips,
  searchAnimDicts,
  searchGameProps,
  searchPeds,
} from "./eup/ped-files";
import {
  CUSTOM_POSE,
  MAX_HELD_PROPS,
  normalizeCustomAnimation,
  normalizeHeldProps,
  parseEmoteSnippet,
  propAttachmentMatrix,
} from "../lib/ped-pose";
import { usePedFigure } from "./eup/usePedFigure";
import { useSceneProps } from "./eup/useSceneProps";
import EupScenePanel from "./eup/EupScenePanel";
import EupTimeline from "./eup/EupTimeline";
import {
  MAX_SCENE_PROPS,
  SCENE_PROP_EXTENSIONS,
  duplicateSceneProp,
  heldPropOffset,
  normalizeSceneProp,
  normalizeSceneProps,
  placeSceneProp,
  removeSceneProp,
  restoreSceneProp,
  uprightYaw,
  watchedScenePropPaths,
} from "../lib/eup-scene";
import { clampClipTime, isClipAtEnd, normalizePlayback } from "../lib/eup-playback";
import { getOutfitLibrary, outfitLibraryError, subscribeOutfitLibrary, updateOutfitLibrary } from "../lib/eup-outfit-library";
import { OUTFIT_STYLES, gameAvailability, generateOutfit, outfitSignature, overridesWithOutfit } from "../lib/eup-outfit-generator";
import { ColorLine, DeckButton, FloorField, InspectorTabs, Slider, StageSection, WorkspaceFrame } from "./workspace/parts";
import { PaneResizer, usePaneWidths } from "./workspace/PaneResizer";
import "./EupPage.css";

const PERSIST_DEBOUNCE_MS = 140;
const WATCH_DEBOUNCE_MS = 350;
const SCAN_FILE_LIMIT = 8000;
const SCAN_MAX_DEPTH = 8;
const STAT_CONCURRENCY = 24;
const DEFAULT_BACKGROUND = "#141414";
const READ_DIR_NOTICE =
  "This folder can't be read (fs:allow-read-dir). Use Add files to pick .ydd and .ytd files directly.";

const PED_FILE_FILTERS = [{ name: "Ped assets", extensions: ["ydd", "ytd"] }];
const EMPTY_PED_ASSETS = Object.freeze({ components: {}, props: {} });
const IDLE_CLIP_LISTING = Object.freeze({ source: "", status: "idle", clips: [], error: "" });

// File-name suffixes for shot angles.
const ANGLE_FILE_NAMES = { view: "view", front: "front", full: "three-quarter", left: "side", back: "back", head: "head" };

const STAGE_NOTES = {
  showroom: "A dark studio with a textured, reflective floor and a spotlight. Saved views use it too.",
  workbench: "Your backdrop colour, with the grid and shadows from the deck.",
};

function clampNumber(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function normalizeScene(value, prefs) {
  const source = value && typeof value === "object" ? value : {};
  // A new workspace, or one saved before a field existed, starts from Settings > Studio.
  const start = prefs.showroom || normalizeShowroomSubject(null, "ped");
  return {
    stage: source.stage === "showroom" || source.stage === "workbench" ? source.stage : start.stage,
    light: SHOWROOM_LIGHT_KEYS.includes(source.light) ? source.light : start.light,
    spot: clampNumber(source.spot, 0, 2, start.spot),
    reflect: clampNumber(source.reflect, 0, 1, start.reflect),
    beam: typeof source.beam === "boolean" ? source.beam : start.beam,
    rim: clampNumber(source.rim, 0, 2, start.rim),
    floor: SHOWROOM_FLOORS.includes(source.floor) ? source.floor : start.floor,
    grid: typeof source.grid === "boolean" ? source.grid : true,
    shadows: typeof source.shadows === "boolean" ? source.shadows : true,
    backdrop: typeof source.backdrop === "string" && /^#[0-9a-f]{6}$/i.test(source.backdrop) ? source.backdrop : prefs.background,
    lightLevel: clampNumber(source.lightLevel, 0, 3, prefs.light),
  };
}

function isTauriRuntimeAvailable() {
  return (
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function"
  );
}

function errorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isPermissionError(error) {
  return /not allowed|forbidden|permission|denied/i.test(errorMessage(error));
}

function joinPath(folder, name) {
  const separator = folder.includes("\\") ? "\\" : "/";
  return folder.endsWith(separator) ? `${folder}${name}` : `${folder}${separator}${name}`;
}

async function mapLimited(items, limit, task) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const position = next;
      next += 1;
      await task(items[position], position);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function statSize(path) {
  try {
    const info = await stat(path);
    return Number.isFinite(info?.size) ? info.size : null;
  } catch {
    return null;
  }
}

// Sizes feed the 16 MB dictionary check and the inspector. `reuse` maps
// pathKey -> size from the previous scan; paths in `changed` are always re-read.
async function attachSizes(files, { reuse = null, changed = null } = {}) {
  await mapLimited(files, STAT_CONCURRENCY, async (file) => {
    const key = pathKey(file.path);
    if (reuse?.has(key) && !changed?.has(key)) {
      file.size = reuse.get(key);
      return;
    }
    file.size = await statSize(file.path);
  });
  return files;
}

async function enumerateFolder(folder, sizeOptions) {
  const separator = folder.includes("\\") ? "\\" : "/";
  const files = [];
  const walk = async (dir, depth) => {
    if (depth > SCAN_MAX_DEPTH || files.length >= SCAN_FILE_LIMIT) return;
    // Sorted so pack order, and with it pack drawable numbers, doesn't
    // depend on the order the file system lists a folder in.
    const entries = (await readDir(dir)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length >= SCAN_FILE_LIMIT) return;
      const path = dir.endsWith(separator) ? `${dir}${entry.name}` : `${dir}${separator}${entry.name}`;
      if (entry.isDirectory) {
        await walk(path, depth + 1);
      } else if (/\.(ydd|ytd)$/i.test(entry.name)) {
        files.push({ path, name: entry.name, size: null });
      }
    }
  };
  await walk(folder, 0);
  return attachSizes(files, sizeOptions);
}

async function canvasToPng(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The image couldn't be encoded as PNG");
  return new Uint8Array(await blob.arrayBuffer());
}

function parentFolder(filePath) {
  const cut = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  return cut > 0 ? filePath.slice(0, cut) : filePath;
}

function supportedVideoType() {
  if (typeof MediaRecorder === "undefined" || typeof HTMLCanvasElement.prototype.captureStream !== "function") return null;
  return pickVideoType((type) => MediaRecorder.isTypeSupported(type));
}

function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function normalizeStringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : [];
}

function newWatchId() {
  return `eup-${Math.random().toString(36).slice(2, 10)}`;
}

function newPieceId() {
  return `piece-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newOutfitId() {
  return `outfit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function isEditableTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
}

function readViewerPrefs() {
  const prefs = loadPrefs();
  const defaults = prefs?.defaults && typeof prefs.defaults === "object" ? prefs.defaults : {};
  const background =
    typeof defaults.backgroundColor === "string" && defaults.backgroundColor
      ? defaults.backgroundColor
      : DEFAULT_BACKGROUND;
  const light = Number.isFinite(defaults.lightIntensity) ? defaults.lightIntensity : 1;
  return { background, light, showroom: normalizeShowroomSubject(defaults.showroom?.ped, "ped") };
}

function EupHelp() {
  return (
    <div className="lv-help" role="dialog" aria-label="Viewer controls">
      <dl>
        <div><dt><kbd className="cx-keycap">LMB</kbd></dt><dd>Orbit</dd></div>
        <div><dt><kbd className="cx-keycap">RMB</kbd></dt><dd>Pan</dd></div>
        <div><dt>Scroll</dt><dd>Zoom</dd></div>
        <div><dt><kbd className="cx-keycap">F</kbd></dt><dd>Frame the ped</dd></div>
        <div><dt><kbd className="cx-keycap">Space</kbd></dt><dd>Play or pause</dd></div>
        <div><dt><kbd className="cx-keycap">←</kbd><kbd className="cx-keycap">→</kbd></dt><dd>Next drawable</dd></div>
        <div><dt><kbd className="cx-keycap">↑</kbd><kbd className="cx-keycap">↓</kbd></dt><dd>Next texture</dd></div>
        <div><dt><kbd className="cx-keycap">H</kbd></dt><dd>Hide the slot</dd></div>
        <div><dt><kbd className="cx-keycap">S</kbd></dt><dd>Show only the slot</dd></div>
        <div><dt>Click a prop</dt><dd>Select it for the gizmo</dd></div>
        <div><dt><kbd className="cx-keycap">G</kbd><kbd className="cx-keycap">R</kbd></dt><dd>Move or turn the prop</dd></div>
        <div><dt><kbd className="cx-keycap">Del</kbd></dt><dd>Remove the placed prop</dd></div>
      </dl>
    </div>
  );
}

export default function EupPage({
  workspaceState,
  onStateChange,
  onRenameTab,
  isActive,
  contextBarTarget,
}) {
  const isTauriRuntime = isTauriRuntimeAvailable();
  const initial = workspaceState && typeof workspaceState === "object" ? workspaceState : {};

  // Character A, and an optional character B beside it. The page edits the
  // focused one; its fields read and write through the setters below.
  const [cast, setCast] = useState(() => restoreCast(initial));
  const [scene, setScene] = useState(() => normalizeScene(initial.scene, readViewerPrefs()));
  // Speed, loop and the paused frame are saved; a paused tab reopens paused on that frame.
  const [playback, setPlayback] = useState(() => normalizePlayback(initial.playback));
  const [playing, setPlaying] = useState(() => !normalizePlayback(initial.playback).paused);
  const [clipRevision, setClipRevision] = useState(0);
  const [clipListing, setClipListing] = useState(IDLE_CLIP_LISTING);
  const propIdRef = useRef(0);
  const [cameraPreset, setCameraPreset] = useState(() =>
    EUP_CAMERA_PRESETS.some((preset) => preset.key === initial.cameraPreset) ? initial.cameraPreset : "front",
  );
  const [sourceFolders, setSourceFolders] = useState(() => normalizeStringList(initial.sourceFolders));
  const [sourceFiles, setSourceFiles] = useState(() => normalizeStringList(initial.sourceFiles));
  const [liveReload, setLiveReload] = useState(() => initial.liveReload !== false);
  // Saved outfits are shared by every EUP Studio session (see eup-outfit-library).
  const outfits = useSyncExternalStore(subscribeOutfitLibrary, getOutfitLibrary);
  const [generated, setGenerated] = useState(null);
  const [generating, setGenerating] = useState(null);

  const [folderScans, setFolderScans] = useState({});
  const [addedFileSizes, setAddedFileSizes] = useState({});
  const [scanNotice, setScanNotice] = useState("");
  const [baseRetry, setBaseRetry] = useState(0);
  // Re-reads of each character's custom ped, so a retry on one leaves the other alone.
  const [describeRetry, setDescribeRetry] = useState({ a: 0, b: 0 });
  const [assetRevision, setAssetRevision] = useState(0);
  const [pathRevisions, setPathRevisions] = useState({});
  const [watchState, setWatchState] = useState({ status: "off", error: "" });
  const [inspectorTab, setInspectorTab] = useState(() => (initial.inspectorTab === "pack" ? "pack" : "clothing"));
  const [packProject, setPackProject] = useState(() => normalizePackProject(initial.pack));
  const [packSelection, setPackSelection] = useState([]);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  // Dock and inspector widths the user dragged, kept for every EUP tab.
  const panes = usePaneWidths("cortex.eup.panes");
  const [helpOpen, setHelpOpen] = useState(false);
  const [notice, setNotice] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [focusComponent, setFocusComponent] = useState(null);
  const [hiddenSlots, setHiddenSlots] = useState({});
  const [soloComponent, setSoloComponent] = useState(null);
  const [thumbnailOpen, setThumbnailOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [thumbnailRun, setThumbnailRun] = useState(null);
  const [exportSettings, setExportSettings] = useState(() => normalizeExportSettings(initial.exportSettings));
  const [exportName, setExportName] = useState("");
  const [exportRun, setExportRun] = useState(null);
  const [sheetComponent, setSheetComponent] = useState(null);
  const videoType = useMemo(() => supportedVideoType(), []);
  // Props placed on the floor; the placed or held prop the gizmo is on
  // ({ kind: "scene", id } or { kind: "held", seat, id }); the last removed prop, for Undo.
  const [sceneProps, setSceneProps] = useState(() => normalizeSceneProps(initial.sceneProps));
  const [selection, setSelection] = useState(null);
  const [gizmoMode, setGizmoMode] = useState("translate");
  const [removedProp, setRemovedProp] = useState(null);

  const stageRootRef = useRef(null);
  if (!stageRootRef.current) {
    stageRootRef.current = new Group();
    stageRootRef.current.name = "eup-cast";
  }
  // Placed props stand beside the cast, outside the group that framing measures.
  const setRootRef = useRef(null);
  if (!setRootRef.current) {
    setRootRef.current = new Group();
    setRootRef.current.name = "eup-set";
  }
  const viewportRef = useRef(null);
  const framedRef = useRef(false);
  const cameraPresetRef = useRef(cameraPreset);
  cameraPresetRef.current = cameraPreset;
  const onRenameTabRef = useRef(onRenameTab);
  onRenameTabRef.current = onRenameTab;
  const thumbnailControllerRef = useRef(null);
  const exportControllerRef = useRef(null);
  const pendingExportRef = useRef(null);
  // Shots and colourways hold the pose still so every image shows the same frame.
  const freezeRef = useRef(false);

  const notify = useCallback((message) => setNotice({ id: Date.now(), message }), []);
  // One alert per operation: a repeat failure replaces the earlier one.
  const raiseAlert = useCallback((id, label, text) => {
    setAlerts((prev) => [...prev.filter((alert) => alert.id !== id), { id, label, text }]);
  }, []);
  const dismissAlert = useCallback((id) => setAlerts((prev) => prev.filter((alert) => alert.id !== id)), []);

  /* ── The focused character ── */
  const focus = cast.focus === "b" && cast.b ? "b" : "a";
  const member = cast[focus];
  const { gender, race, pose, skinTone, hair, selections, baseOverrides } = member;
  const pieces = useMemo(() => projectPieces(cast.pieces, member.worn), [cast.pieces, member.worn]);
  const focusRef = useRef(focus);
  focusRef.current = focus;

  // Setters shaped like useState's, aimed at the character focused when called.
  const setMemberField = useCallback((field, value) => {
    const seat = focusRef.current;
    setCast((prev) => {
      const current = prev[seat];
      if (!current) return prev;
      const next = typeof value === "function" ? value(current[field]) : value;
      return Object.is(next, current[field]) ? prev : { ...prev, [seat]: { ...current, [field]: next } };
    });
  }, []);
  const setGender = useCallback((value) => setMemberField("gender", value), [setMemberField]);
  const setRace = useCallback((value) => setMemberField("race", value), [setMemberField]);
  const setPose = useCallback((value) => setMemberField("pose", value), [setMemberField]);
  const setSkinTone = useCallback((value) => setMemberField("skinTone", value), [setMemberField]);
  const setHair = useCallback((value) => setMemberField("hair", value), [setMemberField]);
  const setSelections = useCallback((value) => setMemberField("selections", value), [setMemberField]);
  const setBaseOverrides = useCallback((value) => setMemberField("baseOverrides", value), [setMemberField]);
  const setAnimation = useCallback(
    (value) => setMemberField("animation", (prev) => normalizeCustomAnimation(typeof value === "function" ? value(prev) : value)),
    [setMemberField],
  );
  const setHeldProps = useCallback(
    (value) => setMemberField("heldProps", (prev) => normalizeHeldProps(typeof value === "function" ? value(prev) : value)),
    [setMemberField],
  );
  // `pieces` is the shared library with the focused character's worn flags.
  const setPieces = useCallback((value) => {
    const seat = focusRef.current;
    setCast((prev) => {
      const current = prev[seat];
      if (!current) return prev;
      const before = projectPieces(prev.pieces, current.worn);
      const next = typeof value === "function" ? value(before) : value;
      return next === before ? prev : applyCastPieces(prev, seat, next);
    });
  }, []);

  const ped = PED_FOR_GENDER[gender];
  const updateScene = useCallback((patch) => setScene((prev) => ({ ...prev, ...patch })), []);
  const showroomOptions = useMemo(
    () => ({ light: scene.light, spot: scene.spot, reflect: scene.reflect, beam: scene.beam, rim: scene.rim, floor: scene.floor }),
    [scene.light, scene.spot, scene.reflect, scene.beam, scene.rim, scene.floor],
  );
  // How far the floor has scrolled under a walk cycle.
  const scrollRef = useRef(0);
  const genderSelections = selections[gender];
  const genderOverrides = baseOverrides[gender];

  /* ── Persist (callback kept in a ref; debounced; skipped when unchanged) ── */
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const persistTimerRef = useRef(null);
  const lastPersistedRef = useRef(null);
  const snapshot = useMemo(() => ({
    ...castSnapshot(cast),
    scene,
    cameraPreset,
    sourceFolders,
    sourceFiles,
    liveReload,
    exportSettings,
    sceneProps,
    pack: packProject,
    playback: { speed: playback.speed, loop: playback.loop, paused: !playing, time: playing ? 0 : playback.time },
  }), [cast, scene, cameraPreset, sourceFolders, sourceFiles, liveReload, exportSettings, sceneProps, packProject, playback, playing]);
  // Seed with the restored state so mounting does not emit a no-op persist.
  if (lastPersistedRef.current === null) lastPersistedRef.current = JSON.stringify(snapshot);
  useEffect(() => {
    if (!onStateChangeRef.current) return undefined;
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastPersistedRef.current) return undefined;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      lastPersistedRef.current = serialized;
      onStateChangeRef.current?.(snapshot);
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [snapshot]);


  /* ── Folder scanning ── */
  useEffect(() => {
    if (!isTauriRuntime) return undefined;
    let cancelled = false;
    const pending = sourceFolders.filter((folder) => !folderScans[folder] || folderScans[folder].status === "scanning");
    if (pending.length === 0) return undefined;
    setFolderScans((prev) => {
      const next = { ...prev };
      for (const folder of pending) next[folder] = { status: "scanning", files: [] };
      return next;
    });
    for (const folder of pending) {
      enumerateFolder(folder).then(
        (files) => {
          if (cancelled) return;
          setFolderScans((prev) => ({ ...prev, [folder]: { status: "ready", files } }));
        },
        (error) => {
          if (cancelled) return;
          const message = errorMessage(error);
          setFolderScans((prev) => ({ ...prev, [folder]: { status: "error", files: [], error: message } }));
          setScanNotice(isPermissionError(error) ? READ_DIR_NOTICE : `Folder scan failed: ${message}`);
        },
      );
    }
    return () => {
      cancelled = true;
    };
    // folderScans is read for the pending check only; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFolders, isTauriRuntime]);

  const refreshAddedSizes = useCallback(async (paths) => {
    const sizes = {};
    await mapLimited(paths, STAT_CONCURRENCY, async (path) => {
      sizes[path] = await statSize(path);
    });
    setAddedFileSizes((prev) => ({ ...prev, ...sizes }));
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;
    const missing = sourceFiles.filter((path) => !(path in addedFileSizes));
    if (missing.length > 0) refreshAddedSizes(missing);
    // addedFileSizes is a cache; reading it must not re-trigger the stat pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFiles, isTauriRuntime, refreshAddedSizes]);

  const fileList = useMemo(() => {
    const files = [];
    for (const folder of sourceFolders) {
      const scan = folderScans[folder];
      if (scan?.files) files.push(...scan.files);
    }
    for (const path of sourceFiles) {
      const size = addedFileSizes[path];
      files.push({ path, name: baseName(path), size: Number.isFinite(size) ? size : null });
    }
    return files;
  }, [sourceFolders, sourceFiles, folderScans, addedFileSizes]);
  const fileListRef = useRef(fileList);
  fileListRef.current = fileList;

  const fileSizes = useMemo(() => {
    const sizes = new Map();
    for (const file of fileList) if (Number.isFinite(file.size)) sizes.set(file.path, file.size);
    return sizes;
  }, [fileList]);

  const scanning = sourceFolders.some((folder) => folderScans[folder]?.status === "scanning");

  // Both peds are grouped up front so each character reads its own clothing
  // and switching the focused one does not regroup the files.
  const groupedByGender = useMemo(() => ({
    male: groupEupAssets(fileList, { defaultPed: PED_FOR_GENDER.male }),
    female: groupEupAssets(fileList, { defaultPed: PED_FOR_GENDER.female }),
  }), [fileList]);
  const pedAssetsByGender = useMemo(() => ({
    male: groupedByGender.male.peds[PED_FOR_GENDER.male] || EMPTY_PED_ASSETS,
    female: groupedByGender.female.peds[PED_FOR_GENDER.female] || EMPTY_PED_ASSETS,
  }), [groupedByGender]);
  // Addon-named packs also continue the game's drawable numbers for the base
  // ped, the way a server registers them: player hair and clothing.
  const serverListingsByGender = useMemo(() => ({
    male: buildServerPackListing(groupedByGender.male.files, PED_FOR_GENDER.male),
    female: buildServerPackListing(groupedByGender.female.files, PED_FOR_GENDER.female),
  }), [groupedByGender]);
  const grouped = groupedByGender[gender];
  const pedAssets = pedAssetsByGender[gender];

  const pack = usePackProject({
    enabled: isTauriRuntime,
    compare: inspectorTab === "pack",
    sourceFolders,
    sourceFiles,
    revision: `${assetRevision}|${fileList.length}`,
    project: packProject,
  });
  const packDrawables = useMemo(() => {
    const map = new Map();
    for (const [packGender, assets] of Object.entries(pedAssetsByGender)) {
      for (const bucket of [assets.components, assets.props]) {
        for (const entry of Object.values(bucket || {})) {
          for (const drawable of Object.values(entry.drawables)) {
            if (drawable.drawablePath) map.set(pathKey(drawable.drawablePath), { gender: packGender, component: entry.component, index: drawable.index });
          }
        }
      }
    }
    return map;
  }, [pedAssetsByGender]);
  const hairCrushFor = (seat) => {
    if (!seat || (seat.model?.kind && seat.model.kind !== "freemode")) return null;
    const seatGender = seat.gender === "female" ? "female" : "male";
    const assets = pedAssetsByGender[seatGender];
    const worn = (component, bucket) => {
      const selection = seat.selections?.[seatGender]?.[component];
      const path = selection ? assets[bucket]?.[component]?.drawables?.[selection.index]?.drawablePath : null;
      return path ? pack.values.get(pathKey(path)) : null;
    };
    const hat = worn("p_head", "props");
    if (!hat?.item.isProp) return null;
    const hair = worn("hair", "components");
    return previewHairCrush({
      hat: hatFlatten(hat.properties.expressionMods),
      hair: hair && !hair.item.isProp ? hairSquash(hair.properties.expressionMods) : null,
    });
  };
  const otherPedCount = useMemo(
    () => grouped.files.filter((file) => file.ped !== ped).length,
    [grouped, ped],
  );
  const issues = useMemo(() => validateEupNames(fileList, { defaultPed: ped }), [fileList, ped]);

  const assetComponents = useMemo(() => {
    const known = [...COMPONENT_IDS, ...PROP_IDS];
    const present = [
      ...Object.keys(pedAssets.components || {}),
      ...Object.keys(pedAssets.props || {}),
    ];
    const rank = (component) => {
      const position = known.indexOf(component);
      return position < 0 ? known.length : position;
    };
    return present.sort((a, b) => rank(a) - rank(b));
  }, [pedAssets]);

  const activeComponent = assetComponents.includes(focusComponent) ? focusComponent : assetComponents[0] || null;

  /* ── Figures on the stage ── */
  const revisionOf = useCallback((path) => (path ? pathRevisions[pathKey(path)] || 0 : 0), [pathRevisions]);
  const offsets = castOffsets(cast);
  const focusVisibility = useMemo(() => ({ hidden: hiddenSlots, solo: soloComponent }), [hiddenSlots, soloComponent]);
  const figuresRef = useRef({});

  // Frames the camera once every slot of every character has settled.
  const handleFigureSettled = useCallback(() => {
    if (framedRef.current) return;
    const figures = Object.values(figuresRef.current);
    if (!figures.every((figure) => figure.isSettled())) return;
    framedRef.current = true;
    for (const figure of figures) figure.settleFloor();
    viewportRef.current?.frame(cameraPresetRef.current);
  }, []);

  const figureShared = {
    enabled: isTauriRuntime,
    clipRevision,
    pieces: cast.pieces,
    pedAssetsByGender,
    serverListingsByGender,
    revisionOf,
    assetRevision,
    baseRetry,
    stageRoot: stageRootRef.current,
    viewportRef,
    freezeRef,
    onSettled: handleFigureSettled,
  };
  const figureA = usePedFigure({
    ...figureShared,
    hairCrush: hairCrushFor(cast.a),
    member: cast.a,
    offsetX: offsets.a,
    describeRetry: describeRetry.a,
    visibility: focus === "a" ? focusVisibility : undefined,
  });
  const figureB = usePedFigure({
    ...figureShared,
    hairCrush: hairCrushFor(cast.b),
    member: cast.b,
    offsetX: offsets.b,
    describeRetry: describeRetry.b,
    visibility: focus === "b" ? focusVisibility : undefined,
  });
  figuresRef.current = { a: figureA, b: figureB };
  const figure = focus === "b" ? figureB : figureA;
  const figureRef = useRef(figure);
  figureRef.current = figure;
  const { slotStates, baseError, clip, clipKey, clipState, wantedClip } = figure;
  // A game ped or the user's ped: EUP clothing, outfits and thumbnails are for
  // the freemode peds, so those surfaces say so instead of acting on them.
  const customNote = figure.custom
    ? `EUP clothing fits the freemode peds only. ${figure.character?.label || "This character"} wears its own drawables and props, set in Body.`
    : "";
  const handleCharacterModelChange = useCallback(({ model, previous }) => {
    framedRef.current = false;
    // Hide and solo name another ped's slots. Male and female freemode keep
    // them, as switching the ped always has.
    if (model.kind !== "freemode" || previous?.kind !== "freemode") {
      setHiddenSlots({});
      setSoloComponent(null);
    }
  }, []);
  const handleCharacterPickError = useCallback((error) => notify(`The ped picker didn't open: ${errorMessage(error)}`), [notify]);
  const characterControls = useEupCharacter({
    cast,
    setCast,
    focusRef,
    onModelChange: handleCharacterModelChange,
    onError: handleCharacterPickError,
  });
  // Worn addon pieces for the focused character, by slot. A worn piece wins
  // its slot over the pack selection and the base clothing.
  const genderPieces = figure.wornPieces;
  const anyClip = Boolean(figureA.clip || figureB.clip);

  // In-game drawable numbers per component: the game's clothing collections,
  // then the loaded server packs.
  const baseIndexes = figure.gameIndexes;

  const pickRoots = useMemo(
    () => (cast.b ? CAST_SEATS.map((seat) => ({ id: seat, root: figuresRef.current[seat].root })) : null),
    [cast.b],
  );

  useEffect(() => {
    scrollRef.current = 0;
    viewportRef.current?.setFloorScroll?.(0);
  }, [figureA.clip, figureB.clip]);

  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const timelineRef = useRef(null);
  // A visible placed prop stands still on the floor, so the floor does too.
  const setShownRef = useRef(false);
  setShownRef.current = sceneProps.some((prop) => !prop.hidden);

  // One animation step per rendered frame while a clip plays. The floor only
  // scrolls when everyone on it walks; a standing character would slide.
  const handleAnimate = useCallback((dt) => {
    if (freezeRef.current) return;
    const { speed: rate, loop } = playbackRef.current;
    const scaled = dt * rate;
    const figures = Object.values(figuresRef.current).filter((item) => item.present);
    const speeds = figures.map((item) => item.step(scaled, loop));
    const speed = speeds.length > 0 ? Math.min(...speeds) : 0;
    if (speed > 0 && !setShownRef.current) {
      scrollRef.current = (scrollRef.current + speed * scaled) % 1000;
      viewportRef.current?.setFloorScroll?.(scrollRef.current);
    }
    const focused = figuresRef.current[focusRef.current];
    if (focused?.clip) timelineRef.current?.update(focused.getTime());
    // Without loop, playback stops once every clip shows its last frame.
    if (!loop && figures.every((item) => !item.clip || isClipAtEnd(item.getTime(), item.clip.duration))) {
      const time = focused?.clip ? focused.getTime() : 0;
      setPlaying(false);
      setPlayback((prev) => ({ ...prev, time: Math.round(time * 1000) / 1000 }));
    }
  }, []);

  // Space, the deck and the timeline: pausing keeps the frame on screen (and
  // in the workspace); with loop off, playing an ended clip starts it again.
  const togglePlay = useCallback(() => {
    if (playingRef.current) {
      const focused = figuresRef.current[focusRef.current];
      const time = focused?.clip ? focused.getTime() : 0;
      setPlaying(false);
      setPlayback((prev) => ({ ...prev, time: Math.round(time * 1000) / 1000 }));
      return;
    }
    if (!playbackRef.current.loop) {
      for (const item of Object.values(figuresRef.current)) {
        if (item.present && item.clip && isClipAtEnd(item.getTime(), item.clip.duration)) item.seek(0);
      }
    }
    setPlaying(true);
  }, []);

  // Scrubbing shows the same moment on every character and pauses there.
  const handleScrub = useCallback((time) => {
    if (playingRef.current) setPlaying(false);
    for (const item of Object.values(figuresRef.current)) if (item.present) item.seek(time);
    viewportRef.current?.requestRender();
  }, []);

  const handleScrubEnd = useCallback((time) => {
    const focused = figuresRef.current[focusRef.current];
    const shown = focused?.clip ? clampClipTime(time, focused.clip.duration) : 0;
    setPlayback((prev) => ({ ...prev, time: Math.round(shown * 1000) / 1000 }));
  }, []);

  // A saved paused frame, or the frame showing when a .ycd reloads, goes back
  // on once each character's clip and skeleton are in (they start at 0).
  // While paused, a character whose clip or skeleton changes (a new ped, a
  // refused clip) goes back to the paused time, so the stage and the
  // timeline show the same frame.
  const pendingSeekRef = useRef(null);
  if (pendingSeekRef.current === null) {
    const saved = normalizePlayback(initial.playback);
    pendingSeekRef.current = saved.paused && saved.time > 0 ? { a: saved.time, b: saved.time } : {};
  }
  useEffect(() => {
    const pending = pendingSeekRef.current;
    let moved = false;
    for (const seat of CAST_SEATS) {
      const item = figuresRef.current[seat];
      if (pending[seat] === undefined) {
        if (!playingRef.current && item?.present && item.clip && item.seek(playbackRef.current.time)) moved = true;
        continue;
      }
      if (!item?.present) {
        delete pending[seat];
      } else if (item.clip && item.seek(pending[seat])) {
        delete pending[seat];
        moved = true;
      }
    }
    if (!moved) return;
    const focused = figuresRef.current[focusRef.current];
    if (focused?.clip) timelineRef.current?.update(focused.getTime());
    viewportRef.current?.requestRender();
  }, [figureA.clip, figureB.clip, figureA.skeletonTags, figureB.skeletonTags]);

  useEffect(
    () => () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      if (thumbnailControllerRef.current) thumbnailControllerRef.current.cancelled = true;
      if (exportControllerRef.current) exportControllerRef.current.cancelled = true;
    },
    [],
  );

  /* ── Cast ── */
  const handleFocusSeat = useCallback((seat) => {
    if (seat === focusRef.current) return;
    setCast((prev) => (prev[seat] ? { ...prev, focus: seat } : prev));
    // Hide and solo name slots of the character they were set on.
    setHiddenSlots({});
    setSoloComponent(null);
  }, []);

  const handleAddCharacter = useCallback((nextGender) => {
    framedRef.current = false;
    setCast((prev) => (prev.b ? prev : { ...prev, b: createCastMember(nextGender, prev.a), focus: "b" }));
    setHiddenSlots({});
    setSoloComponent(null);
  }, []);

  // Removing A moves B into its place, so one character always stands.
  const handleRemoveCharacter = useCallback((seat) => {
    framedRef.current = false;
    setCast((prev) => {
      if (!prev.b) return prev;
      return seat === "a" ? { ...prev, a: prev.b, b: null, focus: "a" } : { ...prev, b: null, focus: "a" };
    });
    setHiddenSlots({});
    setSoloComponent(null);
  }, []);

  /* ── Set: props placed on the floor, and the gizmo ── */
  const sceneSet = useSceneProps({
    enabled: isTauriRuntime,
    props: sceneProps,
    setRoot: setRootRef.current,
    viewportRef,
    revisionOf,
  });
  const castRef = useRef(cast);
  castRef.current = cast;
  const scenePropsRef = useRef(sceneProps);
  scenePropsRef.current = sceneProps;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const removedPropRef = useRef(removedProp);
  removedPropRef.current = removedProp;

  const raiseSetFull = useCallback(() => {
    raiseAlert("set-full", "The set is full", `EUP Studio holds up to ${MAX_SCENE_PROPS} placed props. Remove one to add another.`);
  }, [raiseAlert]);

  const handleAddSceneProp = useCallback((partial) => {
    const list = scenePropsRef.current;
    if (list.length >= MAX_SCENE_PROPS) {
      raiseSetFull();
      return;
    }
    const prop = normalizeSceneProp({
      ...partial,
      id: `set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      position: placeSceneProp(list, { castHalfWidth: castRef.current.b ? 0.95 : 0.45 }),
    });
    if (!prop) return;
    setSceneProps((prev) => (prev.length >= MAX_SCENE_PROPS ? prev : [...prev, prop]));
    setSelection({ kind: "scene", id: prop.id });
    setRemovedProp(null);
  }, [raiseSetFull]);

  const handleAddGameSceneProp = useCallback((name) => handleAddSceneProp({ source: "game", name }), [handleAddSceneProp]);

  const pickScenePropFile = useCallback(async (title) => {
    const picked = await open({ multiple: false, filters: [{ name: "Prop model", extensions: [...SCENE_PROP_EXTENSIONS] }], title });
    const path = Array.isArray(picked) ? picked[0] : picked;
    return typeof path === "string" && path ? path : null;
  }, []);

  const handleAddScenePropFile = useCallback(async () => {
    try {
      const path = await pickScenePropFile("Add a prop to the set");
      if (path) handleAddSceneProp({ source: "file", path });
    } catch (error) {
      raiseAlert("set-prop", "Couldn't open the prop", errorMessage(error));
    }
  }, [handleAddSceneProp, pickScenePropFile, raiseAlert]);

  const updateSceneProp = useCallback((id, patch) => {
    setSceneProps((prev) => prev.map((prop) => (prop.id === id ? normalizeSceneProp({ ...prop, ...patch }) || prop : prop)));
  }, []);

  const handleToggleScenePropHidden = useCallback((id) => {
    setSceneProps((prev) => prev.map((prop) => (prop.id === id ? { ...prop, hidden: !prop.hidden } : prop)));
  }, []);

  const handleDuplicateSceneProp = useCallback((id) => {
    const list = scenePropsRef.current;
    const prop = list.find((item) => item.id === id);
    if (!prop) return;
    if (list.length >= MAX_SCENE_PROPS) {
      raiseSetFull();
      return;
    }
    const copy = duplicateSceneProp(prop, list, `set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
    if (!copy) return;
    setSceneProps((prev) => (prev.length >= MAX_SCENE_PROPS ? prev : [...prev, copy]));
    setSelection({ kind: "scene", id: copy.id });
    setRemovedProp(null);
  }, [raiseSetFull]);

  // No confirmation: the inline Undo (and Ctrl+Z) brings a removed prop back.
  const handleRemoveSceneProp = useCallback((id) => {
    const { list, removed } = removeSceneProp(scenePropsRef.current, id);
    if (!removed) return;
    setSceneProps(list);
    setRemovedProp(removed);
    setSelection((current) => (current?.kind === "scene" && current.id === id ? null : current));
  }, []);

  const handleUndoRemoveSceneProp = useCallback(() => {
    const removed = removedPropRef.current;
    if (!removed) return;
    const list = scenePropsRef.current;
    const restored = restoreSceneProp(list, removed);
    if (restored === list) {
      if (list.length >= MAX_SCENE_PROPS) raiseSetFull();
      return;
    }
    setSceneProps(restored);
    setRemovedProp(null);
    setSelection({ kind: "scene", id: removed.prop.id });
  }, [raiseSetFull]);

  // A moved or renamed file: point the prop at it and keep its placement. The
  // same path picked again (the picker now allows it) loads it again too.
  const retrySceneProp = sceneSet.retry;
  const handleLocateSceneProp = useCallback(async (id) => {
    try {
      const path = await pickScenePropFile("Locate the prop's file");
      if (!path) return;
      updateSceneProp(id, { source: "file", path });
      retrySceneProp(id);
    } catch (error) {
      raiseAlert("set-prop", "Couldn't open the prop", errorMessage(error));
    }
  }, [pickScenePropFile, raiseAlert, retrySceneProp, updateSceneProp]);

  const handleSelectSceneProp = useCallback((id) => {
    setSelection(id ? { kind: "scene", id } : null);
  }, []);

  const handleSelectHeldProp = useCallback((id) => {
    setSelection(id ? { kind: "held", seat: focusRef.current, id } : null);
  }, []);

  // Held props in their bone's space, for the gizmo. Writes the seat's own list.
  const updateHeldProp = useCallback((seat, id, patch) => {
    setCast((prev) => {
      const current = prev[seat];
      if (!current) return prev;
      const heldProps = normalizeHeldProps(current.heldProps.map((prop) => (prop.id === id ? { ...prop, ...patch } : prop)));
      return { ...prev, [seat]: { ...current, heldProps } };
    });
  }, []);

  // What a click in the viewfinder can select: visible placed props and both characters' held props.
  const { holderOf } = sceneSet;
  const pickObjects = useCallback(() => {
    const entries = [];
    for (const prop of scenePropsRef.current) {
      const holder = prop.hidden ? null : holderOf(prop.id);
      if (holder) entries.push({ key: `scene:${prop.id}`, object: holder, held: false });
    }
    for (const seat of CAST_SEATS) {
      const item = figuresRef.current[seat];
      if (!item?.present) continue;
      for (const prop of castRef.current[seat]?.heldProps || []) {
        const group = item.heldGroupOf(prop.id);
        if (group) entries.push({ key: `held:${seat}:${prop.id}`, object: group, held: true });
      }
    }
    return entries;
  }, [holderOf]);

  const handlePickObject = useCallback((key) => {
    if (!key) {
      setSelection(null);
      return;
    }
    const [kind, first, second] = key.split(":");
    if (kind === "scene") {
      setSelection({ kind: "scene", id: first });
      setInspectorTab("scene");
      setInspectorOpen(true);
    } else if (kind === "held" && CAST_SEATS.includes(first)) {
      handleFocusSeat(first);
      setSelection({ kind: "held", seat: first, id: second });
    }
  }, [handleFocusSeat]);

  // A drag ends: a placed prop keeps its spot and turn about Y (upright); a
  // held prop's new spot becomes its bone offset and rotation.
  const handleGizmoEnd = useCallback((object) => {
    const current = selectionRef.current;
    if (!current || !object) return;
    if (current.kind === "scene") {
      const yaw = uprightYaw(object.quaternion);
      object.rotation.set(0, MathUtils.degToRad(yaw), 0);
      updateSceneProp(current.id, { position: object.position.toArray(), yaw });
      return;
    }
    const root = figuresRef.current[current.seat]?.root;
    const prop = castRef.current[current.seat]?.heldProps.find((item) => item.id === current.id);
    if (!root || !prop) return;
    const skeleton = root.userData.poseSkeleton || findPedSkeleton(root);
    const pose = root.userData.poseSkeleton ? root.userData.pose : null;
    const bone = propAttachmentMatrix(skeleton, pose, { bone: prop.bone, position: [0, 0, 0], rotation: [0, 0, 0] });
    if (!bone) return;
    object.updateMatrix();
    updateHeldProp(current.seat, current.id, heldPropOffset(bone, object.matrix));
  }, [updateHeldProp, updateSceneProp]);

  // The gizmo goes on a loaded, shown placed prop, or a loaded held prop of the
  // edited character that hangs from a bone its skeleton has (otherwise the
  // prop is hidden and has no bone to measure an offset from).
  let gizmoObject = null;
  if (selection?.kind === "scene") {
    const prop = sceneProps.find((item) => item.id === selection.id);
    if (prop && !prop.hidden && sceneSet.states[prop.id]?.status === "ready") gizmoObject = holderOf(prop.id);
  } else if (selection?.kind === "held" && selection.seat === focus && figure.heldStates[selection.id]?.status === "ready") {
    const prop = member.heldProps.find((item) => item.id === selection.id);
    const group = figure.heldGroupOf(selection.id);
    if (prop && figure.skeletonTags?.has(prop.bone) && group?.userData.attached) gizmoObject = group;
  }
  const gizmoKind = selection?.kind || null;
  const gizmo = useMemo(
    () => (gizmoObject ? { object: gizmoObject, mode: gizmoMode, free: gizmoKind === "held" } : null),
    [gizmoObject, gizmoMode, gizmoKind],
  );
  const selectedHeldId = selection?.kind === "held" && selection.seat === focus ? selection.id : null;

  /* ── Live reload ── */
  const sourceFoldersRef = useRef(sourceFolders);
  sourceFoldersRef.current = sourceFolders;
  const sourceFilesRef = useRef(sourceFiles);
  sourceFilesRef.current = sourceFiles;

  const rescanFolders = useCallback(async (folders, changedKeys) => {
    for (const folder of folders) {
      const previous = new Map();
      for (const file of fileListRef.current) {
        if (Number.isFinite(file.size)) previous.set(pathKey(file.path), file.size);
      }
      try {
        const files = await enumerateFolder(folder, { reuse: previous, changed: changedKeys });
        // A folder removed while it was rescanning stays removed.
        setFolderScans((current) => (sourceFoldersRef.current.includes(folder)
          ? { ...current, [folder]: { status: "ready", files } }
          : current));
      } catch (error) {
        setScanNotice(`Rescan failed: ${errorMessage(error)}`);
      }
    }
  }, []);

  // Piece textures can be images; their changes reload the piece too.
  const pieceTextureKeysRef = useRef(new Set());
  pieceTextureKeysRef.current = new Set(cast.pieces.map((piece) => pathKey(piece.texturePath)).filter(Boolean));

  // Custom .ycd files in use and loaded placed-prop files are watched too:
  // saving one reloads the clip (on the frame showing) or the prop in place.
  const extraWatch = new Map();
  for (const seat of CAST_SEATS) {
    const animation = cast[seat]?.pose === CUSTOM_POSE ? cast[seat].animation : null;
    if (animation?.source === "file") extraWatch.set(pathKey(animation.path), { kind: "ycd", path: animation.path });
  }
  for (const path of watchedScenePropPaths(sceneProps, sceneSet.states)) {
    extraWatch.set(pathKey(path), { kind: "prop", path });
  }
  const extraWatchRef = useRef(extraWatch);
  extraWatchRef.current = extraWatch;

  const handleSourceChanges = useCallback(
    (paths) => {
      const relevant = paths.filter((path) => /\.(ydd|ytd)$/i.test(path)
        || pieceTextureKeysRef.current.has(pathKey(path))
        || extraWatchRef.current.has(pathKey(path)));
      if (relevant.length === 0) return;
      if (relevant.some((path) => extraWatchRef.current.get(pathKey(path))?.kind === "ycd")) {
        for (const seat of CAST_SEATS) {
          const item = figuresRef.current[seat];
          if (item?.present && item.clip && item.clipKey.startsWith("file:")) pendingSeekRef.current[seat] = item.getTime();
        }
        setClipRevision((value) => value + 1);
      }
      const changedKeys = new Set(relevant.map(pathKey));
      const knownByKey = new Map(fileListRef.current.map((file) => [pathKey(file.path), file.path]));
      invalidatePedDrawables(
        relevant
          .filter((path) => /\.ydd$/i.test(path))
          .map((path) => knownByKey.get(pathKey(path)) || path),
      );
      setPathRevisions((prev) => {
        const next = { ...prev };
        for (const key of changedKeys) next[key] = (next[key] || 0) + 1;
        return next;
      });
      const folders = sourceFoldersRef.current.filter((folder) => {
        const prefix = pathKey(folder).replace(/\\?$/, "\\");
        return [...changedKeys].some((key) => key.startsWith(prefix));
      });
      if (folders.length > 0) rescanFolders(folders, changedKeys);
      const changedAdded = sourceFilesRef.current.filter((path) => changedKeys.has(pathKey(path)));
      if (changedAdded.length > 0) refreshAddedSizes(changedAdded);
      notify(relevant.length === 1 ? `Reloaded ${baseName(relevant[0])}` : `Reloaded ${relevant.length} files`);
    },
    [notify, refreshAddedSizes, rescanFolders],
  );
  const handleSourceChangesRef = useRef(handleSourceChanges);
  handleSourceChangesRef.current = handleSourceChanges;

  const watchKey = [...new Set([
    ...sourceFolders,
    ...sourceFiles,
    ...cast.pieces.flatMap((piece) => [piece.drawablePath, piece.texturePath]).filter(Boolean),
    ...[...extraWatch.values()].map((entry) => entry.path),
  ])].join("\n");
  useEffect(() => {
    const paths = watchKey ? watchKey.split("\n") : [];
    if (!isTauriRuntime || !liveReload || paths.length === 0) {
      setWatchState({ status: "off", error: "" });
      return undefined;
    }
    // A fresh id per run: a late stop for the previous run cannot cancel this one.
    const id = newWatchId();
    let disposed = false;
    let unlisten = null;
    let timer = null;
    const pending = new Set();
    (async () => {
      try {
        unlisten = await listen("eup:update", (event) => {
          if (event.payload?.id !== id) return;
          for (const path of event.payload.paths || []) pending.add(path);
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            const batch = [...pending];
            pending.clear();
            handleSourceChangesRef.current(batch);
          }, WATCH_DEBOUNCE_MS);
        });
        if (disposed) {
          unlisten();
          return;
        }
        await invoke("start_eup_watch", { id, paths });
        if (!disposed) setWatchState({ status: "watching", error: "" });
      } catch (error) {
        if (!disposed) setWatchState({ status: "error", error: errorMessage(error) });
      }
    })();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
      invoke("stop_eup_watch", { id }).catch(() => {});
    };
  }, [isTauriRuntime, liveReload, watchKey]);

  /* ── Actions ── */
  const handleOpenFolder = useCallback(async () => {
    if (!isTauriRuntime) return;
    try {
      const picked = await open({ directory: true, recursive: true, multiple: false, title: "Open EUP resource folder" });
      if (typeof picked !== "string" || !picked) return;
      setScanNotice("");
      setSourceFolders((prev) => (prev.includes(picked) ? prev : [...prev, picked]));
      const label = baseName(picked);
      if (label) onRenameTabRef.current?.(label);
    } catch (error) {
      raiseAlert("open-folder", "Couldn't open the folder", errorMessage(error));
    }
  }, [isTauriRuntime, raiseAlert]);

  const handleAddFiles = useCallback(async () => {
    if (!isTauriRuntime) return;
    try {
      const picked = await open({ multiple: true, filters: PED_FILE_FILTERS, title: "Add ped files" });
      const list = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
      if (list.length === 0) return;
      setSourceFiles((prev) => {
        const next = [...prev];
        for (const path of list) if (!next.includes(path)) next.push(path);
        return next;
      });
    } catch (error) {
      raiseAlert("add-files", "Couldn't add the files", errorMessage(error));
    }
  }, [isTauriRuntime, raiseAlert]);

  const handleRemoveFolder = useCallback((folder) => {
    setSourceFolders((prev) => prev.filter((item) => item !== folder));
    setFolderScans((prev) => {
      const next = { ...prev };
      delete next[folder];
      return next;
    });
  }, []);

  const handleRemoveFile = useCallback((file) => {
    setSourceFiles((prev) => prev.filter((item) => item !== file));
  }, []);

  const handleRefreshAssets = useCallback(async () => {
    invalidatePedDrawables(fileList.filter((file) => /\.ydd$/i.test(file.path)).map((file) => file.path));
    setAssetRevision((value) => value + 1);
    if (sourceFiles.length > 0) refreshAddedSizes(sourceFiles);
    for (const folder of sourceFolders) {
      try {
        const files = await enumerateFolder(folder);
        setFolderScans((current) => ({ ...current, [folder]: { status: "ready", files } }));
      } catch (error) { setScanNotice(`Refresh failed: ${errorMessage(error)}`); }
    }
  }, [fileList, refreshAddedSizes, sourceFiles, sourceFolders]);

  const handleSelectDrawable = useCallback(
    (component, index) => {
      setFocusComponent(component);
      setSelections((prev) => {
        const current = { ...prev[gender] };
        if (index === null || index === undefined) {
          delete current[component];
        } else {
          current[component] = { index, variant: "a" };
        }
        return { ...prev, [gender]: current };
      });
      // A pack drawable takes the slot back from a worn piece.
      if (index !== null && index !== undefined) {
        setPieces((prev) => (prev.some((piece) => piece.worn && piece.gender === gender && piece.component === component)
          ? prev.map((piece) => (piece.worn && piece.gender === gender && piece.component === component ? { ...piece, worn: false } : piece))
          : prev));
      }
    },
    [gender],
  );

  useEffect(() => {
    setPackSelection([]);
  }, [gender]);

  const handleSelectPackItem = useCallback((item, { toggle = false, range = false } = {}) => {
    const slotKey = slotOrderKey(item);
    setPackSelection((prev) => {
      const anchor = prev.length ? pack.values.get(prev[0])?.item : null;
      if (!anchor || slotOrderKey(anchor) !== slotKey || (!toggle && !range)) return [item.key];
      if (toggle) return prev.includes(item.key) ? prev.filter((key) => key !== item.key) : [...prev, item.key];
      const keys = [...pack.plan.items, ...pack.plan.left].filter((entry) => slotOrderKey(entry) === slotKey).map((entry) => entry.key);
      const from = keys.indexOf(anchor.key);
      const to = keys.indexOf(item.key);
      return from < 0 || to < 0 ? [item.key] : [anchor.key, ...keys.slice(Math.min(from, to), Math.max(from, to) + 1).filter((key) => key !== anchor.key)];
    });
    if (toggle || range) return;
    const target = packDrawables.get(item.key);
    if (target && target.gender === gender) handleSelectDrawable(target.component, target.index);
  }, [gender, handleSelectDrawable, pack.plan, pack.values, packDrawables]);

  const handlePickPackParent = useCallback(async () => {
    try {
      const picked = await open({ directory: true, title: "Folder to build the new pack in" });
      if (typeof picked === "string" && picked) setPackProject((current) => ({ ...current, parent: picked }));
    } catch (error) {
      raiseAlert("pack-parent", "Couldn't pick the folder", errorMessage(error));
    }
  }, [raiseAlert]);

  const handleSelectVariant = useCallback(
    (component, variant) => {
      setFocusComponent(component);
      setSelections((prev) => {
        const current = prev[gender]?.[component];
        if (!current) return prev;
        return { ...prev, [gender]: { ...prev[gender], [component]: { ...current, variant } } };
      });
    },
    [gender],
  );

  const handleToggleHidden = useCallback((component) => {
    setHiddenSlots((prev) => {
      const next = { ...prev };
      if (next[component]) delete next[component];
      else next[component] = true;
      return next;
    });
  }, []);

  const handleToggleSolo = useCallback((component) => {
    setSoloComponent((current) => (current === component ? null : component));
  }, []);

  const handleChangeBaseIndex = useCallback(
    (component, index) => {
      setBaseOverrides((prev) => ({
        ...prev,
        [gender]: { ...prev[gender], [component]: { ...(prev[gender]?.[component] || {}), index, variant: "a" } },
      }));
    },
    [gender],
  );

  // A preset sets the face, hair style, skin tone and hair colour together and
  // leaves the rest of the base clothing alone.
  const handleApplyBodyPreset = useCallback(
    (preset) => {
      setBaseOverrides((prev) => ({
        ...prev,
        [gender]: {
          ...prev[gender],
          head: { ...(prev[gender]?.head || {}), index: preset.head, variant: "a", enabled: true },
          hair: { ...(prev[gender]?.hair || {}), index: preset.hair, variant: "a", enabled: true },
        },
      }));
      setSkinTone(preset.skin);
      setHair(preset.hairColors);
    },
    [gender],
  );

  // A generated outfit replaces the base clothing slots (top through props)
  // and leaves face and hair alone. Numbers come from this install's own
  // clothing collections, so a missing DLC is skipped rather than guessed.
  const generateRunRef = useRef(0);
  const handleGenerateOutfit = useCallback(
    async (styleId) => {
      const style = OUTFIT_STYLES.find((item) => item.id === styleId);
      if (!style) return;
      if (!baseIndexes) {
        raiseAlert("generate", "Couldn't generate an outfit", "The game's clothing list hasn't loaded yet.");
        return;
      }
      const run = ++generateRunRef.current;
      setGenerating(styleId);
      let catalog = null;
      try {
        catalog = (await import("../lib/data/eup-outfit-catalog.js")).EUP_OUTFIT_CATALOG[gender];
      } catch (error) {
        if (run === generateRunRef.current) setGenerating(null);
        raiseAlert("generate", "Couldn't load the outfit catalogue", errorMessage(error));
        return;
      }
      if (run !== generateRunRef.current) return;
      setGenerating(null);
      const available = gameAvailability(baseIndexes);
      const seed = Math.floor(Math.random() * 0x100000000);
      const outfit = generateOutfit(catalog, { style: styleId, seed, available });
      if (!outfit) {
        raiseAlert("generate", "Couldn't generate an outfit", `This GTA V install has none of the ${style.label} clothing.`);
        return;
      }
      const next = overridesWithOutfit(genderOverrides, outfit, available);
      setBaseOverrides((prev) => ({ ...prev, [gender]: overridesWithOutfit(prev[gender], outfit, available) }));
      setGenerated({ style: styleId, name: outfit.name, extras: outfit.pieces, signature: outfitSignature(next) });
      dismissAlert("generate");
    },
    [baseIndexes, dismissAlert, gender, genderOverrides, raiseAlert],
  );

  const handleChangeBaseVariant = useCallback(
    (component, variant) => {
      setBaseOverrides((prev) => ({
        ...prev,
        [gender]: { ...prev[gender], [component]: { ...(prev[gender]?.[component] || {}), variant } },
      }));
    },
    [gender],
  );

  const handleToggleBaseEnabled = useCallback(
    (component, enabled) => {
      setBaseOverrides((prev) => ({
        ...prev,
        [gender]: { ...prev[gender], [component]: { ...(prev[gender]?.[component] || {}), enabled } },
      }));
    },
    [gender],
  );

  const handleResetOutfit = useCallback(() => {
    setSelections((prev) => ({ ...prev, [gender]: {} }));
    setBaseOverrides((prev) => ({ ...prev, [gender]: {} }));
    setPieces((prev) => prev.map((piece) => (piece.gender === gender && piece.worn ? { ...piece, worn: false } : piece)));
    setHiddenSlots({});
    setSoloComponent(null);
  }, [gender]);

  /* ── Character import ── */
  const serverListingsRef = useRef(serverListingsByGender);
  serverListingsRef.current = serverListingsByGender;
  const scanFivemCharacters = useCallback(() => invoke("list_fivem_characters"), []);

  // Game drawable numbers and heritage head races for the imported
  // character's ped, so saved numbers are checked before anything is worn.
  const loadImportContext = useCallback(async (forGender) => {
    if (!isTauriRuntime) return {};
    const forPed = PED_FOR_GENDER[forGender];
    const listing = extendPedListing(await getPedListing(forPed), serverListingsRef.current[forGender]);
    return {
      gameIndexes: listing?.collections?.length
        ? Object.fromEntries([...COMPONENT_IDS, ...PROP_IDS].map((component) => [
          component,
          buildGameDrawableIndex(listing.entries, listing.collections, component),
        ]))
        : null,
      headRaces: headRacesFromListing(listing?.entries, forPed),
    };
  }, [isTauriRuntime]);

  const handleWearCharacter = useCallback((character, plan) => {
    const target = plan.gender;
    if (target !== gender) framedRef.current = false;
    setGender(target);
    setMemberField("model", { kind: "freemode", gender: target });
    setSelections((prev) => ({ ...prev, [target]: {} }));
    setBaseOverrides((prev) => ({ ...prev, [target]: { ...plan.overrides } }));
    setPieces((prev) => prev.map((piece) => (piece.gender === target && piece.worn ? { ...piece, worn: false } : piece)));
    if (plan.hair) setHair(plan.hair);
    if (plan.skinTone) setSkinTone(plan.skinTone);
    setHiddenSlots({});
    setSoloComponent(null);
    setImportOpen(false);
    notify(`Wearing ${character.name}`);
  }, [gender, notify, setMemberField]);

  /* ── Addon pieces ── */
  const piecesRef = useRef(pieces);
  piecesRef.current = pieces;

  // Wearing a piece takes its slot, so the pack selection there is dropped.
  const clearPackSelection = useCallback((pieceGender, component) => {
    setSelections((prev) => {
      if (!prev[pieceGender]?.[component]) return prev;
      const next = { ...prev[pieceGender] };
      delete next[component];
      return { ...prev, [pieceGender]: next };
    });
  }, []);

  const handleAddPieces = useCallback(async () => {
    if (!isTauriRuntime) return;
    try {
      const picked = await open({ multiple: true, filters: [{ name: "Clothing drawables", extensions: ["ydd"] }], title: "Add addon pieces" });
      const list = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
      if (list.length === 0) return;
      const taken = new Set(piecesRef.current.map((piece) => `${piece.gender}|${pathKey(piece.drawablePath)}`));
      const room = MAX_ADDON_PIECES - piecesRef.current.length;
      const added = [];
      let skipped = 0;
      for (const path of list) {
        const pieceGender = detectPieceGender(path) || gender;
        const key = `${pieceGender}|${pathKey(path)}`;
        if (taken.has(key)) continue;
        if (added.length >= room) {
          skipped += 1;
          continue;
        }
        taken.add(key);
        let texturePath = "";
        for (const candidate of pieceTextureCandidates(path)) {
          if (await exists(candidate).catch(() => false)) {
            texturePath = candidate;
            break;
          }
        }
        added.push({
          id: newPieceId(),
          gender: pieceGender,
          component: detectPieceComponent(path).component,
          drawablePath: path,
          texturePath,
          worn: true,
        });
      }
      if (added.length > 0) {
        setPieces((prev) => {
          let next = [...prev, ...added];
          for (const piece of added) next = wearAddonPiece(next, piece.id, true);
          return next;
        });
        for (const piece of added) clearPackSelection(piece.gender, piece.component);
        const others = added.filter((piece) => piece.gender !== gender).length;
        notify(`Added ${added.length} ${added.length === 1 ? "piece" : "pieces"}${others ? `, ${others} for the other ped` : ""}`);
      }
      if (skipped > 0) {
        raiseAlert("add-pieces", "Some pieces weren't added", `A session holds ${MAX_ADDON_PIECES} pieces, so ${skipped} ${skipped === 1 ? "file was" : "files were"} left out.`);
      }
    } catch (error) {
      raiseAlert("add-pieces", "Couldn't add the pieces", errorMessage(error));
    }
  }, [clearPackSelection, gender, isTauriRuntime, notify, raiseAlert]);

  const handleWearPiece = useCallback((id, worn) => {
    const piece = piecesRef.current.find((item) => item.id === id);
    if (!piece) return;
    setPieces((prev) => wearAddonPiece(prev, id, worn));
    if (worn) clearPackSelection(piece.gender, piece.component);
  }, [clearPackSelection]);

  const handleChangePieceComponent = useCallback((id, component) => {
    const piece = piecesRef.current.find((item) => item.id === id);
    if (!piece) return;
    setPieces((prev) => setAddonPieceComponent(prev, id, component));
    if (piece.worn) clearPackSelection(piece.gender, component);
  }, [clearPackSelection]);

  const handlePickPieceTexture = useCallback(async (id) => {
    if (!isTauriRuntime) return;
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "Texture", extensions: [...PIECE_TEXTURE_EXTENSIONS] }],
        title: "Choose the piece's texture",
      });
      if (typeof picked !== "string" || !picked) return;
      setPieces((prev) => prev.map((piece) => (piece.id === id ? { ...piece, texturePath: picked } : piece)));
    } catch (error) {
      raiseAlert("piece-texture", "Couldn't choose the texture", errorMessage(error));
    }
  }, [isTauriRuntime, raiseAlert]);

  const handleClearPieceTexture = useCallback((id) => {
    setPieces((prev) => prev.map((piece) => (piece.id === id ? { ...piece, texturePath: "" } : piece)));
  }, []);

  const handleRemovePiece = useCallback((id) => {
    setPieces((prev) => prev.filter((piece) => piece.id !== id));
  }, []);

  const handleRetryBase = useCallback(() => {
    for (const item of Object.values(figuresRef.current)) if (item.present) forgetPedGameFiles(item.ped);
    setBaseRetry((value) => value + 1);
  }, []);

  // Retry, or "read them again", on the edited character's custom ped. A
  // character that had nothing on stage is framed once it loads.
  const handleRetryCharacter = useCallback(() => {
    const seat = focusRef.current;
    if (!figuresRef.current[seat]?.character?.description) framedRef.current = false;
    setDescribeRetry((prev) => ({ ...prev, [seat]: prev[seat] + 1 }));
  }, []);

  /* ── Pose: custom clips, emote lines and held props ── */
  const handlePoseChange = useCallback((value) => {
    setPose(value);
    setPlaying(true);
  }, [setPose]);

  const handleCustomAnimationChange = useCallback((value) => {
    setAnimation(value);
    setPlaying(true);
  }, [setAnimation]);

  const handlePickYcd = useCallback(async () => {
    try {
      const picked = await open({ multiple: false, filters: [{ name: "Animation dictionary", extensions: ["ycd"] }] });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      setAnimation({ source: "file", path, clip: "" });
      setPlaying(true);
    } catch (error) {
      raiseAlert("ycd", "Couldn't open the animation", errorMessage(error));
    }
  }, [setAnimation, raiseAlert]);

  const handleReloadYcd = useCallback(() => setClipRevision((value) => value + 1), []);

  const newPropId = useCallback(() => {
    propIdRef.current += 1;
    return `held-${Date.now().toString(36)}-${propIdRef.current}`;
  }, []);

  const handleAddGameProp = useCallback((name) => {
    setHeldProps((prev) => (prev.length >= MAX_HELD_PROPS ? prev : [...prev, { id: newPropId(), source: "game", name }]));
  }, [setHeldProps, newPropId]);

  const handleAddFileProp = useCallback(async () => {
    try {
      const picked = await open({ multiple: false, filters: [{ name: "Prop model", extensions: ["ydr", "ydd", "yft"] }] });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      setHeldProps((prev) => (prev.length >= MAX_HELD_PROPS ? prev : [...prev, { id: newPropId(), source: "file", path }]));
    } catch (error) {
      raiseAlert("held-prop", "Couldn't open the prop", errorMessage(error));
    }
  }, [setHeldProps, newPropId, raiseAlert]);

  const handleChangeProp = useCallback((id, patch) => {
    setHeldProps((prev) => prev.map((prop) => (prop.id === id ? { ...prop, ...patch } : prop)));
  }, [setHeldProps]);

  const handleRemoveProp = useCallback((id) => {
    setHeldProps((prev) => prev.filter((prop) => prop.id !== id));
    setSelection((current) => (current?.kind === "held" && current.id === id ? null : current));
  }, [setHeldProps]);

  // Returns the note the panel shows under the emote box.
  const handleImportEmote = useCallback((text) => {
    const parsed = parseEmoteSnippet(text);
    if (!parsed) return { ok: false, message: "No animation or prop found. Paste an emote entry or a TaskPlayAnim line." };
    const parts = [];
    if (parsed.dict) {
      setAnimation({ source: "game", dict: parsed.dict, clip: parsed.clip });
      setPose(CUSTOM_POSE);
      setPlaying(true);
      parts.push(`Playing ${parsed.dict} / ${parsed.clip}`);
    }
    if (parsed.props.length) {
      setHeldProps(parsed.props.map((prop) => ({ ...prop, id: newPropId() })));
      parts.push(`props replaced with ${parsed.props.map((prop) => prop.name).join(", ")}`);
    }
    return { ok: true, message: `${parts.join("; ")}.` };
  }, [setAnimation, setPose, setHeldProps, newPropId]);

  // Clips in the Custom pose's dictionary or file. A newly chosen dictionary
  // starts on its base or idle clip (or its only clip) so something plays at once.
  const customAnimation = member.animation;
  const listingSource = pose !== CUSTOM_POSE || !customAnimation
    ? ""
    : customAnimation.source === "file"
      ? `file:${customAnimation.path}`
      : `game:${customAnimation.dict}`;
  useEffect(() => {
    if (!listingSource || !isTauriRuntime) return undefined;
    let cancelled = false;
    setClipListing((prev) => (prev.source === listingSource && prev.status === "ready"
      ? prev
      : { source: listingSource, status: "loading", clips: [], error: "" }));
    const body = listingSource.slice(5);
    const request = listingSource.startsWith("file:") ? listYcdFileClips(body) : listGameClips(body);
    request.then(
      (result) => {
        if (cancelled) return;
        const clips = Array.isArray(result?.clips) ? result.clips.filter((item) => item?.name) : [];
        setClipListing({ source: listingSource, status: "ready", clips, error: "" });
        const names = clips.map((item) => item.name);
        const first = names.length === 1 ? names[0] : ["base", "idle", "idle_a", "loop"].find((name) => names.includes(name));
        if (!first) return;
        setAnimation((prev) => {
          const source = prev?.source === "file" ? `file:${prev.path}` : prev ? `game:${prev.dict}` : "";
          return prev && !prev.clip && source === listingSource ? { ...prev, clip: first } : prev;
        });
      },
      (error) => !cancelled && setClipListing({ source: listingSource, status: "error", clips: [], error: errorMessage(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [listingSource, clipRevision, isTauriRuntime, setAnimation]);
  const shownClipListing = clipListing.source === listingSource ? clipListing : IDLE_CLIP_LISTING;

  /* ── Outfits ── */
  const outfitSlots = useCallback(
    (outfitSelections, outfitOverrides, wornPieceIds = null) => {
      const slots = [];
      // The current outfit uses what is worn; a saved one, its piece ids.
      const worn = wornAddonPieces(
        wornPieceIds ? pieces.map((piece) => ({ ...piece, worn: wornPieceIds.includes(piece.id) })) : pieces,
        gender,
      );
      // A base number from a loaded server pack is written with its pack.
      const baseEntry = (component, index, variant) => {
        const origin = resolveDrawableNumber(baseIndexes?.[component]?.ranges, index);
        return origin?.server
          ? { component, index, variant, source: "base", server: true, pack: origin.pack }
          : { component, index, variant, source: "base" };
      };
      const pieceEntry = (piece) => ({
        component: piece.component,
        index: pieceDrawableIndex(piece.drawablePath),
        variant: "a",
        source: "piece",
        file: baseName(piece.drawablePath),
      });
      for (const component of COMPONENT_IDS) {
        if (worn[component]) {
          slots.push(pieceEntry(worn[component]));
          continue;
        }
        const selection = outfitSelections?.[component];
        const drawable = Number.isInteger(selection?.index)
          ? pedAssets.components?.[component]?.drawables?.[selection.index]
          : null;
        if (drawable?.drawablePath) {
          slots.push({ component, index: selection.index, variant: selection.variant || "a", source: "eup", file: drawable.drawableName });
          continue;
        }
        const override = outfitOverrides?.[component];
        if (override?.enabled === false) continue;
        const index = Number.isInteger(override?.index) ? override.index : DEFAULT_BASE_OUTFIT[gender][component];
        const variant = /^[a-z]$/.test(override?.variant || "") ? override.variant : "a";
        slots.push(baseEntry(component, index, variant));
      }
      for (const component of PROP_IDS) {
        if (worn[component]) continue;
        const selection = outfitSelections?.[component];
        const drawable = Number.isInteger(selection?.index) ? pedAssets.props?.[component]?.drawables?.[selection.index] : null;
        if (drawable?.drawablePath) {
          slots.push({ component, index: selection.index, variant: selection.variant || "a", source: "eup", file: drawable.drawableName });
          continue;
        }
        const override = outfitOverrides?.[component];
        if (override?.enabled !== true) continue;
        const variant = /^[a-z]$/.test(override.variant || "") ? override.variant : "a";
        slots.push(baseEntry(component, Number.isInteger(override.index) ? override.index : 0, variant));
      }
      for (const component of PROP_IDS) {
        if (worn[component]) slots.push(pieceEntry(worn[component]));
      }
      return slots;
    },
    [pedAssets, gender, pieces, baseIndexes],
  );

  const copyText = useCallback(async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`Copied ${label}`);
    } catch (error) {
      raiseAlert("copy", "Couldn't copy", errorMessage(error));
    }
  }, [notify, raiseAlert]);

  const handleCopyCurrentLua = useCallback(() => {
    const lua = buildOutfitLua({
      name: buildOutfitLabel({ gender, selections: genderSelections }),
      gender,
      slots: outfitSlots(genderSelections, genderOverrides),
    });
    copyText(lua, "outfit as Lua");
  }, [copyText, gender, genderOverrides, genderSelections, outfitSlots]);

  // The library can fail to read (damaged) or to save its first copy.
  useEffect(() => {
    const error = outfitLibraryError();
    if (error) raiseAlert("outfit-library", "Saved outfits", error);
  }, [raiseAlert]);

  const handleSaveOutfit = useCallback(
    (name) => {
      const trimmed = String(name || "").trim().slice(0, 80);
      if (!trimmed) return false;
      const list = outfits[gender] || [];
      const existing = list.find((preset) => preset.name.toLowerCase() === trimmed.toLowerCase());
      if (!existing && list.length >= MAX_OUTFIT_PRESETS) {
        raiseAlert("outfit-save", "Couldn't save the outfit", `${MAX_OUTFIT_PRESETS} outfits are saved for this ped. Delete one to save another.`);
        return false;
      }
      const preset = {
        id: existing?.id || newOutfitId(),
        name: trimmed,
        selections: selectionsWithPaths(genderSelections, pedAssets),
        baseOverrides: genderOverrides,
        pieces: Object.values(genderPieces).map((piece) => piece.id),
        piecePaths: Object.values(genderPieces).map((piece) => piece.drawablePath),
      };
      const saved = updateOutfitLibrary((prev) => {
        const current = prev[gender] || [];
        const next = existing ? current.map((item) => (item.id === existing.id ? preset : item)) : [...current, preset];
        return { ...prev, [gender]: next };
      });
      if (!saved.ok) {
        raiseAlert("outfit-save", "Couldn't save the outfit", saved.error);
        return false;
      }
      dismissAlert("outfit-save");
      notify(`Saved outfit ${trimmed}`);
      return true;
    },
    [dismissAlert, gender, genderOverrides, genderPieces, genderSelections, notify, outfits, pedAssets, raiseAlert],
  );

  // Pack clothing is found by file, so an outfit saved in another session
  // wears the same files when their pack is loaded and skips them otherwise.
  const handleApplyOutfit = useCallback(
    (preset) => {
      const { selections: resolved, missing } = resolveOutfitSelections(preset.selections, pedAssets);
      setSelections((prev) => ({ ...prev, [gender]: resolved }));
      setBaseOverrides((prev) => ({ ...prev, [gender]: { ...preset.baseOverrides } }));
      const wantedIds = new Set(preset.pieces || []);
      const wantedPaths = new Set((preset.piecePaths || []).map(pathKey));
      const loadedPaths = new Set(pieces.filter((piece) => piece.gender === gender).map((piece) => pathKey(piece.drawablePath)));
      setPieces((prev) => prev.map((piece) => (piece.gender === gender
        ? { ...piece, worn: wantedIds.has(piece.id) || wantedPaths.has(pathKey(piece.drawablePath)) }
        : piece)));
      const absent = [
        ...missing.map((item) => baseName(item.path)),
        ...(preset.piecePaths || []).filter((path) => !loadedPaths.has(pathKey(path))).map((path) => baseName(path)),
      ];
      notify(absent.length > 0
        ? `Wearing ${preset.name}. Not loaded here: ${absent.slice(0, 3).join(", ")}${absent.length > 3 ? ` and ${absent.length - 3} more` : ""}`
        : `Wearing ${preset.name}`);
    },
    [gender, notify, pedAssets, pieces],
  );

  const handleDeleteOutfit = useCallback(
    (preset) => {
      const saved = updateOutfitLibrary((prev) => ({ ...prev, [gender]: (prev[gender] || []).filter((item) => item.id !== preset.id) }));
      if (!saved.ok) raiseAlert("outfit-save", "Couldn't delete the outfit", saved.error);
    },
    [gender, raiseAlert],
  );

  const handleCopyOutfitLua = useCallback(
    (preset) => {
      const lua = buildOutfitLua({
        name: preset.name,
        gender,
        slots: outfitSlots(preset.selections, preset.baseOverrides, preset.pieces || []),
      });
      copyText(lua, `${preset.name} as Lua`);
    },
    [copyText, gender, outfitSlots],
  );

  /* ── Screenshot ── */
  // A custom character's files are named after its ped, freemode's after the gender.
  const viewSubject = figure.custom ? exportFileStem(figure.character?.label, "character") : gender;
  const handleScreenshot = useCallback(async () => {
    if (!isTauriRuntime) return;
    const dataUrl = viewportRef.current?.captureScreenshot();
    if (!dataUrl) {
      raiseAlert("screenshot", "View not saved", "The viewfinder isn't ready yet.");
      return;
    }
    try {
      const target = await save({
        defaultPath: `eup-${viewSubject}-${Date.now()}.png`,
        filters: [{ name: "PNG image", extensions: ["png"] }],
        title: "Save screenshot",
      });
      if (!target) return;
      const stamped = await applyWatermarkToDataUrl(dataUrl, loadPrefs()?.defaults?.watermark);
      await writeFile(target, dataUrlToBytes(stamped));
      dismissAlert("screenshot");
      notify(`Saved ${target}`);
    } catch (error) {
      raiseAlert("screenshot", "View not saved", errorMessage(error));
    }
  }, [dismissAlert, isTauriRuntime, notify, raiseAlert, viewSubject]);

  /* ── Thumbnails ── */
  const buildThumbnailJobs = useCallback(
    ({ scope, allVariants }) =>
      listThumbnailJobs(pedAssets, {
        gender,
        race,
        allVariants,
        components: scope === "focused" && activeComponent ? [activeComponent] : null,
      }),
    [pedAssets, gender, race, activeComponent],
  );

  const handlePickThumbnailFolder = useCallback(async () => {
    const picked = await open({ directory: true, multiple: false, title: "Choose thumbnail folder" });
    return typeof picked === "string" && picked ? picked : null;
  }, []);

  const handleCountThumbnailConflicts = useCallback(async (folder, jobs) => {
    let conflicts = 0;
    await mapLimited(jobs, STAT_CONCURRENCY, async (job) => {
      if (await exists(joinPath(folder, job.fileName)).catch(() => false)) conflicts += 1;
    });
    return conflicts;
  }, []);

  const handleRunThumbnails = useCallback(
    async ({ folder, jobs, size, angle, transparent }) => {
      const controller = { cancelled: false };
      thumbnailControllerRef.current = controller;
      const failed = [];
      let written = 0;
      setThumbnailRun({ status: "running", done: 0, written: 0, total: jobs.length, failed, current: null, folder });
      const active = figureRef.current;
      const { skeleton: poseSkeleton, tint, hair: hairColors } = active.lookRef.current;
      const pose = active.currentPose();
      const skeleton = poseSkeleton || findPedSkeleton(active.root);
      const renderer = viewportRef.current?.getRenderer?.();
      const background = transparent ? null : scene.backdrop;
      let aborted = null;

      for (let position = 0; position < jobs.length; position += 1) {
        if (controller.cancelled) break;
        const job = jobs[position];
        setThumbnailRun((run) => run && { ...run, current: job.fileName });
        let group = null;
        try {
          const texturePaths = job.ytdPath
            ? ((await exportYtd(job.ytdPath))?.textures || []).map((item) => item.path)
            : [];
          group = await buildSlotGroup({
            component: job.component,
            drawablePath: job.drawablePath,
            texturePaths,
            readFile,
            renderer,
            skeleton: poseSkeleton,
          });
          setGroupPose(group, pose);
          group.userData.skinTintable = isSkinTintSlot({
            component: job.component,
            drawableFile: job.drawablePath,
            textureFile: job.ytdPath,
          });
          setGroupSkinTint(group, tint);
          setGroupHairColor(group, hairColors);
          const root = createPedRoot();
          root.add(group);
          if (isPropComponent(job.component)) applyPropAttachment(group, skeleton, poseSkeleton ? pose : null);
          const bytes = await viewportRef.current.renderThumbnail(root, { size, angle, background });
          try {
            await writeFile(joinPath(folder, job.fileName), bytes);
          } catch (error) {
            // A refused or failing destination fails every remaining file too.
            aborted = `Writing ${job.fileName} failed: ${errorMessage(error)}`;
            break;
          }
          written += 1;
        } catch (error) {
          failed.push({ fileName: job.fileName, error: errorMessage(error) });
        } finally {
          if (group) disposeSlotGroup(group);
        }
        setThumbnailRun((run) => run && { ...run, done: position + 1, written, failed: [...failed] });
        // Yield so progress paints and input stays responsive between renders.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      if (thumbnailControllerRef.current === controller) thumbnailControllerRef.current = null;
      const status = aborted ? "error" : controller.cancelled ? "cancelled" : "done";
      setThumbnailRun((run) => run && { ...run, status, written, failed: [...failed], current: null, error: aborted });
    },
    [scene.backdrop],
  );

  const handleCancelThumbnails = useCallback(() => {
    if (thumbnailControllerRef.current) thumbnailControllerRef.current.cancelled = true;
  }, []);

  const handleCloseThumbnails = useCallback(() => {
    if (thumbnailRun?.status === "running") return;
    setThumbnailOpen(false);
    setThumbnailRun(null);
  }, [thumbnailRun]);

  /* ── Shots, video and colourway sheets ── */
  // Shots, videos and sheets of a custom character are named after its ped.
  const outfitLabel = figure.custom
    ? figure.character?.label || "Character"
    : buildOutfitLabel({ gender, selections: genderSelections });
  const updateExportSettings = useCallback(
    (patch) => setExportSettings((prev) => normalizeExportSettings({ ...prev, ...patch })),
    [],
  );

  const startExport = (label) => {
    const controller = { cancelled: false };
    exportControllerRef.current = controller;
    setExportRun({ status: "running", label, progress: 0 });
    return controller;
  };

  // Callers report what reached disk, cancelled or not; no run means nothing was written.
  const finishExport = (controller, run) => {
    freezeRef.current = false;
    if (exportControllerRef.current === controller) exportControllerRef.current = null;
    setExportRun(run || { status: "cancelled", label: "Export cancelled. Nothing was saved." });
    viewportRef.current?.requestRender();
  };

  const runShots = useCallback(async ({ folder, files, size, transparent }) => {
    const controller = startExport(`Rendering ${files.length} ${files.length === 1 ? "shot" : "shots"}…`);
    freezeRef.current = true;
    const watermark = loadPrefs()?.defaults?.watermark;
    let written = 0;
    try {
      for (const file of files) {
        if (controller.cancelled) break;
        const canvas = viewportRef.current.captureFrame({ ...size, angle: file.angle, transparent });
        await stampCanvas(canvas, watermark);
        await writeFile(joinPath(folder, file.name), await canvasToPng(canvas));
        written += 1;
        setExportRun((run) => run && { ...run, progress: written / files.length, label: `Saved ${file.name}` });
        // Yield so progress paints between renders.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      finishExport(controller, controller.cancelled && written < files.length
        ? {
            status: "cancelled",
            label: `Cancelled after ${written} of ${files.length} shots`,
            folder: written ? folder : "",
          }
        : {
            status: "done",
            label: `Saved ${written} ${written === 1 ? "shot" : "shots"}`,
            output: folder,
            folder,
          });
    } catch (error) {
      finishExport(controller, {
        status: "error",
        label: written ? `Saved ${written} of ${files.length} shots, then stopped.` : "Shots not saved.",
        error: errorMessage(error),
        folder: written ? folder : "",
      });
    }
  }, []);

  const handleExportShots = useCallback(async () => {
    if (!viewportRef.current) return;
    const stem = exportFileStem(exportName || outfitLabel);
    const files = exportSettings.angles.map((angle) => ({ angle, name: `${stem}-${ANGLE_FILE_NAMES[angle] || angle}.png` }));
    const size = formatSize(exportSettings.format, exportSettings.high);
    const transparent = exportSettings.transparent && scene.stage !== "showroom";
    try {
      const picked = await open({ directory: true, multiple: false, title: "Choose a folder for the shots" });
      if (typeof picked !== "string" || !picked) return;
      let conflicts = 0;
      await mapLimited(files, STAT_CONCURRENCY, async (file) => {
        if (await exists(joinPath(picked, file.name)).catch(() => false)) conflicts += 1;
      });
      const job = { folder: picked, files, size, transparent };
      if (conflicts > 0) {
        pendingExportRef.current = job;
        setExportRun({ status: "confirm", conflicts, total: files.length, folder: picked });
        return;
      }
      runShots(job);
    } catch (error) {
      setExportRun({ status: "error", label: "Shots not saved.", error: errorMessage(error) });
    }
  }, [exportName, exportSettings, outfitLabel, runShots, scene.stage]);

  const handleConfirmExport = useCallback(() => {
    const job = pendingExportRef.current;
    pendingExportRef.current = null;
    if (job) runShots(job);
  }, [runShots]);

  const handleExportVideo = useCallback(async () => {
    if (!viewportRef.current || !videoType) return;
    const { videoCamera, videoLength } = exportSettings;
    const stem = exportFileStem(exportName || outfitLabel);
    let target;
    try {
      target = await save({
        defaultPath: `${stem}-${videoCamera}.${videoType.extension}`,
        filters: [{ name: `${videoType.extension.toUpperCase()} video`, extensions: [videoType.extension] }],
        title: "Save video",
      });
    } catch (error) {
      setExportRun({ status: "error", label: "Video not saved.", error: errorMessage(error) });
      return;
    }
    if (!target) return;
    const controller = startExport(`Recording ${videoLength} s…`);
    let shown = 0;
    try {
      const blob = await viewportRef.current.recordVideo({
        ...formatSize(exportSettings.format, false),
        seconds: videoLength,
        camera: videoCamera,
        fps: VIDEO_FPS,
        mimeType: videoType.mimeType,
        isCancelled: () => controller.cancelled,
        onProgress: (progress) => {
          // A state update per recorded frame would rerender the page 30 times a second.
          if (progress - shown < 0.02 && progress < 1) return;
          shown = progress;
          setExportRun((run) => run && run.status === "running" && { ...run, progress });
        },
      });
      if (!blob || controller.cancelled) {
        finishExport(controller, { status: "cancelled", label: "Recording cancelled. Nothing was saved." });
        return;
      }
      setExportRun((run) => run && { ...run, label: "Saving the video…", progress: 1 });
      await writeFile(target, new Uint8Array(await blob.arrayBuffer()));
      finishExport(controller, { status: "done", label: "Video saved", output: target, folder: parentFolder(target) });
    } catch (error) {
      finishExport(controller, { status: "error", label: "Video not saved.", error: errorMessage(error) });
    }
  }, [exportName, exportSettings, outfitLabel, videoType]);

  // Pack drawables worn now that have two or more textures to compare.
  const sheetOptions = useMemo(() => {
    const options = [];
    if (figure.custom) return options;
    for (const component of assetComponents) {
      const selection = genderSelections[component];
      if (!Number.isInteger(selection?.index)) continue;
      const entry = isPropComponent(component) ? pedAssets.props?.[component] : pedAssets.components?.[component];
      const drawable = entry?.drawables?.[selection.index];
      const variants = listTextureVariants(drawable);
      if (!drawable?.drawablePath || variants.length < 2) continue;
      options.push({
        component,
        drawable,
        variants,
        label: `${componentDisplayName(component)} ${formatIndex(selection.index)}`,
      });
    }
    return options;
  }, [assetComponents, genderSelections, pedAssets, figure.custom]);
  const sheetChoice = sheetOptions.find((option) => option.component === sheetComponent)
    || sheetOptions.find((option) => option.component === activeComponent)
    || sheetOptions[0]
    || null;

  const handleExportSheet = useCallback(async () => {
    if (!viewportRef.current || !sheetChoice) return;
    const { component, drawable, variants, label } = sheetChoice;
    const stem = exportFileStem(exportName || outfitLabel);
    let target;
    try {
      target = await save({
        defaultPath: `${stem}-${exportFileStem(label)}-colourways.png`,
        filters: [{ name: "PNG image", extensions: ["png"] }],
        title: "Save colourway sheet",
      });
    } catch (error) {
      setExportRun({ status: "error", label: "Sheet not saved.", error: errorMessage(error) });
      return;
    }
    if (!target) return;
    const controller = startExport(`Rendering ${variants.length} colourways…`);
    freezeRef.current = true;
    const transparent = exportSettings.transparent && scene.stage !== "showroom";
    const cell = sheetCellSize(exportSettings.format, variants.length);
    const layout = contactSheetLayout(variants.length, cell.width, cell.height);
    const sheet = document.createElement("canvas");
    sheet.width = layout.width;
    sheet.height = layout.height;
    const context = sheet.getContext("2d");
    if (!transparent) {
      context.fillStyle = scene.stage === "showroom" ? "#000000" : scene.backdrop;
      context.fillRect(0, 0, sheet.width, sheet.height);
    }
    const active = figureRef.current;
    const worn = active.runtimeRef.current.get(component)?.group || null;
    const root = active.root;
    const { skeleton: poseSkeleton, tint, hair: hairColors } = active.lookRef.current;
    const pose = active.currentPose();
    const failed = [];
    try {
      for (let i = 0; i < variants.length; i += 1) {
        if (controller.cancelled) break;
        const variant = variants[i];
        setExportRun((run) => run && { ...run, label: `Rendering texture ${variant}…`, progress: i / variants.length });
        let group = null;
        try {
          const texture = resolveTextureForDrawable(drawable, variant, { race });
          const texturePaths = texture?.path ? ((await exportYtd(texture.path))?.textures || []).map((item) => item.path) : [];
          group = await buildSlotGroup({
            component,
            drawablePath: drawable.drawablePath,
            texturePaths,
            readFile,
            renderer: viewportRef.current.getRenderer(),
            skeleton: poseSkeleton,
          });
          if (controller.cancelled) break;
          group.userData.skinTintable = isSkinTintSlot({ component, drawableFile: drawable.drawablePath, textureFile: texture?.path });
          setGroupSkinTint(group, tint);
          setGroupHairColor(group, hairColors);
          setGroupPose(group, pose);
          // Swap the variant in for one synchronous render; the viewfinder
          // never paints it.
          root.add(group);
          if (isPropComponent(component)) applyPropAttachment(group, poseSkeleton || findPedSkeleton(root), pose);
          if (worn) worn.visible = false;
          let frame;
          try {
            frame = viewportRef.current.captureFrame({ ...cell, angle: "view", transparent });
          } finally {
            root.remove(group);
            if (worn) active.applyVisibility(component, worn);
          }
          const { x, y } = layout.cells[i];
          context.drawImage(frame, x, y);
          if (exportSettings.sheetLabels) {
            const fontSize = Math.max(14, Math.round(cell.height * 0.04));
            const pad = Math.round(fontSize * 0.6);
            context.font = `600 ${fontSize}px ui-monospace, "Cascadia Mono", Consolas, monospace`;
            const text = variant.toUpperCase();
            const width = context.measureText(text).width;
            context.fillStyle = "rgba(0, 0, 0, 0.62)";
            context.fillRect(x + pad, y + cell.height - pad - fontSize * 1.6, width + pad * 2, fontSize * 1.6);
            context.fillStyle = "#ffffff";
            context.textBaseline = "middle";
            context.fillText(text, x + pad * 2, y + cell.height - pad - fontSize * 0.8);
          }
        } catch (error) {
          failed.push(`${variant}: ${errorMessage(error)}`);
        } finally {
          if (group) disposeSlotGroup(group);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (controller.cancelled) {
        finishExport(controller, null);
        return;
      }
      if (failed.length === variants.length) throw new Error(failed[0]);
      setExportRun((run) => run && { ...run, label: "Saving the sheet…", progress: 1 });
      await stampCanvas(sheet, loadPrefs()?.defaults?.watermark);
      await writeFile(target, await canvasToPng(sheet));
      finishExport(controller, failed.length
        ? { status: "error", label: `Sheet saved without ${failed.length} ${failed.length === 1 ? "texture" : "textures"}.`, error: failed.join("; ") }
        : { status: "done", label: `Saved ${variants.length} colourways`, output: target, folder: parentFolder(target) });
    } catch (error) {
      finishExport(controller, { status: "error", label: "Sheet not saved.", error: errorMessage(error) });
    }
  }, [exportName, exportSettings, outfitLabel, race, scene.backdrop, scene.stage, sheetChoice]);

  const handleCancelExport = useCallback(() => {
    if (exportControllerRef.current) exportControllerRef.current.cancelled = true;
  }, []);

  const handleDismissExport = useCallback(() => {
    pendingExportRef.current = null;
    setExportRun(null);
  }, []);

  const handleOpenExportFolder = useCallback(async (folder) => {
    if (await openFolderPath(folder)) return true;
    raiseAlert("open-folder", "Folder not opened", `Windows couldn't open ${folder}.`);
    return false;
  }, [raiseAlert]);

  const openExport = useCallback(() => {
    setInspectorTab("export");
    setInspectorOpen(true);
  }, []);

  /* ── Keyboard: cycle the focused slot without leaving the viewport ── */
  useEffect(() => {
    if (!isActive || thumbnailOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      const component = activeComponent;
      const key = event.key;
      if (key === " " && (figuresRef.current.a?.clip || figuresRef.current.b?.clip)) {
        event.preventDefault();
        togglePlay();
        return;
      }
      if (key === "f" || key === "F") {
        event.preventDefault();
        viewportRef.current?.frame(cameraPresetRef.current);
        return;
      }
      if (!component || figureRef.current.custom) return;
      const entry = isPropComponent(component) ? pedAssets.props?.[component] : pedAssets.components?.[component];
      if (!entry) return;
      const selection = genderSelections[component];
      if (key === "ArrowLeft" || key === "ArrowRight") {
        event.preventDefault();
        // `null` is the base slot, so stepping past either end returns to it.
        const options = [null, ...listDrawableIndices(entry).filter((index) => entry.drawables[index]?.drawablePath)];
        const current = Number.isInteger(selection?.index) ? selection.index : null;
        handleSelectDrawable(component, cycleValue(options, current, key === "ArrowLeft" ? -1 : 1));
      } else if (key === "ArrowUp" || key === "ArrowDown") {
        if (!Number.isInteger(selection?.index)) return;
        const variants = listTextureVariants(entry.drawables[selection.index]);
        if (variants.length < 2) return;
        event.preventDefault();
        handleSelectVariant(component, cycleValue(variants, selection.variant, key === "ArrowUp" ? -1 : 1));
      } else if (key === "h" || key === "H") {
        event.preventDefault();
        handleToggleHidden(component);
      } else if (key === "s" || key === "S") {
        event.preventDefault();
        handleToggleSolo(component);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    isActive,
    thumbnailOpen,
    activeComponent,
    pedAssets,
    genderSelections,
    handleSelectDrawable,
    handleSelectVariant,
    handleToggleHidden,
    handleToggleSolo,
    togglePlay,
  ]);

  /* ── Keyboard: the selected prop ── */
  useEffect(() => {
    if (!isActive || thumbnailOpen || importOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.altKey || event.metaKey || isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (event.ctrlKey) {
        if (key === "z" && !event.shiftKey && removedPropRef.current) {
          event.preventDefault();
          handleUndoRemoveSceneProp();
        }
        return;
      }
      const current = selectionRef.current;
      if (!current) return;
      if (key === "g") setGizmoMode("translate");
      else if (key === "r") setGizmoMode("rotate");
      else if (key === "escape") setSelection(null);
      else if (key === "delete" && current.kind === "scene") handleRemoveSceneProp(current.id);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isActive, thumbnailOpen, importOpen, handleRemoveSceneProp, handleUndoRemoveSceneProp]);

  /* ── Keyboard: the customizable view and camera shortcuts ── */
  // EUP has no 3/4 or top shot, so those bindings do nothing here.
  const showShot = (key) => {
    if (!isTauriRuntime) return false;
    setCameraPreset(key);
    if (cameraPresetRef.current === key) viewportRef.current?.frame(key);
    return true;
  };
  const hotkeys = useWorkspaceHotkeys({
    isActive,
    enabled: !thumbnailOpen && !importOpen,
    handlers: {
      [HOTKEY_ACTIONS.TOGGLE_PANEL]: () => setPanelCollapsed((value) => !value),
      [HOTKEY_ACTIONS.RESET_VIEW]: () => viewportRef.current?.frame(cameraPresetRef.current),
      [HOTKEY_ACTIONS.CAMERA_PRESET_FRONT]: () => showShot("front"),
      [HOTKEY_ACTIONS.CAMERA_PRESET_BACK]: () => showShot("back"),
      [HOTKEY_ACTIONS.CAMERA_PRESET_SIDE]: () => showShot("right"),
      [HOTKEY_ACTIONS.CAPTURE_VIEW]: () => (isTauriRuntime && exportRun?.status !== "running" ? handleScreenshot() : false),
    },
  });

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const castStatuses = Object.fromEntries(CAST_SEATS.map((seat) => {
    const states = Object.values(figuresRef.current[seat].slotStates);
    return [seat, {
      // A custom character's ped as the bridge resolved it.
      label: figuresRef.current[seat].character?.label || "",
      loading: states.filter((state) => state.status === "loading").length,
      errors: states.filter((state) => state.status === "error").length,
    }];
  }));
  const loadingCount = castStatuses.a.loading + castStatuses.b.loading;
  const errorCount = castStatuses[focus].errors;
  const errorIssueCount = issues.filter((issue) => issue.severity === "error").length;
  const hiddenCount = Object.keys(hiddenSlots).length;
  const drawableCount = useMemo(
    () => listThumbnailJobs(pedAssets, { gender, race }).length,
    [pedAssets, gender, race],
  );

  const genderPieceList = pieces.filter((piece) => piece.gender === gender);
  const pieceSlotNames = Object.fromEntries(Object.entries(genderPieces).map(([component, piece]) => [component, baseName(piece.drawablePath)]));
  const replacedSlots = { ...genderSelections, ...Object.fromEntries(Object.keys(genderPieces).map((component) => [component, { piece: true }])) };
  const packRaces = listPackRaces(pedAssets);
  const bodyPresets = bodyPresetsFor(gender);
  // The generated outfit stays marked until a base slot it set is changed.
  const activeGenerated = generated && generated.signature === outfitSignature(genderOverrides) ? generated : null;
  const baseIndexOf = (component) => (Number.isInteger(genderOverrides?.[component]?.index)
    ? genderOverrides[component].index
    : DEFAULT_BASE_OUTFIT[gender][component]);
  const activePresetId = bodyPresets.find((preset) => preset.head === baseIndexOf("head")
    && preset.hair === baseIndexOf("hair")
    && preset.skin === skinTone
    && preset.hairColors.color === hair.color)?.id || null;
  const showroomOn = scene.stage === "showroom";
  const stageControls = {
    stage: scene.stage,
    setStage: (value) => updateScene({ stage: value }),
    stageLight: scene.light,
    setStageLight: (value) => updateScene({ light: value }),
    stageSpot: scene.spot,
    setStageSpot: (value) => updateScene({ spot: value }),
    stageReflect: scene.reflect,
    setStageReflect: (value) => updateScene({ reflect: value }),
    stageBeam: scene.beam,
    setStageBeam: (value) => updateScene({ beam: value }),
  };
  const clipProblem = clipState.key === clipKey && Boolean(clipState.refused || clipState.error);
  const poseNote = !wantedClip || !isTauriRuntime
    ? ""
    : clipState.key === clipKey && clipState.refused
      ? clipState.refused
      : clipState.key === clipKey && clipState.error
        ? `The animation didn't load: ${clipState.error}`
        : !clip
          ? "Loading the animation…"
          : "";
  const getFocusedTime = figure.getTime;
  const timeline = useMemo(() => (clip ? (
    <EupTimeline
      ref={timelineRef}
      clip={clip}
      playing={playing}
      onTogglePlay={togglePlay}
      getTime={getFocusedTime}
      onScrub={handleScrub}
      onScrubEnd={handleScrubEnd}
      speed={playback.speed}
      onSpeedChange={(speed) => setPlayback((prev) => ({ ...prev, speed }))}
      loop={playback.loop}
      onLoopChange={(loop) => setPlayback((prev) => ({ ...prev, loop }))}
    />
  ) : null), [clip, playing, togglePlay, getFocusedTime, handleScrub, handleScrubEnd, playback.speed, playback.loop]);
  const pedReady = !baseError && Object.values(slotStates).some((state) => state.source === "base" && state.status === "ready");
  const frameState = { isActive, isBooting: false, contextBarTarget, panelCollapsed, setPanelCollapsed, hotkeys };
  const exportBlocked = !isTauriRuntime
    ? "Exporting needs the desktop app."
    : figure.custom
      ? "Thumbnails are of EUP clothing on the freemode peds."
      : drawableCount === 0
      ? "Load clothing for this ped to export thumbnails."
      : "";
  const exportFormat = EXPORT_FORMATS.find((format) => format.id === exportSettings.format) || EXPORT_FORMATS[0];
  const showFrameGuide = isTauriRuntime && inspectorOpen && !panelCollapsed && inspectorTab === "export";
  const exportRunning = exportRun?.status === "running";

  return (
    <WorkspaceFrame s={frameState} inspectorOpen={inspectorOpen} setInspectorOpen={setInspectorOpen} className="eup-root" style={panes.style}>
      {/* ──── Asset pipeline ──── */}
      <aside className="lv-dock" aria-label="EUP clothing" inert={panelCollapsed}>
        <div className="lv-dock-scroll custom-scrollbar">
          {isTauriRuntime ? (
            <EupCastPanel
              cast={cast}
              focus={focus}
              statuses={castStatuses}
              onFocus={handleFocusSeat}
              onAdd={handleAddCharacter}
              onRemove={handleRemoveCharacter}
            />
          ) : null}
          <EupSourcePanel
            isTauriRuntime={isTauriRuntime}
            pedTitle={cast.b ? `Character ${castLetter(focus)}` : "Character"}
            model={member.model}
            character={figure.character}
            characterControls={characterControls}
            searchPeds={searchPeds}
            onOpenBody={() => {
              setInspectorTab("base");
              setInspectorOpen(true);
            }}
            clothingNote={customNote}
            gender={gender}
            race={race}
            onRaceChange={setRace}
            skinTone={skinTone}
            onSkinToneChange={setSkinTone}
            onImportCharacter={() => setImportOpen(true)}
            packRaces={packRaces}
            sourceFolders={sourceFolders}
            sourceFiles={sourceFiles}
            fileCount={grouped.files.length - otherPedCount}
            otherPedCount={otherPedCount}
            scanNotice={scanNotice}
            scanning={scanning}
            onOpenFolder={handleOpenFolder}
            onAddFiles={handleAddFiles}
            onRefresh={handleRefreshAssets}
            onRemoveFolder={handleRemoveFolder}
            onRemoveFile={handleRemoveFile}
            liveReload={liveReload}
            onLiveReloadChange={setLiveReload}
            watchState={watchState}
            pedReady={pedReady}
            baseError={baseError}
            onRetryBase={handleRetryBase}
            onRetryCharacter={handleRetryCharacter}
          />
          <EupPosePanel
            step={3}
            isTauriRuntime={isTauriRuntime}
            pose={pose}
            onPoseChange={handlePoseChange}
            poseNote={poseNote}
            poseNoteIsError={clipProblem}
            poseError={isTauriRuntime ? figure.skeletonError : ""}
            clipReady={pose === "bind" || Boolean(clip)}
            customAnimation={customAnimation}
            onCustomAnimationChange={handleCustomAnimationChange}
            clipListing={shownClipListing}
            onPickYcd={handlePickYcd}
            onReloadYcd={handleReloadYcd}
            searchDicts={searchAnimDicts}
            heldProps={member.heldProps}
            heldStates={figure.heldStates}
            skeletonTags={figure.skeletonTags}
            onAddGameProp={handleAddGameProp}
            onAddFileProp={handleAddFileProp}
            onChangeProp={handleChangeProp}
            onRemoveProp={handleRemoveProp}
            searchProps={searchGameProps}
            onImportEmote={handleImportEmote}
            playback={timeline}
            selectedHeldId={selectedHeldId}
            onSelectHeld={isTauriRuntime ? handleSelectHeldProp : null}
          />
          <EupPiecesPanel
            step={4}
            isTauriRuntime={isTauriRuntime}
            pieces={genderPieceList}
            otherGenderCount={pieces.length - genderPieceList.length}
            totalCount={pieces.length}
            slotStates={slotStates}
            onAdd={handleAddPieces}
            onToggleWorn={handleWearPiece}
            onChangeComponent={handleChangePieceComponent}
            onPickTexture={handlePickPieceTexture}
            onClearTexture={handleClearPieceTexture}
            onRemove={handleRemovePiece}
            blockedNote={customNote}
          />
          <EupOutfitPanel
            step={5}
            blockedNote={figure.custom ? `Saved outfits and Lua export are for freemode outfits. ${figure.character?.label || "This character"} isn't a freemode ped.` : ""}
            outfits={outfits[gender]}
            otherCount={outfits[gender === "female" ? "male" : "female"].length}
            otherPed={gender === "female" ? "male" : "female"}
            suggestedName={activeGenerated ? `${OUTFIT_STYLES.find((item) => item.id === activeGenerated.style)?.label}: ${activeGenerated.name}`.slice(0, 80) : outfitLabel}
            onSave={handleSaveOutfit}
            onApply={handleApplyOutfit}
            onDelete={handleDeleteOutfit}
            onCopyLua={handleCopyOutfitLua}
            onCopyCurrentLua={handleCopyCurrentLua}
          />
        </div>
        <div className="lv-dock-foot">
          <section className={`lv-capture ${isTauriRuntime ? "" : "is-disabled"}`} id="eup-export">
            <header className="lv-slot-head">
              <h3 className="lv-slot-title">Export</h3>
            </header>
            <div className="lv-slot-body">
              <p className="lv-slot-note">
                {isTauriRuntime ? "Shots, videos and colourway sheets of this outfit." : "Exporting needs the desktop app."}
              </p>
              <button
                type="button"
                className="cx-btn is-primary lv-capture-btn"
                disabled={!isTauriRuntime}
                onClick={openExport}
                aria-pressed={inspectorTab === "export" && inspectorOpen}
              >
                <Images aria-hidden="true" />
                {exportRunning ? "Exporting…" : "Export…"}
              </button>
              <button
                type="button"
                className="cx-btn lv-capture-btn"
                disabled={!isTauriRuntime || exportRunning}
                onClick={handleScreenshot}
                title="Save the viewfinder exactly as framed now"
              >
                <Aperture aria-hidden="true" />
                Save this view
              </button>
            </div>
          </section>
        </div>
        <PaneResizer side="dock" label="Resize the clothing panel" setWidth={panes.setWidth} />
      </aside>

      {/* ──── Viewfinder ──── */}
      <section className="lv-finder" aria-label="Ped preview">
        <div className="lv-stage">
          {isTauriRuntime ? (
            <EupViewport
              ref={viewportRef}
              pedRoot={stageRootRef.current}
              setRoot={setRootRef.current}
              gizmo={gizmo}
              onGizmoEnd={handleGizmoEnd}
              pickObjects={pickObjects}
              onPickObject={handlePickObject}
              focusRoot={cast.b ? figure.root : null}
              pickRoots={pickRoots}
              onPick={handleFocusSeat}
              isActive={isActive}
              backgroundColor={scene.backdrop}
              lightIntensity={scene.lightLevel}
              cameraPreset={cameraPreset}
              enabled={isTauriRuntime}
              stage={scene.stage}
              showroom={showroomOptions}
              showGrid={scene.grid}
              showShadows={scene.shadows}
              animating={playing && anyClip}
              onAnimate={handleAnimate}
            />
          ) : (
            <div className="eup-stage-empty">
              <Monitor aria-hidden="true" />
              <p className="eup-empty-title">Desktop app required</p>
              <p className="eup-empty-desc">Reading game files and EUP clothing needs the Cortex Studio desktop app.</p>
            </div>
          )}
          {showFrameGuide ? (
            <div className="eup-guide" aria-hidden="true" style={{ "--eup-guide-ratio": exportFormat.width / exportFormat.height }}>
              <div className="eup-guide-frame">
                <span className="eup-guide-label">
                  {exportFormat.label} · {exportSettings.mode === "sheet" ? "each colourway" : exportSettings.mode === "video" ? "video" : "This view"}
                </span>
              </div>
            </div>
          ) : null}
        </div>

        <div className="lv-hud">
          {isTauriRuntime ? (
            <div className="lv-stage-switch" role="radiogroup" aria-label="Stage">
              <button
                type="button"
                role="radio"
                aria-checked={!showroomOn}
                className={!showroomOn ? "is-on" : ""}
                onClick={() => updateScene({ stage: "workbench" })}
              >
                Workbench
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={showroomOn}
                className={showroomOn ? "is-on" : ""}
                onClick={() => updateScene({ stage: "showroom" })}
                title="A dark studio with a reflective floor and a spotlight you can aim"
              >
                <LampCeiling aria-hidden="true" />
                Showroom
              </button>
            </div>
          ) : null}

          {soloComponent || hiddenCount > 0 || loadingCount > 0 || errorCount > 0 ? (
            <div className="lv-slip eup-modes" role="status" aria-live="polite">
              {soloComponent ? (
                <span className="eup-mode">
                  <span>Only <b>{componentDisplayName(soloComponent)}</b></span>
                  <button type="button" className="lv-link" onClick={() => setSoloComponent(null)}>Show all</button>
                </span>
              ) : null}
              {hiddenCount > 0 ? (
                <span className="eup-mode">
                  <span>{hiddenCount} hidden</span>
                  <button type="button" className="lv-link" onClick={() => setHiddenSlots({})}>Show</button>
                </span>
              ) : null}
              {loadingCount > 0 ? (
                <span className="eup-mode">
                  <Loader2 className="eup-spin" aria-hidden="true" />
                  <span>Loading {loadingCount} {loadingCount === 1 ? "slot" : "slots"}…</span>
                </span>
              ) : null}
              {errorCount > 0 ? (
                <span className="eup-mode is-error">
                  <AlertTriangle aria-hidden="true" />
                  <span>{errorCount} {errorCount === 1 ? "slot didn't" : "slots didn't"} load</span>
                </span>
              ) : null}
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
                  <button type="button" className="cx-icon-btn" onClick={() => dismissAlert(alert.id)} aria-label="Dismiss">
                    <X aria-hidden="true" />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          <div className="lv-toasts">
            <AnimatePresence>
              {notice ? (
                <motion.div
                  key={notice.id}
                  className="lv-toast"
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 12 }}
                  transition={{ duration: 0.18 }}
                >
                  <Check aria-hidden="true" />
                  <span title={notice.message}>{notice.message}</span>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          {isTauriRuntime ? (
            <div className="lv-deck" role="toolbar" aria-label="Camera">
              <div className="lv-deck-group" role="group" aria-label="Camera shots">
                {EUP_CAMERA_PRESETS.map((preset) => (
                  <DeckButton
                    key={preset.key}
                    active={cameraPreset === preset.key}
                    onClick={() => {
                      setCameraPreset(preset.key);
                      if (preset.key === cameraPreset) viewportRef.current?.frame(preset.key);
                    }}
                    title={`${preset.label} view`}
                  >
                    {preset.label}
                  </DeckButton>
                ))}
                <DeckButton onClick={() => viewportRef.current?.frame(cameraPreset)} title="Frame the ped (F)" className="is-icon">
                  <Crosshair aria-hidden="true" />
                </DeckButton>
              </div>
              <div className="lv-deck-group" role="group" aria-label="View">
                {clip ? (
                  <DeckButton
                    active={playing}
                    onClick={togglePlay}
                    title={playing ? "Pause the animation (Space)" : "Play the animation (Space)"}
                    className="is-icon"
                  >
                    {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                  </DeckButton>
                ) : null}
                <DeckButton
                  active={scene.grid && !showroomOn}
                  onClick={() => updateScene({ grid: !scene.grid })}
                  title={showroomOn ? "Ground grid (workbench only)" : "Ground grid"}
                  disabled={showroomOn}
                  className="is-icon"
                >
                  <Grid3x3 aria-hidden="true" />
                </DeckButton>
                <DeckButton
                  active={scene.shadows || showroomOn}
                  onClick={() => updateScene({ shadows: !scene.shadows })}
                  title={showroomOn ? "Shadows are always on in the showroom" : "Ground shadow"}
                  disabled={showroomOn}
                  className="is-icon"
                >
                  <Sun aria-hidden="true" />
                </DeckButton>
              </div>
              <div className="lv-deck-group">
                <DeckButton active={helpOpen} onClick={() => setHelpOpen((open) => !open)} title="Mouse and keyboard controls" className="is-icon">
                  <CircleHelp aria-hidden="true" />
                </DeckButton>
              </div>
              {helpOpen ? <EupHelp /> : null}
            </div>
          ) : null}
        </div>
      </section>

      {/* ──── Inspector ──── */}
      <aside className="lv-inspector eup-inspector" aria-label="Inspector" inert={panelCollapsed || !inspectorOpen}>
        <PaneResizer side="insp" label="Resize the inspector" setWidth={panes.setWidth} />
        <InspectorTabs
          tabs={[
            { id: "clothing", label: "Clothing" },
            { id: "pack", label: "Pack" },
            { id: "base", label: "Body" },
            { id: "scene", label: "Scene" },
            { id: "export", label: "Export" },
            {
              id: "issues",
              label: (
                <>
                  Issues
                  {issues.length > 0 ? (
                    <span className={`eup-tab-count ${errorIssueCount > 0 ? "is-error" : ""}`}>{issues.length}</span>
                  ) : null}
                </>
              ),
            },
          ]}
          active={inspectorTab}
          onChange={setInspectorTab}
        />
        <div className="lv-inspector-scroll custom-scrollbar">
          {inspectorTab === "clothing" ? (
            <section className="lv-group">
              <div className="lv-group-head">
                <h3 className="lv-group-title">
                  {assetComponents.length > 0
                    ? `${assetComponents.length} ${assetComponents.length === 1 ? "slot" : "slots"} in your clothing`
                    : "Your clothing"}
                </h3>
                <button type="button" className="lv-link" onClick={handleResetOutfit} title="Go back to the base ped">
                  Reset outfit
                </button>
              </div>
              {figure.custom ? <p className="lv-slot-note">{customNote}</p> : (
              <EupComponentList
                pedAssets={pedAssets}
                selections={genderSelections}
                pieceSlots={pieceSlotNames}
                slotStates={slotStates}
                fileSizes={fileSizes}
                focusComponent={activeComponent}
                hiddenSlots={hiddenSlots}
                soloComponent={soloComponent}
                onFocusComponent={setFocusComponent}
                onSelectDrawable={handleSelectDrawable}
                onSelectVariant={handleSelectVariant}
                onToggleHidden={handleToggleHidden}
                onToggleSolo={handleToggleSolo}
                emptyMessage={
                  fileList.length === 0
                    ? "Open an EUP folder or add files to list drawables."
                    : `No files match ${ped}. Switch the ped or check the names.`
                }
              />
              )}
            </section>
          ) : null}
          {inspectorTab === "base" && figure.custom ? (
            <EupCharacterBody
              character={figure.character}
              variation={member.variations?.[figure.modelKey]}
              slotStates={slotStates}
              onVariationChange={characterControls.setVariation}
            />
          ) : inspectorTab === "base" ? (
            <EupBasePanel
              gender={gender}
              presets={bodyPresets}
              activePresetId={activePresetId}
              onApplyPreset={handleApplyBodyPreset}
              generated={activeGenerated}
              generating={generating}
              generatorReady={isTauriRuntime && Boolean(baseIndexes)}
              generatorNote={isTauriRuntime ? (baseIndexes ? "" : "Loading the game's clothing…") : "Generating outfits needs the desktop app and GTA V."}
              onGenerate={handleGenerateOutfit}
              gameIndexes={baseIndexes}
              hair={hair}
              onHairChange={setHair}
              onChangeVariant={handleChangeBaseVariant}
              baseOverrides={genderOverrides}
              slotStates={slotStates}
              selections={replacedSlots}
              onChangeIndex={handleChangeBaseIndex}
              onToggleEnabled={handleToggleBaseEnabled}
            />
          ) : null}
          {inspectorTab === "scene" ? (
            <>
              <EupScenePanel
                isTauriRuntime={isTauriRuntime}
                props={sceneProps}
                states={sceneSet.states}
                selectedId={selection?.kind === "scene" ? selection.id : null}
                onSelect={handleSelectSceneProp}
                searchProps={searchGameProps}
                onAddGame={handleAddGameSceneProp}
                onAddFile={handleAddScenePropFile}
                onChange={updateSceneProp}
                onToggleHidden={handleToggleScenePropHidden}
                onDuplicate={handleDuplicateSceneProp}
                onRemove={handleRemoveSceneProp}
                onRetry={sceneSet.retry}
                onLocate={handleLocateSceneProp}
                removed={removedProp}
                onUndo={handleUndoRemoveSceneProp}
                gizmoMode={gizmoMode}
                onGizmoModeChange={setGizmoMode}
              />
              <StageSection s={stageControls} notes={STAGE_NOTES}>
                <FloorField id="eup-floor-label" value={scene.floor} onChange={(floor) => updateScene({ floor })} />
                <Slider
                  id="eup-stage-rim"
                  label="Rim light"
                  value={scene.rim}
                  min={0}
                  max={2}
                  step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(value) => updateScene({ rim: value })}
                />
              </StageSection>
              {!showroomOn ? (
                <section className="lv-group">
                  <h3 className="lv-group-title">Backdrop</h3>
                  <div className="lv-colors">
                    <ColorLine
                      label="Background"
                      value={scene.backdrop}
                      onChange={(value) => updateScene({ backdrop: value })}
                      onReset={() => updateScene({ backdrop: readViewerPrefs().background })}
                    />
                  </div>
                </section>
              ) : null}
              <section className="lv-group">
                <h3 className="lv-group-title">Light</h3>
                <Slider
                  id="eup-light"
                  label="Fill light"
                  value={scene.lightLevel}
                  min={0}
                  max={3}
                  step={0.05}
                  format={(v) => `${v.toFixed(2)}×`}
                  onChange={(value) => updateScene({ lightLevel: value })}
                />
              </section>
            </>
          ) : null}
          {inspectorTab === "export" ? (
            <EupExportPanel
              settings={exportSettings}
              onChange={updateExportSettings}
              stem={exportName}
              stemPlaceholder={exportFileStem(outfitLabel)}
              onStemChange={setExportName}
              isTauriRuntime={isTauriRuntime}
              showroomOn={showroomOn}
              videoType={videoType}
              sheetOptions={sheetOptions}
              sheetComponent={sheetChoice?.component || null}
              onSheetComponentChange={setSheetComponent}
              run={exportRun}
              onShots={handleExportShots}
              onVideo={handleExportVideo}
              onSheet={handleExportSheet}
              onCancel={handleCancelExport}
              onConfirm={handleConfirmExport}
              onDismiss={handleDismissExport}
              onOpenFolder={handleOpenExportFolder}
              onThumbnails={() => setThumbnailOpen(true)}
              thumbnailsBlocked={exportBlocked}
              sheetNote={figure.custom ? "Colourway sheets show EUP clothing textures on the freemode peds." : ""}
            />
          ) : null}
          {inspectorTab === "issues" ? <EupIssuesPanel issues={issues} /> : null}
          {inspectorTab === "pack" ? (
            <EupPackPanel
              isTauriRuntime={isTauriRuntime}
              gender={gender}
              project={packProject}
              onProjectChange={setPackProject}
              pack={pack}
              selectedKeys={packSelection}
              onSelectItem={handleSelectPackItem}
              onShowGender={(target) => characterControls.setModel({ kind: "freemode", gender: target })}
              onAddFolder={handleOpenFolder}
              onPickParent={handlePickPackParent}
              hatWorn={Boolean(genderSelections?.p_head)}
              note={figure.custom ? `${figure.character?.label || "This character"} isn't a freemode ped, so selecting an item doesn't dress it. The pack still builds.` : ""}
            />
          ) : null}
        </div>
        {inspectorTab === "pack" && isTauriRuntime ? (
          <EupPackFooter isTauriRuntime={isTauriRuntime} project={packProject} pack={pack} onOpenFolder={openFolderPath} />
        ) : null}
        {inspectorTab === "clothing" && assetComponents.length > 0 ? (
          <div className="eup-keys" aria-hidden="true">
            <span><kbd className="cx-keycap">←</kbd><kbd className="cx-keycap">→</kbd>Drawable</span>
            <span><kbd className="cx-keycap">↑</kbd><kbd className="cx-keycap">↓</kbd>Texture</span>
            <span><kbd className="cx-keycap">H</kbd>Hide</span>
            <span><kbd className="cx-keycap">S</kbd>Solo</span>
          </div>
        ) : null}
      </aside>

      {importOpen && (
        <EupCharacterImportDialog
          isTauriRuntime={isTauriRuntime}
          onScan={scanFivemCharacters}
          loadContext={loadImportContext}
          onWear={handleWearCharacter}
          onClose={() => setImportOpen(false)}
        />
      )}
      {thumbnailOpen && (
        <EupThumbnailDialog
          gender={gender}
          focusComponent={activeComponent}
          buildJobs={buildThumbnailJobs}
          onPickFolder={handlePickThumbnailFolder}
          onCountConflicts={handleCountThumbnailConflicts}
          onRun={handleRunThumbnails}
          onCancel={handleCancelThumbnails}
          onClose={handleCloseThumbnails}
          onOpenFolder={openFolderPath}
          run={thumbnailRun}
        />
      )}
    </WorkspaceFrame>
  );
}
