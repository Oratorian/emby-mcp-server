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
 * Shared Zod schemas. Centralised so every tool exposes pagination and
 * response_format with identical semantics — important for the LLM,
 * which generalises behaviour across tools.
 */

import { z } from "zod";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../constants.js";

/** "markdown" or "json" — which output shape the tool should return. */
export const ResponseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe(
    "Output format. 'markdown' is human-readable and compact; 'json' is " +
      "structured for programmatic processing or chained tool calls.",
  );

export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

/** Standard limit/offset pagination, identical across all list tools. */
export const PaginationShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(
      `Maximum results to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Number of results to skip — pair with `limit` for pagination."),
};

/** Emby item ID — a hex string like "ba8a30b6c0d4f7d1e92dec99a14e7be4". */
export const ItemIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/, "item_id must be alphanumeric (hex form Emby uses)")
  .describe(
    "Emby item ID. Get this from `emby_search_items` — IDs are not human-readable.",
  );
