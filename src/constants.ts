/*
 * emby-mcp-server — MCP server for Emby Server.
 * Copyright (C) 2026 Oratorian
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Maximum characters in a single tool response. Responses larger than this
 * get truncated with a clear "narrow your filters" message so the LLM doesn't
 * choke on a 10,000-item library dump.
 */
export const CHARACTER_LIMIT = 25_000;

/** Default page size for list operations. */
export const DEFAULT_LIMIT = 25;

/** Maximum page size — keeps responses bounded even when explicitly requested. */
export const MAX_LIMIT = 100;

/** Identifies this MCP server in Emby auth headers and the X-Application header. */
export const CLIENT_NAME = "EmbyMCP";
export const CLIENT_VERSION = "1.1.1";
export const DEVICE_NAME = "emby-mcp-server";
/** Stable per-installation device id. Emby uses this to track sessions. */
export const DEVICE_ID = "emby-mcp-server-stdio";

/**
 * Catalog of well-known Emby scheduled task names. Emby exposes tasks by
 * stable string Key (e.g. "RefreshLibrary"), but most users think in terms
 * of the display Name. Both are accepted by the start tool — see resolveTaskByName.
 *
 * NOTE: This catalog is a convenience; the source of truth is whatever
 * `/ScheduledTasks` returns from your specific server (plugins can add tasks).
 * The tool falls back to a name lookup against the live list if the alias
 * isn't in this catalog.
 */
export const KNOWN_TASK_ALIASES = {
  scan_library: "RefreshLibrary",
  refresh_chapter_images: "RefreshChapterImages",
  cleanup_logs: "CleanLogFiles",
  cleanup_cache: "CleanCache",
  cleanup_temp_files: "CleanTempFiles",
  cleanup_database: "CleanDatabase",
  cleanup_transcoding_temp: "CleanTranscodingTempFiles",
  cleanup_collections: "CleanupCollections",
  cleanup_playlists: "CleanupPlaylists",
  cleanup_user_data: "RemoveOldUserDatas",
  refresh_people: "RefreshPeople",
  refresh_intros: "RefreshIntros",
  download_subtitles: "DownloadSubtitles",
  optimize_database: "OptimizeDatabase",
  backup_database: "BackupDatabase",
} as const;

export type KnownTaskAlias = keyof typeof KNOWN_TASK_ALIASES;
