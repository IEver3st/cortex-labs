export const BUG_REPORT_SCHEMA_VERSION = 2;
export const BUG_REPORT_MIN_SUBMIT_MS = 2000;
export const BUG_REPORT_SUMMARY_MIN = 5;
export const BUG_REPORT_SUMMARY_MAX = 140;
export const BUG_REPORT_DETAILS_MIN = 10;
export const BUG_REPORT_DETAILS_MAX = 4000;

const PRIORITY_VALUES = new Set(["normal", "high"]);
const REPORT_TYPE_VALUES = new Set(["bug", "feature"]);
const BUG_REPORT_MAX_LOG_CHARS = 12000;
const BUG_REPORT_MAX_BODY_CHARS = 60000;

function normalizeLineEndings(value) {
  return value.replace(/\r\n?/g, "\n");
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return normalizeLineEndings(value).trim();
}

export function validateBugReportDraft(draft, options = {}) {
  const endpoint = (options.endpoint || "").trim();
  const openedAt = options.openedAt || "";
  const now = Date.now();
  const openedAtMs = Date.parse(openedAt);

  const summary = normalizeText(draft?.summary);
  const reportType = REPORT_TYPE_VALUES.has(draft?.reportType) ? draft.reportType : "bug";
  const reproSteps = normalizeText(draft?.reproSteps);
  const expectedBehavior = normalizeText(draft?.expectedBehavior);
  const actualBehavior = normalizeText(draft?.actualBehavior);
  const featureProblem = normalizeText(draft?.featureProblem);
  const featureOutcome = normalizeText(draft?.featureOutcome);
  const featureValue = normalizeText(draft?.featureValue);
  const priority = PRIORITY_VALUES.has(draft?.priority) ? draft.priority : "normal";
  const honeypot = normalizeText(draft?.honeypot);

  const fieldErrors = {};

  if (!summary || summary.length < BUG_REPORT_SUMMARY_MIN) {
    fieldErrors.summary = `Summary must be at least ${BUG_REPORT_SUMMARY_MIN} characters.`;
  } else if (summary.length > BUG_REPORT_SUMMARY_MAX) {
    fieldErrors.summary = `Summary must be ${BUG_REPORT_SUMMARY_MAX} characters or less.`;
  }

  const detailFields = reportType === "feature"
    ? [
        ["featureProblem", "Problem or opportunity", featureProblem],
        ["featureOutcome", "Desired outcome", featureOutcome],
        ["featureValue", "Why it matters", featureValue],
      ]
    : [
        ["reproSteps", "Repro steps", reproSteps],
        ["expectedBehavior", "Expected behavior", expectedBehavior],
        ["actualBehavior", "Actual behavior", actualBehavior],
      ];

  for (const [field, label, value] of detailFields) {
    if (!value || value.length < BUG_REPORT_DETAILS_MIN) {
      fieldErrors[field] = `${label} must be at least ${BUG_REPORT_DETAILS_MIN} characters.`;
    } else if (value.length > BUG_REPORT_DETAILS_MAX) {
      fieldErrors[field] = `${label} must be ${BUG_REPORT_DETAILS_MAX} characters or less.`;
    }
  }

  let formError = "";
  if (!endpoint) {
    formError = "Feedback submission is not configured in this build.";
  } else if (honeypot) {
    formError = "Feedback validation failed.";
  } else if (!Number.isFinite(openedAtMs)) {
    formError = "Feedback session expired. Please reopen the form.";
  } else if (now - openedAtMs < BUG_REPORT_MIN_SUBMIT_MS) {
    formError = "Please take a moment to describe your feedback before submitting.";
  }

  return {
    fieldErrors,
    formError,
    sanitizedDraft: {
      reportType,
      summary,
      reproSteps,
      expectedBehavior,
      actualBehavior,
      featureProblem,
      featureOutcome,
      featureValue,
      priority,
      includeConsoleLogs: reportType === "bug" && Boolean(draft?.includeConsoleLogs),
      honeypot,
    },
  };
}

export function buildBugReportIssue(sanitizedDraft) {
  return {
    reportType: sanitizedDraft.reportType,
    summary: sanitizedDraft.summary,
    priority: sanitizedDraft.priority,
    ...(sanitizedDraft.reportType === "feature"
      ? {
          featureProblem: sanitizedDraft.featureProblem,
          featureOutcome: sanitizedDraft.featureOutcome,
          featureValue: sanitizedDraft.featureValue,
        }
      : {
          reproSteps: sanitizedDraft.reproSteps,
          expectedBehavior: sanitizedDraft.expectedBehavior,
          actualBehavior: sanitizedDraft.actualBehavior,
        }),
  };
}

function escapeCodeFenceText(value) {
  return value.replace(/```/g, "``\u200b`");
}

function truncateToChars(value, maxChars) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 17))}\n...[truncated]`;
}

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

export function formatBugReportIssueTitle(issue) {
  return issue.reportType === "feature"
    ? `[Feature] ${issue.summary}`
    : `[Bug] ${issue.summary}`;
}

export function formatBugReportIssueBody(payload) {
  const isFeature = payload.issue.reportType === "feature";
  const reportDetails = isFeature
    ? `## Problem or Opportunity
${payload.issue.featureProblem}

## Desired Outcome
${payload.issue.featureOutcome}

## Why It Matters
${payload.issue.featureValue}`
    : `## Repro Steps
${payload.issue.reproSteps}

## Expected Behavior
${payload.issue.expectedBehavior}

## Actual Behavior
${payload.issue.actualBehavior}`;
  const priorityLabel = isFeature ? "Importance" : "Priority";
  const priorityValue = payload.issue.priority === "high"
    ? (isFeature ? "Important" : "High")
    : (isFeature ? "Standard" : "Normal");
  const buildBody = (logsText, metadataText) => {
    const diagnosticsSection = isFeature
      ? ""
      : `## Console Logs
\`\`\`text
${logsText}
\`\`\`

`;
    return `## Summary
${payload.issue.summary}

${reportDetails}

## ${priorityLabel}
${priorityValue}

## Environment
${buildEnvironmentBullets(payload.environment)}

${diagnosticsSection}## Raw Metadata
\`\`\`json
${metadataText}
\`\`\`
`;
  };

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

export function deriveBugReportLabels(payload) {
  const labels = [payload.issue?.reportType === "feature" ? "enhancement" : "bug", "from-app"];
  if (payload.environment?.runtime === "web") labels.push("web");
  if (payload.environment?.isIOS) labels.push("ios");
  if (payload.issue?.priority === "high") labels.push("high-priority");
  return labels;
}
