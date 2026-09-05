# RDS2 Queue State Machine, Projection Transactions and Minimal-Sufficient Reducers Implementation Plan — Revision 5

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 Codex 四审意见 1/7/8/11 在本子计划范围内的全部修正：① 预算器 `consume` 增加**总量检查**（单类别通过 + 全类别合计 ≤ 上限才放行，错误码 `subrequest_budget_exceeded`）；② 首次投影启动链路（`emptyProjection(identity)` 为唯一合法初始状态、两处 `await deterministicDeliveryId`、下一唤醒按 `(user_id, namespace)` 作用域派生、`publicView` 回填 `userId/username`）；③ Queue 消费者统一 batch 级 `(batch, env, ctx)` 签名、全部唤醒经 Dispatcher 同一 `.run()` 入口、重试阈值接线进 Dispatcher；④ 四域 Reducer 字段级映射表与模型源码逐字段对齐 + 数组型状态容量上限。

**Architecture:** 与 Rev 4 相同（Dispatcher 原子自认领 → `queueIo.sendWake` → `markQueued`；投影单 D1 batch 五组操作；四域最小充分状态 Reducer；V2 独立 cron invocation）。Rev 5 不改架构，只修正实现契约：Dispatcher 改为返回 `{ run(taskId) }` 对象供接收唤醒、引擎续批唤醒与恢复器三方共用；Reducer 契约方法 `emptyState()` 更名为 `emptyProjection(identity)` 并播种 `state.identity`。

**Tech Stack:** Cloudflare Queues（producers + 4 consumers）、D1 batch、Node test runner、`node:sqlite` 适配器（子计划 1 Rev 5）、Miniflare。

**Spec:** 规格 Rev 5：§12（首次启动规则 + 四域字段级最小充分状态 + 数组容量上限 + 2 MiB）、§13（batch 级消费者签名 + 唤醒经 Dispatcher + 阈值接线）、§15.1（consume 双检查 + `subrequest_budget_exceeded`）、§7.2（初始投影行 NULL `state_json/public_view_json`）。

## Rev 5 相对 Rev 4 的关键修正（Codex 四审意见 1/7/8/11，逐项：修订位置 / 具体失败样本 / 预期行为）

| 意见 | 修订位置 | 具体失败样本（Rev 4 实际行为） | 预期行为（Rev 5） |
|---|---|---|---|
| 1 预算 | Task 2.1 `consume` | `createSubrequestBudget({limit:40})`；`consume("d1",35)` 成功后 `consume("queue",10)`：Rev 4 只查单类别（`10 ≤ 40` 通过），合计 45 被放行，业务硬上限 40 被静默突破；错误码 `budget_exceeded` 与规格不符 | `consume` 必须同时通过两项检查才放行：类别扣减后不超 limit **且**全类别合计（含本次 count）不超 limit；合计超限抛 `subrequest_budget_exceeded:total`，失败样本断言合计停在 35、`snapshotByCategory().queue === 0` |
| 7 首次投影 | Task 2.7 引擎、Task 2.9 契约、Task 2.8 装配 | ① 身份初始化写入 NULL `state_json` 初始行（§7.2/§17），Rev 4 引擎 `JSON.parse(projection.state_json \|\| "{}")` 得到 `{}`，algorithm `applyEvent` 读 `state.byEventKey[key]` 抛 `TypeError: Cannot read properties of undefined (reading 'byEventKey')`，任务永久重试；② `deterministicDeliveryId(artifactKey)` 两处未 `await`（Rev 4 第 462/468 行），绑定值为 Promise 对象，D1 绑定失败或落库 `"[object Promise]"`；③ 用户 A 事件 seq 1–10、用户 B 事件 seq 11、用户 A 事件 seq 12：A 推进到 10 后 Rev 4 `wakeNext("t_project_11")` 唤醒的是 **B 的任务**（跨用户），A 的 seq 12 无人唤醒；④ Rev 4 algorithm `publicView` 直接输出 `userId: null` 并注释"由调用方注入"——没有任何调用方实现注入 | ① 投影行缺失或 `state_json` 为 NULL 时必须 `reducer.emptyProjection(identity)`，禁止 `{}` 字面量进入 `applyEvent`；② 两处 `await deterministicDeliveryId(...)`，测试锁定 `/^[0-9a-f]{32}$/`；③ 下一唤醒 taskId 按 `(user_id, namespace)` 查询 `event_seq > lastSeq` 的第一行派生，禁止 `lastSeq + 1` 全局连续性假设；④ `emptyProjection(identity)` 播种 `state.identity = {userId, username}`，`publicView` 回填 `userId/username`，引擎写库前断言 `publicView.userId != null`（违规抛 `public_view_identity_missing`，不得静默补丁） |
| 8 消费者统一 | Task 2.3/2.4/2.5/2.6/2.8 | ① Task 2.8 装配 `wakeNext = (taskId, type) => queueIo.sendWake(taskId, type, 0)`：引擎续批唤醒绕过 Outbox 状态机（无 `claimOne`/`markQueued`），被唤醒行停留 `pending`，陈旧 `queued` 回收与去重语义对其失效；② Task 2.5 投影处理器为逐消息 `(body, message)` 形态，归档侧（§14）为 batch 级——两种 handler 形态并存；③ 阈值转移只存在于 Task 2.4 测试注释：dispatcher send 失败走 `releaseLease` 后无任何调用方触发 `failWithBackoff`，`attempt_count >= 5` 的行永远退避重试，无人转 `needs_attention` | ① 全部唤醒（接收后即时唤醒、引擎续批唤醒、恢复器补唤醒）一律经 `dispatcher.run(taskId)`；② 四个队列处理器统一 batch 级 `async (batch, env, ctx)` 签名，单入口按 `batch.queue` 路由，投影侧与归档侧形态一致；③ dispatcher send 失败改走 `failWithBackoff`（子计划 1 已有阈值逻辑）：`attempt_count` 达 `RETRY_THRESHOLD=5` → `needs_attention`，返回 `{outcome:"needs_attention"}`；DLQ 消费者 batch 级循环内逐消息 `toNeedsAttention("dlq_exhausted")`；恢复器复用 `dispatcher.run()` 只替换任务来源 |
| 11 字段级映射 | Task 2.9/2.10/2.11/2.12/2.13 | Rev 4 四域状态与模型事实不符：algorithm `topicAgg` 缺 `lastObservedAt`/`eventKeys`（`algorithm-profile-model.js:40-42` 为八字段），`latestByProblem` 只在 `publicView` 临时推导而非状态；generic-profile 按单条 observation 设计（模型事实：`event.observations[]` 多条目，`generic-profile-contract.js:47-59` 每条固定六字段）；interview 选中副本字段为 `{statusOf, changeEvidence, domainProfiles, generalCompetencies}`（规格事实：最小副本为 `completedAt/evidenceConfidence/applyProfileChanges/profileChanges`，`profileChanges` 八字段边界后 `statusOf` 有效输入只有 `outcome`）；resume 评分记录只存 `{seq, outcome}`（模型事实：`total` + `feedback.issues/issueCategories`，`resume-knowledge-model.js:230-248`，mastery 混合 `0.6·new + 0.4·prev`） | 每域 Reducer 任务内建**字段级映射表**（payload 字段 → 状态位置 → publicView 派生），状态形状与模型源码逐字段对齐；数组型状态字段设每键容量上限，写入前断言，超限抛 `state_limit_exceeded:<域>.<字段>`（引擎捕获转 `needs_attention`），不得静默截断 |

**任务处置清单：**

- **整体替换（13 个）：** Task 2.1（意见 1）、Task 2.3/2.4/2.5/2.6/2.8（意见 8）、Task 2.7/2.9（意见 7）、Task 2.10/2.11/2.12/2.13（意见 11）、Task 2.15（意见 7/11 断言增补）。
- **逐字继承（1 个）：** Task 2.2（queue-io 预算化发送封装——`consume` 调用形态不变；其测试正则 `/budget_exceeded/` 仍匹配新错误码 `subrequest_budget_exceeded`）。
- **适配继承（1 个）：** Task 2.14（2 MiB 集成断言）——测试意图、文件清单、提交消息逐字继承；仅桩 Reducer 方法名随 Task 2.9 契约由 `emptyState` 改为 `emptyProjection`，不视为新任务。

## Global Constraints

- 前置门 G0（主索引）：先确认 worktree 状态；本计划残留经用户确认后处理；用户未跟踪文件不删不改不提交。
- 受保护路径（本计划全部 Task 禁改）：`migrations/0005_schema12_jobs.sql`、`src/ingress.js`、`src/dispatcher.js`、`src/sync.js`、`src/event-store.js`、`src/qstash.js`、`src/reconciler.js`、所有 V1 store/model、`tools/reliable-drive-sync-mcp/local-outbox.mjs`、`tools/reliable-drive-sync-mcp/delivery-service.mjs`、`src/protocol.js`（只读）。
- **V1 cron 逐字节保留**：`wrangler.toml` 的 `crons = ["*/5 * * * *", "0 * * * *", "0 */6 * * *"]` 前三项字符不变（仅追加第四项）；`src/index.js` 的 V1 `scheduled` 逻辑保持原样。
- **D1 契约（全子计划强制，同子计划 1 Rev 5）**：全部调用 async/await；`all()` 返回 `{results:[...]}` 必须显式解包；影响行数判定一律 `res.meta.changes`；`batch()` 入参只允许 `prepare(sql).bind(...)` 语句对象；禁止 `res.changes`；所有 sha256 派生函数（含 `deterministicDeliveryId`）必须 `await`。
- **状态机禁令**：禁止断言或实现"同一 taskId 不重复发布"；禁止业务路径读写 `queue_message_id`；禁止 `event_seq BETWEEN` 完成任务；禁止在 `db.batch()` 之外执行归档冻结写；Reducer `state_json` 禁止保存完整事件数组；**禁止引擎或任何处理器绕过 Dispatcher 直接 `Queue.send()`/`queueIo.sendWake`**（唯一例外：dispatcher 自身）。
- **首次启动禁令**：禁止把 `{}` 或其他临时字面量作为 Reducer 初始状态；初始状态只能来自 `reducer.emptyProjection(identity)`。
- **公开视图禁令**：任何路径不得输出 `userId: null` 的 `publicView`；Reducer 状态不得保存 `evidence` 全文（profile 域 observations 最小表示不含 evidence）。
- 修改子计划 1 产物时，`git add` 必须同时包含源文件与其测试文件的追加 diff。
- 所有测试命令在 worktree `C:\Users\27846\my-chatgpt-mcp-v2` 执行；每 Task 结束 `git status --short` 只允许出现该 Task 文件清单。
- 提交规范：`git add` 只加本 Task 文件；消息前缀 `feat(v2):`/`test(v2):`/`fix(v2):`；禁止 `git add -A`、`reset --hard`、`checkout --`、`stash drop`。
- 每 Task 回滚：`git revert <task_sha>`。

## Interfaces

- **Consumes**：子计划 1 Rev 5 全部 Produces（`shared/rds2-protocol.mjs` 的 `canonicalJson/sha256Hex/ALLOWED_EVENT_TYPES`、六仓库——outbox 的 `claimOne/claimDue/markQueued/complete/failWithBackoff/toNeedsAttention/releaseLease/byTaskId/reclaimExpired/reclaimStaleQueued`（`failWithBackoff` 内置 `RETRY_THRESHOLD=5` 与 `BACKOFF_MS=[30s,60s,120s,300s,600s]`）、projection 的 `get/upsert/updateAdvanced`、archive-delivery 的 **`async` `deterministicDeliveryId`**（返回 32 hex）/`freezeRows`、event 的 `readAfter`、`accept-service`、`sqlite-adapter`、Miniflare 助手模式）。
- **Produces**：`src/rds2/subrequest-budget.js` 导出 `createSubrequestBudget(options)` → `{remaining, consume, assertWithinLimit, snapshotByCategory}`；`src/rds2/queue-io.js` 导出 `createQueueIo(budget, bindings)`（继承 Rev 4）；`src/rds2/dispatcher-v2.js` 导出 `createDispatcher(deps)` → **`{ run(taskId) }`**；`src/rds2/recovery.js` 导出 `createRecovery(db, deps)` → `{ run() }`；`src/rds2/queue-consumer.js` 导出 `createQueueHandler(processors)`；`src/rds2/dlq-consumer.js` 导出 `createDlqBatchProcessor(db, deps)`；`src/rds2/projection-engine.js` 导出 `createProjectionEngine(db, deps)`；`src/rds2/reducer-contract.js` 导出 `assertReducer`；`src/rds2/fold-all.js` 导出 `foldAll`；`src/rds2/reducers/index.js` 导出 `createReducerRegistry()`；四域 Reducer 各导出 `{name, emptyProjection, applyEvent, publicView}`；`outbox-repository` 追加 `listDue(limit, now)`；`wrangler.toml` crons 追加 `2-57/5 * * * *`；`src/index.js` scheduled 分流 + queue 方法。

---

### Task 2.1 SubrequestBudget 最小实现（§15.1 接口，consume 双检查）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/subrequest-budget.js`；Test `services/reliable-drive-sync-worker/test/rds2-subrequest-budget.test.js`
**Interfaces:** Produces `createSubrequestBudget` | Consumes 无（子计划 3 消费并扩展全通道封装）
**意见 1 修订：** `consume` 从"只查单类别余量"重写为**双检查**（类别扣减后不超 limit 且全类别合计不超 limit）；错误码 `budget_exceeded` 更名为 `subrequest_budget_exceeded`。

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
  test("per-category overflow throws subrequest_budget_exceeded", () => {
    const b = createSubrequestBudget({ limit: 40 });
    assert.throws(() => b.consume("d1", 41), /subrequest_budget_exceeded/);
  });
  test("意见1 失败样本：单类别通过但合计超限时必须拒绝", () => {
    const b = createSubrequestBudget({ limit: 40 });
    b.consume("d1", 35);
    // Rev 4 只查单类别：queue 10 <= 40 会错误放行，合计 45 突破硬上限
    assert.throws(() => b.consume("queue", 10), /subrequest_budget_exceeded:total/);
    const snap = b.snapshotByCategory();
    assert.equal(snap.queue, 0);            // 拒绝不得产生部分记账
    assert.equal(snap.total, 35);
    assert.equal(b.remaining(), 5);
  });
  test("total exactly at limit passes, one more fails", () => {
    const b = createSubrequestBudget({ limit: 40 });
    b.consume("d1", 30); b.consume("queue", 9); b.consume("drive_list", 1);   // 合计 40，放行
    assert.equal(b.remaining(), 0);
    assert.throws(() => b.consume("fetch_other"), /subrequest_budget_exceeded:total/);
  });
  test("hard stop: assertWithinLimit at limit throws subrequest_budget_exceeded", () => {
    const b = createSubrequestBudget({ limit: 40 });
    for (let i = 0; i < 40; i++) b.consume("d1");
    assert.throws(() => b.consume("d1"), /subrequest_budget_exceeded/);
    assert.throws(() => b.assertWithinLimit(), /subrequest_budget_exceeded/);
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
    b.consume("d1", 10);
    assert.throws(() => b.consume("queue", 6), /subrequest_budget_exceeded:total/);
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
        if (typeof count !== "number" || !Number.isInteger(count) || count < 1) throw new Error("invalid_budget_count");
        if (used[category] + count > limit) throw new Error(`subrequest_budget_exceeded:${category}`);   // 检查一：类别
        if (total() + count > limit) throw new Error("subrequest_budget_exceeded:total");               // 检查二：合计（意见 1）
        used[category] += count;
      },
      assertWithinLimit() { if (total() >= limit) throw new Error("subrequest_budget_exceeded"); },
      snapshotByCategory: () => ({ ...used, total: total(), limit })
    };
  }
  ```
  注：本实现是 §15.1 "预算器至少提供"的最小形态；`budgetD1/budgetQueue/budgetDrive/budgetFetch` 依赖封装由子计划 3 Task 3.2 在本文件之上扩展，不回改本接口。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/subrequest-budget.js services/reliable-drive-sync-worker/test/rds2-subrequest-budget.test.js && git commit -m "feat(v2): subrequest budget with dual per-category and total checks"`。

### Task 2.2 Queue 消息契约与预算化发送封装（逐字继承 Rev 4）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/queue-io.js`；Test `services/reliable-drive-sync-worker/test/rds2-queue-io.test.js`
**Interfaces:** Produces `createQueueIo` | Consumes Task 2.1

- [ ] 逐字继承 Rev 4 Task 2.2 全部步骤（消息体 `{taskId, taskType, attempt}`、consume 先于 send、预算耗尽中止发送）。其测试正则 `/budget_exceeded/` 仍匹配 `subrequest_budget_exceeded`，无需改动。
- [ ] 提交消息不变：`feat(v2): budgeted queue io with fixed message body`。

### Task 2.3 Dispatcher 六条规则（`{ run() }` 对象 + 阈值接线进 send 失败路径）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/dispatcher-v2.js`；Test `services/reliable-drive-sync-worker/test/rds2-dispatcher-v2.test.js`
**Interfaces:** Produces `createDispatcher(deps)` → **`{ run(taskId) }`** | Consumes Task 2.2、子计划 1 outbox-repository（`claimOne/markQueued/failWithBackoff/byTaskId`）
**规则映射（规格 §13）:** ① 自原子认领 `pending` ② 只发送成功置 `dispatching` 的任务 ③ 发布成功置 `queued` + `queued_at`（`queue_message_id` 保持 NULL）④ `markQueued` 只接 `dispatching`，对 `queued` 重放**不调用它** ⑤ send 失败走 `failWithBackoff`（释放租约 + 退避 `available_at`；**阈值接线：`attempt_count` 达 `RETRY_THRESHOLD=5` 转 `needs_attention`**）⑥ 影响行数 `meta.changes` 判定；对 `processing/needs_attention/completed` 行显式拒绝（`illegal_state_transition`）。
**意见 8 修订：** ① 返回从裸函数改为 `{ run(taskId) }` 对象——接收唤醒、引擎续批唤醒、恢复器三方共用同一入口；② 规则⑤ 从 `releaseLease(taskId, code)` 改为 `failWithBackoff(taskId, "queue_send_failed")`——阈值转移在 Dispatcher 内完成接线，不再只写在文档。

- [ ] 1. 失败测试（六条规则逐条 + 重复发布容忍 + 阈值接线）：
  ```js
  test("rule1+2: dispatcher claims the task itself and only sends the dispatching row", async () => {
    // 预置 pending 任务 t_project_1；run 后：行 state='queued'、lease_owner=NULL、queue_message_id IS NULL
    // 断言 sendWake 恰被调用一次、attempt 取自认领后的行
  });
  test("rule1: concurrent run of same taskId sends at most once", async () => {
    // 两个 dispatcher（同一 adapter 或注入第二个 adapter 指向同一 sqlite 文件）并发 run("t_project_1")
    // 恰一个返回 {outcome:"queued"}，另一个返回 claim 失败路径（不 send、不抛错）
  });
  test("rule3: markQueued writes queued_at and leaves queue_message_id NULL", async () => {
    // run 成功后断言 queued_at 非空且 <= now、queue_message_id IS NULL
  });
  test("rule4: re-run of queued row does NOT call markQueued again", async () => {
    // 对已 queued 行再次 run → {outcome:"requeued_idempotent"}，不 send；queued_at 未变化
  });
  test("rule5: send failure releases lease and sets backoff available_at via failWithBackoff", async () => {
    // queueIo.sendWake 抛错 → 行 state='pending'、available_at > now、last_error_code='queue_send_failed'
    // 返回 {outcome:"send_failed"}
  });
  test("意见8 阈值接线：attempt_count 达 5 时 send 失败转 needs_attention", async () => {
    // 预置 pending 任务 attempt_count=4 → run：claimOne 递增为 5 → sendWake 注入失败
    // → failWithBackoff 判定 5 >= RETRY_THRESHOLD → 行 state='needs_attention'、
    //   last_error_code='queue_send_failed'、lease_owner=NULL
    // → 返回 {outcome:"needs_attention"}；sendWake 恰调用 1 次
  });
  test("rule6: dispatching processing/needs_attention/completed rows is rejected", async () => {
    // 预置三行分别为 processing/needs_attention/completed → run 各返回
    // {outcome:"illegal_state_transition", state}，sendWake 未被调用，行状态不变
  });
  test("send success + markQueued failure leaves dispatching row under lease (no silent success)", async () => {
    // 注入 markQueued 抛 illegal_state_transition：run 返回 {outcome:"reconcile_needed"}，
    // 行保持 state='dispatching' 且租约未清；同一 taskId 再次 run：
    // claimOne 对 dispatching 行返回 null → {outcome:"noop"}（不重复 send，等租约过期回收）
  });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  export function createDispatcher(deps) {
    const { outbox, queueIo } = deps;
    return {
      async run(taskId) {
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
          const settled = await outbox.failWithBackoff(taskId, "queue_send_failed"); // 规则⑤ + 阈值接线（意见 8）
          return { outcome: settled === "needs_attention" ? "needs_attention" : "send_failed" };
        }
        try {
          await outbox.markQueued(taskId); // 规则③：只接 dispatching，meta.changes 判定
          return { outcome: "queued" };
        } catch (cause) {
          return { outcome: "reconcile_needed" }; // 发送成功、回写失败：租约保留，行留 dispatching
        }
      }
    };
  }
  ```
  （`outbox.failWithBackoff` 为子计划 1 Rev 5 已有方法：`attempt_count >= RETRY_THRESHOLD` → `needs_attention`，否则 `pending` + 退避 `available_at` + 清租约，内部 `meta.changes` 判定。）
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/dispatcher-v2.js services/reliable-drive-sync-worker/test/rds2-dispatcher-v2.test.js && git commit -m "feat(v2): dispatcher run entry with threshold wired into send-failure path"`。

### Task 2.4 V2 独立 cron invocation 与有界恢复器（复用 `dispatcher.run`，含陈旧 queued 回收）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/recovery.js`；Modify `services/reliable-drive-sync-worker/src/index.js`（`scheduled()` 按 `controller.cron` 分流，V1 代码路径逐字节保留）、`services/reliable-drive-sync-worker/wrangler.toml`（crons 追加第四项）、`services/reliable-drive-sync-worker/src/rds2/outbox-repository.js`（追加只读 `listDue`）；Test `services/reliable-drive-sync-worker/test/rds2-recovery.test.js`、`services/reliable-drive-sync-worker/test/rds2-cron-coexistence.test.js`
**Interfaces:** Produces `createRecovery(db, deps)` → `{ run() }`、`buildScheduledHandler`（测试导出） | Consumes Task 2.1/2.3、outbox-repository
**规格依据（§15.2/§13）:** `crons` 前三项逐字节保留，追加 `"2-57/5 * * * *"`；V2 恢复器预算 15；**恢复器只列出到期 taskId，发布一律复用 `dispatcher.run()` 同一入口（只替换任务来源）**。
**意见 8 修订：** Rev 4 `for (const taskId of due) await dispatcher(taskId)`（裸函数调用）改为 `await dispatcher.run(taskId)`；阈值端到端断言从注释改写为可执行测试。

- [ ] 1. 失败测试（recovery）：
  ```js
  test("recovery reclaims expired leases, stale queued rows, then dispatches due tasks via dispatcher.run", async () => {
    // 预置：租约过期 processing 行 A、queued_at 早于 now-10min 的行 B、queued_at 新鲜的行 C、
    //       available_at 到期的 pending 行 D、未到期 pending 行 E
    // 注入 dispatcher spy（{ run: async (taskId) => calls.push(taskId) }）
    // run() 后：A、B 复位 pending；C 不动；spy.run 恰以 D 调用一次；E 不动
  });
  test("stale queued reclaim uses queued_at <= now-10min boundary", async () => {
    // queued_at = now-9min59s → 不复位；queued_at = now-10min → 复位（含边界）
  });
  test("recovery is bounded: at most 4 dispatcher.run calls, no Promise.all", async () => {
    // 预置 8 个到期任务 → run() 只 run 4 个（listDue(4)）；其余留给下次
    const src = readFileSync(new URL("../src/rds2/recovery.js", import.meta.url), "utf8");
    assert.ok(!src.includes("Promise.all"), "recovery must not fan out concurrently");
  });
  test("v2 invocation budget stays within 15 (d1 + queue counted)", async () => {
    // 预置 4 个到期任务全部 dispatch 成功 → budget.snapshotByCategory():
    // d1 = 3 (reclaimExpired + reclaimStaleQueued + listDue) + 4×2 (claimOne + markQueued) = 11，
    // queue = 4，total = 15 <= 15（预算证明的 total 直接来自 snapshotByCategory 合计）
  });
  test("意见8 端到端：attempt_count=4 的到期任务 send 失败后转 needs_attention", async () => {
    // 预置到期 pending 行 attempt_count=4；真实 dispatcher + 注入 sendWake 失败
    // recovery.run() → dispatcher.run → claimOne 递增为 5 → send 失败 → failWithBackoff
    // → 行 state='needs_attention'、last_error_code='queue_send_failed'；{ processed: 1 }
  });
  ```
- [ ] 2. 失败测试（coexistence——独立 invocation 证明，逐字继承 Rev 4）：
  ```js
  test("v1 crons route to v1 logic and never run v2 recovery", async () => { /* 同 Rev 4 */ });
  test("v2 cron 2-57/5 routes to recovery only and v1 logic is untouched", async () => { /* 同 Rev 4 */ });
  test("v2 recovery failure is contained inside its own invocation", async () => { /* 同 Rev 4 */ });
  test("wrangler.toml keeps v1 crons byte-identical and appends the v2 expression", () => { /* 同 Rev 4 */ });
  ```
- [ ] 3. 预期失败：模块不存在 / crons 未追加。
- [ ] 4. 实现 recovery：
  ```js
  export function createRecovery(db, { outbox, dispatcher, budget }) {
    return {
      async run() {
        budget.consume("d1", 1);
        await outbox.reclaimExpired();
        budget.consume("d1", 1);
        await outbox.reclaimStaleQueued(); // 陈旧 queued 回收：queued_at <= now-10min → pending
        budget.consume("d1", 1);
        const due = await outbox.listDue(4); // 只读列出（不认领），认领权归 dispatcher；
        // 4 = floor((15 - 3 固定 reclaim) / 3 每任务)，保证最坏路径 total === 15 不破预算
        for (const taskId of due) await dispatcher.run(taskId);   // 意见 8：复用 Dispatcher 同一 .run() 入口
        return { processed: due.length };
      }
    };
  }
  ```
  `outbox.listDue(limit, now)`：`SELECT task_id FROM rds2_event_outbox WHERE state='pending' AND available_at <= ? ORDER BY available_at LIMIT ?`（只读，追加到子计划 1 仓库 + 测试，`all()` 后 `{results}` 解包）。
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
- [ ] 8. 提交：`git add services/reliable-drive-sync-worker/src/rds2/recovery.js services/reliable-drive-sync-worker/src/rds2/outbox-repository.js services/reliable-drive-sync-worker/src/index.js services/reliable-drive-sync-worker/wrangler.toml services/reliable-drive-sync-worker/test/rds2-recovery.test.js services/reliable-drive-sync-worker/test/rds2-cron-coexistence.test.js services/reliable-drive-sync-worker/test/rds2-outbox-repository.test.js && git commit -m "feat(v2): dedicated v2 cron recovery reusing dispatcher run entry"`。

### Task 2.5 Queue handler 统一 batch 级签名 + 四队列 TOML + handler 根部预算器

**Files:** Modify `services/reliable-drive-sync-worker/src/index.js`（default export 与 `createWorker` 各追加 queue 方法）、`services/reliable-drive-sync-worker/wrangler.toml`（追加 producers/consumers 块）；Create `src/rds2/queue-consumer.js`；Test `services/reliable-drive-sync-worker/test/rds2-queue-consumer.test.js`
**Interfaces:** Produces `createQueueHandler(processors)` | Consumes Task 2.1
**规格依据（§13）:** 消费者签名统一为 batch 级 `async queue(batch, env, ctx)`：单入口按 `batch.queue` 路由到投影、归档或 DLQ 处理器，**所有处理器共享同一签名与预算器构造方式**。
**意见 8 修订：** Rev 4 处理器为逐消息 `(body, message)` 形态（与 §14 归档侧 batch 级形态并存），重写为四键全部是 `async (batch, env, ctx)` 的 batch 级处理器。

- [ ] 1. 失败测试：
  ```js
  test("createWorker exposes queue handler and routes by batch.queue", async () => {
    const handled = [];
    const worker = createWorker(fakeEnv, { processors: {
      "rds2-project": async (batch) => handled.push(["project", batch.messages.length]),
      "rds2-archive": async (batch) => handled.push(["archive", batch.messages.length]),
      "rds2-project-dlq": async (batch) => handled.push(["project-dlq", batch.messages.length]),
      "rds2-archive-dlq": async (batch) => handled.push(["archive-dlq", batch.messages.length]) } });
    const message = (queue, taskId, taskType) => ({ queue, body: { taskId, taskType, attempt: 1 }, ack() {}, retry() { throw new Error("retry-unexpected"); } });
    await worker.queue({ queue: "rds2-project", messages: [message("rds2-project", "t_project_1", "project_event")] }, fakeEnv, { waitUntil() {} });
    assert.deepEqual(handled, [["project", 1]]);
  });
  test("all four processors receive the whole batch with unified (batch, env, ctx) signature", async () => {
    // 注入签名采集处理器：断言每个处理器收到的第 1 参带 .messages 数组、第 2 参为 env、第 3 参为 ctx
    // 投影侧与归档侧形态一致（意见 8：禁止一个逐消息、一个按 batch）
  });
  test("queue handler creates exactly one budget at the root and the same instance reaches processors", async () => {
    // 注入收集型处理器：两条消息连续处理收到同一 budget 实例（§15.1 invocation 根部单预算器）
  });
  test("processor failure surfaces so the batch is retried (no swallow)", async () => {
    // 处理器抛错 → worker.queue rejects（不吞错）
  });
  test("unknown queue name rejects with unhandled_queue", async () => {
    // batch.queue = "rds2-unknown" → rejects /unhandled_queue/
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
  export function createQueueHandler(processors) {
    return async function queue(batch, env, ctx) {
      const processor = processors[batch.queue];
      if (!processor) throw new Error(`unhandled_queue:${batch.queue}`);
      await processor(batch, env, ctx);   // 统一 batch 级签名（意见 8）
    };
  }
  ```
- [ ] 4. `wrangler.toml` 追加（逐行书写，置于文件末尾，V1 内容与 Task 2.4 的 crons 行不动）：四队列 producers/consumers 块与 Rev 4 相同（`rds2-project` max_batch_size=10、`rds2-archive` max_batch_size=8、两 DLQ 消费者，`dead_letter_queue` 各指向对应 DLQ，`max_retries=5`/`3`）。
- [ ] 5. `src/index.js` default export 追加 `queue(batch, env, context) { return createWorker(env).queue(batch, env, context); }`；`createWorker` 返回对象追加 `queue: createQueueHandler(buildProcessors(env, createSubrequestBudget({ limit: 40 })))`——根部单预算器；`buildProcessors` 本 Task 先注册四个 **batch 级**空处理器骨架（`async (batch) => { for (const m of batch.messages) m.ack(); }`），Task 2.6/2.8 与子计划 3 替换为真实现。
- [ ] 6. 验证：`npm run test:worker` 预期 `# fail 0`；`npx --yes wrangler deploy --config services/reliable-drive-sync-worker/wrangler.toml --dry-run --outdir "$PWD/services/reliable-drive-sync-worker/tmp-dryrun-t25"` 退出码 0，随后删除该目录。
- [ ] 7. 提交：`git add services/reliable-drive-sync-worker/src/index.js services/reliable-drive-sync-worker/src/rds2/queue-consumer.js services/reliable-drive-sync-worker/wrangler.toml services/reliable-drive-sync-worker/test/rds2-queue-consumer.test.js && git commit -m "feat(v2): unified batch-level queue handler with root budget and four consumers"`。

### Task 2.6 DLQ 消费者：batch 级按 taskId 置 needs_attention

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/dlq-consumer.js`；Modify `src/index.js`（`buildProcessors` 两个 DLQ 键替换为真实现）；Test `services/reliable-drive-sync-worker/test/rds2-dlq.test.js`
**Interfaces:** Produces `createDlqBatchProcessor(db, deps)` → `async (batch, env, ctx)` | Consumes outbox-repository
**意见 8 修订：** 从逐消息 `process(body)` 重写为 batch 级处理器（与投影/归档形态统一）；逐消息语义（unknown_task ack、completed noop、`dlq_exhausted`）保留在循环体内。

- [ ] 1. 失败测试：
  ```js
  test("batch with known tasks sets needs_attention and acks every message", async () => {
    // 消息 [{taskId:"t_project_1"},{taskId:"t_project_2"}]（均预置 queued）
    // → 两行 state='needs_attention'、last_error_code='dlq_exhausted'；两次 ack
  });
  test("unknown taskId is acked without throwing (no DLQ loop)", async () => {
    // 未知 taskId → 不抛错、ack、返回统计 {needs_attention:0, unknown:1, noop:0}
  });
  test("completed task stays completed and is acked", async () => { /* noop */ });
  test("mixed batch: known + unknown + completed in one batch", async () => { /* 三态各一，全部 ack */ });
  test("兜底通道：DLQ processor 抛错不影响 recovery 路径的 needs_attention 转移", async () => {
    // recovery 的 reclaimExpired + dispatcher.run + failWithBackoff 把长期 queued/processing 行转 needs_attention
  });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 实现：
  ```js
  export function createDlqBatchProcessor(db, { outbox }) {
    return async function processBatch(batch) {
      let needsAttention = 0, unknown = 0, noop = 0;
      for (const message of batch.messages) {
        const task = await outbox.byTaskId(message.body.taskId);
        if (!task) { unknown += 1; message.ack(); continue; }        // 防 DLQ 死循环
        if (task.state === "completed") { noop += 1; message.ack(); continue; }
        await outbox.toNeedsAttention(message.body.taskId, "dlq_exhausted");
        needsAttention += 1; message.ack();
      }
      return { needs_attention: needsAttention, unknown, noop };
    };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/dlq-consumer.js services/reliable-drive-sync-worker/src/index.js services/reliable-drive-sync-worker/test/rds2-dlq.test.js && git commit -m "feat(v2): batch-level dlq consumers routing by task id"`。

### Task 2.7 投影引擎：首次启动 emptyProjection + per-user 续批唤醒 + 单 D1 batch 五组操作 + 2 MiB 上限

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/projection-engine.js`；Test `services/reliable-drive-sync-worker/test/rds2-projection-engine.test.js`
**Interfaces:** Produces `createProjectionEngine(db, deps)` → `processTask(taskId)` | Consumes 子计划 1 全部仓库（projection `updateAdvanced` 触发器 CAS、archive-delivery **`async` `deterministicDeliveryId`**、event `readAfter`）、`shared/rds2-protocol.mjs`
**排序说明：** 本 Task 位于 Task 2.9（registry）之前，`deps.registry` 由测试内联桩 Reducer 提供；Task 2.9 交付真实 registry 后由 Task 2.8 接线替换，本 Task 代码零改动。
**五组操作（规格 §12，单 batch，N=fresh 事件数 ≤10）：** ① 投影 UPDATE（1 条，触发器 CAS ABORT 旧游标）② 精确 taskId `IN (绑定列表)` 完成 N 个 project task（1 条，禁 BETWEEN）③ N 条 event delivery `INSERT OR IGNORE` ④ 1 条 snapshot delivery `INSERT OR IGNORE` ⑤ N+1 条 archive task `INSERT OR IGNORE` = **2N+3 条语句**。
**意见 7 修订（四点）：** ① 首次启动：投影行缺失或 `state_json` 为 NULL 时必须 `reducer.emptyProjection(identity)`（identity 来自触发事件行 `user_id` + envelope `username`），禁止 `JSON.parse(state_json || "{}")`；② 两处 `deterministicDeliveryId(...)` 加 `await`（子计划 1 Rev 5 该函数为 async，返回 32 hex）；③ 续批唤醒 taskId 按 `(user_id, namespace)` 作用域查询派生，禁止 `lastSeq + 1` 全局连续性假设；④ 写库前断言 `publicView.userId != null`。

- [ ] 1. 失败测试（Rev 4 八条保留 + 意见 7 四条新增）：
  ```js
  test("advances cursor by at most 10 events in one atomic batch", async () => { /* 同 Rev 4 */ });
  test("hasMore triggers a follow-up wake, not a direct queue call", async () => {
    // deps.wakeNext spy：15 事件场景恰调用一次；源码静态断言引擎文件不含 "queue.send" 与 "sendWake"
  });
  test("stale consumer batch fails with zero side effects (trigger CAS)", async () => { /* 同 Rev 4 */ });
  test("duplicate message after cursor advanced completes task without reapplying", async () => { /* 同 Rev 4 */ });
  test("single batch freezes 10 event artifacts + 1 snapshot (10+1, never 1+1)", async () => {
    // 同 Rev 4，追加断言：全部 archive_delivery_id 匹配 /^[0-9a-f]{32}$/（意见 7②：Promise 泄漏回归锁）
  });
  test("project tasks are completed by exact taskId IN-list, not BETWEEN", async () => { /* 同 Rev 4 */ });
  test("mid-batch failure rolls back projection, task completion and all freezes", async () => { /* 同 Rev 4 */ });
  test("state_json over 2 MiB routes task to needs_attention without any write", async () => { /* 同 Rev 4 */ });
  test("意见7①：NULL state_json 初始行走 emptyProjection，不抛 TypeError", async () => {
    // 预置身份初始化写入的投影行（state_json=NULL, public_view_json=NULL, last_event_seq=0，见 §7.2）
    // 桩 reducer 记录 emptyProjection 收到的 identity；processTask → advanced
    // 断言：emptyProjection 恰调用一次、identity.userId === 事件 user_id、
    // 引擎未把 {} 传给 applyEvent（桩内断言 state.byEventKey 等键存在）
  });
  test("意见7①：投影行缺失时 upsert 后同样走 emptyProjection（缺行与 NULL 同契约）", async () => { /* */ });
  test("意见7③：续批唤醒按 (user_id, namespace) 派生，不跨用户", async () => {
    // 预置：用户 A 事件 seq 1..10、用户 B 事件 seq 11、用户 A 事件 seq 12
    // processTask("t_project_1")（A）推进 10 条 → hasMore
    // 断言 wakeNext 以 "t_project_12" 调用（A 的下一事件），不是 "t_project_11"（B 的任务）
  });
  test("意见7④：publicView 回填 userId/username，引擎写前断言非空", async () => {
    // 处理 3 个事件后读 rds2_projections：public_view_json 解析后
    // userId === 触发事件 user_id、username === envelope identity.username；
    // 桩 publicView 返回 userId:null 的场景 → 引擎抛 public_view_identity_missing，无任何写入
  });
  test("容量上限：reducer 抛 state_limit_exceeded:* 时任务转 needs_attention 且无写入", async () => {
    // 桩 applyEvent 抛 Error("state_limit_exceeded:algorithm.byEventKey")
    // → {outcome:"state_limit_exceeded"}、行 needs_attention、投影行未变、deliveries 0 新行
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
      if (!event) { await outbox.toNeedsAttention(taskId, "event_missing"); return { outcome: "event_missing" }; }
      const projectionName = registry.projectionName(event.namespace);
      const triggerDomainEvent = registry.toDomainEvent(event);
      const identity = { userId: event.user_id, username: triggerDomainEvent.username };   // 意见 7①
      let projection = await projections.get(event.user_id, event.namespace, projectionName);
      if (!projection) { await projections.upsert(event.user_id, event.namespace, projectionName); projection = await projections.get(event.user_id, event.namespace, projectionName); }
      if (projection.last_event_seq >= event.event_seq) { await outbox.complete(taskId); return { outcome: "noop_confirmed" }; }
      const fresh = await events.readAfter(event.user_id, event.namespace, projection.last_event_seq, BATCH_LIMIT);
      if (fresh.length === 0) { await outbox.complete(taskId); return { outcome: "noop_confirmed" }; }
      const reducer = registry.forNamespace(event.namespace);
      // 意见 7①：行缺失或 state_json 为 NULL → emptyProjection(identity) 是唯一合法初始状态
      let state = projection.state_json == null ? reducer.emptyProjection(identity) : JSON.parse(projection.state_json);
      try {
        for (const row of fresh) state = reducer.applyEvent(state, registry.toDomainEvent(row));
      } catch (cause) {
        if (String(cause?.message ?? "").startsWith("state_limit_exceeded")) {   // 意见 11 容量上限接线
          await outbox.toNeedsAttention(taskId, "state_limit_exceeded");
          return { outcome: "state_limit_exceeded" };
        }
        throw cause;
      }
      const lastSeq = fresh[fresh.length - 1].event_seq;
      const stateJson = JSON.stringify(state);
      if (Buffer.byteLength(stateJson, "utf8") > STATE_LIMIT_BYTES) {
        await outbox.toNeedsAttention(taskId, "state_limit_exceeded");   // 先断言后写，不得静默截断
        return { outcome: "state_limit_exceeded" };
      }
      const publicView = reducer.publicView(state);
      if (publicView?.userId == null) throw new Error("public_view_identity_missing");   // 意见 7④ 防线
      const publicViewJson = canonicalJson(publicView);
      const contentHash = await sha256Hex(publicViewJson);
      const now = new Date().toISOString();
      const deliveries = [];
      for (const row of fresh) {
        const artifactKey = `business-event:${row.event_id}`;
        deliveries.push({ archive_delivery_id: await deterministicDeliveryId(artifactKey),   // 意见 7② await
          artifact_kind: "business_event", artifact_key: artifactKey, user_id: row.user_id, namespace: row.namespace,
          source_event_seq: row.event_seq, projection_name: null, projection_event_seq: null,
          artifact_json: row.envelope_json, artifact_hash: row.envelope_hash,
          drive_path: `users/${row.user_id}/${row.namespace}/events/event-${row.event_id}.json` });
      }
      const snapKey = `projection:${event.user_id}:${event.namespace}:${projectionName}:${lastSeq}`;
      deliveries.push({ archive_delivery_id: await deterministicDeliveryId(snapKey),   // 意见 7② await
        artifact_kind: "projection_snapshot", artifact_key: snapKey, user_id: event.user_id, namespace: event.namespace,
        source_event_seq: null, projection_name: projectionName, projection_event_seq: lastSeq,
        artifact_json: publicViewJson, artifact_hash: contentHash,
        drive_path: `users/${event.user_id}/${event.namespace}/snapshots/${projectionName}-through-${lastSeq}.json` });
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
      if (fresh.length === BATCH_LIMIT) {
        // 意见 7③：按 (user_id, namespace) 作用域派生下一唤醒 taskId，禁止 lastSeq + 1 全局连续性假设
        const next = await db.prepare(`SELECT event_seq FROM rds2_business_events
          WHERE user_id = ? AND namespace = ? AND event_seq > ? ORDER BY event_seq ASC LIMIT 1`)
          .bind(event.user_id, event.namespace, lastSeq).first();
        if (next) await wakeNext(`t_project_${next.event_seq}`, "project_event");
      }
      return { outcome: "advanced", lastSeq, advanced: fresh.length, hasMore: fresh.length === BATCH_LIMIT };
    };
  }
  ```
  （`events.readAfter` 为子计划 1 event-repository 已有方法；`deterministicDeliveryId` 为子计划 1 archive-delivery-repository 的 **async** 导出纯函数，返回 32 hex。`wakeNext` 由 Task 2.8 接线注入 `dispatcher.run`——引擎自身不触碰 queue，静态断言锁定。）
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/projection-engine.js services/reliable-drive-sync-worker/test/rds2-projection-engine.test.js && git commit -m "feat(v2): projection engine with emptyProjection startup, per-user wake and awaited delivery ids"`。

### Task 2.8 投影消费者接线（wakeNext 经 `dispatcher.run`）+ 规格两条必测链路端到端

**Files:** Modify `src/index.js`（`buildProcessors` 的 `rds2-project` 键替换为 batch 级引擎接线）；Test `services/reliable-drive-sync-worker/test/rds2-duplicate-consumption.test.js`
**Interfaces:** Consumes Task 2.2/2.3/2.5/2.7
**规格依据（§13）:** 必须存在的两条真实测试链路：① `send 成功 → markQueued 失败 → 租约到期 → 相同 taskId 重发 → 重复消费无副作用`；② `queued 消息丢失 → 陈旧回收 → 重新发布 → 恰好一次业务效果`。
**意见 8 修订：** Rev 4 `wakeNext: (taskId, type) => queueIo.sendWake(taskId, type, 0)` 绕过 Outbox 状态机；改为 `wakeNext: (taskId) => dispatcher.run(taskId)`——引擎续批唤醒与接收即时唤醒、恢复器补唤醒共用同一 Dispatcher 入口。

- [ ] 1. 失败测试（端到端，Miniflare 或 sqlite-adapter + 假 queue binding）：
  ```js
  test("chain A: send ok, write-back fails, lease expires, same taskId republished, duplicate consume is harmless", async () => {
    // ① accept 事件 seq1 → dispatcher.run（sendWake 成功）
    // ② 注入 markQueued 失败（或手工把行留在 dispatching + 短租约）→ 行 dispatching
    // ③ reclaimExpired（租约过期）→ 行 pending → dispatcher.run 重发（sendWake 第二次，同 taskId）
    // ④ 消费该 taskId 两次 → 第一次 advanced，第二次 noop_confirmed
    // 断言：cursor=1、topicMastery 计数无翻倍、archive_deliveries 恰 2 行（1 event + 1 snapshot）
  });
  test("chain B: queued message lost, stale reclaim after 10min, republish, exactly one business effect", async () => {
    // ① accept 事件 → dispatcher.run 成功（行 queued，假 queue 吞掉消息不投递）
    // ② 时钟推进 >10min → recovery.run() → reclaimStaleQueued 复位 pending → dispatcher.run 重发
    // ③ 消费 → advanced；重复消费 → noop_confirmed
    // 断言：publicView 与直接顺序处理结果 deepEqual；queued_at 在复位行重发后更新为新值
  });
  test("duplicate publish then duplicate consume yields one projection advance and one artifact set", async () => {
    // dispatcher 两次 run 同 taskId（模拟回写失败后恢复器重发）→ 消费两次 →
    // projections.last_event_seq 只推进一次的值；archive_deliveries 恰 2 行；publicView 深相等
  });
  test("意见8：引擎续批唤醒经过 dispatcher.run，任务行走完整状态机", async () => {
    // 预置 15 个同用户事件 → 消费 t_project_1 → 推进 10 条
    // 断言：t_project_11（同用户下一事件任务）被 dispatcher.run 认领并置 queued（lease 周期内），
    // 不是停留 pending 等待恢复器；queueIo.sendWake 恰被 dispatcher 调用一次（引擎未直接调用）
  });
  test("wakeNext path is budgeted through the shared root budget", async () => {
    // 消费 + 续批唤醒后 snapshotByCategory：queue 计数包含续批那次 send
  });
  ```
- [ ] 2. 预期失败：`rds2-project` 处理器为空实现。
- [ ] 3. 实现 `buildProcessors` 的 project 键（batch 级）与引擎装配：
  ```js
  "rds2-project": async (batch) => {
    for (const message of batch.messages) { await engine.processTask(message.body.taskId); message.ack(); }
  },
  ```
  引擎实例化加入 `createWorker` 私有装配：`deps = { events, projections, outbox, registry: createReducerRegistry(), wakeNext: (taskId) => dispatcher.run(taskId) }`（`dispatcher` 与恢复器共用同一实例；`queueIo` 仅注入 dispatcher，不直接暴露给引擎装配）。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/index.js services/reliable-drive-sync-worker/test/rds2-duplicate-consumption.test.js && git commit -m "feat(v2): project consumer wiring with dispatcher-run wake and the two mandatory chains"`。

### Task 2.9 fold-all Oracle、Reducer 契约（`emptyProjection(identity)`）与 toDomainEvent 冻结结构

**Files:** Create `src/rds2/reducer-contract.js`、`src/rds2/fold-all.js`、`src/rds2/reducers/index.js`；Test `test/rds2-reducer-contract.test.js`、`test/rds2-fold-all.test.js`
**Interfaces:** Produces `assertReducer`、`foldAll`、`createReducerRegistry` | Consumes 无
**意见 7/11 修订：** ① 契约方法 `emptyState` 更名为 `emptyProjection(identity)`（对齐规格 §12 接口签名），各 Reducer 在其中播种 `state.identity = {userId, username}`；② `foldAll(reducer, events, identity)` 以 `emptyProjection(identity)` 起手；③ `toDomainEvent` 维持 Rev 4 冻结结构（identity 统一 `username`，无 displayName；`identity.userId` 与 `row.user_id` 不一致抛 `identity_row_mismatch`）。

- [ ] 1. 失败测试：
  ```js
  test("assertReducer rejects objects missing the three functions", () => {
    assert.throws(() => assertReducer({ applyEvent: () => {}, publicView: () => {} }), /invalid_reducer/);
    assert.throws(() => assertReducer({ emptyProjection: () => {}, applyEvent: () => {} }), /invalid_reducer/);
  });
  test("emptyProjection seeds identity into state", () => {
    // 任一域 reducer.emptyProjection({userId:"u-1", username:"乔"}) →
    // state.identity deepEqual {userId:"u-1", username:"乔"}
  });
  test("publicView backfills userId/username from seeded identity (never null)", () => {
    // emptyProjection → publicView → userId/username 与 identity 一致
  });
  test("publicView is pure: same state twice gives deep-equal output", () => { /* */ });
  test("foldAll sorts by event_seq ASC and folds from emptyProjection(identity)", () => { /* */ });
  test("toDomainEvent freezes the unified structure with username (no displayName)", async () => { /* 同 Rev 4 */ });
  test("registry: unknown namespace throws no_reducer_for_namespace", () => { /* */ });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  export function assertReducer(reducer) {
    for (const key of ["emptyProjection", "applyEvent", "publicView"]) {
      if (typeof reducer?.[key] !== "function") throw new Error("invalid_reducer");
    }
    return reducer;
  }
  export function foldAll(reducer, events, identity) {
    const ordered = [...events].sort((a, b) => a.event_seq - b.event_seq);
    let state = reducer.emptyProjection(identity);
    for (const event of ordered) state = reducer.applyEvent(state, event);
    return reducer.publicView(state);
  }
  ```
  `createReducerRegistry()` 返回 `{ forNamespace(ns), projectionName(ns), toDomainEvent(row) }`；`toDomainEvent` 逐字继承 Rev 4（`username` 统一 + `identity_row_mismatch`）。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/reducer-contract.js services/reliable-drive-sync-worker/src/rds2/fold-all.js services/reliable-drive-sync-worker/src/rds2/reducers/index.js services/reliable-drive-sync-worker/test/rds2-reducer-contract.test.js services/reliable-drive-sync-worker/test/rds2-fold-all.test.js && git commit -m "feat(v2): reducer contract with emptyProjection identity seeding"`。

### Task 2.10 algorithm Reducer（字段级映射 + 容量上限）

**Files:** Create `src/rds2/reducers/algorithm.js`；Test `test/rds2-reducer-algorithm.test.js`
**Interfaces:** Consumes Task 2.9；规则蓝本 `src/algorithm-profile-model.js`（只读）
**意见 11 修订：** 状态形状与 `algorithm-profile-model.js:40-42, 52-56, 75-77, 87` 逐字段对齐：`topicAgg` 补全 `lastObservedAt/eventKeys`；`latestByProblem` 与 `currentTopic` 提升为状态字段（不再 publicView 临时推导）。

**字段级映射表（payload.event → 状态 → publicView）：**

| payload 字段 | 状态位置 | publicView 派生 | 蓝本 |
|---|---|---|---|
| `eventKey`（行级） | `byEventKey` 键；`topicAgg[topic].eventKeys[]` 追加 | `sourceEventKeys`（按 seq 序）；`weaknesses[].evidenceEventKeys` | model:50, 71, 86 |
| `eventId`（行级） | `byEventKey[key].eventId` | `headEventId`（head 记录） | model:85 |
| `outcome` | `byEventKey[key].outcome`；`topicAgg` 三分类计数（`incorrect/stuck/partial`→negative、`completed/correct`→positive、其余→neutral）；`latestByProblem[pid].outcome` | `topicMastery[topic].{attempts,negative,positive,neutral,lastOutcome}`；`weaknesses[].status`（positive>0→improving）；`pendingProblemIds`（latest 非 positive） | model:6-7, 44-48, 66, 76 |
| `topic` | `byEventKey[key].topic`；`topicAgg` 键；`currentTopic`（每事件覆盖为最新） | `topicMastery` 键；`currentTopic` | model:39, 87 |
| `observedAt` | `byEventKey[key].observedAt`；`topicAgg[topic].lastObservedAt` | `topicMastery[].lastObservedAt`；`weaknesses[].lastObservedAt`；`generatedAt`（head 记录 observedAt，确定性，不用 `now()`） | model:49, 70, 84 |
| `problem.{source,title}` | `problemIdOf`（`source:title` 或 `title`）→ `topicAgg[topic].problemIds[]`（去重追加）、`latestByProblem[pid] = {seq, outcome, eventKey}`（seq 更大者胜） | `topicMastery[].problemIds`；`pendingProblemIds` | model:16-21, 52-56, 75-77 |
| `evidence` | **不入状态**（校验期字段） | — | Rev 4 已锁 |
| seq（行级） | `byEventKey[key].seq`；`latestByProblem[pid].seq`；`headSeq` | `headEventSeq`；`sourceEventKeys` 排序键 | §12 V2 排序语义 |

**容量上限（写入前断言，超限抛 `state_limit_exceeded:algorithm.<字段>`）：** `byEventKey` ≤ 5000 键；`topicAgg[topic].problemIds` ≤ 500；`topicAgg[topic].eventKeys` ≤ 1000；`latestByProblem` ≤ 1000 键。

- [ ] 1. 失败测试（Rev 4 断言保留并按新状态形状修正 + 意见 11 新增）：
  ```js
  test("completed/correct positive, incorrect/stuck/partial negative, consulted neutral", () => { /* topicAgg 三分支计数 */ });
  test("problemId normalizes to source:title", () => { /* */ });
  test("pendingProblemIds keeps problem until latest-seq outcome is positive", () => {
    // seq3 incorrect → pending；seq4 completed → 移出；断言来自状态 latestByProblem，非临时推导
  });
  test("weaknesses: negative>0, improving when positive>0, sorted by negative desc then topic", () => { /* */ });
  test("topicAgg carries lastObservedAt and eventKeys per topic (field-level parity with model)", () => {
    // 两事件同 topic → topicAgg[topic].lastObservedAt === 第二事件 observedAt；
    // eventKeys 按 apply 序 deepEqual [k1, k2]
  });
  test("currentTopic is maintained in state and equals the latest applied event topic", () => { /* */ });
  test("duplicate eventKey application is a state no-op (defense in depth behind DB unique index)", () => { /* */ });
  test("state stays minimal: no event arrays, payload not retained", () => {
    // 200 事件后 JSON.stringify(state) 不含 'evidence' 键
  });
  test("capacity: byEventKey overflow throws state_limit_exceeded:algorithm.byEventKey", () => {
    // 桩 5001 个唯一 eventKey → 第 5001 次 applyEvent 抛错；state 未被部分污染（引用不变式抽查）
  });
  test("capacity: per-topic eventKeys overflow throws state_limit_exceeded:algorithm.topicAgg.eventKeys", () => { /* 1001 键 */ });
  test("state_json of a 300-event normal series stays far below 2 MiB", () => { /* < 256 KiB */ });
  test("publicView is deterministic and backfills identity", () => {
    // 两次调用 deepEqual；userId/username 与 emptyProjection identity 一致；generatedAt === head observedAt
  });
  ```
- [ ] 2. 预期失败：`forNamespace("algorithm")` 抛 `no_reducer_for_namespace`。
- [ ] 3. 最小实现：
  ```js
  const NEGATIVE = new Set(["incorrect", "stuck", "partial"]);
  const POSITIVE = new Set(["completed", "correct"]);
  const CAP_BY_EVENT_KEY = 5000, CAP_TOPIC_PROBLEMS = 500, CAP_TOPIC_EVENT_KEYS = 1000, CAP_LATEST_BY_PROBLEM = 1000;
  const text = (v) => typeof v === "string" && v.trim() ? v.trim() : null;
  const problemIdOf = (ev) => {
    const title = text(ev?.problem?.title);
    if (!title) return null;
    const source = text(ev?.problem?.source);
    return source ? `${source}:${title}` : title;
  };
  export const algorithmReducer = {
    name: "algorithm",
    emptyProjection: (identity) => ({
      identity: { userId: identity.userId, username: identity.username ?? null },
      byEventKey: {}, topicAgg: {}, latestByProblem: {},
      currentTopic: null, headSeq: 0, headEventKey: null
    }),
    applyEvent(state, event) {
      const key = event.eventKey;
      if (state.byEventKey[key]) return state;                     // DB 唯一索引后的防御层
      if (Object.keys(state.byEventKey).length >= CAP_BY_EVENT_KEY) throw new Error("state_limit_exceeded:algorithm.byEventKey");
      const ev = event.payload.event;
      const outcome = ev.outcome, topic = ev.topic, observedAt = ev.observedAt ?? null;
      const agg = state.topicAgg[topic] ?? { attempts: 0, negative: 0, positive: 0, neutral: 0, lastOutcome: null, lastObservedAt: null, problemIds: [], eventKeys: [] };
      agg.attempts += 1;
      if (NEGATIVE.has(outcome)) agg.negative += 1; else if (POSITIVE.has(outcome)) agg.positive += 1; else agg.neutral += 1;
      agg.lastOutcome = outcome; agg.lastObservedAt = observedAt;
      if (agg.eventKeys.length >= CAP_TOPIC_EVENT_KEYS) throw new Error("state_limit_exceeded:algorithm.topicAgg.eventKeys");
      agg.eventKeys.push(key);
      const pid = problemIdOf(ev);
      if (pid && !agg.problemIds.includes(pid)) {
        if (agg.problemIds.length >= CAP_TOPIC_PROBLEMS) throw new Error("state_limit_exceeded:algorithm.topicAgg.problemIds");
        agg.problemIds.push(pid);
      }
      const latestByProblem = { ...state.latestByProblem };
      if (pid) {
        const cur = latestByProblem[pid];
        if (!cur || event.event_seq > cur.seq) latestByProblem[pid] = { seq: event.event_seq, outcome, eventKey: key };
        if (Object.keys(latestByProblem).length > CAP_LATEST_BY_PROBLEM) throw new Error("state_limit_exceeded:algorithm.latestByProblem");
      }
      return {
        ...state,
        byEventKey: { ...state.byEventKey, [key]: { seq: event.event_seq, eventId: event.eventId, outcome, topic, problemId: pid, observedAt } },
        topicAgg: { ...state.topicAgg, [topic]: agg },
        latestByProblem,
        currentTopic: topic,
        headSeq: event.event_seq, headEventKey: key
      };
    },
    publicView(state) {
      const entries = Object.entries(state.byEventKey).sort((a, b) => a[1].seq - b[1].seq);
      const topicMastery = {};
      for (const [topic, m] of Object.entries(state.topicAgg)) {
        topicMastery[topic] = { attempts: m.attempts, negative: m.negative, positive: m.positive, neutral: m.neutral,
          lastOutcome: m.lastOutcome, lastObservedAt: m.lastObservedAt, problemIds: [...m.problemIds], eventKeys: [...m.eventKeys] };
      }
      const weaknesses = Object.entries(topicMastery).filter(([, m]) => m.negative > 0)
        .sort((a, b) => (b[1].negative - a[1].negative) || String(a[0]).localeCompare(String(b[0])))
        .map(([topic, m]) => ({ topic, status: m.positive > 0 ? "improving" : "open", negative: m.negative,
          positive: m.positive, lastOutcome: m.lastObservedAt, lastObservedAt: m.lastObservedAt, evidenceEventKeys: [...m.eventKeys] }));
      const pendingProblemIds = Object.entries(state.latestByProblem).filter(([, r]) => !POSITIVE.has(r.outcome)).map(([pid]) => pid);
      const head = state.headEventKey ? state.byEventKey[state.headEventKey] : null;
      return { schemaVersion: "1.2", userId: state.identity.userId, username: state.identity.username,
        generatedAt: head?.observedAt ?? null, headEventId: head?.eventId ?? null, headEventSeq: state.headSeq,
        sourceEventKeys: entries.map(([k]) => k), currentTopic: state.currentTopic,
        topicMastery, weaknesses, pendingProblemIds };
    }
  };
  ```
  （注册 `projectionName("algorithm") = "learning"`。）
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/reducers/algorithm.js services/reliable-drive-sync-worker/src/rds2/reducers/index.js services/reliable-drive-sync-worker/test/rds2-reducer-algorithm.test.js && git commit -m "feat(v2): algorithm reducer with field-level mapped minimal state and capacity caps"`。

### Task 2.11 generic-profile Reducer（observations[] 多条目 + 分组索引 + correction 严格晚于）

**Files:** Create `src/rds2/reducers/generic-profile.js`；Test `test/rds2-reducer-generic-profile.test.js`
**Interfaces:** Consumes Task 2.9；规则蓝本 `src/generic-profile-model.js:50-189`、`src/generic-profile-contract.js:47-66`（只读）
**意见 11 修订：** 从单条 observation 设计重写为**多条目 `observations[]`**：一个事件可携带多条观察（契约每条固定 `dimensionKey/subjectKey/outcome/evidence/confidence/sourceRef` 六字段）；状态按 `(dimensionKey, subjectKey)` 建分组索引；弱点关闭规则"最近负向后两个独立 sourceRef 正向"（model:144-159）逐行移植。

**字段级映射表（payload.event → 状态 → publicView）：**

| payload 字段 | 状态位置 | publicView 派生 | 蓝本 |
|---|---|---|---|
| `action`（observe/supersede/invalidate） | `contributions[key].action`；`inactive[target].action` | 四分类输入 | contract:5, 60-66 |
| `observedAt` | `contributions[key].observedAt` | `memberOf.latestObservedAt`（组内最后一条）；correction 严格晚于判定（`Date.parse` 大于，等于/更早抛 `invalid_profile_event`） | model:85, 125 |
| `targetEventKey` | `contributions[key].targetEventKey`；撤销时定位 `inactive` 与 `groups` 移除 | — | model:78-95 |
| `observations[].dimensionKey/subjectKey` | observations 最小表示保留；`groups["<dim>\u0000<sub>"]` 键 | `memberOf.dimensionKey/subjectKey`；四桶按 `(dimensionKey, subjectKey)` 排序 | model:103, 122-123, 171-174 |
| `observations[].outcome` | observations 最小表示保留 | `positiveEvidenceCount/negativeEvidenceCount/partialEvidenceCount` 计数（positive=`completed/correct/passed`、negative=`stuck/incorrect/failed`、partial=`partial`）；`latestOutcome`；四分类规则 | model:4-7, 116-120, 124, 158-168 |
| `observations[].confidence` | observations 最小表示保留 | `memberOf.confidence`（组内最后一条） | model:126 |
| `observations[].sourceRef` | observations 最小表示保留 | `memberOf.sourceRefs`（去重排序）；**弱点关闭：负向清空、正向按 sourceRef 去重累计，`distinctPositiveSources ≥ 2` 且 latest 非负向 → `stableStrengths`** | model:112, 131, 144-159 |
| `observations[].evidence` | **不入状态**（契约校验期字段，publicView 不引用） | — | contract:50-56 |
| `eventKey`（行级） | `contributions` 键；`groups` 值元素 | `memberOf.evidenceRefs`（组内 eventKey 去重排序）；`sourceEventKeys`（全键排序） | model:111, 130, 184 |
| `eventId`（行级） | `contributions[key].eventId` | `headEventId` | model:183 |
| `domain` | `state.domain`（首事件播种，profile 投影每用户单域） | `domain` | model:181 |
| seq（行级） | `contributions[key].seq`；`inactive[target].seq` | 组内排序键（V2 seq 序，替代 model 的 observedAt 稳定序——§12 V2 排序语义） | §12 |

**容量上限：** `contributions` ≤ 5000 键；单事件 `observations[]` ≤ 50 条；每组 `groups[gkey]` ≤ 1000 键。超限抛 `state_limit_exceeded:profile.contributions|observations|groups`。

- [ ] 1. 失败测试（Rev 4 断言按多条目形状修正 + 意见 11 新增）：
  ```js
  test("one event with multiple observations feeds multiple groups", () => {
    // observe 事件携带 2 条 observations（不同 dimensionKey）→ 两个 groups 键各含该 eventKey；
    // contributions[key].observations 长度为 2 且不含 evidence 字段
  });
  test("supersede deactivates target and stays active itself", () => { /* inactive + groups 移除/加入 */ });
  test("supersede can itself be superseded later (chained)", () => { /* 两跳链 */ });
  test("invalidate deactivates target without adding an active contribution", () => {
    // invalidate 的 observations 为空（contract:65）；目标从 groups 移除、inactive 登记
  });
  test("correction requires observedAt strictly later than target (V1 rule kept)", () => {
    // target.observedAt = T；新事件 observedAt = T+1ms → 接受；
    // observedAt = T（相等）→ 抛 invalid_profile_event；T-1ms → 抛 invalid_profile_event
    // 断言依据 generic-profile-model.js:85-86 的 Date.parse 严格大于与错误码
  });
  test("targeting inactive or missing event fails at reducer boundary", () => {
    // target_event_not_found（目标从未出现）；target_event_inactive（目标已撤销或目标本身是 invalidate）
  });
  test("self-target is rejected", () => { /* invalid_profile_event */ });
  test("revocation shrinks aggregates without deleting contribution records", () => {
    // 聚合计数回落，contributions 键保留（最小贡献记录支持重放撤销重推导）
  });
  test("weakness closure needs two distinct positive sourceRefs after the latest negative", () => {
    // 组内序列：negative(S1) → positive(S1) → positive(S1)（同源不累计）→ 仍 openWeaknesses；
    // 再 positive(S2) → stableStrengths；再 negative(S3) → 重新 openWeaknesses（负向重置计数）
    // 断言依据 model:144-159
  });
  test("publicView groups by dimension+subject into four buckets, deterministic", () => {
    // openWeaknesses/improvingSignals/stableStrengths/observations；两次调用 deepEqual；
    // 桶内按 (dimensionKey, subjectKey) 排序；userId/username/domain 回填
  });
  test("state stays minimal: no envelopes, no evidence text", () => {
    // 200 事件后 stringify(state) 不含 'evidence'；300 事件 < 256 KiB
  });
  test("capacity: observations over 50 per event throws state_limit_exceeded:profile.observations", () => { /* */ });
  ```
- [ ] 2. 预期失败：`forNamespace("profile")` 抛 `no_reducer_for_namespace`。
- [ ] 3. 最小实现要点：
  ```js
  const POSITIVE = new Set(["completed", "correct", "passed"]);
  const NEGATIVE = new Set(["stuck", "incorrect", "failed"]);
  const PARTIAL = "partial";
  const CAP_CONTRIBUTIONS = 5000, CAP_OBSERVATIONS = 50, CAP_GROUP_KEYS = 1000;
  // emptyProjection: (identity) => ({ identity: {...}, domain: null, contributions: {}, inactive: {}, groups: {}, headSeq: 0, headEventKey: null })
  // applyEvent(state, event):
  //   key 已在 contributions → 原样返回（防御层）；
  //   action !== "observe"：自目标 → invalid_profile_event；目标不存在 → target_event_not_found；
  //     Date.parse(ev.observedAt) > Date.parse(target.observedAt) 不成立 → invalid_profile_event；
  //     目标已 inactive 或目标 action === "invalidate" → target_event_inactive；
  //     然后 inactive[target] = {by: key, action, seq} 并从目标各 observation 对应 groups 移除该键；
  //   observations 最小表示 = ev.observations.map(o => ({dimensionKey, subjectKey, outcome, confidence, sourceRef}))（弃 evidence）；
  //   容量断言三连；contributions[key] = {seq, eventId, action, observedAt, targetEventKey, observations: 最小表示}；
  //   action !== "invalidate" → 按每条 observation 把 key 加入 groups[gkey]（gkey = dim + "\u0000" + sub）；
  //   state.domain ??= ev.domain ?? null。
  // publicView：遍历 groups → 组内 entries = keys.map(k => contributions[k])（插入序即 seq 序）展开为
  //   {contribution, observation} 序列 → memberOf 移植（计数/latest/evidenceRefs/sourceRefs，model:109-133）
  //   → 关闭规则移植（负向清空 distinctPositiveSources、正向按 sourceRef 累计，model:144-153）
  //   → 四分类移植（model:158-168）→ 桶内 (dimensionKey, subjectKey) 排序（model:171-174）；
  //   顶层 {schemaVersion:"1.0", userId, username, domain, generatedAt: head observedAt,
  //         headEventId, sourceEventKeys: Object.keys(contributions).sort(), 四桶}。
  ```
  （注册 `projectionName("profile") = "profile"`。）
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/reducers/generic-profile.js services/reliable-drive-sync-worker/src/rds2/reducers/index.js services/reliable-drive-sync-worker/test/rds2-reducer-generic-profile.test.js && git commit -m "feat(v2): generic profile reducer with multi-observation groups and closure rule parity"`。

### Task 2.12 interview Reducer（每 session 选中 review 的最小字段副本 + 八字段边界）

**Files:** Create `src/rds2/reducers/interview.js`；Test `test/rds2-reducer-interview.test.js`
**Interfaces:** Consumes Task 2.9；规则蓝本 `src/profile-model.js:24-104`（只读）
**意见 11 修订：** 选中 review 的最小副本字段从 `{statusOf, changeEvidence, domainProfiles, generalCompetencies}` 改为规格锁定的 `{completedAt, evidenceConfidence, applyProfileChanges, profileChanges}`；`profileChanges` 条目在边界裁剪为**八字段** `{kind, outcome, domain, weaknessId, variantId, competencyId, title, evidenceRefs}`——`statusOf` 的有效输入只有 `outcome`（V1 的 `status/result/action` 与 `id/variant/questionId/domainId/level/evidenceConfidence/evidenceRef` 等回退字段在边界外被丢弃，映射表逐项注明）。

**字段级映射表（payload.event → 状态 → publicView）：**

| payload 字段 | 状态位置 | publicView 派生 | 蓝本 |
|---|---|---|---|
| `sessionId` | `selectedBySession` 键；副本内保留 | `weakness.passingSessionIds`（pass 时追加去重） | model:61, 82 |
| `reviewVersion` | 副本内保留（Number 归一 `\|\| 0`） | 选中规则：更高 version 胜；平者更高 seq 胜（V2 seq 序，替代 model:41 的 completedAt 稳定序） | model:41; §12 |
| `completedAt` | 副本内保留 | `generatedAt`（head 副本 completedAt，确定性） | model:14, 98 |
| `evidenceConfidence` | 副本内保留（事件级） | `weakness.confidence`/`competency.confidence`（首见非空值 sticky） | model:60, 70, 87 |
| `applyProfileChanges` | 副本内保留；`!== true` 的事件**不进聚合**（identity 绑定已由 emptyProjection 承担） | — | model:34, 44-47 |
| `profileChanges[].kind` | 边界保留 | 仅作 weakness/competency 判别辅助（V1 的 `kind === "weakness"` 回退因 `id` 被裁而失效，映射表注明） | model:55 |
| `profileChanges[].outcome` | 边界保留 | `statusOf` 唯一有效输入：`open` 词族（failed/failure/fail/incorrect/wrong/open）→ `open`；`pass` 词族（passed/pass/success/correct/improving/close/closed/resolved）→ `pass`；其余 `null` | model:6-12 |
| `profileChanges[].domain` | 边界保留 | `domainProfiles` 键（缺省 `"general"`；V1 的 `domainId` 回退被裁） | model:57, 76 |
| `profileChanges[].weaknessId` | 边界保留 | `domainProfiles[domain].weaknesses` 键（V1 的 `id`/`W[-_]` 回退被裁） | model:54-56 |
| `profileChanges[].variantId` | 边界保留 | `weakness.passingVariantIds`（pass 时追加去重；V1 的 `variant/questionId` 回退被裁） | model:62, 83 |
| `profileChanges[].competencyId` | 边界保留 | `generalCompetencies` 键（V1 的 `id/name` 回退被裁） | model:65 |
| `profileChanges[].title` | 边界保留 | `weakness.title`（非 undefined 时覆盖） | model:88 |
| `profileChanges[].evidenceRefs` | 边界保留（字符串数组过滤） | `weakness.evidenceRefs`/`competency.evidenceRefs` 并集（V1 的 `change.evidenceRef` 单值与 `event.evidenceRefs` 事件级并集被裁） | model:19-25, 69, 86 |
| seq/eventId/eventKey（行级） | 副本内保留 | 选中平序键；`headEventId`；`sourceEventKeys`（选中副本的 eventKey，按 seq 序） | model:99-100 |

**publicView 聚合（从 `selectedBySession` 确定性重算）：** 选中副本按 seq 升序遍历——weakness 记录 `{status, passingSessionIds, passingVariantIds, evidenceRefs, confidence, title}`：`open` → `status="open"`；`pass` → 追加 sessionId/variantId 去重后 `passingSessionIds.length >= 2 && passingVariantIds.length >= 2` → `"closed"`，否则 `"improving"`（model:77-89 逐行）；competency 记录 `{status, evidenceRefs, confidence}`：`open`→`needs_work`、`pass`→`demonstrated`（model:67-72，无 `level`——边界已裁）。顶层 `{schemaVersion:"1.2", userId, username, generatedAt, headEventId, sourceEventKeys, domainProfiles, generalCompetencies}`。

**容量上限：** `selectedBySession` ≤ 1000 个 session；单 review `profileChanges` ≤ 100 条。超限抛 `state_limit_exceeded:interview.selectedBySession|profileChanges`。

- [ ] 1. 失败测试（Rev 4 断言按新副本形状修正 + 意见 11 新增）：
  ```js
  test("higher reviewVersion replaces the session selection and revokes old contributions", () => {
    // session s1: v1 open weakness W1 → v2 closed W1 → publicView 中 W1 为 closed 且 v1 evidenceRefs 消失
  });
  test("reviewVersion tie is broken by higher event_seq", () => { /* v2,seq=5 vs v2,seq=7 → seq7 胜 */ });
  test("applyProfileChanges=false events are not aggregated", () => { /* state 引用不变 */ });
  test("selected review copy keeps exactly the boundary fields (8-field profileChanges)", () => {
    // 输入 change 携带 {id, status, result, action, variant, questionId, domainId, level, evidenceRef, evidenceConfidence}
    // → 副本条目键集合恰为 {kind, outcome, domain, weaknessId, variantId, competencyId, title, evidenceRefs}
  });
  test("statusOf effective input is outcome only (status/result/action dropped at boundary)", () => {
    // change = {outcome:"passed", status:"failed"} → statusOf 读 outcome → pass（V1 会先命中 status → open；
    // 边界裁剪后行为差异被本测试显式锁定，而非隐式漂移）
  });
  test("weakness closure rule: >=2 passing sessions and >=2 passing variants", () => {
    // 同一 weakness：session s1 pass(variant v1) → improving；s2 pass(v1)（variant 重复）→ 仍 improving；
    // s2 pass(v2) → closed。对齐 profile-model.js:82-84
  });
  test("state keeps only the selected review per session (old version removed)", () => { /* */ });
  test("state stays bounded: 200 sessions * 3 review versions < 256 KiB", () => { /* 替换制有界证明 */ });
  test("capacity: 101 profileChanges in one review throws state_limit_exceeded:interview.profileChanges", () => { /* */ });
  test("publicView backfills identity and is deterministic", () => { /* userId/username + 两次 deepEqual */ });
  ```
- [ ] 2. 预期失败：`forNamespace("interview")` 抛 `no_reducer_for_namespace`。
- [ ] 3. 最小实现要点：
  ```js
  const CAP_SESSIONS = 1000, CAP_CHANGES = 100;
  // emptyProjection: (identity) => ({ identity: {...}, selectedBySession: {}, headSeq: 0, headEventKey: null })
  // applyEvent：仅处理 interview.review.completed；applyProfileChanges !== true 或非数组 profileChanges → 原样返回；
  //   reviewVersion = Number(ev.reviewVersion) || 0；cur = selectedBySession[sessionId]；
  //   cur 存在且 (reviewVersion < cur.reviewVersion || (== 且 event.event_seq <= cur.seq)) → 原样返回；
  //   新 session 且键数达 CAP_SESSIONS → 抛 state_limit_exceeded:interview.selectedBySession；
  //   profileChanges.length > CAP_CHANGES → 抛 state_limit_exceeded:interview.profileChanges；
  //   边界裁剪 minimalCopy：{seq, eventId, eventKey, sessionId, reviewVersion, completedAt, evidenceConfidence,
  //     applyProfileChanges: true, profileChanges: ev.profileChanges.map(c => ({kind, outcome, domain,
  //     weaknessId, variantId, competencyId, title, evidenceRefs: 字符串数组过滤}))}；
  // publicView：按 seq 升序遍历选中副本，逐项移植 model:51-91（字段来源见映射表），
  //   statusOf 实现保留 model:6-12 词族但只喂 {outcome}。
  ```
  （注册 `projectionName("interview") = "interview"`。）
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/reducers/interview.js services/reliable-drive-sync-worker/src/rds2/reducers/index.js services/reliable-drive-sync-worker/test/rds2-reducer-interview.test.js && git commit -m "feat(v2): interview reducer with eight-field boundary copies and closure parity"`。

### Task 2.13 resume-knowledge Reducer（当前 resumeVersion bank 替换制 + total/feedback 评分索引 + mastery 混合）

**Files:** Create `src/rds2/reducers/resume-knowledge.js`；Test `test/rds2-reducer-resume-knowledge.test.js`
**Interfaces:** Consumes Task 2.9；规则蓝本 `src/resume-knowledge-model.js:88-123, 130-137, 143-155, 176-193, 199-313`（只读）
**意见 11 修订：** 评分记录从 `{seq, outcome}` 重写为 `{seq, total, scoredAt, eventId, eventKey, issues, issueCategories}`（`feedback.issues/feedback.issueCategories` 入状态，`recentIssues` 依赖它们）；`questionMastery` 提升为状态字段并按 `0.6·new + 0.4·prev` 增量混合；bank 问题最小副本补 `evidence`（`nextReview` 的 untested-explicit 规则依赖，`resume-knowledge-model.js:290`）。

**字段级映射表（payload.event → 状态 → publicView）：**

| payload 字段 | 状态位置 | publicView 派生 | 蓝本 |
|---|---|---|---|
| `question-bank-created.resumeVersion` | `currentBank.resumeVersion`（seq 更大者替换，旧 bank 不降级） | `resumeVersion` | model:92, 300 |
| `question-bank-created.questions[].questionKey/knowledgePointId/evidence` | `currentBank.questions[]` 最小副本（三字段） | `knowledgePoints` 分组键；`coverage` 分母；`nextReview` 的 `untested`（仅 `evidence === "explicit"` 的未测题） | model:253-261, 287-292 |
| `answer-scored.localDate` + `questionKey` | `scores` 键 `"<localDate>\u007c<questionKey>"`（首见写入，重复丢弃） | `lastScoredLocalDate`；`recentIssues[].localDate` | model:177-193 |
| `answer-scored.total` | `scores[key].total`（Number 归一，非有限 → 0） | `questionMastery[qk].masteryScore`：首评 `round2(total)`，其后 `round2(0.6·new + 0.4·prev)`；`lastTotal`；`recentIssues[].total` | model:46-47, 131-137, 227-234 |
| `answer-scored.scoredAt` | `scores[key].scoredAt` | `generatedAt`（最后一条评分 scoredAt，确定性） | model:171-174, 299 |
| `answer-scored.feedback.issues` / `feedback.issueCategories` | `scores[key].issues` / `scores[key].issueCategories`（非空字符串过滤） | `recentIssues`（按 seq 序取最后 5 条） | model:240-248, 48, 310 |
| `eventId/eventKey`（行级） | `scores[key].eventId/eventKey`；`questionMastery[qk].lastEventId` | `headEventId`；`sourceEventKeys`（评分 seq 序） | model:235, 239, 301-302 |
| seq（行级） | `scores[key].seq`；`currentBank.bankSeq` | 排序键；bank 替换比较键 | §12 |
| —（无 bank） | `currentBank === null` | **`status: "resume_required"`**，`questionMastery/knowledgePoints` 空、`coverage {tested:0,total:0,ratio:0}`、`recentIssues/weaknesses/nextReview` 空——不得猜测空画像 | model:93, §12 |

**publicView 其余派生（全部从 `currentBank + scores + questionMastery` 重算）：** `questionMastery[qk]` 输出补 `knowledgePointId`（bank 连接）与 `inQuestionBank`；`knowledgePoints` 移植 `knowledgePointStats`（tested 均值 mastery、tested/total、coverage）；`weaknesses` 移植 `compareWeakness` 四键排序（masteryScore 升序 → 知识点 mastery → lastScoredLocalDate → questionKey）；`nextReview` = weaknesses `low_mastery` + untested explicit `untested`，前 5 条。

**容量上限：** `scores` ≤ 2000 键；`currentBank.questions` ≤ 500；`questionMastery` ≤ 500 键。超限抛 `state_limit_exceeded:resume-knowledge.scores|bank|mastery`。

- [ ] 1. 失败测试（Rev 4 断言按新形状修正 + 意见 11 新增）：
  ```js
  test("latest bank event by seq replaces currentBank with its resumeVersion", () => { /* bankA(v1,seq1) → bankB(v2,seq5) → v2 */ });
  test("older bank arriving later never downgrades currentBank", () => { /* */ });
  test("first score per (localDate, questionKey) wins, later duplicates dropped defensively", () => { /* */ });
  test("same question scoreable again on next local date", () => { /* 两个键 */ });
  test("score record carries total and feedback issues/issueCategories", () => {
    // answer-scored {total: 82, feedback:{issues:["i1","", "i2"], issueCategories:["c1"]}}
    // → scores[key] deepEqual {seq, total:82, scoredAt, eventId, eventKey, issues:["i1","i2"], issueCategories:["c1"]}
  });
  test("mastery blends 0.6 * new + 0.4 * previous after the first score", () => {
    // 首日 80 → masteryScore 80；次日 60 → round2(0.6*60 + 0.4*80) = 68；attempts 2、lastTotal 60
  });
  test("missing bank yields resume_required instead of guessing", () => { /* status === "resume_required" */ });
  test("coverage = tested/total per knowledge point from currentBank", () => { /* bankB 替换后按 B 重算 */ });
  test("recentIssues keeps the last 5 scored entries in seq order", () => { /* 7 条评分 → 后 5 条 */ });
  test("nextReview: low_mastery first, then untested explicit-evidence questions, capped at 5", () => { /* */ });
  test("state stays minimal: 300 events < 256 KiB and no evidence text", () => { /* */ });
  test("capacity: 2001st score key throws state_limit_exceeded:resume-knowledge.scores", () => { /* */ });
  test("publicView backfills identity and is deterministic", () => { /* */ });
  ```
- [ ] 2. 预期失败：`forNamespace("resume-knowledge")` 抛 `no_reducer_for_namespace`。
- [ ] 3. 最小实现要点：
  ```js
  const CAP_SCORES = 2000, CAP_BANK_QUESTIONS = 500, CAP_MASTERED = 500;
  const round2 = (v) => Math.round(v * 100) / 100;
  // emptyProjection: (identity) => ({ identity: {...}, currentBank: null, scores: {}, questionMastery: {}, headSeq: 0, headEventKey: null })
  // applyEvent(eventType 分流)：
  //   "resume-knowledge.question-bank-created"：event.event_seq > (currentBank?.bankSeq ?? -1) 才替换；
  //     questions 最小副本 {questionKey, knowledgePointId, evidence}（> CAP_BANK_QUESTIONS 抛错）；
  //   "resume-knowledge.answer-scored"：键 `${localDate}|${questionKey}` 已存在 → 原样返回；
  //     键数达 CAP_SCORES 抛错；total = Number(ev.total)，非有限 → 0；
  //     scores[key] = {seq, total, scoredAt, eventId, eventKey, issues, issueCategories}；
  //     questionMastery[qk]：prev 存在 → masteryScore = round2(0.6*total + 0.4*prev.masteryScore)，
  //     否则 round2(total)；attempts+1；lastTotal；lastEventId；lastScoredLocalDate（> CAP_MASTERED 抛错）。
  // publicView：无 bank → resume_required 视图；有 bank → 移植 model:213-313（字段来源见映射表）；
  //   recentIssues 从 scores 按 seq 升序取后 5 条，questionKey 由键切分（localDate 固定 10 字符 + "|" 前缀）。
  ```
  （注册 `projectionName("resume-knowledge") = "resume-knowledge"`。）
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/reducers/resume-knowledge.js services/reliable-drive-sync-worker/src/rds2/reducers/index.js services/reliable-drive-sync-worker/test/rds2-reducer-resume-knowledge.test.js && git commit -m "feat(v2): resume knowledge reducer with total-feedback score index and mastery blend"`。

### Task 2.14 引擎 2 MiB 上限集成断言（适配继承 Rev 4）

**Files:** Test `services/reliable-drive-sync-worker/test/rds2-state-limit.test.js`（复用 Task 2.7 引擎 + 子计划 1 迁移）
**Interfaces:** Consumes Task 2.7、子计划 1 sqlite-adapter + 迁移 0006

- [ ] 逐字继承 Rev 4 Task 2.14 两条测试（超限转 needs_attention 零写入；2 MiB 边界恰好值仍写入），仅桩 Reducer 方法名随 Task 2.9 契约改为 `emptyProjection`。
- [ ] 追加一条：`state_limit_exceeded:*` 容量错误（桩 applyEvent 抛出）在真实迁移 schema 下同样转 needs_attention 且零写入（意见 11 接线回归）。
- [ ] 提交：`git add services/reliable-drive-sync-worker/test/rds2-state-limit.test.js && git commit -m "test(v2): state limit boundary integration assertions"`。

### Task 2.15 四域 fold/增量等价套件（子计划 2 完成门）

**Files:** Create `test/rds2-equivalence-algorithm.test.js`、`test/rds2-equivalence-generic-profile.test.js`、`test/rds2-equivalence-interview.test.js`、`test/rds2-equivalence-resume-knowledge.test.js`
**Interfaces:** Consumes Task 2.7/2.9–2.13
**Rev 5 修订：** 继承 Rev 4 输入规则（eventKey 全唯一、乱序指业务时间乱序）之外，新增身份回填与确定性断言（意见 7④/意见 11）。

- [ ] 1. 失败测试（四文件同一骨架，每域独立实例化）：
  ```js
  // 以 algorithm 为例；其余三域替换事件构造器
  for (const batchSize of [1, 3, 7, 10]) {
    test(`fold equals incremental with batch ${batchSize}`, async () => {
      const events = buildCanonicalEventSeries(); // 每域 12 个合法事件，eventKey 全唯一，
      // 含业务时间乱序（observedAt 与 seq 反序）、迟到回填、同 session 多版本 review、多 bank 替换、
      // generic-profile 单事件多 observations
      const identity = { userId: "u-1", username: "乔" };
      const folded = foldAll(reducer, events, identity);
      const incremental = await runIncremental(engine, events, batchSize); // 分批 accept + processTask
      assert.deepEqual(incremental.publicView, folded);
      assert.equal(incremental.lastEventSeq, events.at(-1).event_seq);
    });
  }
  test("publicView identity is backfilled and never null (fold and incremental agree)", async () => {
    // 两种路径的 publicView.userId === identity.userId、username === identity.username
  });
  test("fold is deterministic: two foldAll runs are deep-equal", async () => {
    // 含 generatedAt（确定性来源，非 now()）
  });
  test("out-of-order arrival converges to seq order (business time is not the fold key)", async () => { /* 同 Rev 4 */ });
  test("every input eventKey is unique (DB unique index would reject duplicates)", () => { /* 同 Rev 4 */ });
  ```
  `runIncremental(engine, events, batchSize)` 为测试文件内联助手：按批调用 accept-service + engine.processTask（复用子计划 1 助手）。
- [ ] 2. 预期失败：若任一 Reducer 违反等价（publicView 依赖 seq 之外的输入），对应断言 fail——修复在对应 Reducer 文件内进行，必须以独立 commit 落地，消息按域取：`fix(v2): restore fold equivalence for algorithm|generic-profile|interview|resume-knowledge`，禁止笼统提交。
- [ ] 3. 全部通过后：`npm run test:worker` 预期 `# fail 0`；`npm run test:bridge` 预期 `# fail 0`。
- [ ] 4. 提交：`git add services/reliable-drive-sync-worker/test/rds2-equivalence-algorithm.test.js services/reliable-drive-sync-worker/test/rds2-equivalence-generic-profile.test.js services/reliable-drive-sync-worker/test/rds2-equivalence-interview.test.js services/reliable-drive-sync-worker/test/rds2-equivalence-resume-knowledge.test.js && git commit -m "test(v2): four-domain fold and incremental equivalence suites"`。

## 覆盖与自检（子计划 2 完成门）

- [ ] 规格映射：§13 全条（2.2–2.6/2.8，含两条必测链路、batch 级签名统一、唤醒经 Dispatcher、阈值接线）、§12 全条（2.7/2.9–2.15：首次启动 emptyProjection、五组操作、精确 taskId、四域字段级映射、容量上限、2 MiB、等价语义）、§15.1 预算器双检查（2.1）、§15.2 独立 cron（2.4）、§16 失败恢复表（2.7/2.8/2.15）。
- [ ] Codex 四审意见映射：意见 1 → 2.1；意见 7 → 2.7/2.8/2.9；意见 8 → 2.3/2.4/2.5/2.6/2.8；意见 11 → 2.9/2.10/2.11/2.12/2.13。
- [ ] `grep -rn "BETWEEN" services/reliable-drive-sync-worker/src/rds2/` 零命中。
- [ ] `grep -rn "Promise.all" services/reliable-drive-sync-worker/src/rds2/recovery.js services/reliable-drive-sync-worker/src/rds2/dispatcher-v2.js` 零命中。
- [ ] `grep -rn "displayName" services/reliable-drive-sync-worker/src/rds2/` 零命中。
- [ ] `grep -rn "emptyState" services/reliable-drive-sync-worker/src/rds2/ services/reliable-drive-sync-worker/test/rds2-*.test.js` 零命中（契约更名回归锁）。
- [ ] `grep -rn "userId: null" services/reliable-drive-sync-worker/src/rds2/` 零命中（publicView 身份回填回归锁）。
- [ ] `grep -rn "queueIo.sendWake" services/reliable-drive-sync-worker/src/rds2/` 仅命中 `dispatcher-v2.js`（唤醒唯一通道回归锁）。
- [ ] `grep -rn "queue_message_id" services/reliable-drive-sync-worker/src/rds2/` 仅命中列定义与建表 SQL，无业务读写。
- [ ] `grep -rn "accepted" services/reliable-drive-sync-worker/src/rds2/reducers/` 零命中（禁止完整事件数组回归）。
- [ ] `grep -rn "evidence" services/reliable-drive-sync-worker/src/rds2/reducers/generic-profile.js` 仅命中注释与 `evidenceRefs`/`sourceRefs` 派生（状态不存 evidence 全文回归锁，允许映射表/注释提及）。
- [ ] 四队列消费者齐备且全部 batch 级签名（Task 2.5 测试锁定）；crons 前三项逐字节保留（Task 2.4 测试锁定）。
- [ ] Task 2.3/2.4/2.8 三个测试文件均含并发或重复发布路径断言（不存在"不产生重复发布"的测试）。
- [ ] Task 2.3 含阈值接线测试（attempt_count=4 + send 失败 → needs_attention）；Task 2.8 含续批唤醒经 dispatcher.run 断言。
- [ ] `grep -rn "TODO\|TBD\|同上\|参考前文\|必要修复\|<tmp>\|<skill>" services/reliable-drive-sync-worker/src/rds2/ services/reliable-drive-sync-worker/test/rds2-*.test.js` 零命中。
