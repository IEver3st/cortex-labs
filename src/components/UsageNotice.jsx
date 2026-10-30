import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { setUsageStatsEnabled } from "../lib/usage";
import "./UsageNotice.css";

export default function UsageNotice({ onDone }) {
  const reduceMotion = useReducedMotion();
  const [saveFailed, setSaveFailed] = useState(false);

  const turnOff = () => {
    if (!setUsageStatsEnabled(false)) {
      setSaveFailed(true);
      return;
    }
    onDone();
  };

  return (
    <motion.section
      className="usage-notice"
      role="region"
      aria-labelledby="usage-notice-title"
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
      transition={{ duration: reduceMotion ? 0 : 0.16, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <h2 id="usage-notice-title" className="usage-notice-title">Anonymous usage stats are on</h2>
      <p className="usage-notice-body">
        Studio sends a count when it opens and when you save liveries, templates, EUP packs, photos or siren setups. Each count carries a random ID and the app version, never your files or your Cortex account.
      </p>
      <p className={`usage-notice-hint ${saveFailed ? "is-error" : ""}`} role={saveFailed ? "alert" : undefined}>
        {saveFailed
          ? "Couldn't save that. Storage may be full, so nothing is sent until you choose again."
          : "You can change this any time in Settings > Privacy."}
      </p>
      <div className="usage-notice-actions">
        <button type="button" className="cx-btn is-quiet" onClick={turnOff}>Turn off</button>
        <button type="button" className="cx-btn is-primary" onClick={onDone}>OK</button>
      </div>
    </motion.section>
  );
}
