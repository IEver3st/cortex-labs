export type BugPriority = 'normal' | 'high';
export type ConsoleLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export type BugReportPayload = {
  schemaVersion: 1;
  createdAt: string;
  issue: {
    summary: string;
    reproSteps: string;
    expectedBehavior: string;
    actualBehavior: string;
    priority: BugPriority;
  };
  environment: {
    appVersion: string;
    runtime: 'web' | 'tauri';
    browserName: string;
    browserVersion: string | null;
    osName: string;
    osVersion: string | null;
    deviceType: 'desktop' | 'tablet' | 'mobile';
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

export const BUG_REPORT_SCHEMA_VERSION = 1;
export const BUG_REPORT_MIN_SUBMIT_MS = 2000;
export const BUG_REPORT_MAX_PAYLOAD_BYTES = 64 * 1024;
export const BUG_REPORT_MAX_BODY_CHARS = 60_000;
export const BUG_REPORT_MAX_LOG_CHARS = 12_000;
export const BUG_REPORT_SUMMARY_MIN = 5;
export const BUG_REPORT_SUMMARY_MAX = 140;
export const BUG_REPORT_DETAILS_MIN = 10;
export const BUG_REPORT_DETAILS_MAX = 4000;
export const BUG_REPORT_MAX_LOG_ENTRIES = 200;

const PRIORITIES = new Set<BugPriority>(['normal', 'high']);
const LOG_LEVELS = new Set<ConsoleLogLevel>(['log', 'info', 'warn', 'error', 'debug']);
const DEVICE_TYPES = new Set<BugReportPayload['environment']['deviceType']>(['desktop', 'tablet', 'mobile']);
const RUNTIMES = new Set<BugReportPayload['environment']['runtime']>(['web', 'tauri']);

export const MANAGED_LABELS = {
  'from-app': {
    color: '0e8a16',
    description: 'Reported from the in-app bug form',
  },
  web: {
    color: '1d76db',
    description: 'Reported from the web runtime',
  },
  ios: {
    color: 'fbca04',
    description: 'Reported from the iOS runtime',
  },
  'high-priority': {
    color: 'b60205',
    description: 'Marked high priority by reporter',
  },
} as const;

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n?/g, '\n');
}

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, '');
}

function sanitizeText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return '';
  return normalizeLineEndings(stripHtml(value)).trim().slice(0, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function parseAllowedOrigins(raw: string | undefined) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function ensureAllowedOrigin(origin: string | null, allowedOrigins: Set<string>) {
  if (!origin) return;
  if (allowedOrigins.size === 0 || !allowedOrigins.has(origin)) {
    throw new Error('Origin not allowed.');
  }
}

export function validateBugReportPayload(payload: unknown): BugReportPayload {
  assert(isRecord(payload), 'Request body must be a JSON object.');
  assert(payload.schemaVersion === BUG_REPORT_SCHEMA_VERSION, 'Unsupported bug report schema version.');

  const issue = payload.issue;
  const environment = payload.environment;
  const consoleLogs = payload.consoleLogs;
  const antiAbuse = payload.antiAbuse;

  assert(isRecord(issue), 'Bug report issue payload is missing.');
  assert(isRecord(environment), 'Bug report environment payload is missing.');
  assert(isRecord(consoleLogs), 'Bug report console log payload is missing.');
  assert(isRecord(antiAbuse), 'Bug report anti-abuse payload is missing.');

  const summary = sanitizeText(issue.summary, BUG_REPORT_SUMMARY_MAX);
  const reproSteps = sanitizeText(issue.reproSteps, BUG_REPORT_DETAILS_MAX);
  const expectedBehavior = sanitizeText(issue.expectedBehavior, BUG_REPORT_DETAILS_MAX);
  const actualBehavior = sanitizeText(issue.actualBehavior, BUG_REPORT_DETAILS_MAX);
  const priority = PRIORITIES.has(issue.priority as BugPriority) ? (issue.priority as BugPriority) : 'normal';

  assert(summary.length >= BUG_REPORT_SUMMARY_MIN, `Summary must be at least ${BUG_REPORT_SUMMARY_MIN} characters.`);
  assert(reproSteps.length >= BUG_REPORT_DETAILS_MIN, `Repro steps must be at least ${BUG_REPORT_DETAILS_MIN} characters.`);
  assert(
    expectedBehavior.length >= BUG_REPORT_DETAILS_MIN,
    `Expected behavior must be at least ${BUG_REPORT_DETAILS_MIN} characters.`,
  );
  assert(
    actualBehavior.length >= BUG_REPORT_DETAILS_MIN,
    `Actual behavior must be at least ${BUG_REPORT_DETAILS_MIN} characters.`,
  );

  const runtime = RUNTIMES.has(environment.runtime as BugReportPayload['environment']['runtime'])
    ? (environment.runtime as BugReportPayload['environment']['runtime'])
    : 'web';
  const deviceType = DEVICE_TYPES.has(environment.deviceType as BugReportPayload['environment']['deviceType'])
    ? (environment.deviceType as BugReportPayload['environment']['deviceType'])
    : 'desktop';

  const included = Boolean(consoleLogs.included);
  const rawEntries = Array.isArray(consoleLogs.entries) ? consoleLogs.entries : [];
  const entries = included
    ? rawEntries.slice(0, BUG_REPORT_MAX_LOG_ENTRIES).map((entry) => {
        const safeEntry = isRecord(entry) ? entry : {};
        return {
          timestamp: sanitizeText(safeEntry.timestamp, 64) || new Date().toISOString(),
          level: LOG_LEVELS.has(safeEntry.level as ConsoleLogLevel)
            ? (safeEntry.level as ConsoleLogLevel)
            : 'log',
          message: sanitizeText(safeEntry.message, 2000),
        };
      })
    : [];

  const openedAt = sanitizeText(antiAbuse.openedAt, 64);
  const submittedAt = sanitizeText(antiAbuse.submittedAt, 64);
  const honeypot = sanitizeText(antiAbuse.honeypot, 128);

  assert(!honeypot, 'Bug report validation failed.');

  return {
    schemaVersion: BUG_REPORT_SCHEMA_VERSION,
    createdAt: sanitizeText(payload.createdAt, 64) || submittedAt || new Date().toISOString(),
    issue: {
      summary,
      reproSteps,
      expectedBehavior,
      actualBehavior,
      priority,
    },
    environment: {
      appVersion: sanitizeText(environment.appVersion, 120) || 'unknown',
      runtime,
      browserName: sanitizeText(environment.browserName, 120) || 'Unknown',
      browserVersion: sanitizeText(environment.browserVersion, 120) || null,
      osName: sanitizeText(environment.osName, 120) || 'Unknown',
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
      honeypot: '',
      openedAt,
      submittedAt,
    },
  };
}

export function ensureSubmissionDelay(payload: BugReportPayload) {
  const openedAtMs = Date.parse(payload.antiAbuse.openedAt);
  const submittedAtMs = Date.parse(payload.antiAbuse.submittedAt || payload.createdAt);
  if (!Number.isFinite(openedAtMs) || !Number.isFinite(submittedAtMs)) {
    throw new Error('Bug report timing data is invalid.');
  }
  if (submittedAtMs - openedAtMs < BUG_REPORT_MIN_SUBMIT_MS) {
    throw new Error('Bug report submitted too quickly.');
  }
}

export function deriveBugReportLabels(payload: BugReportPayload) {
  const labels = ['bug', 'from-app'];
  if (payload.environment.runtime === 'web') labels.push('web');
  if (payload.environment.isIOS) labels.push('ios');
  if (payload.issue.priority === 'high') labels.push('high-priority');
  return labels;
}

function escapeCodeFenceText(value: string) {
  return value.replace(/```/g, '``\u200b`');
}

function truncateToChars(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 17))}\n...[truncated]`;
}

export function formatConsoleLogBlock(payload: BugReportPayload) {
  if (!payload.consoleLogs.included || payload.consoleLogs.entries.length === 0) {
    return 'Not included';
  }

  const text = payload.consoleLogs.entries
    .map((entry) => `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`)
    .join('\n');

  return escapeCodeFenceText(truncateToChars(text, BUG_REPORT_MAX_LOG_CHARS));
}

function buildEnvironmentBullets(environment: BugReportPayload['environment']) {
  const browser = [environment.browserName, environment.browserVersion].filter(Boolean).join(' ') || 'Unknown';
  const os = [environment.osName, environment.osVersion].filter(Boolean).join(' ') || 'Unknown';
  return [
    `- App version: \`${environment.appVersion}\``,
    `- Runtime: \`${environment.runtime}\``,
    `- Browser: \`${browser}\``,
    `- OS: \`${os}\``,
    `- Device: \`${environment.deviceType}\``,
    `- Locale: \`${environment.locale || 'n/a'}\``,
    `- URL: \`${environment.currentUrl || 'n/a'}\``,
  ].join('\n');
}

export function formatBugReportIssueTitle(summary: string) {
  return `[Bug] ${summary}`;
}

export function formatBugReportIssueBody(payload: BugReportPayload) {
  const buildBody = (logsText: string, metadataText: string) => `## Summary
${payload.issue.summary}

## Repro Steps
${payload.issue.reproSteps}

## Expected Behavior
${payload.issue.expectedBehavior}

## Actual Behavior
${payload.issue.actualBehavior}

## Priority
${payload.issue.priority === 'high' ? 'High' : 'Normal'}

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
