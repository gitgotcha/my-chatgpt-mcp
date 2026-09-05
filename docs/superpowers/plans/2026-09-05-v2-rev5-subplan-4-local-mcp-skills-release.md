# RDS2 Local Outbox V2, Budgeted HTTP Routes, Skills Contract and Release Runbook Implementation Plan — Revision 5

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 Codex 四审意见 5/12/13：① 意见 5（§10/§17 协议兼容冲突）——T4.5 桥接集成测试的 `system.user.resolve` 样本 payload 从 `{username}` 改为 `{displayName}`（`protocol.js:36,404` registry 要求 `displayName` 且不允许任何其他字段，`payload.username` 必被 `invalid_payload` 拒绝，Rev 4 的正样本本身就是非法样本）；查询消息的校验边界显式化——事件 payload 注册表只约束 `/v2/events` 写入路径，`/v2/query` 查询消息经"外壳 + 身份 + 按 scope 的 payload 规则"校验（否则 §10.2 的 `payload.targetRequestId` 无处安放）；② 意见 12（§11/§10.1 本地 Outbox 运行时错误）——T4.3 `claimPending` 的 `this.db.transaction(...)` 改为显式 `exec("BEGIN IMMEDIATE")`/`exec("COMMIT")` + 异常 `exec("ROLLBACK")`（`node:sqlite` 的 `DatabaseSync` 没有 `.transaction()`，Node 22.22.2 实测 `typeof db.transaction === "undefined"`，Rev 4 实现首次调用即 TypeError）；`markSending` UPDATE 谓词补 `available_at <= now`（退避中的行不得被单行 submit 提前认领）；T4.4 退避表下标从 0 开始（Rev 4 `capBackoff(attempt_count)` 首档直接跳 60s）；`blocked` 行在 submit 返回 blocked 语义且不得出现在任何待发查询；本地回执不得预构造 `persistence.localOutbox:"acknowledged"`（该字段只允许 Worker 在 D1 原子提交后返回的 durable receipt 携带）；③ 意见 13（§19.2/§21 发布与自检可执行）——T4.10 runbook 的 PowerShell 脚本调用从 `node xxx.ps1` 改为 `powershell -File`/`pwsh -File`；发布前置显式补齐：创建四条 Cloudflare Queue（当前 `wrangler.toml` 无 `[[queues]]` 段，子计划 2 T2.5 才把配置块写入）、应用 V2 D1 迁移、确认 V2 恢复器 cron 与四队列配置块在位；删除与"空白名单 fail-closed 503"矛盾的"清空白名单"回滚表述，回滚语义统一为"恢复上一部署版本并关闭功能开关"。

**Architecture:** 本地状态流冻结 `pending → sending → confirmed | pending(backoff) | blocked` 不变；`claimPending` 在显式事务内逐行条件 UPDATE（`changes===1` 才进本批）；`markSending`/`claimPending` 的认领谓词统一为 `state='pending' AND (available_at IS NULL OR available_at <= now)`；退避序列 `[30s,60s,120s,300s,600s…]` 下标 = `attempt_count - 1`（认领时已递增，首次失败取第 0 档）。ingress 九步顺序（§10.1）不变，第 ⑨ 步唤醒从直连 `queueIo.sendWake` 改为 `dispatcher.run(receipt.taskId)`（意见 8 横切：接收唤醒、引擎续批唤醒、恢复器共用同一 Dispatcher 入口，任务行走完整状态机 `pending → dispatching → queued`）；唤醒失败不阻塞 receipt，恢复器兜底。

**Tech Stack:** Node ≥22、`node:sqlite`（outbox-v2）、既有 MCP stdio bridge 骨架、Node test runner、Cloudflare vars/secrets/queues。

**Spec:** 规格 Rev 5：§10.1（接收九步 + `persistence.localOutbox:"acknowledged"` 回执时机）、§10.2（targetRequestId 区分）、§11（本地 Outbox V2 全条，含 Rev 5 新增四条：显式事务、markSending 谓词、退避下标 0、blocked 排除）、§15.1（预算化封装）、§17（凭据身份 + 协议事实分层冻结）、§19.2（一次性前置 + 十步发布 + 统一回滚语义）、§21.4 验收门 11/12/13/16。

## Rev 5 关键修订表（意见 5/12/13 逐项）

| 意见 | 修订位置 | 具体失败样本 | 预期行为 |
|---|---|---|---|
| 5 | Task 4.5（桥接集成测试样本）+ Task 4.6（查询路由校验边界） | Rev 4 T4.5 `READ_CASES` 的 user resolve 条目为 `payload: { username: "乔炳源" }`——按子计划 1 Task 1.2 parity 锁（`protocol.js:36,404`），该 payload 缺 required `displayName` 且 `username` 不在允许集，共享校验器必抛 `invalid_payload`：**计划自带的正样本无法通过计划自带的校验器**。另：Rev 4 未说明查询消息的校验边界，若对 `payload:{domain, scope, targetRequestId}` 套用事件注册表，`scope`/`targetRequestId` 同样必被拒，§10.2 的事件状态查询将无可行的合法载体。 | ① user resolve 正样本改为 `payload: { displayName: "乔炳源" }`；增补负样本 `payload.username` → `invalid_payload` 的集成断言。② 查询消息校验边界显式化并测试锁定：`/v2/query` 走"外壳 + 身份 + 按 scope 的 payload 规则"，事件 payload 注册表只约束 `/v2/events`；同一 `scope:event_status` 消息发往 `/v2/events` 必须 400 `invalid_payload`，发往 `/v2/query` 必须按 scope 正确处理。 |
| 12 | Task 4.3（local-outbox-v2 显式事务 + 认领谓词）+ Task 4.4（退避下标 + blocked 语义 + 回执时机） | ① Rev 4 T4.3 `claimPending` 调用 `this.db.transaction(() => {...})()`——Node 22.22.2 实测 `typeof new DatabaseSync(":memory:").transaction === "undefined"`，首次 flush 即 `TypeError: this.db.transaction is not a function`，批量路径整体瘫痪。② Rev 4 `markSending` 谓词只有 `state='pending'`：对 `available_at = now+60s` 的退避中行，单行 submit 路径直接认领并立即发送，退避门槛形同虚设。③ Rev 4 `capBackoff(row.attempt_count)`：认领后 `attempt_count=1`，首次失败取 `BACKOFF_MS[1]=60_000`——首档 30s 永远不会被使用。④ Rev 4 `submit()` 对 `blocked` 行：`flushOne` 返回 null 后落入 `{status:"pending"}` 分支——已永久阻塞的行被谎报为待发。⑤ Rev 4 无测试阻止本地构造含 `persistence.localOutbox:"acknowledged"` 的对象。 | ① 多写操作用显式 `exec("BEGIN IMMEDIATE")` → 全部成功 `exec("COMMIT")` → 任一异常 `exec("ROLLBACK")` 后上抛；环境锁测试断言 `typeof db.transaction === "undefined"`。② `markSending`/`claimPending` 认领谓词统一含 `state='pending' AND (available_at IS NULL OR available_at <= now)`，以 `changes===1` 为认领成功，未认领成功本次 flush 零网络。③ `capBackoff(attempt_count - 1)`：首次失败取第 0 档 30s，增量序列 `[30s,60s,120s,300s,600s,600s…]` 逐次断言。④ `submit()` 对 `blocked` 行返回 `{status:"blocked", errorCode}` 且零网络；`blocked` 行不得出现在 claimPending/任何待发查询结果中。⑤ 本地 pending 回执对象 JSON 不含 `"acknowledged"`；`confirm()` 逐字节持久化 Worker durable receipt（回执时机由 §10.1 锁定）。 |
| 13 | Task 4.10（runbook 与配置一致性测试） | ① Rev 4 runbook 附录写 `node C:\...\setup-local-clients.ps1`——该文件是 PowerShell 脚本（`param(...)` 块，`tools/reliable-drive-sync-mcp/setup-local-clients.ps1:1-7`），node 解释器无法执行，发布时插件重装步骤直接失败。② 当前 `wrangler.toml` 无 `[[queues]]` 段（全文 18 行，仅 vars/d1/crons），Rev 4 runbook 十步从"本地测试"直接跳到"暗部署"——`wrangler deploy` 时四条 Queue（`rds2-project`/`rds2-archive` 及各自 DLQ）在账号内不存在、V2 D1 迁移未应用、V2 恢复器 cron 未启用，暗部署后即卡死。③ Rev 4 步 6/7 回滚列写"清空白名单"/"清空白名单恢复 algorithm-only"——T4.6 的 canary fail-closed 语义下，显式配置空串即全 namespace 503 `canary_misconfigured`，"清空白名单"不是回滚而是制造全量故障。 | ① 附录改为 `powershell -File <绝对路径>`（或 `pwsh -File`），runbook 测试静态断言 `/node\s+\S*\.ps1/` 零命中。② runbook 新增"第 0 节 一次性前置"，逐条可执行：四条 `npx wrangler queues create`（队列名与子计划 2 T2.5 TOML 逐字一致）、`npx wrangler d1 migrations apply reliable-drive-sync --remote`、核对 `wrangler.toml` 已含 `[[queues]]` 块与 V2 cron `2-57/5 * * * *`（子计划 2 T2.4/T2.5 产物）。③ 回滚列统一为"恢复上一部署版本（`npx wrangler rollback`）并关闭功能开关"，"清空白名单"字样全文零命中（测试锁定）。 |

## 任务处置总表（Rev 4 → Rev 5）

| Task | 处置 | 理由 |
|---|---|---|
| 4.1 环境变量分流 | 逐字继承 Rev 4 | 意见 5/12/13 不涉及 |
| 4.2 读写分流契约 | 逐字继承 Rev 4 | 五类只读集合与 dry-run 特例不变 |
| 4.3 local-outbox-v2 | **整体替换** | 意见 12①②④：显式事务、available_at 谓词、blocked 排除 |
| 4.4 delivery-service-v2 | **整体替换** | 意见 12③④⑤：退避下标 0、blocked 语义、回执时机 |
| 4.5 桥接五类读集成测试 | **整体替换** | 意见 5：displayName 正样本 + username 负样本 + 查询消息边界 |
| 4.6 Worker 三路由 | **整体替换** | 意见 8 横切（唤醒经 `dispatcher.run`）+ 意见 5 查询边界 + 预算注释重算 7≤10 |
| 4.7 本地 Outbox 故障语义套件 | 适配继承 | 五块保留；backoff 块断言序列改为 30s 起，blocked 块增补"不出现在待发查询" |
| 4.8 Worker 端到端混沌 | 逐字继承 Rev 4 | 意见 5/12/13 不改 §16 十行语义 |
| 4.9 Skills 契约盘点 | 逐字继承 Rev 4 | 意见 5/12/13 不涉及 |
| 4.10 runbook | **整体替换** | 意见 13①②③：解释器、前置步骤、白名单矛盾 |
| 4.11 回滚演练 | 逐字继承 Rev 4 | 意见 5/12/13 不涉及 |

## Global Constraints

- 前置门 G0 与提交规范同主索引；受保护路径同子计划 1（`stdio-bridge.mjs` 仅按 Task 4.1/4.4 的明确 diff 修改 `configurationFromEnvironment()` 与 `createService()` 构造分支；`delivery-service.mjs` 与 `local-outbox.mjs` 不改，仅作 V1 黑盒参照）。
- Skills 仓库路径固定：`C:\Users\27846\my-chatgpt-skills`；只允许修改 Task 4.9 列出的文件。
- **协议事实分层强制（意见 5）**：envelope `identity` 仅 `userId/username`，不存在 `identity.displayName`；`system.user.resolve` payload = `{displayName}` 且不允许任何其他字段（`protocol.js:36,404`）；测试构造的 envelope payload 形状以 `shared/rds2-protocol.mjs` 的 `PAYLOAD_REGISTRY`（子计划 1 Task 1.2）为准；**查询消息（`/v2/query` 请求体）不适用事件 payload 注册表**，其校验规则由 Task 4.6 按 scope 显式定义——两个路径各有测试锁定，禁止互相套用。
- 混沌与路由测试全部本地；runbook 中任何远程命令（部署、迁移、Queue 创建、开关变更）仅作为文档内容，执行需乔炳源逐阶段授权。
- **预算化强制**：三个 V2 HTTP handler 内禁止裸 `env.DB`（一律 `budgetD1(env.DB, budget)`）与裸 `fetch`；静态测试锁定（Task 4.6）。
- **唤醒路径强制（意见 8 横切）**：Worker 侧任何 Queue 发送必须经 `createDispatcher(...).run(taskId)`（子计划 2 Task 2.3）；`http-ingress.js` 禁止出现 `sendWake` 直接调用（静态断言锁定，与子计划 2 完成门 grep 互证）。
- 所有测试命令在 worktree `C:\Users\27846\my-chatgpt-mcp-v2` 执行；每 Task 结束 `git status --short` 只允许出现该 Task 文件清单。
- 提交规范：`git add` 只加本 Task 文件；消息前缀 `feat(v2):`/`test(v2):`/`fix(v2):`/`docs(v2):`；禁止 `git add -A`、`reset --hard`、`checkout --`、`stash drop`。
- 每 Task 回滚：`git revert <task_sha>`；Skills 仓库侧为在其自身 git 仓库 revert。

## Interfaces

- **Consumes**：子计划 1 `shared/rds2-protocol.mjs`（`canonicalJson/sha256Hex/validateEnvelope/normalizeUsername`）、accept-service、identity-init、credential-auth、`createOutboxRepository(db)`（Task 1.11）；子计划 2 `createDispatcher({outbox, queueIo})` → `{run(taskId)}`（Task 2.3）、`createQueueIo(budget, bindings)`（Task 2.2）；子计划 3 `budgeted-io` + `metrics`；`delivery-service.mjs` 的 `READ_ONLY_EVENTS` 行为（黑盒参照）。
- **Produces**：`tools/reliable-drive-sync-mcp/read-write-split.mjs` 导出 `READ_ONLY_EVENT_TYPES`、`isReadOnlyEnvelope`；`local-outbox-v2.mjs` 导出 `LocalOutboxV2`；`delivery-service-v2.mjs` 导出 `DeliveryServiceV2`；Worker `src/rds2/http-ingress.js` 导出 `handleV2Events(buildDeps)`；`src/rds2/http-query.js` 导出 `handleV2Query(buildDeps)`；`src/rds2/http-identity-init.js` 导出 `handleV2UsersInit(buildDeps)`；`docs/superpowers/plans/v2-release-runbook.md`。

---

### Task 4.1 环境变量分流（进程级，envelope 不变）——逐字继承 Rev 4

- [ ] 逐字继承 Rev 4 Task 4.1 全部步骤（`configurationFromEnvironmentForTest` 纯函数导出、`RELIABLE_DRIVE_SYNC_WRITE_VERSION` 三态校验、v2 默认 `outbox-v2.sqlite` 派生、`RELIABLE_DRIVE_SYNC_OUTBOX_PATH` 单变量覆盖两模式、`createService()` v2 分支先抛 `v2_delivery_not_wired`、v1 默认路径逐字节不变）。
- [ ] 提交消息不变：`feat(v2): env-based local write version switching`。

### Task 4.2 读写分流契约（READ_ONLY_EVENTS 对齐）——逐字继承 Rev 4

- [ ] 逐字继承 Rev 4 Task 4.2 全部步骤（五类只读集合排序断言、dry-run 只读 / apply 写、V1 `handleRequest` 黑盒 parity）。
- [ ] 提交消息不变：`feat(v2): read write split contract with v1 parity`。

### Task 4.3 local-outbox-v2 重写（canonical fingerprint + available_at + 显式事务原子认领 + confirmed 重放）——整体替换

**Files:** Create `tools/reliable-drive-sync-mcp/local-outbox-v2.mjs`；Test `tools/reliable-drive-sync-mcp/test/v2-local-outbox.test.mjs`
**Interfaces:** Produces `LocalOutboxV2` | Consumes `shared/rds2-protocol.mjs`（`canonicalJson/sha256Hex`）、`node:sqlite`
**规格依据（§11）:** fingerprint = 完整 envelope 的 canonical JSON SHA-256；状态流 `pending→sending→confirmed|pending(backoff)|blocked`；`available_at` 退避门槛；**多写操作显式事务（`exec("BEGIN IMMEDIATE")`/`COMMIT`/异常 `ROLLBACK`），`node:sqlite` 无 `.transaction()`**；**认领谓词同时含 `state='pending'` 与 `available_at <= now`**；**`blocked` 行不得出现在任何待发查询结果中**；单批 ≤20；confirm 清 payload 留最小 receipt。
**意见 12 修订：** ① Rev 4 `claimPending` 的 `this.db.transaction(() => {...})()` 替换为显式 exec 事务（Node 22.22.2 实测 `typeof db.transaction === "undefined"`，原实现首次调用即 TypeError）；② `markSending` 谓词补 `(available_at IS NULL OR available_at <= ?)`；③ 新增环境锁与 blocked 排除测试。

- [ ] 1. 失败测试：
  ```js
  import { canonicalJson } from "../../../shared/rds2-protocol.mjs";
  import { DatabaseSync } from "node:sqlite";
  test("environment lock: node:sqlite DatabaseSync has no .transaction() (意见12①)", () => {
    const db = new DatabaseSync(":memory:");
    assert.equal(typeof db.transaction, "undefined");   // Node 22/26 均实测；防 better-sqlite3 习惯回潮
    db.close();
  });
  test("schema has fingerprint/available_at and state check covers exactly four states", async () => {
    // 同 Rev 4：十列齐 + CHECK 拒绝第五态
  });
  test("fingerprint is sha256 of canonicalJson over the FULL envelope (identity/eventKey included)", async () => {
    // 同 Rev 4：键序不同的同一 envelope → 单行重用
  });
  test("enqueue reuses row for same request_id and same input; rejects different input", async () => {
    // 同 Rev 4：同输入重用；不同输入 request_id_conflict
  });
  test("claimPending runs inside an explicit BEGIN IMMEDIATE/COMMIT transaction (意见12①)", async () => {
    // spy db.exec：claimPending 一次调用期间 exec 调用序列以 "BEGIN IMMEDIATE" 开始、"COMMIT" 结束
    // 三行 due → 全部认领；断言行状态在 COMMIT 前已对本连接可见（同事务内）
  });
  test("claimPending rolls back on mid-loop failure leaving all rows pending (意见12①)", async () => {
    // monkeypatch db.prepare：第二行 UPDATE 时抛注入错误
    // → exec 收到 "ROLLBACK"；两行均保持 state='pending'、attempt_count 不变；异常上抛
  });
  test("claimPending is atomic: row whose conditional markSending fails is skipped, not sent", async () => {
    // 同 Rev 4：注入 changes=0 → 该行不进本批、flush 零网络
  });
  test("available_at gates claiming; due rows are claimed", async () => {
    // 同 Rev 4：now+60s / NULL / now-1s 三行 → 只含后两行
  });
  test("markSending rejects rows whose available_at is in the future (意见12②)", async () => {
    // 行 A requeue 后 available_at = now+60s（退避中）
    // → markSending("A") 返回 false（谓词含 available_at <= now）；行保持 pending
    // → flushOne("A") 零网络调用（未认领成功不得发送）
  });
  test("blocked rows never appear in due queries (意见12④)", async () => {
    // 预置 blocked 行（available_at = 过去时刻，确保不是被 available_at 挡下）
    // → claimPending 结果为空；直接 SELECT 待发谓词（state='pending' AND (available_at IS NULL OR available_at <= now)）零命中
  });
  test("restart recovers sending to pending (available_at cleared = immediately due)", async () => { /* 同 Rev 4 */ });
  test("flushPending takes at most 20 due rows", async () => { /* 同 Rev 4：25 行 → 20 */ });
  test("confirm clears payload but keeps minimal receipt", async () => { /* 同 Rev 4 */ });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（核心 SQL；与 Rev 4 差异处为显式事务与 markSending 谓词）：
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
    async enqueue(envelope) { /* 同 Rev 4：fingerprint 全 envelope canonical；同 requestId 同指纹重用、异指纹 request_id_conflict */ }
    claimPending(limit = 20, now = new Date().toISOString()) {
      this.db.exec("BEGIN IMMEDIATE");                 // 意见12①：显式事务（无 .transaction() 可用）
      try {
        const due = this.db.prepare(`SELECT request_id FROM local_outbox_v2
          WHERE state='pending' AND (available_at IS NULL OR available_at <= ?) ORDER BY created_at LIMIT ?`).all(now, limit);
        const claimed = [];
        for (const row of due) {
          const res = this.db.prepare(`UPDATE local_outbox_v2 SET state='sending', attempt_count=attempt_count+1, updated_at=?
            WHERE request_id=? AND state='pending'`).run(now, row.request_id);
          if (res.changes === 1) claimed.push(row.request_id);   // 条件转移未成功 → 不进本批，不发送
        }
        this.db.exec("COMMIT");
        return claimed;
      } catch (cause) {
        this.db.exec("ROLLBACK");                      // 任一异常整体回滚后上抛
        throw cause;
      }
    }
    markSending(requestId, now = new Date().toISOString()) {
      const res = this.db.prepare(`UPDATE local_outbox_v2 SET state='sending', attempt_count=attempt_count+1, updated_at=?
        WHERE request_id=? AND state='pending' AND (available_at IS NULL OR available_at <= ?)`).run(now, requestId, now);   // 意见12②：退避中行不得被认领
      return res.changes === 1;
    }
    block(requestId, code) { /* 同 Rev 4 */ }
    requeue(requestId, code, backoffMs, now = Date.now()) { /* 同 Rev 4：available_at = now+backoffMs */ }
    confirm(requestId, receipt) { /* 同 Rev 4：state='confirmed'、payload_json=NULL、last_receipt_json=Worker 回执原文 */ }
    recoverSending() { /* 同 Rev 4 */ }
    byRequestId(requestId) { /* SELECT * WHERE request_id=? */ }
    columns(table) { return this.db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name); }
  }
  ```
- [ ] 4. `npm run test:bridge` 预期 `# fail 0`。
- [ ] 5. 提交：`git add tools/reliable-drive-sync-mcp/local-outbox-v2.mjs tools/reliable-drive-sync-mcp/test/v2-local-outbox.test.mjs && git commit -m "feat(v2): local outbox v2 with explicit transactions and due-gated claiming"`。

### Task 4.4 delivery-service-v2 重写（超时中止 + 永久错误集合 + 退避下标 0 + blocked 语义 + 回执时机）——整体替换

**Files:** Create `tools/reliable-drive-sync-mcp/delivery-service-v2.mjs`；Modify `tools/reliable-drive-sync-mcp/stdio-bridge.mjs`（仅 `createService()` 的 v2 分支）；Test `tools/reliable-drive-sync-mcp/test/v2-delivery-service.test.mjs`
**Interfaces:** Produces `DeliveryServiceV2` | Consumes Task 4.2/4.3、`shared/rds2-protocol.mjs`
**规格依据（§11 + §10.1）:** 永久错误直接 blocked（400/401/403/409 与协议错误码集合）；临时 = 超时/网络错误/5xx/429/503 → 退避；confirmed 重放零网络；三个 ID 每次重试原样；**退避表下标从 0 开始（首档 30s）**；**blocked 行返回 blocked 语义不重试**；**`persistence.localOutbox:"acknowledged"` 只允许出现在 Worker durable receipt 中，本地发送前不得预构造**。
**意见 12 修订：** ① Rev 4 `capBackoff(row.attempt_count)` → `capBackoff(row.attempt_count - 1)`（认领时已递增，Rev 4 首档直接跳 60s）；② `submit()` 对 `blocked` 行显式返回 blocked 语义（Rev 4 落入 `{status:"pending"}` 谎报分支）；③ 新增回执时机锁测试。

- [ ] 1. 失败测试：
  ```js
  test("write requests persist locally before any network call", async () => { /* 同 Rev 4 */ });
  test("confirmed row replay returns local receipt with zero network", async () => { /* 同 Rev 4 */ });
  test("read requests go to /v2/query and never touch outbox", async () => { /* 同 Rev 4 */ });
  test("permanent error codes block immediately and are never retried by sweeps", async () => { /* 同 Rev 4：七码逐一 */ });
  test("http status 400/401/403/409 blocks even with unknown body code", async () => { /* 同 Rev 4 */ });
  test("timeout aborts at 30s and requeues as temporary", async () => { /* 同 Rev 4：注入假计时 */ });
  test("backoff index starts at 0: first failure waits 30s, never 60s (意见12③)", async () => {
    // 首次失败（attempt_count 认领后为 1）→ available_at - requeue 时刻 === 30_000
    // 连续 6 次失败 → 增量序列逐次断言 [30_000, 60_000, 120_000, 300_000, 600_000, 600_000]
    // （Rev 4 的 capBackoff(attempt_count) 使首次增量为 60_000，本测试对其失败）
  });
  test("blocked row submit returns blocked semantics with zero network (意见12④)", async () => {
    // 预置 blocked 行（last_error_code='event_id_conflict'）→ submit 同 envelope
    // → 返回 {status:"blocked", errorCode:"event_id_conflict"}；fetch 计数 0；行保持 blocked
    // （Rev 4 落入 {status:"pending"} 分支，本测试对其失败）
  });
  test("local pending receipt never carries persistence.localOutbox acknowledged (意见12⑤)", async () => {
    // 假服务端挂起（flushOne 超时重排）→ submit 返回兜底对象
    // → JSON.stringify(兜底对象) 不含 "acknowledged"、不含 "persistence"
    // confirm 成功后：last_receipt_json 与 Worker 返回体逐字节相等（Worker durable receipt 原文落库）
  });
  test("lost response after d1 commit: same three ids retry returns original receipt then confirms", async () => { /* 同 Rev 4 */ });
  test("batch flush does not re-markSending rows it already claimed", async () => { /* 同 Rev 4 */ });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（与 Rev 4 差异处：退避下标、blocked 两处分支、兜底回执；`createService()` 接线同 Rev 4）：
  ```js
  import { isReadOnlyEnvelope } from "./read-write-split.mjs";
  const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
  const capBackoff = (attemptIndex) => BACKOFF_MS[Math.min(Math.max(attemptIndex, 0), BACKOFF_MS.length - 1)]; // 意见12③：下标从 0
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
      if (row.state === "blocked")                                // 意见12④：blocked 语义不重试
        return { status: "blocked", requestId: row.request_id, errorCode: row.last_error_code };
      await this.flushOne(row.request_id);                        // 单行路径：自行 markSending（available_at 谓词在 Task 4.3）
      const after = this.outbox.byRequestId(row.request_id);
      if (after.state === "confirmed") return JSON.parse(after.last_receipt_json);
      if (after.state === "blocked")
        return { status: "blocked", requestId: after.request_id, errorCode: after.last_error_code };
      return { status: "pending", requestId: row.request_id };    // 意见12⑤：本地兜底回执不得含 persistence/acknowledged
    }
    async query(envelope) { /* 同 Rev 4：POST /v2/query + AbortSignal.timeout(30_000) + 非 ok 抛 body.error */ }
    async flushOne(requestId, { alreadySending = false } = {}) {
      let row = this.outbox.byRequestId(requestId);
      if (!row || row.state === "confirmed" || row.state === "blocked") return null;   // blocked 不进入任何重试
      if (!alreadySending && !this.outbox.markSending(requestId)) return null;         // 未认领成功不得发送（含 available_at 门槛）
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
          this.outbox.confirm(requestId, body);                    // Worker durable receipt 原文落库（含 persistence.localOutbox）
          return body;
        }
        if (PERMANENT.has(body?.error) || PERMANENT_STATUS.has(response.status)) {
          this.outbox.block(requestId, body?.error ?? `http_${response.status}`);
          return { status: "blocked", errorCode: body?.error ?? `http_${response.status}` };
        }
        this.outbox.requeue(requestId, body?.error ?? `http_${response.status}`, capBackoff(row.attempt_count - 1)); // 意见12③
        return { status: "pending" };
      } catch (cause) {                                            // 超时/网络错误 = 临时
        this.outbox.requeue(requestId, cause?.name === "TimeoutError" ? "timeout" : "network_error", capBackoff(row.attempt_count - 1));
        return { status: "pending" };
      }
    }
    async flushPending() {
      const ids = this.outbox.claimPending(20);                    // 批量路径：认领即 sending（显式事务内）
      for (const id of ids) await this.flushOne(id, { alreadySending: true });
      return ids.length;
    }
  }
  ```
- [ ] 4. `npm run test:bridge` 预期 `# fail 0`。
- [ ] 5. 提交：`git add tools/reliable-drive-sync-mcp/delivery-service-v2.mjs tools/reliable-drive-sync-mcp/stdio-bridge.mjs tools/reliable-drive-sync-mcp/test/v2-delivery-service.test.mjs && git commit -m "feat(v2): delivery service v2 with zero-based backoff and blocked semantics"`。

### Task 4.5 Bridge 五类读 + 写路径集成测试（displayName 契约 + 查询消息边界）——整体替换

**Files:** Test `tools/reliable-drive-sync-mcp/test/v2-bridge-integration.test.mjs`
**Interfaces:** Consumes Task 4.1–4.4（经真实 `handleRequest` + 注入 fetch）
**意见 5 修订：** ① user resolve 正样本 payload 从 `{username}` 改为 `{displayName}`（Rev 4 样本必被共享校验器 `invalid_payload` 拒绝）；② 新增 username 负样本集成断言；③ 事件状态查询消息的校验边界在样本注释与 Task 4.6 测试中显式锁定。

- [ ] 1. 失败测试（七块 + 意见 5 两块）：
  ```js
  const READ_CASES = [
    ["capabilities read",  { schemaVersion: "1.2", namespace: "system", eventType: "system.capabilities.read", requestId: "r-cap", identity: IDENTITY, payload: {} }],
    ["user resolve",       { schemaVersion: "1.2", namespace: "system", eventType: "system.user.resolve", requestId: "r-ur", identity: IDENTITY, payload: { displayName: "乔炳源" } }],   // 意见5：displayName，protocol.js:36
    ["profile snapshot",   { schemaVersion: "1.2", namespace: "profile", eventType: "profile.snapshot.read", requestId: "r-ps", identity: IDENTITY, payload: { domain: "backend" } }],
    ["session list",       { schemaVersion: "1.2", namespace: "interview", eventType: "interview.session.list", requestId: "r-sl", identity: IDENTITY, payload: {} }],
    ["session load",       { schemaVersion: "1.2", namespace: "interview", eventType: "interview.session.load", requestId: "r-ld", identity: IDENTITY, payload: { sessionId: "s1" } }]
  ];
  // IDENTITY = { userId: "u-1", username: "乔炳源" }——identity 仅 userId/username（protocol.js:28），无 displayName
  // payload 形状以 shared/rds2-protocol.mjs PAYLOAD_REGISTRY 为准（子计划 1 Task 1.2）
  for (const [name, envelope] of READ_CASES) {
    test(`${name} goes to /v2/query and creates no outbox row under writeVersion=v2`, async () => { /* 同 Rev 4 */ });
  }
  test("意见5：user resolve with payload.username is rejected as invalid_payload end-to-end", async () => {
    // envelope = user resolve + payload { username: "乔炳源" }（Rev 4 的错误样本形态）
    // 假服务端按共享校验器语义应答 400 { error: "invalid_payload" }
    // → query() 抛出 /invalid_payload/；断言发往 /v2/query 的样本确实会被服务端按 registry 拒绝
    // （与共享校验器 parity：子计划 1 Task 1.2 已锁 {username} → invalid_payload，此块锁端到端表现）
  });
  test("意见5：identity never carries displayName in any read case on the wire", async () => {
    // 五类读实际发往 /v2/query 的 body：identity 键集合 deepEqual ["userId","username"]（无 displayName）
  });
  test("event status read uses payload.targetRequestId, never reuse of the request's own requestId", async () => { /* 同 Rev 4 */ });
  test("write under writeVersion=v2 persists locally before POST /v2/events", async () => { /* 同 Rev 4 */ });
  test("reads never produce business events on the wire", async () => { /* 同 Rev 4 */ });
  ```
  `event status` 读的查询消息形态冻结为：`{schemaVersion:"1.2", namespace:"profile", eventType:"profile.snapshot.read", requestId:"q-1", identity, payload:{ domain:"backend", scope:"event_status", targetRequestId:"r-1" }}`——**该消息只发往 `/v2/query`，是查询消息不是事件**：`/v2/query` 按 Task 4.6 的 scope 规则校验（外壳 + 身份 + event_status 分支要求 `targetRequestId`/`targetEventId` 恰居其一），事件 payload 注册表只约束 `/v2/events` 写入路径（同一消息发往 `/v2/events` 必须 400 `invalid_payload`，由 Task 4.6 测试锁定）。此边界使 §10.2 的 `payload.targetRequestId` 与意见 5 的注册表冻结同时成立。
- [ ] 2. 预期失败：路由未分流、Outbox 误建行、或样本被校验器拒绝。
- [ ] 3. 修复落点：`delivery-service-v2.submit` 的读分支与样本本身（不得改 `stdio-bridge.mjs` 以外的 V1 文件）。
- [ ] 4. `npm run test:bridge` 预期 `# fail 0`。
- [ ] 5. 提交：`git add tools/reliable-drive-sync-mcp/test/v2-bridge-integration.test.mjs && git commit -m "test(v2): bridge read write integration with displayName and query message boundary"`。

### Task 4.6 Worker 三路由重写：鉴权先行 + 实际字节 413 + 身份双核对 + 根部预算器 + 唤醒经 Dispatcher + 独立开关——整体替换

**Files:** Create `src/rds2/http-ingress.js`、`src/rds2/http-query.js`、`src/rds2/http-identity-init.js`；Modify `src/index.js`（fetch 路由追加三行 + 装配）；Test `test/rds2-http-ingress.test.js`、`test/rds2-http-query.test.js`、`test/rds2-http-identity-init.test.js`、`test/worker-routes.test.js`（追加分开关断言）
**Interfaces:** Consumes 子计划 1 服务层 + `createOutboxRepository`（Task 1.11）、子计划 2 `createDispatcher`（Task 2.3）/ `createQueueIo`（Task 2.2）、子计划 3 `budgetD1/metrics` + 子计划 2 `createSubrequestBudget`
**规格依据（§10.1 九步 + §10.2 + Codex P0-11）:** ①鉴权先行（未鉴权不读业务体）②Content-Length 预检 + 实际字节复核 413 ③完整校验 ④身份双核对（userId + 规范化 username 对 `name_key`）⑤哈希 ⑥七矩阵 ⑦原子插入 ⑧receipt ⑨**唤醒经 Dispatcher 认领后发布，失败不阻塞 receipt（恢复器兜底）**。canary 显式配置为空 = fail-closed。`RDS2_INIT_ENABLED` 独立门控 init 路由。
**意见 8 横切修订：** Rev 4 第 ⑨ 步 `buildQueueIo(env, budget).sendWake(receipt.taskId, "project_event", 0)` 绕过 Outbox 状态机（任务行停留 `pending`，等恢复器兜底，且与子计划 2 "禁止绕过 Dispatcher" 的全局约束冲突）；改为 `createDispatcher({ outbox, queueIo }).run(receipt.taskId)`——任务行走完整 `pending → dispatching → queued`。
**意见 5 修订：** `handleV2Query` 的校验边界显式化——查询消息不套用事件 payload 注册表（外壳/namespace/eventType 白名单/identity 形状复用共享模块的对应检查；payload 按 scope 分支规则校验）。

- [ ] 1. 失败测试（ingress，九步逐条）：
  ```js
  test("step1: unauthenticated request never reads business body", async () => { /* 同 Rev 4 */ });
  test("step2: declared Content-Length > 1MiB -> 413 without reading; actual bytes > 1MiB -> 413", async () => { /* 同 Rev 4 */ });
  test("step4: identity userId mismatch -> 403; normalized username != name_key -> 403", async () => { /* 同 Rev 4 */ });
  test("canary fail-closed: explicitly empty allowlist rejects; unset passes under EVENTS gate", async () => { /* 同 Rev 4 */ });
  test("admin token cannot call ingress (permission separation)", async () => { /* 同 Rev 4 */ });
  test("意见8：accepted response is the durable receipt and the wake walks the dispatcher state machine", async () => {
    // 合法事件 → 200 receipt（含 persistence.localOutbox:"acknowledged"，Worker D1 原子提交后返回）
    // 断言 outbox 任务行 state='queued'、queued_at 非空、queue_message_id IS NULL（不是停留 pending 等恢复器）
    // 假 queue binding send 计数恰 1；行 lease_owner 已清空
    // （Rev 4 直连 sendWake 时行保持 pending，本测试对其失败）
  });
  test("queue publish failure still returns accepted and the task is requeued by failWithBackoff", async () => {
    // send 抛错 → 200 receipt 不变；任务行 state='pending'、available_at > now、last_error_code='queue_send_failed'
    // （意见 8：阈值接线在 dispatcher 内——attempt_count=4 预置行再失败即 needs_attention，由子计划 2 T2.3 锁定，此处只证不阻塞 receipt）
  });
  test("route handler uses budgetD1 only and never calls sendWake directly (static)", () => {
    const src = readFileSync(new URL("../src/rds2/http-ingress.js", import.meta.url), "utf8");
    assert.ok(!src.includes("env.DB"));
    assert.ok(src.includes("budgetD1"));
    assert.ok(!src.includes("sendWake"), "wake must go through dispatcher.run (意见8)");
    assert.ok(src.includes("dispatcher.run"));
  });
  test("ingress worst case within budget 10 with dispatcher-run wake", async () => {
    // 鉴权 1 + 三查询 1 + 接收 batch 1 + 回读 1 + dispatcher.run(claimOne 1 + send 1 queue + markQueued 1)
    // = d1 6 + queue 1 = 7 ≤ 10（snapshotByCategory() 合计断言；与子计划 3 Task 3.6 入口证明互证）
  });
  ```
- [ ] 2. 失败测试（query，含意见 5 边界锁定）：
  ```js
  test("projection read is identity-bound to the credential user", async () => { /* 同 Rev 4 */ });
  test("event_status resolves by payload.targetRequestId and only returns rows owned by the credential user", async () => { /* 同 Rev 4 */ });
  test("RDS2_READS_ENABLED gate + admin token cannot read projections", async () => { /* 同 Rev 4 */ });
  test("意见5：event_status query message is validated by scope rules, not the event payload registry", async () => {
    // 同一消息体 {eventType:"profile.snapshot.read", payload:{domain, scope:"event_status", targetRequestId}}
    // → POST /v2/query：按 scope 规则受理（200 或 404 event_not_found，不是 invalid_payload）
    // → POST /v2/events（开关开、身份合法）：400 invalid_payload（scope/targetRequestId 不在注册表允许集）
  });
  test("意见5：event_status requires exactly one of targetRequestId/targetEventId", async () => {
    // 两者同现 → 400 invalid_query；两者皆缺 → 400 invalid_query
  });
  ```
- [ ] 3. 失败测试（identity-init）：同 Rev 4（`RDS2_INIT_ENABLED !== "true"` → 503 `rds2_disabled` 独立开关；admin token 错误 → 403；成功 → 201 + 一次性凭据；普通凭据 → 401；`expectedAdminToken` 注入比较，未配置 fail-closed 403）。
- [ ] 4. 失败测试（routes/开关全闭）：同 Rev 4（三 v2 路由 503 + V1 路由快照不变）。
- [ ] 5. 预期失败：404（路由不存在）。
- [ ] 6. 实现（三文件 + index.js 追加；与 Rev 4 差异：第 ⑨ 步唤醒与 query 校验边界）：
  ```js
  // src/rds2/http-ingress.js（顺序 = 规格 §10.1 九步）
  export function handleV2Events(buildDeps) {
    return async function (request, env) {
      if (env.RDS2_EVENTS_ENABLED !== "true") return json(503, { error: "rds2_disabled" });
      const budget = createSubrequestBudget({ limit: 10 });            // 入口根部单预算器（最坏 7 ≤ 10，见测试）
      const db = budgetD1(env.DB, budget);                             // 全依赖预算化
      let user;                                                        // ① 鉴权先行
      try { user = await authenticateUser(db, request.headers.get("authorization") ?? ""); }
      catch { return json(401, { error: "unauthorized" }); }
      // ② 大小双检、③ 解析与完整校验、④ 身份双核对、canary fail-closed（均同 Rev 4，逐行保留）
      try {
        const receipt = await createAcceptService(db, buildDeps(env))(envelope, user);   // ⑤-⑧
        try {
          const dispatcher = createDispatcher({                        // ⑨ 意见8：唤醒经 Dispatcher 状态机
            outbox: createOutboxRepository(db),                        //     复用同一预算化 db（claimOne/markQueued 计入预算）
            queueIo: createQueueIo(budget, env)
          });
          await dispatcher.run(receipt.taskId);
        } catch { /* 唤醒失败不阻塞 receipt，恢复器兜底 */ }
        emitBudgetSnapshot(budget, "ingress");
        return json(200, receipt);
      } catch (cause) {
        return json(errorStatus(cause), { error: cause.code ?? cause.message });
      }
    };
  }
  ```
  `handleV2Query`（`RDS2_READS_ENABLED` 门 → 鉴权 → 外壳/namespace/eventType 白名单/identity 形状检查（复用共享模块对应规则）→ scope 分支：无 `scope` = 投影读（payload 按该 eventType 注册表形状校验，如 `profile.snapshot.read` = `{domain, userId?, username?}`）；`scope === "event_status"` = 事件状态查（payload 要求 `targetRequestId`/`targetEventId` 恰居其一且为非空字符串，其余键拒绝 `invalid_query`）→ 凭据 user 绑定，仅本用户数据）；`handleV2UsersInit` 同 Rev 4；`index.js` fetch 追加三行路由。
- [ ] 7. `npm run test:worker` 预期 `# fail 0`。
- [ ] 8. 提交：`git add services/reliable-drive-sync-worker/src/rds2/http-ingress.js services/reliable-drive-sync-worker/src/rds2/http-query.js services/reliable-drive-sync-worker/src/rds2/http-identity-init.js services/reliable-drive-sync-worker/src/index.js services/reliable-drive-sync-worker/test/rds2-http-ingress.test.js services/reliable-drive-sync-worker/test/rds2-http-query.test.js services/reliable-drive-sync-worker/test/rds2-http-identity-init.test.js services/reliable-drive-sync-worker/test/worker-routes.test.js && git commit -m "feat(v2): auth-first budgeted v2 routes with dispatcher-run wake and query scope validation"`。

### Task 4.7 本地 Outbox 故障语义套件（重启/超时/退避/阻塞/重放）——适配继承

**Files:** Test `tools/reliable-drive-sync-mcp/test/v2-outbox-chaos.test.mjs`
**Interfaces:** Consumes Task 4.3/4.4
**规格依据（§21.4 验收门 11）:** 本地 Outbox 重启/超时/退避/阻塞/重放五语义逐一证明。
**意见 12 适配：** backoff 块断言序列从"封顶 600s"细化为"首档 30s 起的完整序列"；blocked 块增补"不出现在任何待发查询"断言。

- [ ] 1. 失败测试（五块）：
  ```js
  test("restart: sending rows recover to pending and flush again succeeds", async () => { /* 同 Rev 4 */ });
  test("timeout: hung server aborts at 30s boundary path and requeues with backoff", async () => { /* 同 Rev 4 */ });
  test("backoff: first increment is 30s and the capped sequence is [30,60,120,300,600,600]s (意见12③)", async () => {
    // 逐次失败断言 available_at 增量完整序列；首档为 30_000 而非 60_000（对 Rev 4 capBackoff(attempt_count) 失败）
    // 到期后 claimPending 重新认领成功（available_at 谓词两侧覆盖）
  });
  test("blocked: permanent errors survive sweeps and restarts without retry (意见12④)", async () => {
    // blocked 行跨重启保持 blocked；claimPending/任何待发查询始终不返回该行；submit 返回 blocked 语义零网络
  });
  test("replay: confirmed row re-submit returns local receipt with zero fetch (also after restart)", async () => { /* 同 Rev 4 */ });
  ```
- [ ] 2. 预期失败 → 修复落点在 Task 4.3/4.4 文件内（独立 commit 注明块名：`fix(v2): outbox chaos <block>`）。
- [ ] 3. `npm run test:bridge` 预期 `# fail 0`。
- [ ] 4. 提交：`git add tools/reliable-drive-sync-mcp/test/v2-outbox-chaos.test.mjs && git commit -m "test(v2): local outbox chaos semantics with zero-based backoff"`。

### Task 4.8 Worker 端到端混沌与故障恢复套件（§16 十行）——逐字继承 Rev 4

- [ ] 逐字继承 Rev 4 Task 4.8 全部步骤（§16 表十行逐行测试 + 按行修复独立 commit 序列）。
- [ ] 提交消息不变：`test(v2): chaos and failure recovery suite`。

### Task 4.9 Skills 契约盘点与文案修订（仓库 `C:\Users\27846\my-chatgpt-skills`）——逐字继承 Rev 4

- [ ] 逐字继承 Rev 4 Task 4.9 全部步骤（inventory 文档冻结、五个契约测试三态文案断言、五个 SKILL.md 修订、AGENTS.md V2 语义小节、skills 仓六组独立提交）。
- [ ] 提交消息不变：五组 `feat(skills):` + 一组 `docs(skills):`（同 Rev 4 列表）。

### Task 4.10 插件重装与十步发布 runbook（意见 13 修正版：解释器修正 + 一次性前置 + 回滚语义统一）——整体替换

**Files:** Create（主仓）`docs/superpowers/plans/v2-release-runbook.md`；Test（主仓）`services/reliable-drive-sync-worker/test/rds2-runbook-config.test.js`
**Interfaces:** Consumes 全部开关名 + 四队列名（子计划 2 T2.5）+ V2 cron（子计划 2 T2.4） | Produces runbook 文档
**规格依据（§19.2 + 意见 13）:** 环境变量名与实现完全一致（`RELIABLE_DRIVE_SYNC_OUTBOX_PATH`，无 `_V2` 幻影变量）；文档内不残留 "本任务SHA/SHA/outdir" 三类尖括号占位符；dry-run 命令确定性（固定相对路径 outdir，bash 与 PowerShell 双版本）；**PowerShell 脚本以 `powershell -File`/`pwsh -File` 调用，禁止 `node xxx.ps1`**；**首次部署前的一次性前置逐条可执行（四条 Queue 创建、D1 迁移应用、V2 cron 与 `[[queues]]` 配置块核对）**；**回滚语义统一为"恢复上一部署版本并关闭功能开关"，无"清空白名单"表述**。
**意见 13 修订：** ① 附录 `node ...\setup-local-clients.ps1` → `powershell -File ...`（该文件为 PowerShell 脚本，`param(...)` 块，node 无法解释执行）；② 新增"第 0 节 一次性前置"（当前 `wrangler.toml` 无 `[[queues]]` 段，Rev 4 runbook 从本地测试直接跳暗部署，Queue 不存在则绑定失效）；③ 步 6/7 回滚列"清空白名单"删除（显式空串即全 namespace 503 `canary_misconfigured`，与回滚目标矛盾）。

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
    // 同 Rev 4：三类尖括号占位符零命中 + tmp-dryrun + powershell 变体
  });
  test("意见13①：powershell scripts are invoked via powershell -File, never node", () => {
    const runbook = readFileSync(new URL("../../../docs/superpowers/plans/v2-release-runbook.md", import.meta.url), "utf8");
    assert.ok(!/node\s+\S*\.ps1/.test(runbook), "node cannot interpret .ps1 (setup-local-clients.ps1 is PowerShell)");
    assert.match(runbook, /powershell\s+-File\s+\S*setup-local-clients\.ps1/);   // 或 pwsh -File，附录两变体至少其一
  });
  test("意见13②：one-time prerequisites create four queues, apply migrations, and verify v2 cron", () => {
    const runbook = readFileSync(new URL("../../../docs/superpowers/plans/v2-release-runbook.md", import.meta.url), "utf8");
    for (const q of ["rds2-project", "rds2-archive", "rds2-project-dlq", "rds2-archive-dlq"]) {
      assert.match(runbook, new RegExp(`wrangler queues create ${q}`), `missing queues create for ${q}`);
    }
    assert.match(runbook, /d1 migrations apply reliable-drive-sync/);
    assert.match(runbook, /2-57\/5 \* \* \* \*/);                 // V2 恢复器 cron（子计划 2 Task 2.4）
    assert.match(runbook, /\[\[queues\]\]/);                       // 配置块核对（子计划 2 Task 2.5 产物）
  });
  test("意见13③：rollback wording is unified, no clear-allowlist action remains", () => {
    const runbook = readFileSync(new URL("../../../docs/superpowers/plans/v2-release-runbook.md", import.meta.url), "utf8");
    assert.ok(!runbook.includes("清空白名单"), "empty allowlist is itself fail-closed 503 (canary_misconfigured)");
    assert.ok(!runbook.includes("清空白名单"));
    assert.match(runbook, /恢复上一部署版本并关闭功能开关/);
    assert.match(runbook, /wrangler rollback/);
  });
  ```
- [ ] 2. runbook 内容（第 0 节一次性前置 + 十步 = 规格 §19.2，每步四列：进入条件 / 动作与命令（需授权）/ 退出条件 / 回滚）：

  **第 0 节 一次性前置（首次部署前，全部需乔炳源授权；每步可单独验证）**

  | 前置 | 动作与命令（需授权） | 验证 |
  |---|---|---|
  | 0.1 创建四条 Queue | `npx wrangler queues create rds2-project`、`npx wrangler queues create rds2-project-dlq`、`npx wrangler queues create rds2-archive`、`npx wrangler queues create rds2-archive-dlq`（当前 `wrangler.toml` 无 `[[queues]]` 段，账号内队列不存在；队列名与子计划 2 Task 2.5 TOML 逐字一致） | `npx wrangler queues list` 含四行 |
  | 0.2 应用 V2 D1 迁移 | `npx wrangler d1 migrations apply reliable-drive-sync --remote`（`migrations/0006_rds2_v2_tables.sql`，子计划 1 Task 1.4 产物） | `npx wrangler d1 execute reliable-drive-sync --remote --command "SELECT name FROM sqlite_master WHERE name LIKE 'rds2_%'"` 含六表 |
  | 0.3 核对 V2 配置块 | 核对 `services/reliable-drive-sync-worker/wrangler.toml` 已含：`[[queues]]` producers/consumers 四队列块（子计划 2 Task 2.5）与 crons 第四项 `2-57/5 * * * *`（子计划 2 Task 2.4）；缺一则回到对应 Task 补齐，禁止手工补写与计划不一致的配置 | `git diff` 无 wrangler.toml 未提交改动；dry-run 退出码 0 |

  **十步发布（顺序固定，回滚列统一语义：恢复上一部署版本并关闭功能开关）**

  | 步 | 进入条件 | 动作与命令（需授权） | 退出条件与回滚 |
  |---|---|---|---|
  | 1 本地测试 | 子计划 1–4 全绿 + 第 0 节完成 | 仓库根执行 `npm test`；确定性 dry-run 门（bash）：`npx wrangler deploy --config services/reliable-drive-sync-worker/wrangler.toml --dry-run --outdir ./services/reliable-drive-sync-worker/tmp-dryrun` 后 `rm -rf ./services/reliable-drive-sync-worker/tmp-dryrun`；PowerShell 等价：`npx wrangler deploy --config services/reliable-drive-sync-worker/wrangler.toml --dry-run --outdir ./services/reliable-drive-sync-worker/tmp-dryrun; Remove-Item -Recurse -Force ./services/reliable-drive-sync-worker/tmp-dryrun` | 全绿 + dry-run 退出码 0；无回滚需求 |
  | 2 暗部署 | Codex 五审通过 + 乔炳源授权 | `npx wrangler deploy`（所有 RDS2_* 开关缺省=false，暗部署全闭） | V1 指标无回归；回滚 `npx wrangler rollback` |
  | 3 合成用户 | 步骤 2 观察 24h | admin 调 `POST /v2/users/init`（需先开 `RDS2_INIT_ENABLED`，`RDS2_ADMIN_TOKEN` 经 secret 注入） | 返回 userId+凭据；回滚：关闭 `RDS2_INIT_ENABLED`（初始化幂等，已建行保留无害） |
  | 4 合成 canary | 步骤 3 完成 | 逐一开启 `RDS2_EVENTS_ENABLED`、`RDS2_READS_ENABLED`、`RDS2_PROJECT_ENABLED`、`RDS2_ARCHIVE_ENABLED`（vars 变更需重新部署生效），每步验证开启前拒绝与开启后放行 | 全链路 + 预算指标 ≤ 上限 + DLQ 空；回滚：恢复上一部署版本并关闭功能开关 |
  | 5 单客户端 MCP 切换 | 步骤 4 观察 ≥48h 零 needs_attention | 用户本机设 `RELIABLE_DRIVE_SYNC_WRITE_VERSION=v2` + 用户凭据（`RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET`）；V1 pending 行逐条确认处理 | 一周无阻塞行；回退改回 v1（outbox-v2.sqlite 保留） |
  | 6 真实 algorithm canary | 步骤 5 完成 | `RDS2_CANARY_NAMESPACES=algorithm` 并重新部署 | 画像内容与用户核对一致；回滚：恢复上一部署版本并关闭功能开关（**不得**把白名单置空——显式空串即全 namespace 503 `canary_misconfigured`） |
  | 7 其他域逐个 | 步骤 6 每域独立观察 | 白名单逐域追加 `interview`,`profile`,`resume-knowledge`，每次重新部署 | 每域抽检一致；回滚：恢复上一部署版本并关闭功能开关 |
  | 8 Skill/插件生效 | 步骤 7 全绿 | skills 仓文案提交后执行插件重装（见附录精确命令） | 契约测试绿；回滚：skills 仓 revert + 按附录重装旧版 |
  | 9 稳定观察 ≥1 周 | 步骤 8 | 每日检查 needs_attention/DLQ/预算快照 | 零 P1 |
  | 10 关闭 V1/QStash | 步骤 9 + 乔炳源二次独立确认 | 停 V1 写入（移除 QStash 调度） | **单向动作，无自动回滚** |
- [ ] 3. 插件重装附录（精确命令，PowerShell 从仓库根执行）：
  ```powershell
  # 1) 停止运行中的 MCP 客户端进程后重装本地桥接插件（意见13①：PowerShell 脚本必须经 PowerShell 解释器）
  powershell -File C:\Users\27846\my-chatgpt-mcp\tools\reliable-drive-sync-mcp\setup-local-clients.ps1
  #    （pwsh 等价：pwsh -File C:\Users\27846\my-chatgpt-mcp\tools\reliable-drive-sync-mcp\setup-local-clients.ps1）
  # 2) 环境变量清单（setup-local-clients.ps1 写入用户级）：
  #    RELIABLE_DRIVE_SYNC_WORKER_URL=<worker 部署地址>
  #    RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET=<用户凭据，非 admin token>
  #    RELIABLE_DRIVE_SYNC_WRITE_VERSION=v2
  #    RELIABLE_DRIVE_SYNC_OUTBOX_PATH=<可选，默认 %LOCALAPPDATA%\ReliableDriveSync\outbox-v2.sqlite>
  # 3) 验证：node --test tools/reliable-drive-sync-mcp/test/v2-config.test.mjs
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add docs/superpowers/plans/v2-release-runbook.md services/reliable-drive-sync-worker/test/rds2-runbook-config.test.js && git commit -m "docs(v2): executable runbook with queue prerequisites and unified rollback"`。

### Task 4.11 回滚演练验证（本地可执行部分 + 全局完成门）——逐字继承 Rev 4

- [ ] 逐字继承 Rev 4 Task 4.11 全部步骤（writeVersion v2↔v1 双构造互不读写、开关全闭 V1 快照不变、blocked 行跨切换存活可再驱动、wrangler dry-run 确定性 outdir 退出码 0）。
- [ ] 提交消息不变：`test(v2): local rollback drills`。

## 覆盖与自检（子计划 4 完成门）

- [ ] 规格映射：§10.1 九步（4.6 逐条断言）+ 回执时机（4.4 回执时机锁、4.6 receipt 断言）、§10.2 targetRequestId（4.5/4.6 + 查询消息边界两块）、§11 全条（4.3/4.4/4.7：状态流、canonical hash、available_at、confirmed 重放、AbortController、永久错误集合、**显式事务、认领谓词、退避下标 0、blocked 排除**）、§15.1（4.6 根部预算器 + 最坏 7≤10）、§16（4.8 十行）、§17（4.6 init fail-closed + 协议分层）、§19.2 一次性前置 + 十步（4.10）、§21.3 三状态（4.9）、§21.4 验收门 11/12/13/16。
- [ ] 意见 5/12/13 逐项自检：①`grep -rn "payload: { username" tools/reliable-drive-sync-mcp/test/ src/` 零命中（displayName 契约）；②`grep -rn "\.transaction(" tools/reliable-drive-sync-mcp/local-outbox-v2.mjs tools/reliable-drive-sync-mcp/delivery-service-v2.mjs` 零命中（显式事务）；③`grep -n "available_at" tools/reliable-drive-sync-mcp/local-outbox-v2.mjs` 同时命中 markSending 谓词与 claimPending 谓词；④`grep -n "attempt_count - 1" tools/reliable-drive-sync-mcp/delivery-service-v2.mjs` 命中两处 requeue；⑤`grep -n "清空白名单\|清空白名单\|node\s\+.*\.ps1" docs/superpowers/plans/v2-release-runbook.md` 零命中（Task 4.10 测试锁定）；⑥`grep -n "sendWake" src/rds2/http-ingress.js` 零命中（意见 8 横切，与子计划 2 完成门互证）。
- [ ] 全局自检执行并记录（详见主索引 §4）：①规格 §20/§21/§22 逐条映射见主索引矩阵；②`grep -rn "TODO\|TBD\|同上\|参考前文\|必要修复\|补全逻辑\|如有问题" docs/superpowers/plans/*rev5*.md src/ test/ ../tools/` 零命中；③`task_id`/`stale_projection_write`/`business_dedupe_key`/`namespace_not_enabled`/`canary_misconfigured` 跨文件命名一致（grep 核对）；④七入口预算证明齐（子计划 3 Task 3.6，ingress 行已按 `dispatcher.run` 重算为 7≤10）；⑤Queue 无 message-ID 依赖（子计划 2 完成门）；⑥四 DLQ 消费者（子计划 2 Task 2.5）；⑦凭据身份（子计划 1 T1.9 + 子计划 4 T4.6 双核对）；⑧四域最小充分状态（子计划 2 T2.10–2.13）；⑨协议层 identity 无 displayName（envelope/toDomainEvent/示例路径零命中；`rds2_users.display_name` 用户表字段与 `system.user-*` payload 的 `displayName` 为合法领域字段，见子计划 1 T1.9/T1.2）；⑩发布顺序与规格 §19.2 一次性前置 + 十步一致（Task 4.10 测试锁定）；⑪"本任务SHA/SHA/outdir" 三类尖括号占位符全仓零命中（Task 4.10 测试锁定）。
