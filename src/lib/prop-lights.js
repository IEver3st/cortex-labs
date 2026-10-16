import * as THREE from "three";
import { gtaLightToThree } from "./prop-studio.js";
import { GLOW_LAYER } from "./viewer-render-effects.js";
import { STAGE_ACCENT_LIMIT, createBeamMaterial } from "./viewer-stage.js";

/* The lights a prop carries (manifest v9 lights[]): a flashlight's cone, a
   lamp's bulb. Each becomes a three.js light inside the prop's GTA space, so it
   turns and spins with the prop. Spots also get a ray-marched beam (the
   stage's own beam shader) for haze, every light gets a corona on the glow
   layer, and the brightest few light the showroom floor through the stage's
   accent lights.

   Lights are created once per model and switched by intensity, never by
   visibility: changing the number of lights recompiles every lit material. */

// Lights beyond this are listed but not previewed; the strongest are kept.
export const PROP_LIGHT_LIMIT = 16;
const BEAM_STRENGTH = 0.32;
const CORONA_SCALE = 0.35;
const MIN_CORONA = 0.015;

let coronaTexture = null;
let coronaUsers = 0;

function acquireCorona() {
  coronaUsers += 1;
  if (coronaTexture) return coronaTexture;
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1);
      const falloff = Math.max(0, 1 - d);
      const value = Math.round(255 * falloff * falloff * falloff);
      const i = (y * size + x) * 4;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = value;
    }
  }
  coronaTexture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  coronaTexture.magFilter = THREE.LinearFilter;
  coronaTexture.minFilter = THREE.LinearFilter;
  coronaTexture.needsUpdate = true;
  return coronaTexture;
}

function releaseCorona() {
  coronaUsers = Math.max(0, coronaUsers - 1);
  if (coronaUsers === 0 && coronaTexture) {
    coronaTexture.dispose();
    coronaTexture = null;
  }
}

const _apex = new THREE.Vector3();
const _target = new THREE.Vector3();
const _axis = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * `gta` is the prop's GTA-space group; `scene` holds the beams (they are
 * world-space ray-marchers). Returns a controller; update() re-reads world
 * transforms after the prop moves and returns the floor accents.
 */
export function createPropLightRig({ gta, scene, lights = [] }) {
  const group = new THREE.Group();
  group.name = "prop-lights";
  gta.add(group);
  const beams = new THREE.Group();
  beams.name = "prop-light-beams";
  scene.add(beams);
  const corona = acquireCorona();

  const reach = (light) => light.intensity * light.falloff;
  const chosen = [...lights].sort((a, b) => reach(b) - reach(a)).slice(0, PROP_LIGHT_LIMIT);
  const entries = chosen.map((light) => {
    const params = gtaLightToThree(light, 1);
    const color = new THREE.Color().setRGB(...params.color, THREE.SRGBColorSpace);
    let three;
    if (params.kind === "spot") {
      three = new THREE.SpotLight(color, 0, params.distance, params.angle, params.penumbra, 0);
      three.target.position.set(
        light.position[0] + light.direction[0],
        light.position[1] + light.direction[1],
        light.position[2] + light.direction[2],
      );
      group.add(three.target);
    } else {
      three = new THREE.PointLight(color, 0, params.distance, 0);
    }
    three.name = `prop-light:${light.id}`;
    three.position.set(...light.position);
    three.castShadow = false;
    group.add(three);

    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: corona,
      color: color.clone(),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      transparent: true,
    }));
    sprite.name = `prop-corona:${light.id}`;
    sprite.position.set(...light.position);
    sprite.layers.set(GLOW_LAYER);
    sprite.userData.propHelper = true;
    sprite.visible = false;
    group.add(sprite);

    let beam = null;
    if (params.kind === "spot") {
      const material = createBeamMaterial();
      material.uniforms.uColor.value.copy(color);
      beam = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 48, 1, false), material);
      beam.name = `prop-beam:${light.id}`;
      beam.renderOrder = -1;
      beam.frustumCulled = false;
      beam.visible = false;
      beam.userData.propHelper = true;
      beams.add(beam);
    }
    return { light, params, three, color, sprite, beam, on: false, intensity: 0 };
  });

  let state = { enabled: true, strength: 1, haze: 0.6, glow: 1, off: {}, floorY: 0 };

  const rig = {
    count: lights.length,
    previewed: entries.length,
    previewedIds: new Set(entries.map((entry) => entry.light.id)),

    setState(next) {
      state = { ...state, ...next };
      for (const entry of entries) {
        entry.on = state.enabled && !state.off?.[entry.light.id];
        entry.intensity = entry.on ? gtaLightToThree(entry.light, state.strength).intensity : 0;
        entry.three.intensity = entry.intensity;
        // A corona size of 0 means the game draws none.
        const coronaLevel = entry.on && entry.light.coronaSize > 0
          ? Math.min(2, entry.light.coronaIntensity || 1) * (state.glow || 0)
          : 0;
        entry.sprite.visible = coronaLevel > 0.001;
        entry.sprite.material.color.copy(entry.color).multiplyScalar(coronaLevel);
        const size = Math.max(MIN_CORONA, entry.light.coronaSize * CORONA_SCALE);
        entry.sprite.scale.setScalar(size);
        if (entry.beam) {
          const level = entry.on ? state.haze * Math.min(2, Math.max(0.3, Math.sqrt(entry.intensity / 4))) : 0;
          entry.beam.visible = level > 0.001;
          entry.beam.material.uniforms.uStrength.value = level * BEAM_STRENGTH;
        }
      }
    },

    /**
     * Follows the prop after it moved. Returns world-space accents for the
     * showroom floor: the brightest lit lights, at most STAGE_ACCENT_LIMIT.
     */
    update(floorY = state.floorY) {
      state.floorY = floorY;
      group.updateWorldMatrix(true, true);
      const accents = [];
      for (const entry of entries) {
        if (!entry.on) continue;
        const apex = entry.three.getWorldPosition(new THREE.Vector3());
        let direction = null;
        if (entry.params.kind === "spot") {
          entry.three.target.getWorldPosition(_target);
          direction = _target.sub(apex).normalize().clone();
        }
        if (entry.intensity > 0) {
          accents.push({
            position: apex,
            direction,
            color: entry.color,
            intensity: entry.intensity,
            distance: entry.params.distance,
            angle: entry.params.angle,
            penumbra: entry.params.penumbra,
          });
        }
        if (entry.beam && direction) {
          const length = entry.params.distance;
          const spread = Math.tan(Math.min(entry.params.angle, 1.4));
          const radius = spread * length;
          _apex.copy(apex);
          _axis.copy(direction);
          // Cone apex at +Y; turn +Y to point back at the light.
          entry.beam.quaternion.setFromUnitVectors(UP, _axis.clone().negate());
          entry.beam.scale.set(radius * 1.03, length, radius * 1.03);
          entry.beam.position.copy(_apex).addScaledVector(_axis, length / 2);
          const u = entry.beam.material.uniforms;
          u.uApex.value.copy(_apex);
          u.uAxis.value.copy(_axis);
          u.uLength.value = length;
          u.uSpread.value = spread;
          u.uFloorY.value = floorY;
        }
      }
      accents.sort((a, b) => b.intensity - a.intensity);
      return accents.slice(0, STAGE_ACCENT_LIMIT);
    },

    dispose() {
      for (const entry of entries) {
        entry.three.dispose?.();
        entry.sprite.material.dispose();
        if (entry.beam) {
          entry.beam.geometry.dispose();
          entry.beam.material.dispose();
        }
      }
      group.removeFromParent();
      beams.removeFromParent();
      releaseCorona();
    },
  };

  rig.setState(state);
  return rig;
}
