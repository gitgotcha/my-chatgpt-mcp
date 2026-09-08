# T11 Parity Evidence：V1 通用画像 → V2 行模型逐项映射

状态：**T11 本地实现已交付，本文档作为 parity 基线与审计记录**。实现复用
V1 源模型（`src/generic-profile-model.js`）作为 Oracle，并在 V2 投影引擎中提供
可续页的 `buildPage`。任何实现与本文件的语义偏差都是缺陷；真实远程运行时与
大规模状态上界仍由 T14/T16 验收。

## 1. 源模型（V1）字段清单

输入事件（经 `validateGenericProfileEvent` 校验后）：

| 字段 | 类型/约束 | 用途 |
|---|---|---|
| `eventId` / `eventKey` | UUID / 非空字符串 | 身份与幂等键（eventKey 内容冲突 → `event_key_conflict`） |
| `identity` | `{userId: UUID, username}` | 绑定身份 |
| `domain` | 合法域 | 域隔离 |
| `observedAt` | ISO 时间 | 排序第一键；纠正的时间约束 |
| `action` | `observe` / `supersede` / `invalidate` | 动作 |
| `targetEventKey` | 非空（纠正类） | 指向更早事件；自指 → `invalid_profile_event` |
| `observations[]` | `{dimensionKey, subjectKey, outcome, confidence, sourceRef}` | 观察条目（evidence 载体） |

outcome 分类：正向 `{completed, correct, passed}`、负向 `{stuck, incorrect, failed}`、
中性 `{observed, consulted}`、`partial` 单列。

## 2. 行模型（V2，migration 0007 + `generic-profile.js`）

四类行，全部落在 `rds2_projection_rows`（scope + `staging_generation`/`active_generation`）：

| row_kind | row_key | member_key | 内容（value_json） |
|---|---|---|---|
| `event_activity` | `{eventKey}` | 空事件键（行级） | `{eventId, observedAt, action, supersededBy?, invalidatedBy?}` — 事件的活跃性账本 |
| `observation` | `{eventKey}#{index}` | `member_key` = `{dimensionKey}\u0000{subjectKey}` | 单条观察（outcome/confidence/sourceRef）— **evidence 逐行保存，不是 JSON 数组** |
| `source_signal` | `{member_key}#{sourceRef}` | `member_key` | 该 (维度,主体,来源) 的最新正向 `observedAt` 与计数 — 「最近负向以来的不同正向来源」的可增量载体 |
| `member` | `{member_key}` | `member_key` | `{memberKey, events, projected}`；`projected` 为 V1 Oracle 对该成员历史的结果 |

键展开规则：`member_key = dimensionKey + "\u0000" + subjectKey`（与 V1 分组键逐字节一致）。

## 3. 排序规则（不变量）

1. 事件处理顺序：`observedAt` → `eventKey` → `eventId`（`compareStable`，与 V1 逐字节一致）。
   V2 分页按 `event_seq`（接收序）扫描，但页内先按 `compareStable` 排序后应用；
   如果跨页迟到事件会改变已处理纠正关系，必须启动固定 `target_event_seq` 的完整 scope 分页重算，
   直到结果与 V1 全量 Oracle 一致。
2. 行页内序：`(sort_key, row_key)` 双键；`sort_key` = 该成员的最新 `observedAt`。
3. 输出组内排序：`dimensionKey` → `subjectKey`（`sortMembers`）。

## 4. 撤销规则（与 V1 逐条对照）

| V1 规则 | V2 实现 |
|---|---|
| 纠正目标必须已存在（`target_event_not_found`） | `event_activity` 行存在且可读，否则同码 |
| 目标 `observedAt` 必须严格早于纠正事件（否则 `invalid_profile_event`） | 同 |
| 自指（`targetEventKey === eventKey`）→ `invalid_profile_event` | 同 |
| 目标已失活 → `target_event_inactive` | 读目标 `event_activity` 行的 `invalidatedBy/supersededBy` |
| `invalidate` 不进入活跃集 | `event_activity.action='invalidate'` 不产生 observation 行 |
| `supersede` 使目标失活但自身活跃 | 目标行写 `supersededBy`；supersede 自身照常观察 |
| 撤销不可撤销（无恢复路径） | 同（V1 无此语义，不新增） |

纠正关系只允许指向**同页或更早页**已处理的事件（时间严格递增保证）；
跨页目标通过 staged read 读取其 `event_activity` 行。

## 5. Oracle 对照（V1 `rebuildGenericProfile` 输出 ↔ V2 行读取）

| # | V1 输出 | V2 对应 | 对齐方式 |
|---|---|---|---|
| 1 | `openWeaknesses / improvingSignals / stableStrengths / observations` | `member` 行的 `bucket` 字段 | 分类算法逐条对照（见下） |
| 2 | `member.latestOutcome/latestObservedAt/confidence` | member 行同名字段 = 组内最新 observation | 最新 = `(observedAt,eventKey,eventId)` 最大 |
| 3 | `positiveEvidenceCount/negativeEvidenceCount/partialEvidenceCount` | member 行计数 = 全组 observation 行扫描 | 重建期逐行累加 |
| 4 | `evidenceRefs`（去重 eventKeys 排序） | observation 行（evidence 逐行）按 eventKey 去重排序 | 读侧聚合 |
| 5 | `sourceRefs`（去重排序） | `source_signal` 行集合 | 读侧聚合 |
| 6 | `distinctPositiveSources ≥ 2`（最近负向后） | `source_signal` 中 `lastPositiveAt > lastNegativeAt` 的来源数 | 负向写 `lastNegativeAt` 清零语义 |
| 7 | `sourceEventKeys`（去重排序） | `event_activity` 行全集 | 读侧聚合 |
| 8 | `headEventId/generatedAt`（最后去重事件） | 构建激活 summary（V2 头） | 头部承载，与 F1 契约一致 |
| 9 | 乱序结果 | 页内 `compareStable`；跨页影响历史关系时固定目标的完整 scope 重算 | 同页乱序必须与 V1 一致；跨页迟到事件不得固化为“到达序语义”，必须在新 generation 完成后与 V1 Oracle 对齐 |

分类判定（与 V1 158-168 行逐条一致）：
`distinctPositiveSources ≥ 2 且 latest 非负 → strengths`；`latest 负向 → weaknesses`；
`latest partial → 有负向 ? improving : observations`；`latest 正向 → 有负向 ? weaknesses : observations`；
其余 → `有负向 ? weaknesses : observations`。

## 6. 当前实现边界

`buildPage` 已将 observation、source_signal、event_activity 与 member 变化写入
staging，并能通过 `expandPageReads` 读取跨页纠正影响的成员。为保持 V1 语义，
member 行当前仍携带该成员的事件历史，summary 仍保留去重后的 sourceEventKeys；
这两个载体在极长历史下可能增长，不能把它们描述成已证明的 O(1) 状态。T14 的
入口/规模门必须继续测量并在超过行大小或预算时稳定停车，后续可再引入按成员的
分段历史行，但不能静默截断。

## 7. 迁移 0007

`rds2_projection_rows` 已含 `member_key` 列（0006）；0007 仅增量添加索引：
`(user_id, namespace, projection_name, generation, row_kind, member_key, sort_key, row_key)`
—— 满足规格中的索引页查询（scope + member_key + 排序键 + LIMIT 50）。

## 8. 拒绝与错误（全部稳定码，不得静默吞错）

`invalid_identity` / `invalid_domain` / `event_key_conflict` / `invalid_profile_event` /
`target_event_not_found` / `target_event_inactive` — 与 V1 同码同语义。
纠正依赖尚未到达的目标时：事件标 `semantic_rejected`（审计保留），其余 scope 继续。
