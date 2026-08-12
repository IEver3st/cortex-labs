import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's type-stripping runtime requires the explicit TypeScript extension.
import * as bugReport from "./bug-report.ts";

const {
  BUG_REPORT_SCHEMA_VERSION,
  BugReportPayloadTooLargeError,
  deriveBugReportLabels,
  ensureAllowedOrigin,
  formatBugReportIssueBody,
  formatBugReportIssueTitle,
  parseAllowedOrigins,
  readBugReportBody,
  validateBugReportPayload,
} = bugReport;

function basePayload() {
  const submittedAt = new Date().toISOString();
  const openedAt = new Date(Date.parse(submittedAt) - 3000).toISOString();
  return {
    schemaVersion: BUG_REPORT_SCHEMA_VERSION,
    createdAt: submittedAt,
    issue: {
      reportType: "bug",
      summary: "Viewer freezes after reload",
      reproSteps: "Open a model and reload the selected texture.",
      expectedBehavior: "The updated texture should remain interactive.",
      actualBehavior: "The viewer stops responding after the reload.",
      priority: "normal",
    },
    environment: {
      appVersion: "4.0.0",
      runtime: "web",
      browserName: "Chrome",
      browserVersion: "1",
      osName: "Windows",
      osVersion: "11",
      deviceType: "desktop",
      isIOS: false,
      userAgent: "test",
      locale: "en-US",
      currentUrl: "https://studio.example.test",
    },
    consoleLogs: { included: true, entries: [] },
    antiAbuse: { honeypot: "", openedAt, submittedAt },
  };
}

test("accepts schema v2 feature requests and formats feature-specific issues", () => {
  const raw = {
    ...basePayload(),
    issue: {
      reportType: "feature",
      summary: "Add reusable camera groups",
      featureProblem:
        "Recreating the same camera set takes repetitive manual steps.",
      featureOutcome:
        "Save a named camera group and restore it in another workspace.",
      featureValue:
        "Authors can produce consistent previews with less setup time.",
      priority: "high",
    },
  };

  const payload = validateBugReportPayload(raw);
  assert.equal(payload.issue.reportType, "feature");
  assert.equal(payload.consoleLogs.included, false);
  assert.equal(
    formatBugReportIssueTitle(payload.issue),
    "[Feature] Add reusable camera groups",
  );
  assert.deepEqual(deriveBugReportLabels(payload), [
    "enhancement",
    "from-app",
    "web",
    "high-priority",
  ]);

  const body = formatBugReportIssueBody(payload);
  assert.match(body, /## Problem or Opportunity/);
  assert.match(body, /## Desired Outcome/);
  assert.match(body, /## Why It Matters/);
  assert.match(body, /## Importance\nImportant/);
  assert.doesNotMatch(body, /## Console Logs/);
});

test("keeps schema v1 bug reports compatible while normalizing them to v2", () => {
  const current = basePayload();
  const { reportType: _reportType, ...legacyIssue } = current.issue;
  const raw = { ...current, schemaVersion: 1, issue: legacyIssue };

  const payload = validateBugReportPayload(raw);
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.issue.reportType, "bug");
  assert.equal(
    formatBugReportIssueTitle(payload.issue),
    "[Bug] Viewer freezes after reload",
  );
  assert.deepEqual(deriveBugReportLabels(payload), ["bug", "from-app", "web"]);
});

test("rejects schema v2 payloads without an explicit report type", () => {
  const current = basePayload();
  const { reportType: _reportType, ...invalidIssue } = current.issue;
  const raw = { ...current, issue: invalidIssue };
  assert.throws(
    () => validateBugReportPayload(raw),
    /Bug report type is invalid/,
  );
});

test("origin validation fails closed and normalizes configured trailing slashes", () => {
  assert.throws(
    () => ensureAllowedOrigin(null, new Set()),
    /Origin not allowed/,
  );
  assert.throws(
    () =>
      ensureAllowedOrigin(
        null,
        parseAllowedOrigins("https://studio.example.test"),
      ),
    /Origin not allowed/,
  );
  assert.doesNotThrow(() =>
    ensureAllowedOrigin(
      "https://studio.example.test",
      parseAllowedOrigins("https://studio.example.test/"),
    ),
  );
  assert.throws(
    () =>
      ensureAllowedOrigin(
        "https://attacker.example.test",
        parseAllowedOrigins("https://studio.example.test"),
      ),
    /Origin not allowed/,
  );
});

test("request body reading enforces the byte limit while streaming", async () => {
  const accepted = new Request("https://studio.example.test/api/report-bug", {
    method: "POST",
    body: "abc",
  });
  assert.equal(await readBugReportBody(accepted, 3), "abc");

  const rejected = new Request("https://studio.example.test/api/report-bug", {
    method: "POST",
    body: "abcd",
  });
  await assert.rejects(
    () => readBugReportBody(rejected, 3),
    (error) => error instanceof BugReportPayloadTooLargeError,
  );

  const declaredTooLarge = new Request(
    "https://studio.example.test/api/report-bug",
    {
      method: "POST",
      headers: { "content-length": "4" },
      body: "abc",
    },
  );
  await assert.rejects(
    () => readBugReportBody(declaredTooLarge, 3),
    (error) => error instanceof BugReportPayloadTooLargeError,
  );
});
