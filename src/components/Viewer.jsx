import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { DDSLoader } from "three/examples/jsm/loaders/DDSLoader";
import { TGALoader } from "three/examples/jsm/loaders/TGALoader";
import { DFFLoader } from "dff-loader";
import { readFile } from "@tauri-apps/plugin-fs";
import { parseYft } from "../lib/yft";
import { parseDDS } from "../lib/dds";
import {
  getFileExtension,
  getFileNameWithoutExtension,
  getTextureMimeType,
  sniffTextureSignature,
  heightToFootprintRatio,
  maybeAutoFixYftUpAxis,
  setupLiveryShader,
  buildDrawableObject,
  hasRenderableMeshes,
  disposeObject,
  disposeMaterial,
  createFloorGrid,
  normalizeLoadedMeshes,
  setupWasdControls,
  setupWheelWhileDragging,
  loadTextureFromPath as loadTextureFromPathShared,
  loadPsdTexture,
  loadPdnTexture,
  YDD_SCAN_SETTINGS,
} from "../lib/viewer-utils";

const presets = {
  front: new THREE.Vector3(0, 0, -1),
  back: new THREE.Vector3(0, 0, 1),
  side: new THREE.Vector3(1, 0, 0),
  angle: new THREE.Vector3(0.8, 0.12, -0.8),
  top: new THREE.Vector3(0, 1, 0),
};

const defaultBody = "#dfe4ea";
const ALL_TARGET = "all";
const MATERIAL_TARGET_PREFIX = "material:";
const MESH_TARGET_PREFIX = "mesh:";
const LIVERY_TOKEN_SPLIT = /[^a-z0-9]+/g;
const EXTERIOR_INCLUDE_TOKENS = [
  "carpaint",
  "car_paint",
  "car-paint",
  "livery",
  "sign",
  "decal",
  "logo",
  "wrap",
  "body",
  "bodyshell",
  "shell",
  "exterior",
  "panel",
  "door",
  "hood",
  "bonnet",
  "roof",
  "trunk",
  "boot",
  "bumper",
  "fender",
  "quarter",
  "skirt",
  "spoiler",
  "mirror",
  "lid",
];
const EXTERIOR_EXCLUDE_TOKENS = [
  "glass",
  "window",
  "interior",
  "seat",
  "dash",
  "steer",
  "wheel",
  "tire",
  "rim",
  "brake",
  "engine",
  "suspension",
  "chassis",
  "under",
  "undercarriage",
];
const TEXTURE_CACHE_LIMIT = 16;
const textureCache = new Map();

function getTextureCacheKey(path, flipY, reloadToken) {
  if (!path) return "";
  const normalized = path.toString();
  const token = Number.isFinite(reloadToken) ? reloadToken : 0;
  return `${normalized}::${flipY ? "fy" : "nf"}::${token}`;
}

function touchTextureCache(key) {
  const entry = textureCache.get(key);
  if (!entry) return null;
  textureCache.delete(key);
  textureCache.set(key, entry);
  return entry.texture;
}

function getCachedTexture(key) {
  if (!key) return null;
  return touchTextureCache(key);
}

function pruneTextureCache() {
  if (textureCache.size <= TEXTURE_CACHE_LIMIT) return;
  for (const [key, entry] of textureCache) {
    if (textureCache.size <= TEXTURE_CACHE_LIMIT) break;
    if (entry.refs > 0) continue;
    textureCache.delete(key);
    entry.texture.dispose?.();
  }
}

function cacheTexture(key, texture) {
  if (!key || !texture) return;
  const existing = textureCache.get(key);
  if (existing && existing.texture !== texture) {
    existing.texture.dispose?.();
  }
  const refs = existing?.refs || 0;
  textureCache.delete(key);
  texture.userData = texture.userData || {};
  texture.userData.cacheKey = key;
  textureCache.set(key, { texture, refs });
  pruneTextureCache();
}

function retainTexture(texture) {
  if (!texture) return;
  const key = texture.userData?.cacheKey;
  if (!key) return;
  const entry = textureCache.get(key);
  if (!entry) return;
  entry.refs = (entry.refs || 0) + 1;
}

function releaseTexture(texture) {
  if (!texture) return;
  const key = texture.userData?.cacheKey;
  if (!key) {
    texture.dispose?.();
    return;
  }
  const entry = textureCache.get(key);
  if (!entry) {
    texture.dispose?.();
    return;
  }
  entry.refs = Math.max(0, (entry.refs || 0) - 1);
}
export default function Viewer({
  modelPath,
  texturePath,
  windowTexturePath,
  bodyColor,
  backgroundColor,
  textureReloadToken,
  windowTextureReloadToken = textureReloadToken,
  textureTarget,
  windowTextureTarget,
  textureMode = "everything",
  liveryExteriorOnly = false,
  flipTextureY = true,
  wasdEnabled = false,
  showGrid = false,
  lightIntensity = 1.0,
  glossiness = 0.5,
  onReady,
  onModelInfo,
  onModelError,
  onModelLoading,
  onTextureReload,
  onTextureError,
  onWindowTextureError,
  onFormatWarning,
}) {
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const modelRef = useRef(null);
  const textureRef = useRef(null);
  const windowTextureRef = useRef(null);
  const lightsRef = useRef({ ambient: null, key: null, rim: null });
  const gridRef = useRef(null);
  const fitRef = useRef({ center: new THREE.Vector3(), distance: 4 });
  const [sceneReady, setSceneReady] = useState(false);
  const [modelLoadedVersion, setModelLoadedVersion] = useState(0);
  const requestRenderRef = useRef(null);
  const wasdStateRef = useRef({
    forward: false,
    back: false,
    left: false,
    right: false,
    up: false,
    down: false,
    boost: false,
  });
  const wasdFrameRef = useRef(0);
  const onReadyRef = useRef(onReady);
  const onModelInfoRef = useRef(onModelInfo);
  const onModelErrorRef = useRef(onModelError);
  const onModelLoadingRef = useRef(onModelLoading);
  const onTextureErrorRef = useRef(onTextureError);
  const onWindowTextureErrorRef = useRef(onWindowTextureError);
  const onFormatWarningRef = useRef(onFormatWarning);
  const materialStateRef = useRef({});

  const resolvedBodyColor = bodyColor || defaultBody;

  const textureLoader = useMemo(() => new THREE.TextureLoader(), []);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    onModelInfoRef.current = onModelInfo;
  }, [onModelInfo]);

  useEffect(() => {
    onModelErrorRef.current = onModelError;
  }, [onModelError]);

  useEffect(() => {
    onModelLoadingRef.current = onModelLoading;
  }, [onModelLoading]);

  useEffect(() => {
    onTextureErrorRef.current = onTextureError;
    onWindowTextureErrorRef.current = onWindowTextureError;
    onFormatWarningRef.current = onFormatWarning;
  });

  useEffect(() => {
    materialStateRef.current = {
      bodyColor: resolvedBodyColor,
      textureTarget,
      windowTextureTarget,
      liveryExteriorOnly,
      textureMode,
      glossiness,
    };
  }, [resolvedBodyColor, textureTarget, windowTextureTarget, liveryExteriorOnly, textureMode, glossiness]);

  const requestRender = useCallback(() => {
    requestRenderRef.current?.();
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const scene = new THREE.Scene();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    const getPixelRatio = () => Math.min(window.devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(getPixelRatio());
    renderer.setClearColor(new THREE.Color(backgroundColor || "#141414"), 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    camera.position.set(2.4, 1.2, 2.8);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };

    const wheelWhileDragging = setupWheelWhileDragging(controls, requestRenderRef);
    renderer.domElement.addEventListener("wheel", wheelWhileDragging, { passive: false });

    controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;

    const ambient = new THREE.AmbientLight(0xffffff, 0.5 * lightIntensity);
    const key = new THREE.DirectionalLight(0xffffff, 0.9 * lightIntensity);
    key.position.set(3.5, 4.5, 2.5);
    const rim = new THREE.DirectionalLight(0xffffff, 0.35 * lightIntensity);
    rim.position.set(-3, 2, -2.2);

    lightsRef.current = { ambient, key, rim };
    scene.add(ambient, key, rim);

    renderer.domElement.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });

    containerRef.current.appendChild(renderer.domElement);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;
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
      renderer.setPixelRatio(getPixelRatio());
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
      setPreset: (presetKey) => {
        const preset = presets[presetKey];
        if (!preset) return;
        const { center, distance } = fitRef.current;
        camera.position.set(
          center.x + preset.x * distance,
          center.y + preset.y * distance,
          center.z + preset.z * distance,
        );
        controls.target.copy(center);
        controls.update();
        requestRenderRef.current?.();
      },
      setZoom: (zoomFactor) => {
        if (!cameraRef.current || !controlsRef.current) return;
        const zoom = Math.max(0.4, Math.min(2.5, zoomFactor || 1));
        const { center, distance } = fitRef.current;
        const direction = new THREE.Vector3()
          .subVectors(cameraRef.current.position, controlsRef.current.target)
          .normalize();
        const nextDistance = distance / zoom;
        cameraRef.current.position.copy(center).add(direction.multiplyScalar(nextDistance));
        controlsRef.current.target.copy(center);
        controlsRef.current.update();
        requestRenderRef.current?.();
      },
      reset: () => {
        const { center, distance } = fitRef.current;
        camera.position.set(center.x + distance, center.y + distance * 0.2, center.z + distance);
        controls.target.copy(center);
        controls.update();
        requestRenderRef.current?.();
      },
      rotateModel: (axis) => {
        if (!modelRef.current) return;
        const angle = Math.PI / 2; // 90 degrees
        switch (axis) {
          case "x":
            modelRef.current.rotateX(angle);
            break;
          case "y":
            modelRef.current.rotateY(angle);
            break;
          case "z":
            modelRef.current.rotateZ(angle);
            break;
          default:
            break;
        }
        requestRenderRef.current?.();
      },
      captureScreenshot: () => {
        if (!rendererRef.current || !sceneRef.current || !cameraRef.current) return null;
        // Render a fresh frame and capture it
        rendererRef.current.render(sceneRef.current, cameraRef.current);
        return rendererRef.current.domElement.toDataURL("image/png");
      },
      getPresetKeys: () => Object.keys(presets),
    });

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      controls.removeEventListener("start", requestRenderFrame);
      controls.removeEventListener("change", requestRenderFrame);
      controls.removeEventListener("end", requestRenderFrame);
      controls.dispose();
      renderer.dispose();
      renderer.domElement.removeEventListener("wheel", wheelWhileDragging);
      renderer.domElement.remove();
      setSceneReady(false);
      requestRenderRef.current = null;
    };
  }, []);

  useEffect(() => {
    const { ambient, key, rim } = lightsRef.current;
    if (ambient) ambient.intensity = 0.5 * lightIntensity;
    if (key) key.intensity = 0.9 * lightIntensity;
    if (rim) rim.intensity = 0.35 * lightIntensity;
    requestRenderRef.current?.();
  }, [lightIntensity]);

  useEffect(() => {
    if (!modelRef.current) return;
    const factor = 2 - 2 * glossiness;
    const meshes = getMeshList(modelRef.current);

    for (const child of meshes) {
      if (!child.material) continue;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (!material) continue;
        const base = material.userData?.baseRoughness;
        if (typeof base === "number") {
          material.roughness = Math.min(1.0, Math.max(0.0, base * factor));
        }
      }
    }
    requestRenderRef.current?.();
  }, [glossiness]);

  useEffect(() => {
    if (!sceneReady) return;
    if (!wasdEnabled) return;
    if (!cameraRef.current || !controlsRef.current) return;
    return setupWasdControls({ wasdStateRef, wasdFrameRef, cameraRef, controlsRef, fitRef, requestRenderRef });
  }, [sceneReady, wasdEnabled]);

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

  useEffect(() => {
    if (!sceneReady || !sceneRef.current) return;

    if (!modelPath) {
      onModelLoadingRef.current?.(false);
      return;
    }

    let cancelled = false;

    const loadModel = async () => {
      onModelLoadingRef.current?.(true);
      try {
        const extension = getFileExtension(modelPath);
        let object = null;

        if (extension === "obj") {
          onModelErrorRef.current?.(
            "out of sheer respect for vehicle devs and those who pour their hearts and souls into their creations, .OBJ files will never be supported.",
          );
          return;
        }

        if (extension === "yft") {
          let bytes = null;
          try {
            bytes = await readFile(modelPath);
          } catch {
            onModelErrorRef.current?.("Failed to read YFT file.");
            return;
          }
          if (cancelled) return;
          const name = getFileNameWithoutExtension(modelPath) || "yft_model";
          let drawable = null;
          try {
            drawable = parseYft(bytes, name);
          } catch (err) {
            console.error("[YFT] Parse error:", err);
            onModelErrorRef.current?.("YFT parsing failed.");
            return;
          }
          if (!drawable || !drawable.models?.length) {
            onModelErrorRef.current?.("YFT parsing returned no drawable data.");
            return;
          }

          object = buildDrawableObject(drawable, { useVertexColors: false });
          if (!hasRenderableMeshes(object)) {
            onModelErrorRef.current?.("YFT parsed but no mesh data was generated.");
            return;
          }
          object.userData.sourceFormat = "yft";

        } else if (extension === "ydd") {
          let bytes = null;
          try {
            bytes = await readFile(modelPath);
          } catch {
            onModelErrorRef.current?.("Failed to read YDD file.");
            return;
          }
          if (cancelled) return;
          const name = getFileNameWithoutExtension(modelPath) || "ydd_model";
          let drawable = null;
          try {
            drawable = parseYft(bytes, name, YDD_SCAN_SETTINGS);
          } catch (err) {
            console.error("[YDD] Parse error:", err);
            onModelErrorRef.current?.("YDD parsing failed.");
            return;
          }
          if (!drawable || !drawable.models?.length) {
            onModelErrorRef.current?.("YDD parsing returned no drawable data.");
            return;
          }
          object = buildDrawableObject(drawable, { useVertexColors: false });
          if (!hasRenderableMeshes(object)) {
            onModelErrorRef.current?.("YDD parsed but no mesh data was generated.");
            return;
          }
          object.userData.sourceFormat = "ydd";
        } else if (extension === "clmesh") {
          let bytes = null;
          try {
            bytes = await readFile(modelPath);
          } catch {
            onModelErrorRef.current?.("Failed to read mesh cache.");
            return;
          }
          if (cancelled) return;
          const meshes = parseClmesh(bytes);
          if (!meshes || meshes.length === 0) {
            onModelErrorRef.current?.("Mesh cache contained no meshes.");
            return;
          }
          object = buildClmeshObject(meshes);
        } else if (extension === "dff") {
          let bytes = null;
          try {
            bytes = await readFile(modelPath);
          } catch {
            return;
          }
          if (cancelled) return;
          const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          const loader = new DFFLoader();
          try {
            object = loader.parse(buffer);
          } catch {
            return;
          }
        } else {
          onModelErrorRef.current?.("Unsupported model format.");
          return;
        }

        if (!object) {
          onModelErrorRef.current?.("Model loaded with no geometry.");
          return;
        }
        normalizeLoadedMeshes(object);

        if (modelRef.current) {
          sceneRef.current.remove(modelRef.current);
          disposeObject(modelRef.current);
        }

        modelRef.current = object;
        sceneRef.current.add(object);

        const glossFactor = 2 - 2 * glossiness;
        const meshes = getMeshList(object);
        for (const child of meshes) {
          if (!child.material) continue;
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          for (const material of materials) {
            if (!material) continue;
            const base = material.userData?.baseRoughness;
            if (typeof base === "number") {
              material.roughness = Math.min(1.0, Math.max(0.0, base * glossFactor));
            }
          }
        }

        const targets = collectTextureTargets(object);
        const liveryTarget = findLiveryTarget(object);
        const windowTarget = findWindowTemplateTarget(object);
        onModelInfoRef.current?.({
          targets,
          liveryTarget: liveryTarget?.value || "",
          liveryLabel: liveryTarget?.label || "",
          windowTarget: windowTarget?.value || "",
          windowLabel: windowTarget?.label || "",
        });

        const box = new THREE.Box3().setFromObject(object);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

        if (object?.userData?.sourceFormat === "yft") {
          const didFix = maybeAutoFixYftUpAxis(object, size);
          if (didFix) {
            box.setFromObject(object);
            box.getSize(size);
            box.getCenter(center);
          }
        }

        const isBoundsValid =
          Number.isFinite(size.x) &&
          Number.isFinite(size.y) &&
          Number.isFinite(size.z) &&
          Number.isFinite(center.x) &&
          Number.isFinite(center.y) &&
          Number.isFinite(center.z);
        if (!isBoundsValid) {
          onModelErrorRef.current?.("Parsed model bounds are invalid.");
          return;
        }
        const maxDim = Math.max(size.x, size.y, size.z);
        if (!Number.isFinite(maxDim) || maxDim <= 0) {
          onModelErrorRef.current?.("Parsed model geometry is empty.");
          return;
        }
        const distance = Math.max(maxDim * 1.6, 2.4);

        fitRef.current = { center, distance };

        if (cameraRef.current && controlsRef.current) {
          cameraRef.current.near = Math.max(distance / 100, 0.01);
          cameraRef.current.far = Math.max(distance * 50, 100);
          cameraRef.current.position.set(center.x + distance, center.y + distance * 0.2, center.z + distance);
          cameraRef.current.updateProjectionMatrix();
          controlsRef.current.target.copy(center);
          controlsRef.current.minDistance = Math.max(distance * 0.05, 0.1);
          controlsRef.current.maxDistance = distance * 10;
          controlsRef.current.update();
        }

        applyMaterials(
          object,
          resolvedBodyColor,
          textureRef.current,
          textureTarget,
          windowTextureRef.current,
          windowTextureTarget,
          liveryExteriorOnly,
          textureMode,
        );
        requestRender();
        setModelLoadedVersion((v) => v + 1);
      } catch (error) {
        const message =
          error && typeof error === "object" && "message" in error
            ? `Model load failed: ${error.message}`
            : "Model load failed.";
        onModelErrorRef.current?.(message);
        console.error(error);
      } finally {
        if (!cancelled) onModelLoadingRef.current?.(false);
      }
    };

    loadModel();

    return () => {
      cancelled = true;
      onModelLoadingRef.current?.(false);
    };
  }, [modelPath, sceneReady]);

  useEffect(() => {
    if (!modelRef.current) return;
    applyMaterials(
      modelRef.current,
      resolvedBodyColor,
      textureRef.current,
      textureTarget,
      windowTextureRef.current,
      windowTextureTarget,
      liveryExteriorOnly,
      textureMode,
      materialStateRef.current.glossiness,
    );
    requestRender();
  }, [resolvedBodyColor, textureTarget, windowTextureTarget, liveryExteriorOnly, textureMode]);

  useEffect(() => {
    let cancelled = false;

    const clearTexture = () => {
      const materialState = materialStateRef.current;
      if (textureRef.current) {
        releaseTexture(textureRef.current);
        textureRef.current = null;
      }
      if (modelRef.current) {
        applyMaterials(
          modelRef.current,
          materialState.bodyColor,
          null,
          materialState.textureTarget,
          windowTextureRef.current,
          materialState.windowTextureTarget,
          materialState.liveryExteriorOnly,
          materialState.textureMode,
          materialState.glossiness,
        );
      }
      onTextureErrorRef.current?.("");
    };

    if (!texturePath) {
      clearTexture();
      return;
    }

    const loadTexture = async () => {
      // Handle data: URLs (e.g. from VariantsPage composited preview)
      if (texturePath.startsWith("data:")) {
        try {
          const img = new Image();
          img.crossOrigin = "anonymous";
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = texturePath;
          });
          const texture = new THREE.CanvasTexture(img);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.flipY = true;
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.needsUpdate = true;
          texture.anisotropy = rendererRef.current?.capabilities.getMaxAnisotropy() || 1;
          if (cancelled) return;
          releaseTexture(textureRef.current);
          textureRef.current = texture;
          retainTexture(texture);
          const materialState = materialStateRef.current;
          if (modelRef.current) {
            applyMaterials(
              modelRef.current,
              materialState.bodyColor,
              texture,
              materialState.textureTarget,
              windowTextureRef.current,
              materialState.windowTextureTarget,
              materialState.liveryExteriorOnly,
              materialState.textureMode,
              materialState.glossiness,
            );
            requestRender();
          }
          onTextureErrorRef.current?.("");
          onTextureReload?.();
        } catch {
          /* data URL loading failed */
        }
        return;
      }

      const cacheKey = getTextureCacheKey(texturePath, flipTextureY, textureReloadToken);
      const cached = getCachedTexture(cacheKey);
      if (cached) {
        if (cancelled) return;
        const materialState = materialStateRef.current;
        if (textureRef.current !== cached) {
          releaseTexture(textureRef.current);
          textureRef.current = cached;
          retainTexture(cached);
        }
        if (modelRef.current) {
          applyMaterials(
            modelRef.current,
            materialState.bodyColor,
            cached,
            materialState.textureTarget,
            windowTextureRef.current,
            materialState.windowTextureTarget,
            materialState.liveryExteriorOnly,
            materialState.textureMode,
            materialState.glossiness,
          );
          requestRender();
        }
        onTextureErrorRef.current?.("");
        onTextureReload?.();
        return;
      }
      let bytes = null;
      try {
        bytes = await readFile(texturePath);
      } catch {
        return;
      }
      if (cancelled) return;

      const extension = getFileExtension(texturePath);
      const signature = sniffTextureSignature(bytes);

      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );

      const applyTextureSettings = (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        if (!texture.isCompressedTexture && !texture.userData?.ddsDecoded) {
          texture.flipY = flipTextureY;
        }
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.needsUpdate = true;
        texture.anisotropy = rendererRef.current?.capabilities.getMaxAnisotropy() || 1;
        if (texture.isDataTexture) {
          texture.magFilter = THREE.LinearFilter;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          if (!texture.mipmaps || texture.mipmaps.length === 0) {
            texture.generateMipmaps = true;
          }
        }
      };

      const loadNative = async () => {
        const mime = signature.mime || getTextureMimeType(extension) || "application/octet-stream";
        const blob = new Blob([bytes], { type: mime });
        const url = URL.createObjectURL(blob);
        try {
          const texture = await new Promise((resolve, reject) => {
            textureLoader.load(url, resolve, undefined, reject);
          });
          return texture;
        } finally {
          URL.revokeObjectURL(url);
        }
      };

      const loadDdsCustom = async () => {
        const tex = parseDDS(buffer);
        if (!tex) throw new Error("Custom DDS parser returned null");
        return tex;
      };

      const loadDdsFallback = async () => {
        const loader = new DDSLoader();
        if (typeof loader.parse === "function") {
          return loader.parse(buffer, true);
        }
        const blob = new Blob([bytes], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        try {
          const texture = await new Promise((resolve, reject) => {
            loader.load(url, resolve, undefined, reject);
          });
          return texture;
        } finally {
          URL.revokeObjectURL(url);
        }
      };

      const loadTga = async () => {
        const loader = new TGALoader();
        if (typeof loader.parse === "function") {
          return loader.parse(buffer);
        }
        const blob = new Blob([bytes], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        try {
          const texture = await new Promise((resolve, reject) => {
            loader.load(url, resolve, undefined, reject);
          });
          return texture;
        } finally {
          URL.revokeObjectURL(url);
        }
      };

      const loadPsd = async () => loadPsdTexture(bytes);

      const loadTiff = async () => {
        const mod = await import("utif");
        const UTIF = mod.default || mod;
        const ifds = UTIF.decode(buffer);
        if (!ifds || ifds.length === 0) {
          throw new Error("TIFF contained no images.");
        }
        UTIF.decodeImage(buffer, ifds[0]);
        const rgba = UTIF.toRGBA8(ifds[0]);
        const w = ifds[0].width;
        const h = ifds[0].height;
        if (!rgba || !w || !h) {
          throw new Error("TIFF decode returned empty image data.");
        }
        return new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat);
      };

      const loadAi = async () => {
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url
        ).href;
        const loadingTask = pdfjsLib.getDocument({ data: buffer });
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const context = canvas.getContext("2d");
        await page.render({ canvasContext: context, viewport }).promise;
        return new THREE.CanvasTexture(canvas);
      };

      const loadPdn = async () => loadPdnTexture(bytes, texturePath);

      const attempts = [];
      const kind = (extension || "").toLowerCase();
      const sigKind = (signature.kind || "").toLowerCase();
      const isTiff = kind === "tif" || kind === "tiff" || sigKind === "tif" || sigKind === "tiff";
      const isPsd = kind === "psd" || sigKind === "psd";
      const isDds = kind === "dds" || sigKind === "dds";
      const isAi = kind === "ai" || sigKind === "ai" || sigKind === "ai-ps";
      const isPdnFile = kind === "pdn" || sigKind === "pdn";
      const isPdfCompatibleAi = sigKind === "ai" || kind === "ai";
      const isUnsupportedAiVariant = kind === "ai" && sigKind !== "ai";

      if (isDds) { attempts.push(loadDdsCustom); attempts.push(loadDdsFallback); }
      if (kind === "tga") attempts.push(loadTga);
      if (isPsd) attempts.push(loadPsd);
      if (isPdnFile) attempts.push(loadPdn);
      if (isTiff) attempts.push(loadTiff);
      if (isAi && isPdfCompatibleAi) attempts.push(loadAi);
      attempts.push(loadNative);

      let texture = null;
      let lastError = null;

      for (const attempt of attempts) {
        try {
          texture = await attempt();
          if (texture) break;
        } catch (error) {
          if (error?.type === "unsupported-bit-depth") {
            console.log("[Texture] Unsupported bit depth detected:", error.bitDepth);
            onFormatWarningRef.current?.({ type: "16bit-psd", bitDepth: error.bitDepth, path: texturePath, kind: "primary" });
            return;
          }
          if (!lastError || (error instanceof Error && error.message)) {
            lastError = error;
          }
        }
      }

      if (!texture) {
        console.error("[Texture] Load failed:", lastError);
        const errorMessage = isUnsupportedAiVariant
          ? "This .ai file is not PDF-compatible. Re-save/export it as PDF-compatible AI, or use PNG/JPG."
          : (lastError?.message ||
            "Texture failed to load. Try exporting to PNG or JPG if your editor uses a specialized format.");
        onTextureErrorRef.current?.(errorMessage);
        return;
      }

      if (cancelled) {
        releaseTexture(texture);
        return;
      }

      applyTextureSettings(texture);
      cacheTexture(cacheKey, texture);
      releaseTexture(textureRef.current);
      textureRef.current = texture;
      retainTexture(texture);

      if (modelRef.current) {
        const materialState = materialStateRef.current;
        applyMaterials(
          modelRef.current,
          materialState.bodyColor,
          texture,
          materialState.textureTarget,
          windowTextureRef.current,
          materialState.windowTextureTarget,
          materialState.liveryExteriorOnly,
          materialState.textureMode,
          materialState.glossiness,
        );
        requestRender();
      }

      onTextureErrorRef.current?.("");
      onTextureReload?.();
    };

    loadTexture();

    return () => {
      cancelled = true;
    };
  }, [
    texturePath,
    textureReloadToken,
    textureLoader,
    onTextureReload,
    flipTextureY,
  ]);

  useEffect(() => {
    let cancelled = false;

    const clearTexture = () => {
      const materialState = materialStateRef.current;
      if (windowTextureRef.current) {
        releaseTexture(windowTextureRef.current);
        windowTextureRef.current = null;
      }
      if (modelRef.current) {
        applyMaterials(
          modelRef.current,
          materialState.bodyColor,
          textureRef.current,
          materialState.textureTarget,
          null,
          materialState.windowTextureTarget,
          materialState.liveryExteriorOnly,
          materialState.textureMode,
          materialState.glossiness,
        );
        requestRender();
      }
      onWindowTextureErrorRef.current?.("");
    };

    if (!windowTexturePath) {
      clearTexture();
      return;
    }

    const loadTexture = async () => {
      const cacheKey = getTextureCacheKey(
        windowTexturePath,
        flipTextureY,
        windowTextureReloadToken,
      );
      const cached = getCachedTexture(cacheKey);
      if (cached) {
        if (cancelled) return;
        const materialState = materialStateRef.current;
        if (windowTextureRef.current !== cached) {
          releaseTexture(windowTextureRef.current);
          windowTextureRef.current = cached;
          retainTexture(cached);
        }
        if (modelRef.current) {
          applyMaterials(
            modelRef.current,
            materialState.bodyColor,
            textureRef.current,
            materialState.textureTarget,
            cached,
            materialState.windowTextureTarget,
            materialState.liveryExteriorOnly,
            materialState.textureMode,
            materialState.glossiness,
          );
          requestRender();
        }
        onWindowTextureErrorRef.current?.("");
        onTextureReload?.();
        return;
      }
      let bytes = null;
      try {
        bytes = await readFile(windowTexturePath);
      } catch {
        return;
      }
      if (cancelled) return;

      const extension = getFileExtension(windowTexturePath);
      const signature = sniffTextureSignature(bytes);

      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );

      const applyTextureSettings = (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        if (!texture.isCompressedTexture && !texture.userData?.ddsDecoded) {
          texture.flipY = flipTextureY;
        }
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.needsUpdate = true;
        texture.anisotropy = rendererRef.current?.capabilities.getMaxAnisotropy() || 1;
        if (texture.isDataTexture) {
          texture.magFilter = THREE.LinearFilter;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          if (!texture.mipmaps || texture.mipmaps.length === 0) {
            texture.generateMipmaps = true;
          }
        }
      };

      const loadNative = async () => {
        const mime = signature.mime || getTextureMimeType(extension) || "application/octet-stream";
        const blob = new Blob([bytes], { type: mime });
        const url = URL.createObjectURL(blob);
        try {
          const texture = await new Promise((resolve, reject) => {
            textureLoader.load(url, resolve, undefined, reject);
          });
          return texture;
        } finally {
          URL.revokeObjectURL(url);
        }
      };

      const loadDdsCustom = async () => {
        const tex = parseDDS(buffer);
        if (!tex) throw new Error("Custom DDS parser returned null");
        return tex;
      };

      const loadDdsFallback = async () => {
        const loader = new DDSLoader();
        if (typeof loader.parse === "function") {
          return loader.parse(buffer, true);
        }
        const blob = new Blob([bytes], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        try {
          const texture = await new Promise((resolve, reject) => {
            loader.load(url, resolve, undefined, reject);
          });
          return texture;
        } finally {
          URL.revokeObjectURL(url);
        }
      };

      const loadTga = async () => {
        const loader = new TGALoader();
        if (typeof loader.parse === "function") {
          return loader.parse(buffer);
        }
        const blob = new Blob([bytes], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        try {
          const texture = await new Promise((resolve, reject) => {
            loader.load(url, resolve, undefined, reject);
          });
          return texture;
        } finally {
          URL.revokeObjectURL(url);
        }
      };

      const loadPsd = async () => loadPsdTexture(bytes);

      const loadTiff = async () => {
        const mod = await import("utif");
        const UTIF = mod.default || mod;
        const ifds = UTIF.decode(buffer);
        if (!ifds || ifds.length === 0) {
          throw new Error("TIFF contained no images.");
        }
        UTIF.decodeImage(buffer, ifds[0]);
        const rgba = UTIF.toRGBA8(ifds[0]);
        const w = ifds[0].width;
        const h = ifds[0].height;
        if (!rgba || !w || !h) {
          throw new Error("TIFF decode returned empty image data.");
        }
        return new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat);
      };

      const loadAi = async () => {
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url
        ).href;
        const loadingTask = pdfjsLib.getDocument({ data: buffer });
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const context = canvas.getContext("2d");
        await page.render({ canvasContext: context, viewport }).promise;
        return new THREE.CanvasTexture(canvas);
      };

      const loadPdn = async () => loadPdnTexture(bytes, windowTexturePath);

      const attempts = [];
      const kind = (extension || "").toLowerCase();
      const sigKind = (signature.kind || "").toLowerCase();
      const isTiff = kind === "tif" || kind === "tiff" || sigKind === "tif" || sigKind === "tiff";
      const isPsd = kind === "psd" || sigKind === "psd";
      const isDds = kind === "dds" || sigKind === "dds";
      const isAi = kind === "ai" || sigKind === "ai" || sigKind === "ai-ps";
      const isPdnFile = kind === "pdn" || sigKind === "pdn";
      const isPdfCompatibleAi = sigKind === "ai" || kind === "ai";
      const isUnsupportedAiVariant = kind === "ai" && sigKind !== "ai";

      if (isDds) { attempts.push(loadDdsCustom); attempts.push(loadDdsFallback); }
      if (kind === "tga") attempts.push(loadTga);
      if (isPsd) attempts.push(loadPsd);
      if (isPdnFile) attempts.push(loadPdn);
      if (isTiff) attempts.push(loadTiff);
      if (isAi && isPdfCompatibleAi) attempts.push(loadAi);
      attempts.push(loadNative);

      let texture = null;
      let lastError = null;

      for (const attempt of attempts) {
        try {
          texture = await attempt();
          if (texture) break;
        } catch (error) {
          if (error?.type === "unsupported-bit-depth") {
            onFormatWarningRef.current?.({ type: "16bit-psd", bitDepth: error.bitDepth, path: windowTexturePath, kind: "window" });
            return;
          }
          lastError = error;
        }
      }

      if (!texture) {
        console.error("[Window Texture] Load failed:", lastError);
        onWindowTextureErrorRef.current?.(
          isUnsupportedAiVariant
            ? "This .ai file is not PDF-compatible. Re-save/export it as PDF-compatible AI, or use PNG/JPG."
            : "Window template failed to load. Try exporting to PNG or JPG if your editor uses a specialized format.",
        );
        return;
      }

      if (cancelled) {
        releaseTexture(texture);
        return;
      }

      applyTextureSettings(texture);
      cacheTexture(cacheKey, texture);
      releaseTexture(windowTextureRef.current);
      windowTextureRef.current = texture;
      retainTexture(texture);

      if (modelRef.current) {
        const materialState = materialStateRef.current;
        applyMaterials(
          modelRef.current,
          materialState.bodyColor,
          textureRef.current,
          materialState.textureTarget,
          texture,
          materialState.windowTextureTarget,
          materialState.liveryExteriorOnly,
          materialState.textureMode,
          materialState.glossiness,
        );
      }

      onWindowTextureErrorRef.current?.("");
      onTextureReload?.();
    };

    loadTexture();

    return () => {
      cancelled = true;
    };
  }, [
    windowTexturePath,
    windowTextureReloadToken,
    textureLoader,
    onTextureReload,
    flipTextureY,
  ]);

  return <div ref={containerRef} className="h-full w-full" />;
}

function buildClmeshObject(meshes) {
  const root = new THREE.Group();
  root.name = "clmesh";

  meshes.forEach((mesh) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    if (mesh.normals) {
      geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    }
    if (mesh.uvs) {
      geometry.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
    }
    if (mesh.indices) {
      geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    }

    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0.2,
      roughness: 0.6,
      side: THREE.FrontSide,
    });
    material.name = mesh.materialName || "";

    const threeMesh = new THREE.Mesh(geometry, material);
    threeMesh.name = mesh.name || material.name || "mesh";
    if (mesh.textureRefs && Object.keys(mesh.textureRefs).length > 0) {
      threeMesh.userData.textureRefs = mesh.textureRefs;
    }
    root.add(threeMesh);
  });

  return root;
}

function parseClmesh(bytes) {
  if (!bytes || bytes.length < 8) {
    throw new Error("Invalid mesh cache.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const magic = readClmeshMagic(bytes, offset);
  if (magic !== "CLM1") {
    throw new Error("Mesh cache magic mismatch.");
  }
  offset += 4;

  const version = view.getUint16(offset, true);
  offset += 2;
  if (version !== 1) {
    throw new Error(`Unsupported mesh cache version ${version}.`);
  }

  const meshCount = view.getUint16(offset, true);
  offset += 2;

  const decoder = new TextDecoder("utf-8");
  const meshes = [];

  for (let i = 0; i < meshCount; i += 1) {
    const name = readClmeshString(view, bytes, decoder, () => offset, (next) => {
      offset = next;
    });
    const materialName = readClmeshString(view, bytes, decoder, () => offset, (next) => {
      offset = next;
    });

    const vertexCount = view.getUint32(offset, true);
    offset += 4;
    const indexCount = view.getUint32(offset, true);
    offset += 4;
    const flags = view.getUint8(offset);
    offset += 1;

    const positions = readClmeshFloatArray(bytes, offset, vertexCount * 3);
    offset += vertexCount * 3 * 4;

    let normals = null;
    if (flags & 0x1) {
      normals = readClmeshFloatArray(bytes, offset, vertexCount * 3);
      offset += vertexCount * 3 * 4;
    }

    let uvs = null;
    if (flags & 0x2) {
      uvs = readClmeshFloatArray(bytes, offset, vertexCount * 2);
      offset += vertexCount * 2 * 4;
    }

    const indices = readClmeshUintArray(bytes, offset, indexCount);
    offset += indexCount * 4;

    meshes.push({ name, materialName, positions, normals, uvs, indices });
  }

  return meshes;
}

function readClmeshMagic(bytes, offset) {
  if (offset + 4 > bytes.length) return "";
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function readClmeshString(view, bytes, decoder, getOffset, setOffset) {
  let offset = getOffset();
  if (offset + 2 > bytes.length) return "";
  const length = view.getUint16(offset, true);
  offset += 2;
  const end = offset + length;
  if (end > bytes.length) {
    setOffset(bytes.length);
    return "";
  }
  const value = decoder.decode(bytes.subarray(offset, end));
  setOffset(end);
  return value;
}

function readClmeshFloatArray(bytes, offset, count) {
  const length = count * 4;
  if (offset + length > bytes.length) {
    throw new Error("Mesh cache is truncated.");
  }
  return new Float32Array(bytes.buffer, bytes.byteOffset + offset, count);
}

function readClmeshUintArray(bytes, offset, count) {
  const length = count * 4;
  if (offset + length > bytes.length) {
    throw new Error("Mesh cache is truncated.");
  }
  return new Uint32Array(bytes.buffer, bytes.byteOffset + offset, count);
}

function getMeshList(object) {
  if (!object) return [];
  if (object.userData?.meshList) return object.userData.meshList;
  const meshes = [];
  object.traverse((child) => {
    if (child.isMesh) meshes.push(child);
  });
  object.userData.meshList = meshes;
  return meshes;
}

function getOrCreateAppliedMaterial(mesh, color) {
  if (mesh.userData.appliedMaterial) return mesh.userData.appliedMaterial;
  
  const baseMat = mesh.userData.baseMaterial || mesh.material;
  const baseRoughness = baseMat.userData?.baseRoughness ?? baseMat.roughness ?? 0.6;
  const metalness = baseMat.metalness ?? 0.2;

  const material = new THREE.MeshStandardMaterial({
    color,
    map: null,
    side: THREE.FrontSide,
    metalness,
    roughness: baseRoughness,
  });
  material.userData.baseRoughness = baseRoughness;
  setupLiveryShader(material);
  mesh.userData.appliedMaterial = material;
  return material;
}

function updateAppliedMaterial(material, color, map) {
  material.color.copy(color);
  if (material.map !== map) {
    material.map = map || null;
    material.needsUpdate = true;
  }
}

function applyMaterials(
  object,
  bodyColor,
  texture,
  textureTarget,
  windowTexture,
  windowTextureTarget,
  liveryExteriorOnly,
  textureMode,
  glossiness = 0.5,
) {
  const color = new THREE.Color(bodyColor);
  const vehicleTarget = textureTarget || ALL_TARGET;
  const windowTarget = windowTextureTarget || ALL_TARGET;
  const exteriorOnly = Boolean(liveryExteriorOnly);
  const preferUv2 = textureMode === "livery";
  const meshes = getMeshList(object);

  const glossFactor = 2 - 2 * glossiness;

  for (const child of meshes) {
    if (!child.userData.baseMaterial) {
      child.userData.baseMaterial = child.material;
    }

    const isGlass = isGlassMaterial(child);

    const matchesVehicleRaw = matchesTextureTarget(child, vehicleTarget);
    const matchesVehicle = preferUv2 && isGlass ? false : matchesVehicleRaw;
    const matchesWindow = Boolean(windowTexture) && matchesTextureTarget(child, windowTarget);
    const shouldApply = matchesVehicle || matchesWindow;
    const activeTexture = matchesWindow ? windowTexture : matchesVehicle ? texture : null;
    const preferUv2ForMesh = matchesWindow ? false : preferUv2;

    if (activeTexture && child.geometry) {
      if (!applyTextureUVSet(child.geometry, preferUv2ForMesh)) {
        generateBoxProjectionUVs(child.geometry);
      }
    } else if (!shouldApply && child.geometry) {
      restoreBaseUVs(child.geometry);
    }

    if (exteriorOnly) {
      child.visible = shouldShowExteriorDual(
        child,
        vehicleTarget,
        matchesVehicle,
        windowTarget,
        matchesWindow,
      );
    } else if (!child.visible) {
      child.visible = true;
    }

    if (shouldApply && (activeTexture || matchesVehicle)) {
      const appliedMaterial = getOrCreateAppliedMaterial(child, color);
      updateAppliedMaterial(appliedMaterial, color, activeTexture);
      if (child.material !== appliedMaterial) {
        child.material = appliedMaterial;
      }
      
      const base = appliedMaterial.userData.baseRoughness;
      if (typeof base === "number") {
        appliedMaterial.roughness = Math.min(1.0, Math.max(0.0, base * glossFactor));
      }
      continue;
    }

    if (child.material !== child.userData.baseMaterial) {
      if (child.material !== child.userData.appliedMaterial) {
        disposeMaterial(child.material);
      }
      child.material = child.userData.baseMaterial;
    }

    const base = child.material.userData.baseRoughness;
    if (typeof base === "number") {
      child.material.roughness = Math.min(1.0, Math.max(0.0, base * glossFactor));
    }
  }
}

function getBaseUVs(geometry) {
  if (!geometry) return { uv0: null, uv1: null, uv2: null, uv3: null };
  if (!geometry.userData.baseUv) {
    geometry.userData.baseUv = geometry.attributes.uv || null;
  }
  if (!geometry.userData.baseUv2) {
    geometry.userData.baseUv2 = geometry.attributes.uv2 || null;
  }
  if (!geometry.userData.baseUv3) {
    geometry.userData.baseUv3 = geometry.attributes.uv3 || null;
  }
  if (!geometry.userData.baseUv4) {
    geometry.userData.baseUv4 = geometry.attributes.uv4 || null;
  }
  return {
    uv0: geometry.userData.baseUv,
    uv1: geometry.userData.baseUv2,
    uv2: geometry.userData.baseUv3,
    uv3: geometry.userData.baseUv4,
  };
}

function scoreUVAttribute(attribute) {
  if (!attribute || !attribute.array || attribute.itemSize < 2) return -1;
  const count = Math.min(attribute.count || 0, 2000);
  if (!count) return -1;
  const array = attribute.array;
  const stride = attribute.itemSize;
  let inRange = 0;
  let valid = 0;
  for (let i = 0; i < count; i += 1) {
    const u = array[i * stride];
    const v = array[i * stride + 1];
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    valid += 1;
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) inRange += 1;
  }
  if (!valid) return -1;
  return inRange / valid;
}

function chooseUVAttribute(geometry, preferUv2) {
  const { uv0, uv1, uv2, uv3 } = getBaseUVs(geometry);
  const candidates = [uv0, uv1, uv2, uv3];

  if (preferUv2) {
    for (const index of [1, 2, 3, 0]) {
      if (candidates[index]) return candidates[index];
    }
    return null;
  }

  if (uv0) return uv0;
  if (uv1) return uv1;
  if (uv2) return uv2;
  if (uv3) return uv3;
  return null;
}

function applyTextureUVSet(geometry, preferUv2) {
  if (!geometry) return false;
  const chosen = chooseUVAttribute(geometry, preferUv2);
  if (!chosen) return false;
  if (geometry.attributes.uv !== chosen) {
    geometry.setAttribute("uv", chosen);
    geometry.attributes.uv.needsUpdate = true;
  }
  return true;
}

function restoreBaseUVs(geometry) {
  if (!geometry) return;
  const { uv0 } = getBaseUVs(geometry);
  if (uv0 && geometry.attributes.uv !== uv0) {
    geometry.setAttribute("uv", uv0);
    geometry.attributes.uv.needsUpdate = true;
  }
}

function generateBoxProjectionUVs(geometry) {
  if (!geometry) return;
  if (!geometry.userData) geometry.userData = {};
  if (geometry.userData.boxUvAttribute) {
    if (geometry.attributes.uv !== geometry.userData.boxUvAttribute) {
      geometry.setAttribute("uv", geometry.userData.boxUvAttribute);
      geometry.attributes.uv.needsUpdate = true;
    }
    return;
  }
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  const size = new THREE.Vector3();
  bbox.getSize(size);

  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const uvs = new Float32Array(positions.count * 2);

  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);

    let u, v;

    if (normals) {
      const nx = Math.abs(normals.getX(i));
      const ny = Math.abs(normals.getY(i));
      const nz = Math.abs(normals.getZ(i));

      if (nx >= ny && nx >= nz) {
        u = (z - bbox.min.z) / (size.z || 1);
        v = (y - bbox.min.y) / (size.y || 1);
      } else if (ny >= nx && ny >= nz) {
        u = (x - bbox.min.x) / (size.x || 1);
        v = (z - bbox.min.z) / (size.z || 1);
      } else {
        u = (x - bbox.min.x) / (size.x || 1);
        v = (y - bbox.min.y) / (size.y || 1);
      }
    } else {
      u = (x - bbox.min.x) / (size.x || 1);
      v = (y - bbox.min.y) / (size.y || 1);
    }

    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }

  const attribute = new THREE.BufferAttribute(uvs, 2);
  geometry.userData.boxUvAttribute = attribute;
  geometry.setAttribute("uv", attribute);
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

function ensureMeshLabel(child) {
  if (!child.isMesh) return "";
  const existing = child.userData?.meshLabel;
  if (existing) return existing;
  const name = child.name?.trim();
  if (name) {
    child.userData.meshLabel = name;
    return name;
  }
  const label = `mesh-${child.id}`;
  child.userData.meshLabel = label;
  return label;
}

function getMeshMeta(child) {
  if (!child?.isMesh) {
    return {
      baseMaterial: null,
      meshLabel: "",
      materialNames: [],
      targetSet: new Set(),
      isGlass: false,
    };
  }
  const baseMaterial = child.userData?.baseMaterial || child.material;
  const cached = child.userData?.textureMeta;
  if (cached && cached.baseMaterial === baseMaterial) return cached;

  const meshLabel = ensureMeshLabel(child);
  const materialNames = getMaterialNames(baseMaterial);
  const targetSet = new Set(materialNames.map((name) => `${MATERIAL_TARGET_PREFIX}${name}`));
  targetSet.add(`${MESH_TARGET_PREFIX}${meshLabel}`);
  const labelLower = meshLabel.toLowerCase();
  const isGlass = materialNames.some((name) => {
    const lower = name.toLowerCase();
    return lower.includes("glass") || lower.includes("window") || lower.includes("vehglass");
  }) || labelLower.includes("glass") || labelLower.includes("window");

  const meta = { baseMaterial, meshLabel, materialNames, targetSet, isGlass };
  child.userData.textureMeta = meta;
  return meta;
}

function matchesTextureTarget(child, textureTarget) {
  if (textureTarget === "none") return false;
  if (!textureTarget || textureTarget === ALL_TARGET) return true;
  if (
    textureTarget.startsWith(MATERIAL_TARGET_PREFIX) ||
    textureTarget.startsWith(MESH_TARGET_PREFIX)
  ) {
    const meta = getMeshMeta(child);
    return meta.targetSet.has(textureTarget);
  }
  return true;
}

function isGlassMaterial(child) {
  if (!child.isMesh) return false;
  return getMeshMeta(child).isGlass;
}

function shouldShowExterior(child, textureTarget, matchesTarget) {
  if (matchesTarget && textureTarget !== ALL_TARGET) return true;
  const meta = getMeshMeta(child);
  if (matchesExteriorName(meta.meshLabel)) return true;
  return meta.materialNames.some(matchesExteriorName);
}

function shouldShowExteriorDual(
  child,
  vehicleTarget,
  matchesVehicle,
  windowTarget,
  matchesWindow,
) {
  if (matchesWindow && windowTarget && windowTarget !== ALL_TARGET) return true;
  return shouldShowExterior(child, vehicleTarget, matchesVehicle);
}

function matchesExteriorName(name) {
  if (!name) return false;
  const raw = name.toString().trim().toLowerCase();
  if (!raw) return false;
  const hasInclude = EXTERIOR_INCLUDE_TOKENS.some((token) => raw.includes(token));
  if (hasInclude) return true;
  const hasExclude = EXTERIOR_EXCLUDE_TOKENS.some((token) => raw.includes(token));
  if (hasExclude) return false;
  return false;
}

function collectTextureTargets(object) {
  const materialNames = new Set();
  const meshNames = new Set();
  const meshes = getMeshList(object);

  for (const child of meshes) {
    const baseMaterial = child.userData?.baseMaterial || child.material;
    const names = getMaterialNames(baseMaterial);
    names.forEach((name) => materialNames.add(name));
    meshNames.add(ensureMeshLabel(child));
  }

  const targets = [];
  if (materialNames.size > 0) {
    Array.from(materialNames)
      .sort()
      .forEach((name) => {
        targets.push({ value: `${MATERIAL_TARGET_PREFIX}${name}`, label: `Material: ${name}` });
      });
  } else {
    Array.from(meshNames)
      .sort()
      .forEach((name) => {
        targets.push({ value: `${MESH_TARGET_PREFIX}${name}`, label: `Mesh: ${name}` });
      });
  }

  return targets;
}

function findLiveryTarget(object) {
  let best = null;
  const meshes = getMeshList(object);

  for (const child of meshes) {
    const meta = getMeshMeta(child);
    meta.materialNames.forEach((name) => {
      const score = scoreLiveryName(name);
      if (score <= 0) return;
      const candidate = makeLiveryCandidate(name, "material", score);
      if (isBetterLiveryCandidate(candidate, best)) {
        best = candidate;
      }
    });

    const meshLabel = meta.meshLabel;
    const meshScore = scoreLiveryName(meshLabel);
    if (meshScore > 0) {
      const candidate = makeLiveryCandidate(meshLabel, "mesh", meshScore);
      if (isBetterLiveryCandidate(candidate, best)) {
        best = candidate;
      }
    }
  }

  if (!best) return null;
  return { value: best.value, label: best.label };
}

function findWindowTemplateTarget(object) {
  let best = null;
  const meshes = getMeshList(object);

  for (const child of meshes) {
    const meta = getMeshMeta(child);
    meta.materialNames.forEach((name) => {
      const score = scoreWindowTemplateName(name);
      if (score <= 0) return;
      const candidate = makeLiveryCandidate(name, "material", score);
      if (isBetterLiveryCandidate(candidate, best)) {
        best = candidate;
      }
    });

    const meshLabel = meta.meshLabel;
    const meshScore = scoreWindowTemplateName(meshLabel);
    if (meshScore > 0) {
      const candidate = makeLiveryCandidate(meshLabel, "mesh", meshScore);
      if (isBetterLiveryCandidate(candidate, best)) {
        best = candidate;
      }
    }
  }

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

function scoreLiveryName(name) {
  if (!name) return 0;
  const raw = name.toString().trim().toLowerCase();
  if (!raw) return 0;

  if (raw.includes("vehicle_paint") || raw.includes("carpaint") || raw.includes("car_paint") || raw.includes("car-paint")) return 120;
  if (raw.includes("livery")) return 110;

  if (raw.includes("vehicle_sign") || raw.includes("sign_1") || raw.includes("sign-1") || raw.includes("sign1")) return 95;
  if (raw.includes("sign_2") || raw.includes("sign-2") || raw.includes("sign2")) return 85;
  if (raw.includes("sign_3") || raw.includes("sign-3") || raw.includes("sign3")) return 75;

  if (raw.includes("vehicle_decal")) return 90;

  const tokens = tokenizeName(raw);
  const tokenSet = new Set(tokens);

  if (tokenSet.has("sign") && tokenSet.has("1")) return 95;
  if (tokenSet.has("sign") && tokenSet.has("2")) return 85;
  if (tokenSet.has("sign") && tokenSet.has("3")) return 75;
  if (tokenSet.has("sign")) return 65;

  if (raw.includes("decal") || tokenSet.has("decal") || tokenSet.has("decals")) return 55;
  if (raw.includes("logo") || tokenSet.has("logo") || tokenSet.has("logos")) return 50;
  if (raw.includes("wrap") || tokenSet.has("wrap")) return 45;

  if (raw.startsWith("material_") && !raw.includes("glass") && !raw.includes("tire") && !raw.includes("interior")) return 30;

  return 0;
}

function tokenizeName(raw) {
  return raw.replace(LIVERY_TOKEN_SPLIT, " ").trim().split(" ").filter(Boolean);
}

function makeLiveryCandidate(name, type, baseScore) {
  const isMaterial = type === "material";
  return {
    value: `${isMaterial ? MATERIAL_TARGET_PREFIX : MESH_TARGET_PREFIX}${name}`,
    label: `${isMaterial ? "Material" : "Mesh"}: ${name}`,
    score: baseScore + (isMaterial ? 5 : 0),
    isMaterial,
  };
}

function isBetterLiveryCandidate(candidate, best) {
  if (!best) return true;
  if (candidate.score !== best.score) return candidate.score > best.score;
  if (candidate.isMaterial !== best.isMaterial) return candidate.isMaterial;
  return candidate.label.localeCompare(best.label) < 0;
}

