import { memo, useEffect, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Eye, EyeOff, Loader2, Shuffle } from "lucide-react";
import {
  COMPONENT_IDS,
  DEFAULT_BASE_OUTFIT,
  HAIR_COLORS,
  PROP_IDS,
  componentDisplayName,
  isPropComponent,
  resolveDrawableNumber,
  stepGameDrawable,
} from "../../lib/eup";
import { OUTFIT_STYLES } from "../../lib/eup-outfit-generator";

const STYLE_GROUPS = [
  { kind: "everyday", label: "Everyday" },
  { kind: "service", label: "Service" },
];

/** Style choices; the worn style is opposite ink and generates another when pressed again. */
function OutfitGenerator({ generated, generating, ready, note, onGenerate }) {
  const active = generated ? OUTFIT_STYLES.find((style) => style.id === generated.style) : null;
  return (
    <section className="lv-group">
      <h3 className="lv-group-title">Outfit generator</h3>
      {STYLE_GROUPS.map((group) => (
        <div key={group.kind} className="eup-gen-group">
          <p className="eup-gen-kind">{group.label}</p>
          <ul className="eup-presets" aria-label={`${group.label} outfits`}>
            {OUTFIT_STYLES.filter((style) => style.kind === group.kind).map((style) => {
              const on = active?.id === style.id;
              return (
                <li key={style.id}>
                  <button
                    type="button"
                    className={`eup-preset is-compact ${on ? "is-on" : ""}`}
                    aria-pressed={on}
                    disabled={!ready}
                    onClick={() => onGenerate(style.id)}
                    title={on ? `Generate another ${style.label} outfit` : `Generate a ${style.label} outfit`}
                  >
                    <span className="eup-preset-label">{style.label}</span>
                    {generating === style.id ? (
                      <Loader2 className="eup-spin eup-gen-icon" aria-hidden="true" />
                    ) : on ? (
                      <Shuffle className="eup-gen-icon" aria-hidden="true" />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {active ? (
        <p className="eup-gen-result" aria-live="polite">
          <span className="eup-gen-name">{generated.name}</span>
          {generated.extras?.length ? <span className="eup-gen-extras">{generated.extras.join(", ")}</span> : null}
          {active.note ? <span className="eup-gen-extras">{active.note}</span> : null}
        </p>
      ) : null}
      <p className="lv-slot-note">
        {note || "Game clothing for the slots under yours. Every top keeps the arms and undershirt the game pairs with it. Press the style again for another. Your clothing still wins where it has a slot."}
      </p>
    </section>
  );
}

// The prop anchors freemode peds have game props for.
const GAME_PROP_IDS = Object.freeze(["p_head", "p_eyes", "p_ears", "p_lwrist", "p_rwrist"]);

// "mpgunrunning" -> "Gunrunning"; the ped's own folder is the base game.
// A loaded server pack keeps its own name.
function packLabel(pack, server = false) {
  if (server) return pack;
  if (!pack) return "Base game";
  const name = pack.replace(/^mp(?=[a-z])/, "").replace(/_/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function SlotState({ slotState, name }) {
  const status = slotState?.status;
  if (status === "loading") {
    return (
      <span className="eup-body-state">
        <Loader2 className="eup-spin" aria-hidden="true" />
        <span className="sr-only">Loading {name}</span>
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="eup-body-state" title={slotState.error}>
        <AlertTriangle className="eup-error-icon" aria-hidden="true" />
        <span className="sr-only">{name} didn't load: {slotState.error}</span>
      </span>
    );
  }
  return null;
}

function BaseSlot({ component, gender, override, slotState, replacedByEup, gameIndex, onChangeIndex, onChangeVariant, onToggleEnabled }) {
  // Game props start off; component slots start on.
  const prop = isPropComponent(component);
  const defaultIndex = prop ? 0 : DEFAULT_BASE_OUTFIT[gender]?.[component] ?? 0;
  const value = Number.isInteger(override?.index) ? override.index : defaultIndex;
  const enabled = prop ? override?.enabled === true : override?.enabled ?? true;
  const variant = /^[a-z]$/.test(override?.variant || "") ? override.variant : "a";
  const name = componentDisplayName(component);
  const numbers = gameIndex?.numbers || [];
  const source = gameIndex ? resolveDrawableNumber(gameIndex.ranges, value) : null;
  const known = !gameIndex || gameIndex.variants.has(value);
  const variants = gameIndex?.variants.get(value) || [];

  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = Number.parseInt(draft, 10);
    if (Number.isInteger(next) && next >= 0 && next !== value) onChangeIndex(component, next);
    else setDraft(String(value));
  };
  const step = (direction) => onChangeIndex(component, stepGameDrawable(numbers, value, direction));

  return (
    <li className={`eup-body ${enabled ? "" : "is-off"} ${replacedByEup ? "is-replaced" : ""}`}>
      <div className="eup-body-head">
        <span className="eup-body-name">
          {name}
          <span className="eup-code">{component}</span>
        </span>
        <SlotState slotState={slotState} name={name} />
        <button
          type="button"
          className={`cx-icon-btn ${enabled ? "" : "is-on"}`}
          aria-pressed={!enabled}
          aria-label={prop
            ? enabled ? `Take off the game ${name.toLowerCase()}` : `Wear a game ${name.toLowerCase()}`
            : enabled ? `Remove the base ${name.toLowerCase()}` : `Restore the base ${name.toLowerCase()}`}
          title={prop ? (enabled ? "Take off" : "Wear a game prop") : enabled ? "Remove this slot" : "Restore this slot"}
          onClick={() => onToggleEnabled(component, !enabled)}
        >
          {enabled ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
        </button>
      </div>

      {replacedByEup ? (
        <p className="eup-body-note">Replaced by your clothing.</p>
      ) : !enabled ? (
        <p className="eup-body-note">{prop ? "None. Show it to wear a game prop." : "Removed. Restore it to pick a drawable."}</p>
      ) : (
        <>
          <div className="eup-body-pick">
            <button
              type="button"
              className="cx-icon-btn"
              onClick={() => step(-1)}
              disabled={numbers.length === 0}
              aria-label={`Previous ${name.toLowerCase()}`}
              title="Previous"
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <input
              className="eup-body-number"
              inputMode="numeric"
              value={draft}
              aria-label={`${name} drawable number`}
              onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                  event.preventDefault();
                  step(event.key === "ArrowUp" ? 1 : -1);
                }
                if (event.key === "Escape") {
                  setDraft(String(value));
                  event.currentTarget.blur();
                }
              }}
            />
            <button
              type="button"
              className="cx-icon-btn"
              onClick={() => step(1)}
              disabled={numbers.length === 0}
              aria-label={`Next ${name.toLowerCase()}`}
              title="Next"
            >
              <ChevronRight aria-hidden="true" />
            </button>
            {gameIndex ? (
              <span
                className={`eup-body-meta ${known ? "" : "is-missing"}`}
                title={source?.server ? `Loaded pack ${source.pack}` : source?.folder || undefined}
              >
                <span className="eup-body-pack">{known && source ? packLabel(source.pack, source.server) : "Not in the game"}</span>
                <span className="eup-body-count">of {gameIndex.total}</span>
              </span>
            ) : null}
          </div>
          {variants.length > 1 ? (
            <div className="eup-variants" role="radiogroup" aria-label={`${name} texture`}>
              <span className="cx-label">Texture</span>
              {variants.map((letter) => (
                <button
                  key={letter}
                  type="button"
                  role="radio"
                  aria-checked={variant === letter}
                  className={`eup-chip is-variant ${variant === letter ? "is-selected" : ""}`}
                  onClick={() => onChangeVariant(component, letter)}
                >
                  {letter}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </li>
  );
}

function ColourRow({ id, label, value, onChange }) {
  const preset = HAIR_COLORS.find((item) => item.color === value);
  return (
    <div className="lv-field">
      <span className="eup-field-head">
        <span className="cx-label" id={id}>{label}</span>
        <span className="eup-field-value">{preset ? preset.label : value.toUpperCase()}</span>
      </span>
      <div className="eup-hair-swatches" role="radiogroup" aria-labelledby={id}>
        {HAIR_COLORS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={value === item.color}
            aria-label={item.label}
            title={item.label}
            className={`eup-tone eup-hair-swatch ${value === item.color ? "is-on" : ""}`}
            style={{ "--chip": item.color }}
            onClick={() => onChange(item.color)}
          />
        ))}
        <label className={`eup-tone eup-hair-swatch eup-hair-custom ${preset ? "" : "is-on"}`} style={{ "--chip": value }} title="Custom colour">
          <input type="color" value={value} onChange={(event) => onChange(event.target.value)} aria-label={`Custom ${label.toLowerCase()}`} />
        </label>
      </div>
    </div>
  );
}

/** The game ped under the clothing: hair colour, then one game drawable per component. */
function EupBasePanel({
  gender,
  presets,
  activePresetId,
  onApplyPreset,
  generated,
  generating,
  generatorReady,
  generatorNote,
  onGenerate,
  baseOverrides,
  slotStates,
  selections,
  gameIndexes,
  hair,
  onHairChange,
  onChangeIndex,
  onChangeVariant,
  onToggleEnabled,
}) {
  const serverPacks = Object.values(gameIndexes || {}).some((index) => index.total > index.gameTotal);
  return (
    <>
      <section className="lv-group">
        <h3 className="lv-group-title">Body presets</h3>
        <ul className="eup-presets" aria-label="Body presets">
          {presets.map((preset) => (
            <li key={preset.id}>
              <button
                type="button"
                className={`eup-preset ${activePresetId === preset.id ? "is-on" : ""}`}
                aria-pressed={activePresetId === preset.id}
                onClick={() => onApplyPreset(preset)}
                title={`Face ${preset.head}, hair ${preset.hair}`}
              >
                <span className="eup-preset-swatches" aria-hidden="true">
                  <span style={{ "--chip": preset.skinSwatch }} />
                  <span style={{ "--chip": preset.hairColors.color }} />
                </span>
                <span className="eup-preset-label">{preset.label}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="lv-slot-note">A face, skin tone, hairstyle and hair colour from the game. Change any of them below.</p>
      </section>
      <OutfitGenerator
        generated={generated}
        generating={generating}
        ready={generatorReady}
        note={generatorNote}
        onGenerate={onGenerate}
      />
      <section className="lv-group">
        <h3 className="lv-group-title">Hair colour</h3>
        <ColourRow id="eup-hair-color" label="Colour" value={hair.color} onChange={(color) => onHairChange({ ...hair, color })} />
        <ColourRow id="eup-hair-highlight" label="Highlight" value={hair.highlight} onChange={(highlight) => onHairChange({ ...hair, highlight })} />
      </section>
      <section className="lv-group">
        <h3 className="lv-group-title">Base body</h3>
        <p className="lv-slot-note">
          Game clothing under yours, numbered as in game. Step through with the arrows or type a number.
          {serverPacks ? " Addon packs you load come after the game's clothing, numbered in the order you added them." : ""}
        </p>
        <ul className="eup-body-list">
          {COMPONENT_IDS.map((component) => (
            <BaseSlot
              key={component}
              component={component}
              gender={gender}
              override={baseOverrides?.[component]}
              slotState={slotStates?.[component]?.source === "base" ? slotStates[component] : null}
              replacedByEup={Boolean(selections?.[component])}
              gameIndex={gameIndexes?.[component] || null}
              onChangeIndex={onChangeIndex}
              onChangeVariant={onChangeVariant}
              onToggleEnabled={onToggleEnabled}
            />
          ))}
        </ul>
      </section>
      <section className="lv-group">
        <h3 className="lv-group-title">Game props</h3>
        <p className="lv-slot-note">Hats, glasses and accessories from the game, off until you show one.</p>
        <ul className="eup-body-list">
          {PROP_IDS.filter((component) => (gameIndexes
            ? gameIndexes[component]?.numbers?.length > 0
            : GAME_PROP_IDS.includes(component))).map((component) => (
            <BaseSlot
              key={component}
              component={component}
              gender={gender}
              override={baseOverrides?.[component]}
              slotState={slotStates?.[component]?.source === "base" ? slotStates[component] : null}
              replacedByEup={Boolean(selections?.[component])}
              gameIndex={gameIndexes?.[component] || null}
              onChangeIndex={onChangeIndex}
              onChangeVariant={onChangeVariant}
              onToggleEnabled={onToggleEnabled}
            />
          ))}
        </ul>
      </section>
    </>
  );
}

export default memo(EupBasePanel);
