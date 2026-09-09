import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { handleRequest } from "../stdio-bridge.mjs";

const context = {
  installationId: "11111111-1111-4111-8111-111111111111",
  bindingEpoch: "22222222-2222-4222-8222-222222222222",
  bindingRevision: 0,
  userId: "33333333-3333-4333-8333-333333333333"
};

function call(arguments_, options) {
  return handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_event", arguments: arguments_ } }, options);
}

test("T07 tools/list exposes only submit_event", async () => {
  const result = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {});
  assert.deepEqual(result.result.tools.map((tool) => tool.name), ["submit_event"]);
});

test("T01 tools/list publishes closed V2 account, query, and business input branches", async () => {
  const result = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {});
  const schema = result.result.tools[0].inputSchema;
  assert.equal(schema.anyOf, undefined);
  assert.ok(Array.isArray(schema.oneOf));
  const storage = schema.oneOf.find((branch) => branch.required.includes("storageVersion"));
  const business = schema.oneOf.find((branch) => branch.required.includes("schemaVersion"));
  assert.ok(storage);
  assert.ok(business);
  assert.equal(storage.additionalProperties, false);
  assert.equal(business.additionalProperties, false);
  assert.ok(storage.properties.operation.enum.includes("account.current"));
  assert.ok(storage.properties.operation.enum.includes("account.register"));
  assert.ok(storage.properties.operation.enum.includes("account.transfer.redeem"));
  assert.ok(storage.properties.operation.enum.includes("event.status"));
  assert.ok(Object.hasOwn(storage.properties, "bindingContext"));
  assert.ok(Object.hasOwn(business.properties, "bindingContext"));
  assert.equal(business.required.includes("bindingContext"), true);
});

test("T07 account operations route through the account registry", async () => {
  const calls = [];
  const accounts = { current: async () => { calls.push("current"); return { state: "unbound", bindingContext: { ...context, userId: null } }; } };
  const response = await call({ storageVersion: 2, operation: "account.current", params: {} }, { writeVersion: "v2", accounts });
  assert.equal(response.result.structuredContent.state, "unbound");
  assert.deepEqual(calls, ["current"]);
});

test("T07 personal query without binding context performs zero business IO", async () => {
  let queries = 0;
  const response = await call({ storageVersion: 2, operation: "projection.read", params: { namespace: "algorithm", projectionName: "learning" } }, {
    writeVersion: "v2", businessTransport: { query: async () => { queries += 1; } }
  });
  assert.equal(response.error.message, "binding_context_required");
  assert.equal(queries, 0);
});

test("T07 query and write use business transport after one explicit context", async () => {
  const calls = [];
  const businessTransport = {
    async query(value) { calls.push(["query", value]); return { revision: 1 }; },
    async submit(value) { calls.push(["submit", value]); return { status: "queued_locally" }; }
  };
  const query = await call({ storageVersion: 2, operation: "projection.read", params: { namespace: "algorithm", projectionName: "learning" }, bindingContext: context }, { writeVersion: "v2", businessTransport });
  const write = await call({ schemaVersion: "1.2", namespace: "profile", eventType: "profile.evidence.recorded", identity: { username: "乔" }, payload: { domain: "english-learning", event: { schemaVersion: "1.0", eventId: "44444444-4444-4444-8444-444444444444", eventKey: "k", observedAt: "2026-09-01T00:00:00.000Z", sourceSkill: "english-learning", action: "observe", observations: [{ dimensionKey: "vocabulary", subjectKey: "a", outcome: "stuck", evidence: "e", confidence: "high", sourceRef: "s" }] } }, requestId: "w-1", bindingContext: context }, { writeVersion: "v2", businessTransport });
  assert.equal(query.result.structuredContent.revision, 1);
  assert.equal(write.result.structuredContent.status, "queued_locally");
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].bindingContext, context);
});

test("T07 start-v2 resolves the Windows-user device directory and never loads a fixed credential", async () => {
  const script = await readFile(fileURLToPath(new URL("../start-v2.ps1", import.meta.url)), "utf8");
  assert.match(script, /RELIABLE_DRIVE_SYNC_DEVICE_ROOT/);
  assert.doesNotMatch(script, /v2-client\.credential\.xml|Import-Clixml/);
});
