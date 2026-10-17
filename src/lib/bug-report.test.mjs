import assert from "node:assert/strict";
import test from "node:test";
import {
  BUG_REPORT_AREAS,
  BUG_REPORT_FREQUENCIES,
  BUG_REPORT_SCHEMA_VERSION,
  buildBugReportIssue,
  deriveBugReportLabels,
  formatBugReportIssueBody,
  formatBugReportIssueTitle,
  formatBugReportMarkdown,
  hasFeedbackDraftContent,
  hasFeedbackDraftText,
  normalizeFeedbackDraftStore,
  sanitizeBugReportDraft,
  validateBugReportDraft,
} from "./bug-report-core.js";

const ENDPOINT = "tauri://native";
const ENVIRONMENT = {
  appVersion: "4.0.0",
  runtime: "tauri",
  browserName: "WebView2",
  browserVersion: "1",
  osName: "Windows",
  osVersion: "11",
  deviceType: "desktop",
  isIOS: false,
  locale: "en-US",
  currentUrl: null,
};

function openedAt() {
  return new Date(Date.now() - 3000).toISOString();
}

test("validates only the fields required by the selected report type", () => {
  const feature = validateBugReportDraft(
    {
      reportType: "feature",
      summary: "Add reusable camera groups",
      featureProblem: "Recreating the same camera set takes several repetitive steps.",
      featureOutcome: "Save a named camera group and restore it in another workspace.",
      featureValue: "Livery authors can produce consistent previews with less setup time.",
      priority: "high",
      includeConsoleLogs: true,
    },
    { endpoint: ENDPOINT, openedAt: openedAt() },
  );

  assert.deepEqual(feature.fieldErrors, {});
  assert.equal(feature.formError, "");
  assert.equal(feature.sanitizedDraft.reportType, "feature");
  assert.equal(feature.sanitizedDraft.includeConsoleLogs, false);

  const invalidBug = validateBugReportDraft(
    { reportType: "bug", summary: "Viewer freezes" },
    { endpoint: ENDPOINT, openedAt: openedAt() },
  );

  assert.deepEqual(Object.keys(invalidBug.fieldErrors).sort(), [
    "actualBehavior",
    "expectedBehavior",
    "reproSteps",
  ]);
  assert.equal("featureProblem" in invalidBug.fieldErrors, false);
});

test("builds a feature request with feature-specific GitHub formatting", () => {
  const validation = validateBugReportDraft(
    {
      reportType: "feature",
      summary: "Add reusable camera groups",
      featureProblem: "Recreating the same camera set takes several repetitive steps.",
      featureOutcome: "Save a named camera group and restore it in another workspace.",
      featureValue: "Livery authors can produce consistent previews with less setup time.",
      priority: "high",
      includeConsoleLogs: true,
      honeypot: "",
    },
    { endpoint: ENDPOINT, openedAt: openedAt() },
  );
  const payload = {
    schemaVersion: BUG_REPORT_SCHEMA_VERSION,
    issue: buildBugReportIssue(validation.sanitizedDraft),
    environment: ENVIRONMENT,
    consoleLogs: { included: validation.sanitizedDraft.includeConsoleLogs, entries: [] },
  };

  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.issue.reportType, "feature");
  assert.equal(payload.issue.reproSteps, undefined);
  assert.equal(payload.consoleLogs.included, false);
  assert.equal(formatBugReportIssueTitle(payload.issue), "[Feature] Add reusable camera groups");
  assert.deepEqual(deriveBugReportLabels(payload), ["enhancement", "from-app", "high-priority"]);

  const body = formatBugReportIssueBody(payload);
  assert.match(body, /## Problem or Opportunity/);
  assert.match(body, /## Desired Outcome/);
  assert.match(body, /## Why It Matters/);
  assert.match(body, /## Importance\nImportant/);
  assert.doesNotMatch(body, /## Repro Steps/);
  assert.doesNotMatch(body, /## Console Logs/);
});

test("preserves the existing bug report shape and labels", () => {
  const validation = validateBugReportDraft(
    {
      reportType: "bug",
      summary: "Viewer freezes after texture reload",
      reproSteps: "Open a model, choose a texture, then reload the same texture.",
      expectedBehavior: "The new texture appears and the viewport stays responsive.",
      actualBehavior: "The viewport stops responding until the workspace is reopened.",
      priority: "normal",
      includeConsoleLogs: false,
      honeypot: "",
    },
    { endpoint: ENDPOINT, openedAt: openedAt() },
  );
  const payload = {
    schemaVersion: BUG_REPORT_SCHEMA_VERSION,
    issue: buildBugReportIssue(validation.sanitizedDraft),
    environment: ENVIRONMENT,
    consoleLogs: { included: validation.sanitizedDraft.includeConsoleLogs, entries: [] },
  };

  assert.equal(payload.issue.reportType, "bug");
  assert.equal(payload.issue.featureProblem, undefined);
  assert.equal(formatBugReportIssueTitle(payload.issue), "[Bug] Viewer freezes after texture reload");
  assert.deepEqual(deriveBugReportLabels(payload), ["bug", "from-app"]);

  const body = formatBugReportIssueBody(payload);
  assert.match(body, /## Repro Steps/);
  assert.match(body, /## Console Logs/);
  assert.doesNotMatch(body, /## Problem or Opportunity/);
});

const BUG_DRAFT = {
  reportType: "bug",
  summary: "Viewer freezes after texture reload",
  reproSteps: "Open a model, choose a texture, then reload the same texture.",
  expectedBehavior: "The new texture appears and the viewport stays responsive.",
  actualBehavior: "The viewport stops responding until the workspace is reopened.",
  priority: "high",
  includeConsoleLogs: false,
  honeypot: "",
};

const FEATURE_DRAFT = {
  reportType: "feature",
  summary: "Add reusable camera groups",
  featureProblem: "Recreating the same camera set takes several repetitive steps.",
  featureOutcome: "Save a named camera group and restore it in another workspace.",
  featureValue: "Livery authors can produce consistent previews with less setup time.",
  priority: "normal",
};

function payloadFor(draft) {
  const validation = validateBugReportDraft(draft, { endpoint: ENDPOINT, openedAt: openedAt() });
  assert.deepEqual(validation.fieldErrors, {});
  return {
    schemaVersion: BUG_REPORT_SCHEMA_VERSION,
    issue: buildBugReportIssue(validation.sanitizedDraft),
    environment: ENVIRONMENT,
    consoleLogs: { included: validation.sanitizedDraft.includeConsoleLogs, entries: [] },
  };
}

test("area and frequency are allowlisted and dropped when unknown", () => {
  assert.deepEqual(
    BUG_REPORT_AREAS.map((entry) => entry.value),
    ["livery", "eup", "eup-studio", "prop-studio", "multi", "sirens", "variant-builder", "template-generator", "home-settings", "other"],
  );
  assert.deepEqual(BUG_REPORT_FREQUENCIES.map((entry) => entry.value), ["always", "sometimes", "once"]);

  // A draft saved from All Textures, before Vehicle mode, keeps its area.
  assert.equal(sanitizeBugReportDraft({ ...BUG_DRAFT, area: "all-textures" }).sanitizedDraft.area, "livery");

  const known = sanitizeBugReportDraft({ ...BUG_DRAFT, area: "eup-studio", frequency: "sometimes" });
  assert.equal(known.sanitizedDraft.area, "eup-studio");
  assert.equal(known.sanitizedDraft.frequency, "sometimes");

  const unknown = sanitizeBugReportDraft({ ...BUG_DRAFT, area: "<script>", frequency: "daily" });
  assert.equal(unknown.sanitizedDraft.area, "");
  assert.equal(unknown.sanitizedDraft.frequency, "");
  assert.deepEqual(unknown.fieldErrors, {});

  const feature = sanitizeBugReportDraft({ ...FEATURE_DRAFT, area: "multi", frequency: "always" });
  assert.equal(feature.sanitizedDraft.area, "multi");
  assert.equal(feature.sanitizedDraft.frequency, "", "frequency is bug-only");
});

test("area and frequency are additive: omitted from the issue when unset", () => {
  const plain = payloadFor(BUG_DRAFT);
  assert.equal("area" in plain.issue, false);
  assert.equal("frequency" in plain.issue, false);
  const plainBody = formatBugReportIssueBody(plain);
  assert.doesNotMatch(plainBody, /## Area/);
  assert.doesNotMatch(plainBody, /## Frequency/);

  const tagged = payloadFor({ ...BUG_DRAFT, area: "template-generator", frequency: "always" });
  assert.equal(tagged.schemaVersion, 2);
  assert.equal(tagged.issue.area, "template-generator");
  assert.equal(tagged.issue.frequency, "always");
  const body = formatBugReportIssueBody(tagged);
  assert.match(
    body,
    /## Actual Behavior\n[^\n]+\n\n## Area\nTemplate Generator\n\n## Frequency\nAlways\n\n## Priority\nHigh\n/,
  );
  assert.deepEqual(deriveBugReportLabels(tagged), ["bug", "from-app", "high-priority"]);
});

test("feature requests carry area but never frequency, with unchanged labels", () => {
  const payload = payloadFor({ ...FEATURE_DRAFT, area: "home-settings", frequency: "once" });
  assert.equal(payload.issue.area, "home-settings");
  assert.equal("frequency" in payload.issue, false);
  const body = formatBugReportIssueBody(payload);
  assert.match(body, /## Area\nHome \/ Settings\n/);
  assert.doesNotMatch(body, /## Frequency/);
  assert.match(body, /## Importance\nNice to have\n/);
  assert.deepEqual(deriveBugReportLabels(payload), ["enhancement", "from-app"]);
  assert.deepEqual(
    deriveBugReportLabels({ ...payload, environment: { ...ENVIRONMENT, runtime: "web", isIOS: true } }),
    ["enhancement", "from-app", "web", "ios"],
  );
});

test("an injected area value cannot reach the issue body", () => {
  const issue = { ...buildBugReportIssue(sanitizeBugReportDraft(BUG_DRAFT).sanitizedDraft), area: "## Injected", frequency: "x" };
  const body = formatBugReportIssueBody({ issue, environment: ENVIRONMENT, consoleLogs: { included: false, entries: [] } });
  assert.doesNotMatch(body, /Injected/);
  assert.doesNotMatch(body, /## Frequency/);
});

test("sanitizing user fields does not depend on submission readiness", () => {
  const offline = validateBugReportDraft(BUG_DRAFT, { endpoint: "", openedAt: openedAt() });
  assert.equal(offline.formError, "Feedback submission is not configured in this build.");
  assert.deepEqual(sanitizeBugReportDraft(BUG_DRAFT).fieldErrors, {});

  const markdown = formatBugReportMarkdown(payloadFor({ ...BUG_DRAFT, area: "livery" }));
  assert.match(markdown, /^# \[Bug\] Viewer freezes after texture reload\n\n## Summary\n/);
  // Vehicle reports keep Livery's "livery" id.
  assert.match(markdown, /## Area\nVehicle\n/);
});

test("draft store keeps allowlisted fields per type and never the honeypot", () => {
  const store = normalizeFeedbackDraftStore({
    version: 1,
    drafts: {
      bug: { ...BUG_DRAFT, honeypot: "bot", area: "nope", frequency: "once", extra: "x", includeConsoleLogs: true },
      feature: { ...FEATURE_DRAFT, reproSteps: "leaked", frequency: "always", area: "eup" },
    },
  });
  assert.equal("honeypot" in store.drafts.bug, false);
  assert.equal("extra" in store.drafts.bug, false);
  assert.equal(store.drafts.bug.area, "");
  assert.equal(store.drafts.bug.frequency, "once");
  assert.equal(store.drafts.bug.includeConsoleLogs, true);
  assert.equal(store.drafts.bug.summary, BUG_DRAFT.summary);
  assert.equal("reproSteps" in store.drafts.feature, false);
  assert.equal("frequency" in store.drafts.feature, false);
  assert.equal(store.drafts.feature.area, "eup");

  const legacy = normalizeFeedbackDraftStore({ version: 99, drafts: { bug: BUG_DRAFT } });
  assert.equal(legacy.drafts.bug.summary, "");
  assert.equal(normalizeFeedbackDraftStore("garbage").drafts.feature.summary, "");

  const oversized = normalizeFeedbackDraftStore({ version: 1, drafts: { bug: { summary: "x".repeat(500) } } });
  assert.equal(oversized.drafts.bug.summary.length, 140);
});

test("draft content detection ignores whitespace and defaults", () => {
  assert.equal(hasFeedbackDraftContent("bug", { summary: "   ", priority: "normal" }), false);
  assert.equal(hasFeedbackDraftContent("bug", { frequency: "once" }), true);
  assert.equal(hasFeedbackDraftContent("feature", { frequency: "once" }), false);
  assert.equal(hasFeedbackDraftContent("feature", { priority: "high" }), true);
  assert.equal(hasFeedbackDraftContent("feature", { featureValue: "Faster" }), true);
  assert.equal(hasFeedbackDraftContent("bug", null), false);
  assert.equal(hasFeedbackDraftContent("bug", { area: "livery" }), false);
});

test("draft text detection only counts typed fields", () => {
  assert.equal(hasFeedbackDraftText("bug", { area: "livery", priority: "high", frequency: "once" }), false);
  assert.equal(hasFeedbackDraftText("bug", { reproSteps: "1. Open" }), true);
  assert.equal(hasFeedbackDraftText("feature", { reproSteps: "1. Open" }), false);
  assert.equal(hasFeedbackDraftText("feature", { featureProblem: "Slow" }), true);
});
