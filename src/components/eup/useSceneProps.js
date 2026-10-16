import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { exists } from "@tauri-apps/plugin-fs";
import { scenePropModelKey } from "../../lib/eup-scene";
import { exportGameProp } from "./ped-files";

function errorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (typeof error.message === "string") return error.message;
  return String(error);
}

function place(holder, prop) {
  holder.position.fromArray(prop.position);
  holder.rotation.set(0, THREE.MathUtils.degToRad(prop.yaw), 0);
  holder.visible = !prop.hidden;
  holder.updateMatrixWorld(true);
}

/**
 * Props placed on the EUP stage. Each loads through Photo Mode's model
 * controller (a holder for the placement, a ground group that rests the
 * model's lowest point on the floor, the highest LOD, and the game's textures
 * through native materials) and stands under `setRoot`, which the viewport
 * renders but never frames.
 *
 * A file prop whose file is gone is reported as "missing" and loads nothing;
 * any other failure is an "error" that `retry(id)` loads again.
 * `revisionOf(path)` bumps reload a file prop in place: the old model stays
 * until the new one is ready. Loads are cancelled on replacement and unmount.
 */
export function useSceneProps({ enabled, props, setRoot, viewportRef, revisionOf }) {
  const runtimeRef = useRef(new Map());
  const propsRef = useRef(props);
  propsRef.current = props;
  const [states, setStates] = useState({});
  const [retries, setRetries] = useState({});

  const keyOf = (prop) => `${scenePropModelKey(prop)}@${prop.source === "file" ? revisionOf(prop.path) : 0}#${retries[prop.id] || 0}`;
  const modelKeys = props.map((prop) => `${prop.id}=${keyOf(prop)}`).join("|");

  const setState = useCallback((id, state) => {
    setStates((prev) => ({ ...prev, [id]: state }));
  }, []);

  const render = useCallback(() => viewportRef.current?.requestRender(), [viewportRef]);

  const dropStale = (entry) => {
    entry.stale?.dispose();
    entry.stale = null;
  };

  const load = useCallback(async (prop, entry) => {
    const { signal } = entry.abort;
    setState(prop.id, { status: "loading" });
    try {
      let path = prop.path;
      if (prop.source === "file") {
        // Only a definite "not there" is missing. The check is scope-bound, so a
        // file on another drive after a restart can be refused; the bridge
        // parse below reads it natively and reports a real failure itself.
        const found = await exists(prop.path).catch(() => null);
        if (signal.aborted) return;
        if (found === false) {
          dropStale(entry);
          render();
          setState(prop.id, { status: "missing" });
          return;
        }
      } else {
        path = (await exportGameProp(prop.name))?.path;
        if (signal.aborted) return;
        if (!path) throw new Error(`The game files returned no model for ${prop.name}.`);
      }
      // Photo Mode's loaders, fetched on first use so EUP Studio opens without them.
      const { loadPhotoModel } = await import("../photo/photo-objects.js");
      if (signal.aborted) return;
      const controller = await loadPhotoModel({ kind: "prop", source: "file", path, signal });
      if (signal.aborted) {
        controller.dispose();
        return;
      }
      controller.holder.name = `set-prop:${prop.id}`;
      dropStale(entry);
      entry.controller = controller;
      place(controller.holder, propsRef.current.find((item) => item.id === prop.id) || prop);
      setRoot.add(controller.holder);
      render();
      setState(prop.id, { status: "ready", warning: controller.warnings?.[0] || "" });
      const summary = await controller.loadTextures({
        renderer: viewportRef.current?.getRenderer?.(),
        signal,
        onRender: render,
      });
      if (signal.aborted) return;
      render();
      const failed = summary?.failed || 0;
      if (failed) setState(prop.id, { status: "ready", warning: `${failed} texture${failed === 1 ? "" : "s"} didn't load.` });
    } catch (error) {
      if (error?.name === "AbortError" || signal.aborted) return;
      dropStale(entry);
      render();
      setState(prop.id, { status: "error", error: errorMessage(error) });
    }
  }, [render, setRoot, setState, viewportRef]);

  /* ── Mount and unmount models to match the list ── */
  useEffect(() => {
    if (!enabled) return;
    const runtime = runtimeRef.current;
    const wanted = new Map(propsRef.current.map((prop) => [prop.id, prop]));
    const carried = new Map();
    let changed = false;
    for (const [id, entry] of [...runtime]) {
      const prop = wanted.get(id);
      if (prop && keyOf(prop) === entry.key) continue;
      entry.abort.abort();
      runtime.delete(id);
      const visible = entry.controller || entry.stale;
      if (entry.controller && entry.stale) entry.stale.dispose();
      // Same model, new revision or a retry: keep what is on screen until the reload lands.
      if (prop && visible && scenePropModelKey(prop) === entry.modelKey) {
        carried.set(id, visible);
      } else if (visible) {
        visible.dispose();
        changed = true;
      }
    }
    for (const prop of propsRef.current) {
      if (runtime.has(prop.id)) continue;
      const entry = {
        key: keyOf(prop),
        modelKey: scenePropModelKey(prop),
        abort: new AbortController(),
        controller: null,
        stale: carried.get(prop.id) || null,
      };
      runtime.set(prop.id, entry);
      load(prop, entry);
    }
    setStates((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([id]) => wanted.has(id)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    if (changed) render();
    // keyOf reads `retries` and `revisionOf`; both are folded into modelKeys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKeys, enabled, load, render]);

  /* ── Placement and visibility apply in place ── */
  useEffect(() => {
    for (const prop of props) {
      const entry = runtimeRef.current.get(prop.id);
      const holder = entry?.controller?.holder || entry?.stale?.holder;
      if (holder) place(holder, prop);
    }
    render();
  }, [props, render]);

  useEffect(
    () => () => {
      for (const entry of runtimeRef.current.values()) {
        entry.abort.abort();
        entry.controller?.dispose();
        entry.stale?.dispose();
      }
      runtimeRef.current.clear();
    },
    [],
  );

  const retry = useCallback((id) => {
    setRetries((prev) => ({ ...prev, [id]: (prev[id] || 0) + 1 }));
  }, []);

  /** The loaded model's holder (the object the gizmo moves), or null. */
  const holderOf = useCallback((id) => runtimeRef.current.get(id)?.controller?.holder || null, []);

  return { states, retry, holderOf };
}
