// Variant Builder layer visibility. A variant's map only holds the layers the
// user (or an older file) set; any other layer shows as the file has it. The
// layer list, the counts and the compositor all read it that way, so every
// edit must too. Each edit returns the same map when nothing would change, so
// the caller can skip recording an undo step.

/** Whether a layer shows in this variant: its stored value, else the file's own. */
export function isLayerVisible(visibility, layer) {
  if (!layer) return false;
  const stored = visibility?.[layer.id];
  return Boolean(stored ?? layer.visible);
}

function withValues(visibility, layers, valueFor) {
  let next = null;
  for (const layer of layers) {
    if (!layer) continue;
    const value = valueFor(layer);
    if (isLayerVisible(visibility, layer) === value) continue;
    next ??= { ...(visibility || {}) };
    next[layer.id] = value;
  }
  return next ?? visibility;
}

/** Flips one layer from what the list shows. */
export function toggleLayer(visibility, layer) {
  if (!layer) return visibility;
  return { ...(visibility || {}), [layer.id]: !isLayerVisible(visibility, layer) };
}

/** Shows or hides every layer given (a group's children). */
export function setLayers(visibility, layers, value) {
  return withValues(visibility, layers, () => Boolean(value));
}

/** Shows only `layerId` among its siblings. */
export function soloLayer(visibility, siblings, layerId) {
  return withValues(visibility, siblings, (layer) => layer.id === layerId);
}
