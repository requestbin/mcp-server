/**
 * Live MCP demo (CX-20261014-02): REAL MCP protocol client -> `node dist/index.js` (stdio) -> RequestBin API ->
 * mock data plane over HTTP -> persisted capture. Deterministic script, NOT an LLM run.
 *
 *   KEYS_FILE=/path/keys.env REQUESTBIN_BASE_URL=http://localhost:3000 MOCK_PORT=8081 node demo/live-demo.mjs <scenario>
 *   scenarios: free | sequence | pro | failures
 * Keys are read from KEYS_FILE (RB_KEY_FREE / RB_KEY_FREE2 / RB_KEY_PRO / RB_KEY_OTHER), passed only via the child's environment and
 * redacted from the transcript. Writes JSON lines to stdout.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const keys = Object.fromEntries(fs.readFileSync(process.env.KEYS_FILE, 'utf8').trim().split('\n').map(l => l.split('=')));
const BASE = process.env.REQUESTBIN_BASE_URL || 'http://localhost:3000';
const MOCK_PORT = Number(process.env.MOCK_PORT || 8081);
const redact = s => Object.values(keys).reduce((t, k) => t.split(k).join('rb_***'), s);
const log = (step, data) => console.log(redact(JSON.stringify({ step, ...data })));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect(keyName, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, '..', 'dist', 'index.js')],
    env: { PATH: process.env.PATH, REQUESTBIN_API_KEY: keys[keyName], REQUESTBIN_BASE_URL: extraEnv.REQUESTBIN_BASE_URL ?? BASE, REQUESTBIN_MOCK_DOMAIN: `localhost:${MOCK_PORT}`, REQUESTBIN_MOCK_SCHEME: 'http', ...extraEnv },
  });
  const client = new Client({ name: 'live-demo', version: '1.0.0' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? '';
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    log(`tool:${name}`, { args, isError: Boolean(res.isError), result: json });
    return { isError: Boolean(res.isError), json };
  };
  return { client, call, close: () => client.close() };
}

/** Real HTTP to the mock data plane (Host header routes by slug; no DNS or new port needed). timeoutMs aborts the CLIENT. */
function hit(slug, method, p, { body, timeoutMs = 15000, headers = {} } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port: MOCK_PORT, path: p, method, headers: { Host: `${slug}.localhost:${MOCK_PORT}`, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers }, timeout: timeoutMs }, (res) => {
      let data = ''; res.on('data', d => (data += d)); res.on('end', () => resolve({ status: res.statusCode, body: data.slice(0, 200), ms: Date.now() - t0 }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'CLIENT_TIMEOUT', ms: Date.now() - t0 }); });
    req.on('error', e => resolve({ status: 'ERROR', error: e.code, ms: Date.now() - t0 }));
    if (body) req.write(body);
    req.end();
  });
}

async function captures(call, id, want, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const r = await call('list_mock_captures', { endpointId: id, limit: 20 });
    if (r.json.count >= want) return r.json;
    await sleep(1000);
  }
  return (await call('list_mock_captures', { endpointId: id, limit: 20 })).json;
}

const scenarios = {
  /** 1. Free: create -> inspect -> update starter -> explicit deploy -> real HTTP -> capture. Exactly one rule throughout. */
  async free() {
    const m = await connect('RB_KEY_FREE');
    const before = (await m.call('list_mock_endpoints')).json.length;
    const created = (await m.call('create_mock_endpoint', { name: 'cx-demo-free' })).json;
    const { id, slug } = created; const starter = created.rulesInMatchOrder[0].id;
    log('check', { rulesAfterCreate: created.rulesInMatchOrder.length, endpointsBefore: before });
    const got = (await m.call('get_mock_endpoint', { endpointId: id })).json;
    const upd = await m.call('update_mock_rule', { endpointId: id, ruleId: starter, expectedUpdatedAt: got.updatedAt, match: { method: 'POST', path: '/checkout' }, response: { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: '{"error":"payment_provider_down"}' } });
    log('http-before-deploy', { note: 'saved, NOT deployed: the live URL still serves the previous deploy', res: await hit(slug, 'POST', '/checkout') });
    await m.call('deploy_mock', { endpointId: id });
    const live = await hit(slug, 'POST', '/checkout', { body: '{"amount":1}' });
    log('http-after-deploy', { res: live });
    const caps = await captures(m.call, id, 2);
    const cap = caps.captures.find(c => c.path === '/checkout' && c.method === 'POST' && c.statusCode === 500);
    log('check', { captureMatchedStarter: cap?.matchedRuleId === starter, statusCode: cap?.statusCode, captureId: cap?.id });
    await m.call('add_mock_rule', { endpointId: id, method: 'GET', path: '/extra', statusCode: 200 });
    const end = (await m.call('get_mock_endpoint', { endpointId: id })).json;
    log('check', { rulesAtEnd: end.rulesInMatchOrder.length, endpointsAfter: (await m.call('list_mock_endpoints')).json.length, updated: upd.isError === false });
    log('summary', { endpointId: id, slug, starterRuleId: starter });
    return { m, id, slug, starter };
  },

  /** 2. Same Free rule -> Sequence 429 / 5000 ms delay / 200, publish, real HTTP, persisted run/step, Reset, observed restart. */
  async sequence(ctx) {
    const { m, id, slug, starter } = ctx;
    const g = (await m.call('get_mock_endpoint', { endpointId: id })).json;
    await m.call('update_mock_rule', { endpointId: id, ruleId: starter, expectedUpdatedAt: g.updatedAt, match: { method: 'GET', path: '/pay' }, sequence: { steps: [{ statusCode: 429, headers: { 'Retry-After': '1' }, body: '{"error":"rate_limited"}' }, { statusCode: 200, delayMs: 5000, body: '{"ok":true}' }] } });
    await m.call('deploy_mock', { endpointId: id });
    const r1 = await hit(slug, 'GET', '/pay'); log('http-1', { expect: 429, res: r1 });
    const r2 = await hit(slug, 'GET', '/pay', { timeoutMs: 2000 }); log('http-2', { expect: 'CLIENT_TIMEOUT (step 2 delays 5000 ms)', res: r2 });
    await sleep(4500);
    const r3 = await hit(slug, 'GET', '/pay', { timeoutMs: 12000 }); log('http-3', { expect: '200 after ~5 s (hold_last)', res: r3 });
    const caps1 = await captures(m.call, id, 3, 25);
    log('captures-before-reset', { scenario: caps1.captures.filter(c => c.path === '/pay').map(c => ({ id: c.id, statusCode: c.statusCode, matchedRuleId: c.matchedRuleId, scenario: c.scenario })) });
    const reset = await m.call('reset_mock_sequence', { endpointId: id, ruleId: starter });
    await sleep(2000);
    const r4 = await hit(slug, 'GET', '/pay'); log('http-after-reset', { expect: '429 (back to step 1)', res: r4 });
    const caps2 = await captures(m.call, id, caps1.count + 1, 25);
    log('captures-after-reset', { latest: caps2.captures.filter(c => c.path === '/pay').slice(0, 1).map(c => ({ id: c.id, statusCode: c.statusCode, scenario: c.scenario })), resetQueued: reset.json.queued, resetObservedApplied: reset.json.observedApplied });
    const g2 = (await m.call('get_mock_endpoint', { endpointId: id })).json;
    await m.call('update_mock_rule', { endpointId: id, ruleId: starter, expectedUpdatedAt: g2.updatedAt, sequence: null });
    log('summary', { note: 'sequence cleared (null) to leave the synthetic endpoint static' });
  },

  /** 3. PRO: catch-all starter shadows a new specific rule at priority 0; a LOWER number wins; unsupported glob is literal; cap rejection. */
  async pro() {
    const m = await connect('RB_KEY_PRO');
    const created = (await m.call('create_mock_endpoint', { name: 'cx-demo-pro' })).json;
    const { id, slug } = created; const starter = created.rulesInMatchOrder[0].id;
    const add = (await m.call('add_mock_rule', { endpointId: id, method: 'POST', path: '/checkout', statusCode: 500, body: '{"error":"boom"}' })).json;
    log('check', { shadowWarning: add.warnings });
    await m.call('deploy_mock', { endpointId: id });
    const shadowed = await hit(slug, 'POST', '/checkout', { body: '{}' }); log('http-shadowed', { expect: '200 starter wins at equal priority', res: shadowed });
    const g = (await m.call('get_mock_endpoint', { endpointId: id })).json;
    const ruleId = add.rule.id;
    await m.call('update_mock_rule', { endpointId: id, ruleId, expectedUpdatedAt: g.updatedAt, priority: -1 });
    await m.call('deploy_mock', { endpointId: id });
    const wins = await hit(slug, 'POST', '/checkout', { body: '{}' }); log('http-specific-wins', { expect: 500, res: wins });
    const caps = await captures(m.call, id, 2);
    log('check', { latestCaptureMatchedSpecific: caps.captures.find(c => c.statusCode === 500)?.matchedRuleId === ruleId });
    const glob = (await m.call('add_mock_rule', { endpointId: id, method: 'GET', path: '/api/v1/*', statusCode: 418, priority: -2 })).json;
    await m.call('deploy_mock', { endpointId: id });
    const lit = await hit(slug, 'GET', '/api/v1/users'); log('http-glob-is-literal', { globWarnings: glob.warnings, expect: 'not 418: path glob matches literally only (falls to starter 200)', res: lit });
    for (let i = 0; i < 3; i++) await m.call('add_mock_rule', { endpointId: id, method: 'GET', path: `/fill${i}`, statusCode: 200, priority: 10 + i });
    const over = await m.call('add_mock_rule', { endpointId: id, method: 'GET', path: '/overflow', statusCode: 200, priority: 20 });
    const end = (await m.call('get_mock_endpoint', { endpointId: id })).json;
    log('check', { ruleCapRejected: over.json.error?.code, rulesAtEnd: end.rulesInMatchOrder.length });
    await m.close();
  },

  /** 4. Conflict, repeat, wrong account, invalid input, ambiguous/ordinary network loss — on a fresh Free endpoint. */
  async failures() {
    const a = await connect('RB_KEY_FREE2');
    const created = (await a.call('create_mock_endpoint', { name: 'cx-demo-failures' })).json;
    const { id } = created; const starter = created.rulesInMatchOrder[0].id;
    const tokenA = (await a.call('get_mock_endpoint', { endpointId: id })).json.updatedAt;
    const b = await connect('RB_KEY_FREE2');
    const bu = await b.call('update_mock_rule', { endpointId: id, ruleId: starter, expectedUpdatedAt: tokenA, response: { statusCode: 201 } });
    const conflict = await a.call('update_mock_rule', { endpointId: id, ruleId: starter, expectedUpdatedAt: tokenA, response: { statusCode: 202 } });
    log('check', { conflictCode: conflict.json.error?.code, hasIntended: Boolean(conflict.json.error?.intendedChange), hasCurrent: Boolean(conflict.json.error?.current?.updatedAt), otherChangeKept: bu.isError === false });
    const repeat = await b.call('update_mock_rule', { endpointId: id, ruleId: starter, expectedUpdatedAt: tokenA, response: { statusCode: 201 } });
    log('check', { repeatWithOldTokenCode: repeat.json.error?.code });
    const o = await connect('RB_KEY_OTHER');
    const wrongGet = await o.call('get_mock_endpoint', { endpointId: id });
    const wrongUpd = await o.call('update_mock_rule', { endpointId: id, ruleId: starter, expectedUpdatedAt: tokenA, isActive: false });
    const wrongDeploy = await o.call('deploy_mock', { endpointId: id });
    log('check', { wrongAccount: [wrongGet.json.error?.code, wrongUpd.json.error?.code, wrongDeploy.json.error?.code] });
    const fresh = (await a.call('get_mock_endpoint', { endpointId: id })).json;
    const invalid = await a.call('update_mock_rule', { endpointId: id, ruleId: starter, expectedUpdatedAt: fresh.updatedAt, match: { path: 'x'.repeat(2100) } });
    log('check', { invalidCode: invalid.json.error?.code, issues: invalid.json.error?.details });
    const badRes = await a.client.callTool({ name: 'update_mock_rule', arguments: { endpointId: id, ruleId: starter, expectedUpdatedAt: fresh.updatedAt, response: { statusCode: 999 } } });
    log('check', { schemaRejectedBeforeAnyHttp: { isError: Boolean(badRes.isError), text: String(badRes.content?.[0]?.text ?? '').slice(0, 140) } });
    const after = (await a.call('get_mock_endpoint', { endpointId: id })).json;
    log('check', { ruleStillOne: after.rulesInMatchOrder.length === 1, statusStillFromB: after.rulesInMatchOrder[0].response.statusCode });
    // ordinary network loss: nothing reachable
    const dead = await connect('RB_KEY_FREE2', { REQUESTBIN_BASE_URL: 'http://127.0.0.1:1' });
    const net = await dead.call('update_mock_rule', { endpointId: id, ruleId: starter, expectedUpdatedAt: fresh.updatedAt, isActive: false });
    log('check', { unreachableCode: net.json.error?.code });
    await Promise.all([a.close(), b.close(), o.close(), dead.close()]);
    // ambiguous: the write is applied by the REAL server, then the response is lost (fault preload in the MCP child)
    const p = await connect('RB_KEY_PRO');
    const pc = (await p.call('create_mock_endpoint', { name: 'cx-demo-ambiguous' })).json;
    await p.close();
    const amb = await connect('RB_KEY_PRO', { FAULT: 'lose-response:POST:/rules', NODE_OPTIONS: `--import ${path.join(here, 'fault-preload.mjs')}` });
    const r = await amb.call('add_mock_rule', { endpointId: pc.id, method: 'GET', path: '/once', statusCode: 201, priority: -1 });
    const chk = (await amb.call('get_mock_endpoint', { endpointId: pc.id })).json;
    log('check', { ambiguousCode: r.json.error?.code, outcome: r.json.error?.details?.outcome, candidates: r.json.error?.details?.candidates, claimsAppliedOrSafeRetry: /DID succeed|safe to retry/i.test(JSON.stringify(r.json)), rulesAfter: chk.rulesInMatchOrder.length, duplicates: chk.rulesInMatchOrder.filter(x => x.match.path === '/once').length });
    await amb.close();
  },
};

/** Server WITHOUT the capability contract (an older build): reads work, capability-dependent writes are refused before sending. */
scenarios.compat = async () => {
  const m = await connect('RB_KEY_FREE');
  const created = (await m.call('create_mock_endpoint', { name: 'cx-demo-compat' })).json;
  const { id } = created; const starter = created.rulesInMatchOrder[0].id;
  const g = (await m.call('get_mock_endpoint', { endpointId: id })).json;
  log('check', { capabilitiesStatus: g.serverCapabilities?.status, readOnlyWorks: Boolean(g.rulesInMatchOrder) });
  // another writer (UI/API) changes the rule; an old server would let our stale PATCH overwrite it
  const other = await connect('RB_KEY_FREE');
  const og = (await other.call('get_mock_endpoint', { endpointId: id })).json;
  // the ONLY way to change it on an old server is outside these tools: use the raw API as the "other writer"
  const res = await fetch(`${BASE}/api/mock-endpoints/${id}/rules/${starter}`, { method: 'PATCH', headers: { Authorization: `Bearer ${keys.RB_KEY_FREE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ response: { statusCode: 201, headers: {}, body: 'other-writer' } }) });
  log('other-writer', { status: res.status });
  const r = await m.call('update_mock_rule', { endpointId: id, ruleId: starter, expectedUpdatedAt: g.updatedAt, response: { statusCode: 500, body: 'ours' } });
  const after = (await m.call('get_mock_endpoint', { endpointId: id })).json;
  log('check', { refusedCode: r.json.error?.code, statusAfter: after.rulesInMatchOrder[0].response.statusCode, bodyAfter: after.rulesInMatchOrder[0].response.bodyPreview, otherWriterKept: after.rulesInMatchOrder[0].response.bodyPreview === 'other-writer' });
  const rs = await m.call('reset_mock_sequence', { endpointId: id, ruleId: starter });
  log('check', { resetCode: rs.json.error?.code });
  await other.close(); await m.close();
};

/** The configured (synthetic, task-owned) key placed inside rule content: output is redacted, the stored rule is untouched. */
scenarios.redact = async () => {
  const key = keys.RB_KEY_PRO;
  const m = await connect('RB_KEY_PRO');
  const created = (await m.call('create_mock_endpoint', { name: 'cx-demo-redact' })).json;
  const { id } = created;
  const add = await m.call('add_mock_rule', { endpointId: id, method: 'POST', path: '/leak', statusCode: 200, priority: -1, body: JSON.stringify({ token: key, note: 'keep-me' }), headers: { Authorization: `Bearer ${key}`, 'X-Note': 'keep-me' } });
  const get = await m.call('get_mock_endpoint', { endpointId: id });
  const raw = await (await fetch(`${BASE}/api/mock-endpoints/${id}`, { headers: { Authorization: `Bearer ${key}` } })).json();
  const stored = raw.endpoint.rules.find(r => r.match.path === '/leak');
  const outputs = JSON.stringify([add, get]);
  log('check', { toolOutputsContainKey: outputs.includes(key), diagnosticsKept: outputs.includes('keep-me'), storedHeaderUnchanged: stored.response.headers.Authorization === `Bearer ${key}`, storedBodyUnchanged: stored.response.body.includes(key) });
  await m.close();
};

scenarios.verify = async () => {
  // Independent check of an LLM-driven setup: real HTTP, then captures through the MCP client.
  const m = await connect('RB_KEY_LLM');
  const eps = (await m.call('list_mock_endpoints')).json;
  const ep = eps.find(e => e.id === process.env.ENDPOINT_ID);
  const res = await hit(ep.slug, 'POST', '/checkout', { body: '{"amount":1}' });
  log('http', { res });
  const caps = await captures(m.call, ep.id, 1);
  const g = (await m.call('get_mock_endpoint', { endpointId: ep.id })).json;
  log('check', { status: res.status, captureStatus: caps.captures[0]?.statusCode, matchedRuleId: caps.captures[0]?.matchedRuleId, rulesInMatchOrder: g.rulesInMatchOrder.map(r => r.id) });
  await m.close();
};

const name = process.argv[2];
if (name === 'free+sequence') {
  const ctx = await scenarios.free();
  await scenarios.sequence(ctx);
  await ctx.m.close();
} else {
  await scenarios[name]();
}
