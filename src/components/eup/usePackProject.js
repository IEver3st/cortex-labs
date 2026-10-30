import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fileNameOf, groupClothingFiles, planClothingPackBuild } from "../../lib/clothing-pack.js";
import { itemProperties } from "../../lib/clothing-properties.js";
import { parsePedVariationXml } from "../../lib/ped-variation-xml.js";
import { clothingBuildRequest } from "../../lib/clothing-write.js";
import { trackUsage } from "../../lib/usage.js";

const LOOSE_SOURCE = "loose-files";

const errorText = (error) => String(error?.message || error || "Unknown error").replace(/\.$/, "");
const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

async function readPackModels(packs) {
  const models = {};
  const failed = [];
  for (const pack of packs) {
    if (!pack.ymtPath) continue;
    try {
      const result = await invoke("read_pack_ymt", { path: pack.ymtPath });
      models[pack.ymtPath] = parsePedVariationXml(result.xml);
    } catch (error) {
      failed.push(`${fileNameOf(pack.ymtPath)} (${errorText(error)})`);
    }
  }
  return { models, failed };
}

async function scanFolder(folder) {
  const scan = await invoke("clothing_folder", { folder });
  const files = (scan?.files || []).map((file) => ({ path: String(file.path), escrowed: Boolean(file.escrowed) }));
  const grouped = groupClothingFiles(files.filter((file) => !file.escrowed));
  const { models, failed } = await readPackModels(grouped.packs);
  return {
    packs: grouped.packs,
    models,
    failed,
    escrowed: files.filter((file) => file.escrowed).length,
    unknown: grouped.unknown.length,
    stray: grouped.stray.length,
    truncated: Boolean(scan?.truncated),
  };
}

async function scanLooseFiles(paths) {
  const grouped = groupClothingFiles(paths.map((path) => ({ path })));
  const { models, failed } = await readPackModels(grouped.packs);
  return { packs: grouped.packs, models, failed, escrowed: 0, unknown: grouped.unknown.length, stray: grouped.stray.length, truncated: false };
}

function comparedPaths(sources) {
  const paths = [];
  for (const source of sources) {
    for (const pack of source.packs) {
      for (const item of pack.items) paths.push(item.drawable, ...item.textures.map((texture) => texture.path));
    }
  }
  return paths;
}

function sourceChecks(source) {
  return [
    source.escrowed ? { tone: "caution", text: `${plural(source.escrowed, "file")} in ${source.label} ${source.escrowed === 1 ? "is" : "are"} in an escrowed resource, so ${source.escrowed === 1 ? "it is" : "they are"} left out.` } : null,
    source.unknown ? { tone: "caution", text: `${plural(source.unknown, "file")} in ${source.label} ${source.unknown === 1 ? "is not" : "are not"} named as freemode clothing, so ${source.unknown === 1 ? "it is" : "they are"} left out.` } : null,
    source.stray ? { tone: "caution", text: `${plural(source.stray, "texture")} in ${source.label} ${source.stray === 1 ? "has" : "have"} no model beside ${source.stray === 1 ? "it" : "them"}, so ${source.stray === 1 ? "it is" : "they are"} left out.` } : null,
    source.truncated ? { tone: "caution", text: `${source.label} holds more files than Cortex reads at once; only the first 20000 entries are used.` } : null,
    ...(source.failed || []).map((failure) => ({ tone: "destructive", text: `${failure} couldn't be read. Fix the file or remove its folder to build; Cortex won't guess its items' settings.` })),
    source.status === "error" ? { tone: "destructive", text: `${source.label} couldn't be read: ${source.error}` } : null,
  ].filter(Boolean);
}

export function usePackProject({ enabled, compare, sourceFolders, sourceFiles, revision, project }) {
  const [scans, setScans] = useState({});
  const scansRef = useRef(scans);
  scansRef.current = scans;
  const [identical, setIdentical] = useState({ status: "idle", key: "", map: {}, error: "" });
  const [run, setRun] = useState({ phase: "ready", progress: null, result: null, error: "" });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const looseKey = sourceFiles.join("\n");
  const wanted = useMemo(() => [
    ...sourceFolders.map((folder) => ({ id: folder, label: fileNameOf(folder) || folder, folder })),
    ...(sourceFiles.length ? [{ id: LOOSE_SOURCE, label: "Added files", files: sourceFiles }] : []),
  ], [sourceFolders, sourceFiles]);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const stamp = `${revision}|${looseKey}`;
    const stale = wanted.filter((source) => scansRef.current[source.id]?.stamp !== stamp);
    if (!stale.length) return undefined;
    setScans((current) => {
      const next = {};
      for (const source of wanted) next[source.id] = current[source.id] || { status: "reading", packs: [], models: {} };
      for (const source of stale) next[source.id] = { ...next[source.id], status: next[source.id].status === "ready" ? "ready" : "reading" };
      return next;
    });
    (async () => {
      for (const source of stale) {
        try {
          const result = source.folder ? await scanFolder(source.folder) : await scanLooseFiles(source.files);
          if (cancelled) return;
          setScans((current) => ({ ...current, [source.id]: { ...result, status: "ready", stamp } }));
        } catch (error) {
          if (cancelled) return;
          setScans((current) => ({ ...current, [source.id]: { status: "error", error: errorText(error), packs: [], models: {}, stamp } }));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, wanted, revision, looseKey]);

  const sources = useMemo(() => wanted.map((source) => ({
    ...source,
    ...(scans[source.id] || { status: "reading", packs: [], models: {} }),
  })), [wanted, scans]);
  const reading = sources.some((source) => source.status === "reading");
  const ready = useMemo(() => sources.filter((source) => source.status === "ready"), [sources]);
  const models = useMemo(() => Object.assign({}, ...ready.map((source) => source.models)), [ready]);

  const readyKey = ready.map((source) => `${source.id}@${source.stamp}`).join(",");
  useEffect(() => {
    if (!enabled || !compare || !project.merge || !ready.length || reading) return undefined;
    const paths = comparedPaths(ready);
    const key = `${readyKey}|${paths.length}`;
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
  }, [enabled, compare, project.merge, readyKey, reading]);

  const plan = useMemo(() => planClothingPackBuild({
    name: project.name,
    sources: ready.map((source) => ({ id: source.id, label: source.label, packs: source.packs })),
    models,
    identical: project.merge && identical.status === "ready" ? identical.map : {},
    merge: project.merge,
    edits: project.edits,
    order: project.order,
  }), [identical, models, project, ready]);

  const values = useMemo(() => {
    const byKey = new Map();
    for (const item of [...plan.items, ...plan.left]) {
      byKey.set(item.key, { item, properties: itemProperties({ isProp: item.isProp, info: item.info, prop: item.prop, edit: project.edits[item.key] }) });
    }
    return byKey;
  }, [plan, project.edits]);

  const checks = useMemo(() => {
    const list = [...sources.flatMap(sourceChecks), ...plan.checks];
    if (project.merge && identical.status === "error") list.unshift({ tone: "destructive", text: `The files couldn't be compared, so nothing merges: ${identical.error}` });
    return list;
  }, [sources, plan, project.merge, identical]);

  const comparing = project.merge && identical.status === "comparing";
  const unreadable = ready.reduce((count, source) => count + (source.failed?.length || 0), 0);

  const build = useCallback(async () => {
    setRun({ phase: "building", progress: { done: 0, total: plan.copies.length + plan.ymts.length + plan.texts.length + plan.creatures.length }, result: null, error: "" });
    let unlisten = null;
    try {
      unlisten = await listen("clothing-pack-progress", (event) => {
        if (mounted.current) setRun((current) => (current.phase === "building" ? { ...current, progress: event.payload } : current));
      });
      const result = await invoke("clothing_pack_build", { request: clothingBuildRequest(plan, project.parent, project.name) });
      trackUsage("eup");
      if (mounted.current) setRun({ phase: "done", progress: null, result: { path: String(result?.path || ""), items: plan.summary.items, textures: plan.summary.textures, creatures: plan.creatures.length }, error: "" });
    } catch (error) {
      if (mounted.current) setRun({ phase: "error", progress: null, result: null, error: errorText(error) });
    } finally {
      unlisten?.();
    }
  }, [plan, project.parent, project.name]);

  const resetRun = useCallback(() => setRun({ phase: "ready", progress: null, result: null, error: "" }), []);

  useEffect(() => {
    setRun((current) => (current.phase === "done" || current.phase === "error" ? { phase: "ready", progress: null, result: null, error: "" } : current));
  }, [project]);

  return { sources, reading, comparing, unreadable, plan, values, checks, run, build, resetRun };
}
