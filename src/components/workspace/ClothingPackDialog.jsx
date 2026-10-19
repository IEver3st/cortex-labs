import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, FolderPlus, X } from "lucide-react";
import { ToolDialog, StatusLines } from "../siren-editor/SirenToolDialogs";
import { Toggle } from "../ui/toggle";
import { checkPackName, fileNameOf, groupClothingFiles, pedLabel, planClothingPackBuild } from "../../lib/clothing-pack.js";
import { parsePedVariationXml } from "../../lib/ped-variation-xml.js";
import { clothingBuildRequest } from "../../lib/clothing-write.js";
import "../siren-editor/SirenEditor.css";
import "./LiveriesPanel.css";
import "./ClothingPackDialog.css";

/* Builds a new addon clothing resource from folders of clothing the user
   picked: every item renumbered into one pack per ped (a second pack when a
   slot is full), with its own .ymt, shop meta and fxmanifest.lua. With merge
   on, items whose model files are byte for byte the same become one item with
   all their textures. The folders are only read; the host refuses the game
   install, FiveM's own files and escrowed resources, and writes the new
   resource into a folder that does not exist yet. */

const TONES = { confirm: "is-confirm", caution: "is-caution", destructive: "is-destructive" };

let nextSourceId = 0;

const errorText = (error) => String(error?.message || error || "Unknown error").replace(/\.$/, "");
const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

function sourceCounts(source) {
  const items = source.packs.reduce((sum, pack) => sum + pack.items.length, 0);
  const textures = source.packs.reduce((sum, pack) => sum + pack.items.reduce((total, item) => total + item.textures.length, 0), 0);
  return { items, textures };
}

// Paths whose bytes decide a merge: every drawable and texture file.
function comparedPaths(sources) {
  const paths = [];
  for (const source of sources) {
    for (const pack of source.packs) {
      for (const item of pack.items) {
        paths.push(item.drawable, ...item.textures.map((texture) => texture.path));
      }
    }
  }
  return paths;
}

function joinPath(folder, name) {
  const separator = folder.includes("\\") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${separator}${name}`;
}

export default function ClothingPackDialog({ onClose }) {
  const [sources, setSources] = useState([]);
  const [models, setModels] = useState({});
  const [merge, setMerge] = useState(true);
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [identical, setIdentical] = useState({ status: "idle", key: "", map: {}, error: "" });
  const [run, setRun] = useState({ phase: "ready", progress: null, lines: [] });
  const [notes, setNotes] = useState([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const busy = run.phase === "building";
  const done = run.phase === "done";
  const ready = useMemo(() => sources.filter((source) => source.status === "ready"), [sources]);
  const reading = sources.some((source) => source.status === "reading");

  const readSource = useCallback(async (id, folder) => {
    try {
      const scan = await invoke("clothing_folder", { folder });
      const files = (scan?.files || []).map((file) => ({ path: String(file.path), escrowed: Boolean(file.escrowed) }));
      const grouped = groupClothingFiles(files.filter((file) => !file.escrowed));
      const read = {};
      const failed = [];
      for (const pack of grouped.packs) {
        if (!pack.ymtPath) continue;
        try {
          const result = await invoke("read_pack_ymt", { path: pack.ymtPath });
          read[pack.ymtPath] = parsePedVariationXml(result.xml);
        } catch (error) {
          failed.push(`${fileNameOf(pack.ymtPath)} (${errorText(error)})`);
        }
      }
      if (!mounted.current) return;
      setModels((current) => ({ ...current, ...read }));
      setSources((current) => current.map((source) => (source.id !== id ? source : {
        ...source,
        status: "ready",
        packs: grouped.packs,
        escrowed: files.filter((file) => file.escrowed).length,
        unknown: grouped.unknown.length,
        stray: grouped.stray.length,
        truncated: Boolean(scan?.truncated),
        // How hats fit over hair; the new pack does not carry it.
        creature: files.filter((file) => !file.escrowed && /^mp_creaturemetadata_.*\.ymt$/i.test(fileNameOf(file.path))).length,
        failed,
      })));
    } catch (error) {
      if (!mounted.current) return;
      setSources((current) => current.map((source) => (source.id === id ? { ...source, status: "error", error: errorText(error) } : source)));
    }
  }, []);

  const addSources = async () => {
    let picked;
    try {
      picked = await open({ directory: true, recursive: true, multiple: true, title: "Folders of clothing to build from" });
    } catch (error) {
      setNotes([`The folder picker failed: ${errorText(error)}`]);
      return;
    }
    const folders = (Array.isArray(picked) ? picked : picked ? [picked] : []).map(String);
    const known = new Set(sources.map((source) => source.folder.toLowerCase()));
    const fresh = folders.filter((folder) => !known.has(folder.toLowerCase()));
    setNotes(folders.length > fresh.length ? ["A folder already in the list was left as it is."] : []);
    if (!fresh.length) return;
    const added = fresh.map((folder) => ({ id: `s${(nextSourceId += 1)}`, folder, label: fileNameOf(folder) || folder, status: "reading", packs: [] }));
    setSources((current) => [...current, ...added]);
    if (!name) {
      const suggested = checkPackName(added[0].label.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "").slice(0, 32));
      if (suggested.name) setName(suggested.name);
    }
    for (const source of added) await readSource(source.id, source.folder);
  };

  const removeSource = (id) => setSources((current) => current.filter((source) => source.id !== id));

  const pickParent = async () => {
    try {
      const picked = await open({ directory: true, title: "Folder to build the new resource in" });
      if (typeof picked === "string" && picked) setParent(picked);
    } catch (error) {
      setNotes([`The folder picker failed: ${errorText(error)}`]);
    }
  };

  // Byte comparison of every file, for merging; redone when the sources change.
  const readyKey = ready.map((source) => source.id).join(",");
  useEffect(() => {
    if (!merge || !ready.length || reading) return undefined;
    const paths = comparedPaths(ready);
    const key = `${readyKey}|${paths.length}`;
    // Only a finished comparison is kept; one cut off by a toggle starts again.
    if (identical.key === key && identical.status === "ready") return undefined;
    let cancelled = false;
    setIdentical({ status: "comparing", key, map: {}, error: "" });
    invoke("clothing_identical_files", { paths })
      .then((groups) => {
        if (cancelled) return;
        const map = {};
        (groups || []).forEach((group, index) => { if (group != null) map[paths[index]] = group; });
        setIdentical({ status: "ready", key, map, error: "" });
      })
      .catch((error) => { if (!cancelled) setIdentical({ status: "error", key, map: {}, error: errorText(error) }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merge, readyKey, reading]);

  const plan = useMemo(() => planClothingPackBuild({
    name,
    sources: ready.map((source) => ({ id: source.id, label: source.label, packs: source.packs })),
    models,
    identical: merge && identical.status === "ready" ? identical.map : {},
    merge,
  }), [identical, merge, models, name, ready]);

  const sourceChecks = ready.flatMap((source) => [
    source.escrowed ? { tone: "caution", text: `${plural(source.escrowed, "file")} in ${source.label} ${source.escrowed === 1 ? "is" : "are"} in an escrowed resource, so ${source.escrowed === 1 ? "it is" : "they are"} left out.` } : null,
    source.unknown ? { tone: "caution", text: `${plural(source.unknown, "file")} in ${source.label} ${source.unknown === 1 ? "is not" : "are not"} named as freemode clothing (or ${source.unknown === 1 ? "has" : "have"} no ped in the name or folder), so ${source.unknown === 1 ? "it is" : "they are"} left out.` } : null,
    source.stray ? { tone: "caution", text: `${plural(source.stray, "texture")} in ${source.label} ${source.stray === 1 ? "has" : "have"} no model beside ${source.stray === 1 ? "it" : "them"}, so ${source.stray === 1 ? "it is" : "they are"} left out.` } : null,
    source.creature ? { tone: "caution", text: `${source.label} has creature metadata (how its hats sit over hair). The new pack does not include it yet, so hair may show through those hats in game.` } : null,
    source.truncated ? { tone: "caution", text: `${source.label} holds more files than Cortex reads at once; only the first 20000 entries are used.` } : null,
    ...(source.failed || []).map((failure) => ({ tone: "caution", text: `${failure} couldn't be read, so its items get default settings.` })),
  ]).filter(Boolean);
  const checks = [...sourceChecks, ...plan.checks];
  if (merge && identical.status === "error") checks.unshift({ tone: "destructive", text: `The files couldn't be compared, so nothing merges: ${identical.error}` });

  const packs = plan.dlcs.map((dlc) => {
    const items = plan.items.filter((item) => item.dlc === dlc.dlc);
    return { ...dlc, items: items.length, textures: items.reduce((sum, item) => sum + item.textures.length, 0) };
  });
  const target = parent && name ? joinPath(parent, name) : "";
  const comparing = merge && identical.status === "comparing";
  const disabledReason = busy || done ? ""
    : !sources.length ? "Add a folder of clothing first."
      : reading ? "Reading the folders…"
        : comparing ? "Comparing the files…"
          : plan.blocked || (!parent ? "Pick where to build the resource." : "");

  const build = async () => {
    if (disabledReason || busy) return;
    setRun({ phase: "building", progress: { done: 0, total: plan.copies.length + plan.ymts.length + plan.texts.length }, lines: [] });
    let unlisten = null;
    try {
      unlisten = await listen("clothing-pack-progress", (event) => {
        if (mounted.current) setRun((current) => (current.phase === "building" ? { ...current, progress: event.payload } : current));
      });
      const result = await invoke("clothing_pack_build", { request: clothingBuildRequest(plan, parent, name) });
      if (!mounted.current) return;
      setRun({
        phase: "done",
        progress: null,
        lines: [{ tone: "ok", text: `Built ${name} with ${plural(plan.summary.items, "item")} and ${plural(plan.summary.textures, "texture")}`, path: String(result?.path || target) }],
      });
    } catch (error) {
      if (mounted.current) setRun({ phase: "error", progress: null, lines: [{ tone: "error", text: `The pack was not built: ${errorText(error)}.` }] });
    } finally {
      unlisten?.();
    }
  };

  const progress = run.progress;
  return (
    <ToolDialog title="Build addon pack" titleId="lv-cpack-title" busy={busy} onClose={onClose} wide>
      <div className="se-dialog-body lv-cpack-body custom-scrollbar">
        <p className="se-note">
          Copies the clothing in folders you pick into a new FiveM resource with its own pack name, numbered so items from different packs no longer clash. Your folders are only read.
        </p>

        <section className="se-group">
          <header className="se-group-head">
            <h4 className="cx-label">Sources</h4>
            <button type="button" className="cx-btn is-quiet lv-cpack-add" onClick={addSources} disabled={busy || done}>
              <FolderPlus aria-hidden="true" />
              Add folders…
            </button>
          </header>
          {sources.length ? (
            <ul className="lv-cpack-sources" aria-label="Source folders">
              {sources.map((source) => {
                const counts = source.status === "ready" ? sourceCounts(source) : null;
                const detail = source.status === "reading" ? "Reading…"
                  : source.status === "error" ? source.error
                    : counts.items ? `${plural(source.packs.length, "pack")} · ${plural(counts.items, "item")} · ${plural(counts.textures, "texture")}`
                      : source.escrowed ? "Escrowed resource, so nothing is copied from it"
                        : "No freemode clothing found";
                const tone = source.status === "error" ? "error" : source.status === "reading" ? "busy" : counts?.items ? "" : "warn";
                return (
                  <li key={source.id} className="lv-cpack-source">
                    <span className="lv-cpack-source-text">
                      <span className="lv-cpack-source-name" title={source.folder}>{source.label}</span>
                      <span className="lv-cpack-source-path" title={source.folder}>{source.folder}</span>
                      <span className={`lv-cpack-source-detail ${tone ? `is-${tone}` : ""}`}>{detail}</span>
                    </span>
                    <button type="button" className="cx-icon-btn" onClick={() => removeSource(source.id)} disabled={busy || done}
                      aria-label={`Leave out ${source.label}`} title={`Leave out ${source.label}`}>
                      <X aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="lv-slot-note"><span>Add folders of freemode clothing: addon packs, or loose files from a clothing tool.</span></p>
          )}
          {notes.map((note) => <p key={note} className="se-note is-warn">{note}</p>)}
        </section>

        <section className="se-group">
          <header className="se-group-head">
            <h4 className="cx-label">New pack</h4>
          </header>
          <div className="se-field">
            <span className="se-field-label" id="lv-cpack-name-label">Name</span>
            <div className="se-field-control">
              <input className={`se-text ${name && checkPackName(name).error ? "is-invalid" : ""}`} value={name} spellCheck={false} placeholder="my_uniforms"
                aria-labelledby="lv-cpack-name-label" disabled={busy || done} onChange={(event) => setName(event.target.value.trim())} />
            </div>
          </div>
          <div className="se-field">
            <span className="se-field-label" title="Items whose model file is byte for byte the same become one item with all their textures">Merge identical models</span>
            <Toggle checked={merge} onChange={setMerge} ariaLabel="Merge identical models" disabled={busy || done} />
          </div>
          <div className="se-field">
            <span className="se-field-label">Build in</span>
            <div className="se-field-control lv-cpack-parent">
              <span className="lv-cpack-path" title={target || parent}>{target || parent || "No folder picked"}</span>
              <button type="button" className="cx-btn is-quiet" onClick={pickParent} disabled={busy || done}>
                <FolderOpen aria-hidden="true" />
                {parent ? "Change…" : "Pick…"}
              </button>
            </div>
          </div>
        </section>

        {packs.length && !done ? (
          <table className="lv-liv-plan">
            <thead>
              <tr>
                <th scope="col">Pack</th>
                <th scope="col">Ped</th>
                <th scope="col">Items</th>
                <th scope="col">Textures</th>
              </tr>
            </thead>
            <tbody>
              {packs.map((pack) => (
                <tr key={pack.dlc}>
                  <td className="lv-liv-plan-file" title={pack.ymt}>{pack.dlc}</td>
                  <td>{pedLabel(pack.ped)}</td>
                  <td className="lv-liv-plan-size">{pack.items}</td>
                  <td className="lv-liv-plan-size">{pack.textures}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {checks.length && !done ? (
          <section className="lv-liv-checks" aria-labelledby="lv-cpack-checks-title">
            <h3 id="lv-cpack-checks-title" className="cx-label">Checks</h3>
            <ul>
              {checks.map((check) => (
                <li key={check.text} className={TONES[check.tone] || ""}>
                  <span className="lv-dot" aria-hidden="true" />
                  <span>{check.text}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {done ? (
          <p className="se-note">{`Add ensure ${name} to your server.cfg to stream it. Keep each pack's licence with the clothing it covers.`}</p>
        ) : (
          <p className="se-note">Only build from clothing you made or may share. Each pack's licence still applies to its clothing after the merge.</p>
        )}
      </div>
      <footer className="se-dialog-foot is-row">
        <div className="se-dialog-foot-status">
          <StatusLines lines={run.lines} />
          {busy ? (
            <div className="lv-liv-progress" role="status">
              <p className="lv-slot-note is-busy"><span>{`Building ${name}…`}</span></p>
              {progress?.total ? (
                <div className="lv-progress" aria-hidden="true">
                  <span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
                </div>
              ) : null}
            </div>
          ) : null}
          {disabledReason && run.phase !== "error" ? <p className="se-note">{disabledReason}</p> : null}
        </div>
        <div className="se-dialog-actions">
          <button type="button" className="settings-secondary" onClick={onClose} disabled={busy}>{done ? "Close" : "Cancel"}</button>
          {done ? null : (
            <button type="button" className="settings-primary" onClick={build} disabled={Boolean(disabledReason) || busy}
              title={disabledReason || `Build ${target}`}>
              {busy ? "Building…" : run.phase === "error" ? "Try again" : "Build pack"}
            </button>
          )}
        </div>
      </footer>
    </ToolDialog>
  );
}
