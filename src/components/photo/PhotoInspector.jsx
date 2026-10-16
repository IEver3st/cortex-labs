import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Bookmark, Pause, Play, Search, Trash2 } from "lucide-react";
import { CLOTHING_PRESETS, bodyPresetsFor } from "../../lib/eup.js";
import { buildVehiclePaint } from "../../lib/vehicle-paint.js";
import {
  LENS_MAX_MM,
  LENS_MIN_MM,
  LENS_PRESETS,
  OUTPUT_PRESETS,
  PHOTO_POSES,
  PHOTO_SPOTLIGHT_LIMIT,
  STEERING_LIMIT,
  litObjectIds,
  objectLabel,
} from "../../lib/photo-mode.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle } from "../ui/toggle";
import { ColorLine, FloorField, InspectorTabs, Slider, StageSection } from "../workspace/parts";
import PaintSlots from "../workspace/PaintSlots";
import { PaneResizer } from "../workspace/PaneResizer";
import VehiclePlatePanel from "../VehiclePlatePanel";

const KIND_NAMES = { vehicle: "Vehicle", ped: "Person", prop: "Prop" };
const STAGE_NOTES = {
  showroom: "A dark studio with a reflective floor. Every object has its own spotlight (Object tab); these set the direction and strength they start from.",
  workbench: "Your backdrop colour, with the grid and shadows from the deck.",
};

function errorText(error) {
  return (typeof error === "string" ? error : error?.message) || "Unknown error";
}

function Note({ tone = "idle", children }) {
  return (
    <p className={`lv-slot-note is-${tone}`}>
      <span className="lv-dot" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function Seg({ id, label, value, options, onChange }) {
  return (
    <div className="lv-field">
      {label ? <span className="cx-label" id={id}>{label}</span> : null}
      <div className="lv-seg" role="radiogroup" aria-labelledby={label ? id : undefined} aria-label={label ? undefined : id}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={value === option.id}
            className={`lv-seg-btn ${value === option.id ? "is-on" : ""}`}
            disabled={option.disabled}
            title={option.title}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SelectRow({ label, value, onChange, options }) {
  return (
    <div className="lv-field">
      <span className="cx-label">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/* ── Custom animation: search the game's dictionaries, then pick a clip ── */

function CustomPose({ ped, desktop, onChange }) {
  const [query, setQuery] = useState(ped.dict || "");
  const [dicts, setDicts] = useState({ status: "idle", list: [], error: "" });
  const [clips, setClips] = useState({ dict: "", status: "idle", list: [], error: "" });
  const trimmed = query.trim().toLowerCase();

  useEffect(() => {
    if (!desktop || trimmed.length < 3 || trimmed === ped.dict) {
      setDicts({ status: "idle", list: [], error: "" });
      return undefined;
    }
    if (!/^[a-z0-9_@.\- ]{3,64}$/.test(trimmed)) {
      setDicts({ status: "error", list: [], error: "Use letters, digits, _, @, . and -." });
      return undefined;
    }
    let cancelled = false;
    setDicts((prev) => ({ ...prev, status: "loading" }));
    const timer = setTimeout(() => {
      invoke("search_anim_dicts", { query: trimmed }).then(
        (result) => !cancelled && setDicts({ status: "ready", list: Array.isArray(result?.dicts) ? result.dicts : [], error: "" }),
        (error) => !cancelled && setDicts({ status: "error", list: [], error: errorText(error) }),
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [desktop, ped.dict, trimmed]);

  useEffect(() => {
    if (!desktop || !ped.dict) return undefined;
    let cancelled = false;
    setClips({ dict: ped.dict, status: "loading", list: [], error: "" });
    invoke("list_ped_clips", { dict: ped.dict }).then(
      (result) => !cancelled && setClips({
        dict: ped.dict,
        status: "ready",
        list: (Array.isArray(result?.clips) ? result.clips : []).map((clip) => clip.name).filter(Boolean),
        error: "",
      }),
      (error) => !cancelled && setClips({ dict: ped.dict, status: "error", list: [], error: errorText(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [desktop, ped.dict]);

  return (
    <div className="pm-custom-pose">
      <label className="pm-search">
        <Search aria-hidden="true" />
        <input
          type="search"
          value={query}
          spellCheck={false}
          placeholder="Animation dictionary, e.g. amb@world_human"
          aria-label="Search animation dictionaries"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {dicts.status === "loading" ? <Note>Searching the game&apos;s animations…</Note> : null}
      {dicts.status === "error" ? <Note tone="error">{dicts.error}</Note> : null}
      {dicts.status === "ready" ? (
        dicts.list.length ? (
          <div className="pm-pick-list custom-scrollbar" role="listbox" aria-label="Animation dictionaries">
            {dicts.list.map((dict) => (
              <button
                key={dict}
                type="button"
                role="option"
                aria-selected={dict === ped.dict}
                className={`pm-pick ${dict === ped.dict ? "is-on" : ""}`}
                onClick={() => {
                  setQuery(dict);
                  onChange({ dict, clip: "", time: 0 });
                }}
              >
                {dict}
              </button>
            ))}
          </div>
        ) : (
          <Note>No dictionary matches.</Note>
        )
      ) : null}
      {ped.dict ? (
        clips.status === "loading" ? (
          <Note>Listing the clips in {ped.dict}…</Note>
        ) : clips.status === "error" ? (
          <Note tone="error">{clips.error}</Note>
        ) : clips.list.length ? (
          <SelectRow
            label="Clip"
            value={ped.clip || ""}
            onChange={(clip) => onChange({ clip, time: 0 })}
            options={clips.list.map((clip) => ({ id: clip, label: clip }))}
          />
        ) : clips.status === "ready" ? (
          <Note>This dictionary has no clips.</Note>
        ) : null
      ) : null}
    </div>
  );
}

/* ── Object tab ── */

function PlacementGroup({ object, onChange }) {
  const [x, lift, z] = object.position;
  const set = (index, value) => {
    const position = [...object.position];
    position[index] = Number(value.toFixed(3));
    onChange({ position });
  };
  return (
    <section className="lv-group">
      <div className="lv-group-head">
        <h3 className="lv-group-title">Placement</h3>
        <button
          type="button"
          className="lv-link"
          onClick={() => onChange({ position: [object.position[0], 0, object.position[2]], yaw: 0 })}
          disabled={lift === 0 && object.yaw === 0}
        >
          Level and face front
        </button>
      </div>
      <Slider id="pm-pos-x" label="Left and right" value={x} min={-30} max={30} step={0.05} format={(v) => `${v.toFixed(2)} m`} onChange={(v) => set(0, v)} />
      <Slider id="pm-pos-z" label="Back and forth" value={z} min={-30} max={30} step={0.05} format={(v) => `${v.toFixed(2)} m`} onChange={(v) => set(2, v)} />
      <Slider id="pm-pos-lift" label="Lift" value={lift} min={0} max={5} step={0.01} format={(v) => `${v.toFixed(2)} m`} onChange={(v) => set(1, v)} />
      <Slider id="pm-yaw" label="Turn" value={object.yaw} min={0} max={359} step={1} format={(v) => `${Math.round(v)}°`} onChange={(v) => onChange({ yaw: v })} />
    </section>
  );
}

function DoorsGroup({ object, rig, roof, onChange }) {
  const parts = rig?.parts || [];
  const doors = object.vehicle.doors;
  const setDoor = (id, amount) => {
    const next = { ...doors };
    if (amount > 0) next[id] = amount;
    else delete next[id];
    onChange({ vehicle: { ...object.vehicle, doors: next } });
  };
  const allOpen = parts.length > 0 && parts.every((part) => (doors[part.id] || 0) >= 1);
  return (
    <section className="lv-group">
      <div className="lv-group-head">
        <h3 className="lv-group-title">Doors</h3>
        {parts.length ? (
          <button
            type="button"
            className="lv-link"
            onClick={() => onChange({
              vehicle: { ...object.vehicle, doors: allOpen ? {} : Object.fromEntries(parts.map((part) => [part.id, 1])) },
            })}
          >
            {allOpen ? "Close all" : "Open all"}
          </button>
        ) : null}
      </div>
      {roof ? (
        <Slider
          id="pm-roof"
          label="Roof"
          value={object.vehicle.roof}
          min={0}
          max={1}
          step={0.01}
          format={(v) => (v <= 0 ? "Up" : v >= 1 ? "Down" : `${Math.round(v * 100)}% down`)}
          onChange={(roofValue) => onChange({ vehicle: { ...object.vehicle, roof: roofValue } })}
        />
      ) : null}
      {parts.length ? (
        parts.map((part) => (
          <Slider
            key={part.id}
            id={`pm-door-${part.id}`}
            label={part.label}
            value={doors[part.id] || 0}
            min={0}
            max={1}
            step={0.01}
            format={(v) => (v <= 0 ? "Shut" : `${Math.round(v * 100)}% open`)}
            onChange={(v) => setDoor(part.id, v)}
          />
        ))
      ) : !roof ? (
        <p className="lv-slot-note">This model has no doors, bonnet or boot that open.</p>
      ) : null}
      {parts.length || roof ? <p className="lv-slot-note">Click a door, the bonnet or the boot on the selected vehicle to open or close it.</p> : null}
    </section>
  );
}

function PersonGroups({ object, runtime, desktop, onChange, onTogglePlay }) {
  const ped = object.ped;
  const setPed = (patch) => onChange({ ped: { ...ped, ...patch } });
  const duration = runtime?.duration || 0;
  const poseOptions = [...PHOTO_POSES.map((pose) => ({ id: pose.id, label: pose.label })), { id: "custom", label: "Any game animation…" }];
  return (
    <>
      <section className="lv-group">
        <h3 className="lv-group-title">Appearance</h3>
        <Seg
          id="pm-ped-gender"
          label="Ped"
          value={ped.gender}
          onChange={(gender) => {
            if (gender === ped.gender) return;
            setPed({ gender, body: bodyPresetsFor(gender)[0].id, outfit: CLOTHING_PRESETS[gender][0].id });
          }}
          options={[
            { id: "male", label: "Male" },
            { id: "female", label: "Female" },
          ]}
        />
        <SelectRow label="Look" value={ped.body} onChange={(body) => setPed({ body })} options={bodyPresetsFor(ped.gender)} />
        <SelectRow label="Clothes" value={ped.outfit} onChange={(outfit) => setPed({ outfit })} options={CLOTHING_PRESETS[ped.gender]} />
      </section>
      <section className="lv-group">
        <h3 className="lv-group-title">Pose</h3>
        <SelectRow label="Animation" value={ped.pose} onChange={(pose) => setPed({ pose, time: 0, playing: false })} options={poseOptions} />
        {ped.pose === "custom" ? <CustomPose ped={ped} desktop={desktop} onChange={setPed} /> : null}
        {runtime?.poseStatus === "loading" ? <Note>Loading the animation…</Note> : null}
        {runtime?.poseStatus === "error" ? <Note tone="error">{runtime.poseError}</Note> : null}
        {duration > 0 ? (
          <div className="pm-pose-time">
            <button
              type="button"
              className="cx-icon-btn"
              onClick={onTogglePlay}
              aria-label={ped.playing ? "Pause the animation" : "Play the animation"}
              title={ped.playing ? "Pause (Space)" : "Play (Space)"}
            >
              {ped.playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            </button>
            <Slider
              id="pm-pose-time"
              label="Frame"
              value={Math.min(ped.time, duration)}
              min={0}
              max={duration}
              step={1 / 30}
              format={(v) => `${v.toFixed(2)} s`}
              onChange={(time) => setPed({ time, playing: false })}
            />
          </div>
        ) : null}
      </section>
    </>
  );
}

function ObjectTab({ object, runtime, desktop, lit, showroom, onChange, onTogglePlay }) {
  if (!object) {
    return <p className="pm-inspector-empty">Select something on set, in the list or the viewfinder, to place and adjust it.</p>;
  }
  const status = runtime?.status;
  const textures = runtime?.textures;
  return (
    <>
      <section className="lv-group">
        <h3 className="lv-group-title">{KIND_NAMES[object.kind]}</h3>
        <p className="pm-object-name" title={object.path || object.name}>{objectLabel(object)}</p>
        {status === "loading" ? <Note>{runtime.message || "Loading…"}</Note> : null}
        {status === "error" ? <Note tone="error">{runtime.error}</Note> : null}
        {status === "ready" && runtime.parser === "parser" ? <Note tone="warn">Geometry only: the CodeWalker bridge couldn&apos;t read this model.</Note> : null}
        {textures?.state === "loading" ? <Note>Loading textures {textures.loaded || 0} of {textures.planned || "…"}</Note> : null}
        {textures?.state === "ready" ? (
          <Note tone={textures.failed || textures.missing ? "warn" : "ok"}>
            {textures.loaded} {textures.loaded === 1 ? "texture" : "textures"}
            {textures.missing ? `, ${textures.missing} not found` : ""}
            {textures.failed ? `, ${textures.failed} couldn't load` : ""}
          </Note>
        ) : null}
        {textures?.state === "error" ? <Note tone="error">Textures didn&apos;t load: {textures.error}</Note> : null}
        {(runtime?.warnings || []).slice(0, 3).map((warning) => <Note key={warning} tone="warn">{warning}</Note>)}
      </section>
      <PlacementGroup object={object} onChange={onChange} />
      <SpotlightGroup object={object} lit={lit} showroom={showroom} onChange={onChange} />
      {object.kind === "vehicle" ? (
        <p className="lv-slot-note">Doors, mods, extras, livery, plate and paint are in the Vehicle tab.</p>
      ) : null}
      {object.kind === "ped" ? (
        <PersonGroups object={object} runtime={runtime} desktop={desktop} onChange={onChange} onTogglePlay={onTogglePlay} />
      ) : null}
    </>
  );
}

const SPOT_FROM = [
  { id: "", label: "Scene" },
  { id: "top", label: "Top" },
  { id: "front", label: "Front" },
  { id: "back", label: "Back" },
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
];
const STUDIO_WHITE = "#f4f6fa";

function SpotlightGroup({ object, lit, showroom, onChange }) {
  const light = object.light;
  const setLight = (patch) => onChange({ light: { ...light, ...patch } });
  return (
    <section className="lv-group">
      <div className="lv-group-head">
        <h3 className="lv-group-title">Spotlight</h3>
        <Toggle checked={light.on} onChange={(on) => setLight({ on })} ariaLabel="This object's own spotlight" />
      </div>
      {!showroom ? <p className="lv-slot-note">Spotlights light the showroom stage. Switch the stage to Showroom to see them.</p> : null}
      {light.on && !lit && !object.hidden ? (
        <Note tone="warn">Up to {PHOTO_SPOTLIGHT_LIMIT} objects can have a spotlight at once. Switch one off to light this one.</Note>
      ) : null}
      {light.on ? (
        <>
          <Slider
            id="pm-spot-strength"
            label="Strength"
            value={light.strength}
            min={0}
            max={3}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(strength) => setLight({ strength })}
          />
          <Seg id="pm-spot-from" label="Light from" value={light.from} options={SPOT_FROM} onChange={(from) => setLight({ from })} />
          <p className="lv-slot-note">Directions are from this object&apos;s front; Scene follows the Scene tab.</p>
          <div className="lv-colors">
            <ColorLine
              label="Colour"
              value={light.color || STUDIO_WHITE}
              onChange={(color) => setLight({ color })}
              onReset={() => setLight({ color: null })}
            />
          </div>
          <div className="lv-toggle-row">
            <span>Beam</span>
            <Toggle checked={light.beam} onChange={(beam) => setLight({ beam })} ariaLabel="Show this spotlight's beam" />
          </div>
        </>
      ) : null}
    </section>
  );
}

/* ── Vehicle tab ── */

function ModKitGroup({ object, runtime, onChange }) {
  const setup = runtime?.setup;
  const mods = object.vehicle.mods;
  const setMods = (next) => onChange({ vehicle: { ...object.vehicle, mods: next } });
  if (!setup || setup.status === "loading") {
    return (
      <section className="lv-group">
        <h3 className="lv-group-title">Mod kit</h3>
        <Note>Reading the vehicle&apos;s mod kit…</Note>
      </section>
    );
  }
  if (setup.status === "error") {
    return (
      <section className="lv-group">
        <h3 className="lv-group-title">Mod kit</h3>
        <Note tone="error">The mod kit didn&apos;t load: {setup.error}</Note>
      </section>
    );
  }
  const kits = setup.kits || [];
  if (!kits.length) {
    return (
      <section className="lv-group">
        <h3 className="lv-group-title">Mod kit</h3>
        <p className="lv-slot-note">This vehicle has no mod kit with visible parts.</p>
      </section>
    );
  }
  const kit = kits.find((item) => item.kitName === mods.kit) || kits[0];
  const picked = Object.keys(mods.slots).length;
  const status = runtime?.mods;
  const modCount = kit.slots.reduce((total, slot) => total + slot.mods.length, 0);
  return (
    <section className="lv-group">
      <div className="lv-group-head">
        <h3 className="lv-group-title">Mod kit</h3>
        {picked ? (
          <button type="button" className="lv-link" onClick={() => setMods({ kit: kit.kitName, slots: {} })}>
            All stock
          </button>
        ) : null}
      </div>
      {kits.length > 1 ? (
        <SelectRow
          label="Kit"
          value={kit.kitName}
          onChange={(kitName) => setMods({ kit: kitName, slots: {} })}
          options={kits.map((item, index) => ({ id: item.kitName, label: /^hash_/i.test(item.kitName) ? `Kit ${index + 1}` : item.kitName }))}
        />
      ) : null}
      <p className="lv-slot-note">{kit.slots.length} slots, {modCount} parts. Parts load the first time you pick one.</p>
      {status?.status === "preparing" ? <Note>Preparing the mod parts. The first time can take a few seconds.</Note> : null}
      {status?.status === "loading" ? <Note>Loading the chosen parts…</Note> : null}
      {status?.status === "error" ? <Note tone="error">The mod parts didn&apos;t load: {status.error}</Note> : null}
      {status?.missing?.length ? <Note tone="warn">{status.missing.length} part models aren&apos;t in the files: {status.missing.slice(0, 3).map((item) => item.modelName || item).join(", ")}</Note> : null}
      {status?.failed?.length ? <Note tone="warn">{status.failed.length} parts didn&apos;t load: {status.failed[0].message}</Note> : null}
      {kit.slots.map((slot) => {
        const current = mods.slots[slot.type];
        const value = slot.mods.some((mod) => mod.index === current) ? String(current) : "stock";
        return (
          <SelectRow
            key={slot.type}
            label={slot.displayName}
            value={value}
            onChange={(next) => {
              const slots = { ...mods.slots };
              if (next === "stock") delete slots[slot.type];
              else slots[slot.type] = Number(next);
              setMods({ kit: kit.kitName, slots });
            }}
            options={[
              { id: "stock", label: "Stock" },
              ...slot.mods.map((mod) => ({ id: String(mod.index), label: mod.displayName || mod.modelName })),
            ]}
          />
        );
      })}
    </section>
  );
}

function LightsGroup({ vehicle, setup, onChange }) {
  const lights = vehicle.lights;
  const setLights = (patch) => onChange({ lights: { ...lights, ...patch } });
  const hasSirens = Boolean(setup?.sirenSetting);
  return (
    <section className="lv-group">
      <h3 className="lv-group-title">Lights</h3>
      <div className={`lv-toggle-row ${hasSirens ? "" : "pm-is-disabled"}`}>
        <span>Emergency lights</span>
        <Toggle checked={lights.sirens && hasSirens} onChange={(sirens) => setLights({ sirens })} ariaLabel="Emergency lights" disabled={!hasSirens} />
      </div>
      {setup?.status === "ready" && !hasSirens ? <p className="lv-slot-note">This vehicle has no siren settings in its carcols.</p> : null}
      <Seg
        id="pm-headlights"
        label="Headlights"
        value={lights.headlights}
        onChange={(headlights) => setLights({ headlights })}
        options={[
          { id: "off", label: "Off" },
          { id: "on", label: "On" },
          { id: "full", label: "Full beam" },
        ]}
      />
      <Seg
        id="pm-indicators"
        label="Indicators"
        value={lights.indicators}
        onChange={(indicators) => setLights({ indicators })}
        options={[
          { id: "off", label: "Off" },
          { id: "left", label: "Left" },
          { id: "right", label: "Right" },
          { id: "hazard", label: "Hazards" },
        ]}
      />
      <div className="lv-toggle-row">
        <span>Brake lights</span>
        <Toggle checked={lights.brakes} onChange={(brakes) => setLights({ brakes })} ariaLabel="Brake lights" />
      </div>
      <div className="lv-toggle-row">
        <span>Extra lamps</span>
        <Toggle checked={lights.extras} onChange={(extras) => setLights({ extras })} ariaLabel="Extra lamps" />
      </div>
      <p className="lv-slot-note">Lit lamps glow and light the body, nearby objects and the floor. Dim the studio in the Scene tab to let them carry the shot.</p>
    </section>
  );
}

function VehicleTab({ object, runtime, desktop, onChange }) {
  const controller = runtime?.controller;
  const vehicle = object.vehicle;
  const setVehicle = (patch) => onChange({ vehicle: { ...vehicle, ...patch } });
  const ready = runtime?.status === "ready" && controller;
  if (!ready) {
    return <p className="pm-inspector-empty">{runtime?.status === "error" ? runtime.error : "The vehicle is still loading."}</p>;
  }
  const setup = runtime.setup;
  const lock = setup?.steeringLock ?? STEERING_LIMIT;
  const extras = controller.extras || [];
  const liveries = controller.liveries;
  return (
    <>
      <DoorsGroup object={object} rig={controller.rig} roof={Boolean(setup?.roof)} onChange={onChange} />
      {setup?.roofError ? <Note tone="warn">{setup.roofError}</Note> : null}
      <LightsGroup vehicle={vehicle} setup={setup} onChange={setVehicle} />
      <section className="lv-group">
        <h3 className="lv-group-title">Wheels</h3>
        <Slider
          id="pm-steering"
          label="Steering"
          value={Math.max(-lock, Math.min(lock, vehicle.steering))}
          min={-lock}
          max={lock}
          step={0.5}
          format={(v) => (Math.abs(v) < 0.25 ? "Straight" : `${Math.abs(v).toFixed(1)}° ${v < 0 ? "left" : "right"}`)}
          onChange={(steering) => setVehicle({ steering })}
        />
      </section>
      <ModKitGroup object={object} runtime={runtime} onChange={onChange} />
      {extras.length ? (
        <section className="lv-group">
          <div className="lv-group-head">
            <h3 className="lv-group-title">Extras</h3>
            {Object.keys(vehicle.extras).length ? (
              <button type="button" className="lv-link" onClick={() => setVehicle({ extras: {} })}>All off</button>
            ) : null}
          </div>
          {extras.map((extra) => (
            <div key={extra.index} className="lv-toggle-row">
              <span>{extra.label}</span>
              <Toggle
                checked={Boolean(vehicle.extras[extra.index])}
                onChange={(on) => {
                  const next = { ...vehicle.extras };
                  if (on) next[extra.index] = true;
                  else delete next[extra.index];
                  setVehicle({ extras: next });
                }}
                ariaLabel={`Show ${extra.label}`}
              />
            </div>
          ))}
        </section>
      ) : null}
      {liveries ? (
        <section className="lv-group">
          <h3 className="lv-group-title">Livery</h3>
          <SelectRow
            label="Texture livery"
            value={vehicle.livery == null ? "model" : String(vehicle.livery)}
            onChange={(value) => setVehicle({ livery: value === "model" ? null : Number(value) })}
            options={[{ id: "model", label: "As modelled" }, ...liveries.map((number) => ({ id: String(number), label: `Livery ${number}` }))]}
          />
          {runtime.liveryError ? <Note tone="error">{runtime.liveryError}</Note> : null}
          <p className="lv-slot-note">Mod kit liveries are in the Livery slot of the mod kit.</p>
        </section>
      ) : null}
      <VehiclePlatePanel
        plate={vehicle.plate}
        onChange={(patch) => setVehicle({ plate: { ...vehicle.plate, ...patch } })}
        status={runtime.plate}
        isTauriRuntime={desktop}
        hasPlate={controller.hasPlate}
      />
      <PaintSlots
        key={object.id}
        title="Paint"
        paint={vehicle.paint}
        onChange={(key, value) => value && setVehicle({ paint: { ...vehicle.paint, [key]: value } })}
        onReset={(key) => setVehicle({ paint: { ...vehicle.paint, [key]: buildVehiclePaint()[key] } })}
      />
    </>
  );
}

/* ── Camera tab ── */

function CameraTab({ settings, onLens, onSaveShot, onUseShot, onDeleteShot, onOutput }) {
  const showroom = settings.scene.stage === "showroom";
  return (
    <>
      <section className="lv-group">
        <h3 className="lv-group-title">Lens</h3>
        <Slider id="pm-lens" label="Focal length" value={settings.lens} min={LENS_MIN_MM} max={LENS_MAX_MM} step={1} format={(v) => `${Math.round(v)} mm`} onChange={onLens} />
        <div className="lv-chips" role="group" aria-label="Lens presets">
          {LENS_PRESETS.map((mm) => (
            <button
              key={mm}
              type="button"
              className={`lv-chip-btn ${Math.round(settings.lens) === mm ? "is-on" : ""}`}
              aria-pressed={Math.round(settings.lens) === mm}
              onClick={() => onLens(mm)}
            >
              {mm}
            </button>
          ))}
        </div>
        <p className="lv-slot-note">Wide lenses exaggerate depth; 85 mm and longer flatten it, as for portraits.</p>
      </section>

      <section className="lv-group">
        <div className="lv-group-head">
          <h3 className="lv-group-title">Saved views</h3>
          <button type="button" className="lv-link" onClick={onSaveShot} disabled={settings.shots.length >= 12}>
            Save this view
          </button>
        </div>
        {settings.shots.length ? (
          <ul className="pm-shots">
            {settings.shots.map((shot) => (
              <li key={shot.id} className="pm-shot">
                <button type="button" className="pm-shot-use" onClick={() => onUseShot(shot)} title="Return to this view">
                  <Bookmark aria-hidden="true" />
                  <span>{shot.name}</span>
                  <span className="pm-shot-lens">{Math.round(shot.lens)} mm</span>
                </button>
                <button type="button" className="cx-icon-btn" onClick={() => onDeleteShot(shot.id)} aria-label={`Delete ${shot.name}`} title="Delete">
                  <Trash2 aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="lv-slot-note">Save a camera angle and lens to come back to it after you rearrange the set.</p>
        )}
      </section>

      <section className="lv-group">
        <h3 className="lv-group-title">Photo</h3>
        <SelectRow
          label="Size"
          value={settings.output.preset}
          onChange={(preset) => onOutput({ preset })}
          options={OUTPUT_PRESETS.map((preset) => ({ id: preset.id, label: `${preset.label} px` }))}
        />
        <Seg
          id="pm-out-bg"
          label="Background"
          value={settings.output.transparent && !showroom ? "clear" : "scene"}
          onChange={(value) => onOutput({ transparent: value === "clear" })}
          options={[
            { id: "scene", label: "As shown" },
            {
              id: "clear",
              label: "Transparent",
              disabled: showroom,
              title: showroom ? "The showroom is the background; switch to the workbench for a cut-out" : undefined,
            },
          ]}
        />
        {showroom ? <p className="lv-slot-note">Transparent photos need the workbench stage.</p> : null}
        <div className="lv-toggle-row">
          <span>Frame guide</span>
          <Toggle checked={settings.output.guides} onChange={(guides) => onOutput({ guides })} ariaLabel="Show the photo's frame in the viewfinder" />
        </div>
      </section>
    </>
  );
}

/* ── Scene tab ── */

function SceneTab({ scene, onScene, defaultBackdrop }) {
  const stageControls = {
    stage: scene.stage,
    setStage: (stage) => onScene({ stage }),
    stageLight: scene.light,
    setStageLight: (light) => onScene({ light }),
    stageSpot: scene.spot,
    setStageSpot: (spot) => onScene({ spot }),
    stageReflect: scene.reflect,
    setStageReflect: (reflect) => onScene({ reflect }),
    stageBeam: scene.beam,
    setStageBeam: (beam) => onScene({ beam }),
  };
  return (
    <>
      <StageSection s={stageControls} notes={STAGE_NOTES}>
        <FloorField id="pm-floor-label" value={scene.floor} onChange={(floor) => onScene({ floor })} />
      </StageSection>
      <section className="lv-group">
        <h3 className="lv-group-title">Light</h3>
        <Slider id="pm-light" label="Fill light" value={scene.lightLevel} min={0} max={3} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(lightLevel) => onScene({ lightLevel })} />
        <Slider id="pm-dark" label="Dark room" value={scene.dark} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(dark) => onScene({ dark })} />
        <p className="lv-slot-note">Dims the studio, spotlights included, so vehicle lights carry the shot.</p>
      </section>
      <section className="lv-group">
        <h3 className="lv-group-title">Vehicle lights</h3>
        <Slider id="pm-light-glow" label="Glow" value={scene.lightGlow} min={0} max={2} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(lightGlow) => onScene({ lightGlow })} />
        <Slider id="pm-light-spill" label="Light on surroundings" value={scene.lightSpill} min={0} max={3} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(lightSpill) => onScene({ lightSpill })} />
        <Slider id="pm-light-haze" label="Haze" value={scene.haze} min={0} max={2} step={0.05} format={(v) => (v <= 0 ? "Off" : `${v.toFixed(2)}×`)} onChange={(haze) => onScene({ haze })} />
      </section>
      {scene.stage !== "showroom" ? (
        <section className="lv-group">
          <h3 className="lv-group-title">Backdrop</h3>
          <div className="lv-colors">
            <ColorLine label="Background" value={scene.backdrop} onChange={(backdrop) => onScene({ backdrop })} onReset={() => onScene({ backdrop: defaultBackdrop })} />
          </div>
        </section>
      ) : null}
    </>
  );
}

export default function PhotoInspector({
  onResize,
  tab,
  onTab,
  inert,
  settings,
  selected,
  runtime,
  desktop,
  defaultBackdrop,
  onObject,
  onTogglePlay,
  onScene,
  onLens,
  onSaveShot,
  onUseShot,
  onDeleteShot,
  onOutput,
}) {
  const isVehicle = selected?.kind === "vehicle";
  // The Vehicle tab exists while a vehicle is selected; otherwise its content falls back to Object.
  const shown = tab === "vehicle" && !isVehicle ? "object" : tab;
  return (
    <aside className="lv-inspector" aria-label="Inspector" inert={inert}>
      {onResize ? <PaneResizer side="insp" label="Resize the inspector" setWidth={onResize} /> : null}
      <InspectorTabs
        tabs={[
          { id: "object", label: "Object" },
          ...(isVehicle ? [{ id: "vehicle", label: "Vehicle" }] : []),
          { id: "camera", label: "Camera" },
          { id: "scene", label: "Scene" },
        ]}
        active={shown}
        onChange={onTab}
      />
      <div className="lv-inspector-scroll custom-scrollbar">
        {shown === "vehicle" ? <VehicleTab object={selected} runtime={runtime} desktop={desktop} onChange={onObject} /> : null}
        {shown === "object" ? (
          <ObjectTab
            object={selected}
            runtime={runtime}
            desktop={desktop}
            lit={Boolean(selected && litObjectIds(settings.objects).includes(selected.id))}
            showroom={settings.scene.stage === "showroom"}
            onChange={onObject}
            onTogglePlay={onTogglePlay}
          />
        ) : null}
        {shown === "camera" ? (
          <CameraTab
            settings={settings}
            onLens={onLens}
            onSaveShot={onSaveShot}
            onUseShot={onUseShot}
            onDeleteShot={onDeleteShot}
            onOutput={onOutput}
          />
        ) : null}
        {shown === "scene" ? <SceneTab scene={settings.scene} onScene={onScene} defaultBackdrop={defaultBackdrop} /> : null}
      </div>
    </aside>
  );
}

