// 1:1 GTA-metre scale reference overlays for Prop Studio.
// Procedural lightweight geometry (no external files needed), tagged
// userData.propHelper = true so bounds, shadows, picking and PNG exports skip it.

import * as THREE from "three";

export const SCALE_REFERENCES = Object.freeze([
  { id: "none", label: "Off" },
  { id: "ped", label: "Ped (1.8 m)" },
  { id: "table", label: "Table (75 cm)" },
  { id: "cube", label: "1 m cube" },
  { id: "hand", label: "Hand (19 cm)" },
]);

const GHOST_COLOR = 0x9fb4c8;

function makeMaterials() {
  const fill = new THREE.MeshBasicMaterial({
    color: GHOST_COLOR,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const line = new THREE.LineBasicMaterial({
    color: GHOST_COLOR,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    toneMapped: false,
  });
  return { fill, line };
}

function addPart(group, geometry, { fill, line }, position = [0, 0, 0], rotation = [0, 0, 0]) {
  const mesh = new THREE.Mesh(geometry, fill);
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  mesh.userData.propHelper = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 6;
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 24), line);
  edges.userData.propHelper = true;
  edges.renderOrder = 7;
  mesh.add(edges);
  group.add(mesh);
  return mesh;
}

/** Stylized 1.80 m human silhouette (standing on y = 0). */
function buildPedGhost(materials) {
  const group = new THREE.Group();
  // Legs (0 -> 0.88 m)
  addPart(group, new THREE.CylinderGeometry(0.068, 0.055, 0.88, 10), materials, [-0.1, 0.44, 0]);
  addPart(group, new THREE.CylinderGeometry(0.068, 0.055, 0.88, 10), materials, [0.1, 0.44, 0]);
  // Pelvis + torso (0.88 -> 1.48 m)
  addPart(group, new THREE.BoxGeometry(0.36, 0.6, 0.2), materials, [0, 1.18, 0]);
  // Shoulders / arms (hand bottoms around 0.80 m)
  addPart(group, new THREE.CylinderGeometry(0.048, 0.04, 0.66, 8), materials, [-0.24, 1.13, 0]);
  addPart(group, new THREE.CylinderGeometry(0.048, 0.04, 0.66, 8), materials, [0.24, 1.13, 0]);
  // Neck + head (1.48 -> 1.80 m)
  addPart(group, new THREE.CylinderGeometry(0.055, 0.06, 0.09, 8), materials, [0, 1.525, 0]);
  addPart(group, new THREE.SphereGeometry(0.115, 12, 10), materials, [0, 1.685, 0]);
  return { group, halfWidth: 0.29 };
}

/** Standard 1.20 m × 0.70 m × 0.75 m GTA table/counter (standing on y = 0). */
function buildTableGhost(materials) {
  const group = new THREE.Group();
  addPart(group, new THREE.BoxGeometry(1.2, 0.04, 0.7), materials, [0, 0.73, 0]);
  for (const x of [-0.55, 0.55]) {
    for (const z of [-0.3, 0.3]) {
      addPart(group, new THREE.BoxGeometry(0.045, 0.71, 0.045), materials, [x, 0.355, z]);
    }
  }
  return { group, halfWidth: 0.6 };
}

/** 1.00 m reference cube with 10 cm vertical tick marks (standing on y = 0). */
function buildCubeGhost(materials) {
  const group = new THREE.Group();
  addPart(group, new THREE.BoxGeometry(1, 1, 1), materials, [0, 0.5, 0]);
  const pts = [];
  for (let i = 1; i < 10; i += 1) {
    const y = i * 0.1;
    const tick = i === 5 ? 0.14 : 0.06;
    pts.push(new THREE.Vector3(-0.5, y, 0.5), new THREE.Vector3(-0.5 + tick, y, 0.5));
  }
  const ruler = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), materials.line);
  ruler.userData.propHelper = true;
  group.add(ruler);
  return { group, halfWidth: 0.5 };
}

/** 19 cm human hand silhouette for handheld props (standing upright on y = 0). */
function buildHandGhost(materials) {
  const group = new THREE.Group();
  // Palm (~8.5 cm wide, 9.5 cm tall, 2.5 cm thick)
  addPart(group, new THREE.BoxGeometry(0.085, 0.095, 0.024), materials, [0, 0.0475, 0]);
  // 4 fingers
  const fingers = [
    [-0.032, 0.075],
    [-0.011, 0.09],
    [0.011, 0.084],
    [0.032, 0.066],
  ];
  for (const [fx, len] of fingers) {
    addPart(group, new THREE.CylinderGeometry(0.0085, 0.0095, len, 8), materials, [fx, 0.095 + len * 0.5, 0]);
  }
  // Thumb
  addPart(group, new THREE.CylinderGeometry(0.01, 0.011, 0.062, 8), materials, [-0.058, 0.062, 0.006], [0, 0, 0.62]);
  return { group, halfWidth: 0.075 };
}

/**
 * Creates a disposable 1:1 GTA-metre scale reference group positioned cleanly to
 * the side of `bounds` on the same floor plane (`bounds.min.y`).
 */
export function createScaleReference(kind, bounds) {
  if (!kind || kind === "none") return null;
  const materials = makeMaterials();
  const builders = {
    ped: buildPedGhost,
    table: buildTableGhost,
    cube: buildCubeGhost,
    hand: buildHandGhost,
  };
  const build = builders[kind];
  if (!build) {
    materials.fill.dispose();
    materials.line.dispose();
    return null;
  }
  const { group, halfWidth } = build(materials);
  group.name = `prop-scale-ref:${kind}`;
  group.userData.propHelper = true;
  positionScaleReference(group, halfWidth, bounds);

  return {
    group,
    halfWidth,
    reposition(nextBounds) {
      positionScaleReference(group, halfWidth, nextBounds);
    },
    dispose() {
      group.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
      });
      materials.fill.dispose();
      materials.line.dispose();
      group.removeFromParent();
    },
  };
}

function positionScaleReference(group, halfWidth, bounds) {
  if (!bounds || bounds.isEmpty?.()) {
    group.position.set(halfWidth + 0.25, 0, 0);
    return;
  }
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const gap = Math.max(0.06, Math.min(0.45, Math.max(size.x, halfWidth) * 0.35));
  group.position.set(bounds.max.x + gap + halfWidth, bounds.min.y, center.z);
}
