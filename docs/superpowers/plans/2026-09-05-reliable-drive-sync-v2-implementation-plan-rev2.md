# Reliable Drive Sync V2 实施计划 — Revision 2

> 计划日期：2026-09-05  
> 上位规格：`docs/superpowers/specs/2026-09-05-reliable-drive-sync-v2-requirements-and-architecture.md`（已同步修订为 Rev 2）  
> 前序版本：`...-implementation-plan.md`（Rev 1，保留作审核轨迹，不再维护）  
> 审核输入：Codex 2026-09-05 审核结论（6 个阻断问题 + 修订项 + 粒度要求）  
> 当前状态：**Rev 1 未获批准。本 Revision 2 待 Codex 复审。未获批准前不得进入 Phase 1。**

---

## A. 审核意见逐条对照表

| # | Codex 意见 | 处理 | 落点 |
|---|---|---|---|
| 阻断1 | event_seq 与旧业务时间排序不等价，"完全等价 Oracle"不成立 | 采纳。等价语义改为 **V2 全量 fold（event_seq 序） vs 增量**；旧 Rebuild 降级为领域规则参照；四域各建领域不变量测试；上位规格 §12/§21.1/§22 已同步修订 | Phase 5 T5.2/T5.5、Phase 6 |
| 阻断2 | namespace `algorithm-learning` 与 Schema 1.2 白名单冲突 | 采纳。全部改为 `algorithm`（白名单：system/algorithm/interview/resume-knowledge/profile）；`algorithm-learning` 仅作 Skill/展示名；规格已修订 | 规格 Rev 2、Phase 5/6 |
| 阻断3 | envelope V2 标记不可实现（ALLOWED_ENVELOPE_FIELDS 严格白名单） | 采纳。改用进程级配置 `RELIABLE_DRIVE_SYNC_WRITE_VERSION=v1\|v2`（默认 v1），envelope 零改动，MCP 仍只有 `submit_event`，按本地客户端灰度 | Phase 3 T3.5 |
| 阻断4 | V2 身份初始化无闭环，canary 无法通过身份校验 | 采纳。新增受保护初始化入口 `POST /v2/users/init`（独立 admin token，非业务事件入口），幂等、含空投影创建、显式冲突语义、失败不自动建档 | Phase 3 T3.1、Phase 10 步骤 2 |
| 阻断5 | Queue 未接入 Worker default export；TOML 写法不可用；缺 ack/retry/DLQ/租约语义 | 采纳。default export 增加 `queue(batch, env, context)`；TOML 逐行书写；按 `batch.queue` 路由；逐消息 ack/retry 条件；DLQ 消费者 + 租约过期双通道转 `needs_attention` | Phase 4 T4.1–T4.4 |
| 阻断6 | google-drive.js 未导出 oauthAccessToken/accessToken/googleUpload/googleGet，"零修改复用"不可实现 | 采纳。改为一次**行为不变的公共原语抽取**：新建 `src/drive-http-client.js`（accessToken/uploadJson/readJson/listChildrenExact），V1 与 V2 共用，380 个现有测试证明无回归 | Phase 7 T7.1 |
| 修订a | 缺索引/外键/“每事件一个投影任务”唯一约束 | 采纳。迁移补齐：outbox 部分唯一索引 `event_seq WHERE task_type='project_event'`、`(state, available_at)` 索引、archive `(artifact_key)` 唯一（表内）、`drive_path` 索引、`REFERENCES` 关系约束 | Phase 2 T2.1 |
| 修订b | taskId 必须确定性 | 采纳。`project_event` 任务 taskId = `t_project_<event_seq>`；`archive_artifact` 任务 taskId = `t_archive_<archive_delivery_id>`；archive_delivery_id 由 `artifact_key` 的 SHA-256 前 32 hex 确定性派生 → 完全相同重试返回原 taskId | Phase 2 T2.5/T2.7 |
| 修订c | classifySubmission 太模糊 | 采纳。ingress 顺序执行三次精确查询（requestId 唯一、eventId 唯一、作用域 eventKey 组合唯一）得到意图；INSERT 撞唯一约束时（并发竞态）重查并给出稳定结果 | Phase 1 T1.3、Phase 2 T2.8 |
| 修订d | 原子性须真实 D1 事务证明 | 采纳。仓库层面向薄适配器（D1 binding 语义：prepare/bind/run/all/batch）；本地用 `node:sqlite` 实现同语义适配器（batch = BEGIN…COMMIT/ROLLBACK），测试跑真实 SQLite 文件；远程验证留待 canary 阶段（需授权） | Phase 2 T2.2/T2.9 |
| 修订e | 读取接口缺身份边界 | 采纳。`POST /v2/query`，请求体携带已验证身份，服务端核对 `rds2_users` 后仅返回该用户数据；不提供按 requestId 跨用户 GET；规格 §10.2 已修订 | Phase 3 T3.4 |
| 修订f | Drive 冷启动子请求未计预算 | 采纳。预算模型：固定开销 = 1 token + 根目录确认 1 + 用户/namespace/events/snapshots 冷目录最多 8 次查找或创建；每对象 3 次（精确查找 + 新建 + readback）；8 对象最坏 = 9 + 24 = **33 ≤ 40** | Phase 7 T7.3 |
| 修订g | 冷目录下应自适应批量而非强凑 8 个 | 采纳。每认领一个对象前检查 `remaining ≥ 冻结开销 + 3`，不足即停止扩批并释放未执行租约；8 仍是上限不是目标 | Phase 7 T7.2/T7.3 |
| 修订h | 全局开关不能支撑单域 canary | 采纳。新增 `RDS2_CANARY_NAMESPACES`（逗号分隔白名单，如 `"algorithm"`）与可选 `RDS2_CANARY_USER_IDS`；ingress 按其逐事件放行 | Phase 3 T3.2 |
| 修订i | 灰度顺序循环依赖（真实 canary 需要本地切换，但切换排在 canary 后） | 采纳。重排：暗部署 → 合成用户 canary（curl 直连，不依赖本地 MCP）→ 本地 MCP v2 切换（单客户端）→ 真实 algorithm canary → 其他域 → Skill 文案 → 观察 → 关 V1 | Phase 10 |
| 修订j | Phase 0 工作区假设过期（新增未跟踪文档） | 采纳。T0.3 将规格与计划文档入库；`docs/project-learning/` 保持未跟踪（讲义已暂停，是否入库待用户决定，见"未解决问题"） | Phase 0 T0.3 |
| 修订k | 懒加载测试不得依赖 stderr | 采纳。已实施：临时 `outbox.sqlite`——初始化后断言文件不存在，首次 submit_event 后断言文件存在且含 pending 行；stderr 警告断言全部移除 | Phase 0 T0.2（已完成） |
| 修订l | shared/ 布局可接受，但需 dry-run 门 | 采纳。Phase 1 退出条件含 `npx wrangler deploy --dry-run --outdir <tmp>`；今晚已在基线上预跑一次 | Phase 1 T1.5、Phase 0 T0.5 |
| 粒度 | 每 Phase 数天级，需拆到测试-实现-验证-提交 | 采纳。全部 Phase 拆为 T 编号任务，每任务 = 1 个失败测试 + 最小实现 + 精确验证命令 + 独立提交 + 回滚点 | 全文 |

---

## B. 本次已执行的本地安全准备（2026-09-05 夜间，均在授权范围内）

| 任务 | 内容 | 结果 |
|---|---|---|
| T0.1 ✅ | 显式 `git add` 六个 V1 热修文件并提交（未用 `add -A`，未动其他文件） | commit `e58eabc`，6 files，+205/−11 |
| T0.2 ✅ | 删除 `stdio-bridge.test.mjs:326` 的 node:sqlite 警告计数断言；新增"初始化后 Outbox 文件不存在、首次 submit_event 后存在且含 2 行 pending"行为测试（临时路径注入 `RELIABLE_DRIVE_SYNC_OUTBOX_PATH`）。红：Node 26 下 `0 !== 1` 已复现；绿：Node 22 与 Node 26 均 47/47 | commit `22ee4d2` |
| T0.3 ✅ | 规格 Rev 2（namespace 统一、fold Oracle 语义、POST /v2/query）+ 计划 Rev 1/Rev 2 入库 | 见 docs commit SHA（执行报告） |
| T0.4 ✅ | 绿色基线：Worker 380/380，Bridge 47/47（Node 22.22.2 与 26.7.0 双验证），tag `v2-baseline-green` | tag 指向 docs commit |
| T0.5 ✅ | 隔离 worktree `C:\Users\27846\my-chatgpt-mcp-v2`（分支 `feat/rds2-v2`，自基线分出）；worktree 内全量测试绿色；`npx wrangler deploy --dry-run --outdir <tmp>` 通过 | 详情见执行报告 |

**未执行（等待授权）**：远程 D1 migration、Queue/DLQ 创建、Worker 部署、Drive 写入、真实用户 canary、MCP/Skill 切换、V1/QStash 关闭、任何付费配置。详见随附执行报告《未解决问题》一节。

---

## C. 通用纪律

- **TDD**：每任务先红后绿。红 = 新测试失败且失败原因正确；绿 = 全仓测试 0 失败。
- **提交**：每任务一个 commit；消息前缀 `feat(v2):` / `test(v2):` / `chore(v2):`；禁止 `git add -A`；禁止 `reset --hard` / `checkout --` / `stash drop`。
- **每任务上报**：变更文件、新增/通过测试数、commit SHA（执行代理在任务完成时输出）。
- **halt-and-report 触发**：脏 worktree 超出当前任务预期、冲突、任何与本计划冲突的源码事实、测试数与预期不符。halt 后禁止继续下一任务。
- **受保护路径**（V2 全程不改）：`migrations/0005_schema12_jobs.sql`、V1 ingress/dispatcher/sync/event-store/qstash/reconciler、各 V1 store/model、`tools/reliable-drive-sync-mcp/local-outbox.mjs`、`delivery-service.mjs`（V1 主体）。例外：`src/index.js` 仅按 T3.8/T4.1 的明确说明追加路由与 queue handler；`src/google-drive.js` 仅按 T7.1 的原语抽取改造（行为不变，测试证明）。
- **远程红线**：`wrangler d1 migrations apply --remote`、`wrangler queues create`、`wrangler deploy`（真实部署）、任何 Drive 写操作、V1 关闭，全部需要乔炳源显式逐项授权。
- **验证命令**：`npm run test:worker` / `npm run test:bridge` / `npm test`；预期输出以 `# fail 0` 为准。

---

## Phase 0 — 基线保护与绿色基线（已完成，见 B 节）

T0.1–T0.5 已执行并记录 SHA。Phase 1 进入条件 = 本节 + Codex 对本计划复审通过。

---

## Phase 1 — 共享 V2 协议模块（工作包 1 后半）

### T1.1 规范 JSON 与哈希
- 红：`services/reliable-drive-sync-worker/test/rds2-protocol.test.js` — 键顺序不同、内容相同的 envelope 哈希相同；嵌套数组/对象规范化正确。
- 绿：新建 `shared/rds2-protocol.mjs`，导出 `canonicalJson(value)` 与 `sha256Hex(text)`（`crypto.subtle`，Workers/Node 通用）。
- 验证：`npm run test:worker` → `# fail 0`。
- 提交：`feat(v2): shared canonical json + sha256`。回滚：revert 该 commit（文件未被引用）。

### T1.2 envelope 完整校验（单一事实源）
- 红：同一测试文件 — namespace 白名单外 → `invalid_namespace`；eventType 前缀与 namespace 不一致（`protocol.js:377` 语义）→ `namespace_event_type_mismatch`；envelope 出现白名单外字段（`ALLOWED_ENVELOPE_FIELDS` 语义，`protocol.js:27`）→ `invalid_envelope_field`；`schemaVersion != "1.2"`、payload 内部事件字段缺失/类型错误 → 各自错误码；`algorithm.learning.completed` 内外 eventType 一致性校验。
- 绿：`shared/rds2-protocol.mjs` 增加校验器。**设计决策**：V1 `protocol.js` 不改造（避免动 V1）；新建 `test/rds2-protocol-parity.test.js` 固定 20+ 组金样本，断言 shared 校验器与 V1 `protocol.js` 对重叠规则给出一致结论，防两端漂移。
- 验证：`npm run test:worker` → `# fail 0`（含 parity 测试）。
- 提交：`feat(v2): shared envelope validator + parity tests`。回滚：revert。

### T1.3 三查询意图判定（替换 classifySubmission）
- 红：`test/rds2-protocol.test.js` — 纯函数 `resolveIntent({ requestRow, eventRow, eventKeyRow }, incoming)`：三行全空 → `new_event`；requestRow 哈希同 → `exact_retry`，哈希异 → `request_id_conflict`；eventRow 哈希异 → `event_id_conflict`；eventKeyRow 存在且非本 eventId → `event_key_already_recorded`；冲突优先级矩阵全覆盖。
- 绿：`shared/rds2-protocol.mjs` 增加 `resolveIntent`。文档注释明确：ingress 必须先做三次精确查询再调用本函数，INSERT 唯一约束失败后必须重查再判定（竞态路径在 T2.8 测试）。
- 验证：`npm run test:worker` → `# fail 0`。
- 提交：`feat(v2): three-lookup intent resolution`。回滚：revert。

### T1.4 receipt 构造器与错误码
- 红：receipt 含 §10.1 全字段，`projection/drive` 恒为 `pending`；`cloud_accepted` 不得出现"drive synced/snapshot updated"类文案（字符串断言）。
- 绿：`shared/rds2-protocol.mjs` 增加 `durableReceipt()` 与错误码常量。
- 验证：`npm run test:worker` → `# fail 0`。
- 提交：`feat(v2): durable receipt builder`。回滚：revert。

### T1.5 打包门（Phase 1 退出条件）
- 动作：`npx wrangler deploy --dry-run --outdir "$TMP/rds2-dryrun-p1"`。
- 预期：退出码 0，bundle 包含 shared 模块内容（如尚未被引用则仅验证基线打包仍通过）。
- 提交：无（验证性任务）。失败则 halt-and-report。

---

## Phase 2 — D1 V2 数据底座（工作包 2）

### T2.1 迁移 0006：五表 + 约束 + 索引
- 红：`test/rds2-schema.test.js` — 对本地 SQLite 应用 `migrations/0006_rds2_v2_tables.sql` 后：五表存在；`rds2_users.name_key` 唯一；`rds2_business_events` 的 `request_id`/`event_id`/`(user_id,namespace,event_type,event_key)` 三唯一约束各自触发；`rds2_event_outbox(event_seq) WHERE task_type='project_event'` 部分唯一索引拦截第二个投影任务；`rds2_archive_deliveries.artifact_key` 唯一；外键 `business_events.user_id REFERENCES rds2_users(user_id)`、`event_outbox.event_seq REFERENCES business_events(event_seq)`、`event_outbox.archive_delivery_id REFERENCES archive_deliveries(archive_delivery_id)` 声明存在（运行期由适配器 `PRAGMA foreign_keys=ON` 验证拦截）；索引 `(state, available_at)`、`(drive_path)` 存在。
- 绿：新建 `migrations/0006_rds2_v2_tables.sql`（全部 `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`，风格对齐 0005；不动 0005）。
- 验证：`npm run test:worker` → `# fail 0`。
- 提交：`feat(v2): rds2 five-table migration`。回滚：revert（迁移未应用于远程，无副作用）。

### T2.2 SQLite 适配器（真实事务测试载体）
- 红：`test/rds2-sqlite-adapter.test.js` — 适配器实现 D1 语义：`prepare().bind().run/all/first`；`batch([stmt...])` 在事务内执行，任一语句失败整个批次回滚（真实 BEGIN/ROLLBACK，含约束失败）；`PRAGMA foreign_keys=ON`。
- 绿：新建 `services/reliable-drive-sync-worker/src/rds2/sqlite-adapter.js`（基于 `node:sqlite`，仅测试与本地集成使用；生产走 D1 binding 同语义 API）。
- 验证：`npm run test:worker` → `# fail 0`。
- 提交：`feat(v2): sqlite adapter with d1 batch semantics`。回滚：revert。

### T2.3 user-repository
- 红：`test/rds2-user-repository.test.js` — 注册（NFKC+trim name_key）、同 name_key 幂等返回原 user、disabled 拦截读取与写入标记。
- 绿：`src/rds2/user-repository.js`。
- 验证/提交/回滚：同上模式，`feat(v2): user repository`。

### T2.4 event-repository
- 红：`test/rds2-event-repository.test.js` — `event_seq` 单调分配；`readAfter(seq, limit)` 仅返回 `event_seq > seq` 且 `ASC LIMIT ≤10`；三唯一约束错误码映射。
- 绿：`src/rds2/event-repository.js`（只暴露 insert 与游标读，无 update/delete 路径——账本不可变由接口面保证）。
- 提交：`feat(v2): event repository (append-only surface)`。

### T2.5 outbox-repository + 确定性 taskId
- 红：`test/rds2-outbox-repository.test.js` — `t_project_<event_seq>` 确定性生成；短租约认领（两租约互斥）；租约过期回收（attempt+1）；状态机非法迁移拒绝（如 completed → pending 拒绝）；到期小批领取 `LIMIT ≤5`；重试阈值转 `needs_attention`。
- 绿：`src/rds2/outbox-repository.js`。
- 提交：`feat(v2): outbox repository with leases and deterministic task ids`。

### T2.6 projection-repository
- 红：`test/rds2-projection-repository.test.js` — 主键 `(user_id, namespace, projection_name)`；游标条件更新 `WHERE last_event_seq = ?`——旧游标写入返回 0 行（防旧覆盖新）；`content_hash` 写入与读取。
- 绿：`src/rds2/projection-repository.js`。
- 提交：`feat(v2): projection repository with cursor guard`。

### T2.7 archive-delivery-repository
- 红：`test/rds2-archive-delivery-repository.test.js` — `artifact_key` 幂等（重复冻结返回原行）；`archive_delivery_id` 由 `artifact_key` SHA-256 前 32 hex 确定性派生 → 同 artifact 重试得同 ID（进而 `t_archive_<id>` 稳定）；状态迁移 `pending→delivering→delivered/needs_attention` 合法、逆迁拒绝。
- 绿：`src/rds2/archive-delivery-repository.js`。
- 提交：`feat(v2): archive delivery repository`。

### T2.8 accept-service（原子接收 + 竞态处理）
- 红：`test/rds2-accept-service.test.js` — 正常路径：一次 `batch([INSERT event, INSERT outbox])` 后事件与 `t_project_<seq>` 同存；**竞态路径**：两条并发相同 requestId（预查均空、INSERT 撞唯一）→ 重查后返回 `exact_retry` 与同一 receipt，不产生第二行；身份不存在/禁用 → 拒绝且零写入；batch 中第二条失败 → 首条一并回滚（真实 SQLite 事务）。
- 绿：`src/rds2/accept-service.js`。
- 提交：`feat(v2): atomic accept service with race-safe idempotency`。

### T2.9 D1 真实事务集成测试
- 红：`test/rds2-d1-integration.test.js` — 真实 SQLite 文件库跑完整接收→游标读→投影写链路；进程重启后数据仍在；中途 kill 模拟（事务内抛出）后无半提交状态。
- 绿：复用 T2.2/T2.8 实现，仅补测试（如实现缺陷在此暴露则修复并拆独立 commit）。
- 提交：`test(v2): real-sqlite transactional integration suite`。
- **远程检查点（需授权，不在本轮）**：`npx wrangler d1 migrations apply reliable-drive-sync --remote`。

---

## Phase 3 — `/v2/events`、身份初始化与本地 MCP V2（工作包 3）

### T3.1 身份初始化入口 `POST /v2/users/init`
- 红：`test/rds2-identity-init.test.js` — 仅接受 `RDS2_ADMIN_TOKEN`（独立 secret，与 ingress Bearer 不同），错误 token → 403；首次初始化返回 `{userId, displayName, nameKey}` 并创建指定 namespace（默认 `algorithm`）的空投影行；同 displayName 重复初始化 → 幂等返回同一 userId，不建第二个用户；同 name_key 但显式携带不同 userId → `409 name_key_conflict`（附现有 userId 提示，不自动覆盖）；disabled 身份不可经 init 复活；初始化失败零残留（无半建用户/投影）。业务事件入口（T3.2）断言：不存在自动建档路径。
- 绿：`src/rds2/identity-init.js` + `src/index.js` 路由一行（仅此改动）。
- 提交：`feat(v2): protected identity initialization`。

### T3.2 ingress `POST /v2/events`
- 红：`test/rds2-ingress-v2.test.js` — §10.1 八步顺序：鉴权失败/超大请求/坏 JSON/外壳校验失败/内部校验失败/身份不存在或禁用 → 各自稳定错误码；canary 门：`RDS2_CANARY_NAMESPACES="algorithm"` 时 `interview` 事件 → `503 namespace_not_enabled`；T1.3 意图判定接入真实仓库；budget 断言整个接收路径 ≤10 子请求（注入计数 fetch）；Queue 发布失败不影响 `accepted`。
- 绿：`src/rds2/ingress-v2.js`（每处外部调用经 SubrequestBudget——预算器本阶段先以内联最小版提供，T4.5 抽公共模块）。
- 提交：`feat(v2): v2 events ingress with canary allowlist`。

### T3.3 稳定回执与 already_recorded
- 红：`test/rds2-ingress-v2.test.js` 追加 — 完全相同重试返回原 `eventSeq/taskId/persistence`；`event_key_already_recorded` 返回首次事件回执（§9 表第 4 行）；三种冲突错误体不泄露任何 envelope 内容。
- 绿：ingress 分支补全。
- 提交：`feat(v2): stable receipts and already_recorded semantics`。

### T3.4 `POST /v2/query`（带身份读取）
- 红：`test/rds2-read-api.test.js` — 请求体 `{identity, scope:"projection", namespace}` → 核对 `rds2_users`（UUID + name_key 一致）后仅返回该用户 `public_view_json`；身份不符 → `403 identity_mismatch`；`scope:"event_status"` 按 requestId/eventId 仅查本人分层状态（eventLedger/projection/drive）；**不存在**任何无需身份的 GET 查询路径（路由清单断言）。
- 绿：`src/rds2/read-api.js` + index.js 路由两行。
- 提交：`feat(v2): identity-bound query endpoint`。

### T3.5 本地版本分流（进程级配置，不碰 envelope）
- 红：`tools/reliable-drive-sync-mcp/test/v2-config.test.mjs` — `configurationFromEnvironment()` 新增 `writeVersion`（默认 `"v1"`）；`RELIABLE_DRIVE_SYNC_WRITE_VERSION=v2` 时 `createService` 构造 `DeliveryServiceV2`，v1 行为逐字节不变（现有 47 个 bridge 测试全部保持绿）。
- 绿：`stdio-bridge.mjs` 仅改 `configurationFromEnvironment()`（第 98–106 行区域）与 `createService()` 的构造分支；V1 `DeliveryService` 构造路径代码不动。
- 提交：`feat(v2): env-based local write version switching`。

### T3.6 local-outbox-v2
- 红：`test/v2-local-outbox.test.mjs` — 默认库文件 `<dataDir>/ReliableDriveSync/outbox-v2.sqlite`（可用 `RELIABLE_DRIVE_SYNC_OUTBOX_PATH_V2` 覆盖）；schema 含 `request_id` 主键、状态、payload、最小 receipt 列；原子认领（`markSending` 失败则 flush 跳过该行）；重启恢复 `sending→pending`；单批 ≤20；同 requestId 同输入重用原行、异输入本地冲突。
- 绿：`tools/reliable-drive-sync-mcp/local-outbox-v2.mjs`。
- 提交：`feat(v2): local outbox v2 with atomic claiming`。

### T3.7 delivery-service-v2
- 红：`test/v2-delivery-service.test.mjs` — 仅 durable receipt / `already_recorded` 清理 payload 行并留最小 receipt 历史；三种 ID 冲突 → 行标记 `blocked` 且 30 秒扫描不再拾取（永久阻塞）；超时/5xx/429 → pending + 有上限退避（断言退避序列封顶）；"D1 已提交但响应丢失"模拟 → 同三 ID 重试取原回执后正常清理。
- 绿：`tools/reliable-drive-sync-mcp/delivery-service-v2.mjs`。
- 提交：`feat(v2): delivery service v2 with permanent blocking and capped backoff`。

### T3.8 index.js 路由接入
- 红：`test/worker-routes.test.js` 追加 — `/v2/events`、`/v2/users/init`、`/v2/query` 三路由存在且分别受 `RDS2_EVENTS_ENABLED`/admin token/`RDS2_READS_ENABLED` 控制，关闭时稳定 `503 rds2_disabled`；V1 路由响应逐项不变（快照断言）。
- 绿：`src/index.js` 追加三行路由（V1 路由零改动）。
- 提交：`feat(v2): wire v2 routes behind feature flags`。
- **部署检查点（需授权）**：真实部署延后至 Phase 10 暗部署。

---

## Phase 4 — D1 Outbox 与 Cloudflare Queue（工作包 4）

### T4.1 queue handler 接入 default export + TOML
- 红：`test/rds2-queue-consumer.test.js` — `createWorker(env).queue(batch, env, ctx)` 存在；按 `batch.queue` 路由到投影/归档处理器；消息仅含 `{taskId, taskType, attempt}` 定位信息；逐消息语义：处理器成功/幂等命中 → `message.ack()`；瞬时失败（注入错误）→ `message.retry()`；未投递 `ack`/`retry` 的消息由平台重试（断言不吞异常）。
- 绿：`src/index.js` default export 增加 `queue(batch, env, context){ return createWorker(env).queue(batch, env, context); }`，`createWorker` 增加 `queue()` 方法（fetch/scheduled 零改动）；`wrangler.toml` 追加（逐行书写）：
  ```toml
  [[queues.producers]]
  binding = "RDS2_PROJECT_QUEUE"
  queue = "rds2-project"

  [[queues.producers]]
  binding = "RDS2_ARCHIVE_QUEUE"
  queue = "rds2-archive"

  [[queues.consumers]]
  queue = "rds2-project"
  max_batch_size = 10
  max_retries = 5
  dead_letter_queue = "rds2-project-dlq"

  [[queues.consumers]]
  queue = "rds2-archive"
  max_batch_size = 8
  max_retries = 5
  dead_letter_queue = "rds2-archive-dlq"
  ```
  （V1 crons/D1 binding/QStash vars 保留；**Queue 实际创建是远程动作，需授权**。）
- 验证：`npm run test:worker` → `# fail 0`；`npx wrangler deploy --dry-run --outdir <tmp>` 通过（TOML 语法门）。
- 提交：`feat(v2): queue handler in worker default export + queue config`。回滚：revert 后 dry-run 复验。

### T4.2 dispatcher-v2（发布三段式）
- 红：`test/rds2-dispatcher-v2.test.js` — 认领（短租约）→ 发布 → 记 `queue_message_id`+`queued` 三段各自失败的恢复：发布失败释放租约并设 `available_at=now+退避`；记录失败 → 任务留 `dispatching` 由租约过期回收，不产生重复发布断言（同 taskId 二次发布前必须查状态）。
- 绿：`src/rds2/dispatcher-v2.js`。
- 提交：`feat(v2): outbox dispatcher with lease-then-publish`。

### T4.3 定时恢复器
- 红：`test/rds2-recovery.test.js` — 仅取 `available_at ≤ now` 且 `pending/dispatching(租约过期)`；小批 ≤5 顺序处理；源码静态断言领取路径无 `Promise.all`；`attempt_count ≥ 阈值(5)` → `needs_attention`；崩溃恢复：过期 `processing` 租约被重置为 `pending` 并 attempt+1。
- 绿：`src/rds2/recovery.js`，挂入现有 cron 分支（追加 `controller?.cron === "*/5 * * * *"` 的 V2 分支，V1 reconciler 调用不动）。
- 提交：`feat(v2): bounded cron recovery`。

### T4.4 DLQ 处理
- 红：`test/rds2-dlq.test.js` — DLQ 消费（`rds2-project-dlq`/`rds2-archive-dlq` 均有消费者）按 `queue_message_id` 定位 outbox 行 → 置 `needs_attention` + `last_error_code='dlq_exhausted'`；找不到对应行 → 仅告警日志不崩溃；兜底：recovery 扫描 `queued/processing` 超过租约与阈值者同样转 `needs_attention`（双通道，防 DLQ 消费者自身故障）。
- 绿：`src/rds2/dlq-consumer.js` + index.js queue 路由分支。
- 提交：`feat(v2): dlq consumer and dual-channel needs_attention`。

### T4.5 SubrequestBudget 公共模块
- 红：`test/rds2-subrequest-budget.test.js` — `remaining/consume/assertWithinLimit/snapshotByCategory`；上限 40；`consume` 超额抛出且**未产生任何调用**（预算先于调用）；分类快照准确。
- 绿：`src/rds2/subrequest-budget.js`；T3.2 内联版重构为引用本模块（行为不变，ingress 测试保持绿）。
- 提交：`feat(v2): shared subrequest budget`。

---

## Phase 5 — 增量投影框架与 algorithm Reducer（工作包 5）

### T5.1 Reducer 契约
- 红：`test/rds2-reducer-contract.test.js` — 合法 Reducer 必须实现 `emptyProjection(identity)/applyEvent(currentState, validatedEvent)/publicView(nextState)` 且为纯函数（同输入同输出、无 IO——以重复调用相等断言）；非法 Reducer 在注册时抛出。
- 绿：`src/rds2/reducer-contract.js` + 注册表 `src/rds2/reducers/index.js`。
- 提交：`feat(v2): pure reducer contract`。

### T5.2 V2 全量 fold Oracle
- 红：`test/rds2-fold-all.test.js` — `foldAll(events)`：按 `event_seq ASC` 排序后从 `emptyProjection` 一次性 apply 至末；与单批 apply(seq 排序) 结果逐字段一致；**明确断言**：当事件序列的 `event_seq` 顺序与其业务时间（observedAt/scoredAt/completedAt）顺序不一致时，V2 fold 结果与 V1 rebuild 结果**允许不同**（快照字段差异示例固化，作为语义变更证据，不是缺陷）。
- 绿：`src/rds2/fold-all.js`（仅测试与离线工具引用，不入在线热路径）。
- 提交：`feat(v2): v2 fold-all oracle with explicit seq semantics`。

### T5.3 投影引擎
- 红：`test/rds2-projection-engine.test.js` — §12 六步：读游标 → `readAfter(last,10)` → 逐 apply → 单事务原子写【投影 + 完成对应 `t_project_*` 任务 + 冻结 archive_deliveries + 建 `t_archive_*` 任务】→ 有剩余再投递唤醒 → 无剩余对重复消息 ack；游标防旧覆盖（并发双消费者仅一个前进）；引擎自身不触 Drive（依赖注入清单断言）。
- 绿：`src/rds2/projection-engine.js`。
- 提交：`feat(v2): incremental projection engine with atomic archive freezing`。

### T5.4 algorithm Reducer（领域：`algorithm`）
- 红：`test/rds2-reducer-algorithm.test.js` — 以 `src/algorithm-profile-model.js` 为规则蓝本移植：completed/correct 计正分、incorrect/stuck/partial 记弱点、`consulted` 永不计分也不建弱点、problemId 归一（source:title）；**领域不变量**：correction 事件使既有弱点按规则消解或转移；`observedAt` 仅作展示排序输入，不改变计分集合；依赖顺序规则在 seq 序下成立。
- 绿：`src/rds2/reducers/algorithm.js`。
- 提交：`feat(v2): algorithm reducer (canary domain)`。

### T5.5 等价测试（Phase 5 退出条件）
- 红：`test/rds2-equivalence-algorithm.test.js` — 同一合法事件序列（含乱序投递、重复投递、迟到回填三类扰动）：foldAll ≡ 批大小 1/3/7/10 的增量 apply 逐字段相等（`state_json` 与 `public_view_json`）；重复 Queue 消息不二次计分。
- 绿：仅测试（如暴露引擎缺陷，修复拆独立 commit 并回报）。
- 提交：`test(v2): algorithm fold/incremental equivalence`。
- **部署检查点（需授权）**：`RDS2_PROJECT_ENABLED=true` 暗部署准备，真实开启在 Phase 10。

---

## Phase 6 — 其余三域 Reducer（工作包 6，每域独立提交，禁止合并）

### T6.1 profile（generic profile）
- 红：`test/rds2-reducer-generic-profile.test.js` + `test/rds2-equivalence-generic-profile.test.js` — 规则蓝本 `src/generic-profile-model.js`（positive/negative/neutral/partial 分类、domain 校验契约）；不变量：同 eventKey 幂等（ingest 已保证唯一，Reducer 对重复 seq 输入仍无二次效果）；排序语义变更为 event_seq，业务时间仅展示；等价三件套（fold ≡ 任意批、乱序、重复）。
- 绿：`src/rds2/reducers/generic-profile.js`。
- 提交：`feat(v2): generic profile reducer`。

### T6.2 interview
- 红：`test/rds2-reducer-interview.test.js` + 等价测试 — 蓝本 `src/profile-model.js`/`interview-store.js`；不变量：**correction 是新不可变版本**（同 session 取最新）；V2 下"最新"= 最高 `reviewVersion`，平局取更大 `event_seq`（V1 为 completedAt+eventId 序，此处为明确的 V2 语义变更，固化测试注释）；profileChanges 仅在 `applyProfileChanges === true` 时生效。
- 绿：`src/rds2/reducers/interview.js`。
- 提交：`feat(v2): interview reducer`。

### T6.3 resume-knowledge
- 红：`test/rds2-reducer-resume-knowledge.test.js` + 等价测试 — 蓝本 `src/resume-knowledge-model.js`；不变量：**每题每自然日只记第一次有效评分**——V2 中该规则主要由 ingest 期 `(user_id, namespace, event_type, event_key)` 唯一约束保证（`eventKey` 按 `userId|localDate|questionKey` 作用域生成），Reducer 保留防御规则：作用域内若出现多事件（仅合成序列可能）取最小 `event_seq`；`scoredAt`/`localDate` 仅作展示与键生成，不作折叠顺序；coverage 计算（tested/total）逐字段对齐。
- 绿：`src/rds2/reducers/resume-knowledge.js`。
- 提交：`feat(v2): resume knowledge reducer`。

---

## Phase 7 — Drive V2 归档（工作包 7）

### T7.1 公共原语抽取（行为不变改造 `google-drive.js`）
- 红：先行测试 `test/drive-http-client.test.js` — `accessToken/oauthAccessToken/uploadJson/readJson/listChildrenExact` 的注入 fetch 契约与 URL 组装（含 `withSharedDriveSupport`）。
- 绿：新建 `src/drive-http-client.js`，将 `google-drive.js` 中四个模块私有函数（`oauthAccessToken/accessToken/googleUpload/googleGet`）迁入并导出；`google-drive.js` 改为 import 并保持 `createDriveRepository` 公共 API 与行为不变（含热修的去重与脱敏日志行为——由现有 `google-drive.test.js`/`sync.test.js`/`event-store.test.js` 证明）。
- 验证：`npm run test:worker` → 380+ 全绿（无回归证据）。
- 提交：`refactor(v2): extract shared drive http primitives (behavior preserving)`。回滚：revert。
- **此任务是唯一允许触碰 `google-drive.js` 的任务，且必须单独提交、单独审核。**

### T7.2 归档器
- 红：`test/rds2-drive-archiver.test.js` — 只上传 D1 冻结 `artifact_json`；重试按确定性父目录 + 精确文件名查找（注入断言无列表全扫）；已存在且哈希同 → 复用原文件记 delivered；哈希异 → `needs_attention` 禁覆盖；新建后精确 readback 哈希校验；同一调用复用 token 与已解析父目录（注入计数断言 token 仅 1 次）；**自适应批量**：认领每个对象前检查 `remaining ≥ 冻结开销 + 3`，不足停止扩批并释放未执行租约。
- 绿：`src/rds2/drive-archiver.js` + `src/rds2/drive-archive-client.js`（基于 T7.1 原语）。
- 确定性路径：`DriveRoot/my-chatGPT-skills-v2/users/<userId>/<namespace>/events/event-<eventId>.json` 与 `.../snapshots/<projectionName>-through-<eventSeq>.json`（逐条断言）。
- 提交：`feat(v2): bounded idempotent drive archiver`。

### T7.3 冷启动预算最坏证明
- 红：`test/rds2-budget-drive-worst-case.test.js` — 最坏分支：冷目录全部不存在（根确认 1 + user/namespace/events/snapshots 创建 4 + 各自查找 4 = 9）+ token 1 + 8 对象 ×（查找 1 + 新建 1 + readback 1）= 24 → 合计 **34 ≤ 40**；额度仅够 2 个对象时恰处理 2 个、其余释放；任何路径 > 40 直接失败。
- 绿：仅测试（如实现超标则修 archiver 并拆 commit）。
- 提交：`test(v2): drive cold-start worst-case budget proof`。

---

## Phase 8 — 全入口预算证明与可观测性（工作包 8）

### T8.1 四入口最坏路径测试
- 红：`test/rds2-budget-worst-case.test.js` — `/v2/events` ≤10；投影消费者 10 事件最坏 ≤20；恢复器最坏 ≤30；归档（引用 T7.3）≤40。全部注入计数假客户端。
- 绿：仅测试 + 必要修复。
- 提交：`test(v2): per-entry worst-case subrequest proofs`。

### T8.2 指标与脱敏日志
- 红：`test/rds2-metrics.test.js` — 总调用数、按类别、剩余额度、提前停止批次次数可导出；`test/rds2-log-redaction.test.js` — 静态断言（grep src/rds2 无 Bearer/token 全值输出）+ 动态断言（日志样例不含 Bearer、OAuth token、完整 envelope、完整画像、Drive 正文）。
- 绿：`src/rds2/metrics.js` + 各模块埋点。
- 提交：`feat(v2): budget metrics and redacted logging`。

---

## Phase 9 — Skill/插件契约升级（工作包 9，仓库 `C:\Users\27846\my-chatgpt-skills`）

### T9.1 契约盘点（只读）
- 动作：扫描 skills 仓库中 V1 语义引用（"Drive 已同步"类文案、读取路径、receipt 字段假设），产出 `docs/superpowers/plans/v2-skill-contract-inventory.md` 并冻结。
- 提交：`docs(v2): skill contract inventory`。

### T9.2 逐 Skill 修订（每 Skill 独立 commit）
- 内容：三状态严格区分文案（`cloud_accepted` ≠ `projection completed` ≠ `Drive delivered`）；读请求仍走 `submit_event` 同一工具（读语义经 `/v2/query` 由 Worker 表达）；本地切换文档写明 `RELIABLE_DRIVE_SYNC_WRITE_VERSION=v2` 环境变量与回退方法（envelope 不变，Skill 无需新增协议字段）；`setup-local-clients.ps1` 相关说明同步。
- 验证：skills 仓库 `tests/` 内契约测试逐 Skill 添加并通过。
- 提交：`feat(skills): v2 delivery semantics for <skill>`（逐个）。

### T9.3 插件重装流程
- 红：契约测试 — 安装/重装文档中的环境变量清单包含 WRITE_VERSION 与新 Outbox 路径说明。
- 绿：文档 + 测试。
- 提交：`docs(skills): v2 plugin reinstall flow`。

---

## Phase 10 — 端到端验证与发布（工作包 10，重排后无循环依赖）

### T10.1 混沌测试
- 红：`test/rds2-chaos.test.js` — §16 表逐行：响应丢失重试取原回执；Queue 重复/乱序/丢消息（丢消息由恢复器兜底）；消费者崩溃租约回收；投影半途失败回滚；Drive 响应丢失复用原文件；同名异内容阻断；预算耗尽释放租约；DLQ→needs_attention。
- 提交：`test(v2): chaos and failure-recovery suite`。

### T10.2 发布序列（每步进入/退出/监控/回滚，每步执行前需乔炳源显式授权）

| # | 阶段 | 进入条件 | 退出条件 | 回滚 |
|---|---|---|---|---|
| 1 | 暗部署（远程） | Phase 0–9 全绿 + Codex 复审通过 | 部署成功、开关全关、V1 指标无回归、dry-run 与部署 bundle 一致 | `npx wrangler rollback` |
| 2 | 合成用户 canary | 阶段 1 完成 | admin init 建合成用户 → curl 直连 `/v2/events`（algorithm）→ 投影 → 归档 → `/v2/query` 全链路；预算指标达标；DLQ 空 | 逐开关关闭 + rollback；V2 数据保留不删 |
| 3 | 本地 MCP v2 切换（单客户端） | 阶段 2 观察 ≥48h 无积压 | 用户本机 `RELIABLE_DRIVE_SYNC_WRITE_VERSION=v2`；V1 pending 行由用户逐条确认处理（不静默遗弃） | 本机环境变量回 v1；`outbox-v2.sqlite` 保留 |
| 4 | 真实 algorithm canary | 阶段 3 通过 | `RDS2_CANARY_NAMESPACES="algorithm"`；真实事件接收→投影→归档；与用户核对画像内容 | 关 canary 白名单；观察 DLQ 排空 |
| 5 | 其他域逐个启用 | 每域独立观察窗口 | 逐域等价抽检 + 预算达标 | 白名单逐域移除 |
| 6 | Skill 文案全量生效 | 阶段 5 通过 | skills 重装完成、契约测试绿 | skills 仓库 revert + 重装旧版 |
| 7 | 稳定观察 | — | 监控窗口（建议 ≥1 周）零 P1 | — |
| 8 | 关闭 V1 写入与 QStash | 阶段 7 + **乔炳源再次独立确认** | V1 冻结只读 | **单向动作，无自动回滚，执行前二次确认** |

---

## D. Codex 复审自检（§22 清单逐项）

1. 五表与原子边界 → T2.1/T2.8/T2.9；
2. Queue 仅唤醒器 → T4.1（消息仅定位信息）；
3. 三 ID 相同重试与冲突测试 → T1.3/T3.2/T3.3；
4. 在线快照全部来自 D1 投影 → T3.4（路由清单断言无 Drive 读取路径）；
5. 无 Drive 全历史扫描 → T7.2（注入断言）+ T10.1；
6. 每入口最坏 40 子请求证明 → T8.1（含 T7.3 冷启动）；
7. 六个未提交热修保存 → T0.1（`e58eabc`，已完成）；
8. 不迁移/覆盖/删除 V1 → C 节受保护路径 + T10.2 表；
9. 每域 Reducer fold/增量等价 + 领域不变量 → T5.5/T6.1–T6.3；
10. 三状态严格区分 → T3.3/T9.2；
11. 暗部署/canary/DLQ/人工恢复/回滚 → T4.4/T10.2；
12. 双仓库契约 → T9.1–T9.3。

## E. 未解决问题（需乔炳源/Codex 裁决）

1. `docs/project-learning/`（暂停的讲义，总览+模块4）是否入库——本计划保持未跟踪。
2. `rds2_users` 初始数据：乔本人 userId 是否复用 V1 已有 UUID 或新分配，待 T3.1 实施前确认。
3. `RDS2_DRIVE_ROOT_FOLDER_ID`（V2 根目录）需用户在 Drive 中创建后以 secret 注入，Phase 7 前提供。
4. D1 远程验证（T2.9 的远程部分）与本地 node:sqlite 适配器语义的最终一致性，在阶段 1 暗部署后以生产 canary 数据复核。
5. Queue 付费额度：Cloudflare Queues 在免费计划的配额限制需在阶段 1 前确认（属"付费配置"红线，未获授权前不开启）。
