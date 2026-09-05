# RDS2 Protocol, Identity and D1 Data Foundation Implementation Plan — Revision 5

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立共享 V2 协议模块（单一事实源，覆盖 V1 全部 18 个允许事件类型的校验，**外壳错误码与 V1 逐字节一致**）、六张 `rds2_*` 表迁移（含业务唯一索引 + 归档租约列）、**真实异步 D1 契约**下的仓库层与服务层（原子接收、七条幂等矩阵含 conflict 闭环、单 batch 身份初始化含**双向绑定核对**），以及 Miniflare 真 binding 集成测试。

**Architecture:** `shared/rds2-protocol.mjs` 被 Worker（Wrangler 打包）与 Bridge（Node ESM）共同引用；仓库层面向**真实 Cloudflare D1 API**（`prepare(sql).bind(...).first()/all()/run()`、`batch(绑定语句数组)`、**`all()` 返回 `{results:[...]}`**、`result.meta.changes`），本地 `node:sqlite` 适配器模拟同一套 API（语句对象经 **WeakMap 私有映射**携带 sql/params，不创造第二套接口）；`src/rds2/*.js` 引用仓库根 `shared/` 的相对路径为 `../../../../shared/rds2-protocol.mjs`；身份初始化 = 单个 D1 batch（用户 + 凭据 + 全部初始投影，初始投影 `state_json/public_view_json = NULL`）；凭据语义 = 追加签发；admin token 期望值依赖注入；凭据随机字节用 Web Crypto。

**Tech Stack:** Node ≥22 内置 test runner；`node:sqlite`（单元级）；`miniflare` devDependency（集成级）；Wrangler 4 `--dry-run` 打包门。零运行时依赖。

**Spec:** 上位规格 Rev 5：§3 决策 15/16（D1 异步契约 + 适配器形状、独立 cron）、§7.2（六表 + 业务唯一索引 + `queued_at` + 凭据列 + **归档租约列**）、§9（七条矩阵 + **投影期 conflict 闭环**）、§10.1（先鉴权接收九步 + receipt 时机）、§17（凭据映射、追加签发、admin 注入、Web Crypto、**协议事实分层**、**双向绑定核对**）、§21.4 验收门 1/2/3/4。

**Rev 5 相对 Rev 4 的关键修正（Codex 四审意见 3/4/5/6，编号保留）:**

| # | 修订位置 | 具体失败样本 | 预期行为 |
|---|---|---|---|
| 3 | Task 1.7（全文重写）+ 1.10/1.11/1.13/1.16（`.results` 解包） | Rev 4 适配器 `bind()` 返回的对象只含 `first/all/run` 闭包，`batch()` 内 `stmt.sql`/`stmt.params` 为 `undefined` → 运行期 `db.prepare(undefined)` 抛错；`.all()` 直接返回数组而真实 D1 返回 `{results}`，适配器与真 D1 形状分叉；T1.7 测试用 `a.length===1 \|\| b.length===1` 恒真断言，什么也证明不了 | 语句对象经 WeakMap 私有携带 `{sql, params}`；`all()` 返回 `{results:[...]}`；`batch()` 逐语句解包执行并原子回滚；`UPDATE…RETURNING` 经 `all()` 取 `.results`；测试为精确形状断言，且同一断言套件在 Miniflare 真 D1 上复跑 |
| 4 | Task 1.15（双向核对）+ 1.6（无需改表，核对在代码层） | 两个不同展示名经 NFKC 折叠得到同一 `name_key`（如全角字符），Rev 4 仅正向 `byNameKey` 命中即把新凭据绑到旧用户 `user_id`；同 `credential_hash` 已绑其他用户时不检查 | `byNameKey` 命中后反向校验该行 `display_name === 入参.trim()` 且 `byId(user_id).name_key` 与入参一致；签发前校验 `credential_hash` 未绑定其他 `user_id`；任一方向不符 → `identity_conflict`，初始化 batch 零残留 |
| 5 | Task 1.2（错误码分层 + payload 分层） | Rev 4 发明 `invalid_envelope_field`/`namespace_event_type_mismatch` 两个 V1 不存在的码，且把缺 `requestId` 映到 `invalid_payload`（V1 为 `invalid_request_id`）、identity 校验要求 `userId` 必填非空串（V1 为可选+UUID 正则、错误码 `invalid_identity`）；parity 只比"合法/非法"结论不比码，分叉不可见；`system.user.resolve` 样本若写 `payload.username` 必被 `invalid_payload` 拒绝（`protocol.js:36,404`） | 外壳错误码与 V1 逐字节一致：`invalid_envelope/invalid_namespace/invalid_event_type/invalid_schema_version/invalid_request_id/invalid_identity/invalid_payload`；V1 冻结码集合与 V2 新增码集合分层登记；parity 测试对外壳级拒绝**逐码比对**；`system.user.resolve` 正样本 `payload={displayName}`，反样本 `payload.username` 两侧同拒 |
| 6 | Task 1.3（样本修正）+ 1.14（conflict 分支闭环） | Rev 4 样本 7"仅命中 byEventId 且内容一致但 requestId 未命中"不可能存在（`envelope_hash` 覆盖整个 envelope 含 requestId，内容一致则 requestId 必命中同一行）；T1.14 竞态重查路径只处理 `exact_retry/already_recorded/corrupt`，`conflict` 分支 fallthrough 把原始 `UNIQUE constraint failed` 异常抛给客户端 | 样本 7 改写为"byEventId 命中且内容与归属完全一致（byRequestId 必然同命中）→ exact_retry（即矩阵第 1 条）"，并新增样本"新 requestId + 同 eventId + 同业务内容 → 因 hash 覆盖 requestId 必落 `event_id_conflict`"；T1.14 重查后 `conflict` 分支显式抛 `ProtocolError(reIntent.code)`（稳定 409），只有重查仍为 `new_event` 时才上抛原始异常 |

**任务处置清单：** 全文替换 Task 1.2/1.3/1.6/1.7/1.10/1.11/1.13/1.14/1.15/1.16（本文件）；逐字继承 Rev 4 文件 `2026-09-05-v2-rev4-subplan-1-protocol-identity-d1.md` 的 Task 1.1/1.4/1.5/1.8/1.9/1.12/1.17（这些任务只用 `.first()`/`.run()`，不受 `{results}` 形状影响；其文件清单、失败测试、实现与提交命令以 Rev 4 原文为准，执行时在本计划中打勾即视为对 Rev 4 同号任务打勾）。

## Global Constraints

- 前置门 G0（主索引）：先确认 worktree 状态；本计划残留经用户确认后处理；用户未跟踪文件不删不改不提交。
- 受保护路径（本计划全部 Task 禁改）：`migrations/0005_schema12_jobs.sql`、`src/ingress.js`、`src/dispatcher.js`、`src/sync.js`、`src/event-store.js`、`src/qstash.js`、`src/reconciler.js`、所有 V1 store/model、`tools/reliable-drive-sync-mcp/local-outbox.mjs`、`tools/reliable-drive-sync-mcp/delivery-service.mjs`。`src/protocol.js` 只读（parity 测试引用，不修改）。
- 所有测试命令在 worktree `C:\Users\27846\my-chatgpt-mcp-v2` 执行；每 Task 结束 `git status --short` 只允许出现该 Task 文件。
- 提交规范：`git add` 只加本 Task 文件清单；消息前缀 `feat(v2):`/`test(v2):`/`chore(v2):`；禁止 `git add -A`、`reset --hard`、`checkout --`、`stash drop`。
- **D1 契约（全子计划强制）**：仓库方法返回 Promise；影响行数判定一律 `const res = await stmt.run(); res.meta.changes === 1`；禁止读取 `res.changes`；`batch()` 入参只允许 `prepare(sql).bind(...)` 返回的语句对象；**`.all()` 的返回值必须解构 `.results` 后才可当数组使用**（真实 D1 形状，适配器同形）。
- **协议事实分层（全子计划强制）**：envelope `identity` 仅 `userId/username`；`displayName` 只出现于 `system.user-registered`/`system.user.resolve` 的 payload；禁止 `payload.username`（resolve 的 payload 不允许任何其他字段，`protocol.js:36`）。
- 每 Task 回滚方式相同：`git revert <task_sha>`。

## Interfaces

- **Produces**（后续子计划消费）：`shared/rds2-protocol.mjs` 导出 `canonicalJson(value)`、`sha256Hex(text)`、`validateEnvelope(envelope)`、`resolveIntent(lookups, incoming)`、`durableReceipt(fields)`、`alreadyRecordedReceipt(firstEvent)`、`ERROR_CODES`（含 `V1_FROZEN_CODES`/`V2_CODES` 分层）、`deriveDedupeKey(eventType, payload, userId)`、`ALLOWED_EVENT_TYPES`；`src/rds2/sqlite-adapter.js` 导出 `createSqliteAdapter(filePath)`（真实 D1 API 模拟，`all()→{results}`）；`src/rds2/*-repository.js` 各导出异步工厂；`src/rds2/accept-service.js` 导出 `createAcceptService(db, deps)`；`src/rds2/credential-auth.js` 导出 `issueCredential(db, userId, token)`、`authenticateUser(db, bearerToken)`；`src/rds2/identity-init.js` 导出 `createIdentityInitService(db, deps)`；`migrations/0006_rds2_v2_tables.sql`（含归档租约列）。
- **Consumes**：`src/protocol.js`（parity 金样本只读）、`node:sqlite`、`miniflare`、Web Crypto。

---

### Task 1.2 全事件类型校验器（18 类型注册表 + V1 冻结错误码分层）

**Files:** Modify `shared/rds2-protocol.mjs`；Test `services/reliable-drive-sync-worker/test/rds2-protocol.test.js` 追加 + 新建 `services/reliable-drive-sync-worker/test/rds2-protocol-parity.test.js`
**Interfaces:** Produces `validateEnvelope`, `ALLOWED_EVENT_TYPES`, `ProtocolError`, `ERROR_CODES`, `V1_FROZEN_CODES`, `V2_CODES` | Consumes `protocol.js` 只读语义

- [ ] 1. 写失败测试（外壳六条 + 类型覆盖十八条 + payload 分层两条）：
  - 外壳（错误码必须与 V1 `protocol.js` `inspectEnvelope` **逐字节一致**）：
    - envelope 六字段白名单外字段 → `invalid_envelope`（**不是** `invalid_envelope_field`）；
    - namespace 非五值白名单 → `invalid_namespace`；
    - `eventType.split(".")[0] !== namespace` → `invalid_event_type`（**不是** `namespace_event_type_mismatch`）；
    - `schemaVersion !== "1.2"` → `invalid_schema_version`；
    - `requestId` 缺失/空白 → `invalid_request_id`（**不是** `invalid_payload`）；
    - `identity` 含 `userId/username` 之外字段、`username` 缺失/空白、`userId` 存在但非 UUID → `invalid_identity`；`identity` 整体缺省合法（V1 语义，身份核对在凭据层完成）。
  - 类型覆盖：`ALLOWED_EVENT_TYPES` 与 V1 `PAYLOAD_SCHEMA` 18 键完全一致（**V1 兼容全集 18 种，V2 新增 0 种**）。每类型至少一正一反样本（非法样本含：缺必需字段、内外 eventType 不一致、多未知字段三类中的适用项）；UUID/RFC3339/localDate/sessionId 正则同 Rev 4。
  - **payload 分层（意见 5 锁定）**：
    - `system.user.resolve` 正样本：`payload = { displayName: "乔炳源" }` → 合法；
    - `system.user.resolve` 反样本：`payload = { username: "乔炳源" }` → `invalid_payload`（required `displayName` 缺失 + `username` 不在允许集）；`payload = { displayName: "x", userId: "<uuid>" }` → `invalid_payload`（resolve optional 为空集，`protocol.js:36`）；
    - `system.user-registered` 正样本：`payload = { displayName, username?, userId? }`；反样本缺 `displayName` → `invalid_payload`。
  - `ProtocolError` 实例对 V1 冻结码同时暴露 `.code` 与 `.status`（同值），便于 parity 与 V1 `ProtocolError.status` 直接比较。
- [ ] 2. 运行 `npm run test:worker 2>&1 | tail -4`，预期新增用例全部 fail。
- [ ] 3. 实现（字段集与 V1 `protocol.js:27-55,364-426` 逐字段对齐，不 import V1 文件）：
  ```js
  export const V1_FROZEN_CODES = new Set([ // 与 V1 ProtocolError.status 逐字节一致，禁止改名
    "invalid_schema_version", "invalid_envelope", "invalid_namespace", "invalid_event_type",
    "invalid_request_id", "invalid_identity", "invalid_payload", "invalid_domain",
    "invalid_profile_event", "invalid_event"
  ]);
  export const V2_CODES = new Set([ // V2 新增（V1 无对应语义），新增成员必须先登记此处
    "request_id_conflict", "event_id_conflict", "event_key_already_recorded",
    "idempotency_state_corrupt", "identity_mismatch", "identity_not_found", "identity_conflict",
    "user_disabled", "unauthorized", "forbidden", "namespace_not_enabled", "name_key_conflict",
    "already_recorded"
  ]);
  export const ERROR_CODES = Object.fromEntries([...V1_FROZEN_CODES, ...V2_CODES].map((c) => [c, c]));
  export class ProtocolError extends Error {
    constructor(code) { super(code); this.code = code; this.status = code; }
  }
  const ENVELOPE_FIELDS = new Set(["schemaVersion", "namespace", "eventType", "identity", "payload", "requestId"]);
  const IDENTITY_FIELDS = new Set(["userId", "username"]);
  const NAMESPACES = new Set(["system", "algorithm", "interview", "resume-knowledge", "profile"]);
  // validateEnvelope 外壳顺序与 V1 inspectEnvelope 一致：
  // schemaVersion → envelope 字段白名单 → namespace → eventType 白名单 → namespace/type 前缀 → requestId → identity → payload
  // payload 按 PAYLOAD_REGISTRY 分派；system.user.resolve 的 registry 项为 { required:["displayName"], optional:[] }
  ```
- [ ] 4. parity 金样本测试 `test/rds2-protocol-parity.test.js`（**意见 5 升级**）：
  - 外壳级：对上述六条外壳反样本，分别用 V1（`inspectEnvelope`）与 shared（`validateEnvelope`）执行，断言**错误码完全相等**（`v1Err.status === sharedErr.code`）；
  - payload/内部事件级：18 类型各一正一反（共 ≥36 组），断言两侧"合法/非法"结论一致；
  - `system.user.resolve` 的 `payload.username` 反样本必须出现在 parity 集中（两侧同拒）；
  - 出现不一致 → halt-and-report 差异样本，不得改 V1。
  运行 `npm run test:worker 2>&1 | tail -4` 预期 `# fail 0`。
- [ ] 5. 提交：`git add shared/rds2-protocol.mjs services/reliable-drive-sync-worker/test/rds2-protocol.test.js services/reliable-drive-sync-worker/test/rds2-protocol-parity.test.js && git commit -m "feat(v2): full-coverage validator with v1-frozen error code tiering"`。

### Task 1.3 resolveIntent：四查询入口 + 七条矩阵（样本修正版）

**Files:** Modify `shared/rds2-protocol.mjs`；Test 同 1.1 文件追加
**Interfaces:** Produces `resolveIntent(lookups, incoming)` | Consumes `canonicalJson/sha256Hex`

- [ ] 1. 失败测试（矩阵逐条参数化，`lookups = { byRequestId, byEventId, byEventKey, byBusinessDedupeKey }`）：
  1. 全部命中同一事件且 hash 相同 → `{kind:"exact_retry", event:<行>}`；
  2. `byRequestId` 命中 hash 不同 → `{kind:"conflict", code:"request_id_conflict"}`；
  3. `byEventId` 命中 hash 不同 **或** `request_id` 不同 → `{kind:"conflict", code:"event_id_conflict"}`；
  4. `byEventKey` 命中且 `event_id !== incoming.eventId` → `{kind:"already_recorded", first:<byEventKey 行>}`；
  5. 仅 `byBusinessDedupeKey` 命中且指向不同事件 → `{kind:"already_recorded", first:<dedupe 行>}`；
  6. 多个查询命中**不同 event_id** 且无任何单行与 incoming 完全一致 → `{kind:"corrupt"}`；
  7. **（意见 6 样本修正）** `byEventId` 命中且 `envelope_hash` 与 `request_id` 均与 incoming 一致 → `exact_retry`；此时 `byRequestId` 必然同时命中同一行（`envelope_hash` 覆盖整个 envelope 含 `requestId`，内容一致 ⇒ requestId 一致 ⇒ 命中），样本注释禁止再写"requestId 未命中"；
  7b. **（新增锁定样本）** 新 `requestId` + 同 `eventId` + 同业务内容：因 hash 覆盖 `requestId`，`envelope_hash` 必不同 → `event_id_conflict`（不是 exact_retry，也不是 new_event）；
  8. 四查询全空 → `{kind:"new_event"}`；
  9. 优先级：conflict > corrupt > exact_retry > already_recorded > new_event（组合样本锁定）。
- [ ] 2. 预期失败：`resolveIntent is not a function`。
- [ ] 3. 实现：与 Rev 4 相同（逻辑已正确，注释按样本 7/7b 修正）：
  ```js
  export function resolveIntent(lookups, incoming) {
    const req = lookups.byRequestId, evt = lookups.byEventId,
          key = lookups.byEventKey, dedupe = lookups.byBusinessDedupeKey;
    if (req && req.envelope_hash !== incoming.envelopeHash) return { kind: "conflict", code: "request_id_conflict" };
    if (evt && (evt.envelope_hash !== incoming.envelopeHash || evt.request_id !== incoming.requestId))
      return { kind: "conflict", code: "event_id_conflict" };
    const hits = [req, evt, key, dedupe].filter(Boolean);
    const distinct = new Set(hits.map((r) => r.event_id));
    if (evt) { // evt 与 incoming 完全一致（上面已排除冲突）→ 同一事实幂等重放（矩阵第 1 条）
      if (distinct.size === 1) return { kind: "exact_retry", event: evt };
      return { kind: "corrupt" };
    }
    if (distinct.size > 1) return { kind: "corrupt" };
    if (key) return { kind: "already_recorded", first: key };
    if (dedupe) return { kind: "already_recorded", first: dedupe };
    if (req) return { kind: "exact_retry", event: req };
    return { kind: "new_event" };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add shared/rds2-protocol.mjs services/reliable-drive-sync-worker/test/rds2-protocol.test.js && git commit -m "feat(v2): four-lookup seven-rule intent resolution with corrected samples"`。

### Task 1.6 迁移 0006：六表 + 业务唯一索引 + CHECK + CAS 触发器 + queued_at + 凭据列 + 归档租约列

**Files:** Create `services/reliable-drive-sync-worker/migrations/0006_rds2_v2_tables.sql`；Test `services/reliable-drive-sync-worker/test/rds2-schema.test.js`
**Interfaces:** Produces 六表 schema | Consumes 无

- [ ] 1. 失败测试（Rev 4 全部断言保留，追加两条）：
  ```js
  test("archive deliveries carry lease columns for owner-checked completion", () => {
    const db = freshDb();
    const cols = db.prepare("PRAGMA table_info(rds2_archive_deliveries)").all().map((r) => r.name);
    assert.ok(cols.includes("lease_owner") && cols.includes("lease_until"));
  });
  test("projections initial row allows null state for emptyProjection startup", () => {
    const db = freshDb();
    seedUser(db, "u1");
    db.exec(`INSERT INTO rds2_projections (user_id, namespace, projection_name, last_event_seq, state_json, public_view_json, content_hash, updated_at)
      VALUES ('u1','algorithm','learning',0,NULL,NULL,'empty','2026-09-05')`);
    const row = db.prepare("SELECT * FROM rds2_projections WHERE user_id='u1'").get();
    assert.equal(row.state_json, null); // NULL = 引擎首次处理时经 emptyProjection(identity) 生成（规格 §12 首次启动规则）
  });
  ```
- [ ] 2. 运行 `npm run test:worker 2>&1 | tail -4`，预期新用例 fail。
- [ ] 3. 实现（Rev 4 迁移基础上追加；全部 `IF NOT EXISTS`，不动 0005）：
  ```sql
  -- rds2_archive_deliveries 列追加（意见 9：完成 UPDATE 谓词携带 lease_owner）：
  --   lease_owner TEXT,
  --   lease_until TEXT,
  -- （CREATE TABLE 列序：... state, lease_owner, lease_until, drive_file_id, attempt_count, ...）
  ```
  其余表体、索引、CHECK、CAS 触发器与 Rev 4 相同。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/migrations/0006_rds2_v2_tables.sql services/reliable-drive-sync-worker/test/rds2-schema.test.js && git commit -m "feat(v2): rds2 six-table migration with archive lease columns"`。

### Task 1.7 SQLite 快速适配器（真实 D1 API 模拟：WeakMap 私有语句 + `{results}` 形状）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/sqlite-adapter.js`；Test `services/reliable-drive-sync-worker/test/rds2-sqlite-adapter.test.js`
**Interfaces:** Produces `createSqliteAdapter(filePath)` → `{prepare, batch, exec}`（D1 语义）| Consumes `node:sqlite`

- [ ] 1. 失败测试（**全部为精确形状断言，禁止 `\|\|` 恒真式**）：
  ```js
  test("first returns row or null; all returns {results}; run returns meta.changes", async () => {
    const adapter = createSqliteAdapter(":memory:");
    adapter.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)");
    await adapter.prepare("INSERT INTO t VALUES (?, ?)").bind("a", "1").run();
    assert.equal((await adapter.prepare("SELECT v FROM t WHERE id=?").bind("a").first()).v, "1");
    assert.equal(await adapter.prepare("SELECT v FROM t WHERE id=?").bind("zzz").first(), null);
    const all = await adapter.prepare("SELECT id FROM t").all();
    assert.deepEqual(Object.keys(all), ["results"]);          // 真实 D1 形状
    assert.equal(all.results.length, 1);
    const res = await adapter.prepare("UPDATE t SET v='2' WHERE id='a'").run();
    assert.equal(res.meta.changes, 1);
    assert.equal(typeof res.meta.last_row_id, "number");
  });
  test("statement payloads are private: not enumerable, not json-serializable", async () => {
    const adapter = createSqliteAdapter(":memory:");
    const stmt = adapter.prepare("SELECT 1").bind();
    assert.equal(JSON.stringify(stmt), "{}");                 // WeakMap 私有映射，sql/params 不外泄
    assert.equal(stmt.sql, undefined);
  });
  test("batch executes bound statements, returns per-statement meta, rolls back atomically", async () => {
    const adapter = createSqliteAdapter(":memory:");
    adapter.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)");
    const out = await adapter.batch([
      adapter.prepare("INSERT INTO t VALUES ('a','1')"),
      adapter.prepare("UPDATE t SET v='2' WHERE id='a'")
    ]);
    assert.equal(out[1].meta.changes, 1);
    await assert.rejects(() => adapter.batch([
      adapter.prepare("DELETE FROM t"),
      adapter.prepare("INSERT INTO t VALUES ('a','9')")       // 主键冲突（上行已重插 'a'）
    ]));
    // 先补一行 'a' 再跑冲突 batch，验证整体回滚：
    const { results } = await adapter.prepare("SELECT COUNT(*) c FROM t").all();
    assert.equal(results[0].c, 1);                            // DELETE 被回滚
  });
  test("update...returning works through all().results", async () => {
    const adapter = createSqliteAdapter(":memory:");
    adapter.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)");
    await adapter.prepare("INSERT INTO t VALUES ('a','1')").run();
    const { results } = await adapter.prepare("UPDATE t SET v='9' WHERE id='a' RETURNING *").all();
    assert.deepEqual(results, [{ id: "a", v: "9" }]);
  });
  test("first/all/run/batch are async", async () => {
    const adapter = createSqliteAdapter(":memory:");
    assert.ok(adapter.prepare("SELECT 1").first() instanceof Promise);
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
    const payloadOf = new WeakMap(); // 语句对象 → {sql, params}，私有映射（意见 3）
    function makeStatement(sql, params) {
      const stmt = {
        first: async () => db.prepare(sql).get(...params) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...params) }),
        run: async () => {
          const r = db.prepare(sql).run(...params);
          return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
        }
      };
      payloadOf.set(stmt, { sql, params });
      return stmt;
    }
    return {
      prepare: (sql) => {
        const unbound = makeStatement(sql, []);
        unbound.bind = (...params) => makeStatement(sql, params);
        return unbound;
      },
      exec: (sql) => db.exec(sql),
      async batch(statements) {
        db.exec("BEGIN"); // node:sqlite 无 .transaction()（意见 12 同源事实），显式事务
        try {
          const out = [];
          for (const stmt of statements) {
            const payload = payloadOf.get(stmt);
            if (!payload) throw new Error("foreign_statement_object");
            const r = db.prepare(payload.sql).run(...payload.params);
            out.push({ success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } });
          }
          db.exec("COMMIT");
          return out;
        } catch (cause) { db.exec("ROLLBACK"); throw cause; }
      }
    };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/sqlite-adapter.js services/reliable-drive-sync-worker/test/rds2-sqlite-adapter.test.js && git commit -m "feat(v2): sqlite adapter with private statement payloads and results envelope"`。

### Task 1.10 event-repository（异步 + 四查询入口 + `.results` 解包）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/event-repository.js`；Test `services/reliable-drive-sync-worker/test/rds2-event-repository.test.js`
**Interfaces:** Produces `createEventRepository(db)` → `{readAfter, insert, byRequestId, byEventId, byEventKey, byBusinessDedupeKey}`（全 async）| Consumes adapter

- [ ] 1. 失败测试（Rev 4 全部断言保留，修正一条形状断言）：
  - `readAfter("u1","algorithm",0,10)` 返回**数组**（已解包 `.results`）、只含该用户该域事件、按 `event_seq ASC`；预置 12 条其他用户事件 + 3 条本用户事件时返回长度恰为 3（其他用户事件不消耗 limit）；
  - `insert` 返回 Promise 且插入后可由四个查询入口寻址；
  - `byBusinessDedupeKey("u1|2026-09-05|Q1")` 命中携带 dedupeKey 的行，未携带 → `null`；
  - `byEventKey` 四元组作用域：同 key 不同 namespace → `null`。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（与 Rev 4 相同，仅 `readAfter` 解包）：
  ```js
  readAfter: async (userId, namespace, afterEventSeq, limit) => {
    const { results } = await db.prepare(`SELECT * FROM rds2_business_events
      WHERE user_id = ? AND namespace = ? AND event_seq > ? ORDER BY event_seq ASC LIMIT ?`)
      .bind(userId, namespace, afterEventSeq, limit).all();
    return results;
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/event-repository.js services/reliable-drive-sync-worker/test/rds2-event-repository.test.js && git commit -m "feat(v2): async event repository unwrapping results envelope"`。

### Task 1.11 outbox-repository（原子认领 UPDATE…RETURNING + `.results` 解包 + meta.changes + 陈旧 queued 回收）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/outbox-repository.js`；Test `services/reliable-drive-sync-worker/test/rds2-outbox-repository.test.js`
**Interfaces:** Produces `createOutboxRepository(db)` → `{claimDue, claimOne, renewLease, markQueued, markProcessing, complete, failWithBackoff, toNeedsAttention, releaseLease, byTaskId, reclaimExpired, reclaimStaleQueued}`（全 async）| Consumes adapter

- [ ] 1. 失败测试（Rev 4 全部断言保留，形状断言修正为 `.results` 解包）：
  - `claimDue(5,"w1")` 返回**数组** ≤5 行、全部 `state='dispatching'` 带租约；并发互斥：第二个 adapter 同参调用返回 0 行；
  - `claimOne` 非 pending → `null`（不抛）；
  - `markQueued/complete/failWithBackoff` 的 `meta.changes` 判定与 Rev 4 相同；
  - `reclaimStaleQueued` 阈值行为与 Rev 4 相同；
  - `queue_message_id` 恒 NULL。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（与 Rev 4 相同，仅两处解包）：
  ```js
  async claimDue(limit, owner, now = new Date().toISOString()) {
    const { results } = await db.prepare(`UPDATE rds2_event_outbox
      SET state='dispatching', lease_owner=?, lease_until=?, attempt_count=attempt_count+1, updated_at=?
      WHERE task_id IN (SELECT task_id FROM rds2_event_outbox WHERE state='pending' AND available_at <= ? ORDER BY available_at ASC LIMIT ?)
      RETURNING *`).bind(owner, new Date(Date.now() + 60_000).toISOString(), now, now, limit).all();
    return results;
  },
  async claimOne(taskId, owner, now = new Date().toISOString()) {
    const { results } = await db.prepare(`UPDATE rds2_event_outbox
      SET state='dispatching', lease_owner=?, lease_until=?, attempt_count=attempt_count+1, updated_at=?
      WHERE task_id = ? AND state='pending' RETURNING *`).bind(owner, new Date(Date.now() + 60_000).toISOString(), now, taskId).all();
    return results[0] ?? null;
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/outbox-repository.js services/reliable-drive-sync-worker/test/rds2-outbox-repository.test.js && git commit -m "feat(v2): atomic outbox claiming with results envelope unwrap"`。

### Task 1.13 archive-delivery-repository（异步 + 确定性 ID + 租约所有者核对 + 三集合状态机）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/archive-delivery-repository.js`；Test `services/reliable-drive-sync-worker/test/rds2-archive-delivery-repository.test.js`
**Interfaces:** Produces `createArchiveDeliveryRepository(db)` → `{freezeRows, markDelivering, markDelivered, markNeedsAttention, releaseLease, claimableGroups, byArtifactKey}`（全 async）| Consumes adapter, `sha256Hex`

- [ ] 1. 失败测试（Rev 4 断言保留 + 意见 9 锁定）：
  - `deterministicDeliveryId(artifactKey)` = `sha256(artifact_key)` 前 32 hex（硬编码期望值，**带 await**）；
  - `markDelivering(id, "archiver:inv-1")` 置 `delivering` 并写 `lease_owner/lease_until`；非 `pending` 行 → `illegal_state_transition`；
  - **`markDelivered(id, fileId, owner)` 谓词携带 `lease_owner`**：以错误 owner 调用 → `illegal_state_transition`（`meta.changes === 0`），状态保持 `delivering`（旧消费者的迟到完成不得覆盖新租约）；
  - `markNeedsAttention(id, code, owner)` 只允许 `delivering + 同 owner` 或 `pending` 行；**`needs_attention` 行对后续 `markDelivered` 免疫**（谓词限 `state='delivering'`）；
  - `releaseLease(id, owner)`：`delivering + 同 owner` → 复位 `pending` 并清租约（预算不足未执行对象的 `released` 集合落地）；
  - `claimableGroups(4)` 返回**数组**（`.results` 解包）按 `(user_id, namespace)` ≤4 组；
  - `freezeRows` 生成语句对象可入 batch 且重复执行幂等。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  import { sha256Hex } from "../../../../shared/rds2-protocol.mjs";
  export const deterministicDeliveryId = async (artifactKey) => (await sha256Hex(artifactKey)).slice(0, 32);
  export function createArchiveDeliveryRepository(db) {
    const insertSql = `INSERT OR IGNORE INTO rds2_archive_deliveries (archive_delivery_id, artifact_kind, artifact_key, user_id, namespace, source_event_seq, projection_name, projection_event_seq, artifact_json, artifact_hash, drive_path, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`;
    const must = (r) => { if (r.meta.changes !== 1) throw new Error("illegal_state_transition"); };
    return {
      async freezeRows(rows) { /* 与 Rev 4 相同：返回绑定语句对象数组 */ },
      async markDelivering(id, owner, leaseMs = 60_000) {
        must(await db.prepare(`UPDATE rds2_archive_deliveries
          SET state='delivering', lease_owner=?, lease_until=?, attempt_count=attempt_count+1, updated_at=?
          WHERE archive_delivery_id=? AND state='pending'`)
          .bind(owner, new Date(Date.now() + leaseMs).toISOString(), new Date().toISOString(), id).run());
      },
      async markDelivered(id, driveFileId, owner) {
        must(await db.prepare(`UPDATE rds2_archive_deliveries
          SET state='delivered', drive_file_id=?, lease_owner=NULL, lease_until=NULL, updated_at=?
          WHERE archive_delivery_id=? AND state='delivering' AND lease_owner=?`)
          .bind(driveFileId, new Date().toISOString(), id, owner).run());
      },
      async markNeedsAttention(id, code, owner) {
        must(await db.prepare(`UPDATE rds2_archive_deliveries
          SET state='needs_attention', last_error_code=?, lease_owner=NULL, lease_until=NULL, updated_at=?
          WHERE archive_delivery_id=? AND ((state='delivering' AND lease_owner=?) OR state='pending')`)
          .bind(code, new Date().toISOString(), id, owner).run());
      },
      async releaseLease(id, owner) {
        must(await db.prepare(`UPDATE rds2_archive_deliveries
          SET state='pending', lease_owner=NULL, lease_until=NULL, updated_at=?
          WHERE archive_delivery_id=? AND state='delivering' AND lease_owner=?`)
          .bind(new Date().toISOString(), id, owner).run());
      },
      claimableGroups: async (limit) => {
        const { results } = await db.prepare(`SELECT user_id, namespace, MIN(created_at) AS first_created
          FROM rds2_archive_deliveries WHERE state='pending' GROUP BY user_id, namespace ORDER BY first_created ASC LIMIT ?`).bind(limit).all();
        return results;
      },
      byArtifactKey: (key) => db.prepare("SELECT * FROM rds2_archive_deliveries WHERE artifact_key = ?").bind(key).first()
    };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/archive-delivery-repository.js services/reliable-drive-sync-worker/test/rds2-archive-delivery-repository.test.js && git commit -m "feat(v2): archive delivery repository with lease owner checked state machine"`。

### Task 1.14 accept-service（七矩阵 + 单 batch 原子接收 + 竞态重查 conflict 闭环）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/accept-service.js`；Test `services/reliable-drive-sync-worker/test/rds2-accept-service.test.js`
**Interfaces:** Produces `createAcceptService(db, deps)` → `accept(validatedEnvelope, user)`（async）| Consumes Task 1.2/1.3/1.5/1.8/1.10/1.11

- [ ] 1. 失败测试（Rev 4 全部断言保留 + 意见 6 锁定）：
  - Rev 4 九条（原子接收、中途回滚、矩阵 2/3、4/5、6、1b、7、身份前置拒绝、dedupe 派生）原样保留；
  - **竞态 conflict 闭环**：预置事件 A（requestId=r1, eventId=e1）；构造 envelope B = 同 eventId e1 + 新 requestId r2 + 同业务内容 → 预查即命中矩阵第 3 条 → `event_id_conflict`（ProtocolError，409 语义，非原始 SQL 异常）；
  - **竞态 UNIQUE 重查 conflict**：mock 预查四入口全空、INSERT 撞 `UNIQUE`、重查返回"同 requestId 不同 hash"行 → 抛 `ProtocolError("request_id_conflict")`，**错误消息不含 `UNIQUE constraint failed`**；
  - 重查仍为 `new_event`（极端：唯一冲突来自并发插入后又被人为删除的测试注入）→ 允许上抛原始异常并记录 `last_error_code`。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（与 Rev 4 相同，仅 UNIQUE 捕获块闭环 conflict 分支）：
  ```js
  try {
    await db.batch([insertEvent, insertTask]);
  } catch (cause) {
    if (!/UNIQUE constraint failed/.test(String(cause))) throw cause;
    const reIntent = resolveIntent(await lookupsFor(envelope, envelopeHash, user.user_id), incoming);
    if (reIntent.kind === "exact_retry") return retryReceipt(reIntent.event, outbox);
    if (reIntent.kind === "already_recorded") return alreadyRecordedReceipt(reIntent.first);
    if (reIntent.kind === "conflict") throw new ProtocolError(reIntent.code); // 意见 6：稳定 409，不泄漏 SQL 异常
    if (reIntent.kind === "corrupt") throw new ProtocolError("idempotency_state_corrupt");
    throw cause;
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/accept-service.js services/reliable-drive-sync-worker/test/rds2-accept-service.test.js && git commit -m "feat(v2): atomic accept service with conflict-closed race relookup"`。

### Task 1.15 identity-init 服务逻辑（单 D1 batch + 双向绑定核对 + NULL 初始投影 + 期望值注入）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/identity-init.js`；Test `services/reliable-drive-sync-worker/test/rds2-identity-init.test.js`
**Interfaces:** Produces `createIdentityInitService(db, deps)` → `init({displayName, namespaces, userIdOverride?})` | Consumes Task 1.8/1.9、`randomCredentialToken`

- [ ] 1. 失败测试（Rev 4 全部断言保留 + 意见 4/7 锁定）：
  - Rev 4 六条（fail-closed、首次 init、单 batch 零残留、重复 init 追加签发、`name_key_conflict`、Web Crypto 熵源）原样保留；
  - **双向核对（意见 4）**：预置用户 `display_name="QBY"`（name_key 同）；以全角 `"ＱＢＹ"` 调用 init（NFKC 折叠后 name_key 相同但 display 不同）→ 抛 `identity_conflict`，且 credentials/projections 计数不变；
  - 正向命中后 `byId` 反查 `name_key` 不一致（测试用破损种子行注入）→ `identity_conflict`；
  - 预置 `credential_hash` 已绑 `user_a`，对新用户 `user_b` 注入同 hash 场景（mock `randomCredentialToken` 定值）→ `identity_conflict`；
  - **NULL 初始投影（意见 7 联动）**：init 后每 namespace 一行，`state_json IS NULL AND public_view_json IS NULL AND content_hash='empty'`（引擎首次处理经 `emptyProjection(identity)` 生成，规格 §12 首次启动规则；子计划 2 T2.7 消费本契约）；
  - 同 displayName 重复 init 仍幂等返回同一 userId + 新凭据（追加签发不受双向核对影响）。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  import { issueCredential, randomCredentialToken } from "./credential-auth.js";
  import { sha256Hex } from "../../../../shared/rds2-protocol.mjs";
  export function createIdentityInitService(db, { users, expectedAdminToken }) {
    return async function init({ adminToken, displayName, namespaces = ["algorithm"], userIdOverride }) {
      if (!expectedAdminToken || adminToken !== expectedAdminToken) throw new Error("forbidden");
      const trimmed = displayName.trim();
      const nameKey = trimmed.normalize("NFKC");
      const existing = await users.byNameKey(nameKey);
      if (existing) {
        // 意见 4 双向核对：NFKC 折叠碰撞不得静默并号
        if (existing.display_name !== trimmed) throw new Error("identity_conflict");
        const reverse = await users.byId(existing.user_id);
        if (!reverse || reverse.name_key !== nameKey) throw new Error("identity_conflict");
        if (userIdOverride && userIdOverride !== existing.user_id) throw new Error("name_key_conflict");
        if (existing.status !== "active") throw new Error("user_disabled");
      }
      const userId = existing?.user_id ?? userIdOverride ?? crypto.randomUUID();
      const clientCredential = randomCredentialToken();
      const credentialHash = await sha256Hex(clientCredential);
      const bound = await db.prepare("SELECT user_id FROM rds2_credentials WHERE credential_hash = ?").bind(credentialHash).first();
      if (bound && bound.user_id !== userId) throw new Error("identity_conflict");
      const now = new Date().toISOString();
      await db.batch([
        db.prepare(`INSERT INTO rds2_users (user_id, display_name, name_key, status, created_at, updated_at)
          VALUES (?, ?, ?, 'active', ?, ?) ON CONFLICT(user_id) DO NOTHING`)
          .bind(userId, trimmed, nameKey, now, now),
        db.prepare("INSERT INTO rds2_credentials (credential_hash, user_id, status, revoked_at, created_at) VALUES (?, ?, 'active', NULL, ?)")
          .bind(credentialHash, userId, now),
        ...namespaces.map((ns) => db.prepare(`INSERT OR IGNORE INTO rds2_projections
          (user_id, namespace, projection_name, last_event_seq, state_json, public_view_json, content_hash, updated_at)
          VALUES (?, ?, ?, 0, NULL, NULL, 'empty', ?)`).bind(userId, ns, defaultProjectionName(ns), now))
      ]);
      const user = await users.assertActive(userId);
      return { userId: user.user_id, displayName: user.display_name, clientCredential };
    };
  }
  export function defaultProjectionName(namespace) { return namespace === "algorithm" ? "learning" : namespace; }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/identity-init.js services/reliable-drive-sync-worker/test/rds2-identity-init.test.js && git commit -m "feat(v2): identity init with bidirectional binding checks and null-seeded projections"`。

### Task 1.16 Miniflare 真 D1 集成套件（形状 parity + 双向核对 + 零残留）

**Files:** Modify `services/reliable-drive-sync-worker/package.json`（devDependencies 增加 `"miniflare": "^4.0.0"`）；Create `services/reliable-drive-sync-worker/test/rds2-d1-integration.test.js`；Modify `services/reliable-drive-sync-worker/.gitignore`（追加 `.wrangler-state/`，若无则创建）
**Interfaces:** Produces `startRds2Miniflare()` 测试助手 | Consumes `miniflare`

- [ ] 1. 安装依赖：`cd services/reliable-drive-sync-worker && npm install --save-dev miniflare@^4.0.0`（本地 devDependency，无远程动作）。
- [ ] 2. 失败测试（Rev 4 七项断言保留并升级 + 两项新增）：
  - ① 迁移应用成功且六表存在（含 `lease_owner/lease_until` 列）；
  - ② 异步 API：`prepare/bind/run/first/all` 各一次成功往返；
  - ②b **（意见 3）真 D1 形状锁定**：`all()` 返回值含 `.results` 数组（`Object.keys` 含 `results`）；`UPDATE … RETURNING *` 经 `.all()` 取 `.results` 得变更行——与 Task 1.7 适配器断言逐条同形；
  - ③ 绑定语句 batch 原子回滚；
  - ④ `meta.changes` 影响行数；
  - ⑤ 原子接收 + 投影 CAS（跑 Task 1.14/1.12 场景）；
  - ⑥ 身份初始化零残留（注入失败 batch → users/credentials/projections 计数 0）；
  - ⑥b **（意见 4/7）**：真 D1 上跑 Task 1.15 双向核对拒绝（全角 displayName → `identity_conflict`）与 NULL 初始投影行断言；
  - ⑦ 持久化：同 `d1Persist` 路径重启后数据仍在。
- [ ] 3. 运行 `npm run test:worker 2>&1 | tail -4`：先确认集成用例 fail（`Cannot find package 'miniflare'`），实现后预期 `# fail 0`。
- [ ] 4. 提交：`git add services/reliable-drive-sync-worker/package.json services/reliable-drive-sync-worker/package-lock.json services/reliable-drive-sync-worker/test/rds2-d1-integration.test.js services/reliable-drive-sync-worker/.gitignore && git commit -m "test(v2): miniflare real d1 contract and identity binding integration suite"`。
- 回滚：`git revert <task_sha>`；lockfile 回退即可。

## 覆盖与自检（子计划 1 完成门）

- [ ] 规格映射：§3.15 D1 异步契约与适配器形状（1.7/1.16②b）、§7.2 全部约束与业务唯一索引与归档租约列（1.6/1.13）、§9 七条矩阵与投影期 conflict 闭环的接收侧（1.3/1.14）、§17 凭据身份、追加签发、协议事实分层、双向绑定核对（1.2/1.9/1.15）、§10.1 先鉴权接收的服务端部分（1.14，路由门在子计划 4）、§21.4 门 1/2/3/4（1.16/1.14/1.2/1.15）。
- [ ] `grep -rn "result.changes" src/rds2/` 零命中（只允许 `meta.changes`）；`grep -rn "db.batch(\[{" src/rds2/` 零命中（batch 只接绑定语句变量）；`grep -rn "\.\./\.\./\.\./shared/" src/rds2/` 零命中（src 下必须四层）。
- [ ] `grep -rn "\.all()" src/rds2/` 的每一处命中必须伴随同行或下一行 `.results` 解构（人工逐条核对，真实 D1 形状）。
- [ ] `grep -rn "payload.username\|invalid_envelope_field\|namespace_event_type_mismatch" shared/ src/rds2/ services/reliable-drive-sync-worker/test/rds2-*.test.js` 零命中（V1 冻结码分层与 payload 分层）。
- [ ] `grep -rn "identity.displayName" shared/ src/rds2/` 零命中（identity 仅 `userId/username`；用户表 `display_name` 与 `system.user-*` payload 的 `displayName` 为合法命中，逐一人工确认）。
- [ ] `grep -rn "TODO\|TBD\|同上\|参考前文\|必要修复\|<tmp>\|<dataDir>\|<skill>" src/rds2/ migrations/0006_rds2_v2_tables.sql test/rds2-*.test.js` 预期零命中。
- [ ] 命名一致性：`t_project_<event_seq>`、`stale_projection_write`、`business_dedupe_key`、`idempotency_state_corrupt`、`name_key_conflict`、`identity_conflict`、`illegal_state_transition` 在全部文件拼写一致（`grep -rn` 核对）。
