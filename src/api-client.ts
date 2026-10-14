/**
 * RequestBin API client — used by MCP tools to interact with the API.
 */

import { ApiError } from './errors.js';

/** Network errors that prove the request never reached a server (safe to say "nothing was sent"). */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ClientOptions = {
  /** Bound for the WHOLE request including reading the body (default 30 s). An abort on a write is NOT proof the write did not happen. */
  timeoutMs?: number;
};

export class RequestBinClient {
  private baseUrl: string;
  private apiKey: string;
  private fetchImpl: FetchLike;
  private timeoutMs: number;

  constructor(apiKey: string, baseUrl = 'https://requestbin.net', fetchImpl: FetchLike = fetch, opts: ClientOptions = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 30000;
  }

  /**
   * One HTTP call. Everything after the request is sent is inside the same guard: a failure while reading or parsing
   * the response of a WRITE keeps may-have-applied semantics (the server may have committed before the body broke).
   */
  private async request(path: string, options: RequestInit = {}): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const isWrite = (options.method ?? 'GET').toUpperCase() !== 'GET';
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    let res: Response;
    let text: string;
    try {
      try {
        res = await this.fetchImpl(url, {
          ...options,
          signal: controller.signal,
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            ...options.headers,
          },
        });
      } catch (e: any) {
        if (timedOut) {
          throw new ApiError(`timed out after ${this.timeoutMs} ms`, 0, null, isWrite, 'timeout');
        }
        const code = e?.cause?.code ?? e?.code;
        // The message is generated here (never from the request), so it cannot contain the Authorization header.
        const refused = NOT_SENT_CODES.has(code);
        throw new ApiError(code ? String(code) : 'network failure', 0, null, isWrite && !refused, refused ? 'refused' : 'transport');
      }
      try {
        text = await res.text();
      } catch (e: any) {
        throw new ApiError(timedOut ? `timed out after ${this.timeoutMs} ms` : `response body could not be read (${e?.cause?.code ?? e?.name ?? 'error'})`, 0, null, isWrite, timedOut ? 'timeout' : 'unreadable');
      }
    } finally {
      clearTimeout(timer);
    }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      if (res.ok) {
        // A 2xx we cannot parse (HTML gateway page, truncated stream): for a write this may hide a committed change.
        throw new ApiError('success response was not valid JSON', 0, null, isWrite, 'unreadable');
      }
      data = { raw: text.slice(0, 500) };
    }

    if (!res.ok) {
      throw new ApiError(data.error || `API error: ${res.status} ${res.statusText}`, res.status, data, isWrite && res.status >= 500);
    }

    return data;
  }

  // ── Bins ──

  async listBins(): Promise<any[]> {
    const data = await this.request('/api/bins');
    return data.bins || [];
  }

  async createBin(name: string, serverId: string, note?: string): Promise<any> {
    return this.request('/api/bins', {
      method: 'POST',
      body: JSON.stringify({ name, serverId, note }),
    });
  }

  async getBin(binId: string): Promise<any> {
    return this.request(`/api/bins/${binId}`);
  }

  async deleteBin(binId: string): Promise<any> {
    return this.request(`/api/bins/${binId}`, { method: 'DELETE' });
  }

  // ── Interactions ──

  async listInteractions(binId: string, limit = 20): Promise<any> {
    return this.request(`/api/bins/${binId}/interactions?limit=${limit}`);
  }

  // ── Replay ──

  async createReplayJob(spec: {
    method: string;
    url: string;
    headers?: Array<{ key: string; value: string; enabled: boolean }>;
    body?: string;
    bodyMode?: string;
  }): Promise<any> {
    return this.request('/api/replay/jobs', {
      method: 'POST',
      body: JSON.stringify({
        requestSpec: {
          method: spec.method,
          url: spec.url,
          headers: spec.headers || [],
          query: [],
          body: spec.body || '',
          bodyMode: spec.bodyMode || 'none',
          auth: { type: 'none' },
          options: {
            replaceDomain: false,
            retry: 'none',
            delayMs: 0,
            forwardToBin: '',
            removeAuthHeader: false,
            overrideHeaders: false,
          },
        },
        sourceType: 'manual',
      }),
    });
  }

  async getReplayJob(jobId: string): Promise<any> {
    return this.request(`/api/replay/jobs/${jobId}`);
  }

  async listReplayJobs(limit = 10): Promise<any> {
    return this.request(`/api/replay/jobs?limit=${limit}`);
  }

  // ── Forwarding Rules ──

  async listForwardingRules(): Promise<any> {
    return this.request('/api/forwarding-rules');
  }

  // ── Servers ──

  async listServers(): Promise<any> {
    return this.request('/api/servers');
  }

  // ── Mock Endpoints ──

  async listMockEndpoints(): Promise<any> {
    return this.request('/api/mock-endpoints');
  }

  async createMockEndpoint(opts: {
    name?: string;
    slug?: string;
  } = {}): Promise<any> {
    const body: Record<string, unknown> = {};
    if (opts.name !== undefined) {
      body.name = opts.name;
    }
    if (opts.slug !== undefined && opts.slug !== '') {
      body.slug = opts.slug;
    }
    return this.request('/api/mock-endpoints', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getMockEndpoint(endpointId: string): Promise<any> {
    return this.request(`/api/mock-endpoints/${encodeURIComponent(endpointId)}`);
  }

  /** PATCH one rule. `sequence` omitted = preserved, `null` = cleared; `expectedUpdatedAt` makes the write atomic (409 on conflict). */
  async updateMockRule(endpointId: string, ruleId: string, patch: Record<string, unknown>): Promise<any> {
    return this.request(`/api/mock-endpoints/${encodeURIComponent(endpointId)}/rules/${encodeURIComponent(ruleId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  /** 202 = reset QUEUED on the data plane (not proof it was consumed). 404 `Not found` = scenario runtime disabled. */
  async resetMockSequence(endpointId: string, ruleId: string): Promise<any> {
    return this.request(`/api/mock-endpoints/${encodeURIComponent(endpointId)}/rules/${encodeURIComponent(ruleId)}/reset`, {
      method: 'POST',
    });
  }

  async addMockRule(endpointId: string, rule: {
    match: { method: string; path: string };
    response: { statusCode: number; headers?: Record<string, string>; body?: string };
    priority?: number;
    isActive?: boolean;
    sequence?: unknown;
  }): Promise<any> {
    return this.request(`/api/mock-endpoints/${endpointId}/rules`, {
      method: 'POST',
      body: JSON.stringify(rule),
    });
  }

  async deployMockEndpoint(endpointId: string): Promise<any> {
    return this.request(`/api/mock-endpoints/${endpointId}/deploy`, {
      method: 'POST',
    });
  }

  async listMockCaptures(endpointId: string, opts: { limit?: number } = {}): Promise<any> {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    return this.request(`/api/mock-endpoints/${endpointId}/interactions?limit=${limit}`);
  }
}
