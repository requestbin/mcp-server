# Contributing to RequestBin MCP Server

Thank you for your interest in contributing!

## Reporting bugs

Please open a GitHub issue with:
- MCP client you're using (Claude Code, Cursor, Windsurf...)
- Node.js version (`node --version`)
- Full error message
- Steps to reproduce

## Requesting new tools or payload providers

Open an issue describing:
- Tool name and what it should do
- Use case / workflow it enables
- Which payload providers you'd like added

## Pull requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Make your changes
4. Ensure the build passes: `npm run build`
5. Open a PR with a clear description

## Available tools

`list_bins`, `create_bin`, `get_bin`, `delete_bin`,
`list_interactions`, `replay_request`, `get_replay_status`, `list_servers`

## Payload providers

Stripe, GitHub, Shopify, Slack, AWS SNS, Twilio
