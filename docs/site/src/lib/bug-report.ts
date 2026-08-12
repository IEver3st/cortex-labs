export type BugPriority = "normal" | "high";
export type ReportType = "bug" | "feature";
export type ConsoleLogLevel = "log" | "info" | "warn" | "error" | "debug";

type BugIssue = {
  reportType: "bug";
  summary: string;
  reproSteps: string;
  expectedBehavior: string;
  actualBehavior: string;
  priority: BugPriority;
};

type FeatureIssue = {
  reportType: "feature";
  summary: string;
  featureProblem: string;
  featureOutcome: string;
  featureValue: string;
  priority: BugPriority;
};

export type BugReportPayload = {
  schemaVersion: 2;
  createdAt: string;
  issue: BugIssue | FeatureIssue;
  environment: {
    appVersion: string;
    runtime: "web" | "tauri";
    browserName: string;
    browserVersion: string | null;
    osName: string;
    osVersion: string | null;
    deviceType: "desktop" | "tablet" | "mobile";
    isIOS: boolean;
    userAgent: string;
    locale: string | null;
    currentUrl: string | null;
  };
  consoleLogs: {
    included: boolean;
    entries: Array<{
      timestamp: string;
      level: ConsoleLogLevel;
      message: string;
    }>;
  };
  antiAbuse: {
    honeypot: string;
    openedAt: string;
    submittedAt: string;
  };
};

export const BUG_REPORT_SCHEMA_VERSION = 2;
export const BUG_REPORT_LEGACY_SCHEMA_VERSION = 1;
export const BUG_REPORT_MIN_SUBMIT_MS = 2000;
export const BUG_REPORT_MAX_PAYLOAD_BYTES = 64 * 1024;
export const BUG_REPORT_MAX_BODY_CHARS = 60_000;
export const BUG_REPORT_MAX_LOG_CHARS = 12_000;
export const BUG_REPORT_SUMMARY_MIN = 5;
export const BUG_REPORT_SUMMARY_MAX = 140;
export const BUG_REPORT_DETAILS_MIN = 10;
export const BUG_REPORT_DETAILS_MAX = 4000;
export const BUG_REPORT_MAX_LOG_ENTRIES = 200;

const PRIORITIES = new Set<BugPriority>(["normal", "high"]);
const LOG_LEVELS = new Set<ConsoleLogLevel>([
  "log",
  "info",
  "warn",
  "error",
  "debug",
]);
const DEVICE_TYPES = new Set<BugReportPayload["environment"]["deviceType"]>([
  "desktop",
  "tablet",
  "mobile",
]);
const RUNTIMES = new Set<BugReportPayload["environment"]["runtime"]>([
  "web",
  "tauri",
]);

export const MANAGED_LABELS = {
  bug: {
    color: "d73a4a",
    description: "Something isn't working",
  },
  enhancement: {
    color: "a2eeef",
    description: "New feature or request",
  },
  "from-app": {
    color: "0e8a16",
    description: "Reported from the in-app bug form",
  },
  web: {
    color: "1d76db",
    description: "Reported from the web runtime",
  },
  ios: {
    color: "fbca04",
    description: "Reported from the iOS runtime",
  },
  "high-priority": {
    color: "b60205",
    description: "Marked high priority by reporter",
  },
} as const;

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, "");
}

function sanitizeText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  return normalizeLineEndings(stripHtml(value)).trim().slice(0, maxLength);
}

function normalizeOrigin(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function parseAllowedOrigins(raw: string | undefined) {
  return new Set(
    String(raw || "")
      .split(",")
      .map(normalizeOrigin)
      .filter(Boolean),
  );
}

export function ensureAllowedOrigin(
  origin: string | null,
  allowedOrigins: Set<string>,
) {
  if (
    !origin ||
    allowedOrigins.size === 0 ||
    !allowedOrigins.has(normalizeOrigin(origin))
  ) {
    throw new Error("Origin not allowed.");
  }
}

export class BugReportPayloadTooLargeError extends Error {
  constructor() {
    super("Bug report payload is too large.");
    this.name = "BugReportPayloadTooLargeError";
  }
}

export async function readBugReportBody(
  request: Request,
  maxBytes = BUG_REPORT_MAX_PAYLOAD_BYTES,
) {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength.trim())) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw new BugReportPayloadTooLargeError();
    }
  }

  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BugReportPayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export function validateBugReportPayload(payload: unknown): BugReportPayload {
  assert(isRecord(payload), "Request body must be a JSON object.");
  assert(
    payload.schemaVersion === BUG_REPORT_LEGACY_SCHEMA_VERSION ||
      payload.schemaVersion === BUG_REPORT_SCHEMA_VERSION,
    "Unsupported bug report schema version.",
  );

  const issue = payload.issue;
  const environment = payload.environment;
  const consoleLogs = payload.consoleLogs;
  const antiAbuse = payload.antiAbuse;

  assert(isRecord(issue), "Bug report issue payload is missing.");
  assert(isRecord(environment), "Bug report environment payload is missing.");
  assert(isRecord(consoleLogs), "Bug report console log payload is missing.");
  assert(isRecord(antiAbuse), "Bug report anti-abuse payload is missing.");

  const reportType: ReportType =
    payload.schemaVersion === BUG_REPORT_LEGACY_SCHEMA_VERSION
      ? "bug"
      : issue.reportType === "bug" || issue.reportType === "feature"
        ? issue.reportType
        : (() => {
            throw new Error("Bug report type is invalid.");
          })();
  const summary = sanitizeText(issue.summary, BUG_REPORT_SUMMARY_MAX);
  const priority = PRIORITIES.has(issue.priority as BugPriority)
    ? (issue.priority as BugPriority)
    : "normal";

  assert(
    summary.length >= BUG_REPORT_SUMMARY_MIN,
    `Summary must be at least ${BUG_REPORT_SUMMARY_MIN} characters.`,
  );

  const normalizedIssue: BugIssue | FeatureIssue =
    reportType === "feature"
      ? {
          reportType,
          summary,
          featureProblem: sanitizeText(
            issue.featureProblem,
            BUG_REPORT_DETAILS_MAX,
          ),
          featureOutcome: sanitizeText(
            issue.featureOutcome,
            BUG_REPORT_DETAILS_MAX,
          ),
          featureValue: sanitizeText(
            issue.featureValue,
            BUG_REPORT_DETAILS_MAX,
          ),
          priority,
        }
      : {
          reportType,
          summary,
          reproSteps: sanitizeText(issue.reproSteps, BUG_REPORT_DETAILS_MAX),
          expectedBehavior: sanitizeText(
            issue.expectedBehavior,
            BUG_REPORT_DETAILS_MAX,
          ),
          actualBehavior: sanitizeText(
            issue.actualBehavior,
            BUG_REPORT_DETAILS_MAX,
          ),
          priority,
        };

  if (normalizedIssue.reportType === "feature") {
    assert(
      normalizedIssue.featureProblem.length >= BUG_REPORT_DETAILS_MIN,
      `Problem or opportunity must be at least ${BUG_REPORT_DETAILS_MIN} characters.`,
    );
    assert(
      normalizedIssue.featureOutcome.length >= BUG_REPORT_DETAILS_MIN,
      `Desired outcome must be at least ${BUG_REPORT_DETAILS_MIN} characters.`,
    );
    assert(
      normalizedIssue.featureValue.length >= BUG_REPORT_DETAILS_MIN,
      `Why it matters must be at least ${BUG_REPORT_DETAILS_MIN} characters.`,
    );
  } else {
    assert(
      normalizedIssue.reproSteps.length >= BUG_REPORT_DETAILS_MIN,
      `Repro steps must be at least ${BUG_REPORT_DETAILS_MIN} characters.`,
    );
    assert(
      normalizedIssue.expectedBehavior.length >= BUG_REPORT_DETAILS_MIN,
      `Expected behavior must be at least ${BUG_REPORT_DETAILS_MIN} characters.`,
    );
    assert(
      normalizedIssue.actualBehavior.length >= BUG_REPORT_DETAILS_MIN,
      `Actual behavior must be at least ${BUG_REPORT_DETAILS_MIN} characters.`,
    );
  }

  const runtime = RUNTIMES.has(
    environment.runtime as BugReportPayload["environment"]["runtime"],
  )
    ? (environment.runtime as BugReportPayload["environment"]["runtime"])
    : "web";
  const deviceType = DEVICE_TYPES.has(
    environment.deviceType as BugReportPayload["environment"]["deviceType"],
  )
    ? (environment.deviceType as BugReportPayload["environment"]["deviceType"])
    : "desktop";

  const included = reportType === "bug" && Boolean(consoleLogs.included);
  const rawEntries = Array.isArray(consoleLogs.entries)
    ? consoleLogs.entries
    : [];
  const entries = included
    ? rawEntries.slice(0, BUG_REPORT_MAX_LOG_ENTRIES).map((entry) => {
        const safeEntry = isRecord(entry) ? entry : {};
        return {
          timestamp:
            sanitizeText(safeEntry.timestamp, 64) || new Date().toISOString(),
          level: LOG_LEVELS.has(safeEntry.level as ConsoleLogLevel)
            ? (safeEntry.level as ConsoleLogLevel)
            : "log",
          message: sanitizeText(safeEntry.message, 2000),
        };
      })
    : [];

  const openedAt = sanitizeText(antiAbuse.openedAt, 64);
  const submittedAt = sanitizeText(antiAbuse.submittedAt, 64);
  const honeypot = sanitizeText(antiAbuse.honeypot, 128);

  assert(!honeypot, "Bug report validation failed.");

  return {
    schemaVersion: BUG_REPORT_SCHEMA_VERSION,
    createdAt:
      sanitizeText(payload.createdAt, 64) ||
      submittedAt ||
      new Date().toISOString(),
    issue: normalizedIssue,
    environment: {
      appVersion: sanitizeText(environment.appVersion, 120) || "unknown",
      runtime,
      browserName: sanitizeText(environment.browserName, 120) || "Unknown",
      browserVersion: sanitizeText(environment.browserVersion, 120) || null,
      osName: sanitizeText(environment.osName, 120) || "Unknown",
      osVersion: sanitizeText(environment.osVersion, 120) || null,
      deviceType,
      isIOS: Boolean(environment.isIOS),
      userAgent: sanitizeText(environment.userAgent, 1024),
      locale: sanitizeText(environment.locale, 64) || null,
      currentUrl: sanitizeText(environment.currentUrl, 1024) || null,
    },
    consoleLogs: {
      included,
      entries,
    },
    antiAbuse: {
      honeypot: "",
      openedAt,
      submittedAt,
    },
  };
}

export function ensureSubmissionDelay(payload: BugReportPayload) {
  const openedAtMs = Date.parse(payload.antiAbuse.openedAt);
  const submittedAtMs = Date.parse(
    payload.antiAbuse.submittedAt || payload.createdAt,
  );
  if (!Number.isFinite(openedAtMs) || !Number.isFinite(submittedAtMs)) {
    throw new Error("Bug report timing data is invalid.");
  }
  if (submittedAtMs - openedAtMs < BUG_REPORT_MIN_SUBMIT_MS) {
    throw new Error("Bug report submitted too quickly.");
  }
}

export function deriveBugReportLabels(payload: BugReportPayload) {
  const labels = [
    payload.issue.reportType === "feature" ? "enhancement" : "bug",
    "from-app",
  ];
  if (payload.environment.runtime === "web") labels.push("web");
  if (payload.environment.isIOS) labels.push("ios");
  if (payload.issue.priority === "high") labels.push("high-priority");
  return labels;
}

function escapeCodeFenceText(value: string) {
  return value.replace(/```/g, "``\u200b`");
}

function truncateToChars(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 17))}\n...[truncated]`;
}

export function formatConsoleLogBlock(payload: BugReportPayload) {
  if (
    !payload.consoleLogs.included ||
    payload.consoleLogs.entries.length === 0
  ) {
    return "Not included";
  }

  const text = payload.consoleLogs.entries
    .map(
      (entry) =>
        `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`,
    )
    .join("\n");

  return escapeCodeFenceText(truncateToChars(text, BUG_REPORT_MAX_LOG_CHARS));
}

function buildEnvironmentBullets(environment: BugReportPayload["environment"]) {
  const browser =
    [environment.browserName, environment.browserVersion]
      .filter(Boolean)
      .join(" ") || "Unknown";
  const os =
    [environment.osName, environment.osVersion].filter(Boolean).join(" ") ||
    "Unknown";
  return [
    `- App version: \`${environment.appVersion}\``,
    `- Runtime: \`${environment.runtime}\``,
    `- Browser: \`${browser}\``,
    `- OS: \`${os}\``,
    `- Device: \`${environment.deviceType}\``,
    `- Locale: \`${environment.locale || "n/a"}\``,
    `- URL: \`${environment.currentUrl || "n/a"}\``,
  ].join("\n");
}

export function formatBugReportIssueTitle(issue: BugReportPayload["issue"]) {
  return issue.reportType === "feature"
    ? `[Feature] ${issue.summary}`
    : `[Bug] ${issue.summary}`;
}

export function formatBugReportIssueBody(payload: BugReportPayload) {
  const issue = payload.issue;
  const isFeature = issue.reportType === "feature";
  const details =
    issue.reportType === "feature"
      ? `## Problem or Opportunity
${issue.featureProblem}

## Desired Outcome
${issue.featureOutcome}

## Why It Matters
${issue.featureValue}`
      : `## Repro Steps
${issue.reproSteps}

## Expected Behavior
${issue.expectedBehavior}

## Actual Behavior
${issue.actualBehavior}`;
  const priorityLabel = isFeature ? "Importance" : "Priority";
  const priorityValue =
    payload.issue.priority === "high"
      ? isFeature
        ? "Important"
        : "High"
      : isFeature
        ? "Standard"
        : "Normal";
  const buildBody = (logsText: string, metadataText: string) => `## Summary
${payload.issue.summary}

${details}

## ${priorityLabel}
${priorityValue}

## Environment
${buildEnvironmentBullets(payload.environment)}

${
  isFeature
    ? ""
    : `## Console Logs
\`\`\`text
${logsText}
\`\`\`

`
}## Raw Metadata
\`\`\`json
${metadataText}
\`\`\`
`;

  let logsText = formatConsoleLogBlock(payload);
  let metadataText = JSON.stringify(payload.environment, null, 2);
  let body = buildBody(logsText, metadataText);

  if (body.length > BUG_REPORT_MAX_BODY_CHARS) {
    logsText = truncateToChars(
      logsText,
      Math.floor(BUG_REPORT_MAX_LOG_CHARS / 2),
    );
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
