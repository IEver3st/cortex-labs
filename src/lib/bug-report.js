import { getVersion as getTauriAppVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import appMeta from "../../package.json";
import { getConsoleLogEntries } from "./console-log-buffer.js";
import {
  BUG_REPORT_SCHEMA_VERSION,
  buildBugReportIssue,
  deriveBugReportLabels,
  formatBugReportIssueBody,
  formatBugReportIssueTitle,
  validateBugReportDraft as validateBugReportDraftCore,
} from "./bug-report-core.js";
export {
  BUG_REPORT_SCHEMA_VERSION,
  BUG_REPORT_MIN_SUBMIT_MS,
  BUG_REPORT_SUMMARY_MIN,
  BUG_REPORT_SUMMARY_MAX,
  BUG_REPORT_DETAILS_MIN,
  BUG_REPORT_DETAILS_MAX,
  buildBugReportIssue,
  deriveBugReportLabels,
  formatBugReportIssueBody,
  formatBugReportIssueTitle,
} from "./bug-report-core.js";

export const BUG_REPORT_ENDPOINT = (import.meta.env?.VITE_BUG_REPORT_ENDPOINT || "").trim();

export function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function"
  );
}

function parseVersion(ua, pattern) {
  const match = ua.match(pattern);
  return match?.[1]?.replace(/_/g, ".") || null;
}

function parseEnvironmentFromUserAgent(userAgent) {
  const ua = typeof userAgent === "string" ? userAgent : "";
  const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1);
  const isIPhone = /iPhone|iPod/.test(ua);
  const isIOS = isIPad || isIPhone;
  const isAndroid = /Android/.test(ua);
  const isMobile = isIPhone || /Android.*Mobile|Mobile|Windows Phone/i.test(ua);
  const isTablet = isIPad || (/Android/.test(ua) && !/Mobile/i.test(ua)) || /Tablet|Nexus 7|Nexus 10|SM-T/i.test(ua);

  let browserName = "Unknown";
  let browserVersion = null;
  if (/Edg\//.test(ua)) {
    browserName = "Edge";
    browserVersion = parseVersion(ua, /Edg\/([\d.]+)/);
  } else if (/OPR\//.test(ua)) {
    browserName = "Opera";
    browserVersion = parseVersion(ua, /OPR\/([\d.]+)/);
  } else if (/Firefox\/|FxiOS\//.test(ua)) {
    browserName = "Firefox";
    browserVersion = parseVersion(ua, /(?:Firefox|FxiOS)\/([\d.]+)/);
  } else if (/Chrome\/|CriOS\//.test(ua)) {
    browserName = "Chrome";
    browserVersion = parseVersion(ua, /(?:Chrome|CriOS)\/([\d.]+)/);
  } else if (/Safari\//.test(ua)) {
    browserName = "Safari";
    browserVersion = parseVersion(ua, /Version\/([\d.]+)/) || parseVersion(ua, /Safari\/([\d.]+)/);
  }

  let osName = "Unknown";
  let osVersion = null;
  if (isIOS) {
    osName = "iOS";
    osVersion = parseVersion(ua, /OS ([\d_]+)/);
  } else if (isAndroid) {
    osName = "Android";
    osVersion = parseVersion(ua, /Android ([\d.]+)/);
  } else if (/Windows NT/.test(ua)) {
    osName = "Windows";
    osVersion = parseVersion(ua, /Windows NT ([\d.]+)/);
  } else if (/Mac OS X/.test(ua)) {
    osName = "macOS";
    osVersion = parseVersion(ua, /Mac OS X ([\d_]+)/);
  } else if (/Linux/.test(ua)) {
    osName = "Linux";
  }

  return {
    browserName,
    browserVersion,
    osName,
    osVersion,
    deviceType: isTablet ? "tablet" : isMobile ? "mobile" : "desktop",
    isIOS,
  };
}

export async function resolveAppVersion() {
  if (isTauriRuntime()) {
    try {
      const version = await getTauriAppVersion();
      if (typeof version === "string" && version.trim()) return version.trim();
    } catch {
      // Fall back to the web package version when the Tauri API is unavailable.
    }
  }
  return appMeta.version;
}

export async function collectBugReportEnvironment() {
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const locale = typeof navigator !== "undefined" ? navigator.language : null;
  const parsed = parseEnvironmentFromUserAgent(userAgent);

  return {
    appVersion: await resolveAppVersion(),
    runtime: isTauriRuntime() ? "tauri" : "web",
    browserName: parsed.browserName,
    browserVersion: parsed.browserVersion,
    osName: parsed.osName,
    osVersion: parsed.osVersion,
    deviceType: parsed.deviceType,
    isIOS: parsed.isIOS,
    userAgent,
    locale,
    currentUrl:
      typeof window !== "undefined" && !isTauriRuntime() && window.location
        ? window.location.href
        : null,
  };
}

export function getBugReportEndpoint() {
  if (BUG_REPORT_ENDPOINT) return BUG_REPORT_ENDPOINT;
  if (isTauriRuntime()) return "tauri://native";
  return "";
}

export function formatEnvironmentSummary(environment) {
  if (!environment) return [];
  return [
    { label: "App version", value: environment.appVersion || "Unknown" },
    { label: "Runtime", value: environment.runtime || "Unknown" },
    {
      label: "Browser",
      value: [environment.browserName, environment.browserVersion].filter(Boolean).join(" ") || "Unknown",
    },
    {
      label: "OS / device",
      value: [environment.osName, environment.osVersion, `(${environment.deviceType || "unknown"})`]
        .filter(Boolean)
        .join(" "),
    },
  ];
}

export function validateBugReportDraft(draft, options = {}) {
  return validateBugReportDraftCore(draft, {
    ...options,
    endpoint: options.endpoint ?? BUG_REPORT_ENDPOINT,
  });
}

export async function buildBugReportPayload(draft, options = {}) {
  const endpoint = (options.endpoint ?? BUG_REPORT_ENDPOINT).trim();
  const openedAt = options.openedAt || new Date().toISOString();
  const validation = validateBugReportDraft(draft, { endpoint, openedAt });
  if (validation.formError || Object.keys(validation.fieldErrors).length > 0) {
    const error = new Error(validation.formError || "Feedback validation failed.");
    error.fieldErrors = validation.fieldErrors;
    throw error;
  }

  const submittedAt = new Date().toISOString();
  const environment = options.environment || (await collectBugReportEnvironment());
  const logs = validation.sanitizedDraft.includeConsoleLogs ? getConsoleLogEntries() : [];

  return {
    schemaVersion: BUG_REPORT_SCHEMA_VERSION,
    createdAt: submittedAt,
    issue: buildBugReportIssue(validation.sanitizedDraft),
    environment,
    consoleLogs: {
      included: validation.sanitizedDraft.includeConsoleLogs,
      entries: logs,
    },
    antiAbuse: {
      honeypot: validation.sanitizedDraft.honeypot,
      openedAt,
      submittedAt,
    },
  };
}

export async function submitBugReport(payload, endpoint = BUG_REPORT_ENDPOINT) {
  if (isTauriRuntime() && (!endpoint || endpoint === "tauri://native")) {
    const title = formatBugReportIssueTitle(payload.issue);
    const body = formatBugReportIssueBody(payload);
    const labels = deriveBugReportLabels(payload);
    const result = await invoke("submit_bug_report", {
      payload: { title, body, labels },
    });
    return {
      ok: true,
      issueNumber: result.issue_number,
      issueUrl: result.issue_url,
    };
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error("Feedback submission timed out. Check your connection and try again.");
    }
    throw err;
  }

  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  if (!response.ok || !responseBody?.ok) {
    const message =
      responseBody?.error ||
      `Feedback submission failed with HTTP ${response.status}.`;
    throw new Error(message);
  }

  return responseBody;
}
