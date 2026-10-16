import { useEffect, useRef, useState } from "react";
import { loadPrefs, PREFS_UPDATED_EVENT } from "./prefs";
import { DEFAULT_HOTKEYS, findMatchingAction, mergeHotkeys } from "./hotkeys.js";

export function loadStoredHotkeys() {
  const stored = loadPrefs()?.hotkeys;
  return mergeHotkeys(stored && typeof stored === "object" ? stored : {}, DEFAULT_HOTKEYS);
}

/** The user's bindings, reloaded when Settings saves preferences. */
export function useStoredHotkeys() {
  const [hotkeys, setHotkeys] = useState(loadStoredHotkeys);
  useEffect(() => {
    const reload = () => setHotkeys(loadStoredHotkeys());
    window.addEventListener(PREFS_UPDATED_EVENT, reload);
    return () => window.removeEventListener(PREFS_UPDATED_EVENT, reload);
  }, []);
  return hotkeys;
}

function isTypingTarget(target) {
  return target instanceof Element
    && Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='listbox'], .hotkey-input"));
}

/**
 * Runs the user's customizable bindings on a page that is not a viewer tab.
 * `handlers` maps a HOTKEY_ACTIONS id to the page's own function for it; a
 * handler that returns false leaves the key press alone (the page has no such
 * shot right now, for example). Returns the bindings for shortcut hints.
 */
export function useWorkspaceHotkeys({ isActive, enabled = true, handlers }) {
  const hotkeys = useStoredHotkeys();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!isActive || !enabled) return undefined;
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.repeat || isTypingTarget(event.target)) return;
      const current = handlersRef.current || {};
      const actions = Object.keys(current).filter((action) => typeof current[action] === "function");
      const action = findMatchingAction(hotkeys, event, actions);
      if (!action || current[action](event) === false) return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, hotkeys, isActive]);

  return hotkeys;
}
