export const SHAPE_KINDS = ["stripe", "band", "chevron", "outline", "battenburg", "check"];
export const PATTERN_KINDS = ["battenburg", "check"];
export const MAX_PATTERN_CELLS = 20000;

export const SHAPE_PARAM_LIMITS = {
  count: [1, 24],
  gap: [0, 4],
  slant: [-75, 75],
  thickness: [0.01, 1],
  angle: [10, 170],
  rows: [1, 16],
  cellAspect: [0.25, 8],
  phase: [0, 1],
};

export const SHAPE_DEFAULTS = {
  stripe: { count: 2, gap: 0.6, slant: 0 },
  band: { slant: 0 },
  chevron: { count: 3, thickness: 0.35, angle: 110 },
  outline: { thickness: 0.06 },
  battenburg: { rows: 2, cellAspect: 1.4, phase: 0 },
  check: { rows: 4, cellAspect: 1, phase: 0 },
};

function clampNumber(value, [min, max], fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function normalizeShapeParams(shape, params) {
  const defaults = SHAPE_DEFAULTS[shape];
  if (!defaults) return null;
  const source = params && typeof params === "object" ? params : {};
  const out = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    out[key] = clampNumber(source[key], SHAPE_PARAM_LIMITS[key], fallback);
    if (key === "count" || key === "rows") out[key] = Math.round(out[key]);
  }
  return out;
}

function slantOffset(height, degrees) {
  return Math.tan((degrees * Math.PI) / 180) * height * 0.5;
}

function stripePolygons(params, width, height) {
  const { count, gap, slant } = params;
  const unit = height / (count + gap * (count - 1));
  const left = -width / 2;
  const right = width / 2;
  const polygons = [];
  for (let index = 0; index < count; index += 1) {
    const top = -height / 2 + index * unit * (1 + gap);
    const bottom = top + unit;
    const shiftTop = slantOffset(height, slant) * ((top / (height / 2)) || 0);
    const shiftBottom = slantOffset(height, slant) * ((bottom / (height / 2)) || 0);
    polygons.push([
      [left - shiftTop, top],
      [right - shiftTop, top],
      [right - shiftBottom, bottom],
      [left - shiftBottom, bottom],
    ]);
  }
  return polygons;
}

function bandPolygons(params, width, height) {
  const shift = Math.min(width / 2, Math.abs(slantOffset(height, params.slant)));
  const sign = Math.sign(params.slant);
  const left = -width / 2;
  const right = width / 2;
  const top = -height / 2;
  const bottom = height / 2;
  if (!shift) return [[[left, top], [right, top], [right, bottom], [left, bottom]]];
  return [[
    [left + shift * (1 + sign), top],
    [right - shift * (1 - sign), top],
    [right - shift * (1 + sign), bottom],
    [left + shift * (1 - sign), bottom],
  ]];
}

function chevronPolygons(params, width, height) {
  const { count, thickness, angle } = params;
  const half = width / 2;
  const bar = Math.max(0.5, (height / count) * thickness);
  const rise = Math.min(half / Math.tan((angle * Math.PI) / 360), Math.max(0, height - bar));
  const step = count > 1 ? (height - rise - bar) / (count - 1) : 0;
  const polygons = [];
  for (let index = 0; index < count; index += 1) {
    const apex = -height / 2 + index * step;
    polygons.push([
      [0, apex],
      [half, apex + rise],
      [half, apex + rise + bar],
      [0, apex + bar],
      [-half, apex + rise + bar],
      [-half, apex + rise],
    ]);
  }
  return polygons;
}

function outlinePolygons(params, width, height) {
  const inset = Math.max(0.5, Math.min(width, height) * params.thickness);
  const left = -width / 2;
  const top = -height / 2;
  const outer = [[left, top], [-left, top], [-left, -top], [left, -top]];
  if (inset * 2 >= Math.min(width, height)) return [outer];
  const inner = [[left + inset, top + inset], [left + inset, -top - inset], [-left - inset, -top - inset], [-left - inset, top + inset]];
  return [outer, inner];
}

export function patternCells(params, width, height) {
  const rows = Math.max(1, Math.round(params.rows));
  const rowHeight = height / rows;
  const cellWidth = rowHeight * params.cellAspect;
  if (!(cellWidth > 0) || !(rowHeight > 0)) return [];
  const columns = Math.ceil(width / cellWidth) + 1;
  if (rows * columns > MAX_PATTERN_CELLS) return [];
  const start = -width / 2 - params.phase * cellWidth;
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x0 = Math.max(-width / 2, start + column * cellWidth);
      const x1 = Math.min(width / 2, start + (column + 1) * cellWidth);
      if (x1 <= x0) continue;
      const y0 = -height / 2 + row * rowHeight;
      cells.push({ x: x0, y: y0, width: x1 - x0, height: rowHeight, parity: (row + column) % 2 });
    }
  }
  return cells;
}

export function shapePolygons(shape, rawParams, width, height) {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return [];
  const params = normalizeShapeParams(shape, rawParams);
  if (!params) return [];
  if (shape === "stripe") return stripePolygons(params, width, height);
  if (shape === "band") return bandPolygons(params, width, height);
  if (shape === "chevron") return chevronPolygons(params, width, height);
  if (shape === "outline") return outlinePolygons(params, width, height);
  return patternCells(params, width, height)
    .filter((cell) => cell.parity === 0)
    .map((cell) => [[cell.x, cell.y], [cell.x + cell.width, cell.y], [cell.x + cell.width, cell.y + cell.height], [cell.x, cell.y + cell.height]]);
}

export function patternSecondaryPolygons(shape, rawParams, width, height) {
  if (!PATTERN_KINDS.includes(shape)) return [];
  const params = normalizeShapeParams(shape, rawParams);
  if (!params || !(width > 0) || !(height > 0)) return [];
  return patternCells(params, width, height)
    .filter((cell) => cell.parity === 1)
    .map((cell) => [[cell.x, cell.y], [cell.x + cell.width, cell.y], [cell.x + cell.width, cell.y + cell.height], [cell.x, cell.y + cell.height]]);
}
