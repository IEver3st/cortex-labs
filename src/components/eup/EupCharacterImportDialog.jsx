import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { AlertTriangle, FileUp, Loader2, RefreshCw, X } from "lucide-react";
import { componentDisplayName } from "../../lib/eup";
import { planCharacterImport, readCharacterFile, readCharacterText, readKvsRecords } from "../../lib/character-import";

const FORMAT_LABELS = {
  "vmenu-enhanced": "vMenu character",
  "vmenu-enhanced-ped": "vMenu saved ped",
  "vmenu-legacy": "vMenu character",
  "vmenu-legacy-ped": "vMenu saved ped",
  "menyoo-outfit": "Menyoo outfit",
};

// LSPDFR's .ls/.bak are offered so picking one explains why it can't be read.
const CHARACTER_FILE_FILTERS = [
  { name: "Character saves", extensions: ["xml", "json", "txt", "ls", "bak"] },
];

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function sortCharacters(list) {
  return [...list].sort((a, b) => (a.resource || "").localeCompare(b.resource || "", undefined, { sensitivity: "base" })
    || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function ScanNote({ scan }) {
  if (scan.status === "loading") {
    return (
      <p className="eup-dialog-status" role="status">
        <Loader2 className="eup-spin" aria-hidden="true" />
        <span>Reading FiveM saves…</span>
      </p>
    );
  }
  if (scan.status === "error") return <p className="eup-dialog-error" role="alert">Couldn't read FiveM saves: {scan.error}</p>;
  if (scan.status !== "done") return null;
  const lines = [];
  if (scan.stores === 0) lines.push("No FiveM saves on this PC. FiveM keeps them in %AppData%\\CitizenFX\\kvs.");
  else if (scan.characters.length === 0) lines.push("No vMenu characters in FiveM's saves on this PC.");
  if (scan.locked) lines.push("FiveM is running, so characters saved since it started may be missing. Close it and refresh.");
  if (scan.otherModels > 0) lines.push(`${plural(scan.otherModels, "save")} use other ped models; EUP Studio dresses the freemode peds only.`);
  if (scan.truncated) lines.push("Only the first 2000 saves are listed.");
  return lines.map((line) => <p key={line} className="eup-dialog-note">{line}</p>);
}

function CharacterList({ characters, selectedId, onSelect, label }) {
  if (characters.length === 0) return null;
  return (
    <ul className="eup-import-list custom-scrollbar" role="radiogroup" aria-label={label}>
      {characters.map((character) => (
        <li key={character.id}>
          <button
            type="button"
            role="radio"
            aria-checked={selectedId === character.id}
            className={`eup-import-row ${selectedId === character.id ? "is-on" : ""}`}
            onClick={() => onSelect(character.id)}
          >
            <span className="eup-import-name" title={character.name}>{character.name}</span>
            <span className="eup-import-meta">
              {[character.resource, FORMAT_LABELS[character.format], character.gender].filter(Boolean).join(" · ")}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function PlanSummary({ plan }) {
  const carried = [`${plural(plan.carried, "clothing slot")}`];
  if (plan.overrides.head) carried.push("face");
  if (plan.skinTone) carried.push("skin tone");
  if (plan.hair) carried.push("hair colour");
  return (
    <div className="eup-import-plan">
      <p className="eup-dialog-note">Carries over {carried.join(", ")}.</p>
      {plan.notes.map((note) => <p key={note} className="eup-dialog-note">{note}</p>)}
      {plan.skipped.length > 0 ? (
        <div className="eup-import-skipped">
          <p className="eup-dialog-note is-warn">
            <AlertTriangle aria-hidden="true" />
            {plural(plan.skipped.length, "slot")} {plan.skipped.length === 1 ? "stays" : "stay"} on the base ped
          </p>
          <ul>
            {plan.skipped.map((item) => (
              <li key={`${item.component}-${item.reason}`}>
                <span className="eup-import-slot">{componentDisplayName(item.component)}</span> {item.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {plan.notShown.length > 0 ? (
        <p className="eup-dialog-note">Not shown in Cortex: {plan.notShown.join(", ")}.</p>
      ) : null}
    </div>
  );
}

// Lists vMenu characters from FiveM's saves on this PC or a pasted vMenu
// code, previews what carries over, and dresses the base ped on confirm.
// Nothing is written anywhere: the FiveM store is only read.
export default function EupCharacterImportDialog({ isTauriRuntime, onScan, loadContext, onWear, onClose }) {
  const [source, setSource] = useState(isTauriRuntime ? "pc" : "paste");
  const [scan, setScan] = useState({ status: "idle" });
  const [pasteText, setPasteText] = useState("");
  const [pasted, setPasted] = useState({ status: "idle", characters: [] });
  const [selectedId, setSelectedId] = useState(null);
  const [outfitIndex, setOutfitIndex] = useState(0);
  const [contexts, setContexts] = useState({});
  const scanRun = useRef(0);

  const runScan = useCallback(async () => {
    const run = scanRun.current + 1;
    scanRun.current = run;
    setScan({ status: "loading" });
    try {
      const result = await onScan();
      if (scanRun.current !== run) return;
      const read = readKvsRecords(result?.records);
      setScan({
        status: "done",
        characters: sortCharacters(read.characters),
        otherModels: read.otherModels,
        stores: result?.stores?.length || 0,
        // FiveM holds its write-ahead log open while it runs.
        locked: (result?.unreadable || []).some((item) => /\.log:/i.test(item)),
        truncated: Boolean(result?.truncated),
      });
    } catch (error) {
      if (scanRun.current === run) setScan({ status: "error", error: error?.message || String(error) });
    }
  }, [onScan]);

  useEffect(() => {
    if (isTauriRuntime) runScan();
    return () => {
      scanRun.current += 1;
    };
  }, [isTauriRuntime, runScan]);

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

  const showRead = async (reading, idPrefix) => {
    setPasted({ status: "loading", characters: [] });
    try {
      const result = await reading();
      if (!result) {
        setPasted({ status: "idle", characters: [] });
        return;
      }
      const characters = result.characters.map((character, index) => ({ ...character, id: `${idPrefix}:${index}` }));
      setPasted({ status: "done", characters, otherModels: result.otherModels });
      setSelectedId(characters[0]?.id || null);
      setOutfitIndex(characters[0]?.defaultOutfit || 0);
    } catch (error) {
      setPasted({ status: "error", characters: [], error: error?.message || String(error) });
    }
  };

  const readPasted = () => showRead(() => readCharacterText(pasteText), "paste");

  const openFile = () => showRead(async () => {
    const picked = await open({ multiple: false, filters: CHARACTER_FILE_FILTERS, title: "Open a character file" });
    if (typeof picked !== "string" || !picked) return null;
    return readCharacterFile(await readFile(picked), picked);
  }, "file");

  const characters = source === "pc" ? scan.characters || [] : pasted.characters;
  const selected = characters.find((character) => character.id === selectedId) || null;
  const select = (id) => {
    setSelectedId(id);
    setOutfitIndex(characters.find((character) => character.id === id)?.defaultOutfit || 0);
  };

  // The game listing of the character's ped, to check its drawable numbers.
  const gender = selected?.gender || null;
  const context = gender ? contexts[gender] : null;
  const requested = useRef(new Set());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!gender || requested.current.has(gender)) return;
    requested.current.add(gender);
    setContexts((prev) => ({ ...prev, [gender]: { status: "loading" } }));
    const settle = (next) => {
      if (!mounted.current) return;
      if (next.status === "error") requested.current.delete(gender);
      setContexts((prev) => ({ ...prev, [gender]: next }));
    };
    loadContext(gender).then(
      (value) => settle({ status: "ready", value }),
      (error) => settle({ status: "error", error: error?.message || String(error) }),
    );
  }, [gender, loadContext]);

  const plan = useMemo(() => {
    if (!selected || context?.status !== "ready") return null;
    return planCharacterImport(selected, outfitIndex, context.value);
  }, [selected, outfitIndex, context]);

  return (
    <div className="eup-scrim" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="eup-dialog eup-import" role="dialog" aria-modal="true" aria-labelledby="eup-import-title">
        <header className="eup-dialog-head">
          <h2 id="eup-import-title" className="cx-display eup-dialog-title">Import character</h2>
          <button type="button" className="cx-icon-btn" onClick={onClose} aria-label="Close" title="Close">
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="eup-dialog-body">
          <div className="lv-seg" role="radiogroup" aria-label="Where the character comes from">
            {[
              { id: "pc", label: "FiveM saves on this PC", disabled: !isTauriRuntime },
              { id: "paste", label: "Code or file" },
            ].map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={source === option.id}
                className={`lv-seg-btn ${source === option.id ? "is-on" : ""}`}
                disabled={option.disabled}
                title={option.disabled ? "Reading FiveM saves needs the desktop app." : undefined}
                onClick={() => {
                  setSource(option.id);
                  setSelectedId(null);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>

          {source === "pc" ? (
            <>
              <div className="eup-import-head">
                <p className="eup-dialog-note">Characters and saved peds that vMenu, and menus using its save format, keep in FiveM.</p>
                <button type="button" className="cx-icon-btn" onClick={runScan} disabled={scan.status === "loading"} aria-label="Read FiveM saves again" title="Refresh">
                  <RefreshCw aria-hidden="true" />
                </button>
              </div>
              <ScanNote scan={scan} />
            </>
          ) : (
            <>
              <label className="eup-import-paste">
                <span className="cx-label">vMenu code, JSON or Menyoo XML</span>
                <textarea
                  className="eup-import-text custom-scrollbar"
                  value={pasteText}
                  onChange={(event) => setPasteText(event.target.value)}
                  placeholder="VME1G:…"
                  spellCheck={false}
                  rows={4}
                />
              </label>
              <p className="eup-dialog-note">
                In vMenu Enhanced: Misc Settings, Import &amp; Export, Show My Transfer Code. Or open a Menyoo outfit .xml
                from menyooStuff\Outfits, which is also how LSPDFR characters come over: put one on in game and save the outfit in Menyoo.
              </p>
              <div className="eup-import-actions">
                <button type="button" className="cx-btn lv-btn-sm" onClick={readPasted} disabled={!pasteText.trim() || pasted.status === "loading"}>
                  {pasted.status === "loading" ? "Reading…" : "Read code"}
                </button>
                {isTauriRuntime ? (
                  <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={openFile} disabled={pasted.status === "loading"}>
                    <FileUp aria-hidden="true" />
                    Open a file…
                  </button>
                ) : null}
              </div>
              {pasted.status === "error" ? <p className="eup-dialog-error" role="alert">{pasted.error}</p> : null}
              {pasted.status === "done" && pasted.otherModels > 0 ? (
                <p className="eup-dialog-note">{plural(pasted.otherModels, "save")} use other ped models; EUP Studio dresses the freemode peds only.</p>
              ) : null}
            </>
          )}

          <CharacterList characters={characters} selectedId={selectedId} onSelect={select} label="Characters" />

          {selected && selected.outfits.length > 1 ? (
            <div className="lv-field">
              <span className="cx-label" id="eup-import-outfit">Outfit</span>
              <div className="lv-chips" role="radiogroup" aria-labelledby="eup-import-outfit">
                {selected.outfits.map((outfit, index) => (
                  <button
                    key={`${outfit.name}-${index}`}
                    type="button"
                    role="radio"
                    aria-checked={outfitIndex === index}
                    className={`lv-chip-btn ${outfitIndex === index ? "is-on" : ""}`}
                    onClick={() => setOutfitIndex(index)}
                  >
                    {outfit.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {selected && context?.status === "loading" ? (
            <p className="eup-dialog-status" role="status">
              <Loader2 className="eup-spin" aria-hidden="true" />
              <span>Checking the clothing against your game files…</span>
            </p>
          ) : null}
          {selected && context?.status === "error" ? (
            <p className="eup-dialog-error" role="alert">Game files unavailable: {context.error}</p>
          ) : null}
          {plan ? <PlanSummary plan={plan} /> : null}

          <p className="eup-dialog-note">Wearing a character replaces this ped's face, hair and base clothing and takes off pack clothing and addon pieces.</p>
          <footer className="eup-dialog-actions">
            <button type="button" className="settings-secondary" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="settings-primary"
              disabled={!plan}
              onClick={() => onWear(selected, plan)}
            >
              Wear character
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
