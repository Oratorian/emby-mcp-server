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
