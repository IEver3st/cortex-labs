import { ArrowDown, ArrowUp, FolderOpen, FolderPlus } from "lucide-react";
import { Toggle } from "../ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Slider } from "../workspace/parts";
import { COMPONENT_IDS, PED_FOR_GENDER, PROP_IDS, componentDisplayName, formatIndex } from "../../lib/eup";
import { checkPackName, fileNameOf, movedInOrder, slotOrderKey, withItemEdits, withoutItemProperties } from "../../lib/clothing-pack.js";
import {
  FEET_SLOT,
  GAME_HAIR_SQUASH,
  HAIR_SLOT,
  HAIR_SQUASH_INDEX,
  HAT_ANCHOR,
  HAT_FLATTEN_INDEX,
  HEEL_INDEX,
  HELMET_FLAGS,
  ITEM_FLAGS,
  RENDER_MODES,
  hairSquash,
  hasFlag,
  hatFlatten,
  heelHeight,
  otherFlags,
  soundChoices,
  withExpression,
  withFlag,
} from "../../lib/clothing-properties.js";
import "./EupPackPanel.css";

const TONES = { confirm: "is-live", caution: "is-warn", destructive: "is-error" };
const OPAQUE = "opaque";

const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const slotName = (item) => componentDisplayName(item.isProp ? PROP_IDS[item.slotId] : COMPONENT_IDS[item.slotId]);
const slotCode = (item) => (item.isProp ? PROP_IDS[item.slotId] : COMPONENT_IDS[item.slotId]);
const shortName = (label) => fileNameOf(label).replace(/\.[^.]+$/, "").split("^").pop();
const percent = (value) => `${Math.round(value * 100)}%`;

function slotGroups(plan, ped) {
  const groups = new Map();
  const add = (item, included) => {
    const key = slotOrderKey(item);
    if (!groups.has(key)) groups.set(key, { key, sample: item, included: [], left: [] });
    groups.get(key)[included ? "included" : "left"].push(item);
  };
  for (const item of plan.items) if (item.ped === ped) add(item, true);
  for (const item of plan.left) if (item.ped === ped) add(item, false);
  return [...groups.values()].sort((a, b) => Number(a.sample.isProp) - Number(b.sample.isProp) || a.sample.slotId - b.sample.slotId);
}

function SlotList({ group, selectedKeys, onSelect, onMove }) {
  const keys = group.included.map((item) => item.key);
  const firstDlc = group.included[0]?.dlc;
  return (
    <div className="eup-pack-slot">
      <h4 className="eup-pack-slot-name">
        {slotName(group.sample)}
        <span className="eup-code">{slotCode(group.sample)}</span>
        <span className="eup-pack-slot-count">{group.included.length}</span>
      </h4>
      <ul className="eup-pack-rows" role="listbox" aria-multiselectable="true" aria-label={`${slotName(group.sample)} items`}>
        {[...group.included, ...group.left].map((item, position) => {
          const included = position < group.included.length;
          const selected = selectedKeys.includes(item.key);
          const meta = [
            item.source,
            included ? plural(item.textures.length, "texture") : "left out",
            item.merged?.length ? `+${item.merged.length} merged` : "",
            included && item.dlc !== firstDlc ? `in ${item.dlc}` : "",
          ].filter(Boolean).join(" · ");
          return (
            <li
              key={item.key}
              role="option"
              aria-selected={selected}
              tabIndex={0}
              className={`eup-pack-row ${selected ? "is-selected" : ""} ${included ? "" : "is-out"}`}
              title={item.sourceDrawable}
              onClick={(event) => onSelect(item, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey })}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(item, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey });
                } else if (included && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                  event.preventDefault();
                  onMove(group.key, keys, item.key, event.key === "ArrowUp" ? -1 : 1);
                }
              }}
            >
              <span className="eup-pack-num">{included ? formatIndex(item.index) : "—"}</span>
              <span className="eup-pack-text">
                <span className="eup-pack-name">{shortName(item.label)}</span>
                <span className="eup-pack-meta">{meta}</span>
              </span>
              {included ? (
                <span className="eup-pack-acts">
                  <button type="button" className="cx-icon-btn" disabled={position === 0} aria-label={`Move ${shortName(item.label)} up`} title="Move up (Alt+↑)"
                    onClick={(event) => { event.stopPropagation(); onMove(group.key, keys, item.key, -1); }}>
                    <ArrowUp aria-hidden="true" />
                  </button>
                  <button type="button" className="cx-icon-btn" disabled={position === group.included.length - 1} aria-label={`Move ${shortName(item.label)} down`} title="Move down (Alt+↓)"
                    onClick={(event) => { event.stopPropagation(); onMove(group.key, keys, item.key, 1); }}>
                    <ArrowDown aria-hidden="true" />
                  </button>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FlagChips({ label, flags, list, onToggle }) {
  return (
    <div className="lv-field">
      <span className="cx-label">{label}</span>
      <div className="lv-chips" role="group" aria-label={label}>
        {list.map((flag) => {
          const on = hasFlag(flags, flag.bit);
          return (
            <button key={flag.bit} type="button" className={`lv-chip-btn eup-pack-chip ${on ? "is-on" : ""}`} aria-pressed={on} title={flag.game}
              onClick={() => onToggle(flag.bit, !on)}>
              {flag.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ItemProperties({ items, values, edits, hatWorn, onEdit, onEditEach, onReset }) {
  const first = items[0];
  const { properties } = values.get(first.key);
  const { isProp, slotId } = first;
  const count = items.length;
  const out = items.every((item) => edits[item.key]?.out);
  const edited = items.some((item) => Object.keys(edits[item.key] || {}).some((field) => field !== "out"));
  const mixed = (read) => count > 1 && items.some((item) => read(values.get(item.key).properties) !== read(properties));
  const sounds = isProp ? null : soundChoices(slotId, properties.audioId);
  const flagList = isProp && slotId === HAT_ANCHOR ? [...ITEM_FLAGS, ...HELMET_FLAGS] : ITEM_FLAGS;
  const extra = otherFlags(properties.flags, flagList);
  const included = values.get(first.key).item.drawable;
  const setExpression = (index, value) => onEditEach((own) => ({ expressionMods: withExpression(own.expressionMods, index, value) }));
  const facts = [
    ["From", first.source],
    ["File", fileNameOf(first.sourceDrawable)],
    included ? ["Builds as", fileNameOf(first.drawable)] : null,
    included ? ["Textures", String(first.textures.length)] : null,
    isProp ? null : ["Skin tone", first.suffix === "r" ? "Race textures (_r)" : "One for all (_u)"],
    included && !isProp ? ["First person", first.alternates ? plural(first.alternates, "model") : "None"] : null,
    included && !isProp ? ["Cloth physics", first.cloth ? "Yes (.yld)" : "None"] : null,
  ].filter(Boolean);

  return (
    <section className="lv-group eup-pack-item" aria-label="Item properties">
      <div className="lv-group-head">
        <h3 className="lv-group-title">{count > 1 ? `${count} items` : `${slotName(first)} ${included ? formatIndex(first.index) : ""}`.trim()}</h3>
        <button type="button" className="lv-link" disabled={!edited} onClick={onReset} title="Go back to the values from the item's own pack">
          Reset
        </button>
      </div>
      {count === 1 ? (
        <dl className="eup-facts">
          {facts.map(([label, value]) => (
            <div key={label} className="eup-pack-fact">
              <dt className="cx-label">{label}</dt>
              <dd title={value}>{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="lv-slot-note">Changes apply to every selected item.</p>
      )}
      <div className="lv-toggle-row">
        <span>In the pack</span>
        <Toggle checked={!out} onChange={(on) => onEdit({ out: on ? null : true })} ariaLabel={count > 1 ? "Keep the selected items in the pack" : "Keep this item in the pack"} />
      </div>

      {sounds ? (
        <div className="lv-field">
          <span className="cx-label" id="eup-pack-sound">{slotId === FEET_SLOT ? "Footsteps" : "Sound"}</span>
          <Select value={properties.audioId || "none"} onValueChange={(audioId) => onEdit({ audioId })}>
            <SelectTrigger className="lv-select" aria-labelledby="eup-pack-sound">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="lv-select-content">
              {sounds.map(([id, label]) => <SelectItem key={id} value={id}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {!isProp && slotId === HAIR_SLOT ? (
        <div className="eup-pack-control">
          <Slider id="eup-pack-squash" label={mixed((value) => hairSquash(value.expressionMods)) ? "Squash under hats (mixed)" : "Squash under hats"}
            value={hairSquash(properties.expressionMods)} min={0} max={0.4} step={0.005} format={(value) => value.toFixed(3)}
            onChange={(value) => setExpression(HAIR_SQUASH_INDEX, value)} />
          <p className="lv-slot-note">
            {`The game's own hairstyles use about ${GAME_HAIR_SQUASH}. It needs hair rigged to the game's hair bones (MH_Hair_Scale or MH_Hair_Crown).${hatWorn ? "" : " Wear a hat to see it."}`}
          </p>
        </div>
      ) : null}

      {!isProp && slotId === FEET_SLOT ? (
        <div className="eup-pack-control">
          <Slider id="eup-pack-heel" label={mixed((value) => heelHeight(value.expressionMods)) ? "Heel height (mixed)" : "Heel height"}
            value={heelHeight(properties.expressionMods)} min={0} max={1} step={0.05} format={percent}
            onChange={(value) => setExpression(HEEL_INDEX, value)} />
          <p className="lv-slot-note">
            <span>The game's heels use 100%. The ped stands taller in game; the preview does not show the lift.</span>
            {heelHeight(properties.expressionMods) > 0 && properties.audioId !== "shoe_heels" ? (
              <button type="button" className="lv-link eup-note-action" onClick={() => onEdit({ audioId: "shoe_heels" })}>Use heel footsteps</button>
            ) : null}
          </p>
        </div>
      ) : null}

      {isProp && slotId === HAT_ANCHOR ? (
        <div className="eup-pack-control">
          <Slider id="eup-pack-flatten" label={mixed((value) => hatFlatten(value.expressionMods)) ? "Flatten hair (mixed)" : "Flatten hair"}
            value={hatFlatten(properties.expressionMods)} min={0} max={1} step={0.05} format={percent}
            onChange={(value) => setExpression(HAT_FLATTEN_INDEX, -value)} />
          <p className="lv-slot-note">
            {`The game's own hats use 50%. At 0% the hair stays as it is and may show through the hat.${hatWorn ? "" : " Wear this hat to see it."}`}
          </p>
        </div>
      ) : null}

      {isProp ? (
        <div className="lv-field">
          <span className="cx-label" id="eup-pack-render">Transparency</span>
          <Select value={properties.renderFlags || OPAQUE} onValueChange={(mode) => onEdit({ renderFlags: mode === OPAQUE ? "" : mode })}>
            <SelectTrigger className="lv-select" aria-labelledby="eup-pack-render">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="lv-select-content">
              {RENDER_MODES.map(([mode, label]) => <SelectItem key={mode || OPAQUE} value={mode || OPAQUE}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <FlagChips label={mixed((value) => value.flags) ? "Game flags (mixed)" : "Game flags"} flags={properties.flags} list={flagList}
        onToggle={(bit, on) => onEditEach((own) => ({ flags: withFlag(own.flags, bit, on) }))} />
      {extra ? <p className="lv-slot-note">{`Other flag bits stay as the pack set them (0x${extra.toString(16)}).`}</p> : null}
    </section>
  );
}

export default function EupPackPanel({
  isTauriRuntime,
  gender,
  project,
  onProjectChange,
  pack,
  selectedKeys,
  onSelectItem,
  onShowGender,
  onAddFolder,
  onPickParent,
  hatWorn,
  note,
}) {
  const ped = PED_FOR_GENDER[gender];
  const otherGender = gender === "female" ? "male" : "female";
  const { plan, sources, values } = pack;
  const groups = slotGroups(plan, ped);
  const otherCount = [...plan.items, ...plan.left].filter((item) => item.ped === PED_FOR_GENDER[otherGender]).length;
  const pedCount = groups.reduce((sum, group) => sum + group.included.length, 0);
  const selected = selectedKeys.map((key) => values.get(key)?.item).filter(Boolean);
  const nameError = project.name ? checkPackName(project.name).error : "";
  const update = (patch) => onProjectChange((current) => ({ ...current, ...(typeof patch === "function" ? patch(current) : patch) }));
  const onMove = (slotKey, keys, key, delta) => update((current) => ({ order: movedInOrder(current.order, slotKey, keys, key, delta) }));

  if (!isTauriRuntime) {
    return (
      <div className="eup-empty">
        <p className="eup-empty-title">Building a pack needs the desktop app</p>
        <p className="eup-empty-desc">The browser can't read clothing folders or write the new resource.</p>
      </div>
    );
  }

  return (
    <>
      <section className="lv-group">
        <div className="lv-group-head">
          <h3 className="lv-group-title">New pack</h3>
        </div>
        <div className="lv-field">
          <label className="cx-label" htmlFor="eup-pack-name">Name</label>
          <input id="eup-pack-name" className={`lv-text-input is-mono ${nameError ? "is-invalid" : ""}`} value={project.name} spellCheck={false} placeholder="my_uniforms"
            maxLength={32} onChange={(event) => update({ name: event.target.value.trim().toLowerCase() })} aria-invalid={Boolean(nameError)} />
          {nameError ? <p className="lv-slot-note is-warn"><span className="lv-dot" aria-hidden="true" />{nameError}</p> : null}
        </div>
        <div className="lv-field">
          <span className="cx-label">Build in</span>
          <div className="eup-pack-parent">
            <span className="eup-pack-path" title={project.parent}>{project.parent || "No folder picked"}</span>
            <button type="button" className="cx-btn is-quiet" onClick={onPickParent}>
              <FolderOpen aria-hidden="true" />
              {project.parent ? "Change…" : "Pick…"}
            </button>
          </div>
        </div>
        <div className="lv-toggle-row">
          <span title="Items whose model file is byte for byte the same become one item with all their textures">Merge identical models</span>
          <Toggle checked={project.merge} onChange={(merge) => update({ merge })} ariaLabel="Merge identical models" />
        </div>
      </section>

      <section className="lv-group">
        <div className="lv-group-head">
          <h3 className="lv-group-title">{`${gender === "female" ? "Female" : "Male"} items`}</h3>
          <span className="eup-pack-total">{plural(pedCount, "item")}</span>
        </div>
        {note ? <p className="lv-slot-note">{note}</p> : null}
        {!sources.length ? (
          <div className="eup-empty">
            <p className="eup-empty-title">No clothing yet</p>
            <p className="eup-empty-desc">Add the folders to build from. They are only read.</p>
            <button type="button" className="cx-btn" onClick={onAddFolder}>
              <FolderPlus aria-hidden="true" />
              Add a folder…
            </button>
          </div>
        ) : pack.reading && !groups.length ? (
          <p className="lv-slot-note is-busy"><span>Reading the clothing…</span></p>
        ) : groups.length ? (
          groups.map((group) => <SlotList key={group.key} group={group} selectedKeys={selectedKeys} onSelect={onSelectItem} onMove={onMove} />)
        ) : (
          <p className="lv-slot-note">{`No ${gender} clothing in these folders.`}</p>
        )}
        {otherCount ? (
          <p className="lv-slot-note">
            <span>{`${plural(otherCount, `${otherGender} item`)} ${otherCount === 1 ? "is" : "are"} in the pack too.`}</span>
            <button type="button" className="lv-link eup-note-action" onClick={() => onShowGender(otherGender)}>{`Show ${otherGender}`}</button>
          </p>
        ) : null}
        {sources.length ? (
          <button type="button" className="lv-link eup-pack-add" onClick={onAddFolder}>
            <FolderPlus aria-hidden="true" />
            Add another folder
          </button>
        ) : null}
      </section>

      {selected.length ? (
        <ItemProperties
          items={selected}
          values={values}
          edits={project.edits}
          hatWorn={hatWorn}
          onEdit={(patch) => update((current) => ({ edits: withItemEdits(current.edits, selectedKeys, patch) }))}
          onEditEach={(patchFor) => update((current) => ({
            edits: selectedKeys.reduce((edits, key) => {
              const entry = values.get(key);
              return entry ? withItemEdits(edits, [key], patchFor(entry.properties)) : edits;
            }, current.edits),
          }))}
          onReset={() => update((current) => ({ edits: withoutItemProperties(current.edits, selectedKeys) }))}
        />
      ) : groups.length ? (
        <p className="lv-slot-note">Select an item to wear it and set its sound, flags, hair and heel values. Ctrl-click selects several.</p>
      ) : null}

      {pack.checks.length ? (
        <section className="lv-group" aria-label="Checks">
          <h3 className="lv-group-title">Checks</h3>
          <ul className="eup-pack-checks">
            {pack.checks.map((check) => (
              <li key={check.text} className={`lv-slot-note ${TONES[check.tone] || ""}`}>
                <span className="lv-dot" aria-hidden="true" />
                <span>{check.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

export function EupPackFooter({ isTauriRuntime, project, pack, onOpenFolder }) {
  const { plan, run } = pack;
  const busy = run.phase === "building";
  const reason = !isTauriRuntime ? "Building a pack needs the desktop app."
    : !pack.sources.length ? "Add clothing to build from."
      : pack.reading ? "Reading the clothing…"
        : pack.comparing ? "Comparing files for merging…"
          : pack.unreadable ? "A pack's .ymt couldn't be read. See Checks."
            : plan.blocked || (!project.parent ? "Pick where to build the pack." : "");
  const summary = plan.summary.items
    ? `${plural(plan.summary.items, "item")} · ${plural(plan.summary.textures, "texture")}${plan.creatures.length ? " · creature metadata" : ""}`
    : "";
  return (
    <div className="eup-pack-foot">
      {busy && run.progress?.total ? (
        <div className="lv-progress" aria-hidden="true">
          <span style={{ width: `${Math.round((run.progress.done / run.progress.total) * 100)}%` }} />
        </div>
      ) : null}
      {run.phase === "done" ? (
        <div className="eup-pack-result" role="status">
          <p className="lv-slot-note is-live"><span className="lv-dot" aria-hidden="true" />{`Built ${fileNameOf(run.result.path)}: ${plural(run.result.items, "item")}, ${plural(run.result.textures, "texture")}`}</p>
          <p className="eup-pack-path" title={run.result.path}>{run.result.path}</p>
          <p className="lv-slot-note">{`Add ensure ${fileNameOf(run.result.path)} to your server.cfg. Keep each pack's licence with the clothing it covers.`}</p>
          <button type="button" className="cx-btn" onClick={() => onOpenFolder(run.result.path)}>
            <FolderOpen aria-hidden="true" />
            Open folder
          </button>
        </div>
      ) : run.phase === "error" ? (
        <p className="lv-slot-note is-error" role="alert"><span className="lv-dot" aria-hidden="true" />{`The pack was not built: ${run.error}.`}</p>
      ) : (
        <p className="lv-slot-note">{reason || summary}</p>
      )}
      <button type="button" className="cx-btn is-primary eup-pack-build" disabled={Boolean(reason) || busy} onClick={pack.build}
        title={reason || `Build ${project.name} in ${project.parent}`}>
        {busy ? "Building…" : run.phase === "error" ? "Try again" : "Build pack"}
      </button>
      {run.phase === "done" ? null : (
        <p className="eup-pack-rule">Only build from clothing you made or may share. Each pack's licence still applies after the build.</p>
      )}
    </div>
  );
}
