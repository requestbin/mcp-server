/**
 * Structured API errors for the MCP tools. An agent must be able to reason about WHY a call failed
 * (cap, conflict, validation, not enabled, ambiguous network loss) without us leaking the API key,
 * another account's data or raw server internals.
 */

export type ErrorCode =
  | 'unauthorized'
  | 'plan_limit'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'scenario_runtime_unavailable'
  | 'no_sequence'
  | 'network_error'
  | 'ambiguous_write'
  | 'server_error'
  | 'bad_request';

/** Thrown by RequestBinClient for every non-2xx response and for network failures (status 0). */
export class ApiError extends Error {
  status: number;
  body: any;
  /** True when the request may have reached the server (network loss after send, 5xx): a write's outcome is unknown. */
  mayHaveApplied: boolean;

  constructor(message: string, status: number, body: any, mayHaveApplied = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.mayHaveApplied = mayHaveApplied;
  }
}

export type ToolErrorPayload = {
  error: {
    code: ErrorCode;
    status: number;
    message: string;
    hint: string;
    details?: unknown;
    /** For writes: exactly what the agent asked for, so it can re-apply deliberately after a conflict. */
    intendedChange?: unknown;
    /** For conflicts: the current server state to re-plan against. Never overwritten automatically. */
    current?: unknown;
  };
};

const MAX_TEXT = 600;

function clip(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/** Remove anything that looks like a key from text we echo back. */
export function redact(text: string, apiKey?: string): string {
  let out = text.replace(/rb_[A-Za-z0-9_-]{8,}/g, 'rb_***');
  if (apiKey && apiKey.length > 8) {
    out = out.split(apiKey).join('rb_***');
  }
  return out;
}

export type ErrorContext = {
  tool: string;
  /** Present for writes so ambiguous/conflict errors can echo the intended change. */
  intendedChange?: unknown;
  apiKey?: string;
};

export function toToolError(err: unknown, ctx: ErrorContext): ToolErrorPayload {
  const base = (code: ErrorCode, status: number, message: string, hint: string, extra: Partial<ToolErrorPayload['error']> = {}): ToolErrorPayload => ({
    error: {
      code,
      status,
      message: redact(message, ctx.apiKey),
      hint,
      ...(ctx.intendedChange !== undefined ? { intendedChange: ctx.intendedChange } : {}),
      ...extra,
    },
  });

  if (!(err instanceof ApiError)) {
    return base('server_error', 0, err instanceof Error ? err.message : 'Unexpected error', 'This is a tool-side failure. Re-read the state with get_mock_endpoint before trying again.');
  }

  const body = err.body && typeof err.body === 'object' ? err.body : {};
  const serverMessage = typeof body.error === 'string' ? body.error : err.message;

  if (err.status === 0) {
    return base(
      err.mayHaveApplied ? 'ambiguous_write' : 'network_error',
      0,
      err.mayHaveApplied
        ? `The connection failed after the request may have been sent (${serverMessage}). Whether the change was applied is UNKNOWN.`
        : `Could not reach the RequestBin API (${serverMessage}). Nothing was sent.`,
      err.mayHaveApplied
        ? 'Do NOT repeat the write blindly. Call get_mock_endpoint and compare the rules (and updatedAt) with what you intended, then act on what you actually see.'
        : 'Check REQUESTBIN_BASE_URL and that the API is reachable, then retry. No state changed.',
    );
  }
  if (err.status === 401) {
    return base('unauthorized', 401, 'The API key was rejected.', 'Create a key at /api-keys and set REQUESTBIN_API_KEY. The key is never echoed by this tool.');
  }
  if (err.status === 403 && (body.allowed === false || body.requiredPlan)) {
    return base(
      'plan_limit',
      403,
      serverMessage,
      `Your ${body.currentPlan ?? 'current'} plan limit was reached${body.requiredPlan ? ` (needs ${body.requiredPlan})` : ''}. Nothing was created. On Free, edit the existing starter rule with update_mock_rule instead of adding a rule.`,
      { details: { currentPlan: body.currentPlan, requiredPlan: body.requiredPlan, usage: body.usage } },
    );
  }
  if (err.status === 403) {
    return base('unauthorized', 403, serverMessage, 'This account is not allowed to do that.');
  }
  if (err.status === 404) {
    if (ctx.tool === 'reset_mock_sequence' && serverMessage === 'Not found') {
      return base(
        'scenario_runtime_unavailable',
        404,
        'The server does not expose sequence reset: the Scenario runtime is not enabled on this environment.',
        'This is a server capability gap, not a missing rule. Do not retry. A server operator must enable it; this tool never enables flags.',
      );
    }
    return base('not_found', 404, serverMessage, 'The endpoint or rule does not exist for this account (or belongs to another account). Use list_mock_endpoints / get_mock_endpoint to find valid ids.');
  }
  if (err.status === 409) {
    if (body.code === 'rule_conflict') {
      return base(
        'conflict',
        409,
        'The rule or endpoint changed since you read it. Your change was NOT applied and nothing was overwritten.',
        'Re-plan against `current` (it includes a fresh updatedAt), then call update_mock_rule again with that token if the change is still wanted.',
        { current: { rule: body.rule ?? null, updatedAt: body.endpoint?.updatedAt ?? null } },
      );
    }
    if (ctx.tool === 'reset_mock_sequence') {
      return base('no_sequence', 409, serverMessage, 'This rule has no Sequence to reset. Configure one with update_mock_rule first.');
    }
    return base('conflict', 409, serverMessage, 'The resource is in a conflicting state. Re-read with get_mock_endpoint.');
  }
  if (err.status === 422) {
    const issues = body.issues ?? {};
    if (typeof issues.sequence === 'string' && /not enabled/i.test(issues.sequence)) {
      return base(
        'scenario_runtime_unavailable',
        422,
        'Sequences are not enabled on this environment, so the Sequence was rejected. The rule was NOT changed.',
        'Use a static response instead, or ask a server operator to enable Scenario. This tool never enables flags.',
        { details: issues },
      );
    }
    return base('validation', 422, 'The server rejected the rule as invalid. Nothing was changed.', 'Fix the fields listed in details.issues and call again.', { details: issues });
  }
  if (err.status === 400) {
    return base('bad_request', 400, serverMessage, 'The request was malformed. Check the argument formats (expectedUpdatedAt must be an ISO date string).');
  }
  if (err.status >= 500) {
    return base(
      err.mayHaveApplied ? 'ambiguous_write' : 'server_error',
      err.status,
      `The server failed (${err.status}). The outcome of a write is UNKNOWN.`,
      'Do NOT repeat a write blindly. Call get_mock_endpoint to see what actually changed.',
    );
  }

  return base('server_error', err.status, clip(serverMessage), 'Unexpected response. Re-read state before retrying.');
}

export function errorResult(payload: ToolErrorPayload) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }], isError: true };
}
