#!/usr/bin/env node
/**
 * RequestBin MCP Server
 *
 * Allows AI coding agents (Claude, Cursor, Windsurf) to:
 * - Create and manage webhook bins
 * - Inspect captured requests
 * - Replay HTTP requests
 * - List forwarding rules
 *
 * Setup:
 *   1. Get an API key from https://requestbin.net/api-keys
 *   2. Set REQUESTBIN_API_KEY environment variable
 *   3. Add to your MCP config (see README.md)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { RequestBinClient } from './api-client.js';

const API_KEY = process.env.REQUESTBIN_API_KEY;
const BASE_URL = process.env.REQUESTBIN_BASE_URL || 'https://requestbin.net';

if (!API_KEY) {
  console.error('Error: REQUESTBIN_API_KEY environment variable is required.');
  console.error('Get your API key at https://requestbin.net/api-keys');
  process.exit(1);
}

const client = new RequestBinClient(API_KEY, BASE_URL);
const server = new McpServer({
  name: 'requestbin',
  version: '0.1.0',
});

// ── Tool: list_bins ──

server.tool(
  'list_bins',
  'List all your webhook bins with their URLs and stats',
  {},
  async () => {
    try {
      const bins = await client.listBins();
      const summary = bins.map((b: any) => ({
        binId: b.binId,
        name: b.name,
        url: b.url,
        interactions: b.interactionCount || 0,
        createdAt: b.createdAt,
      }));
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(summary, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── Tool: create_bin ──

server.tool(
  'create_bin',
  'Create a new webhook bin to capture HTTP requests. Returns the bin URL you can use as a webhook endpoint.',
  {
    name: z.string().describe('Name for the bin (e.g. "Stripe Webhooks", "GitHub Events")'),
    serverId: z.string().describe('Server ID to create the bin on. Use list_servers to find available servers.'),
    note: z.string().optional().describe('Optional note/description for the bin'),
  },
  async ({ name, serverId, note }) => {
    try {
      const result = await client.createBin(name, serverId, note);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            binId: result.bin?.binId,
            name: result.bin?.name,
            url: result.bin?.url,
            message: `Bin created. Send webhooks to: ${result.bin?.url}`,
          }, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── Tool: get_bin ──

server.tool(
  'get_bin',
  'Get details of a specific bin including recent interactions',
  {
    binId: z.string().describe('The bin ID (UUID format)'),
  },
  async ({ binId }) => {
    try {
      const result = await client.getBin(binId);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            bin: {
              binId: result.bin?.binId,
              name: result.bin?.name,
              url: result.bin?.url,
              isOwner: result.isOwner,
              stats: result.stats,
            },
            recentInteractions: (result.interactions || []).slice(0, 5).map((i: any) => ({
              id: i._id,
              method: i.data?.method || i.protocol,
              path: i.data?.path,
              timestamp: i.timestamp,
              isViewed: i.isViewed,
            })),
          }, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── Tool: delete_bin ──

server.tool(
  'delete_bin',
  'Delete a webhook bin (soft delete)',
  {
    binId: z.string().describe('The bin ID to delete'),
  },
  async ({ binId }) => {
    try {
      await client.deleteBin(binId);
      return {
        content: [{ type: 'text' as const, text: `Bin ${binId} deleted successfully.` }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── Tool: list_interactions ──

server.tool(
  'list_interactions',
  'List captured HTTP requests (interactions) for a bin',
  {
    binId: z.string().describe('The bin ID'),
    limit: z.number().optional().default(10).describe('Number of interactions to return (default 10, max 50)'),
  },
  async ({ binId, limit }) => {
    try {
      const result = await client.listInteractions(binId, Math.min(limit, 50));
      const interactions = (result.interactions || []).map((i: any) => ({
        id: i._id,
        method: i.data?.method || i.protocol,
        path: i.data?.path,
        remoteAddress: i['remote-address'],
        timestamp: i.timestamp,
        headers: i.data?.headers,
        body: i.data?.body ? (typeof i.data.body === 'string' ? i.data.body.substring(0, 500) : JSON.stringify(i.data.body).substring(0, 500)) : null,
        isViewed: i.isViewed,
        isImportant: i.isImportant,
      }));
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ count: interactions.length, interactions }, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── Tool: replay_request ──

server.tool(
  'replay_request',
  'Send an HTTP request to any URL (replay/test webhook delivery). The request is executed server-side.',
  {
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).describe('HTTP method'),
    url: z.string().url().describe('Target URL to send the request to'),
    headers: z.array(z.object({
      key: z.string(),
      value: z.string(),
    })).optional().describe('HTTP headers to include'),
    body: z.string().optional().describe('Request body (for POST/PUT/PATCH)'),
    bodyMode: z.enum(['none', 'json', 'text']).optional().default('none').describe('Body content type'),
  },
  async ({ method, url, headers, body, bodyMode }) => {
    try {
      const result = await client.createReplayJob({
        method,
        url,
        headers: (headers || []).map(h => ({ ...h, enabled: true })),
        body: body || '',
        bodyMode: bodyMode || (body ? 'json' : 'none'),
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            jobId: result.job_id,
            status: result.status,
            message: `Replay job queued. It will be executed by the runner service.`,
          }, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── Tool: get_replay_status ──

server.tool(
  'get_replay_status',
  'Check the status of a replay job',
  {
    jobId: z.string().describe('The replay job ID'),
  },
  async ({ jobId }) => {
    try {
      const result = await client.getReplayJob(jobId);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── Tool: list_servers ──

server.tool(
  'list_servers',
  'List available servers (needed for creating bins). Returns server IDs you can use with create_bin.',
  {},
  async () => {
    try {
      const result = await client.listServers();
      const servers = (result.servers || []).map((s: any) => ({
        serverId: s.serverId,
        name: s.name || s.serverUrl,
        url: s.serverUrl,
        status: s.healthStatus,
      }));
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(servers, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── Start server ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('MCP server error:', error);
  process.exit(1);
});
