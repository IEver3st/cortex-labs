import { useEffect, useRef } from "react";
import "./ReplacePrompt.css";

/**
 * Asks before an export overwrites files that already exist, with the same
 * wording and actions as the EUP export prompt. Nothing is written until the
 * user confirms.
 */
export default function ReplacePrompt({ conflicts, total, folder, onConfirm, onCancel }) {
  const ref = useRef(null);

  // The prompt opens under the export button, which can sit below the fold of
  // a scrolling dock on a short window; bring it into view so the export
  // click visibly asks something.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    for (let el = node.parentElement; el; el = el.parentElement) {
      const { overflowY } = window.getComputedStyle(el);
      if (overflowY !== "auto" && overflowY !== "scroll") continue;
      const box = el.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      if (rect.top < box.top || rect.bottom > box.bottom) node.scrollIntoView({ block: "nearest" });
      return;
    }
  }, []);

  return (
    <div className="lv-replace" role="alert" ref={ref}>
      <p>
        {conflicts} of {total} {total === 1 ? "file already exists" : "files already exist"} in{" "}
        <code title={folder}>{folder}</code>. Replace {conflicts === 1 ? "it" : "them"}?
      </p>
      <div className="lv-slot-actions">
        <button type="button" className="cx-btn is-danger lv-btn-sm" onClick={onConfirm}>
          Replace {conflicts} {conflicts === 1 ? "file" : "files"}
        </button>
        <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
