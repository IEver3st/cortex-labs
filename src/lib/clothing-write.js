// Sends a clothing texture plan (clothing-pack.js planClothingTextureWrite)
// to the desktop host through the same staged session as the livery write
// (livery-write.js): each image built and staged on its own, then a commit
// that builds every texture file and the pack's .ymt before it adds the new
// files and backs up and replaces the rest.

import { stageId, writeStagedTextures } from "./livery-write.js";

const CLOTHING_COMMANDS = { begin: "clothing_write_begin", stage: "clothing_write_stage", commit: "clothing_write_commit", cancel: "clothing_write_cancel" };

/** The `clothing_write_commit` request for a plan whose textures are staged. */
export function clothingCommitRequest(plan, token, stamp) {
  return {
    token,
    stamp,
    ymt: plan.ymt ? { path: plan.ymt.path, xml: plan.ymt.xml, base: plan.ymt.base } : null,
    ytds: plan.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      ...(file.template ? { template: file.template } : {}),
      textures: file.textures.map((texture) => (texture.mode === "delete" ? { name: texture.name, mode: "delete" } : {
        name: texture.name,
        mode: texture.mode,
        id: stageId(texture.itemId, texture),
        ...(texture.like ? { like: texture.like } : {}),
      })),
    })),
  };
}

/**
 * Writes a clothing plan for the item at `drawablePath`. `items` are the
 * staged images `[{ id, path, letter }]`; `build`, `onProgress` and
 * `isCancelled` are as for writeLiveries. Resolves the host's `{ created,
 * replaced: [{ path, backup }], files }`.
 */
export function writeClothingTextures({ invoke, plan, items, drawablePath, build, onProgress, isCancelled, date }) {
  return writeStagedTextures({
    invoke, commands: CLOTHING_COMMANDS, beginArgs: { drawablePath }, plan, items, build, onProgress, isCancelled, date,
    commitRequest: (token, stamp) => clothingCommitRequest(plan, token, stamp),
  });
}

/**
 * The `clothing_pack_build` request for a build plan (planClothingPackBuild)
 * written as `parent/folderName`.
 */
export function clothingBuildRequest(plan, parent, folderName) {
  return {
    parent,
    name: folderName,
    copies: plan.copies.map(({ from, to }) => ({ from, to })),
    ymts: plan.ymts.map(({ to, xml }) => ({ to, text: xml })),
    texts: plan.texts.map(({ to, text }) => ({ to, text })),
  };
}
