import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { buildFolderReport, doctorManifestPaths, isInside, MAX_MANIFEST_CHARS } from "../../lib/pack-doctor.js";
import { doctorGenerator, errorText } from "./useDoctorReport.js";

const IDLE = Object.freeze({ status: "idle", stage: "", done: 0, total: 0, report: null, key: null, folder: "" });
const LISTING = "listing";

function retire(controller) {
  if (!controller) return;
  controller.retired = true;
  controller.abort();
}

export default function useFolderDoctor({ folder, scan, modelPath, enabled }) {
  const [state, setState] = useState(IDLE);
  const controllerRef = useRef(null);
  const ready = scan.status === "ready";
  const resources = ready ? scan.resources : null;
  const snapshot = useRef(scan);
  snapshot.current = scan;
  const model = /\.yft$/i.test(modelPath || "") && isInside(folder, modelPath) ? modelPath : "";

  const run = useCallback(async () => {
    const current = snapshot.current;
    if (current.status !== "ready" || !current.resources) return;
    retire(controllerRef.current);
    const controller = new AbortController();
    controllerRef.current = controller;
    const key = current.resources;
    const base = { key, folder, report: null };
    const finish = async ({ assets, assetsError, manifests, cancelled }) => {
      const report = buildFolderReport({
        folder: current.folder || folder,
        scan: current,
        assets,
        assetsError,
        manifests,
        cancelled,
        createdAt: new Date().toISOString(),
        generator: await doctorGenerator(),
      });
      if (controllerRef.current === controller) controllerRef.current = null;
      if (!controller.retired) setState({ ...base, status: cancelled ? "cancelled" : "done", stage: "", done: 0, total: 0, report });
    };
    const progress = (next) => { if (!controller.retired && !controller.signal.aborted) setState({ ...base, status: "running", ...next }); };
    progress({ stage: "Measuring streamed files", done: 0, total: 0 });
    let assets = null;
    let assetsError = "";
    try {
      assets = await invoke("describe_streamed_assets", { root: folder, models: model ? [model] : [] });
    } catch (error) {
      assetsError = errorText(error);
    }
    const manifests = {};
    if (controller.signal.aborted) return finish({ assets, assetsError, manifests, cancelled: true });
    const paths = doctorManifestPaths(current, assets);
    progress({ stage: "Reading manifests", done: 0, total: paths.length });
    for (const [index, path] of paths.entries()) {
      if (controller.signal.aborted) return finish({ assets, assetsError, manifests, cancelled: true });
      try {
        const text = await readTextFile(path);
        manifests[path] = text.length > MAX_MANIFEST_CHARS ? { error: "It is larger than 1 MiB." } : { text };
      } catch (error) {
        manifests[path] = { error: errorText(error) };
      }
      progress({ stage: "Reading manifests", done: index + 1, total: paths.length });
    }
    if (controller.signal.aborted) return finish({ assets, assetsError, manifests, cancelled: true });
    progress({ stage: "Checking", done: 0, total: 0 });
    return finish({ assets, assetsError, manifests, cancelled: false });
  }, [folder, model]);

  const cancel = useCallback(() => {
    if (controllerRef.current && !controllerRef.current.signal.aborted) {
      controllerRef.current.abort();
      setState((current) => (current.status === "running" ? { ...current, stage: "Cancelling", done: 0, total: 0 } : current));
      return;
    }
    if (!ready) setState({ ...IDLE, status: "cancelled", key: LISTING, folder });
  }, [ready, folder]);

  useEffect(() => {
    if (!enabled || !resources || state.status === "running") return;
    if (state.key === resources) return;
    if (state.status === "cancelled" && state.key === LISTING && state.folder === folder) return;
    run();
  }, [enabled, resources, state.key, state.status, state.folder, folder, run]);

  useEffect(() => {
    retire(controllerRef.current);
    controllerRef.current = null;
    setState(IDLE);
  }, [folder]);

  useEffect(() => () => retire(controllerRef.current), []);

  return { ...state, run, cancel, listing: scan.status === "scanning" };
}
