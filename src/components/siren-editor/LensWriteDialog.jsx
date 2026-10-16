import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { exists, readFile, readTextFile } from "@tauri-apps/plugin-fs";
import { Check, CircleAlert } from "lucide-react";
import { ToolDialog, StatusLines } from "./SirenToolDialogs";
import { errorText, fileName } from "./useSirenTools.js";
import { requestBridgeParse } from "../../lib/model-load.js";
import {
  bridgeModelReader,
  canWriteLens,
  lensConflictGroups,
  prepareLensWrite,
  writeLensTextures,
} from "../../lib/lens-texture-write.js";

// Writes the Lens glow colours into the vehicle's own texture dictionaries,
// so the game shows them. Opens on a check that builds every new texture and
// lists what will change, including other lights that share the texels; the
// write itself backs up and replaces the files natively, all or nothing.
// Sirens that share texels but differ in colour are fixed here, which
// changes their preview tints and runs the check again. So are sirens whose
// texture would have to be copied from outside the vehicle's resource: Cortex
// does not copy those, so the fix leaves them in the texture's colour.

const HEX_RE = /^#[0-9a-f]{6}$/i;

function joinList(items) {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// Runs of three or more collapse: 3, 4, 5, 6, 27, 28 reads "3–6, 27 and 28".
function sirenRanges(sirens) {
  const sorted = [...new Set(sirens)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    if (j - i >= 2) parts.push(`${sorted[i]}–${sorted[j]}`);
    else for (let k = i; k <= j; k += 1) parts.push(String(sorted[k]));
    i = j + 1;
  }
  return parts;
}

function sirenWords(sirens, capital = false) {
  const parts = sirenRanges(sirens);
  const word = parts.length === 1 && !parts[0].includes("–") ? "siren" : "sirens";
  return `${capital ? word[0].toUpperCase() + word.slice(1) : word} ${joinList(parts)}`;
}

function alsoWords({ alsoSirens, alsoOther }) {
  const parts = [];
  if (alsoSirens.length) parts.push(sirenWords(alsoSirens));
  if (alsoOther) parts.push(`${alsoOther} other ${alsoOther === 1 ? "light" : "lights"}`);
  return parts.length ? `also changes ${parts.join(" and ")}` : "";
}

/** Siren number to "#rrggbb" from the preview tints, "siren" resolved to the siren's colour. */
export function lensWriteColours(tints, sirens) {
  const colours = {};
  for (const [key, tint] of Object.entries(tints || {})) {
    const colour = tint === "siren" ? sirens?.[Number(key) - 1]?.color : tint;
    if (HEX_RE.test(colour || "")) colours[key] = colour.toLowerCase();
  }
  return colours;
}

export function LensWriteDialog({ s, onClose }) {
  const modelPath = s.modelPath;
  const tints = s.vehicleLights?.lens;
  const colours = useMemo(
    () => lensWriteColours(tints, s.sirenEditor?.draft?.sirens),
    [tints, s.sirenEditor?.draft?.sirens],
  );
  const coloursKey = JSON.stringify(colours);
  const [check, setCheck] = useState({ status: "checking", prepared: null, error: "" });
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState([]);
  const [done, setDone] = useState(false);

  // Checks on opening and again after a conflict fix changes the colours. The
  // last result stays on screen while a recheck runs, so the list does not jump.
  useEffect(() => {
    if (done) return undefined;
    let cancelled = false;
    setCheck((current) => ({ status: "checking", prepared: current.prepared, error: "" }));
    prepareLensWrite({
      modelPath,
      colours: JSON.parse(coloursKey),
      readModel: bridgeModelReader({ parse: (path) => requestBridgeParse(invoke, path), readFile, readText: readTextFile }),
      readFile,
      exists,
      exportYtd: (path) => invoke("export_ytd", { path }),
    })
      .then((prepared) => { if (!cancelled) setCheck({ status: "ready", prepared, error: "" }); })
      .catch((error) => { if (!cancelled) setCheck({ status: "error", prepared: null, error: errorText(error) }); });
    return () => { cancelled = true; };
  }, [coloursKey, done, modelPath]);

  const checking = check.status === "checking";
  const prepared = check.prepared;
  const ready = !checking && canWriteLens(prepared);
  const groups = useMemo(() => lensConflictGroups(prepared?.conflicts || [], colours, prepared?.shares), [prepared, colours]);
  const outside = prepared?.outside || [];
  const problemCount = groups.length + outside.length + (prepared?.problems?.length || 0);
  const disabledReason = done ? ""
    : checking ? (prepared ? "Checking the new colours…" : "Checking the lens textures…")
      : check.status === "error" ? "The lens textures could not be checked."
        : prepared?.blocked ? "Nothing to write."
          : !ready ? `Fix ${problemCount === 1 ? "the problem" : `the ${problemCount} problems`} above first.` : "";

  // Gives every siren in a conflict group one lens colour, or the texture's own.
  const unify = ({ sirens }, colour) => {
    const next = { ...(tints || {}) };
    for (const siren of sirens) {
      if (colour) next[siren] = colour;
      else delete next[siren];
    }
    s.updateVehicleLights({ lensTints: next });
  };

  const write = useCallback(async () => {
    if (disabledReason || busy || !prepared) return;
    setBusy(true);
    try {
      const result = await writeLensTextures({ invoke, prepared });
      const files = (result?.files || []).map((file) => String(file.path));
      const count = prepared.textures.length;
      setLines([
        { tone: "ok", text: `Wrote ${count} lens ${count === 1 ? "texture" : "textures"}; each file has a .bak beside it`, path: files.join("\n") },
      ]);
      setDone(true);
      // The textures now carry the colours, so the preview tints would only repeat them.
      s.updateVehicleLights({ lensTints: {} });
      s.reloadModel?.();
    } catch (error) {
      setLines([{ tone: "error", text: errorText(error) }]);
    } finally {
      setBusy(false);
    }
  }, [busy, disabledReason, prepared, s]);

  const files = prepared?.files || [];
  const textures = prepared?.textures || [];
  const conflicted = new Set((prepared?.conflicts || []).map((conflict) => conflict.texture));
  const sources = [...new Set(textures.map((texture) => texture.from).filter(Boolean))];
  const formats = [...new Set(textures.map((texture) => texture.converted).filter(Boolean))];
  const sharesTexels = textures.some((texture) => texture.alsoSirens.length || texture.alsoOther);
  return (
    <ToolDialog title="Write lens colours" titleId="se-lens-title" busy={busy} onClose={onClose}>
      <div className="se-dialog-body">
        <p className="se-note">
          Recolours the textures the tinted sirens&apos; lenses use, inside this vehicle&apos;s own texture dictionaries, so the game shows the new colours.
        </p>
        {check.status === "error" ? <p className="se-note is-error">{check.error}</p> : null}
        {prepared?.blocked ? <p className="se-note is-error">{prepared.blocked}</p> : null}

        {!done && problemCount ? (
          <section className="se-lens-fix" aria-labelledby="se-lens-fix-title">
            <h3 id="se-lens-fix-title" className="cx-label">Fix before writing</h3>
            {groups.map((group) => (
              <div key={group.sirens.join("-")} className="se-lens-conflict">
                <p className="se-note">
                  <strong>{sirenWords(group.sirens, true)}</strong> light the same part of {joinList(group.textures)}, so in game they glow one colour. Pick it:
                </p>
                <div className="se-lens-choices" role="group" aria-label={`Lens colour for ${sirenWords(group.sirens)}`}>
                  {group.options.map((option) => (
                    <button key={option.colour} type="button" className="cx-btn lv-btn-sm se-lens-choice" disabled={checking}
                      onClick={() => unify(group, option.colour)}
                      title={`Give ${sirenWords(group.sirens)} the colour ${sirenWords(option.sirens)} ${option.sirens.length === 1 ? "has" : "have"} now`}>
                      <span className="se-lens-swatch" style={{ background: option.colour }} aria-hidden="true" />
                      <span className="se-lens-hex">{option.colour}</span>
                      <span className="sw-meta">{sirenRanges(option.sirens).join(", ")}</span>
                    </button>
                  ))}
                  <button type="button" className="cx-btn is-quiet lv-btn-sm" disabled={checking} onClick={() => unify(group, null)}
                    title={`Leave ${sirenWords(group.sirens)} in the texture's own colour`}>
                    Texture colour
                  </button>
                </div>
              </div>
            ))}
            {outside.map((entry) => (
              <div key={`outside-${entry.texture}`} className="se-lens-conflict">
                <p className="se-note">
                  <strong>{sirenWords(entry.sirens, true)}</strong> {entry.sirens.length === 1 ? "glows" : "glow"} through {entry.texture}, {entry.reason}. Cortex only copies textures from this vehicle&apos;s own resource.
                </p>
                <div className="se-lens-choices">
                  <button type="button" className="cx-btn is-quiet lv-btn-sm" disabled={checking} onClick={() => unify(entry, null)}
                    title={`Leave ${sirenWords(entry.sirens)} in the texture's own colour`}>
                    Texture colour
                  </button>
                </div>
              </div>
            ))}
            {(prepared?.problems || []).map((problem) => <p key={problem} className="se-note is-error">{problem}</p>)}
          </section>
        ) : null}

        {textures.length && !done ? (
          <ul className="se-lens-plan" aria-label="Lens textures to write">
            {textures.map((texture) => {
              const bad = conflicted.has(texture.name);
              const also = alsoWords(texture);
              return (
                <li key={texture.name} className={bad ? "is-error" : undefined}>
                  {bad ? <CircleAlert aria-label="Colour conflict" /> : <Check aria-hidden="true" />}
                  <span className="se-lens-name" title={texture.name}>{texture.name}</span>
                  <span className="se-lens-tags">
                    {texture.from ? <span className="se-lens-tag" title={`A recoloured copy of the texture in ${texture.from}`}>copy</span> : null}
                    {texture.converted ? <span className="se-lens-tag">{texture.converted} → DXT5</span> : null}
                  </span>
                  <span className="se-lens-sirens">
                    {sirenWords(texture.sirens, true)}
                    {also ? <span className="se-lens-also">; {also}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}

        {files.length && !done ? (
          <div className="se-lens-notes">
            <p className="se-note">Writes {joinList(files.map((file) => file.name))}. Each file gets a .bak beside it first.</p>
            {sources.map((from) => (
              <p key={`from-${from}`} className="se-note">
                Textures marked copy come from {from} in this vehicle&apos;s resource, which other vehicles can share. This vehicle gets its own recoloured copies; {from} stays as it is.
              </p>
            ))}
            {formats.map((format) => (
              <p key={`format-${format}`} className="se-note">{format} textures are written as DXT5: the same size, slightly softer detail.</p>
            ))}
            {sharesTexels ? <p className="se-note is-warn">Lights listed under also changes sample the same texels, so they take the new colour too.</p> : null}
          </div>
        ) : null}
        {done ? <p className="se-note">Restart the resource in game to load the new textures. Each .bak holds the file as it was.</p> : null}
      </div>
      <footer className="se-dialog-foot is-row">
        <div className="se-dialog-foot-status">
          <StatusLines lines={lines} />
          {disabledReason ? <p className={checking ? "lv-slot-note is-busy" : "se-note"}>{disabledReason}</p> : null}
        </div>
        <div className="se-dialog-actions">
          <button type="button" className="settings-secondary" onClick={onClose} disabled={busy}>{done ? "Close" : "Cancel"}</button>
          {done ? null : (
            <button type="button" className="settings-primary" onClick={write} disabled={Boolean(disabledReason) || busy}
              title={disabledReason || `Write into ${files.map((file) => fileName(file.path)).join(", ")}`}>
              {busy ? "Writing…" : "Write"}
            </button>
          )}
        </div>
      </footer>
    </ToolDialog>
  );
}
