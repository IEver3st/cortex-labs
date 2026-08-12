export const LIGHT_DOME_CENTER = 50;
export const LIGHT_DOME_RADIUS = 40;

export function clampLightElevation(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(90, parsed));
}

export function normalizeLightAzimuth(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return ((parsed % 360) + 360) % 360;
}

export function projectLightDirection(
  azimuth,
  elevation,
  { centerX = LIGHT_DOME_CENTER, centerY = LIGHT_DOME_CENTER, radius = LIGHT_DOME_RADIUS } = {},
) {
  const normalizedAzimuth = normalizeLightAzimuth(azimuth);
  const clampedElevation = clampLightElevation(elevation);
  const azimuthRadians = normalizedAzimuth * (Math.PI / 180);
  const projectedRadius = ((90 - clampedElevation) / 90) * radius;

  return {
    x: centerX + projectedRadius * Math.sin(azimuthRadians),
    y: centerY - projectedRadius * Math.cos(azimuthRadians),
  };
}

export function lightDirectionFromPoint(
  x,
  y,
  { centerX = LIGHT_DOME_CENTER, centerY = LIGHT_DOME_CENTER, radius = LIGHT_DOME_RADIUS } = {},
) {
  const dx = Number(x) - centerX;
  const dy = centerY - Number(y);
  const distance = Math.sqrt((dx * dx) + (dy * dy));
  const clampedDistance = Math.min(distance, radius);
  const rawAzimuth = Math.atan2(dx, dy) * (180 / Math.PI);

  return {
    azimuth: Math.round(normalizeLightAzimuth(rawAzimuth)),
    elevation: Math.round(90 - ((clampedDistance / radius) * 90)),
  };
}

export function getLightCompassLabel(azimuth) {
  const labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return labels[Math.round(normalizeLightAzimuth(azimuth) / 45) % labels.length];
}
