// stdio MCP surface: one tool named `rds`, no account flow (design §7).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, TOOL } from "../server.mjs";

function fakeService() {
  return {
    submitted: [],
    async submit(request) {
      this.submitted.push(request);
      return { requestId: request.requestId, local: "local_pending" };
    },
    async status(requestId) { return { requestId, display: "d1_committed" }; },
    async query(operation) { return { operation, ok: true }; },
    async admin(operation, params) { return { operation, ...params, state: "pending" }; }
  };
}

test("initialize and tools/list expose exactly one rds tool", async () => {
  const server = createServer({ service: fakeService() });
  const init = await server.onRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(init.result.serverInfo.name, "rds-jbryon");
  const list = await server.onRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["rds"]);
  assert.equal(TOOL.inputSchema.properties.kind.enum.includes("request"), true);
});

test("a request through the tool reaches the service", async () => {
  const service = fakeService();
  const server = createServer({ service });
  const response = await server.onRequest({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: {
      name: "rds",
      arguments: {
        kind: "request",
        request: { protocol: "rds-jbryon", apiVersion: 1, workspaceEpoch: "0123456789abcdef0123456789abcdef", requestId: "req-00000001", operation: "snapshot.patch" }
      }
    }
  });
  assert.equal(response.result.structuredContent.result.local, "local_pending");
  assert.equal(service.submitted.length, 1);
});

test("unknown tools and methods are rejected without side effects", async () => {
  const service = fakeService();
  const server = createServer({ service });
  const unknownTool = await server.onRequest({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "drive" } });
  assert.equal(unknownTool.error.code, -32602);
  const unknownMethod = await server.onRequest({ jsonrpc: "2.0", id: 5, method: "resources/list" });
  assert.equal(unknownMethod.error.code, -32601);
  assert.equal(service.submitted.length, 0);
});

test("notifications never produce a response", async () => {
  const server = createServer({ service: fakeService() });
  assert.equal(await server.onRequest({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("the MCP rds tool exposes the operator retry action", async () => {
  const server = createServer({ service: fakeService() });
  assert.equal(TOOL.inputSchema.properties.kind.enum.includes("admin"), true);
  const response = await server.onRequest({
    jsonrpc: "2.0", id: 6, method: "tools/call",
    params: {
      name: "rds",
      arguments: { kind: "admin", operation: "task.retry", params: { taskId: "task-0001" } }
    }
  });
  assert.deepEqual(response.result.structuredContent.result, {
    operation: "task.retry", taskId: "task-0001", state: "pending"
  });
});
