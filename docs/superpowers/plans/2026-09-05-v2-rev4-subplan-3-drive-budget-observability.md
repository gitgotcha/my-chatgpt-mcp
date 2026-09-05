# RDS2 Drive Archiving, Honest Budget Proofs and Observability Implementation Plan — Revision 4

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 Codex 三审 P0-6/7 两项阻断修正：① Drive 归档器重写为 **invocation/batch 级处理**——Queue handler 根部单预算器、按本批消息的精确 taskId 集合**原子认领**（单条条件 `UPDATE…RETURNING` 置 processing/delivering）、按 `(userId, namespace)` 分组复用 token 与目录解析、**逐对象完成自己的 delivery 与自己的 archive task**、已处理对象逐条 `message.ack()`、预算不足未执行对象显式释放租约并 `message.retry()`、同名多文件 `needs_attention`；② 冻结**诚实精确成本模型**（8 新对象单组全冷 = **38 ≤ 40**，明细见 §15.3），预算证明的 `total` 必须来自唯一 `SubrequestBudget.snapshotByCategory()` 合计、必须经**真实 Queue batch 入口**执行、D1 侧必须真实 Miniflare binding + `budgetD1`，废除 Rev 3 的"另算 calls 计数 / 直接调用内部方法 / 36 次低估模型"。

**Architecture:** 认领即得内容——认领 `delivering` 行 `RETURNING *` 随行带回冻结的 `artifact_json/artifact_hash/drive_path`，无需第三次 D1 读。哈希证据链：上传时把 `artifact_hash` 写入 Drive 文件 `appProperties`（multipart metadata part），重放路径用**单次 list**（q 按精确文件名 + `fields=files(id,appProperties)`）比对哈希——命中即同名同哈希（成本 1，无上传无回读），同名但哈希不符 `needs_attention`，与 §15.3"重放 = 1"完全吻合。目录链从 secret `RDS2_DRIVE_ROOT_FOLDER_ID` 起步（**不在 invocation 内解析 V2 根本身**）：`users → <userId> → <namespace> → events|snapshots` 五级，冷解析 5 list + 5 create，结果按 `(parentFolderId, name)` 缓存于 invocation 内（跨组共享 users 层）。动态缩批上限 `floor((remaining - 组固定预留) / 3)`。

**Tech Stack:** 既有 V1 Drive 原语（`google-drive.js` 只读蓝本 + 行为不变抽取）、Node test runner、Miniflare（D1 真 binding）、注入式计数假客户端（drive 四通道 + d1 + queue）。

**Spec:** 规格 Rev 4：§14（归档规则全条）、§15.1（统一预算器与四封装）、§15.3（精确成本模型表与边界规则）、§16（预算耗尽行）、§21.4 验收门 9/10/14/15。

**Rev 4 相对 Rev 3 的关键修正（本子计划范围）:**
1. 归档器入口从"单 taskId 触发 + claimableGroups 扫描全部 pending"改为 **batch 级精确认领**：只处理本批消息 taskId 对应的行，未被本批认领的 pending 行不顺带扫描；原子认领经 `UPDATE…RETURNING`，两个 Worker 并发互斥。
2. 修复 Rev 3 伪代码 `uploadResult`/`fileId` 未定义错误；每个对象更新**自己的** delivery 与**自己的** `t_archive_<deliveryId>` task，不再把全部对象记到触发任务头上。
3. 补 `message.ack()`/`message.retry()` 逐条语义与同名多文件 `drive_ambiguous_name`。
4. 成本模型 36 → **38**（Drive 原语以 `google-drive.js` 源码为准：multipart upload 是 **1 次 fetch**，Rev 3 误记 3）；目录链从 4 级 8 次改为 **5 级 10 次**（V2 根由 secret 注入）；证明入口改为真实 Queue batch + Miniflare D1 + `snapshotByCategory()` 合计。
5. `createBudget` 从 Rev 3 的重复定义改为复用子计划 2 Task 2.1 的 `createSubrequestBudget`（十类别、`budget_exceeded`、`snapshotByCategory()` 含 `total/limit`），本子计划只交付 `budgetD1/budgetQueue/budgetDrive/budgetFetch` 四封装。
6. readback 新增 `readTextContent` 原语（一次 GET 返回**文本**），哈希对冻结规范字节（`artifact_json` 字符串本身的 SHA-256），禁止 `JSON.parse → JSON.stringify` 往返后再算。

## Global Constraints

- 前置门 G0 与提交规范同主索引；受保护路径同子计划 1。
- **唯一允许触碰 `src/google-drive.js` 的任务是 Task 3.1**，且必须单独提交、以既有 Worker 测试全绿作为行为不变证据；diff 限于模块私有函数迁出 + import 回来 + 新增 `readTextContent` 与 `googleUpload` 的可选 metadata 参数（不传时行为逐字节不变）。
- V1 `createJson`/`readJson` 行为不得改变（含 metadata+content 两次读取）；content-only `readJsonContent` 与新增 `readTextContent` 只作为新原语供 V2 使用。
- **全通道预算化强制**：`src/rds2/` 业务源文件（除 `sqlite-adapter.js` 与装配层）不得出现裸 `env.DB`、裸 `fetch(`、`.send(` 直连——全部经 `budgetD1/budgetQueue/budgetDrive/budgetFetch` 封装（静态测试锁定，Task 3.2）。
- **哈希语义强制**：`artifact_hash` = SHA-256(冻结 `artifact_json` 字符串)；readback 校验 = SHA-256(readback 文本) 对比；任何 `JSON.parse→stringify` 后的哈希比较都判失败（测试锁定）。
- 成本模型表（§15.3）冻结：`d1 ≤3 + drive_oauth 1 + drive_list 13（目录 5 + 对象 8）+ drive_create 5 + drive_upload 8 + drive_read_content 8 + drive_read_meta 0 + queue 0`，合计 **38 ≤ 40**；任何测试路径超 40 即失败。
- 所有测试命令在 worktree `C:\Users\27846\my-chatgpt-mcp-v2` 执行；每 Task 结束 `git status --short` 只允许出现该 Task 文件。
- 提交规范：`git add` 只加本 Task 文件；消息前缀 `feat(v2):`/`test(v2):`/`fix(v2):`/`refactor(v2):`；禁止 `git add -A`、`reset --hard`、`checkout --`、`stash drop`。
- 每 Task 回滚：`git revert <task_sha>`。

## Interfaces

- **Consumes**：子计划 1 全部 Produces（六仓库、`deterministicDeliveryId`、`canonicalJson/sha256Hex`、sqlite-adapter、Miniflare 助手）；子计划 2 的 `createSubrequestBudget`、`queue-io`、投影引擎接线后的 `createWorker`。
- **Produces**：`src/drive-http-client.js` 导出 `oauthAccessToken`、`accessToken`、`googleUpload`、`googleGet`、`readJsonContent`、`readTextContent`、`formatGoogleDriveWriteError`、`withSharedDriveSupport`；`src/rds2/budgeted-io.js` 导出 `budgetD1(db, budget)`、`budgetQueue(queue, budget)`、`budgetDrive(env, budget)`、`budgetFetch(budget)`；`src/rds2/drive-archiver.js` 导出 `createDriveArchiver(deps)` → `processArchiveBatch(messages)` 与 `V2_DIR_LEVELS`；`src/rds2/metrics.js` 导出 `emitBudgetSnapshot(budget, entry)`。

---

### Task 3.1 公共原语抽取 + readTextContent（行为不变改造）

**Files:** Create `services/reliable-drive-sync-worker/src/drive-http-client.js`；Modify `services/reliable-drive-sync-worker/src/google-drive.js`（仅本 Task）；Test `services/reliable-drive-sync-worker/test/drive-http-client.test.js`
**Interfaces:** Produces 原语八件 | Consumes `google-drive.js` 既有实现（迁出）

- [ ] 1. 失败测试：
  ```js
  import { accessToken, googleUpload, readJsonContent, readTextContent } from "../src/drive-http-client.js";
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
    const value = await readJsonContent({}, "file-1",
      async (url) => { calls.push(url); return new Response(JSON.stringify({ ok: true }), { status: 200 }); },
      async () => "tok");
    assert.equal(calls.length, 1);
    assert.match(calls[0], /alt=media/);
    assert.deepEqual(value, { ok: true });
  });
  test("readTextContent returns raw text with exactly one GET (hash target is frozen bytes)", async () => {
    const calls = [];
    const text = await readTextContent({}, "file-1",
      async (url) => { calls.push(url); return new Response('{"b":1,"a":2}', { status: 200 }); },
      async () => "tok");
    assert.equal(calls.length, 1);
    assert.equal(text, '{"b":1,"a":2}'); // 原文返回，不 parse
  });
  test("googleUpload sends multipart with shared drive support and optional appProperties metadata", async () => {
    // 无 metadata 参数 → 请求体两个 part，与 V1 逐字节一致（行为不变）；
    // 传 { appProperties: { artifact_hash: "abc" } } → metadata part JSON 含 appProperties 字段
  });
  ```
- [ ] 2. 运行 `npm run test:worker 2>&1 | tail -4`，预期 `# fail 1`（模块不存在）。
- [ ] 3. 迁出实现：把 `google-drive.js` 的 `oauthAccessToken/accessToken/googleUpload/googleGet/withSharedDriveSupport/formatGoogleDriveWriteError` 原样搬入 `src/drive-http-client.js` 并加 `export`；新增：
  ```js
  export async function readTextContent(env, fileId, fetchImpl = fetch, tokenProvider = () => accessToken(env, fetchImpl)) {
    const token = await tokenProvider();
    const response = await fetchImpl(withSharedDriveSupport(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {}), { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error("Google Drive read failed");
    return response.text();   // 原文文本，禁止 parse
  }
  ```
  `googleUpload` 追加可选第 4 参 `metadata`（默认 `undefined`）：metadata part 在现有字段基础上合并 `metadata`（如 `{ appProperties: { artifact_hash } }`）；不传时构造的请求体与 V1 逐字节一致。
- [ ] 4. 修改 `google-drive.js`：删除已迁出的私有函数定义，改为 `import … from "./drive-http-client.js"` + `export { formatGoogleDriveWriteError, withSharedDriveSupport } from "./drive-http-client.js";`；`createDriveRepository` 内部调用点改引 import 名，函数体逐字节不变。
- [ ] 5. 行为不变验证：`npm run test:worker 2>&1 | tail -4` 预期 `# fail 0` 且 `# pass` 总数 ≥ 380 + 新增；`npm run test:bridge` 预期 `# fail 0`。
- [ ] 6. 提交：`git add services/reliable-drive-sync-worker/src/drive-http-client.js services/reliable-drive-sync-worker/src/google-drive.js services/reliable-drive-sync-worker/test/drive-http-client.test.js && git commit -m "refactor(v2): extract drive http primitives and add readTextContent behavior preserving"`。

### Task 3.2 预算化全通道封装（D1 三形态 + Queue + Drive + fetch/redirect）

**Files:** Create `src/rds2/budgeted-io.js`；Test `test/rds2-budgeted-io.test.js`
**Interfaces:** Produces `budgetD1`, `budgetQueue`, `budgetDrive`, `budgetFetch` | Consumes 子计划 2 `createSubrequestBudget`、Task 3.1 原语
**规格依据（§15.1）:** `budgetD1` 支持三种调用形态各计 `d1`：`prepare(sql).first()/all()/run()`、`prepare(sql).bind(...)` 后同、`batch(stmts[])` 一次 1；UPDATE 影响行数读 `result.meta.changes`（透传不加工）。重定向在每次跟随前计 `redirect`。

- [ ] 1. 失败测试：
  ```js
  test("budgetD1 counts each of the three call shapes as one d1 round-trip", async () => {
    const budget = createSubrequestBudget({ limit: 40 });
    const d1 = budgetD1(fakeDb, budget);
    await d1.prepare("SELECT 1").first();                       // +1
    await d1.prepare("UPDATE t SET x=1 WHERE id=?").bind(1).run(); // +1
    await d1.batch([fakeDb.prepare("SELECT 1"), fakeDb.prepare("SELECT 2")]); // +1（一次网络往返）
    assert.equal(budget.snapshotByCategory().d1, 3);
  });
  test("consume before call: exhausted budget prevents execution", async () => {
    const budget = createSubrequestBudget({ limit: 1 });
    budget.consume("d1", 1);
    const d1 = budgetD1(fakeDb, budget);
    await assert.rejects(() => d1.prepare("SELECT 1").first(), /budget_exceeded/);
    assert.equal(fakeDbCalls, 0);
  });
  test("budgetDrive maps primitives to spec categories", async () => {
    const budget = createSubrequestBudget({ limit: 40 });
    const drive = budgetDrive(fakeEnv, budget);
    await drive.token();                       // drive_oauth 1
    await drive.listChildren("f", "q");        // drive_list 1
    await drive.createFolder("f", "n");        // drive_create 1
    await drive.uploadJson("f", "n", "{}", { appProperties: { artifact_hash: "h" } }); // drive_upload 1
    await drive.readTextContent("fid");        // drive_read_content 1
    await drive.readJson("fid");               // drive_read_meta 1 + drive_read_content 1（V1 readJson 两次 GET）
    const s = budget.snapshotByCategory();
    assert.equal(s.drive_oauth, 1); assert.equal(s.drive_list, 1); assert.equal(s.drive_create, 1);
    assert.equal(s.drive_upload, 1); assert.equal(s.drive_read_content, 2); assert.equal(s.drive_read_meta, 1);
  });
  test("budgetFetch counts redirects before each follow", async () => {
    const budget = createSubrequestBudget({ limit: 40 });
    const f = budgetFetch(budget);
    await f("https://a.example", { fetchImpl: redirectingFake }); // 302 → 跟随前 +1 redirect → 200
    assert.equal(budget.snapshotByCategory().redirect, 1);
  });
  test("static: rds2 business sources never bypass the wrappers", () => {
    for (const file of rds2BusinessFiles()) {   // 排除 sqlite-adapter.js
      const src = readFileSync(file, "utf8");
      assert.ok(!src.includes("env.DB"), file);
      assert.ok(!/\bfetch\(/.test(src.replace(/budgetFetch|fetchImpl|tokenProvider/g, "")), file);
    }
  });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  export function budgetD1(db, budget) {
    const wrap = (inner) => ({
      first: async (...a) => { budget.consume("d1", 1); return inner.first(...a); },
      all: async (...a) => { budget.consume("d1", 1); return inner.all(...a); },
      run: async (...a) => { budget.consume("d1", 1); return inner.run(...a); }
    });
    return {
      prepare: (sql) => ({ bind: (...params) => wrap(db.prepare(sql).bind(...params)), first: (...a) => wrap(db.prepare(sql)).first(...a), all: (...a) => wrap(db.prepare(sql)).all(...a), run: (...a) => wrap(db.prepare(sql)).run(...a) }),
      batch: async (statements) => { budget.consume("d1", 1); return db.batch(statements); },
      exec: async (sql) => { budget.consume("d1", 1); return db.exec(sql); }
    };
  }
  export function budgetQueue(queue, budget) {
    return { async send(body) { budget.consume("queue", 1); return queue.send(body); } };
  }
  export function budgetDrive(env, budget) {
    const f = budgetFetch(budget);
    const tokenProvider = () => { budget.consume("drive_oauth", 1); return accessToken(env, f); };
    return {
      token: tokenProvider,
      listChildren: async (parentId, q) => { budget.consume("drive_list", 1); return listChildrenVia(f, tokenProvider, parentId, q); },
      createFolder: async (parentId, name) => { budget.consume("drive_create", 1); return createFolderVia(f, tokenProvider, parentId, name); },
      uploadJson: async (parentId, name, json, metadata) => { budget.consume("drive_upload", 1); return googleUpload(env, parentId, name, json, f, tokenProvider, metadata); },
      readTextContent: async (fileId) => { budget.consume("drive_read_content", 1); return readTextContent(env, fileId, f, tokenProvider); },
      readJson: async (fileId) => { budget.consume("drive_read_meta", 1); const meta = await getMetaVia(f, tokenProvider, fileId); budget.consume("drive_read_content", 1); return readJsonContent(env, fileId, f, tokenProvider); }
    };
  }
  export function budgetFetch(budget) {
    return async function budgetedFetch(url, init = {}, fetchImpl = fetch) {
      let response = await fetchImpl(url, init);
      while ([301, 302, 303, 307, 308].includes(response.status)) {
        budget.consume("redirect", 1);                    // 每次跟随前计入
        response = await fetchImpl(response.headers.get("location"), init);
      }
      return response;
    };
  }
  ```
  （`listChildrenVia/createFolderVia/getMetaVia` 为 Task 3.1 迁出符号的薄适配；如 `google-drive.js` 未暴露等价内部函数，在本文件内以既有 URL/参数形状实现并在测试锁定请求数。）
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/budgeted-io.js services/reliable-drive-sync-worker/test/rds2-budgeted-io.test.js && git commit -m "feat(v2): budgeted d1 queue drive fetch wrappers over shared budget"`。

### Task 3.3 Drive 归档器 batch 级重写（原子认领 + 分组 + 逐对象完成 + ack/retry）

**Files:** Create `src/rds2/drive-archiver.js`；Modify `src/index.js`（`buildProcessors` 的 `rds2-archive` 键替换为真实现，传入 queue 根部预算器）；Test `test/rds2-drive-archiver.test.js`
**Interfaces:** Produces `createDriveArchiver(deps)` → `processArchiveBatch(messages)` | Consumes Task 3.1/3.2、子计划 1 archive-delivery-repository（`markDelivering/markDelivered/toNeedsAttention` 语义）、outbox-repository
**规格依据（§14）:** 全条——根部单预算器、精确 taskId 认领、`(userId, namespace)` 分组复用、逐对象完成自身 delivery 与自身 task、逐条 ack、预算不足释放租约 + retry、同名多文件 `needs_attention`、哈希对冻结字节、目录五级 secret 注入、复用 token 与已解析目录、禁触 V1 根。

- [ ] 1. 失败测试（注入计数假客户端）：
  ```js
  function makeFakeDrive(plan) { /* list/create/upload/readText 按脚本返回；逐类别计数 */ }
  test("claims exactly the batch taskIds atomically; foreign pending rows untouched", async () => {
    // 预置本批 2 个 t_archive 任务 + 库中另一 pending 任务（不在本批）
    // → processArchiveBatch 后：本批 2 行 processing→按结果完成；外部行保持 pending 原样（无扫描）
  });
  test("concurrent identical batches: only one claims (UPDATE..RETURNING mutual exclusion)", async () => {
    // 两个 archiver（第二 adapter 指向同一 sqlite 文件）并发同一批 → 恰一方认领成功处理，另一方零认领零副作用
  });
  test("claims return frozen content via RETURNING (no extra content read)", async () => {
    // 认领后不产生额外 SELECT：上传使用认领行带回的 artifact_json（spy 断言 SELECT deliveries 次数 0）
  });
  test("groups by (userId,namespace); dir chain resolved once per group, users level shared", async () => {
    // 同组 3 对象：该组目录链解析 1 次；两个组共享 users 层（第二组 list 从 userId 层起步）
    // 冷组成本 = 5 list + 5 create
  });
  test("directory chain starts from secret RDS2_DRIVE_ROOT_FOLDER_ID, never resolves v2 root", () => {
    const src = readFileSync(archiverPath, "utf8");
    assert.ok(!src.includes("my-chatGPT-skills-v2")); // V2 根名不出现在 invocation 内
    // 假 drive 记录首次 list 的 parentId === env.RDS2_DRIVE_ROOT_FOLDER_ID
  });
  test("each object updates its own delivery and its own t_archive_<deliveryId> task", async () => {
    // 3 对象成功 → 3 个 delivery delivered（各自 drive_file_id）+ 3 个 task completed（精确 taskId 集合，非触发任务）
  });
  test("processed messages ack individually; budget-starved leftovers release lease and retry", async () => {
    // 预算仅够 1 个对象（预置消耗）→ 1 条 ack；其余消息 retry() 且对应行回 pending（释放租约 1 次 d1 计入预算）
  });
  test("ambiguous exact-name match (multiple files) -> needs_attention(drive_ambiguous_name), no upload", async () => { /* */ });
  test("existing file with matching appProperties artifact_hash = successful replay: 1 list, no upload, no readback", async () => { /* */ });
  test("existing file with different hash -> needs_attention, never overwrite", async () => { /* 无 upload 调用 */ });
  test("new object: upload multipart carries appProperties artifact_hash; readback hash computed on raw text", async () => {
    // upload metadata part 含 appProperties；readTextContent 文本 sha256 === artifact.artifact_hash
    // （artifact_json 经 JSON.parse→stringify 后算哈希的场景由构造不等价字节锁定失败）
  });
  test("upload succeeds but readback hash mismatches -> needs_attention, message retried", async () => { /* */ });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（核心流程）：
  ```js
  import { sha256Hex } from "../../../../shared/rds2-protocol.mjs";
  export const V2_DIR_LEVELS = ["users", "<userId>", "<namespace>", "events|snapshots"];
  export function createDriveArchiver({ db, budget, outbox, archiveRepo, drive, env }) {
    const dirCache = new Map(); // (parentFolderId|name) -> folderId，invocation 内共享
    return async function processArchiveBatch(messages) {
      const taskIds = messages.map((m) => m.body.taskId);
      const deliveryIds = taskIds.map((t) => t.slice("t_archive_".length)); // 确定性推导，无依赖查询
      // ① 原子认领：单 batch 两条 UPDATE…RETURNING（行置 processing + delivery 置 delivering）
      budget.consume("d1", 1);
      const claimed = await db.batch([
        db.prepare(`UPDATE rds2_event_outbox SET state='processing', lease_owner='archiver', lease_until=?, attempt_count=attempt_count+1, updated_at=?
          WHERE task_type='archive_artifact' AND state IN ('queued','pending') AND task_id IN (${taskIds.map(() => "?").join(",")}) RETURNING task_id, archive_delivery_id`)
          .bind(new Date(Date.now() + 5 * 60000).toISOString(), new Date().toISOString(), ...taskIds),
        db.prepare(`UPDATE rds2_archive_deliveries SET state='delivering', attempt_count=attempt_count+1, updated_at=?
          WHERE state='pending' AND archive_delivery_id IN (${deliveryIds.map(() => "?").join(",")}) RETURNING *`)
          .bind(new Date().toISOString(), ...deliveryIds)
      ]);
      const rows = claimed[1].results ?? [];
      if (rows.length === 0) { for (const m of messages) m.ack(); return { outcome: "noop", processed: 0 }; }
      // ② 分组（userId, namespace），每组复用 token 与目录缓存
      const groups = new Map();
      for (const row of rows) {
        const key = `${row.user_id}|${row.namespace}`;
        (groups.get(key) ?? groups.set(key, []).get(key)).push(row);
      }
      const token = await drive.token(); // drive_oauth 1（全 invocation 一次）
      const perObjectCost = 3;           // 精确查找 1 + 上传 1 + 回读 1
      const done = [], deferred = [];
      for (const [key, group] of groups) {
        const groupDirCost = 10;         // 5 list + 5 create（冷组最坏；热目录命中 dirCache 时为 0）
        if (budget.remaining() < groupDirCost + perObjectCost) { deferred.push(...group); continue; }
        const dirs = await resolveGroupDirs(drive, dirCache, env, group[0]); // users/<userId>/<ns>，secret 根起步
        for (const row of group) {
          if (budget.remaining() < perObjectCost) { deferred.push(row); continue; }
          const parent = dirs[row.artifact_kind === "projection_snapshot" ? "snapshots" : "events"];
          const fileName = fileNameOf(row);                       // event-<eventId>.json / <name>-through-<seq>.json（冻结于 drive_path）
          const found = await drive.findExact(parent, fileName);  // drive_list 1；fields=files(id,appProperties)
          if (found.length > 1) { await archiveRepo.toNeedsAttention(row.archive_delivery_id, "drive_ambiguous_name"); done.push(row); continue; }
          if (found.length === 1) {
            if (found[0].appProperties?.artifact_hash === row.artifact_hash) { await finishOne(row, found[0].id); continue; } // 重放=1
            await archiveRepo.toNeedsAttention(row.archive_delivery_id, "drive_hash_mismatch"); done.push(row); continue;   // 禁覆盖
          }
          const uploaded = await drive.uploadJson(parent, fileName, row.artifact_json, { appProperties: { artifact_hash: row.artifact_hash } }); // drive_upload 1
          const text = await drive.readTextContent(uploaded.id);  // drive_read_content 1（恰好一次 GET）
          if (await sha256Hex(text) !== row.artifact_hash) { await archiveRepo.toNeedsAttention(row.archive_delivery_id, "drive_readback_mismatch"); done.push(row); continue; }
          await finishOne(row, uploaded.id);
        }
      }
      async function finishOne(row, fileId) { done.push({ ...row, fileId }); }
      // ③ 完成批：按精确集合完成自身 delivery 与自身 task（1 次 d1，2 条 IN 语句）
      if (done.length > 0) {
        budget.consume("d1", 1);
        await db.batch([
          db.prepare(`UPDATE rds2_archive_deliveries SET state='delivered', drive_file_id=?, updated_at=? WHERE archive_delivery_id IN (${done.map(() => "?").join(",")})`).bind(...),
          db.prepare(`UPDATE rds2_event_outbox SET state='completed', updated_at=? WHERE task_id IN (${done.map((r) => `t_archive_${r.archive_delivery_id}`).map(() => "?").join(",")})`).bind(...)
        ]);
      }
      // ④ 逐条 ack / retry：done 的消息 ack（含 needs_attention 转移的——已落库不需重试）；deferred 释放租约后 retry
      if (deferred.length > 0) {
        budget.consume("d1", 1);
        await db.batch([db.prepare(`UPDATE rds2_archive_deliveries SET state='pending', lease_owner=NULL, updated_at=? WHERE archive_delivery_id IN (${deferred.map(() => "?").join(",")}) AND state='delivering'`).bind(...),
                        db.prepare(`UPDATE rds2_event_outbox SET state='pending', lease_owner=NULL, available_at=?, updated_at=? WHERE task_type='archive_artifact' AND state='processing' AND archive_delivery_id IN (${deferred.map(() => "?").join(",")})`).bind(...)]);
      }
      for (const m of messages) {
        const d = m.body.taskId.slice("t_archive_".length);
        if (done.some((r) => r.archive_delivery_id === d)) m.ack();
        else if (deferred.some((r) => r.archive_delivery_id === d)) m.retry();
        else m.ack(); // 认领落空（并发或已完成）：安全确认
      }
      return { outcome: "mixed", processed: done.length, deferred: deferred.length };
    };
  }
  ```
  （`drive.findExact` 由 budgetDrive 补充：`consume("drive_list",1)` 后按 `name = '<fileName>' and '<parentId>' in parents and trashed=false`，`fields=files(id,appProperties)`；`fileNameOf(row)` 从冻结 `drive_path` 取末段——文件名/父目录/内容/哈希全部来自冻结行，不重算。）
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/drive-archiver.js services/reliable-drive-sync-worker/src/rds2/budgeted-io.js services/reliable-drive-sync-worker/src/index.js services/reliable-drive-sync-worker/test/rds2-drive-archiver.test.js services/reliable-drive-sync-worker/test/rds2-budgeted-io.test.js && git commit -m "feat(v2): batch-level drive archiver with atomic claim per-object completion"`。

### Task 3.4 单组最坏路径精确证明：8 对象 38 ≤ 40（真实 Queue 入口 + Miniflare D1）

**Files:** Test `test/rds2-budget-archive-worst-case.test.js`
**Interfaces:** Consumes Task 3.2/3.3、子计划 1 Miniflare 助手、子计划 2 `createWorker` 接线
**规格依据（§15.3 + Codex P0-7）:** total 必须直接来自唯一 `SubrequestBudget.snapshotByCategory()` 合计；必须经真实 Queue batch 入口（`createWorker(...).queue(...)`）执行；D1 侧必须真实 Miniflare binding + `budgetD1`；明细表冻结为 `d1 3 + oauth 1 + 目录 10 + list 8 + upload 8 + readback 8 = 38`（目录 list 计入 drive_list → drive_list 合计 13、drive_create 5）。

- [ ] 1. 失败测试：
  ```js
  test("single group, 8 brand-new objects, all-cold dirs: total from snapshotByCategory <= 38", async () => {
    // 真实 Miniflare D1：迁移 0006 建库；预置同 (user, namespace) 的 8 个 pending delivery + 8 个 t_archive 任务
    // env.RDS2_DRIVE_ROOT_FOLDER_ID = "root-secret"；drive 注入计数假客户端（全缺失、上传成功、readback 返回冻结原文）
    // 经真实入口：worker.queue({ queue: "rds2-archive", messages: 8 条 }, env, { waitUntil(){} })
    const snap = capturedBudget.snapshotByCategory();  // queue handler 根部唯一预算器
    assert.ok(snap.total <= 38, `archive worst path ${snap.total} exceeds model 38`);
    assert.ok(snap.total <= 40, `archive worst path ${snap.total} exceeds hard limit 40`);
    assert.equal(snap.drive_oauth, 1);
    assert.equal(snap.drive_list, 13);        // 目录 5 + 每对象精确查找 8
    assert.equal(snap.drive_create, 5);       // 冷目录 5 级创建
    assert.equal(snap.drive_upload, 8);
    assert.equal(snap.drive_read_content, 8); // content-only readback 恰一次/对象
    assert.equal(snap.drive_read_meta, 0);    // V2 归档不取 metadata
    assert.equal(snap.queue, 0);              // 归档不发布新消息
    assert.ok(snap.d1 <= 3);                  // 认领 1 + 完成 1（RETURNING 免内容读取）
    // 结果侧：8 delivery delivered、8 task completed、8 消息 ack
  });
  test("proof runs through the real queue entry, not an internal method call", () => {
    // 测试源码静态断言：不含 createDriveArchiver 直接调用（防绕过入口的假证明回归）
  });
  ```
- [ ] 2. 预期失败：total > 38 或任一类别不符 → 修 archiver（独立 commit `fix(v2): tighten archive budget path`）。
- [ ] 3. 通过后 `npm run test:worker` 预期 `# fail 0`。
- [ ] 4. 提交：`git add services/reliable-drive-sync-worker/test/rds2-budget-archive-worst-case.test.js && git commit -m "test(v2): honest 38<=40 worst-case archive proof via real queue entry"`。

### Task 3.5 多组积压自适应缩批证明（含释放租约与 retry）

**Files:** Test `test/rds2-budget-archive-multi-group.test.js`
**Interfaces:** Consumes Task 3.3/3.4

- [ ] 1. 失败测试：
  ```js
  test("8 objects across 8 groups (all cold) adaptively stop and release unclaimed", async () => {
    // 固定成本：d1 3 + oauth 1 = 4；每组冷 = 目录 10 + 对象 3 = 13
    // 40 - 4 = 36 → 组1(13) 余 23 → 组2(13) 余 10 < 13 → 停 → processed === 2
    // 断言：processed === 2；snapshotByCategory().total <= 40；
    // 6 个未执行 delivery 回 pending（租约释放）、对应 task 回 pending、6 条消息 retry() 被调用；
    // 无任何 needs_attention、无覆盖、无静默吞掉
  });
  test("batch size derives from remaining budget, never hardcoded 8", async () => {
    // 行为断言：构造 remaining = 6 场景 → 0 组可启动（deferred 全部释放）且不抛预算异常
  });
  ```
- [ ] 2. 预期失败 → 修复 archiver 分批逻辑（独立 commit `fix(v2): adaptive multi-group batch sizing`）。
- [ ] 3. `npm run test:worker` 预期 `# fail 0`。
- [ ] 4. 提交：`git add services/reliable-drive-sync-worker/test/rds2-budget-archive-multi-group.test.js && git commit -m "test(v2): multi-group adaptive archive budget with lease release"`。

### Task 3.6 全入口 40 子请求最坏证明（七入口，V2 预算版）

**Files:** Test `test/rds2-budget-per-entry.test.js`
**Interfaces:** Consumes 子计划 1 accept/init、子计划 2 recovery/consumer/engine、本子计划 archiver
**Rev 4 修正：** 各入口成本按 Rev 4 实现重算；recovery = 15（批量 4，T2.4）；archive = 38（T3.4 引用复验）；project consumer 首任务 8。

- [ ] 1. 失败测试（七块，全用 `createSubrequestBudget` + 计数封装统计，total 来自 `snapshotByCategory()`）：
  ```js
  const CASES = [
    ["POST /v2/events",     async () => runIngressWorstCase(),  10], // 鉴权 1 + 三查询 1 + 接收 batch 1 + 回读 1 + queue 1 = 5
    ["POST /v2/query",      async () => runQueryWorstCase(),    10], // 鉴权 1 + 投影读 1 + 状态读 2 = 4
    ["POST /v2/users/init", async () => runInitWorstCase(),     10], // 校验 1 + 单 batch 身份初始化 1 + 回读 1 = 3
    ["project consumer",    async () => runProjectConsumerWorstCase(), 20], // 任务 1 + 事件 1 + 投影读 1 + upsert+get 2 + readAfter 1 + 大 batch 1 + wake 1 = 8（首任务最坏）
    ["archive consumer",    async () => runArchiveConsumerWorstCase(), 40], // T3.4 已证 38（此处经入口复验 <= 40）
    ["dlq consumers",       async () => runDlqConsumerWorstCase(),     10], // 查行 1 + 更新 1 = 2
    ["scheduled recovery",  async () => runRecoveryWorstCase(), 15]  // reclaim 3 + 4×(claimOne 1 + markQueued 1 d1 + send 1 queue) = 15
  ];
  for (const [name, run, cap] of CASES) {
    test(`${name} stays within ${cap}`, async () => {
      const budget = createSubrequestBudget({ limit: cap });
      const snap = await run(budget);   // 各 worst-case 助手为测试文件内联构造，全部走真实入口或已测实现
      assert.ok(snap.total <= cap, `${name} consumed ${snap.total} > ${cap}`);
    });
  }
  ```
- [ ] 2. 预期失败：任何入口超帽 → 修复对应装配（独立 commit 注明入口名）。
- [ ] 3. `npm run test:worker` 预期 `# fail 0`。
- [ ] 4. 提交：`git add services/reliable-drive-sync-worker/test/rds2-budget-per-entry.test.js && git commit -m "test(v2): per-entry worst-case subrequest proofs for all seven entries"`。

### Task 3.7 指标导出与日志脱敏

**Files:** Create `src/rds2/metrics.js`；Test `test/rds2-metrics.test.js`、`test/rds2-log-redaction.test.js`
**Interfaces:** Produces `emitBudgetSnapshot` | Consumes Task 3.2

- [ ] 1. 失败测试（metrics）：`emitBudgetSnapshot(budget, "archive")` 返回 `{entry:"archive", total, byCategory, remaining, earlyStopBatches}` 且 JSON.stringify 后 `console.log` 可序列化；`earlyStopBatches` 在 Task 3.5 的 deferred 场景 +1。
- [ ] 2. 失败测试（redaction）：
  ```js
  test("static: rds2 sources never log bearer, tokens, envelope bodies or profile payloads", () => {
    for (const file of rds2SourceFiles()) {
      const src = readFileSync(file, "utf8");
      assert.ok(!/console\.log\([^)]*Bearer/.test(src), file);
      assert.ok(!/console\.log\([^)]*envelope_json/.test(src), file);
      assert.ok(!/console\.log\([^)]*public_view_json/.test(src), file);
      assert.ok(!/console\.log\([^)]*artifact_json/.test(src), file);
    }
  });
  test("dynamic: recovery failure log contains only event and code", async () => { /* Task 2.4 失败日志字段集合恰为 {event, code} */ });
  ```
- [ ] 3. 实现并在各入口装配点调用 `emitBudgetSnapshot`（幂等、纯读）。
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/metrics.js services/reliable-drive-sync-worker/test/rds2-metrics.test.js services/reliable-drive-sync-worker/test/rds2-log-redaction.test.js && git commit -m "feat(v2): budget metrics and redaction guards"`。

## 覆盖与自检（子计划 3 完成门）

- [ ] 规格映射：§14 全条（3.3 逐条测试）、§15.1 四封装（3.2）、§15.3 成本模型（3.4 逐类别 38）、§16 预算行（3.3/3.5 释放断言）、§21.4 验收门 9（全通道预算）/10（并发认领）/14（逐 cron 预算，3.6 recovery 行）/15（全绿门）。
- [ ] `grep -rn "drive_read_meta" services/reliable-drive-sync-worker/src/rds2/drive-archiver.js` 零命中（V2 归档不取 metadata）。
- [ ] `grep -rn "my-chatGPT-skills-v2" services/reliable-drive-sync-worker/src/rds2/drive-archiver.js` 零命中（V2 根 secret 注入）。
- [ ] Task 3.4 证明经真实 Queue batch 入口且 total 来自 `snapshotByCategory()`（测试静态断言锁定）。
- [ ] `npm run test:worker` 与 `npm run test:bridge` 双绿；`npx wrangler deploy --config services/reliable-drive-sync-worker/wrangler.toml --dry-run --outdir "$PWD/services/reliable-drive-sync-worker/tmp-dryrun-p3"` 通过后删除该目录（本计划产物）。
- [ ] `grep -rn "TODO\|TBD\|同上\|参考前文\|必要修复\|<tmp>\|<skill>" services/reliable-drive-sync-worker/src/ services/reliable-drive-sync-worker/test/` 零命中。
