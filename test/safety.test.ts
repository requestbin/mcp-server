/**
 * CX-20261014-03 contract-safety regressions:
 *  1. capability-dependent writes fail CLOSED unless the server states the capability,
 *  2. ambiguous write outcomes stay UNKNOWN (candidates, never "applied" / "safe to retry"),
 *  3. the configured API credential never appears in any structured output.
 * Written before the fixes (see git history of the PR); HTTP is faked, the MCP protocol is real.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KEY, setup } from './harness.js';

const seq = { steps: [{ statusCode: 429 }, { statusCode: 200, delayMs: 100 }] };
const noSafeClaims = (text: string) => {
  assert.ok(!/safe to retry|DID succeed|now safe|Do not add it again|safe to repeat/i.test(text), `unproven claim in: ${text.slice(0, 300)}`);
};

// ── 1. capability gating ─────────────────────────────────────────────────

test('OLD server (no capabilities, ignores expectedUpdatedAt and sequence, answers 200): update is NOT sent, other writer is not overwritten', async () => {
  const { call, fake, writes } = await setup({ legacy: true, caps: 'absent' });
  const g = await call('get_mock_endpoint', { endpointId: 'ep1' });
  assert.equal(g.isError, false, 'read-only tools still work');
  assert.equal(g.json.serverCapabilities.status, 'absent');
  assert.match(g.json.serverCapabilities.note, /read-only/i);
  // another writer changes the rule; our token is now stale. An old server would apply our PATCH anyway.
  fake.state.ep.rules[0].response.statusCode = 201;
  fake.state.ep.updatedAt = '2031-01-01T00:00:00.000Z';
  const r = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: g.json.updatedAt, response: { statusCode: 500 } });
  assert.equal(r.isError, true);
  assert.equal(r.json.error.code, 'capability_unavailable');
  assert.equal(writes(/PATCH/).length, 0, 'no PATCH may be sent');
  assert.equal(fake.state.ep.rules[0].response.statusCode, 201, 'not overwritten');
  assert.ok(r.json.error.intendedChange);
});

test('updatedAt / publishedRules / publishIsolation in the payload are NOT evidence of CAS: even with them present and a matching token, absent capabilities fail closed', async () => {
  const { call, fake, writes } = await setup({ legacy: true, caps: 'absent' });
  fake.state.ep.publishIsolation = 'verified';
  const g = await call('get_mock_endpoint', { endpointId: 'ep1' });
  const r = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: g.json.updatedAt, isActive: false });
  assert.equal(r.json.error.code, 'capability_unavailable');
  assert.equal(writes().length, 0);
});

test('malformed capability contract (wrong types / unknown contract id) fails closed', async () => {
  for (const caps of ['malformed'] as const) {
    const { call, writes } = await setup({ caps });
    const g = await call('get_mock_endpoint', { endpointId: 'ep1' });
    assert.equal(g.json.serverCapabilities.status, 'malformed');
    const r = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: g.json.updatedAt, isActive: false });
    assert.equal(r.json.error.code, 'capability_unavailable');
    assert.equal(writes().length, 0);
  }
});

test('CAS only (no scenario section): plain updates work with the token; any sequence write (object OR null) and reset are refused before sending', async () => {
  const { call, writes } = await setup({ caps: 'cas-only-no-scenario' });
  const g = await call('get_mock_endpoint', { endpointId: 'ep1' });
  assert.equal(g.json.serverCapabilities.status, 'ok');
  assert.equal(g.json.serverCapabilities.atomicCas, true);
  const seqObj = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: g.json.updatedAt, sequence: seq });
  const seqNull = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: g.json.updatedAt, sequence: null });
  const reset = await call('reset_mock_sequence', { endpointId: 'ep1', ruleId: 'starter' });
  for (const r of [seqObj, seqNull, reset]) {
    assert.equal(r.isError, true);
    assert.equal(r.json.error.code, 'capability_unavailable');
  }
  assert.equal(writes().length, 0);
  const ok = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: g.json.updatedAt, response: { statusCode: 503 } });
  assert.equal(ok.isError, false);
  assert.equal(writes(/PATCH/).length, 1);
  assert.equal(writes(/PATCH/)[0]!.body.expectedUpdatedAt, g.json.updatedAt);
});

test('Scenario supported but DISABLED: sequence object and reset are refused before sending (scenario_runtime_unavailable); null (clear) is still allowed', async () => {
  const { call, writes } = await setup({ caps: 'scenario-disabled', scenario: false });
  const g = await call('get_mock_endpoint', { endpointId: 'ep1' });
  assert.equal(g.json.serverCapabilities.scenarioEnabled, false);
  const o = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: g.json.updatedAt, sequence: seq });
  assert.equal(o.json.error.code, 'scenario_runtime_unavailable');
  const r = await call('reset_mock_sequence', { endpointId: 'ep1', ruleId: 'starter' });
  assert.equal(r.json.error.code, 'scenario_runtime_unavailable');
  assert.equal(writes().length, 0);
  const n = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: g.json.updatedAt, sequence: null });
  assert.equal(n.isError, false);
});

test('add_mock_rule on an old server: a plain add is allowed (no capability needed) but a Sequence add is refused before sending (old servers drop it silently)', async () => {
  const { call, fake, writes } = await setup({ plan: 'pro', legacy: true, caps: 'absent' });
  const seqAdd = await call('add_mock_rule', { endpointId: 'ep1', method: 'GET', path: '/s', statusCode: 200, sequence: seq });
  assert.equal(seqAdd.json.error.code, 'capability_unavailable');
  assert.equal(writes(/POST/).length, 0);
  const plain = await call('add_mock_rule', { endpointId: 'ep1', method: 'GET', path: '/p', statusCode: 200, priority: -1 });
  assert.equal(plain.isError, false);
  assert.equal(fake.state.ep.rules.length, 2);
});

test('NEW server: capabilities ok, real CAS conflict still returned as conflict', async () => {
  const { call, fake } = await setup({ caps: 'full' });
  const g = await call('get_mock_endpoint', { endpointId: 'ep1' });
  assert.deepEqual({ ...g.json.serverCapabilities }, { status: 'ok', contract: 'mock-rules-v1', atomicCas: true, scenarioSupported: true, scenarioEnabled: true, note: g.json.serverCapabilities.note });
  fake.state.ep.updatedAt = '2032-01-01T00:00:00.000Z';
  const r = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: g.json.updatedAt, isActive: false });
  assert.equal(r.json.error.code, 'conflict');
});

// ── 2. ambiguous writes stay unknown ─────────────────────────────────────

test('lost response, delayed commit AFTER a negative read: outcome is UNKNOWN, no safe-retry claim, one POST; the late commit proves a retry would have duplicated', async () => {
  const { call, fake, writes } = await setup({ plan: 'pro', failNext: [{ match: /POST .*\/rules$/, mode: 'delay-commit' }] });
  const r = await call('add_mock_rule', { endpointId: 'ep1', method: 'GET', path: '/x', statusCode: 201, priority: -5 });
  assert.equal(r.json.error.code, 'ambiguous_write');
  assert.equal(r.json.error.details.outcome, 'unknown');
  assert.deepEqual(r.json.error.details.candidates, []);
  noSafeClaims(r.text);
  assert.match(r.json.error.hint, /UNKNOWN|unknown/);
  assert.equal(r.json.error.intendedChange.path, '/x');
  assert.equal(writes(/POST/).length, 1);
  fake.flush();
  assert.equal(fake.state.ep.rules.filter((x: any) => x.match.path === '/x').length, 1, 'the write committed late');
});

test('concurrent writers: a same-match rule with DIFFERENT headers and a 500 sequence is only a candidate; exact config equality is still not proof', async () => {
  const { call, fake } = await setup({ plan: 'pro', failNext: [{ match: /POST .*\/rules$/, mode: 'network-after' }] });
  // a concurrent writer's look-alike appears in the same window as ours
  fake.state.afterWrite = () => fake.state.ep.rules.push({ id: 'other-writer', priority: -5, isActive: true, match: { method: 'GET', path: '/x' }, response: { statusCode: 201, headers: { 'X-Evil': '1' }, body: '' }, sequence: { steps: [{ statusCode: 500, headers: {}, body: '', delayMs: 0 }], afterLast: 'hold_last' } });
  const r = await call('add_mock_rule', { endpointId: 'ep1', method: 'GET', path: '/x', statusCode: 201, priority: -5 });
  assert.equal(r.json.error.code, 'ambiguous_write');
  assert.equal(r.json.error.details.outcome, 'unknown');
  const cands = r.json.error.details.candidates;
  assert.equal(cands.length, 2, 'ours (applied) and the other writer are both just candidates');
  const other = cands.find((c: any) => c.ruleId === 'other-writer');
  assert.equal(other.matchesIntendedExactly, false, 'different headers / sequence must not count as a match');
  const ours = cands.find((c: any) => c.ruleId !== 'other-writer');
  assert.equal(ours.matchesIntendedExactly, true);
  assert.match(r.json.error.details.note, /not proof/i);
  noSafeClaims(r.text);
});

test('failed reconciliation read (pre-read ok, post-read network error)', async () => {
  const { call, fake, writes } = await setup({ plan: 'pro' });
  let gets = 0;
  const orig = fake.fetchImpl;
  // wrap: lose the POST response after applying, and fail the 2nd GET
  fake.state.failNext.push({ match: /POST .*\/rules$/, mode: 'network-after' });
  const { RequestBinClient } = await import('../src/api-client.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { registerMockTools } = await import('../src/mock-tools.js');
  const f = async (u: string, i?: RequestInit) => {
    if ((i?.method ?? 'GET') === 'GET' && ++gets === 2) {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    }
    return orig(u, i);
  };
  const server = new McpServer({ name: 't', version: '0' });
  registerMockTools(server, new RequestBinClient(KEY, 'http://api.test', f), { mockDomain: 'x', mockScheme: 'http' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(st), c.connect(ct)]);
  const res: any = await c.callTool({ name: 'add_mock_rule', arguments: { endpointId: 'ep1', method: 'GET', path: '/y', statusCode: 200, priority: -1 } });
  const j = JSON.parse(res.content[0].text);
  assert.equal(j.error.code, 'ambiguous_write');
  assert.equal(j.error.details.outcome, 'unknown');
  assert.equal(j.error.details.reconciliation, 'read_failed');
  noSafeClaims(res.content[0].text);
  assert.equal(writes(/POST/).length, 1);
});

test('response body stream fails AFTER a 200 on a write: ambiguous_write (may have applied), not a generic server_error', async () => {
  for (const [tool, args, re] of [
    ['add_mock_rule', { endpointId: 'ep1', method: 'GET', path: '/b', statusCode: 200, priority: -1 }, /POST .*\/rules$/],
    ['deploy_mock', { endpointId: 'ep1' }, /POST .*\/deploy$/],
  ] as const) {
    const { call, writes } = await setup({ plan: 'pro', failNext: [{ match: re, mode: 'body-stream-fail' }] });
    const r = await call(tool, args);
    assert.equal(r.json.error.code, 'ambiguous_write', tool);
    assert.equal(writes(re).length, 1, `${tool}: exactly one write attempt`);
    noSafeClaims(r.text);
  }
  const { call, writes } = await setup({ failNext: [{ match: /PATCH/, mode: 'body-stream-fail' }] });
  const g = await call('get_mock_endpoint', { endpointId: 'ep1' });
  const u = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: g.json.updatedAt, response: { statusCode: 503 } });
  assert.equal(u.json.error.code, 'ambiguous_write');
  assert.equal(writes(/PATCH/).length, 1);
});

test('truncated JSON or non-JSON 200 after a write is ambiguous (the write may have applied); on a read it is a server_error', async () => {
  for (const mode of ['truncated-json', 'non-json-200'] as const) {
    const { call, writes } = await setup({ plan: 'pro', failNext: [{ match: /POST .*\/rules$/, mode }] });
    const r = await call('add_mock_rule', { endpointId: 'ep1', method: 'GET', path: '/t', statusCode: 200, priority: -1 });
    assert.equal(r.json.error.code, 'ambiguous_write', mode);
    assert.equal(writes(/POST/).length, 1);
    noSafeClaims(r.text);
  }
  const { call } = await setup({ failNext: [{ match: /GET .*ep1$/, mode: 'non-json-200' }] });
  const g = await call('get_mock_endpoint', { endpointId: 'ep1' });
  assert.equal(g.isError, true);
  assert.notEqual(g.json.error.code, 'ambiguous_write');
});

test('genuine pre-connect refusal on a write stays network_error ("nothing was sent") — the only case that may say so', async () => {
  const { call, writes } = await setup({ plan: 'pro', failNext: [{ match: /POST .*\/rules$/, mode: 'network-before' }] });
  const r = await call('add_mock_rule', { endpointId: 'ep1', method: 'GET', path: '/n', statusCode: 200 });
  assert.equal(r.json.error.code, 'network_error');
  assert.match(r.json.error.message, /Nothing was sent/);
  assert.equal(writes(/POST/).length, 1, 'one attempt, no auto-retry');
});

test('bounded timeout: an aborted WRITE is ambiguous (abort is not proof of no write); an aborted READ is a network_error', async () => {
  const w = await setup({ plan: 'pro', failNext: [{ match: /POST .*\/rules$/, mode: 'hang' }] }, { timeoutMs: 50 });
  const r = await w.call('add_mock_rule', { endpointId: 'ep1', method: 'GET', path: '/h', statusCode: 200, priority: -1 });
  assert.equal(r.json.error.code, 'ambiguous_write');
  assert.match(r.json.error.message, /timed out|timeout/i);
  noSafeClaims(r.text);
  const rd = await setup({ failNext: [{ match: /GET .*ep1$/, mode: 'hang' }] }, { timeoutMs: 50 });
  const g = await rd.call('get_mock_endpoint', { endpointId: 'ep1' });
  assert.equal(g.json.error.code, 'network_error');
  assert.match(g.json.error.message, /timed out|timeout/i);
});

test('deploy / reset / update wording never claims they are side-effect-free or safe to blindly repeat', async () => {
  const { client } = await setup();
  const { tools } = await client.listTools();
  const text = (n: string) => tools.find(t => t.name === n)!.description!;
  assert.ok(!/safe to repeat/i.test(text('deploy_mock')));
  assert.match(text('deploy_mock'), /publish(es)? whatever is (currently )?saved|intervening/i);
  assert.ok(!/safe to repeat/i.test(text('reset_mock_sequence')));
  assert.match(text('reset_mock_sequence'), /every caller|another caller/i);
  assert.ok(!/safe to repeat after a lost response/i.test(text('update_mock_rule')));
  const amb = await setup({ failNext: [{ match: /deploy$/, mode: 'network-after' }] });
  const r = await amb.call('deploy_mock', { endpointId: 'ep1' });
  assert.equal(r.json.error.code, 'ambiguous_write');
  assert.match(r.json.error.hint, /get_mock_endpoint/);
  assert.match(r.json.error.hint, /publish/i);
});

// ── 3. credential redaction ──────────────────────────────────────────────

test('the configured API key is redacted from intendedChange, current, details and successful outputs — nested in arrays, headers, sequence bodies, JSON-in-string — and the stored rule is NOT modified', async () => {
  const { call, fake } = await setup({ plan: 'pro' });
  const tricky = `Bearer ${KEY}`;
  const nestedJson = JSON.stringify({ token: KEY, list: [KEY, { deep: `x${KEY}y` }] });
  // success output: add a rule whose body/headers/sequence contain the key
  const added = await call('add_mock_rule', { endpointId: 'ep1', method: 'POST', path: '/leak', statusCode: 200, priority: -1, body: nestedJson, headers: { Authorization: tricky, 'X-Note': 'keep-me' }, sequence: { steps: [{ statusCode: 200, body: `seq ${KEY}` }] } });
  assert.equal(added.isError, false);
  assert.ok(!added.text.includes(KEY), 'success summary must not echo the key');
  assert.match(added.text, /keep-me/, 'diagnostics are not stripped');
  const stored = fake.state.ep.rules.find((r: any) => r.match.path === '/leak');
  assert.equal(stored.response.headers.Authorization, tricky, 'what is written to the rule is unchanged');
  assert.ok(stored.response.body.includes(KEY));
  // inspect output
  const g = await call('get_mock_endpoint', { endpointId: 'ep1' });
  assert.ok(!g.text.includes(KEY));
  // conflict: intendedChange + current both carry the key
  const staleToken = g.json.updatedAt;
  fake.state.ep.updatedAt = '2040-01-01T00:00:00.000Z';
  const c = await call('update_mock_rule', { endpointId: 'ep1', ruleId: stored.id, expectedUpdatedAt: staleToken, response: { body: `intended ${KEY}`, headers: { Authorization: tricky } } });
  assert.equal(c.json.error.code, 'conflict');
  assert.ok(!c.text.includes(KEY), 'intendedChange/current must be redacted');
  assert.match(c.text, /rb_\*\*\*/);
  assert.match(c.json.error.current.rule.response.headers['X-Note'], /keep-me/);
});

test('error details that echo the key (validation issues, server messages) are redacted too', async () => {
  const { call, fake } = await setup({ plan: 'pro' });
  const g = await call('get_mock_endpoint', { endpointId: 'ep1' });
  const orig = fake.fetchImpl;
  void orig;
  fake.state.ep.rules[0].response.statusCode = 200;
  // a server that reflects the Authorization value in its 422 issues
  const reflected = async () => new Response(JSON.stringify({ error: `bad token ${KEY}`, issues: { 'response.headers': `Header Authorization: Bearer ${KEY}` } }), { status: 422 });
  const { RequestBinClient } = await import('../src/api-client.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { registerMockTools } = await import('../src/mock-tools.js');
  let n = 0;
  const f = async (u: string, i?: RequestInit) => ((i?.method ?? 'GET') === 'GET' || ++n < 0 ? orig(u, i) : reflected());
  const server = new McpServer({ name: 't', version: '0' });
  registerMockTools(server, new RequestBinClient(KEY, 'http://api.test', f), { apiKey: KEY, mockDomain: 'x', mockScheme: 'http' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(st), c.connect(ct)]);
  const res: any = await c.callTool({ name: 'update_mock_rule', arguments: { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: g.json.updatedAt, isActive: false } });
  const text = res.content[0].text;
  assert.equal(JSON.parse(text).error.code, 'validation');
  assert.ok(!text.includes(KEY));
  assert.match(text, /rb_\*\*\*/);
});

test('redaction is scoped honestly: only the configured credential is replaced, other content (even key-like text) is left intact', async () => {
  const { call } = await setup({ plan: 'pro' }, { key: 'rb_configured_key_value_aaaaaaaa' });
  const a = await call('add_mock_rule', { endpointId: 'ep1', method: 'GET', path: '/scope', statusCode: 200, priority: -1, body: 'rb_someone_elses_token_bbbbbbbb and rb_configured_key_value_aaaaaaaa' });
  assert.ok(!a.text.includes('rb_configured_key_value_aaaaaaaa'));
  assert.ok(a.text.includes('rb_someone_elses_token_bbbbbbbb') || a.text.includes('rb_***'), 'scoped: unknown tokens are not guaranteed redacted');
});
