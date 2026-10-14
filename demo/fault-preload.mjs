/**
 * Fault injection for the demo ONLY (loaded into the MCP child process via NODE_OPTIONS=--import).
 * FAULT=lose-response:<METHOD>:<path-suffix>  → the request IS sent and applied by the real server, then the
 * response is dropped once (simulates a network loss after a write). No ports, no proxy.
 */
const spec = process.env.FAULT;
if (spec) {
  const [kind, method, suffix] = spec.split(':');
  const real = globalThis.fetch;
  let fired = false;
  globalThis.fetch = async (input, init = {}) => {
    const res = await real(input, init);
    const url = String(input);
    if (kind === 'lose-response' && !fired && (init.method ?? 'GET').toUpperCase() === method && url.endsWith(suffix)) {
      fired = true;
      await res.arrayBuffer().catch(() => {});
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    }
    return res;
  };
}
