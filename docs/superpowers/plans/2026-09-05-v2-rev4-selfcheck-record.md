# Rev 4 自检记录（等待 Codex 四审）

> 本记录由 Workbuddy 于 2026-09-05 编制，对应 Codex 三审退回意见（审核对象 commit `f619405`，要求 Revision 4）。性质：**仅文档修订**，未修改任何代码、未部署、未迁移、未创建 Queue、未写入 D1/Drive、未开启任何 V2 开关。按意见十四：完成后停止，等待四审，不进入 Phase 1。

## 1. 元信息

- 工作树：`C:\Users\27846\my-chatgpt-mcp-v2`（worktree of `C:\Users\27846\my-chatgpt-mcp`），分支 `feat/rds2-v2`，基线 commit `f619405`（Rev 3 收尾提交）。
- 本轮变更：上位规格原地修订 + 5 份新文档；Revision 1–3 全部文档保留未删除。

## 2. 交付物清单（wc -l 实测）

| 文件 | 行数 | 性质 |
|---|---:|---|
| `docs/superpowers/specs/2026-09-05-reliable-drive-sync-v2-requirements-and-architecture.md` | 787 | 原地修订至 Rev 4（Rev 3 为 571 行） |
| `docs/superpowers/plans/2026-09-05-reliable-drive-sync-v2-implementation-plan-rev4.md` | 87 | 新建主索引（含逐项矩阵 + 16 验收门映射） |
| `docs/superpowers/plans/2026-09-05-v2-rev4-subplan-1-protocol-identity-d1.md` | 761 | 新建（T1.1–T1.17） |
| `docs/superpowers/plans/2026-09-05-v2-rev4-subplan-2-queue-projection-reducers.md` | 830 | 新建（T2.1–T2.15） |
| `docs/superpowers/plans/2026-09-05-v2-rev4-subplan-3-drive-budget-observability.md` | 427 | 新建重写（T3.1–T3.7） |
| `docs/superpowers/plans/2026-09-05-v2-rev4-subplan-4-local-mcp-skills-release.md` | 591 | 新建重写（T4.1–T4.11） |
| 合计 | 3483 | — |

## 3. 逐项矩阵复核结论

主索引 §4 矩阵 12 行（11 P0 + 1 P1）+ §4.1 验收门映射 16 行，全部具备"规格章节 + 任务号 + 具名测试 + 提交边界"四要素。抽查确认：

- P0-1：`T1.16 断言④ meta.changes 形状`、`budgetD1 三形态`（T3.2）与规格 §3 决策 15 对应；
- P0-4：投影五组操作落在 T2.7 最小实现代码（2N+3 条语句、`IN` 列表绑定、`INSERT OR IGNORE` 冻结），非注意事项式表述；
- P0-5：Dispatcher 六条规则逐条映射 T2.3 测试名（rule1–rule6）；规格 §13 两条必测链路对应 T2.8 链 A/链 B 具名测试；
- P0-7：38≤40 明细表逐类别断言（T3.4），证明入口为真实 `worker.queue(...)` + Miniflare D1 + `snapshotByCategory()` 合计；
- P0-9：四域最小状态结构、correction `Date.parse` 严格晚于（T2.11，修正 Rev 3 的 seq 比较）、resume bank 替换制（T2.13，修正 Rev 3 的"最低 seq"）、等价输入 eventKey 唯一（T2.15 构造器自检）；
- P0-11：接收九步逐条落在 T4.6 测试（step1 鉴权先行含 body 读取 spy、step2 双检 413、step4 username→name_key 双核对）。

## 4. 自检 grep 证据（2026-09-05 实测，worktree 执行）

**4.1 占位符**：对五份 Rev 4 文档执行 `grep -n "<本任务SHA>|<SHA>|<outdir>|TODO|TBD|同上|参考前文|必要修复"`：
- 首轮命中 10 处，其中 7 处为 Global Constraints 的 `git revert` 命令模板占位 → 已统一改写为英文惯例 `git revert <task_sha>`（非"该填未填"残留）；子计划 4 修正描述中的尖括号字面量已改为无尖括号表述。
- 复检后仅剩 1 类命中：子计划 4 T4.10 测试代码中的字符串字面量 `["<本任务SHA>", "<SHA>", "<outdir>"]`——这是验收门断言本身的检查目标，必须保留。
- Rev 4 自检记录与 runbook（文档正文）中占位符零命中（由 T4.10 测试在实现期持续锁定）。

**4.2 displayName 语义澄清**：`grep -rn displayName` 在五份文档命中 8 处，全部位于子计划 1 T1.9/T1.15 的**用户表领域字段**（`rds2_users.display_name` 注册输入参数、`normalizeNameKey(displayName)`）——与协议层 identity 无关。协议事实冻结于规格 §8："协议没有 result 字段，也不存在 identity.displayName"；`toDomainEvent`（T2.9）统一 `username` 并含 `identity_row_mismatch` 双核对；规格 §8 LeetCode 206 示例已修正为 `identity.username`。

**4.3 跨文件命名一致性**（grep -l 命中文件数）：`stale_projection_write` 4、`business_dedupe_key` 3、`snapshotByCategory` 3、`state_limit_exceeded` 2、`drive_ambiguous_name` 2、`reclaimStaleQueued` 2、`2-57/5` 2、`targetRequestId` 2、`canary_misconfigured` 1（仅子计划 4 路由层，符合职责边界）。无同名异义。

## 5. 数字一致性复核

- **归档成本模型（§15.3 冻结表）**：d1 3 + drive_oauth 1 + 目录（5 list + 5 create）10 + 对象查找 8 + 上传 8 + content-only 回读 8 = **38 ≤ 40**。Drive 原语成本以 `google-drive.js` 源码核实：`googleUpload`（multipart）= **1 次 fetch**（Rev 3 误记 3，本次修正）；`readJson` = 2 GET（V1 保留）；content-only 回读 = 1 GET（新原语 `readTextContent`，T3.1）。目录层级五级自 secret `RDS2_DRIVE_ROOT_FOLDER_ID` 起步（不解析 V2 根）。
- **恢复器预算（§15.2 = 15）**：固定 reclaim 3（`reclaimExpired` + `reclaimStaleQueued` + `listDue`）+ 批量 4 × 每任务 3（`claimOne` 1 d1 + `sendWake` 1 queue + `markQueued` 1 d1）= **15 恰好不超**。批量 4 = `floor((15 − 3) / 3)`，已在子计划 2 T2.4 实现与测试中冻结（Rev 4 编制过程中发现的账目冲突已修正——Rev 3/初稿的批量 5 会导致 18 > 15）。
- **多组缩批（T3.5）**：固定 4（d1 3 + oauth 1）+ 每冷组 13（目录 10 + 对象 3）→ 40 − 4 = 36 → 恰处理 2 组后余 10 < 13 停止，processed === 2，total ≤ 40。
- **投影事务（§12.4）**：单 batch 语句数 = 1（投影 UPDATE）+ 1（精确 taskId `IN` 完成）+ N（event delivery）+ 1（snapshot delivery）+ (N+1)（archive task）= **2N + 3**；N=10 → 23 条语句、10+1 归档对象。
- **七入口预算帽（T3.6）**：ingress 5（帽 10）、query 4（10）、init 3（10）、project consumer 8（20）、archive 38（40，引 T3.4）、dlq 2（10）、recovery 15（15）。

## 6. 边界与遗留

1. **主仓库残留（需用户授权）**：Rev 4 编制初期的规格修订与子计划 1 曾误写入主仓库 `C:\Users\27846\my-chatgpt-mcp`（分支 `feat-generic-profile-runtime`，origin 已 gone）的工作树——现内容已完整迁移至 worktree 并经 `diff -q` 校验一致。主仓库的两处残留（spec 修改 M 状态 + untracked subplan-1 文件）**保留原样未清理**，清理（`git checkout -- <spec>` + 删除 untracked 文件）需乔炳源显式授权后执行。
2. 提交仅在 worktree 本地执行（显式 `git add` 文件清单），**不 push**。
3. 完成后停止，等待 Codex 四审；不进入 Phase 1。
