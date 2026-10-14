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
import { ApiError, errorResult, toToolError } from './errors.js';
import type { Rule, RulePatch } from './mock-logic.js';
import { buildPatchPayload, hasChange, looksLikeCreated, MATCH_SEMANTICS, matchOrder, publishState, ruleWarnings, summarizeRule } from './mock-logic.js';

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
  const ok = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] });
  const fail = (err: unknown, tool: string, intendedChange?: unknown) => errorResult(toToolError(err, { tool, intendedChange, apiKey: cfg.apiKey }));

  const view = (ep: any) => {
    const rules: Rule[] = ep.rules ?? [];
    return {
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
        return ok(view(result.endpoint));
      } catch (e) {
        return fail(e, 'get_mock_endpoint');
      }
    },
  );

  // ── add_mock_rule ──
  server.tool(
    'add_mock_rule',
    `Append a rule to a mock endpoint (WRITE; saved but NOT deployed — call deploy_mock to publish). ${MATCH_SEMANTICS} A new rule is appended with the priority you give (default 0); a catch-all with an equal or lower priority number is evaluated first and will shadow it — the result lists such warnings. Plan caps apply per endpoint (Free 1 / PRO 5 / TEAM 20); a cap rejection is plan_limit and creates nothing. On Free use update_mock_rule on the starter instead. After a network failure or 5xx this tool does NOT retry; it checks the endpoint once and reports whether the rule now exists so you do not add a duplicate.`,
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
      let before: Rule[] | null = null;
      try {
        before = (await client.getMockEndpoint(endpointId)).endpoint?.rules ?? [];
      } catch (e) {
        return fail(e, 'add_mock_rule', intended);
      }
      try {
        const result = await client.addMockRule(endpointId, {
          match: { method, path },
          response: { statusCode, headers: headers || {}, body: body || '' },
          priority,
          ...(sequence ? { sequence } : {}),
        });
        const ep = result.endpoint;
        return ok({
          rule: result.rule ? summarizeRule(result.rule) : null,
          updatedAt: ep?.updatedAt,
          warnings: ruleWarnings(ep?.rules ?? []),
          deployed: false,
          message: 'Rule saved. Nothing is deployed yet — call deploy_mock to publish.',
        });
      } catch (e) {
        if (e instanceof ApiError && e.mayHaveApplied) {
          // Ambiguous: look once, never write again.
          try {
            const now = (await client.getMockEndpoint(endpointId)).endpoint?.rules ?? [];
            const known = new Set((before ?? []).map(r => r.id));
            const created = now.find((r: Rule) => !known.has(r.id) && looksLikeCreated(r, { method, path, statusCode, priority: priority ?? 0, body: body || '' }));
            const payload = toToolError(e, { tool: 'add_mock_rule', intendedChange: intended, apiKey: cfg.apiKey });
            payload.error.details = created
              ? { reconciled: 'applied', ruleId: created.id, note: 'The write DID succeed. Do not add it again.' }
              : { reconciled: 'not_found', note: 'No matching new rule exists after re-reading. It is now safe to retry once.' };
            return errorResult(payload);
          } catch {
            return fail(e, 'add_mock_rule', intended);
          }
        }
        return fail(e, 'add_mock_rule', intended);
      }
    },
  );

  // ── update_mock_rule ──
  server.tool(
    'update_mock_rule',
    'Edit an EXISTING rule (including the Free starter) in place. WRITE: saved but NOT deployed — call deploy_mock to publish. Requires `expectedUpdatedAt` = the `updatedAt` from your latest get_mock_endpoint; the server applies the change atomically only if nothing changed since, otherwise you get code `conflict` with the current state and your intended change — nothing is overwritten and nothing is retried. Only the fields you pass change: match.method/path, response.statusCode/headers/body, priority (LOWER = evaluated first), isActive. `sequence`: omit = keep the existing Sequence; null = clear it (back to a static response); object = replace it. While a rule has a Sequence its static response is ignored — pass sequence:null to make it static. Safe to repeat after a lost response: the repeated call returns conflict if the first one was applied (the token moved).',
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
      try {
        currentEp = (await client.getMockEndpoint(endpointId)).endpoint;
      } catch (e) {
        return fail(e, 'update_mock_rule', intended);
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
        const warnings = ruleWarnings(ep?.rules ?? []);
        if (current.sequence?.steps?.length && patch.response && patch.sequence === undefined) {
          warnings.push('This rule still has a Sequence, so the static response you just saved is ignored while the Sequence exists. Pass sequence:null to serve the static response.');
        }
        return ok({
          rule: result.rule ? summarizeRule(result.rule) : null,
          /** New token for the next update. */
          updatedAt: ep?.updatedAt,
          state: ep ? publishState({ publishedAt: ep.publishedAt, configVersion: ep.configVersion, rules: ep.rules ?? [], publishedRules: ep.publishedRules, publishIsolation: ep.publishIsolation }) : null,
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
    'Ask the live mock server to restart ONE rule\'s Sequence at step 1. WRITE-like, affects every caller of the published endpoint, never changes saved rules. HTTP 202 means QUEUED, not that the data plane has applied it: verify by sending a request and reading list_mock_captures (the capture shows run/step). It acts on the PUBLISHED Sequence only — unpublished edits take effect after deploy_mock. If the server has the Scenario runtime disabled you get scenario_runtime_unavailable (a capability gap; this tool never enables flags). Safe to repeat.',
    { endpointId: z.string(), ruleId: z.string() },
    async ({ endpointId, ruleId }) => {
      try {
        const result = await client.resetMockSequence(endpointId, ruleId);
        return ok({
          queued: Boolean(result.published),
          observedApplied: false,
          note: 'Reset is QUEUED on the data plane; it is not proof of completion. Send a request and check list_mock_captures for the step it received.',
          serverNote: result.note,
        });
      } catch (e) {
        return fail(e, 'reset_mock_sequence', { endpointId, ruleId });
      }
    },
  );

  // ── deploy_mock ──
  server.tool(
    'deploy_mock',
    'Publish the CURRENTLY SAVED rules to the live mock server. The only tool that deploys; add/update never do. WRITE: bumps configVersion. Deploys saved rules only — an edit you have not saved is not included. Safe to repeat (it just bumps the version again). "Deployed" is not a passing test: verify by calling the URL and reading list_mock_captures.',
    { endpointId: z.string() },
    async ({ endpointId }) => {
      try {
        const result = await client.deployMockEndpoint(endpointId);
        const ep = result.endpoint;
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
