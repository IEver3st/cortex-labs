import * as THREE from "three";
import {
  MAX_SIREN_COUNT,
  anyLightOn,
  boneHeading,
  classifyLightMesh,
  evaluateLights,
  lightsAnimate,
  normalizeLensTints,
  normalizeLightSwitches,
  sirenEmission,
  sirenFlashScale,
  sirenHeading,
} from "./emergency-lights.js";
import { elsRunning, evaluateEls } from "./els-lights.js";
import { elsColorHex } from "./els-vcf.js";
import { FLOOR_LIGHT_LAYER, GLOW_LAYER } from "./viewer-render-effects.js";
import { createBeamMaterial } from "./viewer-stage.js";

// Drives emissive light meshes on a loaded vehicle from emergency-lights.js.
// Everything the rig adds (glow overlays, coronas, the ground light pool and
// body spill lights) lives in its own scene group, outside the model, so
// material assignment, picking, extras and export never see it. The only change
// made to the model is the transform of meshes on turned, rotating or scaling
// sirenN bones, restored on dispose. Bridge meshes are in GTA vehicle space:
// +X right, +Y forward, +Z up.
//
// ELS (state.els) is the other exception: an ELS script flashes lights by
// switching whole extras, so while its preview runs the rig sets the
// visibility of the extras the VCF controls every frame, and hands them back
// to the host's extras plan (userData.metaExtraVisible) when it stops.

// Body spill uses a fixed set of merged point lights, one per vehicle quadrant,
// so the light count (and every lit material's shader) never changes while
// sirens flash. The ground pool covers every siren in one shader pass.
const BODY_LIGHT_QUADRANTS = 4;
// Body lights sit this far outside the vehicle's side so they wash whole panels
// instead of painting a hot spot on the nearest one. Brightness is tuned so a
// panel facing the light receives what it did from the old 1.2 m placement.
const BODY_LIGHT_OFFSET = 3;
const BODY_LIGHT_CANDELA = 0.05 * (BODY_LIGHT_OFFSET / 1.2) ** 2;
// One source per lit light head; a siren can light heads in several places.
const POOL_SOURCE_LIMIT = 64;
// Heads of one siren closer than this (metres) light the ground as one source.
const HEAD_CLUSTER_DISTANCE = 0.6;
// Ground spill brightness per unit of carcols siren intensity, at Spill 1x.
// A 30-siren bar lights 10-15 heads at once with falloffs of 50-80 m, so this
// stays low enough that the overlap reads as coloured light, not a flat sheet.
const POOL_STRENGTH = 0.07;
const POOL_RADIUS = 26;
// Spill eases between steps over this many seconds, so fast patterns light
// the ground the way the eye averages them instead of strobing it. The lit
// emitters themselves still switch on the exact step.
const SPILL_SMOOTHING = 0.07;
// Fraction of light that still reaches ground shadowed by the body (bounce).
const BODY_SHADOW_FLOOR = 0.12;
// Fog: ray-marched beams (the stage's beam shader) for the brightest lit spot
// heads. A fixed set, so the cost does not grow with the number of sirens.
const HAZE_BEAM_LIMIT = 12;
const HAZE_STRENGTH = 0.3;
// Beams show this far (metres) at most; carcols falloffs reach 30-50 m.
const HAZE_LENGTH = 9;
// Siren spot lights aim level; a slight downward tilt lets the beam meet the floor.
const HAZE_PITCH = Math.tan(THREE.MathUtils.degToRad(6));
const CONE_UP = new THREE.Vector3(0, 1, 0);
const CORONA_SCALE = 2;
const UP = new THREE.Vector3(0, 0, 1);
const WHITE = new THREE.Color(1, 1, 1);
const HOT_CORE = 0.05;
// Scales a light's game emissive into glow coverage. At 1.2 a lit headlight
// lens on a typical veh_lits texture (alpha 0.1-0.3) reads solid, and a
// siren's 150 burns through the near-transparent flasher reflectors packs put
// inside head and tail lamps.
const EMISSIVE_GAIN = 1.2;
// Spill energy of one ELS environment light, as a carcols siren intensity.
// ELS draws a fixed-strength light per lit extra; this matches a typical siren.
const ELS_ENV_ENERGY = 1.5;
// Lowest alpha a lit default-light texel (light id 0 off an extra: DRLs,
// markers, screens) counts with. Packs author DRL bars as low as 2/255 and
// they burn solid in game at the default light's modest emissive; with this
// floor their art (brightness 0.3-1) burns 1-5. Head, tail and brake lamps,
// sirens and steady-burn extras keep their own alpha: their textures carry
// lens noise and in-lamp flashback or scratch films at 4-8/255 that would
// otherwise turn into grain or flood the lamps they share.
const DEFAULT_LIGHT_ALPHA_FLOOR = 0.25;
// Burn (brightness x alpha x gain) where the glow's knee sits: dark trim and
// faint texels drop away, lit lamps burn well past it.
const GLOW_KNEE = 0.1;
// Metres of opaque body between the camera and a siren before its editor
// marker reads as on the far side of the vehicle.
const FAR_SIDE_DEPTH = 1;

let gradientTexture = null;
let gradientUsers = 0;

function acquireGradient() {
  gradientUsers += 1;
  if (gradientTexture) return gradientTexture;
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5) / size * 2 - 1;
      const dy = (y + 0.5) / size * 2 - 1;
      const falloff = Math.max(0, 1 - Math.hypot(dx, dy));
      const value = Math.round(255 * falloff * falloff);
      const index = (y * size + x) * 4;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = value;
    }
  }
  gradientTexture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  gradientTexture.magFilter = THREE.LinearFilter;
  gradientTexture.minFilter = THREE.LinearFilter;
  gradientTexture.needsUpdate = true;
  return gradientTexture;
}

function releaseGradient() {
  gradientUsers = Math.max(0, gradientUsers - 1);
  if (gradientUsers === 0 && gradientTexture) {
    gradientTexture.dispose();
    gradientTexture = null;
  }
}

// A heading within this of the bone's rest yaw leaves the meshes as modelled
// (atan2 reports a bone turned to pi as -pi).
const TURN_EPSILON = 1e-4;

/**
 * How far the game turns a siren's meshes about its bone. The bone takes the
 * siren's heading and its meshes were bound at the bone's rest yaw, so the turn
 * is the difference. Packs that pre-turn sirenN bones to their delta get none;
 * packs that model every emitter facing forward on unturned bones rely on it to
 * put rear and side heads in place. Without a bone only rotators turn.
 */
function sirenTurn(siren, sirenState) {
  if (!sirenState) return 0;
  if (siren.restYaw == null) return sirenState.rotate ? sirenState.spin : 0;
  const delta = sirenState.yaw - siren.restYaw;
  const turn = Math.atan2(Math.sin(delta), Math.cos(delta));
  return Math.abs(turn) < TURN_EPSILON ? 0 : turn;
}

// The extra a mesh belongs to: tagged by the viewer, else from the manifest.
function extraIndexOf(mesh) {
  const tagged = mesh.userData?.extraIndex;
  if (Number.isInteger(tagged)) return tagged;
  const native = mesh.userData?.nativeMaterial?.extraIndex;
  return Number.isInteger(native) ? native : null;
}

function isShown(object, root) {
  for (let node = object; node; node = node.parent) {
    if (!node.visible) return false;
    if (node === root) return true;
  }
  return true;
}

// Lit emitters draw as solid surfaces, as the game draws emissives: where a red
// and a blue emitter overlap, the nearer one shows instead of the two adding up
// to purple. Coincident surfaces resolve by siren order.
function createOverlay(mesh, order, alphaFloor = 0) {
  const material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    depthWrite: true,
    depthFunc: THREE.LessEqualDepth,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    side: (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)?.side ?? THREE.FrontSide,
    toneMapped: false,
  });
  // A textured emitter glows where its texture is bright, as the game's
  // emissive is texel colour times intensity: dark texels emit nothing, so
  // coverage grows with brightness times alpha and saturates with the game's
  // HDR emissive (`glowGain`). Lamp textures keep alpha near zero so the
  // unlit lens reads as tinted glass, yet in game a DRL bar at 2/255 burns as
  // solid as a tail lamp at 16/255, so alpha counts for at least `alphaFloor`
  // (DEFAULT_LIGHT_ALPHA_FLOOR); fully empty texels stay dark. The hue is the texture's: emissive
  // textures are colour atlases (red, blue, amber and white blocks) and each
  // mesh's UVs pick its colour, as in game. Light comes from areas, not lone
  // texels: lamp textures and steady-burn scratch films carry sparkle layers
  // whose bright texels are a texel or two wide and meant to be barely
  // visible, so a texel only glows as brightly as its 4x4 texel neighbourhood
  // allows (four bilinear taps 1.5 texels out, so textures without mips
  // filter too). Lit areas and lines a few texels across keep their shape;
  // scattered sparkles average out dim (even 1% coverage reads as grey grain
  // on a black lens). A knee
  // then drops emission too faint to read as light: below it burn falls with
  // its cube, while lamps, which burn well past it, keep nearly all of theirs.
  // A preview lens tint sets `glowKeepHue` to 0: the texture still shapes the
  // glow, and the material colour (the tint) colours it.
  material.userData.glowGain = { value: 1 };
  material.userData.glowKeepHue = { value: 1 };
  material.onBeforeCompile = (shader) => {
    if (material.userData.glowMode !== "texture") return;
    shader.uniforms.glowGain = material.userData.glowGain;
    shader.uniforms.glowKeepHue = material.userData.glowKeepHue;
    shader.fragmentShader = `uniform float glowGain;\nuniform float glowKeepHue;\n${shader.fragmentShader}`.replace(
      "#include <map_fragment>",
      [
        "#ifdef USE_MAP",
        "\tvec4 glowTexel = texture2D( map, vMapUv );",
        "\tfloat glowLevel = max( glowTexel.r, max( glowTexel.g, glowTexel.b ) );",
        "\tvec2 glowStep = 1.5 / vec2( textureSize( map, 0 ) );",
        "\tfloat glowArea = 0.0;",
        "\tfor ( int i = 0; i < 4; i ++ ) {",
        "\t\tvec2 glowOffset = vec2( i < 2 ? -1.0 : 1.0, ( i == 0 || i == 2 ) ? -1.0 : 1.0 ) * glowStep;",
        "\t\tvec3 glowTap = textureLod( map, vMapUv + glowOffset, 0.0 ).rgb;",
        "\t\tglowArea += 0.25 * max( glowTap.r, max( glowTap.g, glowTap.b ) );",
        "\t}",
        `\tfloat glowAlpha = step( 0.002, glowTexel.a ) * max( glowTexel.a, ${alphaFloor.toFixed(2)} );`,
        "\tfloat glowBurn = min( glowLevel, glowArea ) * glowAlpha * glowGain;",
        `\tfloat glowKnee = glowBurn / ${GLOW_KNEE.toFixed(2)};`,
        "\tglowKnee *= glowKnee * glowKnee;",
        "\tdiffuseColor.a *= 1.0 - exp( -glowBurn * glowKnee / ( 1.0 + glowKnee ) );",
        "\tdiffuseColor.rgb *= mix( vec3( 1.0 ), glowTexel.rgb / max( glowLevel, 1e-4 ), glowKeepHue );",
        "#endif",
      ].join("\n"),
    );
  };
  material.customProgramCacheKey = () => `light-glow-${material.userData.glowMode || "solid"}-${alphaFloor}`;
  const overlay = new THREE.Mesh(mesh.geometry, material);
  overlay.name = `light-glow:${mesh.name}`;
  overlay.matrixAutoUpdate = false;
  overlay.visible = false;
  overlay.renderOrder = 10 + order;
  overlay.layers.set(GLOW_LAYER);
  overlay.frustumCulled = mesh.frustumCulled;
  return overlay;
}

// Ground light from siren spot lights, evaluated per pixel the way the game
// lights the world with them: a 3D spot light at each lit head, aimed along the
// siren's delta with the setting's inner and outer cone (Rage half-angles),
// attenuated by lightFalloffMax and lightFalloffExponent, with the ground's
// incidence angle, and shadowed by the vehicle body (castShadows). One quad, one
// pass, whatever the number of lit heads.
function createLightPool() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPositions: { value: Array.from({ length: POOL_SOURCE_LIMIT }, () => new THREE.Vector4()) },
      uColors: { value: Array.from({ length: POOL_SOURCE_LIMIT }, () => new THREE.Vector4()) },
      uCount: { value: 0 },
      uFloorY: { value: 0 },
      uStrength: { value: POOL_STRENGTH },
      // x: falloff radius, y: falloff exponent.
      uFalloff: { value: new THREE.Vector2(30, 8) },
      // cos of the outer and inner cone half-angles.
      uCone: { value: new THREE.Vector2(Math.cos(THREE.MathUtils.degToRad(70)), Math.cos(THREE.MathUtils.degToRad(2))) },
      // Vehicle body as an oriented box: centre, unit axes and half extents.
      uBoxCenter: { value: new THREE.Vector3() },
      uBoxX: { value: new THREE.Vector3(1, 0, 0) },
      uBoxY: { value: new THREE.Vector3(0, 1, 0) },
      uBoxZ: { value: new THREE.Vector3(0, 0, 1) },
      uBoxHalf: { value: new THREE.Vector3() },
      uShadowFloor: { value: BODY_SHADOW_FLOOR },
    },
    vertexShader: `varying vec3 vWorld;
      varying vec2 vUv;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `#define LIMIT ${POOL_SOURCE_LIMIT}
      uniform vec4 uPositions[LIMIT];
      uniform vec4 uColors[LIMIT];
      uniform int uCount;
      uniform float uFloorY;
      uniform float uStrength;
      uniform vec2 uFalloff;
      uniform vec2 uCone;
      uniform vec3 uBoxCenter;
      uniform vec3 uBoxX;
      uniform vec3 uBoxY;
      uniform vec3 uBoxZ;
      uniform vec3 uBoxHalf;
      uniform float uShadowFloor;
      varying vec3 vWorld;
      varying vec2 vUv;

      // How much of the body stands between a light and a ground point, kept
      // soft so many lights do not cut overlapping wedge shadows: a light lights
      // the ground on its own side of the vehicle, a light above the body (or
      // in its middle) lights all round, and the ground under the body is dark.
      float bodyShade(vec3 light, vec3 point) {
        vec3 l = light - uBoxCenter;
        vec3 p = point - uBoxCenter;
        vec2 half2 = max(uBoxHalf.xy, vec2(1e-3));
        vec2 lp = vec2(dot(l, uBoxX), dot(l, uBoxY)) / half2;
        vec2 pp = vec2(dot(p, uBoxX), dot(p, uBoxY)) / half2;
        float side = smoothstep(-0.35, 0.45, dot(normalize(pp + vec2(1e-4)), normalize(lp + vec2(1e-4))));
        float roof = smoothstep(0.85, 1.15, dot(l, uBoxZ) / max(uBoxHalf.z, 1e-3));
        float middle = 1.0 - smoothstep(0.2, 0.5, length(lp));
        float facing = max(side, max(roof, middle));
        float under = 1.0 - smoothstep(0.8, 1.15, max(abs(pp.x), abs(pp.y)));
        return mix(uShadowFloor, 1.0, facing) * mix(1.0, uShadowFloor, under);
      }

      void main() {
        vec3 sum = vec3(0.0);
        for (int i = 0; i < LIMIT; i++) {
          if (i >= uCount) break;
          vec4 light = uPositions[i];
          vec4 color = uColors[i];
          vec3 toPoint = vWorld - light.xyz;
          float distSq = dot(toPoint, toPoint);
          float dist = sqrt(distSq);
          // Rage-style attenuation: (1 - d^2 / r^2) ^ exponent.
          float atten = pow(clamp(1.0 - distSq / (uFalloff.x * uFalloff.x), 0.0, 1.0), uFalloff.y);
          if (atten <= 0.0) continue;
          // Incidence on the ground (normal up).
          float incidence = clamp((light.y - uFloorY) / max(dist, 1e-3), 0.0, 1.0);
          // Spot cone around the horizontal aim; color.w < -5 marks a point light.
          float spot = 1.0;
          if (color.w > -5.0) {
            vec3 aim = vec3(sin(color.w), 0.0, cos(color.w));
            spot = smoothstep(uCone.x, uCone.y, dot(toPoint / max(dist, 1e-3), aim));
          }
          float lit = atten * incidence * spot;
          if (lit <= 0.0) continue;
          sum += color.rgb * lit * bodyShade(light.xyz, vWorld);
        }
        // Many sirens light the same ground. A soft knee keeps one light
        // linear but stops overlapping pools clipping into a flat sheet, so
        // where red and white overlap both still read.
        vec3 lit = sum * uStrength;
        // Fade out before the quad's edge so long falloffs never show its square.
        float edge = 1.0 - smoothstep(0.3, 0.5, length(vUv - 0.5));
        gl_FragColor = vec4(lit / (1.0 + lit) * edge, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  pool.name = "light-ground-pool";
  pool.rotation.x = -Math.PI / 2;
  pool.renderOrder = -1;
  pool.frustumCulled = false;
  // Lights the floor; the floor's mirror must not see it (FLOOR_LIGHT_LAYER).
  pool.layers.set(FLOOR_LIGHT_LAYER);
  return pool;
}

/**
 * Builds a rig for `model`, or returns null when the model has no light meshes
 * (non-YFT formats, or caches written before manifest v8).
 */
export function createEmergencyLightRig({ scene, model }) {
  if (!scene || !model) return null;
  const meshes = [];
  // Emissive meshes on an extra that are no lamp: what ELS lightbars use.
  // Their overlays are built the first time an ELS preview runs.
  const elsEmitters = [];
  model.traverse((child) => {
    if (!child.isMesh) return;
    const native = child.userData?.nativeMaterial;
    if (!native) return;
    const light = classifyLightMesh(native);
    if (light) meshes.push({ mesh: child, light });
    else if (Number.isInteger(extraIndexOf(child)) && String(native.shaderName || "").toLowerCase().includes("emissive")
      && !/^siren_glass\d+$/i.test(String(native.lightBone || ""))) {
      elsEmitters.push(child);
    }
  });
  if (!meshes.length && !elsEmitters.length) return null;

  const group = new THREE.Group();
  group.name = "emergency-lights";
  scene.add(group);
  const gradient = acquireGradient();

  // Vehicle space is the bridge meshes' parent; every light mesh shares it.
  const space = (meshes[0]?.mesh || elsEmitters[0]).parent || model;
  // The bridge root carries the bones; normalisation may have wrapped it.
  let boneList = [];
  model.traverse((child) => {
    if (!boneList.length && Array.isArray(child.userData?.lightBones)) boneList = child.userData.lightBones;
  });
  const bones = new Map();
  for (const bone of boneList) {
    bones.set(bone.name, {
      position: new THREE.Vector3().fromArray(bone.position),
      quaternion: new THREE.Quaternion().fromArray(bone.rotation || [0, 0, 0, 1]),
    });
  }

  const entries = meshes.map(({ mesh, light }) => {
    const lit = light.kind !== "siren" || light.lit;
    const order = light.kind === "siren" ? light.siren / 100 : 0;
    const overlay = lit ? createOverlay(mesh, order, light.lamp === "always" ? DEFAULT_LIGHT_ALPHA_FLOOR : 0) : null;
    if (overlay) group.add(overlay);
    return {
      mesh,
      light,
      // The extra the mesh is on, for ELS switching; null on the body.
      extra: extraIndexOf(mesh),
      overlay,
      position: mesh.position.clone(),
      quaternion: mesh.quaternion.clone(),
      scale: mesh.scale.clone(),
    };
  });

  // Siren pivots: the sirenN bone, or the centre of its meshes for caches
  // without light bones.
  const sirens = new Map();
  for (const entry of entries) {
    if (entry.light.kind !== "siren") continue;
    const index = entry.light.siren;
    if (!sirens.has(index)) sirens.set(index, { index, entries: [], lit: false, bounds: new THREE.Box3() });
    const siren = sirens.get(index);
    siren.entries.push(entry);
    siren.lit ||= entry.light.lit;
    const geometry = entry.mesh.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    siren.bounds.union(geometry.boundingBox);
  }
  for (const siren of sirens.values()) {
    // Light heads: lit emitters and their geometry centres, for spill placement.
    siren.heads = siren.entries.filter((entry) => entry.overlay).map((entry) => {
      const geometry = entry.mesh.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      return { entry, center: geometry.boundingBox.getCenter(new THREE.Vector3()) };
    });
    const bone = bones.get(`siren${siren.index}`);
    siren.pivot = bone ? bone.position.clone() : siren.bounds.getCenter(new THREE.Vector3());
    siren.axis = bone ? UP.clone().applyQuaternion(bone.quaternion).normalize() : UP.clone();
    // The heading the bone's meshes were modelled at, as a siren yaw.
    siren.restYaw = bone ? boneHeading(bone.quaternion.toArray()) : null;
    // Where the heads sit at rest, for the editor's siren markers.
    const rest = new THREE.Matrix4();
    siren.restCenter = siren.heads.length
      ? siren.heads.reduce((sum, head) => sum.add(head.center.clone().applyMatrix4(
        rest.compose(head.entry.position, head.entry.quaternion, head.entry.scale))), new THREE.Vector3())
        .divideScalar(siren.heads.length)
      : siren.pivot.clone();
    // Heads that sit together at rest share one corona. A siren's heads can be
    // spread over the vehicle (bar and grille), and its bone can sit away from
    // all of them, so neither the bone nor the heads' average is a lamp.
    siren.clusters = [];
    for (const head of siren.heads) {
      const local = head.center.clone().applyMatrix4(rest.compose(head.entry.position, head.entry.quaternion, head.entry.scale));
      const cluster = siren.clusters.find((entry) => entry.rest.distanceToSquared(local) < HEAD_CLUSTER_DISTANCE * HEAD_CLUSTER_DISTANCE);
      if (cluster) {
        cluster.heads.push(head);
        cluster.rest.multiplyScalar(cluster.heads.length - 1).add(local).divideScalar(cluster.heads.length);
      } else siren.clusters.push({ heads: [head], rest: local });
    }
  }

  // Vehicle-space footprint, for placing body spill lights outside the body.
  const footprint = new THREE.Box3();
  for (const child of space.children) {
    if (!child.isMesh || !child.geometry) continue;
    if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
    footprint.union(child.geometry.boundingBox.clone().applyMatrix4(child.matrix));
  }

  // ELS bookkeeping, built the first time an ELS preview runs so other
  // vehicles pay nothing: every mesh of each extra (lit or not) for switching,
  // where each extra sits in vehicle space for its environment light, and
  // glow overlays for the emissive extras that are no lamp.
  let elsIndex = null;
  function ensureElsIndex() {
    if (elsIndex) return elsIndex;
    const byExtra = new Map();
    const bounds = new Map();
    model.traverse((child) => {
      const extra = child.isMesh ? extraIndexOf(child) : null;
      if (!Number.isInteger(extra)) return;
      if (!byExtra.has(extra)) byExtra.set(extra, []);
      byExtra.get(extra).push(child);
      if (!child.geometry) return;
      if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
      const box = child.geometry.boundingBox.clone().applyMatrix4(child.matrix);
      bounds.set(extra, bounds.has(extra) ? bounds.get(extra).union(box) : box);
    });
    for (const mesh of elsEmitters) {
      const overlay = createOverlay(mesh, 0, 0);
      if (overlay) group.add(overlay);
      entries.push({
        mesh,
        light: { kind: "els" },
        extra: extraIndexOf(mesh),
        overlay,
        position: mesh.position.clone(),
        quaternion: mesh.quaternion.clone(),
        scale: mesh.scale.clone(),
      });
    }
    elsIndex = { meshes: byExtra, centers: new Map([...bounds].map(([extra, box]) => [extra, box.getCenter(new THREE.Vector3())])) };
    return elsIndex;
  }

  const lampNames = [...new Set(entries.filter((entry) => entry.light.kind === "lamp").map((entry) => entry.light.name))];
  const litSirens = [...sirens.values()].filter((siren) => siren.lit).map((siren) => siren.index).sort((a, b) => a - b);

  let state = { setting: null, switches: normalizeLightSwitches(null), muted: new Set(), speed: 1, spill: true, spillStrength: 1, glow: 1, haze: 0, lens: {}, els: null, elsOn: false };
  // Extras the ELS preview switched last frame, to hand back when it stops.
  let elsDriven = new Set();
  // VCF colour per ELS extra, for untextured emitters and environment light.
  let elsColors = new Map();
  let clock = 0;
  // Indicators flash in real time; `clock` follows siren playback speed and scrubbing.
  let lampClock = 0;
  let lastNow = null;
  let bodyLights = [];
  let pool = null;
  let beams = [];
  let beamGeometry = null;
  // [{ index, sprite, heads }]: one per head cluster, or per bone (heads null).
  let coronas = [];
  let spinning = false;
  let idle = false;
  let structure = "";
  // Eased spill energy per siren index.
  const spillEnergy = new Map();
  const steadyEntries = entries.filter((entry) => entry.light.kind === "steady");
  // Steady-burn extras light whenever their extra is shown, switches or not.
  const steadyShown = () => steadyEntries.some((entry) => isShown(entry.mesh, model));

  const disposeSpill = () => {
    for (const light of bodyLights) {
      group.remove(light);
      light.dispose?.();
    }
    bodyLights = [];
    if (pool) {
      group.remove(pool);
      pool.geometry.dispose();
      pool.material.dispose();
      pool = null;
    }
    for (const beam of beams) {
      group.remove(beam);
      beam.material.dispose();
    }
    beams = [];
    beamGeometry?.dispose();
    beamGeometry = null;
  };

  const disposeCoronas = () => {
    for (const { sprite } of coronas) {
      group.remove(sprite);
      sprite.material.dispose();
    }
    coronas = [];
  };

  // What the spill and corona objects depend on. Live edits to colours, patterns
  // or corona sizes keep the same objects; adding a corona or turning spill off
  // rebuilds them.
  const structureKey = () => {
    const setting = state.setting;
    const sirensOn = Boolean(setting) && state.switches.sirens;
    if (!sirensOn && !state.elsOn) return "off";
    const definitions = sirensOn && Array.isArray(setting.sirens) ? setting.sirens.slice(0, MAX_SIREN_COUNT) : [];
    const coronaIndices = definitions.flatMap((definition, offset) =>
      definition.corona?.size > 0 && definition.corona?.intensity > 0 ? [offset + 1] : []);
    return `${state.spill ? 1 : 0}|${state.haze > 0 ? 1 : 0}|${coronaIndices.join(",")}|${state.elsOn ? 1 : 0}`;
  };

  // Spill and coronas depend on the siren setting; rebuilt only when its
  // structure or the spill switch changes.
  const rebuildSirenObjects = () => {
    disposeSpill();
    disposeCoronas();
    const setting = state.setting;
    const sirensOn = Boolean(setting) && state.switches.sirens;
    if (!sirensOn && !state.elsOn) return;
    if (state.spill) {
      for (let quadrant = 0; quadrant < BODY_LIGHT_QUADRANTS; quadrant += 1) {
        const light = new THREE.PointLight(0xffffff, 0, 0, 2);
        light.castShadow = false;
        group.add(light);
        bodyLights.push(light);
      }
      pool = createLightPool();
      group.add(pool);
    }
    // Fog beams and coronas belong to carcols sirens; ELS lights spill only.
    if (!sirensOn) return;
    if (state.haze > 0) {
      beamGeometry = new THREE.ConeGeometry(1, 1, 48, 1, false);
      for (let index = 0; index < HAZE_BEAM_LIMIT; index += 1) {
        const beam = new THREE.Mesh(beamGeometry, createBeamMaterial());
        beam.name = `light-haze:${index}`;
        // Between the floor and the vehicle, like the stage's own beam.
        beam.renderOrder = -1;
        beam.frustumCulled = false;
        beam.visible = false;
        group.add(beam);
        beams.push(beam);
      }
    }
    const definitions = Array.isArray(setting.sirens) ? setting.sirens.slice(0, MAX_SIREN_COUNT) : [];
    definitions.forEach((definition, offset) => {
      const index = offset + 1;
      // A corona size of 0 means the siren has no corona.
      if (!(definition.corona?.size > 0) || !(definition.corona?.intensity > 0)) return;
      if (!sirens.has(index) && !bones.has(`siren${index}`)) return;
      const clusters = sirens.get(index)?.clusters;
      for (const heads of clusters?.length ? clusters.map((cluster) => cluster.heads) : [null]) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: gradient,
          color: 0x000000,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
          toneMapped: false,
        }));
        sprite.name = `light-corona:siren${index}`;
        sprite.visible = false;
        sprite.renderOrder = 11;
        sprite.layers.set(GLOW_LAYER);
        group.add(sprite);
        coronas.push({ index, sprite, heads });
      }
    });
  };

  const restoreEntry = (entry) => {
    entry.mesh.position.copy(entry.position);
    entry.mesh.quaternion.copy(entry.quaternion);
    entry.mesh.scale.copy(entry.scale);
    entry.mesh.updateMatrix();
  };

  const restoreTransforms = () => {
    for (const siren of sirens.values()) {
      for (const entry of siren.entries) restoreEntry(entry);
      siren.transformed = false;
    }
    spinning = false;
  };

  const scratch = {
    world: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    toCamera: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    spaceQuaternion: new THREE.Quaternion(),
    box: new THREE.Box3(),
    size: new THREE.Vector3(),
    color: new THREE.Color(),
    elsLocal: new THREE.Vector3(),
    elsOffset: new THREE.Vector3(),
    quadrants: Array.from({ length: BODY_LIGHT_QUADRANTS }, () => ({
      color: new THREE.Color(),
      weight: 0,
      anchor: new THREE.Vector3(),
      anchors: 0,
    })),
  };

  const yawDirection = (yaw, target) => target.set(-Math.sin(yaw), Math.cos(yaw), 0);

  function setState(next = {}) {
    const els = next.els?.config ? { config: next.els.config, preview: next.els.preview || null, pack: next.els.pack || null } : null;
    const elsOn = Boolean(els) && elsRunning(els.config, els.preview);
    const switches = normalizeLightSwitches(next.switches);
    // With an ELS VCF in charge the carcols siren lights follow its light
    // stage (DfltSirenLtsActivateAtLstg), not the Sirens switch.
    if (els) switches.sirens = elsOn && evaluateEls(els.config, els.preview, 0, els.pack).sirens;
    elsColors = new Map((els?.config.lights || []).filter((light) => light.kind === "extra").map((light) => [light.id, elsColorHex(light.color)]));
    state = {
      els,
      elsOn,
      setting: next.setting ?? null,
      switches,
      muted: new Set(Array.isArray(next.muted) ? next.muted : []),
      speed: Number.isFinite(next.speed) ? Math.max(0, next.speed) : 1,
      spill: next.spill !== false,
      // Scales ground and body spill; 1 is the calibrated default.
      spillStrength: Number.isFinite(next.spillStrength) ? Math.max(0, Math.min(3, next.spillStrength)) : 1,
      // Scales bloom and coronas; 1 is the calibrated default.
      glow: Number.isFinite(next.glow) ? Math.max(0, Math.min(2, next.glow)) : 1,
      // Fog beams from the lit spot heads; 0 builds none.
      haze: Number.isFinite(next.haze) ? Math.max(0, Math.min(2, next.haze)) : 0,
      // Preview lens colours by siren number (normalizeLensTints).
      lens: normalizeLensTints(next.lens),
    };
    const nextStructure = structureKey();
    if (nextStructure !== structure) {
      structure = nextStructure;
      rebuildSirenObjects();
    }
    if (!state.switches.sirens && spinning) restoreTransforms();
  }

  /** Advances the clock and applies the frame. Returns true while lights animate. */
  function update(camera, now = performance.now()) {
    if (!state.elsOn && elsDriven.size) releaseElsExtras();
    if (!anyLightOn(state.switches) && !steadyShown() && !state.elsOn) {
      if (!idle) {
        for (const entry of entries) if (entry.overlay) entry.overlay.visible = false;
        for (const { sprite } of coronas) sprite.visible = false;
        if (spinning) restoreTransforms();
        idle = true;
      }
      lastNow = null;
      return false;
    }
    idle = false;
    const clockBefore = clock;
    if (lastNow != null) {
      const elapsed = Math.min(0.25, Math.max(0, (now - lastNow) / 1000));
      clock += elapsed * state.speed;
      lampClock += elapsed;
    }
    lastNow = now;
    const spillStep = clock - clockBefore;
    const frame = evaluateLights(state.setting, state.switches, clock, lampNames, lampClock);
    const elsFrame = state.elsOn ? evaluateEls(state.els.config, state.els.preview, clock * 1000, state.els.pack) : null;
    if (elsFrame) {
      ensureElsIndex();
      driveElsExtras(elsFrame);
    }
    const elsEmission = elsFrame ? sirenEmission(state.switches.night) : null;
    const sirenStates = new Map(frame.sirens.map((siren) => [siren.siren, siren]));

    // Sirens turn to their heading (rotators keep turning), and `scale` sirens
    // grow, every mesh on their bone about the bone pivot:
    // position = pivot + s * R * (rest - pivot).
    let turned = false;
    for (const siren of sirens.values()) {
      const sirenState = sirenStates.get(siren.index);
      const muted = state.muted.has(siren.index);
      const turn = sirenTurn(siren, sirenState);
      const grow = sirenState && !muted ? sirenState.scale : 1;
      if (!turn && grow === 1) {
        if (siren.transformed) {
          for (const entry of siren.entries) restoreEntry(entry);
          siren.transformed = false;
        }
        continue;
      }
      scratch.quaternion.setFromAxisAngle(siren.axis, turn);
      for (const entry of siren.entries) {
        entry.mesh.quaternion.copy(scratch.quaternion).multiply(entry.quaternion);
        entry.mesh.scale.copy(entry.scale).multiplyScalar(grow);
        entry.mesh.position.copy(entry.position).sub(siren.pivot).multiplyScalar(grow)
          .applyQuaternion(scratch.quaternion).add(siren.pivot);
        entry.mesh.updateMatrix();
      }
      siren.transformed = true;
      turned = true;
    }
    if (spinning && !turned) restoreTransforms();
    spinning = turned;

    model.updateMatrixWorld(true);
    const worldScale = space.matrixWorld.getMaxScaleOnAxis() || 1;
    space.matrixWorld.decompose(scratch.world, scratch.spaceQuaternion, scratch.size);

    for (const entry of entries) {
      const overlay = entry.overlay;
      if (!overlay) continue;
      let strength = 0;
      let color = "#ffffff";
      let alpha = 1;
      let lens = null;
      if (entry.light.kind === "siren") {
        const sirenState = sirenStates.get(entry.light.siren);
        if (sirenState && !state.muted.has(entry.light.siren)) {
          strength = sirenState.strength;
          color = sirenState.color;
          alpha = sirenState.alpha;
          const tint = state.lens[entry.light.siren];
          lens = tint === "siren" ? color : tint || null;
          overlay.material.userData.glowGain.value = (sirenState.energy || 0) * EMISSIVE_GAIN;
        }
      } else if (elsFrame && elsFrame.driven.has(entry.extra)) {
        // An ELS-switched extra (lamp-authored ones included, as many ELS
        // packs use the extralight ids): hidden when dark, so a shown one is lit.
        strength = elsEmission.strength;
        color = elsColors.get(entry.extra) || color;
        overlay.material.userData.glowGain.value = elsEmission.energy * EMISSIVE_GAIN;
      } else if (entry.light.kind === "lamp") {
        const lamp = frame.lamps[entry.light.name];
        strength = lamp?.strength || 0;
        color = lamp?.color || color;
        overlay.material.userData.glowGain.value = (lamp?.energy || 0) * EMISSIVE_GAIN;
      } else if (entry.light.kind === "steady") {
        strength = frame.steady.strength;
        overlay.material.userData.glowGain.value = (frame.steady.energy || 0) * EMISSIVE_GAIN;
      }
      const visible = strength > 0 && isShown(entry.mesh, model);
      overlay.visible = visible;
      if (!visible) continue;
      // The emitter's texture shapes and colours the glow: the game's emissive
      // is texel colour times intensity, so a siren's carcols colour drives its
      // corona and spill light, not the mesh. Untextured emitters glow solid in
      // the siren or lamp colour. A preview lens tint recolours either kind.
      const sourceMaterial = Array.isArray(entry.mesh.material) ? entry.mesh.material[0] : entry.mesh.material;
      const map = sourceMaterial?.map || null;
      const glowMode = map ? "texture" : "solid";
      if (lens) color = lens;
      else if (map) color = "#ffffff";
      const glowMaterial = overlay.material;
      glowMaterial.userData.glowKeepHue.value = lens ? 0 : 1;
      if (glowMaterial.map !== map || glowMaterial.userData.glowMode !== glowMode) {
        glowMaterial.map = map;
        glowMaterial.transparent = Boolean(map);
        // Dark and empty texels write no depth, so they cannot hide emitters behind them.
        glowMaterial.alphaTest = map ? 0.01 : 0;
        glowMaterial.userData.glowMode = glowMode;
        glowMaterial.needsUpdate = true;
      }
      // A hot lamp burns slightly toward white at its core; the bloom keeps the colour.
      overlay.material.color.set(color).lerp(WHITE, HOT_CORE).multiplyScalar(strength * alpha);
      overlay.matrix.copy(entry.mesh.matrixWorld);
      overlay.matrixWorldNeedsUpdate = true;
    }

    // Spill: the ground pool takes every lit siren with `light` set; the body
    // lights merge them into one point light per vehicle quadrant.
    const setting = state.setting;
    const hazeSources = [];
    if (pool || bodyLights.length || beams.length) {
      // Body spill lights reach a fixed distance; the ground uses the carcols falloff.
      const range = 14 * worldScale;
      for (const quadrant of scratch.quadrants) {
        quadrant.color.setRGB(0, 0, 0);
        quadrant.weight = 0;
        quadrant.anchor.set(0, 0, 0);
        quadrant.anchors = 0;
      }
      let count = 0;
      const definitions = Array.isArray(setting?.sirens) ? setting.sirens : [];
      const inner = Number.isFinite(setting?.lightInnerConeAngle) ? setting.lightInnerConeAngle : 10;
      const outer = Number.isFinite(setting?.lightOuterConeAngle) ? Math.max(setting.lightOuterConeAngle, inner, 1) : 70;
      if (pool) {
        // Rage cone angles are half-angles from the aim.
        pool.material.uniforms.uCone.value.set(
          Math.cos(THREE.MathUtils.degToRad(Math.min(outer, 89))),
          Math.cos(THREE.MathUtils.degToRad(Math.min(inner, outer - 0.5))),
        );
        const falloffMax = Number.isFinite(setting?.lightFalloffMax) && setting.lightFalloffMax > 0 ? setting.lightFalloffMax : 30;
        const exponent = Number.isFinite(setting?.lightFalloffExponent) && setting.lightFalloffExponent > 0 ? setting.lightFalloffExponent : 8;
        pool.material.uniforms.uFalloff.value.set(falloffMax * worldScale, exponent);
      }
      const clusterLimit = (HEAD_CLUSTER_DISTANCE * HEAD_CLUSTER_DISTANCE);
      // Paused or scrubbing: show the step exactly; playing: ease toward it.
      const ease = spillStep > 0 ? 1 - Math.exp(-spillStep / SPILL_SMOOTHING) : 1;
      for (const sirenState of frame.sirens) {
        const definition = definitions[sirenState.siren - 1];
        const target = sirenState.on && definition?.light && !state.muted.has(sirenState.siren)
          ? Math.max(0, sirenState.intensity) * sirenState.alpha : 0;
        const previous = spillEnergy.get(sirenState.siren) ?? 0;
        const energy = previous + (target - previous) * ease;
        spillEnergy.set(sirenState.siren, energy);
        if (!definition?.light) continue;
        const siren = sirens.get(sirenState.siren);
        if (!siren?.heads.length) continue;
        // Body lights stay at the centre of every spill head in their quadrant,
        // lit or not. Following only the lit heads made the light, and its
        // highlight on the body, jump with each pattern step.
        if (bodyLights.length) {
          for (const head of siren.heads) {
            if (!isShown(head.entry.mesh, model)) continue;
            const local = scratch.world.copy(head.center).applyMatrix4(head.entry.mesh.matrix);
            const quadrant = scratch.quadrants[(local.x >= 0 ? 1 : 0) + (local.y >= 0 ? 2 : 0)];
            quadrant.anchor.add(local);
            quadrant.anchors += 1;
          }
        }
        if (energy < 0.01) continue;
        // Spill comes from where the heads are after scaling, not from the bone:
        // packed emitters land far from their siren bone. Heads of one siren in
        // different places (bar and grille) each light the ground.
        const clusters = [];
        for (const head of siren.heads) {
          if (!isShown(head.entry.mesh, model)) continue;
          const local = head.center.clone().applyMatrix4(head.entry.mesh.matrix);
          const cluster = clusters.find((entry) => entry.sum.clone().divideScalar(entry.count).distanceToSquared(local) < clusterLimit);
          if (cluster) {
            cluster.sum.add(local);
            cluster.count += 1;
          } else clusters.push({ sum: local.clone(), count: 1 });
        }
        if (!clusters.length) continue;
        scratch.color.set(sirenState.color).multiplyScalar(energy);
        // Aim: the siren's yaw in world space, as an angle on the ground plane.
        yawDirection(sirenState.yaw, scratch.dir).applyQuaternion(scratch.spaceQuaternion);
        const aim = definition.spotLight ? Math.atan2(scratch.dir.x, scratch.dir.z) : -10;
        for (const cluster of clusters) {
          const local = cluster.sum.divideScalar(cluster.count);
          if (beams.length && definition.spotLight) {
            hazeSources.push({
              position: space.localToWorld(local.clone()),
              direction: scratch.dir.clone(),
              color: new THREE.Color(sirenState.color),
              energy,
            });
          }
          if (pool && count < POOL_SOURCE_LIMIT) {
            space.localToWorld(scratch.world.copy(local));
            pool.material.uniforms.uPositions.value[count].set(scratch.world.x, scratch.world.y, scratch.world.z, range);
            pool.material.uniforms.uColors.value[count].set(scratch.color.r, scratch.color.g, scratch.color.b, aim);
            count += 1;
          }
          if (bodyLights.length) {
            const quadrant = scratch.quadrants[(local.x >= 0 ? 1 : 0) + (local.y >= 0 ? 2 : 0)];
            quadrant.color.add(scratch.color);
            quadrant.weight += energy;
          }
        }
      }
      // ELS environment lights: one omni source per lit extra, at the extra
      // plus the VCF offset (vehicle space), eased like siren spill.
      if (elsFrame) {
        for (const light of state.els.config.lights) {
          if (light.kind !== "extra" || !light.envLight || !elsFrame.driven.has(light.id)) continue;
          const center = elsIndex.centers.get(light.id);
          if (!center) continue;
          const local = scratch.elsLocal.copy(center).add(scratch.elsOffset.fromArray(light.offset));
          if (bodyLights.length) {
            const quadrant = scratch.quadrants[(local.x >= 0 ? 1 : 0) + (local.y >= 0 ? 2 : 0)];
            quadrant.anchor.add(local);
            quadrant.anchors += 1;
          }
          const key = `els:${light.id}`;
          const target = elsFrame.lit.has(light.id) ? ELS_ENV_ENERGY : 0;
          const previous = spillEnergy.get(key) ?? 0;
          const energy = previous + (target - previous) * ease;
          spillEnergy.set(key, energy);
          if (energy < 0.01) continue;
          scratch.color.set(elsColors.get(light.id) || "#ffffff").multiplyScalar(energy);
          if (pool && count < POOL_SOURCE_LIMIT) {
            space.localToWorld(scratch.world.copy(local));
            pool.material.uniforms.uPositions.value[count].set(scratch.world.x, scratch.world.y, scratch.world.z, range);
            pool.material.uniforms.uColors.value[count].set(scratch.color.r, scratch.color.g, scratch.color.b, -10);
            count += 1;
          }
          if (bodyLights.length) {
            const quadrant = scratch.quadrants[(local.x >= 0 ? 1 : 0) + (local.y >= 0 ? 2 : 0)];
            quadrant.color.add(scratch.color);
            quadrant.weight += energy;
          }
        }
      }
      if (pool) {
        pool.material.uniforms.uCount.value = count;
        scratch.box.setFromObject(model);
        if (!scratch.box.isEmpty()) {
          scratch.box.getCenter(scratch.size);
          pool.material.uniforms.uFloorY.value = scratch.box.min.y;
          // Shadowing body: the footprint inset a little (lights on the surface
          // stay outside it), from above the wheels to below the roof bar.
          if (!footprint.isEmpty()) {
            const size = footprint.getSize(new THREE.Vector3());
            const bodyMin = new THREE.Vector3(footprint.min.x + size.x * 0.06, footprint.min.y + size.y * 0.05, footprint.min.z + size.z * 0.18);
            const bodyMax = new THREE.Vector3(footprint.max.x - size.x * 0.06, footprint.max.y - size.y * 0.05, footprint.min.z + size.z * 0.8);
            const center = bodyMin.clone().add(bodyMax).multiplyScalar(0.5);
            const u = pool.material.uniforms;
            u.uBoxCenter.value.copy(space.localToWorld(center));
            u.uBoxX.value.set(1, 0, 0).applyQuaternion(scratch.spaceQuaternion).normalize();
            u.uBoxY.value.set(0, 1, 0).applyQuaternion(scratch.spaceQuaternion).normalize();
            u.uBoxZ.value.set(0, 0, 1).applyQuaternion(scratch.spaceQuaternion).normalize();
            u.uBoxHalf.value.copy(bodyMax).sub(bodyMin).multiplyScalar(0.5 * worldScale);
          }
          pool.position.set(scratch.size.x, scratch.box.min.y + 0.003 * worldScale, scratch.size.z);
          pool.scale.setScalar(POOL_RADIUS * 2 * worldScale);
          pool.updateMatrixWorld();
        }
        pool.material.uniforms.uStrength.value = POOL_STRENGTH * state.spillStrength;
        pool.visible = count > 0 && state.spillStrength > 0;
      }
      bodyLights.forEach((light, index) => {
        const quadrant = scratch.quadrants[index];
        if (quadrant.weight <= 0 || quadrant.anchors === 0) {
          light.intensity = 0;
          return;
        }
        // Quadrant's head centre in vehicle space, pushed out past the side of the body.
        light.position.copy(quadrant.anchor).multiplyScalar(1 / quadrant.anchors);
        if (!footprint.isEmpty()) {
          light.position.x = index % 2 === 1 ? footprint.max.x + BODY_LIGHT_OFFSET : footprint.min.x - BODY_LIGHT_OFFSET;
        }
        space.localToWorld(light.position);
        const total = quadrant.color.r + quadrant.color.g + quadrant.color.b;
        light.color.copy(quadrant.color).multiplyScalar(total > 0 ? 3 / total : 0);
        light.intensity = BODY_LIGHT_CANDELA * state.spillStrength * Math.min(quadrant.weight, 12) * worldScale * worldScale;
        light.distance = range;
      });

      // Fog: the brightest lit spot heads get a beam along their aim, tilted
      // slightly down so it meets the floor. Colour is the siren's own.
      if (beams.length) {
        hazeSources.sort((a, b) => b.energy - a.energy);
        let floorY = pool?.material.uniforms.uFloorY.value;
        if (!Number.isFinite(floorY) || !pool) {
          scratch.box.setFromObject(model);
          floorY = scratch.box.isEmpty() ? 0 : scratch.box.min.y;
        }
        const halfAngle = THREE.MathUtils.degToRad(Math.max(6, Math.min(32, inner + (outer - inner) * 0.3)));
        const spread = Math.tan(halfAngle);
        const length = HAZE_LENGTH * worldScale;
        beams.forEach((beam, index) => {
          const source = hazeSources[index];
          if (!source) {
            beam.visible = false;
            return;
          }
          const axis = source.direction.setY(source.direction.y - HAZE_PITCH).normalize();
          const radius = spread * length;
          // Cone apex at +Y; turn +Y to point back at the light.
          beam.quaternion.setFromUnitVectors(CONE_UP, scratch.toCamera.copy(axis).negate());
          beam.scale.set(radius * 1.03, length, radius * 1.03);
          beam.position.copy(source.position).addScaledVector(axis, length / 2);
          const u = beam.material.uniforms;
          u.uApex.value.copy(source.position);
          u.uAxis.value.copy(axis);
          u.uLength.value = length;
          u.uSpread.value = spread;
          u.uFloorY.value = floorY;
          u.uColor.value.copy(source.color);
          u.uStrength.value = state.haze * HAZE_STRENGTH * Math.min(1.5, Math.sqrt(source.energy / 2.5));
          beam.visible = true;
        });
      }
    } else {
      for (const beam of beams) beam.visible = false;
    }

    // Coronas sit on their heads as they are now (turned and scaled), or on the
    // bone for sirens without lit meshes, pulled toward the camera so the lens
    // does not hide them. faceCamera=false fades them away from the light's direction.
    for (const { index, sprite, heads } of coronas) {
      const sirenState = sirenStates.get(index);
      const corona = sirenState?.corona;
      let shown = Boolean(sirenState?.on && camera) && !state.muted.has(index);
      if (shown && heads) {
        scratch.world.set(0, 0, 0);
        let count = 0;
        for (const head of heads) {
          if (!isShown(head.entry.mesh, model)) continue;
          scratch.world.add(scratch.size.copy(head.center).applyMatrix4(head.entry.mesh.matrix));
          count += 1;
        }
        shown = count > 0;
        if (shown) scratch.world.divideScalar(count);
      } else if (shown) {
        const siren = sirens.get(index);
        const pivot = siren?.pivot || bones.get(`siren${index}`)?.position;
        shown = Boolean(pivot) && isShown(siren?.entries[0]?.mesh || space, model);
        if (shown) scratch.world.copy(pivot);
      }
      if (!shown) {
        sprite.visible = false;
        continue;
      }
      space.localToWorld(scratch.world);
      scratch.toCamera.copy(camera.position).sub(scratch.world).normalize();
      let facing = 1;
      if (!corona.faceCamera) {
        yawDirection(sirenState.yaw, scratch.dir).applyQuaternion(scratch.spaceQuaternion);
        facing = THREE.MathUtils.smoothstep(scratch.dir.dot(scratch.toCamera), -0.25, 0.6);
      }
      const level = facing * Math.min(1, corona.intensity / 20) * sirenState.alpha * state.glow * 0.6;
      sprite.visible = level > 0.01;
      if (!sprite.visible) continue;
      const size = corona.size * CORONA_SCALE * worldScale;
      const pull = (Number.isFinite(corona.pull) ? corona.pull : 0.1) * worldScale;
      sprite.position.copy(scratch.world).addScaledVector(scratch.toCamera, pull + size * 0.1);
      sprite.scale.set(size, size, 1);
      sprite.material.color.set(sirenState.color).multiplyScalar(level);
    }

    const sirensRunning = lightsAnimate(state.setting, { ...state.switches, indicators: "off" }) && state.speed > 0;
    const elsFlashing = Boolean(elsFrame) && state.speed > 0 && Object.values(elsFrame.groups).some((group) => group.active);
    return sirensRunning || elsFlashing || state.switches.indicators !== "off";
  }

  // Shows each ELS-controlled extra while the preview lights it and hides it
  // otherwise. LOD and mod-kit hiding still win.
  function driveElsExtras(elsFrame) {
    for (const extra of elsDriven) if (!elsFrame.driven.has(extra)) releaseExtra(extra);
    for (const extra of elsFrame.driven) {
      const lit = elsFrame.lit.has(extra);
      for (const mesh of elsIndex.meshes.get(extra) || []) {
        mesh.visible = lit && mesh.userData.nativeLodActive !== false && mesh.userData.modHidden !== true;
      }
    }
    elsDriven = new Set(elsFrame.driven);
  }

  function releaseExtra(extra) {
    for (const mesh of elsIndex?.meshes.get(extra) || []) {
      mesh.visible = mesh.userData.metaExtraVisible !== false && mesh.userData.nativeLodActive !== false && mesh.userData.modHidden !== true;
    }
  }

  // Hands every ELS-switched extra back to the host's extras plan.
  function releaseElsExtras() {
    for (const extra of elsDriven) releaseExtra(extra);
    elsDriven = new Set();
  }

  /** Moves the light clock to `seconds`, for scrubbing a paused pattern. */
  function setTime(seconds) {
    clock = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    lastNow = null;
  }

  /**
   * World position of each siren's light heads where they show while lit
   * (turned to their heading and `scale` sirens grown about their bone), or of
   * the siren bone when it has no lit mesh. Returns [{ siren, position }].
   */
  function getSirenAnchors() {
    space.updateWorldMatrix(true, false);
    const definitions = Array.isArray(state.setting?.sirens) ? state.setting.sirens : [];
    const out = [];
    const indices = new Set([...sirens.keys()]);
    for (const name of bones.keys()) {
      const match = /^siren(\d+)$/.exec(name);
      if (match) indices.add(Number(match[1]));
    }
    for (const index of [...indices].sort((a, b) => a - b)) {
      const siren = sirens.get(index);
      const definition = definitions[index - 1];
      const grow = definition?.scale ? sirenFlashScale(definition.scaleFactor) : 1;
      const turn = siren && definition ? sirenTurn(siren, { rotate: false, spin: 0, yaw: sirenHeading(definition) }) : 0;
      const local = siren
        ? siren.restCenter.clone().sub(siren.pivot).multiplyScalar(grow).applyAxisAngle(siren.axis, turn).add(siren.pivot)
        : bones.get(`siren${index}`).position.clone();
      if (siren && !isShown(siren.entries[0].mesh, model)) continue;
      out.push({ siren: index, position: space.localToWorld(local) });
    }
    return out;
  }

  /**
   * Finds the sirens on the far side of the body from `eye` (world space):
   * more than a metre of opaque geometry lies between the camera and the
   * light. Lightbar housings, grilles and lamp lenses in front of a head are
   * thinner than that, so in-lamp and lightbar heads still count as facing
   * the camera. Raycasting a whole vehicle takes tens of milliseconds, so the
   * scan runs in slices: `step(budgetMs)` returns true once `far` (a Set of
   * siren indices) is complete.
   */
  function scanFarSirens(eye, anchors = getSirenAnchors()) {
    const far = new Set();
    const emitters = new Set(entries.map((entry) => entry.mesh));
    const occluders = [];
    model.traverse((object) => {
      if (!object.isMesh || emitters.has(object) || !isShown(object, model)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.some((material) => material && !material.transparent && !(material.transmission > 0) && material.opacity >= 1)) {
        occluders.push(object);
      }
    });
    const origin = eye.clone();
    const gap = FAR_SIDE_DEPTH * (space.matrixWorld.getMaxScaleOnAxis() || 1);
    const raycaster = new THREE.Raycaster();
    const direction = new THREE.Vector3();
    const hits = [];
    let next = 0;
    return {
      far,
      step(budgetMs = Infinity) {
        const start = performance.now();
        while (next < anchors.length) {
          const { siren, position } = anchors[next++];
          direction.copy(position).sub(origin);
          const distance = direction.length();
          if (distance > gap) {
            raycaster.set(origin, direction.divideScalar(distance));
            raycaster.far = distance - gap;
            for (const mesh of occluders) {
              hits.length = 0;
              mesh.raycast(raycaster, hits);
              if (hits.length) {
                far.add(siren);
                break;
              }
            }
          }
          if (performance.now() - start >= budgetMs) break;
        }
        return next >= anchors.length;
      },
    };
  }

  function dispose() {
    releaseElsExtras();
    restoreTransforms();
    disposeSpill();
    disposeCoronas();
    for (const entry of entries) {
      if (!entry.overlay) continue;
      group.remove(entry.overlay);
      entry.overlay.material.dispose();
    }
    scene.remove(group);
    releaseGradient();
  }

  const rig = {
    model,
    group,
    lampNames,
    litSirens,
    sirenBones: [...bones.keys()].filter((name) => /^siren\d+$/.test(name)),
    setState,
    setTime,
    getSirenAnchors,
    scanFarSirens,
    update,
    dispose,
    get time() {
      return clock;
    },
    get glow() {
      return state.glow;
    },
    /** True when any light is switched on, so bloom and continuous frames are worth their cost. */
    get active() {
      return anyLightOn(state.switches) || steadyShown() || state.elsOn;
    },
    /** True while an ELS preview is switching extras. */
    get elsActive() {
      return state.elsOn;
    },
  };
  return rig;
}
