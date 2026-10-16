import { useEffect } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SelectField } from "./parts";
import { BuildsSection, KitShootSection } from "./KitShootPanel";

/* Mods inspector for All and Sirens: pick the vehicle's game livery and
   carcols mod kit parts per slot, and preview them on the loaded vehicle. Kit
   Shoot only shows in All. State lives in useVehicleModkits; the viewer
   reports per-part load and texture status back through `status`. */

const STOCK = "stock";
const LIVERY_SLOT = "VMT_LIVERY_MOD";

function Note({ tone = "idle", children }) {
  return (
    <p className={`lv-slot-note is-${tone}`}>
      <span className="lv-dot" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function partNote(part, status, nativeOn) {
  if (!status || status.state === "loading") return { tone: "idle", text: `Loading ${part.modelName}…` };
  if (status.state === "error") return { tone: "error", text: `${part.modelName} didn't load: ${status.message}` };
  const textures = status.textures;
  if (!nativeOn || !textures) return null;
  if (textures.state === "loading") return { tone: "idle", text: `Loading textures for ${part.modelName}…` };
  if (textures.state === "error") return { tone: "error", text: `Textures for ${part.modelName} didn't load: ${textures.message}` };
  const problems = [
    textures.failed > 0 ? `${textures.failed} couldn't load` : "",
    textures.missing > 0 ? `${textures.missing} not found` : "",
  ].filter(Boolean);
  if (problems.length) return { tone: "warn", text: `${part.modelName}: ${problems.join(", ")}` };
  return null;
}

function SlotField({ slot, value, onChange, parts, missing, status, nativeOn, disabled }) {
  const slotParts = parts.filter((part) => part.slotType === slot.type);
  const slotMissing = missing.filter((entry) => entry.slotType === slot.type);
  const renamed = slot.displayName !== slot.label;
  return (
    <div className="lv-mod-slot">
      <div className="lv-field">
        <span className="lv-mod-slot-head">
          <span className="cx-label" title={slot.displayName}>{slot.displayName}</span>
          {renamed ? <span className="lv-mod-meta">{slot.label}</span> : null}
        </span>
        <Select
          value={Number.isInteger(value) ? String(value) : STOCK}
          onValueChange={(next) => onChange(next === STOCK ? null : Number(next))}
          disabled={disabled}
        >
          <SelectTrigger aria-label={slot.displayName}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={STOCK}>Stock</SelectItem>
            {slot.mods.map((mod) => (
              <SelectItem
                key={mod.index}
                value={String(mod.index)}
                description={mod.displayName !== mod.modelName ? mod.modelName : undefined}
              >
                {mod.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {slotMissing.map((entry) => (
        <Note key={entry.modelName} tone="warn">{`${entry.modelName}.yft isn't in this resource.`}</Note>
      ))}
      {disabled ? null : slotParts.map((part) => {
        const note = partNote(part, status?.parts?.[part.key], nativeOn);
        return note ? <Note key={part.key} tone={note.tone}>{note.text}</Note> : null;
      })}
    </div>
  );
}

/* The vehicle's own liveries, as the game switches them: texture liveries
   (`<prefix>_sign_N` in its texture dictionary) and the kit's livery mods.
   One is shown at a time; a livery mod wins over a texture livery in game, so
   picking one clears the other. */
function LiverySection({ s, kit, parts, missing, status, locked }) {
  const modkits = s.modkits;
  const textureNumbers = s.gameLiveries?.numbers || [];
  const prefix = s.gameLiveries?.prefix || "";
  const slot = kit?.slots.find((entry) => entry.type === LIVERY_SLOT) || null;
  if (textureNumbers.length === 0 && !slot) return null;

  const options = [{ value: STOCK, label: "As modelled" }];
  for (const number of textureNumbers) {
    options.push({
      value: `t:${number}`,
      label: kit?.liveryNames?.[number - 1] || `Livery ${number}`,
      description: `${prefix}_sign_${number}`,
    });
  }
  for (const mod of slot?.mods || []) {
    options.push({
      value: `m:${mod.index}`,
      label: mod.displayName,
      description: mod.displayName !== mod.modelName ? `Mod · ${mod.modelName}` : "Mod",
    });
  }
  const modIndex = modkits.selection[LIVERY_SLOT];
  const value = Number.isInteger(modIndex) && options.some((option) => option.value === `m:${modIndex}`)
    ? `m:${modIndex}`
    : s.gameLivery != null && textureNumbers.includes(s.gameLivery) ? `t:${s.gameLivery}` : STOCK;

  const choose = (next) => {
    const [kind, raw] = next.split(":");
    const number = Number(raw);
    if (kind === "m") {
      s.setGameLivery(null);
      modkits.setMod(LIVERY_SLOT, number);
      return;
    }
    if (Number.isInteger(modIndex)) modkits.setMod(LIVERY_SLOT, null);
    s.setGameLivery(kind === "t" ? number : null);
  };
  const step = (delta) => {
    const index = options.findIndex((option) => option.value === value);
    choose(options[(index + delta + options.length) % options.length].value);
  };

  const nativeOn = Boolean(s.nativeMaterialsEnabled);
  const modPart = parts.find((part) => part.slotType === LIVERY_SLOT) || null;
  const modNote = modPart ? partNote(modPart, status?.parts?.[modPart.key], nativeOn) : null;
  const modMissing = missing.filter((entry) => entry.slotType === LIVERY_SLOT);
  return (
    <section className="lv-group" id="panel-livery">
      <div className="lv-group-head">
        <h3 className="lv-group-title">Livery</h3>
        <span className="lv-mod-meta">{`${options.length - 1} in game`}</span>
      </div>
      <div className="lv-livery-row">
        <Select value={value} onValueChange={choose} disabled={locked}>
          <SelectTrigger aria-label="Livery">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value} description={option.description}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button type="button" className="cx-icon-btn" aria-label="Previous livery" title="Previous livery" disabled={locked} onClick={() => step(-1)}>
          <ChevronLeft aria-hidden="true" />
        </button>
        <button type="button" className="cx-icon-btn" aria-label="Next livery" title="Next livery" disabled={locked} onClick={() => step(1)}>
          <ChevronRight aria-hidden="true" />
        </button>
      </div>
      {!nativeOn && value !== STOCK ? (
        <p className="lv-slot-note">
          <span>Liveries show once the model's own textures are on.</span>
          <button type="button" className="lv-link lv-native-retry" onClick={() => s.setNativeMaterialsEnabled(true)}>
            Turn on
          </button>
        </p>
      ) : null}
      {/* A loaded texture is the final override on the meshes it targets (Viewer). */}
      {nativeOn && s.texturePath ? (
        <Note>
          {s.textureTarget === "all"
            ? "Your loaded texture covers every mesh, so a game livery won't show until you unload it."
            : "Your loaded texture stays on the meshes it's applied to; a game livery shows on the rest."}
        </Note>
      ) : null}
      {s.gameLiveries?.error ? <Note tone="error">{s.gameLiveries.error}</Note> : null}
      {modMissing.map((entry) => (
        <Note key={entry.modelName} tone="warn">{`${entry.modelName}.yft isn't in this resource.`}</Note>
      ))}
      {modNote && !locked ? <Note tone={modNote.tone}>{modNote.text}</Note> : null}
    </section>
  );
}

export default function ModkitPanel({ s }) {
  const modkits = s.modkits;
  const status = s.vehicleModsStatus;
  const { request } = modkits;
  useEffect(() => { request(); }, [request]);

  if (!s.isTauriRuntime) return <p className="lv-slot-note">Mod kits need the desktop app.</p>;
  if (!s.modelPath) return <p className="lv-slot-note">Load a vehicle to preview its mod kit.</p>;
  // Texture liveries don't need the kit, so they show while it is unavailable.
  const textureLiveries = <LiverySection s={s} kit={null} parts={[]} missing={[]} status={status} locked={false} />;
  if (!modkits.eligible) {
    return (
      <>
        {textureLiveries}
        <p className="lv-slot-note">Mod kits need a .yft vehicle model.</p>
      </>
    );
  }
  if (modkits.status === "idle" || modkits.status === "scanning") {
    return (
      <>
        {textureLiveries}
        <p className="lv-slot-note is-busy">Reading the resource's meta files…</p>
      </>
    );
  }

  const rescan = (
    <button type="button" className="lv-link lv-native-retry" onClick={modkits.rescan}>
      <RefreshCw aria-hidden="true" />
      Rescan
    </button>
  );
  const readErrors = modkits.errors.length > 0
    ? <Note tone="warn">{`${modkits.errors.length} file${modkits.errors.length === 1 ? "" : "s"} couldn't be read: ${modkits.errors[0].message}`}</Note>
    : null;

  if (modkits.status === "error" || !modkits.activeKit) {
    return (
      <>
        {textureLiveries}
        <section className="lv-group" id="panel-modkit">
          <div className="lv-group-head">
            <h3 className="lv-group-title">Mod kit</h3>
            {rescan}
          </div>
          <p className="lv-slot-note">
            {modkits.status === "error"
              ? "The resource couldn't be scanned."
              : `No mod kit with visible parts was found for ${modkits.modelName} in this resource's carcols.meta.`}
          </p>
          {readErrors}
        </section>
      </>
    );
  }

  const kit = modkits.activeKit;
  const { parts, missing, hiddenBones } = modkits.resolution;
  const partSlots = kit.slots.filter((slot) => slot.type !== LIVERY_SLOT);
  // The livery has its own picker, so "All stock" leaves it alone.
  const pickedSlots = partSlots.filter((slot) => Number.isInteger(modkits.selection[slot.type]));
  const allStock = () => {
    for (const slot of pickedSlots) modkits.setMod(slot.type, null);
  };
  const nativeOn = Boolean(s.nativeMaterialsEnabled);
  const nameSources = modkits.nameSources || [];
  // A running kit shoot drives the viewer; the picks below are what it restores.
  const locked = modkits.shooting || Boolean(s.kitShoot?.running);
  return (
    <>
      <LiverySection s={s} kit={kit} parts={parts} missing={missing} status={status} locked={locked} />
      <section className="lv-group" id="panel-modkit">
        <div className="lv-group-head">
          <h3 className="lv-group-title">Mod kit</h3>
          {rescan}
        </div>
        {modkits.kits.length > 1 ? (
          <SelectField label="Kit">
            <Select value={kit.kitName} onValueChange={modkits.setKit} disabled={locked}>
              <SelectTrigger aria-label="Mod kit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modkits.kits.map((entry) => (
                  <SelectItem key={entry.kitName} value={entry.kitName}>{entry.kitName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SelectField>
        ) : (
          <p className="lv-mod-kit" title={kit.sourcePath}>
            <span>{kit.kitName}</span>
            {kit.id != null ? <span className="lv-mod-meta">id {kit.id}</span> : null}
          </p>
        )}
        {!kit.linked ? (
          <Note tone="warn">Not listed under kits in carvariations.meta, so the game won't offer these parts.</Note>
        ) : null}
        {!nativeOn ? (
          <p className="lv-slot-note">
            <span>Parts show untextured until the model's own textures are on.</span>
            <button type="button" className="lv-link lv-native-retry" onClick={() => s.setNativeMaterialsEnabled(true)}>
              Turn on
            </button>
          </p>
        ) : status && !status.parentTexturesAvailable && parts.length > 0 ? (
          <Note tone="warn">The vehicle's texture dictionary isn't available, so parts only use textures they embed.</Note>
        ) : null}
        {nameSources.length > 0 ? (
          <p className="lv-slot-note" title={nameSources.join("\n")}>
            <span>Names from </span>
            <span className="lv-mod-meta">{nameSources.map((path) => path.split("/").pop()).join(", ")}</span>
          </p>
        ) : (
          <p className="lv-slot-note">No AddTextEntry names in this resource's scripts, so parts show their carcols labels.</p>
        )}
        {readErrors}
      </section>

      {partSlots.length > 0 ? (
        <section className="lv-group" id="panel-modkit-parts">
          <div className="lv-group-head">
            <h3 className="lv-group-title">Parts</h3>
            <button type="button" className="lv-link" onClick={allStock} disabled={locked || pickedSlots.length === 0}>
              All stock
            </button>
          </div>
          {partSlots.map((slot) => (
            <SlotField
              key={slot.type}
              slot={slot}
              value={modkits.selection[slot.type]}
              onChange={(index) => modkits.setMod(slot.type, index)}
              parts={parts}
              missing={missing}
              status={status}
              nativeOn={nativeOn}
              disabled={locked}
            />
          ))}
          {hiddenBones.length > 0 && !locked ? (
            status && !status.boneDataAvailable ? (
              <Note tone="warn">{`This model has no bone data, so the stock parts on ${hiddenBones.join(", ")} stay visible.`}</Note>
            ) : (
              <p className="lv-slot-note">
                <span>
                  {`Hiding ${status?.hiddenMeshCount ?? 0} stock mesh${status?.hiddenMeshCount === 1 ? "" : "es"} on `}
                  <span className="lv-mod-meta">{hiddenBones.join(", ")}</span>
                </span>
              </p>
            )
          ) : null}
        </section>
      ) : null}

      <BuildsSection modkits={modkits} disabled={locked} />
      {s.kitShoot ? <KitShootSection s={s} modkits={modkits} /> : null}
    </>
  );
}
