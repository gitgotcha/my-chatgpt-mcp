import readline from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { DeliveryService } from "./delivery-service.mjs";
import { LocalOutbox } from "./local-outbox.mjs";

const TOOL = {
  name: "submit_event",
  description: "Durably queue a validated system, interview, algorithm or resume-knowledge event in the local SQLite Outbox before cloud delivery.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "namespace", "eventType", "requestId"],
    properties: {
      schemaVersion: { type: "string" },
      namespace: { type: "string" },
      eventType: { type: "string" },
      identity: {
        type: "object",
        additionalProperties: false,
        required: ["username"],
        properties: {
          userId: { type: "string" },
          username: { type: "string" }
        }
      },
      payload: { type: "object" },
      requestId: { type: "string" }
    }
  }
};

export function deriveWorkerUrl(configuredUrl) {
  const url = new URL(configuredUrl);
  return url.origin;
}

const reply = (id, result) => ({ jsonrpc: "2.0", id, result });
const failure = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

function defaultOutboxPath() {
  const base = process.env.LOCALAPPDATA
    ?? process.env.XDG_DATA_HOME
    ?? join(homedir(), ".local", "share");
  return join(base, "ReliableDriveSync", "outbox.sqlite");
}

function createService(options) {
  if (!options.workerUrl || !options.token) throw new Error("Bridge configuration is incomplete");
  try {
    deriveWorkerUrl(options.workerUrl);
  } catch {
    throw new Error("Bridge Worker URL is invalid");
  }
  const outbox = options.outbox ?? new LocalOutbox(options.outboxPath ?? defaultOutboxPath());
  return new DeliveryService({
    outbox,
    workerUrl: options.workerUrl,
    token: options.token,
    fetchImpl: options.fetchImpl
  });
}

async function submitEvent(id, args, options) {
  try {
    const service = options.service ?? createService(options);
    const result = await service.submit(args);
    return reply(id, {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result
    });
  } catch (cause) {
    return failure(id, -32603, cause instanceof Error ? cause.message : String(cause));
  }
}

export async function handleRequest(request, options = {}) {
  if (!request || typeof request !== "object") return failure(null, -32600, "Invalid request");
  if (request.method === "notifications/initialized") return null;
  if (request.method === "initialize") {
    return reply(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "reliable-drive-sync", version: "2.0.0" }
    });
  }
  if (request.method === "ping") return reply(request.id, {});
  if (request.method === "tools/list") return reply(request.id, { tools: [TOOL] });
  if (request.method !== "tools/call") return failure(request.id, -32601, "Method not found");
  if (request.params?.name !== "submit_event") return failure(request.id, -32601, "Tool not implemented");
  return submitEvent(request.id, request.params?.arguments ?? {}, options);
}

function configurationFromEnvironment() {
  const configuredUrl = process.env.RELIABLE_DRIVE_SYNC_WORKER_URL
    ?? process.env.RELIABLE_DRIVE_SYNC_INGRESS_URL;
  return {
    workerUrl: configuredUrl,
    token: process.env.RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET,
    outboxPath: process.env.RELIABLE_DRIVE_SYNC_OUTBOX_PATH
  };
}

if (process.argv[1] && new URL(import.meta.url).pathname.toLowerCase() === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).pathname.toLowerCase()) {
  const config = configurationFromEnvironment();
  let service;
  const runtime = {
    ...config,
    get service() {
      if (!service && config.workerUrl && config.token) {
        try {
          service = createService(config);
          const timer = setInterval(() => { void service.flushPending(); }, 30_000);
          timer.unref();
        } catch {
          // Keep initialization and tool discovery available; the call returns
          // the concrete configuration error through JSON-RPC.
        }
      }
      return service;
    }
  };
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", async (line) => {
    if (!line.trim()) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify(failure(null, -32700, "Parse error"))}\n`);
      return;
    }
    const response = await handleRequest(request, runtime);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}
