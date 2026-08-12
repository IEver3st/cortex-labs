import assert from "node:assert/strict";
import test from "node:test";
import {
  BUG_REPORT_SCHEMA_VERSION,
  buildBugReportIssue,
  deriveBugReportLabels,
  formatBugReportIssueBody,
  formatBugReportIssueTitle,
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
