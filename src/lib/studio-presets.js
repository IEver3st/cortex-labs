// Curated studio lighting & backdrop presets shared by Prop Studio and Photo Mode.
// Pure data + helpers so both workspaces apply identical looks cleanly.

export const STUDIO_LOOK_PRESETS = Object.freeze([
  {
    id: "showroom-dark",
    label: "Showroom",
    note: "Dark product studio with overhead softbox and reflections.",
    prop: { stage: "showroom", light: "top", spot: 1.0, reflect: 0.6, beam: true, rim: 0.35, floor: "polished", dark: 0, lightLevel: 1.0, shadows: true, grid: false },
    photo: { stage: "showroom", light: "top", spot: 1.0, reflect: 0.6, beam: true, floor: "polished", dark: 0, lightLevel: 1.0, shadows: true, grid: false },
  },
  {
    id: "clean-cutout",
    label: "Clean dark",
    note: "Even studio fill on a flat dark backdrop for crisp icons and cutouts.",
    prop: { stage: "workbench", backdrop: "#141414", lightLevel: 1.15, dark: 0, shadows: false, grid: false },
    photo: { stage: "workbench", backdrop: "#141414", lightLevel: 1.15, dark: 0, shadows: false, grid: false },
  },
  {
    id: "light-studio",
    label: "Clean light",
    note: "Bright neutral paper backdrop with soft contact shadow.",
    prop: { stage: "workbench", backdrop: "#e8e8e2", lightLevel: 1.25, dark: 0, shadows: true, grid: false },
    photo: { stage: "workbench", backdrop: "#e8e8e2", lightLevel: 1.25, dark: 0, shadows: true, grid: false },
  },
  {
    id: "moody-rim",
    label: "Moody rim",
    note: "Backlit silhouette with strong edge rim and glossy concrete floor.",
    prop: { stage: "showroom", light: "back", spot: 1.25, reflect: 0.8, beam: true, rim: 1.35, floor: "concrete", dark: 0.15, lightLevel: 0.85, shadows: true, grid: false },
    photo: { stage: "showroom", light: "back", spot: 1.25, reflect: 0.8, beam: true, floor: "concrete", dark: 0.15, lightLevel: 0.85, shadows: true, grid: false },
  },
  {
    id: "night-glow",
    label: "Night glow",
    note: "Studio dimmed so emissives and authored lights lead the shot.",
    prop: { stage: "showroom", light: "top", spot: 0.6, reflect: 0.75, beam: false, rim: 0.2, floor: "asphalt", dark: 0.92, lightLevel: 0.75, shadows: true, grid: false },
    photo: { stage: "showroom", light: "top", spot: 0.6, reflect: 0.75, beam: false, floor: "asphalt", dark: 0.92, lightLevel: 0.75, shadows: true, grid: false },
  },
  {
    id: "inspect-grid",
    label: "Inspect",
    note: "Workbench with ground grid and shadows for geometry and scale checks.",
    prop: { stage: "workbench", backdrop: "#181a1f", lightLevel: 1.0, dark: 0, shadows: true, grid: true },
    photo: { stage: "workbench", backdrop: "#181a1f", lightLevel: 1.0, dark: 0, shadows: true, grid: true },
  },
]);

export function getStudioPresetPatch(presetId, target = "prop") {
  const preset = STUDIO_LOOK_PRESETS.find((item) => item.id === presetId);
  if (!preset) return null;
  const patch = preset[target === "photo" ? "photo" : "prop"];
  return patch ? { ...patch } : null;
}

function approx(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 0.02;
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** Returns the matching preset id if `scene` currently matches one, else "". */
export function matchStudioPreset(scene, target = "prop") {
  if (!scene || typeof scene !== "object") return "";
  const key = target === "photo" ? "photo" : "prop";
  for (const preset of STUDIO_LOOK_PRESETS) {
    const patch = preset[key];
    if (Object.entries(patch).every(([field, value]) => approx(scene[field], value))) {
      return preset.id;
    }
  }
  return "";
}
