import { useCallback, useEffect, useState } from "react";
import { ExternalLink, LogOut, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { JUNO_CHANGED, JUNO_SIGN_IN, announceJunoChange, callJuno, junoError } from "../lib/juno.js";

const SENDS = "Vehicle name and details, resource folder and setting name, light count and positions, timing, colours, and your description.";
const NEVER_SENDS = "Your models, textures or files.";
const ALLOWANCE_RULE = "Each new Juno description uses a little. Automatic retries and repeat requests are free.";
const DISCORD_PATH = "M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.182 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z";
const SIGNED_OUT_ONLINE = "Signed out of your Cortex account on this PC.";
const SIGNED_OUT_OFFLINE = "Signed out on this PC. Studio ends the old session on the server the next time you sign in with this account.";

function DiscordMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d={DISCORD_PATH} />
    </svg>
  );
}

function Note({ tone, children }) {
  return (
    <p className={`settings-juno-note is-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <span className="settings-juno-dot" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function JunoPrivacy() {
  const open = (page) => invoke("juno_open", { page }).catch(() => {});
  return (
    <div className="settings-juno-privacy">
      <dl className="settings-juno-split">
        <div>
          <dt className="cx-label">Sends</dt>
          <dd>{SENDS}</dd>
        </div>
        <div className="is-never">
          <dt className="cx-label">Never sends</dt>
          <dd>{NEVER_SENDS}</dd>
        </div>
      </dl>
      <div className="settings-juno-foot">
        <span>Kept for 30 days, then deleted.</span>
        <span className="settings-juno-legal">
          <button type="button" className="settings-juno-link" onClick={() => open("terms")}>
            Terms
            <ExternalLink aria-hidden="true" />
          </button>
          <button type="button" className="settings-juno-link" onClick={() => open("privacy")}>
            Privacy
            <ExternalLink aria-hidden="true" />
          </button>
        </span>
      </div>
    </div>
  );
}

function usedPercent(account) {
  return Number.isFinite(account?.usedPct) ? Math.min(100, Math.max(0, Math.round(account.usedPct))) : null;
}

function Allowance({ account, error, onRetry }) {
  if (error) {
    return (
      <div className="settings-row">
        <div className="settings-row-label">
          <div className="settings-row-title">Monthly allowance</div>
          <div className="settings-row-desc">{error}</div>
        </div>
        <button type="button" className="settings-mini" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }
  const used = usedPercent(account);
  const full = used >= 100;
  const terms = [
    account?.plan ? `${account.plan} plan` : "",
    account?.resetsOn ? `resets ${account.resetsOn}` : "",
  ].filter(Boolean).join(", ");
  return (
    <div className={`settings-row settings-allowance${full ? " is-full" : ""}`} aria-busy={!account}>
      <div className="settings-allowance-head">
        <div className="settings-row-label">
          <div className="settings-row-title">Monthly allowance</div>
          <div className="settings-row-desc">
            {account ? (terms ? `${terms.charAt(0).toUpperCase()}${terms.slice(1)}.` : "Share used this month.") : "Loading…"}
          </div>
        </div>
        <div className="settings-allowance-figure" aria-hidden="true">
          <span className="cx-display">{used == null ? "…" : `${used}%`}</span>
          {used == null ? null : <span>used</span>}
        </div>
      </div>
      <span
        className="settings-allowance-bar"
        {...(used == null ? { "aria-hidden": true } : {
          role: "meter",
          "aria-label": "Allowance used this month",
          "aria-valuemin": 0,
          "aria-valuemax": 100,
          "aria-valuenow": used,
          "aria-valuetext": `${used}% used`,
        })}
      >
        <span style={{ width: `${used ?? 0}%` }} />
      </span>
      <div className="settings-row-desc">{full ? "Automatic retries and repeat requests are still free." : ALLOWANCE_RULE}</div>
    </div>
  );
}

export default function CortexAccountSettings({ isTauriRuntime }) {
  const [signedIn, setSignedIn] = useState(null);
  const [status, setStatus] = useState(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [phase, setPhase] = useState("idle");
  const [signIn, setSignIn] = useState(null);
  const [account, setAccount] = useState(null);
  const [accountError, setAccountError] = useState("");
  const [note, setNote] = useState(null);

  const readLocal = useCallback(() => {
    invoke("juno_local")
      .then((local) => setSignedIn(Boolean(local?.signedIn)))
      .catch((error) => {
        setSignedIn(false);
        setNote({ tone: "error", text: junoError(error).message });
      });
  }, []);

  const readStatus = useCallback(() => {
    setStatusBusy(true);
    invoke("juno_status")
      .then((value) => setStatus({ ai: value?.ai || "soon", reachable: true }))
      .catch(() => setStatus({ ai: null, reachable: false }))
      .finally(() => setStatusBusy(false));
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return undefined;
    readLocal();
    readStatus();
    window.addEventListener(JUNO_CHANGED, readLocal);
    return () => window.removeEventListener(JUNO_CHANGED, readLocal);
  }, [isTauriRuntime, readLocal, readStatus]);

  const loadAccount = useCallback(() => {
    setAccountError("");
    callJuno("juno_account")
      .then(setAccount)
      .catch((error) => {
        if (error.code === "unauthorized") setNote({ tone: "error", text: error.message });
        else setAccountError(error.message);
      });
  }, []);

  const refresh = useCallback(() => {
    readStatus();
    if (signedIn) loadAccount();
  }, [readStatus, signedIn, loadAccount]);

  useEffect(() => {
    if (signedIn) loadAccount();
    else setAccount(null);
  }, [signedIn, loadAccount]);

  useEffect(() => {
    if (!isTauriRuntime) return undefined;
    let alive = true;
    let settled = false;
    invoke("juno_sign_in_state")
      .then((current) => {
        if (!alive || settled) return;
        if (current?.active) {
          setSignIn({ userCode: current.userCode, opened: Boolean(current.opened), offline: Boolean(current.offline) });
          setPhase((value) => (value === "idle" ? "waiting" : value));
        } else if (current?.error?.message && current.error.code !== "cancelled") {
          setNote({ tone: "error", text: current.error.message });
        }
      })
      .catch(() => {});
    const onSignIn = (event) => {
      const detail = event.detail || {};
      if (detail.status === "offline" || detail.status === "waiting") {
        setSignIn((current) => (current ? { ...current, offline: detail.status === "offline" } : current));
        return;
      }
      settled = true;
      setPhase("idle");
      setSignIn(null);
      if (detail.status === "done") {
        setSignedIn(true);
        setNote({ tone: "ok", text: "Signed in." });
        readStatus();
      } else if (detail.code !== "cancelled") {
        setNote({ tone: "error", text: detail.message || "Sign-in didn't finish. Sign in again to retry." });
      }
    };
    window.addEventListener(JUNO_SIGN_IN, onSignIn);
    return () => {
      alive = false;
      window.removeEventListener(JUNO_SIGN_IN, onSignIn);
    };
  }, [isTauriRuntime, readStatus]);

  const cancel = () => {
    invoke("juno_sign_in_cancel").catch(() => {});
    setPhase("idle");
    setSignIn(null);
  };

  const reopen = () => {
    invoke("juno_sign_in_reopen")
      .then(() => setSignIn((current) => (current ? { ...current, opened: true } : current)))
      .catch((error) => {
        const failure = junoError(error);
        if (failure.code === "cancelled") {
          setPhase("idle");
          setSignIn(null);
        }
        setNote({ tone: "error", text: failure.message });
      });
  };

  const start = async () => {
    setPhase("starting");
    setNote(null);
    try {
      const started = await callJuno("juno_sign_in_start");
      setSignIn({ userCode: started?.userCode || "", opened: Boolean(started?.opened), offline: false });
      setPhase((value) => (value === "starting" ? "waiting" : value));
    } catch (error) {
      setPhase("idle");
      setNote({ tone: "error", text: error.message });
    }
  };

  const signOut = async () => {
    setPhase("leaving");
    setNote(null);
    try {
      const out = await callJuno("juno_sign_out");
      setNote({ tone: "idle", text: out?.offline ? SIGNED_OUT_OFFLINE : SIGNED_OUT_ONLINE });
    } catch (error) {
      setNote({ tone: "error", text: error.message });
    } finally {
      setPhase("idle");
      announceJunoChange();
    }
  };

  if (!isTauriRuntime) {
    return (
      <section className="settings-panel">
        <div className="settings-panel-title">Cortex account</div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-title">Desktop only</div>
            <div className="settings-row-desc">Sign in from the Cortex Studio desktop app.</div>
          </div>
        </div>
      </section>
    );
  }

  const checking = signedIn === null || !status;
  const closed = status?.reachable && status.ai !== "open";

  let accountRow;
  if (signedIn) {
    accountRow = (
      <div className="settings-row settings-account-id">
        <div className="settings-row-label">
          {account?.name ? (
            <>
              <div className="settings-account-name cx-display" title={account.name}>{account.name}</div>
              <div className="settings-row-desc settings-account-via">
                <DiscordMark />
                Signed in with Discord
              </div>
            </>
          ) : (
            <div className="settings-row-title settings-account-via">
              <DiscordMark />
              Signed in with Discord
            </div>
          )}
        </div>
        <button type="button" className="settings-mini" onClick={signOut} disabled={phase === "leaving"}>
          <LogOut aria-hidden="true" />
          {phase === "leaving" ? "Signing out…" : "Sign out"}
        </button>
      </div>
    );
  } else if (phase === "waiting" && signIn) {
    accountRow = (
      <div className="settings-row">
        <div className="settings-row-label">
          <div className="settings-row-title settings-juno-state">
            <span className={`settings-juno-dot ${signIn.offline ? "is-warn" : "is-live"}`} aria-hidden="true" />
            {signIn.offline ? "Can't reach Cortex" : "Waiting for approval"}
          </div>
          <div className="settings-row-desc">
            {signIn.offline
              ? "Studio keeps trying. Approve on gsdmods.com when you're back online."
              : signIn.opened
                ? "Approve on gsdmods.com and check it shows this code."
                : "Open gsdmods.com to approve, and check it shows this code."}
          </div>
        </div>
        <div className="settings-juno-actions">
          {signIn.userCode ? (
            <>
              <span className="sr-only">Sign-in code</span>
              <span className="settings-account-code">{signIn.userCode}</span>
            </>
          ) : null}
          <button type="button" className="settings-mini" onClick={reopen}>
            <ExternalLink aria-hidden="true" />
            {signIn.opened ? "Open again" : "Open gsdmods.com"}
          </button>
          <button type="button" className="settings-mini is-quiet" onClick={cancel}>Cancel</button>
        </div>
      </div>
    );
  } else {
    accountRow = (
      <div className="settings-row">
        <div className="settings-row-label">
          <div className="settings-row-title">Not signed in</div>
          <div className="settings-row-desc">
            {signedIn === null
              ? "Checking…"
              : "Optional and free, for Juno and Cortex Forge. You sign in on gsdmods.com with Discord (verified email)."}
          </div>
        </div>
        {signedIn === null ? null : (
          <button type="button" className="settings-mini is-primary settings-juno-discord" onClick={start} disabled={phase === "starting"}>
            <DiscordMark />
            {phase === "starting" ? "Opening gsdmods.com…" : "Sign in with Discord"}
          </button>
        )}
      </div>
    );
  }

  const used = usedPercent(account);
  const junoStatus = checking
    ? { tone: "idle", title: "Checking…" }
    : !status.reachable
      ? { tone: "error", title: "Can't reach Juno", retry: !accountError }
      : closed
        ? { tone: "warn", title: "Not open yet" }
        : signedIn && used >= 100
          ? { tone: "warn", title: "Allowance used" }
          : signedIn
            ? { tone: "ok", title: "Ready" }
            : phase === "starting" || phase === "waiting"
              ? { tone: "idle", title: "Waiting for sign-in" }
              : { tone: "idle", title: "Needs sign-in" };

  return (
    <>
      <section className="settings-panel">
        {accountRow}
        {signedIn ? <Allowance account={account} error={accountError} onRetry={refresh} /> : null}
        {note ? <Note tone={note.tone}>{note.text}</Note> : null}
      </section>
      <section className="settings-panel">
        <div className="settings-panel-heading-row">
          <div>
            <div className="settings-panel-title">Juno</div>
            <p className="settings-panel-description">Writes siren patterns from a description. Open a vehicle's sirens to use it.</p>
          </div>
          <div className={`settings-juno-status is-${junoStatus.tone}`}>
            <span className="settings-juno-dot" aria-hidden="true" />
            <span role="status">{junoStatus.title}</span>
            {junoStatus.retry ? (
              <button type="button" className="settings-mini" onClick={refresh} disabled={statusBusy}>
                <RefreshCw aria-hidden="true" />
                {statusBusy ? "Checking…" : "Try again"}
              </button>
            ) : null}
          </div>
        </div>
        <JunoPrivacy />
      </section>
    </>
  );
}
