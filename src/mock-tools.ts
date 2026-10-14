/**
 * Mock API tools (create / inspect / edit / sequence / reset / deploy / captures).
 *
 * Contract rules (CX-20261014-02):
 *  - Nothing here deploys as a side effect. Only deploy_mock publishes.
 *  - Writes that depend on prior state require the endpoint `updatedAt` token (server-side atomic CAS).
 *  - No tool enables server flags, bypasses plan caps, or writes anywhere except the documented API routes.
 *  - Errors are structured (see errors.ts); ambiguous write failures never auto-retry.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { RequestBinClient } from './api-client.js';
import { ApiError, errorResult, serializeSafe, toolRefusal, toToolError } from './errors.js';
import type { Rule, RuleConfig, RulePatch, ServerCapabilities } from './mock-logic.js';
import { buildPatchPayload, candidatesAfterAdd, hasChange, MATCH_SEMANTICS, matchOrder, parseCapabilities, publishState, ruleWarnings, summarizeRule } from './mock-logic.js';

export type MockToolsConfig = {
  apiKey?: string;
  mockDomain: string;
  /** `https` for production; `http` for a local data plane such as localhost:8081. */
  mockScheme: string;
};

const METHODS = ['*', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

const headersSchema = z.record(z.string()).describe('Flat object of header name → string value, e.g. {"Content-Type":"application/json"}');

const sequenceSchema = z.object({
  steps: z.array(z.object({
    statusCode: z.number().int().min(100).max(599),
    delayMs: z.number().int().min(0).max(15000).optional().describe('Server-side delay before this step answers (0–15000 ms)'),
    headers: headersSchema.optional(),
    body: z.string().optional(),
  })).min(1).max(10).describe('1–10 ordered steps. Request N gets step N; after the last step the last step repeats (hold_last).'),
  afterLast: z.literal('hold_last').optional(),
}).describe('Ordered response Sequence (e.g. 429 → slow 200). Requires the Scenario runtime on the server; otherwise the call is rejected with code scenario_runtime_unavailable and nothing changes.');

export function registerMockTools(server: McpServer, client: RequestBinClient, cfg: MockToolsConfig) {
  const urlFor = (slug: string) => `${cfg.mockScheme}://${slug}.${cfg.mockDomain}`;
  // Every payload leaves through serializeSafe: the CONFIGURED credential is redacted at the output boundary only.
  const ok = (payload: unknown) => ({ content: [{ type: 'text' as const, text: serializeSafe(payload, cfg.apiKey) }] });
  const fail = (err: unknown, tool: string, intendedChange?: unknown) => errorResult(toToolError(err, { tool, intendedChange, apiKey: cfg.apiKey }), cfg.apiKey);
  const refuse = (payload: ReturnType<typeof toolRefusal>) => errorResult(payload, cfg.apiKey);
  /** A successful write response that lacks the fields we rely on may hide a committed change: treat as UNKNOWN. */
  const requireShape = (cond: boolean, what: string) => {
    if (!cond) {
      throw new ApiError(`success response is missing ${what}`, 0, null, true, 'unreadable');
    }
  };
  const capabilityRefusal = (caps: ServerCapabilities, needs: string, intended: unknown) => refuse(toolRefusal(
    'capability_unavailable',
    `Refused before sending anything: this server did not state support for ${needs} (capabilities: ${caps.status}). ${caps.note}`,
    'Nothing was changed. Use a server build that states the capability (RequestBin API contract "mock-rules-v1"), or make the change in the web UI. This tool never infers capability from other fields and has no override.',
    { intendedChange: intended, details: { serverCapabilities: caps } },
  ));
  const scenarioRefusal = (caps: ServerCapabilities, intended: unknown) => refuse(toolRefusal(
    'scenario_runtime_unavailable',
    'The Scenario runtime is not enabled on this server, so Sequences and Reset are unavailable. Nothing was sent.',
    'This is a server capability gap. Use a static response, or ask a server operator to enable Scenario. This tool never enables flags.',
    { intendedChange: intended, details: { serverCapabilities: caps } },
  ));

  const view = (ep: any, caps?: ServerCapabilities) => {
    const rules: Rule[] = ep.rules ?? [];
    return {
      ...(caps ? { serverCapabilities: caps } : {}),
      id: ep.id,
      slug: ep.slug,
      name: ep.name,
      url: ep.slug ? urlFor(ep.slug) : null,
      status: ep.status,
      configVersion: ep.configVersion,
      publishedAt: ep.publishedAt,
      /** Pass this as expectedUpdatedAt to update_mock_rule. It changes after every save, deploy or note edit. */
      updatedAt: ep.updatedAt,
      state: publishState({ publishedAt: ep.publishedAt, configVersion: ep.configVersion, rules, publishedRules: ep.publishedRules, publishIsolation: ep.publishIsolation }),
      matchSemantics: MATCH_SEMANTICS,
      rulesInMatchOrder: matchOrder(rules).map(r => summarizeRule(r)),
      warnings: ruleWarnings(rules),
    };
  };

  // ── list_mock_endpoints ──
  server.tool(
    'list_mock_endpoints',
    'List your mock endpoints (id, slug, URL, rule count, last deploy). Read-only. Use get_mock_endpoint for the rules.',
    {},
    async () => {
      try {
        const result = await client.listMockEndpoints();
        return ok((result.endpoints || []).map((e: any) => ({
          id: e.id,
          slug: e.slug,
          name: e.name,
          url: e.slug ? urlFor(e.slug) : null,
          status: e.status,
          configVersion: e.configVersion,
          rules: e.rules?.length || 0,
          interactionCount: e.interactionCount || 0,
          publishedAt: e.publishedAt,
        })));
      } catch (e) {
        return fail(e, 'list_mock_endpoints');
      }
    },
  );

  // ── create_mock_endpoint ──
  server.tool(
    'create_mock_endpoint',
    'Create a mock endpoint. WRITES one endpoint (counts toward your plan\'s endpoint cap). It is born published with ONE starter rule: any method, any path, priority 0, 200 JSON. On Free the rule cap is 1, so DO NOT add_mock_rule next (it will be rejected with plan_limit) — call get_mock_endpoint, then update_mock_rule on the starter. Not idempotent: after a network failure call list_mock_endpoints before retrying. Custom slugs need PRO/TEAM.',
    {
      name: z.string().optional().describe('Display name, e.g. "checkout repro"'),
      slug: z.string().optional().describe('Custom subdomain slug (PRO/TEAM only). Omit for an auto slug.'),
    },
    async ({ name, slug }) => {
      try {
        const result = await client.createMockEndpoint({ name, slug });
        const ep = result.endpoint;
        requireShape(typeof ep?.id === 'string' && Array.isArray(ep?.rules), 'endpoint.id / endpoint.rules');
        return ok({
          ...view(ep),
          message: `Created ${ep?.slug ? urlFor(ep.slug) : 'endpoint'} with a starter rule (id ${ep?.rules?.[0]?.id}). Next: update_mock_rule on that id (pass updatedAt), then deploy_mock.`,
        });
      } catch (e) {
        return fail(e, 'create_mock_endpoint');
      }
    },
  );

  // ── get_mock_endpoint ──
  server.tool(
    'get_mock_endpoint',
    'Inspect one mock endpoint. Read-only. Returns the rules IN THE ORDER THE SERVER EVALUATES THEM (ascending priority, lower first), each rule\'s id, match, response and Sequence, the endpoint `updatedAt` token required by update_mock_rule, whether saved rules are deployed / unsaved / legacy-unverified, and warnings about rules that can never match (e.g. the Free starter `* *` at priority 0 shadows later rules).',
    { endpointId: z.string().describe('Mock endpoint id') },
    async ({ endpointId }) => {
      try {
        const result = await client.getMockEndpoint(endpointId);
        return ok(view(result.endpoint, parseCapabilities(result.capabilities)));
      } catch (e) {
        return fail(e, 'get_mock_endpoint');
      }
    },
  );

  // ── add_mock_rule ──
  server.tool(
    'add_mock_rule',
    `Append a rule to a mock endpoint (WRITE; saved but NOT deployed — call deploy_mock to publish). ${MATCH_SEMANTICS} A new rule is appended with the priority you give (default 0); a catch-all with an equal or lower priority number is evaluated first and will shadow it — the result lists such warnings. Plan caps apply per endpoint (Free 1 / PRO 5 / TEAM 20); a cap rejection is plan_limit and creates nothing. On Free use update_mock_rule on the starter instead. A sequence requires a server that states Scenario support. After a lost response, timeout, unreadable response or 5xx the outcome is UNKNOWN: this tool never retries; it re-reads the endpoint once and lists CANDIDATE rules (not proof — a concurrent writer can create a look-alike and your request may still commit later). Do not repeat the add on that evidence.`,
    {
      endpointId: z.string().describe('Mock endpoint id'),
      method: z.enum(METHODS).describe('"*" = any method, or one exact method'),
      path: z.string().describe('Exact path such as "/checkout", or "*" for any path. Globs and path parameters are not supported.'),
      statusCode: z.number().int().min(100).max(599),
      body: z.string().optional().describe('Response body as a string (serialize JSON yourself)'),
      headers: headersSchema.optional(),
      priority: z.number().int().optional().describe('LOWER numbers are evaluated FIRST (default 0). Use a lower number than a catch-all to take precedence over it.'),
      sequence: sequenceSchema.optional(),
    },
    async ({ endpointId, method, path, statusCode, body, headers, priority, sequence }) => {
      const intended = { endpointId, method, path, statusCode, body, headers, priority, sequence };
      let before: Rule[];
      let caps: ServerCapabilities;
      try {
        const pre = await client.getMockEndpoint(endpointId);
        before = pre.endpoint?.rules ?? [];
        caps = parseCapabilities(pre.capabilities);
      } catch (e) {
        return fail(e, 'add_mock_rule', intended);
      }
      if (sequence) {
        // Older servers accept the call and silently drop `sequence`: refuse before sending.
        if (!caps.scenarioSupported) {
          return capabilityRefusal(caps, 'Scenario sequences', intended);
        }
        if (!caps.scenarioEnabled) {
          return scenarioRefusal(caps, intended);
        }
      }
      const wanted: RuleConfig = { priority: priority ?? 0, isActive: true, match: { method, path }, response: { statusCode, headers: headers || {}, body: body || '' }, ...(sequence ? { sequence } : {}) };
      try {
        const result = await client.addMockRule(endpointId, { match: wanted.match, response: wanted.response, priority, ...(sequence ? { sequence } : {}) });
        const ep = result.endpoint;
        requireShape(typeof result.rule?.id === 'string' && Array.isArray(ep?.rules) && typeof ep?.updatedAt === 'string', 'rule.id / endpoint.rules / endpoint.updatedAt');
        return ok({
          rule: summarizeRule(result.rule),
          updatedAt: ep.updatedAt,
          warnings: ruleWarnings(ep.rules),
          deployed: false,
          message: 'Rule saved. Nothing is deployed yet — call deploy_mock to publish.',
        });
      } catch (e) {
        if (e instanceof ApiError && e.mayHaveApplied) {
          // Outcome UNKNOWN. One read-only look for candidates; never a second write, never a verdict.
          const payload = toToolError(e, { tool: 'add_mock_rule', intendedChange: intended, apiKey: cfg.apiKey });
          try {
            const after = (await client.getMockEndpoint(endpointId)).endpoint?.rules ?? [];
            payload.error.details = {
              outcome: 'unknown',
              reconciliation: 'read_ok',
              candidates: candidatesAfterAdd(before, after, wanted),
              note: 'Candidates are NOT proof that your write applied: a concurrent writer can create a look-alike, and your request may still commit after this read. Do not retry add_mock_rule on this evidence. Re-read with get_mock_endpoint after a pause and decide with the user.',
            };
          } catch {
            payload.error.details = { outcome: 'unknown', reconciliation: 'read_failed', candidates: [], note: 'The follow-up read also failed, so there is no evidence either way. Do not retry add_mock_rule until get_mock_endpoint works and you have compared the rules.' };
          }
          return errorResult(payload, cfg.apiKey);
        }
        return fail(e, 'add_mock_rule', intended);
      }
    },
  );

  // ── update_mock_rule ──
  server.tool(
    'update_mock_rule',
    'Edit an EXISTING rule (including the Free starter) in place. WRITE: saved but NOT deployed — call deploy_mock to publish. Requires `expectedUpdatedAt` = the `updatedAt` from your latest get_mock_endpoint; the server applies the change atomically only if nothing changed since, otherwise you get code `conflict` with the current state and your intended change — nothing is overwritten and nothing is retried. Only the fields you pass change: match.method/path, response.statusCode/headers/body, priority (LOWER = evaluated first), isActive. `sequence`: omit = keep the existing Sequence; null = clear it (back to a static response); object = replace it. While a rule has a Sequence its static response is ignored — pass sequence:null to make it static. The server must state atomic compare-and-set support (otherwise the call is refused before sending); a `sequence` field also requires stated Scenario support. If a response is lost, the outcome is UNKNOWN: call get_mock_endpoint before any repeat (repeating with the old token returns conflict if the first call applied, unless another writer also moved the token).',
    {
      endpointId: z.string(),
      ruleId: z.string().describe('Rule id from get_mock_endpoint (the starter rule has one too)'),
      expectedUpdatedAt: z.string().describe('The endpoint updatedAt from your latest get_mock_endpoint (ISO date string)'),
      match: z.object({ method: z.enum(METHODS).optional(), path: z.string().optional() }).optional(),
      response: z.object({ statusCode: z.number().int().min(100).max(599).optional(), headers: headersSchema.optional(), body: z.string().optional() }).optional(),
      priority: z.number().int().optional(),
      isActive: z.boolean().optional(),
      sequence: sequenceSchema.nullable().optional(),
    },
    async ({ endpointId, ruleId, expectedUpdatedAt, match, response, priority, isActive, sequence }) => {
      const patch: RulePatch = { match, response, priority, isActive, sequence };
      const intended = { endpointId, ruleId, expectedUpdatedAt, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
      if (!hasChange(patch)) {
        return errorResult(toToolError(new ApiError('No fields to change', 400, { error: 'Pass at least one of match, response, priority, isActive, sequence.' }), { tool: 'update_mock_rule', intendedChange: intended, apiKey: cfg.apiKey }));
      }
      let currentEp: any;
      let caps: ServerCapabilities;
      try {
        const pre = await client.getMockEndpoint(endpointId);
        currentEp = pre.endpoint;
        caps = parseCapabilities(pre.capabilities);
      } catch (e) {
        return fail(e, 'update_mock_rule', intended);
      }
      // Fail closed: an old server answers 200 while ignoring expectedUpdatedAt and sequence. Only an explicit statement from the server counts.
      if (!(caps.status === 'ok' && caps.atomicCas)) {
        return capabilityRefusal(caps, 'atomic compare-and-set rule updates', intended);
      }
      if (patch.sequence !== undefined) {
        if (!caps.scenarioSupported) {
          return capabilityRefusal(caps, 'Scenario sequences', intended);
        }
        if (patch.sequence !== null && !caps.scenarioEnabled) {
          return scenarioRefusal(caps, intended);
        }
      }
      const current: Rule | undefined = (currentEp.rules ?? []).find((r: Rule) => r.id === ruleId);
      if (!current) {
        return fail(new ApiError('Rule not found', 404, { error: `Rule not found. Rules on this endpoint: ${(currentEp.rules ?? []).map((r: Rule) => r.id).join(', ') || 'none'}` }), 'update_mock_rule', intended);
      }
      if (currentEp.updatedAt !== expectedUpdatedAt) {
        // Detected before writing: same shape as a server conflict so the agent handles one case.
        return fail(new ApiError('conflict', 409, { code: 'rule_conflict', rule: current, endpoint: { updatedAt: currentEp.updatedAt } }), 'update_mock_rule', intended);
      }
      try {
        const result = await client.updateMockRule(endpointId, ruleId, buildPatchPayload(current, patch, expectedUpdatedAt));
        const ep = result.endpoint;
        requireShape(typeof result.rule?.id === 'string' && Array.isArray(ep?.rules) && typeof ep?.updatedAt === 'string', 'rule.id / endpoint.rules / endpoint.updatedAt');
        const warnings = ruleWarnings(ep.rules);
        if (current.sequence?.steps?.length && patch.response && patch.sequence === undefined) {
          warnings.push('This rule still has a Sequence, so the static response you just saved is ignored while the Sequence exists. Pass sequence:null to serve the static response.');
        }
        return ok({
          rule: summarizeRule(result.rule),
          /** New token for the next update. */
          updatedAt: ep.updatedAt,
          state: publishState({ publishedAt: ep.publishedAt, configVersion: ep.configVersion, rules: ep.rules, publishedRules: ep.publishedRules, publishIsolation: ep.publishIsolation }),
          warnings,
          deployed: false,
          message: 'Saved, NOT deployed. The live URL may still serve the previous deploy (see state). Call deploy_mock to publish.',
        });
      } catch (e) {
        return fail(e, 'update_mock_rule', intended);
      }
    },
  );

  // ── reset_mock_sequence ──
  server.tool(
    'reset_mock_sequence',
    'Ask the live mock server to restart ONE rule\'s Sequence at step 1. It affects EVERY caller of the published endpoint (including other people\'s tests) and never changes saved rules. HTTP 202 means QUEUED, not that the data plane has applied it: verify by sending a request and reading list_mock_captures (the capture shows run/step). It acts on the PUBLISHED Sequence only — unpublished edits take effect after deploy_mock. Requires a server that states Scenario support and has it enabled; otherwise the call is refused before sending (this tool never enables flags). It is NOT idempotent or side-effect-free: every call restarts the Sequence again, so after a lost response check get_mock_endpoint / list_mock_captures before repeating.',
    { endpointId: z.string(), ruleId: z.string() },
    async ({ endpointId, ruleId }) => {
      const intended = { endpointId, ruleId };
      try {
        const caps = parseCapabilities((await client.getMockEndpoint(endpointId)).capabilities);
        if (!caps.scenarioSupported) {
          return capabilityRefusal(caps, 'Scenario sequence reset', intended);
        }
        if (!caps.scenarioEnabled) {
          return scenarioRefusal(caps, intended);
        }
        const result = await client.resetMockSequence(endpointId, ruleId);
        requireShape(result?.published === true, 'published:true');
        return ok({
          queued: true,
          observedApplied: false,
          note: 'Reset is QUEUED on the data plane; it is not proof of completion. Send a request and check list_mock_captures for the step it received.',
          serverNote: result.note,
        });
      } catch (e) {
        return fail(e, 'reset_mock_sequence', intended);
      }
    },
  );

  // ── deploy_mock ──
  server.tool(
    'deploy_mock',
    'Publish the CURRENTLY SAVED rules to the live mock server. The only tool that deploys; add/update never do. WRITE: bumps configVersion. Deploys saved rules only — an edit you have not saved is not included. Repeating it is NOT side-effect-free: every call publishes whatever is saved at that moment, including edits saved meanwhile by you or other callers, and bumps the version. After a lost response the outcome is UNKNOWN — check get_mock_endpoint (configVersion, publishedAt, state) before repeating. "Deployed" is not a passing test: verify by calling the URL and reading list_mock_captures.',
    { endpointId: z.string() },
    async ({ endpointId }) => {
      try {
        const result = await client.deployMockEndpoint(endpointId);
        const ep = result.endpoint;
        requireShape(typeof ep?.configVersion === 'number' && Array.isArray(ep?.rules), 'endpoint.configVersion / endpoint.rules');
        return ok({
          ...view(ep),
          message: `Deployed config v${ep?.configVersion}. Next: send a real request to ${ep?.slug ? urlFor(ep.slug) : 'the URL'} and confirm it with list_mock_captures — deploying is not verification.`,
        });
      } catch (e) {
        return fail(e, 'deploy_mock');
      }
    },
  );

  // ── list_mock_captures ──
  server.tool(
    'list_mock_captures',
    'List recent requests that reached a mock endpoint (read-only): method, path, status returned, the matched rule id (null = no rule matched, default 200 empty), and for Sequence rules the run / step / outcome the data plane recorded. Newest first as captured; order inside a Sequence run is only given by its execution number. Use this as the evidence that a deployed rule served what you expect.',
    { endpointId: z.string(), limit: z.number().int().min(1).max(200).optional() },
    async ({ endpointId, limit }) => {
      try {
        const result = await client.listMockCaptures(endpointId, { limit });
        const captures = (result.interactions || []).map((i: any) => ({
          id: i.id,
          method: i.method,
          path: i.path,
          statusCode: i.statusCode,
          matchedRuleId: i.matchedRuleId,
          scenario: i.scenario ?? null,
          occurredAt: i.occurredAt,
          remoteAddress: i.remoteAddress,
        }));
        return ok({ count: captures.length, total: result.total ?? captures.length, captures });
      } catch (e) {
        return fail(e, 'list_mock_captures');
      }
    },
  );
}
