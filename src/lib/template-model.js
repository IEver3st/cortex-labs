const TEMPLATE_MODEL_FORMATS = new Set(["yft", "ydd"]);
const TEMPLATE_VIEW_MODES = new Set(["model", "template", "split"]);

export function normalizeTemplateViewMode(value, fallback = "split") {
  if (TEMPLATE_VIEW_MODES.has(value)) return value;
  return TEMPLATE_VIEW_MODES.has(fallback) ? fallback : "split";
}

export function getTemplateModelFormat(value, fallback = "yft") {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const direct = raw.replace(/^\./, "");
  if (TEMPLATE_MODEL_FORMATS.has(direct)) return direct;

  const match = raw.match(/\.([^.\\/]+)$/);
  const extension = match?.[1] || "";
  if (TEMPLATE_MODEL_FORMATS.has(extension)) return extension;

  const normalizedFallback = typeof fallback === "string" ? fallback.trim().toLowerCase() : "";
  return TEMPLATE_MODEL_FORMATS.has(normalizedFallback) ? normalizedFallback : "yft";
}

export function isSupportedTemplateModel(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /\.(?:yft|ydd)$/.test(raw);
}

export function getTemplateModelPolicy(value) {
  const format = getTemplateModelFormat(value);
  const isEup = format === "ydd";

  return {
    format,
    isEup,
    label: isEup ? "EUP" : "Vehicle",
    preferUv2: !isEup,
    meshSelectionMode: isEup ? "all" : "vehicle-livery",
    preferredTarget: isEup ? "" : "material:vehicle_paint3",
    textureMode: isEup ? "eup" : "livery",
    textureTarget: isEup ? "all" : "material:vehicle_paint3",
    supportsExteriorOnly: !isEup,
    includeVehicleLayers: !isEup,
  };
}
