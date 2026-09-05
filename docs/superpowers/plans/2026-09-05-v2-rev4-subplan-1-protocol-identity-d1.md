# RDS2 Protocol, Identity and D1 Data Foundation Implementation Plan — Revision 4

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立共享 V2 协议模块（单一事实源，覆盖 V1 全部 18 个允许事件类型的校验）、六张 `rds2_*` 表迁移（含业务唯一索引）、**真实异步 D1 契约**下的仓库层与服务层（原子接收、七条幂等矩阵、单 batch 身份初始化），以及 Miniflare 真 binding 集成测试。

**Architecture:** `shared/rds2-protocol.mjs` 被 Worker（Wrangler 打包）与 Bridge（Node ESM）共同引用；仓库层面向**真实 Cloudflare D1 API**（`prepare(sql).bind(...).first()/all()/run()`、`batch(绑定语句数组)`、`result.meta.changes`），本地 `node:sqlite` 适配器模拟同一套 API（不创造 `{sql,params}` 第二套接口）；`src/rds2/*.js` 引用仓库根 `shared/` 的相对路径为 `../../../../shared/rds2-protocol.mjs`（`src/rds2 → src → worker → services → 仓库根`，四层）；身份初始化 = 单个 D1 batch（用户 + 凭据 + 全部初始投影）；凭据语义 = 追加签发（`status/revoked_at` 预留）；admin token 期望值依赖注入；凭据随机字节用 Web Crypto。

**Tech Stack:** Node ≥22 内置 test runner；`node:sqlite`（单元级）；`miniflare` devDependency（集成级）；Wrangler 4 `--dry-run` 打包门。零运行时依赖。

**Spec:** 上位规格 Rev 4：§3 决策 15/16（D1 异步契约、独立 cron）、§7.2（六表 + 业务唯一索引 + `queued_at` + 凭据列）、§9（七条幂等矩阵 + 四查询入口）、§10.1（先鉴权接收九步）、§17（凭据映射、追加签发、admin 注入、Web Crypto）、§21.4 验收门 1/2/3/4。

**Rev 4 相对 Rev 3 的关键修正（本子计划范围）:**
1. 全部 Repository/Service 接口改 async；`db.batch()` 接收绑定后语句对象数组；影响行数读 `result.meta.changes`。
2. SQLite 适配器模拟真实 D1 API，删除 Rev 3 的 `{sql, params}` 形态。
3. 迁移 0006 补 `idx_rds2_events_business_scope` 唯一索引、`rds2_event_outbox.queued_at`、`rds2_credentials.status/revoked_at`。
4. `resolveIntent` 重写为四查询入口 + 七条矩阵（新增 `byBusinessDedupeKey`、`idempotency_state_corrupt`、仅命中 eventId 内容一致 → exact_retry）。
5. 校验器从"仅 algorithm"扩展到 V1 全部 18 个允许事件类型，每类型至少一正一反样本。
6. 身份初始化改单 D1 batch，admin token 改期望值注入，凭据生成改 Web Crypto。
7. Miniflare 配置改对象形态 `d1Databases: { DB: "<uuid>" }`。

## Global Constraints

- 前置门 G0（主索引）：先确认 worktree 状态；本计划残留经用户确认后处理；用户未跟踪文件不删不改不提交。
- 受保护路径（本计划全部 Task 禁改）：`migrations/0005_schema12_jobs.sql`、`src/ingress.js`、`src/dispatcher.js`、`src/sync.js`、`src/event-store.js`、`src/qstash.js`、`src/reconciler.js`、所有 V1 store/model、`tools/reliable-drive-sync-mcp/local-outbox.mjs`、`tools/reliable-drive-sync-mcp/delivery-service.mjs`。`src/protocol.js` 只读（parity 测试引用，不修改）。
- 所有测试命令在 worktree `C:\Users\27846\my-chatgpt-mcp-v2` 执行；每 Task 结束 `git status --short` 只允许出现该 Task 文件。
- 提交规范：`git add` 只加本 Task 文件清单；消息前缀 `feat(v2):`/`test(v2):`/`chore(v2):`；禁止 `git add -A`、`reset --hard`、`checkout --`、`stash drop`。
- **D1 契约（全子计划强制）**：仓库方法返回 Promise；影响行数判定一律 `const res = await stmt.run(...); res.meta.changes === 1`；禁止读取 `res.changes`；`batch()` 入参只允许 `prepare(sql).bind(...)` 返回的语句对象。
- 每 Task 回滚方式相同：`git revert <task_sha>`。

## Interfaces

- **Produces**（后续子计划消费）：`shared/rds2-protocol.mjs` 导出 `canonicalJson(value)`、`sha256Hex(text)`、`validateEnvelope(envelope)`、`resolveIntent(lookups, incoming)`、`durableReceipt(fields)`、`alreadyRecordedReceipt(firstEvent)`、`ERROR_CODES`、`deriveDedupeKey(eventType, payload, userId)`、`ALLOWED_EVENT_TYPES`；`src/rds2/sqlite-adapter.js` 导出 `createSqliteAdapter(filePath)`（真实 D1 API 模拟）；`src/rds2/*-repository.js` 各导出异步工厂；`src/rds2/accept-service.js` 导出 `createAcceptService(db, deps)`；`src/rds2/credential-auth.js` 导出 `issueCredential(db, userId, token)`、`authenticateUser(db, bearerToken)`；`src/rds2/identity-init.js` 导出 `createIdentityInitService(db, deps)`；`migrations/0006_rds2_v2_tables.sql`。
- **Consumes**：`src/protocol.js`（parity 金样本只读）、`node:sqlite`、`miniflare`、Web Crypto（`crypto.subtle`/`crypto.getRandomValues`，Workers 与 Node ≥19 全局可用）。

---

### Task 1.1 共享协议模块：规范 JSON 与哈希 + 路径解析断言

**Files:** Create `shared/rds2-protocol.mjs`；Test `services/reliable-drive-sync-worker/test/rds2-protocol.test.js`
**Interfaces:** Produces `canonicalJson`, `sha256Hex` | Consumes `crypto.subtle`

- [ ] 1. 写失败测试 `services/reliable-drive-sync-worker/test/rds2-protocol.test.js`（测试文件在 `test/` 下，相对仓库根 shared 为三层 `../../../shared/…`；`src/rds2/` 下为四层 `../../../../shared/…`——本 Task 同时用一条 import 断言锁定两层路径均真实存在）：
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
    assert.equal(h1, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  test("shared module resolves from src/rds2 depth too (four-level relative import)", async () => {
    const mod = await import("../../../shared/rds2-protocol.mjs");
    assert.equal(typeof mod.canonicalJson, "function");
    // Task 1.8/1.9 等 src/rds2/ 内文件的 import 路径 '../../../../shared/rds2-protocol.mjs'
    // 由其各自测试文件的真实 import 隐式验证（解析失败即测试失败）。
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
- [ ] 4. 运行 `npm run test:worker 2>&1 | tail -4`，预期 `# fail 0`。
- [ ] 5. 提交：`git add shared/rds2-protocol.mjs services/reliable-drive-sync-worker/test/rds2-protocol.test.js && git commit -m "feat(v2): shared canonical json and sha256"`。

### Task 1.2 全事件类型校验器（18 类型注册表，每类型一正一反）

**Files:** Modify `shared/rds2-protocol.mjs`；Test 同 Task 1.1 文件追加 + 新建 `test/rds2-protocol-parity.test.js`
**Interfaces:** Produces `validateEnvelope`, `ALLOWED_EVENT_TYPES`, `ProtocolError`, `ERROR_CODES` | Consumes `protocol.js` 只读语义

- [ ] 1. 追加失败测试（外壳五条 + 类型覆盖十八条）：
  - 外壳：六字段白名单外字段 → `invalid_envelope_field`；namespace 非五值白名单 → `invalid_namespace`；`eventType.split(".")[0] !== namespace` → `namespace_event_type_mismatch`；`schemaVersion !== "1.2"` → `invalid_schema_version`；`identity` 缺 `userId`/`username` 任一或非字符串 → `identity_mismatch`。
  - 类型覆盖：`ALLOWED_EVENT_TYPES` 必须与 V1 `protocol.js` 的 `PAYLOAD_SCHEMA` 18 键完全一致（`system.user-registered`、`system.capabilities.read`、`system.user.resolve`、`system.legacy-migration-requested`、`algorithm.learning.completed`、`algorithm.daily-plan-created`、`interview.session.list`、`interview.session.load`、`interview.session.completed`、`interview.review.completed`、`resume-knowledge.resume-ingested`、`resume-knowledge.claim-confirmed`、`resume-knowledge.claim-rejected`、`resume-knowledge.question-bank-created`、`resume-knowledge.daily-plan-created`、`resume-knowledge.answer-scored`、`profile.evidence.recorded`、`profile.snapshot.read`）。**每个类型至少一组合法样本和一组非法样本**（非法样本至少含：缺必需字段、内外 eventType 不一致、多未知字段三类中的适用项）；UUID 字段不符合 RFC 4122 正则、`observedAt/completedAt` 不符 RFC3339、`localDate` 不符 `^\d{4}-\d{2}-\d{2}$`、`sessionId` 不符 `^(MOCK|REAL)-` 均拒绝。逐类型断言写在参数化测试（`for (const [type, schema] of registry)`）。
- [ ] 2. 运行 `npm run test:worker 2>&1 | tail -4`，预期新增用例全部 fail。
- [ ] 3. 实现（字段集与 V1 `protocol.js:33-55` 的 `PAYLOAD_SCHEMA` 与各 `*_FIELDS` 集合逐字段对齐，不 import V1 文件；核心结构如下）：
  ```js
  export const ERROR_CODES = { invalid_envelope_field: "invalid_envelope_field", invalid_namespace: "invalid_namespace",
    namespace_event_type_mismatch: "namespace_event_type_mismatch", invalid_schema_version: "invalid_schema_version",
    invalid_payload: "invalid_payload", invalid_event_type: "invalid_event_type",
    request_id_conflict: "request_id_conflict", event_id_conflict: "event_id_conflict",
    event_key_already_recorded: "event_key_already_recorded", idempotency_state_corrupt: "idempotency_state_corrupt",
    identity_mismatch: "identity_mismatch", identity_not_found: "identity_not_found", user_disabled: "user_disabled",
    unauthorized: "unauthorized", forbidden: "forbidden", namespace_not_enabled: "namespace_not_enabled" };
  export class ProtocolError extends Error { constructor(code) { super(code); this.code = code; } }
  const ENVELOPE_FIELDS = new Set(["schemaVersion", "namespace", "eventType", "identity", "payload", "requestId"]);
  const NAMESPACES = new Set(["system", "algorithm", "interview", "resume-knowledge", "profile"]);
  // PAYLOAD_REGISTRY：18 个 eventType → { required: [...], optional: [...], innerFields: Set, validators: {...} }
  // 内部事件字段集逐字对齐 V1：SESSION_FIELDS/REVIEW_FIELDS/ALGORITHM_FIELDS/ALGORITHM_PLAN_FIELDS/
  // RESUME_INGESTED_FIELDS/RESUME_CLAIM_FIELDS/RESUME_BANK_FIELDS/RESUME_PLAN_FIELDS/ANSWER_SCORED_FIELDS
  // 及 generic-profile 契约（action ∈ observe|supersede|invalidate、domain 白名单、observations 数组）
  export function validateEnvelope(envelope) {
    if (!envelope || typeof envelope !== "object") throw new ProtocolError("invalid_payload");
    for (const key of Object.keys(envelope)) if (!ENVELOPE_FIELDS.has(key)) throw new ProtocolError("invalid_envelope_field");
    if (envelope.schemaVersion !== "1.2") throw new ProtocolError("invalid_schema_version");
    if (!NAMESPACES.has(envelope.namespace)) throw new ProtocolError("invalid_namespace");
    if (!ALLOWED_EVENT_TYPES.has(envelope.eventType)) throw new ProtocolError("invalid_event_type");
    if (envelope.eventType.split(".")[0] !== envelope.namespace) throw new ProtocolError("namespace_event_type_mismatch");
    if (typeof envelope.requestId !== "string" || !envelope.requestId.trim()) throw new ProtocolError("invalid_payload");
    if (!envelope.identity || typeof envelope.identity.userId !== "string" || !envelope.identity.userId.trim()
      || typeof envelope.identity.username !== "string" || !envelope.identity.username.trim()) throw new ProtocolError("identity_mismatch");
    validatePayload(envelope); // 按 PAYLOAD_REGISTRY 分派：required 精确、字段集合精确（多未知字段拒绝）、
                               // UUID/RFC3339/localDate/sessionId 正则、内外 eventType 一致、
                               // generic-profile 的 action/domain/observations、resume claim 类型集合
    return envelope;
  }
  ```
- [ ] 4. 追加 parity 金样本测试 `test/rds2-protocol-parity.test.js`：从 `protocol.js`（`inspectEnvelope`+`validateEventForBoundary` 组合语义）与 shared 校验器分别跑 **每个允许类型各一组合法样本 + 各一组非法样本（共 ≥36 组）**，断言二者"合法/非法"结论一致（不比较错误文案）。运行预期 `# fail 0`；出现不一致 → halt-and-report 差异样本，不得改 V1。
- [ ] 5. 提交：`git add shared/rds2-protocol.mjs services/reliable-drive-sync-worker/test/rds2-protocol.test.js services/reliable-drive-sync-worker/test/rds2-protocol-parity.test.js && git commit -m "feat(v2): full-coverage shared envelope validator with v1 parity"`。

### Task 1.3 resolveIntent：四查询入口 + 七条矩阵

**Files:** Modify `shared/rds2-protocol.mjs`；Test 同 1.1 文件追加
**Interfaces:** Produces `resolveIntent(lookups, incoming)` | Consumes `canonicalJson/sha256Hex`

- [ ] 1. 失败测试（矩阵逐条参数化，`lookups = { byRequestId, byEventId, byEventKey, byBusinessDedupeKey }`，命中行含 `envelope_hash/event_id/request_id`，`incoming = { envelopeHash, eventId, requestId }`）：
  1. 全部命中同一事件且 hash 相同 → `{kind:"exact_retry", event:<行>}`；
  2. `byRequestId` 命中 hash 不同 → `{kind:"conflict", code:"request_id_conflict"}`；
  3. `byEventId` 命中 hash 不同 **或** `request_id` 不同 → `{code:"event_id_conflict"}`；
  4. `byEventKey` 命中且 `event_id !== incoming.eventId` → `{kind:"already_recorded", first:<byEventKey 行>}`；
  5. 仅 `byBusinessDedupeKey` 命中且指向不同事件 → `{kind:"already_recorded", first:<dedupe 行>}`（响应不暴露 UNIQUE）；
  6. 多个查询命中**不同 event_id** 且无任何单行与 incoming 完全一致 → `{kind:"corrupt"}`（accept-service 转 500 `idempotency_state_corrupt`）；
  7. **仅命中 `byEventId` 且内容一致**（requestId 未命中）→ `exact_retry`（同一事实幂等重放），**不得判 `new_event`**；
  8. 四查询全空 → `{kind:"new_event"}`；
  9. 优先级：conflict > corrupt > exact_retry > already_recorded > new_event（用组合样本锁定）。
- [ ] 2. 预期失败：`resolveIntent is not a function`。
- [ ] 3. 实现：
  ```js
  export function resolveIntent(lookups, incoming) {
    const req = lookups.byRequestId, evt = lookups.byEventId,
          key = lookups.byEventKey, dedupe = lookups.byBusinessDedupeKey;
    if (req && req.envelope_hash !== incoming.envelopeHash) return { kind: "conflict", code: "request_id_conflict" };
    if (evt && (evt.envelope_hash !== incoming.envelopeHash || evt.request_id !== incoming.requestId))
      return { kind: "conflict", code: "event_id_conflict" };
    const hits = [req, evt, key, dedupe].filter(Boolean);
    const distinct = new Set(hits.map((r) => r.event_id));
    if (evt) { // evt 与 incoming 完全一致（上面已排除冲突）→ 同一事实幂等重放，无论 requestId 是否首次出现
      if (distinct.size === 1) return { kind: "exact_retry", event: evt };
      return { kind: "corrupt" }; // evt 指向 A 而 key/dedupe 指向 B
    }
    if (distinct.size > 1) return { kind: "corrupt" };
    if (key) return { kind: "already_recorded", first: key };
    if (dedupe) return { kind: "already_recorded", first: dedupe };
    if (req) return { kind: "exact_retry", event: req };
    return { kind: "new_event" };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add shared/rds2-protocol.mjs services/reliable-drive-sync-worker/test/rds2-protocol.test.js && git commit -m "feat(v2): four-lookup seven-rule intent resolution"`。

### Task 1.4 durable receipt 与 already_recorded receipt 构造器

**Files:** Modify `shared/rds2-protocol.mjs`；Test 同文件追加
**Interfaces:** Produces `durableReceipt`, `alreadyRecordedReceipt` | Consumes 无

- [ ] 1. 失败测试：`durableReceipt({requestId,eventId,eventKey,eventSeq:101,taskId:"t_project_101"})` 返回 `status:"accepted"`、`deliveryState:"cloud_accepted"`、`persistence:{localOutbox:"acknowledged",eventLedger:"accepted",projection:"pending",drive:"pending"}`；字符串化后不匹配 `/drive.synced|snapshot.updated/i`。`alreadyRecordedReceipt(firstRow)` 返回 `status:"already_recorded"`、首次事件的 `requestId/eventId/eventKey/eventSeq/taskId`、`persistence.drive:"pending"`，且**不含**任何 SQL 异常痕迹。
- [ ] 2. 预期失败：函数不存在。
- [ ] 3. 实现：`durableReceipt` 同 Rev 3；新增：
  ```js
  export function alreadyRecordedReceipt(firstRow) {
    return { status: "already_recorded", requestId: firstRow.request_id, eventId: firstRow.event_id,
      eventKey: firstRow.event_key, eventSeq: firstRow.event_seq, taskId: `t_project_${firstRow.event_seq}`,
      persistence: { localOutbox: "acknowledged", eventLedger: "already_recorded", projection: "see_first_receipt", drive: "pending" } };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add shared/rds2-protocol.mjs services/reliable-drive-sync-worker/test/rds2-protocol.test.js && git commit -m "feat(v2): durable and already-recorded receipt builders"`。

### Task 1.5 business_dedupe_key 派生函数

**Files:** Modify `shared/rds2-protocol.mjs`；Test 同文件追加
**Interfaces:** Produces `deriveDedupeKey` | Consumes Task 1.2 校验后的 envelope

- [ ] 1. 失败测试：`deriveDedupeKey("resume-knowledge.answer-scored", { event: { questionKey: "Q1", localDate: "2026-09-05" } }, "u-1")` → `"u-1|2026-09-05|Q1"`；其他 eventType → `null`；answer-scored 缺 questionKey/localDate → 抛 `invalid_payload`。
- [ ] 2. 预期失败：函数不存在。
- [ ] 3. 实现：同 Rev 3 版本（逻辑未变）。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add shared/rds2-protocol.mjs services/reliable-drive-sync-worker/test/rds2-protocol.test.js && git commit -m "feat(v2): server-side business dedupe key derivation"`。

### Task 1.6 迁移 0006：六表 + 业务唯一索引 + CHECK + CAS 触发器 + queued_at + 凭据列

**Files:** Create `services/reliable-drive-sync-worker/migrations/0006_rds2_v2_tables.sql`；Test `services/reliable-drive-sync-worker/test/rds2-schema.test.js`
**Interfaces:** Produces 六表 schema | Consumes 无

- [ ] 1. 失败测试（node:sqlite 内存库执行迁移 SQL 后断言；在 Rev 3 五条基础上追加两条）：
  - Rev 3 已有：六表存在；Outbox 四类非法形状被 CHECK 拒绝；每事件一个 project task（部分唯一索引）；CAS 触发器 ABORT 旧游标写入；`business_dedupe_key` 部分唯一拦截同作用域。
  - **Rev 4 追加**：
  ```js
  test("business scope unique index blocks duplicate (user,namespace,type,key)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    const ins = (seq, key, dedupe = null) => db.exec(`INSERT INTO rds2_business_events
      (event_seq,event_id,request_id,user_id,namespace,event_type,event_key,envelope_json,envelope_hash,business_dedupe_key,occurred_at,accepted_at)
      VALUES (${seq},'e${seq}','r${seq}','u1','algorithm','algorithm.learning.completed','${key}','{}','h',${dedupe ? `'${dedupe}'` : "NULL"},'2026-09-05','2026-09-05')`);
    ins(1, "k1");
    assert.throws(() => ins(2, "k1"), /UNIQUE/);   // 同作用域第二事件被拒
    ins(3, "k2");
    db.exec(`INSERT INTO rds2_business_events (event_seq,event_id,request_id,user_id,namespace,event_type,event_key,envelope_json,envelope_hash,occurred_at,accepted_at)
      VALUES (4,'e4','r4','u2','algorithm','algorithm.learning.completed','k1','{}','h','2026-09-05','2026-09-05')`); // 其他用户同 key 合法
  });
  test("credentials table has status/revoked_at; outbox has queued_at", () => {
    const db = freshDb();
    assert.deepEqual(db.prepare("PRAGMA table_info(rds2_credentials)").all().map((r) => r.name),
      ["credential_hash", "user_id", "status", "revoked_at", "created_at"]);
    assert.ok(db.prepare("PRAGMA table_info(rds2_event_outbox)").all().some((r) => r.name === "queued_at"));
    assert.throws(() => db.exec(`INSERT INTO rds2_credentials VALUES ('h','u1','bogus',NULL,'2026')`), /CHECK/);
  });
  ```
- [ ] 2. 运行 `npm run test:worker 2>&1 | tail -4`，预期新用例 fail（`no such table`）。
- [ ] 3. 最小实现 `migrations/0006_rds2_v2_tables.sql`（全部 `IF NOT EXISTS`，不动 0005；`rds2_users/rds2_business_events/rds2_archive_deliveries/rds2_projections/rds2_event_outbox` 表体与 Rev 3 相同，差异如下）：
  ```sql
  -- rds2_business_events 索引区追加（event_key NOT NULL，无需部分索引）：
  CREATE UNIQUE INDEX IF NOT EXISTS idx_rds2_events_business_scope
    ON rds2_business_events(user_id, namespace, event_type, event_key);

  -- rds2_event_outbox 列追加：
  --   queued_at TEXT,
  -- （CREATE TABLE 列序：... lease_owner, lease_until, queued_at, queue_message_id, ...）

  CREATE TABLE IF NOT EXISTS rds2_credentials (
    credential_hash TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES rds2_users(user_id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
    revoked_at TEXT,
    created_at TEXT NOT NULL
  );
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/migrations/0006_rds2_v2_tables.sql services/reliable-drive-sync-worker/test/rds2-schema.test.js && git commit -m "feat(v2): rds2 six-table migration with business scope unique index"`。

### Task 1.7 SQLite 快速适配器（真实 D1 API 模拟）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/sqlite-adapter.js`；Test `services/reliable-drive-sync-worker/test/rds2-sqlite-adapter.test.js`
**Interfaces:** Produces `createSqliteAdapter(filePath)` → `{prepare, batch, exec}`（D1 语义）| Consumes `node:sqlite`

- [ ] 1. 失败测试（**API 形状与真实 D1 完全一致**）：
  ```js
  test("prepare().bind().first/all/run mirror the real d1 api", async () => {
    const adapter = createSqliteAdapter(join(await mkdtemp(join(tmpdir(), "rds2-")), "t.sqlite"));
    adapter.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)");
    await adapter.prepare("INSERT INTO t VALUES (?, ?)").bind("a", "1").run();
    assert.equal((await adapter.prepare("SELECT COUNT(*) c FROM t").first()).c, 1);
    assert.deepEqual((await adapter.prepare("SELECT id FROM t").bind("a").all()).length === 1 ||
                     (await adapter.prepare("SELECT id FROM t").all()).length === 1, true);
  });
  test("batch accepts bound statements and returns meta.changes; rolls back atomically", async () => {
    const adapter = createSqliteAdapter(join(await mkdtemp(join(tmpdir(), "rds2-")), "t2.sqlite"));
    adapter.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)");
    const good = adapter.prepare("INSERT INTO t VALUES ('a','1')");
    const result = await adapter.batch([good, adapter.prepare("UPDATE t SET v='2' WHERE id='a'")]);
    assert.equal(result[1].meta.changes, 1);                    // meta.changes，不是 .changes
    const bad = adapter.prepare("INSERT INTO t VALUES ('a','9')"); // 主键冲突
    await assert.rejects(() => adapter.batch([adapter.prepare("DELETE FROM t"), bad]));
    assert.equal((await adapter.prepare("SELECT COUNT(*) c FROM t").first()).c, 1); // 回滚生效
  });
  test("run returns meta.changes for UPDATE", async () => {
    const adapter = createSqliteAdapter(join(await mkdtemp(join(tmpdir(), "rds2-")), "t3.sqlite"));
    adapter.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)");
    await adapter.prepare("INSERT INTO t VALUES ('a','1')").run();
    const res = await adapter.prepare("UPDATE t SET v='2' WHERE id='a'").run();
    assert.equal(res.meta.changes, 1);
  });
  test("statements are async: first/all/run/batch return promises", async () => {
    const adapter = createSqliteAdapter(":memory:");
    adapter.exec("CREATE TABLE t (id TEXT)");
    const p = adapter.prepare("SELECT * FROM t").first();
    assert.ok(p instanceof Promise);
    assert.ok(adapter.batch([]) instanceof Promise);
  });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  import { DatabaseSync } from "node:sqlite";
  export function createSqliteAdapter(filePath) {
    const db = new DatabaseSync(filePath);
    db.exec("PRAGMA foreign_keys = ON");
    function prepare(sql) {
      const bound = (params) => ({
        first: async () => db.prepare(sql).get(...params) ?? null,
        all: async () => db.prepare(sql).all(...params),
        run: async () => {
          const r = db.prepare(sql).run(...params);
          return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
        }
      });
      return { bind: (...params) => bound(params), ...bound([]) };
    }
    return {
      prepare,
      exec: (sql) => db.exec(sql),
      async batch(statements) {
        db.exec("BEGIN");
        try {
          const results = [];
          for (const stmt of statements) {
            const r = db.prepare(stmt.sql).run(...stmt.params);
            results.push({ success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } });
          }
          db.exec("COMMIT");
          return results;
        } catch (cause) { db.exec("ROLLBACK"); throw cause; }
      }
    };
  }
  ```
  （绑定语句对象内部携带 `{sql, params}`——这是适配器的私有实现细节，**对仓库层不可见**：仓库层只见 `prepare(sql).bind(...)` 返回可传入 `batch()` 的语句对象，与真实 D1 一致。）
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/sqlite-adapter.js services/reliable-drive-sync-worker/test/rds2-sqlite-adapter.test.js && git commit -m "feat(v2): sqlite adapter mirroring real d1 api"`。

### Task 1.8 user-repository（async D1 契约）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/user-repository.js`；Test `services/reliable-drive-sync-worker/test/rds2-user-repository.test.js`
**Interfaces:** Produces `createUserRepository(db)` → `{register, byNameKey, byId, assertActive}`（全 async）| Consumes adapter
**Import 路径锁定：** `import { normalizeNameKey } from "./name-key.js"` 不适用——`normalizeNameKey` 在本文件导出；shared 引用统一 `../../../../shared/rds2-protocol.mjs`（四层）。

- [ ] 1. 失败测试：`register("乔炳源")` 生成 UUID v4 格式 user 且 `name_key === "乔炳源"`；同 displayName 重复注册返回同一行（幂等）；`byId` 不存在 → `null`；`assertActive` 对 `status='disabled'` 抛 `user_disabled`；显式传入与现有 name_key 不同的 userId → 抛 `name_key_conflict`；**所有方法返回 Promise**。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  export const normalizeNameKey = (displayName) => displayName.normalize("NFKC").trim();
  export function createUserRepository(db) {
    return {
      async register(displayName, userIdOverride) {
        const nameKey = normalizeNameKey(displayName);
        const existing = await db.prepare("SELECT * FROM rds2_users WHERE name_key = ?").bind(nameKey).first();
        if (existing) {
          if (userIdOverride && userIdOverride !== existing.user_id) throw new Error("name_key_conflict");
          return existing;
        }
        const userId = userIdOverride ?? crypto.randomUUID();
        const now = new Date().toISOString();
        await db.prepare("INSERT INTO rds2_users (user_id, display_name, name_key, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
          .bind(userId, displayName.trim(), nameKey, now, now).run();
        return db.prepare("SELECT * FROM rds2_users WHERE user_id = ?").bind(userId).first();
      },
      byNameKey: (nameKey) => db.prepare("SELECT * FROM rds2_users WHERE name_key = ?").bind(normalizeNameKey(nameKey)).first(),
      byId: (userId) => db.prepare("SELECT * FROM rds2_users WHERE user_id = ?").bind(userId).first(),
      async assertActive(userId) {
        const user = await this.byId(userId);
        if (!user) throw new Error("identity_not_found");
        if (user.status !== "active") throw new Error("user_disabled");
        return user;
      }
    };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/user-repository.js services/reliable-drive-sync-worker/test/rds2-user-repository.test.js && git commit -m "feat(v2): async user repository with nfkc name key"`。

### Task 1.9 credential-repository（追加签发 + active 校验 + Web Crypto）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/credential-auth.js`；Test `services/reliable-drive-sync-worker/test/rds2-credential-auth.test.js`
**Interfaces:** Produces `issueCredential(db, userId, token)`（追加签发）、`authenticateUser(db, bearerToken)` | Consumes `sha256Hex`, Task 1.8

- [ ] 1. 失败测试：`issueCredential` 写入 SHA-256 哈希（库中查不到明文）且 `status='active'`；**同用户二次签发不撤销旧行**（旧行仍 `active`——追加签发语义，测试显式断言两行共存）；`authenticateUser` 对任一 active 凭据返回用户行；`revoked` 状态凭据拒绝（`unauthorized`）；未知 token 抛 `unauthorized`；被禁用用户凭据抛 `user_disabled`；token 明文不出现在任何抛错消息中。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  import { sha256Hex } from "../../../../shared/rds2-protocol.mjs";
  export async function issueCredential(db, userId, token) {
    const hash = await sha256Hex(token);
    await db.prepare("INSERT INTO rds2_credentials (credential_hash, user_id, status, revoked_at, created_at) VALUES (?, ?, 'active', NULL, ?)")
      .bind(hash, userId, new Date().toISOString()).run();
    return hash;
  }
  export async function authenticateUser(db, bearerToken) {
    if (typeof bearerToken !== "string" || !bearerToken.startsWith("Bearer ")) throw new Error("unauthorized");
    const hash = await sha256Hex(bearerToken.slice(7));
    const row = await db.prepare("SELECT user_id FROM rds2_credentials WHERE credential_hash = ? AND status = 'active'").bind(hash).first();
    if (!row) throw new Error("unauthorized");
    const user = await db.prepare("SELECT * FROM rds2_users WHERE user_id = ?").bind(row.user_id).first();
    if (!user) throw new Error("unauthorized");
    if (user.status !== "active") throw new Error("user_disabled");
    return user;
  }
  export function randomCredentialToken() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);                       // Web Crypto，Workers/Node 通用
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/credential-auth.js services/reliable-drive-sync-worker/test/rds2-credential-auth.test.js && git commit -m "feat(v2): additive credential issuance with web crypto"`。

### Task 1.10 event-repository（异步 + 四查询入口 + 作用域游标）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/event-repository.js`；Test `services/reliable-drive-sync-worker/test/rds2-event-repository.test.js`
**Interfaces:** Produces `createEventRepository(db)` → `{readAfter, insert, byRequestId, byEventId, byEventKey, byBusinessDedupeKey}`（全 async）| Consumes adapter

- [ ] 1. 失败测试（Rev 3 两条保留 + 新增）：
  - `readAfter("u1","algorithm",0,10)` 只返回该用户该域事件、按 `event_seq ASC`；其他用户事件不消耗 limit；
  - `insert` 返回 Promise 且插入后可由四个查询入口寻址；
  - **`byBusinessDedupeKey("u1|2026-09-05|Q1")` 命中插入时携带 dedupeKey 的行**，未携带 → `null`；
  - `byEventKey(userId, namespace, eventType, eventKey)` 四元组作用域：同 key 不同 namespace → `null`。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  export function createEventRepository(db) {
    const insertStmt = `INSERT INTO rds2_business_events
      (event_id, request_id, user_id, namespace, event_type, event_key, envelope_json, envelope_hash, business_dedupe_key, occurred_at, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    return {
      insert(input) {
        return db.prepare(insertStmt).bind(input.eventId, input.requestId, input.userId, input.namespace,
          input.eventType, input.eventKey, input.envelopeJson, input.envelopeHash,
          input.businessDedupeKey ?? null, input.occurredAt, new Date().toISOString()).run();
      },
      readAfter: (userId, namespace, afterEventSeq, limit) =>
        db.prepare(`SELECT * FROM rds2_business_events WHERE user_id = ? AND namespace = ? AND event_seq > ? ORDER BY event_seq ASC LIMIT ?`)
          .bind(userId, namespace, afterEventSeq, limit).all(),
      byRequestId: (requestId) => db.prepare("SELECT * FROM rds2_business_events WHERE request_id = ?").bind(requestId).first(),
      byEventId: (eventId) => db.prepare("SELECT * FROM rds2_business_events WHERE event_id = ?").bind(eventId).first(),
      byEventKey: (userId, namespace, eventType, eventKey) =>
        db.prepare("SELECT * FROM rds2_business_events WHERE user_id = ? AND namespace = ? AND event_type = ? AND event_key = ?")
          .bind(userId, namespace, eventType, eventKey).first(),
      byBusinessDedupeKey: (dedupeKey) =>
        db.prepare("SELECT * FROM rds2_business_events WHERE business_dedupe_key = ?").bind(dedupeKey).first()
    };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/event-repository.js services/reliable-drive-sync-worker/test/rds2-event-repository.test.js && git commit -m "feat(v2): async event repository with four lookup entries"`。

### Task 1.11 outbox-repository（原子认领 UPDATE…RETURNING + meta.changes + 陈旧 queued 回收）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/outbox-repository.js`；Test `services/reliable-drive-sync-worker/test/rds2-outbox-repository.test.js`
**Interfaces:** Produces `createOutboxRepository(db)` → `{claimDue, claimOne, renewLease, markQueued, markProcessing, complete, failWithBackoff, toNeedsAttention, releaseLease, byTaskId, reclaimExpired, reclaimStaleQueued}`（全 async）| Consumes adapter
**迁移适配注：** SQLite（node:sqlite ≥ Node 22 内置 3.40+）支持 `RETURNING`；Miniflare 真 D1 同样支持。两环境同一 SQL。

- [ ] 1. 失败测试：
  - `claimDue(5,"w1")` 用**单条 `UPDATE … WHERE task_id IN (SELECT …) RETURNING *`** 认领：返回 ≤5 行、全部 `state='dispatching'` 且带租约；**并发互斥**：注入第二个 adapter 指向同一 sqlite 文件，第一个 claimDue 后第二个同参调用返回 0 行（写锁 + 条件子查询保证）；
  - `claimOne(taskId, owner)`：`pending` 行 → 置 `dispatching` 返回行；非 pending → 返回 `null`（不抛）；
  - `markQueued` 只接受 `dispatching`：成功写 `queued` + `queued_at`；对 `queued/processing/completed` 行调用抛 `illegal_state_transition`；
  - `complete(taskId)` 后 `state='completed'`；对 `completed` 行幂等；
  - `failWithBackoff` 第 5 次（阈值）转 `needs_attention`；此前转 `pending` + `available_at`；
  - `reclaimExpired` 把 `lease_until < now` 的 `dispatching/processing` 复位 `pending` 且 `attempt_count+1`；
  - **`reclaimStaleQueued(now)`**：把 `state='queued' AND queued_at <= now-10min` 的行复位 `pending`（`queued_at` 早于阈值），返回影响行数；`queued_at` 新鲜的行不动；
  - **每个 UPDATE 断言 `res.meta.changes`**：对 `markQueued`/`complete`/`failWithBackoff` 注入 0 行命中场景 → 抛 `illegal_state_transition` 或返回 `"noop"`，绝不允许静默成功；
  - `queue_message_id` 恒写 NULL。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（核心语句）：
  ```js
  const RETRY_THRESHOLD = 5;
  const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
  const QUEUED_STALE_MS = 10 * 60_000;
  export function createOutboxRepository(db) {
    const ok = (res, n = 1) => { if (res.meta.changes !== n) throw new Error("illegal_state_transition"); return res; };
    return {
      async claimDue(limit, owner, now = new Date().toISOString()) {
        db; // 单条原子认领：条件子查询 + RETURNING，两个 Worker 并发不返回同一批
        return db.prepare(`UPDATE rds2_event_outbox
          SET state='dispatching', lease_owner=?, lease_until=?, attempt_count=attempt_count+1, updated_at=?
          WHERE task_id IN (SELECT task_id FROM rds2_event_outbox WHERE state='pending' AND available_at <= ? ORDER BY available_at ASC LIMIT ?)
          RETURNING *`).bind(owner, new Date(Date.now() + 60_000).toISOString(), now, now, limit).all();
      },
      async claimOne(taskId, owner, now = new Date().toISOString()) {
        const rows = await db.prepare(`UPDATE rds2_event_outbox
          SET state='dispatching', lease_owner=?, lease_until=?, attempt_count=attempt_count+1, updated_at=?
          WHERE task_id = ? AND state='pending' RETURNING *`).bind(owner, new Date(Date.now() + 60_000).toISOString(), now, taskId).all();
        return rows[0] ?? null;
      },
      async markQueued(taskId) {
        ok(await db.prepare(`UPDATE rds2_event_outbox SET state='queued', queued_at=?, lease_owner=NULL, lease_until=NULL, updated_at=? WHERE task_id=? AND state='dispatching'`)
          .bind(new Date().toISOString(), new Date().toISOString(), taskId).run());
      },
      async complete(taskId) {
        const res = await db.prepare(`UPDATE rds2_event_outbox SET state='completed', updated_at=? WHERE task_id=? AND state IN ('dispatching','queued','processing')`)
          .bind(new Date().toISOString(), taskId).run();
        return res.meta.changes === 1 ? "completed" : "noop";
      },
      async failWithBackoff(taskId, errorCode, now = Date.now()) {
        const row = await this.byTaskId(taskId);
        if (!row) return "noop";
        if (row.attempt_count >= RETRY_THRESHOLD) {
          await db.prepare(`UPDATE rds2_event_outbox SET state='needs_attention', last_error_code=?, lease_owner=NULL, updated_at=? WHERE task_id=? AND state != 'completed'`)
            .bind(errorCode, new Date(now).toISOString(), taskId).run();
          return "needs_attention";
        }
        await db.prepare(`UPDATE rds2_event_outbox SET state='pending', last_error_code=?, lease_owner=NULL, available_at=?, updated_at=? WHERE task_id=? AND state != 'completed'`)
          .bind(errorCode, new Date(now + BACKOFF_MS[Math.min(row.attempt_count, BACKOFF_MS.length - 1)]).toISOString(), new Date(now).toISOString(), taskId).run();
        return "pending";
      },
      reclaimExpired: (now = new Date().toISOString()) =>
        db.prepare(`UPDATE rds2_event_outbox SET state='pending', lease_owner=NULL, attempt_count=attempt_count+1, updated_at=? WHERE lease_until IS NOT NULL AND lease_until < ? AND state IN ('dispatching','processing')`).bind(now, now).run(),
      reclaimStaleQueued: (now = Date.now()) =>
        db.prepare(`UPDATE rds2_event_outbox SET state='pending', lease_owner=NULL, updated_at=? WHERE state='queued' AND queued_at <= ?`)
          .bind(new Date(now).toISOString(), new Date(now - QUEUED_STALE_MS).toISOString()).run(),
      byTaskId: (taskId) => db.prepare("SELECT * FROM rds2_event_outbox WHERE task_id = ?").bind(taskId).first()
    };
  }
  ```
  （`markProcessing/toNeedsAttention/renewLease/releaseLease` 按同一 `meta.changes` 模式补全；`toNeedsAttention` 即 `failWithBackoff` 阈值路径的显式版本。）
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/outbox-repository.js services/reliable-drive-sync-worker/test/rds2-outbox-repository.test.js && git commit -m "feat(v2): atomic outbox claiming with returning and meta changes"`。

### Task 1.12 projection-repository（异步 + 触发器 CAS）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/projection-repository.js`；Test `services/reliable-drive-sync-worker/test/rds2-projection-repository.test.js`
**Interfaces:** Produces `createProjectionRepository(db)` → `{get, upsert, updateAdvanced}`（全 async）| Consumes adapter, 迁移触发器

- [ ] 1. 失败测试：`updateAdvanced` 执行无 seq 谓词的 UPDATE；游标 100 写 `last_event_seq=90` → 抛 `/stale_projection_write/`；写 110 成功且 `res.meta.changes === 1`；两个消费者同读 100，A 写 110 后 B 写 110 → 抛 `stale_projection_write`；`upsert` 幂等；返回 Promise。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（与 Rev 3 相同语义，改 async + meta.changes）：
  ```js
  export function createProjectionRepository(db) {
    return {
      get: (userId, namespace, projectionName) =>
        db.prepare("SELECT * FROM rds2_projections WHERE user_id=? AND namespace=? AND projection_name=?").bind(userId, namespace, projectionName).first(),
      async upsert(userId, namespace, projectionName) {
        await db.prepare(`INSERT OR IGNORE INTO rds2_projections (user_id, namespace, projection_name, last_event_seq, state_json, public_view_json, content_hash, updated_at)
          VALUES (?, ?, ?, 0, '{}', '{}', 'empty', ?)`).bind(userId, namespace, projectionName, new Date().toISOString()).run();
      },
      async updateAdvanced(fields) {
        const res = await db.prepare(`UPDATE rds2_projections SET last_event_seq=?, state_json=?, public_view_json=?, content_hash=?, updated_at=?
          WHERE user_id=? AND namespace=? AND projection_name=?`)
          .bind(fields.lastEventSeq, fields.stateJson, fields.publicViewJson, fields.contentHash, new Date().toISOString(),
            fields.userId, fields.namespace, fields.projectionName).run();
        if (res.meta.changes !== 1) throw new Error("projection_row_missing");
        return res;
      }
    };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/projection-repository.js services/reliable-drive-sync-worker/test/rds2-projection-repository.test.js && git commit -m "feat(v2): async projection repository guarded by cas trigger"`。

### Task 1.13 archive-delivery-repository（异步 + 确定性 ID + 状态机）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/archive-delivery-repository.js`；Test `services/reliable-drive-sync-worker/test/rds2-archive-delivery-repository.test.js`
**Interfaces:** Produces `createArchiveDeliveryRepository(db)` → `{freezeExisting, freezeRows, markDelivering, markDelivered, markNeedsAttention, claimableGroups, byArtifactKey}`（全 async）| Consumes adapter, `sha256Hex`
**Rev 4 注：** `freeze` 不再在接收/投影路径单独调用——投影/接收的冻结 INSERT 并入其所属原子 batch（子计划 2 引擎、本 Task 1.14/1.15 装配）。本仓库提供供 batch 使用的语句与独立维护方法。

- [ ] 1. 失败测试：`deterministicDeliveryId(artifactKey)` = `sha256(artifact_key)` 前 32 hex（硬编码期望值断言）；`markDelivering` 对非 `pending` 行抛 `illegal_state_transition`（`meta.changes` 判定）；`markDelivered` 记录 `drive_file_id`；`claimableGroups(4)` 按 `(user_id, namespace)` 分组 ≤4 组；`freezeRows` 生成的 INSERT OR IGNORE 语句对象可入 batch 且重复执行幂等（UNIQUE 冲突不影响后续语句）。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  import { sha256Hex } from "../../../../shared/rds2-protocol.mjs";
  export const deterministicDeliveryId = async (artifactKey) => (await sha256Hex(artifactKey)).slice(0, 32);
  export function createArchiveDeliveryRepository(db) {
    const insertSql = `INSERT OR IGNORE INTO rds2_archive_deliveries (archive_delivery_id, artifact_kind, artifact_key, user_id, namespace, source_event_seq, projection_name, projection_event_seq, artifact_json, artifact_hash, drive_path, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`;
    return {
      async freezeRows(rows) { // rows: [{deliveryId, artifactKind, artifactKey, userId, namespace, sourceEventSeq, projectionName, projectionEventSeq, artifactJson, artifactHash, drivePath}]
        const now = new Date().toISOString();
        return rows.map((f) => db.prepare(insertSql).bind(f.deliveryId, f.artifactKind, f.artifactKey, f.userId, f.namespace,
          f.sourceEventSeq ?? null, f.projectionName ?? null, f.projectionEventSeq ?? null,
          f.artifactJson, f.artifactHash, f.drivePath, now, now));
      },
      async markDelivering(id) {
        const r = await db.prepare("UPDATE rds2_archive_deliveries SET state='delivering', attempt_count=attempt_count+1, updated_at=? WHERE archive_delivery_id=? AND state='pending'")
          .bind(new Date().toISOString(), id).run();
        if (r.meta.changes !== 1) throw new Error("illegal_state_transition");
      },
      async markDelivered(id, driveFileId) {
        const r = await db.prepare("UPDATE rds2_archive_deliveries SET state='delivered', drive_file_id=?, updated_at=? WHERE archive_delivery_id=? AND state='delivering'")
          .bind(driveFileId, new Date().toISOString(), id).run();
        if (r.meta.changes !== 1) throw new Error("illegal_state_transition");
      },
      async markNeedsAttention(id, code) {
        await db.prepare("UPDATE rds2_archive_deliveries SET state='needs_attention', last_error_code=?, updated_at=? WHERE archive_delivery_id=? AND state != 'delivered'")
          .bind(code, new Date().toISOString(), id).run();
      },
      claimableGroups: (limit) =>
        db.prepare(`SELECT user_id, namespace, MIN(created_at) AS first_created FROM rds2_archive_deliveries WHERE state='pending' GROUP BY user_id, namespace ORDER BY first_created ASC LIMIT ?`).bind(limit).all(),
      byArtifactKey: (key) => db.prepare("SELECT * FROM rds2_archive_deliveries WHERE artifact_key = ?").bind(key).first()
    };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/archive-delivery-repository.js services/reliable-drive-sync-worker/test/rds2-archive-delivery-repository.test.js && git commit -m "feat(v2): async archive delivery repository with in-batch freeze"`。

### Task 1.14 accept-service（七矩阵 + 单 batch 原子接收 + 竞态重查）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/accept-service.js`；Test `services/reliable-drive-sync-worker/test/rds2-accept-service.test.js`
**Interfaces:** Produces `createAcceptService(db, deps)` → `accept(validatedEnvelope, user)`（async）| Consumes Task 1.2/1.3/1.5/1.8/1.10/1.11
**Rev 4 注：** canary 门从 accept-service 移除（收口在路由层 fail-closed，见子计划 4）；本服务只做身份、校验后语义与原子接收。

- [ ] 1. 失败测试：
  ```js
  test("event and project task commit atomically with deterministic task id", async () => {
    const svc = createAcceptService(db, deps);
    const receipt = await svc.accept(validAlgorithmEnvelope, user);
    assert.equal(receipt.taskId, `t_project_${receipt.eventSeq}`);
    assert.equal((await db.prepare("SELECT COUNT(*) c FROM rds2_business_events").first()).c, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) c FROM rds2_event_outbox WHERE task_type='project_event'").first()).c, 1);
  });
  test("mid-batch failure rolls back event insert", async () => { /* 注入 batch：第二条抛错 → 事件计数 0 */ });
  test("matrix rule 2/3: hash conflicts reject with stable codes", async () => { /* 同 requestId 不同内容 → request_id_conflict；同 eventId 不同内容 → event_id_conflict */ });
  test("matrix rule 4/5: eventKey/dedupe occupied returns first receipt as already_recorded", async () => { /* 不暴露 UNIQUE 异常 */ });
  test("matrix rule 6: cross-hit different events -> idempotency_state_corrupt", async () => { /* 预置冲突行 → 500 语义错误码，零写入 */ });
  test("matrix rule 1b: eventId-only hit with identical content returns exact_retry", async () => { /* 新 requestId 同 eventId 同内容 → 原 receipt，无第二行 */ });
  test("matrix rule 7: concurrent insert hits UNIQUE, re-lookup resolves to exact_retry", async () => {
    // 并发预查为空后两条相同 enqueue：一条成功一条撞 UNIQUE → 重查四入口 → exact_retry 返回原 eventSeq/taskId
  });
  test("disabled identity and identity_mismatch reject before any write", async () => { /* 计数断言零写入 */ });
  test("answer-scored derives business_dedupe_key", async () => { /* 库中查到 'u1|2026-09-05|Q1' */ });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（核心 batch，`event_seq` 由 SQL 内派生）：
  ```js
  import { canonicalJson, sha256Hex, resolveIntent, durableReceipt, alreadyRecordedReceipt, deriveDedupeKey, ProtocolError } from "../../../../shared/rds2-protocol.mjs";

  export function createAcceptService(db, { users, events, outbox }) {
    const lookupsFor = async (envelope, envelopeHash, userId) => ({
      byRequestId: await events.byRequestId(envelope.requestId),
      byEventId: await events.byEventId(envelope.payload.event.eventId),
      byEventKey: await events.byEventKey(userId, envelope.namespace, envelope.eventType, envelope.payload.event.eventKey),
      byBusinessDedupeKey: await events.byBusinessDedupeKey(deriveDedupeKey(envelope.eventType, envelope.payload, userId) ?? `__none__:${envelope.requestId}`)
    });
    return async function accept(envelope, user) {
      await users.assertActive(user.user_id);
      if (envelope.identity.userId !== user.user_id) throw new ProtocolError("identity_mismatch");
      if (envelope.identity.username.normalize("NFKC").trim() !== user.name_key) throw new ProtocolError("identity_mismatch");
      const envelopeHash = await sha256Hex(canonicalJson(envelope));
      const incoming = { envelopeHash, eventId: envelope.payload.event.eventId, requestId: envelope.requestId };
      const intent = resolveIntent(await lookupsFor(envelope, envelopeHash, user.user_id), incoming);
      if (intent.kind === "exact_retry") return retryReceipt(intent.event, outbox);
      if (intent.kind === "already_recorded") return alreadyRecordedReceipt(intent.first);
      if (intent.kind === "corrupt") throw new ProtocolError("idempotency_state_corrupt");
      const dedupeKey = deriveDedupeKey(envelope.eventType, envelope.payload, user.user_id);
      const now = new Date().toISOString();
      const insertEvent = db.prepare(`INSERT INTO rds2_business_events (request_id, event_id, user_id, namespace, event_type, event_key, envelope_json, envelope_hash, business_dedupe_key, occurred_at, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(envelope.requestId, envelope.payload.event.eventId, user.user_id, envelope.namespace, envelope.eventType,
              envelope.payload.event.eventKey, canonicalJson(envelope), envelopeHash, dedupeKey,
              envelope.payload.event.observedAt ?? now, now);
      const insertTask = db.prepare(`INSERT INTO rds2_event_outbox (task_id, task_type, event_seq, archive_delivery_id, state, attempt_count, queue_message_id, available_at, created_at, updated_at)
        SELECT 't_project_' || event_seq, 'project_event', event_seq, NULL, 'pending', 0, NULL, ?, ?, ? FROM rds2_business_events WHERE request_id = ?`)
        .bind(now, now, now, envelope.requestId);
      try {
        await db.batch([insertEvent, insertTask]);
      } catch (cause) {
        if (!/UNIQUE constraint failed/.test(String(cause))) throw cause;
        // 矩阵第 7 条：并发预查为空，唯一约束兜底 → 重查四入口按矩阵重新判定
        const reIntent = resolveIntent(await lookupsFor(envelope, envelopeHash, user.user_id), incoming);
        if (reIntent.kind === "exact_retry") return retryReceipt(reIntent.event, outbox);
        if (reIntent.kind === "already_recorded") return alreadyRecordedReceipt(reIntent.first);
        if (reIntent.kind === "corrupt") throw new ProtocolError("idempotency_state_corrupt");
        throw cause;
      }
      const row = await events.byRequestId(envelope.requestId);
      return durableReceipt({ requestId: envelope.requestId, eventId: row.event_id, eventKey: row.event_key, eventSeq: row.event_seq, taskId: `t_project_${row.event_seq}` });
    };
  }
  async function retryReceipt(row, outbox) {
    const task = await outbox.byTaskId(`t_project_${row.event_seq}`);
    return durableReceipt({ requestId: row.request_id, eventId: row.event_id, eventKey: row.event_key, eventSeq: row.event_seq, taskId: task?.task_id ?? `t_project_${row.event_seq}` });
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/accept-service.js services/reliable-drive-sync-worker/test/rds2-accept-service.test.js && git commit -m "feat(v2): atomic accept service implementing seven-rule matrix"`。

### Task 1.15 identity-init 服务逻辑（单 D1 batch + 期望值注入 + 零残留）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/identity-init.js`；Test `services/reliable-drive-sync-worker/test/rds2-identity-init.test.js`
**Interfaces:** Produces `createIdentityInitService(db, deps)` → `init({displayName, namespaces, userIdOverride?})`（admin token 由装配注入，非请求比较）| Consumes Task 1.8/1.9、`randomCredentialToken`
**路由接线（子计划 4 Task 4.6）**：`expectedAdminToken: env.RDS2_ADMIN_TOKEN`；本 Task 测试直接注入测试常量。

- [ ] 1. 失败测试：
  - `expectedAdminToken` 未配置（undefined/空串）→ 任何调用抛 `forbidden`（fail-closed）；调用方 token 与注入期望值不符 → `forbidden`（错误信息不含期望值）；
  - 首次 init 返回 `{userId, displayName, clientCredential}`（64 hex），库中 `rds2_credentials` 只有哈希且 `status='active'`；
  - **单 batch 原子性**：注入失败 batch（第三条语句抛错，模拟用户插入成功后凭据插入失败）→ users/credentials/projections 计数全部为 0（零残留）；
  - 重复 init 同 displayName 幂等返回同一 userId 且返回新凭据（追加签发：旧行仍 active，两行共存）；
  - 同 name_key 显式传不同 userId → `name_key_conflict`；`namespaces` 默认 `["algorithm"]`，每个 namespace 一行空投影；disabled 用户重新 init → `user_disabled`；
  - 凭据 token 由 `randomCredentialToken()` 生成（测试断言 64 hex 且两次调用不同——Web Crypto 熵源）。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  import { issueCredential, randomCredentialToken } from "./credential-auth.js";
  export function createIdentityInitService(db, { users, projections, expectedAdminToken }) {
    return async function init({ adminToken, displayName, namespaces = ["algorithm"], userIdOverride }) {
      if (!expectedAdminToken || adminToken !== expectedAdminToken) throw new Error("forbidden");
      // 单原子 batch：用户 + 凭据 + 全部初始投影（三条起，注入失败时一起回滚）
      const clientCredential = randomCredentialToken();
      const { sha256Hex } = await import("../../../../shared/rds2-protocol.mjs");
      const credentialHash = await sha256Hex(clientCredential);
      const nameKey = displayName.normalize("NFKC").trim();
      const now = new Date().toISOString();
      const existing = await users.byNameKey(nameKey);
      if (existing && userIdOverride && userIdOverride !== existing.user_id) throw new Error("name_key_conflict");
      if (existing && existing.status !== "active") throw new Error("user_disabled");
      const userId = existing?.user_id ?? userIdOverride ?? crypto.randomUUID();
      await db.batch([
        db.prepare(`INSERT INTO rds2_users (user_id, display_name, name_key, status, created_at, updated_at)
          VALUES (?, ?, ?, 'active', ?, ?) ON CONFLICT(user_id) DO NOTHING`)
          .bind(userId, displayName.trim(), nameKey, now, now),
        db.prepare("INSERT INTO rds2_credentials (credential_hash, user_id, status, revoked_at, created_at) VALUES (?, ?, 'active', NULL, ?)")
          .bind(credentialHash, userId, now),
        ...namespaces.map((ns) => db.prepare(`INSERT OR IGNORE INTO rds2_projections (user_id, namespace, projection_name, last_event_seq, state_json, public_view_json, content_hash, updated_at)
          VALUES (?, ?, ?, 0, '{}', '{}', 'empty', ?)`).bind(userId, ns, defaultProjectionName(ns), now))
      ]);
      const user = await users.assertActive(userId);
      return { userId: user.user_id, displayName: user.display_name, clientCredential };
    };
  }
  export function defaultProjectionName(namespace) { return namespace === "algorithm" ? "learning" : namespace; }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/identity-init.js services/reliable-drive-sync-worker/test/rds2-identity-init.test.js && git commit -m "feat(v2): single-batch identity init with injected admin expectation"`。

### Task 1.16 Miniflare 真 D1 集成套件

**Files:** Modify `services/reliable-drive-sync-worker/package.json`（devDependencies 增加 `"miniflare": "^4.0.0"`）；Create `services/reliable-drive-sync-worker/test/rds2-d1-integration.test.js`；Modify `services/reliable-drive-sync-worker/.gitignore`（追加 `.wrangler-state/`，若无该文件则创建）
**Interfaces:** Produces `startRds2Miniflare()` 测试助手（自测试文件内联）| Consumes `miniflare`
**Rev 4 注：** Miniflare 配置改**对象形态**（Codex 指定）。

- [ ] 1. 安装依赖：`cd services/reliable-drive-sync-worker && npm install --save-dev miniflare@^4.0.0`（本地 devDependency，无远程动作）。
- [ ] 2. 失败测试（七项断言）：
  ```js
  import { Miniflare } from "miniflare";
  async function startRds2Miniflare(persistPath) {
    const mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },  // 对象形态
      d1Persist: persistPath
    });
    const db = await mf.getD1Database("DB");
    const migration = readFileSync(new URL("../migrations/0006_rds2_v2_tables.sql", import.meta.url), "utf8");
    await db.exec(migration);
    return { mf, db };
  }
  ```
  断言清单：① `db.exec(migration)` 成功且六表存在；② **异步 API**：`prepare/bind/run/first/all` 各一次成功往返（建 user、查 user，全部 await）；③ **绑定语句 batch**：`db.batch([db.prepare(s1).bind(...), db.prepare(s2).bind(...)])` 第二条违反 CHECK 时第一条回滚（事件计数 0）；④ **`meta.changes`**：真 D1 的 UPDATE `run()` 返回 `meta.changes === 1`（真实 D1 返回形状断言，锁定适配器模拟正确）；⑤ 原子接收 + 投影 CAS：用真 D1 binding 跑 Task 1.14 accept（receipt.taskId = `t_project_<seq>`、outbox 一行）与 Task 1.12 `updateAdvanced(90)` 抛 `/stale_projection_write/` 且 batch 回滚；⑥ **身份初始化零残留**：注入会失败的 batch 场景跑 Task 1.15 init → users/credentials/projections 计数 0；⑦ 持久化：关闭第一个 Miniflare，同 `d1Persist` 路径新建第二个实例，先前数据仍在。
- [ ] 3. 运行 `npm run test:worker 2>&1 | tail -4`：先确认集成用例 fail（`Cannot find package 'miniflare'`），实现后预期 `# fail 0`。
- [ ] 4. 提交：`git add services/reliable-drive-sync-worker/package.json services/reliable-drive-sync-worker/package-lock.json services/reliable-drive-sync-worker/test/rds2-d1-integration.test.js services/reliable-drive-sync-worker/.gitignore && git commit -m "test(v2): miniflare real d1 async contract integration suite"`。
- 回滚：`git revert <task_sha>`；lockfile 回退即可。

### Task 1.17 打包门 dry-run

**Files:** 无新增（验证性任务）
**Interfaces:** Consumes 全部已有文件

- [ ] 1. `cd C:\Users\27846\my-chatgpt-mcp-v2 && npx --yes wrangler deploy --config services/reliable-drive-sync-worker/wrangler.toml --dry-run --outdir "$PWD/services/reliable-drive-sync-worker/tmp-dryrun-p1"`。
- [ ] 2. 预期：退出码 0，输出 `Total Upload` 与 `--dry-run: exiting now`；bundle 内 `grep -l canonicalJson` 命中（shared 已被 `src/rds2/*` 源引用，此断言为确定性验收门；未命中即失败，不存在"通过也行"分支）。
- [ ] 3. `git status --short` 确认仅新增未跟踪的 `tmp-dryrun-p1/`；逐文件 `rm` + 空目录 `rmdir` 删除该目录（本计划产物，G0 规则允许）。
- [ ] 4. 无提交。失败则 halt-and-report，附 wrangler 完整输出。

## 覆盖与自检（子计划 1 完成门）

- [ ] 规格映射：§3.15 D1 异步契约（Task 1.7/1.8–1.13 全 async + meta.changes + 1.16 ④）、§7.2 全部约束与业务唯一索引（Task 1.6）、§9 七条矩阵（1.3/1.14）、§17 凭据身份与追加签发（1.9/1.15）、§10.1 先鉴权接收的服务端部分（1.14，路由门在子计划 4）、§21.4 门 1/2/3/4（1.16②③④⑥/1.14/1.2/1.15⑥）。
- [ ] `grep -rn "result.changes" src/rds2/` 零命中（只允许 `meta.changes`）；`grep -rn "db.batch(\[{" src/rds2/` 零命中（batch 只接绑定语句）；`grep -rn "\.\./\.\./\.\./shared/" src/rds2/` 零命中（src 下必须四层）。
- [ ] `grep -rn "displayName" src/rds2/ shared/` 零命中（identity 字段统一 `username`）。
- [ ] `grep -rn "TODO\|TBD\|同上\|参考前文\|必要修复\|<tmp>\|<dataDir>\|<skill>" src/rds2/ migrations/0006_rds2_v2_tables.sql test/rds2-*.test.js` 预期零命中。
- [ ] 命名一致性：`t_project_<event_seq>`、`stale_projection_write`、`business_dedupe_key`、`idempotency_state_corrupt`、`name_key_conflict` 在全部文件拼写一致（`grep -rn` 核对）。
