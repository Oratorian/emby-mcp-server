/**
 * Emby HTTP client — single source of truth for talking to the server.
 *
 * Auth model
 * ----------
 * Emby accepts two credentials:
 *   1. A static API key (server-wide, no user context)
 *   2. An access token obtained by POSTing username/password to
 *      /Users/AuthenticateByName, which also returns a UserId
 *
 * Both are transmitted via the SAME header — `X-Emby-Authorization` — which
 * carries client metadata (MediaBrowser Client="…", Device="…", DeviceId="…",
 * Version="…") plus a `Token=…` field. Emby also accepts the API key in
 * `?api_key=` for tools/clients that can't set headers; we use the header.
 *
 * Why a single client?
 * --------------------
 * Centralising fetch + auth + error translation prevents every tool from
 * reinventing the wheel and keeps error messages consistent (the LLM sees
 * "Unauthorized: check EMBY_API_KEY" instead of a raw 401 body, every time).
 */

import {
  CLIENT_NAME,
  CLIENT_VERSION,
  DEVICE_ID,
  DEVICE_NAME,
} from "../constants.js";
import type { EmbyAuthResponse } from "../types.js";

export interface EmbyConfig {
  /** Base server URL, e.g. http://192.168.1.50:8096 — no trailing slash. */
  baseUrl: string;
  /** Server-wide API key. If set, takes precedence over username/password. */
  apiKey?: string;
  /** Username for per-user auth; paired with `password`. */
  username?: string;
  /** Password for per-user auth; paired with `username`. */
  password?: string;
}

export interface ResolvedAuth {
  /** Token sent in the `Token=` field of the X-Emby-Authorization header. */
  token: string;
  /** UserId — only present when authenticated via username/password. */
  userId?: string;
  /** Human-readable label for error messages: "API key" or "user 'andrew'". */
  source: string;
}

/** Thrown when the Emby API returns a non-2xx response. */
export class EmbyApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly url: string,
  ) {
    super(message);
    this.name = "EmbyApiError";
  }
}

/**
 * Loads config from environment variables. Fails fast with an actionable
 * message — Claude (or whoever's reading the stderr log) shouldn't have to
 * guess which variable is missing.
 */
export function loadConfigFromEnv(): EmbyConfig {
  const baseUrl = process.env.EMBY_SERVER_URL?.replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error(
      "EMBY_SERVER_URL is required (e.g. http://192.168.1.50:8096). " +
        "Set it in the MCP client's env config.",
    );
  }

  const apiKey = process.env.EMBY_API_KEY;
  const username = process.env.EMBY_USERNAME;
  const password = process.env.EMBY_PASSWORD;

  if (!apiKey && !(username && password)) {
    throw new Error(
      "No Emby credentials provided. Set either EMBY_API_KEY, " +
        "or both EMBY_USERNAME and EMBY_PASSWORD.",
    );
  }

  return { baseUrl, apiKey, username, password };
}

/**
 * Resolves credentials into a usable token + (optionally) UserId.
 * Called once at startup; the result is cached for the process lifetime.
 *
 * If both API key and username/password are configured, the API key wins —
 * it's simpler and doesn't expire. Username/password is the fallback.
 */
export async function authenticate(config: EmbyConfig): Promise<ResolvedAuth> {
  if (config.apiKey) {
    return { token: config.apiKey, source: "API key" };
  }

  // Username/password path: POST to /Users/AuthenticateByName.
  // The auth header on this request uses no Token field — it's the
  // bootstrapping call that produces the token.
  const url = `${config.baseUrl}/Users/AuthenticateByName`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Emby-Authorization": buildAuthHeader(undefined),
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        Username: config.username,
        Pw: config.password,
      }),
    });
  } catch (err) {
    throw new Error(
      `Failed to reach Emby server at ${config.baseUrl}: ${(err as Error).message}. ` +
        `Verify EMBY_SERVER_URL is correct and the server is running.`,
    );
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        `Login failed: invalid EMBY_USERNAME or EMBY_PASSWORD (HTTP 401).`,
      );
    }
    throw new EmbyApiError(
      response.status,
      `Login failed: HTTP ${response.status} from ${url}`,
      url,
    );
  }

  const data = (await response.json()) as EmbyAuthResponse;
  return {
    token: data.AccessToken,
    userId: data.User.Id,
    source: `user '${data.User.Name}'`,
  };
}

/**
 * Constructs the X-Emby-Authorization header. Emby parses this with a
 * permissive comma-separated key=value scheme; values are quoted.
 *
 * The `Token` field is omitted on the bootstrapping AuthenticateByName call
 * (we don't have a token yet) and present on all subsequent requests.
 */
function buildAuthHeader(token: string | undefined): string {
  const parts = [
    `MediaBrowser Client="${CLIENT_NAME}"`,
    `Device="${DEVICE_NAME}"`,
    `DeviceId="${DEVICE_ID}"`,
    `Version="${CLIENT_VERSION}"`,
  ];
  if (token) parts.push(`Token="${token}"`);
  return parts.join(", ");
}

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE" | "PUT";
  /** URL path (no leading slash needed). */
  path: string;
  /** Query string params. Arrays are joined with commas — Emby's convention. */
  query?: Record<string, string | number | boolean | string[] | undefined>;
  /** JSON body for POST/PUT. */
  body?: unknown;
}

/**
 * Builds the full request URL with query string, applying Emby's quirk that
 * arrays serialize as comma-separated values rather than repeated keys.
 */
function buildUrl(
  baseUrl: string,
  path: string,
  query?: RequestOptions["query"],
): string {
  const url = new URL(`${baseUrl}/${path.replace(/^\/+/, "")}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        if (value.length > 0) url.searchParams.set(key, value.join(","));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

/**
 * Issues an authenticated request to Emby and returns the parsed JSON body.
 * For 204 No Content responses (common on POST mutations), returns `null`.
 *
 * Errors are translated into messages that point at a fix:
 * - 401 -> auth advice
 * - 404 -> "no such item; try emby_search_items"
 * - 5xx -> "server error; check Emby logs"
 */
export async function embyRequest<T = unknown>(
  config: EmbyConfig,
  auth: ResolvedAuth,
  opts: RequestOptions,
): Promise<T> {
  const method = opts.method ?? "GET";
  const url = buildUrl(config.baseUrl, opts.path, opts.query);

  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Emby-Authorization": buildAuthHeader(auth.token),
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    throw new Error(
      `Network error calling ${method} ${opts.path}: ${(err as Error).message}. ` +
        `Is the Emby server reachable at ${config.baseUrl}?`,
    );
  }

  if (response.status === 204) {
    // No-content success — common for POST mutations like /MarkPlayed.
    return null as T;
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    const snippet = bodyText.slice(0, 200);
    let hint = "";
    if (response.status === 401) {
      hint = ` Authentication failed — check that ${auth.source} is still valid.`;
    } else if (response.status === 404) {
      hint = " The requested resource was not found — verify the ID with emby_search_items.";
    } else if (response.status >= 500) {
      hint = " Emby server error — check the server logs.";
    }
    throw new EmbyApiError(
      response.status,
      `HTTP ${response.status} from ${method} ${opts.path}${hint}${snippet ? `: ${snippet}` : ""}`,
      url,
    );
  }

  // Some endpoints return empty body on 200; tolerate that.
  const text = await response.text();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Emby returned non-JSON response from ${opts.path}: ${text.slice(0, 200)}`,
    );
  }
}
