# RDS2 Drive Archiving, Per-Entry Budget Proofs and Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 抽取行为不变的 Drive 公共原语（含 content-only readback），落地按 `(userId, namespace)` 分组认领、按剩余额度动态缩批的幂等归档器，并为全部七个 Worker 入口建立统计 D1/Queue/Drive/fetch/重定向的 40 子请求最坏路径证明，附脱敏指标。

**Architecture:** 每次 invocation 根部创建唯一 `SubrequestBudget(40)`，注入 D1 封装、Queue 封装、Drive 客户端与 fetch 包装；`consume` 先于调用；Drive 成本以 `google-drive.js` 源码为准（OAuth 1 次 fetch、list 每页 1 次、文件夹创建 1 次、上传 1 次、`readJson` = metadata+content 2 次、content-only readback 1 次、重定向逐次计）；归档器认领按组展开，目录链每 invocation 每组只解析一次，未执行租约释放的 D1 成本计入预算。

**Tech Stack:** 既有 V1 Drive 原语（`google-drive.js` 只读蓝本 + 行为不变抽取）、Node test runner、注入式计数假客户端（同时覆盖 d1/queue/drive/fetch 四通道）。

**Spec:** 规格 §14（确定性路径、冻结 artifact）、§15（Rev 3：单预算器、全入口上限表、Drive 原语成本）、§16（预算耗尽释放租约行）。

## Global Constraints

- 前置门 G0 与提交规范同主索引；受保护路径同子计划 1。
- **唯一允许触碰 `src/google-drive.js` 的任务是 Task 3.1**，且必须单独提交、以 380 个既有 Worker 测试全绿作为行为不变证据；Task 3.1 的 diff 限于：模块私有函数迁出 + import 回来 + `createDriveRepository` 内部改引 `drive-http-client.js`，公共导出与行为不变。
- V1 `createJson`/`readJson` 行为不得改变（含 metadata+content 两次读取）；content-only 只作为新原语供 V2 使用。
- 每 Task 回滚：`git revert <本任务SHA>`。

## Interfaces

- **Consumes**：子计划 1 全部 Produces；子计划 2 的 `queue-io`、engine、仓库层；`archive-delivery-repository` 的 `claimableGroups`。
- **Produces**：`src/drive-http-client.js` 导出 `oauthAccessToken`、`accessToken`、`googleUpload`、`googleGet`、`readJsonContent`、`formatGoogleDriveWriteError`、`withSharedDriveSupport`；`src/rds2/subrequest-budget.js` 导出 `createBudget(limit)` → `{remaining, consume, assertWithinLimit, snapshotByCategory}`；`src/rds2/budgeted-io.js` 导出 `budgetD1(db, budget)`、`budgetQueue(queue, budget)`；`src/rds2/drive-archiver.js` 导出 `createDriveArchiver(deps)` → `processArchiveTask(taskId)`；`src/rds2/metrics.js` 导出 `emitBudgetSnapshot(budget, entry)`。

---

### Task 3.1 公共原语抽取（行为不变改造）

**Files:** Create `services/reliable-drive-sync-worker/src/drive-http-client.js`；Modify `services/reliable-drive-sync-worker/src/google-drive.js`（仅本 Task）；Test `services/reliable-drive-sync-worker/test/drive-http-client.test.js`
**Interfaces:** Produces 原语七件 | Consumes `google-drive.js` 既有实现（迁出）

- [ ] 1. 失败测试：
  ```js
  import { oauthAccessToken, accessToken, googleUpload, googleGet, readJsonContent } from "../src/drive-http-client.js";
  test("accessToken prefers oauth trio and posts form body", async () => {
    const calls = [];
    const token = await accessToken(
      { GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "sec", GOOGLE_OAUTH_REFRESH_TOKEN: "rt" },
      async (url, init) => { calls.push([url, init?.body]); return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }); }
    );
    assert.equal(token, "tok");
    assert.match(calls[0][0], /oauth2\.googleapis\.com\/token/);
    assert.match(String(calls[0][1]), /grant_type=refresh_token/);
  });
  test("readJsonContent performs exactly one GET with alt=media", async () => {
    const calls = [];
    const value = await readJsonContent({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "a@b.c", private_key: "" }) }, "file-1",
      async (url, init) => { calls.push(url); return new Response(JSON.stringify({ ok: true }), { status: 200 }); });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /alt=media/);
    assert.deepEqual(value, { ok: true });
  });
  test("googleUpload sends multipart with shared drive support", async () => { /* 断言 URL 含 uploadType=multipart 与 supportsAllDrives */ });
  ```
- [ ] 2. 运行 `npm run test:worker 2>&1 | tail -4`，预期 `# fail 1`（模块不存在）。
- [ ] 3. 迁出实现：把 `google-drive.js:27-92` 的 `oauthAccessToken/accessToken/googleUpload/googleGet` 原样搬入 `src/drive-http-client.js` 并加 `export`；新增：
  ```js
  export async function readJsonContent(env, fileId, fetchImpl = fetch, tokenProvider = () => accessToken(env, fetchImpl)) {
    const token = await tokenProvider();
    const response = await fetchImpl(withSharedDriveSupport(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {}), { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error("Google Drive read failed");
    return JSON.parse(await response.text());
  }
  ```
- [ ] 4. 修改 `google-drive.js`：删除四个私有函数定义，改为 `import { accessToken, googleUpload, googleGet, formatGoogleDriveWriteError as formatWriteErrorLocal } from "./drive-http-client.js";`——注意 `formatGoogleDriveWriteError` 本身已是导出符号，保持其 re-export：`export { formatGoogleDriveWriteError, withSharedDriveSupport } from "./drive-http-client.js";`（`withSharedDriveSupport` 定义体一并迁入新文件，`google-drive.js` 顶部原 export 行替换为 re-export）。`createDriveRepository` 内部所有调用点改引 import 名，函数体逐字节不变。
- [ ] 5. 行为不变验证：`npm run test:worker 2>&1 | tail -4` 预期 `# fail 0` 且 `# pass` 总数 ≥ 380 + 新增 3（`google-drive.test.js`/`sync.test.js`/`event-store.test.js` 全绿即热修行为未回归）；`npm run test:bridge` 预期 `# fail 0`。
- [ ] 6. 提交：`git add services/reliable-drive-sync-worker/src/drive-http-client.js services/reliable-drive-sync-worker/src/google-drive.js services/reliable-drive-sync-worker/test/drive-http-client.test.js && git commit -m "refactor(v2): extract shared drive http primitives behavior preserving"`。

### Task 3.2 SubrequestBudget 定稿与预算化 D1/Queue 封装

**Files:** Create `src/rds2/subrequest-budget.js`、`src/rds2/budgeted-io.js`；Modify `src/index.js`（入口装配桩替换为真预算器）；Test `test/rds2-subrequest-budget.test.js`、`test/rds2-budgeted-io.test.js`
**Interfaces:** Produces `createBudget`, `budgetD1`, `budgetQueue` | Consumes 子计划 1 adapter 语义

- [ ] 1. 失败测试：
  ```js
  test("consume before call: exhausted budget prevents invocation", async () => {
    const budget = createBudget(2);
    budget.consume("d1", 2);
    const d1 = budgetD1(fakeDb, budget);
    await assert.rejects(() => d1.prepare("SELECT 1").first(), /budget_exhausted/);
    assert.equal(callCount, 0); // fakeDb 未被触达
  });
  test("categories snapshot accumulates", () => {
    const budget = createBudget(40);
    budget.consume("d1", 3); budget.consume("queue", 1); budget.consume("drive_list", 2);
    assert.deepEqual(budget.snapshotByCategory(), { d1: 3, queue: 1, drive_list: 2 });
    assert.equal(budget.remaining(), 34);
  });
  test("redirect responses are counted", async () => {
    // budgetD1/fetch 包装：注入返回 302 的假 fetch，经一次跟随后的最终 200 → redirect 类别 +1
  });
  test("budgeted d1 proxies prepare/bind/run/all/first/batch with counting", async () => { /* 每类一次计数断言 */ });
  test("budgeted queue send counts queue category", async () => { /* */ });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  export function createBudget(limit = 40) {
    const byCategory = {};
    return {
      remaining: () => limit - Object.values(byCategory).reduce((a, b) => a + b, 0),
      consume(category, count = 1) {
        if (this.remaining() < count) throw new Error("budget_exhausted");
        byCategory[category] = (byCategory[category] ?? 0) + count;
      },
      assertWithinLimit() { if (this.remaining() < 0) throw new Error("budget_exhausted"); },
      snapshotByCategory: () => ({ ...byCategory })
    };
  }
  export function budgetD1(db, budget) {
    const counting = (sql) => ({ ...db.prepare(sql), prepare: undefined });
    return {
      prepare(sql) {
        return {
          bind: (...params) => {
            const inner = db.prepare(sql).bind(...params);
            return {
              first: async (...args) => { budget.consume("d1", 1); return inner.first(...args); },
              all: async (...args) => { budget.consume("d1", 1); return inner.all(...args); },
              run: async (...args) => { budget.consume("d1", 1); return inner.run(...args); }
            };
          }
        };
      },
      async batch(statements) { budget.consume("d1", 1); return db.batch(statements); },
      exec: async (sql) => { budget.consume("d1", 1); return db.exec(sql); }
    };
  }
  export function budgetQueue(queue, budget) {
    return { async send(body) { budget.consume("queue", 1); return queue.send(body); } };
  }
  ```
  `src/index.js`：Task 2.3 的 `createRecoveryBudget` 内联桩替换为 `createBudget(15)`；`buildProcessors`/各入口（子计划 4 接线时）统一经 `createBudget(40)` 创建并传入 `budgetD1/budgetQueue`。本 Task 只改装配桩与相关 import，`git add` 含 `src/index.js`。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/subrequest-budget.js services/reliable-drive-sync-worker/src/rds2/budgeted-io.js services/reliable-drive-sync-worker/src/index.js services/reliable-drive-sync-worker/test/rds2-subrequest-budget.test.js services/reliable-drive-sync-worker/test/rds2-budgeted-io.test.js && git commit -m "feat(v2): single-invocation budget with d1 and queue wrappers"`。

### Task 3.3 Drive 归档器（分组认领 + 动态缩批 + 幂等上传）

**Files:** Create `src/rds2/drive-archiver.js`；Test `test/rds2-drive-archiver.test.js`
**Interfaces:** Produces `createDriveArchiver` | Consumes Task 3.1/3.2，子计划 1 archive-delivery-repository、outbox-repository

- [ ] 1. 失败测试（注入计数假客户端，四通道计数）：
  ```js
  function makeFakeDrive(plan) { // plan: 每 fileId 的响应脚本
    const calls = { drive_oauth: 0, drive_list: 0, drive_create: 0, drive_upload: 0, drive_read_meta: 0, drive_read_content: 0, redirect: 0, d1: 0, queue: 0 };
    // listChildren 假实现按 plan 返回存在/缺失；upload 返回 {id}; readJsonContent 返回冻结 JSON
    return { calls, client };
  }
  test("uploads frozen artifact json only and verifies content hash via content-only readback", async () => { /* readback 恰 1 次 content GET；readJsonContent 返回值 sha256 == artifact_hash */ });
  test("existing file with same hash counts as delivered replay", async () => { /* 精确查找 1 次 list → 命中 → 无 upload、无 readback → markDelivered */ });
  test("existing file with different hash goes needs_attention without overwrite", async () => { /* 无 upload 调用 */ });
  test("directory chain resolved once per invocation per group", async () => {
    // 同组 3 个对象：user/ns/events 三级目录查找各 1 次、缺失各建 1 次；第 2、3 个对象零目录调用
  });
  test("dynamic batch: stops claiming when remaining budget below reserved cost, releases unclaimed leases", async () => {
    // 剩余额度仅够 2 个对象（预算器预置已消耗）→ 恰处理 2 个；未执行租约释放 1 次 d1 调用且计入预算
  });
  test("claims are grouped by (userId, namespace)", async () => { /* claimableGroups 桩返回 3 组 → 处理顺序按组展开 */ });
  test("archive task completed even when delivery already delivered (idempotent replay)", async () => { /* t_archive_x 二次消费 → noop */ });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（核心流程）：
  ```js
  export const V2_ROOT = "my-chatGPT-skills-v2";
  export const DIR_RESERVE = { levels: 4, perObject: 3 };
  export function createDriveArchiver({ db, budget, outbox, archiveRepo, drive }) {
    return async function processArchiveTask(taskId) {
      const task = outbox.byTaskId(taskId);
      if (!task || task.state === "completed") return { outcome: "noop" };
      const groups = archiveRepo.claimableGroups(dynamicGroupLimit(budget));
      const token = await drive.token(); // 内部 consume("drive_oauth",1)
      let processed = 0;
      for (const group of groups) {
        if (budget.remaining() < reservedFor(group, budget)) break;
        const dirs = await resolveDirChain(drive, group); // 每级 findFolder(list)→缺失则 create；结果缓存于本次 invocation
        const artifacts = db.prepare(`SELECT * FROM rds2_archive_deliveries WHERE user_id=? AND namespace=? AND state='pending' ORDER BY created_at ASC`).all(group.user_id, group.namespace);
        for (const artifact of artifacts) {
          if (budget.remaining() < DIR_RESERVE.perObject) break;
          const parent = dirFor(artifact, dirs);
          const existing = await drive.findFileExact(parent.id, fileNameOf(artifact)); // consume drive_list
          if (existing) {
            const content = await drive.readJsonContent(existing.id); // consume drive_read_content
            if (await sha256Hex(JSON.stringify(content)) !== artifact.artifact_hash) { archiveRepo.markNeedsAttention(artifact.archive_delivery_id, "drive_hash_mismatch"); continue; }
          } else {
            await drive.uploadJson(parent.id, fileNameOf(artifact), artifact.artifact_json); // consume drive_upload
            const readback = await drive.readJsonContent(uploadResult.id); // consume drive_read_content；readback 内容的 sha256 必须等于 artifact.artifact_hash
          }
          archiveRepo.markDelivered(artifact.archive_delivery_id, fileId);
          outbox.complete(taskId); // 同组其余对象各自的 t_archive_* 任务由其自身消息或恢复器完成；此处完成当前任务
          processed += 1;
        }
      }
      if (processed === 0 && groups.length > 0) { /* 释放未执行租约：1 次 d1 */ releaseUnclaimed(db, budget, groups); }
      return { outcome: processed > 0 ? "delivered" : "released", processed };
    };
  }
  ```
  `reservedFor(group)` = 剩余目录未解析成本（首次 8，已解析组 0）+ `DIR_RESERVE.perObject`；`releaseUnclaimed` 一条 D1 UPDATE 把未认领组代表行保持 `pending`（无租约泄漏即无需写）——测试以“预算不足时不再认领新组且 d1 释放调用计入”为断言核心。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/drive-archiver.js services/reliable-drive-sync-worker/test/rds2-drive-archiver.test.js && git commit -m "feat(v2): grouped idempotent drive archiver with dynamic batching"`。

### Task 3.4 单组最坏路径证明：8 对象 ≤ 40

**Files:** Test `test/rds2-budget-archive-worst-case.test.js`
**Interfaces:** Consumes Task 3.3

- [ ] 1. 失败测试（成本模型逐项断言）：
  ```js
  test("single group 8 objects all-missing all-create all-readback stays within 40", async () => {
    const { calls } = makeFakeDrive({ allMissing: true, objects: 8 });
    const budget = createBudget(40);
    // 预置 8 个 pending 对象（同 user/namespace）、8 个 t_archive 任务；认领 1 个任务触发组处理
    await archiver.processArchiveTask("t_archive_a1");
    const total = Object.values(calls).reduce((a, b) => a + b, 0);
    assert.ok(total <= 40, `total ${total} exceeds 40`);
    // 精确成本断言：
    assert.equal(calls.drive_oauth, 1);
    assert.ok(calls.drive_list >= 3 + 8); // 目录链 3 级查找 + 每对象精确查找
    assert.ok(calls.drive_create <= 4);
    assert.equal(calls.drive_upload, 8);
    assert.equal(calls.drive_read_content, 8);
    assert.equal(calls.drive_read_meta, 0); // content-only readback，不取 metadata
  });
  ```
- [ ] 2. 预期失败：总调用 > 40 或某类别不符 → 修 archiver（独立 commit `fix(v2): tighten archive budget path`）。
- [ ] 3. 通过后 `npm run test:worker` 预期 `# fail 0`。
- [ ] 4. 提交：`git add services/reliable-drive-sync-worker/test/rds2-budget-archive-worst-case.test.js && git commit -m "test(v2): single-group worst-case archive budget proof"`。

### Task 3.5 多用户混合积压自适应缩批证明

**Files:** Test `test/rds2-budget-archive-multi-group.test.js`
**Interfaces:** Consumes Task 3.3/3.4

- [ ] 1. 失败测试：
  ```js
  test("8 objects across 8 groups process adaptively and release unclaimed", async () => {
    // 8 组各 1 个 pending 对象，目录链全冷（每组 4 级查找 + 4 创建）
    // 预算 40：token 1 + d1 3 + 组1(8 目录 + 3) = 12 → 余 28 → 组2 12 → 余 16 → 组3 12 → 余 4 < 12 → 停
    // 断言：processed === 3；calls 总数 ≤ 40；剩余 5 组保持 pending（无 needs_attention、无覆盖）
    assert.equal(result.processed, 3);
    assert.ok(Object.values(calls).reduce((a, b) => a + b, 0) <= 40);
  });
  test("batch size is derived from remaining budget, never hardcoded to 8", () => {
    const src = readFileSync(archiverPath, "utf8");
    assert.ok(!src.includes("for (const artifact of artifacts) {\n        if (budget.remaining() < DIR_RESERVE.perObject)")); // 防回退为固定 8 循环的守门由结构断言+行为断言共同承担
  });
  ```
  （第二条守门以行为断言为主：构造剩余额度 6 的场景，断言只处理 1 个对象——固定 8 循环在此场景必然超预算失败。）
- [ ] 2. 预期失败 → 修复 archiver 分批逻辑（独立 commit `fix(v2): adaptive multi-group batch sizing`）。
- [ ] 3. `npm run test:worker` 预期 `# fail 0`。
- [ ] 4. 提交：`git add services/reliable-drive-sync-worker/test/rds2-budget-archive-multi-group.test.js && git commit -m "test(v2): multi-group adaptive archive budget proof"`。

### Task 3.6 全入口 40 子请求最坏证明（七入口）

**Files:** Test `test/rds2-budget-per-entry.test.js`
**Interfaces:** Consumes 子计划 1 accept/init、子计划 2 recovery/consumer、本子计划 archiver

- [ ] 1. 失败测试（七块，全用注入计数封装统计 d1/queue/drive/fetch/redirect）：
  ```js
  const CASES = [
    ["POST /v2/events",     async () => runIngressWorstCase(),  10],
    ["POST /v2/query",      async () => runQueryWorstCase(),    10],
    ["POST /v2/users/init", async () => runInitWorstCase(),     10],
    ["project consumer",    async () => runProjectConsumerWorstCase(), 20],
    ["archive consumer",    async () => runArchiveConsumerWorstCase(), 40],
    ["dlq consumers",       async () => runDlqConsumerWorstCase(),     10],
    ["scheduled recovery",  async () => runRecoveryWorstCase(), 15]
  ];
  for (const [name, run, cap] of CASES) {
    test(`${name} stays within ${cap}`, async () => {
      const budget = createBudget(cap);
      const { total } = await run(budget);
      assert.ok(total <= cap, `${name} consumed ${total} > ${cap}`);
    });
  }
  ```
  各 worst-case 助手为测试文件内联构造（全部走子计划 1/2 已测实现 + 计数封装）：ingress（鉴权 1 + 三查询 1 batch 化为 1 + 接收 batch 1 + 回读 1 + queue 1 = 5）；query（鉴权 1 + 投影读 1 + 状态读 2 = 4）；init（校验 1 + 用户/凭据/投影 batch 2 = 3）；project consumer（任务行 1 + 事件行 1 + 投影读 1 + readAfter 1 + 大 batch 1 + 余量检查 1 + wake 1 = 7）；archive（Task 3.4 已证 36）；dlq（查行 1 + 更新 1 = 2）；recovery（reclaim 1 + claim 1 + 5×(send 1 + 回写 1) = 12）。
- [ ] 2. 预期失败：任何入口超帽 → 修复对应装配（独立 commit 注明入口名）。
- [ ] 3. `npm run test:worker` 预期 `# fail 0`。
- [ ] 4. 提交：`git add services/reliable-drive-sync-worker/test/rds2-budget-per-entry.test.js && git commit -m "test(v2): per-entry worst-case subrequest proofs for all seven entries"`。

### Task 3.7 指标导出与日志脱敏

**Files:** Create `src/rds2/metrics.js`；Test `test/rds2-metrics.test.js`、`test/rds2-log-redaction.test.js`
**Interfaces:** Produces `emitBudgetSnapshot` | Consumes Task 3.2

- [ ] 1. 失败测试（metrics）：`emitBudgetSnapshot(budget, "archive")` 返回 `{entry:"archive", total, byCategory, remaining, earlyStopBatches}` 且 JSON.stringify 后 `console.log` 可序列化。
- [ ] 2. 失败测试（redaction）：
  ```js
  test("static: rds2 sources never log bearer, tokens, envelope bodies or profile payloads", () => {
    for (const file of rds2SourceFiles()) {
      const src = readFileSync(file, "utf8");
      assert.ok(!/console\.log\([^)]*Bearer/.test(src), file);
      assert.ok(!/console\.log\([^)]*envelope_json/.test(src), file);
      assert.ok(!/console\.log\([^)]*public_view_json/.test(src), file);
    }
  });
  test("dynamic: recovery failure log contains only event and code", async () => { /* Task 2.3 的失败日志经捕获断言字段集合恰为 {event, code} */ });
  ```
- [ ] 3. 实现并在各入口装配点调用 `emitBudgetSnapshot`（幂等、纯读）。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/metrics.js services/reliable-drive-sync-worker/test/rds2-metrics.test.js services/reliable-drive-sync-worker/test/rds2-log-redaction.test.js && git commit -m "feat(v2): budget metrics and redaction guards"`。

## 覆盖与自检（子计划 3 完成门）

- [ ] 规格映射：§14 全条（3.3 测试）、§15 全入口（3.6 七入口 + 3.2 单预算器）、§16 预算行（3.3 释放断言）。
- [ ] `grep -rn "drive_read_meta" src/rds2/drive-archiver.js` 零命中（V2 归档不取 metadata）。
- [ ] `npm run test:worker` 与 `npm run test:bridge` 双绿；`npx wrangler deploy --config services/reliable-drive-sync-worker/wrangler.toml --dry-run --outdir "$PWD/services/reliable-drive-sync-worker/tmp-dryrun-p3"` 通过后删除该目录（本计划产物）。
- [ ] `grep -rn "TODO\|TBD\|同上\|参考前文\|必要修复\|<tmp>\|<skill>" src/ test/` 零命中。
