/**
 * Type definitions for Emby Server REST API responses.
 *
 * These are intentionally narrow: only the fields we actually read are
 * declared. Emby returns much more, but typing every field would be both
 * fragile (the API evolves) and overkill (we strip unused data anyway).
 *
 * All fields are `unknown`-safe: code that consumes these does so via
 * the format helpers in services/format.ts which tolerate missing values.
 */

export interface EmbyAuthResponse {
  User: { Id: string; Name: string };
  AccessToken: string;
  ServerId: string;
}

export interface EmbyItem {
  Id: string;
  Name: string;
  Type: string; // "Movie" | "Series" | "Episode" | "Season" | "Audio" | ...
  ProductionYear?: number;
  Overview?: string;
  Genres?: string[];
  Tags?: string[];
  CommunityRating?: number;
  CriticRating?: number;
  OfficialRating?: string;
  RunTimeTicks?: number;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  SeriesName?: string;
  SeasonName?: string;
  Path?: string;
  DateCreated?: string;
  PremiereDate?: string;
  UserData?: {
    Played: boolean;
    PlayCount: number;
    IsFavorite: boolean;
    Rating?: number;
    PlaybackPositionTicks?: number;
  };
  ProviderIds?: Record<string, string>;
}

export interface EmbyItemsResponse {
  Items: EmbyItem[];
  TotalRecordCount: number;
}

export interface EmbyTaskTriggerInfo {
  Type: string;
  TimeOfDayTicks?: number;
  IntervalTicks?: number;
  DayOfWeek?: string;
  MaxRuntimeTicks?: number;
}

export interface EmbyScheduledTask {
  Id: string;
  Name: string;
  /** Stable string ID. Optional because Emby occasionally omits it
   * (observed on built-in "Rotate log file" task — has no Key in the API). */
  Key?: string;
  Description?: string;
  Category?: string;
  State: "Idle" | "Cancelling" | "Running";
  CurrentProgressPercentage?: number;
  LastExecutionResult?: {
    StartTimeUtc: string;
    EndTimeUtc: string;
    Status: "Completed" | "Failed" | "Cancelled" | "Aborted";
    ErrorMessage?: string;
    LongErrorMessage?: string;
  };
  Triggers?: EmbyTaskTriggerInfo[];
  IsHidden?: boolean;
}

/** Discriminated result type used by every tool — keeps error handling consistent. */
export type ToolOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };
