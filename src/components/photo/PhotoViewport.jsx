import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { TransformControls } from "three/examples/jsm/controls/TransformControls";
import { createViewerStage } from "../../lib/viewer-stage.js";
import {
  BLOOM_STRENGTH,
  FLOOR_LIGHT_LAYER,
  GLOW_LAYER,
  applyShadowFlags,
  configureShadowLight,
  createAoPipeline,
  createBloomPipeline,
  disposeAoPipeline,
  disposeBloomPipeline,
  renderWithEffects,
  resizeAoPipeline,
  resizeBloomPipeline,
  setAoBounds,
} from "../../lib/viewer-render-effects.js";
import { lensToFov, litObjectIds } from "../../lib/photo-mode.js";

const MAX_PIXEL_RATIO = 1.5;
// Pointer travel (px) under which a press and release counts as a click.
const CLICK_SLOP = 5;
const FIT_PADDING = 1.15;

// Directions from the scene's centre to the camera. Objects face -Z at yaw 0.
const PRESET_DIRECTIONS = {
  front: new THREE.Vector3(0, 0.18, -1).normalize(),
  back: new THREE.Vector3(0, 0.18, 1).normalize(),
  side: new THREE.Vector3(1, 0.15, 0).normalize(),
  angle: new THREE.Vector3(0.82, 0.32, -1).normalize(),
  top: new THREE.Vector3(0, 1, -0.02).normalize(),
  low: new THREE.Vector3(0.7, 0.04, -1).normalize(),
};

const LIGHT_LEVELS = {
  workbench: { ambient: 0.5, key: 0.95, rim: 0.4 },
  showroom: { ambient: 0.08, key: 0.3, rim: 0.35 },
};

function canvasToPngBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("PNG encoding failed."));
        return;
      }
      blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
    }, "image/png");
  });
}

function yawDegrees(object) {
  const euler = new THREE.Euler().setFromQuaternion(object.quaternion, "YXZ");
  const degrees = THREE.MathUtils.radToDeg(euler.y);
  return Number((((degrees % 360) + 360) % 360).toFixed(2));
}

/* Photo Mode's 3D view: every object on set, the shared viewer stage (subject
   "vehicle"), a move/turn gizmo on the selected object and click-to-select.
   Renders on demand: a frame loop runs only while the orbit settles, doors
   swing or a pose plays (`onStep` returns true), and never while the tab is
   hidden. `objects` is [{ id, controller, hidden }]; the page owns loading
   and disposal, this component only adds and removes holders. */
const PhotoViewport = forwardRef(function PhotoViewport(
  {
    objects,
    selectedId,
    gizmoMode = "translate",
    gizmoVisible = true,
    lens = 35,
    isActive,
    backgroundColor,
    lightIntensity = 1,
    dark = 0,
    lightGlow = 1,
    stage = "showroom",
    showroom = null,
    showGrid = true,
    showShadows = true,
    ambientOcclusion = false,
    playing = false,
    onStep = null,
    onSelect = null,
    onTransform = null,
    onCameraChange = null,
    onResize = null,
    onTogglePart = null,
  },
  ref,
) {
  const containerRef = useRef(null);
  const stateRef = useRef(null);
  const activeRef = useRef(Boolean(isActive));
  activeRef.current = Boolean(isActive);
  const playingRef = useRef(Boolean(playing));
  playingRef.current = Boolean(playing);
  const objectsRef = useRef(objects);
  objectsRef.current = objects;
  const callbacksRef = useRef({});
  callbacksRef.current = { onStep, onSelect, onTransform, onCameraChange, onResize, onTogglePart };
  const glowRef = useRef(lightGlow);
  glowRef.current = lightGlow;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    // Alpha so a transparent capture keeps its alpha; the clear colour is opaque otherwise.
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(new THREE.Color(backgroundColor || "#141414"), 1);
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(lensToFov(lens), 1, 0.05, 500);
    camera.position.set(5, 2.2, -6);
    // Vehicle light glow and the light pool their sirens throw on the floor.
    camera.layers.enable(GLOW_LAYER);
    camera.layers.enable(FLOOR_LIGHT_LAYER);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minDistance = 0.2;
    controls.maxDistance = 120;

    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    const key = new THREE.DirectionalLight(0xffffff, 0.95);
    key.position.set(4, 7, -5);
    const rim = new THREE.DirectionalLight(0xffffff, 0.4);
    rim.position.set(-5, 3.5, 4);
    scene.add(ambient, key, rim, key.target);

    const stageApi = createViewerStage({ renderer, scene, keyLight: key, subject: "vehicle" });
    stageApi.setBackgroundColor(backgroundColor);
    // Every object gets its own showroom spotlight; none lit means no spot.
    stageApi.setShowroom({ bayMinimum: 0 });
    const aoPipeline = createAoPipeline({ renderer, scene, camera, width: 1, height: 1 });

    const gizmo = new TransformControls(camera, renderer.domElement);
    gizmo.setSize(0.85);
    const gizmoHelper = gizmo.getHelper();
    scene.add(gizmoHelper);

    container.appendChild(renderer.domElement);
    renderer.domElement.addEventListener("contextmenu", (event) => event.preventDefault());

    const state = {
      renderer,
      scene,
      camera,
      controls,
      gizmo,
      gizmoHelper,
      lights: { ambient, key, rim },
      stage: stageApi,
      ao: aoPipeline,
      attached: new Map(),
      frameId: 0,
      lastTime: 0,
      pendingWhileInactive: false,
      disposed: false,
      size: { width: 1, height: 1 },
      aoBounds: { clip: null, radius: null },
    };
    stateRef.current = state;

    const sceneBounds = () => {
      const bounds = new THREE.Box3();
      for (const entry of objectsRef.current || []) {
        if (entry.hidden || !entry.controller) continue;
        bounds.expandByObject(entry.controller.holder);
      }
      return bounds.isEmpty() ? null : bounds;
    };
    state.sceneBounds = sceneBounds;

    /** Draws a frame. Returns true while vehicle lights are flashing. */
    const draw = () => {
      let lightsAnimating = false;
      let lightsLit = false;
      const now = performance.now();
      for (const entry of objectsRef.current || []) {
        if (!entry.controller) continue;
        applyShadowFlags(entry.controller.holder, stageApi.castsShadows);
        entry.controller.beforeRender?.();
        if (entry.controller.updateLights?.(camera, now)) lightsAnimating = true;
        if (entry.controller.lightsActive) lightsLit = true;
      }
      // Bounds are measured on refit, not per frame: a posed ped's bounds cost a CPU skin pass.
      if (aoPipeline?.enabled) setAoBounds(aoPipeline, state.aoBounds.clip, { radiusBounds: state.aoBounds.radius });
      // Lit lamps glow through the bloom pass, built the first time one is on.
      if (lightsLit && !state.bloom) {
        state.bloom = createBloomPipeline({ renderer, scene, camera, width: state.size.width, height: state.size.height });
      }
      if (state.bloom) {
        state.bloom.enabled = lightsLit;
        state.bloom.bloomPass.strength = BLOOM_STRENGTH * glowRef.current;
      }
      renderWithEffects({ renderer, scene, camera, ao: aoPipeline, bloom: state.bloom });
      return lightsAnimating;
    };
    state.draw = draw;

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!width || !height) return;
      state.size = { width, height };
      callbacksRef.current.onResize?.({ width, height });
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      resizeAoPipeline(aoPipeline, width, height, renderer.getPixelRatio());
      resizeBloomPipeline(state.bloom, width, height, renderer.getPixelRatio());
      stageApi.resize();
    };

    const tick = (now) => {
      if (state.disposed) return;
      state.frameId = 0;
      const dt = state.lastTime ? Math.min((now - state.lastTime) / 1000, 0.1) : 0;
      const moving = Boolean(callbacksRef.current.onStep?.(dt, now));
      const animate = moving || playingRef.current;
      const orbiting = controls.update();
      if (moving) renderer.shadowMap.needsUpdate = true;
      const flashing = draw();
      state.lastTime = animate || flashing ? now : 0;
      if (orbiting || animate || flashing) requestRender();
    };

    const requestRender = () => {
      if (state.disposed) return;
      if (!activeRef.current) {
        state.pendingWhileInactive = true;
        return;
      }
      if (state.frameId) return;
      state.frameId = requestAnimationFrame(tick);
    };
    state.requestRender = requestRender;

    let cameraTimer = 0;
    const handleControlsChange = () => {
      requestRender();
      clearTimeout(cameraTimer);
      cameraTimer = setTimeout(() => callbacksRef.current.onCameraChange?.(), 300);
    };
    controls.addEventListener("change", handleControlsChange);

    gizmo.addEventListener("change", requestRender);
    gizmo.addEventListener("dragging-changed", (event) => {
      controls.enabled = !event.value;
      if (event.value) return;
      const holder = gizmo.object;
      const entry = (objectsRef.current || []).find((item) => item.controller?.holder === holder);
      if (!entry) return;
      // The gizmo only turns about Y; keep the holder upright whatever it reports.
      const yaw = yawDegrees(holder);
      holder.rotation.set(0, THREE.MathUtils.degToRad(yaw), 0);
      renderer.shadowMap.needsUpdate = true;
      callbacksRef.current.onTransform?.(entry.id, {
        position: holder.position.toArray().map((value) => Number(value.toFixed(3))),
        yaw,
      });
    });

    // Click to select: a press and release that barely moved and was not a gizmo
    // drag. On the selected vehicle, a click on a door, bonnet, boot or roof
    // opens or closes it instead.
    let press = null;
    const raycaster = new THREE.Raycaster();
    const handlePointerDown = (event) => {
      press = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    };
    const handlePointerUp = (event) => {
      if (!press || event.button !== 0) return;
      const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
      press = null;
      if (moved > CLICK_SLOP || gizmo.dragging || gizmo.axis) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const entries = (objectsRef.current || []).filter((entry) => entry.controller && !entry.hidden);
      const hits = raycaster.intersectObjects(entries.map((entry) => entry.controller.holder), true)
        .filter((hit) => hit.object.visible && hit.object.isMesh);
      const hit = hits[0];
      let id = null;
      let owner = null;
      if (hit) {
        for (let node = hit.object; node; node = node.parent) {
          owner = entries.find((item) => item.controller.holder === node) || null;
          if (owner) {
            id = owner.id;
            break;
          }
        }
      }
      const target = owner && id === selectedRef.current ? owner.controller.targetForMesh?.(hit.object) : null;
      if (target) callbacksRef.current.onTogglePart?.(id, target);
      else callbacksRef.current.onSelect?.(id);
    };
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);

    const observer = new ResizeObserver(() => {
      resize();
      requestRender();
    });
    observer.observe(container);
    resize();
    requestRender();

    return () => {
      state.disposed = true;
      clearTimeout(cameraTimer);
      observer.disconnect();
      controls.removeEventListener("change", handleControlsChange);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      if (state.frameId) cancelAnimationFrame(state.frameId);
      gizmo.detach();
      gizmo.dispose();
      gizmoHelper.removeFromParent();
      controls.dispose();
      for (const holder of state.attached.values()) holder.removeFromParent();
      state.attached.clear();
      disposeAoPipeline(aoPipeline);
      disposeBloomPipeline(state.bloom);
      stageApi.dispose();
      key.shadow.map?.dispose?.();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      stateRef.current = null;
    };
    // The renderer is created once; prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fits the stage (floor, spotlight, shadow catcher) around everything on set.
  const refit = () => {
    const state = stateRef.current;
    if (!state) return;
    const bounds = state.sceneBounds();
    const models = (objectsRef.current || []).filter((entry) => entry.controller && !entry.hidden).map((entry) => entry.controller.holder);
    // AO clips to the whole set but takes its radius from a typical object on
    // it (the median by size), so a helicopter beside a ped doesn't blur both.
    const boxes = models
      .map((holder) => new THREE.Box3().setFromObject(holder))
      .filter((box) => !box.isEmpty())
      .sort((a, b) => a.getSize(new THREE.Vector3()).length() - b.getSize(new THREE.Vector3()).length());
    state.aoBounds = { clip: bounds, radius: boxes[Math.floor((boxes.length - 1) / 2)] || null };
    if (bounds) {
      // Lit objects become stage bays, each with its own spotlight settings.
      const entries = (objectsRef.current || []).filter((entry) => entry.controller);
      const lit = new Set(litObjectIds(entries));
      const litEntries = entries.filter((entry) => lit.has(entry.id));
      state.stage.setBayOverrides(new Map(litEntries.map((entry) => [entry.controller.holder.id, {
        strength: entry.light?.strength ?? 1,
        from: entry.light?.from || null,
        color: entry.light?.color || null,
        beam: entry.light?.beam !== false,
      }])));
      state.stage.fit(bounds.clone().expandByScalar(0.05), models, {
        bays: true,
        bayModels: litEntries.map((entry) => entry.controller.holder),
      });
      state.stage.constrainControls(state.controls);
    }
    state.renderer.shadowMap.needsUpdate = true;
    state.requestRender();
  };

  // Sync holders, visibility and placement with the page's object list.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const live = new Set();
    for (const entry of objects || []) {
      const holder = entry.controller?.holder;
      if (!holder) continue;
      live.add(holder);
      if (!state.attached.has(entry.id) || state.attached.get(entry.id) !== holder) {
        state.attached.get(entry.id)?.removeFromParent();
        state.attached.set(entry.id, holder);
        state.scene.add(holder);
        entry.controller.attachScene?.(state.scene);
      }
      holder.visible = !entry.hidden;
      // A holder being dragged keeps the gizmo's live transform.
      if (!(state.gizmo.dragging && state.gizmo.object === holder)) {
        holder.position.fromArray(entry.position);
        holder.rotation.set(0, THREE.MathUtils.degToRad(entry.yaw), 0);
      }
      holder.updateMatrixWorld(true);
    }
    for (const [id, holder] of state.attached) {
      if (live.has(holder)) continue;
      if (state.gizmo.object === holder) state.gizmo.detach();
      holder.removeFromParent();
      state.attached.delete(id);
    }
    refit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objects]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const entry = (objects || []).find((item) => item.id === selectedId && item.controller && !item.hidden);
    if (entry && gizmoVisible) {
      if (state.gizmo.object !== entry.controller.holder) state.gizmo.attach(entry.controller.holder);
      const rotate = gizmoMode === "rotate";
      state.gizmo.setMode(rotate ? "rotate" : "translate");
      state.gizmo.setSpace(rotate ? "local" : "world");
      state.gizmo.showX = !rotate;
      state.gizmo.showZ = !rotate;
      state.gizmo.showY = true;
    } else {
      state.gizmo.detach();
    }
    state.requestRender();
  }, [objects, selectedId, gizmoMode, gizmoVisible]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    state.camera.fov = lensToFov(lens);
    state.camera.updateProjectionMatrix();
    state.requestRender();
  }, [lens]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    state.renderer.setClearColor(new THREE.Color(backgroundColor || "#141414"), 1);
    state.stage.setBackgroundColor(backgroundColor);
    state.requestRender();
  }, [backgroundColor]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const showroomOn = stage === "showroom";
    state.stage.setMode(stage);
    state.stage.setShadows(showShadows);
    state.stage.setGrid(showGrid);
    configureShadowLight(state.lights.key, showShadows && !showroomOn);
    // Dark room: the studio dims to a trace so vehicle lights carry the shot.
    const night = 1 - Math.min(1, Math.max(0, dark)) * 0.96;
    state.stage.setNight(night);
    const levels = LIGHT_LEVELS[showroomOn ? "showroom" : "workbench"];
    state.lights.ambient.intensity = levels.ambient * lightIntensity * night;
    state.lights.key.intensity = levels.key * lightIntensity * night;
    state.lights.rim.intensity = levels.rim * lightIntensity * night;
    state.stage.constrainControls(state.controls);
    state.renderer.shadowMap.needsUpdate = true;
    state.requestRender();
  }, [stage, showGrid, showShadows, lightIntensity, dark]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state || !showroom) return;
    state.stage.setShowroom(showroom);
    state.renderer.shadowMap.needsUpdate = true;
    state.requestRender();
  }, [showroom]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    if (state.ao) state.ao.enabled = Boolean(ambientOcclusion);
    state.requestRender();
  }, [ambientOcclusion]);

  useEffect(() => {
    const state = stateRef.current;
    if (state && playing && isActive) state.requestRender();
  }, [playing, isActive]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state || !isActive || !state.pendingWhileInactive) return;
    state.pendingWhileInactive = false;
    state.requestRender();
  }, [isActive]);

  /** Points the camera at `bounds` from a preset direction, filling the frame. */
  const frameBounds = (bounds, presetKey = "angle") => {
    const state = stateRef.current;
    if (!state || !bounds) return;
    const { camera, controls } = state;
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.1);
    const vertical = THREE.MathUtils.degToRad(camera.fov);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * (camera.aspect || 1));
    const limiting = Math.min(vertical, horizontal);
    const distance = (radius * FIT_PADDING) / Math.sin(limiting / 2);
    const direction = PRESET_DIRECTIONS[presetKey] || PRESET_DIRECTIONS.angle;
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).addScaledVector(direction, distance);
    camera.near = Math.max(0.02, distance * 0.01);
    camera.far = Math.max(distance * 30, 200);
    camera.updateProjectionMatrix();
    controls.update();
    state.requestRender();
    callbacksRef.current.onCameraChange?.();
  };

  /**
   * Renders the current camera at `width` × `height` with the live effects and
   * returns PNG bytes. The picture is the largest frame of the output's aspect
   * that fits the viewfinder, centred: the frame guide the page draws. The
   * stage is hidden for a transparent background; the gizmo never shows. The
   * canvas is restored to the viewfinder afterwards.
   */
  const capture = async ({ width, height, transparent = false }) => {
    const state = stateRef.current;
    if (!state) throw new Error("The viewfinder isn't ready yet.");
    const { renderer, camera, controls, gizmoHelper, stage: stageApi, ao } = state;
    controls.update();
    const previousRatio = renderer.getPixelRatio();
    const previousSize = renderer.getSize(new THREE.Vector2());
    const previousAspect = camera.aspect;
    const previousFov = camera.fov;
    const viewAspect = state.size.width / state.size.height;
    const outAspect = width / height;
    const previousColor = renderer.getClearColor(new THREE.Color());
    const previousAlpha = renderer.getClearAlpha();
    const stageRoot = state.scene.getObjectByName("viewer-stage");
    const stageVisible = stageRoot?.visible ?? true;
    const gizmoWasVisible = gizmoHelper.visible;
    gizmoHelper.visible = false;
    // The frame is copied out and the viewfinder restored in this task; PNG
    // encoding is async, and a live frame drawn meanwhile would otherwise show
    // the canvas at the output size.
    const canvas = document.createElement("canvas");
    try {
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      camera.aspect = outAspect;
      // A wider output than the viewfinder keeps the viewfinder's width and
      // crops height, instead of showing more than the guide.
      if (outAspect > viewAspect) {
        const halfVertical = THREE.MathUtils.degToRad(previousFov) / 2;
        camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan((Math.tan(halfVertical) * viewAspect) / outAspect));
      }
      camera.updateProjectionMatrix();
      stageApi.resize();
      resizeAoPipeline(ao, width, height, 1);
      resizeBloomPipeline(state.bloom, width, height, 1);
      if (transparent) {
        if (stageRoot) stageRoot.visible = false;
        renderer.setClearColor(0x000000, 0);
      }
      state.draw();
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(renderer.domElement, 0, 0, width, height);
    } finally {
      gizmoHelper.visible = gizmoWasVisible;
      if (stageRoot) stageRoot.visible = stageVisible;
      renderer.setClearColor(previousColor, previousAlpha);
      renderer.setPixelRatio(previousRatio);
      renderer.setSize(previousSize.x, previousSize.y, false);
      camera.aspect = previousAspect;
      camera.fov = previousFov;
      camera.updateProjectionMatrix();
      stageApi.resize();
      resizeAoPipeline(ao, previousSize.x, previousSize.y, previousRatio);
      resizeBloomPipeline(state.bloom, previousSize.x, previousSize.y, previousRatio);
      state.draw();
    }
    return canvasToPngBytes(canvas);
  };

  useImperativeHandle(ref, () => ({
    requestRender: () => stateRef.current?.requestRender?.(),
    getRenderer: () => stateRef.current?.renderer || null,
    refit,
    frameAll: (presetKey) => frameBounds(stateRef.current?.sceneBounds(), presetKey),
    frameObject: (id, presetKey) => {
      const entry = (objectsRef.current || []).find((item) => item.id === id && item.controller);
      if (entry) frameBounds(new THREE.Box3().setFromObject(entry.controller.holder), presetKey);
    },
    /** The live camera as { position, target } arrays. */
    getCamera: () => {
      const state = stateRef.current;
      if (!state) return null;
      return {
        position: state.camera.position.toArray().map((value) => Number(value.toFixed(3))),
        target: state.controls.target.toArray().map((value) => Number(value.toFixed(3))),
      };
    },
    setCamera: ({ position, target }) => {
      const state = stateRef.current;
      if (!state || !position || !target) return;
      state.camera.position.fromArray(position);
      state.controls.target.fromArray(target);
      state.controls.update();
      state.requestRender();
    },
    capture,
  }));

  return <div className="pm-viewport" ref={containerRef} />;
});

export default PhotoViewport;
