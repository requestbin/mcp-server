import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RequestBinClient } from '../src/api-client.js';
import { registerMockTools } from '../src/mock-tools.js';
import { KEY, setup } from './harness.js';

test('tool list is the closure contract and no description advertises globs or higher-priority-first', async () => {
  const { client } = await setup();
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name).sort();
  assert.deepEqual(names, ['add_mock_rule', 'create_mock_endpoint', 'deploy_mock', 'get_mock_endpoint', 'list_mock_captures', 'list_mock_endpoints', 'reset_mock_sequence', 'update_mock_rule']);
  const all = tools.map(t => `${t.description}\n${JSON.stringify(t.inputSchema)}`).join('\n');
  assert.ok(!/api\/v1\/\*/.test(all), 'must not advertise /api/v1/*');
  assert.ok(!/Higher priority rules are evaluated first/i.test(all));
  assert.match(all, /LOWER number first/i);
});

test('Free flow: inspect starter, update it in place to POST /checkout 500, deploy explicitly; exactly one rule; no add; no auto-deploy', async () => {
  const { call, fake } = await setup({ plan: 'free' });
  const got = await call('get_mock_endpoint', { endpointId: 'ep1' });
  assert.equal(got.json.rulesInMatchOrder.length, 1);
  assert.equal(got.json.rulesInMatchOrder[0].id, 'starter');
  assert.equal(got.json.state.kind, 'in_sync');
  const upd = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: got.json.updatedAt, match: { method: 'POST', path: '/checkout' }, response: { statusCode: 500, body: '{"error":"boom"}' } });
  assert.equal(upd.isError, false);
  assert.equal(upd.json.deployed, false);
  assert.equal(upd.json.state.kind, 'unsaved_changes');
  assert.match(upd.json.state.savedChangesServedLive, /unknown/);
  assert.equal(fake.state.calls.filter(c => c.path.endsWith('/deploy')).length, 0, 'update must never deploy');
  const after = await call('get_mock_endpoint', { endpointId: 'ep1' });
  assert.equal(after.json.rulesInMatchOrder.length, 1);
  assert.deepEqual(after.json.rulesInMatchOrder[0].match, { method: 'POST', path: '/checkout' });
  assert.equal(after.json.rulesInMatchOrder[0].response.statusCode, 500);
  const dep = await call('deploy_mock', { endpointId: 'ep1' });
  assert.equal(dep.json.state.kind, 'in_sync');
  assert.match(dep.json.message, /not verification/);
});

test('Free cap: add_mock_rule is rejected as plan_limit, creates nothing, and says to edit the starter', async () => {
  const { call, fake } = await setup({ plan: 'free' });
  const r = await call('add_mock_rule', { endpointId: 'ep1', method: 'POST', path: '/checkout', statusCode: 500 });
  assert.equal(r.isError, true);
  assert.equal(r.json.error.code, 'plan_limit');
  assert.match(r.json.error.hint, /update_mock_rule/);
  assert.equal(fake.state.ep.rules.length, 1);
});

test('CAS: stale token (detected before write) and server-side conflict both return conflict + intended change + current; nothing overwritten', async () => {
  const { call, fake } = await setup();
  const got = await call('get_mock_endpoint', { endpointId: 'ep1' });
  const stale = got.json.updatedAt;
  // someone else changes the rule
  fake.state.ep.rules[0].response.statusCode = 201;
  fake.state.ep.updatedAt = '2030-01-01T00:00:00.000Z';
  const r = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: stale, response: { statusCode: 500 } });
  assert.equal(r.isError, true);
  assert.equal(r.json.error.code, 'conflict');
  assert.equal(r.json.error.intendedChange.response.statusCode, 500);
  assert.equal(r.json.error.current.updatedAt, '2030-01-01T00:00:00.000Z');
  assert.equal(r.json.error.current.rule.response.statusCode, 201);
  assert.equal(fake.state.ep.rules[0].response.statusCode, 201, 'the other change was not overwritten');
  assert.equal(fake.state.calls.filter(c => c.method === 'PATCH').length, 0, 'no PATCH was sent for a stale token');
  // race between our read and write: the server CAS rejects
  const ok1 = await call('get_mock_endpoint', { endpointId: 'ep1' });
  const orig = fake.fetchImpl;
  let raced = false;
  const patchFetch = async (u: string, i?: RequestInit) => {
    if (!raced && (i?.method ?? 'GET') === 'PATCH') {
      raced = true;
      fake.state.ep.updatedAt = '2031-01-01T00:00:00.000Z';
    }
    return orig(u, i);
  };
  const server2 = new McpServer({ name: 't', version: '0' });
  registerMockTools(server2, new RequestBinClient(KEY, 'http://api.test', patchFetch), { mockDomain: 'x', mockScheme: 'http' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c2 = new Client({ name: 'c', version: '0' });
  await Promise.all([server2.connect(st), c2.connect(ct)]);
  const res: any = await c2.callTool({ name: 'update_mock_rule', arguments: { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: ok1.json.updatedAt, response: { statusCode: 500 } } });
  const j = JSON.parse(res.content[0].text);
  assert.equal(j.error.code, 'conflict');
  assert.equal(fake.state.ep.rules[0].response.statusCode, 201);
});

test('sequence: omitted preserves, object replaces, null clears; static edit on a sequence rule warns', async () => {
  const { call } = await setup({ plan: 'free', scenario: true });
  let g = await call('get_mock_endpoint', { endpointId: 'ep1' });
  const seq = { steps: [{ statusCode: 429 }, { statusCode: 200, delayMs: 5000 }] };
  let u = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: g.json.updatedAt, match: { method: 'GET', path: '/pay' }, sequence: seq });
  assert.equal(u.json.rule.sequence.steps.length, 2);
  assert.equal(u.json.rule.sequence.steps[1].delayMs, 5000);
  u = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: u.json.updatedAt, response: { body: 'static' } });
  assert.equal(u.json.rule.sequence.steps.length, 2, 'omitted sequence is preserved');
  assert.ok(u.json.warnings.some((w: string) => /Sequence/.test(w)));
  u = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: u.json.updatedAt, sequence: null });
  assert.equal(u.json.rule.sequence, null, 'null clears');
});

test('scenario runtime disabled: sequence write and reset are actionable errors, never success, rule unchanged', async () => {
  const { call, fake } = await setup({ scenario: false });
  const g = await call('get_mock_endpoint', { endpointId: 'ep1' });
  const u = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: g.json.updatedAt, sequence: { steps: [{ statusCode: 429 }] } });
  assert.equal(u.isError, true);
  assert.equal(u.json.error.code, 'scenario_runtime_unavailable');
  assert.equal(fake.state.ep.rules[0].sequence, undefined);
  const r = await call('reset_mock_sequence', { endpointId: 'ep1', ruleId: 'starter' });
  assert.equal(r.isError, true);
  assert.equal(r.json.error.code, 'scenario_runtime_unavailable');
});

test('reset: 202 is reported as queued, not applied; rule without a sequence is no_sequence', async () => {
  const { call } = await setup({ scenario: true });
  const none = await call('reset_mock_sequence', { endpointId: 'ep1', ruleId: 'starter' });
  assert.equal(none.json.error.code, 'no_sequence');
  const g = await call('get_mock_endpoint', { endpointId: 'ep1' });
  await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: g.json.updatedAt, sequence: { steps: [{ statusCode: 429 }, { statusCode: 200 }] } });
  const r = await call('reset_mock_sequence', { endpointId: 'ep1', ruleId: 'starter' });
  assert.equal(r.isError, false);
  assert.equal(r.json.queued, true);
  assert.equal(r.json.observedApplied, false);
});

test('priority: the Free catch-all starter shadows a new specific rule at priority 0; a LOWER number takes precedence; warning explains it', async () => {
  const { call } = await setup({ plan: 'pro' });
  const shadowed = await call('add_mock_rule', { endpointId: 'ep1', method: 'POST', path: '/checkout', statusCode: 500 });
  assert.ok(shadowed.json.warnings.some((w: string) => /never reached/.test(w)), 'equal priority keeps the catch-all first');
  const first = await call('add_mock_rule', { endpointId: 'ep1', method: 'POST', path: '/pay', statusCode: 402, priority: -1 });
  assert.equal(first.json.warnings.filter((w: string) => /POST \/pay/.test(w)).length, 0);
  const g = await call('get_mock_endpoint', { endpointId: 'ep1' });
  assert.equal(g.json.rulesInMatchOrder[0].match.path, '/pay', 'lower priority number is evaluated first');
  assert.equal(g.json.rulesInMatchOrder.at(-1).match.path, '/checkout');
});

test('network loss: before send = network_error (nothing sent); after an applied write = ambiguous_write with UNKNOWN outcome and candidates only — never a verdict', async () => {
  const { call, fake } = await setup({ plan: 'pro', failNext: [{ match: /POST .*\/rules$/, mode: 'network-after' }] });
  const r = await call('add_mock_rule', { endpointId: 'ep1', method: 'GET', path: '/x', statusCode: 201, priority: -5 });
  assert.equal(r.isError, true);
  assert.equal(r.json.error.code, 'ambiguous_write');
  assert.equal(r.json.error.details.outcome, 'unknown');
  assert.equal(r.json.error.details.candidates.length, 1);
  assert.equal(r.json.error.details.candidates[0].matchesIntendedExactly, true);
  assert.ok(!/DID succeed|safe to retry/i.test(r.text));
  assert.equal(fake.state.ep.rules.length, 2);
  assert.equal(fake.state.calls.filter(c => c.method === 'POST' && c.path.endsWith('/rules')).length, 1, 'exactly one write attempt');

  const b = await setup({ plan: 'pro', failNext: [{ match: /POST .*\/rules$/, mode: 'network-before' }] });
  const r2 = await b.call('add_mock_rule', { endpointId: 'ep1', method: 'GET', path: '/x', statusCode: 201 });
  assert.equal(r2.json.error.code, 'network_error');
  assert.match(r2.json.error.hint, /No state changed/);
});

test('5xx after the write on update is ambiguous_write and tells the agent to re-read', async () => {
  const { call } = await setup({ failNext: [{ match: /PATCH/, mode: '500-after' }] });
  const g = await call('get_mock_endpoint', { endpointId: 'ep1' });
  const r = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: g.json.updatedAt, response: { statusCode: 503 } });
  assert.equal(r.json.error.code, 'ambiguous_write');
  assert.match(r.json.error.hint, /get_mock_endpoint/);
  const again = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: g.json.updatedAt, response: { statusCode: 503 } });
  assert.equal(again.json.error.code, 'conflict', 'repeating with the old token cannot double-apply');
});

test('validation and not-found are structured; invalid input changes nothing', async () => {
  const { call, fake } = await setup();
  const g = await call('get_mock_endpoint', { endpointId: 'ep1' });
  // schema-level (zod) rejection happens before any HTTP call
  const bad: any = await (async () => { try { return await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: g.json.updatedAt, response: { statusCode: 999 } }); } catch (e: any) { return { thrown: e.message }; } })();
  assert.ok(bad.thrown || bad.isError);
  assert.equal(fake.state.calls.filter(c => c.method === 'PATCH').length, 0);
  const nf = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'nope', expectedUpdatedAt: g.json.updatedAt, isActive: false });
  assert.equal(nf.json.error.code, 'not_found');
  const wrong = await call('get_mock_endpoint', { endpointId: 'other-account-endpoint' });
  assert.equal(wrong.json.error.code, 'not_found');
  const empty = await call('update_mock_rule', { endpointId: 'ep1', ruleId: 'starter', expectedUpdatedAt: g.json.updatedAt });
  assert.equal(empty.json.error.code, 'bad_request');
});

test('the API key never appears in any tool output, including errors', async () => {
  const { call } = await setup({ failNext: [{ match: /GET/, mode: 'network-before' }] });
  const outs = [
    await call('get_mock_endpoint', { endpointId: 'ep1' }),
    await call('list_mock_endpoints'),
    await call('get_mock_endpoint', { endpointId: 'zzz' }),
  ];
  for (const o of outs) {
    assert.ok(!o.text.includes(KEY) && !/rb_test_super/.test(o.text));
  }
});

test('legacy endpoint (no published snapshot) never claims isolation', async () => {
  const { call, fake } = await setup();
  delete fake.state.ep.publishedRules;
  const g = await call('get_mock_endpoint', { endpointId: 'ep1' });
  assert.equal(g.json.state.kind, 'legacy');
  assert.match(g.json.state.detail, /MAY already be live/);
});

test('unsupported path glob / params are accepted by the API but flagged as literal (never advertised as working)', async () => {
  const { call } = await setup({ plan: 'pro' });
  const a = await call('add_mock_rule', { endpointId: 'ep1', method: 'GET', path: '/api/v1/*', statusCode: 200, priority: -1 });
  assert.ok(a.json.warnings.some((w: string) => /LITERAL/.test(w)));
  const g = await call('get_mock_endpoint', { endpointId: 'ep1' });
  assert.ok(g.json.warnings.some((w: string) => /\/api\/v1\/\*/.test(w) && /LITERAL/.test(w)));
  const p = await call('add_mock_rule', { endpointId: 'ep1', method: 'GET', path: '/users/:id', statusCode: 200, priority: -2 });
  assert.ok(p.json.warnings.some((w: string) => /users\/:id/.test(w)));
});
