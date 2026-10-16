// Layout for the siren editor's callout markers: a dot on each light and its
// number on a short leader just off it, like a parts diagram. Positions are
// canvas CSS pixels. Each frame a label first rides along with its light, then
// relaxes a few iterations from there, so labels glide into new arrangements
// as the camera moves instead of jumping.

/** Lights closer than this on screen share one dot and one label. */
export const CALLOUT_CLUSTER_PX = 6;
/** How far a label rests from its light, pushed out from the group's centre. */
export const CALLOUT_REACH_PX = 30;
// Clearance kept around every light's dot and between labels.
const DOT_CLEARANCE_PX = 6;
const LABEL_GAP_PX = 3;
const EDGE_PX = 4;

/**
 * Groups visible markers ([{ siren, x, y, behind, far }]) that sit within
 * `radius` px of each other. A group takes the position of its lowest siren,
 * its id is that siren's index, and it is `far` only when every light in it is.
 */
export function clusterMarkers(markers, radius = CALLOUT_CLUSTER_PX) {
  const clusters = [];
  const sorted = (markers || []).filter((marker) => !marker.behind).sort((a, b) => a.siren - b.siren);
  for (const marker of sorted) {
    const near = clusters.find((cluster) => Math.hypot(cluster.x - marker.x, cluster.y - marker.y) < radius);
    if (near) {
      near.sirens.push(marker.siren);
      near.far = near.far && Boolean(marker.far);
    } else {
      clusters.push({ id: marker.siren, sirens: [marker.siren], x: marker.x, y: marker.y, far: Boolean(marker.far) });
    }
  }
  return clusters;
}

/** Changes only when the groups, their members or their far flags change. */
export function clusterKey(clusters) {
  return clusters.map((cluster) => `${cluster.sirens.join("+")}${cluster.far ? "~" : ""}`).join(",");
}

function restingSpot(cluster, center, reach) {
  let dx = cluster.x - center.x;
  let dy = cluster.y - center.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-3) {
    dx = 0;
    dy = -1;
  } else {
    dx /= length;
    dy /= length;
  }
  return { x: cluster.x + dx * reach, y: cluster.y + dy * reach };
}

/**
 * Moves each label with its light, then toward its resting spot and apart
 * from the other labels and every light's dot, kept inside `width` x
 * `height`. `labels` maps cluster id to { x, y, w, h } (centre and size) and
 * is updated in place; a cluster without an entry starts at its resting spot
 * with `sizes.get(id)` or a default size. Entries for clusters that no longer
 * exist are removed. `maxStep` caps how far one call rearranges a label
 * beyond following its light. Returns the largest such rearrangement.
 */
export function relaxCallouts(clusters, labels, { width, height, sizes = null, iterations = 6, reach = CALLOUT_REACH_PX, pull = 0.2, maxStep = Infinity } = {}) {
  if (!clusters.length) {
    labels.clear();
    return 0;
  }
  const center = {
    x: clusters.reduce((sum, cluster) => sum + cluster.x, 0) / clusters.length,
    y: clusters.reduce((sum, cluster) => sum + cluster.y, 0) / clusters.length,
  };
  const ids = new Set(clusters.map((cluster) => cluster.id));
  for (const id of labels.keys()) if (!ids.has(id)) labels.delete(id);

  const items = clusters.map((cluster) => {
    const target = restingSpot(cluster, center, reach);
    const size = sizes?.get(cluster.id);
    let label = labels.get(cluster.id);
    if (!label) {
      label = { x: target.x, y: target.y, w: 24, h: 18 };
      labels.set(cluster.id, label);
    } else if (Number.isFinite(label.ax)) {
      label.x += cluster.x - label.ax;
      label.y += cluster.y - label.ay;
    }
    label.ax = cluster.x;
    label.ay = cluster.y;
    if (size) {
      label.w = size.w;
      label.h = size.h;
    }
    return { label, target, start: { x: label.x, y: label.y } };
  });

  const clamp = (label) => {
    label.x = Math.min(Math.max(label.x, label.w / 2 + EDGE_PX), Math.max(label.w / 2 + EDGE_PX, width - label.w / 2 - EDGE_PX));
    label.y = Math.min(Math.max(label.y, label.h / 2 + EDGE_PX), Math.max(label.h / 2 + EDGE_PX, height - label.h / 2 - EDGE_PX));
  };

  const separate = () => {
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i].label;
        const b = items[j].label;
        const overlapX = (a.w + b.w) / 2 + LABEL_GAP_PX - Math.abs(a.x - b.x);
        const overlapY = (a.h + b.h) / 2 + LABEL_GAP_PX - Math.abs(a.y - b.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        // Labels are wider than tall, so sliding sideways is often the shorter way out.
        if (overlapX < overlapY * 1.5) {
          const shift = (a.x < b.x || (a.x === b.x && i < j) ? -1 : 1) * overlapX / 2;
          a.x += shift;
          b.x -= shift;
        } else {
          const shift = (a.y < b.y || (a.y === b.y && i < j) ? -1 : 1) * overlapY / 2;
          a.y += shift;
          b.y -= shift;
        }
      }
    }
  };
  const clearDots = () => {
    for (const { label } of items) {
      for (const cluster of clusters) {
        const overlapX = label.w / 2 + DOT_CLEARANCE_PX - Math.abs(label.x - cluster.x);
        const overlapY = label.h / 2 + DOT_CLEARANCE_PX - Math.abs(label.y - cluster.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        if (overlapY < overlapX) label.y += (label.y < cluster.y ? -1 : 1) * overlapY;
        else label.x += (label.x < cluster.x ? -1 : 1) * overlapX;
      }
    }
  };

  // Pull, then resolve: dots first, labels last, so a settled frame ends with
  // labels apart (the gap absorbs what the next dot push re-introduces).
  for (let pass = 0; pass < iterations; pass += 1) {
    for (const { label, target } of items) {
      label.x += (target.x - label.x) * pull;
      label.y += (target.y - label.y) * pull;
    }
    clearDots();
    separate();
    separate();
    for (const { label } of items) clamp(label);
  }

  let moved = 0;
  for (const { label, start } of items) {
    let distance = Math.hypot(label.x - start.x, label.y - start.y);
    if (distance > maxStep) {
      label.x = start.x + (label.x - start.x) * maxStep / distance;
      label.y = start.y + (label.y - start.y) * maxStep / distance;
      distance = maxStep;
    }
    moved = Math.max(moved, distance);
  }
  return moved;
}

/**
 * Where a leader from `point` meets the edge of `label` ({ x, y, w, h }), or
 * null when the point sits inside the label.
 */
export function leaderEnd(point, label) {
  const left = label.x - label.w / 2;
  const top = label.y - label.h / 2;
  const x = Math.min(Math.max(point.x, left), left + label.w);
  const y = Math.min(Math.max(point.y, top), top + label.h);
  if (x === point.x && y === point.y) return null;
  return { x, y };
}
