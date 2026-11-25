import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { TransformControls } from "three/examples/jsm/controls/TransformControls";
import { createViewerStage } from "../../lib/viewer-stage.js";
import { createCameraGlide } from "../../lib/camera-glide.js";
import { clearNativeTextureCache } from "../../lib/native-materials.js";
import { createMeshStatsReporter } from "../../lib/mesh-stats.js";
import { onViewerControlsChange, previewPixelRatio, readViewerControls } from "../../lib/preview-detail.js";
import { createScaleReference } from "../../lib/prop-scale-ref.js";
import { propAttachmentMatrix, sampleClipPose } from "../../lib/ped-pose.js";
import { propLocalFromBoneMatrix } from "../../lib/prop-attach.js";
import { pickVideoType } from "../../lib/eup-export.js";
import { normalizeRecordingSize, planRecordingFrames } from "../../lib/viewer-recording.js";
import { loadPhotoPed } from "../photo/photo-objects.js";
import {
  GLOW_LAYER,
  applyShadowFlags,
  configureShadowLight,
  createAoPipeline,
  createBloomPipeline,
  createShadowMapCache,
  disposeAoPipeline,
  disposeBloomPipeline,
  renderWithEffects,
  resizeAoPipeline,
  resizeBloomPipeline,
  setAoBounds,
} from "../../lib/viewer-render-effects.js";

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

function unpremultiplyPixelsToCanvas(pixels, width, height, opaqueBackground) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const image = new ImageData(width, height);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y += 1) {
    const src = (height - 1 - y) * rowBytes;
    const dst = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 4) {
      const alpha = pixels[src + x + 3];
      const scale = !opaqueBackground && alpha > 0 && alpha < 255 ? 255 / alpha : 1;
      image.data[dst + x] = Math.min(255, pixels[src + x] * scale);
      image.data[dst + x + 1] = Math.min(255, pixels[src + x + 1] * scale);
      image.data[dst + x + 2] = Math.min(255, pixels[src + x + 2] * scale);
      image.data[dst + x + 3] = alpha;
    }
  }
  canvas.getContext("2d").putImageData(image, 0, 0);
  return canvas;
}

/* Own WebGL renderer on the shared viewer stage (subject "prop"). Renders on
   demand: the frame loop runs only while orbit damping settles or the
   turntable is spinning (`animating`), and never while the tab is hidden.
   Bloom and AO pipelines are created lazily on first use, and shadow maps
   use createShadowMapCache so orbiting never re-renders unchanged shadows. */
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
    scaleRef = "none",
    attach = null,
    attachGizmoMode = "off",
    onAttachStatus = null,
    onAttachTransform = null,
    onPickMaterial = null,
    onCameraDistance = null,
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
  const onPickMaterialRef = useRef(onPickMaterial);
  onPickMaterialRef.current = onPickMaterial;
  const onCameraDistanceRef = useRef(onCameraDistance);
  onCameraDistanceRef.current = onCameraDistance;
  const onAttachStatusRef = useRef(onAttachStatus);
  onAttachStatusRef.current = onAttachStatus;
  const onAttachTransformRef = useRef(onAttachTransform);
  onAttachTransformRef.current = onAttachTransform;
  const attachGizmoRef = useRef(attachGizmoMode);
  attachGizmoRef.current = attachGizmoMode;
  const propRef = useRef(prop);
  propRef.current = prop;
  const meshStatsRef = useRef({ on: showMeshStats, onStats: onMeshStats, reporter: createMeshStatsReporter() });
  meshStatsRef.current.on = showMeshStats;
  meshStatsRef.current.onStats = onMeshStats;
  const hideModelRef = useRef(Boolean(hideModel));
  hideModelRef.current = Boolean(hideModel);
  const bloomWantRef = useRef(Boolean(bloom));
  bloomWantRef.current = Boolean(bloom);
  const aoWantRef = useRef(Boolean(ambientOcclusion));
  aoWantRef.current = Boolean(ambientOcclusion);
  const scaleRefKind = useRef(scaleRef || "none");
  scaleRefKind.current = scaleRef || "none";
  const attachRef = useRef(attach);
  attachRef.current = attach;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    let viewerControls = readViewerControls();
    renderer.setPixelRatio(previewPixelRatio(viewerControls.detail));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(new THREE.Color(backgroundColor || "#141414"), 1);
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const shadowMapCache = createShadowMapCache(renderer);

    const scene = new THREE.Scene();
    scene.onBeforeRender = (_renderer, _scene, _camera, target) => {
      if (!target) shadowMapCache.update(scene);
    };
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
    camera.position.set(0.6, 0.4, 0.8);
    camera.layers.enable(GLOW_LAYER);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minDistance = 0.02;
    controls.zoomToCursor = viewerControls.zoomToCursor;
    controls.maxDistance = 20;
    const cameraGlide = createCameraGlide({ camera, controls });
    const cancelGlide = () => cameraGlide.cancel();

    const ambient = new THREE.AmbientLight(0xffffff, 0.5 * lightIntensity);
    const key = new THREE.DirectionalLight(0xffffff, 0.95 * lightIntensity);
    key.position.set(2.5, 4, 3);
    const rim = new THREE.DirectionalLight(0xffffff, 0.4 * lightIntensity);
    rim.position.set(-3, 2, -2.5);
    scene.add(ambient, key, rim, key.target);

    const stageApi = createViewerStage({ renderer, scene, keyLight: key, subject: "prop", followTone: true });
    stageApi.setBackgroundColor(backgroundColor);

    const gizmo = new TransformControls(camera, renderer.domElement);
    gizmo.setSize(0.75);
    gizmo.setSpace("local");
    const gizmoHelper = gizmo.getHelper();
    gizmoHelper.visible = false;
    scene.add(gizmoHelper);

    container.appendChild(renderer.domElement);
    renderer.domElement.addEventListener("contextmenu", (event) => event.preventDefault());

    const state = {
      renderer,
      scene,
      camera,
      controls,
      cameraGlide,
      gizmo,
      gizmoHelper,
      lights: { ambient, key, rim },
      stage: stageApi,
      shadowMapCache,
      bloom: null,
      ao: null,
      aoBoundsDirty: true,
      viewportWidth: 1,
      viewportHeight: 1,
      frameId: 0,
      lastTime: 0,
      pendingWhileInactive: false,
      disposed: false,
      recording: false,
      attached: null,
      scaleHelper: null,
      ped: null,
      pedGender: "",
      attachSlot: null,
      attachedProp: null,
      lastReportedDist: -1,
      gizmoDragging: false,
    };
    stateRef.current = state;

    const detachAttachedProp = () => {
      state.gizmo.detach();
      state.gizmoHelper.visible = false;
      if (state.attachedProp) {
        const { model, parent } = state.attachedProp;
        if (parent) parent.add(model);
        else model.removeFromParent();
        state.attachedProp = null;
      }
      if (state.attached) state.attached.visible = true;
      if (state.ped) state.ped.holder.visible = false;
    };
    state.detachAttachedProp = detachAttachedProp;

    const ensureBloom = () => {
      if (!state.bloom) {
        state.bloom = createBloomPipeline({
          renderer,
          scene,
          camera,
          width: state.viewportWidth,
          height: state.viewportHeight,
        });
      }
      return state.bloom;
    };

    const ensureAo = () => {
      if (!state.ao) {
        state.ao = createAoPipeline({
          renderer,
          scene,
          camera,
          width: state.viewportWidth,
          height: state.viewportHeight,
        });
      }
      return state.ao;
    };

    const resize = ({ defer = false } = {}) => {
      if (state.recording) return false;
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!width || !height) return false;
      const ratio = renderer.getPixelRatio();
      const unchanged = width === state.viewportWidth && height === state.viewportHeight && ratio === state.lastPixelRatio;
      if (unchanged) {
        if (!defer) {
          if (state.bloom) resizeBloomPipeline(state.bloom, width, height, ratio, { defer: false });
          if (state.ao) resizeAoPipeline(state.ao, width, height, ratio, { defer: false });
          stageApi.resize({ defer: false });
        }
        return false;
      }
      const hadViewport = state.viewportWidth > 0 && state.viewportHeight > 0;
      const ratioChanged = ratio !== state.lastPixelRatio;
      state.viewportWidth = width;
      state.viewportHeight = height;
      state.lastPixelRatio = ratio;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      const opts = defer && hadViewport && !ratioChanged ? { defer: true, onSettled: requestRender } : { defer: false };
      if (state.bloom) resizeBloomPipeline(state.bloom, width, height, ratio, opts);
      if (state.ao) resizeAoPipeline(state.ao, width, height, ratio, opts);
      stageApi.resize(opts);
      return true;
    };
    state.resize = resize;

    const syncShadowFlags = () => {
      const current = propRef.current;
      if (current) applyShadowFlags(current.model, stageApi.castsShadows);
      if (state.ped?.holder) applyShadowFlags(state.ped.holder, stageApi.castsShadows);
      shadowMapCache.invalidate();
    };
    state.syncShadowFlags = syncShadowFlags;

    const reportCameraDistance = () => {
      const callback = onCameraDistanceRef.current;
      const current = propRef.current;
      if (!callback || !current) return;
      const dist = camera.position.distanceTo(controls.target);
      if (state.lastReportedDist < 0 || Math.abs(dist - state.lastReportedDist) / Math.max(0.05, state.lastReportedDist) > 0.03) {
        state.lastReportedDist = dist;
        callback(dist);
      }
    };

    const draw = () => {
      const current = propRef.current;
      const wantBloom = bloomWantRef.current;
      const bloomPipeline = wantBloom ? ensureBloom() : state.bloom;
      if (bloomPipeline) bloomPipeline.enabled = wantBloom;

      const wantAo = aoWantRef.current;
      const aoPipeline = wantAo ? ensureAo() : state.ao;
      if (aoPipeline) {
        aoPipeline.enabled = wantAo;
        if (wantAo && (state.aoBoundsDirty || animatingRef.current)) {
          state.aoBoundsDirty = false;
          setAoBounds(aoPipeline, current?.bounds() || null);
        }
      }

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
      if (state.disposed || state.recording) return;
      state.frameId = 0;
      const animate = animatingRef.current && activeRef.current && !attachRef.current?.enabled;
      if (animate) {
        const dt = state.lastTime ? Math.min((now - state.lastTime) / 1000, 0.1) : 0;
        onAnimateRef.current?.(dt);
        const current = propRef.current;
        if (current) {
          state.stage.setSpin(current.yaw);
          state.shadowMapCache.invalidate();
        }
      }
      state.lastTime = animate ? now : 0;
      const gliding = cameraGlide.step(now);
      const moved = controls.update();
      if (moved || gliding) reportCameraDistance();
      onFrameRef.current?.();
      draw();
      if (moved || gliding || animate) requestRender();
    };

    const requestRender = () => {
      if (state.disposed || state.recording) return;
      if (!activeRef.current) {
        state.pendingWhileInactive = true;
        return;
      }
      if (state.frameId) return;
      state.frameId = requestAnimationFrame(tick);
    };
    state.requestRender = requestRender;

    const renderNow = () => {
      if (state.disposed || state.recording || !activeRef.current) return requestRender();
      if (state.frameId) cancelAnimationFrame(state.frameId);
      tick(performance.now());
    };
    controls.addEventListener("change", requestRender);

    const commitAttachGizmo = () => {
      if (!state.ped || !state.attachSlot || !attachRef.current?.enabled) return;
      const boneTag = attachRef.current.bone ?? 28422;
      const pose = state.ped.clip ? sampleClipPose(state.ped.skeleton, state.ped.clip, state.ped.time) : null;
      const boneMat = propAttachmentMatrix(state.ped.skeleton, pose, {
        bone: boneTag,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
      });
      if (!boneMat) return;
      state.attachSlot.updateMatrix();
      const local = propLocalFromBoneMatrix(boneMat, state.attachSlot.matrix);
      if (local) onAttachTransformRef.current?.(local);
    };

    gizmo.addEventListener("change", () => {
      if (state.gizmoDragging) {
        state.shadowMapCache.invalidate();
        commitAttachGizmo();
      }
      requestRender();
    });
    gizmo.addEventListener("dragging-changed", (event) => {
      state.gizmoDragging = Boolean(event.value);
      controls.enabled = !event.value;
      if (!event.value) commitAttachGizmo();
      requestRender();
    });

    // Click-to-inspect raycast: ignore drags > 4px so orbiting never triggers picks.
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    let downPos = null;
    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      downPos = { x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event) => {
      if (event.button !== 0 || !downPos) return;
      const dist = Math.hypot(event.clientX - downPos.x, event.clientY - downPos.y);
      downPos = null;
      if (dist > 4 || gizmo.dragging || gizmo.axis || !onPickMaterialRef.current || !propRef.current) return;
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pointerNdc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointerNdc, camera);
      const targets = propRef.current.meshes.filter((mesh) => mesh.visible && !mesh.userData?.propHelper);
      const hits = raycaster.intersectObjects(targets, false);
      if (hits.length > 0) {
        const key = hits[0].object?.userData?.materialKey || "";
        if (key) onPickMaterialRef.current(key);
      } else {
        onPickMaterialRef.current("");
      }
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointerdown", cancelGlide, { passive: true });
    renderer.domElement.addEventListener("wheel", cancelGlide, { passive: true });

    const observer = new ResizeObserver(() => {
      if (resize({ defer: true })) renderNow();
      else requestRender();
    });
    observer.observe(container);
    resize({ defer: false });
    requestRender();
    const stopViewerControls = onViewerControlsChange(viewerControls, (next) => {
      viewerControls = next;
      controls.zoomToCursor = next.zoomToCursor;
      renderer.setPixelRatio(previewPixelRatio(next.detail));
      if (resize({ defer: false })) renderNow();
      else requestRender();
    });

    return () => {
      state.disposed = true;
      observer.disconnect();
      stopViewerControls();
      controls.removeEventListener("change", requestRender);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointerdown", cancelGlide);
      renderer.domElement.removeEventListener("wheel", cancelGlide);
      cameraGlide.cancel();
      if (state.frameId) cancelAnimationFrame(state.frameId);
      state.detachAttachedProp();
      state.scaleHelper?.dispose();
      state.scaleHelper = null;
      state.ped?.dispose();
      state.ped = null;
      gizmo.detach();
      gizmo.dispose();
      scene.remove(gizmoHelper);
      controls.dispose();
      if (state.attached) scene.remove(state.attached);
      if (state.bloom) disposeBloomPipeline(state.bloom);
      if (state.ao) disposeAoPipeline(state.ao);
      stageApi.dispose();
      key.shadow.map?.dispose?.();
      clearNativeTextureCache(renderer);
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
    state.aoBoundsDirty = true;
    state.syncShadowFlags();
    state.requestRender();
  }, [prop]);

  // Scale reference ghost beside the prop (off when ped attachment preview is on).
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return undefined;
    state.scaleHelper?.dispose();
    state.scaleHelper = null;
    const showScale = prop && scaleRef && scaleRef !== "none" && !attach?.enabled;
    if (showScale) {
      const helper = createScaleReference(scaleRef, prop.restBounds());
      if (helper) {
        state.scene.add(helper.group);
        state.scaleHelper = helper;
      }
    }
    state.requestRender();
    return () => {
      state.scaleHelper?.dispose();
      state.scaleHelper = null;
    };
  }, [prop, scaleRef, attach?.enabled]);

  // Ped Bone Attachment preview: mount freemode ped + attach prop.model onto bone.
  const attachEnabled = Boolean(attach?.enabled && prop);
  const attachGender = attach?.gender || "male";
  const attachPose = attach?.pose || "idle";
  const attachBone = attach?.bone ?? 28422;
  const attachPosKey = Array.isArray(attach?.position) ? attach.position.join(",") : "0,0,0";
  const attachRotKey = Array.isArray(attach?.rotation) ? attach.rotation.join(",") : "0,0,0";

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return undefined;

    const detachProp = () => state.detachAttachedProp();

    if (!attachEnabled) {
      detachProp();
      state.aoBoundsDirty = true;
      state.syncShadowFlags();
      state.requestRender();
      onAttachStatusRef.current?.({ state: "off", message: "" });
      return undefined;
    }

    const controller = new AbortController();
    (async () => {
      try {
        if (!state.ped || state.pedGender !== attachGender) {
          onAttachStatusRef.current?.({ state: "loading", message: "Loading freemode ped…" });
          if (state.ped) {
            detachProp();
            state.ped.dispose();
            state.ped = null;
            state.attachSlot = null;
            state.pedGender = "";
          }
          const ped = await loadPhotoPed({
            look: { gender: attachGender, body: "a", outfit: "street" },
            renderer: state.renderer,
            signal: controller.signal,
            onStatus: (message) => onAttachStatusRef.current?.({ state: "loading", message }),
          });
          if (controller.signal.aborted || state.disposed) {
            ped.dispose();
            return;
          }
          state.scene.add(ped.holder);
          const slot = new THREE.Group();
          slot.name = "prop-attach-slot";
          slot.userData.heldProp = true;
          ped.root.add(slot);
          state.ped = ped;
          state.pedGender = attachGender;
          state.attachSlot = slot;
        }

        if (controller.signal.aborted || state.disposed) return;
        state.ped.holder.visible = true;
        onAttachStatusRef.current?.({ state: "loading", message: "Posing ped…" });
        await state.ped.setPose({ gender: attachGender, pose: attachPose, time: 0 }, controller.signal).catch(() => null);
        if (controller.signal.aborted || state.disposed) return;

        // Attach prop.model to the ped's bone slot and hide the standalone turntable root.
        const current = propRef.current;
        if (current && state.attachSlot) {
          detachProp();
          state.ped.holder.visible = true;
          state.attachSlot.add(current.model);
          state.attachedProp = { model: current.model, parent: current.gta };
          if (state.attached) state.attached.visible = false;
          const pose = state.ped.clip ? sampleClipPose(state.ped.skeleton, state.ped.clip, state.ped.time) : null;
          const currentAttach = attachRef.current || {};
          const mat = propAttachmentMatrix(state.ped.skeleton, pose, {
            bone: currentAttach.bone ?? 28422,
            position: currentAttach.position || [0, 0, 0],
            rotation: currentAttach.rotation || [0, 0, 0],
          });
          if (mat) {
            mat.decompose(state.attachSlot.position, state.attachSlot.quaternion, state.attachSlot.scale);
            state.attachSlot.updateMatrix();
          }
          if (attachGizmoRef.current === "translate" || attachGizmoRef.current === "rotate") {
            state.gizmo.setMode(attachGizmoRef.current);
            state.gizmo.attach(state.attachSlot);
            state.gizmoHelper.visible = true;
          }
          state.ped.holder.updateMatrixWorld(true);
          const pedBox = new THREE.Box3().setFromObject(state.ped.holder);
          if (!pedBox.isEmpty()) {
            state.stage.fit(pedBox.clone().expandByScalar(0.1), [state.ped.holder]);
            state.stage.constrainControls(state.controls);
            const sphere = pedBox.getBoundingSphere(new THREE.Sphere());
            const dist = (sphere.radius * 1.25) / Math.sin(THREE.MathUtils.degToRad(FOV) / 2);
            state.camera.position.copy(sphere.center).addScaledVector(PRESET_DIRECTIONS.angle, dist);
            state.camera.near = Math.max(0.01, dist * 0.01);
            state.camera.far = Math.max(dist * 30, 30);
            state.camera.updateProjectionMatrix();
            state.controls.target.copy(sphere.center);
            state.controls.maxDistance = Math.max(dist * 6, 12);
            state.controls.update();
          }
        }
        state.aoBoundsDirty = true;
        state.syncShadowFlags();
        state.requestRender();
        onAttachStatusRef.current?.({ state: "ready", message: "" });
      } catch (error) {
        if (error?.name === "AbortError" || controller.signal.aborted) return;
        detachProp();
        onAttachStatusRef.current?.({ state: "error", message: error?.message || String(error) });
      }
    })();

    return () => {
      controller.abort();
      detachProp();
    };
  }, [attachEnabled, attachGender, attachPose, prop]);

  // Instant bone/offset/rotation updates without reloading the ped!
  useEffect(() => {
    const state = stateRef.current;
    if (!state || !attachEnabled || !state.ped || !state.attachSlot || state.gizmoDragging) return;
    const pose = state.ped.clip ? sampleClipPose(state.ped.skeleton, state.ped.clip, state.ped.time) : null;
    const mat = propAttachmentMatrix(state.ped.skeleton, pose, {
      bone: attachBone,
      position: attach?.position || [0, 0, 0],
      rotation: attach?.rotation || [0, 0, 0],
    });
    if (mat) {
      mat.decompose(state.attachSlot.position, state.attachSlot.quaternion, state.attachSlot.scale);
      state.attachSlot.updateMatrix();
      state.ped.holder.updateMatrixWorld(true);
    }
    state.shadowMapCache.invalidate();
    state.requestRender();
  }, [attachEnabled, attachBone, attachPosKey, attachRotKey, attach?.position, attach?.rotation]);

  // Toggle 3D Move/Rotate TransformControls gizmo on the attached prop.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const show = attachEnabled && state.attachSlot && (attachGizmoMode === "translate" || attachGizmoMode === "rotate");
    if (show) {
      state.gizmo.setMode(attachGizmoMode);
      state.gizmo.attach(state.attachSlot);
      state.gizmoHelper.visible = true;
    } else {
      state.gizmo.detach();
      state.gizmoHelper.visible = false;
    }
    state.requestRender();
  }, [attachEnabled, attachGizmoMode, prop]);

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
    state.syncShadowFlags();
    state.requestRender();
  }, [stage, showGrid, showShadows, lightIntensity, dark]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state || !showroom) return;
    state.stage.setShowroom(showroom);
    state.shadowMapCache.invalidate();
    state.requestRender();
  }, [showroom]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    if (state.bloom) state.bloom.enabled = Boolean(bloom);
    if (state.ao) state.ao.enabled = Boolean(ambientOcclusion);
    state.aoBoundsDirty = true;
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
    state.shadowMapCache.invalidate();
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
    if (attachRef.current?.enabled && state.ped?.holder) {
      const box = new THREE.Box3().setFromObject(state.ped.holder);
      if (!box.isEmpty()) state.stage.fit(box.clone().expandByScalar(0.1), [state.ped.holder]);
      state.stage.constrainControls(state.controls);
      state.syncShadowFlags();
      state.requestRender();
      return;
    }
    const bounds = current.restBounds();
    if (!bounds) return;
    state.scaleHelper?.reposition(bounds);
    state.stage.fit(bounds.clone().expandByScalar(Math.max(0.01, bounds.getSize(new THREE.Vector3()).length() * 0.05)), [current.model]);
    state.stage.constrainControls(state.controls);
    state.aoBoundsDirty = true;
    state.syncShadowFlags();
    state.requestRender();
  };

  const frame = (presetKey = "angle", { instant = false } = {}) => {
    const state = stateRef.current;
    const current = propRef.current;
    if (!state || !current) return;
    const bounds = attachRef.current?.enabled && state.ped?.holder
      ? new THREE.Box3().setFromObject(state.ped.holder)
      : current.restBounds();
    if (!bounds || bounds.isEmpty()) return;
    const { camera, controls } = state;
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.01);
    const aspect = camera.aspect > 0 ? camera.aspect : 1;
    const vertical = THREE.MathUtils.degToRad(FOV);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
    const limiting = Math.max(Math.min(vertical, horizontal), THREE.MathUtils.degToRad(10));
    const distance = (radius * FIT_PADDING) / Math.sin(limiting / 2);
    const direction = PRESET_DIRECTIONS[presetKey] || PRESET_DIRECTIONS.angle;

    controls.minDistance = Math.max(radius * 0.15, 0.005);
    controls.maxDistance = Math.max(distance * 8, 1);
    refit();
    state.cameraGlide.to({
      position: sphere.center.clone().addScaledVector(direction, distance),
      target: sphere.center,
      near: Math.max(0.0005, distance * 0.01),
      far: Math.max(distance * 40, 10),
      instant,
    });
    state.lastReportedDist = -1;
    state.requestRender();
  };

  // Renders the prop alone into an offscreen target and returns an HTMLCanvasElement.
  const renderAngleCanvas = ({ size = 512, width = size, height = size, angle = "camera", padding = 0.08, background = null } = {}) => {
    const state = stateRef.current;
    const current = propRef.current;
    if (!state || !current) throw new Error("The viewfinder isn't ready yet.");
    const { renderer, lights, scene: mainScene } = state;

    // If prop.model is currently reparented on the ped, temporarily put it back for clean prop-only capture.
    const wasOnPed = Boolean(state.attachedProp && state.attachedProp.model === current.model);
    if (wasOnPed) {
      current.gta.add(current.model);
      current.root.visible = true;
    }

    const bounds = current.bounds();
    if (!bounds) {
      if (wasOnPed && state.attachSlot) {
        state.attachSlot.add(current.model);
        current.root.visible = false;
      }
      throw new Error("The prop has no visible geometry.");
    }

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
    const aspect = width / Math.max(1, height);
    const camera = new THREE.PerspectiveCamera(THUMBNAIL_FOV, aspect, Math.max(distance * 0.01, 0.0005), distance * 6);
    camera.layers.enable(GLOW_LAYER);
    const direction = angle === "camera"
      ? state.camera.position.clone().sub(state.controls.target).normalize()
      : (PRESET_DIRECTIONS[angle] || PRESET_DIRECTIONS.angle).clone();
    camera.position.copy(sphere.center).addScaledVector(direction, distance);
    camera.up.set(0, 1, 0);
    camera.lookAt(sphere.center);
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

    const target = new THREE.WebGLRenderTarget(width, height, { samples: 4, colorSpace: THREE.SRGBColorSpace });
    const previousTarget = renderer.getRenderTarget();
    const previousColor = renderer.getClearColor(new THREE.Color());
    const previousAlpha = renderer.getClearAlpha();
    const pixels = new Uint8Array(width * height * 4);
    try {
      renderer.setRenderTarget(target);
      if (background) renderer.setClearColor(new THREE.Color(background), 1);
      else renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(thumbScene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(previousColor, previousAlpha);
      target.dispose();
      if (parent) parent.add(root);
      else thumbScene.remove(root);
      restoreHelpers();
      if (wasOnPed && state.attachSlot) {
        state.attachSlot.add(current.model);
        current.root.visible = false;
      }
      state.requestRender();
    }

    return unpremultiplyPixelsToCanvas(pixels, width, height, Boolean(background));
  };

  // Renders the prop alone into an offscreen target and returns PNG bytes.
  const renderThumbnail = async (options = {}) => {
    const canvas = renderAngleCanvas(options);
    return canvasToPngBytes(canvas);
  };

  // Records a 30 fps 360° turntable video directly from the live viewport.
  const recordTurntableVideo = async ({ width = 1080, height = 1080, seconds = 6, fps = 30, signal, onProgress } = {}) => {
    const state = stateRef.current;
    const current = propRef.current;
    if (!state || !current) throw new Error("The viewfinder isn't ready yet.");
    if (typeof MediaRecorder === "undefined" || typeof HTMLCanvasElement.prototype.captureStream !== "function") {
      throw new Error("Video recording isn't supported in this runtime.");
    }
    const format = pickVideoType((type) => MediaRecorder.isTypeSupported(type));
    if (!format) throw new Error("No supported video encoder is available.");
    const size = normalizeRecordingSize(width, height);
    if (!size) throw new Error("Invalid recording dimensions.");

    const { renderer, camera } = state;
    const plan = planRecordingFrames({ fps, seconds, startYaw: current.yaw, turns: 1, spin: true });
    const prevYaw = current.yaw;
    const prevRatio = renderer.getPixelRatio();
    const prevSize = renderer.getSize(new THREE.Vector2());
    const prevAspect = camera.aspect;
    const restoreHelpers = current.hideHelpers();
    const prevScaleVisible = state.scaleHelper ? state.scaleHelper.group.visible : false;
    if (state.scaleHelper) state.scaleHelper.group.visible = false;
    const prevGizmoVisible = state.gizmoHelper.visible;
    state.gizmoHelper.visible = false;

    state.cameraGlide.cancel();
    state.recording = true;
    if (state.frameId) {
      cancelAnimationFrame(state.frameId);
      state.frameId = 0;
    }

    const chunks = [];
    let recorderError = null;
    try {
      renderer.setPixelRatio(1);
      renderer.setSize(size.width, size.height, false);
      camera.aspect = size.width / size.height;
      camera.updateProjectionMatrix();
      if (state.bloom) resizeBloomPipeline(state.bloom, size.width, size.height, 1);
      if (state.ao) resizeAoPipeline(state.ao, size.width, size.height, 1);
      state.stage.resize();

      const stream = renderer.domElement.captureStream(0);
      const track = stream.getVideoTracks()[0];
      const recorder = new MediaRecorder(stream, {
        mimeType: format.mimeType,
        videoBitsPerSecond: Math.round(size.width * size.height * plan.fps * 0.25),
      });
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunks.push(event.data);
      };
      recorder.onerror = (event) => {
        recorderError = event.error || new Error("Video recorder failed.");
      };
      const stopped = new Promise((resolve) => {
        recorder.onstop = resolve;
      });
      recorder.start(250);

      try {
        for (let i = 0; i < plan.count; i += 1) {
          if (signal?.aborted || recorderError) break;
          current.setYaw(plan.yawAt(i));
          state.stage.setSpin(plan.yawAt(i));
          state.shadowMapCache.invalidate();
          onFrameRef.current?.();
          state.draw();
          track?.requestFrame?.();
          onProgress?.({ current: i + 1, total: plan.count });
          await new Promise((resolve) => setTimeout(resolve, Math.max(8, Math.round(plan.intervalMs))));
        }
      } finally {
        if (recorder.state !== "inactive") recorder.stop();
        await stopped;
        stream.getTracks().forEach((t) => t.stop());
      }
      if (signal?.aborted) {
        const err = new Error("Turntable recording cancelled.");
        err.name = "AbortError";
        throw err;
      }
      if (recorderError) throw recorderError;
      const blob = new Blob(chunks, { type: format.mimeType });
      if (!blob.size) throw new Error("The video recorder produced no data.");
      return { bytes: new Uint8Array(await blob.arrayBuffer()), extension: format.extension, mimeType: format.mimeType };
    } finally {
      state.recording = false;
      if (state.disposed) return;
      current.setYaw(prevYaw);
      state.stage.setSpin(prevYaw);
      restoreHelpers();
      if (state.scaleHelper) state.scaleHelper.group.visible = prevScaleVisible;
      state.gizmoHelper.visible = prevGizmoVisible;
      renderer.setPixelRatio(prevRatio);
      camera.aspect = prevAspect;
      camera.updateProjectionMatrix();
      if (!state.resize({ defer: false })) {
        renderer.setSize(prevSize.x, prevSize.y, false);
        if (state.bloom) resizeBloomPipeline(state.bloom, prevSize.x, prevSize.y, prevRatio, { defer: false });
        if (state.ao) resizeAoPipeline(state.ao, prevSize.x, prevSize.y, prevRatio, { defer: false });
        state.stage.resize({ defer: false });
      }
      state.shadowMapCache.invalidate();
      state.requestRender();
    }
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
      state.resize?.({ defer: false });
      state.controls.update();
      state.draw();
      return state.renderer.domElement.toDataURL("image/png");
    },
    renderThumbnail,
    renderAngleCanvas,
    recordTurntableVideo,
  }));

  return <div className="ps-viewport" ref={containerRef} />;
});

export default PropViewport;
