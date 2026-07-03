import { getVersion as getTauriAppVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import appMeta from "../../package.json";
import { getConsoleLogEntries } from "./console-log-buffer";

export const BUG_REPORT_SCHEMA_VERSION = 1;
export const BUG_REPORT_MIN_SUBMIT_MS = 2000;
export const BUG_REPORT_SUMMARY_MIN = 5;
export const BUG_REPORT_SUMMARY_MAX = 140;
export const BUG_REPORT_DETAILS_MIN = 10;
export const BUG_REPORT_DETAILS_MAX = 4000;
export const BUG_REPORT_ENDPOINT = (import.meta.env?.VITE_BUG_REPORT_ENDPOINT || "").trim();

const PRIORITY_VALUES = new Set(["normal", "high"]);

function normalizeLineEndings(value) {
  return value.replace(/\r\n?/g, "\n");
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return normalizeLineEndings(value).trim();
}

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
  const endpoint = (options.endpoint ?? BUG_REPORT_ENDPOINT).trim();
  const openedAt = options.openedAt || "";
  const now = Date.now();
  const openedAtMs = Date.parse(openedAt);

  const summary = normalizeText(draft?.summary);
  const reproSteps = normalizeText(draft?.reproSteps);
  const expectedBehavior = normalizeText(draft?.expectedBehavior);
  const actualBehavior = normalizeText(draft?.actualBehavior);
  const priority = PRIORITY_VALUES.has(draft?.priority) ? draft.priority : "normal";
  const honeypot = normalizeText(draft?.honeypot);

  const fieldErrors = {};

  if (!summary || summary.length < BUG_REPORT_SUMMARY_MIN) {
    fieldErrors.summary = `Summary must be at least ${BUG_REPORT_SUMMARY_MIN} characters.`;
  } else if (summary.length > BUG_REPORT_SUMMARY_MAX) {
    fieldErrors.summary = `Summary must be ${BUG_REPORT_SUMMARY_MAX} characters or less.`;
  }

  for (const [field, label, value] of [
    ["reproSteps", "Repro steps", reproSteps],
    ["expectedBehavior", "Expected behavior", expectedBehavior],
    ["actualBehavior", "Actual behavior", actualBehavior],
  ]) {
    if (!value || value.length < BUG_REPORT_DETAILS_MIN) {
      fieldErrors[field] = `${label} must be at least ${BUG_REPORT_DETAILS_MIN} characters.`;
    } else if (value.length > BUG_REPORT_DETAILS_MAX) {
      fieldErrors[field] = `${label} must be ${BUG_REPORT_DETAILS_MAX} characters or less.`;
    }
  }

  let formError = "";
  if (!endpoint) {
    formError = "Bug reporting is not configured in this build.";
  } else if (honeypot) {
    formError = "Bug report validation failed.";
  } else if (!Number.isFinite(openedAtMs)) {
    formError = "Bug report session expired. Please reopen the form.";
  } else if (now - openedAtMs < BUG_REPORT_MIN_SUBMIT_MS) {
    formError = "Please take a moment to describe the issue before submitting.";
  }

  return {
    fieldErrors,
    formError,
    sanitizedDraft: {
      summary,
      reproSteps,
      expectedBehavior,
      actualBehavior,
      priority,
      includeConsoleLogs: Boolean(draft?.includeConsoleLogs),
      honeypot,
    },
  };
}

export async function buildBugReportPayload(draft, options = {}) {
  const endpoint = (options.endpoint ?? BUG_REPORT_ENDPOINT).trim();
  const openedAt = options.openedAt || new Date().toISOString();
  const validation = validateBugReportDraft(draft, { endpoint, openedAt });
  if (validation.formError || Object.keys(validation.fieldErrors).length > 0) {
    const error = new Error(validation.formError || "Bug report validation failed.");
    error.fieldErrors = validation.fieldErrors;
    throw error;
  }

  const submittedAt = new Date().toISOString();
  const environment = options.environment || (await collectBugReportEnvironment());
  const logs = validation.sanitizedDraft.includeConsoleLogs ? getConsoleLogEntries() : [];

  return {
    schemaVersion: BUG_REPORT_SCHEMA_VERSION,
    createdAt: submittedAt,
    issue: {
      summary: validation.sanitizedDraft.summary,
      reproSteps: validation.sanitizedDraft.reproSteps,
      expectedBehavior: validation.sanitizedDraft.expectedBehavior,
      actualBehavior: validation.sanitizedDraft.actualBehavior,
      priority: validation.sanitizedDraft.priority,
    },
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

function escapeCodeFenceText(value) {
  return value.replace(/```/g, "``\u200b`");
}

function truncateToChars(value, maxChars) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 17))}\n...[truncated]`;
}

const BUG_REPORT_MAX_LOG_CHARS = 12000;
const BUG_REPORT_MAX_BODY_CHARS = 60000;

function formatConsoleLogBlock(payload) {
  if (!payload.consoleLogs?.included || !payload.consoleLogs.entries?.length) {
    return "Not included";
  }
  const text = payload.consoleLogs.entries
    .map((entry) => `[${entry.timestamp}] [${entry.level?.toUpperCase()}] ${entry.message}`)
    .join("\n");
  return escapeCodeFenceText(truncateToChars(text, BUG_REPORT_MAX_LOG_CHARS));
}

function buildEnvironmentBullets(env) {
  const browser = [env.browserName, env.browserVersion].filter(Boolean).join(" ") || "Unknown";
  const os = [env.osName, env.osVersion].filter(Boolean).join(" ") || "Unknown";
  return [
    `- App version: \`${env.appVersion || "unknown"}\``,
    `- Runtime: \`${env.runtime}\``,
    `- Browser: \`${browser}\``,
    `- OS: \`${os}\``,
    `- Device: \`${env.deviceType}\``,
    `- Locale: \`${env.locale || "n/a"}\``,
    `- URL: \`${env.currentUrl || "n/a"}\``,
  ].join("\n");
}

function formatBugReportIssueTitle(summary) {
  return `[Bug] ${summary}`;
}

function formatBugReportIssueBody(payload) {
  const buildBody = (logsText, metadataText) => `## Summary
${payload.issue.summary}

## Repro Steps
${payload.issue.reproSteps}

## Expected Behavior
${payload.issue.expectedBehavior}

## Actual Behavior
${payload.issue.actualBehavior}

## Priority
${payload.issue.priority === "high" ? "High" : "Normal"}

## Environment
${buildEnvironmentBullets(payload.environment)}

## Console Logs
\`\`\`text
${logsText}
\`\`\`

## Raw Metadata
\`\`\`json
${metadataText}
\`\`\`
`;

  let logsText = formatConsoleLogBlock(payload);
  let metadataText = JSON.stringify(payload.environment, null, 2);
  let body = buildBody(logsText, metadataText);

  if (body.length > BUG_REPORT_MAX_BODY_CHARS) {
    logsText = truncateToChars(logsText, Math.floor(BUG_REPORT_MAX_LOG_CHARS / 2));
    body = buildBody(logsText, metadataText);
  }
  if (body.length > BUG_REPORT_MAX_BODY_CHARS) {
    metadataText = JSON.stringify(
      {
        appVersion: payload.environment.appVersion,
        runtime: payload.environment.runtime,
        browserName: payload.environment.browserName,
        browserVersion: payload.environment.browserVersion,
        osName: payload.environment.osName,
        osVersion: payload.environment.osVersion,
        deviceType: payload.environment.deviceType,
        isIOS: payload.environment.isIOS,
        locale: payload.environment.locale,
      },
      null,
      2,
    );
    body = buildBody(logsText, metadataText);
  }

  return body;
}

function deriveBugReportLabels(payload) {
  const labels = ["bug", "from-app"];
  if (payload.environment?.runtime === "web") labels.push("web");
  if (payload.environment?.isIOS) labels.push("ios");
  if (payload.issue?.priority === "high") labels.push("high-priority");
  return labels;
}

export async function submitBugReport(payload, endpoint = BUG_REPORT_ENDPOINT) {
  if (isTauriRuntime() && (!endpoint || endpoint === "tauri://native")) {
    const title = formatBugReportIssueTitle(payload.issue.summary);
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
      throw new Error("Bug report submission timed out. Check your connection and try again.");
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
      `Bug report submission failed with HTTP ${response.status}.`;
    throw new Error(message);
  }

  return responseBody;
}
