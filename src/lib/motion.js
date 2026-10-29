export function prefersReducedMotion() {
  if (typeof document === "undefined") return true;
  if (document.documentElement.dataset.motion === "reduce") return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
