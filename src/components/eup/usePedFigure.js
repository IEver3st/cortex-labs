import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  COMPONENT_IDS,
  DEFAULT_BASE_OUTFIT,
  PED_FOR_GENDER,
  PROP_IDS,
  baseName,
  buildDrawableRanges,
  buildGameDrawableIndex,
  extendPedListing,
  formatIndex,
  isSkinTintSlot,
  isYtdPath,
  resolveDrawableNumber,
  resolveTextureForDrawable,
  selectBaseGameAssets,
  skinToneTint,
  wornAddonPieces,
} from "../../lib/eup";
import { projectPieces } from "../../lib/eup-cast";
import { disposeTexture, loadTextureFromPath } from "../../lib/viewer-utils";
import {
  buildSlotGroup,
  computePedBounds,
  createPedRoot,
  disposeSlotGroup,
  invalidatePedDrawables,
  setGroupHairColor,
  setGroupPose,
  setGroupSkinTint,
  setHeldPropSpec,
  setPedPose,
  setSlotHidden,
  updatePedPropAttachments,
} from "../../lib/ped-assembly";
import {
  CUSTOM_POSE,
  PED_POSES,
  clipGroundSpeed,
  customAnimationKey,
  heldPropModelKey,
  isValidClip,
  poseClip,
  sampleClipPose,
} from "../../lib/ped-pose";
import { advanceClipTime, clampClipTime } from "../../lib/eup-playback";
import { loadNativeMaterialView } from "../../lib/native-materials";
import {
  characterKey,
  characterName,
  clipRefusedNote,
  clipSkeletonMatch,
  describedCandidates,
  isCustomCharacter,
  keepsSlotOnScreen,
  resolveCharacterSlots,
  skeletonFromDescription,
} from "../../lib/ped-character";
import { loadPropAsset } from "../../lib/prop-model";
import {
  describeCharacter,
  exportGameProp,
  exportPedAsset,
  exportYtd,
  fetchCharacterFile,
  getClipByKey,
  getPedListing,
  getPedSkeleton,
  readPedDrawable,
} from "./ped-files";

// The floor sits under the lowest point across this many samples of a clip,
// so feet never sink below it mid-step.
const FLOOR_SAMPLES = 8;
const NO_VISIBILITY = Object.freeze({ hidden: {}, solo: null });
const EMPTY_PED_ASSETS = Object.freeze({ components: {}, props: {} });
const SLOT_IDS = Object.freeze([...COMPONENT_IDS, ...PROP_IDS]);
const NO_HELD_PROPS = Object.freeze([]);
// Custom clips slower than this are idles that drift, not locomotion; they
// play without scrolling the floor.
const MIN_CUSTOM_WALK_SPEED = 0.25;

/** The clip key for a member's pose: a preset's game clip or the Custom clip. */
function memberClipKey(member, gender) {
  if (!member) return "";
  if (member.pose === CUSTOM_POSE) return customAnimationKey(member.animation);
  const wanted = poseClip(member.pose, gender);
  return wanted ? `game:${wanted.dict}/${wanted.clip}` : "";
}

function walkSpeedFor(member, clip) {
  if (!clip) return 0;
  if (member?.pose === CUSTOM_POSE) {
    const speed = clipGroundSpeed(clip);
    return speed >= MIN_CUSTOM_WALK_SPEED ? speed : 0;
  }
  return PED_POSES.find((item) => item.id === member?.pose)?.walk ? clipGroundSpeed(clip) : 0;
}

// Frees a held prop: its streamed native textures first (which restores the
// base materials), then geometry and materials.
function disposeHeldProp(entry) {
  entry.controller.abort();
  entry.native?.dispose?.();
  entry.native = null;
  const group = entry.group;
  entry.group = null;
  if (!group) return;
  group.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose?.();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) material?.dispose?.();
  });
  group.removeFromParent();
}

function showNativeMaterials(object) {
  object.traverse((child) => {
    if (child.isMesh && child.userData.nativeMaterialObject) child.material = child.userData.nativeMaterialObject;
  });
}

/**
 * Local DDS paths for a character slot's textures (diffuse, then normal), each
 * dictionary fetched once. Missing textures come back as a note; the drawable
 * still shows, untextured.
 */
async function fetchCharacterTextures(description, slot) {
  const wanted = [slot.diffuse, slot.normal].filter(Boolean);
  const listings = new Map();
  for (const texture of wanted) {
    if (!listings.has(texture.file)) listings.set(texture.file, fetchCharacterFile(description, texture.file).catch((error) => ({ error })));
  }
  const paths = [];
  let note = slot.diffuse ? null : `Texture: ${slot.name} has no diffuse texture in the ped's files`;
  for (const texture of wanted) {
    const listing = await listings.get(texture.file);
    const found = (listing?.textures || []).find((item) => String(item.name).toLowerCase() === texture.name.toLowerCase());
    if (found?.path) paths.push(found.path);
    else note ||= listing?.error ? `Texture: ${errorMessage(listing.error)}` : `Texture: ${texture.name} isn't in its dictionary`;
  }
  return { paths, note };
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

/**
 * One character on the EUP stage: its ped root, the slot groups worn on it,
 * its skeleton, animation, skin tone and hair. Slots load and unload to match
 * `member`; pose, tint, hair and visibility apply in place without a reload.
 * A null `member` empties the figure.
 *
 * The root is added to `stageRoot` for the hook's lifetime and stands at
 * `offsetX`. `onSettled` runs whenever every slot has finished loading; a
 * custom character still being described has not. Each `describeRetry` bump
 * reads this character's description again.
 */
export function usePedFigure({
  enabled,
  member,
  pieces,
  pedAssetsByGender,
  serverListingsByGender,
  revisionOf,
  assetRevision,
  baseRetry,
  describeRetry = 0,
  stageRoot,
  offsetX = 0,
  viewportRef,
  freezeRef,
  visibility = NO_VISIBILITY,
  clipRevision = 0,
  onSettled,
}) {
  const present = Boolean(member);
  const gender = member?.gender === "female" ? "female" : "male";
  const ped = PED_FOR_GENDER[gender];
  // A game ped or the user's ped files instead of freemode: described by the
  // bridge and dressed from its own variations, without EUP clothing or tint.
  const model = member?.model;
  const custom = present && isCustomCharacter(model);
  const modelKey = custom ? characterKey(model) : "";
  const modelRef = useRef(model);
  modelRef.current = model;
  const variation = custom ? member?.variations?.[modelKey] : null;
  const race = member?.race;
  const pedAssets = pedAssetsByGender?.[gender] || EMPTY_PED_ASSETS;
  const selections = member?.selections?.[gender];
  const overrides = member?.baseOverrides?.[gender];
  // Loaded addon packs, numbered after the game's clothing as on a server.
  const serverListing = serverListingsByGender?.[gender] || null;
  const serverListingRef = useRef(serverListing);
  serverListingRef.current = serverListing;

  const [slotStates, setSlotStates] = useState({});
  const [baseError, setBaseError] = useState("");
  const [pedSkeleton, setPedSkeleton] = useState({ ped: null, skeleton: null, error: "" });
  const [pedListing, setPedListing] = useState({ ped: null, listing: null });
  const [clipState, setClipState] = useState({ key: "", clip: null, error: "", loading: false });
  const [described, setDescribed] = useState({ key: "", description: null, error: "", loading: false, revision: 0 });

  const rootRef = useRef(null);
  if (!rootRef.current) rootRef.current = createPedRoot();
  const runtimeRef = useRef(new Map());
  const timeRef = useRef(0);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const visibilityRef = useRef(visibility);
  visibilityRef.current = visibility;

  const description = custom && described.key === modelKey && described.description?.ped ? described.description : null;
  // Until the description is in, a custom character has slots still to come:
  // its empty stage isn't settled, so the camera doesn't frame it.
  const describing = custom && (described.key !== modelKey || described.loading);
  const describingRef = useRef(describing);
  describingRef.current = describing;
  const characterSkeleton = useMemo(
    () => (description ? skeletonFromDescription(description.skeleton?.bones) : null),
    [description],
  );
  const skeleton = custom ? characterSkeleton : pedSkeleton.ped === ped ? pedSkeleton.skeleton : null;
  const gameListing = pedListing.ped === ped ? pedListing.listing : null;
  const listing = useMemo(() => extendPedListing(gameListing, serverListing), [gameListing, serverListing]);
  // In-game drawable numbers per slot: the game's collections, then server packs.
  const gameIndexes = useMemo(() => (listing?.collections?.length
    ? Object.fromEntries(SLOT_IDS.map((component) => [component, buildGameDrawableIndex(listing.entries, listing.collections, component)]))
    : null), [listing]);
  const serverEntriesByFolder = useMemo(() => {
    const byFolder = new Map();
    for (const entry of serverListing?.entries || []) {
      if (!byFolder.has(entry.folder)) byFolder.set(entry.folder, []);
      byFolder.get(entry.folder).push(entry);
    }
    return byFolder;
  }, [serverListing]);
  const clipKey = memberClipKey(member, gender);
  const wantedClip = clipKey ? { key: clipKey } : null;
  // A file clip reloads when the user asks; game clips never change.
  const clipFetchRevision = clipKey.startsWith("file:") ? clipRevision : 0;
  const loadedClip = clipKey && clipState.key === clipKey ? clipState.clip : null;
  // A clip made for another skeleton (a human walk on a dog) would tear the
  // mesh apart; the character keeps its rest pose and the note says why.
  const clipFit = custom && skeleton && loadedClip ? clipSkeletonMatch(skeleton, loadedClip) : null;
  const clip = clipFit?.fits === false ? null : loadedClip;
  const walkSpeed = walkSpeedFor(member, clip);
  const heldProps = present ? member.heldProps || NO_HELD_PROPS : NO_HELD_PROPS;
  const tint = skinToneTint(member?.skinTone);
  const hair = member?.hair;

  // Slots finishing later pick up the pose and tint current at that moment.
  const lookRef = useRef({ skeleton: null, clip: null, tint: null, walkSpeed: 0, hair: null });
  lookRef.current = { skeleton, clip, tint, walkSpeed, hair };
  const currentPose = useCallback(() => {
    const { skeleton: bones, clip: active } = lookRef.current;
    return bones && active ? sampleClipPose(bones, active, timeRef.current) : null;
  }, []);

  /* ── Stage placement ── */
  useEffect(() => {
    const root = rootRef.current;
    stageRoot.add(root);
    return () => {
      stageRoot.remove(root);
    };
  }, [stageRoot]);

  /* ── Desired outfit (one slot per component) ── */
  const wornPieces = useMemo(
    () => (present ? wornAddonPieces(projectPieces(pieces, member.worn), gender) : {}),
    [present, pieces, member?.worn, gender],
  );

  const describedRevision = described.revision;
  const desiredSlots = useMemo(() => {
    const slots = {};
    if (!present) return slots;
    if (custom) {
      for (const slot of description ? resolveCharacterSlots(description, variation) : []) {
        slots[slot.slot] = {
          source: "character",
          component: slot.slot,
          ped: description.ped,
          modelKey,
          description,
          skeleton: characterSkeleton,
          slot,
          key: `character|${modelKey}|${describedRevision}|${slot.slot}|${slot.name}|${slot.diffuse?.name || ""}|${slot.normal?.name || ""}`,
        };
      }
      return slots;
    }
    const eupSlot = (component, drawable, variant) => {
      const texture = resolveTextureForDrawable(drawable, variant, { race });
      const ytdPath = texture?.path || null;
      return {
        source: "eup",
        component,
        ped,
        drawablePath: drawable.drawablePath,
        ytdPath,
        key: `eup|${drawable.drawablePath}@${revisionOf(drawable.drawablePath)}|${ytdPath || ""}@${revisionOf(ytdPath)}|${assetRevision}`,
      };
    };
    const pieceSlot = (piece) => ({
      source: "piece",
      component: piece.component,
      ped,
      pieceId: piece.id,
      drawablePath: piece.drawablePath,
      texturePath: piece.texturePath || null,
      key: `piece|${piece.id}|${piece.drawablePath}@${revisionOf(piece.drawablePath)}|${piece.texturePath || ""}@${revisionOf(piece.texturePath)}|${assetRevision}`,
    });
    // A base number inside a loaded server pack wears that pack's files; its
    // key follows their revisions so live reload reaches it like pack clothing.
    const baseSlot = (component, index, variant) => {
      const slot = { source: "base", component, ped, index, variant, race, key: `base|${ped}|${component}|${index}|${variant}|${race}|${baseRetry}` };
      const origin = resolveDrawableNumber(gameIndexes?.[component]?.ranges, index);
      if (!origin?.server) return slot;
      const { drawable, texture } = selectBaseGameAssets(serverEntriesByFolder.get(origin.folder), ped, component, origin.local, { race, variant });
      if (!drawable) return slot;
      const ytdPath = texture?.path || null;
      return {
        ...slot,
        server: origin.pack,
        drawablePath: drawable.path,
        ytdPath,
        key: `${slot.key}|server|${drawable.path}@${revisionOf(drawable.path)}|${ytdPath || ""}@${revisionOf(ytdPath)}|${assetRevision}`,
      };
    };
    for (const component of COMPONENT_IDS) {
      if (wornPieces[component]) {
        slots[component] = pieceSlot(wornPieces[component]);
        continue;
      }
      const selection = selections?.[component];
      const entry = Number.isInteger(selection?.index)
        ? pedAssets.components?.[component]?.drawables?.[selection.index]
        : null;
      if (entry?.drawablePath) {
        slots[component] = eupSlot(component, entry, selection.variant);
        continue;
      }
      const override = overrides?.[component];
      if (override?.enabled === false) continue;
      const index = Number.isInteger(override?.index) ? override.index : DEFAULT_BASE_OUTFIT[gender][component];
      const variant = /^[a-z]$/.test(override?.variant || "") ? override.variant : "a";
      slots[component] = baseSlot(component, index, variant);
    }
    // Game props are off unless switched on (or worn by an imported character).
    for (const component of PROP_IDS) {
      const override = overrides?.[component];
      if (override?.enabled !== true) continue;
      const index = Number.isInteger(override.index) ? override.index : 0;
      const variant = /^[a-z]$/.test(override.variant || "") ? override.variant : "a";
      slots[component] = baseSlot(component, index, variant);
    }
    for (const [component, entry] of Object.entries(pedAssets.props || {})) {
      const selection = selections?.[component];
      const drawable = Number.isInteger(selection?.index) ? entry.drawables?.[selection.index] : null;
      if (!drawable?.drawablePath) continue;
      slots[component] = eupSlot(component, drawable, selection.variant);
    }
    for (const component of PROP_IDS) {
      if (wornPieces[component]) slots[component] = pieceSlot(wornPieces[component]);
    }
    return slots;
  }, [present, selections, overrides, wornPieces, pedAssets, gender, ped, race, baseRetry, assetRevision, revisionOf, gameIndexes, serverEntriesByFolder,
    custom, description, variation, characterSkeleton, modelKey, describedRevision]);

  const settleFloor = useCallback(() => {
    const root = rootRef.current;
    const { skeleton: bones, clip: active } = lookRef.current;
    root.position.y = 0;
    let lowest = Infinity;
    const measure = () => {
      const bounds = computePedBounds(root);
      if (bounds) lowest = Math.min(lowest, bounds.min.y);
    };
    if (bones && active) {
      for (let i = 0; i < FLOOR_SAMPLES; i += 1) {
        setPedPose(root, bones, sampleClipPose(bones, active, (active.duration * i) / FLOOR_SAMPLES));
        measure();
      }
      setPedPose(root, bones, sampleClipPose(bones, active, timeRef.current));
    } else {
      updatePedPropAttachments(root);
      measure();
    }
    if (Number.isFinite(lowest)) root.position.y = -lowest;
    root.updateMatrixWorld(true);
    viewportRef.current?.refit?.();
  }, [viewportRef]);

  // Skinned bounds cost a CPU skin pass per sample; slots load in bursts, so
  // settle once per frame at most.
  const settleFrameRef = useRef(0);
  const scheduleSettle = useCallback(() => {
    if (settleFrameRef.current) return;
    settleFrameRef.current = requestAnimationFrame(() => {
      settleFrameRef.current = 0;
      settleFloor();
      viewportRef.current?.requestRender();
    });
  }, [settleFloor, viewportRef]);
  useEffect(() => () => cancelAnimationFrame(settleFrameRef.current), []);

  const applyVisibility = useCallback((component, group) => {
    if (!group) return;
    const { hidden, solo } = visibilityRef.current;
    setSlotHidden(group, Boolean(hidden[component]) || (Boolean(solo) && solo !== component));
  }, []);

  const updateSlotState = useCallback((component, patch) => {
    setSlotStates((prev) => ({ ...prev, [component]: { ...(prev[component] || {}), ...patch } }));
  }, []);

  const isSettled = useCallback(
    () => !describingRef.current && [...runtimeRef.current.values()].every((slot) => slot.settled),
    [],
  );

  const loadSlot = useCallback(
    async (spec, mounted) => {
      const { component, source } = spec;
      const { signal } = mounted.controller;
      const pieceId = spec.pieceId || null;
      updateSlotState(component, { status: "loading", source, error: null, label: null, pieceId });
      // A piece's painted image, decoded here and owned by the slot group once
      // it is built; disposed in finally if the load stops before that.
      let pendingTexture = null;
      let textureNote = null;
      try {
        let drawablePath;
        let texturePaths = [];
        let label;
        let skinFiles = null;
        let drawableHash = null;
        let readBytes = readFile;
        if (source === "character") {
          const { description: owner, slot } = spec;
          if (!slot.drawable) throw new Error(`${slot.name} is listed in the ped's variations but isn't in its files`);
          const [exported, textures] = await Promise.all([
            fetchCharacterFile(owner, slot.drawable.file),
            fetchCharacterTextures(owner, slot),
          ]);
          drawablePath = exported?.path;
          const ref = owner.files?.[slot.drawable.file];
          // A component ped keeps every drawable in one dictionary.
          if (ref?.dictionary) drawableHash = slot.drawable.hash;
          // The user's own drawable is read natively (see readPedDrawable); its
          // textures were exported into the cache like every other slot's.
          if (ref?.path) readBytes = (path) => (path === drawablePath ? readPedDrawable(path) : readFile(path));
          label = slot.name;
          texturePaths = textures.paths;
          textureNote = textures.note;
        } else if (source === "base" && spec.drawablePath) {
          // A server pack drawable: the pack's own files, nothing to export.
          drawablePath = spec.drawablePath;
          label = baseName(spec.drawablePath);
          skinFiles = { drawableFile: spec.drawablePath, textureFile: spec.ytdPath };
          if (spec.ytdPath) {
            const exportedTexture = await exportYtd(spec.ytdPath);
            texturePaths = (exportedTexture?.textures || []).map((item) => item.path);
          }
        } else if (source === "base") {
          let listing;
          try {
            listing = extendPedListing(await getPedListing(spec.ped), serverListingRef.current);
          } catch (error) {
            setBaseError(`Game files unavailable: ${errorMessage(error)}`);
            throw error;
          }
          const { drawable, texture } = selectBaseGameAssets(listing?.entries, spec.ped, component, spec.index, {
            race: spec.race,
            collections: listing?.collections,
            variant: spec.variant,
          });
          if (!drawable) {
            const ranges = buildDrawableRanges(listing?.entries, listing?.collections, component);
            const last = ranges[ranges.length - 1];
            throw new Error(last
              ? `${component} ${spec.index} isn't in the game files; this ped has 0-${last.start + last.count - 1}`
              : `No ${component}_${formatIndex(spec.index)} drawable in the game files`);
          }
          if (signal.aborted) return;
          // Server pack entries carry their file; game entries are exported.
          const exported = drawable.path ? { path: drawable.path } : await exportPedAsset(spec.ped, drawable);
          drawablePath = exported?.path;
          label = drawable.file;
          skinFiles = { drawableFile: drawable.file, textureFile: texture?.file };
          if (texture) {
            const exportedTexture = texture.path ? await exportYtd(texture.path) : await exportPedAsset(spec.ped, texture);
            texturePaths = (exportedTexture?.textures || []).map((item) => item.path);
          }
        } else if (source === "piece") {
          drawablePath = spec.drawablePath;
          label = baseName(spec.drawablePath);
          skinFiles = { drawableFile: spec.drawablePath, textureFile: spec.texturePath };
          if (spec.texturePath && isYtdPath(spec.texturePath)) {
            try {
              const exportedTexture = await exportYtd(spec.texturePath);
              texturePaths = (exportedTexture?.textures || []).map((item) => item.path);
            } catch (error) {
              // The drawable still shows, untextured, with the reason.
              textureNote = `Texture: ${errorMessage(error)}`;
            }
          } else if (spec.texturePath) {
            pendingTexture = await loadTextureFromPath(spec.texturePath, null, viewportRef.current?.getRenderer?.()).catch((error) => {
              textureNote = error?.type === "unsupported-bit-depth"
                ? `Texture: ${error.bitDepth}-bit images aren't supported; save ${baseName(spec.texturePath)} as 8-bit`
                : `Texture: ${errorMessage(error)}`;
              return null;
            });
            if (pendingTexture) pendingTexture.name = baseName(spec.texturePath);
            else if (!textureNote) textureNote = `Texture: ${baseName(spec.texturePath)} couldn't be read`;
          }
        } else {
          drawablePath = spec.drawablePath;
          label = baseName(spec.drawablePath);
          skinFiles = { drawableFile: spec.drawablePath, textureFile: spec.ytdPath };
          if (spec.ytdPath) {
            const exportedTexture = await exportYtd(spec.ytdPath);
            texturePaths = (exportedTexture?.textures || []).map((item) => item.path);
          }
        }
        if (!drawablePath) throw new Error(`Export returned no drawable path for ${component}`);
        if (signal.aborted) return;

        // Without the skeleton the slot still renders, unposed, in the bind pose.
        const bones = source === "character" ? spec.skeleton : await getPedSkeleton(spec.ped).catch(() => null);
        if (signal.aborted) return;
        // Only freemode hair is a tint mask; other peds' hair is coloured.
        const group = await buildSlotGroup({ component, drawablePath, texturePaths, readFile: readBytes, signal, skeleton: bones,
          diffuseTexture: pendingTexture, renderer: viewportRef.current?.getRenderer?.(), drawableHash, hairTint: source !== "character" });
        pendingTexture = null;
        if (signal.aborted) {
          disposeSlotGroup(group);
          return;
        }
        // The previous drawable stays visible until its replacement is ready,
        // so live reload swaps in place instead of flashing an empty slot.
        if (mounted.stale) {
          disposeSlotGroup(mounted.stale);
          mounted.stale = null;
        }
        mounted.group = group;
        group.userData.skinTintable = source !== "character" && isSkinTintSlot({ component, ...skinFiles });
        setGroupSkinTint(group, lookRef.current.tint);
        setGroupHairColor(group, lookRef.current.hair);
        if (bones === lookRef.current.skeleton) setGroupPose(group, currentPose());
        rootRef.current.add(group);
        scheduleSettle();
        applyVisibility(component, group);
        const textureErrors = group.userData.textureErrors || [];
        updateSlotState(component, {
          status: "ready",
          source,
          label,
          error: textureErrors.length ? `Texture: ${textureErrors[0].message}` : textureNote,
          pieceId,
          info: source !== "base" && source !== "character"
            ? {
                drawablePath: spec.drawablePath,
                ytdPath: spec.ytdPath ?? spec.texturePath,
                stats: group.userData.stats,
                textureInfo: group.userData.textureInfo,
                textureNames: group.userData.textureNames,
              }
            : null,
        });
        if (source === "base") setBaseError("");
        viewportRef.current?.requestRender();
      } catch (error) {
        if (error?.name === "AbortError" || signal.aborted) return;
        if (mounted.stale) {
          disposeSlotGroup(mounted.stale);
          mounted.stale = null;
          scheduleSettle();
          viewportRef.current?.requestRender();
        }
        updateSlotState(component, { status: "error", source, error: errorMessage(error), info: null, pieceId });
      } finally {
        if (pendingTexture) disposeTexture(pendingTexture);
        mounted.settled = true;
        if (!signal.aborted && isSettled()) onSettledRef.current?.();
      }
    },
    [applyVisibility, currentPose, isSettled, scheduleSettle, updateSlotState, viewportRef],
  );

  /* ── Slot runtime: mount/unmount groups to match desiredSlots ── */
  useEffect(() => {
    if (!enabled) return;
    const runtime = runtimeRef.current;
    const removed = [];
    const carried = new Map();
    for (const [component, mounted] of runtime) {
      const want = desiredSlots[component];
      if (want && want.key === mounted.key) continue;
      mounted.controller.abort();
      const visible = mounted.group || mounted.stale;
      if (keepsSlotOnScreen(mounted, want) && visible) {
        // Same slot, new revision: keep what is on screen until the reload lands.
        if (mounted.group && mounted.stale) disposeSlotGroup(mounted.stale);
        carried.set(component, visible);
      } else {
        if (mounted.group) disposeSlotGroup(mounted.group);
        if (mounted.stale) disposeSlotGroup(mounted.stale);
        removed.push(component);
      }
      runtime.delete(component);
    }
    if (removed.length > 0) {
      setSlotStates((prev) => {
        const next = { ...prev };
        for (const component of removed) delete next[component];
        return next;
      });
      scheduleSettle();
      viewportRef.current?.requestRender();
    }
    for (const [component, spec] of Object.entries(desiredSlots)) {
      if (runtime.has(component)) continue;
      const mounted = {
        key: spec.key,
        source: spec.source,
        modelKey: spec.modelKey || "",
        drawablePath: spec.drawablePath || null,
        group: null,
        stale: carried.get(component) || null,
        controller: new AbortController(),
      };
      runtime.set(component, mounted);
      loadSlot(spec, mounted);
    }
    // An emptied figure has nothing left to load, unless a custom character's
    // slots are still to come from its description.
    if (runtime.size === 0 && removed.length > 0 && !describingRef.current) onSettledRef.current?.();
  }, [desiredSlots, enabled, loadSlot, scheduleSettle, viewportRef]);

  useEffect(
    () => () => {
      const runtime = runtimeRef.current;
      for (const mounted of runtime.values()) {
        mounted.controller.abort();
        if (mounted.group) disposeSlotGroup(mounted.group);
        if (mounted.stale) disposeSlotGroup(mounted.stale);
      }
      runtime.clear();
    },
    [],
  );

  /* ── Description of a custom character ── */
  useEffect(() => {
    if (!enabled || !custom) return undefined;
    let cancelled = false;
    setDescribed((prev) => ({
      ...prev,
      key: modelKey,
      description: prev.key === modelKey ? prev.description : null,
      error: "",
      loading: true,
    }));
    describeCharacter(modelRef.current).then(
      (result) => {
        if (cancelled) return;
        // Reading the user's files again (Retry) must not reuse parsed drawables.
        if (modelRef.current?.kind === "file") {
          invalidatePedDrawables((result?.files || []).filter((file) => file.kind === "ydd" && file.path).map((file) => file.path));
        }
        setDescribed((prev) => ({ key: modelKey, description: result, error: "", loading: false, revision: prev.revision + 1 }));
      },
      (error) => !cancelled && setDescribed((prev) => ({ ...prev, key: modelKey, description: null, error: errorMessage(error), loading: false })),
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, custom, modelKey, describeRetry]);

  // A description that came back with nothing to wear (an error, or several
  // peds to choose from) leaves an empty figure that is settled now.
  useEffect(() => {
    if (enabled && custom && !describing && runtimeRef.current.size === 0) onSettledRef.current?.();
  }, [enabled, custom, describing]);

  /* ── Skeleton, listing and clip for this ped ── */
  useEffect(() => {
    if (!enabled || !present || custom) return undefined;
    let cancelled = false;
    getPedListing(ped).then(
      (listing) => !cancelled && setPedListing({ ped, listing }),
      () => {},
    );
    getPedSkeleton(ped).then(
      (bones) => !cancelled && setPedSkeleton({ ped, skeleton: bones, error: "" }),
      (error) => !cancelled && setPedSkeleton({ ped, skeleton: null, error: errorMessage(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [ped, enabled, present, custom, baseRetry]);

  useEffect(() => {
    setBaseError("");
  }, [baseRetry]);

  useEffect(() => {
    if (!clipKey || !enabled) {
      setClipState({ key: "", clip: null, error: "", loading: false });
      return undefined;
    }
    let cancelled = false;
    setClipState((prev) => (prev.key === clipKey && prev.clip ? prev : { key: clipKey, clip: null, error: "", loading: true }));
    getClipByKey(clipKey).then(
      (result) => {
        if (cancelled) return;
        setClipState(isValidClip(result)
          ? { key: clipKey, clip: result, error: "", loading: false }
          : { key: clipKey, clip: null, error: "The animation came back empty.", loading: false });
      },
      (error) => !cancelled && setClipState({ key: clipKey, clip: null, error: errorMessage(error), loading: false }),
    );
    return () => {
      cancelled = true;
    };
  }, [clipKey, clipFetchRevision, enabled]);

  /* ── Held props: models hung from a bone, following the pose ── */
  const heldRuntimeRef = useRef(new Map());
  const heldPropsRef = useRef(heldProps);
  heldPropsRef.current = heldProps;
  const [heldStates, setHeldStates] = useState({});
  const heldModelKeys = heldProps.map((prop) => `${prop.id}=${heldPropModelKey(prop)}`).join("|");

  const setHeldState = useCallback((id, state) => {
    setHeldStates((prev) => ({ ...prev, [id]: state }));
  }, []);

  const loadHeldProp = useCallback(async (prop, entry) => {
    const { signal } = entry.controller;
    setHeldState(prop.id, { status: "loading" });
    try {
      const path = prop.source === "game" ? (await exportGameProp(prop.name))?.path : prop.path;
      if (!path) throw new Error(`${prop.name || prop.path} returned no model file`);
      if (signal.aborted) return;
      const asset = await loadPropAsset(path, { invoke, readFile, signal });
      const group = new THREE.Group();
      group.name = `held:${prop.id}`;
      group.add(asset.object);
      entry.group = group;
      if (signal.aborted) {
        disposeHeldProp(entry);
        return;
      }
      const latest = heldPropsRef.current.find((item) => item.id === prop.id) || prop;
      setHeldPropSpec(group, latest);
      rootRef.current.add(group);
      updatePedPropAttachments(rootRef.current);
      viewportRef.current?.requestRender();
      setHeldState(prop.id, { status: "ready", warning: asset.warnings?.[0] || "" });

      if (asset.parser !== "bridge" || !asset.nativeSummary?.available) return;
      const render = () => viewportRef.current?.requestRender();
      const native = await loadNativeMaterialView({
        object: asset.object,
        renderer: viewportRef.current?.getRenderer?.(),
        signal,
        onSetup: () => {
          showNativeMaterials(asset.object);
          render();
        },
        onRender: render,
      });
      if (signal.aborted || entry.group !== group) {
        native.dispose();
        return;
      }
      entry.native = native;
      showNativeMaterials(asset.object);
      render();
      const failed = native.summary?.failedTextureCount || 0;
      if (failed) setHeldState(prop.id, { status: "ready", warning: `${failed} texture${failed === 1 ? "" : "s"} didn't load.` });
    } catch (error) {
      if (error?.name === "AbortError" || signal.aborted) return;
      setHeldState(prop.id, { status: "error", error: errorMessage(error) });
    }
  }, [setHeldState, viewportRef]);

  useEffect(() => {
    if (!enabled) return;
    const runtime = heldRuntimeRef.current;
    const wanted = new Map(heldPropsRef.current.map((prop) => [prop.id, heldPropModelKey(prop)]));
    let removed = false;
    for (const [id, entry] of runtime) {
      if (wanted.get(id) === entry.key) continue;
      disposeHeldProp(entry);
      runtime.delete(id);
      removed = true;
    }
    for (const prop of heldPropsRef.current) {
      if (runtime.has(prop.id)) continue;
      const entry = { key: heldPropModelKey(prop), controller: new AbortController(), group: null, native: null };
      runtime.set(prop.id, entry);
      loadHeldProp(prop, entry);
    }
    setHeldStates((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => wanted.has(id))));
    if (removed) viewportRef.current?.requestRender();
  }, [heldModelKeys, enabled, loadHeldProp, viewportRef]);

  // Bone, offset and rotation edits move a loaded prop without reloading it.
  useEffect(() => {
    const runtime = heldRuntimeRef.current;
    for (const prop of heldProps) {
      const group = runtime.get(prop.id)?.group;
      if (group) setHeldPropSpec(group, prop);
    }
    updatePedPropAttachments(rootRef.current);
    viewportRef.current?.requestRender();
  }, [heldProps, viewportRef]);

  useEffect(
    () => () => {
      for (const entry of heldRuntimeRef.current.values()) disposeHeldProp(entry);
      heldRuntimeRef.current.clear();
    },
    [],
  );

  const skeletonTags = useMemo(
    () => (skeleton?.bones?.length ? new Set(skeleton.bones.map((bone) => bone.tag)) : null),
    [skeleton],
  );

  /* ── Pose, tint, hair, visibility and placement: applied in place ── */
  useEffect(() => {
    timeRef.current = 0;
    setPedPose(rootRef.current, skeleton, skeleton && clip ? sampleClipPose(skeleton, clip, 0) : null);
    settleFloor();
    viewportRef.current?.requestRender();
  }, [skeleton, clip, settleFloor, viewportRef]);

  useEffect(() => {
    for (const group of rootRef.current.children) setGroupSkinTint(group, tint);
    viewportRef.current?.requestRender();
  }, [tint, viewportRef]);

  useEffect(() => {
    for (const group of rootRef.current.children) setGroupHairColor(group, hair);
    viewportRef.current?.requestRender();
  }, [hair, viewportRef]);

  useEffect(() => {
    for (const [component, mounted] of runtimeRef.current) {
      applyVisibility(component, mounted.group);
      applyVisibility(component, mounted.stale);
    }
    viewportRef.current?.requestRender();
  }, [visibility, applyVisibility, viewportRef]);

  useEffect(() => {
    rootRef.current.position.x = offsetX;
    rootRef.current.updateMatrixWorld(true);
    viewportRef.current?.refit?.();
    viewportRef.current?.requestRender();
  }, [offsetX, viewportRef]);

  // One animation step; returns how fast a walk cycle moves over the ground.
  // With `loop` off the clip holds its last frame.
  const step = useCallback((dt, loop = true) => {
    const { skeleton: bones, clip: active, walkSpeed: speed } = lookRef.current;
    if (!bones || !active || freezeRef.current) return 0;
    timeRef.current = advanceClipTime(timeRef.current, dt, active.duration, loop);
    setPedPose(rootRef.current, bones, sampleClipPose(bones, active, timeRef.current));
    return speed;
  }, [freezeRef]);

  // Shows the clip at `time` seconds (kept inside the clip). False without a clip.
  const seek = useCallback((time) => {
    const { skeleton: bones, clip: active } = lookRef.current;
    if (!bones || !active) return false;
    timeRef.current = clampClipTime(time, active.duration);
    setPedPose(rootRef.current, bones, sampleClipPose(bones, active, timeRef.current));
    return true;
  }, []);
  const getTime = useCallback(() => timeRef.current, []);
  const heldGroupOf = useCallback((id) => heldRuntimeRef.current.get(id)?.group || null, []);
  const characterState = useMemo(() => {
    if (!custom) return null;
    const current = described.key === modelKey;
    return {
      // A file selection names its ped once the bridge has read it.
      label: characterName(model, description),
      loading: current && described.loading,
      error: current ? described.error : "",
      candidates: current ? describedCandidates(described.description) : [],
      description,
      slots: description ? resolveCharacterSlots(description, variation) : [],
    };
  }, [custom, model, modelKey, described, description, variation]);
  // The clip loaded but isn't played: `refused` says why, apart from load errors.
  const shownClipState = clipFit?.fits === false
    ? { ...clipState, clip: null, refused: clipRefusedNote(clipFit, characterName(model, description)) }
    : clipState;

  return {
    present,
    gender,
    ped,
    custom,
    modelKey,
    character: characterState,
    root: rootRef.current,
    runtimeRef,
    lookRef,
    slotStates,
    baseError,
    skeletonError: custom
      ? description && !characterSkeleton ? `${description.ped}'s skeleton couldn't be read, so poses can't play` : ""
      : pedSkeleton.ped === ped ? pedSkeleton.error : "",
    listing,
    gameIndexes,
    clip,
    clipKey,
    clipState: shownClipState,
    wantedClip,
    walkSpeed,
    heldStates,
    skeletonTags,
    wornPieces,
    currentPose,
    applyVisibility,
    settleFloor,
    isSettled,
    step,
    seek,
    getTime,
    heldGroupOf,
  };
}
