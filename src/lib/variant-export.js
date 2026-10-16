// Variant Builder export geometry. A variant keeps its source's aspect ratio
// with the long side at the chosen size; square output is an explicit choice
// that stretches a non-square source.

export const VARIANT_EXPORT_SHAPES = ["source", "square"];

export function normalizeVariantExportShape(value) {
  return value === "square" ? "square" : "source";
}

/** `{ width, height }` in pixels for one exported variant. */
export function variantExportDimensions(sourceWidth, sourceHeight, size, shape = "source") {
  const target = Math.max(1, Math.round(Number(size) || 0));
  const width = Number(sourceWidth);
  const height = Number(sourceHeight);
  if (normalizeVariantExportShape(shape) === "square" || !(width > 0) || !(height > 0) || width === height) {
    return { width: target, height: target };
  }
  const scale = target / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
