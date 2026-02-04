import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader";
import { readFile, readTextFile } from "@tauri-apps/plugin-fs";

const presets = {
  front: new THREE.Vector3(0, 0.12, 1),
  side: new THREE.Vector3(1, 0.1, 0),
  angle: new THREE.Vector3(0.8, 0.12, 0.8),
  top: new THREE.Vector3(0, 1, 0),
};

const defaultBody = "#dfe4ea";
const ALL_TARGET = "all";
const MATERIAL_TARGET_PREFIX = "material:";
const MESH_TARGET_PREFIX = "mesh:";
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
  flipTextureY = true,
  onReady,
  onModelInfo,
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
  const onReadyRef = useRef(onReady);
  const onModelInfoRef = useRef(onModelInfo);
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
    });

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    if (!rendererRef.current) return;
    rendererRef.current.setClearColor(new THREE.Color(backgroundColor || "#141414"), 1);
  }, [backgroundColor]);

  useEffect(() => {
    if (!modelPath || !sceneRef.current) return;

    let cancelled = false;

    const loadModel = async () => {
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
      let object = null;
      try {
        object = loader.parse(text);
      } catch {
        return;
      }
      if (!object) return;
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
      onModelInfoRef.current?.({ targets });

      const box = new THREE.Box3().setFromObject(object);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      const maxDim = Math.max(size.x, size.y, size.z);
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

      applyMaterial(object, resolvedBodyColor, textureRef.current, textureTarget);
    };

    loadModel();

    return () => {
      cancelled = true;
    };
  }, [modelPath]);

  useEffect(() => {
    if (!modelRef.current) return;
    applyMaterial(modelRef.current, resolvedBodyColor, textureRef.current, textureTarget);
  }, [resolvedBodyColor, textureTarget]);

  useEffect(() => {
    let cancelled = false;

    const clearTexture = () => {
      if (textureRef.current) {
        textureRef.current.dispose();
        textureRef.current = null;
      }
      if (modelRef.current) {
        applyMaterial(modelRef.current, resolvedBodyColor, null, textureTarget);
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
            applyMaterial(modelRef.current, resolvedBodyColor, texture, textureTarget);
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
    flipTextureY,
  ]);

  return <div ref={containerRef} className="h-full w-full" />;
}

function applyMaterial(object, bodyColor, texture, textureTarget) {
  const color = new THREE.Color(bodyColor);
  const target = textureTarget || ALL_TARGET;

  object.traverse((child) => {
    if (!child.isMesh) return;

    if (!child.userData.baseMaterial) {
      child.userData.baseMaterial = child.material;
    }

    // Generate UVs if missing and texture is being applied
    if (texture && child.geometry && !child.geometry.attributes.uv) {
      generateBoxProjectionUVs(child.geometry);
    }

    ensureMeshLabel(child);
    const shouldApply = matchesTextureTarget(child, target);

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

function getFileExtension(path) {
  if (!path) return "";
  const normalized = path.toString();
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot === -1) return "";
  return normalized.slice(lastDot + 1).toLowerCase();
}
