import { memo } from "react";
import { AlertTriangle, Check, Info } from "lucide-react";
import { baseName } from "../../lib/eup";

function EupIssuesPanel({ issues }) {
  if (!issues || issues.length === 0) {
    return (
      <div className="eup-empty">
        <Check className="eup-empty-icon is-ok" aria-hidden="true" />
        <p className="eup-empty-title">No naming issues</p>
        <p className="eup-empty-desc">Every file pairs a drawable with its textures and uses lowercase names.</p>
      </div>
    );
  }

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity !== "error");

  return (
    <section className="lv-group">
      <div className="lv-group-head">
        <h3 className="lv-group-title">File names</h3>
        <span className="eup-issues-count">
          {errors.length > 0 ? <span className="is-error">{errors.length} {errors.length === 1 ? "error" : "errors"}</span> : null}
          {warnings.length > 0 ? <span>{warnings.length} {warnings.length === 1 ? "warning" : "warnings"}</span> : null}
        </span>
      </div>
      <ul className="eup-issues">
        {[...errors, ...warnings].map((issue, index) => (
          <li key={`${issue.code}-${issue.path || index}-${index}`} className={`eup-issue ${issue.severity === "error" ? "is-error" : ""}`}>
            {issue.severity === "error" ? (
              <AlertTriangle className="eup-issue-icon" role="img" aria-label="Error" />
            ) : (
              <Info className="eup-issue-icon" role="img" aria-label="Warning" />
            )}
            <div className="eup-issue-body">
              <span className="eup-issue-message">{issue.message}</span>
              {issue.path && <span className="eup-issue-path" title={issue.path}>{baseName(issue.path)}</span>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default memo(EupIssuesPanel);
