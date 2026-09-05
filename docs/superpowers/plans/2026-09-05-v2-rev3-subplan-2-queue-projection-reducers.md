# RDS2 Queue, Projection Engine and Domain Reducers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接入 Cloudflare Queue（四队列全配消费者，消息体 `{taskId, taskType, attempt}`，不依赖生产端 message ID），实现允许重复发布/无副作用重复消费的 D1 Outbox 调度与恢复，落地游标触发器 CAS 的增量投影引擎，并按真实源码规则移植四个领域 Reducer（含非单调修订的内部状态设计）。

**Architecture:** `POST /v2/events` 接收成功后由 dispatcher 认领 `t_project_<seq>` 并 `queue.send({taskId,taskType,attempt})`；消费者按 `batch.queue` 路由；投影引擎一次推进至多 10 个事件，单个 D1 batch 内完成【投影 UPDATE（触发器 CAS）+ 批量完成已覆盖任务 + 冻结两个归档对象 + 建归档任务】；*/5 cron 中 V1 reconciler 先行、V2 恢复器 try/catch 隔离并预留 15 额度；Reducer 的 `state_json` 保存按 seq 有序的已接受事件列表（非单调修订可重放撤销），`publicView` 从状态确定性重算。

**Tech Stack:** Cloudflare Queues（producers + 4 consumers）、D1 batch、Node test runner、`node:sqlite` 适配器（子计划 1）+ Miniflare（集成断言复用其助手模式）。

**Spec:** 规格 §13（Rev 3：taskId 关联、重复发布合法、DLQ 消费者）、§12（非单调状态、fold 等价）、§15.2（消费者/恢复器预算行）、§16（失败恢复表）。

## Global Constraints

- 前置门 G0 与提交规范同主索引；受保护路径同子计划 1。
- 禁止断言或实现“同一 taskId 不重复发布”；禁止在业务路径读取 `queue_message_id`。
- 本子计划不触碰 `src/index.js` 的 `fetch` 路由与 V1 `scheduled()` 逻辑本身（`scheduled()` 按 Task 2.3 的明确 diff 追加 V2 分支，V1 表达式逐字节保留）。
- 每 Task 回滚：`git revert <本任务SHA>`。

## Interfaces

- **Consumes**：子计划 1 全部 Produces（`shared/rds2-protocol.mjs`、六仓库、accept-service、sqlite-adapter、Miniflare 助手模式）。
- **Produces**：`src/rds2/queue-io.js` 导出 `createQueueIo(budget, bindings)` → `{sendWake(taskId, taskType, attempt)}`；`src/rds2/dispatcher-v2.js` 导出 `createDispatcher(db, {outbox, queueIo})`；`src/rds2/recovery.js` 导出 `createRecovery(db, {outbox, dispatcher, budget})`；`src/rds2/queue-consumer.js` 导出 `routeQueueMessage(batch, env, processors)`；`src/rds2/projection-engine.js` 导出 `createProjectionEngine(db, deps)`；`src/rds2/reducers/index.js` 导出 `createReducerRegistry()`；`src/rds2/fold-all.js` 导出 `foldAll(reducer, events, identity)`；四域 Reducer 各导出 `{name, applyEvent(state, event), publicView(state), emptyState()}`。

---

### Task 2.1 Queue 消息契约与预算化发送封装

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/queue-io.js`；Test `services/reliable-drive-sync-worker/test/rds2-queue-io.test.js`
**Interfaces:** Produces `createQueueIo` | Consumes SubrequestBudget 接口（`consume(category, count)`，本 Task 用内联假预算器，公共预算器在子计划 3 Task 3.2 定稿前以同签名本地桩满足）

- [ ] 1. 失败测试：
  ```js
  test("sendWake consumes queue budget and sends fixed body", async () => {
    const consumed = [];
    const budget = { consume: (category, count = 1) => { consumed.push([category, count]); } };
    const sent = [];
    const queueIo = createQueueIo(budget, { RDS2_PROJECT_QUEUE: { async send(body) { sent.push(body); } } });
    await queueIo.sendWake("t_project_101", "project_event", 1);
    assert.deepEqual(consumed, [["queue", 1]]);
    assert.deepEqual(sent, [{ taskId: "t_project_101", taskType: "project_event", attempt: 1 }]);
  });
  test("message body never contains queue_message_id or business truth", () => {
    // 遍历 sendWake 捕获的 body：键集合恰为 {taskId, taskType, attempt}
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

### Task 2.2 dispatcher：认领 → 发布 → 回写（允许重复发布）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/dispatcher-v2.js`；Test `services/reliable-drive-sync-worker/test/rds2-dispatcher-v2.test.js`
**Interfaces:** Produces `createDispatcher` | Consumes Task 2.1, 子计划 1 outbox-repository

- [ ] 1. 失败测试：
  ```js
  test("publish success marks queued with queue_message_id left NULL", async () => { /* dispatch("t_project_1") → 行 state='queued'，queue_message_id IS NULL */ });
  test("send failure releases lease and sets available_at", async () => { /* send 抛错 → state='pending'，available_at>now，last_error_code='queue_send_failed' */ });
  test("write-back failure leaves queued state and allows republish of same taskId", async () => {
    // markQueued 抛 illegal_state_transition 的注入场景：dispatch 返回 {outcome:"reconcile_needed"}
    // 消息已发出；再次 dispatch 同 taskId：任务仍 queued → 直接 markQueued 幂等成功（或重发消息），断言不抛错且最终 state='queued'
  });
  test("dispatch of completed task is a no-op", async () => { /* state='completed' → 不 send */ });
  ```
  关键断言（复审第 2 条）：**不存在**“不产生重复发布”的测试；重复发布路径显式覆盖。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  export function createDispatcher(db, { outbox, queueIo }) {
    return async function dispatch(taskId) {
      const task = outbox.byTaskId(taskId);
      if (!task || task.state === "completed") return { outcome: "noop" };
      if (task.state === "queued") { outbox.markQueued(taskId); return { outcome: "requeued_idempotent" }; }
      try {
        await queueIo.sendWake(task.task_id, task.task_type, task.attempt_count);
      } catch (cause) {
        outbox.failWithBackoff(taskId, "queue_send_failed");
        return { outcome: "send_failed" };
      }
      try {
        outbox.markQueued(taskId);
        return { outcome: "queued" };
      } catch (cause) {
        return { outcome: "reconcile_needed" };
      }
    };
  }
  ```
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/dispatcher-v2.js services/reliable-drive-sync-worker/test/rds2-dispatcher-v2.test.js && git commit -m "feat(v2): dispatcher with duplicate-publish-tolerant semantics"`。

### Task 2.3 */5 cron 共存与有界恢复器

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/recovery.js`；Modify `services/reliable-drive-sync-worker/src/index.js`（仅 `scheduled()` 方法体，diff 如下）；Test `services/reliable-drive-sync-worker/test/rds2-recovery.test.js`、`services/reliable-drive-sync-worker/test/rds2-cron-coexistence.test.js`
**Interfaces:** Produces `createRecovery` | Consumes Task 2.2, outbox-repository

- [ ] 1. 失败测试（recovery）：`run()` 认领 ≤5；每任务成本 = send 1 + markQueued 1，总消耗 `budget.snapshot()` 中 d1 类 ≤ 2（claim 1 + 无额外）且 queue ≤ 5；源码静态断言 `recovery.js` 领取路径无 `Promise.all`（`assert.ok(!src.includes("Promise.all"))`）；`attempt_count >= 5` 的到期任务转 `needs_attention`。
- [ ] 2. 失败测试（coexistence，注入假 env/reconciler/recovery）：
  ```js
  test("v1 reconciler runs first byte-identical when v2 disabled", async () => {
    const calls = [];
    const scheduled = buildScheduledHandler({ RDS2_RECOVERY_ENABLED: "false" }, {
      reconciler: { runFiveMinute: () => { calls.push("v1"); } },
      recovery: { run: () => { calls.push("v2"); } }
    });
    await runScheduled(scheduled, { cron: "*/5 * * * *" });
    assert.deepEqual(calls, ["v1"]);
  });
  test("v2 runs after v1 and its failure does not block or reject v1 outcome", async () => {
    // recovery.run 抛错 → await 结果仍正常，calls = ["v1","v2"]，错误被记入 captured log
  });
  test("v1 rejection still propagates when v2 enabled", async () => {
    // v1 抛错 → scheduled 的 promise 仍 reject（finally 链），且 v2 已执行
  });
  ```
- [ ] 3. 预期失败：模块不存在 / `buildScheduledHandler` 未导出。
- [ ] 4. 实现 recovery：
  ```js
  export function createRecovery(db, { outbox, dispatcher, budget }) {
    return async function run() {
      budget.consume("d1", 1); // reclaimExpired
      outbox.reclaimExpired();
      const due = (() => { budget.consume("d1", 1); return outbox.claimDue(5, "rds2-recovery"); })();
      for (const task of due) {
        await dispatcher(task.task_id);
      }
      return { processed: due.length };
    };
  }
  ```
- [ ] 5. 修改 `src/index.js` `scheduled()`（V1 表达式原样保留为 `v1Work`）：
  ```js
  scheduled(controller, _runtimeEnv, context) {
    const env = _runtimeEnv;
    const v1Work = controller?.cron === "0 * * * *"
      ? reconciler.runHourly()
      : controller?.cron === "0 */6 * * *"
        ? reconciler.runSixHourly()
        : reconciler.runFiveMinute();
    const v2Enabled = env.RDS2_RECOVERY_ENABLED === "true";
    context.waitUntil((async () => {
      try {
        await v1Work;
      } finally {
        if (v2Enabled) {
          try {
            await createRecovery(env.DB, { outbox: buildOutbox(env), dispatcher: buildDispatcher(env), budget: createRecoveryBudget() }).run();
          } catch (cause) {
            console.error(JSON.stringify({ event: "rds2_recovery_failed", code: cause?.code ?? "recovery_error" }));
          }
        }
      }
    })());
  }
  ```
  `buildOutbox/buildDispatcher/buildRecoveryBudget` 为本 Task 新增的 env 装配函数（同文件底部，`createWorker` 内私有），`createRecoveryBudget()` 返回上限 15 的预算器（构造逻辑在子计划 3 Task 3.2 定稿前以内联对象桩实现：`{consume(){}, snapshot: () => ({limit:15})}` 并注明来源）。
- [ ] 6. `npm run test:worker` 预期 `# fail 0`；`npm run test:bridge` 预期 `# fail 0`（index.js 改动不影响 bridge）。
- [ ] 7. 提交：`git add services/reliable-drive-sync-worker/src/rds2/recovery.js services/reliable-drive-sync-worker/src/index.js services/reliable-drive-sync-worker/test/rds2-recovery.test.js services/reliable-drive-sync-worker/test/rds2-cron-coexistence.test.js && git commit -m "feat(v2): bounded recovery coexisting with v1 cron"`。

### Task 2.4 Queue handler 接入 default export + 四队列 TOML

**Files:** Modify `services/reliable-drive-sync-worker/src/index.js`（default export 与 `createWorker` 各追加 queue 方法）、`services/reliable-drive-sync-worker/wrangler.toml`（追加 producers/consumers 块）；Create `src/rds2/queue-consumer.js`；Test `services/reliable-drive-sync-worker/test/rds2-queue-consumer.test.js`
**Interfaces:** Produces `routeQueueMessage` | Consumes Task 2.1–2.3

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
  test("processor failure surfaces so message is retried (no swallow)", async () => {
    // processor 抛错 → worker.queue rejects
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
- [ ] 4. `wrangler.toml` 追加（逐行书写，置于文件末尾，V1 内容不动）：
  ```toml
  [[queues.producers]]
  binding = "RDS2_PROJECT_QUEUE"
  queue = "rds2-project"

  [[queues.producers]]
  binding = "RDS2_ARCHIVE_QUEUE"
  queue = "rds2-archive"

  [[queues.consumers]]
  queue = "rds2-project"
  max_batch_size = 10
  max_retries = 5
  dead_letter_queue = "rds2-project-dlq"

  [[queues.consumers]]
  queue = "rds2-archive"
  max_batch_size = 8
  max_retries = 5
  dead_letter_queue = "rds2-archive-dlq"

  [[queues.consumers]]
  queue = "rds2-project-dlq"
  max_batch_size = 10
  max_retries = 3

  [[queues.consumers]]
  queue = "rds2-archive-dlq"
  max_batch_size = 8
  max_retries = 3
  ```
- [ ] 5. `src/index.js` default export 追加：
  ```js
  export default {
    fetch(request, env, context) { return createWorker(env).fetch(request, env, context); },
    scheduled(controller, env, context) { return createWorker(env).scheduled(controller, env, context); },
    queue(batch, env, context) { return createWorker(env).queue(batch, env, context); }
  };
  ```
  `createWorker` 返回对象追加 `queue: createQueueProcessor(env, buildProcessors(env))`，`buildProcessors` 本 Task 先注册空处理器映射（`{"rds2-project": async () => {}, "rds2-archive": async () => {}, "rds2-project-dlq": ..., "rds2-archive-dlq": ...}`），Task 2.5/2.7 替换为真实现。
- [ ] 6. 验证：`npm run test:worker` 预期 `# fail 0`；`npx --yes wrangler deploy --config services/reliable-drive-sync-worker/wrangler.toml --dry-run --outdir "$PWD/services/reliable-drive-sync-worker/tmp-dryrun-t24"` 退出码 0（TOML 语法门），随后删除该目录。
- [ ] 7. 提交：`git add services/reliable-drive-sync-worker/src/index.js services/reliable-drive-sync-worker/src/rds2/queue-consumer.js services/reliable-drive-sync-worker/wrangler.toml services/reliable-drive-sync-worker/test/rds2-queue-consumer.test.js && git commit -m "feat(v2): queue handler in default export with four consumer config"`。

### Task 2.5 DLQ 消费者：按 taskId 置 needs_attention

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/dlq-consumer.js`；Modify `src/index.js`（`buildProcessors` 中两个 DLQ 键替换为真实现）；Test `services/reliable-drive-sync-worker/test/rds2-dlq.test.js`
**Interfaces:** Produces `createDlqProcessor` | Consumes outbox-repository

- [ ] 1. 失败测试：消息 `{taskId:"t_project_1"}` → 行 `state='needs_attention'`、`last_error_code='dlq_exhausted'`；未知 taskId → 仅返回 `{outcome:"unknown_task"}` 不抛错（消息 ack，防 DLQ 死循环）；`completed` 行 → `{outcome:"noop"}` 保持 completed；兜底通道：recovery 的 `reclaimExpired + failWithBackoff` 把长期 `queued/processing` 行（租约过期 + 阈值）也转 `needs_attention`（复用 Task 2.3 断言，此处补“DLQ 消费者自身故障时兜底仍生效”的注入测试：DLQ processor 抛错不影响 recovery 路径的 needs_attention 转移）。
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 实现：
  ```js
  export function createDlqProcessor(db, { outbox }) {
    return async function process(body) {
      const task = outbox.byTaskId(body.taskId);
      if (!task) return { outcome: "unknown_task" };
      if (task.state === "completed") return { outcome: "noop" };
      outbox.toNeedsAttention(body.taskId, "dlq_exhausted");
      return { outcome: "needs_attention" };
    };
  }
  ```
  `outbox.toNeedsAttention(taskId, code)` 为子计划 1 Task 1.11 已有 `failWithBackoff` 阈值路径的直接调用（`attempt_count` 已 ≥ 阈值时即转移；本 Task 在 outbox-repository 上补一个显式 `toNeedsAttention(taskId, code)` 方法与单测，`git add` 包含子计划 1 文件 `src/rds2/outbox-repository.js` 与其测试文件的追加 diff）。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/dlq-consumer.js services/reliable-drive-sync-worker/src/rds2/outbox-repository.js services/reliable-drive-sync-worker/src/index.js services/reliable-drive-sync-worker/test/rds2-dlq.test.js services/reliable-drive-sync-worker/test/rds2-outbox-repository.test.js && git commit -m "feat(v2): dlq consumers routing by task id"`。

### Task 2.6 投影引擎（触发器 CAS + 原子归档冻结）

**Files:** Create `services/reliable-drive-sync-worker/src/rds2/projection-engine.js`；Test `services/reliable-drive-sync-worker/test/rds2-projection-engine.test.js`
**Interfaces:** Produces `createProjectionEngine(db, deps)` → `processTask(taskId)` | Consumes 子计划 1 全部仓库、`shared/rds2-protocol.mjs`
**排序说明：** 本 Task 位于 Task 2.8（reducer registry）之前，`deps.reducer` 由测试文件内联桩 Reducer（最小 `{applyEvent, publicView, emptyState}` 对象）提供以驱动引擎测试；Task 2.8 交付 `createReducerRegistry()` 后，Task 2.7 的处理器接线改用真实 registry，本 Task 代码零改动（`deps` 注入即契约）。

- [ ] 1. 失败测试（核心六条）：
  ```js
  test("advances cursor by at most 10 events in one atomic batch", async () => { /* 15 个事件 → 引擎推进 10，cursor=10，任务 1..10 completed，11..15 pending */ });
  test("stale consumer batch fails with zero side effects", async () => {
    // 预置 cursor=110；构造“从 100 读出的旧任务”重放 → updateAdvanced 抛 stale_projection_write
    // 断言：task 仍 processing、archive_deliveries 无新行、archive task 无新行（零副作用）
  });
  test("duplicate message after cursor advanced completes task without reapplying", async () => {
    // cursor 已 >= 事件 seq → {outcome:"noop_confirmed"}，publicView 未变化（content_hash 相同）
  });
  test("freeze freezes event artifact and snapshot artifact with deterministic ids", async () => {
    // archive_deliveries 两行：artifact_key='business-event:<eventId>'、'projection:<user>:<ns>:<name>:<seq>'
    // drive_path = 'my-chatGPT-skills-v2/users/<userId>/<namespace>/events/event-<eventId>.json' 与 '.../snapshots/<name>-through-<seq>.json'
    // outbox 两行 t_archive_<deliveryId> 且 CHECK 通过
  });
  test("mid-batch archive insert failure rolls back projection update and task completion", async () => { /* 注入 batch 第三条失败 → 全回滚 */ });
  test("engine never touches drive or queue directly", () => {
    const src = readFileSync(enginePath, "utf8");
    assert.ok(!src.includes("googleapis.com"));
    assert.ok(!src.includes("queue.send"));
  });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（核心 batch 组装）：
  ```js
  import { canonicalJson, sha256Hex } from "../../../shared/rds2-protocol.mjs";
  const BATCH_LIMIT = 10;
  export function createProjectionEngine(db, { events, projections, outbox, archiveRepo, registry }) {
    return async function processTask(taskId) {
      const task = outbox.byTaskId(taskId);
      if (!task || task.state === "completed") return { outcome: "noop_confirmed" };
      const event = db.prepare("SELECT * FROM rds2_business_events WHERE event_seq = ?").first(task.event_seq);
      const projectionName = registry.projectionName(event.namespace);
      let projection = projections.get(event.user_id, event.namespace, projectionName);
      if (!projection) { projections.upsert(event.user_id, event.namespace, projectionName); projection = projections.get(event.user_id, event.namespace, projectionName); }
      if (projection.last_event_seq >= event.event_seq) { outbox.complete(taskId); return { outcome: "noop_confirmed" }; }
      const fresh = events.readAfter(event.user_id, event.namespace, projection.last_event_seq, BATCH_LIMIT);
      const reducer = registry.forNamespace(event.namespace);
      let state = JSON.parse(projection.state_json);
      for (const row of fresh) state = reducer.applyEvent(state, registry.toDomainEvent(row));
      const lastSeq = fresh[fresh.length - 1].event_seq;
      const publicView = reducer.publicView(state);
      const contentHash = await sha256Hex(canonicalJson(publicView));
      const eventDelivery = await archiveRepo.freeze({
        artifactKind: "business_event", artifactKey: `business-event:${event.event_id}`,
        userId: event.user_id, namespace: event.namespace, sourceEventSeq: event.event_seq,
        artifactJson: event.envelope_json, artifactHash: event.envelope_hash,
        drivePath: `my-chatGPT-skills-v2/users/${event.user_id}/${event.namespace}/events/event-${event.event_id}.json`
      });
      const snapDelivery = await archiveRepo.freeze({
        artifactKind: "projection_snapshot", artifactKey: `projection:${event.user_id}:${event.namespace}:${projectionName}:${lastSeq}`,
        userId: event.user_id, namespace: event.namespace, projectionName, projectionEventSeq: lastSeq,
        artifactJson: canonicalJson(publicView), artifactHash: contentHash,
        drivePath: `my-chatGPT-skills-v2/users/${event.user_id}/${event.namespace}/snapshots/${projectionName}-through-${lastSeq}.json`
      });
      await db.batch([
        { sql: `UPDATE rds2_projections SET last_event_seq=?, state_json=?, public_view_json=?, content_hash=?, updated_at=? WHERE user_id=? AND namespace=? AND projection_name=?`,
          params: [lastSeq, JSON.stringify(state), canonicalJson(publicView), contentHash, new Date().toISOString(), event.user_id, event.namespace, projectionName] },
        { sql: `UPDATE rds2_event_outbox SET state='completed', updated_at=? WHERE task_type='project_event' AND event_seq BETWEEN ? AND ? AND state != 'completed'`,
          params: [new Date().toISOString(), fresh[0].event_seq, lastSeq] },
        { sql: `INSERT INTO rds2_event_outbox (task_id, task_type, event_seq, archive_delivery_id, state, attempt_count, queue_message_id, available_at, created_at, updated_at) VALUES (?, 'archive_artifact', NULL, ?, 'pending', 0, NULL, ?, ?, ?)`,
          params: [`t_archive_${eventDelivery.archive_delivery_id}`, eventDelivery.archive_delivery_id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString()] },
        { sql: `INSERT INTO rds2_event_outbox (task_id, task_type, event_seq, archive_delivery_id, state, attempt_count, queue_message_id, available_at, created_at, updated_at) VALUES (?, 'archive_artifact', NULL, ?, 'pending', 0, NULL, ?, ?, ?)`,
          params: [`t_archive_${snapDelivery.archive_delivery_id}`, snapDelivery.archive_delivery_id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString()] }
      ]);
      return { outcome: "advanced", lastSeq, advanced: fresh.length };
    };
  }
  ```
  （`freeze` 在 batch 之外先执行并依赖 `artifact_key` UNIQUE 幂等；batch 失败时已冻结的 delivery 行保留为 `pending`，重放时 `freeze` 返回原行、重插 outbox 由 task_id 主键幂等——此语义由 Task 2.6 第 5 条测试与 Task 2.13 等价套件共同锁定。）
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/projection-engine.js services/reliable-drive-sync-worker/test/rds2-projection-engine.test.js && git commit -m "feat(v2): projection engine with trigger cas and atomic archive freezing"`。

### Task 2.7 投影消费者接线与重复消费端到端

**Files:** Modify `src/index.js`（`buildProcessors` 的 `rds2-project` 键替换为引擎接线）、`src/rds2/queue-consumer.js`（保持不变）；Test `services/reliable-drive-sync-worker/test/rds2-duplicate-consumption.test.js`
**Interfaces:** Consumes Task 2.4/2.6

- [ ] 1. 失败测试（复审“发布成功、回写失败、重复发布”场景端到端）：
  ```js
  test("duplicate publish then duplicate consume yields one projection advance and one artifact set", async () => {
    // 步骤：accept 事件 → dispatcher 两次 dispatch（模拟回写失败后恢复器重发）
    // 消费同一 taskId 两次 → 第一次 advanced，第二次 noop_confirmed
    // 断言：projections.last_event_seq 只推进一次的值；archive_deliveries 恰 2 行；topicMastery 计数无翻倍
  });
  ```
- [ ] 2. 预期失败：`rds2-project` 处理器为空实现。
- [ ] 3. 实现 `buildProcessors` 的 project 键：
  ```js
  "rds2-project": async (body) => { await engine.processTask(body.taskId); },
  ```
  引擎实例化加入 `createWorker` 私有装配（与 Task 2.3 的 buildOutbox 同区）。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/index.js services/reliable-drive-sync-worker/test/rds2-duplicate-consumption.test.js && git commit -m "feat(v2): project consumer wiring and duplicate consumption proof"`。

### Task 2.8 fold-all Oracle 与 Reducer 契约

**Files:** Create `src/rds2/reducer-contract.js`、`src/rds2/fold-all.js`、`src/rds2/reducers/index.js`；Test `test/rds2-reducer-contract.test.js`、`test/rds2-fold-all.test.js`
**Interfaces:** Produces `assertReducer`, `foldAll`, `createReducerRegistry` | Consumes 无

- [ ] 1. 失败测试：`assertReducer` 对缺 `applyEvent/publicView/emptyState` 的对象抛 `invalid_reducer`；纯函数断言（同输入两次调用 `publicView` 深相等）；`foldAll(reducer, events, identity)` 按 `event_seq ASC` 排序后从 `emptyState` 逐个 apply 再 `publicView`；**语义变更固化断言**：构造 seq 顺序与 observedAt 顺序相反的两事件，断言 V2 fold 的 `currentTopic` 取 seq 最大者（与 V1 observedAt 序结果不同），测试注释注明“这是 Rev2/Rev3 锁定的 V2 排序语义，非缺陷”。
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
  `createReducerRegistry()` 返回 `{ forNamespace(ns), projectionName(ns), toDomainEvent(row) }`；`toDomainEvent(row)` 返回 `{ event_seq: row.event_seq, eventId: row.event_id, eventKey: row.event_key, namespace: row.namespace, eventType: row.event_type, payload: JSON.parse(row.envelope_json).payload, userId: row.user_id, username: JSON.parse(row.envelope_json).identity?.displayName ?? null }`；`forNamespace` 未知 namespace 抛 `no_reducer_for_namespace`。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/reducer-contract.js services/reliable-drive-sync-worker/src/rds2/fold-all.js services/reliable-drive-sync-worker/src/rds2/reducers/index.js services/reliable-drive-sync-worker/test/rds2-reducer-contract.test.js services/reliable-drive-sync-worker/test/rds2-fold-all.test.js && git commit -m "feat(v2): reducer contract and seq-ordered fold-all oracle"`。

### Task 2.9 algorithm Reducer（仅真实规则）

**Files:** Create `src/rds2/reducers/algorithm.js`；Test `test/rds2-reducer-algorithm.test.js`
**Interfaces:** Produces algorithm reducer | Consumes Task 2.8；规则蓝本 `src/algorithm-profile-model.js`（只读）

- [ ] 1. 失败测试（规则逐条来自 `algorithm-profile-model.js:6-91`，无 correction/依赖顺序规则——复审明确）：
  ```js
  test("completed/correct add positive, incorrect/stuck/partial add negative, consulted is neutral", () => { /* 三分支计数断言 */ });
  test("problemId normalizes to source:title", () => { /* {source:'leetcode',title:'206'} → 'leetcode:206' */ });
  test("pendingProblemIds keeps problem until latest seq outcome is positive", () => { /* seq3 incorrect → pending；seq4 completed → 移出 */ });
  test("weaknesses: negative>0 → open/improving, sorted by negative desc then topic", () => { /* improving 条件 positive>0 */ });
  test("dedupe by eventKey keeps lowest event_seq defensively", () => { /* 合成重复 seq 事件 → 只计一次 */ });
  test("state_json is the accepted event list; publicView is deterministic", () => { /* state 结构 {accepted:[...]}，publicView 两次调用 deepEqual */ });
  ```
- [ ] 2. 预期失败：`forNamespace("algorithm")` 抛 `no_reducer_for_namespace`。
- [ ] 3. 最小实现（移植自 V1 模型，排序基准换成 event_seq）：
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
    emptyState: () => ({ accepted: [] }),
    applyEvent(state, event) {
      return { accepted: [...state.accepted, event] };
    },
    publicView(state) {
      const byKey = new Map();
      for (const e of [...state.accepted].sort((a, b) => a.event_seq - b.event_seq)) {
        if (!byKey.has(e.eventKey)) byKey.set(e.eventKey, e);
      }
      const ordered = [...byKey.values()];
      const topicMastery = {};
      const latestByProblem = new Map();
      for (const e of ordered) {
        const outcome = e.payload.event.outcome;
        const topic = e.payload.event.topic;
        const m = topicMastery[topic] ?? { attempts: 0, negative: 0, positive: 0, neutral: 0, lastOutcome: null, lastEventSeq: null, problemIds: [], eventKeys: [] };
        m.attempts += 1;
        if (NEGATIVE.has(outcome)) m.negative += 1; else if (POSITIVE.has(outcome)) m.positive += 1; else m.neutral += 1;
        m.lastOutcome = outcome; m.lastEventSeq = e.event_seq; m.eventKeys.push(e.eventKey);
        const pid = problemIdOf(e);
        if (pid) { if (!m.problemIds.includes(pid)) m.problemIds.push(pid); latestByProblem.set(pid, e); }
        topicMastery[topic] = m;
      }
      const weaknesses = Object.entries(topicMastery).filter(([, m]) => m.negative > 0)
        .sort((a, b) => (b[1].negative - a[1].negative) || String(a[0]).localeCompare(String(b[0])))
        .map(([topic, m]) => ({ topic, status: m.positive > 0 ? "improving" : "open", negative: m.negative, positive: m.positive, lastOutcome: m.lastOutcome, lastEventSeq: m.lastEventSeq, evidenceEventKeys: m.eventKeys }));
      const pendingProblemIds = [...latestByProblem.entries()].filter(([, e]) => !POSITIVE.has(e.payload.event.outcome)).map(([pid]) => pid);
      const last = ordered.at(-1);
      return { schemaVersion: "1.2", userId: last?.userId ?? null, headEventId: last?.eventId ?? null, sourceEventKeys: ordered.map((e) => e.eventKey), currentTopic: last?.payload?.event?.topic ?? null, topicMastery, weaknesses, pendingProblemIds };
    }
  };
  ```
  注册进 `reducers/index.js`（`assertReducer(algorithmReducer)`，`projectionName("algorithm") = "learning"`）。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/reducers/algorithm.js services/reliable-drive-sync-worker/src/rds2/reducers/index.js services/reliable-drive-sync-worker/test/rds2-reducer-algorithm.test.js && git commit -m "feat(v2): algorithm reducer with seq semantics"`。

### Task 2.10 generic-profile Reducer（supersede/invalidate 非单调状态）

**Files:** Create `src/rds2/reducers/generic-profile.js`；Test `test/rds2-reducer-generic-profile.test.js`
**Interfaces:** Consumes Task 2.8；规则蓝本 `src/generic-profile-model.js:50-97`（只读）

- [ ] 1. 失败测试（复审要求逐条）：
  ```js
  test("supersede deactivates target and stays active itself", () => { /* active 集合断言 */ });
  test("supersede can itself be superseded later", () => { /* 链式两跳 */ });
  test("invalidate deactivates target without adding an active event", () => { /* */ });
  test("targeting inactive or missing event fails validation at reducer boundary", () => { /* target_event_not_found / target_event_inactive */ });
  test("self-target is rejected", () => { /* invalid_profile_event */ });
  test("state_json retains full accepted events so old contributions can be re-derived", () => {
    // state.accepted 含被撤销事件；publicView 里的聚合计数在撤销后回落
  });
  test("publicView groups by dimension+subject with latest-outcome classification", () => { /* openWeaknesses/improvingSignals/stableStrengths/observations 四桶 */ });
  ```
- [ ] 2. 预期失败：`forNamespace("profile")` 抛 `no_reducer_for_namespace`。
- [ ] 3. 最小实现：`applyEvent` 追加事件（state = `{accepted: [...]}`）；`publicView` 移植 `generic-profile-model.js:50-189` 的去重/撤销/分组/分类逻辑，排序基准：去重保最低 seq、撤销校验改为“target 的 seq 严格小于本事件 seq”（V1 用 observedAt，V2 语义切换，测试注释注明）；四桶分类与 `memberOf` 聚合逐字段对齐（positive/negative/partial 计数、负证据重置 distinctPositiveSources、≥2 正源关闭弱点）。注册 `projectionName("profile") = "profile"`。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/reducers/generic-profile.js services/reliable-drive-sync-worker/src/rds2/reducers/index.js services/reliable-drive-sync-worker/test/rds2-reducer-generic-profile.test.js && git commit -m "feat(v2): generic profile reducer with supersedable state"`。

### Task 2.11 interview Reducer（reviewVersion 替换撤销旧贡献）

**Files:** Create `src/rds2/reducers/interview.js`；Test `test/rds2-reducer-interview.test.js`
**Interfaces:** Consumes Task 2.8；规则蓝本 `src/profile-model.js:24-104`（只读）

- [ ] 1. 失败测试：
  ```js
  test("higher reviewVersion replaces the session selection and revokes old contributions", () => {
    // session s1: v1 open weakness W1 → v2 closed W1 → publicView 中 W1 状态为 closed，且 v1 的 evidenceRefs 不再出现
  });
  test("reviewVersion tie is broken by higher event_seq", () => { /* v2,seq=5 vs v2,seq=7 → seq7 胜 */ });
  test("applyProfileChanges=false events contribute identity only", () => { /* 不进 approved 聚合，但 userId 绑定可用 */ });
  test("state_json keeps only the selected review per session (old version removed)", () => { /* selectedBySession 键集合断言 */ });
  test("weakness closure rule: >=2 passing sessions and >=2 passing variants", () => { /* 对齐 profile-model.js:85-90 */ });
  ```
- [ ] 2. 预期失败：`forNamespace("interview")` 抛 `no_reducer_for_namespace`。
- [ ] 3. 最小实现：state = `{ selectedBySession: {} }`；`applyEvent(state, e)`：仅处理 `interview.review.completed`；`const cur = state.selectedBySession[e.payload.event.sessionId]; if (!cur || reviewVersion(e) > reviewVersion(cur) || (reviewVersion(e) === reviewVersion(cur) && e.event_seq > cur.event_seq)) state = {...state, selectedBySession: {...state.selectedBySession, [sessionId]: e}}; return state;`；`publicView` 移植 `profile-model.js` 的 `statusOf/changeEvidence/domainProfiles/generalCompetencies` 聚合，遍历对象仅用 selected reviews（旧版本贡献天然消失）。注册 `projectionName("interview") = "interview"`。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/reducers/interview.js services/reliable-drive-sync-worker/src/rds2/reducers/index.js services/reliable-drive-sync-worker/test/rds2-reducer-interview.test.js && git commit -m "feat(v2): interview reducer with review version replacement"`。

### Task 2.12 resume-knowledge Reducer（防御性同日去重）

**Files:** Create `src/rds2/reducers/resume-knowledge.js`；Test `test/rds2-reducer-resume-knowledge.test.js`
**Interfaces:** Consumes Task 2.8；规则蓝本 `src/resume-knowledge-model.js:157-215`（只读）

- [ ] 1. 失败测试：
  ```js
  test("first score per (user,localDate,questionKey) wins, later seq duplicates are dropped defensively", () => { /* 合成同作用域双事件（正常不会发生，DB 约束拦截）→ 取最低 seq */ });
  test("same question scoreable again on next local date", () => { /* localDate 不同 → 都保留 */ });
  test("missing question bank yields resume_required instead of guessing", () => { /* state 无 bank 事件 → publicView.resumeRequired === true */ });
  test("question bank from ledger feeds mastery computation", () => { /* resume-knowledge.question-bank-created 事件提供 questions */ });
  test("coverage = tested/total per knowledge point", () => { /* 对齐 resume-knowledge-model.js:142-153 */ });
  ```
- [ ] 2. 预期失败：`forNamespace("resume-knowledge")` 抛 `no_reducer_for_namespace`。
- [ ] 3. 最小实现：state = `{accepted: []}`；`publicView`：从 accepted 中提取 `question-bank-created` 的 bank（取最低 seq 版本），再移植 `firstScorePerDay`（排序基准 scoredAt+eventId 改为 event_seq，测试注明 V2 语义）、`rebuildResumeKnowledgeProfile` 的掌握度与 coverage 聚合。注册 `projectionName("resume-knowledge") = "resume-knowledge"`。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/reducers/resume-knowledge.js services/reliable-drive-sync-worker/src/rds2/reducers/index.js services/reliable-drive-sync-worker/test/rds2-reducer-resume-knowledge.test.js && git commit -m "feat(v2): resume knowledge reducer with defensive daily dedupe"`。

### Task 2.13 四域 fold/增量等价套件（子计划 2 完成门）

**Files:** Create `test/rds2-equivalence-algorithm.test.js`、`test/rds2-equivalence-generic-profile.test.js`、`test/rds2-equivalence-interview.test.js`、`test/rds2-equivalence-resume-knowledge.test.js`
**Interfaces:** Consumes Task 2.6/2.8–2.12

- [ ] 1. 失败测试（四文件同一骨架，每域独立实例化）：
  ```js
  // 以 algorithm 为例；其余三域替换事件构造器
  for (const batchSize of [1, 3, 7, 10]) {
    test(`fold equals incremental with batch ${batchSize}`, async () => {
      const events = buildCanonicalEventSeries(); // 每域 12 个合法事件，含乱序投递、重复 eventKey、迟到回填
      const folded = foldAll(reducer, events, identity);
      const incremental = await runIncremental(engine, events, batchSize); // 分批喂 accept+processTask
      assert.deepEqual(incremental.publicView, folded);
      assert.equal(incremental.lastEventSeq, events.at(-1).event_seq);
    });
  }
  test("duplicate queue messages have no second effect", async () => { /* 同 taskId 消费两次 → publicView 深相等 */ });
  test("out-of-order arrival converges to seq order", async () => { /* 乱序 accept（seq 仍单调）→ 结果与顺序一致 */ });
  ```
  `runIncremental(engine, events, batchSize)` 为测试文件内联助手：按批调用 accept-service + engine.processTask（复用子计划 1 助手）。
- [ ] 2. 预期失败：若任一 Reducer 违反等价（通常因 publicView 依赖 seq 之外的输入），对应断言 fail——修复在对应 Reducer 文件内进行，且必须以独立 commit 落地，commit 消息按域取以下四者之一：`fix(v2): restore fold equivalence for algorithm`、`fix(v2): restore fold equivalence for generic-profile`、`fix(v2): restore fold equivalence for interview`、`fix(v2): restore fold equivalence for resume-knowledge`，禁止笼统提交。
- [ ] 3. 全部通过后：`npm run test:worker` 预期 `# fail 0`；`npm run test:bridge` 预期 `# fail 0`。
- [ ] 4. 提交：`git add services/reliable-drive-sync-worker/test/rds2-equivalence-algorithm.test.js services/reliable-drive-sync-worker/test/rds2-equivalence-generic-profile.test.js services/reliable-drive-sync-worker/test/rds2-equivalence-interview.test.js services/reliable-drive-sync-worker/test/rds2-equivalence-resume-knowledge.test.js && git commit -m "test(v2): four-domain fold and incremental equivalence suites"`。

## 覆盖与自检（子计划 2 完成门）

- [ ] 规格映射：§13 全条（2.1–2.5）、§16 表（2.6/2.7/2.13）、§12 非单调状态（2.10–2.12）、§15.2 投影/恢复/DLQ 行（2.3/2.7 的预算断言在子计划 3 Task 3.6 汇总复验）。
- [ ] `grep -rn "queue_message_id" src/rds2/` 仅命中列定义与建表 SQL，无业务读写。
- [ ] `grep -rn "Promise.all" src/rds2/recovery.js` 零命中。
- [ ] 四队列消费者齐备（Task 2.4 测试锁定）。
- [ ] `grep -rn "TODO\|TBD\|同上\|参考前文\|必要修复\|<tmp>\|<skill>" src/rds2/ test/rds2-*.test.js` 零命中。
