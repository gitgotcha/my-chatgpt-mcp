import readline from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DeliveryService } from "./delivery-service.mjs";
import { randomUUID } from "node:crypto";
import { classifySubmission } from "../../shared/rds2-protocol.mjs";
import { isV2ReadMessage, toV2Query, parseV2StatusInput } from "./v2-routing.mjs";
import { parseSubmission } from "../../shared/device-binding-protocol.mjs";
import { openDeviceStore } from "./gateway/device-store.mjs";
import { createSecureStore, createWindowsDpapiProtector } from "./gateway/secure-store.mjs";
import { createAccounts } from "./gateway/accounts.mjs";
import { createBusinessTransport } from "./gateway/business-transport.mjs";
import { LocalOutboxV2 } from "./local-outbox-v2.mjs";
import { createDeliveryServiceV2 } from "./delivery-service-v2.mjs";

const TOOL = {
  name: "submit_event",
  description: "Discover generic profile capabilities, read profiles, or durably queue a validated system, interview, algorithm, resume-knowledge or profile evidence event in the local SQLite Outbox before cloud delivery.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    anyOf: [
      { required: ["schemaVersion", "namespace", "eventType", "requestId"] },
      { required: ["storageVersion", "operation", "params"] }
    ],
    properties: {
      storageVersion: { type: "integer", const: 2 },
      operation: { type: "string", enum: ["capabilities", "user.resolve", "projection.read", "interview.session.list", "interview.session.load", "event.status"] },
      params: { type: "object" },
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

function defaultOutboxPath(version = "v1") {
  const base = process.env.LOCALAPPDATA
    ?? process.env.XDG_DATA_HOME
    ?? join(homedir(), ".local", "share");
  return join(base, "ReliableDriveSync", version === "v2" ? "outbox-v2.sqlite" : "outbox.sqlite");
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
    path: options.outboxPath ?? defaultOutboxPath("v2"),
    clock: () => new Date().toISOString(),
    owner: `stdio-bridge-${randomUUID()}`
  });
  return createDeliveryServiceV2({
    outbox,
    clock: () => new Date().toISOString(),
    send: async (envelope) => {
      const response = await (options.fetchImpl ?? fetch)(`${deriveWorkerUrl(options.workerUrl)}/v2/events`, {
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
  const response = await (options.fetchImpl ?? fetch)(`${deriveWorkerUrl(options.workerUrl)}/v2/query`, {
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

function defaultDialog(deviceRoot) {
  const script = fileURLToPath(new URL("./gateway/secure-dialog.ps1", import.meta.url));
  function run(action, prompt) {
    const directory = mkdtempSync(join(tmpdir(), "rds2-dialog-"));
    const output = join(directory, "result.txt");
    try {
      const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", action, "-OutputPath", output, "-Prompt", prompt], { encoding: "utf8", windowsHide: false, timeout: 120_000 });
      if (result.status !== 0) return null;
      return readFileSync(output, "utf8").trim();
    } finally { try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
  const protector = createWindowsDpapiProtector();
  return {
    async secret({ purpose = "secret" } = {}) { const encrypted = run("secret", `Reliable Drive Sync ${purpose}`); return encrypted ? protector.unprotect(encrypted) : null; },
    async pairingCode() { const encrypted = run("secret", "输入配对码"); return encrypted ? protector.unprotect(encrypted) : null; },
    async confirm({ purpose = "confirm" } = {}) { return run("confirm", `Reliable Drive Sync ${purpose}`) !== null; },
    async showPairingCode(code) {
      if (typeof code !== "string" || !code) return;
      spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", "param($c); Write-Host ('配对码（仅本机显示）：' + $c); Read-Host '按回车关闭'", "-c", code], { windowsHide: false, timeout: 120_000 });
    }
  };
}

function accountHttpClient(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = () => `${deriveWorkerUrl(options.workerUrl)}/v2/account`;
  async function call(operation, params, credential) {
    const response = await fetchImpl(endpoint(), {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", "CF-Connecting-IP": "127.0.0.1" },
      body: JSON.stringify({ storageVersion: 2, operation, params })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body?.error?.code ?? `account_${response.status}`), { code: body?.error?.code ?? `account_${response.status}` });
    return body;
  }
  return {
    current: ({ credential }) => call("account.current", {}, credential),
    register: ({ displayName, requestId, secret }) => call("account.register", { displayName, requestId }, secret),
    verify: ({ accountHandle, credential }) => call("account.current", {}, credential).then((body) => ({ ...body, accountHandle })),
    pairingCreate: ({ credential, code }) => call("account.transfer.create", { code }, credential),
    pairingRedeem: ({ requestId, code, secret }) => call("account.transfer.redeem", { requestId, code }, secret)
  };
}

async function createGatewayRuntime(options) {
  if (typeof options.deviceRoot !== "string" || !options.deviceRoot.trim()) return null;
  if (typeof options.workerUrl !== "string" || !options.workerUrl.trim()) throw new Error("Bridge Worker URL is invalid");
  const root = options.deviceRoot;
  const deviceStore = openDeviceStore({ path: join(root, "control.sqlite") });
  const secureStore = createSecureStore({ root: join(root, "secure") });
  const client = accountHttpClient(options);
  const dialog = options.dialog ?? defaultDialog(root);
  const accounts = createAccounts({ deviceStore, secureStore, client, dialog, root: join(root, "accounts") });
  const resources = new Map();
  const outboxFactory = ({ userId, credentialRef }) => {
    if (resources.has(userId)) return resources.get(userId);
    const outbox = new LocalOutboxV2({ path: join(root, "outbox", userId, "outbox-v2.sqlite"), clock: () => new Date().toISOString(), owner: `stdio-${randomUUID()}` });
    const delivery = createDeliveryServiceV2({ outbox, clock: () => new Date().toISOString(), send: async (envelope) => {
      const credential = secureStore.get(credentialRef);
      if (!credential) throw Object.assign(new Error("reauth_required"), { code: "reauth_required" });
      const response = await (options.fetchImpl ?? fetch)(`${deriveWorkerUrl(options.workerUrl)}/v2/events`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify(envelope) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(body?.error?.code ?? `http_${response.status}`), { code: body?.error?.code ?? `http_${response.status}` });
      return body;
    } });
    const resource = { outbox, delivery };
    resources.set(userId, resource);
    return resource;
  };
  const businessTransport = createBusinessTransport({ deviceStore, accounts, outboxFactory, workerUrl: options.workerUrl, token: options.token, fetchImpl: options.fetchImpl });
  return { accounts, businessTransport, close() { businessTransport.close(); deviceStore.close(); } };
}

const gatewayServices = new WeakMap();
function getGatewayRuntime(options) {
  if (!gatewayServices.has(options)) {
    const pending = createGatewayRuntime(options).catch((error) => { gatewayServices.delete(options); throw error; });
    gatewayServices.set(options, pending);
  }
  return gatewayServices.get(options);
}

async function submitEvent(id, args, options) {
  try {
    // WriteVersion v2: reads route to /v2/query and never touch the outbox;
    // writes go through the local durable outbox; explicit V2 status inputs
    // keep their own schema.
    if ((options.writeVersion ?? "v1") === "v2") {
      const gateway = options.accounts || options.businessTransport ? null : await getGatewayRuntime(options);
      const accountsGateway = options.accounts ?? gateway?.accounts;
      const businessGateway = options.businessTransport ?? gateway?.businessTransport;
      if (args?.storageVersion === 2) {
        const parsed = parseSubmission(args);
        if (parsed.kind === "account") {
          const accounts = accountsGateway;
          if (!accounts) throw new Error("account_gateway_unavailable");
          const op = parsed.body.operation;
          const method = op === "account.current" ? "current"
            : op === "account.find" ? "find"
            : op === "account.register" ? "register"
            : op === "account.bind" ? "bind"
            : op === "account.switch" ? "switch"
            : op === "account.unbind" ? "unbind"
            : op === "account.transfer.create" ? "transferCreate" : "transferRedeem";
          if (typeof accounts[method] !== "function") throw new Error("account_gateway_unavailable");
          const params = parsed.body.params;
          const result = op === "account.transfer.create"
            ? await accounts[method](parsed.bindingContext)
            : await accounts[method](params);
          return reply(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
        }
        if (parsed.kind === "query" && businessGateway) {
          const result = await businessGateway.query(args);
          return reply(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
        }
        if (parsed.kind === "write" && businessGateway) {
          const result = await businessGateway.submit(args);
          return reply(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
        }
        if (parsed.kind !== "query") throw new Error("business_transport_unavailable");
        const query = args.operation === "event.status" ? parseV2StatusInput(args) : parsed.body;
        if (!TOOL.inputSchema.properties.operation.enum.includes(query.operation)
          || !query.params || typeof query.params !== "object" || Array.isArray(query.params)) {
          throw new Error("invalid_v2_query");
        }
        const result = await v2QueryCall(query, options);
        return reply(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
      }
      // Business envelopes carry schemaVersion rather than storageVersion;
      // the unified gateway must parse them before the legacy V2 classifier
      // sees the top-level bindingContext field.
      if (businessGateway && args && (Object.hasOwn(args, "schemaVersion") || Object.hasOwn(args, "bindingContext"))) {
        const parsed = parseSubmission(args);
        if (parsed.kind === "write") {
          const result = await businessGateway.submit(args);
          return reply(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
        }
        if (parsed.kind === "query") {
          const result = await businessGateway.query(args);
          return reply(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
        }
      }
      if (isV2ReadMessage(args)) {
        const result = await v2QueryCall(toV2Query(args), options);
        return reply(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
      }
      if (classifySubmission(args).kind !== "write") throw new Error("unsupported_write_type");
      const service = await (options.v2Service ?? getV2Service(options));
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

const v2Services = new WeakMap();
function getV2Service(options) {
  if (!v2Services.has(options)) {
    const pending = createV2Service(options).catch((error) => {
      v2Services.delete(options);
      throw error;
    });
    v2Services.set(options, pending);
  }
  return v2Services.get(options);
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
    deviceRoot: process.env.RELIABLE_DRIVE_SYNC_DEVICE_ROOT,
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
