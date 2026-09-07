import readline from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { DeliveryService } from "./delivery-service.mjs";
import { isV2ReadMessage, toV2Query, parseV2StatusInput } from "./v2-routing.mjs";

const TOOL = {
  name: "submit_event",
  description: "Discover generic profile capabilities, read profiles, or durably queue a validated system, interview, algorithm, resume-knowledge or profile evidence event in the local SQLite Outbox before cloud delivery.",
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

async function createService(options) {
  if (!options.workerUrl || !options.token) throw new Error("Bridge configuration is incomplete");
  try {
    deriveWorkerUrl(options.workerUrl);
  } catch {
    throw new Error("Bridge Worker URL is invalid");
  }
  // `local-outbox.mjs` loads `node:sqlite`, which makes Node print an
  // ExperimentalWarning. Import it here rather than at module scope so
  // initialization and tool discovery keep a clean stderr; only a real
  // submit_event call needs durable storage.
  const { LocalOutbox } = await import("./local-outbox.mjs");
  const outbox = options.outbox ?? new LocalOutbox(options.outboxPath ?? defaultOutboxPath());
  return new DeliveryService({
    outbox,
    workerUrl: options.workerUrl,
    token: options.token,
    fetchImpl: options.fetchImpl
  });
}

// WriteVersion v2: reads go straight to /v2/query, writes go through the
// local durable outbox (T09) whose delivery owns the single HTTP call.
async function createV2Service(options) {
  if (!options.workerUrl || !options.token) throw new Error("Bridge configuration is incomplete");
  const { LocalOutboxV2 } = await import("./local-outbox-v2.mjs");
  const { createDeliveryServiceV2 } = await import("./delivery-service-v2.mjs");
  const outbox = options.outbox ?? new LocalOutboxV2({
    path: options.outboxPath ?? defaultOutboxPath(),
    clock: () => new Date().toISOString(),
    owner: "stdio-bridge"
  });
  return createDeliveryServiceV2({
    outbox,
    clock: () => new Date().toISOString(),
    send: async (envelope) => {
      const response = await fetch(`${deriveWorkerUrl(options.workerUrl)}/v2/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(envelope)
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const error = new Error(body?.error?.code ?? `http_${response.status}`);
        if (body?.error?.code) error.code = body.error.code;
        throw error;
      }
      return response.json();
    }
  });
}

async function v2QueryCall(payload, options) {
  const response = await fetch(`${deriveWorkerUrl(options.workerUrl)}/v2/query`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.code ?? `http_${response.status}`);
    if (body?.error?.code) error.code = body.error.code;
    throw error;
  }
  return body;
}

async function submitEvent(id, args, options) {
  try {
    // WriteVersion v2: reads route to /v2/query and never touch the outbox;
    // writes go through the local durable outbox; explicit V2 status inputs
    // keep their own schema.
    if ((options.writeVersion ?? "v1") === "v2") {
      if (args?.storageVersion === 2 && args?.operation === "event.status") {
        const status = parseV2StatusInput(args);
        const result = await v2QueryCall(status, options);
        return reply(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
      }
      if (isV2ReadMessage(args)) {
        const result = await v2QueryCall(toV2Query(args), options);
        return reply(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
      }
      const service = await (options.v2Service ?? createV2Service(options));
      const result = await service.submit(args);
      return reply(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    }
    const service = await (options.service ?? createService(options));
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
    outboxPath: process.env.RELIABLE_DRIVE_SYNC_OUTBOX_PATH,
    writeVersion: process.env.RELIABLE_DRIVE_SYNC_WRITE_VERSION
  };
}

if (process.argv[1] && new URL(import.meta.url).pathname.toLowerCase() === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).pathname.toLowerCase()) {
  const config = configurationFromEnvironment();
  let service;
  let pendingService;
  const runtime = {
    ...config,
    get service() {
      if (service) return service;
      if (!config.workerUrl || !config.token) return undefined;
      // Memoize the promise so concurrent submit_event calls share one
      // Outbox; clear it on failure so the next call retries.
      if (!pendingService) {
        pendingService = createService(config).then((created) => {
          service = created;
          const timer = setInterval(() => { void created.flushPending(); }, 30_000);
          timer.unref();
          return created;
        }).catch(() => {
          pendingService = undefined;
          return undefined;
        });
      }
      return pendingService;
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
