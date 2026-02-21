import * as THREE from "three";
import { DDSLoader } from "three/examples/jsm/loaders/DDSLoader";
import { TGALoader } from "three/examples/jsm/loaders/TGALoader";
import { DFFLoader } from "dff-loader";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { parseYft } from "./yft";
import { parseDDS } from "./dds";

export const YDD_SCAN_SETTINGS = {
  scanLimit: Number.POSITIVE_INFINITY,
  scanMaxCandidates: 32,
  preferBestDrawable: true,
};

export function getFileExtension(path) {
  if (!path) return "";
  const normalized = path.toString();
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot === -1) return "";
  return normalized.slice(lastDot + 1).toLowerCase();
}

export function getFileNameWithoutExtension(path) {
  if (!path) return "";
  const parts = path.toString().split(/[\\/]/);
  const filename = parts[parts.length - 1] || "";
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? filename : filename.slice(0, dot);
}

export function getTextureMimeType(extension) {
  switch ((extension || "").toLowerCase()) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "bmp": return "image/bmp";
    case "tif": case "tiff": return "image/tiff";
    case "avif": return "image/avif";
    case "ai": return "application/pdf";
    case "pdn": return "application/x-pdn";
    case "svg": return "image/svg+xml";
    case "ico": return "image/x-icon";
    default: return "";
  }
}

export function sniffTextureSignature(bytes) {
  if (!bytes || bytes.length < 4) return { kind: "", mime: "" };

  const b0 = bytes[0];
  const b1 = bytes[1];
  const b2 = bytes[2];
  const b3 = bytes[3];

  if (b0 === 0x44 && b1 === 0x44 && b2 === 0x53 && b3 === 0x20) {
    return { kind: "dds", mime: "application/octet-stream" };
  }

  if (b0 === 0x38 && b1 === 0x42 && b2 === 0x50 && b3 === 0x53) {
    return { kind: "psd", mime: "application/octet-stream" };
  }

  if (
    bytes.length >= 8 &&
    b0 === 0x89 &&
    b1 === 0x50 &&
    b2 === 0x4e &&
    b3 === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { kind: "png", mime: "image/png" };
  }

  if (bytes.length >= 3 && b0 === 0xff && b1 === 0xd8 && b2 === 0xff) {
    return { kind: "jpeg", mime: "image/jpeg" };
  }

  if (
    bytes.length >= 6 &&
    b0 === 0x47 &&
    b1 === 0x49 &&
    b2 === 0x46 &&
    b3 === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return { kind: "gif", mime: "image/gif" };
  }

  if (
    bytes.length >= 12 &&
    b0 === 0x52 &&
    b1 === 0x49 &&
    b2 === 0x46 &&
    b3 === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { kind: "webp", mime: "image/webp" };
  }

  if (b0 === 0x42 && b1 === 0x4d) {
    return { kind: "bmp", mime: "image/bmp" };
  }

  if (
    bytes.length >= 4 &&
    ((b0 === 0x49 && b1 === 0x49 && b2 === 0x2a && b3 === 0x00) ||
      (b0 === 0x4d && b1 === 0x4d && b2 === 0x00 && b3 === 0x2a) ||
      (b0 === 0x49 && b1 === 0x49 && b2 === 0x2b && b3 === 0x00) ||
      (b0 === 0x4d && b1 === 0x4d && b2 === 0x00 && b3 === 0x2b))
  ) {
    return { kind: "tiff", mime: "image/tiff" };
  }

  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70 &&
    bytes[8] === 0x61 &&
    bytes[9] === 0x76 &&
    bytes[10] === 0x69 &&
    (bytes[11] === 0x66 || bytes[11] === 0x73)
  ) {
    return { kind: "avif", mime: "image/avif" };
  }

  if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) {
    return { kind: "ai", mime: "application/pdf" };
  }

  if (b0 === 0x25 && b1 === 0x21 && b2 === 0x50 && b3 === 0x53) {
    return { kind: "ai-ps", mime: "application/postscript" };
  }

  // Paint.NET: "PDN3" magic
  if (b0 === 0x50 && b1 === 0x44 && b2 === 0x4e && b3 === 0x33) {
    return { kind: "pdn", mime: "application/x-pdn" };
  }

  return { kind: "", mime: "" };
}

export function heightToFootprintRatio(size) {
  if (!size) return Infinity;
  const footprint = Math.max(size.x, size.z);
  if (!Number.isFinite(footprint) || footprint <= 0) return Infinity;
  const ratio = size.y / footprint;
  return Number.isFinite(ratio) ? ratio : Infinity;
}

export function maybeAutoFixYftUpAxis(object, initialSize) {
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

  const isMeaningfullyBetter = Number.isFinite(scoreB) && scoreB < scoreA * 0.7;
  const isNoLongerStanding = scoreB <= 1.2;

  if (!isMeaningfullyBetter || !isNoLongerStanding) return false;

  object.rotateX(-Math.PI / 2);
  object.updateMatrixWorld(true);
  object.userData.autoOriented = true;
  return true;
}

export function setupLiveryShader(material) {
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

export function buildDrawableObject(drawable, options = {}) {
  const useVertexColors = options.useVertexColors !== false;
  const root = new THREE.Group();
  root.name = drawable.name || "yft";

  drawable.models.forEach((model) => {
    const modelName = model.name || root.name;
    const group = new THREE.Group();
    group.name = modelName;

    model.meshes.forEach((mesh) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));

      if (mesh.normals) {
        geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
      }

      if (mesh.uvs) {
        geometry.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
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

      const hasVertexColors = Boolean(mesh.colors && useVertexColors);
      if (hasVertexColors) {
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
        side: THREE.FrontSide,
        vertexColors: hasVertexColors,
      });
      material.userData.baseRoughness = roughness;
      material.name = mesh.materialName || "";

      const threeMesh = new THREE.Mesh(geometry, material);
      threeMesh.name = mesh.name || material.name || "mesh";
      threeMesh.userData.materialType = isPaint ? "paint" : isGlass ? "glass" : isChrome ? "chrome" : "default";
      if (mesh.textureRefs && Object.keys(mesh.textureRefs).length > 0) {
        threeMesh.userData.textureRefs = mesh.textureRefs;
      }

      group.add(threeMesh);
    });

    if (group.children.length > 0) {
      if (model.transform) {
        const m = new THREE.Matrix4();
        m.fromArray(model.transform);
        group.applyMatrix4(m);
      }
      if (group.parent !== root) {
        root.add(group);
      }
    }
  });

  return root;
}

export function hasRenderableMeshes(object) {
  if (!object) return false;
  let count = 0;
  object.traverse((child) => {
    if (child.isMesh && child.geometry?.attributes?.position?.count > 0) {
      count += 1;
    }
  });
  return count > 0;
}

export function disposeObject(object) {
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

export function disposeMaterial(material) {
  if (!material) return;
  if (Array.isArray(material)) {
    material.forEach((mat) => mat.dispose?.());
  } else {
    material.dispose?.();
  }
}

export function createFloorGrid() {
  const grid = new THREE.GridHelper(40, 40, 0x333333, 0x222222);
  grid.position.y = -0.01;
  grid.material.opacity = 0.35;
  grid.material.transparent = true;
  grid.userData.isFloor = true;
  return grid;
}

export function applyLiveryToModel(object, bodyColor, texture) {
  if (!object) return;
  const color = new THREE.Color(bodyColor || "#e7ebf0");

  object.traverse((child) => {
    if (!child.isMesh) return;
    if (!child.userData.baseMaterial) child.userData.baseMaterial = child.material;

    const matName = (child.material?.name || child.userData.baseMaterial?.name || "").toLowerCase();
    const isPaint = matName.includes("paint") || matName.includes("carpaint") || matName.includes("livery") ||
      matName.includes("sign") || matName.includes("decal") || matName.includes("body") || matName.includes("wrap");

    if (isPaint && texture) {
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

export function applyTextureToAll(object, bodyColor, texture) {
  if (!object) return;
  const color = new THREE.Color(bodyColor || "#e7ebf0");

  object.traverse((child) => {
    if (!child.isMesh) return;
    if (!child.userData.baseMaterial) child.userData.baseMaterial = child.material;

    if (texture) {
      if (!child.userData.dualMaterial) {
        const mat = new THREE.MeshStandardMaterial({
          color, map: texture, side: THREE.DoubleSide,
          metalness: child.userData.baseMaterial?.metalness ?? 0.2,
          roughness: child.userData.baseMaterial?.roughness ?? 0.6,
        });
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
    } else {
      if (!child.userData.dualMaterial) {
        const mat = new THREE.MeshStandardMaterial({
          color,
          map: null,
          side: THREE.DoubleSide,
          metalness: child.userData.baseMaterial?.metalness ?? 0.2,
          roughness: child.userData.baseMaterial?.roughness ?? 0.6,
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

export async function loadTextureFromPath(texturePath, textureLoader, renderer) {
  if (!texturePath) return null;

  let bytes = null;
  try { bytes = await readFile(texturePath); } catch { return null; }

  const extension = getFileExtension(texturePath);
  const signature = sniffTextureSignature(bytes);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  const applySettings = (texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    if (!texture.isCompressedTexture && !texture.userData?.ddsDecoded) texture.flipY = true;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;
    texture.anisotropy = renderer?.capabilities.getMaxAnisotropy() || 1;
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
      return await new Promise((resolve, reject) => textureLoader.load(url, resolve, undefined, reject));
    } finally { URL.revokeObjectURL(url); }
  };

  const loadDdsCustom = async () => {
    const tex = parseDDS(buffer);
    if (!tex) throw new Error("Custom DDS parser returned null");
    return tex;
  };

  const loadDdsFallback = async () => {
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

  const loadPsd = async () => loadPsdTexture(bytes);

  const loadTiff = async () => {
    const mod = await import("utif");
    const UTIF = mod.default || mod;
    const ifds = UTIF.decode(buffer);
    if (!ifds?.length) throw new Error("TIFF contained no images.");
    UTIF.decodeImage(buffer, ifds[0]);
    const rgba = UTIF.toRGBA8(ifds[0]);
    const w = ifds[0].width;
    const h = ifds[0].height;
    if (!rgba || !w || !h) throw new Error("TIFF decode returned empty image data.");
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
  const isPdfCompatibleAi = sigKind === "ai" || kind === "ai";
  if (kind === "dds" || sigKind === "dds") { attempts.push(loadDdsCustom); attempts.push(loadDdsFallback); }
  if (kind === "tga") attempts.push(loadTga);
  if (kind === "psd" || sigKind === "psd") attempts.push(loadPsd);
  if (kind === "pdn" || sigKind === "pdn") attempts.push(loadPdn);
  if (kind === "tif" || kind === "tiff" || sigKind === "tif" || sigKind === "tiff") attempts.push(loadTiff);
  if ((kind === "ai" || sigKind === "ai" || sigKind === "ai-ps") && isPdfCompatibleAi) attempts.push(loadAi);
  attempts.push(loadNative);

  let texture = null;
  for (const attempt of attempts) {
    try {
      texture = await attempt();
      if (texture) break;
    } catch (error) {
      if (error?.type === "unsupported-bit-depth") throw error;
      /* continue */
    }
  }
  if (!texture) return null;
  applySettings(texture);
  return texture;
}

export async function loadModelFile(modelPath) {
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

export function setupWasdControls({
  wasdStateRef,
  wasdFrameRef,
  cameraRef,
  controlsRef,
  fitRef,
  requestRenderRef,
}) {
  const state = wasdStateRef.current;
  const controls = controlsRef.current;
  const camera = cameraRef.current;
  const up = new THREE.Vector3(0, 1, 0);
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();

  const shouldIgnoreEvent = (event) => {
    if (event.defaultPrevented) return true;
    if (event.metaKey || event.ctrlKey || event.altKey) return true;
    const target = event.target;
    if (!target || !(target instanceof Element)) return false;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (target.isContentEditable) return true;
    return false;
  };

  const isActive = () =>
    state.forward || state.back || state.left || state.right || state.up || state.down;

  const stopLoop = () => {
    if (wasdFrameRef.current) {
      cancelAnimationFrame(wasdFrameRef.current);
      wasdFrameRef.current = 0;
    }
  };

  let lastTime = 0;
  const tick = (time) => {
    const delta = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;

    if (!isActive()) {
      stopLoop();
      return;
    }

    const distance = fitRef.current?.distance || 4;
    const baseSpeed = Math.max(distance * 0.6, 0.6);
    const speed = baseSpeed * (state.boost ? 2.0 : 1.0);

    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() === 0) forward.set(0, 0, -1);
    forward.normalize();
    right.crossVectors(forward, up).normalize();

    const move = new THREE.Vector3();
    if (state.forward) move.add(forward);
    if (state.back) move.addScaledVector(forward, -1);
    if (state.right) move.add(right);
    if (state.left) move.addScaledVector(right, -1);
    if (state.up) move.add(up);
    if (state.down) move.addScaledVector(up, -1);

    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed * delta);
      camera.position.add(move);
      controls.target.add(move);
      controls.update();
      requestRenderRef.current?.();
    }

    wasdFrameRef.current = requestAnimationFrame(tick);
  };

  const startLoop = () => {
    if (wasdFrameRef.current) return;
    lastTime = performance.now();
    wasdFrameRef.current = requestAnimationFrame(tick);
  };

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

  const handleKeyDown = (event) => {
    if (shouldIgnoreEvent(event)) return;
    if (!event.code) return;
    const wasActive = isActive();
    const handled = setKey(event.code, true);
    if (!handled) return;
    event.preventDefault();
    if (!wasActive && isActive()) startLoop();
  };

  const handleKeyUp = (event) => {
    if (!event.code) return;
    const handled = setKey(event.code, false);
    if (!handled) return;
    if (!isActive()) stopLoop();
  };

  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);

  return () => {
    window.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("keyup", handleKeyUp);
    stopLoop();
    state.forward = false;
    state.back = false;
    state.left = false;
    state.right = false;
    state.up = false;
    state.down = false;
    state.boost = false;
  };
}

export function setupWheelWhileDragging(controls, requestRenderRef) {
  const handler = (event) => {
    if (!controls.enabled || !controls.enableZoom) return;
    if (controls.state === -1) return;
    event.preventDefault();
    controls._handleMouseWheel(controls._customWheelEvent(event));
    requestRenderRef.current?.();
  };
  return handler;
}

export function normalizeLoadedMeshes(object) {
  object.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    child.castShadow = false;
    child.receiveShadow = false;
    const normalAttr = child.geometry.attributes?.normal;
    if (!normalAttr || normalAttr.count === 0) {
      child.geometry.computeVertexNormals();
      child.geometry.normalizeNormals?.();
    }
  });
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function toByteFromU16(value) {
  return Math.min(255, Math.max(0, Math.round(value / 257)));
}

function toSrgbByteFromLinear(value) {
  return Math.min(255, Math.max(0, Math.round(Math.pow(clamp01(value), 1 / 2.2) * 255)));
}

function normalizePsdImageData(imageData, bitsPerChannel) {
  if (!imageData) return null;
  const width = imageData.width;
  const height = imageData.height;
  const source = imageData.data;
  if (!width || !height || !source) return null;
  const expected = width * height * 4;
  if (!Number.isFinite(expected) || expected <= 0) return null;
  if (source.length < expected) return null;

  const bitDepth = Number.isFinite(bitsPerChannel) ? bitsPerChannel : 8;

  if (bitDepth === 16 && source instanceof Uint16Array) {
    const data = new Uint8Array(expected);
    for (let i = 0; i < expected; i += 1) {
      data[i] = toByteFromU16(source[i]);
    }
    return { width, height, data };
  }

  if (bitDepth === 32 && source instanceof Float32Array) {
    const data = new Uint8Array(expected);
    for (let i = 0; i < expected; i += 4) {
      data[i] = toSrgbByteFromLinear(source[i]);
      data[i + 1] = toSrgbByteFromLinear(source[i + 1]);
      data[i + 2] = toSrgbByteFromLinear(source[i + 2]);
      data[i + 3] = Math.min(255, Math.max(0, Math.round(clamp01(source[i + 3]) * 255)));
    }
    return { width, height, data };
  }

  if (source instanceof Uint8Array) {
    return { width, height, data: source };
  }

  if (source instanceof Uint8ClampedArray) {
    const data = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    return { width, height, data };
  }

  const data = new Uint8Array(expected);
  for (let i = 0; i < expected; i += 1) {
    const value = source[i] ?? 0;
    data[i] = Math.min(255, Math.max(0, Math.round(value)));
  }
  return { width, height, data };
}

function createPsdTexture(imageData, bitsPerChannel) {
  const normalized = normalizePsdImageData(imageData, bitsPerChannel);
  if (!normalized) return null;
  const texture = new THREE.DataTexture(
    normalized.data,
    normalized.width,
    normalized.height,
    THREE.RGBAFormat,
  );
  texture.premultiplyAlpha = false;
  return texture;
}

export async function loadPsdTexture(bytes) {
  const bitDepth = detectPsdBitDepth(bytes);
  if (bitDepth === 16 || bitDepth === 32) {
    const error = new Error(`${bitDepth}-bit PSD not supported`);
    error.type = "unsupported-bit-depth";
    error.bitDepth = bitDepth;
    throw error;
  }
  const { readPsd } = await import("ag-psd");
  const psd = readPsd(bytes, { skipThumbnail: true });
  const canvas = psd?.canvas;
  if (canvas && typeof canvas.getContext === "function") {
    const texture = new THREE.CanvasTexture(canvas);
    texture.premultiplyAlpha = false;
    return texture;
  }
  const imageData = psd?.imageData;
  if (imageData) {
    const texture = createPsdTexture(imageData, psd?.bitsPerChannel);
    if (texture) return texture;
  }
  throw new Error("PSD parsed but no image data found.");
}

export function detectPsdBitDepth(bytes) {
  if (!bytes || bytes.length < 26) return 8;
  if (bytes[0] !== 0x38 || bytes[1] !== 0x42 || bytes[2] !== 0x50 || bytes[3] !== 0x53) {
    return 8;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint16(22, false);
}

function createPdnDataTexture(result, sourceKind = "pdn") {
  const texture = new THREE.DataTexture(
    result.data,
    result.width,
    result.height,
    THREE.RGBAFormat,
  );
  texture.premultiplyAlpha = false;
  texture.userData = texture.userData || {};
  texture.userData.sourceKind = sourceKind;
  return texture;
}

function pdnLog(level, message, details) {
  const payload = details && typeof details === "object" ? details : undefined;
  if (level === "error") {
    if (payload) console.error(`[PDN] ${message}`, payload);
    else console.error(`[PDN] ${message}`);
    return;
  }
  if (level === "warn") {
    if (payload) console.warn(`[PDN] ${message}`, payload);
    else console.warn(`[PDN] ${message}`);
    return;
  }
  if (payload) console.debug(`[PDN] ${message}`, payload);
  else console.debug(`[PDN] ${message}`);
}

function hasVisiblePdnPixels(data) {
  if (!data || data.length < 4) return false;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] !== 0) return true;
  }
  return false;
}

function isUsablePdnDecode(result, visiblePixels) {
  if (!result || !result.data || result.width <= 0 || result.height <= 0) return false;
  const expected = result.width * result.height * 4;
  if (result.data.length < expected) return false;
  if (typeof visiblePixels === "boolean") return visiblePixels;
  return hasVisiblePdnPixels(result.data);
}

function isTauriRuntimeAvailable() {
  return (
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function"
  );
}

function yieldToMainThread() {
  return new Promise((resolve) => {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

async function decodeBase64ToUint8Array(base64Value) {
  if (!base64Value || typeof base64Value !== "string") return null;
  const binary = atob(base64Value);
  const bytes = new Uint8Array(binary.length);
  const chunkSize = 1024 * 1024;
  for (let start = 0; start < binary.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, binary.length);
    for (let index = start; index < end; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    if (end < binary.length) {
      await yieldToMainThread();
    }
  }
  return bytes;
}

async function decodePdnViaWorker(bytes) {
  if (typeof Worker === "undefined" || !bytes || bytes.length === 0) return null;

  const workerBytes = bytes.slice(0);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./pdn-worker.js", import.meta.url), { type: "module" });
    let settled = false;

    const cleanUp = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };

    const finish = (isError, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      cleanUp();
      if (isError) reject(value);
      else resolve(value);
    };

    const timeoutId = setTimeout(() => {
      finish(true, new Error("PDN worker decode timed out."));
    }, 45_000);

    worker.onmessage = (event) => {
      const payload = event?.data || {};
      if (payload?.error) {
        finish(true, new Error(payload.error));
        return;
      }

      const width = Number(payload?.width || 0);
      const height = Number(payload?.height || 0);
      const data = payload?.data instanceof Uint8Array
        ? payload.data
        : payload?.data instanceof ArrayBuffer
          ? new Uint8Array(payload.data)
          : null;

      if (!data || width <= 0 || height <= 0) {
        finish(false, null);
        return;
      }

      finish(false, { width, height, data });
    };

    worker.onerror = (event) => {
      finish(true, new Error(event?.message || "PDN worker decode failed."));
    };

    worker.postMessage({ bytes: workerBytes }, [workerBytes.buffer]);
  });
}

async function decodePdnViaTauri(filePath) {
  const isTauriRuntime = isTauriRuntimeAvailable();

  if (!isTauriRuntime || !filePath || typeof filePath !== "string") {
    pdnLog("debug", "Skipping Tauri decode fallback", {
      isTauriRuntime,
      hasFilePath: typeof filePath === "string" && filePath.length > 0,
    });
    return null;
  }

  pdnLog("debug", "Attempting Tauri decode fallback", { filePath });
  const payload = await invoke("decode_pdn", { path: filePath });
  const width = Number(payload?.width || 0);
  const height = Number(payload?.height || 0);
  const rgba = await decodeBase64ToUint8Array(payload?.rgba_base64);

  pdnLog("debug", "Tauri decode response received", {
    width,
    height,
    rgbaLength: rgba?.length || 0,
  });

  if (!rgba || width <= 0 || height <= 0) return null;
  return { width, height, data: rgba };
}

/**
 * Load a Paint.NET (.pdn) file as a Three.js texture.
 *
 * @param {Uint8Array} bytes  Raw file bytes
 * @param {string} [filePath]  Original file path
 * @returns {Promise<THREE.DataTexture>}
 */
export async function loadPdnTexture(bytes, filePath) {
  const isDesktopTauriDecode =
    isTauriRuntimeAvailable() &&
    typeof filePath === "string" &&
    filePath.length > 0;

  let jsDecodeError = null;
  let tauriDecodeError = null;
  let workerDecodeError = null;
  pdnLog("debug", "Starting PDN texture load", {
    filePath: filePath || null,
    byteLength: bytes?.length || 0,
    preferTauriDecode: isDesktopTauriDecode,
    workerSupported: typeof Worker !== "undefined",
    magic: bytes && bytes.length >= 4 ? String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) : null,
  });

  try {
    const workerResult = await decodePdnViaWorker(bytes);
    const workerVisiblePixels = hasVisiblePdnPixels(workerResult?.data);
    pdnLog("debug", "Worker decode result", {
      hasResult: Boolean(workerResult),
      width: workerResult?.width || 0,
      height: workerResult?.height || 0,
      dataLength: workerResult?.data?.length || 0,
      visiblePixels: workerVisiblePixels,
    });

    if (isUsablePdnDecode(workerResult, workerVisiblePixels)) {
      pdnLog("debug", "Using worker PDN decode result", {
        width: workerResult.width,
        height: workerResult.height,
      });
      return createPdnDataTexture(workerResult, "pdn-js-worker");
    }
    if (workerResult && !workerVisiblePixels) {
      workerDecodeError = new Error("Worker PDN decode produced a fully transparent image.");
    }
  } catch (error) {
    workerDecodeError = error;
    pdnLog("warn", "Worker PDN decode failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (isDesktopTauriDecode) {
    try {
      const tauriResult = await decodePdnViaTauri(filePath);
      const tauriVisiblePixels = hasVisiblePdnPixels(tauriResult?.data);
      pdnLog("debug", "Tauri decode result", {
        hasResult: Boolean(tauriResult),
        width: tauriResult?.width || 0,
        height: tauriResult?.height || 0,
        dataLength: tauriResult?.data?.length || 0,
        visiblePixels: tauriVisiblePixels,
      });

      if (isUsablePdnDecode(tauriResult, tauriVisiblePixels)) {
        pdnLog("debug", "Using Tauri PDN decode result", {
          width: tauriResult.width,
          height: tauriResult.height,
        });
        return createPdnDataTexture(tauriResult, "pdn-tauri");
      }

      if (tauriResult && !tauriVisiblePixels) {
        tauriDecodeError = new Error("Tauri PDN decode produced a fully transparent image.");
      }
    } catch (error) {
      tauriDecodeError = error;
      pdnLog("warn", "Tauri decode failed after worker path", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const { decodePdn } = await import("./pdn");
  try {
    const jsResult = decodePdn(bytes, { fast: true });
    const jsVisiblePixels = hasVisiblePdnPixels(jsResult?.data);
    pdnLog("debug", "JS main-thread decode result", {
      hasResult: Boolean(jsResult),
      width: jsResult?.width || 0,
      height: jsResult?.height || 0,
      dataLength: jsResult?.data?.length || 0,
      visiblePixels: jsVisiblePixels,
    });

    if (isUsablePdnDecode(jsResult, jsVisiblePixels)) {
      pdnLog("debug", "Using JS main-thread PDN decode result", {
        width: jsResult.width,
        height: jsResult.height,
      });
      return createPdnDataTexture(jsResult, "pdn-js");
    }
    if (jsResult && !jsVisiblePixels) {
      jsDecodeError = new Error("PDN decode produced a fully transparent image.");
      pdnLog("warn", "JS decode produced fully transparent image", {
        width: jsResult.width,
        height: jsResult.height,
        dataLength: jsResult.data?.length || 0,
      });
    }
  } catch (error) {
    jsDecodeError = error;
    pdnLog("warn", "JS decode threw error", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const finalError = jsDecodeError || tauriDecodeError || workerDecodeError;
  const detail = finalError instanceof Error && finalError.message
    ? ` (${finalError.message})`
    : "";
  pdnLog("error", "PDN texture load failed", {
    filePath: filePath || null,
    reason: finalError instanceof Error ? finalError.message : "Unknown decode failure",
  });
  throw new Error(`Failed to decode Paint.NET (.pdn) file${detail}. Try re-saving in Paint.NET or exporting to PNG.`);
}
