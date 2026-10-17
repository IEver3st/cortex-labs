// Pack view snapshots: a still of each vehicle in a folder, so the pack shows
// as plain images instead of a viewer per car. The viewer takes one while the
// vehicle is open; the app cache keeps it (vehicle_snapshots.rs).

export const SNAPSHOT_WIDTH = 480;
export const SNAPSHOT_HEIGHT = 270;
export const SNAPSHOT_QUALITY = 0.85;
// The camera shot every snapshot uses, so the pack lines up, closer in than
// the viewer's own framing so the vehicle fills a small tile. The framing fits
// the model's bounding sphere, so a tall vehicle such as a UTV still fits.
export const SNAPSHOT_PRESET = "angle";
export const SNAPSHOT_ZOOM = 1.8;

const BOUNDARY = /^[\d_\-A-Z]/;

/**
 * The plate a vehicle without a snapshot shows: its name less the prefix every
 * vehicle in the pack shares ("GSDSS17Caprice" in a GSDSS pack reads
 * "17Caprice"). The prefix is dropped only where it ends at a word boundary
 * in every name, so "Charger" beside "Challenger" stays whole.
 */
export function plateLabel(name, names) {
  const text = String(name || "");
  const list = (names || []).map((value) => String(value || "")).filter(Boolean);
  if (list.length < 2) return text;
  let length = list[0].length;
  for (const other of list) {
    let at = 0;
    while (at < length && at < other.length && other[at].toLowerCase() === list[0][at].toLowerCase()) at += 1;
    length = at;
  }
  if (length < 2) return text;
  const endsOnSeparator = /[_-]$/.test(list[0].slice(0, length));
  const clean = list.every((value) => value.length - length >= 2 && (endsOnSeparator || BOUNDARY.test(value.slice(length))));
  if (!clean) return text;
  return text.slice(length).replace(/^[_-]+/, "") || text;
}

/** Livery changes staged for a model and not yet written: new images plus removals. */
export function stagedLiveryCount(entry) {
  if (!entry) return 0;
  return (entry.items?.length || 0) + (entry.removed?.length || 0);
}

/**
 * The name the Pack view gives a folder: the resource every vehicle shares,
 * or else the folder's own name.
 */
export function packName(folder, vehicles) {
  const resources = new Set((vehicles || []).map((vehicle) => vehicle.resourcePath));
  if (resources.size === 1 && vehicles[0].resource) return vehicles[0].resource;
  return String(folder || "").replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean).pop() || String(folder || "");
}
