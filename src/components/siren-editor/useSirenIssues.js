import { useMemo } from "react";
import { checkSirenSetting } from "../../lib/siren-settings.js";
import { sirenBonesFrom } from "./useSirenResource.js";

function normalizePath(path) {
  return String(path || "").replace(/\\/g, "/").toLowerCase();
}

/** Checks on the siren draft; errors block saving. */
export default function useSirenIssues(s) {
  const editor = s.sirenEditor;
  const draft = editor?.draft;
  const base = editor?.base;
  const context = s.vehicleLights?.sirenContext || null;
  const modelLights = s.metaModelInfo?.lights;
  const sirenBones = useMemo(() => sirenBonesFrom(modelLights), [modelLights]);
  const issues = useMemo(() => {
    if (!draft) return [];
    // The setting being edited is not a clash with itself.
    const others = (context?.settings || []).filter((entry) =>
      !(base && entry.id === base.id && normalizePath(entry.sourcePath) === normalizePath(base.sourcePath)));
    return checkSirenSetting(draft, {
      sirenBones,
      otherSettings: others,
      variationId: context ? context.variationId : undefined,
    });
  }, [draft, base, context, sirenBones]);
  return { issues, blocking: issues.filter((entry) => entry.severity === "error") };
}
