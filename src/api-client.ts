/**
 * RequestBin API client — used by MCP tools to interact with the API.
 */

export class RequestBinClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(apiKey: string, baseUrl = 'https://requestbin.net') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async request(path: string, options: RequestInit = {}): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      throw new Error(data.error || `API error: ${res.status} ${res.statusText}`);
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

  async addMockRule(endpointId: string, rule: {
    match: { method: string; path: string };
    response: { statusCode: number; headers?: Record<string, string>; body?: string };
    priority?: number;
    isActive?: boolean;
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
