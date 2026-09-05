# Reliable Drive Sync V2 Implementation Plan — Revision 5 主索引（等待 Codex 五审）

> **状态：** 本主索引与四份 execution-ready 子计划、上位规格 Rev 5 构成 Revision 5 完整交付。按 Codex 四审结论要求：完成后停止，等待五审，**不进入 Phase 1**。Revision 1–4 全部文档保留未删除。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## 1. 四审结论与本轮修订范围

Codex 四审（审核对象 commit `9649d5a`）结论：**Rev 4 退回修订，目前不建议进入 Phase 1**。退回意见共 **13 条**（编号 1–13），并要求：① 逐项提交"修订位置、具体失败样本、预期行为"，保持 13 条编号不变；② 优先统一**预算、D1 接口、首次事件完整链路、归档状态机**四个基础面，再展开四个业务域。本轮交付：

- 上位规格原地修订至 Rev 5（13 条修订记录，编号与四审一致，受影响章节就地修补）；
- 新建本主索引（含 13 行逐项矩阵：意见 → 修订位置 → 具体失败样本 → 预期行为 → 任务/测试/提交边界）；
- 新建四份 Rev 5 execution-ready 子计划：基础面先行——子计划 1（意见 3/4/5/6：D1 适配器、身份绑定、协议分层、幂等闭环）、子计划 2（意见 1/7/8/11：预算总量、首次投影、Queue 统一、reducer 保真）、子计划 3（意见 2/9/10：归档预算、归档状态机、Drive 原语签名）、子计划 4（意见 5/12/13：displayName、本地 outbox 事务、runbook 可执行）；
- 新建 Rev 5 自检记录（grep 证据 + 数字一致性复核）。

**本轮权限边界（G0 强制）：** 只修订规格、主索引、四份子计划与自检记录；不修改代码、不部署、不迁移、不创建 Queue、不写入 D1/Drive、不开启任何 V2 开关、不 push。

## 2. 文档清单（全部位于 worktree `feat/rds2-v2`）

| 文档 | 角色 | 状态 |
|---|---|---|
| `docs/superpowers/specs/2026-09-05-reliable-drive-sync-v2-requirements-and-architecture.md` | 上位规格 Rev 5（821 行，修订记录 13 条，§21.4 十六验收门） | 原地修订 |
| `docs/superpowers/plans/2026-09-05-v2-rev5-subplan-1-protocol-identity-d1.md` | 子计划 1 Rev 5：协议/身份/D1 基础（T1.1–T1.17，意见 3/4/5/6） | 新建（495 行） |
| `docs/superpowers/plans/2026-09-05-v2-rev5-subplan-2-queue-projection-reducers.md` | 子计划 2 Rev 5：状态机/投影事务/最小充分状态（T2.1–T2.15，意见 1/7/8/11） | 新建（1043 行） |
| `docs/superpowers/plans/2026-09-05-v2-rev5-subplan-3-drive-budget-observability.md` | 子计划 3 Rev 5：归档认领/诚实成本模型（T3.1–T3.7，意见 2/9/10） | 新建（469 行） |
| `docs/superpowers/plans/2026-09-05-v2-rev5-subplan-4-local-mcp-skills-release.md` | 子计划 4 Rev 5：本地 Outbox/路由/runbook（T4.1–T4.11，意见 5/12/13） | 新建（524 行） |
| `docs/superpowers/plans/2026-09-05-v2-rev5-selfcheck-record.md` | Rev 5 自检记录 | 新建 |
| Revision 1–4 全部文档（含 rev1–rev4 规格期次与 rev3/rev4 子计划、索引、自检记录） | 历史版本 | **保留，未删除未覆盖** |

## 3. 执行顺序与前置门

```text
G0 前置门：确认 worktree 干净基线 → 子计划 1（T1.1→T1.17）
         → 子计划 2（T2.1→T2.15）→ 子计划 3（T3.1→T3.7）→ 子计划 4（T4.1→T4.11）
         → 全局完成门（§5）→ 停止，等待 Codex 五审
```

- 每 Task：失败测试 → 预期失败 → 最小实现 → `npm run test:worker`/`test:bridge` 绿 → 显式 `git add` 该 Task 文件清单提交。
- 每 Task 回滚：`git revert <task_sha>`。
- 禁止：`git add -A`、`reset --hard`、`checkout --`、`stash drop`、修改受保护 V1 路径、`git push`、部署、开关变更。
- Rev 5 任务处置约定：各子计划开头均含"Rev 5 关键修订表"（逐项：修订位置/失败样本/预期行为）与"任务处置总表"（整体替换 / 逐字继承 / 适配继承）；逐字继承的任务以 Rev 4 对应 Task 全文为准，适配继承的任务在继承基础上按标注块修改。

## 4. 逐项矩阵：四审意见 → 修订位置 → 具体失败样本 → 预期行为 → 任务/测试/提交边界

| # | 意见（摘要） | 修订位置 | 具体失败样本 | 预期行为 | 测试锁定与提交边界 |
|---|---|---|---|---|---|
| 1 | 预算器总量口径：`consume` 必须同时过类别与合计双检查 | §15.1；子计划 2 T2.1（consume 重写）、子计划 3 T3.2/T3.4（证明锁定） | 已消费 `d1=35` 后 `consume("queue",10)`：单类别检查 `0+10≤40` 通过，合计 45>40 被放行（Rev 4 只查单类别） | 类别余量与全类别合计（含本次 count ≤40）同时通过才放行；任一超限抛 `subrequest_budget_exceeded:<cat>` / `:total`；被拒绝的 consume 零记账（`snap.queue===0`） | T2.1 失败样本测试断言拒绝后 `total===35` 不变；commit `feat(v2): subrequest budget with dual per-category and total checks` |
| 2 | 归档预算支撑：计数唯一收口在预算化封装 | §15.1/§15.3；子计划 3 T3.2（`budgetFetch` 收口）、T3.4（最坏证明） | OAuth token POST 不经预算器、tokenProvider 每次调用重新获取（`drive_oauth` 重复计数）、重定向自动跟随不计数 → `snapshotByCategory()` 漏记，38≤40 证明失真 | `budgetFetch(budget)` 为唯一 HTTP 计数点（`options.category` 参数化，默认 `fetch_other`）；OAuth POST 经 `budgetFetch` 计 `drive_oauth`；`tokenPromise ??=` 同 invocation memoize；`redirect:"manual"` 每次手动跟随前计 `redirect`；禁止平行计数器 | T3.2 静态测试禁止 `budgeted-io.js` 外出现 `consume("drive_*/redirect/fetch_other")`；T3.4 断言 `drive_oauth===1`、`redirect===0`；commit `feat(v2): budgeted fetch as the single http counting choke point` |
| 3 | D1 适配器语句对象：私有包装 + `{results}` 形状 | §3 决策 15/§15.1；子计划 1 T1.7 | Rev 4 适配器语句对象形态不明，`all()` 不保证 `{results:[...]}` 包络 → 仓库层 `.results` 解包在本地与真 D1 行为分叉 | 每次 `prepare` 创建私有包装语句对象（WeakMap 持有 sql+绑定，不复用）；`all()` 返回 `{results}`；`batch()` 顺序执行返回逐语句结果数组；`run()` 含 `meta.changes`；显式 `BEGIN/COMMIT/ROLLBACK` 经 `exec` | T1.7 同一接口断言套件同时跑 node:sqlite 适配器与 Miniflare 真 binding；commit `feat(v2): sqlite adapter simulating real d1 api` |
| 4 | 身份初始化错绑：双向核对 | §17；子计划 1 T1.15（init 服务）、T1.9（credential-auth） | 两个展示名经 NFKC 折叠产生相同 `name_key` → 正向解析把新凭据绑到旧用户 `user_id` | `name_key→user_id` 命中后反向校验该行 `name_key` 与入参规范化一致；签发凭据前校验该哈希未绑定其他 `user_id`；任一方向不一致 `identity_conflict`，初始化 batch 零残留 | T1.15 全角 displayName → `identity_conflict` 拒绝 + users/credentials/projections 计数均 0；commit `feat(v2): identity init with bidirectional name key binding check` |
| 5 | 协议兼容冲突：事实分层冻结（displayName） | §10/§17；子计划 1 T1.2（parity 锁）、子计划 4 T4.5（样本修正）、T4.6（查询边界） | ① 子计划 4 T4.5 的 user resolve 样本 `payload:{username:"乔炳源"}` 必被共享校验器 `invalid_payload` 拒绝（`protocol.js:36,404`）——计划自带正样本不过自带校验器；② 查询消息若套用事件注册表，`scope/targetRequestId` 必被拒，§10.2 无合法载体 | envelope `identity` 仅 `userId/username`；resolve payload = `{displayName}` 唯一字段；`payload.username` 全部作废；V2 不新增事件类型（18 种 V1 全集）；查询消息经"外壳+身份+按 scope 的 payload 规则"校验，事件注册表只约束 `/v2/events` | T1.2 parity 集含 `{username}` 反样本（两侧同拒）；T4.5 displayName 正样本 + username 负样本端到端；T4.6 同一 `scope:event_status` 消息 `/v2/query` 受理 vs `/v2/events` 400；commit `feat(v2): full-coverage validator with v1-frozen error code tiering`、`test(v2): bridge read write integration with displayName and query message boundary` |
| 6 | 幂等矩阵闭环：竞态 conflict 不泄漏 SQL 异常 | §9；子计划 1 T1.3（矩阵）、T1.14（UNIQUE 重查）、子计划 2 T2.7（投影期闭环） | 同 `eventId` + 新 `requestId` + 同业务内容 → `envelope_hash` 必不同（hash 覆盖全 envelope）→ 预查全空 → INSERT 撞 `UNIQUE` → 原始 SQL 异常泄漏为 500 | 接收期：UNIQUE 捕获后按四入口重查 → `ProtocolError("event_id_conflict")` 稳定 409，错误消息不含 `UNIQUE constraint failed`；投影期：`event_key_conflict` → `needs_attention` 保留两端 `event_id`，禁止静默去重 | T1.14 竞态 UNIQUE 重查测试（conflict/corrupt/retry 三分支）；T2.7 投影期冲突转 needs_attention 断言；commit `feat(v2): atomic accept service with conflict-closed race relookup` |
| 7 | 首次投影启动：`emptyProjection(identity)` 唯一初始态 | §12/§7.2；子计划 2 T2.9（契约更名 + 播种）、T2.7（引擎）、T2.10–2.13（publicView 回填） | ① 读不到投影行把 `{}` 传给 reducer → `publicView` 输出 `userId:null`；② `lastSeq+1` 全局推进跨用户错位唤醒；③ 两处 `deterministicDeliveryId(...)` 漏 `await` → `drive_file_id` 落成 `[object Promise]` | 缺行或 `state_json` 为 NULL 一律 `emptyProjection(identity)`（播种 `state.identity`）；游标按 `(user_id, namespace, projection_name)`；下一唤醒 taskId 按用户查询下一事件派生；`publicView` 从最小状态重算并回填 `userId/username`；`deterministicDeliveryId` 为 async 32-hex（`/^[0-9a-f]{32}$/` 回归锁） | T2.7 引擎首次启动 + per-user 唤醒查询测试；T2.15 `userId: null` 零命中断言；commit `feat(v2): projection engine with empty projection bootstrap and per-user wake derivation` |
| 8 | Queue 批处理统一：batch 级签名 + 唤醒经 Dispatcher + 阈值接线 | §13/§14；子计划 2 T2.3（`{run()}` 对象）、T2.5（四处理器 batch 级）、T2.4（恢复器复用 `.run()`）、T2.8（wakeNext 接线）、子计划 4 T4.6（接收唤醒） | ① 引擎 `wakeNext` 直连 `queueIo.sendWake` 绕过 Outbox 状态机，任务行停留 `pending`；② 投影处理器逐消息 `(body, message)`、归档处理器 batch 级，两形态并存；③ send 失败无阈值转移，`queue_send_failed` 无限重试 | 四队列处理器统一 batch 级 `async (batch, env, ctx)` 按 `batch.queue` 路由；Dispatcher 返回 `{run(taskId)}`，接收唤醒/引擎续批/恢复器三方共用；send 失败 `failWithBackoff(taskId,"queue_send_failed")`，`attempt_count≥RETRY_THRESHOLD=5` → `needs_attention` | T2.3 阈值接线测试（attempt 4→5 → needs_attention）；T2.8 续批唤醒经 dispatcher 断言行变 `queued`；T4.6 ingress 静态断言无 `sendWake`；commit `feat(v2): dispatcher run entry with threshold wired into send-failure path`、`feat(v2): unified batch-level queue handler with root budget and four consumers` |
| 9 | 归档失败覆盖：三集合分离 + 逐行完成 | §14；子计划 3 T3.3（归档器重写）、T3.5（三集合测试） | ① 完成语句单条 IN-list UPDATE 只绑一个 fileId → 多行 delivery 被复写同一 `drive_file_id`；② `needs_attention` 行被后续 batch 的完成语句覆盖为 `delivered`；③ 预算不足未执行对象既未投递也未释放租约（任务丢失） | `delivered`/`attentioned`/`released` 三集合两两不相交；认领在双表写 `lease_owner='archiver:<invocationId>'`；完成按精确 `archive_delivery_id` 逐行 UPDATE（谓词 `state='delivering' AND lease_owner=?`），每行绑自身 `drive_file_id`；`released` 集合双表复位 | T3.3 十二条测试（三集合/免覆盖/逐行 fileId/释放）；T3.5 三集合两两不相交断言；commit `feat(v2): batch-level drive archiver with three disjoint outcome sets and per-row completion` |
| 10 | Drive 原语签名：冻结 + 重放改 readback 哈希 | §14/§15.1/§15.3；子计划 3 T3.1（签名冻结）、T3.3（重放路径） | Rev 4 元数据参数方案向 `googleUpload` 第 5 参传 appProperties 对象——真实签名第 5 参是 `mimeType`（`google-drive.js:71`），调用即参数错位；且自写 appProperties 哈希不构成内容证据 | `googleUpload(env, parentId, name, content, mimeType, fetchImpl, tokenProvider)` 签名冻结字节一致（`.length===5` 测试锁）；metadata 恰为 `{name, parents:[parentId], mimeType}`（断言无 appProperties）；重放 = 精确查找 1 + content-only readback 1 + SHA-256 比对冻结 `artifact_hash`，成本 2；全新对象 3；最坏合计 38≤40 | T3.1 签名冻结 + metadata 形状断言；T3.4 重放路径证明（8 既有 → `drive_upload 0`、readback 8、total ≤40）；commit `refactor(v2): extract drive http primitives with frozen signatures and add readTextContent` |
| 11 | Reducer 状态保真：四域字段级映射 + 容量上限 | §12；子计划 2 T2.10–2.13（四域重写）、T2.7（容量 catch 接线） | ① generic-profile 状态不留 observations 分组序列 → "最近负向后两个独立 sourceRef 正向才关闭弱点"（`generic-profile-model.js:144-159`）无从重算；② interview `statusOf` 读到 V1 fallback 字段（`status:"failed"` 覆盖 `outcome:"passed"`）→ 结论分叉；③ resume mastery 无 `0.6·new+0.4·prev` 混合；④ 数组无界增长撑爆 2 MiB | 四域各有字段级映射表（payload 字段 → state 位置 → publicView 派生 → 源码行号）；interview 边界后 `profileChanges` 仅 8 字段、`statusOf` 有效输入只有 `outcome`；resume 混合 `round2(0.6·new+0.4·prev)`；每键容量上限 + 写前断言，超限 `state_limit_exceeded:<domain>.<field>` → `toNeedsAttention` 零写入 | T2.10–2.13 各域"状态最小 + 增长 + 容量断言"测试；T2.13 `{outcome:"passed", status:"failed"}` → pass 行为差锁；commit `feat(v2): <domain> reducer with field-level minimal sufficient state` ×4 |
| 12 | 本地 Outbox 运行时：显式事务 + 认领谓词 + 退避下标 + blocked 排除 + 回执时机 | §11/§10.1；子计划 4 T4.3（outbox 重写）、T4.4（delivery 重写）、T4.7（套件适配） | ① `this.db.transaction is not a function`（Node 22.22.2 实测 `typeof db.transaction === "undefined"`）——首次 flush 即 TypeError；② `markSending` 认领 `available_at=now+60s` 的退避中行并立即发送；③ `capBackoff(attempt_count)` 首档直接 60s；④ blocked 行 `submit()` 谎报 `{status:"pending"}` | 显式 `exec("BEGIN IMMEDIATE")`/`COMMIT`/异常 `ROLLBACK`；认领谓词 `state='pending' AND (available_at IS NULL OR available_at <= now)`；`capBackoff(attempt_count - 1)` 首档 30s，序列 `[30,60,120,300,600,600…]`；blocked 返回 `{status:"blocked", errorCode}` 且不入任何待发查询；本地兜底回执不含 `persistence.localOutbox:"acknowledged"`（仅 Worker durable receipt 携带） | T4.3 环境锁 + BEGIN/COMMIT 序列 + ROLLBACK 断言；T4.4 首档 30s 全序列 + blocked 零网络 + 回执时机锁；commit `feat(v2): local outbox v2 with explicit transactions and due-gated claiming`、`feat(v2): delivery service v2 with zero-based backoff and blocked semantics` |
| 13 | 发布与自检可执行：解释器 + 一次性前置 + 回滚语义统一 | §19.2/§21；子计划 4 T4.10（runbook 重写） | ① runbook 附录 `node ...\setup-local-clients.ps1`——PowerShell 脚本（`param(...)` 块）node 无法执行；② 当前 `wrangler.toml` 无 `[[queues]]` 段，Rev 4 十步直接暗部署，四队列不存在、V2 迁移未应用、恢复器 cron 未启用；③ 步 6/7"清空白名单"回滚——显式空串即全 namespace 503 `canary_misconfigured`，回滚动作本身制造全量故障 | ① `powershell -File`/`pwsh -File` 调用（静态断言 `/node\s+\S*\.ps1/` 零命中）；② 第 0 节一次性前置：四条 `wrangler queues create`（队列名与子计划 2 T2.5 TOML 逐字一致）+ `d1 migrations apply reliable-drive-sync --remote` + 核对 `[[queues]]` 块与 `2-57/5 * * * *` cron；③ 回滚列统一"恢复上一部署版本并关闭功能开关"，"清空白名单"全文零命中 | T4.10 配置一致性测试五块（变量/占位符/解释器/前置/回滚语义）；commit `docs(v2): executable runbook with queue prerequisites and unified rollback` |

### 4.1 十六条验收门映射（§21.4 → Rev 5 任务/测试）

| # | 验收门 | Rev 5 任务/测试（相对 Rev 4 的变化） |
|---|---|---|
| 1 | 真实 Miniflare 异步 D1 | T1.16 断言①②④（意见 3：同一接口套件同时跑适配器与真 binding） |
| 2 | 四唯一作用域并发 | T1.14 + T1.16 断言②（意见 6：UNIQUE 重查 conflict 闭环） |
| 3 | 每类型一正一反样本 | T1.2（18×2 参数化 + parity 金样本；意见 5：`payload.username` 反样本必入 parity 集） |
| 4 | 身份初始化零残留 | T1.15 + T1.16 断言⑥（意见 4：双向核对拒绝后计数为 0） |
| 5 | 10 事件 10+1 归档 | T2.7（single batch freezes 10+1） |
| 6 | 精确任务完成（禁 BETWEEN） | T2.7（IN 列表 + 交叉用户干扰 + 静态断言） |
| 7 | 发布-回写失败全链路 | T2.8 链 A（意见 8：全程经 `dispatcher.run`） |
| 8 | queued 恢复全链路 | T2.8 链 B（含 10 分钟边界 + 陈旧 queued 回收后经 `dispatcher.run` 重发） |
| 9 | 全通道预算 | T3.2（意见 2：`budgetFetch` 唯一计数点 + memoize + redirect manual）+ T3.4 |
| 10 | 并发认领 | T2.3（dispatcher 并发互斥）+ T3.3（归档并发认领 + lease_owner 双表） |
| 11 | 状态上限 2 MiB | T2.7（引擎断言 + 容量前缀 catch）+ T2.14（边界集成） |
| 12 | 本地 Outbox 重启/超时/退避/阻塞/重放 | T4.7 五块（意见 12：首档 30s 序列 + blocked 不入待发查询） |
| 13 | 无 Content-Length 413 | T4.6 step2 双场景 |
| 14 | 暗部署全闭 | T4.6 routes 全闭测试 + T4.11 flags-off 快照 |
| 15 | 逐 cron 预算 | T2.4（V2 total===15）+ T3.6 七入口（意见 8：ingress 重算为 7≤10、project consumer 重算为 12≤20） |
| 16 | 全绿门 | T4.11（`npm test` worker+bridge 双绿）+ 各子计划完成门 grep |

## 5. 全局完成门（五审前自检依据）

- [ ] 四份子计划各自的"覆盖与自检"节全部勾选（子计划 1：`grep "res.changes"` 零命中 + `identity.displayName` 零命中；子计划 2：`emptyState`/`userId: null` 零命中、`queueIo.sendWake` 仅现于 dispatcher-v2.js；子计划 3：`appProperties` 零命中、`tokenPromise ??=`/`redirect:"manual"` 在位；子计划 4：`payload: { username`/`.transaction(`/`清空白名单`/`node … .ps1` 零命中、ingress 无 `sendWake`）。
- [ ] `npm run test:worker` 与 `npm run test:bridge` 双绿；wrangler dry-run（确定性 outdir）退出码 0。
- [ ] 七入口预算证明全绿（T3.6，ingress 7≤10、project consumer 12≤20、archive 38≤40）；两条规格必测链路存在（T2.8）；16 验收门映射逐条有测试。
- [ ] 13 条意见逐项矩阵（§4）与四份子计划"Rev 5 关键修订表"逐行一致（编号、修订位置、失败样本、预期行为四列可对账）。
- [ ] 占位符与命名一致性 grep 证据记录于 `2026-09-05-v2-rev5-selfcheck-record.md`。
- [ ] **停止：不进入 Phase 1，等待 Codex 五审。**
