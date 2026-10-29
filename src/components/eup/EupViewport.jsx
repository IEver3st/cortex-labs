import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { TransformControls } from "three/examples/jsm/controls/TransformControls";
import { computePedBounds } from "../../lib/ped-assembly";
import { createViewerStage } from "../../lib/viewer-stage.js";
import { applyShadowFlags, configureShadowLight, createSolidWireMaterial, renderSolidWire } from "../../lib/viewer-render-effects.js";
import { countDrawnGeometry, createMeshStatsReporter } from "../../lib/mesh-stats.js";
import { shotFov } from "../../lib/eup-export.js";
import { onViewerControlsChange, previewPixelRatio, readViewerControls } from "../../lib/preview-detail.js";

const FOV = 40;
const FIT_PADDING = 1.15;
// A press that moves further than this (in CSS pixels) is an orbit, not a pick.
const PICK_SLOP = 4;

export const EUP_CAMERA_PRESETS = [
  { key: "front", label: "Front" },
  { key: "back", label: "Back" },
  { key: "left", label: "Left" },
  { key: "right", label: "Right" },
  { key: "head", label: "Head" },
  { key: "full", label: "Full" },
];

const PRESET_DIRECTIONS = {
  // The ped faces +Z after the root rotation; its right side is +X.
  front: new THREE.Vector3(0, 0, 1),
  back: new THREE.Vector3(0, 0, -1),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
  head: new THREE.Vector3(0.25, 0.08, 1).normalize(),
  full: new THREE.Vector3(0.6, 0.18, 1).normalize(),
};

export const THUMBNAIL_ANGLES = {
  front: new THREE.Vector3(0, 0, 1),
  angled: new THREE.Vector3(0.55, 0.15, 1).normalize(),
};
const THUMBNAIL_FOV = 30;
const THUMBNAIL_PADDING = 1.06;

function canvasToPngBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("PNG encoding failed"));
        return;
      }
      blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
    }, "image/png");
  });
}

// Renders `object` alone into an offscreen target on the viewport's renderer
// and returns PNG bytes. Blending into a transparent clear leaves premultiplied
// colour at soft edges, so pixels are un-premultiplied before encoding.
async function renderThumbnail(state, object, { size = 512, angle = "angled", background = null } = {}) {
  if (!state) throw new Error("Viewport is not ready");
  const { renderer, lights } = state;
  const scene = new THREE.Scene();
  const ambient = lights.ambient.clone();
  const key = lights.key.clone();
  const rim = lights.rim.clone();
  scene.add(ambient, key, rim, object);
  object.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(object);
  if (bounds.isEmpty()) {
    scene.remove(object);
    throw new Error("Drawable has no visible geometry");
  }
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.02);
  const distance = (radius * THUMBNAIL_PADDING) / Math.sin(THREE.MathUtils.degToRad(THUMBNAIL_FOV) / 2);
  const camera = new THREE.PerspectiveCamera(THUMBNAIL_FOV, 1, Math.max(distance * 0.01, 0.005), distance * 4);
  const direction = THUMBNAIL_ANGLES[angle] || THUMBNAIL_ANGLES.angled;
  camera.position.copy(sphere.center).addScaledVector(direction, distance);
  camera.lookAt(sphere.center);

  const target = new THREE.WebGLRenderTarget(size, size, { samples: 4, colorSpace: THREE.SRGBColorSpace });
  const previousTarget = renderer.getRenderTarget();
  const previousColor = renderer.getClearColor(new THREE.Color());
  const previousAlpha = renderer.getClearAlpha();
  const pixels = new Uint8Array(size * size * 4);
  try {
    renderer.setRenderTarget(target);
    if (background) renderer.setClearColor(new THREE.Color(background), 1);
    else renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousColor, previousAlpha);
    target.dispose();
    scene.remove(object);
    state.requestRender?.();
  }

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const image = new ImageData(size, size);
  const rowBytes = size * 4;
  for (let y = 0; y < size; y += 1) {
    const src = (size - 1 - y) * rowBytes;
    const dst = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 4) {
      const alpha = pixels[src + x + 3];
      const scale = !background && alpha > 0 && alpha < 255 ? 255 / alpha : 1;
      image.data[dst + x] = Math.min(255, pixels[src + x] * scale);
      image.data[dst + x + 1] = Math.min(255, pixels[src + x + 1] * scale);
      image.data[dst + x + 2] = Math.min(255, pixels[src + x + 2] * scale);
      image.data[dst + x + 3] = alpha;
    }
  }
  canvas.getContext("2d").putImageData(image, 0, 0);
  return canvasToPngBytes(canvas);
}

// Copies a half-float render target into a 2D canvas. three.js writes linear
// colour into render targets, so this flips rows, undoes the premultiplication
// a transparent clear leaves at soft edges, and encodes to sRGB.
function targetToCanvas(renderer, target, width, height) {
  const pixels = new Uint16Array(width * height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const image = new ImageData(width, height);
  const row = width * 4;
  const encode = (value) => Math.round(THREE.MathUtils.clamp(linearToSrgb(value), 0, 1) * 255);
  for (let y = 0; y < height; y += 1) {
    const src = (height - 1 - y) * row;
    const dst = y * row;
    for (let x = 0; x < row; x += 4) {
      const alpha = THREE.MathUtils.clamp(THREE.DataUtils.fromHalfFloat(pixels[src + x + 3]), 0, 1);
      if (alpha <= 0) continue;
      for (let c = 0; c < 3; c += 1) {
        image.data[dst + x + c] = encode(THREE.DataUtils.fromHalfFloat(pixels[src + x + c]) / alpha);
      }
      image.data[dst + x + 3] = Math.round(alpha * 255);
    }
  }
  canvas.getContext("2d").putImageData(image, 0, 0);
  return canvas;
}

function linearToSrgb(value) {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

const UP = new THREE.Vector3(0, 1, 0);

function fallbackBounds() {
  return new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1.8, 0.5));
}

function isShown(object) {
  for (let node = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}

function isInside(root, object) {
  for (let node = object; node; node = node.parent) if (node === root) return true;
  return false;
}

// Hides the move/turn gizmo for a capture; the returned function shows it
// again if it is on an object by then (a selection can change meanwhile).
function hideGizmo(state) {
  const helper = state.gizmoHelper;
  helper.visible = false;
  return () => {
    helper.visible = Boolean(state.gizmo.object);
  };
}

// Scene light levels per stage, matching the vehicle viewer: the showroom is
// lit by its spotlight, so the fill lights drop almost to nothing.
const LIGHT_LEVELS = {
  workbench: { ambient: 0.5, key: 0.9, rim: 0.35 },
  showroom: { ambient: 0.06, key: 0.3, rim: 0.55 },
};

// Own WebGL renderer on the shared viewer stage (workbench grid and shadows,
// or the showroom). Renders on demand; the frame loop only keeps running while
// OrbitControls damping is settling or a clip is playing (`animating`).
//
// `setRoot` holds the props placed on the floor: rendered, shadowed and
// captured, never framed. `gizmo` ({ object, mode, free }) puts a move or turn
// gizmo on one object; a placed prop turns about Y only, a held prop (`free`)
// on every axis. `pickObjects()` lists [{ key, object, held }] a click can
// select through `onPickObject(key)` (null for a click on nothing).
const EupViewport = forwardRef(function EupViewport(
  {
    pedRoot,
    setRoot = null,
    gizmo = null,
    onGizmoEnd = null,
    pickObjects = null,
    onPickObject = null,
    focusRoot = null,
    pickRoots = null,
    onPick = null,
    isActive,
    backgroundColor,
    lightIntensity = 1,
    cameraPreset = "front",
    enabled = true,
    stage = "workbench",
    showroom = null,
    showGrid = true,
    showShadows = true,
    animating = false,
    onAnimate = null,
    showSolidWireframe = false,
    onMeshStats = null,
  },
  ref,
) {
  const containerRef = useRef(null);
  const stateRef = useRef(null);
  const activeRef = useRef(Boolean(isActive));
  activeRef.current = Boolean(isActive);
  const animatingRef = useRef(Boolean(animating));
  animatingRef.current = Boolean(animating);
  const onAnimateRef = useRef(onAnimate);
  onAnimateRef.current = onAnimate;
  const stageModeRef = useRef(stage);
  stageModeRef.current = stage;
  const pickRef = useRef({ roots: pickRoots, onPick });
  pickRef.current = { roots: pickRoots, onPick, objects: pickObjects, onPickObject, onGizmoEnd };
  const gizmoRef = useRef(gizmo);
  gizmoRef.current = gizmo;
  const solidWireRef = useRef({ on: showSolidWireframe, onStats: onMeshStats, material: null, reporter: createMeshStatsReporter() });
  solidWireRef.current.on = showSolidWireframe;
  solidWireRef.current.onStats = onMeshStats;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return undefined;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, stencil: true });
    let viewerControls = readViewerControls();
    renderer.setPixelRatio(previewPixelRatio(viewerControls.detail));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(new THREE.Color(backgroundColor || "#141414"), 1);
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 200);
    camera.position.set(0, 1, 3.5);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minDistance = 0.15;
    controls.zoomToCursor = viewerControls.zoomToCursor;
    controls.maxDistance = 20;
    controls.target.set(0, 0.9, 0);

    const ambient = new THREE.AmbientLight(0xffffff, 0.5 * lightIntensity);
    const key = new THREE.DirectionalLight(0xffffff, 0.9 * lightIntensity);
    key.position.set(3.5, 4.5, 2.5);
    const rim = new THREE.DirectionalLight(0xffffff, 0.35 * lightIntensity);
    rim.position.set(-3, 2, -2.2);
    scene.add(ambient, key, rim, key.target);
    if (pedRoot) scene.add(pedRoot);
    if (setRoot) scene.add(setRoot);

    const stageApi = createViewerStage({ renderer, scene, keyLight: key, subject: "ped" });
    stageApi.setBackgroundColor(backgroundColor);

    const gizmoControls = new TransformControls(camera, renderer.domElement);
    gizmoControls.setSize(0.85);
    const gizmoHelper = gizmoControls.getHelper();
    scene.add(gizmoHelper);

    container.appendChild(renderer.domElement);
    renderer.domElement.addEventListener("contextmenu", (event) => event.preventDefault());

    const state = {
      renderer,
      scene,
      camera,
      controls,
      gizmo: gizmoControls,
      gizmoHelper,
      lights: { ambient, key, rim },
      stage: stageApi,
      frameId: 0,
      lastTime: 0,
      pendingWhileInactive: false,
      disposed: false,
    };
    stateRef.current = state;
    // Slots and placed props load and unload at any time; their shadow flags
    // follow on the next frame after a change. Every slot, held-prop and
    // placed-prop load or unload asks for a render through the handle, which
    // marks them dirty, as does a shadow or stage setting; orbiting and
    // playback don't walk the scene.
    state.shadowsDirty = true;
    state.applyShadows = () => {
      state.shadowsDirty = false;
      if (pedRoot) applyShadowFlags(pedRoot, stageApi.castsShadows);
      if (setRoot) applyShadowFlags(setRoot, stageApi.castsShadows);
    };

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!width || !height) return false;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      stageApi.resize();
      return true;
    };

    const tick = (now) => {
      if (state.disposed) return;
      state.frameId = 0;
      if (state.recording) return;
      // A gizmo drag holds the pose so a held prop stays under the pointer.
      const animate = animatingRef.current && activeRef.current && !gizmoControls.dragging;
      if (animate) {
        const dt = state.lastTime ? Math.min((now - state.lastTime) / 1000, 0.1) : 0;
        onAnimateRef.current?.(dt);
      }
      state.lastTime = animate ? now : 0;
      const moved = controls.update();
      if (gizmoControls.object && !gizmoControls.object.parent) gizmoControls.detach();
      if (state.shadowsDirty) state.applyShadows();
      renderer.render(scene, camera);
      const wire = solidWireRef.current;
      if (wire.on && pedRoot) {
        wire.material ||= createSolidWireMaterial();
        renderSolidWire(renderer, scene, camera, { roots: [pedRoot], material: wire.material });
      }
      wire.reporter.report(wire.on && pedRoot ? [pedRoot] : null, (stats) => {
        if (!stats) return wire.onStats?.(null);
        const models = pedRoot.children.filter((figure) => countDrawnGeometry([figure]).meshes > 0).length;
        wire.onStats?.({ ...stats, models, size: models > 1 ? null : stats.size });
      });
      if (moved || animate) requestRender();
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

    const renderNow = () => {
      if (state.disposed || !activeRef.current) return requestRender();
      if (state.frameId) cancelAnimationFrame(state.frameId);
      tick(performance.now());
    };

    controls.addEventListener("change", requestRender);

    // The gizmo owns the pointer while it drags; orbit waits until it lets go.
    gizmoControls.addEventListener("change", requestRender);
    gizmoControls.addEventListener("dragging-changed", (event) => {
      controls.enabled = !event.value;
      requestRender();
      if (!event.value && gizmoControls.object) pickRef.current.onGizmoEnd?.(gizmoControls.object);
    });

    // A click (not a drag) picks: a held prop, then a placed prop in front of
    // any character, then a character (the way Multi picks a vehicle). A click
    // on nothing clears the prop selection.
    let press = null;
    const raycaster = new THREE.Raycaster();
    const onPointerDown = (event) => {
      // The gizmo's own listener runs first and has set its axis on a handle press.
      press = event.button === 0
        ? { x: event.clientX, y: event.clientY, onGizmo: gizmoControls.dragging || gizmoControls.axis !== null }
        : null;
    };
    const onPointerUp = (event) => {
      const start = press;
      press = null;
      const { roots, onPick: pick, objects, onPickObject: pickObject } = pickRef.current;
      if (!start || start.onGizmo || event.button !== 0) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > PICK_SLOP) return;
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const pointer = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      let prop = null;
      const entries = pickObject ? (objects?.() || []).filter((entry) => entry.object && isShown(entry.object)) : [];
      if (entries.length) {
        for (const hit of raycaster.intersectObjects(entries.map((entry) => entry.object), true)) {
          if (!hit.object.isMesh || !isShown(hit.object)) continue;
          const entry = entries.find((item) => isInside(item.object, hit.object));
          if (entry) {
            prop = { entry, distance: hit.distance };
            break;
          }
        }
      }
      let best = null;
      for (const { id, root } of (pick && roots) || []) {
        const bounds = computePedBounds(root);
        const hit = bounds ? raycaster.ray.intersectBox(bounds, new THREE.Vector3()) : null;
        if (!hit) continue;
        const distance = hit.distanceTo(raycaster.ray.origin);
        if (!best || distance < best.distance) best = { id, distance };
      }
      // A held prop sits inside its character's box, so it wins outright.
      if (prop && (prop.entry.held || !best || prop.distance <= best.distance)) {
        pickObject(prop.entry.key);
        return;
      }
      pickObject?.(null);
      if (best) pick(best.id);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    const observer = new ResizeObserver(() => {
      if (resize()) renderNow();
      else requestRender();
    });
    observer.observe(container);
    resize();
    requestRender();
    const stopViewerControls = onViewerControlsChange(viewerControls, (next) => {
      viewerControls = next;
      controls.zoomToCursor = next.zoomToCursor;
      if (state.recording) return;
      renderer.setPixelRatio(previewPixelRatio(next.detail));
      if (resize()) renderNow();
      else requestRender();
    });

    return () => {
      state.disposed = true;
      observer.disconnect();
      stopViewerControls();
      controls.removeEventListener("change", requestRender);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      if (state.frameId) cancelAnimationFrame(state.frameId);
      gizmoControls.detach();
      gizmoControls.dispose();
      gizmoHelper.removeFromParent();
      controls.dispose();
      if (pedRoot) scene.remove(pedRoot);
      if (setRoot) scene.remove(setRoot);
      stageApi.dispose();
      key.shadow.map?.dispose?.();
      solidWireRef.current.material?.dispose();
      solidWireRef.current.material = null;
      solidWireRef.current.reporter.reset();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      stateRef.current = null;
    };
    // The renderer is created once; prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, pedRoot, setRoot]);

  // Puts the gizmo on the selected object. attach() shows the helper, so a
  // recording leaves it alone and syncs once it ends.
  const syncGizmo = () => {
    const state = stateRef.current;
    if (!state || state.recording) return;
    const controls = state.gizmo;
    const current = gizmoRef.current;
    const target = current?.object || null;
    if (target?.parent) {
      if (controls.object !== target) controls.attach(target);
      const rotate = current.mode === "rotate";
      controls.setMode(rotate ? "rotate" : "translate");
      // Placed props move on the floor plane plus lift, and turn about Y only.
      controls.setSpace(rotate ? "local" : "world");
      controls.showX = Boolean(current.free) || !rotate;
      controls.showZ = Boolean(current.free) || !rotate;
      controls.showY = true;
    } else if (controls.object) {
      controls.detach();
    }
    state.requestRender();
  };

  useEffect(() => {
    solidWireRef.current.reporter.reset();
    stateRef.current?.requestRender();
  }, [showSolidWireframe]);

  useEffect(() => {
    syncGizmo();
    // syncGizmo reads the latest gizmo through gizmoRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gizmo, enabled]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    state.renderer.setClearColor(new THREE.Color(backgroundColor || "#141414"), 1);
    state.stage.setBackgroundColor(backgroundColor);
    state.requestRender();
  }, [backgroundColor, enabled]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const showroomOn = stage === "showroom";
    state.stage.setMode(stage);
    state.stage.setShadows(showShadows);
    state.stage.setGrid(showGrid);
    configureShadowLight(state.lights.key, showShadows && !showroomOn);
    state.shadowsDirty = true;
    const levels = LIGHT_LEVELS[showroomOn ? "showroom" : "workbench"];
    state.lights.ambient.intensity = levels.ambient * lightIntensity;
    state.lights.key.intensity = levels.key * lightIntensity;
    state.lights.rim.intensity = levels.rim * lightIntensity;
    state.stage.constrainControls(state.controls);
    state.renderer.shadowMap.needsUpdate = true;
    state.requestRender();
  }, [stage, showGrid, showShadows, lightIntensity, enabled]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state || !showroom) return;
    state.stage.setShowroom(showroom);
    state.renderer.shadowMap.needsUpdate = true;
    state.requestRender();
  }, [showroom, enabled]);

  useEffect(() => {
    const state = stateRef.current;
    if (state && animating && isActive) state.requestRender();
  }, [animating, isActive]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state || !isActive) return;
    if (state.pendingWhileInactive) {
      state.pendingWhileInactive = false;
      state.requestRender();
    }
  }, [isActive]);

  // Where a camera preset puts the camera for a given aspect. Every preset
  // frames the whole cast except Head, which frames the focused character.
  const framingFor = (presetKey, aspect) => {
    const subject = presetKey === "head" && focusRoot ? focusRoot : pedRoot;
    const bounds = computePedBounds(subject) || computePedBounds(pedRoot) || fallbackBounds();
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const height = Math.max(size.y, 0.5);

    let target = center;
    let radius = Math.max(size.length() / 2, 0.3);
    if (presetKey === "head") {
      target = new THREE.Vector3(center.x, bounds.max.y - height * 0.09, center.z);
      radius = Math.max(height * 0.13, 0.12);
    }

    const direction = PRESET_DIRECTIONS[presetKey] || PRESET_DIRECTIONS.front;
    const vertical = THREE.MathUtils.degToRad(FOV);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * (aspect > 0 ? aspect : 1));
    const limiting = Math.max(Math.min(vertical, horizontal), THREE.MathUtils.degToRad(10));
    const distance = (radius * FIT_PADDING) / Math.sin(limiting / 2);
    return {
      position: target.clone().addScaledVector(direction, distance),
      target,
      near: Math.max(0.01, distance * 0.02),
      far: Math.max(distance * 10, 50),
      minDistance: Math.max(radius * 0.2, 0.05),
      maxDistance: Math.max(distance * 6, 10),
    };
  };

  const frame = (presetKey = cameraPreset) => {
    const state = stateRef.current;
    if (!state) return;
    const { camera, controls } = state;
    const framing = framingFor(presetKey, camera.aspect);
    camera.position.copy(framing.position);
    camera.near = framing.near;
    camera.far = framing.far;
    camera.updateProjectionMatrix();
    controls.target.copy(framing.target);
    controls.minDistance = framing.minDistance;
    controls.maxDistance = framing.maxDistance;
    refit();
    controls.update();
    state.requestRender();
  };

  // Sizes the stage to the ped and keeps the showroom orbit inside it. The
  // floor sits at y = 0, where the page settles the ped's lowest point.
  const refit = () => {
    const state = stateRef.current;
    if (!state) return;
    const bounds = computePedBounds(pedRoot) || fallbackBounds();
    const padded = bounds.clone().expandByScalar(0.15);
    padded.min.y = Math.min(bounds.min.y, 0);
    state.stage.fit(padded, []);
    state.stage.constrainControls(state.controls);
    state.renderer.shadowMap.needsUpdate = true;
    state.requestRender();
  };

  useEffect(() => {
    frame(cameraPreset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraPreset]);

  // A camera for an output of width x height: the viewfinder as framed
  // ("view", cropped exactly like the frame guide) or an auto-framed preset.
  const shotCamera = (width, height, angle = "view") => {
    const { camera } = stateRef.current;
    const shot = camera.clone();
    const outAspect = width / height;
    if (angle === "view") {
      shot.fov = shotFov(camera.fov, camera.aspect, outAspect);
    } else {
      const framing = framingFor(angle, outAspect);
      shot.position.copy(framing.position);
      shot.near = framing.near;
      shot.far = framing.far;
      shot.lookAt(framing.target);
    }
    shot.aspect = outAspect;
    shot.updateProjectionMatrix();
    shot.updateMatrixWorld();
    return shot;
  };

  // Renders the live scene (stage, lights, pose) at an exact pixel size into a
  // 2D canvas. The drawing buffer is resized for one synchronous render and
  // restored before the browser paints, so the viewfinder never shows it.
  // Transparent output renders to a target without the stage; it matches the
  // workbench, which has no tone mapping.
  const captureFrame = ({ width, height, angle = "view", transparent = false }) => {
    const state = stateRef.current;
    if (!state) throw new Error("The viewport isn't ready");
    if (state.recording) throw new Error("A video is recording");
    const { renderer, scene, stage } = state;
    const shot = shotCamera(width, height, angle);
    state.applyShadows();
    renderer.shadowMap.needsUpdate = true;
    if (transparent) {
      const target = new THREE.WebGLRenderTarget(width, height, { samples: 4, type: THREE.HalfFloatType });
      const previousTarget = renderer.getRenderTarget();
      const previousColor = renderer.getClearColor(new THREE.Color());
      const previousAlpha = renderer.getClearAlpha();
      const previousBackground = scene.background;
      const showGizmo = hideGizmo(state);
      try {
        stage.root.visible = false;
        scene.background = null;
        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(scene, shot);
        return targetToCanvas(renderer, target, width, height);
      } finally {
        showGizmo();
        stage.root.visible = true;
        scene.background = previousBackground;
        renderer.setRenderTarget(previousTarget);
        renderer.setClearColor(previousColor, previousAlpha);
        target.dispose();
        state.requestRender();
      }
    }
    const previousRatio = renderer.getPixelRatio();
    const previousSize = renderer.getSize(new THREE.Vector2());
    const showGizmo = hideGizmo(state);
    try {
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      stage.resize();
      renderer.render(scene, shot);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(renderer.domElement, 0, 0);
      return canvas;
    } finally {
      showGizmo();
      renderer.setPixelRatio(previousRatio);
      renderer.setSize(previousSize.x, previousSize.y, false);
      stage.resize();
      state.requestRender();
    }
  };

  // Records the live scene in real time at width x height. "turntable" orbits
  // the camera once around the viewfinder's target from where it is now;
  // "fixed" holds the viewfinder's framing. The pose keeps playing if it is.
  const recordVideo = async ({ width, height, seconds, camera: cameraMode, fps, mimeType, onProgress, isCancelled }) => {
    const state = stateRef.current;
    if (!state) throw new Error("The viewport isn't ready");
    if (state.recording) throw new Error("A video is already recording");
    const { renderer, scene, controls, stage } = state;
    const shot = shotCamera(width, height, "view");
    const pivot = controls.target.clone();
    const offset = shot.position.clone().sub(pivot);
    const previousRatio = renderer.getPixelRatio();
    const previousSize = renderer.getSize(new THREE.Vector2());
    state.recording = true;
    if (state.frameId) {
      cancelAnimationFrame(state.frameId);
      state.frameId = 0;
    }
    // The gizmo stays hidden and put for the whole recording.
    const showGizmo = hideGizmo(state);
    state.gizmo.enabled = false;
    let stream = null;
    try {
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      stage.resize();
      state.applyShadows();
      stream = renderer.domElement.captureStream(fps);
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: Math.round(width * height * fps * 0.25),
      });
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunks.push(event.data);
      };
      let recorderError = null;
      recorder.onerror = (event) => {
        recorderError = event.error || new Error("The recorder failed");
      };
      const stopped = new Promise((resolve) => {
        recorder.onstop = resolve;
      });
      recorder.start(250);
      let cancelled = false;
      await new Promise((resolve) => {
        let start = null;
        let last = null;
        const step = (now) => {
          if (state.disposed) {
            cancelled = true;
            resolve();
            return;
          }
          if (start === null) {
            start = now;
            last = now;
          }
          const elapsed = (now - start) / 1000;
          const dt = Math.min((now - last) / 1000, 0.1);
          last = now;
          if (animatingRef.current) onAnimateRef.current?.(dt);
          if (cameraMode === "turntable") {
            shot.position.copy(pivot).add(offset.clone().applyAxisAngle(UP, (elapsed / seconds) * Math.PI * 2));
            shot.lookAt(pivot);
          }
          // A slot or prop that loads mid-recording gets its shadow flags too.
          if (state.shadowsDirty) state.applyShadows();
          renderer.render(scene, shot);
          onProgress?.(Math.min(1, elapsed / seconds));
          if (isCancelled?.()) cancelled = true;
          if (cancelled || recorderError || elapsed >= seconds) {
            resolve();
            return;
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      if (recorder.state !== "inactive") recorder.stop();
      await stopped;
      if (cancelled) return null;
      if (recorderError) throw recorderError;
      const blob = new Blob(chunks, { type: mimeType });
      // Some runtimes accept a format but never deliver frames.
      if (blob.size === 0) throw new Error("The recorder produced no video data");
      return blob;
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      showGizmo();
      state.gizmo.enabled = true;
      state.recording = false;
      state.lastTime = 0;
      if (!state.disposed) {
        renderer.setPixelRatio(previousRatio);
        renderer.setSize(previousSize.x, previousSize.y, false);
        stage.resize();
        // A prop picked or let go of during the recording gets the gizmo now.
        syncGizmo();
        state.requestRender();
      }
    }
  };

  useImperativeHandle(ref, () => ({
    captureFrame,
    recordVideo,
    getRenderer: () => stateRef.current?.renderer,
    // The page asks for a render after it changes the scene (a slot, held or
    // placed prop loading or going), so shadow flags are refreshed with it.
    requestRender: () => {
      const state = stateRef.current;
      if (!state) return;
      state.shadowsDirty = true;
      state.requestRender();
    },
    frame,
    refit,
    /** Scrolls the floor pattern so a walk cycle playing in place reads as walking forward. */
    setFloorScroll: (distance) => stateRef.current?.stage.setScroll(0, distance),
    captureScreenshot: () => {
      const state = stateRef.current;
      if (!state) return null;
      state.controls.update();
      const showGizmo = hideGizmo(state);
      try {
        state.renderer.render(state.scene, state.camera);
        return state.renderer.domElement.toDataURL("image/png");
      } finally {
        showGizmo();
        state.requestRender();
      }
    },
    renderThumbnail: (object, options) => renderThumbnail(stateRef.current, object, options),
  }));

  return <div className="eup-viewport-canvas" ref={containerRef} />;
});

export default EupViewport;
