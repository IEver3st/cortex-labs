import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { TransformControls } from "three/examples/jsm/controls/TransformControls";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  maybeAutoFixYftUpAxis,
  applyLiveryToModel,
  loadTextureFromPath,
  disposeTexture,
  loadModelFile,
  disposeObject,
  normalizeLoadedMeshes,
  setupWasdControls,
  setupWheelWhileDragging,
  buildCageOverlay,
  disposeCageOverlay,
} from "../lib/viewer-utils";
import {
  buildCameraFraming,
  computeFramingBounds,
  CAMERA_PRESET_KEYS,
  DEFAULT_CAMERA_PRESET,
} from "../lib/camera-framing.js";
import { syncViewerCameraPose } from "../lib/camera-state.js";
import { createViewerStage } from "../lib/viewer-stage.js";
import {
  applyShadowFlags,
  configureShadowLight,
  createAoPipeline,
  createSolidWireMaterial,
  disposeAoPipeline,
  renderWithEffects,
  resizeAoPipeline,
  setAoBounds,
} from "../lib/viewer-render-effects.js";
import { stabilizeObjectForWorld } from "../lib/model-normalization.js";
import { countDrawnGeometry, summarizeMeshStats } from "../lib/mesh-stats.js";
import { LINEUP_GAP, PAINT_KEYS, lineUpOffsets, normalizeYaw, pathKey } from "../lib/multi-lineup.js";
import { loadPropAsset } from "../lib/prop-model.js";
import { loadNativeMaterialView } from "../lib/native-materials.js";
import { getModelExtras } from "../lib/vehicle-mod-parts.js";
import { TURNTABLE_DEFAULT_SPEED, stepTurntable, withTurntableAtRest } from "../lib/turntable.js";

// Pointer travel (px) under which a press-release on the canvas counts as a
// click that selects the vehicle under the cursor, not an orbit.
const CLICK_SLOP = 5;

function baseName(path) {
  return String(path || "").split(/[\\/]/).pop() || "";
}

function errorText(error) {
  return error?.message || (typeof error === "string" ? error : "Unknown error");
}

// A slot wrapper's facing in degrees [0, 360). Read through YXZ so turns past
// 90 degrees come back as a yaw rather than a flipped pitch and roll.
function yawDegrees(object) {
  const euler = new THREE.Euler().setFromQuaternion(object.quaternion, "YXZ");
  return normalizeYaw(THREE.MathUtils.radToDeg(euler.y));
}

function createRuntime(id) {
  return {
    id,
    modelPath: "",
    modelToken: 0,
    // Aborted with modelToken: stops a superseded load's bridge parse.
    modelLoad: null,
    object: null,
    livery: { key: "", token: 0, texture: null },
    window: { key: "", token: 0, texture: null },
    appearanceKey: "",
    // Game textures: { controller, resources } while loaded or loading.
    native: null,
    // Turntable group between the slot's wrapper (which the gizmo moves) and
    // the vehicle, so each vehicle turns in its own bay.
    spin: null,
  };
}

// Restores the vehicle's own materials and frees its game textures. Runs
// before the object itself is disposed.
function releaseNative(runtime) {
  const native = runtime.native;
  if (!native) return;
  runtime.native = null;
  native.controller.abort();
  native.resources?.dispose?.();
}

// The base, livery, window and game materials live in mesh userData and are
// not covered by disposeObject, which only frees the material currently on
// the mesh. A game-texture load still in flight frees its own when it aborts.
function disposeSlotObject(object) {
  if (!object) return;
  const extra = new Set();
  object.traverse((child) => {
    if (!child.isMesh) return;
    const { baseMaterial, dualMaterial, windowMaterial, nativeMaterialObject } = child.userData || {};
    for (const material of [baseMaterial, dualMaterial, windowMaterial, nativeMaterialObject]) {
      if (material && material !== child.material) extra.add(material);
    }
  });
  disposeObject(object);
  for (const material of extra) material.dispose?.();
  object.removeFromParent();
}

/**
 * Multi's 3D view: up to six vehicles in one scene. `slots` is the lineup from
 * App (paths, paint, resolved window target, visibility, saved position); this
 * component owns loading, disposal, the move/turn gizmo and click-to-select.
 */
function MultiModelViewer({
  slots,
  reloadTokens,
  selectedId,
  gizmoVisible = true,
  gizmoMode = "translate",
  backgroundColor,
  backgroundImagePath = "",
  backgroundImageReloadToken = 0,
  backgroundImageBlur = 0,
  lightIntensity = 1.0,
  lightAzimuth = 54,
  lightElevation = 46,
  glossiness = 0.5,
  shadowsEnabled = false,
  ambientOcclusion = false,
  stage = "workbench",
  stageSpot = 1,
  stageReflect = 0.6,
  stageBeam = true,
  stageLight = "top",
  stageFloor = "concrete",
  stageBays = true,
  turntable = false,
  turntableSpeed = TURNTABLE_DEFAULT_SPEED,
  showWireframe = false,
  showCageWireframe = false,
  // Shaded vehicles with their triangle edges drawn over them; reports onMeshStats
  // for every visible vehicle together.
  showSolidWireframe = false,
  onMeshStats,
  showGrid = true,
  wasdEnabled = true,
  isActive = true,
  isTauriRuntime = false,
  onReady,
  onSelectSlot,
  onSlotPlacements,
  onSlotStatus,
  onSlotInfo,
  onFormatWarning,
}) {
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const gizmoRef = useRef(null);
  const requestRenderRef = useRef(null);
  const lightsRef = useRef({ ambient: null, key: null, rim: null });
  const stageRef = useRef(null);
  const aoRef = useRef(null);
  const backgroundTextureRef = useRef(null);
  const runtimeRef = useRef(new Map());
  const disposedRef = useRef(false);
  const fitRef = useRef({
    bounds: null,
    center: new THREE.Vector3(),
    distance: 6,
    baseDistance: 6,
    presetKey: DEFAULT_CAMERA_PRESET,
    zoomFactor: 1,
  });
  const cameraStateRef = useRef({ presetKey: DEFAULT_CAMERA_PRESET, zoomFactor: 1 });

  const [sceneReady, setSceneReady] = useState(false);
  // Bumped when a vehicle is added to or removed from the scene.
  const [modelVersion, setModelVersion] = useState(0);
  const textureLoader = useMemo(() => new THREE.TextureLoader(), []);

  const callbacksRef = useRef({});
  callbacksRef.current = { onReady, onSelectSlot, onSlotPlacements, onSlotStatus, onSlotInfo, onFormatWarning };
  const specsRef = useRef(new Map());
  specsRef.current = new Map((slots || []).map((slot) => [slot.id, slot]));
  const glossinessRef = useRef(glossiness);
  glossinessRef.current = glossiness;
  const showWireframeRef = useRef(showWireframe);
  showWireframeRef.current = showWireframe;
  const solidWireRef = useRef({ on: showSolidWireframe, material: null });
  solidWireRef.current.on = showSolidWireframe;
  const onMeshStatsRef = useRef(onMeshStats);
  onMeshStatsRef.current = onMeshStats;
  // null forces the first drawn frame to report.
  const meshStatsKeyRef = useRef(null);
  const shadowsEnabledRef = useRef(shadowsEnabled);
  shadowsEnabledRef.current = shadowsEnabled;
  const isActiveRef = useRef(isActive);
  const isTauriRuntimeRef = useRef(isTauriRuntime);
  isTauriRuntimeRef.current = isTauriRuntime;
  // Every vehicle shares one turntable angle.
  const turntableStateRef = useRef({ on: turntable, speed: turntableSpeed, yaw: 0 });
  turntableStateRef.current.on = turntable;
  turntableStateRef.current.speed = turntableSpeed;
  const ambientOcclusionRef = useRef(ambientOcclusion);

  useEffect(() => {
    ambientOcclusionRef.current = ambientOcclusion;
    requestRenderRef.current?.();
  }, [ambientOcclusion]);
  useEffect(() => {
    isActiveRef.current = isActive;
    if (isActive) requestRenderRef.current?.();
  }, [isActive]);
  // Starting, stopping (the vehicles ease home) and speed changes need frames.
  useEffect(() => {
    requestRenderRef.current?.();
  }, [turntable, turntableSpeed]);

  const requestRender = useCallback(() => { requestRenderRef.current?.(); }, []);

  // Runs `run` with every vehicle unspun, for measuring them.
  const atRest = useCallback((run) => withTurntableAtRest(
    [...runtimeRef.current.values()].map((runtime) => runtime.spin),
    run,
  ), []);

  const loadedObjects = useCallback((visibleOnly) => {
    const list = [];
    for (const runtime of runtimeRef.current.values()) {
      if (!runtime.object) continue;
      if (visibleOnly && !runtime.object.visible) continue;
      list.push(runtime.object);
    }
    return list;
  }, []);

  const solidWirePass = (roots) => {
    const wire = solidWireRef.current;
    if (!wire.on || !roots.length) return null;
    wire.material ||= createSolidWireMaterial();
    return { roots, material: wire.material };
  };
  // A cheap count every drawn frame; the full summary only when it changes.
  const reportMeshStats = (roots) => {
    const on = solidWireRef.current.on && roots.length > 0;
    const counts = on ? countDrawnGeometry(roots) : null;
    const key = counts ? `${roots.length}:${counts.meshes}:${counts.triangles}:${counts.vertices}` : "";
    if (key === meshStatsKeyRef.current) return;
    meshStatsKeyRef.current = key;
    // The gizmo moves vehicles without changing the counts, so a lineup reports
    // no size rather than a stale one.
    onMeshStatsRef.current?.(on ? { ...summarizeMeshStats(roots), size: null, models: roots.length } : null);
  };

  const applyGlossinessToObject = useCallback((object) => {
    if (!object) return;
    const glossFactor = 2 - 2 * glossinessRef.current;
    const wireframe = Boolean(showWireframeRef.current);
    object.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (!material) continue;
        if (typeof material.userData?.baseRoughness !== "number" && typeof material.roughness === "number") {
          material.userData = material.userData || {};
          material.userData.baseRoughness = material.roughness;
        }
        const base = material.userData?.baseRoughness;
        if (typeof base === "number") material.roughness = Math.min(1, Math.max(0, base * glossFactor));
        if (material.wireframe !== wireframe) {
          material.wireframe = wireframe;
          material.needsUpdate = true;
        }
      }
    });
  }, []);

  // Paint, livery and glass in one pass from the cached textures. The key
  // skips the traversal when nothing visible changed (colour drags re-render
  // App on every tick).
  const applyAppearance = useCallback((runtime, force = false) => {
    const spec = specsRef.current.get(runtime.id);
    if (!runtime.object || !spec) return;
    const key = [
      runtime.livery.texture?.uuid || "",
      runtime.window.texture?.uuid || "",
      PAINT_KEYS.map((name) => {
        const paint = spec.paint?.[name];
        return paint ? `${paint.index ?? ""}:${paint.color}:${paint.finish}` : "";
      }).join(","),
      spec.windowTarget || "none",
      runtime.native ? "native" : "",
    ].join("|");
    if (!force && key === runtime.appearanceKey) return;
    runtime.appearanceKey = key;
    applyLiveryToModel(runtime.object, spec.paint?.primary, runtime.livery.texture, spec.paint, { native: Boolean(runtime.native) });
    applyWindowDesignToModel(runtime.object, runtime.window.texture, spec.windowTarget || "none");
    applyGlossinessToObject(runtime.object);
    requestRender();
  }, [applyGlossinessToObject, requestRender]);

  const reportPlacements = useCallback((ids) => {
    const placements = {};
    for (const id of ids) {
      const object = runtimeRef.current.get(id)?.object;
      if (!object) continue;
      placements[id] = { position: [object.position.x, object.position.y, object.position.z] };
      if (object.userData.lineupTurnable) placements[id].yaw = yawDegrees(object);
    }
    if (Object.keys(placements).length > 0) callbacksRef.current.onSlotPlacements?.(placements);
  }, []);

  const refitCamera = useCallback((
    presetKey = cameraStateRef.current.presetKey || DEFAULT_CAMERA_PRESET,
    zoomFactor = cameraStateRef.current.zoomFactor || 1,
  ) => {
    const visible = loadedObjects(true);
    const objects = visible.length > 0 ? visible : loadedObjects(false);
    if (objects.length === 0) {
      fitRef.current = { ...fitRef.current, bounds: null };
      requestRender();
      return;
    }
    const bounds = atRest(() => computeFramingBounds(objects));
    if (!bounds) return;
    const size = bounds.getSize(new THREE.Vector3());
    if (!Number.isFinite(size.x) || !Number.isFinite(size.y) || !Number.isFinite(size.z)) return;
    fitRef.current = { ...fitRef.current, bounds: bounds.clone(), center: bounds.getCenter(new THREE.Vector3()) };
    cameraStateRef.current = { presetKey, zoomFactor };
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (camera && controls) {
      const { clientWidth = 1, clientHeight = 1 } = containerRef.current || {};
      const framing = buildCameraFraming({ bounds, aspect: clientWidth / clientHeight, fov: camera.fov, presetKey, zoomFactor });
      fitRef.current = {
        ...fitRef.current,
        center: framing.target.clone(),
        distance: framing.distance,
        baseDistance: framing.baseDistance,
        presetKey: framing.presetKey,
        zoomFactor,
      };
      syncViewerCameraPose({
        camera,
        controls,
        position: framing.position,
        target: framing.target,
        up: framing.up,
        near: framing.near,
        far: framing.far,
        minDistance: Math.max(framing.baseDistance * 0.05, 0.1),
        maxDistance: Math.max(framing.baseDistance * 10, 10),
      });
    }
    requestRender();
  }, [atRest, loadedObjects, requestRender]);
  const refitRef = useRef(refitCamera);
  refitRef.current = refitCamera;

  /* ── Scene (once) ── */
  useEffect(() => {
    if (!containerRef.current) return undefined;
    disposedRef.current = false;
    const container = containerRef.current;
    const scene = new THREE.Scene();
    // The stencil lets the solid wireframe tint each pixel once (renderSolidWire).
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, stencil: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(new THREE.Color(backgroundColor || "#141414"), 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = Boolean(shadowsEnabled);
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    camera.position.set(4, 2, 6);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;

    const wheelWhileDragging = setupWheelWhileDragging(controls, requestRenderRef);
    renderer.domElement.addEventListener("wheel", wheelWhileDragging, { passive: false });

    const ambient = new THREE.AmbientLight(0xffffff, 0.5 * lightIntensity);
    const key = new THREE.DirectionalLight(0xffffff, 0.9 * lightIntensity);
    key.position.set(3.5, 4.5, 2.5);
    const rim = new THREE.DirectionalLight(0xffffff, 0.35 * lightIntensity);
    rim.position.set(-3, 2, -2.2);
    configureShadowLight(key, shadowsEnabled && stage !== "showroom");
    lightsRef.current = { ambient, key, rim };
    scene.add(ambient, key, rim, key.target);

    const stageApi = createViewerStage({ renderer, scene, keyLight: key });
    stageApi.setBackgroundColor(backgroundColor);
    stageApi.setShadows(shadowsEnabled);
    stageApi.setMode(stage);
    stageRef.current = stageApi;

    const preventContextMenu = (event) => event.preventDefault();
    renderer.domElement.addEventListener("contextmenu", preventContextMenu);
    container.appendChild(renderer.domElement);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;

    const gizmo = new TransformControls(camera, renderer.domElement);
    gizmo.setMode("translate");
    gizmo.setSize(0.8);
    // three.js draws the active axis as an endless guide line while a handle is
    // hovered or dragged; it cuts through the whole showroom. The handles alone
    // show the direction.
    for (const helper of Object.values(gizmo._gizmo?.helper || {})) {
      for (const line of helper.children.filter((child) => child.name === "AXIS")) helper.remove(line);
    }
    gizmo.addEventListener("dragging-changed", (event) => {
      controls.enabled = !event.value;
      requestRenderRef.current?.();
      if (!event.value) {
        const id = gizmo.object?.userData?.lineupId;
        if (id) reportPlacements([id]);
      }
    });
    gizmo.addEventListener("change", () => requestRenderRef.current?.());
    scene.add(gizmo.getHelper());
    gizmoRef.current = gizmo;

    // Click a vehicle to select it. A press that moved is an orbit, and a
    // press on the gizmo is a move; neither selects.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let press = null;
    const onPointerDown = (event) => {
      press = event.button === 0 && !gizmo.axis ? { x: event.clientX, y: event.clientY } : null;
    };
    const onPointerUp = (event) => {
      const start = press;
      press = null;
      if (!start || event.button !== 0 || gizmo.dragging) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP) return;
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(loadedObjects(true), true);
      for (const hit of hits) {
        let node = hit.object;
        while (node && !node.userData?.lineupId) node = node.parent;
        if (node?.userData?.lineupId) {
          callbacksRef.current.onSelectSlot?.(node.userData.lineupId);
          return;
        }
      }
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    const applyCameraFrame = (presetKey, zoomFactor, shouldRender = true) => {
      if (!fitRef.current?.bounds) return;
      const { clientWidth, clientHeight } = container;
      if (!clientWidth || !clientHeight) return;
      const framing = buildCameraFraming({
        bounds: fitRef.current.bounds,
        aspect: clientWidth / clientHeight,
        fov: camera.fov,
        presetKey,
        zoomFactor,
      });
      syncViewerCameraPose({
        camera,
        controls,
        position: framing.position,
        target: framing.target,
        up: framing.up,
        near: framing.near,
        far: framing.far,
        minDistance: Math.max(framing.baseDistance * 0.05, 0.1),
        maxDistance: Math.max(framing.baseDistance * 10, 10),
      });
      fitRef.current = {
        ...fitRef.current,
        center: framing.target.clone(),
        distance: framing.distance,
        baseDistance: framing.baseDistance,
        presetKey: framing.presetKey,
        zoomFactor,
      };
      cameraStateRef.current = { presetKey: framing.presetKey, zoomFactor };
      if (shouldRender) requestRenderRef.current?.();
    };

    let frameId = 0;
    let isRendering = false;
    let renderRequested = false;
    const aoBounds = new THREE.Box3();
    const canRenderFrame = () => isActiveRef.current && container.clientWidth > 0 && container.clientHeight > 0;

    let turntableAt = null;
    const advanceTurntable = () => {
      const now = performance.now();
      const table = turntableStateRef.current;
      const seconds = turntableAt == null ? 0 : (now - turntableAt) / 1000;
      const anyVehicle = [...runtimeRef.current.values()].some((runtime) => runtime.spin);
      const next = stepTurntable(table.yaw, { on: table.on && anyVehicle, speed: table.speed, seconds });
      turntableAt = next.moving ? now : null;
      if (next.yaw !== table.yaw) {
        table.yaw = next.yaw;
        for (const runtime of runtimeRef.current.values()) {
          if (runtime.spin) runtime.spin.rotation.y = next.yaw;
        }
        stageRef.current?.setSpin(next.yaw);
      }
      return next.moving;
    };

    const renderFrame = () => {
      frameId = 0;
      if (!canRenderFrame()) {
        isRendering = false;
        turntableAt = null;
        return;
      }
      const turning = advanceTurntable();
      const visible = loadedObjects(true);
      // Each visible vehicle is its own showroom bay.
      stageRef.current?.fit(fitRef.current?.bounds, visible, { bays: true, atRest });
      stageRef.current?.constrainControls(controls);
      const needsUpdate = controls.update();
      const wantAo = Boolean(ambientOcclusionRef.current);
      if (wantAo && !aoRef.current) {
        aoRef.current = createAoPipeline({
          renderer,
          scene,
          camera,
          width: container.clientWidth || 1,
          height: container.clientHeight || 1,
        });
      }
      if (aoRef.current) {
        aoRef.current.enabled = wantAo;
        if (wantAo) {
          // Live bounds: the gizmo moves vehicles without a refit.
          aoBounds.makeEmpty();
          for (const object of visible) aoBounds.expandByObject(object);
          setAoBounds(aoRef.current, aoBounds);
        }
      }
      renderWithEffects({ renderer, scene, camera, ao: aoRef.current, wire: solidWirePass(visible) });
      reportMeshStats(visible);
      if (renderRequested || needsUpdate || turning) {
        renderRequested = false;
        frameId = requestAnimationFrame(renderFrame);
      } else {
        isRendering = false;
      }
    };

    const requestRenderFrame = () => {
      if (!canRenderFrame()) return;
      renderRequested = true;
      if (isRendering) return;
      isRendering = true;
      frameId = requestAnimationFrame(renderFrame);
    };
    requestRenderRef.current = requestRenderFrame;

    const resize = () => {
      const { clientWidth, clientHeight } = container;
      if (clientWidth === 0 || clientHeight === 0) return;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(clientWidth, clientHeight);
      resizeAoPipeline(aoRef.current, clientWidth, clientHeight, renderer.getPixelRatio());
      stageRef.current?.resize();
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      if (fitRef.current?.bounds) {
        applyCameraFrame(cameraStateRef.current.presetKey, cameraStateRef.current.zoomFactor, false);
      }
      requestRenderFrame();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    controls.addEventListener("start", requestRenderFrame);
    controls.addEventListener("change", requestRenderFrame);
    controls.addEventListener("end", requestRenderFrame);
    requestRenderFrame();
    setSceneReady(true);

    // Save this view: one frame of the live camera without the move/turn
    // gizmo, read in the task that drew it (the drawing buffer isn't
    // preserved). The live frame is drawn again before returning, so the
    // viewfinder never shows the capture frame.
    const captureLiveFrame = (read) => {
      if (!canRenderFrame()) return null;
      const helper = gizmo.getHelper();
      const helperVisible = helper.visible;
      helper.visible = false;
      try {
        renderWithEffects({ renderer, scene, camera, ao: aoRef.current, wire: solidWirePass(loadedObjects(true)) });
        return read(renderer.domElement);
      } finally {
        helper.visible = helperVisible;
        renderWithEffects({ renderer, scene, camera, ao: aoRef.current, wire: solidWirePass(loadedObjects(true)) });
      }
    };
    const encodePng = (canvas) => canvas.toDataURL("image/png");
    // toBlob snapshots the drawing buffer when called, before the restore.
    const blobPng = (canvas) => new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob || null), "image/png");
    });

    callbacksRef.current.onReady?.({
      // Live view only; Multi has no framing-preset capture, so a preset gives null.
      captureScreenshot: () => captureLiveFrame(encodePng),
      captureFrame: ({ presetKey = null } = {}) => (presetKey ? null : captureLiveFrame(encodePng)),
      captureFrameBlob: ({ presetKey = null } = {}) => (presetKey ? null : captureLiveFrame(blobPng)) || Promise.resolve(null),
      setPreset: (presetKey) => applyCameraFrame(presetKey, cameraStateRef.current.zoomFactor),
      setZoom: (zoomFactor) => applyCameraFrame(cameraStateRef.current.presetKey, zoomFactor),
      reset: () => refitRef.current(DEFAULT_CAMERA_PRESET, 1),
      // Side by side, in lineup order, one gap apart; hidden vehicles keep
      // their place.
      lineUp: (ids) => {
        const ordered = (ids || [])
          .map((id) => runtimeRef.current.get(id))
          .filter((runtime) => runtime?.object?.visible);
        if (ordered.length === 0) return;
        const widths = atRest(() => ordered.map((runtime) => {
          const object = runtime.object;
          object.position.set(0, object.position.y, 0);
          object.updateMatrixWorld(true);
          return new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3()).z;
        }));
        const offsets = lineUpOffsets(widths, LINEUP_GAP);
        ordered.forEach((runtime, index) => runtime.object.position.set(0, runtime.object.position.y, offsets[index]));
        reportPlacements(ordered.map((runtime) => runtime.id));
        refitRef.current();
      },
      getPresetKeys: () => CAMERA_PRESET_KEYS,
    });

    const runtime = runtimeRef.current;
    return () => {
      disposedRef.current = true;
      if (frameId) cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      controls.removeEventListener("start", requestRenderFrame);
      controls.removeEventListener("change", requestRenderFrame);
      controls.removeEventListener("end", requestRenderFrame);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("contextmenu", preventContextMenu);
      renderer.domElement.removeEventListener("wheel", wheelWhileDragging);
      disposeAoPipeline(aoRef.current);
      aoRef.current = null;
      solidWireRef.current.material?.dispose();
      solidWireRef.current.material = null;
      disposeCageOverlay(scene);
      for (const entry of runtime.values()) {
        entry.modelToken += 1;
        entry.modelLoad?.abort();
        releaseNative(entry);
        disposeSlotObject(entry.object);
        disposeTexture(entry.livery.texture);
        disposeTexture(entry.window.texture);
      }
      runtime.clear();
      stageRef.current?.dispose();
      stageRef.current = null;
      if (scene.background === backgroundTextureRef.current) scene.background = null;
      disposeTexture(backgroundTextureRef.current);
      backgroundTextureRef.current = null;
      gizmo.detach();
      gizmo.dispose();
      gizmoRef.current = null;
      controls.dispose();
      renderer.dispose();
      // dispose() frees three's bookkeeping; drop the GL context explicitly too.
      renderer.forceContextLoss();
      renderer.domElement.remove();
      requestRenderRef.current = null;
      setSceneReady(false);
    };
    // The scene is built once; later prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Lineup sync: load, replace and dispose per slot ── */

  // Game textures for a bridge-loaded vehicle. Materials go on at setup and
  // fill in as each DDS arrives; a livery still overrides its own meshes.
  const loadSlotNative = useCallback(async (runtime) => {
    const object = runtime.object;
    let hasNative = false;
    object?.traverse((child) => { if (child.isMesh && child.userData.nativeMaterial) hasNative = true; });
    if (!hasNative || runtime.native) return;
    const report = (patch) => callbacksRef.current.onSlotStatus?.(runtime.id, patch);
    const native = { controller: new AbortController(), resources: null };
    runtime.native = native;
    const current = () => runtime.native === native && runtime.object === object;
    report({ textures: "loading", texturesError: "" });
    try {
      const resources = await loadNativeMaterialView({
        object,
        renderer: rendererRef.current,
        signal: native.controller.signal,
        onSetup: () => { if (current()) applyAppearance(runtime, true); },
        onRender: () => requestRenderRef.current?.(),
      });
      if (!current()) {
        resources.dispose();
        return;
      }
      native.resources = resources;
      const { failedTextureCount = 0, missingBindingCount = 0, unsupportedBindingCount = 0 } = resources.summary || {};
      report({ textures: failedTextureCount + missingBindingCount + unsupportedBindingCount > 0 ? "partial" : "ready" });
      applyAppearance(runtime, true);
    } catch (error) {
      if (error?.name === "AbortError" || !current()) return;
      // Back to the plain paint materials rather than half-built game ones.
      runtime.native = null;
      applyAppearance(runtime, true);
      report({ textures: "error", texturesError: `Game textures didn't load: ${errorText(error)}` });
    }
  }, [applyAppearance]);
  const loadSlotModel = useCallback(async (runtime, path) => {
    const token = runtime.modelToken;
    const { id } = runtime;
    const load = new AbortController();
    runtime.modelLoad = load;
    const report = (patch) => callbacksRef.current.onSlotStatus?.(id, patch);
    report({ loading: true, queued: false, error: "", warning: "", textures: "" });
    let object = null;
    try {
      // The desktop app reads a .yft through the CodeWalker bridge, like the
      // single viewer: wheels, game materials and LOD flags come from it. The
      // JS parser is the browser path and the bridge's fallback (shape only).
      let warning = "";
      if (isTauriRuntimeRef.current && /\.yft$/i.test(path)) {
        const asset = await loadPropAsset(path, { invoke, readFile, signal: load.signal });
        object = asset.object;
        object.userData.sourceFormat = "yft";
        warning = asset.warnings[0] || "";
      } else {
        object = await loadModelFile(path);
      }
      if (disposedRef.current || token !== runtime.modelToken) {
        if (object) disposeSlotObject(object);
        return;
      }
      if (!object) throw new Error(`${baseName(path)} has no geometry the viewer can show`);
      normalizeLoadedMeshes(object);
      // Only the active LOD shows, and extras start off, as in the single
      // viewer without an extras plan.
      getModelExtras(object);
      object.traverse((child) => {
        if (!child.isMesh) return;
        if (child.userData.nativeLodActive === false || Number.isInteger(child.userData.extraIndex)) child.visible = false;
      });
      const info = {
        targets: collectTextureTargets(object),
        ...(() => {
          const detected = findWindowTemplateTarget(object);
          return { windowTarget: detected?.value || "", windowLabel: detected?.label || "" };
        })(),
      };
      const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
      if (object.userData.sourceFormat === "yft") maybeAutoFixYftUpAxis(object, size);
      const stabilized = stabilizeObjectForWorld(object, { autoLevel: true, centerXZ: true, groundToZero: true });
      const sceneObject = stabilized || object;
      sceneObject.userData.lineupId = id;
      // The stabilized wrapper's origin is the vehicle's centre on the floor.
      const spin = new THREE.Group();
      spin.name = "lineup-turntable";
      if (stabilized) {
        for (const child of [...sceneObject.children]) spin.add(child);
        sceneObject.add(spin);
        spin.rotation.y = turntableStateRef.current.yaw;
      }

      const saved = specsRef.current.get(id)?.position;
      // Only the levelling wrapper turns; a bare model may carry an up-axis fix.
      sceneObject.userData.lineupTurnable = sceneObject !== object;
      if (sceneObject.userData.lineupTurnable) {
        sceneObject.rotation.set(0, THREE.MathUtils.degToRad(specsRef.current.get(id)?.yaw || 0), 0);
      }
      let placed = false;
      if (saved) {
        sceneObject.position.set(saved[0], saved[1], saved[2]);
      } else {
        // A new vehicle parks beside the others instead of inside them.
        let edge = -Infinity;
        atRest(() => {
          for (const other of runtimeRef.current.values()) {
            if (!other.object || other.id === id) continue;
            edge = Math.max(edge, new THREE.Box3().setFromObject(other.object).max.z);
          }
        });
        if (Number.isFinite(edge)) {
          const width = withTurntableAtRest(spin, () => new THREE.Box3().setFromObject(sceneObject).getSize(new THREE.Vector3()).z);
          sceneObject.position.set(0, sceneObject.position.y, edge + LINEUP_GAP + width / 2);
        }
        placed = true;
      }
      sceneObject.visible = specsRef.current.get(id)?.visible !== false;
      applyShadowFlags(sceneObject, stageRef.current?.castsShadows ?? shadowsEnabledRef.current);
      sceneRef.current?.add(sceneObject);
      runtime.object = sceneObject;
      runtime.spin = stabilized ? spin : null;
      applyAppearance(runtime, true);
      if (placed) reportPlacements([id]);
      setModelVersion((value) => value + 1);
      refitRef.current();
      callbacksRef.current.onSlotInfo?.(id, info);
      report({ loading: false, error: "", warning });
      // Resolves once the textures are in (or failed), so the queue moves on.
      await loadSlotNative(runtime);
    } catch (error) {
      if (disposedRef.current || token !== runtime.modelToken) return;
      callbacksRef.current.onSlotInfo?.(id, { targets: [], windowTarget: "", windowLabel: "" });
      report({ loading: false, error: `Couldn't load ${baseName(path)}: ${errorText(error)}` });
    }
  }, [applyAppearance, atRest, loadSlotNative, reportPlacements]);

  // Vehicles load one at a time, model and game textures both, in lineup
  // order: several bridge parses and DDS decodes at once stall the viewer.
  // A queued load whose slot changed model meanwhile is skipped.
  const loadQueueRef = useRef(Promise.resolve());
  const queueSlotModel = useCallback((runtime, path) => {
    const token = runtime.modelToken;
    callbacksRef.current.onSlotStatus?.(runtime.id, { loading: true, queued: true, error: "", warning: "", textures: "" });
    loadQueueRef.current = loadQueueRef.current
      .then(() => {
        if (disposedRef.current || token !== runtime.modelToken) return undefined;
        return loadSlotModel(runtime, path);
      })
      .catch(() => {});
  }, [loadSlotModel]);

  const loadSlotTexture = useCallback(async (runtime, kind, path) => {
    const channel = runtime[kind];
    const token = channel.token;
    const field = kind === "livery" ? "liveryError" : "windowError";
    try {
      const texture = await loadTextureFromPath(path, textureLoader, rendererRef.current);
      if (disposedRef.current || token !== channel.token) {
        disposeTexture(texture);
        return;
      }
      if (!texture) throw new Error(`${baseName(path)} couldn't be read`);
      const previous = channel.texture;
      channel.texture = texture;
      applyAppearance(runtime, true);
      if (previous && previous !== texture) disposeTexture(previous);
      callbacksRef.current.onSlotStatus?.(runtime.id, { [field]: "" });
    } catch (error) {
      if (disposedRef.current || token !== channel.token) return;
      if (error?.type === "unsupported-bit-depth") {
        callbacksRef.current.onFormatWarning?.({
          type: "16bit-psd",
          bitDepth: error.bitDepth,
          path,
          slotId: runtime.id,
          kind: kind === "livery" ? "primary" : "window",
        });
        return;
      }
      callbacksRef.current.onSlotStatus?.(runtime.id, { [field]: errorText(error) });
    }
  }, [applyAppearance, textureLoader]);

  useEffect(() => {
    if (!sceneReady) return;
    const runtimes = runtimeRef.current;
    const wanted = specsRef.current;
    let removed = false;
    for (const [id, runtime] of runtimes) {
      if (wanted.has(id)) continue;
      runtime.modelToken += 1;
      runtime.modelLoad?.abort();
      runtime.livery.token += 1;
      runtime.window.token += 1;
      if (gizmoRef.current?.object === runtime.object) gizmoRef.current.detach();
      releaseNative(runtime);
      disposeSlotObject(runtime.object);
      disposeTexture(runtime.livery.texture);
      disposeTexture(runtime.window.texture);
      runtimes.delete(id);
      removed = removed || Boolean(runtime.object);
    }
    if (removed) {
      setModelVersion((value) => value + 1);
      refitRef.current();
    }

    for (const spec of wanted.values()) {
      let runtime = runtimes.get(spec.id);
      if (!runtime) {
        runtime = createRuntime(spec.id);
        runtimes.set(spec.id, runtime);
      }
      if (runtime.modelPath !== spec.modelPath) {
        runtime.modelPath = spec.modelPath;
        runtime.modelToken += 1;
        runtime.modelLoad?.abort();
        if (runtime.object) {
          if (gizmoRef.current?.object === runtime.object) gizmoRef.current.detach();
          releaseNative(runtime);
          disposeSlotObject(runtime.object);
          runtime.object = null;
          runtime.spin = null;
          runtime.appearanceKey = "";
          setModelVersion((value) => value + 1);
          refitRef.current();
        }
        if (spec.modelPath) {
          queueSlotModel(runtime, spec.modelPath);
        } else {
          callbacksRef.current.onSlotStatus?.(spec.id, { loading: false, queued: false, error: "", warning: "", textures: "" });
          callbacksRef.current.onSlotInfo?.(spec.id, { targets: [], windowTarget: "", windowLabel: "" });
        }
      }
      for (const [kind, path] of [["livery", spec.liveryPath], ["window", spec.windowPath]]) {
        const channel = runtime[kind];
        const key = path ? `${path}#${reloadTokens?.[pathKey(path)] || 0}` : "";
        if (channel.key === key) continue;
        channel.key = key;
        channel.token += 1;
        if (path) {
          loadSlotTexture(runtime, kind, path);
        } else if (channel.texture) {
          const previous = channel.texture;
          channel.texture = null;
          applyAppearance(runtime, true);
          disposeTexture(previous);
        }
      }
      if (runtime.object) {
        const visible = spec.visible !== false;
        if (runtime.object.visible !== visible) {
          runtime.object.visible = visible;
          setModelVersion((value) => value + 1);
        }
        const position = spec.position;
        const current = runtime.object.position;
        if (position && !gizmoRef.current?.dragging
          && (current.x !== position[0] || current.y !== position[1] || current.z !== position[2])) {
          current.set(position[0], position[1], position[2]);
          requestRender();
        }
        if (runtime.object.userData.lineupTurnable && !gizmoRef.current?.dragging
          && Math.abs(yawDegrees(runtime.object) - (spec.yaw || 0)) > 0.01) {
          runtime.object.rotation.set(0, THREE.MathUtils.degToRad(spec.yaw || 0), 0);
          requestRender();
        }
        applyAppearance(runtime);
      }
    }
    requestRender();
  }, [sceneReady, slots, reloadTokens, queueSlotModel, loadSlotTexture, applyAppearance, requestRender]);

  /* ── Gizmo follows the selected, visible vehicle ── */
  useEffect(() => {
    const gizmo = gizmoRef.current;
    if (!sceneReady || !gizmo) return;
    const object = runtimeRef.current.get(selectedId)?.object;
    if (gizmoVisible && object?.visible) {
      if (gizmo.object !== object) gizmo.attach(object);
      // Turning is about the vertical axis only, so a vehicle stays on its wheels.
      const rotate = gizmoMode === "rotate" && object.userData.lineupTurnable === true;
      gizmo.setMode(rotate ? "rotate" : "translate");
      gizmo.setSpace(rotate ? "local" : "world");
      gizmo.showX = !rotate;
      gizmo.showZ = !rotate;
      gizmo.showY = true;
    } else {
      gizmo.detach();
    }
    requestRender();
  }, [sceneReady, selectedId, gizmoVisible, gizmoMode, modelVersion, requestRender]);

  /* ── Scene settings ── */
  useEffect(() => {
    if (!rendererRef.current) return;
    rendererRef.current.setClearColor(new THREE.Color(backgroundColor || "#141414"), 1);
    stageRef.current?.setBackgroundColor(backgroundColor);
    requestRender();
  }, [backgroundColor, requestRender]);

  useEffect(() => {
    if (!sceneReady) return undefined;
    let cancelled = false;
    const clearBackground = () => {
      stageRef.current?.setUserBackground(null);
      disposeTexture(backgroundTextureRef.current);
      backgroundTextureRef.current = null;
      requestRender();
    };
    if (!backgroundImagePath) {
      clearBackground();
      return undefined;
    }
    (async () => {
      let texture = null;
      try {
        texture = await loadTextureFromPath(backgroundImagePath, textureLoader, rendererRef.current);
      } catch {
        texture = null;
      }
      if (cancelled) {
        disposeTexture(texture);
        return;
      }
      if (!texture) {
        clearBackground();
        return;
      }
      texture.mapping = THREE.UVMapping;
      let finalTexture = texture;
      const img = texture.image;
      if (backgroundImageBlur > 0 && img && (img instanceof HTMLImageElement || img instanceof HTMLCanvasElement || img instanceof ImageBitmap)) {
        const w = img.naturalWidth || img.width || 512;
        const h = img.naturalHeight || img.height || 512;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        const pad = backgroundImageBlur * 2;
        ctx.filter = `blur(${backgroundImageBlur}px)`;
        ctx.drawImage(img, -pad, -pad, w + pad * 2, h + pad * 2);
        finalTexture = new THREE.CanvasTexture(canvas);
        finalTexture.colorSpace = THREE.SRGBColorSpace;
        // An ImageBitmap source is already upside down (loadBlobTexture), and
        // the canvas copies it as it is.
        finalTexture.flipY = !texture.userData?.flipBaked;
        disposeTexture(texture);
      }
      const previous = backgroundTextureRef.current;
      backgroundTextureRef.current = finalTexture;
      stageRef.current?.setUserBackground(finalTexture);
      if (previous && previous !== finalTexture) disposeTexture(previous);
      requestRender();
    })();
    return () => {
      cancelled = true;
    };
  }, [sceneReady, backgroundImagePath, backgroundImageReloadToken, backgroundImageBlur, textureLoader, requestRender]);

  useEffect(() => {
    const { ambient, key, rim } = lightsRef.current;
    const showroom = stage === "showroom";
    if (ambient) ambient.intensity = (showroom ? 0.06 : 0.5) * lightIntensity;
    if (key) key.intensity = (showroom ? 0.3 : 0.9) * lightIntensity;
    if (rim) rim.intensity = (showroom ? 0.55 : 0.35) * lightIntensity;
    requestRender();
  }, [lightIntensity, stage, requestRender]);

  useEffect(() => {
    const { key } = lightsRef.current;
    if (!key) return;
    const azimuth = (lightAzimuth * Math.PI) / 180;
    const elevation = (lightElevation * Math.PI) / 180;
    key.position.set(8 * Math.cos(elevation) * Math.sin(azimuth), 8 * Math.sin(elevation), 8 * Math.cos(elevation) * Math.cos(azimuth));
    requestRender();
  }, [lightAzimuth, lightElevation, requestRender]);

  useEffect(() => {
    const stageApi = stageRef.current;
    const { key } = lightsRef.current;
    if (!sceneReady || !stageApi || !key) return;
    configureShadowLight(key, shadowsEnabled && stage !== "showroom");
    stageApi.setMode(stage);
    stageApi.setShadows(shadowsEnabled);
    for (const object of loadedObjects(false)) applyShadowFlags(object, stageApi.castsShadows);
    requestRender();
  }, [sceneReady, shadowsEnabled, stage, modelVersion, loadedObjects, requestRender]);

  useEffect(() => {
    stageRef.current?.setShowroom({ spot: stageSpot, reflect: stageReflect, beam: stageBeam, light: stageLight, floor: stageFloor, bayLights: stageBays });
    requestRender();
  }, [sceneReady, stageSpot, stageReflect, stageBeam, stageLight, stageFloor, stageBays, requestRender]);

  useEffect(() => {
    if (!sceneReady) return;
    for (const object of loadedObjects(false)) applyGlossinessToObject(object);
    requestRender();
  }, [sceneReady, glossiness, showWireframe, loadedObjects, applyGlossinessToObject, requestRender]);

  useEffect(() => {
    meshStatsKeyRef.current = null;
    requestRender();
  }, [showSolidWireframe, modelVersion, requestRender]);

  useEffect(() => {
    if (!sceneReady || !sceneRef.current) return;
    disposeCageOverlay(sceneRef.current);
    if (showCageWireframe) {
      for (const object of loadedObjects(true)) buildCageOverlay(object, sceneRef.current);
    }
    requestRender();
  }, [sceneReady, showCageWireframe, modelVersion, loadedObjects, requestRender]);

  useEffect(() => {
    if (!sceneReady) return;
    stageRef.current?.setGrid(showGrid);
    requestRender();
  }, [sceneReady, showGrid, requestRender]);

  const wasdStateRef = useRef({ forward: false, back: false, left: false, right: false, up: false, down: false, boost: false });
  const wasdFrameRef = useRef(0);
  useEffect(() => {
    if (!sceneReady || !wasdEnabled || !cameraRef.current || !controlsRef.current) return undefined;
    return setupWasdControls({
      wasdStateRef,
      wasdFrameRef,
      cameraRef,
      controlsRef,
      fitRef,
      requestRenderRef,
      domElement: rendererRef.current?.domElement,
      isActiveRef,
    });
  }, [sceneReady, wasdEnabled]);

  return <div ref={containerRef} className="h-full w-full" />;
}

export default memo(MultiModelViewer);

const ALL_TARGET = "all";
const NONE_TARGET = "none";
const MATERIAL_TARGET_PREFIX = "material:";
const MESH_TARGET_PREFIX = "mesh:";

function applyWindowDesignToModel(object, texture, windowTarget) {
  if (!object) return;
  const resolvedTarget = windowTarget || NONE_TARGET;
  object.traverse((child) => {
    if (!child.isMesh) return;
    if (!child.userData.baseMaterial) child.userData.baseMaterial = child.material;
    const shouldApply = Boolean(texture) && matchesWindowTarget(child, resolvedTarget);
    if (!shouldApply) {
      if (child.userData.windowMaterial && child.material === child.userData.windowMaterial) {
        child.material = child.userData.dualMaterial || child.userData.baseMaterial;
      }
      return;
    }
    const baseMaterial = child.userData.baseMaterial || child.material;
    if (!child.userData.windowMaterial) {
      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: texture,
        side: THREE.DoubleSide,
        metalness: baseMaterial?.metalness ?? 0,
        roughness: Math.min(baseMaterial?.roughness ?? 0.2, 0.35),
        transparent: true,
        opacity: typeof baseMaterial?.opacity === "number" ? baseMaterial.opacity : 0.5,
      });
      material.userData.baseRoughness = baseMaterial?.userData?.baseRoughness ?? baseMaterial?.roughness ?? 0.2;
      material.userData.baseOpacity = typeof baseMaterial?.opacity === "number" ? baseMaterial.opacity : 0.5;
      material.name = baseMaterial?.name || "";
      child.userData.windowMaterial = material;
    } else if (child.userData.windowMaterial.map !== texture) {
      child.userData.windowMaterial.map = texture;
      child.userData.windowMaterial.needsUpdate = true;
    }
    if (child.material !== child.userData.windowMaterial) child.material = child.userData.windowMaterial;
  });
}

function matchesWindowTarget(mesh, target) {
  if (target === NONE_TARGET) return false;
  if (!target || target === "auto") return isWindowMesh(mesh);
  if (target === ALL_TARGET) return true;
  const baseMaterial = mesh.userData?.baseMaterial || mesh.material;
  if (target.startsWith(MATERIAL_TARGET_PREFIX)) {
    const requested = target.slice(MATERIAL_TARGET_PREFIX.length);
    return getMaterialNames(baseMaterial).some((name) => name === requested);
  }
  if (target.startsWith(MESH_TARGET_PREFIX)) {
    return ensureMeshLabel(mesh) === target.slice(MESH_TARGET_PREFIX.length);
  }
  return isWindowMesh(mesh);
}

function isWindowMesh(mesh) {
  const baseMaterial = mesh.userData?.baseMaterial || mesh.material;
  const text = `${getMaterialNames(baseMaterial).join(" ")} ${mesh.name || ""}`.toLowerCase();
  return ["window", "glass", "vehglass", "sign_2", "sign-2", "sign2", "sign_3", "sign-3", "sign3"].some((token) => text.includes(token));
}

function collectTextureTargets(object) {
  if (!object) return [];
  const materialNames = new Set();
  const meshNames = new Set();
  object.traverse((child) => {
    if (!child.isMesh) return;
    getMaterialNames(child.userData?.baseMaterial || child.material).forEach((name) => materialNames.add(name));
    meshNames.add(ensureMeshLabel(child));
  });
  if (materialNames.size > 0) {
    return [...materialNames].sort().map((name) => ({ value: `${MATERIAL_TARGET_PREFIX}${name}`, label: `Material: ${name}` }));
  }
  return [...meshNames].sort().map((name) => ({ value: `${MESH_TARGET_PREFIX}${name}`, label: `Mesh: ${name}` }));
}

function findWindowTemplateTarget(object) {
  if (!object) return null;
  let best = null;
  const consider = (label, kind) => {
    const score = scoreWindowTemplateName(label);
    if (score <= 0 || (best && score <= best.score)) return;
    best = {
      score,
      value: `${kind === "material" ? MATERIAL_TARGET_PREFIX : MESH_TARGET_PREFIX}${label}`,
      label: `${kind === "material" ? "Material" : "Mesh"}: ${label}`,
    };
  };
  object.traverse((child) => {
    if (!child.isMesh) return;
    getMaterialNames(child.userData?.baseMaterial || child.material).forEach((name) => consider(name, "material"));
    consider(ensureMeshLabel(child), "mesh");
  });
  return best ? { value: best.value, label: best.label } : null;
}

function scoreWindowTemplateName(name) {
  const raw = String(name || "").trim().toLowerCase();
  if (!raw) return 0;
  if (raw.includes("sign_2") || raw.includes("sign-2") || raw.includes("sign2")) return 120;
  if (raw.includes("sign_3") || raw.includes("sign-3") || raw.includes("sign3")) return 110;
  const tokens = new Set(raw.split(/[^a-z0-9]+/g).filter(Boolean));
  if (tokens.has("sign") && tokens.has("2")) return 120;
  if (tokens.has("sign") && tokens.has("3")) return 110;
  if (raw.includes("vehglass")) return 100;
  if (raw.includes("window")) return 70;
  if (raw.includes("glass")) return 60;
  return 0;
}

function getMaterialNames(material) {
  if (!material) return [];
  const list = Array.isArray(material) ? material : [material];
  return list.map((item) => item?.name?.trim()).filter((name) => typeof name === "string" && name.length > 0);
}

function ensureMeshLabel(mesh) {
  if (!mesh?.isMesh) return "";
  if (mesh.userData?.meshLabel) return mesh.userData.meshLabel;
  const label = mesh.name?.trim() || `mesh-${mesh.id}`;
  mesh.userData.meshLabel = label;
  return label;
}
