import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { TransformControls } from "three/examples/jsm/controls/TransformControls";
import {
  maybeAutoFixYftUpAxis,
  applyLiveryToModel,
  applyTextureToAll,
  loadTextureFromPath,
  loadModelFile,
  disposeObject,
  createFloorGrid,
  normalizeLoadedMeshes,
  setupWasdControls,
  setupWheelWhileDragging,
} from "../lib/viewer-utils";

export default function DualModelViewer({
  modelAPath,
  modelBPath,
  textureAPath,
  textureBPath,
  textureAReloadToken = 0,
  textureBReloadToken = 0,
  bodyColor,
  backgroundColor,
  selectedSlot,
  gizmoVisible = true,
  showGrid = true,
  textureMode = "livery",
  initialPosA,
  initialPosB,
  onSelectSlot,
  onPositionChange,
  onReady,
  onModelAError,
  onModelBError,
  onModelALoading,
  onModelBLoading,
}) {
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const requestRenderRef = useRef(null);

  const modelARef = useRef(null);
  const modelBRef = useRef(null);
  const textureARef = useRef(null);
  const textureBRef = useRef(null);
  const gizmoARef = useRef(null);
  const gizmoBRef = useRef(null);
  const gridRef = useRef(null);
  const fitRef = useRef({ center: new THREE.Vector3(), distance: 6 });

  const [sceneReady, setSceneReady] = useState(false);
  const [modelAVersion, setModelAVersion] = useState(0);
  const [modelBVersion, setModelBVersion] = useState(0);

  const textureLoader = useMemo(() => new THREE.TextureLoader(), []);

  const onReadyRef = useRef(onReady);
  const onModelAErrorRef = useRef(onModelAError);
  const onModelBErrorRef = useRef(onModelBError);
  const onModelALoadingRef = useRef(onModelALoading);
  const onModelBLoadingRef = useRef(onModelBLoading);
  const selectedSlotRef = useRef(selectedSlot);

  const onPositionChangeRef = useRef(onPositionChange);
  const textureModeRef = useRef(textureMode);
  const initialPosARef = useRef(initialPosA);
  const initialPosBRef = useRef(initialPosB);

  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { onModelAErrorRef.current = onModelAError; }, [onModelAError]);
  useEffect(() => { onModelBErrorRef.current = onModelBError; }, [onModelBError]);
  useEffect(() => { onModelALoadingRef.current = onModelALoading; }, [onModelALoading]);
  useEffect(() => { onModelBLoadingRef.current = onModelBLoading; }, [onModelBLoading]);
  useEffect(() => { selectedSlotRef.current = selectedSlot; }, [selectedSlot]);
  useEffect(() => { onPositionChangeRef.current = onPositionChange; }, [onPositionChange]);
  useEffect(() => { textureModeRef.current = textureMode; }, [textureMode]);

  const requestRender = useCallback(() => { requestRenderRef.current?.(); }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const scene = new THREE.Scene();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(new THREE.Color(backgroundColor || "#141414"), 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

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

    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(3.5, 4.5, 2.5);
    const rim = new THREE.DirectionalLight(0xffffff, 0.35);
    rim.position.set(-3, 2, -2.2);
    scene.add(ambient, key, rim);

    renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
    containerRef.current.appendChild(renderer.domElement);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;

    const reportPositions = () => {
      const posA = modelARef.current ? [modelARef.current.position.x, modelARef.current.position.y, modelARef.current.position.z] : [0, 0, 0];
      const posB = modelBRef.current ? [modelBRef.current.position.x, modelBRef.current.position.y, modelBRef.current.position.z] : [0, 0, 3];
      onPositionChangeRef.current?.(posA, posB);
    };

    const gizmoA = new TransformControls(camera, renderer.domElement);
    gizmoA.setMode("translate");
    gizmoA.setSize(0.8);
    gizmoA.addEventListener("dragging-changed", (event) => {
      controls.enabled = !event.value;
      requestRenderRef.current?.();
      if (event.value) onSelectSlot?.("A");
      if (!event.value) reportPositions();
    });
    gizmoA.addEventListener("change", () => requestRenderRef.current?.());
    scene.add(gizmoA.getHelper());
    gizmoARef.current = gizmoA;

    const gizmoB = new TransformControls(camera, renderer.domElement);
    gizmoB.setMode("translate");
    gizmoB.setSize(0.8);
    gizmoB.addEventListener("dragging-changed", (event) => {
      controls.enabled = !event.value;
      requestRenderRef.current?.();
      if (event.value) onSelectSlot?.("B");
      if (!event.value) reportPositions();
    });
    gizmoB.addEventListener("change", () => requestRenderRef.current?.());
    scene.add(gizmoB.getHelper());
    gizmoBRef.current = gizmoB;

    setSceneReady(true);

    let frameId = 0;
    let isRendering = false;
    let renderRequested = false;

    const renderFrame = () => {
      frameId = 0;
      const needsUpdate = controls.update();
      renderer.render(scene, camera);
      if (renderRequested || needsUpdate) {
        renderRequested = false;
        frameId = requestAnimationFrame(renderFrame);
      } else {
        isRendering = false;
      }
    };

    const requestRenderFrame = () => {
      renderRequested = true;
      if (isRendering) return;
      isRendering = true;
      frameId = requestAnimationFrame(renderFrame);
    };
    requestRenderRef.current = requestRenderFrame;

    const resize = () => {
      if (!containerRef.current) return;
      const { clientWidth, clientHeight } = containerRef.current;
      if (clientWidth === 0 || clientHeight === 0) return;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(clientWidth, clientHeight);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      requestRenderFrame();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(containerRef.current);
    resize();

    controls.addEventListener("start", requestRenderFrame);
    controls.addEventListener("change", requestRenderFrame);
    controls.addEventListener("end", requestRenderFrame);
    requestRenderFrame();

    onReadyRef.current?.({
      reset: () => {
        const { center, distance } = fitRef.current;
        camera.position.set(center.x + distance, center.y + distance * 0.2, center.z + distance);
        controls.target.copy(center);
        controls.update();
        requestRenderRef.current?.();
      },
      resetPositions: () => {
        if (modelARef.current) modelARef.current.position.set(0, 0, 0);
        if (modelBRef.current) modelBRef.current.position.set(0, 0, 3);
        requestRenderRef.current?.();
      },
      snapTogether: () => {
        if (!modelARef.current || !modelBRef.current) return;
        const boxA = new THREE.Box3().setFromObject(modelARef.current);
        const sizeA = new THREE.Vector3();
        boxA.getSize(sizeA);
        const centerA = new THREE.Vector3();
        boxA.getCenter(centerA);

        const boxB = new THREE.Box3().setFromObject(modelBRef.current);
        const sizeB = new THREE.Vector3();
        boxB.getSize(sizeB);

        const gap = 0.05;
        const newZ = modelARef.current.position.z + (sizeA.z / 2) + (sizeB.z / 2) + gap;
        modelBRef.current.position.set(modelARef.current.position.x, modelARef.current.position.y, newZ);
        requestRenderRef.current?.();
      },
    });

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      controls.removeEventListener("start", requestRenderFrame);
      controls.removeEventListener("change", requestRenderFrame);
      controls.removeEventListener("end", requestRenderFrame);
      gizmoA.dispose();
      gizmoB.dispose();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.removeEventListener("wheel", wheelWhileDragging);
      renderer.domElement.remove();
      setSceneReady(false);
      requestRenderRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!rendererRef.current) return;
    rendererRef.current.setClearColor(new THREE.Color(backgroundColor || "#141414"), 1);
    requestRender();
  }, [backgroundColor]);

  useEffect(() => {
    if (!sceneReady || !sceneRef.current) return;
    if (showGrid && !gridRef.current) {
      const grid = createFloorGrid();
      sceneRef.current.add(grid);
      gridRef.current = grid;
      requestRender();
    } else if (!showGrid && gridRef.current) {
      sceneRef.current.remove(gridRef.current);
      gridRef.current.geometry?.dispose?.();
      gridRef.current.material?.dispose?.();
      gridRef.current = null;
      requestRender();
    }
  }, [showGrid, sceneReady, requestRender]);

  const wasdStateRef = useRef({ forward: false, back: false, left: false, right: false, up: false, down: false, boost: false });
  const wasdFrameRef = useRef(0);

  useEffect(() => {
    if (!sceneReady || !cameraRef.current || !controlsRef.current) return;
    return setupWasdControls({ wasdStateRef, wasdFrameRef, cameraRef, controlsRef, fitRef, requestRenderRef });
  }, [sceneReady]);

  useEffect(() => {
    if (!sceneReady) return;
    const gA = gizmoARef.current;
    const gB = gizmoBRef.current;
    if (gA) {
      const showA = gizmoVisible && selectedSlot === "A" && Boolean(modelARef.current);
      if (showA && modelARef.current) gA.attach(modelARef.current);
      else gA.detach();
    }
    if (gB) {
      const showB = gizmoVisible && selectedSlot === "B" && Boolean(modelBRef.current);
      if (showB && modelBRef.current) gB.attach(modelBRef.current);
      else gB.detach();
    }
    requestRender();
  }, [selectedSlot, gizmoVisible, sceneReady, modelAVersion, modelBVersion]);

  useEffect(() => {
    if (!sceneReady || !sceneRef.current) return;
    if (!modelAPath) {
      onModelALoadingRef.current?.(false);
      return;
    }
    let cancelled = false;

    (async () => {
      onModelALoadingRef.current?.(true);
      try {
        const object = await loadModelFile(modelAPath);
        if (cancelled) return;
        if (!object) { onModelAErrorRef.current?.("Failed to load model A."); return; }

        normalizeLoadedMeshes(object);

        if (modelARef.current) {
          gizmoARef.current?.detach();
          sceneRef.current.remove(modelARef.current);
          disposeObject(modelARef.current);
        }

        const box = new THREE.Box3().setFromObject(object);
        const size = new THREE.Vector3();
        box.getSize(size);
        if (object.userData.sourceFormat === "yft") {
          maybeAutoFixYftUpAxis(object, size);
        }

        const initA = initialPosARef.current;
        if (initA && Array.isArray(initA) && initA.length === 3) {
          object.position.set(initA[0], initA[1], initA[2]);
        }

        sceneRef.current.add(object);
        modelARef.current = object;
        gizmoARef.current?.attach(object);
        setModelAVersion((v) => v + 1);

        refitCamera();
      } catch (err) {
        if (!cancelled) onModelAErrorRef.current?.(`Model A load failed: ${err?.message || "Unknown error"}`);
      } finally {
        if (!cancelled) onModelALoadingRef.current?.(false);
      }
    })();

    return () => { cancelled = true; };
  }, [modelAPath, sceneReady]);

  useEffect(() => {
    if (!sceneReady || !sceneRef.current) return;
    if (!modelBPath) {
      onModelBLoadingRef.current?.(false);
      return;
    }
    let cancelled = false;

    (async () => {
      onModelBLoadingRef.current?.(true);
      try {
        const object = await loadModelFile(modelBPath);
        if (cancelled) return;
        if (!object) { onModelBErrorRef.current?.("Failed to load model B."); return; }

        normalizeLoadedMeshes(object);

        if (modelBRef.current) {
          gizmoBRef.current?.detach();
          sceneRef.current.remove(modelBRef.current);
          disposeObject(modelBRef.current);
        }

        const box = new THREE.Box3().setFromObject(object);
        const size = new THREE.Vector3();
        box.getSize(size);
        if (object.userData.sourceFormat === "yft") {
          maybeAutoFixYftUpAxis(object, size);
        }

        const initB = initialPosBRef.current;
        if (initB && Array.isArray(initB) && initB.length === 3) {
          object.position.set(initB[0], initB[1], initB[2]);
        } else if (modelARef.current) {
          const boxA = new THREE.Box3().setFromObject(modelARef.current);
          const sizeA = new THREE.Vector3();
          boxA.getSize(sizeA);
          object.position.set(0, 0, sizeA.z / 2 + size.z / 2 + 0.1);
        } else {
          object.position.set(0, 0, 3);
        }

        sceneRef.current.add(object);
        modelBRef.current = object;
        gizmoBRef.current?.attach(object);
        setModelBVersion((v) => v + 1);

        refitCamera();
      } catch (err) {
        if (!cancelled) onModelBErrorRef.current?.(`Model B load failed: ${err?.message || "Unknown error"}`);
      } finally {
        if (!cancelled) onModelBLoadingRef.current?.(false);
      }
    })();

    return () => { cancelled = true; };
  }, [modelBPath, sceneReady]);

  useEffect(() => {
    if (!sceneReady) return;
    let cancelled = false;
    const applyFn = textureMode === "eup" ? applyTextureToAll : applyLiveryToModel;

    (async () => {
      if (!textureAPath) {
        if (textureARef.current) { textureARef.current.dispose?.(); textureARef.current = null; }
        if (modelARef.current) { applyFn(modelARef.current, bodyColor, null); requestRender(); }
        return;
      }
      const tex = await loadTextureFromPath(textureAPath, textureLoader, rendererRef.current);
      if (cancelled) return;
      if (textureARef.current && textureARef.current !== tex) textureARef.current.dispose?.();
      textureARef.current = tex;
      if (modelARef.current) { applyFn(modelARef.current, bodyColor, tex); requestRender(); }
    })();

    return () => { cancelled = true; };
  }, [textureAPath, textureAReloadToken, sceneReady, modelAVersion, textureMode]);

  useEffect(() => {
    if (!sceneReady) return;
    let cancelled = false;
    const applyFn = textureMode === "eup" ? applyTextureToAll : applyLiveryToModel;

    (async () => {
      if (!textureBPath) {
        if (textureBRef.current) { textureBRef.current.dispose?.(); textureBRef.current = null; }
        if (modelBRef.current) { applyFn(modelBRef.current, bodyColor, null); requestRender(); }
        return;
      }
      const tex = await loadTextureFromPath(textureBPath, textureLoader, rendererRef.current);
      if (cancelled) return;
      if (textureBRef.current && textureBRef.current !== tex) textureBRef.current.dispose?.();
      textureBRef.current = tex;
      if (modelBRef.current) { applyFn(modelBRef.current, bodyColor, tex); requestRender(); }
    })();

    return () => { cancelled = true; };
  }, [textureBPath, textureBReloadToken, sceneReady, modelBVersion, textureMode]);

  useEffect(() => {
    if (!sceneReady) return;
    const applyFn = textureMode === "eup" ? applyTextureToAll : applyLiveryToModel;
    if (modelARef.current) applyFn(modelARef.current, bodyColor, textureARef.current);
    if (modelBRef.current) applyFn(modelBRef.current, bodyColor, textureBRef.current);
    requestRender();
  }, [bodyColor, sceneReady, textureMode]);

  const refitCamera = useCallback(() => {
    const objects = [modelARef.current, modelBRef.current].filter(Boolean);
    if (objects.length === 0) return;

    const combinedBox = new THREE.Box3();
    objects.forEach((obj) => combinedBox.expandByObject(obj));
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    combinedBox.getSize(size);
    combinedBox.getCenter(center);

    const maxDim = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(maxDim) || maxDim <= 0) return;
    const distance = Math.max(maxDim * 1.8, 3);
    fitRef.current = { center, distance };

    if (cameraRef.current && controlsRef.current) {
      cameraRef.current.near = Math.max(distance / 100, 0.01);
      cameraRef.current.far = Math.max(distance * 50, 100);
      cameraRef.current.position.set(center.x + distance * 0.6, center.y + distance * 0.3, center.z + distance * 0.8);
      cameraRef.current.updateProjectionMatrix();
      controlsRef.current.target.copy(center);
      controlsRef.current.minDistance = Math.max(distance * 0.05, 0.1);
      controlsRef.current.maxDistance = distance * 10;
      controlsRef.current.update();
    }
    requestRender();
  }, [requestRender]);

  return <div ref={containerRef} className="h-full w-full" />;
}
