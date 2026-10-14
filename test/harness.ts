import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RequestBinClient } from '../src/api-client.js';
import { registerMockTools } from '../src/mock-tools.js';
import type { Opts } from './fake-saas.js';
import { createFakeSaas } from './fake-saas.js';

/** Synthetic secret used only in tests. */
export const KEY = 'rb_test_super_secret_key_123456';

/** Real MCP protocol (client <-> server over an in-memory transport); only the HTTP layer is faked. */
export async function setup(opts: Opts = {}, extra: { timeoutMs?: number; key?: string } = {}) {
  const fake = createFakeSaas(opts);
  const key = extra.key ?? KEY;
  const server = new McpServer({ name: 'requestbin-test', version: '0.0.0' });
  registerMockTools(server, new RequestBinClient(key, 'http://api.test', fake.fetchImpl, { timeoutMs: extra.timeoutMs }), { apiKey: key, mockDomain: 'localhost:8081', mockScheme: 'http' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? '';
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { isError: Boolean(res.isError), text, json };
  };
  const writes = (re: RegExp = /./) => fake.state.calls.filter(c => c.method !== 'GET' && re.test(`${c.method} ${c.path}`));
  return { fake, client, call, writes };
}
