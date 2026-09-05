# RDS2 Drive Archiving, Honest Budget Proofs and Observability Implementation Plan — Revision 5

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 Codex 四审意见 2/9/10 在本子计划范围内的全部修正：① 计数唯一收口——OAuth token POST 经 `budgetFetch` 计入 `drive_oauth`、tokenProvider 在 invocation 内 memoize、`budgetFetch` 固定 `redirect: "manual"` 且每次手动跟随前计 `redirect`、实现侧禁止平行计数器；② 归档状态机三集合分离（`delivered`/`needs_attention`/`released` 互不包含）、完成 UPDATE 按精确 `archive_delivery_id` 逐条执行且谓词携带 `lease_owner` 并限 `state='delivering'`、每行 delivery 独立 `drive_file_id`；③ `googleUpload` 签名冻结（第 5 参为 `mimeType`，`google-drive.js:71`）、上传不写 appProperties（自写元数据不构成内容证据）、重放必须 content-only readback 重算 SHA-256（重放成本 1→**2**，最坏合计仍 38≤40）。

**Architecture:** 与 Rev 4 相同（batch 级精确认领 → `(userId, namespace)` 分组复用 → 逐对象完成 → ack/retry）。Rev 5 不改架构：认领改为双表同 `lease_owner`（`archiver:<invocationId>`）；完成批改为每对象一条带租约谓词的 UPDATE（同一 `db.batch`）；重放路径从"appProperties 比对"改为"查找 1 + readback 1 + SHA-256 比对"。

**Tech Stack:** 既有 V1 Drive 原语（`google-drive.js` 只读蓝本 + 行为不变抽取）、Node test runner、Miniflare（D1 真 binding）、注入式计数假客户端。

**Spec:** 规格 Rev 5：§14（三集合分离 + lease_owner 谓词 + 单对象 fileId + 重放 readback）、§15.1（计数单点收口 + token memoize + `redirect:"manual"`）、§15.3（重放成本 2、最坏 38）。

## Rev 5 相对 Rev 4 的关键修正（Codex 四审意见 2/9/10，逐项：修订位置 / 具体失败样本 / 预期行为）

| 意见 | 修订位置 | 具体失败样本（Rev 4 实际行为） | 预期行为（Rev 5） |
|---|---|---|---|
| 2 预算收口 | Task 3.2、Task 3.4 | ① Rev 4 `budgetDrive` 的 `tokenProvider = () => { consume("drive_oauth",1); return accessToken(env,f); }`：同 invocation 内 `uploadJson` + `readTextContent` 各触发一次 OAuth POST（`drive_oauth` 计 2、实际 2 次 token 请求），成本模型"oauth 1"假设被破坏；② Rev 4 `budgetFetch` 不传 `redirect`：平台 fetch 默认 `follow`，302 被静默跟随——实际 2 个子请求只计 1 个，3xx 检测循环永远不会触发；③ OAuth token POST 未经任何预算化通道，其重定向与计数都在封装之外 | ① `tokenProvider` 在 invocation 内 memoize（`tokenPromise ??=`，与 `google-drive.js:114` 同语义）：真实 token 请求恰好一次、`drive_oauth` 计 1；② `budgetFetch` 固定 `redirect: "manual"`，手动跟随循环每次跟随前 `consume("redirect",1)`；③ OAuth POST 经 `budgetFetch` 执行并按 `drive_oauth` 类别计数——**所有 HTTP 计数唯一收口在 `budgetFetch`**（类别参数化），Drive 封装只传类别不自建计数器 |
| 9 归档状态机 | Task 3.3、Task 3.5 | ① Rev 4 同名多文件分支先 `toNeedsAttention(...)` 再把行推入 `done`，末尾完成批 `UPDATE ... SET state='delivered' WHERE archive_delivery_id IN (...)` 谓词未限 `state='delivering'`——刚落库的 `needs_attention` 被同一 invocation 覆盖为 `delivered`，人工介入信号丢失；② 完成批单语句只绑定一个 `drive_file_id`：3 对象成功 → 三行 `drive_file_id` 全部写成同一个值（或绑定错位）；③ deliveries 认领不写 `lease_owner`，旧消费者租约过期被回收、新消费者重新认领后，旧消费者的迟到完成语句把新租约行覆盖为 `delivered` | ① 三集合 `delivered`/`attentioned`/`released` 互不包含（测试断言交集为空）；完成 UPDATE **按精确 `archive_delivery_id` 逐条执行**且谓词为 `state='delivering' AND lease_owner=?`——`needs_attention` 行对完成批免疫；② 每个 delivered 对象一条独立 UPDATE 绑定**自己的** `drive_file_id`；③ 认领时双表（outbox + deliveries）同写 `lease_owner='archiver:<invocationId>'` + `lease_until`；即时 `markNeedsAttention` 走子计划 1 Rev 5 的 owner 核对方法 |
| 10 googleUpload 与重放 | Task 3.1、Task 3.3、Task 3.4 | ① Rev 4 T3.1 给 `googleUpload` "追加第 4 参 metadata"、T3.2 又以第 7 参传 metadata——自相矛盾且与真实签名不符：真实签名为 `googleUpload(env, parentId, name, content, mimeType, fetchImpl, tokenProvider)`（`google-drive.js:71`，第 5 参 `mimeType`），Rev 4 T3.2 调用 `googleUpload(env, parentId, name, json, f, tokenProvider, metadata)` 把 fetch 函数绑到 `mimeType` 位置，multipart 体直接崩坏；② Rev 4 重放路径比对**自写的** `appProperties.artifact_hash`（查找 1 次即判成功）：旧写入方/伪造者可写入同名字段，内容不同但元数据哈希相同 → 误判重放成功；③ 成本模型"重放 = 1"在内容校验义务下不成立 | ① `googleUpload` 签名逐字节冻结（仅迁出，不增删参数），V2 调用 `googleUpload(env, parentId, name, json, "application/json", fetchImpl, tokenProvider)`；上传 metadata 固定 `{name, parents:[parentId], mimeType}`，**不写 appProperties**；② 重放 = 精确查找 1 + content-only readback 1 + SHA-256 与冻结 `artifact_hash` 比对：一致视为成功重放，不一致 `needs_attention`（禁覆盖）；③ 成本模型：新对象 3、重放 2，最坏合计（全部新对象）仍 38 ≤ 40（§15.3） |

**任务处置清单：**

- **整体替换（6 个）：** Task 3.1（意见 10：签名冻结、撤 metadata 参数）、Task 3.2（意见 2：memoize + manual redirect + 唯一收口）、Task 3.3（意见 9/10：三集合 + 租约谓词 + 重放 readback）、Task 3.4（意见 2/10：38 证明 + 重放路径证明）、Task 3.5（意见 9：三集合断言 + 租约释放）、Task 3.6（意见 7 联动：project consumer 成本重算）。
- **逐字继承（1 个）：** Task 3.7（指标导出与日志脱敏——`emitBudgetSnapshot` 只读 `snapshotByCategory()`，不受本 Rev 影响）。

## Global Constraints

- 前置门 G0 与提交规范同主索引；受保护路径同子计划 1。
- **唯一允许触碰 `src/google-drive.js` 的任务是 Task 3.1**，且必须单独提交、以既有 Worker 测试全绿作为行为不变证据；diff 限于模块私有函数迁出 + import 回来 + 新增 `readTextContent`——**`googleUpload` 等被迁出函数的签名与函数体逐字节不变，禁止增删参数**（Rev 4 的 metadata 参数方案撤销）。
- V1 `createJson`/`readJson` 行为不得改变（含 metadata+content 两次读取）；content-only `readJsonContent` 与新增 `readTextContent` 只作为新原语供 V2 使用。
- **全通道预算化强制**：`src/rds2/` 业务源文件（除 `sqlite-adapter.js` 与装配层）不得出现裸 `env.DB`、裸 `fetch(`、`.send(` 直连——全部经 `budgetD1/budgetQueue/budgetDrive/budgetFetch` 封装（静态测试锁定，Task 3.2）；**HTTP 计数唯一收口在 `budgetFetch`**（类别参数化），其他封装与业务代码不得自建计数器。
- **哈希语义强制**：`artifact_hash` = SHA-256(冻结 `artifact_json` 字符串)；重放与新建校验均为 SHA-256(readback 原文) 对比冻结值；**自写的 appProperties 等元数据不构成内容证据，不得作为比对依据**；任何 `JSON.parse→stringify` 后的哈希比较都判失败（测试锁定）。
- **状态机强制**：归档三集合 `delivered`/`attentioned`/`released` 互不包含；完成 UPDATE 谓词必须同时携带 `state='delivering'` 与 `lease_owner`；每行 delivery 只对应一个归档对象与一个 `drive_file_id`。
- 成本模型表（§15.3）冻结：新对象 = 查找 1 + 上传 1 + readback 1 = **3**；重放 = 查找 1 + readback 1 = **2**；单组 8 全新对象全冷最坏 = `d1 ≤3 + drive_oauth 1 + drive_list 13 + drive_create 5 + drive_upload 8 + drive_read_content 8` = **38 ≤ 40**；任何测试路径超 40 即失败。
- 所有测试命令在 worktree `C:\Users\27846\my-chatgpt-mcp-v2` 执行；每 Task 结束 `git status --short` 只允许出现该 Task 文件。
- 提交规范：`git add` 只加本 Task 文件；消息前缀 `feat(v2):`/`test(v2):`/`fix(v2):`/`refactor(v2):`；禁止 `git add -A`、`reset --hard`、`checkout --`、`stash drop`。
- 每 Task 回滚：`git revert <task_sha>`。

## Interfaces

- **Consumes**：子计划 1 Rev 5 全部 Produces（六仓库——archive-delivery 的 `markDelivering/markDelivered(id, fileId, owner)/markNeedsAttention(id, code, owner)/releaseLease(id, owner)` owner 核对语义、`async deterministicDeliveryId`、`canonicalJson/sha256Hex`、sqlite-adapter、Miniflare 助手）；子计划 2 Rev 5 的 `createSubrequestBudget`（双检查版）、`queue-io`、统一 batch 级 `createWorker`。
- **Produces**：`src/drive-http-client.js` 导出 `oauthAccessToken`、`accessToken`、`googleUpload`（签名冻结七参）、`googleGet`、`readJsonContent`、`readTextContent`、`formatGoogleDriveWriteError`、`withSharedDriveSupport`；`src/rds2/budgeted-io.js` 导出 `budgetD1(db, budget)`、`budgetQueue(queue, budget)`、`budgetDrive(env, budget)`、`budgetFetch(budget)`；`src/rds2/drive-archiver.js` 导出 `createDriveArchiver(deps)` → **`processArchiveBatch(batch)`**（batch 级签名，与子计划 2 统一）与 `V2_DIR_LEVELS`；`src/rds2/metrics.js` 导出 `emitBudgetSnapshot(budget, entry)`。

---

### Task 3.1 公共原语抽取 + readTextContent（googleUpload 签名冻结，行为不变改造）

**Files:** Create `services/reliable-drive-sync-worker/src/drive-http-client.js`；Modify `services/reliable-drive-sync-worker/src/google-drive.js`（仅本 Task）；Test `services/reliable-drive-sync-worker/test/drive-http-client.test.js`
**Interfaces:** Produces 原语八件 | Consumes `google-drive.js` 既有实现（迁出）
**意见 10 修订：** 撤销 Rev 4 的"`googleUpload` 追加可选 metadata 参数"方案——真实签名 `googleUpload(env, parentId, name, content, mimeType, fetchImpl = fetch, tokenProvider = () => accessToken(env, fetchImpl))`（`google-drive.js:71`）逐字节冻结；上传 metadata 固定 `{name, parents:[parentId], mimeType}`（`google-drive.js:74`），不支持也不新增 appProperties；V2 归档的内容证据只来自 content-only readback（Task 3.3）。

- [ ] 1. 失败测试：
  ```js
  import { accessToken, googleUpload, readJsonContent, readTextContent } from "../src/drive-http-client.js";
  test("accessToken prefers oauth trio and posts form body", async () => { /* 同 Rev 4 */ });
  test("readJsonContent performs exactly one GET with alt=media", async () => { /* 同 Rev 4 */ });
  test("readTextContent returns raw text with exactly one GET (hash target is frozen bytes)", async () => { /* 同 Rev 4 */ });
  test("googleUpload signature is frozen: seven params, fifth is mimeType", async () => {
    assert.equal(googleUpload.length, 5); // 具名必填形参 env, parentId, name, content, mimeType（后两个带默认值不计入 length）
  });
  test("googleUpload multipart metadata is exactly {name, parents:[parentId], mimeType} — no appProperties", async () => {
    const bodies = [];
    await googleUpload({}, "parent-1", "a.json", "{}", "application/json",
      async (url, init) => { bodies.push(init.body); return new Response(JSON.stringify({ id: "f1" }), { status: 200 }); },
      async () => "tok");
    assert.match(bodies[0], /"name":"a\.json"/);
    assert.match(bodies[0], /"parents":\["parent-1"\]/);
    assert.match(bodies[0], /"mimeType":"application\/json"/);
    assert.ok(!bodies[0].includes("appProperties"), "upload must not write self-asserted metadata");
  });
  test("googleUpload with folder mimeType creates folders (V1 createFolderImpl shape preserved)", async () => {
    // mimeType "application/vnd.google-apps.folder"、content 空串 → 与 V1 调用形状一致
  });
  ```
- [ ] 2. 运行 `npm run test:worker 2>&1 | tail -4`，预期 `# fail 1`（模块不存在）。
- [ ] 3. 迁出实现：把 `google-drive.js` 的 `oauthAccessToken/accessToken/googleUpload/googleGet/withSharedDriveSupport/formatGoogleDriveWriteError` **原样**搬入 `src/drive-http-client.js` 并加 `export`（签名与函数体逐字节不变）；新增：
  ```js
  export async function readTextContent(env, fileId, fetchImpl = fetch, tokenProvider = () => accessToken(env, fetchImpl)) {
    const token = await tokenProvider();
    const response = await fetchImpl(withSharedDriveSupport(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {}), { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error("Google Drive read failed");
    return response.text();   // 原文文本，禁止 parse
  }
  ```
- [ ] 4. 修改 `google-drive.js`：删除已迁出的私有函数定义，改为 `import … from "./drive-http-client.js"` + `export { formatGoogleDriveWriteError, withSharedDriveSupport } from "./drive-http-client.js";`；`createDriveRepository` 内部调用点改引 import 名，函数体逐字节不变（含第 114 行 `tokenPromise ??=` memoize 语义）。
- [ ] 5. 行为不变验证：`npm run test:worker 2>&1 | tail -4` 预期 `# fail 0` 且 `# pass` 总数 ≥ 380 + 新增；`npm run test:bridge` 预期 `# fail 0`。
- [ ] 6. 提交：`git add services/reliable-drive-sync-worker/src/drive-http-client.js services/reliable-drive-sync-worker/src/google-drive.js services/reliable-drive-sync-worker/test/drive-http-client.test.js && git commit -m "refactor(v2): extract drive http primitives with frozen signatures and add readTextContent"`。

### Task 3.2 预算化全通道封装（唯一收口：memoize + manual redirect + 类别参数化 budgetFetch）

**Files:** Create `src/rds2/budgeted-io.js`；Test `test/rds2-budgeted-io.test.js`
**Interfaces:** Produces `budgetD1`, `budgetQueue`, `budgetDrive`, `budgetFetch` | Consumes 子计划 2 Rev 5 `createSubrequestBudget`（双检查版）、Task 3.1 原语
**规格依据（§15.1）:** `budgetD1` 支持三种调用形态各计 `d1`；`batch(stmts[])` 一次 1；UPDATE 影响行数读 `result.meta.changes`。
**意见 2 修订（三点）：** ① **HTTP 计数唯一收口在 `budgetFetch`**：类别经 `options.category` 参数化（缺省 `fetch_other`），Drive 封装只把类别传给 `budgetFetch`，自身与业务代码不再 `consume` 任何 drive 类别（无平行计数器）；② `budgetFetch` 固定 `redirect: "manual"`，3xx 手动跟随循环每次跟随前 `consume("redirect",1)`；③ `budgetDrive` 的 `tokenProvider` 在 invocation 内 memoize（`tokenPromise ??=`，与 `google-drive.js:114` 同语义），OAuth POST 经 `budgetFetch` 按 `drive_oauth` 计数——真实 token 请求几次就计几次（memoize 后恰为 1）。

- [ ] 1. 失败测试：
  ```js
  test("budgetD1 counts each of the three call shapes as one d1 round-trip", async () => { /* 同 Rev 4：first/bind+run/batch = d1 3 */ });
  test("consume before call: exhausted budget prevents execution", async () => { /* 同 Rev 4，错误码 subrequest_budget_exceeded */ });
  test("budgetDrive maps primitives to spec categories via budgetFetch", async () => {
    const budget = createSubrequestBudget({ limit: 40 });
    const drive = budgetDrive(fakeEnv, budget);
    await drive.token();
    await drive.listChildren("f", "q");        // drive_list 1
    await drive.createFolder("f", "n");        // drive_create 1
    await drive.uploadJson("f", "n", "{}");    // drive_upload 1（无 metadata 参）
    await drive.readTextContent("fid");        // drive_read_content 1
    await drive.readJson("fid");               // drive_read_meta 1 + drive_read_content 1
    const s = budget.snapshotByCategory();
    assert.equal(s.drive_oauth, 1); assert.equal(s.drive_list, 1); assert.equal(s.drive_create, 1);
    assert.equal(s.drive_upload, 1); assert.equal(s.drive_read_content, 2); assert.equal(s.drive_read_meta, 1);
    assert.equal(s.fetch_other, 0);            // Drive 通道不产生 fetch_other
  });
  test("意见2①：token is memoized per invocation — repeated drive calls fetch token exactly once", async () => {
    const budget = createSubrequestBudget({ limit: 40 });
    let tokenPosts = 0;
    const drive = budgetDrive(fakeEnv, budget, { tokenFetch: async () => { tokenPosts += 1; return new Response(JSON.stringify({ access_token: "t" }), { status: 200 }); } });
    await drive.uploadJson("f", "a.json", "{}");
    await drive.readTextContent("fid");
    await drive.listChildren("f", "q");
    assert.equal(tokenPosts, 1);
    assert.equal(budget.snapshotByCategory().drive_oauth, 1);   // 计 1 而非 3（Rev 4 缺陷样本）
  });
  test("意见2②：budgetFetch forces redirect:manual and counts before each follow", async () => {
    const budget = createSubrequestBudget({ limit: 40 });
    const inits = [];
    const redirecting = async (url, init) => {
      inits.push([url, init]);
      if (inits.length === 1) return new Response(null, { status: 302, headers: { location: "https://b.example" } });
      return new Response("ok", { status: 200 });
    };
    const f = budgetFetch(budget);
    await f("https://a.example", {}, { fetchImpl: redirecting });
    assert.equal(inits[0][1].redirect, "manual");
    assert.equal(inits[1][1].redirect, "manual");
    assert.equal(budget.snapshotByCategory().redirect, 1);      // Rev 4 平台静默跟随时为 0
  });
  test("意见2③：OAuth POST executes through budgetFetch under drive_oauth category", async () => {
    // token 端点 302 → 200：drive_oauth 计 1（基础请求）+ redirect 计 1（跟随）
    // 不经 budgetFetch 的裸 token 请求形态由静态断言排除
  });
  test("static: rds2 business sources never bypass the wrappers", () => { /* 同 Rev 4 */ });
  test("static: business sources consume no drive_* categories outside budgeted-io.js (no parallel counters)", () => {
    for (const file of rds2BusinessFilesExcept("budgeted-io.js")) {
      const src = readFileSync(file, "utf8");
      assert.ok(!/consume\("drive_/.test(src), file);
      assert.ok(!/consume\("redirect"/.test(src), file);
      assert.ok(!/consume\("fetch_other"/.test(src), file);
    }
  });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现：
  ```js
  import { accessToken, googleUpload, readJsonContent, readTextContent } from "../drive-http-client.js";
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
  export function budgetFetch(budget) {
    return async function budgetedFetch(url, init = {}, options = {}) {
      const fetchImpl = options.fetchImpl ?? fetch;
      const category = options.category ?? "fetch_other";
      budget.consume(category, 1);                              // 基础请求计数：唯一收口（意见 2①）
      const manual = { ...init, redirect: "manual" };           // 意见 2②：固定 manual
      let response = await fetchImpl(url, manual);
      while ([301, 302, 303, 307, 308].includes(response.status)) {
        budget.consume("redirect", 1);                          // 每次跟随前计入
        response = await fetchImpl(response.headers.get("location"), manual);
      }
      return response;
    };
  }
  export function budgetDrive(env, budget) {
    const f = budgetFetch(budget);
    const via = (category) => (url, init) => f(url, init, { category });   // 类别透传，不自建计数
    let tokenPromise;                                           // 意见 2③：invocation 内 memoize（google-drive.js:114 同语义）
    const tokenProvider = () => tokenPromise ??= accessToken(env, via("drive_oauth"));
    return {
      token: tokenProvider,
      listChildren: async (parentId, q) => listChildrenVia(via("drive_list"), tokenProvider, parentId, q),
      createFolder: async (parentId, name) => googleUpload(env, parentId, name, "", "application/vnd.google-apps.folder", via("drive_create"), tokenProvider),
      uploadJson: async (parentId, name, json) => googleUpload(env, parentId, name, json, "application/json", via("drive_upload"), tokenProvider),   // 意见 10：冻结签名，无 metadata
      readTextContent: async (fileId) => readTextContent(env, fileId, via("drive_read_content"), tokenProvider),
      readJson: async (fileId) => { const meta = await getMetaVia(via("drive_read_meta"), tokenProvider, fileId); return readJsonContent(env, fileId, via("drive_read_content"), tokenProvider); }
    };
  }
  ```
  （`listChildrenVia/getMetaVia` 为 Task 3.1 迁出符号的薄适配；如 `google-drive.js` 未暴露等价内部函数，在本文件内以既有 URL/参数形状实现并在测试锁定请求数。）
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/budgeted-io.js services/reliable-drive-sync-worker/test/rds2-budgeted-io.test.js && git commit -m "feat(v2): single-choke-point budgeted io with token memoize and manual redirects"`。

### Task 3.3 Drive 归档器 batch 级重写（三集合分离 + 租约谓词完成 + 重放 readback）

**Files:** Create `src/rds2/drive-archiver.js`；Modify `src/index.js`（`buildProcessors` 的 `rds2-archive` 键替换为真实现，传入 queue 根部预算器）；Test `test/rds2-drive-archiver.test.js`
**Interfaces:** Produces `createDriveArchiver(deps)` → `processArchiveBatch(batch)` | Consumes Task 3.1/3.2、子计划 1 Rev 5 archive-delivery-repository（`markNeedsAttention(id, code, owner)` owner 核对）、outbox-repository
**规格依据（§14）:** 全条——根部单预算器、精确 taskId 认领、`(userId, namespace)` 分组复用、逐对象完成自身 delivery（逐条 UPDATE + `lease_owner` 谓词）与自身 task、逐条 ack、预算不足释放租约 + retry、同名多文件 `needs_attention`、哈希对冻结字节、目录五级 secret 注入、复用 token 与已解析目录、禁触 V1 根。
**意见 9 修订：** ① 认领双表同写 `lease_owner='archiver:<invocationId>'` + `lease_until`；② 结果三集合 `delivered`/`attentioned`/`released` 互不包含，完成批每条 UPDATE 谓词 `state='delivering' AND lease_owner=?`（`needs_attention` 免疫）；③ 每个 delivered 对象独立 UPDATE 绑定自己的 `drive_file_id`。
**意见 10 修订：** 重放路径从 appProperties 比对改为 content-only readback SHA-256（查找 1 + readback 1 = 2）；上传不写 appProperties；`findExact` 字段集 `files(id,name)`。

- [ ] 1. 失败测试（注入计数假客户端）：
  ```js
  function makeFakeDrive(plan) { /* list/create/upload/readText 按脚本返回；逐类别计数 */ }
  test("claims exactly the batch taskIds atomically with lease_owner on both tables; foreign pending rows untouched", async () => {
    // 预置本批 2 个 t_archive 任务 + 库中另一 pending 任务（不在本批）
    // → 本批 2 行 processing/delivering 且 lease_owner 相同（archiver:*）、lease_until 非空；外部行保持 pending 原样
  });
  test("concurrent identical batches: only one claims (UPDATE..RETURNING mutual exclusion)", async () => { /* 同 Rev 4 */ });
  test("claims return frozen content via RETURNING (no extra content read)", async () => { /* 同 Rev 4 */ });
  test("groups by (userId,namespace); dir chain resolved once per group, users level shared", async () => { /* 同 Rev 4 */ });
  test("directory chain starts from secret RDS2_DRIVE_ROOT_FOLDER_ID, never resolves v2 root", async () => { /* 同 Rev 4 */ });
  test("意见9②：each delivered object completes with its OWN drive_file_id via per-row UPDATE", async () => {
    // 3 对象成功（假 drive 返回 fileId f1/f2/f3）→ 三行 delivery 各自 drive_file_id = f1/f2/f3（互不相同）；
    // 三个 task completed；完成语句执行后三行 lease_owner 清空
  });
  test("意见9①：needs_attention rows are immune to the completion batch", async () => {
    // 同批 2 对象：obj1 同名多文件 → needs_attention(drive_ambiguous_name)；obj2 成功 → delivered
    // 完成批执行后：obj1 行保持 needs_attention（不被覆盖为 delivered）、obj1 的 task completed（终态落库）；
    // 三集合断言：delivered ∩ attentioned ∩ released = ∅
  });
  test("意见9③：stale owner's late completion cannot overwrite a reclaimed lease", async () => {
    // ownerA 认领后租约过期 → 回收复位 pending → ownerB 重新认领（新 lease_owner）
    // 以 ownerA 身份执行的完成语句（谓词 lease_owner=ownerA）影响 0 行：delivery 保持 delivering(ownerB)
  });
  test("processed messages ack individually; budget-starved leftovers release lease and retry", async () => {
    // 预算仅够 1 个对象（预置消耗）→ 1 条 ack；其余消息 retry() 且对应行回 pending（lease_owner 清空）
  });
  test("ambiguous exact-name match (multiple files) -> needs_attention(drive_ambiguous_name), no upload", async () => { /* */ });
  test("意见10②：existing file replays via content readback: 1 find + 1 readback, no upload", async () => {
    // 假 drive：findExact 命中 1 文件；readTextContent 返回冻结原文（sha256 === artifact_hash）
    // → delivered（drive_file_id = 命中文件 id）；upload 调用 0 次；find 不带 appProperties 字段请求
  });
  test("意见10②：existing file with different content hash -> needs_attention(drive_hash_mismatch), never overwrite", async () => {
    // readback 文本哈希 ≠ artifact_hash → needs_attention；upload 调用 0 次
  });
  test("意见10①：upload carries no appProperties; readback hash computed on raw text", async () => {
    // upload 请求体不含 appProperties；readTextContent 文本 sha256 === artifact.artifact_hash
    // （artifact_json 经 JSON.parse→stringify 后算哈希的场景由构造不等价字节锁定失败）
  });
  test("upload succeeds but readback hash mismatches -> needs_attention(drive_readback_mismatch), no completion", async () => { /* */ });
  ```
- [ ] 2. 预期失败：模块不存在。
- [ ] 3. 最小实现（核心流程）：
  ```js
  import { sha256Hex } from "../../../../shared/rds2-protocol.mjs";
  export const V2_DIR_LEVELS = ["users", "<userId>", "<namespace>", "events|snapshots"];
  export function createDriveArchiver({ db, budget, outbox, archiveRepo, drive, env }) {
    const dirCache = new Map(); // (parentFolderId|name) -> folderId，invocation 内共享
    return async function processArchiveBatch(batch) {
      const owner = `archiver:${crypto.randomUUID()}`;                 // 意见 9③：invocation 级租约所有者
      const messages = batch.messages;
      const taskIds = messages.map((m) => m.body.taskId);
      const deliveryIds = taskIds.map((t) => t.slice("t_archive_".length));
      // ① 原子认领：单 batch 两条 UPDATE…RETURNING，双表同 lease_owner（意见 9③）
      const claimed = await db.batch([
        db.prepare(`UPDATE rds2_event_outbox SET state='processing', lease_owner=?, lease_until=?, attempt_count=attempt_count+1, updated_at=?
          WHERE task_type='archive_artifact' AND state IN ('queued','pending') AND task_id IN (${taskIds.map(() => "?").join(",")}) RETURNING task_id, archive_delivery_id`)
          .bind(owner, new Date(Date.now() + 5 * 60000).toISOString(), new Date().toISOString(), ...taskIds),
        db.prepare(`UPDATE rds2_archive_deliveries SET state='delivering', lease_owner=?, lease_until=?, attempt_count=attempt_count+1, updated_at=?
          WHERE state='pending' AND archive_delivery_id IN (${deliveryIds.map(() => "?").join(",")}) RETURNING *`)
          .bind(owner, new Date(Date.now() + 5 * 60000).toISOString(), new Date().toISOString(), ...deliveryIds)
      ]);
      const rows = claimed[1].results ?? [];
      if (rows.length === 0) { for (const m of messages) m.ack(); return { outcome: "noop", processed: 0 }; }
      // ② 分组（userId, namespace），每组复用 token 与目录缓存
      const groups = new Map();
      for (const row of rows) {
        const key = `${row.user_id}|${row.namespace}`;
        (groups.get(key) ?? groups.set(key, []).get(key)).push(row);
      }
      await drive.token(); // drive_oauth 1（memoize 后全 invocation 一次）
      const perObjectCost = 3;           // 新对象最坏：查找 1 + 上传 1 + readback 1（重放为 2，按 3 保守预留）
      const tailReserve = 2;             // 完成批 1 + 释放批 1（d1）
      const delivered = [], attentioned = [], released = [];           // 意见 9①：三集合分离
      for (const [key, group] of groups) {
        const groupDirCost = 10;         // 5 list + 5 create（冷组最坏；热目录命中 dirCache 时为 0）
        if (budget.remaining() < groupDirCost + perObjectCost + tailReserve) { released.push(...group); continue; }
        const dirs = await resolveGroupDirs(drive, dirCache, env, group[0]); // users/<userId>/<ns>，secret 根起步
        for (const row of group) {
          if (budget.remaining() < perObjectCost + tailReserve) { released.push(row); continue; }
          const parent = dirs[row.artifact_kind === "projection_snapshot" ? "snapshots" : "events"];
          const fileName = fileNameOf(row);                       // 从冻结 drive_path 取末段
          const found = await drive.findExact(parent, fileName);  // drive_list 1；fields=files(id,name)（意见 10：不取 appProperties）
          if (found.length > 1) { await archiveRepo.markNeedsAttention(row.archive_delivery_id, "drive_ambiguous_name", owner); attentioned.push(row); continue; }
          if (found.length === 1) {
            const replay = await drive.readTextContent(found[0].id);   // 意见 10②：重放 readback（成本 2 = 查找 1 + readback 1）
            if (await sha256Hex(replay) === row.artifact_hash) { delivered.push({ row, fileId: found[0].id }); continue; }
            await archiveRepo.markNeedsAttention(row.archive_delivery_id, "drive_hash_mismatch", owner); attentioned.push(row); continue;   // 禁覆盖
          }
          const uploaded = await drive.uploadJson(parent, fileName, row.artifact_json);   // drive_upload 1，无 appProperties（意见 10①）
          const text = await drive.readTextContent(uploaded.id);       // drive_read_content 1（恰好一次 GET）
          if (await sha256Hex(text) !== row.artifact_hash) { await archiveRepo.markNeedsAttention(row.archive_delivery_id, "drive_readback_mismatch", owner); attentioned.push(row); continue; }
          delivered.push({ row, fileId: uploaded.id });
        }
      }
      // ③ 完成批：每个 delivered 对象一条 UPDATE（精确 id + 自己的 fileId + 租约谓词），task 按精确集合完成（1 次 db.batch）
      const doneTasks = [...delivered.map((d) => d.row), ...attentioned].map((r) => `t_archive_${r.archive_delivery_id}`);
      if (delivered.length > 0 || doneTasks.length > 0) {
        const stmts = [];
        for (const d of delivered) {
          stmts.push(db.prepare(`UPDATE rds2_archive_deliveries SET state='delivered', drive_file_id=?, lease_owner=NULL, updated_at=?
            WHERE archive_delivery_id=? AND state='delivering' AND lease_owner=?`)   // 意见 9①②：needs_attention 免疫 + 旧 owner 免疫
            .bind(d.fileId, new Date().toISOString(), d.row.archive_delivery_id, owner));
        }
        for (const taskId of doneTasks) {
          stmts.push(db.prepare(`UPDATE rds2_event_outbox SET state='completed', updated_at=? WHERE task_id=? AND state='processing' AND lease_owner=?`)
            .bind(new Date().toISOString(), taskId, owner));
        }
        await db.batch(stmts);
      }
      // ④ 释放批：预算不足未执行对象显式释放租约（released 集合）
      if (released.length > 0) {
        await db.batch([
          db.prepare(`UPDATE rds2_archive_deliveries SET state='pending', lease_owner=NULL, lease_until=NULL, updated_at=?
            WHERE archive_delivery_id IN (${released.map(() => "?").join(",")}) AND state='delivering' AND lease_owner=?`)
            .bind(new Date().toISOString(), ...released.map((r) => r.archive_delivery_id), owner),
          db.prepare(`UPDATE rds2_event_outbox SET state='pending', lease_owner=NULL, lease_until=NULL, available_at=?, updated_at=?
            WHERE task_type='archive_artifact' AND state='processing' AND lease_owner=? AND archive_delivery_id IN (${released.map(() => "?").join(",")})`)
            .bind(new Date().toISOString(), new Date().toISOString(), owner, ...released.map((r) => r.archive_delivery_id))
        ]);
      }
      // ⑤ 逐条 ack / retry：delivered + attentioned ack（终态已落库）；released retry；认领落空 ack
      const ackIds = new Set([...delivered.map((d) => d.row.archive_delivery_id), ...attentioned.map((r) => r.archive_delivery_id)]);
      const retryIds = new Set(released.map((r) => r.archive_delivery_id));
      for (const m of messages) {
        const d = m.body.taskId.slice("t_archive_".length);
        if (ackIds.has(d)) m.ack();
        else if (retryIds.has(d)) m.retry();
        else m.ack();
      }
      return { outcome: "mixed", delivered: delivered.length, attentioned: attentioned.length, released: released.length };
    };
  }
  ```
  （`drive.findExact` 由 budgetDrive 补充：按 `name = '<fileName>' and '<parentId>' in parents and trashed=false`，`fields=files(id,name)`；`fileNameOf(row)` 从冻结 `drive_path` 取末段——文件名/父目录/内容/哈希全部来自冻结行，不重算。）
- [ ] 4. `npm run test:worker` 预期 `# fail 0`。
- [ ] 5. 提交：`git add services/reliable-drive-sync-worker/src/rds2/drive-archiver.js services/reliable-drive-sync-worker/src/index.js services/reliable-drive-sync-worker/test/rds2-drive-archiver.test.js && git commit -m "feat(v2): archiver with three-set separation, lease-owned completion and readback replay"`。

### Task 3.4 单组最坏路径精确证明：新对象 38 ≤ 40 + 重放路径 ≤ 40（真实 Queue 入口 + Miniflare D1）

**Files:** Test `test/rds2-budget-archive-worst-case.test.js`
**Interfaces:** Consumes Task 3.2/3.3、子计划 1 Miniflare 助手、子计划 2 Rev 5 `createWorker` 接线
**规格依据（§15.3 + 意见 2/10）:** total 必须直接来自唯一 `SubrequestBudget.snapshotByCategory()` 合计；必须经真实 Queue batch 入口（`createWorker(...).queue(...)`）执行；D1 侧必须真实 Miniflare binding + `budgetD1`；新对象成本 3、重放成本 2。

- [ ] 1. 失败测试：
  ```js
  test("single group, 8 brand-new objects, all-cold dirs: total from snapshotByCategory <= 38", async () => {
    // 真实 Miniflare D1：迁移 0006 建库；预置同 (user, namespace) 的 8 个 pending delivery + 8 个 t_archive 任务
    // env.RDS2_DRIVE_ROOT_FOLDER_ID = "root-secret"；drive 注入计数假客户端（全缺失、上传成功、readback 返回冻结原文）
    // 经真实入口：worker.queue({ queue: "rds2-archive", messages: 8 条 }, env, { waitUntil(){} })
    const snap = capturedBudget.snapshotByCategory();  // queue handler 根部唯一预算器
    assert.ok(snap.total <= 38, `archive worst path ${snap.total} exceeds model 38`);
    assert.ok(snap.total <= 40, `archive worst path ${snap.total} exceeds hard limit 40`);
    assert.equal(snap.drive_oauth, 1);        // 意见 2：memoize 后恰 1
    assert.equal(snap.drive_list, 13);        // 目录 5 + 每对象精确查找 8
    assert.equal(snap.drive_create, 5);
    assert.equal(snap.drive_upload, 8);
    assert.equal(snap.drive_read_content, 8); // content-only readback 恰一次/对象
    assert.equal(snap.drive_read_meta, 0);
    assert.equal(snap.queue, 0);
    assert.equal(snap.redirect, 0);
    assert.equal(snap.fetch_other, 0);        // 意见 2：Drive 通道不产生 fetch_other
    assert.ok(snap.d1 <= 3);                  // 认领 1 + 完成 1（RETURNING 免内容读取）
    // 结果侧：8 delivery delivered（各自独立 drive_file_id）、8 task completed、8 消息 ack
  });
  test("意见10：replay path (8 existing files, hash match) costs find+readback per object, zero uploads", async () => {
    // 假 drive：8 对象全部 findExact 命中 1 且 readback 原文哈希一致
    // snap：drive_upload 0、drive_read_content 8、drive_list 13（目录 5 + 查找 8）、total <= 40
    // 每对象成本 2 的口径：snap.drive_list - 13 基准内查找 8 + readback 8 = 16 ≤ 8×2（目录另计）
  });
  test("proof runs through the real queue entry, not an internal method call", () => {
    // 测试源码静态断言：不含 createDriveArchiver 直接调用（防绕过入口的假证明回归）
  });
  ```
- [ ] 2. 预期失败：total > 38（新对象路径）或任一类别不符 → 修 archiver（独立 commit `fix(v2): tighten archive budget path`）。
- [ ] 3. 通过后 `npm run test:worker` 预期 `# fail 0`。
- [ ] 4. 提交：`git add services/reliable-drive-sync-worker/test/rds2-budget-archive-worst-case.test.js && git commit -m "test(v2): honest 38<=40 worst-case and replay-path archive proofs via real queue entry"`。

### Task 3.5 多组积压自适应缩批证明（三集合 + 释放租约与 retry）

**Files:** Test `test/rds2-budget-archive-multi-group.test.js`
**Interfaces:** Consumes Task 3.3/3.4
**意见 9 修订：** 断言从"deferred 回 pending"升级为三集合语义：`released` 集合租约清空可再认领、`attentioned` 集合不被完成批覆盖、三集合两两交集为空。

- [ ] 1. 失败测试：
  ```js
  test("8 objects across 8 groups (all cold) adaptively stop and release unclaimed", async () => {
    // 固定成本：d1 3 + oauth 1 = 4；每组冷 = 目录 10 + 对象 3 = 13；尾预留 2 纳入组启动判定
    // 40 - 4 - 2 = 34 → 组1(13) 余 21 → 组2(13) 余 8 < 13 → 停 → delivered === 2
    // 断言：delivered === 2；snapshotByCategory().total <= 40；
    // 6 个 released delivery 回 pending 且 lease_owner IS NULL（可再认领）、对应 task 回 pending、6 条消息 retry()；
    // 无任何 needs_attention、无覆盖、无静默吞掉
  });
  test("three sets are pairwise disjoint across mixed outcomes", async () => {
    // 构造同批：1 成功 delivered + 1 同名多文件 attentioned + 1 预算不足 released
    // 断言三集合 archive_delivery_id 两两无交集；返回值 {delivered:1, attentioned:1, released:1}
  });
  test("attentioned delivery is not overwritten by the completion batch in multi-group runs", async () => {
    // 组1 含 1 个 drive_hash_mismatch（attentioned）+ 1 个成功（delivered）
    // 完成批后：mismatch 行保持 needs_attention、成功行 delivered；mismatch 的 task completed
  });
  test("batch size derives from remaining budget, never hardcoded 8", async () => {
    // 构造 remaining = 6 场景 → 0 组可启动（released 全部释放）且不抛预算异常
  });
  ```
- [ ] 2. 预期失败 → 修复 archiver 分批逻辑（独立 commit `fix(v2): adaptive multi-group batch sizing`）。
- [ ] 3. `npm run test:worker` 预期 `# fail 0`。
- [ ] 4. 提交：`git add services/reliable-drive-sync-worker/test/rds2-budget-archive-multi-group.test.js && git commit -m "test(v2): multi-group adaptive archive budget with three-set separation"`。

### Task 3.6 全入口 40 子请求最坏证明（七入口，V2 预算版）

**Files:** Test `test/rds2-budget-per-entry.test.js`
**Interfaces:** Consumes 子计划 1 accept/init、子计划 2 Rev 5 recovery/consumer/engine、本子计划 archiver
**Rev 5 修正：** project consumer 成本按子计划 2 Rev 5 重算——意见 7③ 新增下一唤醒查询（d1 +1）、意见 8 唤醒经 `dispatcher.run`（claimOne 1 + send 1 queue + markQueued 1），首任务最坏从 8 调整为 **12**（d1 11 + queue 1，帽 20 不变）；archive 入口含重放路径复验。

- [ ] 1. 失败测试（七块，全用 `createSubrequestBudget` + 计数封装统计，total 来自 `snapshotByCategory()`）：
  ```js
  const CASES = [
    ["POST /v2/events",     async () => runIngressWorstCase(),  10], // 鉴权 1 + 三查询 1 + 接收 batch 1 + 回读 1 + dispatcher.run(claimOne 1 + send 1 queue + markQueued 1) = 7（意见 8 唤醒经 Dispatcher，子计划 4 T4.6 接线）
    ["POST /v2/query",      async () => runQueryWorstCase(),    10], // 鉴权 1 + 投影读 1 + 状态读 2 = 4
    ["POST /v2/users/init", async () => runInitWorstCase(),     10], // 校验 1 + 单 batch 身份初始化 1 + 回读 1 = 3
    ["project consumer",    async () => runProjectConsumerWorstCase(), 20], // 任务 1 + 事件 1 + 投影读 1 + upsert+get 2 + readAfter 1 + 大 batch 1 + 唤醒查询 1 + dispatcher.run(claimOne 1 + send 1 queue + markQueued 1) = 12（首任务最坏）
    ["archive consumer",    async () => runArchiveConsumerWorstCase(), 40], // T3.4 已证新对象 38、重放路径 ≤ 40（此处经入口复验）
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

### Task 3.7 指标导出与日志脱敏（逐字继承 Rev 4）

**Files:** Create `src/rds2/metrics.js`；Test `test/rds2-metrics.test.js`、`test/rds2-log-redaction.test.js`
**Interfaces:** Produces `emitBudgetSnapshot` | Consumes Task 3.2

- [ ] 逐字继承 Rev 4 Task 3.7 全部步骤（`emitBudgetSnapshot` 字段集 `{entry, total, byCategory, remaining, earlyStopBatches}`、脱敏静态/动态断言、各入口装配点幂等调用）。`earlyStopBatches` 在 Task 3.5 的 released 场景 +1。
- [ ] 提交：`git add services/reliable-drive-sync-worker/src/rds2/metrics.js services/reliable-drive-sync-worker/test/rds2-metrics.test.js services/reliable-drive-sync-worker/test/rds2-log-redaction.test.js && git commit -m "feat(v2): budget metrics and redaction guards"`。

## 覆盖与自检（子计划 3 完成门）

- [ ] 规格映射：§14 全条（3.3 逐条测试，含三集合分离/租约谓词/单对象 fileId/重放 readback）、§15.1 四封装与计数收口（3.2）、§15.3 成本模型（3.4 逐类别 38 + 重放路径）、§16 预算行（3.3/3.5 释放断言）、§21.4 验收门 9/10/14/15。
- [ ] Codex 四审意见映射：意见 2 → 3.2/3.4；意见 9 → 3.3/3.5；意见 10 → 3.1/3.3/3.4。
- [ ] `grep -n "appProperties" services/reliable-drive-sync-worker/src/rds2/ services/reliable-drive-sync-worker/src/drive-http-client.js` 零命中（自写元数据不作证据回归锁；测试文件中的否定断言除外）。
- [ ] `grep -rn "redirect" services/reliable-drive-sync-worker/src/rds2/budgeted-io.js` 命中且含 `"manual"`（manual 跟随回归锁）。
- [ ] `grep -rn "drive_read_meta" services/reliable-drive-sync-worker/src/rds2/drive-archiver.js` 零命中（V2 归档不取 metadata）。
- [ ] `grep -rn "my-chatGPT-skills-v2" services/reliable-drive-sync-worker/src/rds2/drive-archiver.js` 零命中（V2 根 secret 注入）。
- [ ] `grep -rn "tokenPromise ??=" services/reliable-drive-sync-worker/src/rds2/budgeted-io.js` 命中（invocation memoize 回归锁）。
- [ ] Task 3.4 证明经真实 Queue batch 入口且 total 来自 `snapshotByCategory()`（测试静态断言锁定）。
- [ ] `npm run test:worker` 与 `npm run test:bridge` 双绿；`npx wrangler deploy --config services/reliable-drive-sync-worker/wrangler.toml --dry-run --outdir "$PWD/services/reliable-drive-sync-worker/tmp-dryrun-p3"` 通过后删除该目录（本计划产物）。
- [ ] `grep -rn "TODO\|TBD\|同上\|参考前文\|必要修复\|<tmp>\|<skill>" services/reliable-drive-sync-worker/src/ services/reliable-drive-sync-worker/test/` 零命中。
