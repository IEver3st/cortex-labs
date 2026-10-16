import { useCallback, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { characterKey, normalizeCharacterModel, pedGenderHint, withCharacterVariation } from "../../lib/ped-character";

const PED_FILE_FILTERS = [{ name: "Ped files", extensions: ["ymt", "yft", "ydd", "ytd"] }];

/**
 * Controls for the focused cast member's character: which ped it is, and for
 * a game ped or the user's ped, the drawables, textures and props it wears.
 * `onModelChange({ model, previous })` runs after the ped changes; `onError`
 * gets a picker failure.
 */
export function useEupCharacter({ cast, setCast, focusRef, onModelChange, onError }) {
  const castRef = useRef(cast);
  castRef.current = cast;

  const setModel = useCallback((next) => {
    const seat = focusRef.current;
    const current = castRef.current?.[seat];
    if (!current) return;
    const model = normalizeCharacterModel(next, next?.gender || current.gender);
    // A game ped's name says its gender (s_f_y_cop_01), which picks the
    // preset clips; otherwise the character keeps the one it had.
    const gender = model.kind === "freemode" ? model.gender : pedGenderHint(model.ped) || current.gender;
    if (characterKey(model) === characterKey(current.model) && gender === current.gender) return;
    setCast((prev) => (prev[seat] ? { ...prev, [seat]: { ...prev[seat], model, gender } } : prev));
    onModelChange?.({ model, previous: current.model });
  }, [setCast, focusRef, onModelChange]);

  const setVariation = useCallback((next) => {
    setCast((prev) => {
      const seat = focusRef.current;
      const current = prev[seat];
      if (!current) return prev;
      const key = characterKey(current.model);
      const value = typeof next === "function" ? next(current.variations?.[key]) : next;
      return { ...prev, [seat]: { ...current, variations: withCharacterVariation(current.variations, key, value) } };
    });
  }, [setCast, focusRef]);

  const pickPaths = useCallback(async (directory) => {
    try {
      const picked = directory
        ? await open({ directory: true, recursive: true, multiple: false, title: "Open a ped folder" })
        : await open({ multiple: true, filters: PED_FILE_FILTERS, title: "Pick the ped's files" });
      const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
      if (paths.length > 0) setModel({ kind: "file", ped: "", paths });
    } catch (error) {
      onError?.(error);
    }
  }, [setModel, onError]);

  const pickFolder = useCallback(() => pickPaths(true), [pickPaths]);
  const pickFiles = useCallback(() => pickPaths(false), [pickPaths]);

  return { setModel, setVariation, pickFolder, pickFiles };
}
