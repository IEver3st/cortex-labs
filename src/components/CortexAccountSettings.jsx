import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, LogOut, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { JUNO_CHANGED, announceJunoChange, callJuno, junoError } from "../lib/juno.js";

const DATA_FACTS = [
  ["Sends", "Vehicle name and details, resource folder and setting name, light count and positions, timing, colours, and your description."],
  ["Never sends", "Your models, textures or files."],
  ["Kept", "30 days, then deleted."],
  ["Allowance", "Each new description uses a little of the monthly allowance. Juno's automatic retry and repeat requests are free."],
];
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

function JunoFacts() {
  const open = (page) => invoke("juno_open", { page }).catch(() => {});
  return (
    <div className="settings-juno-facts">
      <dl>
        {DATA_FACTS.map(([term, text]) => (
          <div key={term}>
            <dt className="cx-label">{term}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
      <p className="settings-juno-legal">
        <button type="button" className="settings-juno-link" onClick={() => open("terms")}>
          Terms
          <ExternalLink aria-hidden="true" />
        </button>
        <button type="button" className="settings-juno-link" onClick={() => open("privacy")}>
          Privacy
          <ExternalLink aria-hidden="true" />
        </button>
      </p>
    </div>
  );
}

function usedPercent(account) {
  return Number.isFinite(account?.usedPct) ? Math.min(100, Math.max(0, Math.round(account.usedPct))) : null;
}

function AccountDetails({ account, error, onRetry }) {
  if (error) {
    return (
      <div className="settings-row">
        <div className="settings-row-label">
          <div className="settings-row-title">This month</div>
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
  const plan = account?.plan ? `${account.plan} plan.` : "";
  const resets = account?.resetsOn ? `Resets on ${account.resetsOn}.` : "";
  return (
    <div className="settings-row" aria-busy={!account}>
      <div className="settings-row-label">
        <div className="settings-row-title">This month</div>
        <div className="settings-row-desc">{account ? [plan, resets].filter(Boolean).join(" ") || "Share of the monthly allowance used." : "…"}</div>
      </div>
      <div className="settings-juno-usage">
        <span
          className={`settings-juno-bar${used >= 100 ? " is-full" : ""}`}
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
        <span className="settings-juno-value is-mono">{used == null ? "…" : `${used}% used`}</span>
      </div>
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
  const waiting = useRef(false);

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
    waiting.current = phase === "waiting";
    if (phase !== "waiting" || !signIn) return undefined;
    let timer = null;
    let stopped = false;
    const poll = () => {
      callJuno("juno_sign_in_poll")
        .then((answer) => {
          if (stopped) return;
          if (answer?.status === "done") {
            setPhase("idle");
            setSignIn(null);
            setNote({ tone: "ok", text: "Signed in." });
            announceJunoChange();
            readStatus();
            return;
          }
          timer = setTimeout(poll, signIn.interval * 1000);
        })
        .catch((error) => {
          if (stopped) return;
          setPhase("idle");
          setSignIn(null);
          if (error.code !== "cancelled") setNote({ tone: "error", text: error.message });
        });
    };
    timer = setTimeout(poll, signIn.interval * 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [phase, signIn, readStatus]);

  useEffect(() => () => {
    if (waiting.current) invoke("juno_sign_in_cancel").catch(() => {});
  }, []);

  const cancel = () => {
    if (phase === "waiting") invoke("juno_sign_in_cancel").catch(() => {});
    setPhase("idle");
    setSignIn(null);
  };

  const start = async () => {
    setPhase("starting");
    setNote(null);
    try {
      const started = await callJuno("juno_sign_in_start");
      setSignIn(started);
      setPhase("waiting");
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
      <div className="settings-row">
        <div className="settings-row-label">
          {account?.name ? (
            <>
              <div className="settings-juno-name cx-display" title={account.name}>{account.name}</div>
              <div className="settings-row-desc settings-juno-via">
                <DiscordMark />
                Signed in with Discord
              </div>
            </>
          ) : (
            <div className="settings-row-title settings-juno-via">
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
            <span className="settings-juno-dot is-live" aria-hidden="true" />
            Waiting for Discord
          </div>
          <div className="settings-row-desc">
            {signIn.userCode
              ? `${signIn.opened ? "Approve in your browser" : "Open the sign-in page"} and check it shows this code.`
              : signIn.opened ? "Approve the sign-in in your browser." : "Open the sign-in page to approve it."}
          </div>
        </div>
        <div className="settings-juno-actions">
          {signIn.userCode ? <span className="settings-juno-value is-mono settings-juno-code">{signIn.userCode}</span> : null}
          <button type="button" className="settings-mini" onClick={() => invoke("juno_sign_in_reopen", { url: signIn.url })
            .then(() => setSignIn((current) => (current ? { ...current, opened: true } : current)))
            .catch((error) => setNote({ tone: "error", text: junoError(error).message }))}>
            <ExternalLink aria-hidden="true" />
            {signIn.opened ? "Open again" : "Open sign-in page"}
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
            {checking ? "Checking…" : closed ? "Sign-in opens when Juno does." : "Free. Needs a Discord account with a verified email."}
          </div>
        </div>
        {!checking && !closed ? (
          <button type="button" className="settings-mini is-primary settings-juno-discord" onClick={start} disabled={phase === "starting"}>
            <DiscordMark />
            {phase === "starting" ? "Opening Discord…" : "Sign in with Discord"}
          </button>
        ) : null}
      </div>
    );
  }

  const used = usedPercent(account);
  const junoStatus = checking
    ? { tone: "idle", title: "Checking…" }
    : !status.reachable
      ? { tone: "error", title: "Can't reach Juno", desc: accountError ? undefined : "Check your connection and try again.", retry: !accountError }
      : closed
        ? { tone: "warn", title: "Not open yet" }
        : signedIn && used >= 100
          ? { tone: "warn", title: "Allowance used" }
          : signedIn
            ? { tone: "ok", title: "Ready", desc: "Open a vehicle's sirens and describe the lights." }
            : phase === "starting" || phase === "waiting"
              ? { tone: "idle", title: "Waiting for sign-in" }
              : { tone: "idle", title: "Needs sign-in" };

  return (
    <>
      <section className="settings-panel">
        <div className="settings-panel-title">Sign-in and usage</div>
        <p className="settings-panel-description">Optional. One account for Juno and Cortex Forge; the rest of Studio works without it.</p>
        {accountRow}
        {signedIn ? <AccountDetails account={account} error={accountError} onRetry={refresh} /> : null}
        {note ? <Note tone={note.tone}>{note.text}</Note> : null}
      </section>
      <section className="settings-panel">
        <div className="settings-panel-title">Juno</div>
        <p className="settings-panel-description">Writes siren patterns from a description, in the Sirens editor.</p>
        <div className={`settings-row settings-juno-status is-${junoStatus.tone}`}>
          <div className="settings-row-label">
            <div className="settings-row-title settings-juno-state">
              <span className="settings-juno-dot" aria-hidden="true" />
              {junoStatus.title}
            </div>
            {junoStatus.desc ? <div className="settings-row-desc">{junoStatus.desc}</div> : null}
          </div>
          {junoStatus.retry ? (
            <button type="button" className="settings-mini" onClick={refresh} disabled={statusBusy}>
              <RefreshCw aria-hidden="true" />
              {statusBusy ? "Checking…" : "Try again"}
            </button>
          ) : null}
        </div>
        <JunoFacts />
      </section>
    </>
  );
}
