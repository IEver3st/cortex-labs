import { NextResponse } from 'next/server';
import {
  BUG_REPORT_MAX_PAYLOAD_BYTES,
  MANAGED_LABELS,
  deriveBugReportLabels,
  ensureAllowedOrigin,
  ensureSubmissionDelay,
  formatBugReportIssueBody,
  formatBugReportIssueTitle,
  parseAllowedOrigins,
  validateBugReportPayload,
} from '@/lib/bug-report';

export const runtime = 'nodejs';

const GITHUB_API_BASE = 'https://api.github.com';

type GitHubIssueResponse = {
  number: number;
  html_url: string;
};

function getRequiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function githubRequest(path: string, init: RequestInit = {}) {
  const token = getRequiredEnv('GITHUB_TOKEN');
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'cortex-labs-bug-reporter',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
    cache: 'no-store',
  });

  if (response.ok) return response;

  let errorMessage = `GitHub API request failed with HTTP ${response.status}.`;
  try {
    const body = (await response.json()) as { message?: string };
    if (body?.message) errorMessage = body.message;
  } catch {
    // Keep the default message.
  }
  const error = new Error(errorMessage) as Error & { status?: number };
  error.status = response.status;
  throw error;
}

async function ensureLabel(owner: string, repo: string, name: string, canCreate: boolean) {
  try {
    await githubRequest(`/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`, {
      method: 'GET',
    });
    return;
  } catch (error) {
    if ((error as { status?: number })?.status !== 404) {
      throw error;
    }
    const managed = MANAGED_LABELS[name as keyof typeof MANAGED_LABELS];
    if (!managed) throw error;
    if (!canCreate) {
      throw new Error(`Required label "${name}" is missing from the repository.`);
    }
    await githubRequest(`/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        color: managed.color,
        description: managed.description,
      }),
    });
  }
}

export async function POST(request: Request) {
  try {
    ensureAllowedOrigin(request.headers.get('origin'), parseAllowedOrigins(process.env.BUG_REPORT_ALLOWED_ORIGINS));

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).length > BUG_REPORT_MAX_PAYLOAD_BYTES) {
      return NextResponse.json({ ok: false, error: 'Bug report payload is too large.' }, { status: 400 });
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ ok: false, error: 'Request body must be valid JSON.' }, { status: 400 });
    }

    const payload = validateBugReportPayload(parsedBody);
    ensureSubmissionDelay(payload);

    const owner = getRequiredEnv('GITHUB_OWNER');
    const repo = getRequiredEnv('GITHUB_REPO');
    const canCreateLabels = process.env.BUG_REPORT_LABEL_CREATE === 'true';
    const labels = deriveBugReportLabels(payload);

    for (const label of labels) {
      await ensureLabel(owner, repo, label, canCreateLabels);
    }

    const issueResponse = await githubRequest(`/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: JSON.stringify({
        title: formatBugReportIssueTitle(payload.issue.summary),
        body: formatBugReportIssueBody(payload),
        labels,
      }),
    });
    const issue = (await issueResponse.json()) as GitHubIssueResponse;

    return NextResponse.json({
      ok: true,
      issueNumber: issue.number,
      issueUrl: issue.html_url,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : 'Bug report submission failed.';
    if (message === 'Origin not allowed.') {
      return NextResponse.json({ ok: false, error: message }, { status: 403 });
    }
    if (message === 'Bug report submitted too quickly.') {
      return NextResponse.json({ ok: false, error: message }, { status: 429 });
    }
    if (
      message.includes('Summary must be at least') ||
      message.includes('Expected behavior must be at least') ||
      message.includes('Actual behavior must be at least') ||
      message.includes('Repro steps must be at least') ||
      message.includes('Request body must be valid JSON') ||
      message.includes('Request body must be a JSON object') ||
      message.includes('Unsupported bug report schema version') ||
      message.includes('validation failed') ||
      message.includes('timing data is invalid') ||
      message.includes('payload is missing')
    ) {
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
