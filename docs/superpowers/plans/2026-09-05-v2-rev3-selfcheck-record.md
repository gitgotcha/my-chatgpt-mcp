# RDS V2 Revision 3 自检记录（Self-Check Record）

**Status:** Rev 3 交付自检，随提交链提交，供 Codex 三审引用
**Date:** 2026-09-05
**计划主索引:** `docs/superpowers/plans/2026-09-05-v2-rev3-implementation-plan-index.md`（注册表 + 全局冻结决策 + G0 门）
**上位规格:** `docs/superpowers/specs/2026-09-05-reliable-drive-sync-v2-requirements-and-architecture.md`（Rev 3）
**权限边界:** 本记录为文档-only 产物；不含代码变更。

---

## 1. 十项自检结果（对应 Rev 3 任务书十节）

| # | 自检项 | 结论 | 证据位置 |
|---|--------|------|----------|
| 1 | Queue/DLQ 修复（taskId 关联、删 message_id 业务依赖、重复发布合法、四队列消费者） | ✅ 通过 | 规格 §13 Rev 3；子计划 2 Task 2.1–2.5；完成门 grep `queue_message_id` 仅命中列定义与建表 SQL（subplan-2 §完成门）；四队列 TOML 在 Task 2.4 逐行给出且两个 DLQ 均配消费者 |
| 2 | 40 子请求预算模型重建（单预算器、七入口上限表、真实 Drive 成本、自适应缩批） | ✅ 通过 | 规格 §15 Rev 3；子计划 3 Task 3.2（SubrequestBudget + budgetD1/budgetQueue 封装）、Task 3.4（单组 36≤40）、Task 3.5（多组自适应）、Task 3.6（七入口最坏证明，含 ingress/query/init/project/archive/dlq/recovery 全部） |
| 3 | D1 原子事务与游标（CAS 失败整事务失败、readAfter 带 userId/namespace、accept-service 真实 SQL、Outbox CHECK） | ✅ 通过 | 规格 §7.2/§12 Rev 3；子计划 1 Task 1.6（迁移 0006：Outbox 双 CHECK + `trg_rds2_projection_cas` 触发器）、Task 1.10（readAfter `(user_id, namespace, event_seq)` 索引）、Task 1.12（触发器 CAS 写入）、Task 1.14（双语句 batch + 唯一约束失败重查三 ID） |
| 4 | 严格身份边界（凭据映射派生 userId，非请求字段匹配） | ✅ 通过 | 规格 §17 Rev 3（`rds2_credentials(credential_hash, user_id)`）；子计划 1 Task 1.9（credential-repository 与凭据鉴权）、Task 1.16（identity-init 服务逻辑）；请求体 identity 仅一致性核对于 Task 1.14 断言 |
| 5 | submit_event 读写分流契约（READ_ONLY_EVENTS 五类读 + dry-run legacy-migration 不写 Outbox） | ✅ 通过 | 规格 §11 Rev 3；子计划 4 Task 4.2（`READ_ONLY_EVENT_TYPES` 新模块 + V1 黑盒 parity）、Task 4.5（Bridge 五类读 + 写路径集成测试） |
| 6 | 逐域 Reducer 修正（以真实源码为准） | ✅ 通过 | 子计划 2 Task 2.9（algorithm：真实规则、无 correction）、Task 2.10（generic-profile supersede/invalidate）、Task 2.11（interview reviewVersion 替换）、Task 2.12（resume 防御性同日去重 + 部分唯一索引，派生自 §7.2 business_dedupe_key）、Task 2.13（四域 fold/增量等价完成门，修复按域独立 commit） |
| 7 | V1/V2 Cron 共存（V1 表达式逐字节保留先行、V2 try/catch+finally、恢复器预留 15 额度） | ✅ 通过 | 规格 §16 Rev 3；子计划 2 Task 2.3（cron 共存 diff + `createRecoveryBudget` 上限 15 内联桩并注明来源）、Global Constraints 明示 V1 `scheduled()` 逻辑不触碰 |
| 8 | 规格与十步发布顺序统一（§19.2 十步、每步进入/退出/回滚） | ✅ 通过 | 规格 §19.2 Rev 3 与子计划 4 Task 4.9 runbook 表逐行对应；Task 4.10 补本地可执行回滚演练 |
| 9 | execution-ready 格式改造 | ✅ 通过 | 四子计划均含固定 agentic-workers 头部、checkbox 步骤、精确 git add/commit 命令；占位符自检扫描（`<…>`、"同上"、"必要修复"、"TBD"）在 Rev 3 自检轮清零（8 处全部替换为具体枚举）；本轮一致性核查再修复 5 处跨子计划任务编号错配 + 1 处排序依赖说明（见 §3） |
| 10 | 自检与回报 | ✅ 本记录即产物 | 覆盖矩阵见 §2；提交链与回滚见 §4 |

## 2. 覆盖矩阵

### 2.1 规格 §20 十个工作包 → 计划任务

| 工作包 | 覆盖任务 | 备注 |
|--------|----------|------|
| 1. 基线保护与契约层 | 夜间执行已完成（六热修 `e58eabc`、Node v26 测试修复 `22ee4d2`、绿基线 tag `v2-baseline-green`）+ 子计划 1 Task 1.1–1.3（共享协议、envelope 校验器 V1 parity、resolveIntent） | 契约层覆盖完整 |
| 2. D1 V2 数据底座 | 子计划 1 Task 1.5–1.15（business_dedupe_key、迁移 0006、SQLite 适配器、六个 repository、accept-service、Miniflare 真集成） | 冲突矩阵测试在 Task 1.14（三 ID 竞态重查） |
| 3. V2 接口与本地 MCP | 子计划 1 Task 1.4/1.16（durable receipt、identity-init 逻辑）+ 子计划 4 Task 4.1–4.6（环境分流、读写分流、LocalOutboxV2、DeliveryServiceV2、Bridge 完成门、三路由接线 + canary 白名单） | 路由接线集中在 Task 4.6，避免子计划 1 前向依赖 |
| 4. D1 Outbox 与 Cloudflare Queue | 子计划 2 Task 2.1–2.5（queue-io、dispatcher、有界恢复器、四队列 TOML、DLQ 消费者） | 队列/租约/恢复器/状态查询齐备 |
| 5. 增量投影框架 | 子计划 2 Task 2.6–2.9 + Task 2.13（引擎 CAS、投影消费者、fold-all Oracle、algorithm Reducer、等价套件）+ 子计划 4 Task 4.6（algorithm namespace canary 白名单） | |
| 6. 其余领域 Reducer | 子计划 2 Task 2.10–2.13（generic-profile、interview、resume-knowledge + 四域等价完成门） | 逐域独立提交 |
| 7. Drive V2 归档 | 子计划 3 Task 3.1/3.3（七原语抽取、归档器分组认领/动态缩批/幂等上传）+ Task 1.13（archive-delivery-repository 确定性 ID） | |
| 8. 40 子请求预算与可观测性 | 子计划 3 Task 3.2/3.4–3.7（预算器、单组/多组/七入口证明、指标导出与日志脱敏） | |
| 9. Skill/插件契约升级 | 子计划 4 Task 4.8（五 SKILL.md 盘点 + 文案修订，仓库 `my-chatgpt-skills`）+ Task 4.9（插件重装流程） | 双仓库契约均有任务 |
| 10. 端到端验证与发布 | 子计划 4 Task 4.7（混沌与故障恢复套件）、Task 4.9（十步发布 runbook：暗部署/canary/观测/回滚）、Task 4.10（回滚演练） | 生产步骤全部停留在 runbook 文档，未预执行 |

### 2.2 规格 §21 验收标准 → 计划任务

| 验收条款 | 覆盖任务 |
|----------|----------|
| 21.1 幂等重试同一 receipt | Task 1.14（原子接收 + 竞态重查同 receipt） |
| 21.1 三 ID 冲突确定响应、永久冲突不无限重试 | Task 1.14、Task 4.4（blocked 永久阻塞 + 有限退避） |
| 21.1 事件+初始任务原子提交 | Task 1.14（双语句 batch）、Task 1.6（Outbox CHECK 强制配对） |
| 21.1 Queue 重复/乱序/丢消息/崩溃无副作用 | Task 2.2（重复发布合法）、Task 2.6/2.7（投影只推进一次）、Task 3.3（归档幂等）、Task 4.7（混沌套件） |
| 21.1 fold/增量逐字段等价 | Task 2.8（Oracle）、Task 2.13（四域等价套件） |
| 21.1 在线读取只访问 D1 投影 | Task 4.6（/v2/query 只读投影） |
| 21.1 Drive 归档全路径（成功/重试/响应丢失/同名异内容阻断/DLQ） | Task 3.3、Task 1.13、Task 2.5 |
| 21.2 40 子请求单预算器全类别 | Task 3.2/3.6（含 D1/Queue/Drive/redirect/fetch_other） |
| 21.2 提交成本不随历史增长 | Task 1.14（O(1) 接收）、Task 1.10（游标索引） |
| 21.2 投影每批 10、归档动态上限 8 | Task 2.6（batch 上限常量）、Task 3.3/3.5（动态缩批） |
| 21.2 无 `LIMIT 100 + Promise.all` | Task 2.3（重写恢复器）+ 完成门 grep 断言（subplan-2 §完成门） |
| 21.3 V1 表/Drive 根目录不变、不迁移 V1 历史 | 主索引全局冻结决策第 3/4 条；规格 §19 |
| 21.3 写事件先身份+业务校验 | Task 1.9/1.14/1.16 |
| 21.3 日志脱敏 | Task 3.7 |
| 21.3 三状态严格区分 | Task 1.4（durable receipt）、Task 4.8（Skill 文案） |
| 21.4 五层测试通过 | 各子计划完成门 + Task 4.5/4.7 |
| 21.4 Node v26 warning 断言替换 | 已完成（`22ee4d2`，行为断言替代） |
| 21.4 可重复最坏预算测试 + 合成 canary | Task 3.4/3.6、Task 4.6（canary 白名单） |
| 21.4 Miniflare 真 D1 验证五项（migration/batch 回滚/原子接收/CAS 并发/持久化） | Task 1.15 |
| 21.4 每阶段进入/退出/监控/回滚 | Task 4.9 runbook 表 |
| 21.4 关 V1/QStash 前 canary 通过 | 规格 §19.2 第 9–10 步 + Task 4.9（发布门，未预执行） |

### 2.3 规格 §22 Codex 检查清单 → 计划任务

| # | 检查项 | 覆盖位置 |
|---|--------|----------|
| 1 | 五表完整 + Outbox CHECK + business_dedupe_key | Task 1.5/1.6；规格 §7.2 Rev 3 |
| 2 | Queue=唤醒器、消息体 `{taskId, taskType, attempt}`、不依赖 message ID | Task 2.1；规格 §13 Rev 3 |
| 3 | 允许重复发布 + "发布成功但回写失败后重复发布"测试 | Task 2.2 |
| 4 | 四队列全部配置消费者 | Task 2.4（TOML 两主 + 两 DLQ 消费者） |
| 5 | 三 ID 相同重试与冲突测试 | Task 1.14（竞态重查三 ID） |
| 6 | 在线快照全部来自 D1 增量投影 | Task 4.6（/v2/query） |
| 7 | 无 Drive 全历史扫描路径 | Task 1.10（游标读取）/Task 4.2（读分流）；完成门无扫描断言 |
| 8 | 七入口最坏 40 证明（含 query/init/DLQ/恢复器），统计覆盖五类 | Task 3.6；预算类别枚举在 Task 3.2 |
| 9 | 游标 CAS 用触发器使 batch 整体失败 | Task 1.6（`trg_rds2_projection_cas`）、Task 1.12 |
| 10 | readAfter 携带 userId/namespace | Task 1.10 |
| 11 | 身份为凭据映射派生 | Task 1.9/1.16；规格 §17 Rev 3 |
| 12 | 六个 V1 热修文件已保存 | 已完成（`e58eabc`，+205/−11） |
| 13 | 不迁移/覆盖/删除 V1 数据 | 主索引全局冻结决策；规格 §19 |
| 14 | 每域 Reducer fold+增量等价、不变量、state_json 撤销 | Task 2.8–2.13 |
| 15 | 严格区分 D1 接收/投影完成/Drive 归档完成 | Task 1.4、Task 2.7、Task 3.3、Task 4.8 |
| 16 | 暗部署/canary/观测/DLQ/人工恢复/回滚 + §19.2 十步一致 | Task 4.9/4.10 |
| 17 | 双仓库契约更新（`my-chatgpt-mcp` + `my-chatgpt-skills`） | Task 4.8（skills 仓库显式路径）、Task 4.1–4.5（MCP 仓库） |
| 18 | V1/V2 cron 共存（顺序/预算/隔离/关闭时 V1 逐字节不变） | Task 2.3/2.4；Global Constraints（V1 `scheduled()` 不触碰） |

## 3. 本轮一致性核查修复记录

本轮（Rev 3 交付后收尾核查）修复的问题，全部为文档内引用错误，不涉及设计变更：

1. 子计划 2 L30、L169："子计划 3 Task 3.3" → **Task 3.2**（公共预算器实际定义于 Task 3.2「SubrequestBudget 定稿与预算化 D1/Queue 封装」；Task 3.3 是 Drive 归档器）。
2. 子计划 2 L17："按 Task 2.5 的明确 diff" → **Task 2.3**（`scheduled()` 共存 diff 实际在「*/5 cron 共存与有界恢复器」）。
3. 子计划 2 L253："Task 2.6/2.7/2.9 替换为真实现" → **Task 2.5/2.7**（`buildProcessors` 四键中两 DLQ 键在 Task 2.5 替换、投影键在 Task 2.7 替换；Task 2.6 是引擎本身、Task 2.9 是 Reducer，不直接替换 processor 映射）。
4. 子计划 2 L556（完成门）："预算断言在子计划 3 Task 3.7 汇总复验" → **Task 3.6**（七入口最坏证明在 Task 3.6；Task 3.7 是指标导出）。
5. 子计划 2 Task 2.6 头部：新增**排序说明**——引擎测试在 Task 2.8（reducer registry）就位前用测试文件内联桩 Reducer 驱动，Task 2.7 接线改用真实 registry，Task 2.6 代码零改动（`deps` 注入即契约），消除 T2.6 → T2.8 的前向排序疑义。

## 4. 提交链与回滚

- 分支 `feat-generic-profile-runtime`（worktree `C:\Users\27846\my-chatgpt-mcp-v2`，分支 `feat/rds2-v2`）：
  - `e58eabc` V1 六热修；`22ee4d2` Node v26 测试修复；`53ced1e` 绿基线（tag `v2-baseline-green`）；`4524f8c` 规格 Rev 3；`f0590d4` 计划 Rev 3 全套（6 files，+2214/−31）
  - 本记录 + 本轮引用修复：单独 commit（见本提交的 SHA），随后 ff 同步 worktree 分支
- 回滚：`git revert <对应 SHA>`（逐文档提交独立可回退）；基线回退锚点为 tag `v2-baseline-green`。

## 5. 残留事项（不阻塞三审，均已在规格 §23 声明）

1. `docs/project-learning/` 是否入库 — 等用户决定。
2. 讲义模块 5–10 是否继续 — 等用户决定。
3. 乔的 V2 userId 复用或新分配 — 等用户决定（不阻塞：Task 1.16 支持任选）。
4. `RDS2_DRIVE_ROOT_FOLDER_ID` 注入方式 — 等用户决定（Task 4.6 白名单配置占位，注入动作属远程操作，未预执行）。
5. Cloudflare Queues 免费配额确认 — 属外部账务事实，Task 2.4 dry-run 已验证 TOML 语法，配额在生产发布门（§19.2 第 4 步）前确认。
