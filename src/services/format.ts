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
 * Output formatting helpers.
 *
 * Every list-returning tool needs to choose between a markdown summary
 * (default — easier for the LLM and the user to read) and full JSON
 * (when downstream tool calls need precise field access). The formatters
 * here are the single source of truth for both shapes, so the same item
 * always renders the same way regardless of which tool returns it.
 */

import { CHARACTER_LIMIT } from "../constants.js";
import type { EmbyItem, EmbyScheduledTask, EmbySession } from "../types.js";

/** Convert Emby's tick-based durations (10M ticks/sec) to a human string. */
export function ticksToHuman(ticks: number | undefined): string | undefined {
  if (!ticks || ticks <= 0) return undefined;
  const totalSeconds = Math.floor(ticks / 10_000_000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Convert ticks to whole minutes — easier for small models than raw ticks. */
function ticksToMinutes(ticks: number | undefined): number | undefined {
  if (!ticks || ticks <= 0) return undefined;
  return Math.round(ticks / 10_000_000 / 60);
}

/** Strip an ISO timestamp to YYYY-MM-DD — small models read this more reliably. */
function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.slice(0, 10);
}

/**
 * Trim an ISO timestamp to second precision (YYYY-MM-DDTHH:MM:SSZ).
 * Emby reports tick-level precision in `2026-05-19T21:47:05.3118232Z`;
 * the sub-second tail is noise for small models reasoning about timing.
 */
function isoSecond(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.slice(0, 19) + "Z";
}

/**
 * Slim item shape — flat, ~15 fields, designed for small local models
 * (4B-12B) that struggle with deeply nested Emby objects and raw tick
 * durations. Every JSON-mode tool that returns items emits this shape.
 */
export interface SlimItem {
  id: string;
  name: string;
  type: string;
  year?: number;
  runtime_minutes?: number;
  genres?: string[];
  overview?: string;
  community_rating?: number;
  official_rating?: string;
  is_played?: boolean;
  is_favorite?: boolean;
  play_count?: number;
  personal_rating?: number;
  imdb_id?: string;
  tmdb_id?: string;
  tvdb_id?: string;
  series_name?: string;
  season_number?: number;
  episode_number?: number;
  premiered_on?: string;
  added_on?: string;
  tags?: string[];
}

/** Convert a raw EmbyItem into the slim, model-friendly shape. */
export function slimItem(item: EmbyItem): SlimItem {
  const out: SlimItem = {
    id: item.Id,
    name: item.Name,
    type: item.Type,
  };
  if (typeof item.ProductionYear === "number") out.year = item.ProductionYear;
  const minutes = ticksToMinutes(item.RunTimeTicks);
  if (minutes !== undefined) out.runtime_minutes = minutes;
  if (item.Genres?.length) out.genres = item.Genres;
  if (item.Overview) out.overview = item.Overview;
  if (typeof item.CommunityRating === "number") {
    out.community_rating = item.CommunityRating;
  }
  if (item.OfficialRating) out.official_rating = item.OfficialRating;
  if (item.UserData) {
    out.is_played = item.UserData.Played;
    out.is_favorite = item.UserData.IsFavorite;
    out.play_count = item.UserData.PlayCount;
    if (typeof item.UserData.Rating === "number") {
      out.personal_rating = item.UserData.Rating;
    }
  }
  if (item.ProviderIds) {
    if (item.ProviderIds.Imdb) out.imdb_id = item.ProviderIds.Imdb;
    if (item.ProviderIds.Tmdb) out.tmdb_id = item.ProviderIds.Tmdb;
    if (item.ProviderIds.Tvdb) out.tvdb_id = item.ProviderIds.Tvdb;
  }
  if (item.SeriesName) out.series_name = item.SeriesName;
  if (typeof item.ParentIndexNumber === "number") {
    out.season_number = item.ParentIndexNumber;
  }
  if (typeof item.IndexNumber === "number") {
    out.episode_number = item.IndexNumber;
  }
  const premiered = isoDate(item.PremiereDate);
  if (premiered) out.premiered_on = premiered;
  const added = isoDate(item.DateCreated);
  if (added) out.added_on = added;
  if (item.Tags?.length) out.tags = item.Tags;
  return out;
}

/**
 * Curated capability booleans derived from a session's SupportedCommands list.
 * Replaces the raw 35+ command-name array with the handful of capabilities
 * a voice-control client actually plans against. The full list is dropped
 * from the slim shape; if you genuinely need to introspect every command,
 * use the markdown form or the underlying /Sessions endpoint directly.
 *
 * Note: playstate commands (Pause/Stop/Seek/Next/Previous) are NOT here —
 * they're sent through emby_playback_command (`/Sessions/{Id}/Playing/...`),
 * which Emby always accepts on any controllable session regardless of what
 * SupportedCommands advertises. If `supports_remote_control` is true, those
 * commands are always available; don't gate them on a capability flag.
 */
export interface SessionCapabilities {
  can_play_media: boolean;
  can_set_volume: boolean;
  can_step_volume: boolean;
  can_mute: boolean;
  can_set_audio_track: boolean;
  can_set_subtitle_track: boolean;
  can_display_message: boolean;
  can_go_home: boolean;
  can_navigate: boolean;
}

/** Map a session's SupportedCommands array into the curated capability set. */
function deriveCapabilities(
  supportedCommands: string[] | undefined,
): SessionCapabilities {
  const set = new Set(supportedCommands ?? []);
  const has = (...names: string[]): boolean => names.some((n) => set.has(n));
  return {
    can_play_media: has("PlayMediaSource", "PlayTrailers"),
    can_set_volume: has("SetVolume"),
    can_step_volume: has("VolumeUp", "VolumeDown"),
    can_mute: has("Mute", "Unmute", "ToggleMute"),
    can_set_audio_track: has("SetAudioStreamIndex"),
    can_set_subtitle_track: has("SetSubtitleStreamIndex"),
    can_display_message: has("DisplayMessage"),
    can_go_home: has("GoHome"),
    can_navigate: has(
      "MoveUp",
      "MoveDown",
      "MoveLeft",
      "MoveRight",
      "Select",
      "Back",
    ),
  };
}

/** Slim session shape — strips raw ticks and noisy fields. */
export interface SlimSession {
  id: string;
  user_name?: string;
  client: string;
  device_name: string;
  application_version?: string;
  supports_remote_control: boolean;
  /** Only populated when supports_remote_control is true. */
  capabilities?: SessionCapabilities;
  last_active_seconds_ago?: number;
  now_playing?: {
    id: string;
    name: string;
    type: string;
    series_name?: string;
    season_number?: number;
    episode_number?: number;
    runtime_minutes?: number;
    position_minutes?: number;
    progress_percent?: number;
    is_paused?: boolean;
    is_muted?: boolean;
    volume_level?: number;
  };
}

/** Convert a raw EmbySession into the slim shape. */
export function slimSession(session: EmbySession): SlimSession {
  const controllable = session.SupportsRemoteControl !== false;
  const out: SlimSession = {
    id: session.Id,
    client: session.Client,
    device_name: session.DeviceName,
    supports_remote_control: controllable,
  };
  if (controllable) {
    out.capabilities = deriveCapabilities(session.SupportedCommands);
  }
  if (session.UserName) out.user_name = session.UserName;
  if (session.ApplicationVersion) {
    out.application_version = session.ApplicationVersion;
  }
  try {
    const lastSeen = new Date(session.LastActivityDate).getTime();
    out.last_active_seconds_ago = Math.max(
      0,
      Math.floor((Date.now() - lastSeen) / 1000),
    );
  } catch {
    // Bad date string — leave undefined.
  }
  if (session.NowPlayingItem) {
    const npi = session.NowPlayingItem;
    const np: NonNullable<SlimSession["now_playing"]> = {
      id: npi.Id,
      name: npi.Name,
      type: npi.Type,
    };
    if (npi.SeriesName) np.series_name = npi.SeriesName;
    if (typeof npi.ParentIndexNumber === "number") {
      np.season_number = npi.ParentIndexNumber;
    }
    if (typeof npi.IndexNumber === "number") {
      np.episode_number = npi.IndexNumber;
    }
    const runtime = ticksToMinutes(npi.RunTimeTicks);
    if (runtime !== undefined) np.runtime_minutes = runtime;
    if (session.PlayState) {
      const pos = ticksToMinutes(session.PlayState.PositionTicks);
      if (pos !== undefined) np.position_minutes = pos;
      if (
        session.PlayState.PositionTicks &&
        npi.RunTimeTicks &&
        npi.RunTimeTicks > 0
      ) {
        np.progress_percent = Math.round(
          (session.PlayState.PositionTicks / npi.RunTimeTicks) * 100,
        );
      }
      if (typeof session.PlayState.IsPaused === "boolean") {
        np.is_paused = session.PlayState.IsPaused;
      }
      if (typeof session.PlayState.IsMuted === "boolean") {
        np.is_muted = session.PlayState.IsMuted;
      }
      if (typeof session.PlayState.VolumeLevel === "number") {
        np.volume_level = session.PlayState.VolumeLevel;
      }
    }
    out.now_playing = np;
  }
  return out;
}

/** Slim scheduled task shape — drops raw tick triggers. */
export interface SlimTask {
  id: string;
  key?: string;
  name: string;
  state: "Idle" | "Cancelling" | "Running";
  category?: string;
  description?: string;
  progress_percent?: number;
  last_run?: {
    status: "Completed" | "Failed" | "Cancelled" | "Aborted";
    started_at: string;
    ended_at: string;
    error_message?: string;
  };
  is_hidden?: boolean;
}

/** Convert a raw EmbyScheduledTask into the slim shape. */
export function slimTask(task: EmbyScheduledTask): SlimTask {
  const out: SlimTask = {
    id: task.Id,
    name: task.Name,
    state: task.State,
  };
  if (task.Key) out.key = task.Key;
  if (task.Category) out.category = task.Category;
  if (task.Description) out.description = task.Description;
  if (
    typeof task.CurrentProgressPercentage === "number" &&
    task.State === "Running"
  ) {
    out.progress_percent = Math.round(task.CurrentProgressPercentage);
  }
  if (task.LastExecutionResult) {
    const r = task.LastExecutionResult;
    out.last_run = {
      status: r.Status,
      started_at: isoSecond(r.StartTimeUtc) ?? r.StartTimeUtc,
      ended_at: isoSecond(r.EndTimeUtc) ?? r.EndTimeUtc,
    };
    if (r.ErrorMessage) out.last_run.error_message = r.ErrorMessage;
  }
  if (task.IsHidden) out.is_hidden = task.IsHidden;
  return out;
}

/**
 * Truncate a response to CHARACTER_LIMIT, appending guidance on how to get
 * a smaller result. The guidance is part of the truncation — never silent.
 */
export function truncateForResponse(text: string, hint: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  const head = text.slice(0, CHARACTER_LIMIT - 200);
  return (
    head +
    `\n\n…[truncated at ${CHARACTER_LIMIT} characters]\n` +
    `Hint: ${hint}`
  );
}

/**
 * Render an Emby item as a one-paragraph markdown summary. Keeps the most
 * useful fields up front (title, type, year) and skips empty values.
 */
export function itemToMarkdown(item: EmbyItem): string {
  const parts: string[] = [];
  parts.push(`**${item.Name}** (${item.Type}${item.ProductionYear ? `, ${item.ProductionYear}` : ""})`);
  parts.push(`ID: \`${item.Id}\``);
  if (item.SeriesName) parts.push(`Series: ${item.SeriesName}`);
  if (item.SeasonName) parts.push(`Season: ${item.SeasonName}`);
  if (typeof item.IndexNumber === "number") {
    const ep = typeof item.ParentIndexNumber === "number"
      ? `S${item.ParentIndexNumber}E${item.IndexNumber}`
      : `Episode ${item.IndexNumber}`;
    parts.push(ep);
  }
  const runtime = ticksToHuman(item.RunTimeTicks);
  if (runtime) parts.push(`Runtime: ${runtime}`);
  if (item.Genres && item.Genres.length > 0) {
    parts.push(`Genres: ${item.Genres.join(", ")}`);
  }
  if (item.OfficialRating) parts.push(`Rated: ${item.OfficialRating}`);
  if (typeof item.CommunityRating === "number") {
    parts.push(`Community: ${item.CommunityRating.toFixed(1)}`);
  }
  if (item.UserData) {
    const flags: string[] = [];
    if (item.UserData.Played) flags.push("✓ played");
    if (item.UserData.IsFavorite) flags.push("★ favorite");
    if (typeof item.UserData.Rating === "number") {
      flags.push(`rating ${item.UserData.Rating}`);
    }
    if (flags.length) parts.push(flags.join(" · "));
  }
  return parts.join(" · ");
}

/** Detailed multi-line view for a single item — used by emby_get_item. */
export function itemToDetailedMarkdown(item: EmbyItem): string {
  const lines: string[] = [];
  lines.push(`# ${item.Name}`);
  lines.push("");
  lines.push(`- **Type:** ${item.Type}`);
  lines.push(`- **ID:** \`${item.Id}\``);
  if (item.ProductionYear) lines.push(`- **Year:** ${item.ProductionYear}`);
  if (item.SeriesName) lines.push(`- **Series:** ${item.SeriesName}`);
  if (item.SeasonName) lines.push(`- **Season:** ${item.SeasonName}`);
  if (typeof item.IndexNumber === "number") {
    lines.push(`- **Episode #:** ${item.IndexNumber}`);
  }
  const runtime = ticksToHuman(item.RunTimeTicks);
  if (runtime) lines.push(`- **Runtime:** ${runtime}`);
  if (item.OfficialRating) lines.push(`- **Rated:** ${item.OfficialRating}`);
  if (typeof item.CommunityRating === "number") {
    lines.push(`- **Community Rating:** ${item.CommunityRating}`);
  }
  if (typeof item.CriticRating === "number") {
    lines.push(`- **Critic Rating:** ${item.CriticRating}`);
  }
  if (item.Genres?.length) lines.push(`- **Genres:** ${item.Genres.join(", ")}`);
  if (item.Tags?.length) lines.push(`- **Tags:** ${item.Tags.join(", ")}`);
  if (item.PremiereDate) lines.push(`- **Premiered:** ${item.PremiereDate.slice(0, 10)}`);
  if (item.DateCreated) lines.push(`- **Added:** ${item.DateCreated.slice(0, 10)}`);
  if (item.Path) lines.push(`- **Path:** \`${item.Path}\``);
  if (item.UserData) {
    lines.push("");
    lines.push("## User Data");
    lines.push(`- **Played:** ${item.UserData.Played ? "yes" : "no"}`);
    lines.push(`- **Play Count:** ${item.UserData.PlayCount}`);
    lines.push(`- **Favorite:** ${item.UserData.IsFavorite ? "yes" : "no"}`);
    if (typeof item.UserData.Rating === "number") {
      lines.push(`- **Personal Rating:** ${item.UserData.Rating}`);
    }
  }
  if (item.ProviderIds && Object.keys(item.ProviderIds).length > 0) {
    lines.push("");
    lines.push("## External IDs");
    for (const [k, v] of Object.entries(item.ProviderIds)) {
      lines.push(`- **${k}:** ${v}`);
    }
  }
  if (item.Overview) {
    lines.push("");
    lines.push("## Overview");
    lines.push(item.Overview);
  }
  return lines.join("\n");
}

/** Render a scheduled task as a markdown bullet — used by list_scheduled_tasks. */
export function taskToMarkdown(task: EmbyScheduledTask): string {
  const parts: string[] = [];
  parts.push(`**${task.Name}** [${task.State}]`);
  parts.push(`Key: \`${task.Key ?? "<none>"}\``);
  parts.push(`ID: \`${task.Id}\``);
  if (task.Category) parts.push(`Category: ${task.Category}`);
  if (typeof task.CurrentProgressPercentage === "number" && task.State === "Running") {
    parts.push(`Progress: ${task.CurrentProgressPercentage.toFixed(0)}%`);
  }
  if (task.LastExecutionResult) {
    const r = task.LastExecutionResult;
    parts.push(`Last run: ${r.Status} at ${r.EndTimeUtc.slice(0, 19)}Z`);
    if (r.ErrorMessage) parts.push(`Error: ${r.ErrorMessage}`);
  }
  return parts.join(" · ");
}

/** Detailed scheduled task view — used by get_scheduled_task. */
export function taskToDetailedMarkdown(task: EmbyScheduledTask): string {
  const lines: string[] = [];
  lines.push(`# ${task.Name}`);
  lines.push("");
  lines.push(`- **State:** ${task.State}`);
  lines.push(`- **Key:** \`${task.Key ?? "<none>"}\``);
  lines.push(`- **ID:** \`${task.Id}\``);
  if (task.Category) lines.push(`- **Category:** ${task.Category}`);
  if (task.Description) lines.push(`- **Description:** ${task.Description}`);
  if (typeof task.CurrentProgressPercentage === "number" && task.State === "Running") {
    lines.push(`- **Progress:** ${task.CurrentProgressPercentage.toFixed(0)}%`);
  }
  if (task.LastExecutionResult) {
    const r = task.LastExecutionResult;
    lines.push("");
    lines.push("## Last Execution");
    lines.push(`- **Status:** ${r.Status}`);
    lines.push(`- **Started:** ${r.StartTimeUtc.slice(0, 19)}Z`);
    lines.push(`- **Ended:** ${r.EndTimeUtc.slice(0, 19)}Z`);
    if (r.ErrorMessage) lines.push(`- **Error:** ${r.ErrorMessage}`);
  }
  if (task.Triggers?.length) {
    lines.push("");
    lines.push("## Triggers");
    for (const t of task.Triggers) {
      const detail: string[] = [`Type: ${t.Type}`];
      if (t.IntervalTicks) {
        const hours = t.IntervalTicks / 10_000_000 / 3600;
        detail.push(`Every ${hours}h`);
      }
      if (t.DayOfWeek) detail.push(`Day: ${t.DayOfWeek}`);
      if (t.TimeOfDayTicks) {
        const seconds = t.TimeOfDayTicks / 10_000_000;
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        detail.push(`Time: ${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`);
      }
      lines.push(`- ${detail.join(" · ")}`);
    }
  }
  return lines.join("\n");
}

/**
 * Compact one-line session summary — used by emby_list_sessions.
 * Highlights: client name, who's logged in, what's playing, last activity.
 */
export function sessionToMarkdown(session: EmbySession): string {
  const parts: string[] = [];
  const who = session.UserName ? `${session.UserName}@` : "";
  parts.push(`**${who}${session.Client}** on ${session.DeviceName}`);
  parts.push(`Session ID: \`${session.Id}\``);

  if (session.NowPlayingItem) {
    const npi = session.NowPlayingItem;
    let label = npi.Name;
    if (npi.SeriesName && typeof npi.IndexNumber === "number") {
      const ep =
        typeof npi.ParentIndexNumber === "number"
          ? `S${npi.ParentIndexNumber}E${npi.IndexNumber}`
          : `E${npi.IndexNumber}`;
      label = `${npi.SeriesName} ${ep} — ${npi.Name}`;
    }
    const state = session.PlayState?.IsPaused ? "⏸ paused" : "▶ playing";
    let progress = "";
    if (
      session.PlayState?.PositionTicks &&
      npi.RunTimeTicks &&
      npi.RunTimeTicks > 0
    ) {
      const pct = (session.PlayState.PositionTicks / npi.RunTimeTicks) * 100;
      const pos = ticksToHuman(session.PlayState.PositionTicks);
      const total = ticksToHuman(npi.RunTimeTicks);
      progress = ` (${pos ?? "?"}/${total ?? "?"}, ${pct.toFixed(0)}%)`;
    }
    parts.push(`${state}: ${label}${progress}`);
  } else {
    parts.push("idle");
  }

  if (session.SupportsRemoteControl === false) {
    parts.push("⚠ remote control not supported");
  }

  // Last activity in a friendly form.
  try {
    const lastSeen = new Date(session.LastActivityDate);
    const seconds = Math.floor((Date.now() - lastSeen.getTime()) / 1000);
    if (seconds < 60) parts.push(`active ${seconds}s ago`);
    else if (seconds < 3600) parts.push(`active ${Math.floor(seconds / 60)}m ago`);
    else if (seconds < 86_400) parts.push(`active ${Math.floor(seconds / 3600)}h ago`);
    else parts.push(`active ${Math.floor(seconds / 86_400)}d ago`);
  } catch {
    // Bad date string — just skip.
  }

  return parts.join(" · ");
}
