# Rev 5 自检记录（等待 Codex 五审）

> 本记录由 Workbuddy 于 2026-09-05 编制，对应 Codex 四审退回意见（审核对象 commit `9649d5a`，结论"Rev 4 退回修订，目前不建议进入 Phase 1"，13 条意见要求逐项给出"修订位置、具体失败样本、预期行为"）。性质：**仅文档修订**，未修改任何代码、未部署、未迁移、未创建 Queue、未写入 D1/Drive、未开启任何 V2 开关、未 push。按四审结论：完成后停止，等待五审，不进入 Phase 1。

## 1. 元信息

- 工作树：`C:\Users\27846\my-chatgpt-mcp-v2`（worktree of `C:\Users\27846\my-chatgpt-mcp`），分支 `feat/rds2-v2`，基线 commit `9649d5a`（Rev 4 收尾提交）。
- 本轮变更：上位规格原地修订至 Rev 5（13 条修订记录 + 受影响章节就地修补）+ 6 份新文档；Revision 1–4 全部文档保留未删除。
- 四审优先级执行：基础面（预算 = 意见 1/2、D1 接口 = 意见 3、首次事件完整链路 = 意见 6/7/8、归档状态机 = 意见 9/10）先于四业务域展开（意见 11）；子计划 1–3 承载基础面，子计划 2 T2.10–2.13 承载四域。

## 2. 交付物清单（wc -l 实测）

| 文件 | 行数 | 性质 |
|---|---:|---|
| `docs/superpowers/specs/2026-09-05-reliable-drive-sync-v2-requirements-and-architecture.md` | 821 | 原地修订至 Rev 5（Rev 4 为 787 行；13 条修订记录，编号与四审一致） |
| `docs/superpowers/plans/2026-09-05-reliable-drive-sync-v2-implementation-plan-rev5.md` | 89 | 新建主索引（13 行逐项矩阵 + 16 验收门映射） |
| `docs/superpowers/plans/2026-09-05-v2-rev5-subplan-1-protocol-identity-d1.md` | 495 | 新建（T1.1–T1.17，意见 3/4/5/6） |
| `docs/superpowers/plans/2026-09-05-v2-rev5-subplan-2-queue-projection-reducers.md` | 1043 | 新建（T2.1–T2.15，意见 1/7/8/11） |
| `docs/superpowers/plans/2026-09-05-v2-rev5-subplan-3-drive-budget-observability.md` | 469 | 新建（T3.1–T3.7，意见 2/9/10） |
| `docs/superpowers/plans/2026-09-05-v2-rev5-subplan-4-local-mcp-skills-release.md` | 524 | 新建（T4.1–T4.11，意见 5/12/13） |
| 本记录 | — | 新建 |
| 合计（不含本记录） | 3441 | — |

## 3. 逐项矩阵复核结论（13 条，与主索引 §4 可对账）

主索引 §4 矩阵 13 行均具备"修订位置（规格章节 + 任务号）+ 具体失败样本 + 预期行为 + 测试锁定 + 提交边界"五要素；四份子计划开头各有同口径"Rev 5 关键修订表"。抽查确认（源码行号经本轮逐一重读核实）：

- **意见 1**：`consume` 双检查落在子计划 2 T2.1 最小实现（`used[category]+count>limit` → `:category`、`total()+count>limit` → `:total`），失败样本测试断言被拒绝 consume 后 `snap.queue===0`、`total===35`（零记账）；规格 §15.1 line 590 同语义。
- **意见 2**：计数收口落在子计划 3 T3.2——`budgetFetch` 内 `budget.consume(options.category ?? "fetch_other", 1)` 唯一计数点、`{ ...init, redirect: "manual" }`、3xx 循环跟随前 `consume("redirect")`、`tokenPromise ??=` memoize（与 `google-drive.js:110/114` 仓库层语义一致，本轮重读核实）；静态测试禁止 `budgeted-io.js` 外出现 `consume("drive_/redirect/fetch_other")`。
- **意见 3**：适配器落在子计划 1 T1.7——每次 `prepare` 创建私有包装语句对象（WeakMap 持有 sql+绑定）、`all()` 返回 `{results}`、`batch()` 顺序执行逐语句结果、`run()` 含 `meta.changes`、显式 `exec("BEGIN")`/`COMMIT`/`ROLLBACK`；同一接口断言套件同时跑 node:sqlite 适配器与 Miniflare 真 binding。
- **意见 4**：双向核对落在子计划 1 T1.15——`name_key→user_id` 命中后反向校验 `name_key`、签发前校验凭据哈希未绑定他者、任一不一致 `identity_conflict` 且初始化 batch 零残留（users/credentials/projections 计数均 0 断言）。
- **意见 5**：`protocol.js:28`（`IDENTITY_FIELDS = Set(["userId","username"])`）、`:36`（resolve registry `{required:["displayName"], optional:[]}`）、`:404`（校验抛出点）本轮重读核实；子计划 1 T1.2 parity 集含 `{username}` 反样本（两侧同拒）；子计划 4 T4.5 正样本改 `{displayName}`、T4.6 锁定查询消息边界（同一 `scope:event_status` 消息 `/v2/query` 受理 vs `/v2/events` 400 `invalid_payload`）。
- **意见 6**：UNIQUE 重查闭环落在子计划 1 T1.14——`ProtocolError(reIntent.code)` 稳定 409、错误消息不含 `UNIQUE constraint failed`；投影期 `event_key_conflict` → `needs_attention` 保留两端 `event_id`（子计划 2 T2.7；`generic-profile-model.js:58` 抛出语义本轮重读核实）。
- **意见 7**：`emptyProjection(identity)` 唯一初始态（子计划 2 T2.9 契约更名 + `state.identity` 播种）；引擎缺行/NULL `state_json` 一律调用（T2.7）；下一唤醒按 `(user_id, namespace)` 查询派生（`SELECT event_seq ... WHERE user_id=? AND namespace=? AND event_seq>? ORDER BY event_seq LIMIT 1`）；两处 `await deterministicDeliveryId(...)` + `/^[0-9a-f]{32}$/` 回归锁；`publicView` 回填断言 `public_view_identity_missing`。
- **意见 8**：Dispatcher 返回 `{ run(taskId) }`（子计划 2 T2.3），接收唤醒（子计划 4 T4.6）、引擎续批（T2.8 `wakeNext: (taskId) => dispatcher.run(taskId)`）、恢复器（T2.4）三方共用；阈值接线 `attempt_count≥RETRY_THRESHOLD=5` → `needs_attention` 在 send 失败路径完成；四处理器统一 batch 级 `async (batch, env, ctx)` 按 `batch.queue` 路由（T2.5）。
- **意见 9**：三集合 `delivered/attentioned/released` 两两不相交（子计划 3 T3.3/T3.5 测试）；认领双表写 `lease_owner='archiver:<invocationId>'`；完成按精确 `archive_delivery_id` 逐行 UPDATE（谓词 `state='delivering' AND lease_owner=?`），每行绑自身 `drive_file_id`（同一 `db.batch` 内逐行语句，保持单往返）。
- **意见 10**：`google-drive.js:71` 签名与 `:74` metadata 本轮重读核实——`googleUpload.length===5` 签名冻结测试 + metadata 恰为 `{name, parents:[parentId], mimeType}` 且无 appProperties 断言（子计划 3 T3.1）；重放 = 查找 1 + content-only readback 1 + SHA-256 对冻结 `artifact_hash`（T3.3）；成本新对象 3 / 重放 2 / 最坏 38≤40（T3.4 含重放路径复验）。
- **意见 11**：四域字段级映射表（payload 字段 → state 位置 → publicView 派生 → 源码行号）落在子计划 2 T2.10–2.13；行号事实本轮重读核实：`algorithm-profile-model.js:40-42`（topicMastery 8 字段）、`generic-profile-contract.js:47-59`（observations 6 字段）、`generic-profile-model.js:144-159`（弱点关闭）、`profile-model.js:82-84`（`passingSessionIds≥2 && passingVariantIds≥2`）、`resume-knowledge-model.js:46-47,131-137`（`0.6/0.4` 混合）；容量上限 + `state_limit_exceeded:<domain>.<field>` → `toNeedsAttention` 零写入（T2.7 catch 接线）。
- **意见 12**：`node:sqlite` 无 `.transaction()` 经 Node 22.22.2 实测复核（`typeof new DatabaseSync(":memory:").transaction === "undefined"`，显式 `exec("BEGIN IMMEDIATE")`/`COMMIT` 可用）；T4.3 显式事务 + 认领谓词补 `available_at <= now`；T4.4 `capBackoff(attempt_count - 1)` 首档 30s（序列 `[30,60,120,300,600,600…]` 逐次断言）、blocked 返回 blocked 语义零网络、本地兜底回执不含 `persistence.localOutbox:"acknowledged"`（规格 §10.1 line 436 同语义）。
- **意见 13**：`setup-local-clients.ps1` 头部 `param(...)` 块本轮重读核实为 PowerShell 脚本；`wrangler.toml` 全文 18 行无 `[[queues]]` 段本轮重读核实；T4.10 runbook 第 0 节一次性前置（四条 `wrangler queues create` + `d1 migrations apply reliable-drive-sync --remote` + `[[queues]]`/`2-57/5` 核对）、附录 `powershell -File`、回滚统一"恢复上一部署版本并关闭功能开关"，测试静态断言 `/node\s+\S*\.ps1/` 与"清空白名单"零命中。

## 4. 自检 grep 证据（2026-09-05 实测，worktree 执行）

**4.1 占位符**：对规格 + 主索引 + 四份子计划执行 `grep -n "<本任务SHA>|<SHA>|<outdir>|TODO|TBD|同上|参考前文|必要修复|补全逻辑|如有问题"`（剔除自检指令行自身）：**零命中**。

**4.2 意见 5 样本形态**：`grep -rn "payload: { username" docs/superpowers/plans/*rev5*.md` 命中 3 处，全部为主索引/子计划 4 的**自检指令行**与子计划 4 意见 5 修订表**引用的 Rev 4 失败样本**；无任何现存测试夹具使用该非法形态（T4.5 正样本已改 `{displayName}`）。

**4.3 意见 7 契约**：`grep -rn "emptyState"`（剔除 `emptyProjection`）命中 2 处，均为自检指令行；`grep -rn "userId: null"` 命中 7 处，全部为禁令/失败样本/自检语境（规格 line 40/490 为"禁止输出"条款，子计划 2 line 437 为引擎拒绝桩场景），无任何代码路径输出该值。

**4.4 意见 8 唤醒路径**：`grep -rln "sendWake"` 命中主索引 + 子计划 2 + 子计划 4 三份文档——子计划 2 中 `queueIo.sendWake` 仅出现在 Dispatcher 实现与其测试语境（唯一合法位置），子计划 4 T4.6 为"禁止直调"静态断言（`!src.includes("sendWake")` + `dispatcher.run` 在位），主索引为完成门条款。

**4.5 意见 10 元数据**：`grep -rn "appProperties"` 命中 16 处，逐条人工复核全部为失败样本引用、否定断言（`!bodies[0].includes("appProperties")`）与禁令条款；无任何"上传时自写元数据"方案残留。

**4.6 意见 12 事务**：`grep -rn "\.transaction("`（剔除 typeof/禁令/失败样本语境）**零命中**；`BEGIN IMMEDIATE` 在子计划 4 命中 6 处（实现 + 测试断言）；`attempt_count - 1` 命中 6 处（两处 requeue 调用 + 测试与修订表）。

**4.7 意见 13 解释器与回滚**：`grep -rEn "node[[:space:]]+[^[:space:]]*\.ps1"` 命中 5 处，全部为 T4.10 测试的否定正则（`/node\s+\S*\.ps1/`）与失败样本引用；`powershell -File`/`pwsh -File` 在子计划 4 命中 8 处（附录命令 + 测试断言）；`wrangler queues create` 命中 3 处（测试正则循环 + 第 0 节四条命令行 + 修订表）；"清空白名单/清空白名单"命中 9 处，全部为禁令、失败样本与自检语境（runbook 正文的零命中由 T4.10 测试在实现期持续锁定）。

**4.8 D1 契约**：`grep -rn "res\.changes"` 命中 5 处——主索引自检行、子计划 1/2 的 D1 契约禁令条款（Worker D1 侧一律 `res.meta.changes`）、子计划 4 line 150/162 两处 `res.changes === 1`：**后两处为 `node:sqlite` 本地 API**（`StatementSync.run()` 返回 `{changes}`，与 D1 的 `meta.changes` 属不同层），非违规；子计划 1 的 `grep "result.changes"` 零命中锁仍约束 D1 侧。`grep -rn "event_seq BETWEEN"` 仅命中子计划 2 禁令条款。

**4.9 计数收口**：`tokenPromise ??=` 命中 7 处（主索引 2 + 子计划 3 五处：memoize 实现、测试断言、修订表）；`redirect: "manual"` 命中 4 处（子计划 3 实现与静态断言）。

**4.10 队列名一致性**（grep -l 命中文件数）：`rds2-project` 3（子计划 2/4 + 规格）、`rds2-archive` 5（另含子计划 1 任务命名、子计划 3 归档入口）、`rds2-project-dlq` 3、`rds2-archive-dlq` 3；四处拼写逐字一致，主索引以"与子计划 2 T2.5 TOML 逐字一致"引用锁定。

## 5. 数字一致性复核

- **归档成本模型（§15.3，意见 2/10 修正后）**：d1 3 + drive_oauth 1 + 目录（5 list + 5 create）10 + 对象查找 8 + 上传 8 + content-only 回读 8 = **38 ≤ 40**（全新对象最坏路径）；重放路径（单组 8 个既有对象、全冷目录）= d1 3 + oauth 1 + 目录 10 + 查找 8 + 回读 8 = **30 ≤ 40**（`drive_upload 0`），两条路径均由 T3.4 经真实 `worker.queue(...)` 入口 + Miniflare D1 + `snapshotByCategory()` 合计证明。`38 ≤ 40` 字样跨规格/子计划 3/主索引命中 11 处一致。
- **恢复器预算（§15.2 = 15）**：固定 reclaim 3 + 批量 4 × 每任务 3（`claimOne` 1 + send 1 + `markQueued` 1）= **15**；批量 4 = `floor((15−3)/3)`（子计划 2 T2.4 冻结，Rev 4 账目沿用）。
- **多组缩批（T3.5，意见 9 三集合后）**：固定 4（d1 3 + oauth 1）+ tailReserve 2（完成/释放批 d1 预留）→ 每冷组 13；`floor((40−4−2)/13)` = 2 组后停止，未执行对象入 `released` 双表复位；`earlyStopBatches` +1。
- **投影事务（§12.4）**：单 batch 语句数 = 1（投影 UPDATE）+ 1（精确 taskId `IN` 完成）+ N（event delivery）+ 1（snapshot delivery）+ (N+1)（archive task）= **2N+3**；N=10 → 23 条语句、10+1 归档对象。`2N+3` 命中 2 处（子计划 2 + 本记录）。
- **七入口预算帽（T3.6，意见 8 重算后）**：ingress **7**（鉴权 1 + 三查询 1 + 接收 batch 1 + 回读 1 + `dispatcher.run`(claimOne 1 + send 1 queue + markQueued 1)，帽 10；Rev 4 记 5 未计 claimOne/markQueued 两次 d1，本轮已同步修正子计划 3 T3.6 注释）、query 4（10）、init 3（10）、project consumer **12**（d1 11 + queue 1，帽 20；意见 7③ 唤醒查询 +1、意见 8 `dispatcher.run` +3，Rev 4 记 8）、archive 38（40）、dlq 2（10）、recovery 15（15）。`7 ≤ 10` 相关表述命中 8 处、`12` 重算表述命中 3 处，主索引/子计划 3/子计划 4 三处账目一致。
- **退避与阈值**：`RETRY_THRESHOLD = 5` 命中 4 处（规格/子计划 1/2/主索引一致）；`BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000]` 命中 2 处（子计划 1 Worker outbox 与子计划 4 本地 outbox 同序列；意见 12 下标从 0，首档 30s）；`QUEUED_STALE_MS = 10*60_000`（子计划 1，Rev 4 沿用）。

## 6. 边界与遗留

1. **主仓库残留（需用户授权）**：主仓库 `C:\Users\27846\my-chatgpt-mcp`（分支 `feat-generic-profile-runtime`）工作树的两处 Rev 4 期残留（spec 修改 M 状态 + untracked subplan-1 文件）**保留原样未清理**，清理需乔炳源显式授权后执行（Rev 4 自检记录 §6.1 同一事项）。
2. 提交仅在 worktree 本地执行（显式 `git add` 文件清单），**不 push**。
3. 子计划 4 T4.5/T4.6 的"查询消息校验边界"为 Rev 5 在 §10.2（`payload.targetRequestId` 不变）与意见 5（注册表冻结）之间的显式化裁定：查询消息经"外壳 + 身份 + 按 scope 的 payload 规则"校验，事件注册表只约束 `/v2/events`——两侧各有测试锁定，请 Codex 五审重点核对此裁定。
4. 完成后停止，等待 Codex 五审；不进入 Phase 1。
