# AGENTS.md — @browserview/mcp

Model Context Protocol server for browserview.io (stdio transport). Standalone: it does NOT depend on the TypeScript SDK — the HTTP client is reimplemented inline.

## Commands

- Build: `npm run build`
- Run locally: `BROWSERVIEW_API_KEY=... node dist/index.js` (exits 1 with help if the key is unset)
- Publish: `npm publish` (`prepublishOnly` rebuilds; requires `NPM_TOKEN` in the environment — see `.npmrc`)

## Layout

- `src/index.ts` — everything: env handling, inline API client with 429/503 retries, and six `registerTool` calls (`create_session`, `list_sessions`, `get_session`, `destroy_session`, `mint_session_token`, `get_session_replay`).
- `dist/` — build output, gitignored, published via `files: ["dist"]`.

## Conventions

- Env: `BROWSERVIEW_API_KEY` (required), `BROWSERVIEW_BASE_URL` (optional; legacy `BROWSERVIEW_API_URL` still honored with a stderr warning).
- Version lives in **both** `package.json` and the `McpServer({ version })` call — bump together.
- Tool results are JSON strings aimed at agents; keep descriptions accurate, they are the agent-facing docs.
- The API contract source of truth is the browserview.io orchestrator; docs: https://browserview.io/docs/api and https://browserview.io/llms-full.txt

## Release

1. Bump version in `package.json` and `src/index.ts` (`McpServer`).
2. `npm run build`, then a quick stdio smoke (`node dist/index.js` without a key should print help and exit 1).
3. Commit, tag `v<version>`, push (remote: github.com/browserview/mcp).
4. `NPM_TOKEN=... npm publish`
