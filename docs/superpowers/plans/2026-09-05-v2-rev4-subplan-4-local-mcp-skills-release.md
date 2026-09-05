# RDS2 Local Outbox V2, Budgeted HTTP Routes, Skills Contract and Release Runbook Implementation Plan — Revision 4

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 Codex 三审 P0-10/11 与 P1 全部修正：① 本地 Outbox V2 状态机补全——fingerprint 改为**完整 envelope 的 canonical JSON SHA-256**（含 requestId/eventId/eventKey/identity/payload 全部字段，经共享协议 `canonicalJson`，禁止 `JSON.stringify` 直接比较）、新增 `available_at` 退避门槛、`confirmed` 重放直接返回本地 receipt、`AbortSignal.timeout` 30s、永久错误集合全枚举、单行 submit 与批量 flush 共用状态流（flushOne 不得重复 markSending）；② HTTP 路由预算化与完整身份检查——**鉴权先行**（未鉴权不读业务体）、`Content-Length` 不信任 + 实际字节复核 413、身份双核对（userId + 规范化 username 对 `name_key`）、入口根部单预算器且全部依赖经预算化封装、`RDS2_INIT_ENABLED` 独立开关、canary fail-closed、`targetRequestId/targetEventId` 与请求自身 requestId 严格区分；③ Runbook 修正——环境变量名统一、占位符清零、确定性 dry-run 门、Windows PowerShell 兼容命令、精确插件重装命令。

**Architecture:** 本地状态流冻结 `pending → sending → confirmed | pending(backoff) | blocked`；`claimPending` 在事务内逐行条件 UPDATE（`changes===1` 才进本批），markSending 未成功的行不进入当前 flush；退避序列 `[30s,60s,120s,300s,600s…]` 封顶写入 `available_at`，认领谓词 `state='pending' AND (available_at IS NULL OR available_at <= now)`。ingress 九步顺序（§10.1）：鉴权 → 大小双检 → 解析校验 → 身份双核对 → 哈希 → 七矩阵 → 原子插入 → receipt → 经 Dispatcher 唤醒（失败不阻塞 receipt，恢复器兜底）。每路由根部一个 `createSubrequestBudget` + `budgetD1` 包装 `env.DB`，禁止裸连。

**Tech Stack:** Node ≥22、`node:sqlite`（outbox-v2）、既有 MCP stdio bridge 骨架、Node test runner、Cloudflare vars/secrets。

**Spec:** 规格 Rev 4：§10.1（接收九步）、§10.2（targetRequestId 区分）、§11（本地 Outbox V2 全条）、§15.1（预算化封装）、§17（凭据身份）、§19.2（十步发布 + 四开关）、§21.4 验收门 11/12/13/16。

**Rev 4 相对 Rev 3 的关键修正（本子计划范围）:**
1. `local_outbox_v2.fingerprint` 从 `JSON.stringify([requestId, namespace, eventType, payload])` 改为 `sha256Hex(canonicalJson(完整 envelope))`；表新增 `available_at` 列与到期索引。
2. `confirmed` 行再次提交同一请求**直接返回本地 receipt**（不发网络）；`blocked` 行返回 blocked 语义不重试。
3. 新增 30s `AbortSignal.timeout`；永久错误集合全枚举（`request_id_conflict/event_id_conflict/event_key_already_recorded/identity_mismatch/user_disabled/unauthorized/invalid_*` 与 400/401/403/409）；临时 = 超时/网络错误/5xx/429/503 → 退避重排。
4. `claimPending` 改为事务内逐行条件 UPDATE（`meta.changes`/`changes===1` 判定）；`flushOne(requestId, {alreadySending})` 双路径——单行 submit 自行 markSending，批量 flush 传 `alreadySending: true` 禁止重复转移；markSending 未成功的行不发送。
5. ingress 重排为九步：鉴权移到读取 body 之前；大小先查 `Content-Length` 再按实际字节复核；身份核对补 username→`name_key`；`env.DB` 全部经 `budgetD1`；新增 `RDS2_INIT_ENABLED`；canary 变量显式配置为空串时 fail-closed（503 `canary_misconfigured`）。
6. event_status 查询的目标标识从 `payload.requestId` 改为 `payload.targetRequestId`（与 envelope 顶层 requestId 严格区分）；bridge 集成测试与 Worker 侧同步修正。
7. Runbook 修正（P1）：附录环境变量统一为 `RELIABLE_DRIVE_SYNC_OUTBOX_PATH`（删除 Rev 3 的 `RELIABLE_DRIVE_SYNC_OUTBOX_PATH_V2` 幻影变量）；dry-run 门改确定性相对路径 outdir 并附 PowerShell 等价命令；文档内 "本任务SHA/SHA/outdir" 三类尖括号占位符清零（测试锁定）；插件重装给出精确命令序列。

## Global Constraints

- 前置门 G0 与提交规范同主索引；受保护路径同子计划 1（`stdio-bridge.mjs` 仅按 Task 4.1/4.4 的明确 diff 修改 `configurationFromEnvironment()` 与 `createService()` 构造分支；`delivery-service.mjs` 与 `local-outbox.mjs` 不改，仅作 V1 黑盒参照）。
- Skills 仓库路径固定：`C:\Users\27846\my-chatgpt-skills`；只允许修改 Task 4.9 列出的文件。
- **协议事实强制**：identity 字段为 `userId` + `username`（协议无 displayName）；测试构造的 envelope payload 形状以 `shared/rds2-protocol.mjs` 的 `PAYLOAD_REGISTRY`（子计划 1 Task 1.2）为准。
- 混沌与路由测试全部本地；runbook 中任何远程命令（部署、迁移、Queue 创建、开关变更）仅作为文档内容，执行需乔炳源逐阶段授权。
- **预算化强制**：三个 V2 HTTP handler 内禁止裸 `env.DB`（一律 `budgetD1(env.DB, budget)`）与裸 `fetch`；静态测试锁定（Task 4.6）。
- 所有测试命令在 worktree `C:\Users\27846\my-chatgpt-mcp-v2` 执行；每 Task 结束 `git status --short` 只允许出现该 Task 文件清单。
- 提交规范：`git add` 只加本 Task 文件；消息前缀 `feat(v2):`/`test(v2):`/`fix(v2):`/`docs(v2):`；禁止 `git add -A`、`reset --hard`、`checkout --`、`stash drop`。
- 每 Task 回滚：`git revert <task_sha>`；Skills 仓库侧为在其自身 git 仓库 revert。

## Interfaces

- **Consumes**：子计划 1 `shared/rds2-protocol.mjs`（`canonicalJson/sha256Hex/validateEnvelope/normalizeUsername`）、accept-service、identity-init、credential-auth；子计划 2 引擎/调度；子计划 3 `budgeted-io` + `metrics`；`delivery-service.mjs` 的 `READ_ONLY_EVENTS` 行为（黑盒参照）。
- **Produces**：`tools/reliable-drive-sync-mcp/read-write-split.mjs` 导出 `READ_ONLY_EVENT_TYPES`、`isReadOnlyEnvelope`；`local-outbox-v2.mjs` 导出 `LocalOutboxV2`；`delivery-service-v2.mjs` 导出 `DeliveryServiceV2`；Worker `src/rds2/http-ingress.js` 导出 `handleV2Events(buildDeps)`；`src/rds2/http-query.js` 导出 `handleV2Query(buildDeps)`；`src/rds2/http-identity-init.js` 导出 `handleV2UsersInit(buildDeps)`；`docs/superpowers/plans/v2-release-runbook.md`。

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
  test("explicit RELIABLE_DRIVE_SYNC_OUTBOX_PATH overrides v2 default (single variable for both modes)", () => {
    // 给定 v2 + 显式 RELIABLE_DRIVE_SYNC_OUTBOX_PATH → 原样使用；
    // 注：该变量同时服务 v1/v2 覆盖，不存在 *_V2 后缀的变体（runbook 一致性由 Task 4.10 测试锁定）
  });
  ```
  `configurationFromEnvironmentForTest(envOverrides)` 为 `stdio-bridge.mjs` 新导出的纯函数（内部复用 `configurationFromEnvironment` 逻辑，参数化 env 来源；主进程入口行为不变）。
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
  `defaultOutboxBase()` 抽取自现有 `defaultOutboxPath()` 的 base 三行（`stdio-bridge.mjs:40-45`），`defaultOutboxPath()` 改为 `join(defaultOutboxBase(), "ReliableDriveSync", "outbox.sqlite")` 保持 v1 默认路径逐字节不变；本 Task 的 `createService()` 在 `writeVersion === "v2"` 分支仅抛 `new Error("v2_delivery_not_wired")`（由本 Task 测试断言），真实接线在 Task 4.4 完成。
- [ ] 4. 验证：`npm run test:bridge` 预期 `# fail 0`（新增用例通过，既有 47 个全绿——v1 路径未变）。
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

### Task 4.3 local-outbox-v2 重写（canonical fingerprint + available_at + 原子认领 + confirmed 重放）

**Files:** Create `tools/reliable-drive-sync-mcp/local-outbox-v2.mjs`；Test `tools/reliable-drive-sync-mcp/test/v2-local-outbox.test.mjs`
**Interfaces:** Produces `LocalOutboxV2` | Consumes `shared/rds2-protocol.mjs`（`canonicalJson/sha256Hex`）、`node:sqlite`
**规格依据（§11）:** fingerprint = 完整 envelope 的 canonical JSON SHA-256；状态流 `pending→sending→confirmed|pending(backoff)|blocked`；`available_at` 退避门槛；原子认领且 markSending 未成功不发送；单批 ≤20；confirm 清 payload 留最小 receipt。

- [ ] 1. 失败测试：
  ```js
  import { canonicalJson } from "../../../shared/rds2-protocol.mjs";
  test("schema has fingerprint/available_at and state check covers exactly four states", async () => {
    const outbox = new LocalOutboxV2(tempPath());
    const cols = outbox.columns("local_outbox_v2");
    for (const c of ["request_id", "state", "payload_json", "envelope_fingerprint", "available_at",
                     "attempt_count", "last_error_code", "last_receipt_json", "created_at", "updated_at"]) assert.ok(cols.includes(c), c);
    assert.throws(() => outbox.db.prepare("INSERT INTO local_outbox_v2 (request_id, state, envelope_fingerprint, created_at, updated_at) VALUES ('x','weird','f','t','t')").run(), /CHECK/);
  });
  test("fingerprint is sha256 of canonicalJson over the FULL envelope (identity/eventKey included)", async () => {
    const outbox = new LocalOutboxV2(tempPath());
    const envA = { requestId: "r-1", eventId: "e-1", eventKey: "k-1", identity: { userId: "u", username: "q" }, payload: { b: 1, a: 2 } };
    await outbox.enqueue(envA);
    // 键序不同的同一 envelope → 视为同输入（canonical 字段顺序无关）
    await outbox.enqueue({ a: 2, b: 1, payload: { b: 1, a: 2 }, identity: { username: "q", userId: "u" }, eventKey: "k-1", eventId: "e-1", requestId: "r-1" });
    assert.equal(outbox.countRows(), 1);
  });
  test("enqueue reuses row for same request_id and same input; rejects different input", async () => {
    const outbox = new LocalOutboxV2(tempPath());
    const envA = baseEnvelope();
    await outbox.enqueue(envA);
    await outbox.enqueue({ ...envA });                       // 同输入重用
    await assert.rejects(() => outbox.enqueue({ ...envA, payload: { ...envA.payload, x: 1 } }), /request_id_conflict/);
  });
  test("claimPending is atomic: row whose conditional markSending fails is skipped, not sent", async () => {
    // 两行 pending；注入第一行的条件 UPDATE 失败（changes=0 模拟并发改写）→ claimPending 只返回第二行
    // flush 对第一行零网络调用
  });
  test("available_at gates claiming; due rows are claimed", async () => {
    // 行 A available_at = now+60s、行 B NULL、行 C now-1s → claimPending 只含 B、C
  });
  test("restart recovers sending to pending (available_at cleared = immediately due)", async () => {
    // 预置 sending 行 → 关闭实例重开 recoverSending() → pending 且 claimPending 可取
  });
  test("flushPending takes at most 20 due rows", async () => { /* 25 行 → 20 */ });
  test("confirm clears payload but keeps minimal receipt", async () => { /* payload_json NULL、last_receipt_json 非空 */ });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（核心 SQL）：
  ```js
  import { DatabaseSync } from "node:sqlite";
  import { canonicalJson, sha256Hex } from "../../../shared/rds2-protocol.mjs";
  export class LocalOutboxV2 {
    constructor(filePath) {
      this.db = new DatabaseSync(filePath);
      this.db.exec(`CREATE TABLE IF NOT EXISTS local_outbox_v2 (
        request_id TEXT PRIMARY KEY NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','sending','blocked','confirmed')),
        payload_json TEXT,
        envelope_fingerprint TEXT NOT NULL,
        available_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        last_receipt_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_local_outbox_v2_due ON local_outbox_v2(state, available_at)`);
    }
    async enqueue(envelope) {
      const fingerprint = await sha256Hex(canonicalJson(envelope));   // 完整 envelope，字段顺序无关
      const existing = this.db.prepare("SELECT * FROM local_outbox_v2 WHERE request_id = ?").get(envelope.requestId);
      if (existing) {
        if (existing.envelope_fingerprint !== fingerprint) throw new Error("request_id_conflict");
        return existing;
      }
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO local_outbox_v2 (request_id, state, payload_json, envelope_fingerprint, available_at, created_at, updated_at)
        VALUES (?, 'pending', ?, ?, NULL, ?, ?)`).run(envelope.requestId, JSON.stringify(envelope), fingerprint, now, now);
      return this.byRequestId(envelope.requestId);
    }
    claimPending(limit = 20, now = new Date().toISOString()) {
      return this.db.transaction(() => {
        const due = this.db.prepare(`SELECT request_id FROM local_outbox_v2
          WHERE state='pending' AND (available_at IS NULL OR available_at <= ?) ORDER BY created_at LIMIT ?`).all(now, limit);
        const claimed = [];
        for (const row of due) {
          const res = this.db.prepare(`UPDATE local_outbox_v2 SET state='sending', attempt_count=attempt_count+1, updated_at=?
            WHERE request_id=? AND state='pending'`).run(now, row.request_id);
          if (res.changes === 1) claimed.push(row.request_id);       // 条件转移未成功 → 不进本批，不发送
        }
        return claimed;
      })();
    }
    markSending(requestId, now = new Date().toISOString()) {
      const res = this.db.prepare(`UPDATE local_outbox_v2 SET state='sending', attempt_count=attempt_count+1, updated_at=?
        WHERE request_id=? AND state='pending'`).run(now, requestId);
      return res.changes === 1;
    }
    block(requestId, code) { this.db.prepare(`UPDATE local_outbox_v2 SET state='blocked', last_error_code=?, updated_at=? WHERE request_id=? AND state IN ('sending','pending')`).run(code, new Date().toISOString(), requestId); }
    requeue(requestId, code, backoffMs, now = Date.now()) {
      this.db.prepare(`UPDATE local_outbox_v2 SET state='pending', last_error_code=?, available_at=?, updated_at=? WHERE request_id=? AND state='sending'`)
        .run(code, new Date(now + backoffMs).toISOString(), new Date(now).toISOString(), requestId);
    }
    confirm(requestId, receipt) {
      this.db.prepare(`UPDATE local_outbox_v2 SET state='confirmed', payload_json=NULL, last_receipt_json=?, available_at=NULL, updated_at=? WHERE request_id=? AND state='sending'`)
        .run(JSON.stringify(receipt), new Date().toISOString(), requestId);
    }
    recoverSending() { this.db.prepare(`UPDATE local_outbox_v2 SET state='pending', available_at=NULL, updated_at=? WHERE state='sending'`).run(new Date().toISOString()); }
    byRequestId: 内部方法——SELECT * WHERE request_id=?
    columns(table) { return this.db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name); }
  }
  ```
- [ ] 4. `npm run test:bridge` 预期 `# fail 0`。
- [ ] 5. 提交：`git add tools/reliable-drive-sync-mcp/local-outbox-v2.mjs tools/reliable-drive-sync-mcp/test/v2-local-outbox.test.mjs && git commit -m "feat(v2): local outbox v2 with canonical fingerprint and due gating"`。

### Task 4.4 delivery-service-v2 重写（超时中止 + 永久错误集合 + 共用状态流 + confirmed 重放）

**Files:** Create `tools/reliable-drive-sync-mcp/delivery-service-v2.mjs`；Modify `tools/reliable-drive-sync-mcp/stdio-bridge.mjs`（仅 `createService()` 的 v2 分支）；Test `tools/reliable-drive-sync-mcp/test/v2-delivery-service.test.mjs`
**Interfaces:** Produces `DeliveryServiceV2` | Consumes Task 4.2/4.3、`shared/rds2-protocol.mjs`
**规格依据（§11）:** 永久错误直接 blocked（400/401/403/409 与协议错误码集合）；临时 = 超时/网络错误/5xx/429/503 → 退避；confirmed 重放零网络；三个 ID 每次重试原样。

- [ ] 1. 失败测试：
  ```js
  test("write requests persist locally before any network call", async () => { /* fetch 计数 0 时行已存在 */ });
  test("confirmed row replay returns local receipt with zero network", async () => {
    // 第一次提交 confirm 成功 → 再次 submit 同 envelope → 返回 last_receipt_json 且 fetch 计数不增加
  });
  test("read requests go to /v2/query and never touch outbox", async () => { /* 五类读 → POST /v2/query；库行数 0 */ });
  test("permanent error codes block immediately and are never retried by sweeps", async () => {
    for (const code of ["request_id_conflict", "event_id_conflict", "event_key_already_recorded",
                        "identity_mismatch", "user_disabled", "unauthorized", "invalid_envelope"]) {
      // 服务端 409/403/400 + {error: code} → state='blocked'；两次 flushPending 均跳过；fetch 只发生一次
    }
  });
  test("http status 400/401/403/409 blocks even with unknown body code", async () => { /* blocked + http_4xx 代码 */ });
  test("timeout aborts at 30s and requeues as temporary", async () => {
    // fetchImpl 挂起不响应 → flushOne 在约 30s 内以 TimeoutError 结束（测试注入 10ms 假计时验证路径）→ pending + last_error_code='timeout'
  });
  test("5xx/429/503 requeue with capped backoff into available_at", async () => {
    // 连续失败 6 次 → attempt_count=6 且 available_at 增量封顶 600000ms（[30s,60s,120s,300s,600s,600s…]）
  });
  test("lost response after d1 commit: same three ids retry returns original receipt then confirms", async () => {
    // 第一次 fetch 抛网络错误；第二次返回相同 receipt → confirm 用该 receipt；两次请求体 requestId/eventId/eventKey 深相等
  });
  test("batch flush does not re-markSending rows it already claimed", async () => {
    // spy markSending：claimPending 后的 flushPending 期间每行恰被调用 0 次（状态已在 claim 时转移）
  });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（分支核心，并在本 Task 完成与 `createService()` 的接线）：`stdio-bridge.mjs` 的 `createService()` 中 Task 4.1 的 `v2_delivery_not_wired` 分支替换为：
  ```js
  const { DeliveryServiceV2 } = await import("./delivery-service-v2.mjs");
  return new DeliveryServiceV2({ outbox: new LocalOutboxV2(options.outboxPath ?? defaultV2OutboxPath()), workerUrl: options.workerUrl, token: options.token, fetchImpl: options.fetchImpl });
  ```
  ```js
  import { isReadOnlyEnvelope } from "./read-write-split.mjs";
  const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
  const capBackoff = (attempt) => BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  const PERMANENT = new Set(["request_id_conflict", "event_id_conflict", "event_key_already_recorded",
    "identity_mismatch", "user_disabled", "unauthorized", "invalid_envelope", "invalid_event",
    "invalid_payload", "invalid_schema_version"]);
  const PERMANENT_STATUS = new Set([400, 401, 403, 409]);
  export class DeliveryServiceV2 {
    constructor({ outbox, workerUrl, token, fetchImpl = fetch }) { Object.assign(this, { outbox, workerUrl, token, fetchImpl }); }
    async submit(envelope) {
      if (isReadOnlyEnvelope(envelope)) return this.query(envelope);
      const row = await this.outbox.enqueue(envelope);            // 网络前先持久化
      if (row.state === "confirmed") return JSON.parse(row.last_receipt_json);  // confirmed 重放零网络
      await this.flushOne(row.request_id);                        // 单行路径：自行 markSending
      return this.outbox.byRequestId(row.request_id).last_receipt_json
        ? JSON.parse(this.outbox.byRequestId(row.request_id).last_receipt_json)
        : { status: "pending", requestId: row.request_id };
    }
    async query(envelope) {
      const response = await this.fetchImpl(`${this.workerUrl}/v2/query`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(30_000)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error ?? `query_${response.status}`);
      return body;
    }
    async flushOne(requestId, { alreadySending = false } = {}) {
      let row = this.outbox.byRequestId(requestId);
      if (!row || row.state === "confirmed" || row.state === "blocked") return null;
      if (!alreadySending && !this.outbox.markSending(requestId)) return null;   // 未成功不得发送
      row = this.outbox.byRequestId(requestId);
      if (row.state !== "sending") return null;
      try {
        const response = await this.fetchImpl(`${this.workerUrl}/v2/events`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
          body: row.payload_json,                                  // 冻结 envelope 原文：三 ID 每次原样
          signal: AbortSignal.timeout(30_000)
        });
        const body = await response.json().catch(() => ({}));
        if (response.ok && (body?.status === "accepted" || body?.status === "already_recorded")) {
          this.outbox.confirm(requestId, body);
          return body;
        }
        if (PERMANENT.has(body?.error) || PERMANENT_STATUS.has(response.status)) {
          this.outbox.block(requestId, body?.error ?? `http_${response.status}`);
          return { status: "blocked", errorCode: body?.error ?? `http_${response.status}` };
        }
        this.outbox.requeue(requestId, body?.error ?? `http_${response.status}`, capBackoff(row.attempt_count));
        return { status: "pending" };
      } catch (cause) {                                            // 超时/网络错误 = 临时
        this.outbox.requeue(requestId, cause?.name === "TimeoutError" ? "timeout" : "network_error", capBackoff(row.attempt_count));
        return { status: "pending" };
      }
    }
    async flushPending() {
      const ids = this.outbox.claimPending(20);                    // 批量路径：认领即 sending
      for (const id of ids) await this.flushOne(id, { alreadySending: true });
      return ids.length;
    }
  }
  ```
- [ ] 4. `npm run test:bridge` 预期 `# fail 0`。
- [ ] 5. 提交：`git add tools/reliable-drive-sync-mcp/delivery-service-v2.mjs tools/reliable-drive-sync-mcp/stdio-bridge.mjs tools/reliable-drive-sync-mcp/test/v2-delivery-service.test.mjs && git commit -m "feat(v2): delivery service v2 with abort timeout and permanent error set"`。

### Task 4.5 Bridge 五类读 + 写路径集成测试（targetRequestId 契约）

**Files:** Test `tools/reliable-drive-sync-mcp/test/v2-bridge-integration.test.mjs`
**Interfaces:** Consumes Task 4.1–4.4（经真实 `handleRequest` + 注入 fetch）

- [ ] 1. 失败测试（七块）：
  ```js
  const READ_CASES = [
    ["capabilities read",  { schemaVersion: "1.2", namespace: "system", eventType: "system.capabilities.read", requestId: "r-cap", identity: IDENTITY, payload: {} }],
    ["user resolve",       { schemaVersion: "1.2", namespace: "system", eventType: "system.user.resolve", requestId: "r-ur", identity: IDENTITY, payload: { username: "乔炳源" } }],
    ["profile snapshot",   { schemaVersion: "1.2", namespace: "profile", eventType: "profile.snapshot.read", requestId: "r-ps", identity: IDENTITY, payload: { domain: "backend" } }],
    ["session list",       { schemaVersion: "1.2", namespace: "interview", eventType: "interview.session.list", requestId: "r-sl", identity: IDENTITY, payload: {} }],
    ["session load",       { schemaVersion: "1.2", namespace: "interview", eventType: "interview.session.load", requestId: "r-ld", identity: IDENTITY, payload: { sessionId: "s1" } }]
  ];
  // IDENTITY = { userId: "u-1", username: "乔炳源" }；payload 形状以 shared/rds2-protocol.mjs PAYLOAD_REGISTRY 为准
  for (const [name, envelope] of READ_CASES) {
    test(`${name} goes to /v2/query and creates no outbox row under writeVersion=v2`, async () => {
      // env writeVersion=v2 + 注入 fetch 记录 URL → 断言 URL 以 /v2/query 结尾；outbox-v2.sqlite 行数 0（惰性建库）
    });
  }
  test("event status read uses payload.targetRequestId, never reuse of the request's own requestId", async () => {
    // envelope.requestId = "q-1"（本次查询自身），payload.targetRequestId = "r-1"（查询目标）
    // 断言发往 /v2/query 的 body 两个键分别存在且值不同
  });
  test("write under writeVersion=v2 persists locally before POST /v2/events", async () => { /* algorithm.learning.completed → 先有行后 fetch */ });
  test("reads never produce business events on the wire", async () => { /* 假服务端断言 body eventType ∈ READ_ONLY_EVENT_TYPES */ });
  ```
  `event status` 读的 envelope 形态冻结为：`{schemaVersion:"1.2", namespace:"profile", eventType:"profile.snapshot.read", requestId:"q-1", identity, payload:{ domain:"backend", scope:"event_status", targetRequestId:"r-1" }}`——`handleV2Query`（Task 4.6）按 `payload.scope` 分支并以 `payload.targetRequestId` 查询。
- [ ] 2. 预期失败：路由未分流或 Outbox 误建行。
- [ ] 3. 修复落点：`delivery-service-v2.submit` 的读分支（不得改 `stdio-bridge.mjs` 以外的 V1 文件）。
- [ ] 4. `npm run test:bridge` 预期 `# fail 0`。
- [ ] 5. 提交：`git add tools/reliable-drive-sync-mcp/test/v2-bridge-integration.test.mjs && git commit -m "test(v2): bridge read write integration with targetRequestId contract"`。

### Task 4.6 Worker 三路由重写：鉴权先行 + 实际字节 413 + 身份双核对 + 根部预算器 + 独立开关

**Files:** Create `src/rds2/http-ingress.js`、`src/rds2/http-query.js`、`src/rds2/http-identity-init.js`；Modify `src/index.js`（fetch 路由追加三行 + 装配）；Test `test/rds2-http-ingress.test.js`、`test/rds2-http-query.test.js`、`test/rds2-http-identity-init.test.js`、`test/worker-routes.test.js`（追加分开关断言）
**Interfaces:** Consumes 子计划 1 服务层 + 子计划 3 `budgetD1/metrics` + 子计划 2 `createSubrequestBudget`
**规格依据（§10.1 九步 + Codex P0-11）:** ①鉴权先行（未鉴权不读业务体）②Content-Length 预检 + 实际字节复核 413 ③完整校验 ④身份双核对（userId + 规范化 username 对 `name_key`）⑤哈希 ⑥七矩阵 ⑦原子插入 ⑧receipt ⑨唤醒失败不阻塞。canary 显式配置为空 = fail-closed。`RDS2_INIT_ENABLED` 独立门控 init 路由。

- [ ] 1. 失败测试（ingress，九步逐条）：
  ```js
  test("step1: unauthenticated request never reads business body", async () => {
    // 无凭据 → 401 unauthorized；注入 body 读取 spy 断言 request.json/arrayBuffer 未被调用
  });
  test("step2: declared Content-Length > 1MiB -> 413 without reading; actual bytes > 1MiB -> 413", async () => {
    // 场景 A：头声明 2MiB → 413（body 未读）；场景 B：无 Content-Length 但实际 1MiB+1 字节 → 413
  });
  test("step4: identity userId mismatch -> 403; normalized username != name_key -> 403", async () => {
    // 凭据 A 提交 identity.userId=B → 403 identity_mismatch
    // username 大小写/空白变体规范化后等于 name_key → 200；规范化后不等 → 403
  });
  test("canary fail-closed: explicitly empty allowlist rejects; unset passes under EVENTS gate", async () => {
    // RDS2_CANARY_NAMESPACES="" → 503 canary_misconfigured（fail-closed）
    // 未设置 + algorithm 事件 → 200；RDS2_CANARY_NAMESPACES="algorithm" + interview → 503 namespace_not_enabled
  });
  test("admin token cannot call ingress (permission separation)", async () => { /* admin token → 401 unauthorized */ });
  test("accepted response is the durable receipt and one wake is published", async () => { /* receipt 断言 + 假队列 send 计数 1 */ });
  test("queue publish failure still returns accepted (recovery backstop)", async () => { /* send 抛错 → 200 receipt */ });
  test("route handler uses budgetD1 only (static)", () => {
    const src = readFileSync(new URL("../src/rds2/http-ingress.js", import.meta.url), "utf8");
    assert.ok(!src.includes("env.DB"));
    assert.ok(src.includes("budgetD1"));
  });
  ```
- [ ] 2. 失败测试（query）：
  ```js
  test("projection read is identity-bound to the credential user", async () => { /* A 查 B 的 namespace+userId → 403 identity_mismatch */ });
  test("event_status resolves by payload.targetRequestId and only returns rows owned by the credential user", async () => {
    // 他人 targetRequestId → 404 event_not_found（不泄露存在性）；自己的 → 分层状态行
  });
  test("RDS2_READS_ENABLED gate + admin token cannot read projections", async () => { /* 开关关 → 503；admin → 401 */ });
  ```
- [ ] 3. 失败测试（identity-init）：`RDS2_INIT_ENABLED !== "true"` → 503 `rds2_disabled`（**独立开关**）；admin token 错误 → 403；成功 → 201 + 一次性凭据；普通用户凭据调用 → 401。admin 期望值经依赖注入（子计划 1 T1.15 `expectedAdminToken`），未配置时 fail-closed 403，禁止字符串字面量比较。
- [ ] 4. 失败测试（routes/开关全闭）：
  ```js
  test("all four gates off: three v2 routes 503 and v1 routes byte-identical", async () => {
    // RDS2_EVENTS_ENABLED/RDS2_READS_ENABLED/RDS2_INIT_ENABLED 缺省 → 503 rds2_disabled
    // V1 路由响应快照：/v1/sync 与 /v1/qstash/failure 行为与改造前一致（既有 worker-routes 断言保持绿）
  });
  ```
- [ ] 5. 预期失败：404（路由不存在）。
- [ ] 6. 实现（三文件 + index.js 追加）：
  ```js
  // src/rds2/http-ingress.js（顺序 = 规格 §10.1 九步）
  export function handleV2Events(buildDeps) {
    return async function (request, env) {
      if (env.RDS2_EVENTS_ENABLED !== "true") return json(503, { error: "rds2_disabled" });
      const budget = createSubrequestBudget({ limit: 10 });            // 入口根部单预算器
      const db = budgetD1(env.DB, budget);                             // 全依赖预算化
      let user;                                                        // ① 鉴权先行
      try { user = await authenticateUser(db, request.headers.get("authorization") ?? ""); }
      catch { return json(401, { error: "unauthorized" }); }
      const declared = Number(request.headers.get("content-length") ?? "0");   // ② 大小双检
      if (declared > 1_048_576) return json(413, { error: "payload_too_large" });
      const raw = await request.arrayBuffer();
      if (raw.byteLength > 1_048_576) return json(413, { error: "payload_too_large" });   // 实际字节复核
      let envelope;                                                    // ③ 解析与完整校验
      try { envelope = JSON.parse(new TextDecoder().decode(raw)); } catch { return json(400, { error: "invalid_json" }); }
      try { validateEnvelope(envelope); } catch (cause) { return json(400, { error: cause.code ?? "invalid_envelope" }); }
      if (envelope.identity?.userId !== user.user_id) return json(403, { error: "identity_mismatch" });          // ④ 双核对
      if (normalizeUsername(envelope.identity?.username) !== user.name_key) return json(403, { error: "identity_mismatch" });
      const rawCanary = env.RDS2_CANARY_NAMESPACES;                    // canary fail-closed
      if (typeof rawCanary === "string" && rawCanary.trim() === "") return json(503, { error: "canary_misconfigured" });
      const canary = (rawCanary ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (canary.length && !canary.includes(envelope.namespace)) return json(503, { error: "namespace_not_enabled" });
      const canaryUsers = (env.RDS2_CANARY_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (canaryUsers.length && !canaryUsers.includes(user.user_id)) return json(503, { error: "user_not_canary" });
      try {
        const receipt = await createAcceptService(db, buildDeps(env))(envelope, user);   // ⑤-⑧（哈希/七矩阵/插入/receipt 在服务内）
        try { await buildQueueIo(env, budget).sendWake(receipt.taskId, "project_event", 0); } catch { /* ⑨ 恢复器兜底 */ }
        emitBudgetSnapshot(budget, "ingress");
        return json(200, receipt);
      } catch (cause) {
        return json(errorStatus(cause), { error: cause.code ?? cause.message });
      }
    };
  }
  ```
  `normalizeUsername` 复用子计划 1 共享协议导出（与 `name_key` 落库同源，禁两端漂移）。`handleV2Query`（`RDS2_READS_ENABLED` 门 → 鉴权 → `scope` 分支：投影读按 credential user 绑定、`event_status` 按 `payload.targetRequestId` 且仅本用户行）与 `handleV2UsersInit`（`RDS2_INIT_ENABLED` 门 → `expectedAdminToken` 注入比较）按同风格实现；`index.js` fetch 追加三行路由。
- [ ] 7. `npm run test:worker` 预期 `# fail 0`。
- [ ] 8. 提交：`git add services/reliable-drive-sync-worker/src/rds2/http-ingress.js services/reliable-drive-sync-worker/src/rds2/http-query.js services/reliable-drive-sync-worker/src/rds2/http-identity-init.js services/reliable-drive-sync-worker/src/index.js services/reliable-drive-sync-worker/test/rds2-http-ingress.test.js services/reliable-drive-sync-worker/test/rds2-http-query.test.js services/reliable-drive-sync-worker/test/rds2-http-identity-init.test.js services/reliable-drive-sync-worker/test/worker-routes.test.js && git commit -m "feat(v2): auth-first budgeted v2 routes with identity dual check and init flag"`。

### Task 4.7 本地 Outbox 故障语义套件（重启/超时/退避/阻塞/重放）

**Files:** Test `tools/reliable-drive-sync-mcp/test/v2-outbox-chaos.test.mjs`
**Interfaces:** Consumes Task 4.3/4.4
**规格依据（§21.4 验收门 11）:** 本地 Outbox 重启/超时/退避/阻塞/重放五语义逐一证明。

- [ ] 1. 失败测试（五块）：
  ```js
  test("restart: sending rows recover to pending and flush again succeeds", async () => { /* 关闭重开 → recoverSending → flush 成功 confirm */ });
  test("timeout: hung server aborts at 30s boundary path and requeues with backoff", async () => { /* 注入短计时假钟验证 TimeoutError 分支 */ });
  test("backoff: available_at caps at 600s and due rows re-claim", async () => { /* 六次失败序列断言增量 */ });
  test("blocked: permanent errors survive sweeps and restarts without retry", async () => { /* blocked 行跨重启保持 blocked */ });
  test("replay: confirmed row re-submit returns local receipt with zero fetch (also after restart)", async () => { /* */ });
  ```
- [ ] 2. 预期失败 → 修复落点在 Task 4.3/4.4 文件内（独立 commit 注明块名：`fix(v2): outbox chaos <block>`）。
- [ ] 3. `npm run test:bridge` 预期 `# fail 0`。
- [ ] 4. 提交：`git add tools/reliable-drive-sync-mcp/test/v2-outbox-chaos.test.mjs && git commit -m "test(v2): local outbox chaos semantics"`。

### Task 4.8 Worker 端到端混沌与故障恢复套件（§16 十行）

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
- [ ] 2. 预期失败：按行定位实现缺口；每行修复独立 commit，消息依次：`fix(v2): chaos local-row-restart`、`fix(v2): chaos d1-commit-response-lost`、`fix(v2): chaos queue-publish-failed`、`fix(v2): chaos queue-duplicate-reorder`、`fix(v2): chaos projection-half-failure`、`fix(v2): chaos crash-before-ack`、`fix(v2): chaos drive-response-lost`、`fix(v2): chaos drive-long-outage`、`fix(v2): chaos same-name-diff-content`、`fix(v2): chaos budget-exhaustion-release`。
- [ ] 3. `npm run test:worker` 与 `npm run test:bridge` 双绿。
- [ ] 4. 提交：`git add services/reliable-drive-sync-worker/test/rds2-chaos.test.js && git commit -m "test(v2): chaos and failure recovery suite"`。

### Task 4.9 Skills 契约盘点与文案修订（仓库 `C:\Users\27846\my-chatgpt-skills`）

**Files:** Create（主仓）`docs/superpowers/plans/v2-skill-contract-inventory.md`；Modify（skills 仓）`AGENTS.md`、五个 skill 的 `SKILL.md`（精确路径：`C:\Users\27846\my-chatgpt-skills\algorithm-learning\SKILL.md`、`C:\Users\27846\my-chatgpt-skills\backend-project-learning\SKILL.md`、`C:\Users\27846\my-chatgpt-skills\conducting-java-backend-mock-interviews\SKILL.md`、`C:\Users\27846\my-chatgpt-skills\java-knowledge-based-on-resume-learn-skill\SKILL.md`、`C:\Users\27846\my-chatgpt-skills\reviewing-java-backend-interviews\SKILL.md`）、`tests\` 内五个契约测试文件（`algorithm-learning.v2-contract.test.mjs`、`backend-project-learning.v2-contract.test.mjs`、`conducting-java-backend-mock-interviews.v2-contract.test.mjs`、`java-knowledge-based-on-resume-learn-skill.v2-contract.test.mjs`、`reviewing-java-backend-interviews.v2-contract.test.mjs`）
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

### Task 4.10 插件重装与十步发布 runbook（P1 修正版：变量统一、占位符清零、确定性 dry-run、PowerShell 兼容）

**Files:** Create（主仓）`docs/superpowers/plans/v2-release-runbook.md`；Test（主仓）`services/reliable-drive-sync-worker/test/rds2-runbook-config.test.js`
**Interfaces:** Consumes 全部开关名 | Produces runbook 文档
**规格依据（§19.2 + Codex P1）:** 环境变量名与实现完全一致（`RELIABLE_DRIVE_SYNC_OUTBOX_PATH`，无 `_V2` 幻影变量）；文档内不残留 "本任务SHA/SHA/outdir" 三类尖括号占位符；dry-run 命令确定性（固定相对路径 outdir，bash 与 PowerShell 双版本）；插件重装精确命令。

- [ ] 1. 失败测试（runbook 配置一致性，文档即契约）：
  ```js
  test("runbook references exactly the implemented env vars", () => {
    const runbook = readFileSync(new URL("../../../docs/superpowers/plans/v2-release-runbook.md", import.meta.url), "utf8");
    for (const v of ["RDS2_EVENTS_ENABLED", "RDS2_READS_ENABLED", "RDS2_PROJECT_ENABLED", "RDS2_ARCHIVE_ENABLED",
                     "RDS2_RECOVERY_ENABLED", "RDS2_INIT_ENABLED", "RDS2_ADMIN_TOKEN",
                     "RDS2_CANARY_NAMESPACES", "RDS2_CANARY_USER_IDS", "RDS2_DRIVE_ROOT_FOLDER_ID",
                     "RELIABLE_DRIVE_SYNC_WRITE_VERSION", "RELIABLE_DRIVE_SYNC_OUTBOX_PATH"]) assert.match(runbook, new RegExp(v));
    assert.ok(!runbook.includes("RELIABLE_DRIVE_SYNC_OUTBOX_PATH_V2"), "phantom var must not exist");
    for (const step of ["暗部署", "合成用户", "单客户端", "algorithm", "一周", "二次确认"]) assert.match(runbook, new RegExp(step));
  });
  test("runbook has no unresolved placeholders and carries both shell variants for dry-run", () => {
    const runbook = readFileSync(new URL("../../../docs/superpowers/plans/v2-release-runbook.md", import.meta.url), "utf8");
    for (const placeholder of ["<本任务SHA>", "<SHA>", "<outdir>"]) assert.ok(!runbook.includes(placeholder), placeholder);
    assert.match(runbook, /tmp-dryrun/);            // 确定性 outdir
    assert.match(runbook, /powershell/i);           // PowerShell 兼容版本存在
  });
  ```
- [ ] 2. runbook 内容（十步 = 规格 §19.2，每步四列：进入条件 / 动作与命令（需授权）/ 退出条件 / 回滚）：
  | 步 | 进入条件 | 动作与命令（需授权） | 退出条件与回滚 |
  |---|---|---|---|
  | 1 本地测试 | 子计划 1–4 全绿 | 仓库根执行 `npm test`；确定性 dry-run 门（bash）：`npx wrangler deploy --config services/reliable-drive-sync-worker/wrangler.toml --dry-run --outdir ./services/reliable-drive-sync-worker/tmp-dryrun` 后 `rm -rf ./services/reliable-drive-sync-worker/tmp-dryrun`；PowerShell 等价：`npx wrangler deploy --config services/reliable-drive-sync-worker/wrangler.toml --dry-run --outdir ./services/reliable-drive-sync-worker/tmp-dryrun; Remove-Item -Recurse -Force ./services/reliable-drive-sync-worker/tmp-dryrun` | 全绿 + dry-run 退出码 0；无回滚需求 |
  | 2 暗部署 | Codex 四审通过 + 乔炳源授权 | `npx wrangler deploy`（所有 RDS2_* 开关缺省=false，暗部署全闭） | V1 指标无回归；回滚 `npx wrangler rollback` |
  | 3 合成用户 | 步骤 2 观察 24h | admin 调 `POST /v2/users/init`（需先开 `RDS2_INIT_ENABLED`，`RDS2_ADMIN_TOKEN` 经 secret 注入） | 返回 userId+凭据；回滚关开关（初始化幂等） |
  | 4 合成 canary | 步骤 3 完成 | 逐一开启 `RDS2_EVENTS_ENABLED`、`RDS2_READS_ENABLED`、`RDS2_PROJECT_ENABLED`、`RDS2_ARCHIVE_ENABLED`（vars 变更需重新部署生效），每步验证开启前拒绝与开启后放行 | 全链路 + 预算指标 ≤ 上限 + DLQ 空；回滚关开关 + rollback |
  | 5 单客户端 MCP 切换 | 步骤 4 观察 ≥48h 零 needs_attention | 用户本机设 `RELIABLE_DRIVE_SYNC_WRITE_VERSION=v2` + 用户凭据（`RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET`）；V1 pending 行逐条确认处理 | 一周无阻塞行；回退改回 v1（outbox-v2.sqlite 保留） |
  | 6 真实 algorithm canary | 步骤 5 完成 | `RDS2_CANARY_NAMESPACES=algorithm` | 画像内容与用户核对一致；回滚清空白名单 |
  | 7 其他域逐个 | 步骤 6 每域独立观察 | 白名单逐域追加 `interview`,`profile`,`resume-knowledge` | 每域抽检一致；回滚清空白名单恢复 algorithm-only，再 rollback |
  | 8 Skill/插件生效 | 步骤 7 全绿 | skills 仓文案提交后执行插件重装（见附录精确命令） | 契约测试绿；回滚 revert + 重装旧版 |
  | 9 稳定观察 ≥1 周 | 步骤 8 | 每日检查 needs_attention/DLQ/预算快照 | 零 P1 |
  | 10 关闭 V1/QStash | 步骤 9 + 乔炳源二次独立确认 | 停 V1 写入（移除 QStash 调度） | **单向动作，无自动回滚** |
- [ ] 3. 插件重装附录（精确命令，PowerShell 从仓库根执行）：
  ```powershell
  # 1) 停止运行中的 MCP 客户端进程后重装本地桥接插件
  node C:\Users\27846\my-chatgpt-mcp\tools\reliable-drive-sync-mcp\setup-local-clients.ps1
  # 2) 环境变量清单（setup-local-clients.ps1 写入用户级）：
  #    RELIABLE_DRIVE_SYNC_WORKER_URL=<worker 部署地址>
  #    RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET=<用户凭据，非 admin token>
  #    RELIABLE_DRIVE_SYNC_WRITE_VERSION=v2
  #    RELIABLE_DRIVE_SYNC_OUTBOX_PATH=<可选，默认 %LOCALAPPDATA%\ReliableDriveSync\outbox-v2.sqlite>
  # 3) 验证：node --test tools/reliable-drive-sync-mcp/test/v2-config.test.mjs
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add docs/superpowers/plans/v2-release-runbook.md services/reliable-drive-sync-worker/test/rds2-runbook-config.test.js && git commit -m "docs(v2): corrected ten-step runbook with unified vars and deterministic dry-run"`。

### Task 4.11 回滚演练验证（本地可执行部分 + 全局完成门）

**Files:** Test `tools/reliable-drive-sync-mcp/test/v2-rollback-drill.test.mjs`、`services/reliable-drive-sync-worker/test/rds2-rollback-drill.test.js`
**Interfaces:** Consumes Task 4.1–4.6

- [ ] 1. 失败测试（四块，全部本地）：
  ```js
  test("writeVersion v2→v1 switch: v1 service unchanged and v2 rows untouched", async () => { /* 同进程两种 config 构造服务，互不读写对方库文件 */ });
  test("feature flags off: three v2 routes return 503 and v1 routes byte-identical", async () => { /* 快照断言 */ });
  test("outbox-v2 blocked rows survive mode switch and can be re-driven after re-enable", async () => { /* */ });
  test("wrangler dry-run passes with all flags absent (dark-deploy shape, deterministic outdir)", () => { /* execSync dry-run 退出码 0；断言后清理 tmp-dryrun */ });
  ```
- [ ] 2. 预期失败 → 按块修复（独立 commit 注明块名）。
- [ ] 3. `npm test` 双绿（子计划 4 本地完成门 = Rev 4 全局完成门的执行侧）。
- [ ] 4. 提交：`git add tools/reliable-drive-sync-mcp/test/v2-rollback-drill.test.mjs services/reliable-drive-sync-worker/test/rds2-rollback-drill.test.js && git commit -m "test(v2): local rollback drills"`。

## 覆盖与自检（子计划 4 完成门）

- [ ] 规格映射：§10.1 九步（4.6 逐条断言）、§10.2 targetRequestId（4.5/4.6）、§11 全条（4.3/4.4/4.7：状态流、canonical hash、available_at、confirmed 重放、AbortController、永久错误集合）、§15.1（4.6 根部预算器）、§16（4.8 十行）、§17（4.6 init fail-closed）、§19.2 十步（4.10）、§21.3 三状态（4.9）、§21.4 验收门 11/12/13/16。
- [ ] 全局自检执行并记录（详见主索引 §4）：①规格 §20/§21/§22 逐条映射见主索引矩阵；②`grep -rn "TODO\|TBD\|同上\|参考前文\|必要修复\|补全逻辑\|如有问题" docs/superpowers/plans/*rev4*.md src/ test/ ../tools/` 零命中；③`task_id`/`stale_projection_write`/`business_dedupe_key`/`namespace_not_enabled`/`canary_misconfigured` 跨文件命名一致（grep 核对）；④七入口预算证明齐（子计划 3 Task 3.6）；⑤Queue 无 message-ID 依赖（子计划 2 完成门）；⑥四 DLQ 消费者（子计划 2 Task 2.5）；⑦凭据身份（子计划 1 T1.9 + 子计划 4 T4.6 双核对）；⑧四域最小充分状态（子计划 2 T2.10–2.13）；⑨协议层 identity 无 displayName（envelope/toDomainEvent/示例路径零命中；`rds2_users.display_name` 用户表输入参数为合法领域字段，见子计划 1 T1.9）；⑩发布顺序与规格 §19.2 十步一致（Task 4.10 测试锁定）；⑪"本任务SHA/SHA/outdir" 三类尖括号占位符全仓零命中（Task 4.10 测试锁定）。
