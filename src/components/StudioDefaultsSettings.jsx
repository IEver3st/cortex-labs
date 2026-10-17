import { useState } from "react";
import { Toggle } from "./ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Segmented, SliderRow } from "./SettingsControls";
import { getLightCompassLabel } from "../lib/light-direction.js";
import { PLATE_MAX_LENGTH, PLATE_STYLE_NAMES, normalizePlateText } from "../lib/license-plate.js";
import { SHOWROOM_FLOORS, SHOWROOM_FLOOR_LABELS } from "../lib/showroom-floors.js";
import {
  BUILT_IN_SHOWROOM,
  DEFAULT_LIGHT,
  DEFAULT_PLATE,
  STEERING_DEFAULT_LIMIT,
  normalizeLightDefaults,
  normalizePlateDefault,
  normalizeShowroomDefaults,
  normalizeSteeringDefault,
} from "../lib/studio-defaults.js";

const SUBJECTS = [
  { value: "vehicle", label: "Vehicles", desc: "Vehicle and Multi." },
  { value: "ped", label: "EUP", desc: "EUP Studio and EUP." },
  { value: "prop", label: "Props", desc: "Prop Studio." },
];
const STAGES = [
  { value: "workbench", label: "Workbench" },
  { value: "showroom", label: "Showroom" },
];
const LIGHTS = ["top", "front", "back", "left", "right"].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));

const percent = (value) => `${Math.round(value * 100)}%`;

function formatSteering(value) {
  if (Math.abs(value) < 0.05) return "Straight";
  return `${Math.abs(value).toFixed(1)}° ${value < 0 ? "left" : "right"}`;
}

/**
 * Settings > Studio: the scene, light, plate and steering new work starts
 * with. `value` is the settings draft; `onChange` merges a patch into it.
 */
export default function StudioDefaultsSettings({ value, onChange }) {
  const [subject, setSubject] = useState("vehicle");
  const showroom = normalizeShowroomDefaults(value.showroom);
  const scene = showroom[subject];
  const light = normalizeLightDefaults(value);
  const plate = normalizePlateDefault(value.licensePlate);
  const steering = normalizeSteeringDefault(value.steeringAngle);
  const subjectMeta = SUBJECTS.find((entry) => entry.value === subject);

  const updateScene = (patch) => onChange({ showroom: { ...showroom, [subject]: { ...scene, ...patch } } });
  const updatePlate = (patch) => onChange({ licensePlate: { ...plate, ...patch } });

  return (
    <div className="settings-stack">
      <section className="settings-panel">
        <div className="settings-panel-heading-row">
          <div>
            <div className="settings-panel-title">Showroom</div>
            <p className="settings-panel-description">
              How the stage starts in a new workspace. Open and saved workspaces keep their own scene.
            </p>
          </div>
          <Segmented label="Workspace" options={SUBJECTS} value={subject} onChange={setSubject} />
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-title">Open in</div>
            <div className="settings-row-desc">{subjectMeta.desc} Workbench uses your backdrop; Showroom is the photo studio.</div>
          </div>
          <Segmented label="Starting stage" options={STAGES} value={scene.stage} onChange={(stage) => updateScene({ stage })} />
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-title">Light from</div>
            <div className="settings-row-desc">Where the showroom spotlight sits</div>
          </div>
          <Segmented label="Showroom light direction" options={LIGHTS} value={scene.light} onChange={(next) => updateScene({ light: next })} />
        </div>
        <SliderRow title="Spotlight" min={0} max={2} step={0.05} value={scene.spot} format={percent} onChange={(spot) => updateScene({ spot })} />
        <SliderRow title="Floor reflections" min={0} max={1} step={0.05} value={scene.reflect} format={percent} onChange={(reflect) => updateScene({ reflect })} />
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-title">Light beam</div>
            <div className="settings-row-desc">Show the spotlight's cone in the air</div>
          </div>
          <Toggle checked={scene.beam} onChange={(beam) => updateScene({ beam })} ariaLabel="Show the spotlight beam" />
        </div>
        {"floor" in scene ? (
          <div className="settings-row">
            <div className="settings-row-label">
              <div className="settings-row-title">Floor</div>
              <div className="settings-row-desc">Showroom floor finish</div>
            </div>
            <Select value={scene.floor} onValueChange={(floor) => updateScene({ floor })}>
              <SelectTrigger className="settings-select" aria-label="Showroom floor"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SHOWROOM_FLOORS.map((floor) => (
                  <SelectItem key={floor} value={floor}>{SHOWROOM_FLOOR_LABELS[floor]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        {"rim" in scene ? (
          <SliderRow title="Rim light" desc="Back light that separates the subject from the void" min={0} max={2} step={0.05} value={scene.rim} format={percent} onChange={(rim) => updateScene({ rim })} />
        ) : null}
        {"dark" in scene ? (
          <SliderRow title="Dark room" desc="Dims the studio so emissives and the prop's own lights carry the shot" min={0} max={1} step={0.01} value={scene.dark} format={percent} onChange={(dark) => updateScene({ dark })} />
        ) : null}
        <div className="settings-hotkey-foot">
          <div className="settings-row-desc">Applies to {subjectMeta.label} only.</div>
          <button type="button" className="settings-mini" onClick={() => updateScene(BUILT_IN_SHOWROOM[subject])}>
            Restore {subjectMeta.label} defaults
          </button>
        </div>
      </section>

      <section className="settings-panel">
        <div className="settings-panel-title">Lighting</div>
        <SliderRow
          title="Light intensity"
          desc="Studio light level for vehicle and EUP workspaces, and Prop Studio's fill light"
          min={0}
          max={3}
          step={0.05}
          value={light.intensity}
          format={(next) => `${next.toFixed(2)}×`}
          onChange={(lightIntensity) => onChange({ lightIntensity })}
        />
        <SliderRow
          title="Light direction"
          desc="Compass angle of the vehicle key light. Reset in the Light panel returns here."
          min={0}
          max={359}
          step={1}
          value={Math.round(light.azimuth)}
          format={(next) => `${Math.round(next)}° ${getLightCompassLabel(next)}`}
          onChange={(lightAzimuth) => onChange({ lightAzimuth })}
        />
        <SliderRow
          title="Light height"
          desc="0° is level with the vehicle, 90° is straight overhead"
          min={0}
          max={90}
          step={1}
          value={Math.round(light.elevation)}
          format={(next) => `${Math.round(next)}°`}
          onChange={(lightElevation) => onChange({ lightElevation })}
        />
        <div className="settings-hotkey-foot">
          <div className="settings-row-desc">Built in: {DEFAULT_LIGHT.intensity.toFixed(2)}×, {DEFAULT_LIGHT.azimuth}°, {DEFAULT_LIGHT.elevation}° high.</div>
          <button
            type="button"
            className="settings-mini"
            onClick={() => onChange({ lightIntensity: DEFAULT_LIGHT.intensity, lightAzimuth: DEFAULT_LIGHT.azimuth, lightElevation: DEFAULT_LIGHT.elevation })}
          >
            Restore lighting
          </button>
        </div>
      </section>

      <section className="settings-panel">
        <div className="settings-panel-title">Vehicles</div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-title">Plate style</div>
            <div className="settings-row-desc">Drawn from your GTA V files on vehicles with a plate mesh</div>
          </div>
          <Select value={String(plate.style)} onValueChange={(value) => updatePlate({ style: Number(value) })}>
            <SelectTrigger className="settings-select" aria-label="Default plate style"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PLATE_STYLE_NAMES.map((name, index) => (
                <SelectItem key={name} value={String(index)}>{index} · {name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-title">Plate text</div>
            <div className="settings-row-desc">Up to {PLATE_MAX_LENGTH} characters, A-Z, 0-9 and spaces. Editing a plate in a workspace overrides this there.</div>
          </div>
          <input
            className="settings-input settings-mono-input"
            value={plate.text}
            maxLength={PLATE_MAX_LENGTH}
            spellCheck={false}
            autoComplete="off"
            placeholder="Blank plate"
            onChange={(event) => updatePlate({ text: normalizePlateText(event.currentTarget.value) })}
            aria-label="Default plate text"
          />
        </div>
        <SliderRow
          title="Front wheel angle"
          desc="Starting steering for vehicles whose handling.meta sets a steering lock, capped at that lock. Others stay straight."
          min={-STEERING_DEFAULT_LIMIT}
          max={STEERING_DEFAULT_LIMIT}
          step={0.5}
          value={steering}
          format={formatSteering}
          onChange={(steeringAngle) => onChange({ steeringAngle: normalizeSteeringDefault(steeringAngle) })}
        />
        <div className="settings-hotkey-foot">
          <div className="settings-row-desc">Built in: plate {DEFAULT_PLATE.style} · {DEFAULT_PLATE.text}, wheels straight.</div>
          <button type="button" className="settings-mini" onClick={() => onChange({ licensePlate: { ...DEFAULT_PLATE }, steeringAngle: 0 })}>
            Restore vehicle defaults
          </button>
        </div>
      </section>
    </div>
  );
}
