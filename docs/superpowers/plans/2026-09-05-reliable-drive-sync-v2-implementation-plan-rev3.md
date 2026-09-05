# Reliable Drive Sync V2 — Revision 3 主索引（Execution-Ready Plan Index）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 计划日期：2026-09-05  
> 上位规格：`docs/superpowers/specs/2026-09-05-reliable-drive-sync-v2-requirements-and-architecture.md`（已同步修订至 Rev 3）  
> 历史版本：Rev 1（`...-implementation-plan.md`）、Rev 2（`...-implementation-plan-rev2.md`），保留作审核轨迹，不再维护  
> 审核输入：Codex 2026-09-05 对 Revision 2 的复审结论（十组修订要求）  
> 当前状态：**待 Codex 三审。未获通过不得进入任何子计划的 Task 1。**

**Goal:** 把 Reliable Drive Sync 从“每次快照扫描 Drive 全历史”改造为“D1 不可变事件账本 + 游标增量投影 + 有界 Drive 归档”，单次 Worker 调用外部子请求（含 D1/Queue/Drive/fetch/重定向）恒 ≤ 40，事件提交成本与历史总量无关。

**Architecture:** 本地 SQLite Outbox（`submit_event` 唯一 MCP 工具）→ `POST /v2/events`（凭据映射鉴权）→ D1 原子接收（事件 + 投影任务同一 batch）→ Cloudflare Queue 四队列（两主 + 两 DLQ，消息体 `{taskId, taskType, attempt}`）→ 增量投影器（触发器 CAS 游标）→ Drive 归档器（确定性路径、冻结 artifact、content-only readback）；`POST /v2/query` 带身份读取；D1 是唯一业务真相，Queue 只唤醒，Drive 只审计。

**Tech Stack:** Cloudflare Workers（ESM）、D1（SQLite，触发器 + batch 事务）、Cloudflare Queues（含 DLQ 消费者）、Google Drive v3 REST、Node ≥22 内置 `node --test`、`node:sqlite`（快速单元测试）、Miniflare（D1 真 binding 集成测试）、Wrangler 4（`--dry-run` 打包门）。零 npm 运行时依赖；唯一新增 devDependency 为 `miniflare`。

**Spec:** 上位规格 §3 锁定决策全部继承；Rev 3 修订点：§7.2（CHECK 约束、business_dedupe_key、CAS 触发器）、§13（taskId 关联、重复发布合法、DLQ 消费者）、§15（单 invocation 单预算器、全入口上限表）、§17（凭据映射身份）、§19.2（十步发布）。

---

## 子计划注册表

| # | 子计划 | 覆盖工作包（规格 §20） | 路径 |
|---|---|---|---|
| 1 | 协议、身份与 D1 数据底座 | 工作包 1、2 | `docs/superpowers/plans/2026-09-05-v2-rev3-subplan-1-protocol-identity-d1.md` |
| 2 | Queue、投影引擎与四域 Reducer | 工作包 4、5、6 | `docs/superpowers/plans/2026-09-05-v2-rev3-subplan-2-queue-projection-reducers.md` |
| 3 | Drive 归档、全入口预算与可观测性 | 工作包 7、8 | `docs/superpowers/plans/2026-09-05-v2-rev3-subplan-3-drive-budget-observability.md` |
| 4 | 本地 MCP、Skills、canary、发布与回滚 | 工作包 3、9、10 | `docs/superpowers/plans/2026-09-05-v2-rev3-subplan-4-local-mcp-skills-release.md` |

执行顺序：1 → 2 → 3 → 4；子计划内部 Task 严格按编号顺序。跨子计划依赖仅通过文件与接口（见各子计划 Interfaces 节）。

## 基线事实（2026-09-05 已核实）

- 分支 `feat-generic-profile-runtime`：`e58eabc`（六个 V1 热修已保存）→ `22ee4d2`（Node v26 断言修复）→ `53ced1e` + `4524f8c`（文档）。tag `v2-baseline-green` = `53ced1e`。
- 测试基线：Worker 380/380，Bridge 47/47（Node 22.22.2 与 26.7.0 双绿）。
- 隔离 worktree：`C:\Users\27846\my-chatgpt-mcp-v2`，分支 `feat/rds2-v2`。
- `protocol.js:6` namespace 白名单：`system/algorithm/interview/resume-knowledge/profile`；`protocol.js:27` envelope 字段白名单六字段。
- `google-drive.js`：`readJson` = metadata GET + content GET（2 次请求）；`readJsonValue` = content-only（1 次）；`createJson` = upload + readJson（3 次）；`oauthAccessToken/accessToken/googleUpload/googleGet` 未导出。
- `delivery-service.mjs:4` `READ_ONLY_EVENTS`：`interview.session.list`、`interview.session.load`、`system.capabilities.read`、`system.user.resolve`、`profile.snapshot.read`（+ dry-run legacy-migration）；读取走 `POST /v1/query`，从不写本地 Outbox。
- `wrangler.toml` crons：`*/5 * * * *`（V1 reconciler.runFiveMinute）、`0 * * * *`、`0 */6 * * *`。
- `Queue.send()` 只返回 `QueueSendResult` 队列指标，无消息 ID。

## 全局冻结决策（Rev 3，四份子计划共同遵守）

1. **Queue 关联**：消息体 `{ taskId, taskType, attempt }`；D1 Outbox 与消息的唯一业务键 = 确定性 `taskId`（`t_project_<event_seq>` / `t_archive_<deliveryId>`）；`queue_message_id` 列保留为 nullable 诊断、恒写 NULL；允许同一 taskId 重复发布，删除一切“不重复发布”断言。
2. **投影 CAS**：`rds2_projections` 上 BEFORE UPDATE 触发器，`NEW.last_event_seq <= OLD.last_event_seq` 时 `RAISE(ABORT,'stale_projection_write')`；消费者 UPDATE 不带 seq 谓词；CAS 失败 = SQL 错误 = 整个 batch 回滚 = 零副作用。
3. **事件读取**：`readAfter(userId, namespace, afterEventSeq, limit)`，索引 `(user_id, namespace, event_seq)`，LIMIT 作用于该用户该领域，不消耗全局窗口。
4. **原子接收**：一个 D1 batch 两条语句——事件 INSERT + Outbox INSERT...SELECT（`task_id = 't_project_' || event_seq`）；唯一约束失败后重查三 ID 返回稳定结果。
5. **身份**：`rds2_credentials(credential_hash, user_id, created_at)`，Bearer 凭据 SHA-256 → 派生 userId；请求体 identity 仅一致性核对；admin token 只进 `/v2/users/init`。
6. **预算**：每 invocation 根部一个 `SubrequestBudget(40)`，传给全部 D1/Queue/Drive/fetch 封装；类别 `d1/queue/drive_oauth/drive_list/drive_create/drive_upload/drive_read_meta/drive_read_content/redirect/fetch_other`；恢复器在 */5 cron 预留 15。
7. **resume 同日首评**：方案 B——服务端对 `resume-knowledge.answer-scored` 从 `payload.event.questionKey` + `payload.event.localDate`（`protocol.js:308-309` 已校验）派生 `userId|localDate|questionKey` 写 `business_dedupe_key`，部分唯一索引兜底；Reducer 保留防御去重。
8. **Cron 共存**：`scheduled()` 中 V1 reconciler 先执行（代码与行为不变），随后 V2 恢复器在 try/catch 内运行并自带预算；`RDS2_RECOVERY_ENABLED=false` 时 V2 分支整体跳过，V1 逐字节不变。
9. **发布十步**（规格 §19.2）：本地测试 → 暗部署 → 合成用户 → 合成 canary → 单客户端 MCP 切换 → 真实 algorithm canary → 其他域 → Skill/插件 → 一周观察 → 二次确认关 V1。
10. **V2 namespace 值**：一律 `algorithm`；`algorithm-learning` 仅作 Skill 目录名与展示标签。

## 前置门 G0：工作区状态确认与残留处理（每个子计划开工前执行一次）

- [ ] G0.1 `cd C:\Users\27846\my-chatgpt-mcp-v2 && git status --short`，逐行记录输出。
- [ ] G0.2 分类：**本计划此前任务产生的残留**（如 dry-run 输出目录 `services/reliable-drive-sync-worker/tmp/`）→ 列出后请用户确认，经确认后 `git clean -n` 预演、再逐路径删除；**用户文件**（`docs/project-learning/`、`.playwright-cli/`、任何其他未跟踪内容）→ 不删除、不提交、不移动，原样保留并写入当次任务报告。
- [ ] G0.3 `git log --oneline -3` 确认 HEAD 在预期提交上；`npm test` 确认 380+47 全绿后再开始第一个 Task。
- 禁止：`git clean -f` 直接执行、`git reset --hard`、删除任何非本计划产物。

## 自检与回报（Rev 3 完成时已执行，结果见文末“十、自检记录”对应章节）

覆盖矩阵、占位符扫描、命名一致性、全入口预算证明、Queue 无 message-ID 依赖、DLQ 消费者、readAfter 范围、凭据身份、非单调状态、规格-计划发布顺序一致——十项自检的执行方式与通过标准分散在各子计划最后一个 Task，主索引在此声明其存在并要求全部通过后方可回报完成。
