import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Car, FolderOpen, Loader2, Lamp, Search, User, X } from "lucide-react";
import { BODY_PRESETS, CLOTHING_PRESETS, bodyPresetsFor } from "../../lib/eup.js";
import { PHOTO_MODEL_EXTENSIONS, canonicalVehicleClass, filterGameVehicles, vehicleClassLabel } from "../../lib/photo-mode.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

const KINDS = [
  { id: "vehicle", label: "Vehicles", icon: Car },
  { id: "ped", label: "People", icon: User },
  { id: "prop", label: "Props", icon: Lamp },
];
const ALL_CLASSES = "all";
const PROP_SEARCH_DEBOUNCE_MS = 220;
const VEHICLE_ROW_LIMIT = 200;

// The game's vehicle catalogue is read once per app session.
let vehicleCatalog = null;
function loadVehicleCatalog() {
  if (!vehicleCatalog) {
    vehicleCatalog = invoke("list_game_vehicles").catch((error) => {
      vehicleCatalog = null;
      throw error;
    });
  }
  return vehicleCatalog;
}

function errorText(error) {
  return (typeof error === "string" ? error : error?.message) || "Unknown error";
}

function titleCase(value) {
  return String(value || "").toLowerCase().replace(/(^|[\s_-])([a-z])/g, (match, gap, letter) => gap + letter.toUpperCase());
}

/**
 * Picks what to put on set: a base-game vehicle, a freemode ped, a game prop,
 * or the user's own vehicle or prop file. `onAdd` receives a partial scene
 * object; the page places and loads it.
 */
export default function AddToSetDialog({ initialKind = "vehicle", desktop, onAdd, onClose }) {
  const [kind, setKind] = useState(initialKind);
  const [query, setQuery] = useState("");
  const [vehicleClass, setVehicleClass] = useState(ALL_CLASSES);
  const [vehicles, setVehicles] = useState({ status: "idle", list: [], error: "" });
  const [props, setProps] = useState({ status: "idle", list: [], total: 0, error: "" });
  const [gender, setGender] = useState("male");
  const [body, setBody] = useState(BODY_PRESETS.male[0].id);
  const [outfit, setOutfit] = useState(CLOTHING_PRESETS.male[0].id);
  const searchRef = useRef(null);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    searchRef.current?.focus();
  }, [kind]);

  useEffect(() => {
    if (kind !== "vehicle" || !desktop || vehicles.status !== "idle") return;
    setVehicles({ status: "loading", list: [], error: "" });
    loadVehicleCatalog().then(
      (result) => setVehicles({ status: "ready", list: Array.isArray(result?.vehicles) ? result.vehicles : [], error: "" }),
      (error) => setVehicles({ status: "error", list: [], error: errorText(error) }),
    );
  }, [desktop, kind, vehicles.status]);

  const propQuery = query.trim().toLowerCase();
  useEffect(() => {
    if (kind !== "prop" || !desktop) return undefined;
    if (propQuery.length < 2) {
      setProps({ status: "idle", list: [], total: 0, error: "" });
      return undefined;
    }
    if (!/^[a-z0-9_@.\- ]{2,64}$/.test(propQuery)) {
      setProps({ status: "error", list: [], total: 0, error: "Search with letters, digits, _ and -." });
      return undefined;
    }
    let cancelled = false;
    setProps((prev) => ({ ...prev, status: "loading", error: "" }));
    const timer = setTimeout(() => {
      invoke("search_game_props", { query: propQuery }).then(
        (result) => !cancelled && setProps({
          status: "ready",
          list: Array.isArray(result?.props) ? result.props : [],
          total: Number(result?.total) || 0,
          error: "",
        }),
        (error) => !cancelled && setProps({ status: "error", list: [], total: 0, error: errorText(error) }),
      );
    }, PROP_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [desktop, kind, propQuery]);

  const classes = useMemo(
    () => [...new Set(vehicles.list.map((vehicle) => canonicalVehicleClass(vehicle.vehicleClass)).filter(Boolean))]
      .sort((a, b) => vehicleClassLabel(a).localeCompare(vehicleClassLabel(b))),
    [vehicles.list],
  );
  const matchingVehicles = useMemo(
    () => filterGameVehicles(vehicles.list, { query, vehicleClass: vehicleClass === ALL_CLASSES ? "" : vehicleClass }),
    [query, vehicleClass, vehicles.list],
  );

  const pickFile = async () => {
    const extensions = PHOTO_MODEL_EXTENSIONS[kind];
    const picked = await open({
      multiple: false,
      title: kind === "vehicle" ? "Add a vehicle" : "Add a prop",
      filters: [{ name: kind === "vehicle" ? "Vehicle models" : "Prop models", extensions }],
    });
    if (typeof picked === "string" && picked) onAdd({ kind, source: "file", path: picked });
  };

  const changeGender = (next) => {
    setGender(next);
    setBody(BODY_PRESETS[next][0].id);
    setOutfit(CLOTHING_PRESETS[next][0].id);
  };

  return (
    <div className="pm-scrim" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="pm-dialog pm-add" role="dialog" aria-modal="true" aria-labelledby="pm-add-title">
        <header className="pm-dialog-head">
          <h2 id="pm-add-title" className="cx-display pm-dialog-title">Add to set</h2>
          <button type="button" className="cx-icon-btn" onClick={onClose} aria-label="Close" title="Close">
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="pm-add-kinds lv-seg" role="radiogroup" aria-label="What to add">
          {KINDS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={kind === item.id}
              className={`lv-seg-btn ${kind === item.id ? "is-on" : ""}`}
              onClick={() => {
                setKind(item.id);
                setQuery("");
              }}
            >
              <item.icon aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </div>

        {kind === "ped" ? (
          <div className="pm-dialog-body">
            <div className="lv-field">
              <span className="cx-label" id="pm-add-gender">Ped</span>
              <div className="lv-seg" role="radiogroup" aria-labelledby="pm-add-gender">
                {[
                  { id: "male", label: "Freemode male" },
                  { id: "female", label: "Freemode female" },
                ].map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={gender === option.id}
                    className={`lv-seg-btn ${gender === option.id ? "is-on" : ""}`}
                    onClick={() => changeGender(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="lv-field">
              <span className="cx-label">Look</span>
              <Select value={body} onValueChange={setBody}>
                <SelectTrigger aria-label="Look"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {bodyPresetsFor(gender).map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>{preset.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="lv-field">
              <span className="cx-label">Clothes</span>
              <Select value={outfit} onValueChange={setOutfit}>
                <SelectTrigger aria-label="Clothes"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CLOTHING_PRESETS[gender].map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>{preset.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="pm-dialog-note">Built from the game&apos;s freemode ped. Pose, look and clothes can change once it&apos;s on set.</p>
            <footer className="pm-dialog-actions">
              <button type="button" className="settings-secondary" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="settings-primary"
                disabled={!desktop}
                onClick={() => onAdd({ kind: "ped", ped: { gender, body, outfit } })}
              >
                Add person
              </button>
            </footer>
          </div>
        ) : (
          <div className="pm-dialog-body pm-add-browse">
            <div className="pm-add-search">
              <label className="pm-search">
                <Search aria-hidden="true" />
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  spellCheck={false}
                  placeholder={kind === "vehicle" ? "Search by model, name or make" : "Search props, e.g. cone, barrier"}
                  aria-label={kind === "vehicle" ? "Search vehicles" : "Search props"}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              {kind === "vehicle" && classes.length ? (
                <Select value={vehicleClass} onValueChange={setVehicleClass}>
                  <SelectTrigger className="pm-class-select" aria-label="Vehicle class"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_CLASSES}>All classes</SelectItem>
                    {classes.map((value) => (
                      <SelectItem key={value} value={value}>{vehicleClassLabel(value)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>

            <div className="pm-results custom-scrollbar" role="listbox" aria-label="Results">
              {!desktop ? (
                <p className="pm-results-note">Reading the game files needs the desktop app.</p>
              ) : kind === "vehicle" ? (
                vehicles.status === "loading" ? (
                  <p className="pm-results-note"><Loader2 className="pm-spin" aria-hidden="true" />Reading the vehicle list from the game files…</p>
                ) : vehicles.status === "error" ? (
                  <p className="pm-results-note is-error">The vehicle list didn&apos;t load: {vehicles.error}</p>
                ) : matchingVehicles.length === 0 ? (
                  <p className="pm-results-note">No vehicle matches.</p>
                ) : (
                  matchingVehicles.slice(0, VEHICLE_ROW_LIMIT).map((vehicle) => (
                    <button
                      key={vehicle.name}
                      type="button"
                      role="option"
                      aria-selected="false"
                      className="pm-result"
                      onClick={() => onAdd({ kind: "vehicle", source: "game", name: vehicle.name })}
                    >
                      <span className="pm-result-name">{vehicle.name}</span>
                      <span className="pm-result-meta">
                        {[titleCase(vehicle.make), vehicleClassLabel(vehicle.vehicleClass), vehicle.pack || "base game"].filter(Boolean).join(" · ")}
                      </span>
                    </button>
                  ))
                )
              ) : propQuery.length < 2 ? (
                <p className="pm-results-note">Type two or more characters to search the game&apos;s props.</p>
              ) : props.status === "error" ? (
                <p className="pm-results-note is-error">{props.error}</p>
              ) : props.status === "loading" && props.list.length === 0 ? (
                <p className="pm-results-note"><Loader2 className="pm-spin" aria-hidden="true" />Searching the game files…</p>
              ) : props.list.length === 0 ? (
                <p className="pm-results-note">No prop matches.</p>
              ) : (
                props.list.map((name) => (
                  <button
                    key={name}
                    type="button"
                    role="option"
                    aria-selected="false"
                    className="pm-result"
                    onClick={() => onAdd({ kind: "prop", source: "game", name })}
                  >
                    <span className="pm-result-name">{name}</span>
                  </button>
                ))
              )}
            </div>

            <footer className="pm-add-foot">
              <span className="pm-add-count">
                {kind === "vehicle" && vehicles.status === "ready"
                  ? `${Math.min(matchingVehicles.length, VEHICLE_ROW_LIMIT)} of ${matchingVehicles.length}${matchingVehicles.length > VEHICLE_ROW_LIMIT ? ", refine the search" : ""}`
                  : kind === "prop" && props.status === "ready"
                    ? `${props.list.length} of ${props.total}`
                    : ""}
              </span>
              <button type="button" className="cx-btn lv-btn-sm" onClick={pickFile} disabled={!desktop}>
                <FolderOpen aria-hidden="true" />
                {kind === "vehicle" ? "Your own .yft…" : "Your own model…"}
              </button>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
