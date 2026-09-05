# Reliable Drive Sync V2 Implementation Plan — Revision 4 主索引（等待 Codex 四审）

> **状态：** 本主索引与四份 execution-ready 子计划、上位规格 Rev 4 构成 Revision 4 完整交付。按 Codex 三审意见十四要求：完成后停止，等待四审，**不进入 Phase 1**。Revision 1–3 全部文档保留未删除。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## 1. 三审结论与本轮修订范围

Codex 三审（审核对象 commit `f619405`）结论：**不批准进入 Phase 1，要求 Revision 4**。退回意见含 **11 项 P0 阻断问题 + 1 项 P1（Runbook 与自检记录不可信）+ 16 条新增验收门**。本轮交付（意见十四）：

- 上位规格原地修订至 Rev 4（11 条修订记录，逐条对应 11 项 P0）；
- 新建本主索引（含"审核意见 → 规格章节 → 任务 → 测试 → 提交边界"逐项矩阵）；
- 修订或新建四份 execution-ready 子计划（全部阻断项落实到具体 SQL/接口签名/状态机/伪代码/失败测试，未写入"注意事项"式空话）；
- 新建 Rev 4 自检记录（grep 证据 + 数字一致性复核）。

**本轮权限边界（G0 强制）：** 只修订规格、主索引、四份子计划与自检记录；不修改代码、不部署、不迁移、不创建 Queue、不写入 D1/Drive、不开启任何 V2 开关。

## 2. 文档清单（全部位于 worktree `feat/rds2-v2`）

| 文档 | 角色 | 状态 |
|---|---|---|
| `docs/superpowers/specs/2026-09-05-reliable-drive-sync-v2-requirements-and-architecture.md` | 上位规格 Rev 4（787 行，修订记录 11 条，§21.4 十六验收门） | 原地修订 |
| `docs/superpowers/plans/2026-09-05-v2-rev4-subplan-1-protocol-identity-d1.md` | 子计划 1：协议/身份/D1 基础（T1.1–T1.17） | 新建 |
| `docs/superpowers/plans/2026-09-05-v2-rev4-subplan-2-queue-projection-reducers.md` | 子计划 2：状态机/投影事务/最小充分状态（T2.1–T2.15） | 新建 |
| `docs/superpowers/plans/2026-09-05-v2-rev4-subplan-3-drive-budget-observability.md` | 子计划 3：归档认领/诚实成本模型（T3.1–T3.7） | 修订重写 |
| `docs/superpowers/plans/2026-09-05-v2-rev4-subplan-4-local-mcp-skills-release.md` | 子计划 4：本地 Outbox/路由/runbook（T4.1–T4.11） | 修订重写 |
| `docs/superpowers/plans/2026-09-05-v2-rev4-selfcheck-record.md` | Rev 4 自检记录 | 新建 |
| Revision 1–3 全部文档 | 历史版本 | **保留，未删除未覆盖** |

## 3. 执行顺序与前置门

```text
G0 前置门：确认 worktree 干净基线 → 子计划 1（T1.1→T1.17）
         → 子计划 2（T2.1→T2.15）→ 子计划 3（T3.1→T3.7）→ 子计划 4（T4.1→T4.11）
         → 全局完成门（§5）→ 停止，等待 Codex 四审
```

- 每 Task：失败测试 → 预期失败 → 最小实现 → `npm run test:worker`/`test:bridge` 绿 → 显式 `git add` 该 Task 文件清单提交。
- 每 Task 回滚：`git revert <task_sha>`。
- 禁止：`git add -A`、`reset --hard`、`checkout --`、`stash drop`、修改受保护 V1 路径、`git push`、部署、开关变更。

## 4. 逐项矩阵：审核意见 → 规格章节 → 任务 → 测试锁定 → 提交边界

| # | 审核意见（摘要） | 规格章节（Rev 4） | 任务 | 测试锁定 | 提交边界（commit 消息） |
|---|---|---|---|---|---|
| P0-1 | D1 接口模型与真实 D1 不兼容：需全异步、`batch()` 接收绑定语句数组、`meta.changes`、SQLite 适配器模拟真实 API、budgetD1 三形态、Miniflare 对象配置、`shared/` 相对路径四层修正 | §3 决策 15、§7.2、§11、§15.1 | T1.7（适配器）、T1.8–T1.13（六仓库 async 化）、T3.2（budgetD1 三形态） | T1.16 断言①异步 API ②绑定 batch 中途失败回滚 ④`meta.changes` 形状；全局 grep `res.changes` 零命中 | `feat(v2): sqlite adapter simulating real d1 api`、`feat(v2): async repositories …`、`feat(v2): budgeted d1 queue drive fetch wrappers …` |
| P0-2 | 三 ID 与业务去重未闭环：需业务唯一索引 SQL、resolveIntent 重写、七条冻结冲突矩阵 | §7.2（`idx_rds2_events_business_scope`）、§9（七矩阵 + 优先级 conflict>corrupt>exact_retry>already_recorded>new_event） | T1.3（resolveIntent 完整实现）、T1.6（唯一索引迁移）、T1.14（accept-service） | T1.6 schema 测试断言索引存在；T1.3/T1.14 每条矩阵一正一反；T1.16 断言②四唯一作用域并发（UNIQUE 兜底 + 重查） | `feat(v2): resolveIntent seven-matrix …`、`feat(v2): migration 0006 …`、`feat(v2): accept service …` |
| P0-3 | 完整校验器只校验 algorithm：需覆盖全部 V1 事件类型每类型一正一反、修正 LeetCode 206 示例 displayName→username | §8（示例修正 + "协议没有 result，也不存在 identity.displayName"）、§10.1 步骤 3 | T1.2（18 类型注册表校验器 + ≥36 组 parity 金样本）、T1.1（协议模块） | 参数化测试 18×2；`grep displayName` 在协议/示例路径零命中（用户表 `display_name` 字段除外，见自检记录） | `feat(v2): shared protocol module with full payload registry` |
| P0-4 | 原子事务边界破坏：身份初始化单 batch、投影事务五组操作（10 事件→10+1 归档）、禁 BETWEEN 区间完成任务 | §12.4、§17 | T1.15（身份初始化单 batch）、T2.7（投影引擎单 batch 五组操作 = 2N+3 条语句） | T2.7 断言"single batch freezes 10 event artifacts + 1 snapshot"、精确 taskId `IN` 列表（交叉用户干扰测试）、mid-batch 失败全回滚、`grep BETWEEN` 零命中；T1.16 断言⑥身份初始化零残留 | `feat(v2): identity init single d1 batch`、`feat(v2): projection engine with single-batch five-operation transaction …` |
| P0-5 | Queue Outbox 状态机不成立：原子认领 UPDATE…RETURNING、Dispatcher 六条、queued 恢复规则 | §13（全部状态机规则） | T2.3（Dispatcher 六条）、T2.4（recovery + 陈旧 queued 回收 10 分钟）、T1.11（outbox 仓库 claimDue/claimOne/markQueued(queued_at)/reclaimStaleQueued） | T2.3 六条规则逐条测试 + 并发互斥；T2.8 规格两条必测链路（发布-回写失败→重发→重复消费无副作用；queued 丢失→陈旧回收→恰好一次效果）；`grep Promise.all` 零命中 | `feat(v2): dispatcher with atomic claim and six state machine rules`、`feat(v2): dedicated v2 cron invocation …`、`feat(v2): project consumer wiring with the two mandatory end-to-end chains` |
| P0-6 | Drive 归档器没有真正认领且完成错误任务：invocation/batch 级、逐对象完成、ack()/retry()、同名多文件 needs_attention | §14（全条） | T3.3（batch 级原子认领、(userId,namespace) 分组、逐对象完成自身 delivery+task、逐条 ack/retry、ambiguity、appProperties 哈希重放） | T3.3 十二条测试：认领精确性/并发互斥/分组复用/secret 根起步/逐对象完成/预算不足释放+retry/ambiguity/重放=1/异哈希禁覆盖/冻结字节哈希；修复 Rev 3 `uploadResult/fileId` 未定义错误 | `feat(v2): batch-level drive archiver with atomic claim per-object completion` |
| P0-7 | 36 次预算证明低估：先冻结精确成本模型、全通道统计、真实 Queue batch 入口、不能 ≤40 则自动缩批 | §15.1（四封装 + 十类别）、§15.3（38≤40 明细表 + 边界规则） | T3.2（budgetD1/Queue/Drive/fetch 全通道）、T3.4（单组 8 对象 38≤40 精确证明）、T3.5（多组自适应缩批 + 释放租约） | T3.4：total 直接来自 `snapshotByCategory()` 合计、经真实 `worker.queue(...)` 入口、Miniflare D1 真 binding + budgetD1、逐类别断言（oauth 1/list 13/create 5/upload 8/readback 8/read_meta 0/d1≤3）；T3.5：processed===2 + total≤40 + 释放断言 | `feat(v2): budgeted d1 queue drive fetch wrappers over shared budget`、`test(v2): honest 38<=40 worst-case archive proof via real queue entry` |
| P0-8 | V1/V2 共用 scheduled invocation 与 40 上限冲突：V2 独立 cron invocation | §3 决策 16、§15.2（`2-57/5 * * * *`，V1 三条逐字节保留） | T2.4（crons 追加 + `controller.cron` 精确匹配分流 + 有界恢复器批量 4） | T2.4 coexistence 测试：三个 V1 cron 只走 V1、`2-57/5` 只走 V2、暗部署全闭、逐 cron 预算（V2 total===15）、TOML 字节断言 | `feat(v2): dedicated v2 cron invocation with bounded recovery and stale queued reclaim` |
| P0-9 | Reducer 状态无限增长：最小充分状态、state_json 2 MiB 上限、correction observedAt 严格晚于、resume 当前 resumeVersion bank、等价输入不含重复 eventKey、toDomainEvent 冻结 username | §12（最小充分状态四域设计 + 上限 + 等价语义） | T2.9（toDomainEvent username + identity_row_mismatch）、T2.10–T2.13（四域最小状态）、T2.14（2 MiB 边界集成）、T2.15（等价套件，eventKey 唯一输入） | 四域各有"state stays minimal + 增长测试"；T2.11 correction `Date.parse` 严格晚于（V1 规则保留，修正 Rev 3 的 seq 比较）；T2.13 bank 替换制（修正 Rev 3"最低 seq"）；T2.15 构造器自检 eventKey 唯一 + `grep accepted` reducers 零命中 | `feat(v2): algorithm reducer with minimal sufficient state` 等 ×4、`test(v2): state limit boundary integration assertions`、`test(v2): four-domain fold and incremental equivalence suites` |
| P0-10 | 本地 Outbox 状态机不完整：canonical hash 含全部字段、available_at、confirmed 重放、AbortController、永久错误集合 | §11（全条） | T4.3（canonical fingerprint + available_at + 原子认领）、T4.4（30s 中止 + 永久错误集合 + 共用状态流 + confirmed 重放）、T4.7（五语义混沌套件） | T4.3：键序无关 fingerprint/条件认领跳过/到期门/重启恢复；T4.4：七类永久码逐个 block/400-409 兜底/超时 Temporary/退避封顶 600s/批量不重复 markSending/confirmed 零网络重放 | `feat(v2): local outbox v2 with canonical fingerprint and due gating`、`feat(v2): delivery service v2 with abort timeout and permanent error set`、`test(v2): local outbox chaos semantics` |
| P0-11 | HTTP 路由未接预算与完整身份检查：入口根部单预算器、全部依赖预算化、先鉴权、实际字节限制、canary fail-closed、init 独立开关、targetRequestId 字段区分 | §10.1（接收九步）、§10.2（targetRequestId/targetEventId）、§15.1 | T4.6（三路由重写）、T4.5（bridge targetRequestId 契约）、T3.2（静态封装断言） | T4.6 九步逐条：鉴权先行不读 body/双检 413/username→name_key 双核对/canary fail-closed/admin 分离/init 独立开关/静态 `env.DB` 零命中；T4.5 断言 envelope.requestId 与 payload.targetRequestId 并存且不同 | `feat(v2): auth-first budgeted v2 routes with identity dual check and init flag`、`test(v2): bridge read write integration with targetRequestId contract` |
| P1 | Runbook 与自检记录不可信：环境变量名不一致、占位符残留、dry-run 非确定性门、Windows PowerShell 兼容 | §19.2 | T4.10（runbook 修正版） | `rds2-runbook-config.test.js`：实现变量清单逐一 match/幻影变量 `RELIABLE_DRIVE_SYNC_OUTBOX_PATH_V2` 零命中/"本任务SHA/SHA/outdir"尖括号占位零命中/`tmp-dryrun` 确定性路径/PowerShell 版本存在 | `docs(v2): corrected ten-step runbook with unified vars and deterministic dry-run` |
| 意见十三 | 16 条新增验收门 | §21.4 | 见 §4.1 映射表 | 每条门至少一个具名测试 | 各任务提交边界覆盖 |

### 4.1 十六条验收门映射（Codex 意见十三 → §21.4 → 任务/测试）

| # | 验收门 | 任务/测试 |
|---|---|---|
| 1 | 真实 Miniflare 异步 D1 | T1.16 断言①②④ |
| 2 | 四唯一作用域并发 | T1.14 + T1.16 断言② |
| 3 | 每类型一正一反样本 | T1.2（18×2 参数化 + parity 金样本） |
| 4 | 身份初始化零残留 | T1.15 + T1.16 断言⑥ |
| 5 | 10 事件 10+1 归档 | T2.7（single batch freezes 10+1） |
| 6 | 精确任务完成（禁 BETWEEN） | T2.7（IN 列表 + 交叉用户干扰 + 静态断言） |
| 7 | 发布-回写失败全链路 | T2.8 链 A |
| 8 | queued 恢复全链路 | T2.8 链 B（含 10 分钟边界） |
| 9 | 全通道预算 | T3.2（四封装 + 静态绕过断言）+ T3.4 |
| 10 | 并发认领 | T2.3（dispatcher 并发）+ T3.3（归档并发认领） |
| 11 | 状态上限 2 MiB | T2.7（引擎断言）+ T2.14（边界集成） |
| 12 | 本地 Outbox 重启/超时/退避/阻塞/重放 | T4.7 五块 |
| 13 | 无 Content-Length 413 | T4.6 step2 双场景 |
| 14 | 暗部署全闭 | T4.6 routes 全闭测试 + T4.11 flags-off 快照 |
| 15 | 逐 cron 预算 | T2.4（V2 total===15）+ T3.6（七入口含 recovery 15） |
| 16 | 全绿门 | T4.11（`npm test` worker+bridge 双绿）+ 各子计划完成门 grep |

## 5. 全局完成门（四审前自检依据）

- [ ] 四份子计划各自的"覆盖与自检"节全部勾选（含子计划 1 的 `grep "result.changes"` 零命中、子计划 2 的 `grep BETWEEN/accepted` 零命中、子计划 3 的 `drive_read_meta/my-chatGPT-skills-v2` 零命中、子计划 4 的变量与占位符断言）。
- [ ] `npm run test:worker` 与 `npm run test:bridge` 双绿；wrangler dry-run（确定性 outdir）退出码 0。
- [ ] 七入口预算证明全绿（T3.6）；两条规格必测链路存在（T2.8）；16 验收门映射逐条有测试。
- [ ] 占位符与命名一致性 grep 证据记录于 `2026-09-05-v2-rev4-selfcheck-record.md`。
- [ ] **停止：不进入 Phase 1，等待 Codex 四审。**
