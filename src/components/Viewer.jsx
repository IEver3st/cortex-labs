import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader";
import { DFFLoader } from "dff-loader";
import { readFile, readTextFile } from "@tauri-apps/plugin-fs";
import { parseYft } from "../lib/yft";

const presets = {
  // Most GTA/FiveM vehicle assets treat -Z as "forward".
  // Our presets define camera positions around the model, so "front" should be on -Z.
  front: new THREE.Vector3(0, 0.12, -1),
  side: new THREE.Vector3(1, 0.1, 0),
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
const objSignature = /^(?:#|mtllib|o|g|v|vn|vt|f)\s/m;

const looksLikeObj = (text) => objSignature.test(text);

const decodeObjBytes = (bytes) => {
  const utf8 = new TextDecoder("utf-8");
  const utf16le = new TextDecoder("utf-16le");
  let text = utf8.decode(bytes);
  if (text.includes("\u0000") || !looksLikeObj(text)) {
    const decoded = utf16le.decode(bytes);
    if (looksLikeObj(decoded)) return decoded;
    text = decoded;
  }
  return text;
};

export default function Viewer({
  modelPath,
  texturePath,
  bodyColor,
  backgroundColor,
  textureReloadToken,
  textureTarget,
  textureMode = "everything",
  liveryExteriorOnly = false,
  flipTextureY = true,
  onReady,
  onModelInfo,
  onModelError,
  onModelLoading,
  onTextureReload,
  onTextureError,
}) {
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const modelRef = useRef(null);
  const textureRef = useRef(null);
  const fitRef = useRef({ center: new THREE.Vector3(), distance: 4 });
  const [sceneReady, setSceneReady] = useState(false);
  const onReadyRef = useRef(onReady);
  const onModelInfoRef = useRef(onModelInfo);
  const onModelErrorRef = useRef(onModelError);
  const onModelLoadingRef = useRef(onModelLoading);
  const onTextureErrorRef = useRef(onTextureError);

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
  }, [onTextureError]);

  useEffect(() => {
    if (!containerRef.current) return;

    const scene = new THREE.Scene();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
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

    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(3.5, 4.5, 2.5);
    const rim = new THREE.DirectionalLight(0xffffff, 0.35);
    rim.position.set(-3, 2, -2.2);

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

    const resize = () => {
      if (!containerRef.current) return;
      const { clientWidth, clientHeight } = containerRef.current;
      if (clientWidth === 0 || clientHeight === 0) return;
      renderer.setSize(clientWidth, clientHeight);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(containerRef.current);
    resize();

    let frameId = 0;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

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
      },
      reset: () => {
        const { center, distance } = fitRef.current;
        camera.position.set(center.x + distance, center.y + distance * 0.2, center.z + distance);
        controls.target.copy(center);
        controls.update();
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
      },
    });

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      setSceneReady(false);
    };
  }, []);

  useEffect(() => {
    if (!rendererRef.current) return;
    rendererRef.current.setClearColor(new THREE.Color(backgroundColor || "#141414"), 1);
  }, [backgroundColor]);

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
          object = buildDrawableObject(drawable);
          if (!hasRenderableMeshes(object)) {
            onModelErrorRef.current?.("YFT parsed but no mesh data was generated.");
            return;
          }
          object.userData.sourceFormat = "yft";
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
          let text = "";
          try {
            text = await readTextFile(modelPath);
          } catch {
            text = "";
          }
          if (!text || text.includes("\u0000") || !looksLikeObj(text)) {
            try {
              const bytes = await readFile(modelPath);
              text = decodeObjBytes(bytes);
            } catch {
              return;
            }
          }
          if (cancelled) return;
          const loader = new OBJLoader();
          try {
            object = loader.parse(text);
          } catch {
            return;
          }
        }

        if (!object) {
          onModelErrorRef.current?.("Model loaded with no geometry.");
          return;
        }
        object.traverse((child) => {
          if (!child.isMesh) return;
          child.castShadow = false;
          child.receiveShadow = false;
          if (!child.geometry) return;
          const normalAttr = child.geometry.attributes?.normal;
          if (!normalAttr || normalAttr.count === 0) {
            child.geometry.computeVertexNormals();
            child.geometry.normalizeNormals?.();
          }
        });

        if (modelRef.current) {
          sceneRef.current.remove(modelRef.current);
          disposeObject(modelRef.current);
        }

        modelRef.current = object;
        sceneRef.current.add(object);

        const targets = collectTextureTargets(object);
        const liveryTarget = findLiveryTarget(object);
        onModelInfoRef.current?.({
          targets,
          liveryTarget: liveryTarget?.value || "",
          liveryLabel: liveryTarget?.label || "",
        });

        const box = new THREE.Box3().setFromObject(object);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

        // YFTs can arrive in a Z-up coordinate space (GTA/RAGE) while our viewer is Y-up.
        // When that happens the model looks like it's pitched upward on X ("standing").
        // Auto-correct by testing a -90deg X rotation and only applying it if it meaningfully
        // reduces the model's height-to-footprint ratio.
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

        applyMaterial(object, resolvedBodyColor, textureRef.current, textureTarget, liveryExteriorOnly, textureMode);
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
    applyMaterial(modelRef.current, resolvedBodyColor, textureRef.current, textureTarget, liveryExteriorOnly, textureMode);
  }, [resolvedBodyColor, textureTarget, liveryExteriorOnly, textureMode]);

  useEffect(() => {
    let cancelled = false;

    const clearTexture = () => {
      if (textureRef.current) {
        textureRef.current.dispose();
        textureRef.current = null;
      }
      if (modelRef.current) {
        applyMaterial(modelRef.current, resolvedBodyColor, null, textureTarget, liveryExteriorOnly, textureMode);
      }
      onTextureErrorRef.current?.("");
    };

    if (!texturePath) {
      clearTexture();
      return;
    }

    const loadTexture = async () => {
      const extension = getFileExtension(texturePath);
      if (extension === "psd") {
        onTextureErrorRef.current?.("PSD files are not supported. Export to PNG or JPG first.");
        return;
      }
      let bytes = null;
      try {
        bytes = await readFile(texturePath);
      } catch {
        return;
      }
      if (cancelled) return;
      const blob = new Blob([bytes], { type: "image/png" });
      const url = URL.createObjectURL(blob);
      textureLoader.load(
        url,
        (texture) => {
          if (cancelled) {
            texture.dispose();
            URL.revokeObjectURL(url);
            return;
          }
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.flipY = flipTextureY;
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.needsUpdate = true;
          texture.anisotropy = rendererRef.current?.capabilities.getMaxAnisotropy() || 1;
          textureRef.current?.dispose();
          textureRef.current = texture;
          URL.revokeObjectURL(url);
          if (modelRef.current) {
            applyMaterial(modelRef.current, resolvedBodyColor, texture, textureTarget, liveryExteriorOnly, textureMode);
          }
          onTextureErrorRef.current?.("");
          onTextureReload?.();
        },
        undefined,
        () => {
          URL.revokeObjectURL(url);
          onTextureErrorRef.current?.("Texture failed to load. Use PNG, JPG, or WebP.");
        },
      );
    };

    loadTexture();

    return () => {
      cancelled = true;
    };
  }, [
    texturePath,
    textureReloadToken,
    resolvedBodyColor,
    textureLoader,
    onTextureReload,
    textureTarget,
    liveryExteriorOnly,
    flipTextureY,
    textureMode,
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
      side: THREE.DoubleSide,
    });
    material.name = mesh.materialName || "";

    const threeMesh = new THREE.Mesh(geometry, material);
    threeMesh.name = mesh.name || material.name || "mesh";
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

function applyMaterial(object, bodyColor, texture, textureTarget, liveryExteriorOnly, textureMode) {
  const color = new THREE.Color(bodyColor);
  const target = textureTarget || ALL_TARGET;
  const exteriorOnly = Boolean(liveryExteriorOnly);
  const preferUv2 = textureMode === "livery";

  object.traverse((child) => {
    if (!child.isMesh) return;

    if (!child.userData.baseMaterial) {
      child.userData.baseMaterial = child.material;
    }

    ensureMeshLabel(child);
    const shouldApply = matchesTextureTarget(child, target);
    if (texture && shouldApply && child.geometry) {
      if (!applyTextureUVSet(child.geometry, preferUv2)) {
        generateBoxProjectionUVs(child.geometry);
      }
    } else if (!shouldApply && child.geometry) {
      restoreBaseUVs(child.geometry);
    }
    if (exteriorOnly) {
      const shouldShow = shouldShowExterior(child, target, shouldApply);
      child.visible = shouldShow;
    } else if (!child.visible) {
      child.visible = true;
    }

    if (shouldApply) {
      if (child.material === child.userData.appliedMaterial) {
        child.material.color.copy(color);
        child.material.map = texture || null;
        child.material.needsUpdate = true;
        return;
      }

      if (child.material && child.material !== child.userData.baseMaterial) {
        disposeMaterial(child.material);
      }

      const appliedMaterial = new THREE.MeshStandardMaterial({
        color,
        map: texture || null,
        side: THREE.DoubleSide,
        metalness: 0.2,
        roughness: 0.6,
      });
      child.material = appliedMaterial;
      child.userData.appliedMaterial = appliedMaterial;
      return;
    }

    if (child.material !== child.userData.baseMaterial) {
      disposeMaterial(child.material);
      child.material = child.userData.baseMaterial;
      child.userData.appliedMaterial = null;
    }
  });
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
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  const size = new THREE.Vector3();
  bbox.getSize(size);

  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const uvs = new Float32Array(positions.count * 2);

  // Use triplanar/box projection based on face normals
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);

    let u, v;

    if (normals) {
      const nx = Math.abs(normals.getX(i));
      const ny = Math.abs(normals.getY(i));
      const nz = Math.abs(normals.getZ(i));

      // Project based on dominant normal direction
      if (nx >= ny && nx >= nz) {
        // X-facing: project onto YZ plane
        u = (z - bbox.min.z) / (size.z || 1);
        v = (y - bbox.min.y) / (size.y || 1);
      } else if (ny >= nx && ny >= nz) {
        // Y-facing: project onto XZ plane
        u = (x - bbox.min.x) / (size.x || 1);
        v = (z - bbox.min.z) / (size.z || 1);
      } else {
        // Z-facing: project onto XY plane
        u = (x - bbox.min.x) / (size.x || 1);
        v = (y - bbox.min.y) / (size.y || 1);
      }
    } else {
      // Fallback: simple XY projection
      u = (x - bbox.min.x) / (size.x || 1);
      v = (y - bbox.min.y) / (size.y || 1);
    }

    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }

  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
}

function disposeObject(object) {
  object.traverse((child) => {
    if (child.isMesh) {
      if (child.geometry) child.geometry.dispose?.();
      if (child.material) disposeMaterial(child.material);
      if (child.userData?.baseMaterial && child.userData.baseMaterial !== child.material) {
        disposeMaterial(child.userData.baseMaterial);
      }
      if (
        child.userData?.appliedMaterial &&
        child.userData.appliedMaterial !== child.material &&
        child.userData.appliedMaterial !== child.userData.baseMaterial
      ) {
        disposeMaterial(child.userData.appliedMaterial);
      }
    }
  });
}

function disposeMaterial(material) {
  if (!material) return;
  if (Array.isArray(material)) {
    material.forEach((mat) => mat.dispose?.());
  } else {
    material.dispose?.();
  }
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

function matchesTextureTarget(child, textureTarget) {
  if (!textureTarget || textureTarget === ALL_TARGET) return true;
  if (textureTarget.startsWith(MATERIAL_TARGET_PREFIX)) {
    const targetName = textureTarget.slice(MATERIAL_TARGET_PREFIX.length);
    const baseMaterial = child.userData?.baseMaterial || child.material;
    const names = getMaterialNames(baseMaterial);
    return names.includes(targetName);
  }
  if (textureTarget.startsWith(MESH_TARGET_PREFIX)) {
    const targetName = textureTarget.slice(MESH_TARGET_PREFIX.length);
    const label = ensureMeshLabel(child);
    return label === targetName;
  }
  return true;
}

function shouldShowExterior(child, textureTarget, matchesTarget) {
  if (matchesTarget && textureTarget !== ALL_TARGET) return true;
  const label = ensureMeshLabel(child);
  if (matchesExteriorName(label)) return true;
  const baseMaterial = child.userData?.baseMaterial || child.material;
  const names = getMaterialNames(baseMaterial);
  return names.some(matchesExteriorName);
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

  object.traverse((child) => {
    if (!child.isMesh) return;
    const names = getMaterialNames(child.material);
    names.forEach((name) => materialNames.add(name));
    meshNames.add(ensureMeshLabel(child));
  });

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

  object.traverse((child) => {
    if (!child.isMesh) return;

    const materialNames = getMaterialNames(child.material);
    materialNames.forEach((name) => {
      const score = scoreLiveryName(name);
      if (score <= 0) return;
      const candidate = makeLiveryCandidate(name, "material", score);
      if (isBetterLiveryCandidate(candidate, best)) {
        best = candidate;
      }
    });

    const meshLabel = ensureMeshLabel(child);
    const meshScore = scoreLiveryName(meshLabel);
    if (meshScore > 0) {
      const candidate = makeLiveryCandidate(meshLabel, "mesh", meshScore);
      if (isBetterLiveryCandidate(candidate, best)) {
        best = candidate;
      }
    }
  });

  if (!best) return null;
  return { value: best.value, label: best.label };
}

function scoreLiveryName(name) {
  if (!name) return 0;
  const raw = name.toString().trim().toLowerCase();
  if (!raw) return 0;

  // Vehicle paint materials (highest priority for livery application)
  if (raw.includes("vehicle_paint") || raw.includes("carpaint") || raw.includes("car_paint") || raw.includes("car-paint")) return 120;
  if (raw.includes("livery")) return 110;

  // Sign materials (common for sponsor decals)
  if (raw.includes("vehicle_sign") || raw.includes("sign_1") || raw.includes("sign-1") || raw.includes("sign1")) return 95;
  if (raw.includes("sign_2") || raw.includes("sign-2") || raw.includes("sign2")) return 85;
  if (raw.includes("sign_3") || raw.includes("sign-3") || raw.includes("sign3")) return 75;

  // Vehicle decal material
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

  // Generic material hash patterns that might be paint
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

function getFileExtension(path) {
  if (!path) return "";
  const normalized = path.toString();
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot === -1) return "";
  return normalized.slice(lastDot + 1).toLowerCase();
}

function getFileNameWithoutExtension(path) {
  if (!path) return "";
  const normalized = path.toString();
  const parts = normalized.split(/[\\/]/);
  const filename = parts[parts.length - 1] || "";
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? filename : filename.slice(0, dot);
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
  // Only correct when the model is obviously "standing" tall (pitched on X).
  // This keeps thin/vertical parts from being flattened accidentally.
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

  const isMeaningfullyBetter = Number.isFinite(scoreB) && scoreB < scoreA * 0.7;
  const isNoLongerStanding = scoreB <= 1.2;

  if (!isMeaningfullyBetter || !isNoLongerStanding) return false;

  object.rotateX(-Math.PI / 2);
  object.updateMatrixWorld(true);
  object.userData.autoOriented = true;
  return true;
}

function buildDrawableObject(drawable) {
  const root = new THREE.Group();
  root.name = drawable.name || "yft";

  drawable.models.forEach((model) => {
    const group = new THREE.Group();
    group.name = model.name || root.name;

    model.meshes.forEach((mesh) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));

      if (mesh.normals) {
        geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
      }

      if (mesh.uvs) {
        geometry.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
        // Debug: log UV range for first mesh
        if (mesh.uvs.length > 0) {
          let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
          for (let i = 0; i < mesh.uvs.length; i += 2) {
            minU = Math.min(minU, mesh.uvs[i]);
            maxU = Math.max(maxU, mesh.uvs[i]);
            minV = Math.min(minV, mesh.uvs[i + 1]);
            maxV = Math.max(maxV, mesh.uvs[i + 1]);
          }
          console.log(`[YFT] Mesh "${mesh.name || mesh.materialName}" UV range: U=[${minU.toFixed(3)}, ${maxU.toFixed(3)}] V=[${minV.toFixed(3)}, ${maxV.toFixed(3)}]`);
        }
      } else {
        console.log(`[YFT] Mesh "${mesh.name || mesh.materialName}" has no UVs`);
      }

      if (mesh.uvs2) {
        geometry.setAttribute("uv2", new THREE.BufferAttribute(mesh.uvs2, 2));
      }

      if (mesh.uvs3) {
        geometry.setAttribute("uv3", new THREE.BufferAttribute(mesh.uvs3, 2));
      }

      if (mesh.uvs4) {
        geometry.setAttribute("uv4", new THREE.BufferAttribute(mesh.uvs4, 2));
      }

      if (mesh.colors) {
        geometry.setAttribute("color", new THREE.BufferAttribute(mesh.colors, 4));
      }

      if (mesh.tangents) {
        geometry.setAttribute("tangent", new THREE.BufferAttribute(mesh.tangents, 4));
      }

      if (mesh.indices) {
        geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      }

      const matName = (mesh.materialName || "").toLowerCase();
      const isGlass = matName.includes("glass") || matName.includes("window");
      const isChrome = matName.includes("chrome") || matName.includes("metal");
      const isTire = matName.includes("tire") || matName.includes("rubber");
      const isPaint = matName.includes("paint") || matName.includes("carpaint") || matName.includes("livery");

      let metalness = 0.2;
      let roughness = 0.6;
      let opacity = 1.0;
      let transparent = false;

      if (isGlass) {
        metalness = 0.0;
        roughness = 0.1;
        opacity = 0.3;
        transparent = true;
      } else if (isChrome) {
        metalness = 0.9;
        roughness = 0.1;
      } else if (isTire) {
        metalness = 0.0;
        roughness = 0.9;
      } else if (isPaint) {
        metalness = 0.4;
        roughness = 0.3;
      }

      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        metalness,
        roughness,
        opacity,
        transparent,
        side: THREE.DoubleSide,
        vertexColors: mesh.colors ? true : false,
      });
      material.name = mesh.materialName || "";

      const threeMesh = new THREE.Mesh(geometry, material);
      threeMesh.name = mesh.name || material.name || "mesh";
      threeMesh.userData.materialType = isPaint ? "paint" : isGlass ? "glass" : isChrome ? "chrome" : "default";

      group.add(threeMesh);
    });

    if (group.children.length > 0) {
      root.add(group);
    }
  });

  return root;
}

function hasRenderableMeshes(object) {
  if (!object) return false;
  let count = 0;
  object.traverse((child) => {
    if (child.isMesh && child.geometry?.attributes?.position?.count > 0) {
      count += 1;
    }
  });
  return count > 0;
}
