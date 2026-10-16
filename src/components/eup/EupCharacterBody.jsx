import { memo, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Eye, EyeOff } from "lucide-react";
import {
  characterAnchorLabel,
  characterComponentLabel,
  resolveCharacterSlots,
  withComponentChoice,
  withPropChoice,
} from "../../lib/ped-character";
import { SlotState } from "./EupBasePanel";

function TextureChips({ name, textures, value, onChange }) {
  if (textures.length < 2) return null;
  return (
    <div className="eup-variants" role="radiogroup" aria-label={`${name} texture`}>
      <span className="cx-label">Texture</span>
      {textures.map((texture, index) => (
        <button
          key={texture.letter}
          type="button"
          role="radio"
          aria-checked={value === index}
          className={`eup-chip is-variant ${value === index ? "is-selected" : ""}`}
          title={texture.diffuse ? texture.diffuse.name : "No texture file for this letter"}
          onClick={() => onChange(index)}
        >
          {texture.letter}
        </button>
      ))}
    </div>
  );
}

/** Previous/next and a typed number over `values` (drawable indices or prop ids). */
function NumberPick({ name, values, value, total, missing, onChange }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const position = values.indexOf(value);
  const step = (direction) => {
    if (values.length === 0) return;
    onChange(values[(Math.max(position, 0) + direction + values.length) % values.length]);
  };
  const commit = () => {
    const next = Number.parseInt(draft, 10);
    if (values.includes(next) && next !== value) onChange(next);
    else setDraft(String(value));
  };
  return (
    <div className="eup-body-pick">
      <button type="button" className="cx-icon-btn" onClick={() => step(-1)} disabled={values.length < 2} aria-label={`Previous ${name.toLowerCase()}`} title="Previous">
        <ChevronLeft aria-hidden="true" />
      </button>
      <input
        className="eup-body-number"
        inputMode="numeric"
        value={draft}
        aria-label={`${name} number`}
        onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
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
      <button type="button" className="cx-icon-btn" onClick={() => step(1)} disabled={values.length < 2} aria-label={`Next ${name.toLowerCase()}`} title="Next">
        <ChevronRight aria-hidden="true" />
      </button>
      <span className={`eup-body-meta ${missing ? "is-missing" : ""}`}>
        <span className="eup-body-pack">{missing ? "Not in the files" : "Ped files"}</span>
        <span className="eup-body-count">of {total}</span>
      </span>
    </div>
  );
}

function ComponentSlot({ component, worn, slotState, onChange }) {
  const name = characterComponentLabel(component.component);
  const drawables = component.drawables || [];
  const entry = drawables[worn.index];
  return (
    <li className="eup-body">
      <div className="eup-body-head">
        <span className="eup-body-name">
          {name}
          <span className="eup-code">{component.component}</span>
        </span>
        <SlotState slotState={slotState} name={name} />
      </div>
      <NumberPick
        name={name}
        values={drawables.map((_, index) => index)}
        value={worn.index}
        total={drawables.length}
        missing={!entry?.drawable}
        onChange={(index) => onChange({ drawable: index, texture: 0 })}
      />
      <TextureChips
        name={name}
        textures={entry?.textures || []}
        value={worn.texture}
        onChange={(texture) => onChange({ drawable: worn.index, texture })}
      />
    </li>
  );
}

function PropSlot({ anchor, worn, slotState, onChange }) {
  const name = characterAnchorLabel(anchor.anchor);
  const props = anchor.props || [];
  const prop = worn ? props.find((item) => item.index === worn.index) : null;
  return (
    <li className={`eup-body ${worn ? "" : "is-off"}`}>
      <div className="eup-body-head">
        <span className="eup-body-name">
          {name}
          <span className="eup-code">{anchor.anchor}</span>
        </span>
        {worn ? <SlotState slotState={slotState} name={name} /> : null}
        <button
          type="button"
          className={`cx-icon-btn ${worn ? "" : "is-on"}`}
          aria-pressed={!worn}
          aria-label={worn ? `Take off the ${name.toLowerCase()} prop` : `Wear a ${name.toLowerCase()} prop`}
          title={worn ? "Take off" : "Wear a prop"}
          onClick={() => onChange(worn ? null : { prop: props[0]?.index ?? 0, texture: 0 })}
        >
          {worn ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
        </button>
      </div>
      {worn ? (
        <>
          <NumberPick
            name={name}
            values={props.map((item) => item.index)}
            value={worn.index}
            total={props.length}
            missing={!prop?.drawable}
            onChange={(index) => onChange({ prop: index, texture: 0 })}
          />
          <TextureChips
            name={name}
            textures={prop?.textures || []}
            value={worn.texture}
            onChange={(texture) => onChange({ prop: worn.index, texture })}
          />
        </>
      ) : (
        <p className="eup-body-note">None. Show it to wear one of this ped&apos;s props.</p>
      )}
    </li>
  );
}

/**
 * Body tab for a game ped or the user's ped: one drawable and texture per
 * component from the ped's own variations, and its props per anchor.
 */
function EupCharacterBody({ character, variation, slotStates, onVariationChange }) {
  const description = character?.description;
  if (!description) {
    return (
      <section className="lv-group">
        <h3 className="lv-group-title">{character?.label || "Character"}</h3>
        <p className="lv-slot-note">
          {character?.error
            ? "The ped didn't load. Step 2 in the left panel says why."
            : character?.candidates?.length
              ? "Pick which ped to use in step 2 of the left panel."
              : "Reading the ped…"}
        </p>
      </section>
    );
  }
  const worn = Object.fromEntries(resolveCharacterSlots(description, variation).map((slot) => [slot.slot, slot]));
  const stateOf = (slot) => (slotStates?.[slot]?.source === "character" ? slotStates[slot] : null);
  return (
    <>
      <section className="lv-group">
        <h3 className="lv-group-title">Components</h3>
        <p className="lv-slot-note">
          {description.ped} wears one of its own drawables per slot, numbered as in its variations file.
        </p>
        <ul className="eup-body-list">
          {description.components.map((component) => (worn[component.component] ? (
            <ComponentSlot
              key={component.component}
              component={component}
              worn={worn[component.component]}
              slotState={stateOf(component.component)}
              onChange={(choice) => onVariationChange((prev) => withComponentChoice(prev, component.component, choice))}
            />
          ) : null))}
        </ul>
      </section>
      <section className="lv-group">
        <h3 className="lv-group-title">Character props</h3>
        {description.props?.length ? (
          <>
            <p className="lv-slot-note">Hats, glasses, watches and other props this ped has, on their anchor bones. Off until you show one.</p>
            <ul className="eup-body-list">
              {description.props.map((anchor) => (
                <PropSlot
                  key={anchor.anchor}
                  anchor={anchor}
                  worn={worn[anchor.anchor] || null}
                  slotState={stateOf(anchor.anchor)}
                  onChange={(choice) => onVariationChange((prev) => withPropChoice(prev, anchor.anchor, choice))}
                />
              ))}
            </ul>
          </>
        ) : (
          <p className="lv-slot-note">{description.ped} has no props in its variations file.</p>
        )}
      </section>
    </>
  );
}

export default memo(EupCharacterBody);
