# RDS2 Queue State Machine, Projection Transactions and Minimal-Sufficient Reducers Implementation Plan — Revision 4

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 Codex 三审 P0-4/5/8/9 四项阻断修正：① Queue/D1 Outbox 状态机改为真实可验证的**原子认领**（单条条件 `UPDATE…RETURNING`）+ Dispatcher 六条规则 + 陈旧 `queued` 回收 + 两条必须存在的全链路测试；② 投影事务改为**单 D1 batch 五组操作**（10 事件 → 10 business-event artifact + 1 snapshot artifact，按精确 taskId 集合完成任务，禁止 BETWEEN 区间，禁止事务外 freeze）；③ Reducer `state_json` 改为**最小充分状态**（去重索引/聚合计数/选中关系，禁止完整事件数组，2 MiB 上限），领域规则修正（correction observedAt 严格晚于、resume 选当前 resumeVersion bank、等价输入 eventKey 唯一、toDomainEvent 统一 username）；④ V2 恢复器改用**独立 cron invocation**（`2-57/5 * * * *`），V1 三条 cron 逐字节保留。

**Architecture:** Dispatcher 自认领（`claimOne` 原子单行认领）→ `queueIo.sendWake` → `markQueued`（只接 `dispatching`，写 `queued_at`）；恢复器只列出到期 taskId 不预认领，重复发布容忍由 D1 状态机 + 租约 + 投影游标 CAS + 归档幂等键兜底。投影引擎一次推进至多 10 个事件，单个 `db.batch()` 内完成【① 投影 UPDATE（迁移触发器 CAS ABORT 旧游标）② 精确 taskId `IN` 列表完成 N 个 project task ③ N 条 event delivery `INSERT OR IGNORE`（确定性 `deterministicDeliveryId`）④ 1 条 snapshot delivery ⑤ N+1 条 archive task】，合计 2N+3 条语句。四域 Reducer 状态形如 `{byEventKey, topicAgg, relations, selectedBySession, currentBank, scores}`，`publicView` 从最小状态确定性重算；每次 invocation 入口根部一个 `SubrequestBudget`（本子计划交付最小实现，子计划 3 扩展为全通道封装）。

**Tech Stack:** Cloudflare Queues（producers + 4 consumers）、D1 batch（绑定语句数组）、Node test runner、`node:sqlite` 适配器（子计划 1）、Miniflare（集成断言）。

**Spec:** 规格 Rev 4：§11（本地 Outbox V2 语义）、§12（增量投影 + 最小充分状态 + 2 MiB）、§13（原子认领 + Dispatcher 六条 + 陈旧 queued 回收 + 两条测试链路）、§15.1/§15.2（预算器接口 + 独立 cron）、§16（失败恢复表）、§21.4 验收门 5/6/7/8/9/10/14/15。

**Rev 4 相对 Rev 3 的关键修正（本子计划范围）:**
1. Dispatcher 从"byTaskId 后直接 send"重写为六条规则：原子自认领、只发 `dispatching` 行、`markQueued` 只接 `dispatching`（对 `queued` 重放不得调用）、send 失败释放租约、`meta.changes` 判定、对 `processing/needs_attention/completed` 行显式拒绝（`illegal_state_transition`）。
2. 恢复器废除"V1 先行 + finally 内跑 V2 共享 invocation"（Rev 3 Task 2.3），改为独立 cron `2-57/5 * * * *` 按 `controller.cron` 精确匹配分流；新增陈旧 `queued` 回收（`queued_at <= now-10min`）。
3. 投影事务从"batch 外 freeze + 区间完成任务"重写为单 batch 五组操作：完成任务用精确 `task_id IN (绑定列表)`（禁 BETWEEN）、N 事件 → N+1 归档对象全部在同一 batch 冻结（`INSERT OR IGNORE`，禁事务外 freeze）。
4. 四域 Reducer 状态从"完整事件数组 `{accepted:[]}`"重写为最小充分状态；新增 2 MiB 上限引擎断言（超限 `needs_attention(state_limit_exceeded)`）与增长测试。
5. 领域规则修正：correction 保留 V1 语义 `Date.parse(event.observedAt) > Date.parse(target.observedAt)`（严格晚于，修正 Rev 3 的 seq 比较）；resume-knowledge bank 改为"当前 resumeVersion"（最新 bank 事件替换制，修正 Rev 3 的"最低 seq"）；等价测试输入不得含重复 `eventKey`（DB 唯一索引拒绝，非合法输入）；`toDomainEvent` 的 identity 字段统一为 `username`（协议无 displayName）。
6. 新增 Task 2.1 `SubrequestBudget` 最小实现（§15.1 四方法 + 十类别 + 40 上限），供 Queue/scheduled invocation 根部使用；子计划 3 扩展 `budgetD1/budgetQueue/budgetDrive/budgetFetch` 封装。

## Global Constraints

- 前置门 G0（主索引）：先确认 worktree 状态；本计划残留经用户确认后处理；用户未跟踪文件不删不改不提交。
- 受保护路径（本计划全部 Task 禁改）：`migrations/0005_schema12_jobs.sql`、`src/ingress.js`、`src/dispatcher.js`、`src/sync.js`、`src/event-store.js`、`src/qstash.js`、`src/reconciler.js`、所有 V1 store/model、`tools/reliable-drive-sync-mcp/local-outbox.mjs`、`tools/reliable-drive-sync-mcp/delivery-service.mjs`、`src/protocol.js`（只读）。
- **V1 cron 逐字节保留**：`wrangler.toml` 的 `crons = ["*/5 * * * *", "0 * * * *", "0 */6 * * *"]` 前三项字符不变（仅追加第四项）；`src/index.js` 的 V1 `scheduled` 逻辑保持原样（V2 走独立分支，不进入 V1 代码路径）。
- **D1 契约（全子计划强制，同子计划 1）**：全部调用 async/await；影响行数判定一律 `res.meta.changes`；`batch()` 入参只允许 `prepare(sql).bind(...)` 语句对象；禁止 `res.changes`。
- **状态机禁令**：禁止断言或实现"同一 taskId 不重复发布"；禁止业务路径读写 `queue_message_id`；禁止 `event_seq BETWEEN` 完成任务；禁止在 `db.batch()` 之外执行归档冻结写；Reducer `state_json` 禁止保存完整事件数组。
- 修改子计划 1 产物（如 outbox-repository 追加方法）时，`git add` 必须同时包含源文件与其测试文件的追加 diff。
- 所有测试命令在 worktree `C:\Users\27846\my-chatgpt-mcp-v2` 执行；每 Task 结束 `git status --short` 只允许出现该 Task 文件清单。
- 提交规范：`git add` 只加本 Task 文件；消息前缀 `feat(v2):`/`test(v2):`/`fix(v2):`；禁止 `git add -A`、`reset --hard`、`checkout --`、`stash drop`。
- 每 Task 回滚：`git revert <task_sha>`。

## Interfaces

- **Consumes**：子计划 1 全部 Produces（`shared/rds2-protocol.mjs` 的 `canonicalJson/sha256Hex/ALLOWED_EVENT_TYPES`、六仓库（含 outbox 的 `claimOne/markQueued/complete/failWithBackoff/toNeedsAttention/reclaimExpired/reclaimStaleQueued/byTaskId/releaseLease`、projection 的 `get/upsert/updateAdvanced`、archive-delivery 的 `deterministicDeliveryId/freezeRows`）、`accept-service`、`sqlite-adapter`、Miniflare 助手模式）。
- **Produces**：`src/rds2/subrequest-budget.js` 导出 `createSubrequestBudget(options)` → `{remaining, consume, assertWithinLimit, snapshotByCategory}`；`src/rds2/queue-io.js` 导出 `createQueueIo(budget, bindings)`；`src/rds2/dispatcher-v2.js` 导出 `createDispatcher(deps)`；`src/rds2/recovery.js` 导出 `createRecovery(db, deps)`；`src/rds2/queue-consumer.js` 导出 `createQueueProcessor(env, processors)`；`src/rds2/dlq-consumer.js` 导出 `createDlqProcessor(db, deps)`；`src/rds2/projection-engine.js` 导出 `createProjectionEngine(db, deps)`；`src/rds2/reducer-contract.js` 导出 `assertReducer`；`src/rds2/fold-all.js` 导出 `foldAll`；`src/rds2/reducers/index.js` 导出 `createReducerRegistry()`；四域 Reducer 各导出 `{name, emptyState, applyEvent, publicView}`；`outbox-repository` 追加 `listDue(limit, now)`；`wrangler.toml` crons 追加 `2-57/5 * * * *`；`src/index.js` scheduled 分流 + queue 方法。

---

### Task 2.1 SubrequestBudget 最小实现（§15.1 接口）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/subrequest-budget.js`；Test `services/reliable-drive-sync-worker/test/rds2-subrequest-budget.test.js`
**Interfaces:** Produces `createSubrequestBudget` | Consumes 无（子计划 3 消费并扩展全通道封装）

- [ ] 1. 失败测试：
  ```js
  test("consume records by category and remaining decreases", () => {
    const b = createSubrequestBudget({ limit: 40 });
    b.consume("d1", 3); b.consume("queue"); b.consume("drive_list");
    const snap = b.snapshotByCategory();
    assert.equal(snap.d1, 3); assert.equal(snap.queue, 1); assert.equal(snap.drive_list, 1);
    assert.equal(snap.total, 5); assert.equal(b.remaining(), 35);
  });
  test("unknown category is rejected up front", () => {
    const b = createSubrequestBudget({ limit: 40 });
    assert.throws(() => b.consume("drive_magic"), /unknown_budget_category/);
  });
  test("hard stop at limit: consume throws budget_exceeded before execution", () => {
    const b = createSubrequestBudget({ limit: 40 });
    for (let i = 0; i < 40; i++) b.consume("d1");
    assert.throws(() => b.consume("d1"), /budget_exceeded/);
    assert.equal(b.remaining(), 0);
    assert.throws(() => b.assertWithinLimit(), /budget_exceeded/);
  });
  test("categories are exactly the ten spec categories", () => {
    const b = createSubrequestBudget();
    b.consume("d1"); b.consume("queue"); b.consume("drive_oauth"); b.consume("drive_list");
    b.consume("drive_create"); b.consume("drive_upload"); b.consume("drive_read_meta");
    b.consume("drive_read_content"); b.consume("redirect"); b.consume("fetch_other");
    assert.equal(b.snapshotByCategory().total, 10);
  });
  test("recovery variant can be created with limit 15", () => {
    const b = createSubrequestBudget({ limit: 15 });
    assert.equal(b.remaining(), 15);
  });
  ```
- [ ] 2. 预期失败：`createSubrequestBudget is not a function`。
- [ ] 3. 最小实现：
  ```js
  const CATEGORIES = ["d1", "queue", "drive_oauth", "drive_list", "drive_create", "drive_upload",
    "drive_read_meta", "drive_read_content", "redirect", "fetch_other"];
  export function createSubrequestBudget({ limit = 40 } = {}) {
    const used = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
    const total = () => CATEGORIES.reduce((sum, c) => sum + used[c], 0);
    return {
      remaining: () => limit - total(),
      consume(category, count = 1) {
        if (!Object.prototype.hasOwnProperty.call(used, category)) throw new Error(`unknown_budget_category:${category}`);
        if (typeof count !== "number" || count < 1) throw new Error("invalid_budget_count");
        if (used[category] + count > limit) throw new Error(`budget_exceeded:${category}`);
        used[category] += count;
      },
      assertWithinLimit() { if (total() >= limit) throw new Error("budget_exceeded"); },
      snapshotByCategory: () => ({ ...used, total: total(), limit })
    };
  }
  ```
  注：本实现是 §15.1 "预算器至少提供"的最小形态；`budgetD1/budgetQueue/budgetDrive/budgetFetch` 依赖封装由子计划 3 Task 3.2 在本文件之上扩展，不回改本接口。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/subrequest-budget.js services/reliable-drive-sync-worker/test/rds2-subrequest-budget.test.js && git commit -m "feat(v2): minimal subrequest budget with ten categories"`。

### Task 2.2 Queue 消息契约与预算化发送封装

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/queue-io.js`；Test `services/reliable-drive-sync-worker/test/rds2-queue-io.test.js`
**Interfaces:** Produces `createQueueIo` | Consumes Task 2.1

- [ ] 1. 失败测试：
  ```js
  test("sendWake consumes queue budget and sends fixed body", async () => {
    const consumed = [];
    const budget = { consume: (category, count = 1) => { consumed.push([category, count]); } };
    const sent = [];
    const queueIo = createQueueIo(budget, { RDS2_PROJECT_QUEUE: { async send(body) { sent.push(body); } }, RDS2_ARCHIVE_QUEUE: { async send() { throw new Error("archive-unexpected"); } } });
    await queueIo.sendWake("t_project_101", "project_event", 1);
    assert.deepEqual(consumed, [["queue", 1]]);
    assert.deepEqual(sent, [{ taskId: "t_project_101", taskType: "project_event", attempt: 1 }]);
  });
  test("archive task type routes to archive queue", async () => {
    const sent = [];
    const queueIo = createQueueIo({ consume() {} }, { RDS2_ARCHIVE_QUEUE: { async send(body) { sent.push(body); } } });
    await queueIo.sendWake("t_archive_abc", "archive_artifact", 0);
    assert.deepEqual(sent, [{ taskId: "t_archive_abc", taskType: "archive_artifact", attempt: 0 }]);
  });
  test("message body keys are exactly {taskId, taskType, attempt}", async () => {
    const bodies = [];
    const queueIo = createQueueIo({ consume() {} }, { RDS2_PROJECT_QUEUE: { async send(b) { bodies.push(b); } } });
    await queueIo.sendWake("t_project_1", "project_event");
    assert.deepEqual(Object.keys(bodies[0]).sort(), ["attempt", "taskId", "taskType"]);
  });
  test("budget exhaustion aborts send (consume before send)", () => {
    const budget = { consume: () => { throw new Error("budget_exceeded:queue"); } };
    const queueIo = createQueueIo(budget, { RDS2_PROJECT_QUEUE: { async send() { throw new Error("send-must-not-run"); } } });
    assert.rejects(() => queueIo.sendWake("t_project_1", "project_event"), /budget_exceeded/);
  });
  ```
- [ ] 2. 预期失败：`createQueueIo is not a function`。
- [ ] 3. 最小实现：
  ```js
  export function createQueueIo(budget, bindings) {
    return {
      async sendWake(taskId, taskType, attempt) {
        budget.consume("queue", 1);
        const queue = taskType === "archive_artifact" ? bindings.RDS2_ARCHIVE_QUEUE : bindings.RDS2_PROJECT_QUEUE;
        await queue.send({ taskId, taskType, attempt: attempt ?? 0 });
      }
    };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/queue-io.js services/reliable-drive-sync-worker/test/rds2-queue-io.test.js && git commit -m "feat(v2): budgeted queue io with fixed message body"`。

### Task 2.3 Dispatcher 六条规则（原子自认领 + 状态机判定）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/dispatcher-v2.js`；Test `services/reliable-drive-sync-worker/test/rds2-dispatcher-v2.test.js`
**Interfaces:** Produces `createDispatcher(deps)` → `dispatch(taskId)` | Consumes Task 2.2、子计划 1 outbox-repository（`claimOne/markQueued/releaseLease/byTaskId`）
**规则映射（规格 §13）:** ① 自原子认领 `pending`（不假设调用者已认领）② 只发送成功置 `dispatching` 的任务 ③ 发布成功置 `queued` + `queued_at`（`queue_message_id` 保持 NULL）④ `markQueued` 只接 `dispatching`，对 `queued` 行重放**不调用它** ⑤ send 失败释放租约并设 `available_at` ⑥ 影响行数 `meta.changes` 判定；对 `processing/needs_attention/completed` 行显式拒绝（`illegal_state_transition`）。

- [ ] 1. 失败测试（六条规则逐条 + 重复发布容忍）：
  ```js
  test("rule1+2: dispatcher claims the task itself and only sends the dispatching row", async () => {
    // 预置 pending 任务 t_project_1；dispatch 后：行 state='queued'、lease_owner=NULL、queue_message_id IS NULL
    // 断言 sendWake 恰被调用一次、attempt 取自认领后的行
  });
  test("rule1: concurrent dispatch of same taskId sends at most once", async () => {
    // 两个 dispatcher（同一 adapter 或注入第二个 adapter 指向同一 sqlite 文件）并发 dispatch("t_project_1")
    // 恰一个返回 {outcome:"queued"}，另一个返回 claim 失败路径（不 send、不抛错）
  });
  test("rule3: markQueued writes queued_at and leaves queue_message_id NULL", async () => {
    // dispatch 成功后断言 queued_at 非空且 <= now、queue_message_id IS NULL
  });
  test("rule4: re-dispatch of queued row does NOT call markQueued again", async () => {
    // 对已 queued 行再次 dispatch → {outcome:"requeued_idempotent"}，不 send；
    // 注入 spy 断言 markQueued 未被调用（通过可注入 outbox 或断言 queued_at 未变化）
  });
  test("rule5: send failure releases lease and sets available_at", async () => {
    // queueIo.sendWake 抛错 → 行 state='pending'、available_at > now、last_error_code='queue_send_failed'
  });
  test("rule6: dispatching processing/needs_attention/completed rows is rejected", async () => {
    // 预置三行分别为 processing/needs_attention/completed → dispatch 各返回
    // {outcome:"illegal_state_transition", state}，sendWake 未被调用，行状态不变
  });
  test("send success + markQueued failure leaves dispatching row under lease (no silent success)", async () => {
    // 注入 markQueued 抛 illegal_state_transition 的场景：dispatch 返回 {outcome:"reconcile_needed"}，
    // 行保持 state='dispatching' 且租约未清；同一 taskId 再次 dispatch：
    // claimOne 对 dispatching 行返回 null → {outcome:"noop"}（不重复 send，等租约过期回收）
  });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  export function createDispatcher(deps) {
    const { outbox, queueIo } = deps;
    return async function dispatch(taskId) {
      const claimed = await outbox.claimOne(taskId, "dispatcher"); // 规则①：原子单行认领，非 pending → null
      if (!claimed) {
        const task = await outbox.byTaskId(taskId);
        if (!task) return { outcome: "noop" };
        if (task.state === "queued") return { outcome: "requeued_idempotent" }; // 规则④：不调 markQueued
        if (["processing", "needs_attention", "completed"].includes(task.state)) {
          return { outcome: "illegal_state_transition", state: task.state }; // 规则⑥
        }
        return { outcome: "noop" }; // dispatching：他方租约内，等租约回收
      }
      try {
        await queueIo.sendWake(claimed.task_id, claimed.task_type, claimed.attempt_count); // 规则②
      } catch (cause) {
        await outbox.releaseLease(taskId, "queue_send_failed"); // 规则⑤：pending + available_at
        return { outcome: "send_failed" };
      }
      try {
        await outbox.markQueued(taskId); // 规则③：只接 dispatching，meta.changes 判定
        return { outcome: "queued" };
      } catch (cause) {
        return { outcome: "reconcile_needed" }; // 发送成功、回写失败：租约保留，行留 dispatching
      }
    };
  }
  ```
  （`outbox.releaseLease(taskId, code)` 为子计划 1 T1.11 已有方法；若签名缺 `last_error_code` 参数，在本 Task 以追加 diff 补齐该可选参数与其测试。）
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/dispatcher-v2.js services/reliable-drive-sync-worker/src/rds2/outbox-repository.js services/reliable-drive-sync-worker/test/rds2-dispatcher-v2.test.js services/reliable-drive-sync-worker/test/rds2-outbox-repository.test.js && git commit -m "feat(v2): dispatcher with atomic claim and six state machine rules"`。

### Task 2.4 V2 独立 cron invocation 与有界恢复器（含陈旧 queued 回收）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/recovery.js`；Modify `services/reliable-drive-sync-worker/src/index.js`（`scheduled()` 按 `controller.cron` 分流，V1 代码路径逐字节保留）、`services/reliable-drive-sync-worker/wrangler.toml`（crons 追加第四项）、`services/reliable-drive-sync-worker/src/rds2/outbox-repository.js`（追加只读 `listDue`）；Test `services/reliable-drive-sync-worker/test/rds2-recovery.test.js`、`services/reliable-drive-sync-worker/test/rds2-cron-coexistence.test.js`
**Interfaces:** Produces `createRecovery(db, deps)`、`buildScheduledHandler`（测试导出） | Consumes Task 2.1/2.3、outbox-repository
**规格依据（§15.2）:** `crons` 在 V1 三条 `["*/5 * * * *", "0 * * * *", "0 */6 * * *"]` 逐字节保留之外追加 `"2-57/5 * * * *"`；`scheduled()` 按 `controller.cron` 精确匹配分流——V1 表达式走既有 V1 逻辑（零改动），V2 表达式走 V2 恢复器（预算 15）。每条 cron 的 invocation 各自独立证明 ≤40。

- [ ] 1. 失败测试（recovery）：
  ```js
  test("recovery reclaims expired leases, stale queued rows, then dispatches due tasks", async () => {
    // 预置：租约过期 processing 行 A、queued_at 早于 now-10min 的行 B、queued_at 新鲜的行 C、
    //       available_at 到期的 pending 行 D、未到期 pending 行 E
    // run() 后：A、B 复位 pending；C 不动；D 被 dispatch（sendWake 一次）；E 不动
  });
  test("stale queued reclaim uses queued_at <= now-10min boundary", async () => {
    // queued_at = now-9min59s → 不复位；queued_at = now-10min → 复位（含边界）
  });
  test("recovery is bounded: at most 4 dispatches, no Promise.all", async () => {
    // 预置 8 个到期任务 → run() 只 dispatch 4 个（listDue(4)）；其余留给下次
    // 批量 4 = floor((预算 15 - reclaim 固定 3) / 每任务 3)——每任务 = claimOne 1 d1 + send 1 queue + markQueued 1 d1
    const src = readFileSync(new URL("../src/rds2/recovery.js", import.meta.url), "utf8");
    assert.ok(!src.includes("Promise.all"), "recovery must not fan out concurrently");
  });
  test("v2 invocation budget stays within 15 (d1 + queue counted)", async () => {
    // 预置 4 个到期任务全部 dispatch 成功 → budget.snapshotByCategory():
    // d1 = 3 (reclaimExpired + reclaimStaleQueued + listDue) + 4×2 (claimOne + markQueued) = 11，
    // queue = 4，total = 15 <= 15（预算证明的 total 直接来自 snapshotByCategory 合计）
  });
  test("attempt_count >= 5 task transitions to needs_attention via dispatcher path", async () => {
    // attempt_count=5 的到期任务 → dispatch 内 claimOne 成功、DLQ 语义由 Task 2.6 覆盖；
    // 恢复器对 sendWake 失败且 attempt_count>=5 的行转 needs_attention（复用 failWithBackoff 阈值）
  });
  ```
- [ ] 2. 失败测试（coexistence——独立 invocation 证明）：
  ```js
  test("v1 crons route to v1 logic and never run v2 recovery", async () => {
    // buildScheduledHandler 注入假 reconciler/recovery：
    // cron "*/5 * * * *" → calls=["v1:fiveMinute"]；"0 * * * *" → ["v1:hourly"]；"0 */6 * * *" → ["v1:sixHourly"]
    // 三种调用 recovery 均未被调用
  });
  test("v2 cron 2-57/5 routes to recovery only and v1 logic is untouched", async () => {
    // cron "2-57/5 * * * *" → calls=["v2"]；reconciler 未被调用
    // RDS2_RECOVERY_ENABLED 非 "true" → 连 v2 也不执行（暗部署全闭）
  });
  test("v2 recovery failure is contained inside its own invocation", async () => {
    // recovery.run 抛错 → scheduled 的 v2 分支不向外 reject（错误进 captured log，event='rds2_recovery_failed'）
    // V1 与 V2 是不同 invocation，物理隔离，无需 finally 链（Rev 3 方式废除）
  });
  test("wrangler.toml keeps v1 crons byte-identical and appends the v2 expression", () => {
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    assert.ok(toml.includes('crons = ["*/5 * * * *", "0 * * * *", "0 */6 * * *", "2-57/5 * * * *"]'));
  });
  ```
- [ ] 3. 预期失败：模块不存在 / crons 未追加。
- [ ] 4. 实现 recovery：
  ```js
  export function createRecovery(db, { outbox, dispatcher, budget }) {
    return async function run() {
      budget.consume("d1", 1);
      await outbox.reclaimExpired();
      budget.consume("d1", 1);
      await outbox.reclaimStaleQueued(); // 陈旧 queued 回收：queued_at <= now-10min → pending
      budget.consume("d1", 1);
      const due = await outbox.listDue(4); // 只读列出（不认领），认领权归 dispatcher；
      // 4 = floor((15 - 3 固定 reclaim) / 3 每任务)，保证最坏路径 total === 15 不破预算
      for (const taskId of due) await dispatcher(taskId);
      return { processed: due.length };
    };
  }
  ```
  `outbox.listDue(limit, now)`：`SELECT task_id FROM rds2_event_outbox WHERE state='pending' AND available_at <= ? ORDER BY available_at LIMIT ?`（只读，追加到子计划 1 仓库 + 测试）。
- [ ] 5. 修改 `wrangler.toml`：仅把 crons 行改为 `crons = ["*/5 * * * *", "0 * * * *", "0 */6 * * *", "2-57/5 * * * *"]`（前三项逐字节不变，diff 中不得出现原行内容变更）。
- [ ] 6. 修改 `src/index.js` `scheduled()`：V1 现有方法体整体保留为 V1 分支，新增 V2 精确匹配分支：
  ```js
  scheduled(controller, _runtimeEnv, context) {
    const env = _runtimeEnv;
    if (controller?.cron === "2-57/5 * * * *") {           // V2 专用 invocation
      if (env.RDS2_RECOVERY_ENABLED !== "true") return;     // 开关默认关闭：暗部署全闭
      const budget = createSubrequestBudget({ limit: 15 });
      const deps = buildV2RecoveryDeps(env, budget);
      context.waitUntil(createRecovery(env.DB, deps).run().catch((cause) => {
        console.error(JSON.stringify({ event: "rds2_recovery_failed", code: cause?.code ?? "recovery_error" }));
      }));
      return;
    }
    /* ……V1 既有逻辑逐字节保留…… */
  }
  ```
  `buildV2RecoveryDeps(env, budget)` 为新增 env 装配函数（outbox/dispatcher/queueIo 同 Task 2.3/2.2 构造，共享一个 budget 实例）。
- [ ] 7. `npm run test:worker` 预期 `# fail 0`；`npm run test:bridge` 预期 `# fail 0`。
- [ ] 8. 提交：`git add services/reliable-drive-sync-worker/src/rds2/recovery.js services/reliable-drive-sync-worker/src/rds2/outbox-repository.js services/reliable-drive-sync-worker/src/index.js services/reliable-drive-sync-worker/wrangler.toml services/reliable-drive-sync-worker/test/rds2-recovery.test.js services/reliable-drive-sync-worker/test/rds2-cron-coexistence.test.js services/reliable-drive-sync-worker/test/rds2-outbox-repository.test.js && git commit -m "feat(v2): dedicated v2 cron invocation with bounded recovery and stale queued reclaim"`。

### Task 2.5 Queue handler 接入 default export + 四队列 TOML + handler 根部预算器

**Files:** Modify `services/reliable-drive-sync-worker/src/index.js`（default export 与 `createWorker` 各追加 queue 方法）、`services/reliable-drive-sync-worker/wrangler.toml`（追加 producers/consumers 块）；Create `src/rds2/queue-consumer.js`；Test `services/reliable-drive-sync-worker/test/rds2-queue-consumer.test.js`
**Interfaces:** Produces `createQueueProcessor` | Consumes Task 2.1

- [ ] 1. 失败测试：
  ```js
  test("createWorker exposes queue handler and routes by batch.queue", async () => {
    const handled = [];
    const worker = createWorker(fakeEnv, { processors: { "rds2-project": async (m) => handled.push(["project", m.taskId]), "rds2-archive": async (m) => handled.push(["archive", m.taskId]), "rds2-project-dlq": async (m) => handled.push(["project-dlq", m.taskId]), "rds2-archive-dlq": async (m) => handled.push(["archive-dlq", m.taskId]) } });
    const acks = [];
    const message = (queue, taskId, taskType) => ({ queue, body: { taskId, taskType, attempt: 1 }, ack: () => acks.push(taskId), retry: () => { throw new Error("retry-unexpected"); } });
    await worker.queue({ queue: "rds2-project", messages: [message("rds2-project", "t_project_1", "project_event")] }, fakeEnv, { waitUntil() {} });
    assert.deepEqual(handled, [["project", "t_project_1"]]);
    assert.deepEqual(acks, ["t_project_1"]);
  });
  test("queue handler creates exactly one budget at the root and passes it to processors", async () => {
    // 注入收集型 processors：断言两次消息处理收到同一 budget 实例（§15.1 invocation 根部单预算器）
  });
  test("processor failure surfaces so message is retried (no swallow)", async () => {
    // processor 抛错 → worker.queue rejects（不吞错、不 ack）
  });
  test("wrangler.toml declares consumers for all four queues", () => {
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    for (const q of ["rds2-project", "rds2-archive", "rds2-project-dlq", "rds2-archive-dlq"]) assert.match(toml, new RegExp(`queue = "${q}"`));
    assert.match(toml, /dead_letter_queue = "rds2-project-dlq"/);
    assert.match(toml, /dead_letter_queue = "rds2-archive-dlq"/);
  });
  ```
- [ ] 2. 预期失败：`createWorker(...).queue is not a function`。
- [ ] 3. 实现 `src/rds2/queue-consumer.js`：
  ```js
  export function createQueueProcessor(env, processors) {
    return async function queue(batch, env2, context) {
      const processor = processors[batch.queue];
      if (!processor) throw new Error(`unhandled_queue:${batch.queue}`);
      for (const message of batch.messages) {
        await processor(message.body, message);
        message.ack();
      }
    };
  }
  ```
- [ ] 4. `wrangler.toml` 追加（逐行书写，置于文件末尾，V1 内容与 Task 2.4 的 crons 行不动）：四队列 producers/consumers 块与 Rev 3 相同（`rds2-project` max_batch_size=10、`rds2-archive` max_batch_size=8、两 DLQ 消费者，`dead_letter_queue` 各指向对应 DLQ，`max_retries=5`/`3`）。
- [ ] 5. `src/index.js` default export 追加 `queue(batch, env, context) { return createWorker(env).queue(batch, env, context); }`；`createWorker` 返回对象追加 `queue: createQueueProcessor(env, buildProcessors(env, createSubrequestBudget({ limit: 40 })))`——根部单预算器；`buildProcessors` 本 Task 先注册空处理器映射（四键），Task 2.7/2.8 与子计划 3 替换为真实现。
- [ ] 6. 验证：`npm run test:worker` 预期 `# fail 0`；`npx --yes wrangler deploy --config services/reliable-drive-sync-worker/wrangler.toml --dry-run --outdir "$PWD/services/reliable-drive-sync-worker/tmp-dryrun-t25"` 退出码 0，随后删除该目录。
- [ ] 7. 提交：`git add services/reliable-drive-sync-worker/src/index.js services/reliable-drive-sync-worker/src/rds2/queue-consumer.js services/reliable-drive-sync-worker/wrangler.toml services/reliable-drive-sync-worker/test/rds2-queue-consumer.test.js && git commit -m "feat(v2): queue handler in default export with root budget and four consumers"`。

### Task 2.6 DLQ 消费者：按 taskId 置 needs_attention

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/dlq-consumer.js`；Modify `src/index.js`（`buildProcessors` 两个 DLQ 键替换为真实现）；Test `services/reliable-drive-sync-worker/test/rds2-dlq.test.js`
**Interfaces:** Produces `createDlqProcessor` | Consumes outbox-repository

- [ ] 1. 失败测试：消息 `{taskId:"t_project_1"}` → 行 `state='needs_attention'`、`last_error_code='dlq_exhausted'`；未知 taskId → 返回 `{outcome:"unknown_task"}` 不抛错（消息 ack，防 DLQ 死循环）；`completed` 行 → `{outcome:"noop"}` 保持 completed；兜底通道：recovery 的 `reclaimExpired + failWithBackoff` 把长期 `queued/processing` 行也转 `needs_attention`，注入测试"DLQ processor 抛错不影响 recovery 路径的 needs_attention 转移"。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 实现：
  ```js
  export function createDlqProcessor(db, { outbox }) {
    return async function process(body) {
      const task = await outbox.byTaskId(body.taskId);
      if (!task) return { outcome: "unknown_task" };
      if (task.state === "completed") return { outcome: "noop" };
      await outbox.toNeedsAttention(body.taskId, "dlq_exhausted");
      return { outcome: "needs_attention" };
    };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/dlq-consumer.js services/reliable-drive-sync-worker/src/index.js services/reliable-drive-sync-worker/test/rds2-dlq.test.js && git commit -m "feat(v2): dlq consumers routing by task id"`。

### Task 2.7 投影引擎：单 D1 batch 五组操作 + 2 MiB 状态上限断言

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/projection-engine.js`；Test `services/reliable-drive-sync-worker/test/rds2-projection-engine.test.js`
**Interfaces:** Produces `createProjectionEngine(db, deps)` → `processTask(taskId)` | Consumes 子计划 1 全部仓库（projection `updateAdvanced` 触发器 CAS、archive-delivery `deterministicDeliveryId`）、`shared/rds2-protocol.mjs`
**排序说明：** 本 Task 位于 Task 2.9（registry）之前，`deps.reducer` 由测试内联桩 Reducer 提供；Task 2.9 交付真实 registry 后由 Task 2.8 接线替换，本 Task 代码零改动。
**五组操作（规格 §12.4，单 batch，N=fresh 事件数 ≤10）：** ① 投影 UPDATE（1 条，触发器 CAS ABORT 旧游标）② 精确 taskId `IN (绑定列表)` 完成 N 个 project task（1 条，禁 BETWEEN）③ N 条 event delivery `INSERT OR IGNORE` ④ 1 条 snapshot delivery `INSERT OR IGNORE` ⑤ N+1 条 archive task `INSERT OR IGNORE` = **2N+3 条语句**；10 事件 → 23 条、10 business-event artifact + 1 snapshot artifact。

- [ ] 1. 失败测试（核心八条）：
  ```js
  test("advances cursor by at most 10 events in one atomic batch", async () => {
    // 预置 15 个事件（seq 1..15，同 user/namespace，eventKey 全唯一）→ processTask("t_project_1")
    // 断言：cursor=10、10 个事件 task 全部 completed、返回 {outcome:"advanced", hasMore:true}
  });
  test("hasMore triggers a follow-up wake, not a direct queue call", async () => {
    // deps.wakeNext spy：15 事件场景恰调用一次 wakeNext("t_project_11", "project_event")；
    // 源码静态断言引擎文件不含 "queue.send" 与 "googleapis.com"
  });
  test("stale consumer batch fails with zero side effects (trigger CAS)", async () => {
    // 预置 cursor=110；对 seq<=100 的旧任务重放 → updateAdvanced 触发 stale_projection_write → batch 整体回滚
    // 断言：task 仍非 completed、archive_deliveries 无新行、outbox 无新 archive task（零副作用）
  });
  test("duplicate message after cursor advanced completes task without reapplying", async () => {
    // cursor 已 >= 触发事件 seq → {outcome:"noop_confirmed"}，public_view_json 与 content_hash 不变
  });
  test("single batch freezes 10 event artifacts + 1 snapshot (10+1, never 1+1)", async () => {
    // 10 事件推进后：archive_deliveries 恰 11 行（business_event 10 行 artifact_key='business-event:<eventId>'
    // + projection_snapshot 1 行 'projection:<user>:<ns>:<name>:<lastSeq>'）；
    // drive_path 为相对 V2 根的 'users/<userId>/<namespace>/events/event-<eventId>.json' 与
    // 'users/<userId>/<namespace>/snapshots/<name>-through-<lastSeq>.json'；
    // outbox 恰 11 行 t_archive_<deliveryId>（task_id 主键 = 't_archive_' + deterministicDeliveryId(artifactKey)）
  });
  test("project tasks are completed by exact taskId IN-list, not BETWEEN", async () => {
    // 预置交叉用户干扰：userB 的 t_project_5 与本批 seq 区间重叠 → 推进后 userB 的任务保持原状态
    // 源码静态断言：引擎文件不含 "BETWEEN"
  });
  test("mid-batch failure rolls back projection, task completion and all freezes", async () => {
    // 注入 batch 中第 ④ 组语句失败（snapshot artifact_key 冲突改造）→ 全回滚：
    // 投影行 cursor 不变、任务未完成、deliveries 0 新行
  });
  test("state_json over 2 MiB routes task to needs_attention without any write", async () => {
    // 注入桩 reducer 产生 >2MiB state_json → 返回 {outcome:"state_limit_exceeded"}，
    // 行 state='needs_attention'、last_error_code='state_limit_exceeded'，
    // 投影行未变、archive_deliveries 无新行（先断言后写，不得静默截断）
  });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（batch 组装核心）：
  ```js
  import { canonicalJson, sha256Hex } from "../../../../shared/rds2-protocol.mjs";
  import { deterministicDeliveryId } from "./archive-delivery-repository.js";
  const BATCH_LIMIT = 10;
  const STATE_LIMIT_BYTES = 2 * 1024 * 1024;
  export function createProjectionEngine(db, { events, projections, outbox, registry, wakeNext }) {
    return async function processTask(taskId) {
      const task = await outbox.byTaskId(taskId);
      if (!task || task.state === "completed") return { outcome: "noop_confirmed" };
      const event = await db.prepare("SELECT * FROM rds2_business_events WHERE event_seq = ?").bind(task.event_seq).first();
      const projectionName = registry.projectionName(event.namespace);
      let projection = await projections.get(event.user_id, event.namespace, projectionName);
      if (!projection) { await projections.upsert(event.user_id, event.namespace, projectionName); projection = await projections.get(event.user_id, event.namespace, projectionName); }
      if (projection.last_event_seq >= event.event_seq) { await outbox.complete(taskId); return { outcome: "noop_confirmed" }; }
      const fresh = await events.readAfter(event.user_id, event.namespace, projection.last_event_seq, BATCH_LIMIT);
      const reducer = registry.forNamespace(event.namespace);
      let state = JSON.parse(projection.state_json || "{}");
      for (const row of fresh) state = reducer.applyEvent(state, registry.toDomainEvent(row));
      const lastSeq = fresh[fresh.length - 1].event_seq;
      const stateJson = JSON.stringify(state);
      if (Buffer.byteLength(stateJson, "utf8") > STATE_LIMIT_BYTES) {
        await outbox.toNeedsAttention(taskId, "state_limit_exceeded");   // 先断言后写，不得静默截断
        return { outcome: "state_limit_exceeded" };
      }
      const publicView = reducer.publicView(state);
      const publicViewJson = canonicalJson(publicView);
      const contentHash = await sha256Hex(publicViewJson);
      const now = new Date().toISOString();
      const deliveries = [];
      for (const row of fresh) {
        const artifactKey = `business-event:${row.event_id}`;
        deliveries.push({ archive_delivery_id: deterministicDeliveryId(artifactKey), artifact_kind: "business_event",
          artifact_key: artifactKey, user_id: row.user_id, namespace: row.namespace, source_event_seq: row.event_seq,
          projection_name: null, projection_event_seq: null, artifact_json: row.envelope_json, artifact_hash: row.envelope_hash,
          drive_path: `users/${row.user_id}/${row.namespace}/events/event-${row.event_id}.json` });
      }
      const snapKey = `projection:${event.user_id}:${event.namespace}:${projectionName}:${lastSeq}`;
      deliveries.push({ archive_delivery_id: deterministicDeliveryId(snapKey), artifact_kind: "projection_snapshot",
        artifact_key: snapKey, user_id: event.user_id, namespace: event.namespace, source_event_seq: null,
        projection_name: projectionName, projection_event_seq: lastSeq, artifact_json: publicViewJson,
        artifact_hash: contentHash, drive_path: `users/${event.user_id}/${event.namespace}/snapshots/${projectionName}-through-${lastSeq}.json` });
      const stmts = [];
      stmts.push(db.prepare(`UPDATE rds2_projections SET last_event_seq=?, state_json=?, public_view_json=?, content_hash=?, updated_at=?
        WHERE user_id=? AND namespace=? AND projection_name=?`)
        .bind(lastSeq, stateJson, publicViewJson, contentHash, now, event.user_id, event.namespace, projectionName));   // ① 触发器 CAS
      const taskIds = fresh.map((row) => `t_project_${row.event_seq}`);
      stmts.push(db.prepare(`UPDATE rds2_event_outbox SET state='completed', updated_at=?
        WHERE task_type='project_event' AND state != 'completed' AND task_id IN (${taskIds.map(() => "?").join(",")})`)
        .bind(now, ...taskIds));   // ② 精确 taskId 集合，禁 BETWEEN
      for (const d of deliveries) {
        stmts.push(db.prepare(`INSERT OR IGNORE INTO rds2_archive_deliveries (archive_delivery_id, artifact_kind, artifact_key,
          user_id, namespace, source_event_seq, projection_name, projection_event_seq, artifact_json, artifact_hash, drive_path,
          state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
          .bind(d.archive_delivery_id, d.artifact_kind, d.artifact_key, d.user_id, d.namespace, d.source_event_seq,
            d.projection_name, d.projection_event_seq, d.artifact_json, d.artifact_hash, d.drive_path, now, now));   // ③④
      }
      for (const d of deliveries) {
        stmts.push(db.prepare(`INSERT OR IGNORE INTO rds2_event_outbox (task_id, task_type, event_seq, archive_delivery_id,
          state, attempt_count, queue_message_id, available_at, created_at, updated_at)
          VALUES (?, 'archive_artifact', NULL, ?, 'pending', 0, NULL, ?, ?, ?)`)
          .bind(`t_archive_${d.archive_delivery_id}`, d.archive_delivery_id, now, now, now));   // ⑤
      }
      await db.batch(stmts);   // 2N+3 条语句，单事务
      if (fresh.length === BATCH_LIMIT) await wakeNext(`t_project_${lastSeq + 1}`, "project_event");
      return { outcome: "advanced", lastSeq, advanced: fresh.length, hasMore: fresh.length === BATCH_LIMIT };
    };
  }
  ```
  （`events.readAfter` 为子计划 1 event-repository 已有方法；`deterministicDeliveryId` 为子计划 1 archive-delivery-repository 导出纯函数。`wakeNext` 由消费者接线注入——引擎自身不触碰 queue，静态断言锁定。）
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/projection-engine.js services/reliable-drive-sync-worker/test/rds2-projection-engine.test.js && git commit -m "feat(v2): projection engine with single-batch five-operation transaction and state limit"`。

### Task 2.8 投影消费者接线 + 规格两条必测链路端到端

**Files:** Modify `src/index.js`（`buildProcessors` 的 `rds2-project` 键替换为引擎接线，`wakeNext` 注入 `queueIo.sendWake`）；Test `services/reliable-drive-sync-worker/test/rds2-duplicate-consumption.test.js`
**Interfaces:** Consumes Task 2.2/2.3/2.5/2.7
**规格依据（§13）:** 必须存在的两条真实测试链路：① `send 成功 → markQueued 失败 → 租约到期 → 相同 taskId 重发 → 重复消费无副作用`；② `queued 消息丢失 → 陈旧回收 → 重新发布 → 恰好一次业务效果`。

- [ ] 1. 失败测试（端到端，Miniflare 或 sqlite-adapter + 假 queue binding）：
  ```js
  test("chain A: send ok, write-back fails, lease expires, same taskId republished, duplicate consume is harmless", async () => {
    // ① accept 事件 seq1 → dispatch（sendWake 成功）
    // ② 注入 markQueued 失败（或手工把行留在 dispatching + 短租约）→ 行 dispatching
    // ③ reclaimExpired（租约过期）→ 行 pending → dispatch 重发（sendWake 第二次，同 taskId）
    // ④ 消费该 taskId 两次 → 第一次 advanced，第二次 noop_confirmed
    // 断言：cursor=1、topicMastery 计数无翻倍、archive_deliveries 恰 2 行（1 event + 1 snapshot）
  });
  test("chain B: queued message lost, stale reclaim after 10min, republish, exactly one business effect", async () => {
    // ① accept 事件 → dispatch 成功（行 queued，假 queue 吞掉消息不投递）
    // ② 时钟推进 >10min → recovery.run() → reclaimStaleQueued 复位 pending → dispatcher 重发
    // ③ 消费 → advanced；重复消费 → noop_confirmed
    // 断言：publicView 与直接顺序处理结果 deepEqual；queued_at 在复位行重发后更新为新值
  });
  test("duplicate publish then duplicate consume yields one projection advance and one artifact set", async () => {
    // dispatcher 两次 dispatch 同 taskId（模拟回写失败后恢复器重发）→ 消费两次 →
    // projections.last_event_seq 只推进一次的值；archive_deliveries 恰 2 行；publicView 深相等
  });
  ```
- [ ] 2. 预期失败：`rds2-project` 处理器为空实现。
- [ ] 3. 实现 `buildProcessors` 的 project 键与引擎装配：
  ```js
  "rds2-project": async (body) => { await engine.processTask(body.taskId); },
  ```
  引擎实例化加入 `createWorker` 私有装配：`deps = { events, projections, outbox, registry: createReducerRegistry(), wakeNext: (taskId, type) => queueIo.sendWake(taskId, type, 0) }`（`queueIo` 与 dispatcher 共享同一 budget）。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/index.js services/reliable-drive-sync-worker/test/rds2-duplicate-consumption.test.js && git commit -m "feat(v2): project consumer wiring with the two mandatory end-to-end chains"`。

### Task 2.9 fold-all Oracle、Reducer 契约与 toDomainEvent 冻结结构

**Files:** Create `src/rds2/reducer-contract.js`、`src/rds2/fold-all.js`、`src/rds2/reducers/index.js`；Test `test/rds2-reducer-contract.test.js`、`test/rds2-fold-all.test.js`
**Interfaces:** Produces `assertReducer`、`foldAll`、`createReducerRegistry` | Consumes 无
**Rev 4 修正：** `toDomainEvent` 的 identity 字段统一为 `username`（协议事实：`IDENTITY_FIELDS = ["userId", "username"]`，不存在 displayName）；并断言 `identity.userId` 与 `row.user_id` 一致（不一致抛 `identity_row_mismatch`——接收端双核对的下游延续）。

- [ ] 1. 失败测试：
  ```js
  test("assertReducer rejects objects missing the three functions", () => {
    assert.throws(() => assertReducer({ applyEvent: () => {} }), /invalid_reducer/);
  });
  test("publicView is pure: same state twice gives deep-equal output", () => { /* */ });
  test("foldAll sorts by event_seq ASC and folds from emptyState", () => { /* */ });
  test("toDomainEvent freezes the unified structure with username (no displayName)", async () => {
    const row = { event_seq: 7, event_id: "e1", event_key: "k1", namespace: "algorithm",
      event_type: "algorithm.learning.completed", user_id: "u-1", envelope_json: JSON.stringify({
        schemaVersion: "1", identity: { userId: "u-1", username: "乔" },
        payload: { event: { outcome: "completed", topic: "链表", observedAt: "2026-09-01T10:00:00Z", source: "leetcode", problem: { source: "leetcode", title: "206" }, evidence: "ok" } } }) };
    const d = createReducerRegistry().toDomainEvent(row);
    assert.equal(d.username, "乔");
    assert.equal(d.userId, "u-1");
    assert.ok(!("displayName" in d));
    assert.throws(() => createReducerRegistry().toDomainEvent({ ...row, user_id: "u-other" }), /identity_row_mismatch/);
  });
  test("registry: unknown namespace throws no_reducer_for_namespace", () => { /* */ });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  export function assertReducer(reducer) {
    for (const key of ["emptyState", "applyEvent", "publicView"]) {
      if (typeof reducer?.[key] !== "function") throw new Error("invalid_reducer");
    }
    return reducer;
  }
  export function foldAll(reducer, events, identity) {
    const ordered = [...events].sort((a, b) => a.event_seq - b.event_seq);
    let state = reducer.emptyState(identity);
    for (const event of ordered) state = reducer.applyEvent(state, event);
    return reducer.publicView(state);
  }
  ```
  `createReducerRegistry()` 返回 `{ forNamespace(ns), projectionName(ns), toDomainEvent(row) }`：
  ```js
  toDomainEvent(row) {
    const envelope = JSON.parse(row.envelope_json);
    if (envelope.identity?.userId !== row.user_id) throw new Error("identity_row_mismatch");
    return { event_seq: row.event_seq, eventId: row.event_id, eventKey: row.event_key,
      namespace: row.namespace, eventType: row.event_type, payload: envelope.payload,
      userId: row.user_id, username: envelope.identity?.username ?? null };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/reducer-contract.js services/reliable-drive-sync-worker/src/rds2/fold-all.js services/reliable-drive-sync-worker/src/rds2/reducers/index.js services/reliable-drive-sync-worker/test/rds2-reducer-contract.test.js services/reliable-drive-sync-worker/test/rds2-fold-all.test.js && git commit -m "feat(v2): reducer contract, seq-ordered fold oracle and frozen toDomainEvent"`。

### Task 2.10 algorithm Reducer（最小充分状态：去重索引 + 聚合计数）

**Files:** Create `src/rds2/reducers/algorithm.js`；Test `test/rds2-reducer-algorithm.test.js`
**Interfaces:** Consumes Task 2.9；规则蓝本 `src/algorithm-profile-model.js`（只读）
**Rev 4 修正：** state 从 `{accepted: [...]}`（完整事件数组，Codex P0-9 否决）改为 `{byEventKey, topicAgg, headSeq, headEventKey}`；`publicView` 全部派生值从最小状态重算。

- [ ] 1. 失败测试（规则逐条来自 `algorithm-profile-model.js:6-91`）：
  ```js
  test("completed/correct positive, incorrect/stuck/partial negative, consulted neutral", () => { /* topicAgg 三分支计数 */ });
  test("problemId normalizes to source:title", () => { /* {source:'leetcode',title:'206'} → 'leetcode:206' */ });
  test("pendingProblemIds keeps problem until latest-seq outcome is positive", () => { /* seq3 incorrect → pending；seq4 completed → 移出 */ });
  test("weaknesses: negative>0, improving when positive>0, sorted by negative desc then topic", () => { /* */ });
  test("duplicate eventKey application is a state no-op (defense in depth behind DB unique index)", () => {
    // 同 eventKey 二次 applyEvent → state 引用不变（byEventKey 无新键）
  });
  test("state stays minimal: no event arrays, payload not retained", () => {
    // 对 200 个事件 applyEvent 后 JSON.stringify(state) 不含 'evidence' 键
    // （byEventKey 只存 {seq, outcome, topic, problemId}）
  });
  test("state_json of a 300-event normal series stays far below 2 MiB", () => {
    // 300 事件（每事件 topic 从 8 个主题轮换）→ JSON.stringify(state).length < 256 * 1024
  });
  test("publicView is deterministic from minimal state", () => { /* 两次调用 deepEqual；headEventId/headSeq 一致 */ });
  ```
- [ ] 2. 预期失败：`forNamespace("algorithm")` 抛 `no_reducer_for_namespace`。
- [ ] 3. 最小实现：
  ```js
  const NEGATIVE = new Set(["incorrect", "stuck", "partial"]);
  const POSITIVE = new Set(["completed", "correct"]);
  const problemIdOf = (e) => {
    const title = e.payload?.event?.problem?.title;
    if (!title) return null;
    const source = e.payload?.event?.problem?.source;
    return source ? `${source}:${title}` : title;
  };
  export const algorithmReducer = {
    name: "algorithm",
    emptyState: () => ({ byEventKey: {}, topicAgg: {}, headSeq: 0, headEventKey: null }),
    applyEvent(state, event) {
      const key = event.eventKey;
      if (state.byEventKey[key]) return state;                     // DB 唯一索引后的防御层
      const ev = event.payload.event;
      const outcome = ev.outcome, topic = ev.topic;
      const m = state.topicAgg[topic] ?? { attempts: 0, negative: 0, positive: 0, neutral: 0, lastOutcome: null, lastSeq: 0, problemIds: [] };
      m.attempts += 1;
      if (NEGATIVE.has(outcome)) m.negative += 1; else if (POSITIVE.has(outcome)) m.positive += 1; else m.neutral += 1;
      m.lastOutcome = outcome; m.lastSeq = event.event_seq;
      const pid = problemIdOf(event);
      if (pid && !m.problemIds.includes(pid)) m.problemIds.push(pid);
      return {
        byEventKey: { ...state.byEventKey, [key]: { seq: event.event_seq, outcome, topic, problemId: pid } },
        topicAgg: { ...state.topicAgg, [topic]: m },
        headSeq: event.event_seq, headEventKey: key
      };
    },
    publicView(state) {
      const entries = Object.entries(state.byEventKey).sort((a, b) => a[1].seq - b[1].seq);
      const latestByProblem = new Map();
      for (const [key, rec] of entries) {
        const cur = rec.problemId ? latestByProblem.get(rec.problemId) : null;
        if (rec.problemId && (!cur || rec.seq > cur.seq)) latestByProblem.set(rec.problemId, rec);
      }
      const topicMastery = {};
      for (const [topic, m] of Object.entries(state.topicAgg)) {
        topicMastery[topic] = { attempts: m.attempts, negative: m.negative, positive: m.positive, neutral: m.neutral,
          lastOutcome: m.lastOutcome, lastEventSeq: m.lastSeq, problemIds: [...m.problemIds] };
      }
      const weaknesses = Object.entries(topicMastery).filter(([, m]) => m.negative > 0)
        .sort((a, b) => (b[1].negative - a[1].negative) || String(a[0]).localeCompare(String(b[0])))
        .map(([topic, m]) => ({ topic, status: m.positive > 0 ? "improving" : "open", negative: m.negative,
          positive: m.positive, lastOutcome: m.lastOutcome, lastEventSeq: m.lastEventSeq,
          evidenceEventKeys: entries.filter(([, r]) => r.topic === topic).map(([k]) => k) }));
      const pendingProblemIds = [...latestByProblem.values()].filter((r) => !POSITIVE.has(r.outcome)).map((r) => r.problemId);
      return { schemaVersion: "1.2", userId: null, headEventKey: state.headEventKey, headEventSeq: state.headSeq,
        sourceEventKeys: entries.map(([k]) => k),
        currentTopic: state.headEventKey ? state.byEventKey[state.headEventKey].topic : null,
        topicMastery, weaknesses, pendingProblemIds };
    }
  };
  ```
  （`publicView.userId` 由调用方以 identity 注入而非存入 state——最小状态不复制身份。`foldAll` 的第三参与 Task 2.15 等价测试用它回填。注册 `projectionName("algorithm") = "learning"`。）
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/reducers/algorithm.js services/reliable-drive-sync-worker/src/rds2/reducers/index.js services/reliable-drive-sync-worker/test/rds2-reducer-algorithm.test.js && git commit -m "feat(v2): algorithm reducer with minimal sufficient state"`。

### Task 2.11 generic-profile Reducer（最小贡献表 + observedAt 严格晚于 correction）

**Files:** Create `src/rds2/reducers/generic-profile.js`；Test `test/rds2-reducer-generic-profile.test.js`
**Interfaces:** Consumes Task 2.9；规则蓝本 `src/generic-profile-model.js:50-97`（只读）
**Rev 4 修正：** ① state 改为 `{contributions, inactive}`（`contributions[eventKey] = {seq, action, outcome, dimension, subject, targets, observedAt}` 最小贡献记录，`inactive[eventKey] = {by, action, seq}` 关系）；② **correction 保留 V1 领域规则**：`Date.parse(event.observedAt) > Date.parse(target.observedAt)` 严格晚于（`generic-profile-model.js:85`），等于或更早拒绝——修正 Rev 3"用 seq 比较"的语义切换错误；③ 非 correction 的 supersede/invalidate 仍按 seq 关系判定目标存在与活性。

- [ ] 1. 失败测试：
  ```js
  test("supersede deactivates target and stays active itself", () => { /* inactive 集合断言 */ });
  test("supersede can itself be superseded later (chained)", () => { /* 两跳链 */ });
  test("invalidate deactivates target without adding an active contribution", () => { /* */ });
  test("correction requires observedAt strictly later than target (V1 rule kept)", () => {
    // target.observedAt = T；新事件 observedAt = T+1ms → 接受；
    // observedAt = T（相等）→ 抛 stale_correction；T-1ms → 抛 stale_correction
    // 断言依据 generic-profile-model.js:85 的 Date.parse 严格大于
  });
  test("targeting inactive or missing event fails at reducer boundary", () => { /* target_event_not_found / target_event_inactive */ });
  test("self-target is rejected", () => { /* invalid_profile_event */ });
  test("revocation shrinks aggregates without deleting contribution records", () => {
    // 聚合计数回落，但 contributions 键保留（最小贡献记录支持重放撤销重推导）
  });
  test("publicView groups by dimension+subject into four buckets, deterministic", () => {
    // openWeaknesses/improvingSignals/stableStrengths/observations；两次调用 deepEqual
  });
  test("state stays minimal: no envelopes, no evidence text", () => {
    // 200 事件后 stringify(state) 不含 'evidence'；300 事件 < 256 KiB
  });
  ```
- [ ] 2. 预期失败：`forNamespace("profile")` 抛 `no_reducer_for_namespace`。
- [ ] 3. 最小实现要点：`applyEvent` 三 action 分支——
  - `observe`：`contributions[key] = {seq, action, outcome, dimension, subject, targets, observedAt}`（从 `event.payload.event` 提取最小字段，不保留 evidence 全文）；
  - `supersede`/`invalidate`：目标必须存在且 active；`invalidate` 直接置 `inactive[target] = {by: key, action, seq}`；`supersede` 先写自身 contribution 再置目标 inactive；
  - 携带 correction 语义（payload 含 correction 目标 observedAt 对照）时执行 `Date.parse` 严格晚于校验，不通过抛 `stale_correction`；
  - `publicView`：active = contributions 中不在 inactive 的键；四桶分类与 `memberOf` 聚合按 `generic-profile-model.js:50-189` 逐字段移植（positive/negative/partial 计数、负证据重置 distinctPositiveSources、≥2 正源关闭弱点），全部从 `contributions/inactive` 重算。注册 `projectionName("profile") = "profile"`。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/reducers/generic-profile.js services/reliable-drive-sync-worker/src/rds2/reducers/index.js services/reliable-drive-sync-worker/test/rds2-reducer-generic-profile.test.js && git commit -m "feat(v2): generic profile reducer with minimal contributions and strict correction time"`。

### Task 2.12 interview Reducer（每 session 选中 review 的最小字段副本）

**Files:** Create `src/rds2/reducers/interview.js`；Test `test/rds2-reducer-interview.test.js`
**Interfaces:** Consumes Task 2.9；规则蓝本 `src/profile-model.js:24-104`（只读）
**Rev 4 修正：** state 从完整事件对象改为每 session 的**最小字段副本** `{seq, reviewVersion, statusOf, changeEvidence, domainProfiles, generalCompetencies}`（只保留 publicView 需要的字段），替换制天然有界：session 数 × 单 review 大小，不随历史增长。

- [ ] 1. 失败测试：
  ```js
  test("higher reviewVersion replaces the session selection and revokes old contributions", () => {
    // session s1: v1 open weakness W1 → v2 closed W1 → publicView 中 W1 为 closed 且 v1 evidenceRefs 消失
  });
  test("reviewVersion tie is broken by higher event_seq", () => { /* v2,seq=5 vs v2,seq=7 → seq7 胜 */ });
  test("applyProfileChanges=false events contribute identity binding only", () => { /* 不进聚合 */ });
  test("state keeps only the selected review per session (old version removed)", () => {
    // selectedBySession[s1] 的键集合恰为最小字段集；无 v1 残留
  });
  test("weakness closure rule: >=2 passing sessions and >=2 passing variants", () => { /* 对齐 profile-model.js:85-90 */ });
  test("state stays bounded: 200 sessions * 3 review versions < 256 KiB", () => { /* 替换制有界证明 */ });
  ```
- [ ] 2. 预期失败：`forNamespace("interview")` 抛 `no_reducer_for_namespace`。
- [ ] 3. 最小实现要点：state = `{selectedBySession: {}}`；`applyEvent` 仅处理 `interview.review.completed`；`const cur = state.selectedBySession[e.payload.event.sessionId]; if (!cur || reviewVersion(e) > reviewVersion(cur) || (reviewVersion(e) === reviewVersion(cur) && e.event_seq > cur.event_seq)) state = {...state, selectedBySession: {...state.selectedBySession, [sessionId]: minimalCopy(e)}};`；`minimalCopy(e)` 只提取 `statusOf/changeEvidence/domainProfiles/generalCompetencies/reviewVersion/seq`；`publicView` 只遍历 `selectedBySession`（旧版本贡献天然消失）。注册 `projectionName("interview") = "interview"`。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/reducers/interview.js services/reliable-drive-sync-worker/src/rds2/reducers/index.js services/reliable-drive-sync-worker/test/rds2-reducer-interview.test.js && git commit -m "feat(v2): interview reducer with bounded per-session selection"`。

### Task 2.13 resume-knowledge Reducer（当前 resumeVersion bank 替换制 + 评分索引）

**Files:** Create `src/rds2/reducers/resume-knowledge.js`；Test `test/rds2-reducer-resume-knowledge.test.js`
**Interfaces:** Consumes Task 2.9；规则蓝本 `src/resume-knowledge-model.js:88-123, 157-215`（只读）
**Rev 4 修正：** bank 选择从 Rev 3 的"取最低 seq 版本"改为**当前 resumeVersion bank**：按 `event_seq` 最新的 `resume-knowledge.question-bank-created` 事件**替换** `currentBank`（携带其 `resumeVersion`）；评分索引 `{scores}` 键为 `"<localDate>|<questionKey>"`，首见写入（最低 seq 胜出，防御同键重复）。

- [ ] 1. 失败测试：
  ```js
  test("latest bank event by seq replaces currentBank with its resumeVersion", () => {
    // bankA(resumeVersion v1, seq1) → bankB(v2, seq5) → state.currentBank.resumeVersion === 'v2'，questions 为 B 的
  });
  test("older bank arriving later never downgrades currentBank", () => {
    // seq 更小的 bank 事件后到 → currentBank 不变（seq 单调接收序下防御乱序回放）
  });
  test("first score per (localDate, questionKey) wins, later duplicates dropped defensively", () => {
    // 同键第二事件（seq 更大）→ scores 不变
  });
  test("same question scoreable again on next local date", () => { /* localDate 不同 → 两个键 */ });
  test("missing bank yields resume_required instead of guessing", () => { /* publicView.resumeRequired === true */ });
  test("coverage = tested/total per knowledge point from currentBank", () => {
    // bankB 替换后 coverage 按 B 的 questions 重算；bankA 的键不再计入
  });
  test("state stays minimal: bank questions keep only questionKey/knowledgePointId; scores keep outcome only", () => {
    // 300 事件（3 个 bank + 297 评分，问题池 50）→ stringify(state) < 256 KiB 且不含 evidence 全文
  });
  ```
- [ ] 2. 预期失败：`forNamespace("resume-knowledge")` 抛 `no_reducer_for_namespace`。
- [ ] 3. 最小实现要点：state = `{currentBank: null | {resumeVersion, bankSeq, questions: [{questionKey, knowledgePointId}]}, scores: {"<localDate>|<questionKey>": {seq, outcome}}}`；`applyEvent`：`question-bank-created` → 若 `event.event_seq > (state.currentBank?.bankSeq ?? -1)` 则替换 `currentBank`（最小字段副本）；`answer-scored` → 键 `localDate|questionKey` 已存在则丢弃，否则写入；`publicView`：无 bank → `resumeRequired: true`；有 bank → 移植 `rebuildResumeKnowledgeProfile` 的掌握度与 coverage 聚合（`resume-knowledge-model.js:142-153`），只统计当前 bank 的 questionKey。注册 `projectionName("resume-knowledge") = "resume-knowledge"`。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/reducers/resume-knowledge.js services/reliable-drive-sync-worker/src/rds2/reducers/index.js services/reliable-drive-sync-worker/test/rds2-reducer-resume-knowledge.test.js && git commit -m "feat(v2): resume knowledge reducer with current-version bank replacement"`。

### Task 2.14 引擎 2 MiB 上限集成断言（真实迁移 schema 下）

**Files:** Test `services/reliable-drive-sync-worker/test/rds2-state-limit.test.js`（复用 Task 2.7 引擎 + 子计划 1 迁移）
**Interfaces:** Consumes Task 2.7、子计划 1 sqlite-adapter + 迁移 0006

- [ ] 1. 失败测试：
  ```js
  test("engine routes oversized state to needs_attention before any batch write", async () => {
    // 真实迁移建库 + 注入桩 reducer（applyEvent 向 state 塞 3MiB 填充串）→ processTask
    // 断言：outbox 行 needs_attention / state_limit_exceeded；rds2_projections.cursor 不变；
    // rds2_archive_deliveries 计数 0；重放同 taskId（换回真实 reducer 语义的桩）仍走 needs_attention 直至人工介入
  });
  test("2 MiB boundary is exclusive: exactly-at-limit state still writes", async () => {
    // 填充至恰好 2*1024*1024 字节 → 正常 advanced（上限为超过才触发，规格写法"上限 2 MiB…超限时"）
  });
  ```
- [ ] 2. 预期失败：needs_attention 路径未接（Task 2.7 已实现则本测试为回归锁定，仍需先写并确认绿）。
- [ ] 3. `npm run test:worker` 预期 `# fail 0`。
- [ ] 4. 提交：`git add services/reliable-drive-sync-worker/test/rds2-state-limit.test.js && git commit -m "test(v2): state limit boundary integration assertions"`。

### Task 2.15 四域 fold/增量等价套件（子计划 2 完成门）

**Files:** Create `test/rds2-equivalence-algorithm.test.js`、`test/rds2-equivalence-generic-profile.test.js`、`test/rds2-equivalence-interview.test.js`、`test/rds2-equivalence-resume-knowledge.test.js`
**Interfaces:** Consumes Task 2.7/2.9–2.13
**Rev 4 修正：** 等价输入序列**每个 eventKey 必须唯一**（重复 eventKey 被 `idx_rds2_events_business_scope` 唯一索引拒绝，不能作为合法输入）；乱序指业务时间乱序（`observedAt` 与 `seq` 顺序相反）与迟到回填，而非重复 eventKey；Queue 重复投递语义由 Task 2.8 重复消息测试覆盖，与本套件分离。

- [ ] 1. 失败测试（四文件同一骨架，每域独立实例化）：
  ```js
  // 以 algorithm 为例；其余三域替换事件构造器
  for (const batchSize of [1, 3, 7, 10]) {
    test(`fold equals incremental with batch ${batchSize}`, async () => {
      const events = buildCanonicalEventSeries(); // 每域 12 个合法事件，eventKey 全唯一，
      // 含业务时间乱序（observedAt 与 seq 反序）、迟到回填、同 session 多版本 review、多 bank 替换
      const folded = foldAll(reducer, events, identity);
      const incremental = await runIncremental(engine, events, batchSize); // 分批 accept + processTask
      assert.deepEqual(incremental.publicView, folded);
      assert.equal(incremental.lastEventSeq, events.at(-1).event_seq);
    });
  }
  test("out-of-order arrival converges to seq order (business time is not the fold key)", async () => {
    // observedAt 反序的两事件：V2 结果按 seq 折叠，测试注明这是 Rev 2/3/4 锁定的 V2 排序语义，非缺陷
  });
  test("every input eventKey is unique (DB unique index would reject duplicates)", () => {
    // 构造器自检：new Set(eventKeys).size === eventKeys.length，否则测试自身 fail
  });
  ```
  `runIncremental(engine, events, batchSize)` 为测试文件内联助手：按批调用 accept-service + engine.processTask（复用子计划 1 助手）。
- [ ] 2. 预期失败：若任一 Reducer 违反等价（publicView 依赖 seq 之外的输入），对应断言 fail——修复在对应 Reducer 文件内进行，必须以独立 commit 落地，消息按域取：`fix(v2): restore fold equivalence for algorithm|generic-profile|interview|resume-knowledge`，禁止笼统提交。
- [ ] 3. 全部通过后：`npm run test:worker` 预期 `# fail 0`；`npm run test:bridge` 预期 `# fail 0`。
- [ ] 4. 提交：`git add services/reliable-drive-sync-worker/test/rds2-equivalence-algorithm.test.js services/reliable-drive-sync-worker/test/rds2-equivalence-generic-profile.test.js services/reliable-drive-sync-worker/test/rds2-equivalence-interview.test.js services/reliable-drive-sync-worker/test/rds2-equivalence-resume-knowledge.test.js && git commit -m "test(v2): four-domain fold and incremental equivalence suites"`。

## 覆盖与自检（子计划 2 完成门）

- [ ] 规格映射：§13 全条（2.2–2.6/2.8，含两条必测链路）、§12 全条（2.7/2.9–2.15：五组操作、精确 taskId、最小充分状态、2 MiB、等价语义）、§11 本地 Outbox 对照项归子计划 4、§15.1 预算器接口（2.1）、§15.2 独立 cron（2.4）、§16 失败恢复表（2.7/2.8/2.15）。
- [ ] `grep -rn "BETWEEN" services/reliable-drive-sync-worker/src/rds2/` 零命中。
- [ ] `grep -rn "Promise.all" services/reliable-drive-sync-worker/src/rds2/recovery.js services/reliable-drive-sync-worker/src/rds2/dispatcher-v2.js` 零命中。
- [ ] `grep -rn "displayName" services/reliable-drive-sync-worker/src/rds2/` 零命中。
- [ ] `grep -rn "queue_message_id" services/reliable-drive-sync-worker/src/rds2/` 仅命中列定义与建表 SQL，无业务读写。
- [ ] `grep -rn "accepted" services/reliable-drive-sync-worker/src/rds2/reducers/` 零命中（禁止完整事件数组回归）。
- [ ] 四队列消费者齐备（Task 2.5 测试锁定）；crons 前三项逐字节保留（Task 2.4 测试锁定）。
- [ ] Task 2.3/2.4/2.8 三个测试文件均含并发或重复发布路径断言（复审第 2 条：不存在"不产生重复发布"的测试）。
- [ ] `grep -rn "TODO\|TBD\|同上\|参考前文\|必要修复\|<tmp>\|<skill>" services/reliable-drive-sync-worker/src/rds2/ services/reliable-drive-sync-worker/test/rds2-*.test.js` 零命中。
