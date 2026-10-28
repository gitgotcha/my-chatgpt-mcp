// HTTP surface tests: single credential, protocol pinning, dispatch and stable
// error codes (J01/J25 local layer).
import test from "node:test";
import assert from "node:assert/strict";
import { createRdsHandler } from "../src/routes.js";
import { RdsError } from "../src/contracts.js";

const TOKEN = "test-token";

function fakeStore(overrides = {}) {
  return {
    accepted: [],
    async accept(request) {
      this.accepted.push(request);
      return { requestId: request.requestId, status: "d1_committed", effect: "pending" };
    },
    async capabilities() {
      return { product: "RDS-JBryon", apiVersion: 1, catalogRevision: 3 };
    },
    async listDirectory(params) {
      return { entries: [], catalogRevision: 3, page: params?.page ?? 0 };
    },
    async resolvePath(path) {
      return { path, nodeId: "n1" };
    },
    async readSnapshot() {
      return { waiting: false, revision: 2, content: { title: "12306" } };
    },
    async requestStatus(id) {
      if (id === "missing-request") throw Object.assign(new RdsError("request_not_found"), { status: 404 });
      return { requestId: id, effect: "applied" };
    },
    ...overrides
  };
}

const call = (handler, body, { token = TOKEN, method = "POST" } = {}) => handler.handle(new Request("https://rds.test/rds", {
  method,
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: method === "POST" ? JSON.stringify(body) : undefined
}));

const base = { protocol: "rds-jbryon", apiVersion: 1 };

test("a missing or wrong credential reads and writes nothing", async () => {
  const store = fakeStore();
  const handler = createRdsHandler({ store, token: TOKEN });
  const unauthorized = await call(handler, { ...base, kind: "query", operation: "capabilities" }, { token: "wrong" });
  assert.equal(unauthorized.status, 401);
  assert.equal(store.accepted.length, 0);
});

test("only POST is served", async () => {
  const handler = createRdsHandler({ store: fakeStore(), token: TOKEN });
  const response = await handler.handle(new Request("https://rds.test/rds", {
    method: "GET", headers: { authorization: `Bearer ${TOKEN}` }
  }));
  assert.equal(response.status, 405);
});

test("an old or foreign protocol is refused before any effect", async () => {
  const store = fakeStore();
  const handler = createRdsHandler({ store, token: TOKEN });
  const response = await call(handler, { protocol: "rds-jbryon", apiVersion: 2, kind: "query", operation: "capabilities" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "unsupported_protocol");
  assert.equal(store.accepted.length, 0);
});

test("a write returns a D1 receipt and no user identity is required", async () => {
  const store = fakeStore();
  const handler = createRdsHandler({ store, token: TOKEN });
  const request = {
    protocol: "rds-jbryon", apiVersion: 1, workspaceEpoch: "0123456789abcdef0123456789abcdef",
    requestId: "req-00000001", operation: "directory.create",
    target: { path: ["project", "12306"], kind: "directory" }
  };
  const response = await call(handler, { ...base, kind: "request", request });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { requestId: "req-00000001", status: "d1_committed", effect: "pending" });
  assert.equal(store.accepted.length, 1);
});

test("reads dispatch by operation and never touch accept", async () => {
  const store = fakeStore();
  const handler = createRdsHandler({ store, token: TOKEN });
  const list = await call(handler, { ...base, kind: "query", operation: "directory.list", params: { page: 1 } });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).page, 1);
  const snapshot = await call(handler, { ...base, kind: "query", operation: "snapshot.read", params: { nodeId: "n1" } });
  assert.equal((await snapshot.json()).content.title, "12306");
  assert.equal(store.accepted.length, 0);
});

test("an unknown read operation is rejected", async () => {
  const handler = createRdsHandler({ store: fakeStore(), token: TOKEN });
  const response = await call(handler, { ...base, kind: "query", operation: "user.resolve" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "unsupported_operation");
});

test("a store error keeps its stable code and status", async () => {
  const handler = createRdsHandler({ store: fakeStore(), token: TOKEN });
  const response = await call(handler, {
    ...base, kind: "query", operation: "request.status", params: { requestId: "missing-request" }
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "request_not_found");
});
