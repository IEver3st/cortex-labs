import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { TransformControls } from "three/examples/jsm/controls/TransformControls";
import { DDSLoader } from "three/examples/jsm/loaders/DDSLoader";
import { TGALoader } from "three/examples/jsm/loaders/TGALoader";
import { DFFLoader } from "dff-loader";
import { readFile } from "@tauri-apps/plugin-fs";
import { parseYft } from "../lib/yft";

/* ───────── Constants ───────── */
const YDD_SCAN_SETTINGS = {
  scanLimit: Number.POSITIVE_INFINITY,
  scanMaxCandidates: 32,
  preferBestDrawable: true,
};

/* ───────── Helpers (shared with Viewer.jsx) ───────── */

function getFileExtension(path) {
  if (!path) return "";
  const normalized = path.toString();
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot === -1) return "";
  return normalized.slice(lastDot + 1).toLowerCase();
}

function getFileNameWithoutExtension(path) {
  if (!path) return "";
  const parts = path.toString().split(/[\\/]/);
  const filename = parts[parts.length - 1] || "";
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? filename : filename.slice(0, dot);
}

function getTextureMimeType(ext) {
  switch ((ext || "").toLowerCase()) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "bmp": return "image/bmp";
    case "tif": case "tiff": return "image/tiff";
    case "avif": return "image/avif";
    default: return "";
  }
}

function sniffTextureSignature(bytes) {
  if (!bytes || bytes.length < 4) return { kind: "", mime: "" };
  const b0 = bytes[0], b1 = bytes[1], b2 = bytes[2], b3 = bytes[3];
  if (b0 === 0x44 && b1 === 0x44 && b2 === 0x53 && b3 === 0x20) return { kind: "dds", mime: "application/octet-stream" };
  if (b0 === 0x38 && b1 === 0x42 && b2 === 0x50 && b3 === 0x53) return { kind: "psd", mime: "application/octet-stream" };
  if (bytes.length >= 8 && b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return { kind: "png", mime: "image/png" };
  if (bytes.length >= 3 && b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return { kind: "jpeg", mime: "image/jpeg" };
  if (b0 === 0x42 && b1 === 0x4d) return { kind: "bmp", mime: "image/bmp" };
  if ((b0 === 0x49 && b1 === 0x49 && b2 === 0x2a && b3 === 0x00) || (b0 === 0x4d && b1 === 0x4d && b2 === 0x00 && b3 === 0x2a))
    return { kind: "tiff", mime: "image/tiff" };
  return { kind: "", mime: "" };
}

function heightToFootprintRatio(size) {
  if (!size) return Infinity;
  const footprint = Math.max(size.x, size.z);
  if (!Number.isFinite(footprint) || footprint <= 0) return Infinity;
  const ratio = size.y / footprint;
  return Number.isFinite(ratio) ? ratio : Infinity;
}

function maybeAutoFixYftUpAxis(object, initialSize) {
  if (!object) return false;
  const scoreA = heightToFootprintRatio(initialSize);
  if (!Number.isFinite(scoreA) || scoreA <= 1.2) return false;
  const originalQuat = object.quaternion.clone();
  object.rotateX(-Math.PI / 2);
  object.updateMatrixWorld(true);
  const boxB = new THREE.Box3().setFromObject(object);
  const sizeB = new THREE.Vector3();
  boxB.getSize(sizeB);
  const scoreB = heightToFootprintRatio(sizeB);
  object.quaternion.copy(originalQuat);
  object.updateMatrixWorld(true);
  if (!(Number.isFinite(scoreB) && scoreB < scoreA * 0.7 && scoreB <= 1.2)) return false;
  object.rotateX(-Math.PI / 2);
  object.updateMatrixWorld(true);
  object.userData.autoOriented = true;
  return true;
}

function setupLiveryShader(material) {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `
      #ifdef USE_MAP
        vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        #ifdef DECODE_VIDEO_TEXTURE
          sampledDiffuseColor = vec4( mix( pow( sampledDiffuseColor.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), sampledDiffuseColor.rgb * 0.0773993808, vec3( lessThanEqual( sampledDiffuseColor.rgb, vec3( 0.04045 ) ) ) ), sampledDiffuseColor.w );
        #endif
        diffuseColor.rgb = mix(diffuseColor.rgb, sampledDiffuseColor.rgb, sampledDiffuseColor.a);
        diffuseColor.a = 1.0;
      #endif
      `
    );
  };
  material.needsUpdate = true;
}

function buildDrawableObject(drawable, options = {}) {
  const useVertexColors = options.useVertexColors !== false;
  const root = new THREE.Group();
  root.name = drawable.name || "yft";

  drawable.models.forEach((model) => {
    const group = new THREE.Group();
    group.name = model.name || root.name;

    model.meshes.forEach((mesh) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
      if (mesh.normals) geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
      if (mesh.uvs) geometry.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
      if (mesh.uvs2) geometry.setAttribute("uv2", new THREE.BufferAttribute(mesh.uvs2, 2));
      if (mesh.uvs3) geometry.setAttribute("uv3", new THREE.BufferAttribute(mesh.uvs3, 2));
      if (mesh.uvs4) geometry.setAttribute("uv4", new THREE.BufferAttribute(mesh.uvs4, 2));
      const hasVertexColors = Boolean(mesh.colors && useVertexColors);
      if (hasVertexColors) geometry.setAttribute("color", new THREE.BufferAttribute(mesh.colors, 4));
      if (mesh.tangents) geometry.setAttribute("tangent", new THREE.BufferAttribute(mesh.tangents, 4));
      if (mesh.indices) geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));

      const matName = (mesh.materialName || "").toLowerCase();
      const isGlass = matName.includes("glass") || matName.includes("window");
      const isChrome = matName.includes("chrome") || matName.includes("metal");
      const isTire = matName.includes("tire") || matName.includes("rubber");
      const isPaint = matName.includes("paint") || matName.includes("carpaint") || matName.includes("livery");

      let metalness = 0.2, roughness = 0.6, opacity = 1.0, transparent = false;
      if (isGlass) { metalness = 0.0; roughness = 0.1; opacity = 0.3; transparent = true; }
      else if (isChrome) { metalness = 0.9; roughness = 0.1; }
      else if (isTire) { metalness = 0.0; roughness = 0.9; }
      else if (isPaint) { metalness = 0.4; roughness = 0.3; }

      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff, metalness, roughness, opacity, transparent,
        side: THREE.DoubleSide, vertexColors: hasVertexColors,
      });
      material.name = mesh.materialName || "";

      const threeMesh = new THREE.Mesh(geometry, material);
      threeMesh.name = mesh.name || material.name || "mesh";
      if (mesh.textureRefs && Object.keys(mesh.textureRefs).length > 0) {
        threeMesh.userData.textureRefs = mesh.textureRefs;
      }
      group.add(threeMesh);
    });

    if (group.children.length > 0) root.add(group);
  });

  return root;
}

function hasRenderableMeshes(object) {
  if (!object) return false;
  let count = 0;
  object.traverse((child) => {
    if (child.isMesh && child.geometry?.attributes?.position?.count > 0) count += 1;
  });
  return count > 0;
}

function disposeObject(object) {
  object.traverse((child) => {
    if (child.isMesh) {
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose?.());
      else child.material?.dispose?.();
    }
  });
}

/* ───────── Texture loading (simplified from Viewer.jsx) ───────── */
async function loadTextureFromPath(texturePath, textureLoader, renderer) {
  if (!texturePath) return null;

  let bytes = null;
  try { bytes = await readFile(texturePath); } catch { return null; }

  const extension = getFileExtension(texturePath);
  const signature = sniffTextureSignature(bytes);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  const applySettings = (texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    if (!texture.isCompressedTexture) texture.flipY = true;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;
    texture.anisotropy = renderer?.capabilities.getMaxAnisotropy() || 1;
    if (texture.isDataTexture) {
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
    }
  };

  const loadNative = async () => {
    const mime = signature.mime || getTextureMimeType(extension) || "application/octet-stream";
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => textureLoader.load(url, resolve, undefined, reject));
    } finally { URL.revokeObjectURL(url); }
  };

  const loadDds = async () => {
    const loader = new DDSLoader();
    if (typeof loader.parse === "function") return loader.parse(buffer, true);
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
    } finally { URL.revokeObjectURL(url); }
  };

  const loadTga = async () => {
    const loader = new TGALoader();
    if (typeof loader.parse === "function") return loader.parse(buffer);
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
    } finally { URL.revokeObjectURL(url); }
  };

  const loadTiff = async () => {
    const mod = await import("utif");
    const UTIF = mod.default || mod;
    const ifds = UTIF.decode(buffer);
    if (!ifds?.length) throw new Error("TIFF contained no images.");
    UTIF.decodeImage(buffer, ifds[0]);
    const rgba = UTIF.toRGBA8(ifds[0]);
    return new THREE.DataTexture(rgba, ifds[0].width, ifds[0].height, THREE.RGBAFormat);
  };

  const attempts = [];
  const kind = (extension || "").toLowerCase();
  const sigKind = (signature.kind || "").toLowerCase();
  if (kind === "dds" || sigKind === "dds") attempts.push(loadDds);
  if (kind === "tga") attempts.push(loadTga);
  if (kind === "tif" || kind === "tiff" || sigKind === "tif" || sigKind === "tiff") attempts.push(loadTiff);
  attempts.push(loadNative);

  let texture = null;
  for (const attempt of attempts) {
    try { texture = await attempt(); if (texture) break; } catch { /* continue */ }
  }
  if (!texture) return null;
  applySettings(texture);
  return texture;
}

/* ───────── Apply livery texture to all paint-like meshes ───────── */
function applyLiveryToModel(object, bodyColor, texture) {
  if (!object) return;
  const color = new THREE.Color(bodyColor || "#e7ebf0");

  object.traverse((child) => {
    if (!child.isMesh) return;
    if (!child.userData.baseMaterial) child.userData.baseMaterial = child.material;

    const matName = (child.material?.name || child.userData.baseMaterial?.name || "").toLowerCase();
    const isPaint = matName.includes("paint") || matName.includes("carpaint") || matName.includes("livery") ||
      matName.includes("sign") || matName.includes("decal") || matName.includes("body") || matName.includes("wrap");

    if (isPaint && texture) {
      // Prefer UV2 for livery (GTA V convention)
      if (child.geometry?.attributes?.uv2 && child.geometry.attributes.uv !== child.geometry.attributes.uv2) {
        child.geometry.setAttribute("uv", child.geometry.attributes.uv2);
        child.geometry.attributes.uv.needsUpdate = true;
      }

      if (!child.userData.dualMaterial) {
        const mat = new THREE.MeshStandardMaterial({
          color, map: texture, side: THREE.DoubleSide,
          metalness: child.userData.baseMaterial?.metalness ?? 0.4,
          roughness: child.userData.baseMaterial?.roughness ?? 0.3,
        });
        setupLiveryShader(mat);
        mat.name = child.userData.baseMaterial?.name || "";
        child.userData.dualMaterial = mat;
      } else {
        child.userData.dualMaterial.color.copy(color);
        if (child.userData.dualMaterial.map !== texture) {
          child.userData.dualMaterial.map = texture;
          child.userData.dualMaterial.needsUpdate = true;
        }
      }
      if (child.material !== child.userData.dualMaterial) child.material = child.userData.dualMaterial;
    } else if (isPaint) {
      // No texture — just body color
      if (!child.userData.dualMaterial) {
        const mat = new THREE.MeshStandardMaterial({
          color, map: null, side: THREE.DoubleSide,
          metalness: child.userData.baseMaterial?.metalness ?? 0.4,
          roughness: child.userData.baseMaterial?.roughness ?? 0.3,
        });
        mat.name = child.userData.baseMaterial?.name || "";
        child.userData.dualMaterial = mat;
      } else {
        child.userData.dualMaterial.color.copy(color);
        if (child.userData.dualMaterial.map !== null) {
          child.userData.dualMaterial.map = null;
          child.userData.dualMaterial.needsUpdate = true;
        }
      }
      if (child.material !== child.userData.dualMaterial) child.material = child.userData.dualMaterial;
    }
  });
}

/* ───────── Load model file into THREE.Group ───────── */
async function loadModelFile(modelPath) {
  if (!modelPath) return null;

  const extension = getFileExtension(modelPath);
  if (extension === "obj") return null;

  if (extension === "yft" || extension === "ydd") {
    let bytes = null;
    try { bytes = await readFile(modelPath); } catch { return null; }
    const name = getFileNameWithoutExtension(modelPath) || `${extension}_model`;
    let drawable = null;
    try {
      drawable = extension === "ydd" ? parseYft(bytes, name, YDD_SCAN_SETTINGS) : parseYft(bytes, name);
    } catch { return null; }
    if (!drawable?.models?.length) return null;
    const object = buildDrawableObject(drawable, { useVertexColors: false });
    if (!hasRenderableMeshes(object)) return null;
    object.userData.sourceFormat = extension;
    return object;
  }

  if (extension === "dff") {
    let bytes = null;
    try { bytes = await readFile(modelPath); } catch { return null; }
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const loader = new DFFLoader();
    try { return loader.parse(buffer); } catch { return null; }
  }

  return null;
}

/* ───────── Grid floor helper ───────── */
function createFloorGrid() {
  const grid = new THREE.GridHelper(40, 40, 0x333333, 0x222222);
  grid.position.y = -0.01;
  grid.material.opacity = 0.35;
  grid.material.transparent = true;
  grid.userData.isFloor = true;
  return grid;
}

/* ═══════════════════════════════════════════════════════════════════
   DualModelViewer — Experimental multi-model alignment viewer
   ═══════════════════════════════════════════════════════════════════ */

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
  const initialPosARef = useRef(initialPosA);
  const initialPosBRef = useRef(initialPosB);

  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { onModelAErrorRef.current = onModelAError; }, [onModelAError]);
  useEffect(() => { onModelBErrorRef.current = onModelBError; }, [onModelBError]);
  useEffect(() => { onModelALoadingRef.current = onModelALoading; }, [onModelALoading]);
  useEffect(() => { onModelBLoadingRef.current = onModelBLoading; }, [onModelBLoading]);
  useEffect(() => { selectedSlotRef.current = selectedSlot; }, [selectedSlot]);
  useEffect(() => { onPositionChangeRef.current = onPositionChange; }, [onPositionChange]);

  const requestRender = useCallback(() => { requestRenderRef.current?.(); }, []);

  /* ─── Scene setup ─── */
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

    // Wheel-while-dragging fix
    const wheelWhileDragging = (event) => {
      if (!controls.enabled || !controls.enableZoom) return;
      if (controls.state === -1) return;
      event.preventDefault();
      controls._handleMouseWheel(controls._customWheelEvent(event));
      requestRenderRef.current?.();
    };
    renderer.domElement.addEventListener("wheel", wheelWhileDragging, { passive: false });

    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(3.5, 4.5, 2.5);
    const rim = new THREE.DirectionalLight(0xffffff, 0.35);
    rim.position.set(-3, 2, -2.2);
    scene.add(ambient, key, rim);

    // Floor grid
    scene.add(createFloorGrid());

    renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
    containerRef.current.appendChild(renderer.domElement);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;

    // Report positions back to parent for session persistence
    const reportPositions = () => {
      const posA = modelARef.current ? [modelARef.current.position.x, modelARef.current.position.y, modelARef.current.position.z] : [0, 0, 0];
      const posB = modelBRef.current ? [modelBRef.current.position.x, modelBRef.current.position.y, modelBRef.current.position.z] : [0, 0, 3];
      onPositionChangeRef.current?.(posA, posB);
    };

    // TransformControls for slot A
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

    // TransformControls for slot B
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
        // Compute bounding box of model A to snap B right behind it
        const boxA = new THREE.Box3().setFromObject(modelARef.current);
        const sizeA = new THREE.Vector3();
        boxA.getSize(sizeA);
        const centerA = new THREE.Vector3();
        boxA.getCenter(centerA);

        const boxB = new THREE.Box3().setFromObject(modelBRef.current);
        const sizeB = new THREE.Vector3();
        boxB.getSize(sizeB);

        // Place B behind A on the Z axis (GTA vehicles face -Z)
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

  /* ─── Background color ─── */
  useEffect(() => {
    if (!rendererRef.current) return;
    rendererRef.current.setClearColor(new THREE.Color(backgroundColor || "#141414"), 1);
    requestRender();
  }, [backgroundColor]);

  /* ─── WASD camera movement ─── */
  const wasdStateRef = useRef({ forward: false, back: false, left: false, right: false, up: false, down: false, boost: false });
  const wasdFrameRef = useRef(0);

  useEffect(() => {
    if (!sceneReady || !cameraRef.current || !controlsRef.current) return;
    const state = wasdStateRef.current;
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    const up = new THREE.Vector3(0, 1, 0);
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();

    const shouldIgnore = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return true;
      const t = e.target;
      if (t instanceof Element && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return true;
      return false;
    };
    const isActive = () => state.forward || state.back || state.left || state.right || state.up || state.down;
    const stopLoop = () => { if (wasdFrameRef.current) { cancelAnimationFrame(wasdFrameRef.current); wasdFrameRef.current = 0; } };
    let lastTime = 0;
    const tick = (time) => {
      const delta = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;
      if (!isActive()) { stopLoop(); return; }
      const distance = fitRef.current?.distance || 4;
      const speed = Math.max(distance * 0.6, 0.6) * (state.boost ? 2.0 : 1.0);
      camera.getWorldDirection(forward); forward.y = 0;
      if (forward.lengthSq() === 0) forward.set(0, 0, -1);
      forward.normalize(); right.crossVectors(forward, up).normalize();
      const move = new THREE.Vector3();
      if (state.forward) move.add(forward);
      if (state.back) move.addScaledVector(forward, -1);
      if (state.right) move.add(right);
      if (state.left) move.addScaledVector(right, -1);
      if (state.up) move.add(up);
      if (state.down) move.addScaledVector(up, -1);
      if (move.lengthSq() > 0) { move.normalize().multiplyScalar(speed * delta); camera.position.add(move); controls.target.add(move); controls.update(); requestRenderRef.current?.(); }
      wasdFrameRef.current = requestAnimationFrame(tick);
    };
    const startLoop = () => { if (wasdFrameRef.current) return; lastTime = performance.now(); wasdFrameRef.current = requestAnimationFrame(tick); };
    const setKey = (key, pressed) => {
      switch (key) {
        case "KeyW": state.forward = pressed; return true;
        case "KeyS": state.back = pressed; return true;
        case "KeyA": state.left = pressed; return true;
        case "KeyD": state.right = pressed; return true;
        case "KeyQ": state.down = pressed; return true;
        case "KeyE": state.up = pressed; return true;
        case "ShiftLeft": case "ShiftRight": state.boost = pressed; return true;
        default: return false;
      }
    };
    const onDown = (e) => { if (shouldIgnore(e) || !e.code) return; const was = isActive(); if (setKey(e.code, true)) { e.preventDefault(); if (!was && isActive()) startLoop(); } };
    const onUp = (e) => { if (!e.code) return; if (setKey(e.code, false) && !isActive()) stopLoop(); };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => { window.removeEventListener("keydown", onDown); window.removeEventListener("keyup", onUp); stopLoop(); Object.assign(state, { forward: false, back: false, left: false, right: false, up: false, down: false, boost: false }); };
  }, [sceneReady]);

  /* ─── Gizmo visibility sync based on selected slot and toggle ─── */
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

  /* ─── Load model A ─── */
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

        // Normals
        object.traverse((c) => {
          if (!c.isMesh || !c.geometry) return;
          const n = c.geometry.attributes?.normal;
          if (!n || n.count === 0) { c.geometry.computeVertexNormals(); c.geometry.normalizeNormals?.(); }
        });

        // Remove old model A
        if (modelARef.current) {
          gizmoARef.current?.detach();
          sceneRef.current.remove(modelARef.current);
          disposeObject(modelARef.current);
        }

        // Auto-fix axis
        const box = new THREE.Box3().setFromObject(object);
        const size = new THREE.Vector3();
        box.getSize(size);
        if (object.userData.sourceFormat === "yft") {
          maybeAutoFixYftUpAxis(object, size);
        }

        // Apply initial position from session restore
        const initA = initialPosARef.current;
        if (initA && Array.isArray(initA) && initA.length === 3) {
          object.position.set(initA[0], initA[1], initA[2]);
        }

        sceneRef.current.add(object);
        modelARef.current = object;
        gizmoARef.current?.attach(object);
        setModelAVersion((v) => v + 1);

        // Refit camera to encompass both models
        refitCamera();
      } catch (err) {
        if (!cancelled) onModelAErrorRef.current?.(`Model A load failed: ${err?.message || "Unknown error"}`);
      } finally {
        if (!cancelled) onModelALoadingRef.current?.(false);
      }
    })();

    return () => { cancelled = true; };
  }, [modelAPath, sceneReady]);

  /* ─── Load model B ─── */
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

        object.traverse((c) => {
          if (!c.isMesh || !c.geometry) return;
          const n = c.geometry.attributes?.normal;
          if (!n || n.count === 0) { c.geometry.computeVertexNormals(); c.geometry.normalizeNormals?.(); }
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

        // Apply initial position from session restore, or offset behind A
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

  /* ─── Load & apply texture A ─── */
  useEffect(() => {
    if (!sceneReady) return;
    let cancelled = false;

    (async () => {
      if (!textureAPath) {
        if (textureARef.current) { textureARef.current.dispose?.(); textureARef.current = null; }
        if (modelARef.current) { applyLiveryToModel(modelARef.current, bodyColor, null); requestRender(); }
        return;
      }
      const tex = await loadTextureFromPath(textureAPath, textureLoader, rendererRef.current);
      if (cancelled) return;
      if (textureARef.current && textureARef.current !== tex) textureARef.current.dispose?.();
      textureARef.current = tex;
      if (modelARef.current) { applyLiveryToModel(modelARef.current, bodyColor, tex); requestRender(); }
    })();

    return () => { cancelled = true; };
  }, [textureAPath, textureAReloadToken, sceneReady, modelAVersion]);

  /* ─── Load & apply texture B ─── */
  useEffect(() => {
    if (!sceneReady) return;
    let cancelled = false;

    (async () => {
      if (!textureBPath) {
        if (textureBRef.current) { textureBRef.current.dispose?.(); textureBRef.current = null; }
        if (modelBRef.current) { applyLiveryToModel(modelBRef.current, bodyColor, null); requestRender(); }
        return;
      }
      const tex = await loadTextureFromPath(textureBPath, textureLoader, rendererRef.current);
      if (cancelled) return;
      if (textureBRef.current && textureBRef.current !== tex) textureBRef.current.dispose?.();
      textureBRef.current = tex;
      if (modelBRef.current) { applyLiveryToModel(modelBRef.current, bodyColor, tex); requestRender(); }
    })();

    return () => { cancelled = true; };
  }, [textureBPath, textureBReloadToken, sceneReady, modelBVersion]);

  /* ─── Body color changes ─── */
  useEffect(() => {
    if (!sceneReady) return;
    if (modelARef.current) applyLiveryToModel(modelARef.current, bodyColor, textureARef.current);
    if (modelBRef.current) applyLiveryToModel(modelBRef.current, bodyColor, textureBRef.current);
    requestRender();
  }, [bodyColor, sceneReady]);

  /* ─── Camera refit utility ─── */
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
