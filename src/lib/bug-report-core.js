export const BUG_REPORT_SCHEMA_VERSION = 2;
export const BUG_REPORT_MIN_SUBMIT_MS = 2000;
export const BUG_REPORT_SUMMARY_MIN = 5;
export const BUG_REPORT_SUMMARY_MAX = 140;
export const BUG_REPORT_DETAILS_MIN = 10;
export const BUG_REPORT_DETAILS_MAX = 4000;

const PRIORITY_VALUES = new Set(["normal", "high"]);
const REPORT_TYPE_VALUES = new Set(["bug", "feature"]);

// Optional triage context. Values are stable identifiers; labels are what the
// issue body shows. Unknown values are dropped rather than forwarded.
export const BUG_REPORT_AREAS = Object.freeze([
  { value: "livery", label: "Vehicle" },
  { value: "eup", label: "EUP" },
  { value: "eup-studio", label: "EUP Studio" },
  { value: "prop-studio", label: "Prop Studio" },
  { value: "multi", label: "Multi" },
  { value: "sirens", label: "Sirens" },
  { value: "variant-builder", label: "Variant Builder" },
  { value: "template-generator", label: "Template Generator" },
  { value: "home-settings", label: "Home / Settings" },
  { value: "other", label: "Other" },
]);

export const BUG_REPORT_FREQUENCIES = Object.freeze([
  { value: "always", label: "Always" },
  { value: "sometimes", label: "Sometimes" },
  { value: "once", label: "Once" },
]);

const AREA_LABELS = new Map(BUG_REPORT_AREAS.map((entry) => [entry.value, entry.label]));
const FREQUENCY_LABELS = new Map(BUG_REPORT_FREQUENCIES.map((entry) => [entry.value, entry.label]));

export function normalizeBugReportArea(value) {
  // All Textures was merged into Vehicle, which kept Livery's "livery" id.
  if (value === "all-textures") return "livery";
  return typeof value === "string" && AREA_LABELS.has(value) ? value : "";
}

export function normalizeBugReportFrequency(value) {
  return typeof value === "string" && FREQUENCY_LABELS.has(value) ? value : "";
}

const BUG_REPORT_MAX_LOG_CHARS = 12000;
const BUG_REPORT_MAX_BODY_CHARS = 60000;

function normalizeLineEndings(value) {
  return value.replace(/\r\n?/g, "\n");
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return normalizeLineEndings(value).trim();
}

/**
 * Checks the user-authored fields only. Submission readiness (endpoint,
 * honeypot, timing) is layered on by validateBugReportDraft, so a local
 * Markdown copy can still be produced in builds that cannot submit.
 */
export function sanitizeBugReportDraft(draft) {
  const summary = normalizeText(draft?.summary);
  const reportType = REPORT_TYPE_VALUES.has(draft?.reportType) ? draft.reportType : "bug";
  const reproSteps = normalizeText(draft?.reproSteps);
  const expectedBehavior = normalizeText(draft?.expectedBehavior);
  const actualBehavior = normalizeText(draft?.actualBehavior);
  const featureProblem = normalizeText(draft?.featureProblem);
  const featureOutcome = normalizeText(draft?.featureOutcome);
  const featureValue = normalizeText(draft?.featureValue);
  const priority = PRIORITY_VALUES.has(draft?.priority) ? draft.priority : "normal";
  const area = normalizeBugReportArea(draft?.area);
  const frequency = reportType === "bug" ? normalizeBugReportFrequency(draft?.frequency) : "";
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

  return {
    fieldErrors,
    sanitizedDraft: {
      reportType,
      summary,
      reproSteps,
      expectedBehavior,
      actualBehavior,
      featureProblem,
      featureOutcome,
      featureValue,
      area,
      frequency,
      priority,
      includeConsoleLogs: reportType === "bug" && Boolean(draft?.includeConsoleLogs),
      honeypot,
    },
  };
}

export function validateBugReportDraft(draft, options = {}) {
  const endpoint = (options.endpoint || "").trim();
  const openedAt = options.openedAt || "";
  const now = Date.now();
  const openedAtMs = Date.parse(openedAt);
  const { fieldErrors, sanitizedDraft } = sanitizeBugReportDraft(draft);
  const { honeypot } = sanitizedDraft;

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

  return { fieldErrors, formError, sanitizedDraft };
}

export function buildBugReportIssue(sanitizedDraft) {
  const area = normalizeBugReportArea(sanitizedDraft.area);
  const frequency = sanitizedDraft.reportType === "bug"
    ? normalizeBugReportFrequency(sanitizedDraft.frequency)
    : "";
  return {
    reportType: sanitizedDraft.reportType,
    summary: sanitizedDraft.summary,
    priority: sanitizedDraft.priority,
    // Additive optional schemaVersion 2 fields, omitted when unset so older
    // consumers receive exactly the shape they already accept.
    ...(area ? { area } : {}),
    ...(frequency ? { frequency } : {}),
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
    : (isFeature ? "Nice to have" : "Normal");
  const areaLabel = AREA_LABELS.get(normalizeBugReportArea(payload.issue.area));
  const frequencyLabel = isFeature
    ? undefined
    : FREQUENCY_LABELS.get(normalizeBugReportFrequency(payload.issue.frequency));
  const contextSections = [
    areaLabel ? `## Area\n${areaLabel}\n\n` : "",
    frequencyLabel ? `## Frequency\n${frequencyLabel}\n\n` : "",
  ].join("");
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

${contextSections}## ${priorityLabel}
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

/** Title and body as Markdown, for pasting into GitHub by hand. */
export function formatBugReportMarkdown(payload) {
  return `# ${formatBugReportIssueTitle(payload.issue)}\n\n${formatBugReportIssueBody(payload)}`;
}

export const FEEDBACK_DRAFT_VERSION = 1;

const DRAFT_TEXT_FIELDS = {
  bug: ["summary", "reproSteps", "expectedBehavior", "actualBehavior"],
  feature: ["summary", "featureProblem", "featureOutcome", "featureValue"],
};

function normalizeStoredDraft(reportType, raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const draft = {};
  for (const field of DRAFT_TEXT_FIELDS[reportType]) {
    const max = field === "summary" ? BUG_REPORT_SUMMARY_MAX : BUG_REPORT_DETAILS_MAX;
    draft[field] = typeof source[field] === "string" ? source[field].slice(0, max) : "";
  }
  draft.area = normalizeBugReportArea(source.area);
  draft.priority = PRIORITY_VALUES.has(source.priority) ? source.priority : "normal";
  if (reportType === "bug") {
    draft.frequency = normalizeBugReportFrequency(source.frequency);
    if (typeof source.includeConsoleLogs === "boolean") {
      draft.includeConsoleLogs = source.includeConsoleLogs;
    }
  }
  return draft;
}

/** True when a per-type draft holds anything the user typed or chose. */
/** True when the user has typed anything into a draft's text fields. */
export function hasFeedbackDraftText(reportType, draft) {
  if (!draft || typeof draft !== "object") return false;
  const type = reportType === "feature" ? "feature" : "bug";
  return DRAFT_TEXT_FIELDS[type].some((field) => normalizeText(draft[field]));
}

export function hasFeedbackDraftContent(reportType, draft) {
  if (!draft || typeof draft !== "object") return false;
  const type = reportType === "feature" ? "feature" : "bug";
  if (DRAFT_TEXT_FIELDS[type].some((field) => normalizeText(draft[field]))) return true;
  // Area is pre-filled from the open workflow, so on its own it is not user input.
  if (draft.priority === "high") return true;
  return type === "bug" && Boolean(normalizeBugReportFrequency(draft.frequency));
}

/**
 * Normalizes persisted per-type feedback drafts. Only allowlisted fields
 * survive, so the honeypot and anything unexpected are never restored.
 */
export function normalizeFeedbackDraftStore(raw) {
  const source = raw && typeof raw === "object" && raw.version === FEEDBACK_DRAFT_VERSION ? raw : {};
  const drafts = source.drafts && typeof source.drafts === "object" ? source.drafts : {};
  return {
    version: FEEDBACK_DRAFT_VERSION,
    drafts: {
      bug: normalizeStoredDraft("bug", drafts.bug),
      feature: normalizeStoredDraft("feature", drafts.feature),
    },
  };
}
