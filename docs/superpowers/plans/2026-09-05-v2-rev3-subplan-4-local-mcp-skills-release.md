# RDS2 Local MCP, Skills Contract, Canary and Release Runbook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以进程级环境变量（`RELIABLE_DRIVE_SYNC_WRITE_VERSION=v1|v2`，envelope 零改动）完成本地 MCP 的 V2 分流与读写契约，接线 Worker 三条 HTTP 路由与 canary 白名单，通过混沌测试，升级 `my-chatgpt-skills` 契约与文案，并固化十步发布与逐阶段回滚的 runbook。

**Architecture:** Bridge 侧 `configurationFromEnvironment()` 解析 `writeVersion`，`createService` 据此构造 V1 或 V2 DeliveryService；V2 下 `READ_ONLY_EVENTS` 五类读请求直发 `POST /v2/query`（不写本地 Outbox、不产生 business_event），写请求先持久化 `outbox-v2.sqlite` 再投 `POST /v2/events`；Worker 侧 `/v2/events`、`/v2/query`、`/v2/users/init` 分别受 `RDS2_EVENTS_ENABLED`、`RDS2_READS_ENABLED`、admin token 控制，ingress 另受 `RDS2_CANARY_NAMESPACES`（逗号白名单）与可选 `RDS2_CANARY_USER_IDS` 门控。

**Tech Stack:** Node ≥22、`node:sqlite`（outbox-v2）、既有 MCP stdio bridge 骨架、Node test runner、Cloudflare 环境变量（vars/secrets）。

**Spec:** 规格 §10（接口与回执）、§10.2（POST /v2/query）、§11（本地 Outbox V2 语义）、§17（凭据身份）、§19.2（十步发布）、§20 工作包 3/9/10。

## Global Constraints

- 前置门 G0 与提交规范同主索引；受保护路径同子计划 1（`stdio-bridge.mjs` 仅按 Task 4.1/4.2 的明确 diff 修改 `configurationFromEnvironment()` 与 `createService()` 的构造分支；`delivery-service.mjs` 与 `local-outbox.mjs` 不改，只 import 只读符号所在的既有行为作 parity 黑盒参照）。
- Skills 仓库路径固定：`C:\Users\27846\my-chatgpt-skills`；只允许修改 Task 4.7/4.8 列出的文件。
- 混沌与路由测试全部本地；Task 4.9 runbook 中任何远程命令（部署、迁移、Queue 创建、开关变更）仅作为文档内容，执行需乔炳源逐阶段授权。
- 每 Task 回滚：`git revert <本任务SHA>`；Skills 仓库侧为在其自身 git 仓库 revert。

## Interfaces

- **Consumes**：子计划 1 `shared/rds2-protocol.mjs`、accept-service、identity-init、credential-auth；子计划 2 引擎/调度；子计划 3 预算器；`delivery-service.mjs:4` 的 `READ_ONLY_EVENTS` 行为（黑盒参照）。
- **Produces**：`tools/reliable-drive-sync-mcp/read-write-split.mjs` 导出 `READ_ONLY_EVENT_TYPES`、`isReadOnlyEnvelope(envelope)`；`local-outbox-v2.mjs` 导出 `LocalOutboxV2`；`delivery-service-v2.mjs` 导出 `DeliveryServiceV2`；Worker `src/rds2/http-ingress.js` 导出 `handleV2Events(request, env)`；`src/rds2/http-query.js` 导出 `handleV2Query(request, env)`；`src/rds2/http-identity-init.js` 导出 `handleV2UsersInit(request, env)`。

---

### Task 4.1 环境变量分流（进程级，envelope 不变）

**Files:** Modify `tools/reliable-drive-sync-mcp/stdio-bridge.mjs`（仅 `configurationFromEnvironment()` 与 `createService()` 两处）；Test `tools/reliable-drive-sync-mcp/test/v2-config.test.mjs`
**Interfaces:** Consumes `stdio-bridge.mjs:98-106` 既有结构 | Produces `config.writeVersion`

- [ ] 1. 失败测试：
  ```js
  import { configurationFromEnvironmentForTest } from "../stdio-bridge.mjs";
  test("writeVersion defaults to v1", () => {
    const config = configurationFromEnvironmentForTest({});
    assert.equal(config.writeVersion, "v1");
  });
  test("RELIABLE_DRIVE_SYNC_WRITE_VERSION=v2 selects v2 and derives v2 outbox path", () => {
    const config = configurationFromEnvironmentForTest({ RELIABLE_DRIVE_SYNC_WRITE_VERSION: "v2", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" });
    assert.equal(config.writeVersion, "v2");
    assert.match(config.outboxPath, /outbox-v2\.sqlite$/);
  });
  test("invalid version value rejects at config time", () => {
    assert.throws(() => configurationFromEnvironmentForTest({ RELIABLE_DRIVE_SYNC_WRITE_VERSION: "v3" }), /invalid_write_version/);
  });
  test("explicit RELIABLE_DRIVE_SYNC_OUTBOX_PATH overrides v2 default", () => { /* 给定 v2 + 显式路径 → 原样使用 */ });
  ```
  `configurationFromEnvironmentForTest(envOverrides)` 为 `stdio-bridge.mjs` 新导出的纯函数（内部实现复用 `configurationFromEnvironment` 的逻辑，参数化 env 来源；主进程入口行为不变）。
- [ ] 2. 预期失败：导出不存在。
- [ ] 3. 修改 `stdio-bridge.mjs`（精确 diff 范围）：
  ```js
  function configurationFromEnvironment(env = process.env) {
    const configuredUrl = env.RELIABLE_DRIVE_SYNC_WORKER_URL ?? env.RELIABLE_DRIVE_SYNC_INGRESS_URL;
    const writeVersion = env.RELIABLE_DRIVE_SYNC_WRITE_VERSION ?? "v1";
    if (writeVersion !== "v1" && writeVersion !== "v2") throw new Error("invalid_write_version");
    const outboxPath = env.RELIABLE_DRIVE_SYNC_OUTBOX_PATH
      ?? (writeVersion === "v2" ? join(defaultOutboxBase(), "ReliableDriveSync", "outbox-v2.sqlite") : undefined);
    return { workerUrl: configuredUrl, token: env.RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET, outboxPath, writeVersion };
  }
  ```
  `defaultOutboxBase()` 抽取自现有 `defaultOutboxPath()` 的 base 三行（`stdio-bridge.mjs:40-45`），`defaultOutboxPath()` 改为 `join(defaultOutboxBase(), "ReliableDriveSync", "outbox.sqlite")` 保持 v1 默认路径逐字节不变；`configurationFromEnvironment` 调用点传 `process.env`；本 Task 的 `createService()` 在 `writeVersion === "v2"` 分支仅抛 `new Error("v2_delivery_not_wired")`（由本 Task 测试断言），真实 `DeliveryServiceV2` 构造接线在 Task 4.4 完成（其 `git add` 包含 `stdio-bridge.mjs` 的该行替换）。
- [ ] 4. 验证：`npm run test:bridge` 预期 `# fail 0`（新增 4 个用例通过，既有 47 个全绿——v1 路径未变）。
- [ ] 5. 提交：`git add tools/reliable-drive-sync-mcp/stdio-bridge.mjs tools/reliable-drive-sync-mcp/test/v2-config.test.mjs && git commit -m "feat(v2): env-based local write version switching"`。

### Task 4.2 读写分流契约（READ_ONLY_EVENTS 对齐）

**Files:** Create `tools/reliable-drive-sync-mcp/read-write-split.mjs`；Test `tools/reliable-drive-sync-mcp/test/v2-read-write-split.test.mjs`
**Interfaces:** Produces `READ_ONLY_EVENT_TYPES`, `isReadOnlyEnvelope` | Consumes V1 行为（黑盒 parity）

- [ ] 1. 失败测试：
  ```js
  import { READ_ONLY_EVENT_TYPES, isReadOnlyEnvelope } from "../read-write-split.mjs";
  test("readonly set matches v1 delivery behavior exactly", () => {
    assert.deepEqual([...READ_ONLY_EVENT_TYPES].sort(),
      ["interview.session.list", "interview.session.load", "profile.snapshot.read", "system.capabilities.read", "system.user.resolve"]);
  });
  test("dry-run legacy migration is readonly, non-dry-run is a write", () => {
    assert.equal(isReadOnlyEnvelope({ eventType: "system.legacy-migration-requested", payload: { mode: "dry-run" } }), true);
    assert.equal(isReadOnlyEnvelope({ eventType: "system.legacy-migration-requested", payload: { mode: "apply" } }), false);
  });
  test("black-box parity: v1 handleRequest routes the five read types without durable enqueue", async () => {
    // 用注入 fetch 假服务端跑 handleRequest(submitCall(...))：五类 eventType → fetch 命中 /v1/query 且 service 的 outbox 未建行
    // （service 以 options.service 注入桩，桩记录 submit/query 调用分支）
  });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  export const READ_ONLY_EVENT_TYPES = new Set([
    "interview.session.list", "interview.session.load",
    "system.capabilities.read", "system.user.resolve", "profile.snapshot.read"
  ]);
  export function isReadOnlyEnvelope(envelope) {
    return READ_ONLY_EVENT_TYPES.has(envelope?.eventType)
      || (envelope?.eventType === "system.legacy-migration-requested" && envelope?.payload?.mode === "dry-run");
  }
  ```
- [ ] 4. `npm run test:bridge` 预期 `# fail 0`。
- [ ] 5. 提交：`git add tools/reliable-drive-sync-mcp/read-write-split.mjs tools/reliable-drive-sync-mcp/test/v2-read-write-split.test.mjs && git commit -m "feat(v2): read write split contract with v1 parity"`。

### Task 4.3 local-outbox-v2（原子认领 + receipt 历史）

**Files:** Create `tools/reliable-drive-sync-mcp/local-outbox-v2.mjs`；Test `tools/reliable-drive-sync-mcp/test/v2-local-outbox.test.mjs`
**Interfaces:** Produces `LocalOutboxV2` | Consumes `node:sqlite`

- [ ] 1. 失败测试：
  ```js
  test("schema has request_id primary key, state, payload, minimal receipt history", async () => {
    const outbox = new LocalOutboxV2(tempPath());
    const cols = outbox.columns("local_outbox_v2");
    for (const c of ["request_id", "state", "payload_json", "attempt_count", "last_error_code", "last_receipt_json", "created_at", "updated_at"]) assert.ok(cols.includes(c), c);
  });
  test("enqueue reuses row for same request_id and same input", async () => { /* 两次 enqueue 同 id 同 payload → 1 行 */ });
  test("enqueue rejects same request_id with different input locally", async () => { /* 抛 request_id_conflict，不覆盖 */ });
  test("claimPending is atomic: markSending failure skips row in current flush", async () => { /* 注入 markSending 抛错 → flush 返回 0 条且行保持 pending */ });
  test("restart recovers sending to pending", async () => { /* 关闭实例重开 → state=pending */ });
  test("flushPending takes at most 20 rows", async () => { /* 25 行 → 20 */ });
  test("confirm clears payload but keeps minimal receipt", async () => { /* confirm 后 payload_json 为 NULL，last_receipt_json 非空 */ });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（核心 SQL）：
  ```js
  import { DatabaseSync } from "node:sqlite";
  export class LocalOutboxV2 {
    constructor(filePath) {
      this.db = new DatabaseSync(filePath);
      this.db.exec(`CREATE TABLE IF NOT EXISTS local_outbox_v2 (
        request_id TEXT PRIMARY KEY NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','sending','blocked','confirmed')),
        payload_json TEXT,
        input_fingerprint TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        last_receipt_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
    }
    enqueue(envelope) {
      const fingerprint = JSON.stringify([envelope.requestId, envelope.namespace, envelope.eventType, envelope.payload]);
      const existing = this.db.prepare("SELECT * FROM local_outbox_v2 WHERE request_id = ?").get(envelope.requestId);
      if (existing) {
        if (existing.input_fingerprint !== fingerprint) throw new Error("request_id_conflict");
        return existing;
      }
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO local_outbox_v2 (request_id, state, payload_json, input_fingerprint, created_at, updated_at) VALUES (?, 'pending', ?, ?, ?, ?)`)
        .run(envelope.requestId, JSON.stringify(envelope), fingerprint, now, now);
      return this.db.prepare("SELECT * FROM local_outbox_v2 WHERE request_id = ?").get(envelope.requestId);
    }
    claimPending(limit = 20) { /* 事务内 SELECT pending LIMIT ? → 逐行 UPDATE sending；markSending 注入点抛错则整批回滚 */ }
    markSending(requestId) { this.db.prepare("UPDATE local_outbox_v2 SET state='sending', attempt_count=attempt_count+1, updated_at=? WHERE request_id=? AND state='pending'").run(new Date().toISOString(), requestId); }
    block(requestId, code) { this.db.prepare("UPDATE local_outbox_v2 SET state='blocked', last_error_code=?, updated_at=? WHERE request_id=?").run(code, new Date().toISOString(), requestId); }
    requeue(requestId, code) { this.db.prepare("UPDATE local_outbox_v2 SET state='pending', last_error_code=?, updated_at=? WHERE request_id=? AND state='sending'").run(code, new Date().toISOString(), requestId); }
    confirm(requestId, receipt) {
      this.db.prepare("UPDATE local_outbox_v2 SET state='confirmed', payload_json=NULL, last_receipt_json=?, updated_at=? WHERE request_id=?")
        .run(JSON.stringify(receipt), new Date().toISOString(), requestId);
    }
    recoverSending() { this.db.prepare("UPDATE local_outbox_v2 SET state='pending', updated_at=? WHERE state='sending'").run(new Date().toISOString()); }
    flushPending(limit = 20) { /* claim → deliver → confirm/requeue/block；仅 deliveryState=cloud_accepted 或 status=already_recorded 走 confirm */ }
    columns(table) { return this.db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name); }
  }
  ```
- [ ] 4. `npm run test:bridge` 预期 `# fail 0`。
- [ ] 5. 提交：`git add tools/reliable-drive-sync-mcp/local-outbox-v2.mjs tools/reliable-drive-sync-mcp/test/v2-local-outbox.test.mjs && git commit -m "feat(v2): local outbox v2 with atomic claiming and receipt history"`。

### Task 4.4 delivery-service-v2（永久阻塞 + 有限退避 + 同 ID 重试）

**Files:** Create `tools/reliable-drive-sync-mcp/delivery-service-v2.mjs`；Modify `tools/reliable-drive-sync-mcp/stdio-bridge.mjs`（仅 `createService()` 的 v2 分支）；Test `tools/reliable-drive-sync-mcp/test/v2-delivery-service.test.mjs`
**Interfaces:** Produces `DeliveryServiceV2` | Consumes Task 4.2/4.3，`shared/rds2-protocol.mjs`

- [ ] 1. 失败测试：
  ```js
  test("write requests persist locally before any network call", async () => { /* fetch 计数 0 时行已存在 */ });
  test("read requests go to /v2/query and never touch outbox", async () => { /* 五类读 → POST /v2/query；库行数 0 */ });
  test("permanent id conflicts mark blocked and are not retried by the 30s sweep", async () => {
    // 服务端返回 409 request_id_conflict → confirm 不发生、state='blocked'；两次 flushPending 均跳过
  });
  test("already_recorded confirms with first receipt and clears payload", async () => { /* confirm 调用且 receipt.status==='already_recorded' */ });
  test("timeout/5xx/429 requeue with capped backoff", async () => {
    // 三种响应 → state='pending'；连续失败 6 次 → attempt_count 达 6 且 available_at 增量封顶于 600000ms（BACKOFF 序列 [30s,60s,120s,300s,600s,600s...]）
  });
  test("lost response after d1 commit: same three ids retry returns original receipt then confirms", async () => {
    // 第一次 fetch 抛网络错误；第二次返回相同 receipt → confirm 用该 receipt
  });
  test("every request carries the same requestId/eventId/eventKey on retry", async () => { /* 两次请求体三 ID 深相等 */ });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（分支核心，并在本 Task 完成与 `createService()` 的接线）：`stdio-bridge.mjs` 的 `createService()` 中 Task 4.1 的 `v2_delivery_not_wired` 分支替换为：
  ```js
  const { DeliveryServiceV2 } = await import("./delivery-service-v2.mjs");
  return new DeliveryServiceV2({ outbox: new LocalOutboxV2(options.outboxPath ?? defaultV2OutboxPath()), workerUrl: options.workerUrl, token: options.token, fetchImpl: options.fetchImpl });
  ```
  （`defaultV2OutboxPath()` 为 `stdio-bridge.mjs` 内新增小函数，逻辑与 Task 4.1 的 v2 默认路径推导一致。）
  ```js
  import { isReadOnlyEnvelope } from "./read-write-split.mjs";
  const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
  const capBackoff = (attempt) => BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  export class DeliveryServiceV2 {
    constructor({ outbox, workerUrl, token, fetchImpl = fetch }) { Object.assign(this, { outbox, workerUrl, token, fetchImpl }); }
    async submit(envelope) {
      if (isReadOnlyEnvelope(envelope)) return this.query(envelope);
      const row = this.outbox.enqueue(envelope);
      await this.flushOne(row.request_id);
      return this.latestResult(row.request_id);
    }
    async query(envelope) {
      const response = await this.fetchImpl(`${this.workerUrl}/v2/query`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(envelope)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error ?? `query_${response.status}`);
      return body;
    }
    async flushOne(requestId) { /* 单行：markSending → POST /v2/events（含全部三个 ID 原样）→ confirm / block / requeue */ }
    async flushPending() { const rows = this.outbox.claimPending(20); for (const row of rows) await this.flushOne(row.request_id); }
  }
  ```
- [ ] 4. `npm run test:bridge` 预期 `# fail 0`。
- [ ] 5. 提交：`git add tools/reliable-drive-sync-mcp/delivery-service-v2.mjs tools/reliable-drive-sync-mcp/stdio-bridge.mjs tools/reliable-drive-sync-mcp/test/v2-delivery-service.test.mjs && git commit -m "feat(v2): delivery service v2 with permanent blocking and capped backoff"`。

### Task 4.5 Bridge 五类读 + 写路径集成测试（子计划 4 本地完成门）

**Files:** Test `tools/reliable-drive-sync-mcp/test/v2-bridge-integration.test.mjs`
**Interfaces:** Consumes Task 4.1–4.4（经真实 `handleRequest` + 注入 fetch）

- [ ] 1. 失败测试（七块）：
  ```js
  const READ_CASES = [
    ["capabilities read",  { schemaVersion: "1.2", namespace: "system", eventType: "system.capabilities.read", requestId: "r-cap", payload: {} }],
    ["user resolve",       { schemaVersion: "1.2", namespace: "system", eventType: "system.user.resolve", requestId: "r-ur", payload: { displayName: "乔炳源" } }],
    ["profile snapshot",   { schemaVersion: "1.2", namespace: "profile", eventType: "profile.snapshot.read", requestId: "r-ps", payload: { domain: "backend" } }],
    ["session list",       { schemaVersion: "1.2", namespace: "interview", eventType: "interview.session.list", requestId: "r-sl", payload: {} }],
    ["session load",       { schemaVersion: "1.2", namespace: "interview", eventType: "interview.session.load", requestId: "r-ld", payload: { sessionId: "s1" } }]
  ];
  for (const [name, envelope] of READ_CASES) {
    test(`${name} goes to /v2/query and creates no outbox row under writeVersion=v2`, async () => {
      // env writeVersion=v2 + 注入 fetch 记录 URL → 断言 URL 以 /v2/query 结尾；临时 outbox-v2.sqlite 行数 0 且文件不存在（惰性）
    });
  }
  test("event status read via submit_event reaches /v2/query scope=event_status", async () => { /* eventType=profile.snapshot.read 变体或专用查询 envelope → scope 字段断言 */ });
  test("write under writeVersion=v2 persists locally before POST /v2/events", async () => { /* algorithm.learning.completed → 先有行后 fetch；URL 以 /v2/events 结尾 */ });
  test("reads never produce business events on the wire", async () => { /* 假服务端断言收到的 body eventType ∈ READ_ONLY_EVENT_TYPES */ });
  ```
  `event status` 读的 envelope 形态冻结为：`{schemaVersion:"1.2", namespace:"profile", eventType:"profile.snapshot.read", payload:{ domain:"backend", scope:"event_status", requestId:"r-1" }}`——`handleV2Query`（Task 4.6）按 `payload.scope` 分支。
- [ ] 2. 预期失败：路由未分流或 Outbox 误建行。
- [ ] 3. 修复落点：`delivery-service-v2.submit` 的读分支（不得改 `stdio-bridge.mjs` 以外的 V1 文件）。
- [ ] 4. `npm run test:bridge` 预期 `# fail 0`（47 + 本 Task 全部通过）。
- [ ] 5. 提交：`git add tools/reliable-drive-sync-mcp/test/v2-bridge-integration.test.mjs && git commit -m "test(v2): bridge read write integration under v2 mode"`。

### Task 4.6 Worker 三路由接线 + canary 白名单

**Files:** Create `src/rds2/http-ingress.js`、`src/rds2/http-query.js`、`src/rds2/http-identity-init.js`；Modify `src/index.js`（fetch 路由追加三行 + 装配）；Test `test/rds2-http-ingress.test.js`、`test/rds2-http-query.test.js`、`test/rds2-http-identity-init.test.js`、`test/worker-routes.test.js`（追加开关断言）
**Interfaces:** Consumes 子计划 1 服务层 + Task 3.2 预算器

- [ ] 1. 失败测试（ingress）：
  ```js
  test("auth derives user from credential, body identity is consistency-check only", async () => {
    // 凭据 A 提交 identity.userId=B → 403 identity_mismatch
    // 无凭据 → 401 unauthorized；admin token 调 ingress → 401 unauthorized（权限分离）
  });
  test("request size > 1 MiB and malformed json rejected", async () => { /* 413 / 400 invalid_json */ });
  test("canary allowlist gates namespace and optional user ids", async () => {
    // RDS2_CANARY_NAMESPACES="algorithm"：interview 事件 → 503 namespace_not_enabled
    // RDS2_CANARY_USER_IDS="u-1"：凭据映射到 u-2 → 503 user_not_canary
  });
  test("accepted response is the durable receipt and one wake is published", async () => { /* receipt 结构断言 + 假队列 send 计数 1 */ });
  test("queue publish failure still returns accepted", async () => { /* send 抛错 → 200 receipt（恢复器兜底） */ });
  ```
- [ ] 2. 失败测试（query）：
  ```js
  test("projection read is identity-bound to the credential user", async () => { /* A 查 B 的 namespace+userId → 403 identity_mismatch */ });
  test("event_status only returns rows owned by the credential user", async () => { /* 他人 requestId → 404 event_not_found（不泄露存在性） */ });
  test("admin token cannot read projections", async () => { /* admin token → 401 unauthorized */ });
  ```
- [ ] 3. 失败测试（identity-init 路由）：admin token 错误 → 403；成功 → 201 + 一次性凭据；普通用户凭据调用 → 401。`env.RDS2_ADMIN_TOKEN` 与请求 `authorization` 全等比较，比较前不记录 token。
- [ ] 4. 失败测试（routes/开关）：
  ```js
  test("three routes gated by feature vars", async () => {
    // RDS2_EVENTS_ENABLED/RDS2_READS_ENABLED 非 "true" → 503 rds2_disabled
    // V1 路由响应快照：/v1/sync 与 /v1/qstash/failure 在同一 env 下行为与改造前一致（既有 worker-routes 断言保持绿）
  });
  ```
- [ ] 5. 预期失败：404（路由不存在）。
- [ ] 6. 实现（三文件 + index.js 追加）：
  ```js
  // src/rds2/http-ingress.js（核心顺序 = 规格 §10.1 八步）
  export function handleV2Events(buildDeps) {
    return async function (request, env) {
      if (env.RDS2_EVENTS_ENABLED !== "true") return json(503, { error: "rds2_disabled" });
      const budget = createBudget(10);
      const size = Number(request.headers.get("content-length") ?? "0");
      if (size > 1_048_576) return json(413, { error: "payload_too_large" });
      let envelope;
      try { envelope = await request.json(); } catch { return json(400, { error: "invalid_json" }); }
      try {
        validateEnvelope(envelope);
        const user = await authenticateUser(env.DB, request.headers.get("authorization") ?? "");
        if (envelope.identity?.userId && envelope.identity.userId !== user.user_id) return json(403, { error: "identity_mismatch" });
        const canary = (env.RDS2_CANARY_NAMESPACES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        const canaryUsers = (env.RDS2_CANARY_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (canary.length && !canary.includes(envelope.namespace)) return json(503, { error: "namespace_not_enabled" });
        if (canaryUsers.length && !canaryUsers.includes(user.user_id)) return json(503, { error: "user_not_canary" });
        const receipt = await createAcceptService(env.DB, buildDeps(env))(envelope, user, { canaryNamespaces: canary.length ? canary : null });
        if (receipt.status === "already_recorded") return json(200, receipt);
        try { await buildQueueIo(env).sendWake(receipt.taskId, "project_event", 0); } catch { /* 恢复器兜底 */ }
        emitBudgetSnapshot(budget, "ingress");
        return json(200, receipt);
      } catch (cause) {
        return json(errorStatus(cause), { error: cause.code ?? cause.message });
      }
    };
  }
  ```
  `handleV2Query`（鉴权 → scope 分支 → 仅本用户数据）、`handleV2UsersInit`（admin 全等比较 → init 服务）按同风格实现；`index.js` fetch 追加：
  ```js
  if (request.method === "POST" && path === "/v2/events") return handleV2Events(buildDeps)(request, env);
  if (request.method === "POST" && path === "/v2/query") return handleV2Query(buildDeps)(request, env);
  if (request.method === "POST" && path === "/v2/users/init") return handleV2UsersInit(buildDeps)(request, env);
  ```
- [ ] 7. `npm run test:worker` 预期 `# fail 0`。
- [ ] 8. 提交：`git add services/reliable-drive-sync-worker/src/rds2/http-ingress.js services/reliable-drive-sync-worker/src/rds2/http-query.js services/reliable-drive-sync-worker/src/rds2/http-identity-init.js services/reliable-drive-sync-worker/src/index.js services/reliable-drive-sync-worker/test/rds2-http-ingress.test.js services/reliable-drive-sync-worker/test/rds2-http-query.test.js services/reliable-drive-sync-worker/test/rds2-http-identity-init.test.js services/reliable-drive-sync-worker/test/worker-routes.test.js && git commit -m "feat(v2): wire three v2 routes behind flags and canary allowlist"`。

### Task 4.7 混沌与故障恢复套件

**Files:** Test `services/reliable-drive-sync-worker/test/rds2-chaos.test.js`
**Interfaces:** Consumes 全部既有实现

- [ ] 1. 失败测试（规格 §16 表逐行，十块）：
  ```js
  test("local row survives restart", async () => { /* LocalOutboxV2 重开 → pending */ });
  test("d1 committed but response lost: retry returns original receipt, no second event", async () => { /* */ });
  test("event accepted, queue publish failed: recovery republishes", async () => { /* */ });
  test("queue duplicate and reorder: cursor keeps single business effect", async () => { /* */ });
  test("projection half-failure rolls back atomically", async () => { /* */ });
  test("crash after projection commit before ack: duplicate consume is a no-op", async () => { /* */ });
  test("drive upload succeeded but response lost: exact lookup reuses file by hash", async () => { /* */ });
  test("drive long outage: events and projections stay valid, deliveries retry then needs_attention", async () => { /* */ });
  test("same name different content is blocked without overwrite", async () => { /* */ });
  test("budget exhaustion mid-batch releases unclaimed leases leaving recoverable tasks", async () => { /* */ });
  ```
- [ ] 2. 预期失败：按行定位实现缺口；每行修复独立 commit，commit 消息依次取：`fix(v2): chaos local-row-restart`、`fix(v2): chaos d1-commit-response-lost`、`fix(v2): chaos queue-publish-failed`、`fix(v2): chaos queue-duplicate-reorder`、`fix(v2): chaos projection-half-failure`、`fix(v2): chaos crash-before-ack`、`fix(v2): chaos drive-response-lost`、`fix(v2): chaos drive-long-outage`、`fix(v2): chaos same-name-diff-content`、`fix(v2): chaos budget-exhaustion-release`。
- [ ] 3. `npm run test:worker` 与 `npm run test:bridge` 双绿。
- [ ] 4. 提交：`git add services/reliable-drive-sync-worker/test/rds2-chaos.test.js && git commit -m "test(v2): chaos and failure recovery suite"`。

### Task 4.8 Skills 契约盘点与文案修订（仓库 `C:\Users\27846\my-chatgpt-skills`）

**Files:** Create（主仓）`docs/superpowers/plans/v2-skill-contract-inventory.md`；Modify（skills 仓）`AGENTS.md`、五个 skill 的 `SKILL.md`（精确路径：`C:\Users\27846\my-chatgpt-skills\algorithm-learning\SKILL.md`、`C:\Users\27846\my-chatgpt-skills\backend-project-learning\SKILL.md`、`C:\Users\27846\my-chatgpt-skills\conducting-java-backend-mock-interviews\SKILL.md`、`C:\Users\27846\my-chatgpt-skills\java-knowledge-based-on-resume-learn-skill\SKILL.md`、`C:\Users\27846\my-chatgpt-skills\reviewing-java-backend-interviews\SKILL.md`）、`tests/` 内五个契约测试文件（精确路径：`tests\algorithm-learning.v2-contract.test.mjs`、`tests\backend-project-learning.v2-contract.test.mjs`、`tests\conducting-java-backend-mock-interviews.v2-contract.test.mjs`、`tests\java-knowledge-based-on-resume-learn-skill.v2-contract.test.mjs`、`tests\reviewing-java-backend-interviews.v2-contract.test.mjs`）
**Interfaces:** Consumes 规格 §21.3 三状态语义 | Produces inventory 文档 + 文案 + 测试

- [ ] 1. 只读盘点：`grep -rn "Drive\|同步\|快照\|snapshot\|cloud_accepted" C:\Users\27846\my-chatgpt-skills --include="*.md" -l` 逐文件列出命中行，写入 inventory 文档并冻结（inventory 属主仓 docs，独立提交）。
- [ ] 2. 提交：主仓 `git add docs/superpowers/plans/v2-skill-contract-inventory.md && git commit -m "docs(v2): skill contract inventory"`。
- [ ] 3. 失败测试先行（skills 仓 `tests/`）：每个契约测试断言对应 `SKILL.md` 文案（a）包含 `cloud_accepted`、`projection completed`、`Drive delivered` 三态中它实际使用的状态的准确定义；（b）不含把 `cloud_accepted` 描述为“Drive 已同步”或“快照已更新”的句子（正则 `/cloud_accepted[^。]*已同步|cloud_accepted[^。]*快照已更新/` 零命中）；（c）读取指引指向 `submit_event` 的读事件（不引导用户扫 Drive）。
- [ ] 4. 文案修订：五个 `SKILL.md` 按 inventory 逐处替换；`AGENTS.md` 增补 V2 语义小节（三状态定义、`RELIABLE_DRIVE_SYNC_WRITE_VERSION=v2` 切换与回退说明：v2 模式下 envelope 不变、Skill 无需新增协议字段、回退改回 v1 即恢复 V1 路径）。
- [ ] 5. 验证：skills 仓 `node --test tests/*.v2-contract.test.mjs` 预期 0 失败；主仓 `npm test` 保持双绿（无跨仓影响）。
- [ ] 6. 提交（skills 仓，五组独立提交，逐一执行）：
  ```bash
  git add algorithm-learning/SKILL.md tests/algorithm-learning.v2-contract.test.mjs && git commit -m "feat(skills): v2 delivery semantics for algorithm-learning"
  git add backend-project-learning/SKILL.md tests/backend-project-learning.v2-contract.test.mjs && git commit -m "feat(skills): v2 delivery semantics for backend-project-learning"
  git add conducting-java-backend-mock-interviews/SKILL.md tests/conducting-java-backend-mock-interviews.v2-contract.test.mjs && git commit -m "feat(skills): v2 delivery semantics for conducting-java-backend-mock-interviews"
  git add java-knowledge-based-on-resume-learn-skill/SKILL.md tests/java-knowledge-based-on-resume-learn-skill.v2-contract.test.mjs && git commit -m "feat(skills): v2 delivery semantics for java-knowledge-based-on-resume-learn-skill"
  git add reviewing-java-backend-interviews/SKILL.md tests/reviewing-java-backend-interviews.v2-contract.test.mjs && git commit -m "feat(skills): v2 delivery semantics for reviewing-java-backend-interviews"
  git add AGENTS.md && git commit -m "docs(skills): v2 semantics and env switch guide"
  ```
- 回滚：skills 仓逐 commit `git revert`；主仓 inventory 保留（纯文档）。

### Task 4.9 插件重装与十步发布 runbook（文档 + 可验证命令）

**Files:** Create（主仓）`docs/superpowers/plans/v2-release-runbook.md`；Test（主仓）`services/reliable-drive-sync-worker/test/rds2-runbook-config.test.js`
**Interfaces:** Consumes 全部开关名 | Produces runbook 文档

- [ ] 1. 失败测试（runbook 配置一致性，文档即契约）：
  ```js
  test("runbook references exactly the implemented env vars", () => {
    const runbook = readFileSync(new URL("../../../docs/superpowers/plans/v2-release-runbook.md", import.meta.url), "utf8");
    for (const v of ["RDS2_EVENTS_ENABLED", "RDS2_READS_ENABLED", "RDS2_PROJECT_ENABLED", "RDS2_ARCHIVE_ENABLED", "RDS2_RECOVERY_ENABLED", "RDS2_CANARY_NAMESPACES", "RDS2_CANARY_USER_IDS", "RELIABLE_DRIVE_SYNC_WRITE_VERSION"]) assert.match(runbook, new RegExp(v));
    for (const step of ["暗部署", "合成用户", "单客户端", "algorithm", "一周", "二次确认"]) assert.match(runbook, new RegExp(step));
  });
  ```
- [ ] 2. runbook 内容（十步 = 规格 §19.2，每步四列）：
  | 步 | 进入条件 | 动作与命令（需授权） | 退出条件与回滚 |
  |---|---|---|---|
  | 1 本地测试 | 子计划 1–4 全绿 | `npm test`；`npx wrangler deploy --config services/reliable-drive-sync-worker/wrangler.toml --dry-run --outdir "$PWD/services/reliable-drive-sync-worker/tmp-dryrun-runbook"` 后删除该目录 | 全绿；无回滚需求 |
  | 2 暗部署 | Codex 三审通过 + 乔炳源授权 | `npx wrangler deploy`（所有 RDS2_* 开关缺省=false） | V1 指标无回归；回滚 `npx wrangler rollback` |
  | 3 合成用户 | 步骤 2 观察 24h | admin 调 `POST /v2/users/init`（RDS2_ADMIN_TOKEN 经 secret 注入） | 返回 userId+凭据；回滚无需（幂等） |
  | 4 合成 canary | 步骤 3 完成 | 凭据直连 `POST /v2/events`（algorithm）→ 等 `*/5` 恢复器或临时开 `RDS2_PROJECT_ENABLED` → 验证 `POST /v2/query` 与 Drive V2 目录 | 全链路 + 预算指标 ≤ 上限 + DLQ 空；回滚关开关 + rollback |
  | 5 单客户端 MCP 切换 | 步骤 4 观察 ≥48h 零 needs_attention | 用户本机设 `RELIABLE_DRIVE_SYNC_WRITE_VERSION=v2` + 用户凭据；V1 pending 行逐条确认处理 | 一周无阻塞行；回退改回 v1（outbox-v2.sqlite 保留） |
  | 6 真实 algorithm canary | 步骤 5 完成 | `RDS2_CANARY_NAMESPACES=algorithm`（vars 变更需重新部署生效） | 画像内容与用户核对一致；回滚清空白名单 |
  | 7 其他域逐个 | 步骤 6 每域独立观察 | 白名单逐域追加 `interview`,`profile`,`resume-knowledge` | 退出：每域抽检一致；回滚：清空白名单恢复 algorithm-only，再 rollback |
  | 8 Skill/插件生效 | 步骤 7 全绿 | skills 仓已提交文案 + 插件重装流程执行 | 契约测试绿；回滚 revert + 重装旧版 |
  | 9 稳定观察 ≥1 周 | 步骤 8 | 每日检查 needs_attention/DLQ/预算快照 | 零 P1 |
  | 10 关闭 V1/QStash | 步骤 9 + 乔炳源二次独立确认 | 停 V1 写入（移除 QStash 调度） | **单向动作，无自动回滚** |
- [ ] 3. 插件重装说明写入 runbook 附录：`setup-local-clients.ps1` 环境变量清单（`RELIABLE_DRIVE_SYNC_WORKER_URL`、`RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET`=用户凭据、`RELIABLE_DRIVE_SYNC_WRITE_VERSION`、`RELIABLE_DRIVE_SYNC_OUTBOX_PATH_V2` 可选）。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add docs/superpowers/plans/v2-release-runbook.md services/reliable-drive-sync-worker/test/rds2-runbook-config.test.js && git commit -m "docs(v2): ten-step release runbook with per-stage rollback"`。

### Task 4.10 回滚演练验证（本地可执行部分）

**Files:** Test `tools/reliable-drive-sync-mcp/test/v2-rollback-drill.test.mjs`、`services/reliable-drive-sync-worker/test/rds2-rollback-drill.test.js`
**Interfaces:** Consumes Task 4.1–4.6

- [ ] 1. 失败测试（四块，全部本地）：
  ```js
  test("writeVersion v2→v1 switch: v1 service unchanged and v2 rows untouched", async () => { /* 同进程内两种 config 构造服务，互不读写对方库文件 */ });
  test("feature flags off: three v2 routes return 503 and v1 routes byte-identical", async () => { /* 快照断言 */ });
  test("outbox-v2 blocked rows survive mode switch and can be re-driven after re-enable", async () => { /* */ });
  test("wrangler dry-run passes with all flags absent (dark-deploy shape)", () => { /* execSync dry-run 退出码 0；断言后清理临时目录 */ });
  ```
- [ ] 2. 预期失败 → 按块修复（独立 commit 注明块名）。
- [ ] 3. `npm test` 双绿（子计划 4 本地完成门）。
- [ ] 4. 提交：`git add tools/reliable-drive-sync-mcp/test/v2-rollback-drill.test.mjs services/reliable-drive-sync-worker/test/rds2-rollback-drill.test.js && git commit -m "test(v2): local rollback drills"`。

## 覆盖与自检（子计划 4 完成门 = Rev 3 全局完成门）

- [ ] 规格映射：§10.1（4.6 ingress 八步断言）、§10.2（4.6 query）、§11 全条（4.1–4.4）、§16（4.7 十行）、§19.2 十步（4.9）、§21.3 三状态（4.8）。
- [ ] 全局自检执行并记录：①规格 §20/§21/§22 逐条映射表见主索引；②`grep -rn "TODO\|TBD\|同上\|参考前文\|必要修复\|补全逻辑\|如有问题\|<tmp>\|<dataDir>\|<skill>" docs/superpowers/plans/*rev3*.md src/ test/ ../tools/`（占位符模式行除外）零命中；③`task_id`/`stale_projection_write`/`business_dedupe_key`/`namespace_not_enabled` 等跨文件命名一致（grep 核对）；④七入口预算证明齐（子计划 3 Task 3.6）；⑤Queue 无 message-ID 依赖（子计划 2 完成门）；⑥四 DLQ 消费者（子计划 2 Task 2.4）；⑦readAfter 带范围（子计划 1 Task 1.10）；⑧凭据身份（子计划 1 Task 1.9 + 子计划 4 Task 4.6）；⑨四域非单调状态（子计划 2 Task 2.10–2.12）；⑩发布顺序与规格 §19.2 十步一致（Task 4.9 测试锁定）。
