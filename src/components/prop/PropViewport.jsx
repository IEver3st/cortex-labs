import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { createViewerStage } from "../../lib/viewer-stage.js";
import { createMeshStatsReporter } from "../../lib/mesh-stats.js";
import {
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

const MAX_PIXEL_RATIO = 1.5;
const FOV = 35;
const FIT_PADDING = 1.2;
const THUMBNAIL_FOV = 30;

// Directions from the prop's centre to the camera. GTA props face -Y in model
// space, which the GTA-to-three turn puts at +Z.
const PRESET_DIRECTIONS = {
  front: new THREE.Vector3(0, 0.12, 1).normalize(),
  back: new THREE.Vector3(0, 0.12, -1).normalize(),
  left: new THREE.Vector3(-1, 0.12, 0).normalize(),
  right: new THREE.Vector3(1, 0.12, 0).normalize(),
  top: new THREE.Vector3(0, 1, 0.0001).normalize(),
  angle: new THREE.Vector3(0.75, 0.42, 1).normalize(),
};

// Fill light levels per stage; the showroom is lit by its spotlight.
const LIGHT_LEVELS = {
  workbench: { ambient: 0.5, key: 0.95, rim: 0.4 },
  showroom: { ambient: 0.05, key: 0.3, rim: 0.5 },
};

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

/* Own WebGL renderer on the shared viewer stage (subject "prop"). Renders on
   demand: the frame loop runs only while orbit damping settles or the
   turntable is spinning (`animating`), and never while the tab is hidden. */
const PropViewport = forwardRef(function PropViewport(
  {
    prop,
    isActive,
    backgroundColor,
    lightIntensity = 1,
    dark = 0,
    stage = "workbench",
    showroom = null,
    showGrid = true,
    showShadows = true,
    ambientOcclusion = false,
    bloom = false,
    animating = false,
    onAnimate = null,
    onFrame = null,
    showMeshStats = false,
    onMeshStats = null,
    hideModel = false,
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
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const propRef = useRef(prop);
  propRef.current = prop;
  const meshStatsRef = useRef({ on: showMeshStats, onStats: onMeshStats, reporter: createMeshStatsReporter() });
  meshStatsRef.current.on = showMeshStats;
  meshStatsRef.current.onStats = onMeshStats;
  const hideModelRef = useRef(Boolean(hideModel));
  hideModelRef.current = Boolean(hideModel);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(new THREE.Color(backgroundColor || "#141414"), 1);
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
    camera.position.set(0.6, 0.4, 0.8);
    camera.layers.enable(GLOW_LAYER);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minDistance = 0.02;
    controls.maxDistance = 20;

    const ambient = new THREE.AmbientLight(0xffffff, 0.5 * lightIntensity);
    const key = new THREE.DirectionalLight(0xffffff, 0.95 * lightIntensity);
    key.position.set(2.5, 4, 3);
    const rim = new THREE.DirectionalLight(0xffffff, 0.4 * lightIntensity);
    rim.position.set(-3, 2, -2.5);
    scene.add(ambient, key, rim, key.target);

    const stageApi = createViewerStage({ renderer, scene, keyLight: key, subject: "prop" });
    stageApi.setBackgroundColor(backgroundColor);

    const bloomPipeline = createBloomPipeline({ renderer, scene, camera, width: 1, height: 1 });
    const aoPipeline = createAoPipeline({ renderer, scene, camera, width: 1, height: 1 });

    container.appendChild(renderer.domElement);
    renderer.domElement.addEventListener("contextmenu", (event) => event.preventDefault());

    const state = {
      renderer,
      scene,
      camera,
      controls,
      lights: { ambient, key, rim },
      stage: stageApi,
      bloom: bloomPipeline,
      ao: aoPipeline,
      frameId: 0,
      lastTime: 0,
      pendingWhileInactive: false,
      disposed: false,
      attached: null,
    };
    stateRef.current = state;

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!width || !height) return false;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      const ratio = renderer.getPixelRatio();
      resizeBloomPipeline(bloomPipeline, width, height, ratio);
      resizeAoPipeline(aoPipeline, width, height, ratio);
      stageApi.resize();
      return true;
    };

    const draw = () => {
      const current = propRef.current;
      // Only the model casts: beams and coronas are light, not matter.
      if (current) applyShadowFlags(current.model, stageApi.castsShadows);
      if (aoPipeline?.enabled) setAoBounds(aoPipeline, current?.bounds() || null);
      const hidden = hideModelRef.current && current?.model.visible ? current.model : null;
      if (hidden) hidden.visible = false;
      try {
        renderWithEffects({ renderer, scene, camera, ao: aoPipeline, bloom: bloomPipeline });
      } finally {
        if (hidden) hidden.visible = true;
      }
      const stats = meshStatsRef.current;
      stats.reporter.report(stats.on && current ? [current.model] : null, stats.onStats);
    };
    state.draw = draw;

    const tick = (now) => {
      if (state.disposed) return;
      state.frameId = 0;
      const animate = animatingRef.current && activeRef.current;
      if (animate) {
        const dt = state.lastTime ? Math.min((now - state.lastTime) / 1000, 0.1) : 0;
        onAnimateRef.current?.(dt);
      }
      state.lastTime = animate ? now : 0;
      const moved = controls.update();
      onFrameRef.current?.();
      draw();
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

    const observer = new ResizeObserver(() => {
      if (resize()) renderNow();
      else requestRender();
    });
    observer.observe(container);
    resize();
    requestRender();

    return () => {
      state.disposed = true;
      observer.disconnect();
      controls.removeEventListener("change", requestRender);
      if (state.frameId) cancelAnimationFrame(state.frameId);
      controls.dispose();
      if (state.attached) scene.remove(state.attached);
      disposeBloomPipeline(bloomPipeline);
      disposeAoPipeline(aoPipeline);
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

  // Swap the prop in and out of the scene.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    if (state.attached && state.attached !== prop?.root) state.scene.remove(state.attached);
    state.attached = prop?.root || null;
    if (state.attached) state.scene.add(state.attached);
    state.renderer.shadowMap.needsUpdate = true;
    state.requestRender();
  }, [prop]);

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
    // Finer shadow offsets than a vehicle needs; a prop may be centimetres long.
    state.lights.key.shadow.normalBias = 0.004;
    state.lights.key.shadow.bias = -0.0002;
    // Dark room: the studio dims to a trace so emissives and the prop's lights lead.
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
    if (state.bloom) state.bloom.enabled = Boolean(bloom);
    if (state.ao) state.ao.enabled = Boolean(ambientOcclusion);
    state.requestRender();
  }, [bloom, ambientOcclusion]);

  useEffect(() => {
    const state = stateRef.current;
    if (state && animating && isActive) state.requestRender();
  }, [animating, isActive]);

  useEffect(() => {
    meshStatsRef.current.reporter.reset();
    stateRef.current?.requestRender();
  }, [showMeshStats, prop]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    state.renderer.shadowMap.needsUpdate = true;
    state.requestRender();
  }, [hideModel]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state || !isActive) return;
    if (state.pendingWhileInactive) {
      state.pendingWhileInactive = false;
      state.requestRender();
    }
  }, [isActive]);

  // Sizes the stage to the prop and keeps the showroom orbit inside it.
  const refit = () => {
    const state = stateRef.current;
    const current = propRef.current;
    if (!state || !current) return;
    const bounds = current.restBounds();
    if (!bounds) return;
    state.stage.fit(bounds.clone().expandByScalar(Math.max(0.01, bounds.getSize(new THREE.Vector3()).length() * 0.05)), [current.model]);
    state.stage.constrainControls(state.controls);
    state.renderer.shadowMap.needsUpdate = true;
    state.requestRender();
  };

  const frame = (presetKey = "angle") => {
    const state = stateRef.current;
    const current = propRef.current;
    if (!state || !current) return;
    const bounds = current.restBounds();
    if (!bounds) return;
    const { camera, controls } = state;
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.01);
    const aspect = camera.aspect > 0 ? camera.aspect : 1;
    const vertical = THREE.MathUtils.degToRad(FOV);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
    const limiting = Math.max(Math.min(vertical, horizontal), THREE.MathUtils.degToRad(10));
    const distance = (radius * FIT_PADDING) / Math.sin(limiting / 2);
    const direction = PRESET_DIRECTIONS[presetKey] || PRESET_DIRECTIONS.angle;

    camera.position.copy(sphere.center).addScaledVector(direction, distance);
    camera.near = Math.max(0.0005, distance * 0.01);
    camera.far = Math.max(distance * 40, 10);
    camera.updateProjectionMatrix();
    controls.target.copy(sphere.center);
    controls.minDistance = Math.max(radius * 0.15, 0.005);
    controls.maxDistance = Math.max(distance * 8, 1);
    refit();
    controls.update();
    state.requestRender();
  };

  // Renders the prop alone into an offscreen target and returns PNG bytes.
  // Transparent output is un-premultiplied at soft edges before encoding.
  const renderThumbnail = async ({ size = 512, angle = "camera", padding = 0.08, background = null } = {}) => {
    const state = stateRef.current;
    const current = propRef.current;
    if (!state || !current) throw new Error("The viewfinder isn't ready yet.");
    const { renderer, lights, scene: mainScene } = state;
    const bounds = current.bounds();
    if (!bounds) throw new Error("The prop has no visible geometry.");

    const thumbScene = new THREE.Scene();
    thumbScene.environment = mainScene.environment;
    thumbScene.environmentIntensity = mainScene.environmentIntensity ?? 1;
    const fill = [lights.ambient.clone(), lights.key.clone(), lights.rim.clone()];
    for (const light of fill) {
      light.castShadow = false;
      thumbScene.add(light);
    }
    const root = current.root;
    const parent = root.parent;
    const restoreHelpers = current.hideHelpers();
    thumbScene.add(root);
    root.updateMatrixWorld(true);

    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.005);
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(THUMBNAIL_FOV) / 2);
    const camera = new THREE.PerspectiveCamera(THUMBNAIL_FOV, 1, Math.max(distance * 0.01, 0.0005), distance * 6);
    camera.layers.enable(GLOW_LAYER);
    const direction = angle === "camera"
      ? state.camera.position.clone().sub(state.controls.target).normalize()
      : (PRESET_DIRECTIONS[angle] || PRESET_DIRECTIONS.angle).clone();
    camera.position.copy(sphere.center).addScaledVector(direction, distance);
    camera.up.set(0, 1, 0);
    camera.lookAt(sphere.center);
    // The sphere guarantees nothing clips; zoom in until the box's projected
    // corners meet the padding, so flat or long props fill the square.
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    let extent = 0;
    for (let corner = 0; corner < 8; corner += 1) {
      const point = new THREE.Vector3(
        corner & 1 ? bounds.max.x : bounds.min.x,
        corner & 2 ? bounds.max.y : bounds.min.y,
        corner & 4 ? bounds.max.z : bounds.min.z,
      ).project(camera);
      extent = Math.max(extent, Math.abs(point.x), Math.abs(point.y));
    }
    if (extent > 0.001) {
      camera.zoom = Math.min(20, 1 / (extent * (1 + padding)));
      camera.updateProjectionMatrix();
    }

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
      renderer.render(thumbScene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(previousColor, previousAlpha);
      target.dispose();
      if (parent) parent.add(root);
      else thumbScene.remove(root);
      restoreHelpers();
      state.requestRender();
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
  };

  useImperativeHandle(ref, () => ({
    requestRender: () => stateRef.current?.requestRender?.(),
    getRenderer: () => stateRef.current?.renderer || null,
    frame,
    refit,
    /** Floor height of the stage, for the prop light beams. */
    floorY: () => propRef.current?.restBounds()?.min.y ?? 0,
    setAccentLights: (accents) => stateRef.current?.stage.setAccentLights(accents),
    captureScreenshot: () => {
      const state = stateRef.current;
      if (!state) return null;
      state.controls.update();
      state.draw();
      return state.renderer.domElement.toDataURL("image/png");
    },
    renderThumbnail,
  }));

  return <div className="ps-viewport" ref={containerRef} />;
});

export default PropViewport;
