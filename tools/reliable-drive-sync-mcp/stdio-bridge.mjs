import readline from "node:readline";

const TOOL = {
  name: "submit_event",
  description: "Submit a validated system, interview, algorithm or resume-knowledge event. The Worker resolves or registers the stable userId from the display name.",
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
          username: { type: "string" },
          verified: { type: "boolean" }
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

async function forwardSubmitEvent(id, args, { workerUrl, token, fetchImpl = fetch }) {
  if (!workerUrl || !token) return failure(id, -32603, "Bridge configuration is incomplete");
  let destination;
  try {
    destination = deriveWorkerUrl(workerUrl);
  } catch {
    return failure(id, -32603, "Bridge Worker URL is invalid");
  }
  let response;
  try {
    response = await fetchImpl(destination, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "submit_event", arguments: args }
      })
    });
  } catch (cause) {
    return failure(id, -32603, `Worker request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return failure(id, -32603, `Worker returned non-JSON response (HTTP ${response.status})`);
  }
  if (!response.ok) return failure(id, -32603, payload?.error?.message ?? `Worker HTTP ${response.status}`);
  return payload;
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
  return forwardSubmitEvent(request.id, request.params?.arguments ?? {}, options);
}

function configurationFromEnvironment() {
  const configuredUrl = process.env.RELIABLE_DRIVE_SYNC_WORKER_URL
    ?? process.env.RELIABLE_DRIVE_SYNC_INGRESS_URL;
  return {
    workerUrl: configuredUrl,
    token: process.env.RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET
  };
}

if (process.argv[1] && new URL(import.meta.url).pathname.toLowerCase() === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).pathname.toLowerCase()) {
  const config = configurationFromEnvironment();
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
    const response = await handleRequest(request, config);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}
