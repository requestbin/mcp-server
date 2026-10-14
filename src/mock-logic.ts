/**
 * Pure helpers for the mock tools: match order, saved-vs-deployed state, shadowing warnings, patch merge.
 * Semantics mirror the REAL data plane (requestbin-mock/internal/matcher): rules are evaluated in ascending
 * `priority` (LOWER number first), ties keep creation order, only active rules count, method is `*` or exact,
 * path is `*` or an EXACT string (no globs, no params).
 */

export type Rule = {
  id: string;
  priority: number;
  isActive: boolean;
  match: { method: string; path: string };
  response: { statusCode: number; headers: Record<string, string>; body: string };
  sequence?: { steps: Array<{ statusCode: number; headers: Record<string, string>; body: string; delayMs: number }>; afterLast: string };
};

export const MATCH_SEMANTICS = 'First active rule wins, evaluated by ascending priority (LOWER number first; ties keep creation order). Method is "*" or exact; path is "*" or an EXACT string — globs like /api/* and path parameters are NOT supported. Unmatched requests get a default 200 empty body.';

/** Rules in the order the data plane evaluates them (stable). */
export function matchOrder(rules: Rule[]): Rule[] {
  return rules
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.priority - b.r.priority) || (a.i - b.i))
    .map(x => x.r);
}

function covers(earlier: Rule, later: Rule): boolean {
  return (earlier.match.method === '*' || earlier.match.method === later.match.method)
    && (earlier.match.path === '*' || earlier.match.path === later.match.path);
}

export type ShadowWarning = { ruleId: string; shadowedBy: string; message: string };

/** A rule is unreachable when an earlier ACTIVE rule matches every request it would (e.g. the Free `* *` starter at priority 0). */
export function shadowWarnings(rules: Rule[]): ShadowWarning[] {
  const ordered = matchOrder(rules).filter(r => r.isActive);
  const out: ShadowWarning[] = [];
  ordered.forEach((rule, idx) => {
    const blocker = ordered.slice(0, idx).find(e => covers(e, rule));
    if (blocker) {
      out.push({
        ruleId: rule.id,
        shadowedBy: blocker.id,
        message: `Rule ${rule.match.method} ${rule.match.path} (priority ${rule.priority}) is never reached: rule ${blocker.id} (${blocker.match.method} ${blocker.match.path}, priority ${blocker.priority}) matches first. Give the specific rule a LOWER priority number than the catch-all, or edit/pause the catch-all.`,
      });
    }
  });
  return out;
}

/** Paths that LOOK like globs or parameters but are matched literally by the data plane. */
export function unsupportedPathWarnings(rules: Rule[]): string[] {
  return rules
    .filter(r => r.match.path !== '*' && (/\*/.test(r.match.path) || /\/:[A-Za-z_]/.test(r.match.path) || /\{[^}]+\}/.test(r.match.path)))
    .map(r => `Rule ${r.id} path "${r.match.path}" is matched as a LITERAL string: globs ("*" inside a path), ":params" and "{params}" are not supported, so it will not match /api/v1/users-style URLs. Use an exact path, or "*" alone to match any path.`);
}

/** Every warning an agent should read after a write: unreachable rules and unsupported path syntax. */
export function ruleWarnings(rules: Rule[]): string[] {
  return [...shadowWarnings(rules).map(w => w.message), ...unsupportedPathWarnings(rules)];
}

function normalize(rule: Rule) {
  return JSON.stringify({
    id: rule.id,
    priority: rule.priority,
    isActive: rule.isActive,
    match: rule.match,
    response: { statusCode: rule.response.statusCode, headers: sortKeys(rule.response.headers ?? {}), body: rule.response.body ?? '' },
    sequence: rule.sequence?.steps?.length
      ? { afterLast: rule.sequence.afterLast ?? 'hold_last', steps: rule.sequence.steps.map(s => ({ statusCode: s.statusCode, headers: sortKeys(s.headers ?? {}), body: s.body ?? '', delayMs: s.delayMs ?? 0 })) }
      : null,
  });
}

function sortKeys(o: Record<string, string>) {
  return Object.keys(o).sort().reduce<Record<string, string>>((acc, k) => { acc[k] = o[k]!; return acc; }, {});
}

export type PublishState = {
  kind: 'never_published' | 'in_sync' | 'unsaved_changes' | 'legacy';
  deployedVersion: number | null;
  /** Whether saved-but-undeployed edits could already be served by the live URL. We only say "no" when the server proved it. */
  savedChangesServedLive: 'no (server-verified isolation)' | 'unknown (isolation not verified)' | 'not applicable';
  detail: string;
};

export function publishState(ep: { publishedAt: string | null; configVersion: number; rules: Rule[]; publishedRules?: Rule[]; publishIsolation?: string }): PublishState {
  if (!ep.publishedAt) {
    return { kind: 'never_published', deployedVersion: null, savedChangesServedLive: 'not applicable', detail: 'Never deployed. Call deploy_mock to publish the saved rules.' };
  }
  if (!ep.publishedRules) {
    return { kind: 'legacy', deployedVersion: ep.configVersion, savedChangesServedLive: 'unknown (isolation not verified)', detail: 'Deployed before deploy-time snapshots existed: the server cannot prove which rules the live URL serves. Saved edits MAY already be live. Call deploy_mock to make the state explicit.' };
  }
  const same = ep.rules.length === ep.publishedRules.length && ep.rules.every((r, i) => normalize(r) === normalize(ep.publishedRules![i]!));
  if (same) {
    return { kind: 'in_sync', deployedVersion: ep.configVersion, savedChangesServedLive: 'not applicable', detail: 'Saved rules match the last deploy.' };
  }
  return {
    kind: 'unsaved_changes',
    deployedVersion: ep.configVersion,
    savedChangesServedLive: ep.publishIsolation === 'verified' ? 'no (server-verified isolation)' : 'unknown (isolation not verified)',
    detail: ep.publishIsolation === 'verified'
      ? 'Saved rules differ from the last deploy; the server verified they are not served yet. Call deploy_mock to publish.'
      : 'Saved rules differ from the last deploy. The server has NOT verified that the live URL ignores saved edits, so do not assume the old behaviour. Call deploy_mock to make it explicit.',
  };
}

export function summarizeRule(rule: Rule, bodyPreview = 300) {
  const body = rule.response.body ?? '';
  return {
    id: rule.id,
    priority: rule.priority,
    isActive: rule.isActive,
    match: rule.match,
    response: {
      statusCode: rule.response.statusCode,
      headers: rule.response.headers ?? {},
      bodyPreview: body.length > bodyPreview ? `${body.slice(0, bodyPreview)}…` : body,
      bodyBytes: Buffer.byteLength(body, 'utf8'),
    },
    sequence: rule.sequence?.steps?.length
      ? { afterLast: rule.sequence.afterLast ?? 'hold_last', steps: rule.sequence.steps.map((s, i) => ({ step: i + 1, statusCode: s.statusCode, delayMs: s.delayMs ?? 0, headers: s.headers ?? {}, bodyPreview: (s.body ?? '').slice(0, 120) })) }
      : null,
  };
}

export type RulePatch = {
  match?: { method?: string; path?: string };
  response?: { statusCode?: number; headers?: Record<string, string>; body?: string };
  priority?: number;
  isActive?: boolean;
  /** undefined = preserve, null = clear, object = replace. */
  sequence?: { steps: Array<{ statusCode: number; delayMs?: number; headers?: Record<string, string>; body?: string }>; afterLast?: string } | null;
};

/** Build the PATCH payload. The API replaces `match` and `response` wholesale, so partial changes are merged onto the current rule first. */
export function buildPatchPayload(current: Rule, patch: RulePatch, expectedUpdatedAt: string): Record<string, unknown> {
  const payload: Record<string, unknown> = { expectedUpdatedAt };
  if (patch.match) {
    payload.match = { method: patch.match.method ?? current.match.method, path: patch.match.path ?? current.match.path };
  }
  if (patch.response) {
    payload.response = {
      statusCode: patch.response.statusCode ?? current.response.statusCode,
      headers: patch.response.headers ?? current.response.headers ?? {},
      body: patch.response.body ?? current.response.body ?? '',
    };
  }
  if (patch.priority !== undefined) {
    payload.priority = patch.priority;
  }
  if (patch.isActive !== undefined) {
    payload.isActive = patch.isActive;
  }
  if (patch.sequence === null) {
    payload.sequence = null;
  } else if (patch.sequence !== undefined) {
    payload.sequence = {
      afterLast: patch.sequence.afterLast ?? 'hold_last',
      steps: patch.sequence.steps.map(s => ({ statusCode: s.statusCode, delayMs: s.delayMs ?? 0, headers: s.headers ?? {}, body: s.body ?? '' })),
    };
  }
  return payload;
}

export function hasChange(patch: RulePatch): boolean {
  return patch.match !== undefined || patch.response !== undefined || patch.priority !== undefined || patch.isActive !== undefined || patch.sequence !== undefined;
}

export type RuleConfig = {
  priority: number;
  isActive: boolean;
  match: { method: string; path: string };
  response: { statusCode: number; headers: Record<string, string>; body: string };
  sequence?: { steps: Array<{ statusCode: number; delayMs?: number; headers?: Record<string, string>; body?: string }>; afterLast?: string } | null;
};

function configKey(r: RuleConfig): string {
  return JSON.stringify({
    priority: r.priority,
    isActive: r.isActive,
    match: { method: r.match.method, path: r.match.path },
    response: { statusCode: r.response.statusCode, headers: sortKeys(r.response.headers ?? {}), body: r.response.body ?? '' },
    sequence: r.sequence?.steps?.length
      ? { afterLast: r.sequence.afterLast ?? 'hold_last', steps: r.sequence.steps.map(s => ({ statusCode: s.statusCode, delayMs: s.delayMs ?? 0, headers: sortKeys(s.headers ?? {}), body: s.body ?? '' })) }
      : null,
  });
}

/** Full-configuration equality (priority, active flag, match, status, headers, body, sequence). Equality is still NOT proof of causality. */
export function sameConfig(a: RuleConfig, b: RuleConfig): boolean {
  return configKey(a) === configKey(b);
}

export type Candidate = { ruleId: string; matchesIntendedExactly: boolean; match: { method: string; path: string }; priority: number; statusCode: number; hasSequence: boolean };

/**
 * After an ambiguous add: rules that did not exist before our attempt and share the intended method+path (or equal it
 * exactly). They are CANDIDATES only — a concurrent writer can create a look-alike, and our own request may still commit.
 */
export function candidatesAfterAdd(before: Rule[], after: Rule[], intended: RuleConfig): Candidate[] {
  const known = new Set(before.map(r => r.id));
  return after
    .filter(r => !known.has(r.id))
    .filter(r => sameConfig(r, intended) || (r.match.method === intended.match.method && r.match.path === intended.match.path))
    .map(r => ({
      ruleId: r.id,
      matchesIntendedExactly: sameConfig(r, intended),
      match: r.match,
      priority: r.priority,
      statusCode: r.response.statusCode,
      hasSequence: Boolean(r.sequence?.steps?.length),
    }));
}

export type ServerCapabilities = {
  status: 'ok' | 'absent' | 'malformed';
  contract?: string;
  atomicCas: boolean;
  scenarioSupported: boolean;
  scenarioEnabled: boolean;
  note: string;
};

const CONTRACT = 'mock-rules-v1';

/**
 * The ONLY accepted evidence of server capabilities is the explicit `capabilities` object the server's own build returns
 * (SaaS src/libs/mock/capabilities.ts). Presence of updatedAt / publishedRules / publishIsolation, a version string or a
 * URL is not evidence. Absent or malformed => every capability-dependent write is refused before sending.
 */
export function parseCapabilities(raw: unknown): ServerCapabilities {
  const none = { atomicCas: false, scenarioSupported: false, scenarioEnabled: false };
  if (raw === undefined || raw === null) {
    return { status: 'absent', ...none, note: 'This server does not state its capabilities (an older build). Read-only tools work; edits that need atomic compare-and-set or Sequences are refused so nothing can be silently overwritten or dropped.' };
  }
  const c = raw as any;
  const malformed = (why: string): ServerCapabilities => ({ status: 'malformed', ...none, note: `The server's capabilities object is not understood (${why}). Treated as unsupported: read-only tools work; capability-dependent edits are refused.` });
  if (typeof c !== 'object' || c.apiContract !== CONTRACT) {
    return malformed('unknown apiContract');
  }
  if (!c.ruleUpdate || typeof c.ruleUpdate !== 'object' || typeof c.ruleUpdate.atomicCas !== 'boolean') {
    return malformed('ruleUpdate.atomicCas must be a boolean');
  }
  let scenarioSupported = false;
  let scenarioEnabled = false;
  if (c.scenario !== undefined) {
    if (!c.scenario || typeof c.scenario !== 'object' || typeof c.scenario.supported !== 'boolean' || typeof c.scenario.enabled !== 'boolean') {
      return malformed('scenario.supported/enabled must be booleans');
    }
    scenarioSupported = c.scenario.supported;
    scenarioEnabled = c.scenario.supported && c.scenario.enabled;
  }
  return { status: 'ok', contract: CONTRACT, atomicCas: c.ruleUpdate.atomicCas, scenarioSupported, scenarioEnabled, note: 'Capabilities were stated by the server itself.' };
}
