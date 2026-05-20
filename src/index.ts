#!/usr/bin/env node
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
 * Emby MCP server — stdio entry point.
 *
 * Lifecycle:
 *   1. Load config from env vars (EMBY_SERVER_URL + auth credentials).
 *   2. Authenticate once (API key is instant; username/password hits Emby).
 *   3. Register all tools with the resolved auth in closure scope.
 *   4. Connect stdio transport and run.
 *
 * Logging: stdio transport reserves stdout for protocol traffic. ALL log
 * output goes to stderr — silence on stdout is critical.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CLIENT_VERSION } from "./constants.js";
import {
  authenticate,
  loadConfigFromEnv,
} from "./services/client.js";
import { registerLibraryTools } from "./tools/library.js";
import { registerSessionTools } from "./tools/sessions.js";
import { registerTaskTools } from "./tools/tasks.js";

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const auth = await authenticate(config);
  console.error(
    `[emby-mcp-server] Authenticated to ${config.baseUrl} via ${auth.source}` +
      (auth.userId ? ` (UserId=${auth.userId})` : ""),
  );

  const server = new McpServer({
    name: "emby-mcp-server",
    version: CLIENT_VERSION,
  });

  registerLibraryTools(server, config, auth);
  registerTaskTools(server, config, auth);
  registerSessionTools(server, config, auth);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[emby-mcp-server] Ready on stdio.");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[emby-mcp-server] Fatal: ${message}`);
  process.exit(1);
});
