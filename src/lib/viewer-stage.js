import * as THREE from "three";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";
import { SHOWROOM_FLOORS } from "./showroom-floors.js";

/* The viewer's stage: everything around the model that is not the model.

   Workbench: the user's backdrop colour or image, a fading measurement grid,
   and a shadow catcher wide enough that shadows are never clipped.

   Showroom: the vehicle parked in a dark void on a floor finish from
   showroom-floors.js (satin concrete by default). The floor carries fine
   grain and soft, blurred reflections that sharpen towards
   the tyres, then fades into the void colour long before any horizon. One
   spotlight, aimed from the top, front, back or either side, lights the
   vehicle, leaves a pool and a cast shadow on the floor, and moves the studio
   softbox the paint reflects. Built for photos.

   The stage only reacts to fit() (model bounds) and option changes; nothing
   here runs work per frame beyond what three renders.

   `subject: "ped"` adapts it to a person: light directions are measured from
   the ped's front (peds face +Z, vehicles -Z), and a rim light, floor finishes
   and a floor scroll (for in-place walk cycles) become available. Vehicles
   keep the defaults.

   `subject: "prop"` scales the studio to a hand-held object: the stage may be
   centimetres across, the floor pattern and grid shrink with it, and the
   showroom floor also takes light from up to four of the prop's own lights
   (setAccentLights) so a flashlight pools on it in a dark room.

   A lineup (Multi, fit with `bays`) gives each visible vehicle its own bay:
   a spot from the chosen direction, a pool, a beam and a contact shadow, so a
   row of vehicles reads as a showroom floor instead of one wide cone. */

export const STAGE_MODES = ["workbench", "showroom"];

const FLOOR_EXTENT = 32; // workbench grid and catcher size in model radii

// Where the showroom light sits, as a unit vector from the vehicle towards the
// light. Vehicles face -Z and their right-hand side is +X (see camera presets).
const SIDE_ELEVATION = THREE.MathUtils.degToRad(38);
export const SHOWROOM_LIGHTS = {
  top: new THREE.Vector3(0, 1, 0.08).normalize(),
  front: new THREE.Vector3(0, Math.sin(SIDE_ELEVATION), -Math.cos(SIDE_ELEVATION)),
  back: new THREE.Vector3(0, Math.sin(SIDE_ELEVATION), Math.cos(SIDE_ELEVATION)),
  left: new THREE.Vector3(-Math.cos(SIDE_ELEVATION), Math.sin(SIDE_ELEVATION), 0),
  right: new THREE.Vector3(Math.cos(SIDE_ELEVATION), Math.sin(SIDE_ELEVATION), 0),
};
export const SHOWROOM_LIGHT_KEYS = Object.keys(SHOWROOM_LIGHTS);

// Showroom floor finishes (showroom-floors.js). Concrete is the vehicle
// default. The shader picks a finish by its index in the list.
export { SHOWROOM_FLOORS };
const floorIndex = (id) => SHOWROOM_FLOORS.indexOf(id);
const TILE_SIZE = 0.6; // metres

// One tone for the void: the floor fades into exactly this colour well before
// the horizon, so no edge of the stage is ever visible. The fade is by distance
// from the vehicle, not scene fog, so the vehicle itself never greys out.
const SHOWROOM_VOID = new THREE.Color("#0d0e11");
// Neutral, a touch cool: a warm key turns the dark floor brown.
const SPOT_COLOR = new THREE.Color("#f4f6fa");
// Floor irradiance under a spotlight at 100%, independent of model size.
const POOL_IRRADIANCE = 0.3;
// Prop lights the showroom floor can receive (setAccentLights).
export const STAGE_ACCENT_LIMIT = 4;
// Vehicles a lineup showroom lights one by one (fit with `bays`); matches
// Multi's lineup size.
export const STAGE_BAY_LIMIT = 6;

// Furthest the showroom camera may orbit, in model radii: inside the floor's
// fade and the void dome, so the stage never shows its edges.
const SHOWROOM_REACH = 4.5;
// Vehicle spotlights hang this many stage radii from what they light, high
// enough that the lamp and the bright top of its beam stay above the frame at
// any orbit inside SHOWROOM_REACH, and inside the void dome (7 radii). Cone
// angle and candela follow the distance, so the floor pool does not change.
const VEHICLE_SPOT_HANG = 6;

function collectVisibleMeshes(models) {
  const meshes = [];
  for (const model of Array.isArray(models) ? models : [models]) {
    model?.traverseVisible?.((child) => {
      if (child.isMesh && child.geometry) meshes.push(child);
    });
  }
  return meshes;
}

function visibleBounds(meshes) {
  if (!meshes.length) return null;
  const bounds = new THREE.Box3();
  const box = new THREE.Box3();
  for (const mesh of meshes) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    mesh.updateWorldMatrix(true, false);
    bounds.union(box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
  }
  return bounds.isEmpty() ? null : bounds;
}

function isLightColor(color) {
  const c = new THREE.Color(color || "#141414");
  return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722 > 0.45;
}

/* Showroom floor, drawn by a Reflector so it owns the mirror render. The
   surface is lit analytically by the stage spot (the real spot still lights
   the vehicle and casts its shadow onto the catcher above), darkened under
   the vehicle footprint for contact, and textured with band-limited noise so
   distant grain fades instead of shimmering. Reflections are a rotated
   golden-angle blur over the mirror's mip chain, stretched vertically the way
   rough floors smear highlights, and widening with distance from the tyres. */
const SHOWROOM_FLOOR_SHADER = {
  name: "ShowroomFloorShader",
  uniforms: THREE.UniformsUtils.merge([
    {
      color: { value: null },
      tDiffuse: { value: null },
      textureMatrix: { value: null },
      uTexSize: { value: new THREE.Vector2(512, 512) },
      uVoid: { value: SHOWROOM_VOID.clone() },
      uAlbedo: { value: 0.3 },
      uCenter: { value: new THREE.Vector2() },
      uHalf: { value: new THREE.Vector2(1, 1) },
      // Turntable yaw: every contact footprint turns about its own centre.
      uSpin: { value: 0 },
      uRadius: { value: 2.5 },
      uSpotPos: { value: new THREE.Vector3(0, 5, 0) },
      uSpotDir: { value: new THREE.Vector3(0, -1, 0) },
      uSpotCone: { value: new THREE.Vector2(0.9, 0.95) },
      uSpotPower: { value: 1 },
      uSpotColor: { value: SPOT_COLOR.clone() },
      uReflect: { value: 0.6 },
      uFade: { value: new THREE.Vector2(4, 12) },
      uStyle: { value: 0 },
      uTile: { value: TILE_SIZE },
      uScroll: { value: new THREE.Vector2() },
      uPattern: { value: 1 },
      uAccentPos: { value: Array.from({ length: STAGE_ACCENT_LIMIT }, () => new THREE.Vector4()) },
      uAccentDir: { value: Array.from({ length: STAGE_ACCENT_LIMIT }, () => new THREE.Vector4()) },
      uAccentColor: { value: Array.from({ length: STAGE_ACCENT_LIMIT }, () => new THREE.Vector4()) },
      uAccentCount: { value: 0 },
      // Lineup bays: per vehicle, the spot (xyz position, w power), its axis,
      // cone, and the contact footprint (xy centre, zw half size).
      uBaySpot: { value: Array.from({ length: STAGE_BAY_LIMIT }, () => new THREE.Vector4()) },
      uBayDir: { value: Array.from({ length: STAGE_BAY_LIMIT }, () => new THREE.Vector3(0, -1, 0)) },
      uBayCone: { value: Array.from({ length: STAGE_BAY_LIMIT }, () => new THREE.Vector2(0.9, 0.95)) },
      uBayBox: { value: Array.from({ length: STAGE_BAY_LIMIT }, () => new THREE.Vector4(0, 0, 1, 1)) },
      // Per-bay tint of the stage spot colour; white unless a bay sets its own.
      uBayColor: { value: Array.from({ length: STAGE_BAY_LIMIT }, () => new THREE.Vector3(1, 1, 1)) },
      uBayCount: { value: 0 },
    },
  ]),
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorld = world.xyz;
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `,
  fragmentShader: /* glsl */ `
    #include <common>
    #include <dithering_pars_fragment>
    uniform sampler2D tDiffuse;
    uniform vec2 uTexSize;
    uniform vec3 uVoid;
    uniform float uAlbedo;
    uniform vec2 uCenter;
    uniform vec2 uHalf;
    uniform float uSpin;
    uniform float uRadius;
    uniform vec3 uSpotPos;
    uniform vec3 uSpotDir;
    uniform vec2 uSpotCone;
    uniform float uSpotPower;
    uniform vec3 uSpotColor;
    uniform float uReflect;
    uniform vec2 uFade;
    uniform int uStyle;
    uniform float uTile;
    uniform vec2 uScroll;
    uniform float uPattern;
    #define FLOOR_POLISHED ${floorIndex("polished")}
    #define FLOOR_TILES ${floorIndex("tiles")}
    #define FLOOR_MARBLE ${floorIndex("marble")}
    #define FLOOR_CHECKER ${floorIndex("checker")}
    #define FLOOR_EPOXY ${floorIndex("epoxy")}
    #define FLOOR_ASPHALT ${floorIndex("asphalt")}
    #define FLOOR_WOOD ${floorIndex("wood")}
    #define FLOOR_TREAD ${floorIndex("tread")}
    #define ACCENT_LIMIT ${STAGE_ACCENT_LIMIT}
    uniform vec4 uAccentPos[ACCENT_LIMIT];
    uniform vec4 uAccentDir[ACCENT_LIMIT];
    uniform vec4 uAccentColor[ACCENT_LIMIT];
    uniform int uAccentCount;
    #define BAY_LIMIT ${STAGE_BAY_LIMIT}
    uniform vec4 uBaySpot[BAY_LIMIT];
    uniform vec3 uBayDir[BAY_LIMIT];
    uniform vec2 uBayCone[BAY_LIMIT];
    uniform vec4 uBayBox[BAY_LIMIT];
    uniform vec3 uBayColor[BAY_LIMIT];
    uniform int uBayCount;
    varying vec4 vUv;
    varying vec3 vWorld;

    vec3 spotPool(vec3 spotPos, vec3 spotDir, vec2 spotCone, float power) {
      vec3 toLight = spotPos - vWorld;
      float dist = length(toLight);
      vec3 L = toLight / dist;
      float cone = smoothstep(spotCone.x, spotCone.y, dot(-L, spotDir));
      return uSpotColor * (power * cone * max(L.y, 0.0) / (dist * dist));
    }
    // Signed distance from a vehicle's footprint rectangle.
    float footprintEdge(vec2 p, vec2 center, vec2 halfSize) {
      // World xz back into the unspun footprint (a turn of uSpin about +Y).
      vec2 d = p - center;
      float c = cos(uSpin);
      float s = sin(uSpin);
      vec2 q = abs(vec2(c * d.x - s * d.y, s * d.x + c * d.y)) - halfSize;
      return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    }
    float footprintContact(float edge, vec2 halfSize) {
      float soft = max(min(halfSize.x, halfSize.y), 0.05);
      return mix(0.22, 1.0, smoothstep(-0.35 * soft, 0.5 * soft, edge));
    }

    float floorHash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float floorNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = floorHash(i);
      float b = floorHash(i + vec2(1.0, 0.0));
      float c = floorHash(i + vec2(0.0, 1.0));
      float d = floorHash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) - 0.5;
    }
    // One octave, faded out before its cells shrink below a pixel.
    float floorOctave(vec2 p, float freq) {
      vec2 q = p * freq;
      return floorNoise(q) * (1.0 - smoothstep(0.3, 0.8, length(fwidth(q))));
    }
    // 1 while a pattern's cells (q in cells) span a few pixels, fading to 0
    // before they alias.
    float patternDetail(vec2 q) {
      return 1.0 - smoothstep(0.25, 0.6, length(fwidth(q)));
    }
    // 1 on the joints of a grid of size-wide cells, width wide.
    float gridJoint(vec2 t, vec2 size, float width) {
      vec2 f = fract(t / size);
      vec2 edge = min(f, 1.0 - f) * size;
      float gap = min(edge.x, edge.y);
      return 1.0 - smoothstep(width, width + max(fwidth(gap) * 1.5, 0.0005), gap);
    }
    // Box-filtered checkerboard of unit cells: 0 or 1, grey where cells blur.
    float checker(vec2 q) {
      vec2 w = fwidth(q) + 1e-4;
      vec2 i = 2.0 * (abs(fract((q - 0.5 * w) * 0.5) - 0.5) - abs(fract((q + 0.5 * w) * 0.5) - 0.5)) / w;
      return 0.5 - 0.5 * i.x * i.y;
    }

    void main() {
      // p places the floor around the subject; t is the surface pattern, which
      // can scroll under a ped walking in place.
      vec2 p = vWorld.xz;
      vec2 t = p * uPattern + uScroll;
      float mottle = floorOctave(t, 0.32) * 0.55 + floorOctave(t + 7.1, 0.85) * 0.3 + floorOctave(t - 3.7, 2.4) * 0.15;
      float grain = floorOctave(t, 24.0) * 0.5 + floorOctave(t + 1.3, 61.0) * 0.5;
      // Per finish: lit colour, roughness, how the unlit floor reads against
      // the void (shade), mirror strength (gloss) and reflection ripple (bump).
      vec3 albedo = vec3(uAlbedo * clamp(1.0 + mottle * 0.5 + grain * 0.45, 0.4, 1.6));
      float rough = clamp(0.55 + mottle * 0.7, 0.25, 1.0);
      float shade = 1.0;
      float gloss = 1.0;
      float bumpScale = 1.0;
      vec2 bumpExtra = vec2(0.0);
      if (uStyle == FLOOR_POLISHED) {
        // Polished screed: the same stone, ground smooth.
        albedo = vec3(uAlbedo * clamp(0.85 + mottle * 0.4 + grain * 0.15, 0.4, 1.4));
        rough = clamp(0.14 + mottle * 0.3, 0.05, 0.4);
      } else if (uStyle == FLOOR_TILES) {
        // Large-format tiles: per-tile tone, low roughness, dark grout lines.
        vec2 cell = floor(t / uTile);
        float grout = gridJoint(t, vec2(uTile), 0.003);
        float tone = floorHash(cell + 17.0) - 0.5;
        albedo = vec3(uAlbedo * clamp(1.0 + tone * 0.22 + grain * 0.12, 0.5, 1.5) * mix(1.0, 0.35, grout));
        rough = mix(clamp(0.24 + tone * 0.2 + mottle * 0.2, 0.1, 0.5), 1.0, grout);
      } else if (uStyle == FLOOR_MARBLE) {
        // Pale polished marble in 1.2 m slabs. Veins are where domain-warped
        // noise crosses zero, so they meander instead of banding.
        vec2 slab = floor(t / 1.2);
        vec2 w = t + slab * 7.3 + 1.6 * vec2(floorOctave(t, 0.35), floorOctave(t + 5.2, 0.35))
          + 0.5 * vec2(floorOctave(t + 1.7, 1.1), floorOctave(t - 2.9, 1.1));
        float n = floorNoise(w * 0.9) + 0.5 * floorNoise(w * 2.1 + 3.0);
        float veins = (1.0 - smoothstep(0.0, 0.018 + fwidth(n), abs(n))) * patternDetail(w * 1.5);
        float n2 = floorNoise(w * 3.7 + 9.0);
        float fine = (1.0 - smoothstep(0.0, 0.02 + fwidth(n2), abs(n2))) * patternDetail(w * 3.7);
        float tone = floorHash(slab + 5.0) - 0.5;
        float seam = gridJoint(t, vec2(1.2), 0.0012);
        float stone = clamp(1.0 + tone * 0.12 + mottle * 0.2, 0.75, 1.25) * (1.0 - veins * 0.35 - fine * 0.12) * mix(1.0, 0.7, seam);
        albedo = uAlbedo * 1.9 * stone * vec3(1.0, 0.985, 0.96);
        rough = clamp(0.07 + veins * 0.06 + mottle * 0.06, 0.04, 0.2);
        shade = 1.0 + (stone - 1.0) * 0.6;
        bumpScale = 0.35;
      } else if (uStyle == FLOOR_CHECKER) {
        // Black and white 0.45 m glazed tiles with fine grout.
        vec2 q = t / 0.45;
        float white = checker(q);
        float tone = floorHash(floor(q) + 31.0) - 0.5;
        float grout = gridJoint(t, vec2(0.45), 0.002);
        albedo = vec3(uAlbedo * mix(0.12, 2.1, white) * clamp(1.0 + tone * 0.08 + grain * 0.08, 0.8, 1.2) * mix(1.0, 0.4, grout));
        rough = mix(clamp(0.1 + tone * 0.06 + mottle * 0.08, 0.05, 0.25), 0.9, grout);
        shade = mix(0.75, 1.35, white);
        bumpScale = 0.4;
      } else if (uStyle == FLOOR_EPOXY) {
        // Garage epoxy: slate resin, near-mirror gloss, scattered flake.
        vec2 q = t * 28.0;
        vec2 cell = floor(q);
        vec2 at = vec2(floorHash(cell + 11.0), floorHash(cell + 23.0)) * 0.5 + 0.25;
        float flake = (1.0 - smoothstep(0.16, 0.26, length(fract(q) - at))) * step(0.45, floorHash(cell + 3.0)) * patternDetail(q);
        float flakeTone = floorHash(cell + 41.0) < 0.5 ? 0.3 : 2.4;
        float speck = floorOctave(t + 4.4, 90.0);
        albedo = uAlbedo * 0.7 * clamp(1.0 + mottle * 0.15 + speck * 0.5, 0.7, 1.3) * mix(1.0, flakeTone, flake * 0.8) * vec3(0.84, 0.92, 1.06);
        rough = clamp(0.05 + mottle * 0.04 + flake * 0.1, 0.03, 0.18);
        gloss = 1.15;
        bumpScale = 0.2;
      } else if (uStyle == FLOOR_ASPHALT) {
        // Asphalt: pale aggregate in black binder, barely reflective.
        vec2 q = t * 30.0;
        vec2 cell = floor(q);
        vec2 at = vec2(floorHash(cell + 7.0), floorHash(cell + 19.0)) * 0.5 + 0.25;
        float stone = (1.0 - smoothstep(0.15, 0.32, length(fract(q) - at))) * step(0.4, floorHash(cell + 2.0)) * patternDetail(q);
        float stoneTone = 0.8 + floorHash(cell + 29.0) * 1.4;
        albedo = vec3(uAlbedo * 0.6 * clamp(1.0 + mottle * 0.35 + grain * 0.6, 0.5, 1.6) * mix(1.0, stoneTone, stone));
        rough = clamp(0.85 + grain * 0.2, 0.7, 1.0);
        shade = 0.85;
        gloss = 0.35;
        bumpScale = 1.6;
      } else if (uStyle == FLOOR_WOOD) {
        // Lacquered oak boards, 0.2 m by 2.4 m, running front to back with
        // staggered ends.
        float board = floor(t.x / 0.2);
        float along = t.y + floorHash(vec2(board, 3.0)) * 2.4;
        vec2 id = vec2(board, floor(along / 2.4));
        float tone = floorHash(id + 13.0) - 0.5;
        float side = min(fract(t.x / 0.2), 1.0 - fract(t.x / 0.2)) * 0.2;
        float end = min(fract(along / 2.4), 1.0 - fract(along / 2.4)) * 2.4;
        float gap = min(side, end);
        float joint = 1.0 - smoothstep(0.0012, 0.0012 + max(fwidth(gap) * 1.5, 0.0005), gap);
        vec2 g = vec2(t.x * 9.0, t.y * 0.35) + id * 17.3;
        float figure = floorOctave(g, 6.0) * 0.6 + floorOctave(g * vec2(1.0, 0.5) + 2.0, 21.0) * 0.4;
        float wood = clamp(1.0 + tone * 0.35 + figure * 0.55, 0.5, 1.5) * mix(1.0, 0.3, joint);
        albedo = uAlbedo * 1.15 * wood * vec3(1.0, 0.68, 0.42);
        rough = mix(clamp(0.28 + tone * 0.12 + figure * 0.1, 0.15, 0.45), 0.9, joint);
        shade = 1.0 + (wood - 1.0) * 0.5;
        bumpScale = 0.5;
      } else if (uStyle == FLOOR_TREAD) {
        // Aluminium tread plate: raised lugs on a 6 cm grid, alternating
        // 45 degrees, over a brushed sheet.
        vec2 q = t / 0.06;
        vec2 cell = floor(q);
        vec2 f = fract(q) - 0.5;
        vec2 axis = normalize(vec2(1.0, mod(cell.x + cell.y, 2.0) < 0.5 ? 1.0 : -1.0));
        vec2 across = vec2(-axis.y, axis.x);
        vec2 rs = vec2(dot(f, axis), dot(f, across)) / vec2(0.36, 0.075);
        float d = length(rs);
        float detail = patternDetail(q);
        float lug = (1.0 - smoothstep(0.8, 1.0 + fwidth(d), d)) * detail;
        // The lug's sloped rim tilts the reflection outward from its centre.
        vec2 slope = rs.x / 0.36 * axis + rs.y / 0.075 * across;
        float brushed = floorOctave(vec2(t.x * 0.2, t.y * 40.0), 8.0);
        float rim = lug * (1.0 - lug) * 4.0;
        albedo = uAlbedo * 1.2 * clamp(1.0 + brushed * 0.25 + mottle * 0.2, 0.7, 1.3) * mix(1.0, 1.5, lug) * (1.0 - rim * 0.35) * vec3(0.98, 0.99, 1.02);
        rough = clamp(0.32 - lug * 0.12 + brushed * 0.08, 0.12, 0.45);
        gloss = 1.2;
        bumpScale = 0.5;
        bumpExtra = normalize(slope + 1e-5) * rim * 0.006;
      }

      // A lineup gets one pool and one contact shadow per vehicle; a single
      // subject keeps the one stage spot and footprint.
      vec3 irradiance = vec3(0.0);
      float edge = 1e6;
      float contact = 1.0;
      if (uBayCount > 0) {
        for (int i = 0; i < BAY_LIMIT; i++) {
          if (i >= uBayCount) break;
          irradiance += spotPool(uBaySpot[i].xyz, uBayDir[i], uBayCone[i], uBaySpot[i].w) * uBayColor[i];
          float bayEdge = footprintEdge(p, uBayBox[i].xy, uBayBox[i].zw);
          edge = min(edge, bayEdge);
          contact = min(contact, footprintContact(bayEdge, uBayBox[i].zw));
        }
      } else {
        irradiance = spotPool(uSpotPos, uSpotDir, uSpotCone, uSpotPower);
        edge = footprintEdge(p, uCenter, uHalf);
        contact = footprintContact(edge, uHalf);
      }
      // Prop lights, attenuated as the scene lights them (decay 0, windowed by
      // range, smoothstep cone) and brought to the spot term's scale by 1/pi.
      for (int i = 0; i < ACCENT_LIMIT; i++) {
        if (i >= uAccentCount) break;
        vec3 toAccent = uAccentPos[i].xyz - vWorld;
        float accentDist = max(length(toAccent), 1e-4);
        vec3 La = toAccent / accentDist;
        float range = uAccentPos[i].w;
        float window = range > 0.0 ? pow2(saturate(1.0 - pow4(accentDist / range))) : 1.0;
        float accentCone = uAccentDir[i].w < -1.5 ? 1.0 : smoothstep(uAccentDir[i].w, uAccentColor[i].w, dot(-La, uAccentDir[i].xyz));
        irradiance += uAccentColor[i].rgb * (window * accentCone * max(La.y, 0.0) * RECIPROCAL_PI);
      }

      vec3 color = (uVoid * (1.0 + mottle * 0.6 + grain * 0.3) * shade + albedo * irradiance) * contact;

      if (uReflect > 0.001) {
        vec2 bump = vec2(floorOctave(t + 11.0, 9.0), floorOctave(t - 5.0, 9.0))
          + 0.5 * vec2(floorOctave(t + 2.0, 31.0), floorOctave(t - 9.0, 31.0));
        vec2 uv = vUv.xy / vUv.w + bump * 0.006 * bumpScale + bumpExtra;
        float blur = (0.003 + max(edge, 0.0) / uRadius * 0.06) * rough;
        // The mip matches the kernel's real footprint (2.4x taller than wide);
        // a finer one leaves 12 taps too sparse and bright detail sparkles.
        float lod = log2(max(blur * 1.55 * uTexSize.y * 0.5, 1.0));
        float spin = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        vec3 reflection = vec3(0.0);
        float weight = 0.0;
        for (int i = 0; i < 12; i++) {
          float fi = float(i);
          float angle = fi * 2.3999632 + spin;
          vec2 offset = vec2(cos(angle), sin(angle) * 2.4) * sqrt((fi + 0.5) / 12.0) * blur;
          vec3 tap = textureLod(tDiffuse, uv + offset, lod).rgb;
          // Lit emitters (sirens, lamps) are far above 1. Caught by only some
          // taps under the per-pixel rotation, they stipple the floor, and the
          // stipple crawls as the reflection moves. Weighting down the excess
          // over 1 keeps them bright but stable; ordinary content is unchanged.
          float w = 1.0 / (1.0 + max(dot(tap, vec3(0.2126, 0.7152, 0.0722)) - 1.0, 0.0));
          reflection += tap * w;
          weight += w;
        }
        reflection /= weight;
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float fresnel = 0.04 + 0.96 * pow(1.0 - max(viewDir.y, 0.0), 5.0);
        float fade = 1.0 - smoothstep(uRadius * 1.2, uRadius * 4.0, length(p - uCenter));
        color += reflection * uReflect * gloss * mix(0.3, 1.0, fresnel) * (1.25 - rough * 0.5) * fade * mix(0.5, 1.0, contact);
      }

      gl_FragColor = vec4(color, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      // Fade after output conversion so the far floor is exactly the
      // untone-mapped void dome's colour.
      float voidFade = smoothstep(uFade.x, uFade.y, length(p - uCenter));
      gl_FragColor.rgb = mix(gl_FragColor.rgb, linearToOutputTexel(vec4(uVoid, 1.0)).rgb, voidFade);
      #include <dithering_fragment>
    }
  `,
};

/* Studio lighting for reflections: a dim ceiling, long horizontal strips down
   both sides for the body lines, a dark ground for the sills, and one large
   softbox wherever the stage light is aimed from. */
function buildStudioEnvironment(renderer, toLight) {
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color("#030304");
  const glow = (intensity) =>
    new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(intensity), side: THREE.DoubleSide });

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(16, 10), glow(0.4));
  ceiling.position.set(0, 7, 0);
  ceiling.rotation.x = Math.PI / 2;
  envScene.add(ceiling);

  for (const x of [-7, 7]) {
    for (const [y, height, intensity] of [[1.4, 0.35, 2.2], [3, 0.22, 0.9]]) {
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(10, height), glow(intensity));
      strip.position.set(x, y, 0);
      strip.rotation.y = x < 0 ? Math.PI / 2 : -Math.PI / 2;
      envScene.add(strip);
    }
  }

  const ground = new THREE.Mesh(new THREE.CircleGeometry(14, 48), glow(0.025));
  ground.position.y = -1.2;
  ground.rotation.x = -Math.PI / 2;
  envScene.add(ground);

  const overhead = toLight.y > 0.9;
  const softbox = new THREE.Mesh(overhead ? new THREE.PlaneGeometry(3, 8) : new THREE.PlaneGeometry(7, 3.2), glow(8));
  softbox.position.copy(toLight).multiplyScalar(7);
  if (overhead) softbox.rotation.x = Math.PI / 2;
  else softbox.lookAt(0, 0, 0);
  envScene.add(softbox);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(envScene, 0.04);
  pmrem.dispose();
  envScene.traverse((child) => {
    child.geometry?.dispose?.();
    child.material?.dispose?.();
  });
  return target;
}

function createGridMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color("#ffffff") },
      uOpacity: { value: 0.16 },
      uCenter: { value: new THREE.Vector2() },
      uFade: { value: 20 },
      uMinor: { value: 0.5 },
      uMajor: { value: 2.5 },
      uScroll: { value: new THREE.Vector2() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform vec2 uCenter;
      uniform float uFade;
      uniform float uMinor;
      uniform float uMajor;
      uniform vec2 uScroll;
      varying vec3 vWorld;
      float line(vec2 p, float spacing) {
        vec2 cell = p / spacing;
        vec2 g = abs(fract(cell - 0.5) - 0.5) / fwidth(cell);
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        float minor = line(vWorld.xz + uScroll, uMinor) * 0.45;
        float major = line(vWorld.xz + uScroll, uMajor);
        float d = length(vWorld.xz - uCenter);
        float fade = 1.0 - smoothstep(uFade * 0.3, uFade, d);
        float a = max(minor, major) * uOpacity * fade;
        if (a < 0.002) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });
}

function createShadowCatcherMaterial() {
  const material = new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.32 });
  material.depthWrite = false;
  // Fade the catcher towards its edge so a wide floor never shows a seam.
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vCatcher;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvCatcher = position.xy;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vCatcher;")
      .replace(
        "gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );",
        "float catcherFade = 1.0 - smoothstep( 0.18, 0.5, length( vCatcher ) );\n\tgl_FragColor = vec4( color, opacity * catcherFade * ( 1.0 - getShadowMask() ) + ( rand( gl_FragCoord.xy ) - 0.5 ) / 255.0 );",
      );
  };
  return material;
}

/* The visible beam, ray-marched. The closed cone mesh only marks which pixels
   the beam can touch (back faces, so each pixel draws once from outside or
   inside the cone); the glow is the light density summed along that pixel's
   view ray, stopping at the floor plane. So the beam thins smoothly into the
   floor instead of being clipped by it, facets never show, and the mirrored
   camera of the reflection pass sees a correct reflection. It draws after the
   floor and before the vehicle with no depth test: the vehicle covers it. */
const BEAM_STEPS = 24;

export function createBeamMaterial() {
  return new THREE.ShaderMaterial({
    // Opaque queue with additive blending, ordered between floor and vehicle.
    transparent: false,
    depthTest: false,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    // A faint additive glow over a dark void bands in 8-bit output.
    dithering: true,
    uniforms: {
      uColor: { value: SPOT_COLOR.clone() },
      uStrength: { value: 0.3 },
      uApex: { value: new THREE.Vector3(0, 5, 0) },
      uAxis: { value: new THREE.Vector3(0, -1, 0) },
      uLength: { value: 5 },
      uSpread: { value: 0.4 },
      uFloorY: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <dithering_pars_fragment>
      uniform vec3 uColor;
      uniform float uStrength;
      uniform vec3 uApex;
      uniform vec3 uAxis;
      uniform float uLength;
      uniform float uSpread;
      uniform float uFloorY;
      varying vec3 vWorld;

      float beamDensity(vec3 p) {
        vec3 v = p - uApex;
        float t = dot(v, uAxis);
        if (t <= 0.0 || t >= uLength) return 0.0;
        float q = length(v - uAxis * t) / (uSpread * t);
        float h = t / uLength;
        float body = pow(max(1.0 - q * q, 0.0), 1.4);
        float along = smoothstep(0.0, 0.55, 1.0 - h) * (1.0 - (1.0 - smoothstep(0.0, 0.08, h)) * 0.6);
        return body * along;
      }

      void main() {
        vec3 ray = normalize(vWorld - cameraPosition);
        // March only where the cone's bounding sphere and the air above the
        // floor overlap along this ray.
        vec3 mid = uApex + uAxis * (uLength * 0.5);
        float radius = length(vec2(uLength * 0.5, uSpread * uLength));
        vec3 oc = cameraPosition - mid;
        float b = dot(oc, ray);
        float disc = b * b - (dot(oc, oc) - radius * radius);
        if (disc <= 0.0) discard;
        float root = sqrt(disc);
        float s0 = max(-b - root, 0.0);
        float s1 = -b + root;
        float toFloor = (uFloorY - cameraPosition.y) / ray.y;
        if (cameraPosition.y >= uFloorY) {
          if (ray.y < 0.0) s1 = min(s1, toFloor);
        } else {
          if (ray.y <= 0.0) discard;
          s0 = max(s0, toFloor);
        }
        if (s1 <= s0) discard;

        float ds = (s1 - s0) / float(${BEAM_STEPS});
        float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        float sum = 0.0;
        for (int i = 0; i < ${BEAM_STEPS}; i++) {
          sum += beamDensity(cameraPosition + ray * (s0 + (float(i) + jitter) * ds));
        }
        // Normalised by the beam's width at mid-length, so a ray straight
        // through its middle reads about uStrength at any model size.
        float glow = sum * ds / (uSpread * uLength);
        gl_FragColor = vec4(uColor * glow * uStrength, 1.0);
        #include <dithering_fragment>
      }
    `,
  });
}

export function createViewerStage({ renderer, scene, keyLight, subject = "vehicle" }) {
  // Peds face +Z; turning the vehicle light table half a turn keeps "front"
  // meaning the subject's front.
  const facing = subject === "ped" ? -1 : 1;
  const isPed = subject === "ped";
  const isProp = subject === "prop";
  // A person is lit like a stage portrait: side lights sit higher than for a
  // vehicle, so faces are lit from above rather than across.
  const PED_ELEVATION = THREE.MathUtils.degToRad(52);
  const lightDirection = (key) => {
    const base = SHOWROOM_LIGHTS[key] || SHOWROOM_LIGHTS.top;
    const dir = new THREE.Vector3(base.x * facing, base.y, base.z * facing);
    if (!isPed || key === "top") return dir;
    const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    return flat.multiplyScalar(Math.cos(PED_ELEVATION)).setY(Math.sin(PED_ELEVATION));
  };
  const root = new THREE.Group();
  root.name = "viewer-stage";
  root.userData.isStage = true;
  scene.add(root);

  const state = {
    mode: "workbench",
    grid: false,
    shadows: false,
    background: "#141414",
    spot: 1,
    reflect: 0.6,
    beam: true,
    light: "top",
    rim: 0,
    floor: "concrete",
    fitKey: "",
    radius: 2.5,
    center: new THREE.Vector3(),
    half: new THREE.Vector2(1, 1),
    floorY: 0,
    height: 1,
    // Studio light multiplier while the vehicle light preview runs at night.
    night: 1,
    accents: [],
    // Lineup bays from fit(..., { bays: true }): { center, half, radius } per
    // visible vehicle. With two or more, and bayLights on, the showroom lights
    // each vehicle with its own spot instead of one cone over the whole row.
    bays: [],
    bayLights: true,
    // Bays the lineup needs before they replace the stage spot. Photo Mode
    // sets 0: every object lights itself, and no bays means no spot at all.
    bayMinimum: 2,
    // Per-bay settings by model id: { strength, from, color, beam }.
    bayOverrides: new Map(),
  };

  /* ── Workbench ── */
  const plane = new THREE.PlaneGeometry(1, 1);
  const catcher = new THREE.Mesh(plane, createShadowCatcherMaterial());
  catcher.name = "stage-shadow-catcher";
  catcher.rotation.x = -Math.PI / 2;
  catcher.receiveShadow = true;
  catcher.renderOrder = -1;
  root.add(catcher);

  const gridMaterial = createGridMaterial();
  const grid = new THREE.Mesh(plane, gridMaterial);
  grid.name = "stage-grid";
  grid.rotation.x = -Math.PI / 2;
  grid.renderOrder = -2;
  root.add(grid);

  /* ── Showroom ── */
  const showroom = new THREE.Group();
  showroom.name = "stage-showroom";
  root.add(showroom);

  // The floor is the Reflector itself; built on first entry to the showroom.
  let floor = null;
  const reflectionSize = () => {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    return [Math.max(256, Math.round(size.x * 0.5)), Math.max(256, Math.round(size.y * 0.5))];
  };
  const buildFloor = () => {
    const [width, height] = reflectionSize();
    const next = new Reflector(new THREE.PlaneGeometry(1, 1), {
      clipBias: 0.003,
      textureWidth: width,
      textureHeight: height,
      multisample: 0,
      shader: SHOWROOM_FLOOR_SHADER,
    });
    next.name = "stage-floor";
    next.rotation.x = -Math.PI / 2;
    next.renderOrder = -3;
    next.material.dithering = true;
    // Mips feed the rough-reflection blur.
    const texture = next.getRenderTarget().texture;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    next.material.uniforms.uTexSize.value.set(width, height);
    // Skip the mirror pass entirely when reflections are off. Transmissive
    // glass makes three.js draw the opaque scene, floor included, once more
    // before the main pass of the same render call; the mirror rendered there
    // is still current, so the main pass reuses it. Any later render call
    // advances info.render.frame and renders the mirror afresh. Viewers that
    // keep shadow maps across frames (autoUpdate off) render it in both
    // passes: reusing it there lit shadowed interiors seen through glass.
    const renderMirror = next.onBeforeRender;
    let mirrorFrame = -1;
    let mirrorCamera = null;
    next.onBeforeRender = (renderer, scene, camera, ...rest) => {
      if (state.reflect <= 0.01) return;
      const reusable = renderer.shadowMap.autoUpdate;
      if (reusable && camera === mirrorCamera && renderer.info.render.frame === mirrorFrame) return;
      renderMirror(renderer, scene, camera, ...rest);
      mirrorFrame = renderer.info.render.frame;
      mirrorCamera = camera;
    };
    return next;
  };

  const spot = new THREE.SpotLight(SPOT_COLOR, 0, 0, 0.46, 0.7, 2);
  spot.name = "stage-spot";
  spot.castShadow = true;
  // PCF-soft filters in texels, so a moderate map gives a softer studio edge.
  spot.shadow.mapSize.set(1536, 1536);
  spot.shadow.bias = -0.0004;
  spot.shadow.normalBias = 0.03;
  spot.shadow.radius = 6;
  showroom.add(spot, spot.target);

  // Rim light: behind and above the subject, no shadow, for an edge highlight
  // that separates a dark outfit from the void. Off unless asked for.
  const rimLight = new THREE.SpotLight(SPOT_COLOR, 0, 0, 0.55, 0.8, 2);
  rimLight.name = "stage-rim";
  showroom.add(rimLight, rimLight.target);

  // The void is a dome rather than the clear colour so the floor's fade target
  // and the backdrop go through the same output conversion.
  const voidDome = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.MeshBasicMaterial({ color: SHOWROOM_VOID, side: THREE.BackSide, fog: false, depthWrite: false, toneMapped: false, dithering: true }),
  );
  voidDome.name = "stage-void";
  voidDome.renderOrder = -10;
  showroom.add(voidDome);

  const beamMaterial = createBeamMaterial();
  const beam = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 64, 1, false), beamMaterial);
  beam.name = "stage-beam";
  beam.renderOrder = -2;
  showroom.add(beam);

  // One spot and beam per lineup vehicle, built the first time a lineup
  // needs them. Smaller shadow maps than the main spot: up to six render.
  const bayRigs = [];
  const bayRig = (index) => {
    if (!bayRigs[index]) {
      const light = new THREE.SpotLight(SPOT_COLOR, 0, 0, 0.46, 0.7, 2);
      light.name = `stage-bay-spot-${index}`;
      light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.bias = -0.0004;
      light.shadow.normalBias = 0.03;
      light.shadow.radius = 6;
      const material = createBeamMaterial();
      const cone = new THREE.Mesh(beam.geometry, material);
      cone.name = `stage-bay-beam-${index}`;
      cone.renderOrder = -2;
      showroom.add(light, light.target, cone);
      bayRigs[index] = { light, cone, material };
    }
    return bayRigs[index];
  };
  const usesBays = () => !isPed && !isProp && state.bayLights && state.bays.length >= state.bayMinimum;

  // Points a spot from `toLight` at a floor target and sizes its cone to
  // `radius`; candela scale with distance so every vehicle reads the same.
  // Every bay hangs at the stage's height, not its own vehicle's: the camera
  // frames the whole lineup.
  const aimVehicleSpot = (light, cone, coneMaterial, target, radius, toLight, showBeam, strength = 1) => {
    const distance = Math.max(5, radius * 2.8, state.radius * VEHICLE_SPOT_HANG);
    light.target.position.copy(target);
    light.target.updateMatrixWorld();
    light.position.copy(target).addScaledVector(toLight, distance);
    light.angle = Math.atan((radius * 1.3) / distance);
    light.shadow.camera.near = distance * 0.4;
    light.shadow.camera.far = distance * 2.5;
    light.shadow.camera.updateProjectionMatrix();
    light.intensity = state.spot * strength * state.night * 5 * distance * distance;
    const beamRadius = Math.tan(light.angle) * distance * 0.92;
    cone.scale.set(beamRadius * 1.03, distance, beamRadius * 1.03);
    cone.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, toLight);
    cone.position.copy(light.position).addScaledVector(toLight, -distance / 2);
    const u = coneMaterial.uniforms;
    u.uApex.value.copy(light.position);
    u.uAxis.value.copy(toLight).negate();
    u.uLength.value = distance;
    u.uSpread.value = beamRadius / distance;
    u.uFloorY.value = state.floorY;
    cone.visible = showBeam;
    return distance;
  };

  let environment = null;
  let environmentLight = "";
  let savedBackground;

  const applyEnvironment = () => {
    if (state.mode !== "showroom") return;
    if (!environment || environmentLight !== state.light) {
      environment?.dispose?.();
      environment = buildStudioEnvironment(renderer, lightDirection(state.light));
      environmentLight = state.light;
    }
    scene.environment = environment.texture;
  };

  const applyVisibility = () => {
    const showroomOn = state.mode === "showroom";
    showroom.visible = showroomOn;
    beam.visible = showroomOn && state.beam && state.night === 1 && !usesBays();
    catcher.visible = showroomOn || state.shadows;
    catcher.material.opacity = showroomOn ? 0.6 : 0.32;
    grid.visible = !showroomOn && state.grid;
  };

  const layout = () => {
    const r = state.radius;
    const extent = r * FLOOR_EXTENT;
    const { center, floorY } = state;

    catcher.scale.set(extent * 0.5, extent * 0.5, 1);
    catcher.position.set(center.x, floorY + 0.002, center.z);
    grid.scale.set(extent, extent, 1);
    grid.position.set(center.x, floorY + 0.001, center.z);
    gridMaterial.uniforms.uCenter.value.set(center.x, center.z);
    gridMaterial.uniforms.uFade.value = r * 7;
    if (isProp) {
      // Grid lines at a power of ten that suits the prop: centimetres for a
      // flashlight, decimetres for a crate.
      const minor = Math.pow(10, Math.round(Math.log10(r / 4)));
      gridMaterial.uniforms.uMinor.value = minor;
      gridMaterial.uniforms.uMajor.value = minor * 5;
    }

    // The light hangs at a fixed distance along its direction, aimed at the
    // floor under the vehicle's centre, or at a ped's chest so the whole
    // figure sits inside the cone.
    const toLight = lightDirection(state.light);
    const distance = isProp ? Math.max(0.5, r * 3.5) : isPed ? Math.max(4, r * 3.2) : Math.max(5, r * VEHICLE_SPOT_HANG);
    const aimHeight = isPed ? state.height * 0.55 : isProp ? state.height * 0.5 : 0;
    spot.target.position.set(center.x, floorY + aimHeight, center.z);
    spot.target.updateMatrixWorld();
    spot.position.copy(spot.target.position).addScaledVector(toLight, distance);
    spot.angle = Math.atan((r * (isPed ? 1.15 : 1.3)) / distance);
    // Shadow offsets are in metres; a prop a few centimetres across needs finer ones.
    spot.shadow.normalBias = isProp ? Math.max(0.002, r * 0.012) : 0.03;
    spot.shadow.camera.near = distance * 0.4;
    spot.shadow.camera.far = distance * 2.5;
    spot.shadow.camera.updateProjectionMatrix();
    // Candela scale with distance so the vehicle reads the same at any size.
    spot.intensity = state.spot * state.night * 5 * distance * distance;

    const toRim = lightDirection("back").multiplyScalar(0.8).add(new THREE.Vector3(0.35 * facing, 0.75, 0)).normalize();
    rimLight.target.position.set(center.x, floorY + r * 0.6, center.z);
    rimLight.target.updateMatrixWorld();
    rimLight.position.copy(rimLight.target.position).addScaledVector(toRim, distance);
    rimLight.angle = Math.atan((r * 1.4) / distance);
    rimLight.intensity = state.rim * state.night * 6 * distance * distance;
    rimLight.visible = state.rim > 0.001;

    if (floor) {
      const u = floor.material.uniforms;
      floor.scale.set(r * 24, r * 24, 1);
      floor.position.set(center.x, floorY, center.z);
      u.uCenter.value.set(center.x, center.z);
      u.uHalf.value.copy(state.half);
      u.uRadius.value = r;
      u.uSpotPos.value.copy(spot.position);
      u.uSpotDir.value.copy(toLight).negate();
      u.uSpotCone.value.set(Math.cos(spot.angle * 1.15), Math.cos(spot.angle * 0.55));
      // In per-object mode the stage spot is off even when no object is lit.
      u.uSpotPower.value = usesBays() ? 0 : state.spot * state.night * POOL_IRRADIANCE * distance * distance;
      u.uReflect.value = state.reflect;
      u.uFade.value.set(r * 2.2, r * 5.5);
      u.uStyle.value = Math.max(0, floorIndex(state.floor));
      // Floor grain and tiles are authored for vehicles; shrink them with a prop.
      u.uPattern.value = isProp ? Math.min(25, Math.max(1, 2.5 / r)) : 1;
    }

    // The beam runs from the light to the floor; for a vehicle the target is
    // already on the floor, for a ped it continues past the chest.
    const beamLength = isPed || isProp
      ? Math.min(distance * 2.5, (spot.position.y - floorY) / Math.max(toLight.y, 0.2))
      : distance;
    const beamRadius = Math.tan(spot.angle) * beamLength * 0.92;
    // Slightly wider than the marched cone so its polygon edge never clips it.
    beam.scale.set(beamRadius * 1.03, beamLength, beamRadius * 1.03);
    beam.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, toLight);
    beam.position.copy(spot.position).addScaledVector(toLight, -beamLength / 2);
    const beamUniforms = beamMaterial.uniforms;
    beamUniforms.uApex.value.copy(spot.position);
    beamUniforms.uAxis.value.copy(toLight).negate();
    beamUniforms.uLength.value = beamLength;
    beamUniforms.uSpread.value = beamRadius / beamLength;
    beamUniforms.uFloorY.value = floorY;

    // Lineup: the stage spot goes dark and each vehicle gets its own spot,
    // pool, beam and contact shadow, aimed from the same direction.
    const bayCount = usesBays() ? Math.min(state.bays.length, STAGE_BAY_LIMIT) : 0;
    spot.visible = bayCount === 0;
    for (let index = bayCount; index < bayRigs.length; index += 1) {
      bayRigs[index].light.visible = false;
      bayRigs[index].cone.visible = false;
    }
    const showBayBeams = state.beam && state.night === 1;
    for (let index = 0; index < bayCount; index += 1) {
      const bay = state.bays[index];
      const rig = bayRig(index);
      rig.light.visible = true;
      // A bay's own settings: strength on top of the stage spot, a direction
      // measured from its model's front, a colour and a beam switch.
      const own = state.bayOverrides.get(bay.modelId) || null;
      const strength = Number.isFinite(own?.strength) ? Math.max(0, own.strength) : 1;
      const bayToLight = own?.from && SHOWROOM_LIGHTS[own.from]
        ? lightDirection(own.from).applyAxisAngle(THREE.Object3D.DEFAULT_UP, bay.yaw || 0)
        : toLight;
      const tint = own?.color ? new THREE.Color(own.color) : null;
      rig.light.color.copy(SPOT_COLOR);
      if (tint) rig.light.color.multiply(tint);
      rig.material.uniforms.uColor.value.copy(rig.light.color);
      const target = new THREE.Vector3(bay.center.x, floorY, bay.center.z);
      const bayDistance = aimVehicleSpot(rig.light, rig.cone, rig.material, target, bay.radius, bayToLight, showBayBeams && own?.beam !== false, strength);
      if (floor) {
        const u = floor.material.uniforms;
        const { position } = rig.light;
        u.uBaySpot.value[index].set(position.x, position.y, position.z, state.spot * strength * state.night * POOL_IRRADIANCE * bayDistance * bayDistance);
        u.uBayDir.value[index].copy(bayToLight).negate();
        u.uBayCone.value[index].set(Math.cos(rig.light.angle * 1.15), Math.cos(rig.light.angle * 0.55));
        u.uBayBox.value[index].set(bay.center.x, bay.center.z, bay.half.x, bay.half.y);
        if (tint) u.uBayColor.value[index].set(tint.r, tint.g, tint.b);
        else u.uBayColor.value[index].set(1, 1, 1);
      }
    }
    if (floor) floor.material.uniforms.uBayCount.value = bayCount;

    voidDome.scale.setScalar(r * 7);
    voidDome.position.set(center.x, floorY, center.z);


    if (keyLight?.shadow?.camera && keyLight.castShadow) {
      const cam = keyLight.shadow.camera;
      const span = r * 3;
      cam.left = -span;
      cam.right = span;
      cam.top = span;
      cam.bottom = -span;
      cam.near = 0.5;
      cam.far = Math.max(20, r * 12);
      cam.updateProjectionMatrix();
      keyLight.target.position.copy(center);
      keyLight.target.updateMatrixWorld();
    }
  };

  const applyAccents = () => {
    if (!floor) return;
    const u = floor.material.uniforms;
    const accents = state.accents;
    u.uAccentCount.value = accents.length;
    accents.forEach((accent, index) => {
      u.uAccentPos.value[index].set(accent.position.x, accent.position.y, accent.position.z, accent.distance || 0);
      const spot = accent.direction && Number.isFinite(accent.angle);
      const coneCos = spot ? Math.cos(accent.angle) : -2;
      const penumbraCos = spot ? Math.cos(accent.angle * (1 - (accent.penumbra || 0))) : 1;
      if (spot) u.uAccentDir.value[index].set(accent.direction.x, accent.direction.y, accent.direction.z, coneCos);
      else u.uAccentDir.value[index].set(0, -1, 0, coneCos);
      u.uAccentColor.value[index].set(
        accent.color.r * accent.intensity,
        accent.color.g * accent.intensity,
        accent.color.b * accent.intensity,
        penumbraCos,
      );
    });
  };

  const applyGridColor = () => {
    const light = isLightColor(state.background);
    gridMaterial.uniforms.uColor.value.set(light ? "#000000" : "#ffffff");
    gridMaterial.uniforms.uOpacity.value = light ? 0.2 : 0.16;
  };

  const applyMode = () => {
    const showroomOn = state.mode === "showroom";
    if (showroomOn) {
      if (!floor) {
        floor = buildFloor();
        showroom.add(floor);
        applyAccents();
      }
      applyEnvironment();
      scene.environmentIntensity = state.night;
      if (savedBackground === undefined) savedBackground = scene.background;
      scene.background = SHOWROOM_VOID;
      // Khronos PBR Neutral: product-render tone mapping that keeps livery
      // hues true instead of ACES' warm, desaturated shoulder.
      renderer.toneMapping = THREE.NeutralToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.shadowMap.enabled = true;
    } else {
      scene.environment = null;
      if (savedBackground !== undefined) {
        scene.background = savedBackground;
        savedBackground = undefined;
      }
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.shadowMap.enabled = state.shadows;
    }
    renderer.shadowMap.needsUpdate = true;
    applyVisibility();
    layout();
  };

  return {
    root,
    get mode() {
      return state.mode;
    },
    /** True when the model should cast and receive shadows. */
    get castsShadows() {
      return state.mode === "showroom" || state.shadows;
    },
    setMode(mode) {
      const next = STAGE_MODES.includes(mode) ? mode : "workbench";
      if (next === state.mode) return false;
      state.mode = next;
      applyMode();
      return true;
    },
    setShadows(enabled) {
      state.shadows = Boolean(enabled);
      if (state.mode === "workbench") renderer.shadowMap.enabled = state.shadows;
      applyVisibility();
      layout();
    },
    /** Dims the studio lights to `factor` (1 = normal) for the night light preview. */
    setNight(factor) {
      const next = Number.isFinite(factor) ? Math.max(0, Math.min(1, factor)) : 1;
      if (next === state.night) return;
      state.night = next;
      if (state.mode === "showroom") scene.environmentIntensity = next;
      applyVisibility();
      layout();
    },
    setGrid(enabled) {
      state.grid = Boolean(enabled);
      applyVisibility();
    },
    setBackgroundColor(color) {
      state.background = color || "#141414";
      applyGridColor();
    },
    /** The user's own scene.background; held aside while the showroom owns it. */
    setUserBackground(texture) {
      if (state.mode === "showroom") savedBackground = texture;
      else scene.background = texture;
    },
    setShowroom({ spot, reflect, beam, light, rim, floor, bayLights, bayMinimum } = {}) {
      if (Number.isFinite(spot)) state.spot = Math.max(0, spot);
      if (typeof bayLights === "boolean") state.bayLights = bayLights;
      if (Number.isInteger(bayMinimum) && bayMinimum >= 0) state.bayMinimum = bayMinimum;
      if (Number.isFinite(reflect)) state.reflect = Math.max(0, Math.min(1, reflect));
      if (typeof beam === "boolean") state.beam = beam;
      if (Number.isFinite(rim)) state.rim = Math.max(0, rim);
      if (SHOWROOM_FLOORS.includes(floor)) state.floor = floor;
      if (SHOWROOM_LIGHTS[light] && light !== state.light) {
        state.light = light;
        applyEnvironment();
        renderer.shadowMap.needsUpdate = true;
      }
      applyVisibility();
      layout();
    },
    /**
     * Re-anchor to new model bounds; cheap when nothing has changed. `bounds`
     * are the camera framing bounds (padded), which size the stage. `models`
     * place the floor and the contact footprint: the floor sits under the
     * lowest visible mesh, so tyres touch it.
     *
     * With `{ bays: true }`, each entry of `models` (or of `bayModels`, when
     * only some models are lit) is one vehicle of a lineup and gets its own
     * showroom bay; moving or turning a vehicle moves its bay.
     */
    /**
     * `atRest(measure)` runs the measuring with any turntable spin undone, so
     * footprints and bays are the vehicles' own; it is called only when the
     * fit actually changes.
     */
    fit(bounds, models, { bays = false, bayModels = null, atRest = null } = {}) {
      if (!bounds?.isBox3 || bounds.isEmpty()) return;
      const visible = collectVisibleMeshes(models);
      const lineupSource = bayModels ?? models;
      const lineup = bays ? (Array.isArray(lineupSource) ? lineupSource : [lineupSource]).filter((model) => model?.visible) : [];
      const bayKey = lineup.map((model) => `${model.id}@${model.position.toArray().map((n) => n.toFixed(3)).join(",")}/${model.rotation.y.toFixed(3)}`).join(";");
      const key = `${bounds.min.toArray().join(",")}|${bounds.max.toArray().join(",")}|${visible.map((mesh) => mesh.id).join(",")}|${bayKey}`;
      if (key === state.fitKey) return;
      state.fitKey = key;
      const measure = typeof atRest === "function" ? atRest : (run) => run();
      let ground = null;
      measure(() => {
        state.bays = lineup.slice(0, STAGE_BAY_LIMIT).flatMap((model) => {
          const box = visibleBounds(collectVisibleMeshes(model));
          if (!box) return [];
          const size = box.getSize(new THREE.Vector3());
          const facing = new THREE.Euler().setFromQuaternion(model.getWorldQuaternion(new THREE.Quaternion()), "YXZ");
          return [{
            modelId: model.id,
            yaw: facing.y,
            center: box.getCenter(new THREE.Vector3()),
            half: new THREE.Vector2(size.x / 2, size.z / 2),
            radius: Math.max(0.5, size.length() / 2),
          }];
        });
        ground = visibleBounds(visible) || bounds;
      });
      applyVisibility();
      const sphere = bounds.getBoundingSphere(new THREE.Sphere());
      state.radius = Math.max(isProp ? 0.05 : 0.5, sphere.radius);
      ground.getCenter(state.center);
      state.half.set((ground.max.x - ground.min.x) / 2, (ground.max.z - ground.min.z) / 2);
      state.floorY = ground.min.y;
      state.height = Math.max(0.1, ground.max.y - ground.min.y);
      layout();
    },
    /**
     * Keep the orbit inside the studio. The framing code owns the normal
     * limit; this caps it in the showroom and hands it back in the workbench.
     */
    /**
     * Per-bay settings, keyed by the bay's model id (Object3D.id): { strength
     * (x the stage spot), from (a SHOWROOM_LIGHTS key, measured from the
     * model's front), color (hex), beam (false hides its beam) }.
     */
    /** Turns the contact footprints with a vehicle turntable (radians about +Y). */
    setSpin(yaw) {
      if (floor) floor.material.uniforms.uSpin.value = Number.isFinite(yaw) ? yaw : 0;
    },
    setBayOverrides(overrides) {
      state.bayOverrides = overrides instanceof Map ? overrides : new Map();
      layout();
    },
    constrainControls(controls) {
      if (!controls) return;
      if (controls.maxDistance !== controls.userData?.stageMaxDistance) {
        controls.userData = { ...controls.userData, framingMaxDistance: controls.maxDistance };
      }
      const framingMax = controls.userData.framingMaxDistance;
      const next = state.mode === "showroom" ? Math.min(framingMax, state.radius * SHOWROOM_REACH) : framingMax;
      controls.maxDistance = next;
      controls.userData.stageMaxDistance = next;
    },
    /**
     * Prop lights the showroom floor receives, in world space: { position, direction
     * (null for a point light), color (THREE.Color), intensity, distance, angle,
     * penumbra }, matching the three.js light that lights the prop. Extra lights past
     * STAGE_ACCENT_LIMIT are ignored. They are the prop's own lights, so the dark-room
     * factor (setNight) does not dim them.
     */
    setAccentLights(accents) {
      state.accents = (Array.isArray(accents) ? accents : [])
        .filter((accent) => accent?.position && accent.color && Number.isFinite(accent.intensity) && accent.intensity > 0)
        .slice(0, STAGE_ACCENT_LIMIT);
      applyAccents();
    },
    /** Offsets the floor pattern (grid and showroom floor) without moving the floor. */
    setScroll(x = 0, z = 0) {
      gridMaterial.uniforms.uScroll.value.set(x, z);
      floor?.material.uniforms.uScroll.value.set(x, z);
    },
    resize() {
      if (!floor) return;
      const [width, height] = reflectionSize();
      floor.getRenderTarget().setSize(width, height);
      floor.material.uniforms.uTexSize.value.set(width, height);
    },
    dispose() {
      if (state.mode === "showroom") {
        scene.environment = null;
        if (savedBackground !== undefined) scene.background = savedBackground;
      }
      scene.remove(root);
      plane.dispose();
      catcher.material.dispose();
      gridMaterial.dispose();
      voidDome.geometry.dispose();
      voidDome.material.dispose();
      beam.geometry.dispose();
      beamMaterial.dispose();
      floor?.dispose?.();
      floor?.geometry?.dispose?.();
      environment?.dispose?.();
      spot.shadow.map?.dispose?.();
      spot.dispose?.();
      rimLight.dispose?.();
      for (const rig of bayRigs) {
        rig.light.shadow.map?.dispose?.();
        rig.light.dispose?.();
        rig.material.dispose();
      }
    },
  };
}
