import { useState } from "react";
import { BookmarkPlus } from "lucide-react";
import { FactDisclosure } from "./DockFacts";
import { defaultSavedVehicleName, findSavedVehicleByName, loadSavedVehicles, savedVehicleFileName, savedVehicleLinkStatus } from "../../lib/saved-vehicles";

/* Saves the loaded vehicle's setup (mod kit parts, paint, extras, plate and,
   in Vehicle, the livery) under a name Home lists as a saved vehicle.
   A fact row in the model step's <Facts>: closed it names the saved vehicle
   or offers Save, open it holds the name field or Update / Save as new. App
   owns the write and the link back to the entry this tab came from, so a
   linked tab updates that entry. */

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function contents(s) {
  const list = [];
  const parts = Object.keys(s.modkits?.savedSelection?.mods || {}).length;
  const modsShown = s.mode === "vehicle" || s.mode === "sirens";
  if (modsShown && parts) list.push(plural(parts, "mod part"));
  list.push("paint", "extras", "plate");
  if (s.mode === "vehicle" && s.texturePath) list.push("livery");
  const text = `${list.join(", ")} and the model path`;
  return text[0].toUpperCase() + text.slice(1);
}

export default function SaveVehicle({ s }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(null); // { name, asNew, library, notice }
  const [error, setError] = useState("");
  if (!s.saveVehicle || !s.modelPath) return null;
  const linked = s.savedVehicle;

  const close = () => {
    setOpen(false);
    setForm(null);
    setError("");
  };
  const run = (name, options) => {
    const result = s.saveVehicle(name, options);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    close();
    return true;
  };
  const begin = (asNew, notice = "") => {
    setError("");
    setForm({ asNew, notice, name: !asNew && linked ? linked.name : defaultSavedVehicleName(s.modelPath), library: loadSavedVehicles() });
    setOpen(true);
  };
  const toggle = (next) => {
    if (!next) close();
    else if (linked) setOpen(true);
    else begin(false);
  };
  // The entry may have been deleted on Home since this tab linked to it, or
  // pointed at another model (Locate, another tab). Then Update asks for a
  // name like a new save, so it can't replace another vehicle or undo the move.
  const update = () => {
    const library = loadSavedVehicles();
    const status = savedVehicleLinkStatus(library, linked.id, s.modelPath);
    if (status === "linked") {
      run(linked.name);
      return;
    }
    const moved = status === "moved" ? library.vehicles.find((entry) => entry.id === linked.id) : null;
    const where = moved && savedVehicleFileName(moved.modelPath) === savedVehicleFileName(s.modelPath) ? moved.modelPath : savedVehicleFileName(moved?.modelPath);
    begin(true, moved ? `${linked.name} now opens ${where}, so this setup is saved as a new vehicle.` : "");
  };
  const submit = (event) => {
    event.preventDefault();
    const name = form.name.trim();
    if (name) run(name, { asNew: form.asNew });
  };
  // Escape closes the row and hands focus back to its toggle.
  const onKeyDown = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.closest(".lv-fact")?.querySelector(".lv-fact-toggle")?.focus();
    close();
  };

  let body = null;
  if (form) {
    const trimmed = form.name.trim();
    const existing = trimmed ? findSavedVehicleByName(form.library, trimmed) : null;
    const updating = !form.asNew && linked;
    const replacing = existing && !(updating && existing.id === linked.id);
    body = (
      <>
        <form className="lv-vehicle-form" onSubmit={submit}>
          <input
            type="text"
            className="lv-text-input"
            value={form.name}
            maxLength={60}
            placeholder="Vehicle name"
            aria-label="Saved vehicle name"
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setForm({ ...form, name: event.currentTarget.value })}
          />
          <button type="submit" className="cx-btn is-primary" disabled={!trimmed}>
            {replacing ? "Replace" : updating ? "Update" : "Save"}
          </button>
        </form>
        {form.notice ? <p className="lv-slot-note is-warn" role="status">{form.notice}</p> : null}
        {replacing
          ? <p className="lv-slot-note is-warn"><span className="lv-dot" aria-hidden="true" />{`Replaces the saved ${existing.name}.`}</p>
          : <p className="lv-slot-note">{`${contents(s)}. Opens from Home while the model is on this PC.`}</p>}
      </>
    );
  } else if (linked) {
    body = (
      <div className="lv-vehicle-acts">
        <button type="button" className="cx-btn is-primary" onClick={update} title={`Save the current setup over ${linked.name}`}>
          Update
        </button>
        <button type="button" className="cx-btn" onClick={() => begin(true)} title="Save the current setup under a new name">
          Save as new
        </button>
      </div>
    );
  }

  return (
    <FactDisclosure
      className="lv-vehicle-row"
      label="Saved vehicle"
      text
      open={open}
      onOpenChange={toggle}
      ariaLabel={linked ? `Saved vehicle: ${linked.name}` : "Save this vehicle"}
      title={linked ? linked.name : "Keep this setup on Home"}
      value={linked
        ? <span className="lv-vehicle-name">{linked.name}</span>
        : open
          ? <span className="lv-vehicle-none">not saved</span>
          : <span className="lv-vehicle-cta"><BookmarkPlus aria-hidden="true" />Save</span>}
    >
      <div className="lv-vehicle-panel" onKeyDown={onKeyDown}>
        {body}
        {error ? <p className="lv-slot-note is-error" role="alert"><span className="lv-dot" aria-hidden="true" />{error}</p> : null}
      </div>
    </FactDisclosure>
  );
}
