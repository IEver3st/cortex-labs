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
  windowTextureAPath,
  windowTextureBPath,
  windowTextureATarget = "auto",
  windowTextureBTarget = "auto",
  textureAReloadToken = 0,
  textureBReloadToken = 0,
  windowTextureAReloadToken = 0,
  windowTextureBReloadToken = 0,
  bodyColorA,
  bodyColorB,
  backgroundColor,
  backgroundImagePath = "",
  backgroundImageReloadToken = 0,
  backgroundImageBlur = 0,
  lightIntensity = 1.0,
  glossiness = 0.5,
  showWireframe = false,
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
  onModelAInfo,
  onModelBInfo,
  onFormatWarning,
  isActive = true,
}) {
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const requestRenderRef = useRef(null);
  const lightsRef = useRef({ ambient: null, key: null, rim: null });

  const modelARef = useRef(null);
  const modelBRef = useRef(null);
  const textureARef = useRef(null);
  const textureBRef = useRef(null);
  const textureAStateRef = useRef({ path: "", reloadToken: -1 });
  const textureBStateRef = useRef({ path: "", reloadToken: -1 });
  const windowTextureARef = useRef(null);
  const windowTextureBRef = useRef(null);
  const backgroundTextureRef = useRef(null);
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
  const onModelAInfoRef = useRef(onModelAInfo);
  const onModelBInfoRef = useRef(onModelBInfo);
  const onFormatWarningRef = useRef(onFormatWarning);
  const selectedSlotRef = useRef(selectedSlot);

  const onPositionChangeRef = useRef(onPositionChange);
  const textureModeRef = useRef(textureMode);
  const initialPosARef = useRef(initialPosA);
  const initialPosBRef = useRef(initialPosB);
  const glossinessRef = useRef(glossiness);
  const showWireframeRef = useRef(showWireframe);
  const isActiveRef = useRef(isActive);

  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { onModelAErrorRef.current = onModelAError; }, [onModelAError]);
  useEffect(() => { onModelBErrorRef.current = onModelBError; }, [onModelBError]);
  useEffect(() => { onModelALoadingRef.current = onModelALoading; }, [onModelALoading]);
  useEffect(() => { onModelBLoadingRef.current = onModelBLoading; }, [onModelBLoading]);
  useEffect(() => { onModelAInfoRef.current = onModelAInfo; }, [onModelAInfo]);
  useEffect(() => { onModelBInfoRef.current = onModelBInfo; }, [onModelBInfo]);
  useEffect(() => { onFormatWarningRef.current = onFormatWarning; }, [onFormatWarning]);
  useEffect(() => { selectedSlotRef.current = selectedSlot; }, [selectedSlot]);
  useEffect(() => { onPositionChangeRef.current = onPositionChange; }, [onPositionChange]);
  useEffect(() => { textureModeRef.current = textureMode; }, [textureMode]);
  useEffect(() => { glossinessRef.current = glossiness; }, [glossiness]);
  useEffect(() => { showWireframeRef.current = showWireframe; }, [showWireframe]);
  useEffect(() => {
    isActiveRef.current = isActive;
    if (isActive) requestRenderRef.current?.();
  }, [isActive]);

  const requestRender = useCallback(() => { requestRenderRef.current?.(); }, []);

  const applyGlossinessToObject = useCallback((object, nextGlossiness = glossinessRef.current) => {
    if (!object) return;
    const glossFactor = 2 - 2 * nextGlossiness;
    const meshes = getMeshList(object);

    for (const child of meshes) {
      if (!child.material) continue;
      const materials = Array.isArray(child.material) ? child.material : [child.material];

      materials.forEach((material) => {
        if (!material) return;
        const baseFromData = material.userData?.baseRoughness;
        const fallbackBase = typeof material.roughness === "number" ? material.roughness : null;
        const baseRoughness = typeof baseFromData === "number" ? baseFromData : fallbackBase;

        if (typeof baseFromData !== "number" && typeof fallbackBase === "number") {
          material.userData = material.userData || {};
          material.userData.baseRoughness = fallbackBase;
        }

        if (typeof baseRoughness === "number") {
          material.roughness = Math.min(1.0, Math.max(0.0, baseRoughness * glossFactor));
        }
        const nextWireframe = Boolean(showWireframeRef.current);
        if (material.wireframe !== nextWireframe) {
          material.wireframe = nextWireframe;
          material.needsUpdate = true;
        }
      });
    }
  }, []);

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

    const ambient = new THREE.AmbientLight(0xffffff, 0.5 * lightIntensity);
    const key = new THREE.DirectionalLight(0xffffff, 0.9 * lightIntensity);
    key.position.set(3.5, 4.5, 2.5);
    const rim = new THREE.DirectionalLight(0xffffff, 0.35 * lightIntensity);
    rim.position.set(-3, 2, -2.2);
    lightsRef.current = { ambient, key, rim };
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
    const canRenderFrame = () => {
      if (!isActiveRef.current) return false;
      const container = containerRef.current;
      return Boolean(container && container.clientWidth > 0 && container.clientHeight > 0);
    };

    const renderFrame = () => {
      frameId = 0;
      if (!canRenderFrame()) {
        isRendering = false;
        return;
      }
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
      if (!canRenderFrame()) return;
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
      if (scene.background === backgroundTextureRef.current) {
        scene.background = null;
      }
      backgroundTextureRef.current?.dispose?.();
      backgroundTextureRef.current = null;
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
    if (!sceneRef.current || !rendererRef.current) return;
    let cancelled = false;

    const clearBackground = () => {
      if (sceneRef.current?.background === backgroundTextureRef.current) {
        sceneRef.current.background = null;
      }
      backgroundTextureRef.current?.dispose?.();
      backgroundTextureRef.current = null;
      requestRender();
    };

    if (!backgroundImagePath) {
      clearBackground();
      return;
    }

    const loadBackground = async () => {
      let texture = null;
      try {
        texture = await loadTextureFromPath(backgroundImagePath, textureLoader, rendererRef.current);
      } catch {
        texture = null;
      }
      if (!texture) {
        clearBackground();
        return;
      }
      if (cancelled) {
        texture.dispose?.();
        return;
      }

      const previous = backgroundTextureRef.current;
      texture.mapping = THREE.UVMapping;

      // Apply blur via offscreen canvas if requested
      let finalTexture = texture;
      if (backgroundImageBlur > 0) {
        const img = texture.image;
        const isBlurrable = img && (
          img instanceof HTMLImageElement ||
          img instanceof HTMLCanvasElement ||
          img instanceof ImageBitmap
        );
        if (isBlurrable) {
          const w = img.naturalWidth || img.width || img.videoWidth || 512;
          const h = img.naturalHeight || img.height || img.videoHeight || 512;
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          const pad = backgroundImageBlur * 2;
          ctx.filter = `blur(${backgroundImageBlur}px)`;
          ctx.drawImage(img, -pad, -pad, w + pad * 2, h + pad * 2);
          const blurredTexture = new THREE.CanvasTexture(canvas);
          blurredTexture.colorSpace = THREE.SRGBColorSpace;
          blurredTexture.wrapS = THREE.RepeatWrapping;
          blurredTexture.wrapT = THREE.RepeatWrapping;
          texture.dispose();
          finalTexture = blurredTexture;
        }
      }

      backgroundTextureRef.current = finalTexture;
      sceneRef.current.background = finalTexture;
      if (previous && previous !== finalTexture) {
        previous.dispose?.();
      }
      requestRender();
    };

    loadBackground();

    return () => {
      cancelled = true;
    };
  }, [backgroundImagePath, backgroundImageReloadToken, backgroundImageBlur, textureLoader, requestRender]);

  useEffect(() => {
    const { ambient, key, rim } = lightsRef.current;
    if (ambient) ambient.intensity = 0.5 * lightIntensity;
    if (key) key.intensity = 0.9 * lightIntensity;
    if (rim) rim.intensity = 0.35 * lightIntensity;
    requestRender();
  }, [lightIntensity, requestRender]);

  useEffect(() => {
    if (!sceneReady) return;
    applyGlossinessToObject(modelARef.current);
    applyGlossinessToObject(modelBRef.current);
    requestRender();
  }, [sceneReady, glossiness, applyGlossinessToObject, requestRender]);

  useEffect(() => {
    if (!sceneReady) return;
    applyGlossinessToObject(modelARef.current);
    applyGlossinessToObject(modelBRef.current);
    requestRender();
  }, [sceneReady, showWireframe, applyGlossinessToObject, requestRender]);

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
      if (modelARef.current) {
        gizmoARef.current?.detach();
        sceneRef.current.remove(modelARef.current);
        disposeObject(modelARef.current);
        modelARef.current = null;
        setModelAVersion((v) => v + 1);
        refitCamera();
        requestRender();
      }
      onModelAInfoRef.current?.({ targets: [], windowTarget: "", windowLabel: "" });
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
        const targets = collectTextureTargets(object);
        const windowTarget = findWindowTemplateTarget(object);
        onModelAInfoRef.current?.({
          targets,
          windowTarget: windowTarget?.value || "",
          windowLabel: windowTarget?.label || "",
        });

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

        applyGlossinessToObject(object);

        sceneRef.current.add(object);
        modelARef.current = object;
        gizmoARef.current?.attach(object);
        setModelAVersion((v) => v + 1);

        refitCamera();
      } catch (err) {
        onModelAInfoRef.current?.({ targets: [], windowTarget: "", windowLabel: "" });
        if (!cancelled) onModelAErrorRef.current?.(`Model A load failed: ${err?.message || "Unknown error"}`);
      } finally {
        if (!cancelled) onModelALoadingRef.current?.(false);
      }
    })();

    return () => { cancelled = true; };
  }, [modelAPath, sceneReady, applyGlossinessToObject]);

  useEffect(() => {
    if (!sceneReady || !sceneRef.current) return;
    if (!modelBPath) {
      if (modelBRef.current) {
        gizmoBRef.current?.detach();
        sceneRef.current.remove(modelBRef.current);
        disposeObject(modelBRef.current);
        modelBRef.current = null;
        setModelBVersion((v) => v + 1);
        refitCamera();
        requestRender();
      }
      onModelBInfoRef.current?.({ targets: [], windowTarget: "", windowLabel: "" });
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
        const targets = collectTextureTargets(object);
        const windowTarget = findWindowTemplateTarget(object);
        onModelBInfoRef.current?.({
          targets,
          windowTarget: windowTarget?.value || "",
          windowLabel: windowTarget?.label || "",
        });

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

        applyGlossinessToObject(object);

        sceneRef.current.add(object);
        modelBRef.current = object;
        gizmoBRef.current?.attach(object);
        setModelBVersion((v) => v + 1);

        refitCamera();
      } catch (err) {
        onModelBInfoRef.current?.({ targets: [], windowTarget: "", windowLabel: "" });
        if (!cancelled) onModelBErrorRef.current?.(`Model B load failed: ${err?.message || "Unknown error"}`);
      } finally {
        if (!cancelled) onModelBLoadingRef.current?.(false);
      }
    })();

    return () => { cancelled = true; };
  }, [modelBPath, sceneReady, applyGlossinessToObject]);

  useEffect(() => {
    if (!sceneReady) return;
    let cancelled = false;
    const applyFn = textureMode === "eup" ? applyTextureToAll : applyLiveryToModel;

    (async () => {
      if (!textureAPath) {
        textureAStateRef.current = { path: "", reloadToken: -1 };
        if (textureARef.current) { textureARef.current.dispose?.(); textureARef.current = null; }
        if (modelARef.current) {
          applyFn(modelARef.current, bodyColorA, null);
          applyGlossinessToObject(modelARef.current);
          requestRender();
        }
        return;
      }

      if (
        textureARef.current &&
        textureAStateRef.current.path === textureAPath &&
        textureAStateRef.current.reloadToken === textureAReloadToken
      ) {
        if (modelARef.current) {
          applyFn(modelARef.current, bodyColorA, textureARef.current);
          applyGlossinessToObject(modelARef.current);
          requestRender();
        }
        return;
      }

      try {
        const tex = await loadTextureFromPath(textureAPath, textureLoader, rendererRef.current);
        if (cancelled) return;
        if (textureARef.current && textureARef.current !== tex) textureARef.current.dispose?.();
        textureARef.current = tex;
        textureAStateRef.current = { path: textureAPath, reloadToken: textureAReloadToken };
        if (modelARef.current) {
          applyFn(modelARef.current, bodyColorA, tex);
          applyGlossinessToObject(modelARef.current);
          requestRender();
        }
      } catch (err) {
        if (err?.type === "unsupported-bit-depth") {
          onFormatWarningRef.current?.({ type: "16bit-psd", bitDepth: err.bitDepth, path: textureAPath, slot: "A", kind: "primary" });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [textureAPath, textureAReloadToken, sceneReady, modelAVersion, textureMode, bodyColorA, applyGlossinessToObject]);

  useEffect(() => {
    if (!sceneReady) return;
    let cancelled = false;
    const applyFn = textureMode === "eup" ? applyTextureToAll : applyLiveryToModel;

    (async () => {
      if (!textureBPath) {
        textureBStateRef.current = { path: "", reloadToken: -1 };
        if (textureBRef.current) { textureBRef.current.dispose?.(); textureBRef.current = null; }
        if (modelBRef.current) {
          applyFn(modelBRef.current, bodyColorB, null);
          applyGlossinessToObject(modelBRef.current);
          requestRender();
        }
        return;
      }

      if (
        textureBRef.current &&
        textureBStateRef.current.path === textureBPath &&
        textureBStateRef.current.reloadToken === textureBReloadToken
      ) {
        if (modelBRef.current) {
          applyFn(modelBRef.current, bodyColorB, textureBRef.current);
          applyGlossinessToObject(modelBRef.current);
          requestRender();
        }
        return;
      }

      try {
        const tex = await loadTextureFromPath(textureBPath, textureLoader, rendererRef.current);
        if (cancelled) return;
        if (textureBRef.current && textureBRef.current !== tex) textureBRef.current.dispose?.();
        textureBRef.current = tex;
        textureBStateRef.current = { path: textureBPath, reloadToken: textureBReloadToken };
        if (modelBRef.current) {
          applyFn(modelBRef.current, bodyColorB, tex);
          applyGlossinessToObject(modelBRef.current);
          requestRender();
        }
      } catch (err) {
        if (err?.type === "unsupported-bit-depth") {
          onFormatWarningRef.current?.({ type: "16bit-psd", bitDepth: err.bitDepth, path: textureBPath, slot: "B", kind: "primary" });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [textureBPath, textureBReloadToken, sceneReady, modelBVersion, textureMode, bodyColorB, applyGlossinessToObject]);

  useEffect(() => {
    if (!sceneReady) return;
    let cancelled = false;

    (async () => {
      if (textureMode !== "livery" || !windowTextureAPath) {
        if (windowTextureARef.current) { windowTextureARef.current.dispose?.(); windowTextureARef.current = null; }
        if (modelARef.current) {
          applyWindowDesignToModel(modelARef.current, null, windowTextureATarget);
          applyGlossinessToObject(modelARef.current);
          requestRender();
        }
        return;
      }

      try {
        const tex = await loadTextureFromPath(windowTextureAPath, textureLoader, rendererRef.current);
        if (cancelled) return;
        if (windowTextureARef.current && windowTextureARef.current !== tex) windowTextureARef.current.dispose?.();
        windowTextureARef.current = tex;
        if (modelARef.current) {
          applyWindowDesignToModel(modelARef.current, tex, windowTextureATarget);
          applyGlossinessToObject(modelARef.current);
          requestRender();
        }
      } catch (err) {
        if (err?.type === "unsupported-bit-depth") {
          onFormatWarningRef.current?.({ type: "16bit-psd", bitDepth: err.bitDepth, path: windowTextureAPath, slot: "A", kind: "window" });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [windowTextureAPath, windowTextureAReloadToken, windowTextureATarget, sceneReady, modelAVersion, textureMode, applyGlossinessToObject]);

  useEffect(() => {
    if (!sceneReady) return;
    let cancelled = false;

    (async () => {
      if (textureMode !== "livery" || !windowTextureBPath) {
        if (windowTextureBRef.current) { windowTextureBRef.current.dispose?.(); windowTextureBRef.current = null; }
        if (modelBRef.current) {
          applyWindowDesignToModel(modelBRef.current, null, windowTextureBTarget);
          applyGlossinessToObject(modelBRef.current);
          requestRender();
        }
        return;
      }

      try {
        const tex = await loadTextureFromPath(windowTextureBPath, textureLoader, rendererRef.current);
        if (cancelled) return;
        if (windowTextureBRef.current && windowTextureBRef.current !== tex) windowTextureBRef.current.dispose?.();
        windowTextureBRef.current = tex;
        if (modelBRef.current) {
          applyWindowDesignToModel(modelBRef.current, tex, windowTextureBTarget);
          applyGlossinessToObject(modelBRef.current);
          requestRender();
        }
      } catch (err) {
        if (err?.type === "unsupported-bit-depth") {
          onFormatWarningRef.current?.({ type: "16bit-psd", bitDepth: err.bitDepth, path: windowTextureBPath, slot: "B", kind: "window" });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [windowTextureBPath, windowTextureBReloadToken, windowTextureBTarget, sceneReady, modelBVersion, textureMode, applyGlossinessToObject]);

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

    const matchesWindow = matchesWindowTarget(child, resolvedTarget);
    const shouldApply = Boolean(texture) && matchesWindow;

    if (!shouldApply) {
      if (child.userData.windowMaterial && child.material === child.userData.windowMaterial) {
        child.material = child.userData.baseMaterial;
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
      material.name = baseMaterial?.name || "";
      child.userData.windowMaterial = material;
    } else if (child.userData.windowMaterial.map !== texture) {
      child.userData.windowMaterial.map = texture;
      child.userData.windowMaterial.needsUpdate = true;
    }

    if (child.material !== child.userData.windowMaterial) {
      child.material = child.userData.windowMaterial;
    }
  });
}

function matchesWindowTarget(mesh, target) {
  if (target === NONE_TARGET) return false;
  if (!target || target === "auto") return isWindowMesh(mesh);
  if (target === ALL_TARGET) return true;

  const baseMaterial = mesh.userData?.baseMaterial || mesh.material;
  if (target.startsWith(MATERIAL_TARGET_PREFIX)) {
    const requestedName = target.slice(MATERIAL_TARGET_PREFIX.length);
    return getMaterialNames(baseMaterial).some((name) => name === requestedName);
  }

  if (target.startsWith(MESH_TARGET_PREFIX)) {
    const requestedMesh = target.slice(MESH_TARGET_PREFIX.length);
    return ensureMeshLabel(mesh) === requestedMesh;
  }

  return isWindowMesh(mesh);
}

function isWindowMesh(mesh) {
  const baseMaterial = mesh.userData?.baseMaterial || mesh.material;
  const materialNames = getMaterialNames(baseMaterial).map((name) => name.toLowerCase());
  const materialName = materialNames.join(" ");
  const meshName = (mesh.name || "").toLowerCase();
  const target = `${materialName} ${meshName}`;

  return (
    target.includes("window") ||
    target.includes("glass") ||
    target.includes("vehglass") ||
    target.includes("sign_2") ||
    target.includes("sign-2") ||
    target.includes("sign2") ||
    target.includes("sign_3") ||
    target.includes("sign-3") ||
    target.includes("sign3")
  );
}

function collectTextureTargets(object) {
  if (!object) return [];
  const materialNames = new Set();
  const meshNames = new Set();

  object.traverse((child) => {
    if (!child.isMesh) return;
    const baseMaterial = child.userData?.baseMaterial || child.material;
    getMaterialNames(baseMaterial).forEach((name) => materialNames.add(name));
    meshNames.add(ensureMeshLabel(child));
  });

  const targets = [];
  if (materialNames.size > 0) {
    Array.from(materialNames)
      .sort()
      .forEach((name) => {
        targets.push({ value: `${MATERIAL_TARGET_PREFIX}${name}`, label: `Material: ${name}` });
      });
    return targets;
  }

  Array.from(meshNames)
    .sort()
    .forEach((name) => {
      targets.push({ value: `${MESH_TARGET_PREFIX}${name}`, label: `Mesh: ${name}` });
    });
  return targets;
}

function getMeshList(object) {
  if (!object) return [];
  if (Array.isArray(object.userData?.meshList)) {
    return object.userData.meshList;
  }
  const meshes = [];
  object.traverse((child) => {
    if (child.isMesh) meshes.push(child);
  });
  object.userData.meshList = meshes;
  return meshes;
}

function findWindowTemplateTarget(object) {
  if (!object) return null;
  let best = null;

  const applyCandidate = (label, kind) => {
    const score = scoreWindowTemplateName(label);
    if (score <= 0) return;

    const value = kind === "material"
      ? `${MATERIAL_TARGET_PREFIX}${label}`
      : `${MESH_TARGET_PREFIX}${label}`;
    const friendlyLabel = kind === "material"
      ? `Material: ${label}`
      : `Mesh: ${label}`;

    if (!best || score > best.score) {
      best = { score, value, label: friendlyLabel };
    }
  };

  object.traverse((child) => {
    if (!child.isMesh) return;
    const baseMaterial = child.userData?.baseMaterial || child.material;
    getMaterialNames(baseMaterial).forEach((name) => applyCandidate(name, "material"));
    applyCandidate(ensureMeshLabel(child), "mesh");
  });

  if (!best) return null;
  return { value: best.value, label: best.label };
}

function scoreWindowTemplateName(name) {
  if (!name) return 0;
  const raw = name.toString().trim().toLowerCase();
  if (!raw) return 0;

  if (raw.includes("sign_2") || raw.includes("sign-2") || raw.includes("sign2")) return 120;
  if (raw.includes("sign_3") || raw.includes("sign-3") || raw.includes("sign3")) return 110;

  const tokens = tokenizeName(raw);
  const tokenSet = new Set(tokens);
  if (tokenSet.has("sign") && tokenSet.has("2")) return 120;
  if (tokenSet.has("sign") && tokenSet.has("3")) return 110;

  if (raw.includes("vehglass") || raw.includes("vehicle_vehglass")) return 100;
  if (raw.includes("window")) return 70;
  if (raw.includes("glass")) return 60;
  return 0;
}

function tokenizeName(name) {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function getMaterialNames(material) {
  if (!material) return [];
  if (Array.isArray(material)) {
    return material
      .map((mat) => mat?.name?.trim())
      .filter((name) => typeof name === "string" && name.length > 0);
  }
  const name = material.name?.trim();
  return name ? [name] : [];
}

function ensureMeshLabel(mesh) {
  if (!mesh?.isMesh) return "";
  if (mesh.userData?.meshLabel) return mesh.userData.meshLabel;
  const name = mesh.name?.trim();
  const label = name || `mesh-${mesh.id}`;
  mesh.userData.meshLabel = label;
  return label;
}
