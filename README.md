# emby-mcp-server

An MCP (Model Context Protocol) server that exposes [Emby Server](https://emby.media/) library management, scheduled-task, and session-control operations to LLM clients like Claude.

Designed for personal use on a single Emby instance with two deployment shapes in mind:

- **General-purpose use with a cloud LLM** (e.g. Claude Desktop) — full search surface, friendly markdown by default.
- **Voice / accessibility front-ends running a small local model** (4B-12B class — Gemma 3, Qwen, etc. via Ollama or similar). JSON responses are slim, flat, snake_case, and free of raw tick durations or nested objects that small models tend to misread.

The tool surface covers search, item details, played/favorite/rating state, metadata edits, refresh, scheduled tasks, and session control (play, pause, seek, volume, etc.).

## Requirements

- Node.js ≥ 18
- An Emby server, reachable over HTTP from wherever you run this MCP server
- Either an Emby API key OR a valid username/password pair

## Install & build

```bash
npm install
npm run build
```

Output goes to `dist/`. The entry point is `dist/index.js`.

## Configuration

All configuration is via environment variables.

| Variable | Required | Description |
|---|---|---|
| `EMBY_SERVER_URL` | yes | Base URL of your Emby server, e.g. `http://192.168.1.50:8096`. No trailing slash needed. |
| `EMBY_API_KEY` | one of | Server-wide API key. Get one in **Dashboard → API Keys**. |
| `EMBY_USERNAME` | one of | Emby username. Pair with `EMBY_PASSWORD`. |
| `EMBY_PASSWORD` | one of | Emby password for the named user. |

If both `EMBY_API_KEY` and username/password are set, the API key wins.

**Auth differences:**

- **API key** → server-wide, no user context. Some tools (mark played, favorites, ratings) won't work — they need a UserId. Use API key auth for sysadmin-style tasks like running scheduled tasks.
- **Username/password** → full per-user access. The MCP server logs in once at startup, gets an `AccessToken` and `UserId`, and uses those for all subsequent calls.

## Run with Claude Desktop / claude.ai stdio config

Two ways to wire the server into your MCP client's `claude_desktop_config.json`. Both work; pick whichever fits.

**Option A — install from npm (no local build needed):**

```json
{
  "mcpServers": {
    "emby": {
      "command": "npx",
      "args": ["-y", "@mahesvara/emby-mcp-server"],
      "env": {
        "EMBY_SERVER_URL": "http://192.168.1.50:8096",
        "EMBY_USERNAME": "username",
        "EMBY_PASSWORD": "..."
      }
    }
  }
}
```

`npx -y` downloads the package on first launch and caches it; subsequent launches are fast. Update by clearing the npm cache or pinning a version (`@mahesvara/emby-mcp-server@1.2.0`).

**Option B — run from a local checkout** (clone the repo and `npm install && npm run build` first):

```json
{
  "mcpServers": {
    "emby": {
      "command": "node",
      "args": ["/absolute/path/to/emby-mcp-server/dist/index.js"],
      "env": {
        "EMBY_SERVER_URL": "http://192.168.1.50:8096",
        "EMBY_USERNAME": "username",
        "EMBY_PASSWORD": "..."
      }
    }
  }
}
```

Use this when you're developing against the source, want a specific commit, or don't want an internet round-trip on first launch.

## Tools

### Library

| Tool | What it does |
|---|---|
| `emby_search_items` | Search by title, type, genre, year, quality (HD/4K/3D), ratings (community/critic/official), tags, person/studio names, parent folder, played/favorite state, and metadata completeness (`has_imdb_id`, `has_theme_song`, etc.) |
| `emby_get_item` | Full metadata for one item by ID |
| `emby_mark_played` | Toggle played state (requires user-context auth) |
| `emby_set_rating` | Set personal rating (0-10) and/or favorite flag |
| `emby_update_item_metadata` | Patch name/overview/genres/tags/rating/year (server-wide) |
| `emby_refresh_item` | Trigger metadata re-scan from external providers |

`emby_search_items` accepts plain human-readable `person_names` and `studio_names` — the tool resolves them to Emby IDs internally before searching (prefers an exact case-insensitive name match, falls back to first hit). Unresolved names surface in the response as an `unresolved` field so the consumer can tell the user "no library match for X" rather than returning silent empty results.

### Scheduled tasks

| Tool | What it does |
|---|---|
| `emby_list_scheduled_tasks` | List all tasks with state, optionally filter to running |
| `emby_get_scheduled_task` | Detail for one task |
| `emby_start_scheduled_task` | Start a task by alias, Key, or Id |
| `emby_stop_scheduled_task` | Cancel a running task |

### Session control (playback)

Remote-control connected Emby clients (web player, Emby Theater, mobile apps, DLNA renderers). The MCP server can't play media itself — it tells *other* clients what to do.

| Tool | What it does |
|---|---|
| `emby_list_sessions` | List active sessions with what's playing, who, where |
| `emby_play_items` | Play library items on a session (PlayNow / PlayNext / PlayLast) |
| `emby_playback_command` | PlayPause / Pause / Unpause / Stop / Seek / Next / Previous / Rewind / FastForward |
| `emby_send_command` | General commands: VolumeUp/Down, Mute, SetVolume, DisplayMessage, ToggleFullscreen, GoHome, etc. |

Caveats worth knowing:
- **Sessions are ephemeral.** They appear when a client connects, disappear when it closes. `emby_list_sessions` reflects the current state — IDs change.
- **Clients support different commands.** Each session in the JSON response carries a `capabilities` object — curated booleans like `can_set_volume`, `can_step_volume`, `can_display_message`. Playstate commands (Pause/Stop/Seek/Next/Previous) are *not* in this map: they go through `emby_playback_command` and are always available on any controllable session. `emby_send_command` warns if a client didn't advertise the requested general command.
- **NextTrack/PreviousTrack are quirky on video.** Most video clients ignore them or remap them to a 30-second skip / chapter jump.
- **Stop is permanent.** Emby has no server-side resume history. Once a client stops, you can't tell it to "resume where you left off" via the API.
- **`volume_level` on `now_playing` is advisory.** Some clients (notably Emby Theater on Windows) only self-report volume on certain events, so the value can lag the real player state. Trust your ears, not the number.

The server sends general commands via the bodied `POST /Sessions/{Id}/Command` endpoint (with `Name` in the JSON body), not the per-command path `/Sessions/{Id}/Command/{Command}`. On Emby Theater Windows the per-command path silently no-ops `SetVolume`; the bodied form works on every client tested. Worth knowing if you extend the session tools.

### Task aliases

`emby_start_scheduled_task` and `emby_stop_scheduled_task` accept friendly aliases as well as Emby's internal Keys:

| Alias | Emby Key |
|---|---|
| `scan_library` | `RefreshLibrary` |
| `refresh_chapter_images` | `RefreshChapterImages` |
| `cleanup_logs` | `CleanLogFiles` |
| `cleanup_cache` | `CleanCache` |
| `cleanup_temp_files` | `CleanTempFiles` |
| `cleanup_database` | `CleanDatabase` |
| `cleanup_transcoding_temp` | `CleanTranscodingTempFiles` |
| `cleanup_collections` | `CleanupCollections` |
| `cleanup_playlists` | `CleanupPlaylists` |
| `cleanup_user_data` | `RemoveOldUserDatas` |
| `refresh_people` | `RefreshPeople` |
| `refresh_intros` | `RefreshIntros` |
| `download_subtitles` | `DownloadSubtitles` |
| `optimize_database` | `OptimizeDatabase` |
| `backup_database` | `BackupDatabase` |

The aliases are a convenience layer; the source of truth is whatever your server actually exposes in `/ScheduledTasks`. If a task isn't in this list (e.g., one added by a plugin), pass its display Name or Key directly — the server resolves any of them.

## Response shapes

Every list-returning tool accepts `response_format: "markdown" | "json"` (markdown is the default). The JSON form is a deliberately slim, flat, snake_case shape — designed so a 4B-12B local model can consume it without choking on deeply nested Emby objects, raw tick durations, or sub-second timestamps.

**Item (search/get):**

```json
{
  "id": "99160",
  "name": "Polar",
  "type": "Movie",
  "year": 2019,
  "runtime_minutes": 119,
  "genres": ["Action", "Crime", "Drama"],
  "overview": "When a retiring assassin…",
  "community_rating": 6.3,
  "official_rating": "NC-17",
  "is_played": false,
  "is_favorite": false,
  "play_count": 0,
  "imdb_id": "tt4139588",
  "tmdb_id": "483906",
  "tvdb_id": "61",
  "premiered_on": "2019-01-24",
  "added_on": "2026-05-09"
}
```

Empty/missing fields are omitted entirely (small models cope with missing keys better than nulls). Episode items add `series_name`, `season_number`, `episode_number`.

**Session:**

```json
{
  "id": "ef666…",
  "client": "Emby Web",
  "device_name": "Firefox Windows",
  "supports_remote_control": true,
  "capabilities": {
    "can_play_media": true,
    "can_set_volume": true,
    "can_step_volume": true,
    "can_mute": true,
    "can_set_audio_track": true,
    "can_set_subtitle_track": true,
    "can_display_message": true,
    "can_go_home": true,
    "can_navigate": true
  },
  "user_name": "andrew",
  "last_active_seconds_ago": 13,
  "now_playing": {
    "id": "99160",
    "name": "Polar",
    "type": "Movie",
    "runtime_minutes": 119,
    "position_minutes": 18,
    "progress_percent": 15,
    "is_paused": false,
    "is_muted": false,
    "volume_level": 70
  }
}
```

`capabilities` is omitted entirely on sessions that don't support remote control. `now_playing` is omitted when the session is idle.

**Scheduled task:**

```json
{
  "id": "6330ee…",
  "key": "RefreshLibrary",
  "name": "Scan media library",
  "state": "Idle",
  "category": "Library",
  "last_run": {
    "status": "Completed",
    "started_at": "2026-05-20T06:31:55Z",
    "ended_at": "2026-05-20T06:32:05Z"
  }
}
```

Timestamps are trimmed to second precision; raw tick triggers are dropped from the slim shape (use the markdown form if you need the full trigger schedule).

## Design notes

- **Item IDs only for mutations.** No fuzzy "mark Inception as watched" — the LLM must `emby_search_items` first. Avoids destroying state on ambiguous matches.
- **Names resolved inside the tool, not chained by the model.** `person_names` / `studio_names` on `emby_search_items` look up Emby IDs internally rather than requiring the LLM to call a separate resolver tool first. Small models chain tool calls unreliably under voice latency; one-call resolution is robust.
- **Markdown by default, JSON on request.** Markdown is compact and human-readable; JSON is the slim shape above, optimized for programmatic consumption by small local models.
- **Bounded responses.** Hard 25,000-character truncation with a hint on how to narrow the query. Pagination is `limit`/`offset` everywhere.
- **Empty lists return structured JSON.** A no-results search in JSON mode returns `{total: 0, count: 0, items: [], has_more: false}`, never a prose sentence — so a consumer can `result.items.length` without special-casing.
- **Errors point at fixes.** A 401 says "check EMBY_API_KEY or credentials." A 404 says "verify with emby_search_items." No raw stack traces.
- **Bodied command endpoint.** `emby_send_command` posts to `POST /Sessions/{Id}/Command` (with `Name` in the body), not `/Command/{Command}` — the per-command path silently no-ops `SetVolume` on Emby Theater Windows.

## Limitations

- No direct media playback (intentional — MCP can't render audio/video). Session control tools let you drive other Emby clients instead.
- No user/session management (creating users, managing devices, etc. — out of scope).
- No XML responses — JSON only.
- Single Emby instance per server process. To serve multiple, run multiple processes.
