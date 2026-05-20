/**
 * Scheduled task tools — list, inspect, start, stop.
 *
 * Tasks have three identifiers in Emby:
 *   - Id        : Internal GUID, changes between server installs.
 *   - Key       : Stable string ID (e.g. "RefreshLibrary"), shared across installs.
 *   - Name      : Human-readable display name (localized, can change).
 *
 * For starting tasks we accept either the Key or one of the friendly aliases
 * defined in constants.ts (KNOWN_TASK_ALIASES). The aliases give the LLM a
 * predictable enum to work with without forcing the user to memorise Emby's
 * internal Key strings.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  KNOWN_TASK_ALIASES,
  type KnownTaskAlias,
} from "../constants.js";
import {
  embyRequest,
  type EmbyConfig,
  type ResolvedAuth,
} from "../services/client.js";
import {
  slimTask,
  taskToDetailedMarkdown,
  taskToMarkdown,
  truncateForResponse,
} from "../services/format.js";
import { ResponseFormatSchema } from "../schemas/common.js";
import type { EmbyScheduledTask } from "../types.js";

/**
 * Resolves a task identifier (alias, Key, Id, or display Name) to an Emby
 * task. Strategy:
 *   1. If it matches a known alias, translate to that Key.
 *   2. Fetch all tasks once, then match against Id, Key, or Name (case-insensitive).
 * The double-pass is cheap (Emby returns ~30 tasks total) and tolerant.
 */
async function resolveTask(
  config: EmbyConfig,
  auth: ResolvedAuth,
  identifier: string,
): Promise<EmbyScheduledTask> {
  const aliasKey = KNOWN_TASK_ALIASES[identifier as KnownTaskAlias];
  const target = aliasKey ?? identifier;

  const tasks = await embyRequest<EmbyScheduledTask[]>(config, auth, {
    path: "ScheduledTasks",
  });
  if (!tasks?.length) {
    throw new Error("Emby returned no scheduled tasks — server may be misconfigured.");
  }

  const lc = target.toLowerCase();
  const found = tasks.find((t) => {
    // Defensive: Key may be missing (e.g. built-in "Rotate log file" task).
    if (t.Key === target) return true;
    if (t.Id === target) return true;
    if (t.Key && t.Key.toLowerCase() === lc) return true;
    if (t.Name.toLowerCase() === lc) return true;
    return false;
  });
  if (!found) {
    const sample = tasks
      .slice(0, 5)
      .map((t) => `${t.Name} (Key=${t.Key ?? "<none>"})`)
      .join(", ");
    throw new Error(
      `No scheduled task matches '${identifier}'. ` +
        `Try emby_list_scheduled_tasks to see available tasks. ` +
        `Examples: ${sample}…`,
    );
  }
  return found;
}

export function registerTaskTools(
  server: McpServer,
  config: EmbyConfig,
  auth: ResolvedAuth,
): void {
  // ─────────────────────────────────────────────────────────────────────
  // emby_list_scheduled_tasks
  // ─────────────────────────────────────────────────────────────────────
  server.registerTool(
    "emby_list_scheduled_tasks",
    {
      title: "List Emby Scheduled Tasks",
      description: `List all scheduled tasks on the Emby server with their current state.

Use this to find a task's Key or Id before starting/stopping it, or to check
which tasks are currently running.

Args:
  - is_running (boolean, optional): If true, return only tasks currently running.
  - response_format ("markdown" | "json"): Output shape, default "markdown".

Returns:
  json: array of {Id, Key, Name, State, Category, LastExecutionResult, …}
  markdown: bulleted list with state, key, last run summary.

Examples:
  - "is the library scan running?" -> emby_list_scheduled_tasks(is_running=true)
  - "what tasks are available?" -> emby_list_scheduled_tasks() with default args`,
      inputSchema: {
        is_running: z
          .boolean()
          .optional()
          .describe("If true, filter to only tasks in 'Running' state."),
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
      const tasks = await embyRequest<EmbyScheduledTask[]>(config, auth, {
        path: "ScheduledTasks",
      });
      let filtered = tasks ?? [];
      if (params.is_running) {
        filtered = filtered.filter((t) => t.State === "Running");
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
              text: params.is_running
                ? "No scheduled tasks are currently running."
                : "No scheduled tasks found.",
            },
          ],
        };
      }

      if (params.response_format === "json") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(filtered.map(slimTask), null, 2),
            },
          ],
        };
      }

      const lines = filtered.map((t, i) => `${i + 1}. ${taskToMarkdown(t)}`);
      const body = `${filtered.length} scheduled task${filtered.length === 1 ? "" : "s"}:\n\n${lines.join("\n")}`;
      return {
        content: [
          {
            type: "text",
            text: truncateForResponse(
              body,
              "request response_format='json' for the full structured list.",
            ),
          },
        ],
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // emby_get_scheduled_task
  // ─────────────────────────────────────────────────────────────────────
  server.registerTool(
    "emby_get_scheduled_task",
    {
      title: "Get Emby Scheduled Task Details",
      description: `Fetch detailed info for a single scheduled task.

The \`identifier\` param accepts any of:
  - A friendly alias (see emby_start_scheduled_task for the alias list)
  - The task's Key (e.g. "RefreshLibrary")
  - The task's Id (GUID)
  - The task's display Name

Returns: Task with description, triggers, last execution result, and progress
(if running).`,
      inputSchema: {
        identifier: z
          .string()
          .min(1)
          .max(200)
          .describe("Alias, Key, Id, or Name of the task."),
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
      const task = await resolveTask(config, auth, params.identifier);
      if (params.response_format === "json") {
        return {
          content: [
            { type: "text", text: JSON.stringify(slimTask(task), null, 2) },
          ],
        };
      }
      return {
        content: [{ type: "text", text: taskToDetailedMarkdown(task) }],
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // emby_start_scheduled_task
  // ─────────────────────────────────────────────────────────────────────
  const aliasKeys = Object.keys(KNOWN_TASK_ALIASES) as KnownTaskAlias[];
  const aliasDoc = aliasKeys
    .map((k) => `${k} -> ${KNOWN_TASK_ALIASES[k]}`)
    .join(", ");

  server.registerTool(
    "emby_start_scheduled_task",
    {
      title: "Start Emby Scheduled Task",
      description: `Start a scheduled task immediately.

The task identifier can be:
  - A built-in alias for common tasks (preferred for clarity)
  - The task's Key (e.g. "RefreshLibrary")
  - The task's Id

Built-in aliases:
  ${aliasDoc}

The call returns immediately; the task runs asynchronously in the background.
Poll emby_get_scheduled_task to check progress.

Args:
  - identifier (string, required): Alias, Key, or Id of the task.

Returns: Confirmation of the started task with its Name and Key.

Examples:
  - "scan my library" -> emby_start_scheduled_task(identifier="scan_library")
  - "clean the cache" -> emby_start_scheduled_task(identifier="cleanup_cache")`,
      inputSchema: {
        identifier: z
          .string()
          .min(1)
          .max(200)
          .describe(
            `Task alias, Key, or Id. Aliases include: ${aliasKeys.join(", ")}.`,
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
      const task = await resolveTask(config, auth, params.identifier);
      if (task.State === "Running") {
        return {
          content: [
            {
              type: "text",
              text: `Task '${task.Name}' is already running (${task.CurrentProgressPercentage?.toFixed(0) ?? "?"}% complete).`,
            },
          ],
        };
      }
      // Start by Id — the most reliable identifier server-side.
      await embyRequest(config, auth, {
        method: "POST",
        path: `ScheduledTasks/Running/${encodeURIComponent(task.Id)}`,
      });
      return {
        content: [
          {
            type: "text",
            text: `Started task '${task.Name}' (Key=${task.Key ?? "<none>"}). Use emby_get_scheduled_task to monitor progress.`,
          },
        ],
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // emby_stop_scheduled_task
  // ─────────────────────────────────────────────────────────────────────
  server.registerTool(
    "emby_stop_scheduled_task",
    {
      title: "Stop Emby Scheduled Task",
      description: `Cancel a running scheduled task.

If the task isn't running, the call is a no-op and returns a friendly notice.

Args:
  - identifier (string, required): Alias, Key, or Id of the task.

Returns: Confirmation of cancellation, or a notice that the task wasn't running.`,
      inputSchema: {
        identifier: z
          .string()
          .min(1)
          .max(200)
          .describe("Task alias, Key, or Id."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      const task = await resolveTask(config, auth, params.identifier);
      if (task.State !== "Running") {
        return {
          content: [
            {
              type: "text",
              text: `Task '${task.Name}' is not running (state: ${task.State}). Nothing to stop.`,
            },
          ],
        };
      }
      await embyRequest(config, auth, {
        method: "DELETE",
        path: `ScheduledTasks/Running/${encodeURIComponent(task.Id)}`,
      });
      return {
        content: [
          {
            type: "text",
            text: `Cancelled task '${task.Name}' (Key=${task.Key ?? "<none>"}).`,
          },
        ],
      };
    },
  );
}
