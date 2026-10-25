import { useCallback, useEffect, useMemo, useRef } from "react";

export default function usePatternClock(running, speed) {
  const time = useRef(0);
  const listeners = useRef(new Set());

  useEffect(() => {
    if (!running || !(speed > 0)) return undefined;
    let last = null;
    let frame = requestAnimationFrame(function tick(now) {
      if (last != null) time.current += ((now - last) / 1000) * speed;
      last = now;
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [running, speed]);

  const get = useCallback(() => time.current, []);
  const set = useCallback((seconds) => {
    time.current = Math.max(0, Number(seconds) || 0);
    for (const listener of listeners.current) listener();
  }, []);
  const subscribe = useCallback((listener) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);

  return useMemo(() => ({ get, set, subscribe }), [get, set, subscribe]);
}
