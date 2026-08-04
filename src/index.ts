#!/usr/bin/env node
/**
 * @browserview/mcp - MCP server for browserview.io
 *
 * Exposes tools for managing disposable cloud Chromium sessions:
 * humans watch/control via a live viewer URL, agents drive the same
 * browser over the Chrome DevTools Protocol (CDP).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_KEY = process.env.BROWSERVIEW_API_KEY;

const DEFAULT_BASE_URL = "https://sessions.browserview.io";
let baseUrlSource = process.env.BROWSERVIEW_BASE_URL;
if (!baseUrlSource && process.env.BROWSERVIEW_API_URL) {
  baseUrlSource = process.env.BROWSERVIEW_API_URL;
  console.error(
    "browserview-mcp: BROWSERVIEW_API_URL is deprecated; use BROWSERVIEW_BASE_URL instead."
  );
}
const BASE_URL = (baseUrlSource ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

if (!API_KEY) {
  console.error(
    "Error: the BROWSERVIEW_API_KEY environment variable is not set.\n" +
      "Get an API key at https://browserview.io and set it, e.g.:\n" +
      '  BROWSERVIEW_API_KEY=bv_live_... npx @browserview/mcp\n' +
      "Optionally override the API base URL with BROWSERVIEW_BASE_URL " +
      `(default ${DEFAULT_BASE_URL}).`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** Per-request timeout: generous enough for create-with-wait (~5s typical). */
const REQUEST_TIMEOUT_MS = 60_000;
/** Retries after the initial attempt, on 429/503 only. */
const MAX_RETRIES = 3;
/** Never sleep longer than this for a single Retry-After hint. */
const MAX_RETRY_AFTER_WAIT_S = 30;

class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfter?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function apiRequestOnce(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    throw new ApiError(
      timedOut
        ? `Request to ${BASE_URL} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : `Network error reaching ${BASE_URL}: ${
            err instanceof Error ? err.message : String(err)
          }`,
      0
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status} ${res.statusText}`;
    try {
      const data = (await res.json()) as { detail?: unknown };
      if (data && data.detail !== undefined) {
        detail =
          typeof data.detail === "string"
            ? data.detail
            : JSON.stringify(data.detail);
      }
    } catch {
      // non-JSON error body; keep the status line
    }
    // The server sends Retry-After on 429 (30s) and 503 (10s); capture it on
    // any status so callers always see the hint when present.
    const retryAfter = res.headers.get("Retry-After") ?? undefined;
    throw new ApiError(detail, res.status, retryAfter);
  }

  if (res.status === 204) return null;
  return res.json();
}

async function apiRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await apiRequestOnce(method, path, body);
    } catch (err) {
      const retryable =
        err instanceof ApiError &&
        (err.status === 429 || err.status === 503) &&
        attempt < MAX_RETRIES;
      if (!retryable) throw err;
      const hinted = Number(err.retryAfter);
      const waitS =
        Number.isFinite(hinted) && hinted > 0
          ? Math.min(hinted, MAX_RETRY_AFTER_WAIT_S)
          : 2 ** attempt; // 1s, 2s, 4s
      await sleep(waitS * 1000);
    }
  }
}

/**
 * The *_url fields returned by the API are paths relative to the API host.
 * Resolve them to absolute URLs before handing them to the model/user.
 */
function resolveSessionUrls<T extends Record<string, unknown>>(session: T): T {
  const out: Record<string, unknown> = { ...session };
  for (const key of ["viewer_url", "watch_url", "cdp_url"]) {
    const value = out[key];
    if (typeof value === "string" && value.length > 0) {
      try {
        out[key] = new URL(value, `${BASE_URL}/`).toString();
      } catch {
        // leave the value as-is if it can't be parsed
      }
    }
  }
  return out as T;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown): ToolResult {
  let message: string;
  if (err instanceof ApiError) {
    message = `browserview.io API error: ${err.message}`;
    if (err.status === 429) {
      message += err.retryAfter
        ? ` (rate limited - retry after ${err.retryAfter} seconds)`
        : " (rate limited)";
    } else if (err.status === 503 && err.retryAfter) {
      message += ` (temporarily unavailable - retry after ${err.retryAfter} seconds)`;
    }
  } else {
    message = `Unexpected error: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
  return { content: [{ type: "text", text: message }], isError: true };
}

// ---------------------------------------------------------------------------
// MCP server and tools
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "browserview",
  version: "0.3.1",
});

server.registerTool(
  "create_session",
  {
    title: "Create browser session",
    description:
      "Create a new disposable cloud Chromium browser session on browserview.io. " +
      "Defaults: start_url \"about:blank\", 1280x800 viewport. " +
      "Returns the session as JSON including: viewer_url (a link a human can open " +
      "in any browser to watch and take control of the live session), cdp_url + " +
      "cdp_token (drive the browser programmatically: Playwright " +
      "chromium.connectOverCDP(cdp_url, {headers: {'x-session-token': cdp_token}}) " +
      "or Puppeteer puppeteer.connect({browserURL: cdp_url + '?token=' + cdp_token})), " +
      "and token_ttl_seconds " +
      "(how long the returned tokens stay valid - call get_session or " +
      "mint_session_token for fresh ones). Sessions are disposable; destroy them " +
      "with destroy_session when done.",
    inputSchema: {
      start_url: z
        .string()
        .refine(
          (value) => value === "about:blank" || /^https?:\/\/\S+$/.test(value),
          { message: 'must be an http(s) URL or "about:blank"' },
        )
        .optional()
        .describe('URL the browser should open on start (default: "about:blank")'),
      width: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Viewport width in pixels, 320-3840 (default 1280)"),
      height: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Viewport height in pixels, 240-2160 (default 800)"),
      wait: z
        .boolean()
        .optional()
        .describe(
          "Block until the browser is ready to accept CDP connections, " +
            "typically ~5s (default true). Set false to return immediately."
        ),
      record: z
        .boolean()
        .optional()
        .describe(
          "Record the session for replay: video plus action/console/network/" +
            "error event streams, retrievable with get_session_replay after " +
            "the session ends (default false)."
        ),
    },
  },
  async ({ start_url, width, height, wait, record }) => {
    try {
      const session = (await apiRequest("POST", "/sessions", {
        ...(start_url !== undefined && { start_url }),
        ...(width !== undefined && { width }),
        ...(height !== undefined && { height }),
        ...(record !== undefined && { record }),
        wait: wait ?? true,
      })) as Record<string, unknown>;
      return jsonResult(resolveSessionUrls(session));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "list_sessions",
  {
    title: "List browser sessions",
    description:
      "List all active browserview.io browser sessions for this account. " +
      "Returns an array of session summaries (id, status, health, start_url, " +
      "dimensions, created_at). This listing does not include URLs or tokens - " +
      "call get_session with a session_id to get a fresh viewer_url and " +
      "cdp_url/cdp_token for a specific session.",
    inputSchema: {},
  },
  async () => {
    try {
      const sessions = await apiRequest("GET", "/sessions");
      // The listing has no URL fields today, but absolutize defensively in
      // case the server ever adds them (same treatment as get_session).
      const resolved = Array.isArray(sessions)
        ? sessions.map((s) =>
            s && typeof s === "object"
              ? resolveSessionUrls(s as Record<string, unknown>)
              : s
          )
        : sessions;
      return jsonResult(resolved);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "get_session",
  {
    title: "Get browser session",
    description:
      "Fetch a single browserview.io session by id, refreshing its URLs and " +
      "access tokens. Use this to get a current viewer_url (for a human to watch " +
      "or control the browser) and a current cdp_url + cdp_token (pass the token " +
      "as an 'x-session-token' header or '?token=' query param when connecting " +
      "Playwright/Puppeteer over CDP) when previously issued tokens have " +
      "expired or were never captured. Also reports session health details: " +
      "restarts (how many times the in-session browser has restarted; null if " +
      "unknown) and degraded (true when the browser has restarted at least once).",
    inputSchema: {
      session_id: z.string().describe("The id of the session to fetch"),
    },
  },
  async ({ session_id }) => {
    try {
      const session = (await apiRequest(
        "GET",
        `/sessions/${encodeURIComponent(session_id)}`
      )) as Record<string, unknown>;
      return jsonResult(resolveSessionUrls(session));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "destroy_session",
  {
    title: "Destroy browser session",
    description:
      "Permanently destroy a browserview.io browser session. The cloud browser " +
      "shuts down immediately, all viewer and CDP connections are dropped, and " +
      "the session cannot be recovered. Call this when the browsing task is " +
      "finished to free resources. If the session was created with " +
      "record: true, its replay remains available afterwards via " +
      "get_session_replay.",
    inputSchema: {
      session_id: z.string().describe("The id of the session to destroy"),
    },
  },
  async ({ session_id }) => {
    try {
      await apiRequest(
        "DELETE",
        `/sessions/${encodeURIComponent(session_id)}`
      );
      return {
        content: [
          { type: "text" as const, text: `Session ${session_id} destroyed.` },
        ],
      };
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "mint_session_token",
  {
    title: "Mint session token",
    description:
      "Mint a new scoped access token for an existing browserview.io session. " +
      "Scopes: 'view' lets a human watch the session read-only, 'control' lets a " +
      "human watch and take over mouse/keyboard, 'cdp' authorizes a Chrome " +
      "DevTools Protocol connection (Playwright/Puppeteer). Use this to share a " +
      "session with a person or service without exposing your API key, or to " +
      "replace an expiring token. Returns the token, its scope, and its TTL in " +
      "seconds.",
    inputSchema: {
      session_id: z.string().describe("The id of the session to mint a token for"),
      scope: z
        .enum(["view", "control", "cdp"])
        .describe(
          "Token scope: 'view' (watch only), 'control' (watch + take over input), or 'cdp' (DevTools Protocol access)"
        ),
      ttl_seconds: z
        .number()
        .int()
        .min(1)
        .max(604800)
        .optional()
        .describe(
          "Token lifetime in seconds, 1 to 604800 (7 days). Default 3600."
        ),
    },
  },
  async ({ session_id, scope, ttl_seconds }) => {
    try {
      const token = await apiRequest(
        "POST",
        `/sessions/${encodeURIComponent(session_id)}/tokens`,
        { scope, ttl_seconds: ttl_seconds ?? 3600 }
      );
      return jsonResult(token);
    } catch (err) {
      return errorResult(err);
    }
  }
);

/** Absolutize the artifact URLs inside a replay manifest (local-storage
 * shards return API-relative ones; presigned S3 URLs are already absolute). */
function resolveReplayUrls(replay: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...replay };
  const absolute = (value: unknown) => {
    if (typeof value !== "string" || !value) return value;
    try {
      return new URL(value, `${BASE_URL}/`).toString();
    } catch {
      return value;
    }
  };
  const video = out.video as Record<string, unknown> | null | undefined;
  if (video && typeof video === "object") {
    out.video = { ...video, url: absolute(video.url) };
  }
  const events = out.events as Record<string, Record<string, unknown>> | undefined;
  if (events && typeof events === "object") {
    out.events = Object.fromEntries(
      Object.entries(events).map(([name, stream]) => [
        name,
        stream && typeof stream === "object"
          ? { ...stream, url: absolute(stream.url) }
          : stream,
      ])
    );
  }
  return out;
}

server.registerTool(
  "get_session_replay",
  {
    title: "Get session replay",
    description:
      "Fetch the replay manifest of a recorded browserview.io session (one " +
      "created with record: true). Works after the session is destroyed. " +
      "Returns {status: 'recording'} while the session is still running, and " +
      "once ready: a video URL (seekable WebM of everything that happened on " +
      "screen), a pages timeline (main-frame navigations with absolute " +
      "epoch-ms timestamps), and per-stream event file URLs (actions, " +
      "console, network, errors) — each fetchable as newline-delimited JSON " +
      "where every line has an epoch-ms 'ts'. Align an event with the video " +
      "via (ts - video.start_time_ms) / 1000 seconds. URLs expire at " +
      "urls_expire_at_ms; call again for fresh ones. With wait: true, polls " +
      "until the replay is ready (finalization typically takes <30s after " +
      "session end).",
    inputSchema: {
      session_id: z.string().describe("The id of the (possibly destroyed) session"),
      wait: z
        .boolean()
        .optional()
        .describe(
          "Poll until the replay is ready, up to 2 minutes (default false)"
        ),
    },
  },
  async ({ session_id, wait }) => {
    const path = `/sessions/${encodeURIComponent(session_id)}/replay`;
    try {
      if (!wait) {
        const replay = (await apiRequest("GET", path)) as Record<string, unknown>;
        return jsonResult(resolveReplayUrls(replay));
      }
      const deadline = Date.now() + 120_000;
      for (;;) {
        try {
          const replay = (await apiRequest("GET", path)) as Record<string, unknown>;
          if (replay.status === "ready") return jsonResult(resolveReplayUrls(replay));
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 404) throw err;
        }
        if (Date.now() + 5_000 > deadline) {
          return errorResult(
            new ApiError(
              `replay for session ${session_id} was not ready within 120s`,
              0
            )
          );
        }
        await sleep(5_000);
      }
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`browserview MCP server running on stdio (API: ${BASE_URL})`);
}

main().catch((err) => {
  console.error("Fatal error starting browserview MCP server:", err);
  process.exit(1);
});
