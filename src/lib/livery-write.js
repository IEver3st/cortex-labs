// Sends a livery plan (livery-set.js planLiveryWrite) to the desktop host:
// one session, each texture built and staged on its own (a batch of 4K
// liveries is too large for one message), then a commit that rebuilds every
// dictionary, with its removed liveries left out, before it backs up and
// replaces any of them. Until the commit nothing beside the model changes, so
// a failure or cancel before it says so.

import { backupStamp } from "./siren-install.js";

const NOTHING_CHANGED = "Nothing was changed.";

/** Body of `livery_write_stage`: a little-endian u32 header length, the JSON `{ token, id }`, then the DDS. */
export function encodeStageBody(token, id, bytes) {
  const json = new TextEncoder().encode(JSON.stringify({ token, id }));
  const body = new Uint8Array(4 + json.length + bytes.length);
  new DataView(body.buffer).setUint32(0, json.length, true);
  body.set(json, 4);
  body.set(bytes, 4 + json.length);
  return body;
}

export function stageId(itemId, { width, height, levels }) {
  // The host takes ids of up to 64 characters; the size suffix must survive.
  return `${String(itemId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40)}-${width}x${height}-${levels || 0}`;
}

/**
 * The textures a plan needs built: per item, each distinct size the
 * dictionaries take it at. Returns `[{ item, targets: [{ id, width, height, levels }] }]`.
 */
export function liveryBuildJobs(plan, items) {
  const jobs = new Map(items.map((item) => [item.id, { item, targets: [] }]));
  for (const file of plan.files) {
    for (const texture of file.textures) {
      if (texture.mode === "delete") continue;
      const job = jobs.get(texture.itemId);
      if (!job) throw new Error(`Livery ${texture.number} has no image.`);
      const id = stageId(texture.itemId, texture);
      if (!job.targets.some((target) => target.id === id)) {
        job.targets.push({ id, width: texture.width, height: texture.height, levels: texture.levels || 0 });
      }
    }
  }
  return [...jobs.values()].filter((job) => job.targets.length);
}

/** The `livery_write_commit` request for a plan whose textures are staged. */
export function liveryCommitRequest(plan, token, stamp) {
  return {
    token,
    stamp,
    ytds: plan.files.map((file) => ({
      path: file.path,
      textures: file.textures.map((texture) => (texture.mode === "delete" ? { name: texture.name, mode: "delete" } : {
        name: texture.name,
        mode: texture.mode,
        id: stageId(texture.itemId, texture),
        ...(texture.like ? { like: texture.like } : {}),
      })),
    })),
  };
}

function withNothingChanged(error) {
  const text = String(error?.message || error || "The livery write failed.");
  return new Error(text.includes(NOTHING_CHANGED) ? text : `${text.replace(/\.?$/, ".")} ${NOTHING_CHANGED}`);
}

/**
 * Stages a plan's textures in one host session and commits it. `commands`
 * names the session's `begin`, `stage`, `commit` and `cancel` commands,
 * `begin` is called with `beginArgs`, and `commitRequest(token, stamp)` is
 * the commit's request. See writeLiveries for the rest.
 */
export async function writeStagedTextures({ invoke, commands, beginArgs, plan, items, build, commitRequest, onProgress = () => {}, isCancelled = () => false, date = new Date() }) {
  const jobs = liveryBuildJobs(plan, items);
  const total = jobs.reduce((sum, job) => sum + job.targets.length, 0);
  const { token } = await invoke(commands.begin, beginArgs);
  let done = 0;
  try {
    for (const [index, job] of jobs.entries()) {
      if (isCancelled()) throw new Error("The write was cancelled.");
      const at = { item: index + 1, items: jobs.length, label: job.item.path };
      onProgress({ done, total, ...at });
      const outputs = await build(job.item, job.targets);
      for (const [index, target] of job.targets.entries()) {
        if (isCancelled()) throw new Error("The write was cancelled.");
        const bytes = outputs[index]?.bytes;
        if (!bytes?.length) throw new Error(`${job.item.number != null ? `Livery ${job.item.number}` : job.item.path || "A texture"} was not built.`);
        await invoke(commands.stage, encodeStageBody(token, target.id, bytes));
        done += 1;
        onProgress({ done, total, ...at });
      }
    }
    if (isCancelled()) throw new Error("The write was cancelled.");
    // A write that only removes textures stages nothing and goes straight to the commit.
    if (!total) onProgress({ done: 0, total: 0, item: 0, items: 0, label: "" });
  } catch (error) {
    await Promise.resolve(invoke(commands.cancel, { token })).catch(() => {});
    throw withNothingChanged(error);
  }
  return invoke(commands.commit, { request: commitRequest(token, backupStamp(date)) });
}

const LIVERY_COMMANDS = { begin: "livery_write_begin", stage: "livery_write_stage", commit: "livery_write_commit", cancel: "livery_write_cancel" };

/**
 * Writes a plan. `build(item, targets)` resolves each target's DDS bytes in
 * order; `onProgress({ done, total, item, items, label })` hears each staged
 * texture (`done` of `total`) while the `item`th of `items` images is built;
 * `isCancelled()` stops the write before its commit. Resolves the host's
 * `{ files: [{ path, backup, textures }] }`.
 */
export function writeLiveries({ invoke, plan, items, modelPath, build, onProgress, isCancelled, date }) {
  return writeStagedTextures({
    invoke, commands: LIVERY_COMMANDS, beginArgs: { modelPath }, plan, items, build, onProgress, isCancelled, date,
    commitRequest: (token, stamp) => liveryCommitRequest(plan, token, stamp),
  });
}
