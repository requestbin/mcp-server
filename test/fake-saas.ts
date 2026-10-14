/**
 * Minimal in-memory stand-in for the RequestBin mock API, used ONLY by unit tests. It reproduces the contracts the
 * tools rely on (CAS 409 rule_conflict, 403 plan limit body, 422 issues, flag-gated sequence/reset, 202 reset) so the
 * MCP layer can be tested through the real MCP protocol client. It is not evidence about the real server — the
 * live demo (docs/demo) is.
 */
export type Opts = { plan?: 'free' | 'pro'; scenario?: boolean; failNext?: Array<{ match: RegExp; mode: 'network-before' | 'network-after' | '500-after' }> };

let counter = 0;

export function createFakeSaas(opts: Opts = {}) {
  const plan = opts.plan ?? 'free';
  const cap = plan === 'free' ? 1 : 5;
  const state = {
    ep: null as any,
    calls: [] as Array<{ method: string; path: string; body?: any }>,
    scenario: opts.scenario ?? true,
    failNext: [...(opts.failNext ?? [])],
    clock: 1000,
  };
  const tick = () => new Date(1_700_000_000_000 + (state.clock += 1000)).toISOString();

  function createEndpoint() {
    state.ep = {
      id: 'ep1', slug: 'abc12', name: 'x', status: 'active', configVersion: 1, publishedAt: tick(), updatedAt: tick(),
      publishIsolation: 'unverified',
      rules: [{ id: 'starter', priority: 0, isActive: true, match: { method: '*', path: '*' }, response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: '{"hello":"abc12"}' } }],
    };
    state.ep.publishedRules = JSON.parse(JSON.stringify(state.ep.rules));
  }
  createEndpoint();

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    state.calls.push({ method, path, body });

    const fail = state.failNext.find(f => f.match.test(`${method} ${path}`));
    if (fail) {
      state.failNext.splice(state.failNext.indexOf(fail), 1);
      if (fail.mode === 'network-before') {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      }
      // apply first, then lose the response (the dangerous case)
      const res = await handle(method, path, body);
      if (fail.mode === 'network-after') {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      }
      void res;
      return json(500, { error: 'Internal server error' });
    }
    return handle(method, path, body);
  };

  async function handle(method: string, path: string, body: any): Promise<Response> {
    let m: RegExpMatchArray | null;
    if (method === 'GET' && (m = path.match(/^\/api\/mock-endpoints\/([^/]+)$/))) {
      return m[1] === state.ep.id ? json(200, { endpoint: state.ep }) : json(404, { error: 'Endpoint not found' });
    }
    if (method === 'POST' && (m = path.match(/^\/api\/mock-endpoints\/([^/]+)\/rules$/))) {
      if (m[1] !== state.ep.id) {
        return json(404, { error: 'Endpoint not found' });
      }
      if (state.ep.rules.length >= cap) {
        return json(403, { allowed: false, error: `You've reached the ${cap} mock rule limit on your ${plan} plan.`, currentPlan: plan, requiredPlan: plan === 'free' ? 'pro' : 'team', usage: { current: state.ep.rules.length, max: cap } });
      }
      if (body.sequence && !state.scenario) {
        return json(422, { error: 'Validation failed', issues: { sequence: 'Scenario sequences are not enabled' } });
      }
      const rule = { id: `r${++counter}`, priority: body.priority ?? 0, isActive: body.isActive ?? true, match: body.match, response: { statusCode: body.response.statusCode, headers: body.response.headers ?? {}, body: body.response.body ?? '' }, ...(body.sequence ? { sequence: body.sequence } : {}) };
      state.ep.rules.push(rule);
      state.ep.updatedAt = tick();
      return json(201, { rule, endpoint: state.ep });
    }
    if (method === 'PATCH' && (m = path.match(/^\/api\/mock-endpoints\/([^/]+)\/rules\/([^/]+)$/))) {
      const rule = state.ep.rules.find((r: any) => r.id === m![2]);
      const conflict = () => json(409, { error: 'This rule changed since you opened the comparison.', code: 'rule_conflict', rule: rule ?? null, endpoint: state.ep });
      if (body.expectedUpdatedAt && body.expectedUpdatedAt !== state.ep.updatedAt) {
        return conflict();
      }
      if (!rule) {
        return json(404, { error: 'Rule not found' });
      }
      if (body.sequence && !state.scenario) {
        return json(422, { error: 'Validation failed', issues: { sequence: 'Scenario sequences are not enabled' } });
      }
      if (body.response && (body.response.statusCode < 100 || body.response.statusCode > 599)) {
        return json(422, { error: 'Validation failed', issues: { 'response.statusCode': 'Status code must be an integer in 100–599' } });
      }
      if (body.priority !== undefined) {
        rule.priority = body.priority;
      }
      if (body.isActive !== undefined) {
        rule.isActive = body.isActive;
      }
      if (body.match) {
        rule.match = body.match;
      }
      if (body.response) {
        rule.response = body.response;
      }
      if (body.sequence === null) {
        delete rule.sequence;
      } else if (body.sequence) {
        rule.sequence = body.sequence;
      }
      state.ep.updatedAt = tick();
      return json(200, { rule, endpoint: state.ep });
    }
    if (method === 'POST' && (m = path.match(/^\/api\/mock-endpoints\/([^/]+)\/rules\/([^/]+)\/reset$/))) {
      if (!state.scenario) {
        return json(404, { error: 'Not found' });
      }
      const rule = state.ep.rules.find((r: any) => r.id === m![2]);
      if (!rule) {
        return json(404, { error: 'Rule not found' });
      }
      if (!rule.sequence) {
        return json(409, { error: 'This rule has no sequence to reset' });
      }
      return json(202, { published: true, note: 'Reset sent to the live mock server.' });
    }
    if (method === 'POST' && (m = path.match(/^\/api\/mock-endpoints\/([^/]+)\/deploy$/))) {
      state.ep.configVersion += 1;
      state.ep.publishedAt = tick();
      state.ep.publishedRules = JSON.parse(JSON.stringify(state.ep.rules));
      state.ep.updatedAt = tick();
      return json(200, { endpoint: state.ep });
    }
    if (method === 'GET' && /\/interactions$/.test(path)) {
      return json(200, { interactions: [], total: 0 });
    }
    return json(404, { error: 'Not found' });
  }

  return { fetchImpl, state, createEndpoint };
}
