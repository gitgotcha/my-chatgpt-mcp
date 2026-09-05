# RDS V2 Revision 6 — 剩余开发设计补充

日期：2026-09-05  
依据：本地 `feat/rds2-v2`，提交 `48fa65e64a24c88dcaef0e5fb85851fe9961a508`。  
状态：**设计交付，未实施、未部署；本补充中的架构调整应作为下一轮实施审核的明确输入。**

## 1. 文档效力与范围

本补充配合 `2026-09-05-reliable-drive-sync-v2-requirements-and-architecture.md` 阅读。
下述条款明确替代 Rev 5 相应设计；没有覆盖的业务行为仍以现有纯业务模型和既有合法事件契约为依据。
不得将 Rev 3、4、5 的代码片段混合复制作为实现。
开发任务以同目录上级 plans 下的 `2026-09-05-rds-v2-remaining-development-plan-rev6.md` 为顺序。

本轮只新增文档，不替执行者提交代码，不清理主仓库残留，不推进远程迁移。
初始开发交付为算法域完整闭环。其余三个领域逐域通过等价性门后启用，不以“文件已创建”代替业务完成。

## 2. 明确改变的设计

| Rev 5 设计 | Rev 6 决策 | 原因 |
|---|---|---|
| ingress 成本 7、预算 10 | ingress 包括失败分支，业务配额 20；不在请求内派发 Queue | 已有成本遗漏鉴权、校验、重查和派发 |
| 投影批次 10、归档批次 8 | 四队列 max_batch_size=1；一次投影处理一个事件或一页重算，一次归档处理一个对象 | 先证明调用上界，再由独立调用并发提高吞吐 |
| 每次提交后即时调用 dispatcher | 接收事务只写事件和任务，独立恢复器派发 | 减少接收后的半成功分支；初版接受最多约 5 分钟的调度等待，不承诺实时 |
| 六张表是硬限制 | 保留六类核心职责，允许独立的投影明细、重算进度、请求回执表 | 表数不是业务目标，避免用巨型 JSON 代替必要的数据模型 |
| 数组超过容量后 needs_attention | 历史分行保存；大结果分页；复杂重算可续作 | 不能因用户正常积累历史而永久停止学习 |
| 每事件生成完整大快照 | 每事件归档原始事件；每投影提交归档有界投影变更包 | 不在热路径汇集全部历史；变更包不能冒称独立完整快照 |
| Worker 返回 localOutbox acknowledged | Worker 只证明 D1 持久化；本机事务确认后才能增加本机 acknowledged | 云端无法证明本机 SQLite 写入成功 |
| 归档 task/delivery 双表各自认领 | 租约只以 task 为权威；delivery 仅保存对象及归档结果 | 消除双份租约漂移与恢复缺口 |
| 对同规范化展示名直接判身份冲突 | 名称规范化用于一致性检查，不是授权依据 | 凭据授权；管理员初始化时双向校验显式 ID |

**R2：本版不启用。** 它不能解决幂等、租约、游标或预算问题。未来替换归档存储时只替换归档适配器，不改变接收/投影协议。

## 3. 固定边界与版本

- 业务 envelope 保留 schemaVersion="1.2"，不要和存储版本混淆。
- 数据库、查询响应、投影变更包均显式带 storageVersion=2；变更包 kind="projection_delta"，不是 snapshot。
- 身份来自服务端验证后的 credential → userId；正文中的 userId、username 只能一致性核对。
- V2 用户 ID 按现有契约使用 UUID；qiaobingyuan 是可读名称，禁止偷换为 UUID 字段值。
- 所有数据查询同时绑定 userId、namespace、projectionName；profile 的 projectionName 必须包含经校验的 domain。
- V2 的 system.user-registered 仅管理员初始化入口承接；普通 /v2/events 返回 unsupported_write_type。
- system.legacy-migration-requested 在 V2 明确返回 migration_disabled；禁止偷偷转为普通学习事件。
- V1 模式原路径与验证行为保持不变；切换 V2 不得自动将未确认的 V1 pending 转换。
- 时间保存 UTC；业务自然日使用事件契约中校验过的 localDate，默认学习时区 Asia/Shanghai。重试不得重新生成日期。

## 4. 请求、事件与第一次结果

三个标识分工：
1. requestId：一次提交意图，重试保持不变。
2. eventId：一条不可变业务事件，重试保持不变。
3. eventKey：业务幂等键，不能因网络重试重算。

按 canonical JSON 对业务内容计算 contentHash（不含传输 requestId）；另存 envelopeHash 用于同 requestId 的严格重放核对。
canonical JSON 递归按键排序、数组保序，拒绝不可表示 JSON 值；使用 UTF-8 与 Web Crypto SHA-256。

| 已存在的键 | 内容 | 结果 |
|---|---|---|
| requestId | envelopeHash 相同 | 原 receipt，不创建事件/任务 |
| requestId | 不同 | request_id_conflict，409 |
| eventId | contentHash 相同 | 建立当前 requestId → 原事件的回执映射，返回 already_recorded |
| eventId | 不同 | event_id_conflict，409 |
| eventKey | contentHash 相同 | 建立请求别名，返回 already_recorded |
| eventKey | 不同 | event_key_conflict，409 |
| 同日首评 businessKey | 任意新评分 | already_recorded，保留首次事件和首次结果，明确 ignoredDuplicate=true |
| 所有键不存在 | 合法 | 原子写入事件、请求回执、投影任务、原事件归档任务 |

若多个键命中不同事件，优先返回 identity_of_intent_conflict，不任选一行。
同日首评分支只用于明确配置的事件类型（初版 resume-knowledge.answer-scored）；不得全局冻结所有领域的同日事件。
第一次由服务端首次成功提交定义，不由客户端最早时间戳定义。
预查与唯一约束竞态后的重查调用同一个纯决策函数；重查最多一次，仍无法稳定判断则返回可重试错误。
alias receipt 必须同时带 attemptedRequestId、canonicalRequestId、eventId、jobId，禁止把另一个请求的回执伪装为当前请求。

## 5. 查询协议

POST /v2/query 使用独立 DTO：
`{storageVersion:2, operation, params}`，三个顶层字段固定，不接收写事件。
所有 operation 都鉴权，params 额外字段一律拒绝：

| operation | params | 结果 |
|---|---|---|
| capabilities | {} | 当前启用域与读写能力 |
| user.resolve | {displayName} | 只能解析当前凭据绑定用户，名称不符拒绝 |
| projection.read | {namespace,projectionName,limit?,cursor?} | 摘要、分页条目、revision、nextCursor |
| interview.session.list | {limit?,cursor?} | 当前用户会话摘要页 |
| interview.session.load | {sessionId} | 当前用户单会话，响应超限则分段协议拒绝而非截断 |
| event.status | {targetRequestId} 或 {targetEventId} | 两字段严格恰一；接收/投影/归档独立状态 |

limit 默认 20、最大 50，响应体上限 256 KiB。分页游标签名绑定用户、操作、作用域、排序键与 revision。
同一分页会话中 revision 改变则返回 projection_changed，要求从第一页重读，不混合版本。
V1 的五类只读消息在 Bridge 显式映射到这些操作；event.status 是 V2 查询能力，不新增一个伪造的 V1 事件类型。
无 Outbox、无隐式注册、无“读触发归档”。profile.snapshot.read 映射到带 domain 的 projection.read。

## 6. 逻辑存储契约

本表是迁移必须覆盖的键、用途和约束，不是假称已经存在的 SQL 文件。
迁移任务须产出完整 DDL，并在真实 D1 运行时证明事务语义后才能继续业务任务。

| 表 | 主键/关键唯一索引 | 用途与不可破坏条件 |
|---|---|---|
| rds2_users | user_id；UNIQUE name_key | display_name、状态；初始化检查 ID→名称与名称→ID |
| rds2_credentials | credential_hash | user_id、status；不保存明文凭据 |
| rds2_requests | (user_id,request_id) | envelope_hash、canonical_event_id、冻结 receipt |
| rds2_events | event_seq 整数；(user_id,event_id)、(user_id,namespace,event_key) 唯一 | 不可变 envelope/content_hash/scope；business_key 非空时部分唯一 |
| rds2_tasks | task_id | type、scope、event_seq/artifact_id、状态、available_at、attempt、lease_owner、lease_until、lease_epoch |
| rds2_projections | (user_id,namespace,projection_name) | revision、last_event_seq、active_generation、有限摘要、building 状态 |
| rds2_projection_rows | (scope,generation,row_kind,row_key) | 规范化条目、可索引排序字段、有界 JSON；历史证据逐行而非 JSON 数组 |
| rds2_projection_builds | build_id；每 scope 最多一个运行中 build | base_revision、target_event_seq、stage、continuation、staging_generation |
| rds2_archive_deliveries | artifact_id | scope、对象类型、冻结字节、hash、drive_file_id、delivered_at；不保存第二份租约 |
| rds2_commit_guards | guard_id | 事务内临时断言行，触发器验证 task owner/epoch/租期与 projection revision；同一 batch 末尾删除，禁止事务外插入 |

scope 在 DDL 中展开为三个独立列，不用容易碰撞的字符串拼接。
索引至少覆盖 events(scope,event_seq)、tasks(state,available_at,task_id)、tasks(scope,type,event_seq)、rows(scope,generation,row_kind,sort_key,row_key)。
每个 JSON 单元上限 64 KiB，入站 envelope 上限 256 KiB；超过单事件的有限输入上限在接收前拒绝。
有限输入不等于有限历史：不得使用“历史超过 5000 条停服”的规则。
原始事件归档与投影变更包归档是两类任务，event.status 区分两者完成度。

## 7. 投影的原子提交与长任务

普通投影事务一次处理作用域内最小未处理 event_seq，不假定全局 event_seq 连续。
请求已入库与业务已应用分开：accepted 只证明前者。

单步：
1. 条件认领 task，获得 owner 与递增 lease_epoch。
2. 读取当前投影头与一个事件；按领域规则读取有界明细。
3. 在本地计算 row changes、摘要、delta 字节与 hash。
4. 同一 D1 batch 验证 lease_epoch/base_revision/last_event_seq，写 rows、推进头、冻结 delta、创建归档 task、完成当前 task。
5. 冲突通过事务级 ABORT 整批回滚；严禁第一条 UPDATE 影响 0 行后仍执行后续副作用。
6. Queue ack 只在提交成功或查证权威 task 已完成后发生。

算法普通新增事件不重放全部历史。计数累加，latest 字段按 (observedAt,eventId) 比较，迟到事件不能覆盖较新结果。
通用画像撤销、面试改评和影响有序累计的迟到评分可能需要重算：
- 记录 build 的 target_event_seq，分页扫描受影响范围，每次最多 50 行且输出变更不超过单元/请求预算。
- 分页累加写 staging_generation，保存 continuation 后结束 invocation。
- 最终校验 base_revision 并原子切换 active_generation；构建中仍提供旧的完整有效版本及 building=true。
- 新到事件留在任务表排队；不得跳过事件却把 last_event_seq 推过它。
- 清理旧 generation 是独立分页维护任务，不在发布事务内循环删除全部历史。
- 后续页依靠 D1 task + 恢复器再次唤醒；不在一次调用内 while 扫完。

复杂领域的 SQL 聚合、排序与有限中间态必须通过领域验收门。不能把分页取回后在内存拼成全历史当作达标。
高可用不是永不延迟：重算可能延迟当前画像，但不能丢事件或暴露半成品。

## 8. Queue 与恢复

四队列分别为 projection、archive 及对应 DLQ；全部 max_batch_size=1。
消费者若实际收到多条消息，只处理第一条，其余 retry，不共用无界循环。
一个 task 有唯一权威租约。状态：pending → dispatching → queued → processing → completed。
dispatching/queued 可被消费者条件认领，以处理“Queue 已发送但状态未回写”的竞态。
迟到 markQueued 只能更新仍属于当前 dispatcher 的 dispatching，不能覆盖 processing/completed。
pending 必须 available_at<=now；processing 必须有效 owner/epoch 才能完成。
needs_attention 不自动复活；管理员重放保持事件 ID 不变、审计原因并递增任务 epoch。

恢复器独立 cron：2-57/5 * * * *。V1 原有三条 cron 不变。
每次最多处理 4 个任务，按预算余量提前停止。超时 processing/dispatching/queued 可条件回收为 pending。
任务 attempt 在一次真实派发认领时增加，仅作诊断，不因重复 Queue 消息增加。另存 failure_count，只有外部调用失败等真实故障才增加；正常续页、等待前序事件和预算主动暂缓不增加 failure_count。
暂时错误退避 30、60、120、240、480 秒，连续故障 failure_count 达到 5 转 needs_attention 并暴露告警；人工可恢复，不能静默放弃。成功处理一次后清零连续故障计数。
DLQ 只根据消息 taskId 查询 D1，不信任消息携带的用户/事件内容，不能覆盖 completed。
恢复器错误不能调用 V1 恢复器补救；V1 和 V2 数据边界不交叉。

## 9. 归档与预算

归档目录在独立管理员准备任务中逐个创建、检查与登记 folderId；运行时禁止递归 find-or-create。
目录删除/失权转可诊断状态，由管理员修复，不在归档热路径重建。
Drive 对象名由 artifactId 确定；查询必须精确限定父目录、名称、未删除状态。
无对象：上传一次，再 content-only readback；一个对象：readback；多个同名对象：needs_attention。
内容 hash 不同：停止，不覆盖。上传超时后重试先查找，不能盲传第二份。
OAuth 单 invocation 缓存。HTTP redirect 固定 manual，初版拒绝全部 3xx，不自动带凭据跨域。
同一 task 并发发送至多一个有效 owner；即使外部上传重复发生，也必须发现歧义，不能伪称外部恰好一次。

所有入口创建且仅创建一个预算器。D1 执行、Queue send、HTTP fetch 由唯一封装记账，发出之前 consume。
D1 batch 保守记一次 I/O，并另限制 SQL 语句数 32、绑定变量/扫描规模；不能用一个巨大 SQL 掩盖无限工作。
运行时没有“额外免费 10 次”给业务重试。业务总计≤40；测试必须统计完整入口，而非只算某个 service。
预算不足不再调用外部服务；任务依靠租约过期恢复，宁可暂缓，不越界。

| 入口 | 实现配额上限（需完整路径测试） | 单次工作 |
|---|---:|---|
| 写入 | 20 | 1 envelope，最多一次冲突重查，无 Queue send |
| 查询 | 12 | 1 operation、1页 |
| 管理初始化/目录准备 | 20 | 1用户或1目录步骤 |
| 投影 | 24 | 1事件或1页构建 |
| 归档 | 16 | 1冻结对象，包括OAuth/查询/上传/readback/失败收尾 |
| 恢复器 | 32 | 至多4个任务，包括释放/发送/回写 |
| 任一 DLQ | 8 | 1条消息 |

表中是强制配额，不是已经测出的成本。开发者必须提交真实调用 trace 验证成功、失败、超时、重放和竞态。
预算 guard 无法证明未经封装的代码；还必须以入口依赖封装、静态导入检查和运行时 spy 证明无旁路。

## 10. 本地与持久化文案

LocalOutbox 的 pending → sending → acknowledged/blocked 使用 SQLite 显式事务。
sending 有 owner、lease_until，启动仅恢复过期租约，不抢占另一个仍在运行的进程。
回执匹配 attemptedRequestId、身份、事件关联后，先提交本机 acknowledged，再向调用方报告本机已确认。
网络响应丢失重复提交相同 IDs；云端已接受而本机确认失败时保留本地待确认记录。
acknowledged 不立即物理删除；默认保留30天，维护器分批清理；pending/blocked 永不随清理删除。
只有纯读调用时不打开/创建 SQLite。首次写前创建父目录，flush 最多20条逐条发送，每条是独立 HTTP 请求。
等待退避不占住工具调用；MCP 存活期间定时唤醒并在退出时取消计时器，进程关闭期间不承诺扫描。

对外分别报告：
- local_retained：已落本机，云端尚未确认。
- cloud_accepted：D1 已接收，投影与Drive可能未完成。
- projected：权威投影已应用。
- drive_archived：readback 校验及 D1 完成记录成功。
- needs_attention：有可恢复问题，不说已经同步。

这些是状态语义，不要求互斥单字段替代所有维度。
