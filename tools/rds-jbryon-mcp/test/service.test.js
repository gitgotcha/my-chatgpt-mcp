// Local Outbox + service tests (J06/J07/J08/J10/J17/J19 single-process/J25).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRdsClient, LocalOutbox } from "../outbox.mjs";
import { createRdsService, createToolHandler } from "../service.mjs";

const EPOCH = "0123456789abcdef0123456789abcdef";
const CLEANUP = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 };

function request(id, overrides = {}) {
  return {
    protocol: "rds-jbryon",
    apiVersion: 1,
    workspaceEpoch: EPOCH,
    requestId: id,
    operation: "snapshot.patch",
    target: { nodeId: "n1" },
    changes: [{ op: "set", path: ["title"], value: "x" }],
    ...overrides
  };
}

async function withOutbox(callback) {
  const directory = await mkdtemp(join(tmpdir(), "rds-jbryon-outbox-"));
  const path = join(directory, "outbox.sqlite");
  let now = "2026-10-26T10:00:00.000Z";
  const clock = () => now;
  const outbox = new LocalOutbox({ path, clock, owner: "test-owner" });
  try {
    await callback({ outbox, path, clock, advance: (ms) => { now = new Date(Date.parse(now) + ms).toISOString(); } });
  } finally {
    outbox.close();
    await rm(directory, CLEANUP);
  }
}

function fakeClient({ effects = {}, failWith = null, onSend = null } = {}) {
  return {
    sent: [],
    async submit(req) {
      if (onSend) await onSend(req);
      if (failWith) {
        const error = new Error(failWith);
        error.code = failWith;
        throw error;
      }
      this.sent.push(req.requestId);
      return { requestId: req.requestId, status: "d1_committed", effect: "pending" };
    },
    async status(id) {
      const table = this.effects ?? effects;
      if (!(id in table)) {
        const error = new Error("request_not_found");
        error.code = "request_not_found";
        throw error;
      }
      return { requestId: id, effect: table[id] };
    },
    async read(operation) {
      return { operation, ok: true };
    }
  };
}

test("a request survives a restart and keeps its id", async () => {
  await withOutbox(async ({ outbox, path }) => {
    outbox.enqueue(request("req-00000001"));
    outbox.close();
    const reopened = new LocalOutbox({ path, clock: () => "2026-10-26T10:00:00.000Z", owner: "new" });
    try {
      const row = reopened.get("req-00000001");
      assert.equal(row.state, "local_pending");
      assert.equal(row.request.requestId, "req-00000001");
    } finally {
      reopened.close();
    }
  });
});

test("the same id with different content is refused, not overwritten", async () => {
  await withOutbox(async ({ outbox }) => {
    outbox.enqueue(request("req-00000001"));
    const duplicate = outbox.enqueue(request("req-00000001"));
    assert.equal(duplicate.duplicate, true);
    assert.throws(() => outbox.enqueue(request("req-00000001", {
      changes: [{ op: "set", path: ["title"], value: "changed" }]
    })), (error) => error.code === "request_id_conflict");
  });
});

test("an invalid request never enters the outbox", async () => {
  await withOutbox(async ({ outbox }) => {
    assert.throws(() => outbox.enqueue(request("req-00000001", { user: "乔炳源" })), (error) => error.code === "invalid_request");
    assert.equal(outbox.list().length, 0);
  });
});

test("a receipt stops transport retries but does not claim the effect", async () => {
  await withOutbox(async ({ outbox }) => {
    const client = fakeClient();
    const service = createRdsService({ outbox, client });
    await service.submit(request("req-00000001"));
    const row = outbox.get("req-00000001");
    assert.equal(row.state, "cloud_acknowledged");
    assert.equal(row.effect, "pending");
    const status = await service.status("req-00000001");
    assert.equal(status.display, "d1_committed");

    client.effects = { "req-00000001": "applied" };
    const projected = await service.status("req-00000001");
    assert.equal(projected.display, "projected");
  });
});

test("a dependency waits for its applied effect, then sends with the same id", async () => {
  await withOutbox(async ({ outbox }) => {
    const effects = { "req-a0000001": "pending" };
    const client = fakeClient({ effects });
    const service = createRdsService({ outbox, client });
    outbox.enqueue(request("req-a0000001"));
    await service.flush();
    const dependent = request("req-b0000002", { dependsOn: ["req-a0000001"] });
    await service.submit(dependent);
    assert.equal(outbox.get("req-b0000002").state, "waiting_dependency");
    assert.equal(client.sent.includes("req-b0000002"), false);

    effects["req-a0000001"] = "applied";
    assert.equal((await service.releaseReady()).released, 1);
    await service.flush();
    assert.equal(outbox.get("req-b0000002").state, "cloud_acknowledged");
    assert.deepEqual(client.sent.filter((id) => id === "req-b0000002").length, 1);
  });
});

test("a dependency in conflict requires replanning and never sends", async () => {
  await withOutbox(async ({ outbox }) => {
    const effects = { "req-a0000001": "conflict" };
    const client = fakeClient({ effects });
    const service = createRdsService({ outbox, client });
    await service.submit(request("req-b0000002", { dependsOn: ["req-a0000001"] }));
    assert.equal(outbox.get("req-b0000002").state, "waiting_dependency");
    assert.equal(outbox.get("req-b0000002").lastError, "dependency_replan_required");
  });
});

test("transient failures back off and park after the cap", async () => {
  await withOutbox(async ({ outbox, advance }) => {
    const client = fakeClient({ failWith: "network_down" });
    const service = createRdsService({ outbox, client });
    outbox.enqueue(request("req-00000001"));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service.flush();
      advance(10 * 60 * 1000);
    }
    assert.equal(outbox.get("req-00000001").state, "delivery_blocked");
  });
});

test("a permanent rejection parks immediately", async () => {
  await withOutbox(async ({ outbox }) => {
    const client = fakeClient({ failWith: "unsupported_operation" });
    const service = createRdsService({ outbox, client });
    await service.submit(request("req-00000001"));
    assert.equal(outbox.get("req-00000001").state, "delivery_blocked");
  });
});

test("an expired sending lease is recovered", async () => {
  await withOutbox(async ({ outbox, advance }) => {
    outbox.enqueue(request("req-00000001"));
    const claimed = outbox.claimDue();
    assert.equal(claimed.length, 1);
    advance(61_000);
    assert.equal(outbox.recoverExpired().recovered, 1);
    assert.equal(outbox.get("req-00000001").state, "local_pending");
  });
});

test("cancel keeps the row and reports cancelled", async () => {
  await withOutbox(async ({ outbox }) => {
    outbox.enqueue(request("req-00000001"));
    outbox.cancel("req-00000001", "target_deleted");
    assert.equal(outbox.get("req-00000001").state, "cancelled");
  });
});

test("the rds tool dispatches request, query and status", async () => {
  await withOutbox(async ({ outbox }) => {
    const service = createRdsService({ outbox, client: fakeClient() });
    const handle = createToolHandler(service);
    assert.equal((await handle({ kind: "request", request: request("req-00000001") })).ok, true);
    assert.equal((await handle({ kind: "status", requestId: "req-00000001" })).ok, true);
    assert.equal((await handle({ kind: "query", operation: "directory.list", params: {} })).ok, true);
    assert.equal((await handle({ kind: "nope" })).ok, false);
  });
});

test("the rds tool routes only task.retry through the authenticated admin transport", async () => {
  await withOutbox(async ({ outbox }) => {
    const client = {
      ...fakeClient(),
      async admin(operation, params) { return { operation, ...params, state: "pending" }; }
    };
    const service = createRdsService({ outbox, client });
    const handle = createToolHandler(service);
    const result = await handle({ kind: "admin", operation: "task.retry", params: { taskId: "task-0001" } });
    assert.deepEqual(result, {
      ok: true,
      result: { operation: "task.retry", taskId: "task-0001", state: "pending" }
    });
    await assert.rejects(
      service.admin("directory.delete", { taskId: "task-0001" }),
      /unsupported_admin_operation/
    );
  });
});

test("the cloud client sends task.retry as a protocol-pinned admin action", async () => {
  let captured;
  const client = createRdsClient({
    baseUrl: "https://rds.example.test/",
    token: "secret-token",
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ taskId: "task-0001", state: "pending" }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
  });
  const result = await client.admin("task.retry", { taskId: "task-0001" });
  assert.deepEqual(result, { taskId: "task-0001", state: "pending" });
  assert.equal(captured.url, "https://rds.example.test/rds");
  assert.equal(captured.init.headers.authorization, "Bearer secret-token");
  assert.deepEqual(JSON.parse(captured.init.body), {
    protocol: "rds-jbryon", apiVersion: 1, kind: "admin",
    operation: "task.retry", params: { taskId: "task-0001" }
  });
});

test("parallel submits never open two network sends", async () => {
  await withOutbox(async ({ outbox }) => {
    let active = 0;
    let maxActive = 0;
    const client = {
      async submit(req) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { requestId: req.requestId, status: "d1_committed" };
      },
      async status() { return { effect: "pending" }; },
      async read() { return {}; }
    };
    const service = createRdsService({ outbox, client });
    await Promise.all([
      service.submit(request("req-00000001")),
      service.submit(request("req-00000002"))
    ]);
    assert.equal(maxActive, 1);
  });
});

test("J19 independent processes cannot claim the same durable Outbox request", async () => {
  await withOutbox(async ({ outbox, path }) => {
    outbox.enqueue(request("req-multiprocess-0001"));
    const barrier = `${path}.start`;
    const workerPath = fileURLToPath(new URL("./outbox-claim-worker.mjs", import.meta.url));
    const owners = ["worker-process-a", "worker-process-b"];
    const runWorker = (owner) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [workerPath, path, owner, barrier], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => code === 0
        ? resolve(JSON.parse(stdout))
        : reject(new Error(`worker ${owner} exited ${code}: ${stderr}`)));
    });
    const resultsPromise = Promise.all(owners.map(runWorker));
    const readyFiles = owners.map((owner) => `${barrier}.${owner}.ready`);
    const deadline = Date.now() + 10_000;
    while (!readyFiles.every(existsSync)) {
      if (Date.now() > deadline) throw new Error("claim_workers_not_ready");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await writeFile(barrier, "go");
    const results = await resultsPromise;
    const claims = results.flatMap((result) => result.claimed);
    assert.deepEqual(claims, ["req-multiprocess-0001"]);
    assert.equal(results.filter((result) => result.claimed.length === 1).length, 1);
    assert.equal(outbox.get("req-multiprocess-0001").state, "sending");
  });
});

test("dependency waiting never consumes the real failure budget", async () => {
  await withOutbox(async ({ outbox }) => {
    let ready = false;
    let networkCalls = 0;
    const client = {
      async status() { return { effect: ready ? "applied" : "pending" }; },
      async submit() {
        networkCalls += 1;
        const error = new Error("network_down");
        error.code = "network_down";
        throw error;
      },
      async read() { return {}; }
    };
    const service = createRdsService({ outbox, client });
    const dependent = request("req-00000003", { dependsOn: ["req-a0000001"] });
    outbox.enqueue(dependent);
    for (let round = 0; round < 4; round += 1) {
      await service.flush();
      outbox.releaseWaiting(dependent.requestId);
    }
    ready = true;
    await service.flush();
    const row = outbox.get(dependent.requestId);
    assert.equal(row.state, "local_pending");
    assert.equal(row.attemptCount, 1);
    assert.equal(networkCalls, 1);
  });
});
