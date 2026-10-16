import { memo, useEffect, useRef } from "react";
import { AlertTriangle, Eye, EyeOff, Focus, Loader2 } from "lucide-react";
import {
  COMPONENT_IDS,
  PROP_IDS,
  componentDisplayName,
  formatBytes,
  formatIndex,
  listDrawableIndices,
  listTextureVariants,
  textureBudgetWarnings,
} from "../../lib/eup";

const TEXTURE_ROLE_LABELS = { diffuse: "Diffuse", normal: "Normal", specular: "Specular" };

function SlotStatus({ state }) {
  if (!state) return null;
  if (state.status === "loading") {
    return (
      <span className="eup-comp-state">
        <Loader2 className="eup-spin" aria-hidden="true" />
        <span className="sr-only">Loading</span>
      </span>
    );
  }
  if (state.status === "error") {
    return (
      <span className="eup-comp-state" title={state.error}>
        <AlertTriangle className="eup-error-icon" aria-hidden="true" />
        <span className="sr-only">Didn't load: {state.error}</span>
      </span>
    );
  }
  return null;
}

function formatCount(value) {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : "0";
}

function describeTexture(info) {
  if (!info || !Number.isFinite(info.width)) return info?.name || "";
  const mips = Number.isFinite(info.mipMapCount) ? `${info.mipMapCount} mip${info.mipMapCount === 1 ? "" : "s"}` : "";
  return [`${info.width}×${info.height}`, info.fmt, mips].filter(Boolean).join(" · ");
}

// Measured facts for the loaded slot: what the game will stream, not a guess.
function SlotInspector({ state, fileSizes }) {
  const info = state?.info;
  if (!info) return null;
  const { stats, textureInfo = {}, textureNames = [] } = info;
  const roles = Object.keys(TEXTURE_ROLE_LABELS).filter((role) => textureInfo[role]);
  const yddSize = fileSizes?.get(info.drawablePath);
  const ytdSize = info.ytdPath ? fileSizes?.get(info.ytdPath) : null;
  const warnings = roles.flatMap((role) =>
    textureBudgetWarnings(textureInfo[role]).map((text) => `${TEXTURE_ROLE_LABELS[role]}: ${text}`),
  );
  const unused = textureNames.length - roles.length;

  return (
    <div className="eup-inspect">
      <dl className="eup-facts">
        <dt className="cx-label">Geometry</dt>
        <dd>
          {formatCount(stats?.triangles)} tris · {formatCount(stats?.vertices)} verts · {stats?.meshes || 0} mesh
          {stats?.meshes === 1 ? "" : "es"}
        </dd>
        {roles.map((role) => (
          <FragmentRow key={role} label={TEXTURE_ROLE_LABELS[role]} value={describeTexture(textureInfo[role])} title={textureInfo[role].name} />
        ))}
        {roles.length === 0 && <FragmentRow label="Textures" value={info.ytdPath ? "none decoded" : "no .ytd"} />}
        {unused > 0 && <FragmentRow label="Unbound" value={`${unused} more in dictionary`} title={textureNames.join("\n")} />}
        {(Number.isFinite(yddSize) || Number.isFinite(ytdSize)) && (
          <FragmentRow
            label="Files"
            value={[
              Number.isFinite(yddSize) ? `ydd ${formatBytes(yddSize)}` : null,
              Number.isFinite(ytdSize) ? `ytd ${formatBytes(ytdSize)}` : null,
            ].filter(Boolean).join(" · ")}
          />
        )}
      </dl>
      {warnings.length > 0 && (
        <ul className="eup-warnings">
          {warnings.map((text) => (
            <li key={text} className="lv-slot-note is-warn">
              <span className="lv-dot" aria-hidden="true" />
              {text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FragmentRow({ label, value, title }) {
  return (
    <>
      <dt className="cx-label">{label}</dt>
      <dd title={title}>{value}</dd>
    </>
  );
}

function ComponentSection({
  entry,
  selection,
  pieceName,
  slotState,
  fileSizes,
  focused,
  hidden,
  soloed,
  onFocus,
  onSelectDrawable,
  onSelectVariant,
  onToggleHidden,
  onToggleSolo,
}) {
  const sectionRef = useRef(null);
  const indices = listDrawableIndices(entry);
  const selectedIndex = Number.isInteger(selection?.index) ? selection.index : null;
  const selectedEntry = selectedIndex !== null ? entry.drawables[selectedIndex] : null;
  const variants = selectedEntry ? listTextureVariants(selectedEntry) : [];
  const activeVariant = variants.includes(selection?.variant) ? selection.variant : variants[0] || null;
  const name = componentDisplayName(entry.component);

  useEffect(() => {
    if (focused) sectionRef.current?.scrollIntoView({ block: "nearest" });
  }, [focused, selectedIndex, activeVariant]);

  return (
    <section
      ref={sectionRef}
      className={`eup-comp ${focused ? "is-focused" : ""}`}
      aria-label={name}
      onFocusCapture={() => onFocus(entry.component)}
      onPointerDown={() => onFocus(entry.component)}
    >
      <header className="eup-comp-head">
        <h3 className="eup-comp-name">
          {name}
          <span className="eup-code">{entry.component}</span>
        </h3>
        <SlotStatus state={slotState} />
        <span className="eup-comp-count" title={`${indices.length} drawables`}>{indices.length}</span>
        <span className="eup-comp-actions">
          <button
            type="button"
            className={`cx-icon-btn ${soloed ? "is-on" : ""}`}
            aria-pressed={soloed}
            aria-label={soloed ? `Show every slot` : `Solo ${name}`}
            title={soloed ? "Show every slot (S)" : "Show only this slot (S)"}
            onClick={() => onToggleSolo(entry.component)}
          >
            <Focus aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`cx-icon-btn ${hidden ? "is-on" : ""}`}
            aria-pressed={hidden}
            aria-label={hidden ? `Show ${name}` : `Hide ${name}`}
            title={hidden ? "Show slot (H)" : "Hide slot (H)"}
            onClick={() => onToggleHidden(entry.component)}
          >
            {hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </button>
        </span>
      </header>
      {pieceName ? (
        <p className="eup-comp-note">Wearing addon piece <b title={pieceName}>{pieceName}</b>. Pick a drawable to wear it instead.</p>
      ) : null}
      <div className="eup-chips" role="group" aria-label={`${name} drawables`}>
        {indices.map((index) => {
          const drawable = entry.drawables[index];
          const missingDrawable = !drawable.drawablePath;
          const isSelected = selectedIndex === index;
          const title = missingDrawable
            ? `${formatIndex(index)}: texture without a drawable`
            : drawable.drawableName;
          return (
            <button
              key={index}
              type="button"
              className={`eup-chip ${isSelected ? "is-selected" : ""} ${missingDrawable ? "is-missing" : ""}`}
              aria-pressed={isSelected}
              disabled={missingDrawable}
              title={title}
              onClick={() => onSelectDrawable(entry.component, isSelected ? null : index)}
            >
              {formatIndex(index)}
            </button>
          );
        })}
      </div>
      {selectedEntry && (
        <div className="eup-variants" role="group" aria-label={`${name} texture variants`}>
          <span className="cx-label">Texture</span>
          {variants.length === 0 && <span className="eup-variants-empty">No textures found</span>}
          {variants.map((variant) => (
            <button
              key={variant}
              type="button"
              className={`eup-chip is-variant ${activeVariant === variant ? "is-selected" : ""}`}
              aria-pressed={activeVariant === variant}
              onClick={() => onSelectVariant(entry.component, variant)}
            >
              {variant}
            </button>
          ))}
        </div>
      )}
      {selectedEntry && slotState?.status === "ready" && <SlotInspector state={slotState} fileSizes={fileSizes} />}
    </section>
  );
}

function EupComponentList({
  pedAssets,
  selections,
  pieceSlots,
  slotStates,
  fileSizes,
  focusComponent,
  hiddenSlots,
  soloComponent,
  onFocusComponent,
  onSelectDrawable,
  onSelectVariant,
  onToggleHidden,
  onToggleSolo,
  emptyMessage,
}) {
  const components = COMPONENT_IDS.map((id) => pedAssets?.components?.[id]).filter(Boolean);
  const extraComponents = Object.values(pedAssets?.components || {}).filter(
    (entry) => !COMPONENT_IDS.includes(entry.component),
  );
  const props = PROP_IDS.map((id) => pedAssets?.props?.[id]).filter(Boolean);
  const extraProps = Object.values(pedAssets?.props || {}).filter(
    (entry) => !PROP_IDS.includes(entry.component),
  );
  const sections = [...components, ...extraComponents, ...props, ...extraProps];

  if (sections.length === 0) {
    return (
      <div className="eup-empty">
        <p className="eup-empty-title">No clothing for this ped</p>
        <p className="eup-empty-desc">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="eup-comp-list">
      {sections.map((entry) => (
        <ComponentSection
          key={entry.component}
          entry={entry}
          selection={selections?.[entry.component]}
          pieceName={pieceSlots?.[entry.component] || ""}
          slotState={slotStates?.[entry.component]?.source === "eup" ? slotStates[entry.component] : null}
          fileSizes={fileSizes}
          focused={focusComponent === entry.component}
          hidden={Boolean(hiddenSlots?.[entry.component])}
          soloed={soloComponent === entry.component}
          onFocus={onFocusComponent}
          onSelectDrawable={onSelectDrawable}
          onSelectVariant={onSelectVariant}
          onToggleHidden={onToggleHidden}
          onToggleSolo={onToggleSolo}
        />
      ))}
    </div>
  );
}

export default memo(EupComponentList);
