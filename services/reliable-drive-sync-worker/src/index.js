import { ProtocolError } from "./protocol.js";
import { dispatchSubmitEvent } from "./submit-event.js";

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18"
]);

const tools = [{
  name: "submit_event",
  description: "Submit a validated system, interview, algorithm or resume-knowledge event. The caller supplies a display name; the Worker resolves or registers the stable userId.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "namespace", "eventType", "requestId"],
    properties: {
      schemaVersion: { type: "string" },
      namespace: { type: "string" },
      eventType: { type: "string" },
      // userId is optional: the Worker resolves it from the display name and
      // only rejects the call when a supplied userId contradicts the registry.
      identity: {
        type: "object",
        additionalProperties: false,
        required: ["username"],
        properties: { userId: { type: "string" }, username: { type: "string" } }
      },
      // Event payloads are deliberately open at the MCP description layer.
      // The Worker applies the event-type-specific schema before dispatching.
      payload: { type: "object" },
      requestId: { type: "string" }
    }
  },
  annotations: {
    title: "Submit Reliable Drive Sync event",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  }
}];

const result = (id, value) => Response.json({ jsonrpc: "2.0", id, result: value });
const error = (id, code, message) => Response.json({ jsonrpc: "2.0", id, error: { code, message } });

function negotiatedProtocolVersion(message) {
  const requested = message?.params?.protocolVersion;
  return SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
}

function responseProtocolVersion(request, message) {
  const headerVersion = request.headers.get("mcp-protocol-version");
  return SUPPORTED_PROTOCOL_VERSIONS.has(headerVersion)
    ? headerVersion
    : negotiatedProtocolVersion(message);
}

async function handleMessage(message, env, deps = {}) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return error(message?.id ?? null, -32600, "Invalid request");
  }
  if (message.method === "notifications/initialized") return null;
  if (message.method === "initialize") {
    return result(message.id, {
      protocolVersion: negotiatedProtocolVersion(message),
      capabilities: { tools: {} },
      serverInfo: { name: "reliable-drive-sync", version: "2.1.0" },
      instructions: "Use submit_event as the only persistence and profile gateway. Supply the user's display name; never invent a userId."
    });
  }
  if (message.method === "ping") return result(message.id, {});
  if (message.method === "tools/list") return result(message.id, { tools });
  if (message.method !== "tools/call") return error(message.id, -32601, "Method not found");
  if (message.params?.name !== "submit_event") {
    return error(message.id, -32601, "Tool not implemented");
  }
  try {
    const args = message.params?.arguments ?? {};
    const value = await dispatchSubmitEvent(env, args, deps);
    return result(message.id, {
      content: [{ type: "text", text: JSON.stringify(value) }]
    });
  } catch (cause) {
    if (cause instanceof ProtocolError) return error(message.id, -32602, cause.message);
    return error(message.id, -32603, cause instanceof Error ? cause.message : String(cause));
  }
}

async function parseMessage(request) {
  try {
    return { message: await request.json() };
  } catch {
    return { response: error(null, -32700, "Parse error") };
  }
}

export async function handleRequest(request, env, deps = {}) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (typeof env?.MCP_BEARER_TOKEN !== "string" || !env.MCP_BEARER_TOKEN.trim()
    || request.headers.get("authorization") !== `Bearer ${env.MCP_BEARER_TOKEN}`) return new Response("Unauthorized", { status: 401 });
  const parsed = await parseMessage(request);
  if (parsed.response) return parsed.response;
  const response = await handleMessage(parsed.message, env, deps);
  return response ?? new Response(null, { status: 202 });
}

function remoteMcpPath(env) {
  const token = env?.MCP_URL_TOKEN;
  if (typeof token !== "string" || token.length < 32 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  return `/mcp/${token}`;
}

export async function handleRemoteRequest(request, env, deps = {}) {
  const configuredPath = remoteMcpPath(env);
  if (!configuredPath || new URL(request.url).pathname !== configuredPath) {
    return new Response("Not Found", { status: 404 });
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  const parsed = await parseMessage(request);
  if (parsed.response) return parsed.response;
  const response = await handleMessage(parsed.message, env, deps);
  if (!response) return new Response(null, { status: 202 });
  response.headers.set("cache-control", "no-store");
  response.headers.set("mcp-protocol-version", responseProtocolVersion(request, parsed.message));
  return response;
}

export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/mcp/")) return handleRemoteRequest(request, env);
    return handleRequest(request, env);
  }
};
