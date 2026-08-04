# @browserview/mcp

MCP (Model Context Protocol) server for [browserview.io](https://browserview.io) — disposable cloud Chromium sessions. Humans watch and control a session through a live viewer URL; agents drive the same browser over the Chrome DevTools Protocol (CDP) using Playwright or Puppeteer (`connectOverCDP`). This server lets any MCP-capable agent (Claude, OpenAI agents, Cursor, and others) create, inspect, share, and destroy sessions.

## Requirements

- Node.js 18+
- A browserview.io API key, provided via the `BROWSERVIEW_API_KEY` environment variable. Keys are minted in the [browserview.io console](https://browserview.io) and look like `bv_live_` + 40 hex chars.

Optional: set `BROWSERVIEW_BASE_URL` to override the API base URL (default `https://sessions.browserview.io`). The legacy `BROWSERVIEW_API_URL` variable is still honored as a fallback but is deprecated — prefer `BROWSERVIEW_BASE_URL`.

## Setup

### Claude Code

```sh
claude mcp add browserview -e BROWSERVIEW_API_KEY=your-key-here -- npx -y @browserview/mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "browserview": {
      "command": "npx",
      "args": ["-y", "@browserview/mcp"],
      "env": {
        "BROWSERVIEW_API_KEY": "your-key-here"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "browserview": {
      "command": "npx",
      "args": ["-y", "@browserview/mcp"],
      "env": {
        "BROWSERVIEW_API_KEY": "your-key-here"
      }
    }
  }
}
```

### Generic stdio client

Run the server as a stdio subprocess:

```sh
BROWSERVIEW_API_KEY=your-key-here npx -y @browserview/mcp
```

## Tools

| Tool | Arguments | Description |
| --- | --- | --- |
| `create_session` | `start_url?`, `width?`, `height?`, `wait?`, `record?` | Create a browser session. Server defaults: `start_url` `about:blank`, 1280×800 viewport, `wait` true (blocks until the browser accepts CDP, typically ~5s), `record` false (set true to capture a session replay). Returns the session as JSON with an absolute `viewer_url` (a human can open it to watch/control), `watch_url` (view-only), and `cdp_url` + `cdp_token` (for Playwright/Puppeteer `connectOverCDP`). |
| `list_sessions` | — | List all sessions (no URLs/tokens; use `get_session` for those). |
| `get_session` | `session_id` | Fetch one session with freshly issued URLs and tokens, plus health details: `restarts` (int, or null if unknown) and `degraded` (true once the in-session browser has restarted). |
| `destroy_session` | `session_id` | Permanently destroy a session. |
| `mint_session_token` | `session_id`, `scope` (`view` \| `control` \| `cdp`), `ttl_seconds?` | Mint a scoped access token for sharing a session without exposing your API key. `ttl_seconds` must be 1–604800 (7 days); default 3600. |
| `get_session_replay` | `session_id`, `wait?` | Replay manifest of a recorded session (works after destruction): video URL (seekable WebM), pages timeline, and per-stream JSONL event URLs (actions/console/network/errors), all with absolute epoch-ms timestamps. With `wait: true`, polls up to 2 minutes while the recording finalizes. |

## Connecting to the browser

`cdp_url` is deliberately token-free; pass `cdp_token` as an `x-session-token` header or a `?token=` query parameter:

```ts
// Playwright
const browser = await chromium.connectOverCDP(session.cdp_url, {
  headers: { "x-session-token": session.cdp_token },
});

// Puppeteer
const browser = await puppeteer.connect({
  browserURL: session.cdp_url + "?token=" + session.cdp_token,
});
```

Tokens expire after `token_ttl_seconds` (1 hour by default) — call `get_session` or `mint_session_token` for fresh ones. Hand `viewer_url` to a human to let them watch and take control of the same browser while the agent works.

## Behavior notes

- **Retries**: requests that fail with 429 (rate/capacity limit, `Retry-After: 30`) or 503 (auth backend temporarily down, `Retry-After: 10`) are retried automatically up to 3 times, honoring the `Retry-After` header (capped at 30s per wait) or falling back to 1s/2s/4s backoff.
- **Timeout**: each request has a 60s timeout, sized for `create_session` with `wait: true`.
- **URLs**: the API returns `viewer_url`/`watch_url`/`cdp_url` as paths relative to the API host; this server resolves them to absolute URLs before returning them.
- **Errors**: API errors surface the server's `detail` message plus retry hints when rate limited.
- **Lifecycle**: sessions are disposable — destroy them when done; the server also reaps sessions automatically when idle or past their maximum lifetime, so a crashed agent never leaks a browser.

## Development

```sh
npm install
npm run build
node dist/index.js
```
