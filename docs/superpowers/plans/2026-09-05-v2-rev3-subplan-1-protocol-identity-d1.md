# RDS2 Protocol, Identity and D1 Data Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立共享 V2 协议模块（单一事实源）、六张 `rds2_*` 表（五业务表 + 凭据表）的迁移与仓库层、真实 SQL 的原子接收服务、凭据映射身份体系，以及 Miniflare 真 D1 集成测试。

**Architecture:** `shared/rds2-protocol.mjs` 被 Worker（Wrangler 打包）与 Bridge（Node ESM）共同引用；仓库层面向 D1 语义薄接口（`prepare/bind/run/all/first/batch`），本地用 `node:sqlite` 快速适配器做单元测试，用 Miniflare 真 binding 做集成测试；原子接收用一个 D1 batch 的 INSERT + INSERT...SELECT 完成，`event_seq` 由 SQL 内派生出确定性 `taskId`；身份授权 = Bearer 凭据哈希查 `rds2_credentials` 派生 userId。

**Tech Stack:** Node ≥22 内置 test runner；`node:sqlite`（单元级）；`miniflare` devDependency（集成级）；Wrangler 4 `--dry-run` 打包门。零运行时依赖。

**Spec:** 上位规格 §7.2（Rev 3：CHECK 约束、business_dedupe_key、CAS 触发器、rds2_credentials）、§9（三 ID 矩阵）、§10.1（接收八步）、§17（凭据映射）。

## Global Constraints

- 前置门 G0（主索引）：先确认 worktree 状态；本计划残留经用户确认后处理；用户未跟踪文件不删不改不提交。
- 受保护路径（本计划全部 Task 禁改）：`migrations/0005_schema12_jobs.sql`、`src/ingress.js`、`src/dispatcher.js`、`src/sync.js`、`src/event-store.js`、`src/qstash.js`、`src/reconciler.js`、所有 V1 store/model、`tools/reliable-drive-sync-mcp/local-outbox.mjs`、`tools/reliable-drive-sync-mcp/delivery-service.mjs`。`src/protocol.js` 只读（parity 测试引用，不修改）。
- 所有测试命令在 worktree `C:\Users\27846\my-chatgpt-mcp-v2` 执行；每 Task 结束 `git status --short` 只允许出现该 Task 文件。
- 提交规范：`git add` 只加本 Task 文件清单；消息前缀 `feat(v2):`/`test(v2):`/`chore(v2):`；禁止 `git add -A`、`reset --hard`、`checkout --`、`stash drop`。
- 每 Task 回滚方式相同：`git revert <本任务SHA>`；因所有提交相互独立且只增文件，revert 无连锁影响。

## Interfaces

- **Produces**（后续子计划消费）：`shared/rds2-protocol.mjs` 导出 `canonicalJson(value)`、`sha256Hex(text)`、`validateEnvelope(envelope)`、`resolveIntent(lookups, incoming)`、`durableReceipt(fields)`、`ERROR_CODES`、`deriveDedupeKey(eventType, payload, userId)`；`src/rds2/sqlite-adapter.js` 导出 `createSqliteAdapter(filePath)`（D1 语义）；`src/rds2/*-repository.js` 各导出工厂 `createXxxRepository(db)`；`src/rds2/accept-service.js` 导出 `createAcceptService(db, deps)`；`src/rds2/credential-auth.js` 导出 `authenticateUser(db, bearerToken)`；`migrations/0006_rds2_v2_tables.sql`。
- **Consumes**：`src/protocol.js`（parity 金样本只读）、`node:sqlite`、`miniflare`。

---

### Task 1.1 共享协议模块：规范 JSON 与哈希

**Files:** Create `shared/rds2-protocol.mjs`；Test `services/reliable-drive-sync-worker/test/rds2-protocol.test.js`
**Interfaces:** Produces `canonicalJson`, `sha256Hex` | Consumes `crypto.subtle`

- [ ] 1. 写失败测试 `services/reliable-drive-sync-worker/test/rds2-protocol.test.js`：
  ```js
  import assert from "node:assert/strict";
  import test from "node:test";
  import { canonicalJson, sha256Hex } from "../../../shared/rds2-protocol.mjs";

  test("canonicalJson is key-order independent", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }),
                 canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  });
  test("sha256Hex is stable and hex", async () => {
    const h1 = await sha256Hex("abc");
    const h2 = await sha256Hex("abc");
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.equal(h1, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  ```
- [ ] 2. 运行 `npm run test:worker 2>&1 | tail -4`，预期 `# fail 1`，失败信息含 `Cannot find module` 或 `sha256Hex` 未导出。
- [ ] 3. 最小实现 `shared/rds2-protocol.mjs`：
  ```js
  export function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
      const keys = Object.keys(value).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  }
  export async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  ```
- [ ] 4. 运行 `npm run test:worker 2>&1 | tail -4`，预期 `# fail 0` 且 `# pass 380` 起步（新增 2 个）。
- [ ] 5. 提交：`git add shared/rds2-protocol.mjs services/reliable-drive-sync-worker/test/rds2-protocol.test.js && git commit -m "feat(v2): shared canonical json and sha256"`。

### Task 1.2 envelope 完整校验器 + V1 parity 金样本

**Files:** Modify `shared/rds2-protocol.mjs`；Test 同 Task 1.1 文件追加
**Interfaces:** Produces `validateEnvelope`, `ProtocolError`, `ERROR_CODES` | Consumes `protocol.js` 只读语义

- [ ] 1. 追加失败测试：六字段白名单外字段 → `invalid_envelope_field`；namespace 非白名单 → `invalid_namespace`；`eventType.split(".")[0] !== namespace` → `namespace_event_type_mismatch`；`schemaVersion !== "1.2"` → `invalid_schema_version`；`algorithm.learning.completed` 缺 `payload.event.eventId/eventKey/topic/observedAt` → `invalid_payload`；内外 eventType 不一致 → `invalid_payload`。每组一个 `assert.throws(..., /error_code/)`。
- [ ] 2. 运行 `npm run test:worker 2>&1 | tail -4`，预期新增用例全部 `fail`，错误含 `validateEnvelope is not a function`。
- [ ] 3. 实现（对齐 `protocol.js:6/27/371-377` 语义，不 import V1 文件）：
  ```js
  export const ERROR_CODES = {
    invalid_envelope_field: "invalid_envelope_field", invalid_namespace: "invalid_namespace",
    namespace_event_type_mismatch: "namespace_event_type_mismatch",
    invalid_schema_version: "invalid_schema_version", invalid_payload: "invalid_payload",
    request_id_conflict: "request_id_conflict", event_id_conflict: "event_id_conflict",
    event_key_already_recorded: "event_key_already_recorded", identity_mismatch: "identity_mismatch",
    identity_not_found: "identity_not_found", user_disabled: "user_disabled",
    unauthorized: "unauthorized", forbidden: "forbidden", namespace_not_enabled: "namespace_not_enabled"
  };
  export class ProtocolError extends Error { constructor(code) { super(code); this.code = code; } }
  const ENVELOPE_FIELDS = new Set(["schemaVersion", "namespace", "eventType", "identity", "payload", "requestId"]);
  const NAMESPACES = new Set(["system", "algorithm", "interview", "resume-knowledge", "profile"]);
  export function validateEnvelope(envelope) {
    if (!envelope || typeof envelope !== "object") throw new ProtocolError("invalid_payload");
    for (const key of Object.keys(envelope)) if (!ENVELOPE_FIELDS.has(key)) throw new ProtocolError("invalid_envelope_field");
    if (envelope.schemaVersion !== "1.2") throw new ProtocolError("invalid_schema_version");
    if (!NAMESPACES.has(envelope.namespace)) throw new ProtocolError("invalid_namespace");
    if (envelope.eventType.split(".")[0] !== envelope.namespace) throw new ProtocolError("namespace_event_type_mismatch");
    if (typeof envelope.requestId !== "string" || !envelope.requestId.trim()) throw new ProtocolError("invalid_payload");
    const event = envelope.payload?.event;
    if (envelope.eventType === "algorithm.learning.completed") {
      if (!event || event.eventType !== envelope.eventType || typeof event.eventId !== "string"
        || typeof event.eventKey !== "string" || typeof event.topic !== "string"
        || typeof event.observedAt !== "string") throw new ProtocolError("invalid_payload");
    }
    return envelope;
  }
  ```
- [ ] 4. 追加 parity 金样本测试 `test/rds2-protocol-parity.test.js`：从 `protocol.js` 与 shared 校验器分别跑同一组 12 个金样本 envelope（6 合法 6 非法），断言二者“合法/非法”结论一致（不比较错误文案）。运行预期 `# fail 0`；若出现不一致，停止并上报差异样本（halt-and-report，不得改 V1）。
- [ ] 5. 提交：`git add shared/rds2-protocol.mjs services/reliable-drive-sync-worker/test/rds2-protocol.test.js services/reliable-drive-sync-worker/test/rds2-protocol-parity.test.js && git commit -m "feat(v2): shared envelope validator with v1 parity samples"`。

### Task 1.3 三查询意图判定 resolveIntent

**Files:** Modify `shared/rds2-protocol.mjs`；Test 同 1.1 文件追加
**Interfaces:** Produces `resolveIntent(lookups, incoming)` | Consumes `canonicalJson/sha256Hex`

- [ ] 1. 失败测试：`lookups = { byRequestId, byEventId, byEventKey }`（命中行含 `envelope_hash`）与 `incoming = { envelopeHash }` 的五分支矩阵：三行全空 → `{kind:"new_event"}`；`byRequestId` 哈希同 → `{kind:"exact_retry", requestId:true}`；`byRequestId` 哈希异 → `{kind:"conflict", code:"request_id_conflict"}`；`byEventId` 哈希异 → `{code:"event_id_conflict"}`；`byEventKey` 存在且其 `event_id !== incoming.eventId` → `{kind:"already_recorded", firstReceiptSource:"byEventKey"}`；优先级：conflict > already_recorded > exact_retry。
- [ ] 2. 预期失败：`resolveIntent is not a function`。
- [ ] 3. 实现：
  ```js
  export function resolveIntent(lookups, incoming) {
    const req = lookups.byRequestId, evt = lookups.byEventId, key = lookups.byEventKey;
    if (req && req.envelope_hash !== incoming.envelopeHash) return { kind: "conflict", code: "request_id_conflict" };
    if (evt && evt.envelope_hash !== incoming.envelopeHash) return { kind: "conflict", code: "event_id_conflict" };
    if (req && evt && key) return { kind: "exact_retry", event: req };
    if (key && key.event_id !== incoming.eventId) return { kind: "already_recorded", first: key };
    if (req) return { kind: "exact_retry", event: req };
    return { kind: "new_event" };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add shared/rds2-protocol.mjs services/reliable-drive-sync-worker/test/rds2-protocol.test.js && git commit -m "feat(v2): three-lookup intent resolution"`。

### Task 1.4 durable receipt 构造器

**Files:** Modify `shared/rds2-protocol.mjs`；Test 同文件追加
**Interfaces:** Produces `durableReceipt` | Consumes 无

- [ ] 1. 失败测试：`durableReceipt({requestId,eventId,eventKey,eventSeq:101,taskId:"t_project_101"})` 返回对象含 `status:"accepted"`、`deliveryState:"cloud_accepted"`、`persistence:{localOutbox:"acknowledged",eventLedger:"accepted",projection:"pending",drive:"pending"}`；字符串化后不匹配 `/drive.synced|snapshot.updated/i`。
- [ ] 2. 预期失败：`durableReceipt is not a function`。
- [ ] 3. 实现：
  ```js
  export function durableReceipt(fields) {
    return {
      status: "accepted", deliveryState: "cloud_accepted",
      requestId: fields.requestId, eventId: fields.eventId, eventKey: fields.eventKey,
      eventSeq: fields.eventSeq, taskId: fields.taskId,
      persistence: { localOutbox: "acknowledged", eventLedger: "accepted", projection: "pending", drive: "pending" }
    };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add shared/rds2-protocol.mjs services/reliable-drive-sync-worker/test/rds2-protocol.test.js && git commit -m "feat(v2): durable receipt builder"`。

### Task 1.5 business_dedupe_key 派生函数

**Files:** Modify `shared/rds2-protocol.mjs`；Test 同文件追加
**Interfaces:** Produces `deriveDedupeKey` | Consumes `protocol.js:308-309` 已校验字段

- [ ] 1. 失败测试：`deriveDedupeKey("resume-knowledge.answer-scored", { event: { questionKey: "Q1", localDate: "2026-09-05" } }, "u-1")` → `"u-1|2026-09-05|Q1"`；其他 eventType → `null`；answer-scored 缺 questionKey/localDate → 抛 `invalid_payload`。
- [ ] 2. 预期失败：函数不存在。
- [ ] 3. 实现：
  ```js
  export function deriveDedupeKey(eventType, payload, userId) {
    if (eventType !== "resume-knowledge.answer-scored") return null;
    const event = payload?.event ?? {};
    if (typeof event.questionKey !== "string" || !event.questionKey.trim()
      || typeof event.localDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(event.localDate)) {
      throw new ProtocolError("invalid_payload");
    }
    return [userId, event.localDate, event.questionKey].join("|");
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add shared/rds2-protocol.mjs services/reliable-drive-sync-worker/test/rds2-protocol.test.js && git commit -m "feat(v2): server-side business dedupe key derivation"`。

### Task 1.6 迁移 0006：六表 + 约束 + 索引 + CAS 触发器

**Files:** Create `services/reliable-drive-sync-worker/migrations/0006_rds2_v2_tables.sql`；Test `services/reliable-drive-sync-worker/test/rds2-schema.test.js`
**Interfaces:** Produces 六表 schema | Consumes 无

- [ ] 1. 失败测试（node:sqlite 内存库执行迁移 SQL 后断言）：
  ```js
  import assert from "node:assert/strict";
  import test from "node:test";
  import { DatabaseSync } from "node:sqlite";
  import { readFileSync } from "node:fs";
  import { fileURLToPath } from "node:url";

  const migration = readFileSync(fileURLToPath(new URL("../migrations/0006_rds2_v2_tables.sql", import.meta.url)), "utf8");
  function freshDb() { const db = new DatabaseSync(":memory:"); db.exec(migration); return db; }
  test("six rds2 tables exist", () => {
    const db = freshDb();
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'rds2_%' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(names, ["rds2_archive_deliveries", "rds2_business_events", "rds2_credentials", "rds2_event_outbox", "rds2_projections", "rds2_users"]);
  });
  test("outbox type-field CHECK rejects four illegal shapes", () => {
    const db = freshDb();
    db.exec(`INSERT INTO rds2_business_events (event_seq,event_id,request_id,user_id,namespace,event_type,event_key,envelope_json,envelope_hash,occurred_at,accepted_at)
      VALUES (1,'e1','r1','u1','algorithm','algorithm.learning.completed','k','{}','h','2026-09-05','2026-09-05')`);
    const base = `INSERT INTO rds2_event_outbox (task_id,task_type,event_seq,archive_delivery_id,state,available_at,created_at,updated_at) VALUES `;
    assert.throws(() => db.exec(base + `('t1','unknown',1,NULL,'pending','2026','2026','2026')`), /CHECK constraint/);
    assert.throws(() => db.exec(base + `('t2','project_event',NULL,NULL,'pending','2026','2026','2026')`), /CHECK constraint/);
    assert.throws(() => db.exec(base + `('t3','project_event',1,'a1','pending','2026','2026','2026')`), /CHECK constraint/);
    assert.throws(() => db.exec(base + `('t4','archive_artifact',NULL,NULL,'pending','2026','2026','2026')`), /CHECK constraint/);
  });
  test("one project task per event via partial unique index", () => {
    const db = freshDb();
    db.exec(`INSERT INTO rds2_business_events (event_seq,event_id,request_id,user_id,namespace,event_type,event_key,envelope_json,envelope_hash,occurred_at,accepted_at)
      VALUES (1,'e1','r1','u1','algorithm','algorithm.learning.completed','k','{}','h','2026-09-05','2026-09-05')`);
    db.exec(`INSERT INTO rds2_event_outbox (task_id,task_type,event_seq,state,available_at,created_at,updated_at) VALUES ('t_project_1','project_event',1,'pending','2026','2026','2026')`);
    assert.throws(() => db.exec(`INSERT INTO rds2_event_outbox (task_id,task_type,event_seq,state,available_at,created_at,updated_at) VALUES ('t_dup','project_event',1,'pending','2026','2026','2026')`), /UNIQUE/);
  });
  test("projection CAS trigger aborts stale write", () => {
    const db = freshDb();
    db.exec(`INSERT INTO rds2_users VALUES ('u1','乔炳源','乔炳源','active','2026','2026')`);
    db.exec(`INSERT INTO rds2_projections (user_id,namespace,projection_name,last_event_seq,state_json,public_view_json,content_hash,updated_at)
      VALUES ('u1','algorithm','learning',100,'{}','{}','h','2026')`);
    assert.throws(() => db.exec(`UPDATE rds2_projections SET last_event_seq=90 WHERE user_id='u1'`), /stale_projection_write/);
  });
  test("business_dedupe_key partial unique blocks duplicate scope", () => {
    const db = freshDb();
    const ins = (seq, dedupe) => db.exec(`INSERT INTO rds2_business_events (event_seq,event_id,request_id,user_id,namespace,event_type,event_key,envelope_json,envelope_hash,business_dedupe_key,occurred_at,accepted_at)
      VALUES (${seq},'e${seq}','r${seq}','u1','resume-knowledge','resume-knowledge.answer-scored','k','{}','h',${dedupe ? "'u1|2026-09-05|Q1'" : "NULL"},'2026-09-05','2026-09-05')`);
    ins(1, true);
    assert.throws(() => ins(2, true), /UNIQUE/);
    ins(3, false);
  });
  ```
- [ ] 2. 运行 `npm run test:worker 2>&1 | tail -4`，预期 4 个新用例 fail（`no such table`）。
- [ ] 3. 最小实现 `migrations/0006_rds2_v2_tables.sql`（全部 `IF NOT EXISTS`，不动 0005）：
  ```sql
  CREATE TABLE IF NOT EXISTS rds2_users (
    user_id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rds2_business_events (
    event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES rds2_users(user_id),
    namespace TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_key TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    envelope_hash TEXT NOT NULL,
    business_dedupe_key TEXT,
    occurred_at TEXT NOT NULL,
    accepted_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_rds2_events_dedupe
    ON rds2_business_events(business_dedupe_key) WHERE business_dedupe_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_rds2_events_scope
    ON rds2_business_events(user_id, namespace, event_seq);

  CREATE TABLE IF NOT EXISTS rds2_archive_deliveries (
    archive_delivery_id TEXT PRIMARY KEY NOT NULL,
    artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('business_event','projection_snapshot')),
    artifact_key TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES rds2_users(user_id),
    namespace TEXT NOT NULL,
    source_event_seq INTEGER,
    projection_name TEXT,
    projection_event_seq INTEGER,
    artifact_json TEXT NOT NULL,
    artifact_hash TEXT NOT NULL,
    drive_path TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivering','delivered','needs_attention')),
    drive_file_id TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rds2_archive_state ON rds2_archive_deliveries(state, created_at);
  CREATE INDEX IF NOT EXISTS idx_rds2_archive_path ON rds2_archive_deliveries(drive_path);

  CREATE TABLE IF NOT EXISTS rds2_event_outbox (
    task_id TEXT PRIMARY KEY NOT NULL,
    task_type TEXT NOT NULL CHECK (task_type IN ('project_event','archive_artifact')),
    event_seq INTEGER REFERENCES rds2_business_events(event_seq),
    archive_delivery_id TEXT REFERENCES rds2_archive_deliveries(archive_delivery_id),
    state TEXT NOT NULL CHECK (state IN ('pending','dispatching','queued','processing','completed','needs_attention')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_until TEXT,
    queue_message_id TEXT,
    last_error_code TEXT,
    available_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (task_type = 'project_event' AND event_seq IS NOT NULL AND archive_delivery_id IS NULL)
      OR (task_type = 'archive_artifact' AND archive_delivery_id IS NOT NULL AND event_seq IS NULL)
    )
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_rds2_outbox_project_per_event
    ON rds2_event_outbox(event_seq) WHERE task_type = 'project_event';
  CREATE INDEX IF NOT EXISTS idx_rds2_outbox_due ON rds2_event_outbox(state, available_at);

  CREATE TABLE IF NOT EXISTS rds2_projections (
    user_id TEXT NOT NULL REFERENCES rds2_users(user_id),
    namespace TEXT NOT NULL,
    projection_name TEXT NOT NULL,
    projection_version INTEGER NOT NULL DEFAULT 1,
    last_event_seq INTEGER NOT NULL DEFAULT 0,
    state_json TEXT NOT NULL,
    public_view_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, namespace, projection_name)
  );

  CREATE TRIGGER IF NOT EXISTS trg_rds2_projection_cas
  BEFORE UPDATE ON rds2_projections
  FOR EACH ROW
  WHEN NEW.last_event_seq <= OLD.last_event_seq
  BEGIN
    SELECT RAISE(ABORT, 'stale_projection_write');
  END;

  CREATE TABLE IF NOT EXISTS rds2_credentials (
    credential_hash TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES rds2_users(user_id),
    created_at TEXT NOT NULL
  );
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/migrations/0006_rds2_v2_tables.sql services/reliable-drive-sync-worker/test/rds2-schema.test.js && git commit -m "feat(v2): rds2 six-table migration with check constraints and cas trigger"`。

### Task 1.7 SQLite 快速适配器（D1 语义）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/sqlite-adapter.js`；Test `services/reliable-drive-sync-worker/test/rds2-sqlite-adapter.test.js`
**Interfaces:** Produces `createSqliteAdapter(filePath)` 返回 `{prepare, batch, exec}` | Consumes `node:sqlite`

- [ ] 1. 失败测试：`adapter.prepare(sql).bind(...).first()/all()/run()` 可用；`batch([{sql,params},...])` 在事务内执行——第二条语句抛错时第一条回滚（表计数为 0）；`foreign_keys` PRAGMA 为 ON。
  ```js
  test("batch rolls back atomically", async () => {
    const adapter = createSqliteAdapter(join(await mkdtemp(join(tmpdir(), "rds2-")), "t.sqlite"));
    adapter.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)");
    const good = { sql: "INSERT INTO t VALUES ('a','1')", params: [] };
    const bad = { sql: "INSERT INTO t VALUES ('a','2')", params: [] };
    await assert.rejects(() => adapter.batch([good, bad]));
    assert.equal(adapter.prepare("SELECT COUNT(*) c FROM t").first().c, 0);
  });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  import { DatabaseSync } from "node:sqlite";
  export function createSqliteAdapter(filePath) {
    const db = new DatabaseSync(filePath);
    db.exec("PRAGMA foreign_keys = ON");
    const prepare = (sql) => {
      const stmt = db.prepare(sql);
      const bind = (...params) => {
        const run = (...args) => stmt.run(...(args.length ? args : params));
        return {
          run,
          all: (...args) => stmt.all(...(args.length ? args : params)),
          first: (...args) => stmt.get(...(args.length ? args : params)),
          bind
        };
      };
      return { ...bind(), bind };
    };
    return {
      prepare,
      exec: (sql) => db.exec(sql),
      async batch(statements) {
        db.exec("BEGIN");
        try {
          const results = [];
          for (const { sql, params = [] } of statements) results.push(db.prepare(sql).run(...params));
          db.exec("COMMIT");
          return results;
        } catch (cause) {
          db.exec("ROLLBACK");
          throw cause;
        }
      }
    };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/sqlite-adapter.js services/reliable-drive-sync-worker/test/rds2-sqlite-adapter.test.js && git commit -m "feat(v2): sqlite adapter with d1 batch semantics"`。

### Task 1.8 user-repository

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/user-repository.js`；Test `services/reliable-drive-sync-worker/test/rds2-user-repository.test.js`
**Interfaces:** Produces `createUserRepository(db)` → `{register(displayName, userIdOverride?), byNameKey(nameKey), byId(userId), assertActive(userId)}` | Consumes adapter

- [ ] 1. 失败测试：`register("乔炳源")` 生成 UUID v4 格式 user 且 `name_key === "乔炳源"`；同 displayName 重复注册返回同一行（幂等）；`byId` 不存在 → `null`；`assertActive` 对 `status='disabled'` 抛 `user_disabled`；显式传入与现有 name_key 不同的 userId → 抛 `name_key_conflict`。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  import { randomUUID } from "node:crypto";
  export const normalizeNameKey = (displayName) => displayName.normalize("NFKC").trim();
  export function createUserRepository(db) {
    return {
      register(displayName, userIdOverride) {
        const nameKey = normalizeNameKey(displayName);
        const existing = db.prepare("SELECT * FROM rds2_users WHERE name_key = ?").first(nameKey);
        if (existing) {
          if (userIdOverride && userIdOverride !== existing.user_id) throw new Error("name_key_conflict");
          return existing;
        }
        const userId = userIdOverride ?? randomUUID();
        const now = new Date().toISOString();
        db.prepare("INSERT INTO rds2_users (user_id, display_name, name_key, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
          .run(userId, displayName.trim(), nameKey, now, now);
        return db.prepare("SELECT * FROM rds2_users WHERE user_id = ?").first(userId);
      },
      byNameKey: (nameKey) => db.prepare("SELECT * FROM rds2_users WHERE name_key = ?").first(normalizeNameKey(nameKey)),
      byId: (userId) => db.prepare("SELECT * FROM rds2_users WHERE user_id = ?").first(userId),
      assertActive(userId) {
        const user = this.byId(userId);
        if (!user) throw new Error("identity_not_found");
        if (user.status !== "active") throw new Error("user_disabled");
        return user;
      }
    };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/user-repository.js services/reliable-drive-sync-worker/test/rds2-user-repository.test.js && git commit -m "feat(v2): user repository with nfkc name key"`。

### Task 1.9 credential-repository 与凭据鉴权

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/credential-auth.js`；Test `services/reliable-drive-sync-worker/test/rds2-credential-auth.test.js`
**Interfaces:** Produces `issueCredential(db, userId, token)`、`authenticateUser(db, bearerToken)` | Consumes `sha256Hex`, Task 1.8

- [ ] 1. 失败测试：`issueCredential` 写入 SHA-256 哈希（库中查不到明文）；`authenticateUser(db, "Bearer good")` 返回对应用户行；未知 token 抛 `unauthorized`；被禁用用户凭据抛 `user_disabled`；token 明文不出现在任何抛错消息中。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  import { sha256Hex } from "../../../shared/rds2-protocol.mjs";
  export async function issueCredential(db, userId, token) {
    const hash = await sha256Hex(token);
    db.prepare("INSERT INTO rds2_credentials (credential_hash, user_id, created_at) VALUES (?, ?, ?)")
      .run(hash, userId, new Date().toISOString());
    return hash;
  }
  export async function authenticateUser(db, bearerToken) {
    if (typeof bearerToken !== "string" || !bearerToken.startsWith("Bearer ")) throw new Error("unauthorized");
    const hash = await sha256Hex(bearerToken.slice(7));
    const row = db.prepare("SELECT user_id FROM rds2_credentials WHERE credential_hash = ?").first(hash);
    if (!row) throw new Error("unauthorized");
    const user = db.prepare("SELECT * FROM rds2_users WHERE user_id = ?").first(row.user_id);
    if (!user) throw new Error("unauthorized");
    if (user.status !== "active") throw new Error("user_disabled");
    return user;
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/credential-auth.js services/reliable-drive-sync-worker/test/rds2-credential-auth.test.js && git commit -m "feat(v2): credential-mapped identity authentication"`。

### Task 1.10 event-repository（带身份与领域范围的游标读取）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/event-repository.js`；Test `services/reliable-drive-sync-worker/test/rds2-event-repository.test.js`
**Interfaces:** Produces `createEventRepository(db)` → `{readAfter(userId, namespace, afterEventSeq, limit), insert(...), byRequestId, byEventId, byEventKey}` | Consumes adapter

- [ ] 1. 失败测试（重点三条来自复审）：
  ```js
  test("readAfter is scoped by user and namespace", () => {
    const db = freshDb(); const repo = createEventRepository(db);
    seedUser(db, "u1"); seedUser(db, "u2");
    repo.insert({ eventId: "e1", requestId: "r1", userId: "u2", namespace: "algorithm", eventType: "algorithm.learning.completed", eventKey: "k1", envelopeJson: "{}", envelopeHash: "h", occurredAt: "t" });
    repo.insert({ eventId: "e2", requestId: "r2", userId: "u1", namespace: "interview", eventType: "interview.review.completed", eventKey: "k2", envelopeJson: "{}", envelopeHash: "h", occurredAt: "t" });
    repo.insert({ eventId: "e3", requestId: "r3", userId: "u1", namespace: "algorithm", eventType: "algorithm.learning.completed", eventKey: "k3", envelopeJson: "{}", envelopeHash: "h", occurredAt: "t" });
    const rows = repo.readAfter("u1", "algorithm", 0, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_id, "e3");
  });
  test("other users events do not consume this user's limit", () => {
    // 预置 u2 的 10 条 algorithm 事件（全局 seq 1-10），再给 u1 1 条（seq 11）
    // readAfter("u1","algorithm",0,10) 必须返回 u1 的 1 条，而非空
  });
  ```
  另断言：返回行按 `event_seq ASC`；`limit` 超过 10 时调用方（投影引擎）负责截断到 10，repository 不做二次限制。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  export function createEventRepository(db) {
    const insertStmt = `INSERT INTO rds2_business_events
      (event_id, request_id, user_id, namespace, event_type, event_key, envelope_json, envelope_hash, business_dedupe_key, occurred_at, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    return {
      insert(input) {
        db.prepare(insertStmt).run(input.eventId, input.requestId, input.userId, input.namespace,
          input.eventType, input.eventKey, input.envelopeJson, input.envelopeHash,
          input.businessDedupeKey ?? null, input.occurredAt, new Date().toISOString());
        return db.prepare("SELECT * FROM rds2_business_events WHERE request_id = ?").first(input.requestId);
      },
      readAfter: (userId, namespace, afterEventSeq, limit) =>
        db.prepare(`SELECT * FROM rds2_business_events WHERE user_id = ? AND namespace = ? AND event_seq > ? ORDER BY event_seq ASC LIMIT ?`)
          .all(userId, namespace, afterEventSeq, limit),
      byRequestId: (requestId) => db.prepare("SELECT * FROM rds2_business_events WHERE request_id = ?").first(requestId),
      byEventId: (eventId) => db.prepare("SELECT * FROM rds2_business_events WHERE event_id = ?").first(eventId),
      byEventKey: (userId, namespace, eventType, eventKey) =>
        db.prepare("SELECT * FROM rds2_business_events WHERE user_id = ? AND namespace = ? AND event_type = ? AND event_key = ?")
          .first(userId, namespace, eventType, eventKey)
    };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/event-repository.js services/reliable-drive-sync-worker/test/rds2-event-repository.test.js && git commit -m "feat(v2): scoped event repository with user namespace cursor"`。

### Task 1.11 outbox-repository（租约 + 确定性 taskId + 状态机）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/outbox-repository.js`；Test `services/reliable-drive-sync-worker/test/rds2-outbox-repository.test.js`
**Interfaces:** Produces `createOutboxRepository(db)` → `{claimDue(limit, owner, now), renewLease, markQueued, markProcessing, complete, failWithBackoff, toNeedsAttention, releaseLease, byTaskId, reclaimExpired(now)}` | Consumes adapter

- [ ] 1. 失败测试：`claimDue(5,"w1")` 只取 `state='pending' AND available_at <= now`，行数 ≤5，置 `dispatching` + 租约；第二次 `claimDue` 同批返回空（互斥）；`reclaimExpired` 把 `lease_until < now` 的 `dispatching/processing` 复位 `pending` 且 `attempt_count+1`；`complete("t_project_1")` 后 `state='completed'`；对 `completed` 行 `complete` 幂等返回；`failWithBackoff` 第 5 次（阈值）转 `needs_attention`；非法迁移（对 `completed` 调 `markQueued`）抛 `illegal_state_transition`；`queue_message_id` 恒写 NULL（`markQueued` 签名无 message 参数，源码 grep `queue_message_id` 只出现在列定义与建表语句）。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（核心语句）：
  ```js
  const RETRY_THRESHOLD = 5;
  const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
  export function createOutboxRepository(db) {
    return {
      claimDue(limit, owner, now = new Date().toISOString()) {
        return db.prepare(`SELECT * FROM rds2_event_outbox WHERE state = 'pending' AND available_at <= ? ORDER BY available_at ASC LIMIT ?`)
          .all(now, limit)
          .map((row) => {
            db.prepare(`UPDATE rds2_event_outbox SET state='dispatching', lease_owner=?, lease_until=?, attempt_count=attempt_count+1, updated_at=? WHERE task_id=? AND state='pending'`)
              .run(owner, new Date(Date.now() + 60_000).toISOString(), now, row.task_id);
            return { ...row, state: "dispatching" };
          });
      },
      markQueued(taskId) {
        const res = db.prepare(`UPDATE rds2_event_outbox SET state='queued', lease_owner=NULL, lease_until=NULL, updated_at=? WHERE task_id=? AND state='dispatching'`).run(new Date().toISOString(), taskId);
        if (res.changes !== 1) throw new Error("illegal_state_transition");
      },
      complete(taskId) {
        db.prepare(`UPDATE rds2_event_outbox SET state='completed', updated_at=? WHERE task_id=? AND state IN ('dispatching','queued','processing')`).run(new Date().toISOString(), taskId);
      },
      failWithBackoff(taskId, errorCode, now = Date.now()) {
        const row = this.byTaskId(taskId);
        const attempts = row.attempt_count;
        if (attempts >= RETRY_THRESHOLD) {
          db.prepare(`UPDATE rds2_event_outbox SET state='needs_attention', last_error_code=?, lease_owner=NULL, updated_at=? WHERE task_id=?`).run(errorCode, new Date(now).toISOString(), taskId);
          return "needs_attention";
        }
        const at = new Date(now + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]).toISOString();
        db.prepare(`UPDATE rds2_event_outbox SET state='pending', last_error_code=?, lease_owner=NULL, available_at=?, updated_at=? WHERE task_id=?`).run(errorCode, at, new Date(now).toISOString(), taskId);
        return "pending";
      },
      reclaimExpired(now = new Date().toISOString()) {
        return db.prepare(`UPDATE rds2_event_outbox SET state='pending', lease_owner=NULL, attempt_count=attempt_count+1, updated_at=? WHERE lease_until IS NOT NULL AND lease_until < ? AND state IN ('dispatching','processing')`).run(now, now);
      },
      byTaskId: (taskId) => db.prepare("SELECT * FROM rds2_event_outbox WHERE task_id = ?").first(taskId)
    };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/outbox-repository.js services/reliable-drive-sync-worker/test/rds2-outbox-repository.test.js && git commit -m "feat(v2): outbox repository with leases and bounded backoff"`。

### Task 1.12 projection-repository（触发器 CAS 写入）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/projection-repository.js`；Test `services/reliable-drive-sync-worker/test/rds2-projection-repository.test.js`
**Interfaces:** Produces `createProjectionRepository(db)` → `{get(userId, namespace, projectionName), upsert, updateAdvanced}` | Consumes adapter, 迁移触发器

- [ ] 1. 失败测试：`updateAdvanced` 执行 `UPDATE rds2_projections SET ... WHERE user_id=? AND namespace=? AND projection_name=?`（**无 seq 谓词**）；游标 100 时写入 `last_event_seq=90` → 抛 `/stale_projection_write/`；写入 110 成功；两个消费者同读 100，A 写 110 成功后 B 写 110 → 抛 `stale_projection_write`（`NEW<=OLD` 触发）；`upsert`（INSERT OR IGNORE 空投影行）幂等。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  export function createProjectionRepository(db) {
    return {
      get: (userId, namespace, projectionName) =>
        db.prepare("SELECT * FROM rds2_projections WHERE user_id=? AND namespace=? AND projection_name=?").first(userId, namespace, projectionName),
      upsert(userId, namespace, projectionName) {
        db.prepare(`INSERT OR IGNORE INTO rds2_projections (user_id, namespace, projection_name, last_event_seq, state_json, public_view_json, content_hash, updated_at)
          VALUES (?, ?, ?, 0, '{}', '{}', 'empty', ?)`).run(userId, namespace, projectionName, new Date().toISOString());
      },
      updateAdvanced(fields) {
        const res = db.prepare(`UPDATE rds2_projections SET last_event_seq=?, state_json=?, public_view_json=?, content_hash=?, updated_at=?
          WHERE user_id=? AND namespace=? AND projection_name=?`)
          .run(fields.lastEventSeq, fields.stateJson, fields.publicViewJson, fields.contentHash, new Date().toISOString(),
            fields.userId, fields.namespace, fields.projectionName);
        if (res.changes !== 1) throw new Error("projection_row_missing");
        return res;
      }
    };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/projection-repository.js services/reliable-drive-sync-worker/test/rds2-projection-repository.test.js && git commit -m "feat(v2): projection repository guarded by cas trigger"`。

### Task 1.13 archive-delivery-repository（确定性 ID）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/archive-delivery-repository.js`；Test `services/reliable-drive-sync-worker/test/rds2-archive-delivery-repository.test.js`
**Interfaces:** Produces `createArchiveDeliveryRepository(db)` → `{freeze(fields), markDelivering, markDelivered, markNeedsAttention, claimableGroups(limit), byArtifactKey}` | Consumes adapter, `sha256Hex`

- [ ] 1. 失败测试：`freeze` 对同一 `artifact_key` 重复调用返回原行且 `archive_delivery_id` 相同；ID = `sha256(artifact_key)` 前 32 位 hex（测试用硬编码期望值断言算法）；状态机 `pending→delivering→delivered` 合法、`delivered→delivering` 抛 `illegal_state_transition`；`claimableGroups(4)` 返回按 `(user_id, namespace)` 分组、每组一条代表行、总数 ≤4。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  import { sha256Hex } from "../../../shared/rds2-protocol.mjs";
  export const deterministicDeliveryId = async (artifactKey) => (await sha256Hex(artifactKey)).slice(0, 32);
  export function createArchiveDeliveryRepository(db) {
    return {
      async freeze(fields) {
        const existing = db.prepare("SELECT * FROM rds2_archive_deliveries WHERE artifact_key = ?").first(fields.artifactKey);
        if (existing) return existing;
        const id = await deterministicDeliveryId(fields.artifactKey);
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO rds2_archive_deliveries (archive_delivery_id, artifact_kind, artifact_key, user_id, namespace, source_event_seq, projection_name, projection_event_seq, artifact_json, artifact_hash, drive_path, state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
          .run(id, fields.artifactKind, fields.artifactKey, fields.userId, fields.namespace,
            fields.sourceEventSeq ?? null, fields.projectionName ?? null, fields.projectionEventSeq ?? null,
            fields.artifactJson, fields.artifactHash, fields.drivePath, now, now);
        return db.prepare("SELECT * FROM rds2_archive_deliveries WHERE archive_delivery_id = ?").first(id);
      },
      markDelivering(id) { const r = db.prepare("UPDATE rds2_archive_deliveries SET state='delivering', attempt_count=attempt_count+1, updated_at=? WHERE archive_delivery_id=? AND state='pending'").run(new Date().toISOString(), id); if (r.changes !== 1) throw new Error("illegal_state_transition"); },
      markDelivered(id, driveFileId) { db.prepare("UPDATE rds2_archive_deliveries SET state='delivered', drive_file_id=?, updated_at=? WHERE archive_delivery_id=? AND state='delivering'").run(driveFileId, new Date().toISOString(), id); },
      markNeedsAttention(id, code) { db.prepare("UPDATE rds2_archive_deliveries SET state='needs_attention', last_error_code=?, updated_at=? WHERE archive_delivery_id=?").run(code, new Date().toISOString(), id); },
      claimableGroups: (limit) => db.prepare(`SELECT user_id, namespace, MIN(created_at) AS first_created FROM rds2_archive_deliveries WHERE state='pending' GROUP BY user_id, namespace ORDER BY first_created ASC LIMIT ?`).all(limit),
      byArtifactKey: (key) => db.prepare("SELECT * FROM rds2_archive_deliveries WHERE artifact_key = ?").first(key)
    };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/archive-delivery-repository.js services/reliable-drive-sync-worker/test/rds2-archive-delivery-repository.test.js && git commit -m "feat(v2): archive delivery repository with deterministic ids"`。

### Task 1.14 accept-service（真实 SQL 原子接收 + 竞态重查）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/accept-service.js`；Test `services/reliable-drive-sync-worker/test/rds2-accept-service.test.js`
**Interfaces:** Produces `createAcceptService(db, {users, events, outbox})` → `accept(validatedEnvelope, user, {canaryNamespaces})` | Consumes Task 1.2/1.5/1.8/1.10

- [ ] 1. 失败测试：
  ```js
  test("event and project task commit atomically with deterministic task id", async () => {
    const svc = createAcceptService(db, { users, events, outbox });
    const receipt = await svc.accept(validAlgorithmEnvelope, user, { canaryNamespaces: ["algorithm"] });
    assert.equal(receipt.taskId, `t_project_${receipt.eventSeq}`);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM rds2_business_events").first().c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM rds2_event_outbox WHERE task_type='project_event'").first().c, 1);
  });
  test("mid-batch failure rolls back event insert", async () => {
    // 注入 batch 实现：第一条成功、第二条抛错 → 事件表计数为 0
  });
  test("concurrent duplicate requestId returns exact_retry with original receipt", async () => {
    // 预查为空后 INSERT 撞 request_id UNIQUE → 重查三 ID → {kind:"exact_retry"} → 返回原 eventSeq/taskId
  });
  test("canary gate blocks non-allowlisted namespace", async () => {
    await assert.rejects(() => svc.accept(validInterviewEnvelope, user, { canaryNamespaces: ["algorithm"] }), /namespace_not_enabled/);
  });
  test("disabled identity and missing identity reject before any write", async () => { /* 计数断言零写入 */ });
  test("answer-scored derives business_dedupe_key", async () => { /* 库中查到 'u1|2026-09-05|Q1' */ });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（核心 batch SQL，`event_seq` 由 SQL 内派生）：
  ```js
  import { canonicalJson, sha256Hex, resolveIntent, durableReceipt, deriveDedupeKey, ProtocolError } from "../../../shared/rds2-protocol.mjs";

  export function createAcceptService(db, { users, events, outbox }) {
    return async function accept(envelope, user, { canaryNamespaces }) {
      if (!canaryNamespaces.includes(envelope.namespace)) throw new ProtocolError("namespace_not_enabled");
      users.assertActive(user.user_id);
      const envelopeHash = await sha256Hex(canonicalJson(envelope));
      const lookups = {
        byRequestId: events.byRequestId(envelope.requestId),
        byEventId: events.byEventId(envelope.payload.event.eventId),
        byEventKey: events.byEventKey(user.user_id, envelope.namespace, envelope.eventType, envelope.payload.event.eventKey)
      };
      const intent = resolveIntent(lookups, { envelopeHash, eventId: envelope.payload.event.eventId });
      if (intent.kind === "exact_retry") return retryReceipt(intent.event, outbox);
      if (intent.kind === "already_recorded") return { status: "already_recorded", first: intent.first };
      if (intent.kind === "conflict") throw new ProtocolError(intent.code);
      const dedupeKey = deriveDedupeKey(envelope.eventType, envelope.payload, user.user_id);
      const now = new Date().toISOString();
      try {
        await db.batch([
          { sql: `INSERT INTO rds2_business_events (request_id, event_id, user_id, namespace, event_type, event_key, envelope_json, envelope_hash, business_dedupe_key, occurred_at, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [envelope.requestId, envelope.payload.event.eventId, user.user_id, envelope.namespace, envelope.eventType,
                     envelope.payload.event.eventKey, canonicalJson(envelope), envelopeHash, dedupeKey,
                     envelope.payload.event.observedAt ?? now, now] },
          { sql: `INSERT INTO rds2_event_outbox (task_id, task_type, event_seq, archive_delivery_id, state, attempt_count, queue_message_id, available_at, created_at, updated_at)
            SELECT 't_project_' || event_seq, 'project_event', event_seq, NULL, 'pending', 0, NULL, ?, ?, ? FROM rds2_business_events WHERE request_id = ?`,
            params: [now, now, now, envelope.requestId] }
        ]);
      } catch (cause) {
        if (!/UNIQUE constraint failed/.test(String(cause))) throw cause;
        const reLookups = {
          byRequestId: events.byRequestId(envelope.requestId),
          byEventId: events.byEventId(envelope.payload.event.eventId),
          byEventKey: events.byEventKey(user.user_id, envelope.namespace, envelope.eventType, envelope.payload.event.eventKey)
        };
        const reIntent = resolveIntent(reLookups, { envelopeHash, eventId: envelope.payload.event.eventId });
        if (reIntent.kind === "exact_retry") return retryReceipt(reIntent.event, outbox);
        if (reIntent.kind === "already_recorded") return { status: "already_recorded", first: reIntent.first };
        if (reIntent.kind === "conflict") throw new ProtocolError(reIntent.code);
        throw cause;
      }
      const row = events.byRequestId(envelope.requestId);
      return durableReceipt({ requestId: envelope.requestId, eventId: row.event_id, eventKey: row.event_key, eventSeq: row.event_seq, taskId: `t_project_${row.event_seq}` });
    };
  }
  async function retryReceipt(row, outbox) {
    const task = outbox.byTaskId(`t_project_${row.event_seq}`);
    return durableReceipt({ requestId: row.request_id, eventId: row.event_id, eventKey: row.event_key, eventSeq: row.event_seq, taskId: task?.task_id ?? `t_project_${row.event_seq}` });
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/accept-service.js services/reliable-drive-sync-worker/test/rds2-accept-service.test.js && git commit -m "feat(v2): atomic accept service with race-safe idempotency"`。

### Task 1.15 Miniflare 真 D1 集成套件

**Files:** Modify `services/reliable-drive-sync-worker/package.json`（devDependencies 增加 `"miniflare": "^4.0.0"`）；Create `services/reliable-drive-sync-worker/test/rds2-d1-integration.test.js`；Modify `services/reliable-drive-sync-worker/.gitignore`（追加 `.wrangler-state/`，若无该文件则创建）
**Interfaces:** Produces `startRds2Miniflare()` 测试助手（导出自测试文件内联，不跨文件 import）| Consumes `miniflare`

- [ ] 1. 安装依赖：`cd services/reliable-drive-sync-worker && npm install --save-dev miniflare@^4.0.0`。此为本地 devDependency，无费用、无远程动作。
- [ ] 2. 失败测试（六项断言一个文件内分 test 块）：
  ```js
  import { Miniflare } from "miniflare";
  async function startRds2Miniflare(persistPath) {
    const mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: ["DB"],
      d1Persist: persistPath
    });
    const db = await mf.getD1Database("DB");
    const migration = readFileSync(new URL("../migrations/0006_rds2_v2_tables.sql", import.meta.url), "utf8");
    await db.exec(migration);
    return { mf, db };
  }
  ```
  断言清单：① `db.exec(migration)` 成功且六表存在（`SELECT name FROM sqlite_master`）；② `prepare/bind/run/first/all` 各一次成功往返（建 user、查 user）；③ `db.batch` 第二条违反 CHECK 时第一条回滚（事件计数 0）；④ 原子接收：用真 D1 binding 跑 Task 1.14 的 accept，receipt.taskId = `t_project_<seq>` 且 outbox 一行；⑤ 投影 CAS：游标 100 时 `updateAdvanced(90)` 抛 `/stale_projection_write/` 且 batch 回滚；⑥ 持久化：关闭第一个 Miniflare，用同 `d1Persist` 路径新建第二个实例，先前数据仍在。
- [ ] 3. 运行 `npm run test:worker 2>&1 | tail -4`：先确认 6 个集成用例 fail（`Cannot find package 'miniflare'`），实现助手与用例后预期 `# fail 0`。
- [ ] 4. 提交：`git add services/reliable-drive-sync-worker/package.json services/reliable-drive-sync-worker/package-lock.json services/reliable-drive-sync-worker/test/rds2-d1-integration.test.js services/reliable-drive-sync-worker/.gitignore && git commit -m "test(v2): miniflare real d1 binding integration suite"`。
- 回滚：`git revert <SHA>` 后运行 `npm uninstall` 等价操作不必要——lockfile 回退即可。

### Task 1.16 identity-init 服务逻辑（纯函数级，路由接线在子计划 4）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/identity-init.js`；Test `services/reliable-drive-sync-worker/test/rds2-identity-init.test.js`
**Interfaces:** Produces `createIdentityInitService(db, {users, projections})` → `init({adminToken, displayName, namespaces})` | Consumes Task 1.8, `issueCredential`

- [ ] 1. 失败测试：`adminToken !== "test-admin-token"` → 抛 `forbidden`（admin 错误不泄露期望值）；首次 init 返回 `{userId, displayName, clientCredential}`（明文凭据 32 字节 hex），库中 `rds2_credentials` 只有哈希；重复 init 同 displayName 幂等返回同一 userId 且**返回新的 clientCredential**（凭据轮换，旧行保留）；同 name_key 显式传不同 userId → 抛 `name_key_conflict`；`namespaces` 默认 `["algorithm"]`，为每个 namespace 调 `projections.upsert`（查表有行）；disabled 用户名重新 init → 抛 `user_disabled`。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  import { randomBytes } from "node:crypto";
  import { issueCredential } from "./credential-auth.js";
  export const ADMIN_TOKEN_BINDING = "RDS2_ADMIN_TOKEN";
  export function createIdentityInitService(db, { users, projections }) {
    return async function init({ adminToken, displayName, namespaces = ["algorithm"], userIdOverride }) {
      if (adminToken !== ADMIN_TOKEN_BINDING) throw new Error("forbidden");
      const user = users.register(displayName, userIdOverride);
      if (user.status !== "active") throw new Error("user_disabled");
      for (const namespace of namespaces) projections.upsert(user.user_id, namespace, defaultProjectionName(namespace));
      const clientCredential = randomBytes(32).toString("hex");
      await issueCredential(db, user.user_id, clientCredential);
      return { userId: user.user_id, displayName: user.display_name, clientCredential };
    };
  }
  export function defaultProjectionName(namespace) { return namespace === "algorithm" ? "learning" : namespace; }
  ```
  （`ADMIN_TOKEN_BINDING` 在 Task 1.16 以测试常量注入；生产值在子计划 4 的路由接线中改为 `env.RDS2_ADMIN_TOKEN` 比较——该接线 Task 内含独立断言。）
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/identity-init.js services/reliable-drive-sync-worker/test/rds2-identity-init.test.js && git commit -m "feat(v2): protected identity initialization service"`。

### Task 1.17 打包门 dry-run

**Files:** 无新增（验证性任务）
**Interfaces:** Consumes 全部已有文件

- [ ] 1. `cd C:\Users\27846\my-chatgpt-mcp-v2 && npx --yes wrangler deploy --config services/reliable-drive-sync-worker/wrangler.toml --dry-run --outdir "$PWD/services/reliable-drive-sync-worker/tmp-dryrun-p1"`。
- [ ] 2. 预期：退出码 0，输出 `Total Upload` 与 `--dry-run: exiting now`；bundle 包含 `shared/rds2-protocol.mjs` 内容（`grep -l canonicalJson <outdir>/index.js` 命中——本阶段 shared 已被测试外引用但尚未被 Worker 源引用时，此断言改为“dry-run 通过”即可，并在任务报告注明）。
- [ ] 3. `git status --short` 确认仅新增未跟踪的 `tmp-dryrun-p1/`；`git clean -n` 预演后删除该目录（本计划产物，G0 规则允许）。
- [ ] 4. 无提交。失败则 halt-and-report，附 wrangler 完整输出。

## 覆盖与自检（子计划 1 完成门）

- [ ] 规格映射：§7.2 全部约束（Task 1.6）、§9 矩阵（1.3/1.14）、§17 凭据身份（1.9/1.16）、§10.1 步骤 1-6 的服务端部分（1.14）。
- [ ] `grep -rn "TODO\|TBD\|同上\|参考前文\|必要修复\|<tmp>\|<dataDir>\|<skill>" src/rds2/ migrations/0006_rds2_v2_tables.sql test/rds2-*.test.js` 预期零命中。
- [ ] 命名一致性：`t_project_<event_seq>`、`stale_projection_write`、`business_dedupe_key`、`name_key_conflict` 在全部文件拼写一致（`grep -rn` 核对）。
