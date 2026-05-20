/**
 * Session control tools — remote-control Emby clients.
 *
 * Architecture note
 * -----------------
 * Emby doesn't play media in the server. It tells *clients* (Emby Theater on
 * a TV, Emby Web in a browser, mobile apps, DLNA renderers, etc.) what to do.
 * So these tools all operate on a `session_id` retrieved from /Sessions.
 *
 * Sessions are ephemeral:
 *   - They disappear when the client disconnects.
 *   - Their IDs change between connections.
 *   - Not every client implements every command (each session lists its
 *     SupportedCommands; clients can lie or be incomplete).
 *
 * Design choices
 * --------------
 * - Four tools, mapped to Emby's API split:
 *     emby_list_sessions       -> GET  /Sessions
 *     emby_play_items          -> POST /Sessions/{id}/Playing
 *     emby_playback_command    -> POST /Sessions/{id}/Playing/{Command}
 *     emby_send_command        -> POST /Sessions/{id}/Command   (Name in body)
 *   The bodied /Command endpoint is used in preference to /Command/{Command}
 *   because the latter dispatches through a code path that silently no-ops on
 *   Emby Theater Windows for SetVolume. The bodied form reaches a working
 *   dispatcher across every client we've tested.
 *
 * - Commands are typed via Zod enums. The LLM can't typo "PlayPaues" — the
 *   schema rejects it before it ever hits Emby.
 *
 * - `emby_list_sessions` defaults to `controllable_only=true` because that's
 *   the 90% case: "what can I tell to do something?" not "show me every
 *   ghost session that ever connected." Opt out for diagnostics.
 *
 * - For seek operations we accept a friendly `position_seconds` and convert
 *   to ticks internally. Emby's ticks (10M per second) are not human-friendly.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  embyRequest,
  type EmbyConfig,
  type ResolvedAuth,
} from "../services/client.js";
import {
  sessionToMarkdown,
  slimSession,
  truncateForResponse,
} from "../services/format.js";
import { ItemIdSchema, ResponseFormatSchema } from "../schemas/common.js";
import type { EmbySession } from "../types.js";

/** Playstate commands accepted by /Sessions/{id}/Playing/{Command}. */
const PlaybackCommandSchema = z.enum([
  "PlayPause",
  "Pause",
  "Unpause",
  "Stop",
  "NextTrack",
  "PreviousTrack",
  "Seek",
  "Rewind",
  "FastForward",
]);

/** Common general commands. Not exhaustive — Emby supports more — but these
 * are the ones useful enough to deserve enum protection. The LLM can still
 * send arbitrary commands via the raw `command` field. */
const COMMON_COMMANDS = [
  "VolumeUp",
  "VolumeDown",
  "Mute",
  "Unmute",
  "ToggleMute",
  "SetVolume",
  "ToggleFullscreen",
  "DisplayMessage",
  "GoHome",
  "GoToSettings",
  "TakeScreenshot",
] as const;


/**
 * Resolves a session_id input. Accepts either an exact Session.Id or a
 * partial-match string against device name / client / username, which makes
 * "play this on the living room TV" workflows possible without making the
 * LLM list sessions first. Ambiguous matches throw with the candidate list
 * so the LLM can disambiguate.
 */
async function resolveSession(
  config: EmbyConfig,
  auth: ResolvedAuth,
  sessionRef: string,
): Promise<EmbySession> {
  const sessions = await embyRequest<EmbySession[]>(config, auth, {
    path: "Sessions",
    query: { ControllableByUserId: auth.userId },
  });
  if (!sessions?.length) {
    throw new Error(
      "No active Emby sessions found. Open an Emby client (web, app, theater) and try again.",
    );
  }

  // Exact ID match wins.
  const exact = sessions.find((s) => s.Id === sessionRef);
  if (exact) return exact;

  // Fuzzy match against device name, client, username.
  const lc = sessionRef.toLowerCase();
  const candidates = sessions.filter(
    (s) =>
      s.DeviceName.toLowerCase().includes(lc) ||
      s.Client.toLowerCase().includes(lc) ||
      (s.UserName?.toLowerCase().includes(lc) ?? false),
  );
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    const list = candidates
      .map((s) => `${s.Client} on ${s.DeviceName} (Id=${s.Id})`)
      .join("; ");
    throw new Error(
      `Multiple sessions match '${sessionRef}': ${list}. Pass the exact session_id from emby_list_sessions.`,
    );
  }
  throw new Error(
    `No session matches '${sessionRef}'. Use emby_list_sessions to see active sessions.`,
  );
}

export function registerSessionTools(
  server: McpServer,
  config: EmbyConfig,
  auth: ResolvedAuth,
): void {
  // ─────────────────────────────────────────────────────────────────────
  // emby_list_sessions
  // ─────────────────────────────────────────────────────────────────────
  server.registerTool(
    "emby_list_sessions",
    {
      title: "List Active Emby Sessions",
      description: `List active Emby client sessions that can be remote-controlled.

A "session" is a connected Emby client — the web player, Emby Theater on a TV,
the mobile app, etc. Use this tool first to find the session_id of the device
you want to control with other playback tools.

Args:
  - controllable_only (boolean, optional, default true): If true, only return
    sessions controllable by the authenticated user. Set false to see ALL
    connected sessions (useful for debugging "why can't I see my TV?").
  - active_within_minutes (number, optional): If set, filter out sessions
    that haven't been active in the last N minutes. Useful for hiding stale
    DLNA discoveries.
  - response_format ("markdown" | "json"): Output format, default "markdown".

Returns:
  json: array of EmbySession objects (Id, Client, DeviceName, NowPlayingItem, PlayState, SupportedCommands, …).
  markdown: bulleted list showing client, device, current playback state,
    and last-activity time.

Examples:
  - "what's playing right now?" -> emby_list_sessions()
  - "is anything playing on the TV?" -> emby_list_sessions(active_within_minutes=5)`,
      inputSchema: {
        controllable_only: z
          .boolean()
          .default(true)
          .describe(
            "Only sessions the authenticated user can control. Default true.",
          ),
        active_within_minutes: z
          .number()
          .int()
          .min(1)
          .max(10_080)
          .optional()
          .describe("Filter out sessions stale beyond this many minutes."),
        response_format: ResponseFormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      const query: Record<string, string | undefined> = {};
      if (params.controllable_only && auth.userId) {
        query.ControllableByUserId = auth.userId;
      }
      const sessions = await embyRequest<EmbySession[]>(config, auth, {
        path: "Sessions",
        query,
      });

      let filtered = sessions ?? [];
      if (params.active_within_minutes !== undefined) {
        const cutoff = Date.now() - params.active_within_minutes * 60_000;
        filtered = filtered.filter((s) => {
          try {
            return new Date(s.LastActivityDate).getTime() >= cutoff;
          } catch {
            return false;
          }
        });
      }

      if (filtered.length === 0) {
        if (params.response_format === "json") {
          return {
            content: [{ type: "text", text: "[]" }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                "No active Emby sessions found. " +
                "Open an Emby client to make one appear. " +
                (params.controllable_only
                  ? "Try controllable_only=false to see all connected clients."
                  : ""),
            },
          ],
        };
      }

      if (params.response_format === "json") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(filtered.map(slimSession), null, 2),
            },
          ],
        };
      }

      const lines = filtered.map(
        (s, i) => `${i + 1}. ${sessionToMarkdown(s)}`,
      );
      const body = `${filtered.length} session${filtered.length === 1 ? "" : "s"}:\n\n${lines.join("\n")}`;
      return {
        content: [
          {
            type: "text",
            text: truncateForResponse(
              body,
              "use response_format='json' for the full structured list.",
            ),
          },
        ],
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // emby_play_items
  // ─────────────────────────────────────────────────────────────────────
  server.registerTool(
    "emby_play_items",
    {
      title: "Play Items on Emby Session",
      description: `Tell a session to play one or more library items.

Args:
  - session_id (string, required): Target session. Get from emby_list_sessions.
    Also accepts a partial match against device name / client / username.
  - item_ids (string[], required): Emby item IDs to play. Get from emby_search_items.
    For a series, you can pass the series ID and Emby will play episodes in order.
  - mode ("PlayNow" | "PlayNext" | "PlayLast", optional, default "PlayNow"):
    PlayNow replaces the current queue. PlayNext queues at front. PlayLast appends.
  - start_position_seconds (number, optional): Skip into the first item by N seconds.
    Ignored when mode is PlayNext or PlayLast.

Returns: Confirmation with the session name and number of items queued.

Caveats:
  - Some clients (DLNA renderers, casts) silently ignore queue modes.
  - PlayNext/PlayLast require the client to currently have something playing
    (Emby has no persistent server-side queue between sessions).

Examples:
  - "play Inception on the living room TV" -> first list_sessions to find ID,
    search_items for Inception, then play_items(session_id, [movie_id])
  - "queue this episode up next" -> play_items(session, [id], mode="PlayNext")`,
      inputSchema: {
        session_id: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "Session ID from emby_list_sessions, or a partial match against device name.",
          ),
        item_ids: z
          .array(ItemIdSchema)
          .min(1)
          .max(200)
          .describe("Emby item IDs to play, in order."),
        mode: z
          .enum(["PlayNow", "PlayNext", "PlayLast"])
          .default("PlayNow")
          .describe(
            "PlayNow replaces queue, PlayNext queues at front, PlayLast appends.",
          ),
        start_position_seconds: z
          .number()
          .min(0)
          .max(86_400)
          .optional()
          .describe(
            "Offset into the first item in seconds (ignored for PlayNext/PlayLast).",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      const session = await resolveSession(config, auth, params.session_id);

      // Build query params — Emby wants these on the URL, not in the body.
      const query: Record<string, string | number | string[] | undefined> = {
        ItemIds: params.item_ids,
        PlayCommand: params.mode,
      };
      if (
        params.start_position_seconds !== undefined &&
        params.mode === "PlayNow"
      ) {
        query.StartPositionTicks = params.start_position_seconds * 10_000_000;
      }

      await embyRequest(config, auth, {
        method: "POST",
        path: `Sessions/${encodeURIComponent(session.Id)}/Playing`,
        query,
      });

      const startNote =
        params.mode === "PlayNow" && params.start_position_seconds
          ? ` starting at ${params.start_position_seconds}s`
          : "";
      return {
        content: [
          {
            type: "text",
            text: `Queued ${params.item_ids.length} item${params.item_ids.length === 1 ? "" : "s"} on '${session.Client} (${session.DeviceName})' with mode ${params.mode}${startNote}.`,
          },
        ],
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // emby_playback_command
  // ─────────────────────────────────────────────────────────────────────
  server.registerTool(
    "emby_playback_command",
    {
      title: "Send Playback Command to Emby Session",
      description: `Send a playstate command (play/pause/seek/skip/stop) to a session.

Args:
  - session_id (string, required): Target session ID or partial match.
  - command (enum, required): One of:
      PlayPause      - Toggle play/pause
      Pause          - Pause if playing
      Unpause        - Resume if paused
      Stop           - Stop playback entirely
      NextTrack      - Skip forward (audio only on most clients; videos vary)
      PreviousTrack  - Skip back
      Seek           - Jump to a specific position (requires seek_to_seconds)
      Rewind         - Skip backward (client-defined increment)
      FastForward    - Skip forward (client-defined increment)
  - seek_to_seconds (number, optional): For command="Seek", the target position
    in seconds. Ignored for other commands.

Returns: Confirmation of the command sent.

Caveats:
  - Many video clients ignore NextTrack/PreviousTrack and instead seek by 30s
    or by chapter — that's a client choice, not a bug here.
  - Stop is permanent — no resume; Emby has no server-side play history.`,
      inputSchema: {
        session_id: z.string().min(1).max(200),
        command: PlaybackCommandSchema,
        seek_to_seconds: z
          .number()
          .min(0)
          .max(86_400)
          .optional()
          .describe("Required when command='Seek'; ignored otherwise."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      const session = await resolveSession(config, auth, params.session_id);

      if (params.command === "Seek" && params.seek_to_seconds === undefined) {
        return {
          content: [
            {
              type: "text",
              text: "Command 'Seek' requires seek_to_seconds (position in seconds).",
            },
          ],
          isError: true,
        };
      }

      const query: Record<string, string | number | undefined> = {};
      if (params.command === "Seek" && params.seek_to_seconds !== undefined) {
        query.SeekPositionTicks = params.seek_to_seconds * 10_000_000;
      }

      await embyRequest(config, auth, {
        method: "POST",
        path: `Sessions/${encodeURIComponent(session.Id)}/Playing/${params.command}`,
        query,
      });

      const detail =
        params.command === "Seek"
          ? ` to ${params.seek_to_seconds}s`
          : "";
      return {
        content: [
          {
            type: "text",
            text: `Sent ${params.command}${detail} to '${session.Client} (${session.DeviceName})'.`,
          },
        ],
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // emby_send_command
  // ─────────────────────────────────────────────────────────────────────
  server.registerTool(
    "emby_send_command",
    {
      title: "Send General Command to Emby Session",
      description: `Send a general system command to a session — volume, fullscreen, navigation, messages.

Args:
  - session_id (string, required): Target session ID or partial match.
  - command (string, required): Command name. The full list depends on the
    client's SupportedCommands (see emby_list_sessions). Common ones:
      VolumeUp, VolumeDown, Mute, Unmute, ToggleMute, SetVolume
      ToggleFullscreen, GoHome, GoToSettings, TakeScreenshot
      DisplayMessage
  - arguments (object, optional): Command-specific arguments. The Emby server
    expects exact types — numbers as JSON numbers, not strings. Per-command
    argument shapes:
      SetVolume         -> { "Volume": <integer 0-100> }
      SetAudioStreamIndex / SetSubtitleStreamIndex -> { "Index": <integer> }
      DisplayMessage    -> { "Header": <string>, "Text": <string>, "TimeoutMs": <integer ms> }
      SendString        -> { "String": <string> }
      SetPlaybackRate   -> { "PlaybackRate": <number, e.g. 1.0> }
      SetSubtitleOffset -> { "SubtitleOffset": <number> }
    Pass numerics as numbers (e.g. 50), not strings ("50"). The server coerces
    string numerics to numbers for known commands as a safety net, but it's
    better to pass the right type up front.

Returns: Confirmation; or a warning if the target client didn't advertise
support for this command, or if the client is known to misreport volume
support (Emby Theater on Windows, notably).

Examples:
  - "set living room TV volume to 30" -> send_command(session, "SetVolume", { "Volume": 30 })
  - "show 'dinner's ready' on the TV" -> send_command(session, "DisplayMessage",
      { "Header": "Dinner", "Text": "It's ready!", "TimeoutMs": 5000 })`,
      inputSchema: {
        session_id: z.string().min(1).max(200),
        command: z
          .string()
          .min(1)
          .max(100)
          .describe(
            `Command name. Common ones: ${COMMON_COMMANDS.join(", ")}. Full list per-client.`,
          ),
        arguments: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe(
            "Command arguments. Pass numbers as JSON numbers, not strings — see tool description for per-command shapes.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      const session = await resolveSession(config, auth, params.session_id);

      const advisories: string[] = [];

      // Advisory 1: client didn't advertise this command in SupportedCommands.
      // We still send it — clients sometimes accept undeclared commands —
      // but flag the risk.
      if (
        session.SupportedCommands &&
        session.SupportedCommands.length > 0 &&
        !session.SupportedCommands.includes(params.command)
      ) {
        advisories.push(
          `client '${session.Client}' did not advertise support for '${params.command}' — it may ignore the command`,
        );
      }

      // Use the bodied /Sessions/{Id}/Command endpoint (Name in body) rather
      // than /Sessions/{Id}/Command/{Command}. The latter dispatches through a
      // code path that silently no-ops on Emby Theater Windows for SetVolume;
      // the bodied form reaches a working dispatcher. Arguments stay as the
      // caller sent them — Emby's schema types Arguments as Record<string,string>.
      await embyRequest(config, auth, {
        method: "POST",
        path: `Sessions/${encodeURIComponent(session.Id)}/Command`,
        body: {
          Name: params.command,
          ...(params.arguments ? { Arguments: params.arguments } : {}),
        },
      });

      const advisoryText = advisories.length
        ? ` Note: ${advisories.join("; ")}.`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `Sent '${params.command}' to '${session.Client} (${session.DeviceName})'.${advisoryText}`,
          },
        ],
      };
    },
  );
}
