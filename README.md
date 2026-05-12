# @requestbin/mcp-server

Use RequestBin directly in Claude Code, Cursor, Windsurf, and any MCP-compatible AI coding agent.

Create webhook bins, inspect captured HTTP requests, replay them, and stand up **mock API endpoints** — all without leaving your editor.

## Installation

```bash
npm install -g @requestbin/mcp-server
```

Or run directly with npx:

```bash
npx @requestbin/mcp-server
```

## Get an API Key

1. Go to [requestbin.net/api-keys](https://requestbin.net/api-keys)
2. Create a new API key

API keys and MCP access are available on **every plan**, including FREE (5 keys per account). Per-feature limits (bin count, mock endpoint count, custom mock slug) still apply per plan — see [requestbin.net/pricing](https://requestbin.net/pricing).

## Configuration

### Claude Code

Add to your project's `.mcp.json` or `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "requestbin": {
      "command": "requestbin-mcp",
      "env": {
        "REQUESTBIN_API_KEY": "rb_your_key_here"
      }
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "requestbin": {
      "command": "requestbin-mcp",
      "env": {
        "REQUESTBIN_API_KEY": "rb_your_key_here"
      }
    }
  }
}
```

### Cursor

Add to Cursor Settings > MCP Servers:

```json
{
  "requestbin": {
    "command": "requestbin-mcp",
    "env": {
      "REQUESTBIN_API_KEY": "rb_your_key_here"
    }
  }
}
```

### Windsurf

Add to `~/.windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "requestbin": {
      "command": "requestbin-mcp",
      "env": {
        "REQUESTBIN_API_KEY": "rb_your_key_here"
      }
    }
  }
}
```

## Available Tools

**Webhook bins & replay:**

| Tool | Description |
|------|-------------|
| `list_bins` | List all your webhook bins with URLs and stats |
| `create_bin` | Create a new webhook bin (returns URL for webhook endpoint) |
| `get_bin` | Get bin details including recent interactions |
| `delete_bin` | Delete a webhook bin |
| `list_interactions` | List captured HTTP requests for a bin (method, headers, body) |
| `replay_request` | Send an HTTP request to any URL (server-side replay) |
| `get_replay_status` | Check the status of a replay job |
| `list_servers` | List available servers for bin creation |

**Mock APIs (`*.rbmock.dev`):**

| Tool | Description |
|------|-------------|
| `list_mock_endpoints` | List your mock endpoints with slug, URL, and rule count |
| `create_mock_endpoint` | Create a mock endpoint (returns live `{slug}.rbmock.dev` URL) |
| `add_mock_rule` | Append a routing rule (match method/path → status + headers + body) |
| `deploy_mock` | Publish the current rule set so the live mock server picks it up |

## Example Workflow

Here is what a typical conversation looks like with an AI agent that has the RequestBin MCP server configured:

**You:** "Create a webhook bin for testing my Stripe integration"

The agent will:
1. Call `list_servers` to find available servers
2. Call `create_bin` with name "Stripe Webhooks"
3. Return the bin URL to configure in your Stripe Dashboard

**You:** "Show me the last 5 requests to my Stripe webhook bin"

The agent will:
1. Call `list_bins` to find your bins
2. Call `list_interactions` with the bin ID and limit of 5
3. Display the HTTP method, path, headers, and body of each captured request

**You:** "Replay the last webhook event to my local server at localhost:3000/webhooks"

The agent will:
1. Call `list_interactions` to find the most recent request
2. Call `replay_request` with the same method, headers, and body targeting `http://localhost:3000/webhooks`
3. Call `get_replay_status` to confirm delivery

**You:** "Stand up a mock Stripe API that returns 200 for `POST /v1/charges` and 402 for `POST /v1/charges/decline`"

The agent will:
1. Call `create_mock_endpoint` with name "Stripe mock" — gets back a live URL like `https://abc12.rbmock.dev`
2. Call `add_mock_rule` twice (one per path) with the matching status codes and JSON bodies
3. Call `deploy_mock` to publish — the URL is now ready to point your integration at

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REQUESTBIN_API_KEY` | Yes | -- | Your API key from [requestbin.net/api-keys](https://requestbin.net/api-keys) |
| `REQUESTBIN_BASE_URL` | No | `https://requestbin.net` | Custom API base URL (for self-hosted instances) |
| `REQUESTBIN_MOCK_DOMAIN` | No | `rbmock.dev` | Domain that hosts mock endpoints (override for self-hosted) |

## Requirements

- Node.js >= 18
- A RequestBin account (FREE tier works — API/MCP is open to every plan)

## Development

```bash
npm install
npm run dev    # runs with tsx (hot reload)
npm run build  # compile TypeScript to dist/
```

## License

MIT
