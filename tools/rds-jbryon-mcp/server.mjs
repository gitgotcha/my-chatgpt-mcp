#!/usr/bin/env node
// Minimal stdio MCP server for RDS-JBryon (design §7).
//
// One tool, `rds`, one connection credential. No account registration, no
// username resolution: the token authenticates the single owner.
//
// Environment:
//   RDS_URL        e.g. https://rds.example.workers.dev
//   RDS_TOKEN      the service connection token (never logged)
//   RDS_OUTBOX     optional SQLite path (default LOCALAPPDATA/ReliableDriveSync/rds-jbryon-outbox.sqlite)
import readline from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRdsClient, LocalOutbox } from "./outbox.mjs";
import { createRdsService, createToolHandler } from "./service.mjs";

export const TOOL = {
  name: "rds",
  description: "RDS-JBryon single-user directory and snapshot storage: submit a durable write request or read the authoritative state.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["request", "query", "status", "admin"] },
      request: { type: "object" },
      operation: { type: "string" },
      params: { type: "object" },
      requestId: { type: "string" }
    },
    required: ["kind"]
  }
};

function defaultOutboxPath() {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
  return process.env.RDS_OUTBOX ?? join(base, "ReliableDriveSync", "rds-jbryon-outbox.sqlite");
}

export function createServer({ service }) {
  const handle = createToolHandler(service);
  const reply = (id, result) => ({ jsonrpc: "2.0", id, result });
  const failure = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  async function onRequest(request) {
    if (!request || typeof request !== "object") return failure(null, -32600, "Invalid Request");
    const { id, method, params } = request;
    if (method === "initialize") {
      return reply(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "rds-jbryon", version: "1.0.0" }
      });
    }
    if (method === "tools/list") return reply(id, { tools: [TOOL] });
    if (method === "tools/call") {
      if (params?.name !== TOOL.name) return failure(id, -32602, "unknown_tool");
      const result = await handle(params.arguments ?? {});
      return reply(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result
      });
    }
    if (method?.startsWith("notifications/")) return null;
    return failure(id, -32601, "method_not_found");
  }

  return { onRequest };
}

async function main() {
  const url = process.env.RDS_URL;
  const token = process.env.RDS_TOKEN;
  if (!url || !token) {
    process.stderr.write("RDS_URL and RDS_TOKEN are required\n");
    process.exitCode = 2;
    return;
  }
  const outbox = new LocalOutbox({ path: defaultOutboxPath(), owner: `rds-jbryon-${process.pid}` });
  const service = createRdsService({ outbox, client: createRdsClient({ baseUrl: url, token }) });
  const stop = service.startAutoSend({ intervalMs: 30_000 });
  const server = createServer({ service });
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let response;
    try {
      response = await server.onRequest(JSON.parse(line));
    } catch (error) {
      response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse_error" } };
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
  rl.on("close", () => {
    stop();
    service.close();
  });
}

// Windows-safe entry check: compare canonical file URLs, never string-built
// paths (C:\... vs file:///C:/... never match).
const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entryUrl && entryUrl === import.meta.url) {
  await main();
}
