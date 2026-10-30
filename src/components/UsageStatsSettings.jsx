import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "./ui/toggle";
import { USAGE_CHANGED_EVENT, holdUsageStats, resetUsageInstallId, usageInstallId, usageStatsAvailable } from "../lib/usage";

const USAGE_FACTS = [
  ["Sends", "A random ID made on this PC, the app version, and one event: Studio opened, or how many liveries, templates, EUP packs, photos or siren setups you saved."],
  ["Never sends", "Your files, their names or folders, details about your PC, or your Cortex account."],
  ["Kept", "Counts with the ID for 400 days. Totals without it stay."],
];

export default function UsageStatsSettings({ enabled, onChange }) {
  const available = usageStatsAvailable();
  const [installId, setInstallId] = useState(() => (available ? usageInstallId() : null));
  const [resetFailed, setResetFailed] = useState(false);

  useEffect(() => {
    if (!available) return undefined;
    const sync = () => setInstallId(usageInstallId());
    window.addEventListener(USAGE_CHANGED_EVENT, sync);
    return () => window.removeEventListener(USAGE_CHANGED_EVENT, sync);
  }, [available]);

  useEffect(() => holdUsageStats(!enabled), [enabled]);

  const newId = () => {
    const next = resetUsageInstallId();
    setResetFailed(!next);
    if (next) setInstallId(next);
  };

  return (
    <section className="settings-panel">
      <div className="settings-panel-title">Usage stats</div>
      <div className="settings-row">
        <div className="settings-row-label">
          <div className="settings-row-title">Share usage stats</div>
          <div className="settings-row-desc">
            {available
              ? "Count launches and saves so Cortex can see how many people use Studio. Turning it off stops every count."
              : "Only the desktop app sends counts. This browser preview sends nothing."}
          </div>
        </div>
        <Toggle checked={enabled} onChange={onChange} ariaLabel="Share anonymous usage stats" />
      </div>
      {available ? (
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-title">Usage ID</div>
            <div className="settings-row-desc">
              {resetFailed
                ? "Couldn't save a new ID. Storage may be full; the old ID stays."
                : "Random, and not linked to you, your PC or your Cortex account. A new ID makes this PC count as a new install."}
            </div>
          </div>
          <div className="settings-row-actions">
            <code className="settings-usage-id" title={installId || ""}>{installId || "None"}</code>
            <button type="button" className="settings-mini" onClick={newId}>
              <RefreshCw aria-hidden="true" />
              New ID
            </button>
          </div>
        </div>
      ) : null}
      <div className="settings-juno-facts">
        <dl>
          {USAGE_FACTS.map(([term, text]) => (
            <div key={term}>
              <dt className="cx-label">{term}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
        {available ? (
          <p className="settings-juno-legal">
            <button type="button" className="settings-juno-link" onClick={() => invoke("juno_open", { page: "privacy" }).catch(() => {})}>
              Privacy policy
              <ExternalLink aria-hidden="true" />
            </button>
          </p>
        ) : null}
      </div>
    </section>
  );
}
