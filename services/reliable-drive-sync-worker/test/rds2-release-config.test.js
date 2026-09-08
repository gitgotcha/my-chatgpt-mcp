import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(WORKER_ROOT, "..", "..");
const WRANGLER = fs.readFileSync(path.join(WORKER_ROOT, "wrangler.toml"), "utf8");
const INDEX = fs.readFileSync(path.join(WORKER_ROOT, "src", "index.js"), "utf8");
const ROUTES = fs.readFileSync(path.join(WORKER_ROOT, "src", "rds2", "routes.js"), "utf8");
const SETUP = fs.readFileSync(
  path.join(REPO_ROOT, "tools", "reliable-drive-sync-mcp", "setup-local-clients.ps1"),
  "utf8"
);
const RUNBOOK = fs.readFileSync(
  path.join(REPO_ROOT, "docs", "runbooks", "rds2-release.md"),
  "utf8"
);

const QUEUE_NAMES = [
  "rds2-projection",
  "rds2-archive",
  "rds2-projection-dlq",
  "rds2-archive-dlq"
];
const V1_CRONS = ["*/5 * * * *", "0 * * * *", "0 */6 * * *"];
const V2_RECOVERY_CRON = "2-57/5 * * * *";
const FLAGS = [
  "RDS2_WRITE_ENABLED",
  "RDS2_QUERY_ENABLED",
  "RDS2_PROJECTION_ENABLED",
  "RDS2_ARCHIVE_ENABLED",
  "RDS2_RECOVERY_ENABLED"
];

test("T16 declares both V2 queue producers and four single-message consumers", () => {
  assert.match(WRANGLER, /\[\[queues\.producers\]\]/);
  assert.match(WRANGLER, /binding\s*=\s*"RDS2_PROJECTION_QUEUE"/);
  assert.match(WRANGLER, /binding\s*=\s*"RDS2_ARCHIVE_QUEUE"/);
  assert.equal((WRANGLER.match(/\[\[queues\.consumers\]\]/g) ?? []).length, 4);
  assert.equal((WRANGLER.match(/max_batch_size\s*=\s*1/g) ?? []).length, 4);
  for (const queue of QUEUE_NAMES) assert.match(WRANGLER, new RegExp(`queue\\s*=\\s*"${queue}"`));
  assert.match(WRANGLER, /queue\s*=\s*"rds2-projection"[\s\S]*?dead_letter_queue\s*=\s*"rds2-projection-dlq"/);
  assert.match(WRANGLER, /queue\s*=\s*"rds2-archive"[\s\S]*?dead_letter_queue\s*=\s*"rds2-archive-dlq"/);
});

test("T16 preserves all V1 cron expressions and adds the frozen V2 recovery cron", () => {
  for (const cron of V1_CRONS) assert.match(WRANGLER, new RegExp(cron.replaceAll("*", "\\*")));
  assert.match(WRANGLER, new RegExp(V2_RECOVERY_CRON.replaceAll("*", "\\*")));
  assert.match(INDEX, /controller\?\.cron === V2_RECOVERY_CRON/);
});

test("T16 keeps every V2 feature switch explicitly false by default", () => {
  for (const flag of FLAGS) assert.match(WRANGLER, new RegExp(`${flag}\\s*=\\s*"false"`));
});

test("T16 wires the recovery switch to the scheduled entry point", () => {
  assert.match(INDEX, /RDS2_RECOVERY_ENABLED/);
  assert.match(INDEX, /===\s*"true"/);
  assert.match(INDEX, /handleV2Scheduled/);
});

test("T16 disabled recovery cron is a no-op and does not invoke the recovery handler", async () => {
  const { createWorker, V2_RECOVERY_CRON } = await import("../src/index.js");
  const worker = createWorker(
    { RDS2_RECOVERY_ENABLED: "false" },
    { repository: {}, publisher: {} }
  );
  let scheduledWork;
  worker.scheduled(
    { cron: V2_RECOVERY_CRON },
    { RDS2_RECOVERY_ENABLED: "false" },
    { waitUntil(value) { scheduledWork = value; } }
  );
  assert.deepEqual(await scheduledWork, { outcome: "disabled", code: "recovery_disabled" });
});

test("T16 disabling new V2 query traffic does not alter the legacy surface", async () => {
  const { handleV2Request } = await import("../src/rds2/routes.js");
  const response = await handleV2Request(
    new Request("https://worker.example/v2/query", {
      method: "POST",
      body: JSON.stringify({ storageVersion: 2, operation: "capabilities", params: {} })
    }),
    { RDS2_QUERY_ENABLED: "false", RDS2_CURSOR_SECRET: "release-test-secret" },
    null,
    { principal: { userId: "11111111-1111-4111-8111-111111111111", username: "synthetic" } }
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "v2_query_disabled");
});

test("T16 local setup exposes an explicit v1/v2 write switch and never embeds credentials", () => {
  assert.match(SETUP, /ValidateSet\('v1',\s*'v2'\)/);
  assert.match(SETUP, /RELIABLE_DRIVE_SYNC_WRITE_VERSION/);
  assert.doesNotMatch(SETUP, /QSTASH_TOKEN\s*=|DRIVE_REFRESH_TOKEN\s*=|client_secret\s*=/i);
});

test("T16 local canary is explicit and rejects remote mode without required arguments", async () => {
  const canary = await import("../../../tools/reliable-drive-sync-mcp/rds2-canary.mjs");
  await assert.rejects(
    () => canary.runCanary({ argv: ["--remote"], env: {} }),
    (error) => error?.code === "remote_canary_arguments_required"
  );
});

test("T16 local canary never calls Drive or network when credentials and whitelist are supplied", async () => {
  const canary = await import("../../../tools/reliable-drive-sync-mcp/rds2-canary.mjs");
  let fetchCalls = 0;
  const result = await canary.runCanary({
    argv: ["--local"],
    env: {
      RDS2_CANARY_CREDENTIAL: "local-only-test-credential",
      RDS2_ALLOWED_USER_IDS: "synthetic-user"
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("network must not be called in local mode");
    }
  });
  assert.equal(result.mode, "local");
  assert.equal(result.outcome, "dry_run");
  assert.equal(fetchCalls, 0);
});

test("T16 local canary rejects missing credentials or an empty allowlist", async () => {
  const canary = await import("../../../tools/reliable-drive-sync-mcp/rds2-canary.mjs");
  await assert.rejects(
    () => canary.runCanary({ argv: ["--local"], env: {} }),
    (error) => error?.code === "canary_credentials_required"
  );
  await assert.rejects(
    () => canary.runCanary({
      argv: ["--local"],
      env: { RDS2_CANARY_CREDENTIAL: "credential", RDS2_ALLOWED_USER_IDS: " " }
    }),
    (error) => error?.code === "canary_allowlist_required"
  );
});

test("T16 remote canary refuses a user outside the explicit allowlist", async () => {
  const canary = await import("../../../tools/reliable-drive-sync-mcp/rds2-canary.mjs");
  await assert.rejects(
    () => canary.runCanary({
      argv: ["--remote"],
      env: {
        RDS2_CANARY_CREDENTIAL: "credential",
        RDS2_CANARY_URL: "https://worker.example",
        RDS2_CANARY_USER_ID: "user-a",
        RDS2_ALLOWED_USER_IDS: "user-b"
      }
    }),
    (error) => error?.code === "canary_user_not_allowed"
  );
});

test("T16 accepted V2 writes have no implicit V1 fallback", async () => {
  const canary = await import("../../../tools/reliable-drive-sync-mcp/rds2-canary.mjs");
  assert.equal(canary.resolveWritePath({ writeVersion: "v2", accepted: true }), "/v2/events");
  assert.throws(
    () => canary.resolveWritePath({ writeVersion: "v2", accepted: false, fallback: "v1" }),
    (error) => error?.code === "v2_write_fallback_forbidden"
  );
});

test("T16 runbook freezes the ten-step order and safe rollback boundary", () => {
  for (const queue of QUEUE_NAMES) assert.match(RUNBOOK, new RegExp(queue));
  assert.match(RUNBOOK, /powershell -File/);
  assert.doesNotMatch(RUNBOOK, /node\s+[^\r\n]*\.ps1/);
  for (const step of ["本地测试", "暗部署", "合成用户准备", "合成 canary", "单客户端 MCP 切换",
    "真实 algorithm canary", "其余领域", "Skill\/插件", "稳定观察", "二次确认关闭 V1"]) {
    assert.match(RUNBOOK, new RegExp(step));
  }
  assert.match(RUNBOOK, /不执行 `DROP TABLE`/);
  assert.match(RUNBOOK, /恢复上一部署版本并关闭 V2 功能开关/);
});

test("T16 routes both DLQ queue names through the authoritative DLQ handler", async () => {
  assert.match(ROUTES, /rds2-projection-dlq/);
  assert.match(ROUTES, /rds2-archive-dlq/);
  assert.match(ROUTES, /handleDlq/);
  const { handleV2Queue } = await import("../src/rds2/routes.js");
  const db = {
    prepare() {
      return { bind() {
        return { first: async () => ({ task_id: "dlq-completed", state: "completed" }) };
      } };
    }
  };
  const acknowledgements = [];
  const result = await handleV2Queue({
    queue: "rds2-projection-dlq",
    messages: [{ body: { taskId: "dlq-completed" }, ack() { acknowledgements.push("ack"); } }]
  }, {
    RDS2_PROJECTION_ENABLED: "true",
    DB: db,
    RDS2_PROJECTION_QUEUE: { send: async () => {} },
    RDS2_ARCHIVE_QUEUE: { send: async () => {} }
  });
  assert.equal(result.outcome, "noop");
  assert.deepEqual(acknowledgements, ["ack"]);
});

test("T16 queue consumers fail closed while their domain switch is disabled", async () => {
  const { handleV2Queue } = await import("../src/rds2/routes.js");
  const retries = [];
  const result = await handleV2Queue({
    queue: "rds2-projection",
    messages: [{ body: { taskId: "disabled" }, retry() { retries.push("retry"); } }]
  }, { RDS2_PROJECTION_ENABLED: "false" });
  assert.equal(result.outcome, "retry");
  assert.equal(result.code, "rds2_projection_enabled_disabled");
  assert.deepEqual(retries, ["retry"]);
});

test("T16 production archive consumers construct the budgeted V2 Drive client", () => {
  assert.match(ROUTES, /createArchiveClient/);
  assert.match(ROUTES, /RDS2_ARCHIVE_FOLDER_ID/);
  assert.match(ROUTES, /accessToken\(env, io\.fetch\)/);
});

test("T10 queue task rows with D1 snake_case columns select the real algorithm reducer", async () => {
  const { reducerForScope } = await import("../src/rds2/projection/registry.js");
  const { algorithmReducer } = await import("../src/rds2/projection/algorithm.js");
  assert.equal(
    reducerForScope({ namespace: "algorithm", projection_name: "learning" }),
    algorithmReducer
  );
});

test("V1 write gate defaults on and rejects legacy job ingress when disabled", async () => {
  assert.match(WRANGLER, /V1_WRITE_ENABLED\s*=\s*"true"/);
  const { createWorker } = await import("../src/index.js");
  const env = { V1_WRITE_ENABLED: "false", MCP_BEARER_TOKEN: "test-token" };
  const worker = createWorker(env, {
    repository: {},
    publisher: {},
    identityLookup: async () => ({ userId: "u-1", displayName: "test" })
  });
  for (const path of ["/v1/jobs"]) {
    const response = await worker.fetch(new Request(`https://worker.example${path}`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: "{}"
    }), env, null);
    assert.equal(response.status, 410, path);
    assert.deepEqual(await response.json(), { error: "v1_write_disabled" });
  }
});

test("V1 read identity remains available while legacy writes are disabled", async () => {
  const { createWorker } = await import("../src/index.js");
  const env = { V1_WRITE_ENABLED: "false", MCP_BEARER_TOKEN: "test-token" };
  const worker = createWorker(env, {
    repository: {},
    publisher: {},
    identityLookup: async () => ({ userId: "u-1", displayName: "test" })
  });
  const response = await worker.fetch(new Request("https://worker.example/v1/identity?username=test", {
    headers: { authorization: "Bearer test-token" }
  }), env, null);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    identity: { userId: "u-1", username: "test", verified: true }
  });
});

test("V1 sync callback remains reachable to drain accepted work after ingress closes", async () => {
  const { createWorker } = await import("../src/index.js");
  const env = {
    V1_WRITE_ENABLED: "false",
    SYNC_WORKER_URL: "https://worker.example/v1/sync",
    QSTASH_CURRENT_SIGNING_KEY: "test-key"
  };
  const worker = createWorker(env, { repository: {}, publisher: {} });
  const response = await worker.fetch(new Request("https://worker.example/v1/sync", {
    method: "POST", body: "{}"
  }), env, null);
  assert.equal(response.status, 489, "the callback still reaches signature validation");
});

test("full V1 retirement blocks all legacy routes and skips legacy cron", async () => {
  const { createWorker } = await import('../src/index.js');
  const env = { V1_RETIRED:'true' };
  const worker = createWorker(env,{repository:{},publisher:{}});
  for(const path of ['/v1/jobs','/v1/sync','/v1/identity','/v1/qstash/failure']) {
    const response = await worker.fetch(new Request(`https://test${path}`,{method:'POST',body:'{}'}),env,null);
    assert.equal(response.status,410);
    assert.deepEqual(await response.json(),{error:'v1_retired'});
  }
  worker.scheduled({cron:'*/5 * * * *'},env,{waitUntil(){throw new Error('legacy_cron_must_not_run');}});
});
