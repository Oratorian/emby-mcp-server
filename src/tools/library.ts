/**
 * Library tools — search, inspect, and manage media items.
 *
 * Design notes
 * ------------
 * - Item IDs are required for every mutation tool. We deliberately do NOT
 *   accept names ("mark Inception as watched") to avoid ambiguous matches
 *   destroying state. The LLM should call emby_search_items first.
 * - Mutations are routed through `/Users/{UserId}/...` when we have a
 *   UserId (username/password auth). With API-key auth we don't have a
 *   UserId, so we require the caller to pass one — but that's rare; the
 *   server-wide API key is intended for sysadmin tasks, not per-user state.
 *   We surface a clear error in that case.
 * - update_item_metadata uses Emby's POST /Items/{id} which requires the
 *   FULL item body. We GET first, merge our patches, then POST — standard
 *   Emby pattern, otherwise unspecified fields get blanked out.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  embyRequest,
  type EmbyConfig,
  type ResolvedAuth,
} from "../services/client.js";
import {
  itemToDetailedMarkdown,
  itemToMarkdown,
  slimItem,
  truncateForResponse,
} from "../services/format.js";
import { ItemIdSchema, PaginationShape, ResponseFormatSchema } from "../schemas/common.js";
import type { EmbyItem, EmbyItemsResponse } from "../types.js";

/** Builds a 'requires user context' error when API-key auth lacks a UserId. */
function requireUserId(auth: ResolvedAuth): string {
  if (auth.userId) return auth.userId;
  throw new Error(
    "This operation requires user context, but the server is configured " +
      "with an API key (no UserId). Switch to EMBY_USERNAME/EMBY_PASSWORD auth, " +
      "or pass a `user_id` parameter explicitly.",
  );
}

interface NamedHit {
  Id: string;
  Name: string;
}

interface NamedListResponse {
  Items?: NamedHit[];
}

/**
 * Resolve a list of human-readable names to Emby IDs via the given endpoint
 * (typically "Persons" or "Studios"). Strategy:
 *   1. For each name, GET <endpoint>?SearchTerm=<name>&Limit=20.
 *   2. Prefer a case-insensitive EXACT match against the returned items.
 *   3. Fall back to the first result if no exact match exists.
 *   4. Drop names with no results, recording them for an advisory note.
 *
 * Returns the resolved IDs plus the list of names that couldn't be matched —
 * the caller surfaces the unresolved names so the LLM/user knows why a query
 * came back light.
 */
async function resolveNamesToIds(
  config: EmbyConfig,
  auth: ResolvedAuth,
  endpoint: "Persons" | "Studios",
  names: readonly string[],
): Promise<{ ids: string[]; unresolved: string[] }> {
  const ids: string[] = [];
  const unresolved: string[] = [];
  for (const rawName of names) {
    const name = rawName.trim();
    if (!name) continue;
    const data = await embyRequest<NamedListResponse>(config, auth, {
      path: endpoint,
      query: { SearchTerm: name, Limit: 20 },
    });
    const hits = data?.Items ?? [];
    if (hits.length === 0) {
      unresolved.push(name);
      continue;
    }
    const lc = name.toLowerCase();
    const exact = hits.find((h) => h.Name.toLowerCase() === lc);
    ids.push((exact ?? hits[0]!).Id);
  }
  return { ids, unresolved };
}

export function registerLibraryTools(
  server: McpServer,
  config: EmbyConfig,
  auth: ResolvedAuth,
): void {
  // ─────────────────────────────────────────────────────────────────────
  // emby_search_items
  // ─────────────────────────────────────────────────────────────────────
  server.registerTool(
    "emby_search_items",
    {
      title: "Search Emby Library",
      description: `Search the Emby library for movies, shows, episodes, or other media.

Returns matching items with their IDs — required input for every other library tool.

Args:
  - query (string, optional): Title search. Partial matches supported.
  - item_types (string[], optional): Filter by type, e.g. ["Movie","Series","Episode"].
    Common: Movie, Series, Season, Episode, Audio, MusicAlbum, MusicArtist, Book.
  - genres (string[], optional): Filter by genre name(s), e.g. ["Sci-Fi","Drama"].
  - years (number[], optional): Filter by production year(s).
  - is_played (boolean, optional): If set, return only played (true) or unplayed (false) items.
  - is_favorite (boolean, optional): If set, return only favorites (true) or non-favorites (false).
  - is_hd (boolean, optional): If set, return only HD (true) or non-HD (false) items.
  - is_4k (boolean, optional): If set, return only 4K (true) or non-4K (false) items.
  - is_3d (boolean, optional): If set, return only 3D (true) or non-3D (false) items.
  - is_missing (boolean, optional): If set, return only items whose underlying file is missing (true) or present (false).
  - min_community_rating (number, optional): Minimum community rating (0-10).
  - max_community_rating (number, optional): Maximum community rating (0-10).
  - min_critic_rating (number, optional): Minimum critic rating (0-100).
  - official_ratings (string[], optional): Filter by content rating(s), e.g. ["G","PG","PG-13"].
  - tags (string[], optional): Filter by tag(s) attached to items.
  - person_names (string[], optional): Filter by person name(s), e.g. ["Liam Neeson"]. Names resolved internally.
  - person_ids (string[], optional): Filter by Emby person ID(s). For pre-resolved IDs; usually you'll use person_names instead.
  - studio_names (string[], optional): Filter by studio name(s), e.g. ["Pixar"]. Names resolved internally.
  - studio_ids (string[], optional): Filter by Emby studio ID(s). For pre-resolved IDs.
  - parent_id (string, optional): Scope search to a specific library or folder ID.
  - has_overview (boolean, optional): Items with (true) or without (false) an overview.
  - has_theme_song (boolean, optional): Items with (true) or without (false) a theme song.
  - has_imdb_id (boolean, optional): Items with (true) or without (false) an IMDb ID.
  - has_tmdb_id (boolean, optional): Items with (true) or without (false) a TMDb ID.
  - sort_by (string, optional): Sort field. Common: SortName, DateCreated, PremiereDate, CommunityRating, Random.
  - limit (number): Max results 1-100, default 25.
  - offset (number): Skip N results for pagination.
  - response_format ("markdown" | "json"): Output shape, default "markdown".

Returns (json):
  {
    total: number,        // Total matching items in the library
    count: number,        // Items in this page
    offset: number,
    items: EmbyItem[],    // Each has at minimum {Id, Name, Type}
    has_more: boolean,
    next_offset?: number
  }

Examples:
  - "find all unwatched sci-fi movies" -> item_types=["Movie"], genres=["Sci-Fi"], is_played=false
  - "list episodes of Breaking Bad" -> query="Breaking Bad", item_types=["Episode"]
  - "show my favorites" -> is_favorite=true
  - "unwatched 4K action films, top rated" -> item_types=["Movie"], genres=["Action"], is_played=false, is_4k=true, sort_by="CommunityRating"
  - "movies missing IMDb IDs" -> item_types=["Movie"], has_imdb_id=false
  - "Liam Neeson movies" -> item_types=["Movie"], person_names=["Liam Neeson"]
  - "Pixar films I haven't watched" -> studio_names=["Pixar"], is_played=false`,
      inputSchema: {
        query: z.string().max(200).optional().describe("Title search string."),
        item_types: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe("Filter by item type(s) like Movie, Series, Episode."),
        genres: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe("Filter by genre name(s)."),
        years: z
          .array(z.number().int().min(1800).max(2100))
          .max(50)
          .optional()
          .describe("Filter by production year(s)."),
        is_played: z.boolean().optional().describe("Filter by played/unplayed."),
        is_favorite: z.boolean().optional().describe("Filter by favorite flag."),
        is_hd: z.boolean().optional().describe("Filter to HD items only."),
        is_4k: z.boolean().optional().describe("Filter to 4K items only."),
        is_3d: z.boolean().optional().describe("Filter to 3D items only."),
        is_missing: z
          .boolean()
          .optional()
          .describe("Filter by missing-file state."),
        min_community_rating: z
          .number()
          .min(0)
          .max(10)
          .optional()
          .describe("Minimum community rating (0-10)."),
        max_community_rating: z
          .number()
          .min(0)
          .max(10)
          .optional()
          .describe("Maximum community rating (0-10)."),
        min_critic_rating: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Minimum critic rating (0-100)."),
        official_ratings: z
          .array(z.string().min(1).max(20))
          .max(20)
          .optional()
          .describe("Filter by official content rating(s), e.g. [\"G\",\"PG\"]."),
        tags: z
          .array(z.string().min(1).max(100))
          .max(20)
          .optional()
          .describe("Filter by tag(s)."),
        person_names: z
          .array(z.string().min(1).max(100))
          .max(10)
          .optional()
          .describe(
            "Filter by person name(s) like [\"Liam Neeson\",\"Maggie Grace\"]. " +
              "Names are resolved to person IDs internally — pass plain human-readable names. " +
              "Exact name matches are preferred; unresolved names are dropped with a note.",
          ),
        person_ids: z
          .array(z.string().min(1).max(64))
          .max(20)
          .optional()
          .describe(
            "Filter by Emby person ID(s). Use person_names if you only have names; this is for already-resolved IDs.",
          ),
        studio_names: z
          .array(z.string().min(1).max(100))
          .max(10)
          .optional()
          .describe(
            "Filter by studio name(s) like [\"Pixar\",\"A24\"]. Resolved to IDs internally (exact match preferred).",
          ),
        studio_ids: z
          .array(z.string().min(1).max(64))
          .max(20)
          .optional()
          .describe(
            "Filter by Emby studio ID(s). Use studio_names if you only have names.",
          ),
        parent_id: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe("Scope search to a specific library/folder ID."),
        has_overview: z
          .boolean()
          .optional()
          .describe("Filter by presence/absence of overview text."),
        has_theme_song: z
          .boolean()
          .optional()
          .describe("Filter by presence/absence of a theme song."),
        has_imdb_id: z
          .boolean()
          .optional()
          .describe("Filter by presence/absence of an IMDb ID."),
        has_tmdb_id: z
          .boolean()
          .optional()
          .describe("Filter by presence/absence of a TMDb ID."),
        sort_by: z
          .string()
          .max(50)
          .optional()
          .describe("Sort field, e.g. SortName, DateCreated, CommunityRating."),
        ...PaginationShape,
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
      // /Items requires a UserId for proper user-context filtering (played/favorite
      // flags are per-user). Falls back to /Items without UserId for API-key auth.
      const path = auth.userId ? `Users/${auth.userId}/Items` : "Items";

      // Resolve any name-based filters to IDs first. This is hidden inside
      // the tool because small models struggle to chain a resolver tool call
      // followed by a search call reliably — much better to do it server-side.
      const unresolved: string[] = [];
      let personIds: string[] | undefined = params.person_ids;
      if (params.person_names?.length) {
        const r = await resolveNamesToIds(
          config,
          auth,
          "Persons",
          params.person_names,
        );
        personIds = [...(personIds ?? []), ...r.ids];
        for (const n of r.unresolved) unresolved.push(`person:${n}`);
      }
      let studioIds: string[] | undefined = params.studio_ids;
      if (params.studio_names?.length) {
        const r = await resolveNamesToIds(
          config,
          auth,
          "Studios",
          params.studio_names,
        );
        studioIds = [...(studioIds ?? []), ...r.ids];
        for (const n of r.unresolved) unresolved.push(`studio:${n}`);
      }

      // If the caller asked for a name filter and *every* requested name was
      // unresolved, we'd otherwise do an unfiltered library-wide search.
      // Short-circuit: if all name inputs failed to resolve, return empty.
      const allNamesUnresolved =
        ((params.person_names?.length ?? 0) > 0 &&
          (personIds?.length ?? 0) === 0) ||
        ((params.studio_names?.length ?? 0) > 0 &&
          (studioIds?.length ?? 0) === 0);

      const data = allNamesUnresolved
        ? ({ Items: [], TotalRecordCount: 0 } as EmbyItemsResponse)
        : await embyRequest<EmbyItemsResponse>(config, auth, {
            path,
            query: {
              SearchTerm: params.query,
              IncludeItemTypes: params.item_types,
              Genres: params.genres,
              Years: params.years?.map(String),
              IsPlayed: params.is_played,
              IsFavorite: params.is_favorite,
              IsHd: params.is_hd,
              Is4K: params.is_4k,
              Is3D: params.is_3d,
              IsMissing: params.is_missing,
              MinCommunityRating: params.min_community_rating,
              MaxCommunityRating: params.max_community_rating,
              MinCriticRating: params.min_critic_rating,
              OfficialRatings: params.official_ratings,
              Tags: params.tags,
              PersonIds: personIds,
              StudioIds: studioIds,
              ParentId: params.parent_id,
              HasOverview: params.has_overview,
              HasThemeSong: params.has_theme_song,
              HasImdbId: params.has_imdb_id,
              HasTmdbId: params.has_tmdb_id,
              SortBy: params.sort_by ?? "SortName",
              Recursive: true,
              Limit: params.limit,
              StartIndex: params.offset,
              // Trim the response to only fields we actually use.
              Fields: "Genres,Tags,Overview,ProviderIds,UserData,Path,RunTimeTicks,DateCreated,PremiereDate",
            },
          });

      const items = data?.Items ?? [];
      const total = data?.TotalRecordCount ?? 0;
      const hasMore = total > params.offset + items.length;

      // Build a small advisory note for unresolved names so the LLM can tell
      // the user "I couldn't find X in your library" rather than silently
      // returning empty/wrong results.
      const unresolvedNote =
        unresolved.length > 0
          ? `Unresolved names (no library match): ${unresolved.join(", ")}`
          : null;

      if (items.length === 0) {
        if (params.response_format === "json") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    total: 0,
                    count: 0,
                    offset: params.offset,
                    items: [],
                    has_more: false,
                    ...(unresolved.length > 0 ? { unresolved } : {}),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        const text = unresolvedNote
          ? `No items matched those filters. ${unresolvedNote}.`
          : "No items matched those filters.";
        return { content: [{ type: "text", text }] };
      }

      if (params.response_format === "json") {
        const json = {
          total,
          count: items.length,
          offset: params.offset,
          items: items.map(slimItem),
          has_more: hasMore,
          ...(hasMore ? { next_offset: params.offset + items.length } : {}),
          ...(unresolved.length > 0 ? { unresolved } : {}),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
        };
      }

      const lines = items.map(
        (it, i) => `${params.offset + i + 1}. ${itemToMarkdown(it)}`,
      );
      const header = `Found ${total} item${total === 1 ? "" : "s"} (showing ${items.length}):`;
      const noteLine = unresolvedNote ? `\n\n_${unresolvedNote}._` : "";
      const footer = hasMore
        ? `\n\n…${total - params.offset - items.length} more available. Use offset=${params.offset + items.length} to continue.`
        : "";
      const body = `${header}${noteLine}\n\n${lines.join("\n")}${footer}`;
      return {
        content: [
          {
            type: "text",
            text: truncateForResponse(
              body,
              "narrow your search with item_types, genres, or a more specific query.",
            ),
          },
        ],
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // emby_get_item
  // ─────────────────────────────────────────────────────────────────────
  server.registerTool(
    "emby_get_item",
    {
      title: "Get Emby Item Details",
      description: `Retrieve full metadata for a single library item by ID.

Use this after emby_search_items to inspect an item in detail before mutating it.

Args:
  - item_id (string, required): The item's Emby ID.
  - response_format ("markdown" | "json"): Output shape, default "markdown".

Returns: A single EmbyItem object with all metadata fields populated.

Examples:
  - "show me everything about this movie" -> emby_search_items first, then emby_get_item with the ID.`,
      inputSchema: {
        item_id: ItemIdSchema,
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
      const path = auth.userId
        ? `Users/${auth.userId}/Items/${encodeURIComponent(params.item_id)}`
        : `Items/${encodeURIComponent(params.item_id)}`;
      const item = await embyRequest<EmbyItem>(config, auth, { path });
      if (!item) {
        return {
          content: [
            {
              type: "text",
              text: `No item found with ID '${params.item_id}'. Verify with emby_search_items.`,
            },
          ],
          isError: true,
        };
      }
      if (params.response_format === "json") {
        return {
          content: [
            { type: "text", text: JSON.stringify(slimItem(item), null, 2) },
          ],
        };
      }
      return {
        content: [{ type: "text", text: itemToDetailedMarkdown(item) }],
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // emby_mark_played
  // ─────────────────────────────────────────────────────────────────────
  server.registerTool(
    "emby_mark_played",
    {
      title: "Mark Emby Item as Played/Unplayed",
      description: `Toggle the played status of an item for the authenticated user.

Args:
  - item_id (string, required): Emby item ID.
  - played (boolean, required): true to mark as played, false to mark unplayed.

Returns: A confirmation message including the new played state.

Note: Requires user-context auth (EMBY_USERNAME/EMBY_PASSWORD). API-key auth
will return an error explaining the limitation.

Examples:
  - "mark Inception as watched" -> search first, then mark_played(item_id, played=true)`,
      inputSchema: {
        item_id: ItemIdSchema,
        played: z
          .boolean()
          .describe("true = mark as played; false = mark as unplayed."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      const userId = requireUserId(auth);
      const path = `Users/${userId}/PlayedItems/${encodeURIComponent(params.item_id)}`;
      await embyRequest(config, auth, {
        method: params.played ? "POST" : "DELETE",
        path,
      });
      return {
        content: [
          {
            type: "text",
            text: `Marked item ${params.item_id} as ${params.played ? "played" : "unplayed"}.`,
          },
        ],
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // emby_set_rating
  // ─────────────────────────────────────────────────────────────────────
  server.registerTool(
    "emby_set_rating",
    {
      title: "Set Emby Item Rating and/or Favorite",
      description: `Set personal rating (1-10) and/or favorite flag for an item.

At least one of \`rating\` or \`is_favorite\` must be provided. Both can be set in one call.

Args:
  - item_id (string, required): Emby item ID.
  - rating (number, optional): Personal rating 0-10. Pass 0 to clear an existing rating.
  - is_favorite (boolean, optional): Favorite flag.

Returns: A confirmation message describing what was changed.

Note: Requires user-context auth.`,
      inputSchema: {
        item_id: ItemIdSchema,
        rating: z
          .number()
          .min(0)
          .max(10)
          .optional()
          .describe("Personal rating 0-10. 0 clears the rating."),
        is_favorite: z
          .boolean()
          .optional()
          .describe("Favorite flag — true to mark, false to unmark."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      if (params.rating === undefined && params.is_favorite === undefined) {
        return {
          content: [
            {
              type: "text",
              text: "Nothing to change: provide at least one of `rating` or `is_favorite`.",
            },
          ],
          isError: true,
        };
      }
      const userId = requireUserId(auth);
      const changes: string[] = [];

      if (params.is_favorite !== undefined) {
        const path = `Users/${userId}/FavoriteItems/${encodeURIComponent(params.item_id)}`;
        await embyRequest(config, auth, {
          method: params.is_favorite ? "POST" : "DELETE",
          path,
        });
        changes.push(`favorite=${params.is_favorite}`);
      }

      if (params.rating !== undefined) {
        // The /UserData endpoint accepts a partial UserData object.
        const path = `Users/${userId}/Items/${encodeURIComponent(params.item_id)}/UserData`;
        await embyRequest(config, auth, {
          method: "POST",
          path,
          body: { Rating: params.rating },
        });
        changes.push(`rating=${params.rating}`);
      }

      return {
        content: [
          {
            type: "text",
            text: `Updated item ${params.item_id}: ${changes.join(", ")}.`,
          },
        ],
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // emby_update_item_metadata
  // ─────────────────────────────────────────────────────────────────────
  server.registerTool(
    "emby_update_item_metadata",
    {
      title: "Update Emby Item Metadata",
      description: `Patch metadata fields on a library item (server-wide change, affects all users).

Only the fields you provide are changed; everything else is preserved by
fetching the current item, merging your changes in, and POSTing the result.

Args:
  - item_id (string, required): Emby item ID.
  - name (string, optional): New title.
  - overview (string, optional): New plot/description.
  - genres (string[], optional): Replace genre list entirely.
  - tags (string[], optional): Replace tag list entirely.
  - official_rating (string, optional): Content rating, e.g. "PG-13", "TV-MA".
  - production_year (number, optional): Year.

Returns: A confirmation listing the changed fields.

Warning: This modifies metadata for ALL users on the server, not just yours.
Genre and tag arrays REPLACE existing values rather than appending.`,
      inputSchema: {
        item_id: ItemIdSchema,
        name: z.string().min(1).max(500).optional(),
        overview: z.string().max(10_000).optional(),
        genres: z.array(z.string().min(1).max(100)).max(50).optional(),
        tags: z.array(z.string().min(1).max(100)).max(100).optional(),
        official_rating: z.string().min(1).max(20).optional(),
        production_year: z.number().int().min(1800).max(2100).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      const changes: Record<string, unknown> = {};
      if (params.name !== undefined) changes.Name = params.name;
      if (params.overview !== undefined) changes.Overview = params.overview;
      if (params.genres !== undefined) changes.Genres = params.genres;
      if (params.tags !== undefined) changes.Tags = params.tags;
      if (params.official_rating !== undefined) changes.OfficialRating = params.official_rating;
      if (params.production_year !== undefined) changes.ProductionYear = params.production_year;

      if (Object.keys(changes).length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No fields provided — nothing to update.",
            },
          ],
          isError: true,
        };
      }

      // Emby requires the FULL item on POST /Items/{id}; otherwise omitted
      // fields get cleared. So we GET, merge, POST.
      const fetchPath = auth.userId
        ? `Users/${auth.userId}/Items/${encodeURIComponent(params.item_id)}`
        : `Items/${encodeURIComponent(params.item_id)}`;
      const current = await embyRequest<EmbyItem & Record<string, unknown>>(
        config,
        auth,
        { path: fetchPath },
      );
      const merged = { ...current, ...changes };
      await embyRequest(config, auth, {
        method: "POST",
        path: `Items/${encodeURIComponent(params.item_id)}`,
        body: merged,
      });

      return {
        content: [
          {
            type: "text",
            text: `Updated item ${params.item_id}: ${Object.keys(changes).join(", ")}.`,
          },
        ],
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // emby_refresh_item
  // ─────────────────────────────────────────────────────────────────────
  server.registerTool(
    "emby_refresh_item",
    {
      title: "Refresh Emby Item Metadata",
      description: `Trigger a metadata refresh from external providers (TMDB, TVDB, etc.).

This is asynchronous — the call returns immediately and the refresh runs in
the background. Check progress by re-fetching the item later.

Args:
  - item_id (string, required): Emby item ID.
  - mode ("default" | "full" | "missing", optional): How aggressively to refresh.
    Default keeps existing data, "full" re-downloads everything,
    "missing" only fills in absent fields. Default: "default".
  - replace_images (boolean, optional): Whether to redownload artwork. Default: false.

Returns: Confirmation that the refresh was triggered.`,
      inputSchema: {
        item_id: ItemIdSchema,
        mode: z
          .enum(["default", "full", "missing"])
          .default("default")
          .describe("Refresh aggressiveness."),
        replace_images: z
          .boolean()
          .default(false)
          .describe("Redownload images from providers."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      // Map our friendly modes to Emby's MetadataRefreshMode enum values.
      const metadataMode =
        params.mode === "full"
          ? "FullRefresh"
          : params.mode === "missing"
          ? "Default"
          : "ValidationOnly";
      const replaceMetadata = params.mode === "full";

      await embyRequest(config, auth, {
        method: "POST",
        path: `Items/${encodeURIComponent(params.item_id)}/Refresh`,
        query: {
          Recursive: true,
          MetadataRefreshMode: metadataMode,
          ImageRefreshMode: params.replace_images ? "FullRefresh" : "Default",
          ReplaceAllMetadata: replaceMetadata,
          ReplaceAllImages: params.replace_images,
        },
      });
      return {
        content: [
          {
            type: "text",
            text: `Refresh triggered for item ${params.item_id} (mode: ${params.mode}, replace_images: ${params.replace_images}). The refresh runs asynchronously.`,
          },
        ],
      };
    },
  );
}
