# Live demo (local review stack only)

Deterministic MCP-client integration — **not** an LLM run (the one LLM-driven run is `transcripts/llm-claude-code.jsonl`, labelled separately).
Real MCP protocol client → `node dist/index.js` (stdio) → RequestBin API on `localhost:3000` → mock data plane on `localhost:8081` → persisted capture.

```bash
npm run build
export NODE_PATH=../requestbin.saas/node_modules            # for the mongodb driver used by the seed script
export KEYS_FILE=/tmp/cx_keys.env                           # 0600; raw keys are written here and never printed
MONGODB_URI=mongodb://localhost:27017 MONGODB_DB=requestbin_phase0_review node demo/seed-synthetic-users.cjs
REQUESTBIN_BASE_URL=http://localhost:3000 MOCK_PORT=8081 node demo/live-demo.mjs free+sequence   # Free loop, then Sequence + Reset
node demo/live-demo.mjs pro                                  # shadowing, priority, literal glob, cap
node demo/live-demo.mjs failures                             # conflict, repeat, wrong account, invalid, network loss, ambiguous write
ENDPOINT_ID=<id> node demo/live-demo.mjs verify              # independent check of an LLM-configured endpoint
node demo/seed-synthetic-users.cjs --cleanup                 # deletes ONLY users tagged cx20261014 and the endpoints they own
```
Requires a local SaaS dev server with `ENABLE_MOCK_SCENARIO=true` and `ENFORCE_MOCK_LIMITS=true`, and a mock server built from requestbin-mock PR #3, to show Sequence/Reset and cap rejections.
`fault-preload.mjs` drops the response of one real write inside the MCP child process (`FAULT=lose-response:POST:/rules`) to prove ambiguous-write handling; it opens no ports.
