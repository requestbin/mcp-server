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

| Tool | Effect | Description |
|------|--------|-------------|
| `list_mock_endpoints` | read | Endpoints with slug, URL, rule count, last deploy |
| `get_mock_endpoint` | read | One endpoint: rules **in match order** with ids, the `updatedAt` token, saved / deployed / legacy state, warnings (unreachable rules, unsupported path syntax) |
| `create_mock_endpoint` | write | New endpoint (counts toward your endpoint cap), born with **one starter rule** (`* *` → 200) |
| `update_mock_rule` | write (saved, **not deployed**) | Edit an **existing** rule — including the Free starter — with atomic `expectedUpdatedAt` compare-and-set. Static response and Sequence (`sequence` omitted = keep, `null` = clear) |
| `add_mock_rule` | write (saved, not deployed) | Append a rule (PRO/TEAM headroom; Free is rejected as `plan_limit`) |
| `reset_mock_sequence` | write-like | Ask the live server to restart one rule's Sequence at step 1 (HTTP 202 = **queued**, not observed) |
| `deploy_mock` | write | **The only tool that publishes.** Deploys the saved rules; safe to repeat |
| `list_mock_captures` | read | Requests that reached the endpoint: status returned, matched rule id, and Sequence run/step/outcome when recorded |

### What the mock server really matches (read this before writing rules)

- Rules are evaluated in **ascending `priority` — a LOWER number is evaluated FIRST**. Ties keep creation order. The first active match wins.
- `method` is `*` or one exact method. `path` is `*` or an **exact string**. **Path globs (`/api/*`), `:params` and `{params}` are NOT supported** — such a rule only matches that literal text, and the tools warn when you write one.
- Every new endpoint ships a catch-all starter rule (`* *`, priority 0). A rule you add at priority 0 is therefore **shadowed** by it; give the specific rule a lower number (e.g. `-1`) or edit the starter. `get_mock_endpoint` reports this.
- Unmatched requests get a default `200` with an empty body.

### Free plan: edit the starter, don't append

Free allows **1 rule per endpoint** and creating an endpoint already inserts one. The working loop is:

`create_mock_endpoint` → `get_mock_endpoint` (note the rule id and `updatedAt`) → `update_mock_rule` (starter → `POST /checkout` → 500) → `deploy_mock` → call the URL → `list_mock_captures`.

`add_mock_rule` on Free is rejected as `plan_limit` and creates nothing. PRO (5 rules) / TEAM (20): `add_mock_rule` works, with a priority lower than any catch-all.

### Errors the agent can act on

Every failure is returned as `{"error": {"code", "status", "message", "hint", ...}}` with `isError: true`:

| code | meaning | agent action |
|------|---------|--------------|
| `plan_limit` | 403 cap (rules / endpoints) | nothing was created; on Free edit the starter |
| `conflict` | 409: the endpoint changed since your `updatedAt` | nothing overwritten; re-plan against `current`, your `intendedChange` is echoed back; never auto-retried |
| `validation` | 422 | nothing changed; fix `details.issues` |
| `scenario_runtime_unavailable` | server has Sequence/Reset disabled | capability gap; tools never enable flags |
| `not_found` | unknown endpoint/rule **or another account's** | list again |
| `unauthorized` | bad key | key is never echoed |
| `network_error` | request never reached the server | no state changed; safe to retry |
| `ambiguous_write` | connection lost or 5xx **after** a write may have applied | do **not** repeat blindly; `add_mock_rule` re-reads once and tells you whether the rule exists (`details.reconciled`) |

Saved edits are **not** live until `deploy_mock`. On endpoints deployed before deploy-time snapshots existed (`state.kind: "legacy"`) the server cannot prove saved edits are isolated from the live URL, so the tools never claim they are.

## Quickstart (about 5 minutes)

1. Create an API key at [requestbin.net/api-keys](https://requestbin.net/api-keys) (any plan).
2. Add the server to your MCP client (stdio; no hosted service, no OAuth). **The tools above ship in 0.4.0, which is not published yet** — until then run a checkout: `git clone … && npm ci && npm run build`, and use `node /path/to/dist/index.js` as the command:
   - **Claude Code:** `claude mcp add requestbin -e REQUESTBIN_API_KEY=rb_... -- npx -y @requestbin/mcp-server` (or the `.mcp.json` snippet above)
   - **Cursor:** Settings → MCP → add the JSON snippet above.
3. Paste a prompt (Free plan):

   > Using only the requestbin MCP tools: create a mock endpoint, then make `POST /checkout` return HTTP 500 with JSON `{"error":"payment_provider_down"}`. I'm on Free, so edit the starter rule instead of adding one — read the endpoint first. Deploy explicitly, then give me the URL and rule id.
4. Call it yourself: `curl -i -X POST <url>/checkout -d '{}'` → `500`. Then ask the agent: *"List the captures and confirm which rule served my request."*
5. Retry workflow (needs the server's Scenario runtime; otherwise you get `scenario_runtime_unavailable`):

   > Edit the same rule to a Sequence for `GET /pay`: step 1 returns 429, step 2 returns 200 after a 5000 ms delay. Deploy, then tell me what I should observe. After I call it, show the captures (run/step/outcome), reset the sequence, and show the next capture.

   `reset_mock_sequence` says **queued**; the proof that it applied is the next capture starting at step 1.

For a local environment set `REQUESTBIN_BASE_URL`, `REQUESTBIN_MOCK_DOMAIN` (e.g. `localhost:8081`) and `REQUESTBIN_MOCK_SCHEME=http`.

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

**You (PRO):** "Stand up a mock Stripe API that returns 200 for `POST /v1/charges` and 402 for `POST /v1/charges/decline`"

The agent will:
1. Call `create_mock_endpoint` — gets back a live URL and the starter rule
2. Call `add_mock_rule` for each path with a **priority lower than the catch-all starter** (or `update_mock_rule` on the starter)
3. Call `get_mock_endpoint` to confirm the match order and warnings, then `deploy_mock` to publish

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REQUESTBIN_API_KEY` | Yes | -- | Your API key from [requestbin.net/api-keys](https://requestbin.net/api-keys) |
| `REQUESTBIN_BASE_URL` | No | `https://requestbin.net` | Custom API base URL (for self-hosted instances) |
| `REQUESTBIN_MOCK_DOMAIN` | No | `rbmock.dev` | Domain that hosts mock endpoints (override for self-hosted) |
| `REQUESTBIN_MOCK_SCHEME` | No | `https` | Use `http` for a local data plane |

## Requirements

- Node.js >= 18
- A RequestBin account (FREE tier works — API/MCP is open to every plan)

## Development

```bash
npm install
npm run dev    # runs with tsx (hot reload)
npm run build  # compile TypeScript to dist/
npm test       # unit tests through the real MCP protocol client (in-memory transport, faked HTTP)
```

## License

MIT
