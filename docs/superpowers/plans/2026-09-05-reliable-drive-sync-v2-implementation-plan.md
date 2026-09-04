# Reliable Drive Sync V2 实施计划

> 计划日期：2026-09-05  
> 上位规格：`docs/superpowers/specs/2026-09-05-reliable-drive-sync-v2-requirements-and-architecture.md`（下称《基线》）  
> 本计划性质：**只输出计划，不修改代码、不部署、不迁移数据。** 所有实施动作在用户确认并经 Codex 审核后才开始。  
> 计划遵循《基线》第 2 节交付顺序：本计划 → Codex 审核 → 用户确认 → 建立隔离工作区 → 开发。

---

## 0. 通用纪律（适用于全部阶段）

### 0.1 开发流程

- 每个任务严格 TDD 红绿循环：先写失败测试（red），再实现到通过（green），最后重构。
- 每任务一个独立 commit，禁止把多个工作包、多个领域 Reducer 或基础设施与生产切换合并成巨型提交。
- 每任务完成时上报：变更文件清单、新增/通过的测试数量、commit SHA。
- 遇到计划外问题（脏 worktree 超出预期范围、合并冲突、测试回归、无法解释的失败）立即 halt-and-report，禁止 reset / overwrite / guess。

### 0.2 Git 安全规则

- 禁止 `git reset --hard`、`git checkout -- <file>`、`git stash drop`、`git clean -f`。
- 提交 V1 热修时只对《基线》4.3 列出的六个文件做显式 `git add <path>`，禁止 `git add -A`。
- 每阶段完成后打 tag `v2-phase-<N>-green`，作为该阶段回滚锚点。

### 0.3 受保护路径（V2 全程不得修改）

- `services/reliable-drive-sync-worker/migrations/0005_schema12_jobs.sql`
- V1 运行时文件：`src/index.js` 仅允许按 Phase 3 的明确说明追加一行 `/v2/events` 路由分发；其余 V1 文件（`ingress.js`、`dispatcher.js`、`sync.js`、`event-store.js`、`google-drive.js`、`qstash.js`、`reconciler.js`、各 V1 store/model）一律不改。
- 本地 V1 Outbox：`tools/reliable-drive-sync-mcp/local-outbox.mjs`、`delivery-service.mjs`、`stdio-bridge.mjs`（`stdio-bridge.mjs` 仅允许按 Phase 3 说明追加 V2 分支，不动 V1 分支）。
- Drive V1 根目录：任何代码路径不得写入 `my-chatGPT-skills/`（V1）。
- V1 D1 表（`schema12_jobs` 等）：不 ALTER、不 DELETE、不复用。

### 0.4 测试命令（全仓现有配置，不改）

```bash
npm run test          # worker + bridge 全量
npm run test:worker   # node --test services/reliable-drive-sync-worker/test/*.js
npm run test:bridge   # node --test tools/reliable-drive-sync-mcp/test/*.mjs
```

### 0.5 回滚总则（对应《基线》§19）

- 所有 D1 迁移只增不改：V2 五张 `rds2_` 表为新增迁移，回滚时不 DROP（空表无害），通过功能开关停用代码路径。
- 每个 Worker 入口受独立环境开关控制（见各阶段）；回滚 = 关开关 + `npx wrangler rollback`（或重新部署上一阶段 tag）。
- 已被 V2 接收的事件永不删除、永不自动改写到 V1。
- 本地 `outbox-v2.sqlite` 回滚时只停用，不删除文件。

### 0.6 功能开关清单（写入 `wrangler.toml [vars]`，默认全部 `false`）

| 开关 | 控制范围 |
|---|---|
| `RDS2_EVENTS_ENABLED` | `POST /v2/events` 写入口 |
| `RDS2_PROJECT_ENABLED` | 投影 Queue 消费者 |
| `RDS2_ARCHIVE_ENABLED` | Drive 归档 Queue 消费者 |
| `RDS2_RECOVERY_ENABLED` | 定时恢复器 V2 分支 |
| `RDS2_READS_ENABLED` | V2 投影读取接口 |

---

## Phase 0 — 基线保护与绿色基线（对应《基线》工作包 1 前半 + §4.3/§4.4）

**进入条件**：worktree 中恰好存在《基线》4.3 列出的 6 个修改文件 + 1 个未跟踪的规格文档；Worker 380/380、Bridge 45/46。

### 任务 0.1 保存 V1 热修基线

- 动作：显式 `git add` 以下六个文件并提交（热修属 V1 维护，规格已要求先保存再开 V2 工作区）：
  - `services/reliable-drive-sync-worker/src/event-store.js`
  - `services/reliable-drive-sync-worker/src/google-drive.js`
  - `services/reliable-drive-sync-worker/src/sync.js`
  - `services/reliable-drive-sync-worker/test/event-store.test.js`
  - `services/reliable-drive-sync-worker/test/google-drive.test.js`
  - `services/reliable-drive-sync-worker/test/sync.test.js`
- 提交信息：`chore: preserve V1 hotfix baseline (drive read dedup + redacted logs)`
- 验证：`git status --short` 仅剩未跟踪的规格文档；全量测试通过（此时 warning 断言仍失败 1 个，属预期）。
- 回滚：`git revert <sha>`（仅撤保存动作，不丢内容——内容仍在规格文档与本计划中留档）。

### 任务 0.2 修复 Node 版本相关断言，取得完整绿色基线

- 红灯：修改 `tools/reliable-drive-sync-mcp/test/stdio-bridge.test.mjs` 第 324–326 行——删除 `assert.equal((stderr.match(/SQLite is an experimental feature/g) ?? []).length, 1)`，替换为与 Node 版本无关的行为测试：**bridge 初始化响应时 stderr 必须为空；首次业务提交后 SQLite 才被加载**（通过 spawn 子进程、先握手后提交的现有 `runBridge` 骨架断言 stderr 在提交前后始终为空，且功能正常——即“提交前不加载 SQLite”的可观测行为，而非警告文本本身）。
- 绿灯：Bridge 46/46 全绿（Node 22 与 26 双版本各跑一次 `npm run test:bridge` 验证）。
- 基线锚点：全量 `npm run test` 绿色，打 tag `v2-phase-0-green`。
- 回滚：`git revert` 该任务 commit。

**阶段退出条件**：`git status` 干净（除规格文档）；Worker 380/380、Bridge 46/46。

---

## Phase 1 — 共享 V2 协议模块与冲突矩阵（工作包 1 后半）

**目标**：抽取 Worker 与本地共同使用的纯 V2 协议模块，杜绝两端校验规则漂移（《基线》§11 最后一条）。这是纯新增模块，零部署影响。

### 新增文件

- `shared/rds2-protocol.mjs`（仓库根新建 `shared/`；Worker 经 wrangler 打包可引用相对路径，Bridge 以 Node ESM 直接引用同一文件——单一事实源）
  - 规范 JSON 序列化（键排序）+ SHA-256 `envelope_hash` 计算（`crypto.subtle`，Node/Workers 通用）；
  - envelope 完整校验：外壳（`schemaVersion: "1.2"`、`namespace`、`eventType`、`requestId`、`identity`）+ `payload.event` 内部业务事件（`eventId`、`eventKey`、`eventType` 一致性），拒绝只校验外壳；
  - 三个 ID 的冲突/重试判定纯函数：`classifySubmission({ existing, incoming })` → `new_event | exact_retry | request_id_conflict | event_id_conflict | event_key_already_recorded`（《基线》§9 全矩阵）；
  - 稳定错误码常量与 durable receipt 构造器（《基线》§10.1 结构）；
  - `name_key` 规范化（NFKC + trim）。
- Worker 侧测试 `services/reliable-drive-sync-worker/test/rds2-protocol.test.js`
- Bridge 侧测试 `tools/reliable-drive-sync-mcp/test/v2-protocol.test.mjs`（import 同一 `shared/rds2-protocol.mjs`，证明两端规则同源）

### 测试清单（先红后绿）

- 规范 JSON 与哈希：键顺序不同、内容相同 → 哈希相同。
- 校验：每个必填字段缺失/类型错误/`schemaVersion` 非 1.2/内外 `eventType` 不一致 → 独立错误码。
- §9 冲突矩阵逐行 5 组测试：三 ID+内容全同 → `exact_retry`；`requestId` 同哈希异 → `request_id_conflict`；`eventId` 同哈希异 → `event_id_conflict`；作用域 `eventKey` 已存在 → `event_key_already_recorded`；全新 → `new_event`。
- receipt 构造：`cloud_accepted` 语义字段齐全，`projection/drive` 恒为 `pending`。

**提交边界**：协议模块 1 commit；冲突矩阵测试与实现可同 commit（模块为纯函数）。  
**部署检查点**：无（纯新增未引用文件）。  
**回滚**：删除 `shared/` 即可，无运行时影响。

---

## Phase 2 — D1 V2 数据底座（工作包 2）

**目标**：五张 `rds2_` 表 + 仓库层 + 原子接收服务，全部新增，不触碰 V1 迁移。

### 新增文件

- `services/reliable-drive-sync-worker/migrations/0006_rds2_v2_tables.sql`：按《基线》§7.2 建五表，逐条落实约束：
  - `rds2_users`：`user_id` PK，`name_key` UNIQUE，`status CHECK IN ('active','disabled')`；
  - `rds2_business_events`：`event_seq` INTEGER PK AUTOINCREMENT，`request_id` UNIQUE，`event_id` UNIQUE，`(user_id, namespace, event_type, event_key)` UNIQUE；仅 INSERT 语义由代码层保证（不建 UPDATE 触发器，D1 不支持，改由仓库层只暴露 insert + 按 seq 读取）；
  - `rds2_event_outbox`：`task_id` PK，`task_type CHECK IN ('project_event','archive_artifact')`，`state CHECK IN ('pending','dispatching','queued','processing','completed','needs_attention')`，`lease_owner/lease_until/available_at/attempt_count/queue_message_id/last_error_code`；
  - `rds2_projections`：PK `(user_id, namespace, projection_name)`，`last_event_seq`、`state_json`、`public_view_json`、`content_hash`、`projection_version`；
  - `rds2_archive_deliveries`：`archive_delivery_id` PK，`artifact_key` UNIQUE，`artifact_kind CHECK IN ('business_event','projection_snapshot')`，`state CHECK IN ('pending','delivering','delivered','needs_attention')`，`artifact_json/artifact_hash/drive_path/drive_file_id/attempt_count`。
- `services/reliable-drive-sync-worker/src/rds2/user-repository.js`：注册/解析身份、禁用身份拦截。
- `services/reliable-drive-sync-worker/src/rds2/event-repository.js`：按 `event_seq` 游标读取（`> last_event_seq`，`ASC`，LIMIT 10）、插入。
- `services/reliable-drive-sync-worker/src/rds2/outbox-repository.js`：原子认领（短租约）、状态迁移、到期任务小批领取。
- `services/reliable-drive-sync-worker/src/rds2/projection-repository.js`：游标条件事务写入（`WHERE last_event_seq = ?` 防旧覆盖新）。
- `services/reliable-drive-sync-worker/src/rds2/archive-delivery-repository.js`：冻结 artifact、状态迁移。
- `services/reliable-drive-sync-worker/src/rds2/accept-service.js`：D1 `batch()` 原子接收——`business_events` 插入 + `project_event` outbox 行同一批次成功或一起回滚。

### 测试文件（先红后绿，均用内存/本地 D1 模拟或注入假 binding）

- `test/rds2-user-repository.test.js`：注册、name_key 冲突、disabled 拦截。
- `test/rds2-event-repository.test.js`：seq 单调、游标读取 LIMIT、三唯一约束各自触发。
- `test/rds2-outbox-repository.test.js`：租约互斥（两 Worker 认领同一任务只成功一次）、租约过期回收、状态机非法迁移拒绝。
- `test/rds2-projection-repository.test.js`：游标条件写——旧游标消费者写不进去。
- `test/rds2-archive-delivery-repository.test.js`：artifact_key 幂等、状态迁移。
- `test/rds2-accept-service.test.js`：**原子性核心**——注入在第二语句失败的假 batch，验证事件与 outbox 行一起回滚，不存在“有事件、无任务”。

**部署检查点**：`npx wrangler d1 migrations apply reliable-drive-sync --remote`（只增表，V1 零影响；此为第一个远程动作，需用户单独授权）。  
**回滚**：无需回滚——表未被任何运行时代码引用；`npx wrangler rollback` 撤部署即可。

---

## Phase 3 — `POST /v2/events` 与本地 MCP V2（工作包 3）

### 新增文件

- `services/reliable-drive-sync-worker/src/rds2/ingress-v2.js`：按《基线》§10.1 顺序实现 8 步接收；受 `RDS2_EVENTS_ENABLED` 控制，关闭时返回稳定 `503 rds2_disabled`。
- `services/reliable-drive-sync-worker/src/rds2/read-api.js`：`GET /v2/projections/:namespace`（按已验证身份读 `public_view_json`）+ `GET /v2/events/status?requestId=|eventId=`（分层状态查询）；受 `RDS2_READS_ENABLED` 控制。
- `services/reliable-drive-sync-worker/test/rds2-ingress-v2.test.js`
- `services/reliable-drive-sync-worker/test/rds2-read-api.test.js`
- `tools/reliable-drive-sync-mcp/local-outbox-v2.mjs`：V2 语义独立实现（§11 补强项全部落地），库文件 `outbox-v2.sqlite`；V1 `local-outbox.mjs` 不动。
- `tools/reliable-drive-sync-mcp/delivery-service-v2.mjs`：原子认领 pending、永久冲突标记 `blocked` 停止重试、超时/5xx/限流恢复 pending + 有上限退避、D1 已提交响应丢失时同 ID 重试取原回执、成功后删 payload 留最小 receipt 记录。
- `tools/reliable-drive-sync-mcp/test/v2-local-outbox.test.mjs`
- `tools/reliable-drive-sync-mcp/test/v2-delivery-service.test.mjs`

### 修改文件（最小侵入，逐行说明）

- `services/reliable-drive-sync-worker/src/index.js`：在第 54 行路由区追加一行
  `if (request.method === "POST" && path === "/v2/events") return handleV2Events(request, env);`
  及读取路由两行；`handleV2Events` 从 `./rds2/ingress-v2.js` 导入。V1 路由零改动。
- `tools/reliable-drive-sync-mcp/stdio-bridge.mjs`：在现有工具分发处追加 V2 判定分支（envelope 带 V2 标记或显式参数时走 `delivery-service-v2`），V1 分支代码不改。
- `tools/reliable-drive-sync-mcp/delivery-service.mjs`：**不改**；V1 flush 循环外加一层“V1 行照旧、V2 行分流”的编排入口（如需改动编排，则新建 `delivery-orchestrator.mjs`，原文件保持只读）。

### 测试要点

- ingress：鉴权失败、超请求大小、JSON 非法、外壳/内部校验失败、身份不存在/禁用 → 各自稳定错误码；§9 矩阵五分支经真实 D1 语义验证；重试返回原 `eventSeq/taskId`；Queue 发布失败不影响 `accepted`（《基线》§10.1 第 8 步）。
- 本地：原子认领（`markSending` 失败则本次 flush 跳过该行）、三种 ID 冲突转 `blocked` 且 30 秒扫描不再捡起、单批最多 20 条、只有 durable receipt / `already_recorded` 才删行。

**部署检查点**：部署 Worker（开关全关）；`RDS2_EVENTS_ENABLED=true` + 合成用户冒烟属 Phase 10，不在本阶段开启。  
**回滚**：开关置 false + `npx wrangler rollback`；本地切回 V1 分支路径（`outbox-v2.sqlite` 保留）。

---

## Phase 4 — D1 Outbox 与 Cloudflare Queue（工作包 4 + 预算器模块）

**顺序说明**：`SubrequestBudget` 虽属工作包 8，但消费者/恢复器在实现期就需要它，故模块本阶段交付；最坏路径证明与生产指标仍按工作包 8 留在 Phase 8。这是实施顺序调整，不是架构决策变更。

### 新增/修改文件

- `services/reliable-drive-sync-worker/src/rds2/subrequest-budget.js`：`remaining() / consume(category, count=1) / assertWithinLimit() / snapshotByCategory()`，业务硬上限 40，不足即停，禁止先调用后记账。
- `wrangler.toml`（修改，追加而非覆盖现有内容）：
  ```toml
  [[queues.producers]] binding = "RDS2_PROJECT_QUEUE", queue = "rds2-project"
  [[queues.producers]] binding = "RDS2_ARCHIVE_QUEUE", queue = "rds2-archive"
  [[queues.consumers]] queue = "rds2-project",   max_batch_size = 10, max_retries = 5, dead_letter_queue = "rds2-project-dlq"
  [[queues.consumers]] queue = "rds2-archive",   max_batch_size = 8,  max_retries = 5, dead_letter_queue = "rds2-archive-dlq"
  ```
  （V1 的 crons、D1 binding、QStash vars 全部保留。）
- `services/reliable-drive-sync-worker/src/rds2/queue-consumer.js`：按 queue 名称分发到投影/归档处理器；仅接受 Queue 绑定上下文，不暴露公网 HTTP 入口。
- `services/reliable-drive-sync-worker/src/rds2/dispatcher-v2.js`：发布前短租约认领 → 发布成功记 `queue_message_id` + `queued` → 失败释放租约并设 `available_at`。
- `services/reliable-drive-sync-worker/src/rds2/recovery.js`：挂在现有 crons 上（追加分支，不改 V1 cron 逻辑），只取 `available_at` 到期任务，小批（≤5）顺序发布，禁止 `LIMIT 100 + Promise.all`；重试阈值后转 `needs_attention`。

### 测试文件

- `test/rds2-subrequest-budget.test.js`：上限、分类快照、超额即拒绝且不产生调用。
- `test/rds2-dispatcher-v2.test.js`：认领-发布-记录三段每段失败的恢复；租约互斥。
- `test/rds2-recovery.test.js`：到期任务小批处理、无界并发模式静态断言（grep 源文件不得出现 `Promise.all` 于领取路径）、`needs_attention` 转移。
- `test/rds2-queue-consumer.test.js`：消息只含定位信息；重复消息安全确认。

**部署检查点**：远程创建 4 个 Queue（`wrangler queues create`）；部署后开关全关，仅验证部署成功。  
**回滚**：`wrangler.toml` 中 queue 段落独立 commit，可单独 revert；`npx wrangler rollback`。

---

## Phase 5 — 增量投影框架与 algorithm-learning canary（工作包 5）

### 新增文件

- `services/reliable-drive-sync-worker/src/rds2/projection-engine.js`：§12 六步实现——读 `(user_id, namespace, projection_name)` 游标 → 读 ≤10 个新事件（ASC）→ 逐个纯 Reducer → 单个 D1 事务原子写入【新投影 + 完成 project_event 任务 + 冻结 archive_deliveries + 建 archive_artifact 任务】→ 有剩余则再唤醒，无剩余则安全确认重复消息。
- `services/reliable-drive-sync-worker/src/rds2/reducer-contract.js`：`emptyProjection(identity) / applyEvent(currentState, validatedEvent) / publicView(nextState)` 接口定义与合法性校验。
- `services/reliable-drive-sync-worker/src/rds2/reducers/algorithm-learning.js`：以 `src/algorithm-profile-model.js` 现有领域规则为蓝本移植为纯 Reducer（correction、invalidation、同日首次评分、依赖顺序规则一个不弱化）。
- `services/reliable-drive-sync-worker/test/rds2-projection-engine.test.js`
- `services/reliable-drive-sync-worker/test/rds2-reducer-algorithm-learning.test.js`

### 核心：全量/增量等价测试 Oracle（`test/rds2-projection-equivalence.test.js`）

- 旧全量 rebuild 作为测试 Oracle（仅测试环境引用，不入在线热路径）；
- 对同一组合法事件序列：全量重建结果 ≡ 任意切批（1/3/7/10 一批）增量 apply 结果，`state_json` 与 `public_view_json` 逐字段相等；
- 乱序到达（Queue 乱序事实模型）：靠 `event_seq` 排序后结果仍等价；
- 重复事件（同 eventKey）：增量路径不二次计分。

**部署检查点**：`RDS2_PROJECT_ENABLED=true`（仅投影消费者开启，无生产事件流入，属暗部署准备）。  
**回滚**：开关关闭；投影表空，无数据回滚需求。

---

## Phase 6 — 其余领域 Reducer（工作包 6）

每个领域独立 commit + 独立等价测试，禁止合并提交：

- `src/rds2/reducers/generic-profile.js` + `test/rds2-reducer-generic-profile.test.js`（蓝本：`src/generic-profile-model.js`、`generic-profile-contract.js`）
- `src/rds2/reducers/interview.js` + `test/rds2-reducer-interview.test.js`（蓝本：`src/interview-store.js`、`profile-model.js`）
- `src/rds2/reducers/resume-knowledge.js` + `test/rds2-reducer-resume-knowledge.test.js`（蓝本：`src/resume-knowledge-model.js`）

每个领域：现有业务规则清单先列出 → 等价测试逐条覆盖 → 全量/增量等价 + 乱序 + 重复三件套。

**部署检查点**：仅代码与测试，无部署变化。  
**回滚**：revert 对应 commit。

---

## Phase 7 — Drive V2 归档（工作包 7）

### 新增文件

- `services/reliable-drive-sync-worker/src/rds2/drive-archive-client.js`：窄接口 Drive 客户端，OAuth 与基础上传原语 import 自现有 `src/google-drive.js`（**该文件零修改**）；V2 专属逻辑（精确文件名查找、readback、哈希比对）全部在新文件。
- `services/reliable-drive-sync-worker/src/rds2/drive-archiver.js`：§14 规则——只上传 D1 冻结的 `artifact_json`；重试先按确定性父目录 + 精确文件名查找（不扫描历史集合）；已存在且哈希同 = 成功重放；哈希异 = `needs_attention` 禁止覆盖；新建后精确 readback 校验；同一调用内复用 token 与已解析父目录；每次操作前经 `SubrequestBudget` 记账，额度不足停止领取并释放租约。
- `services/reliable-drive-sync-worker/test/rds2-drive-archiver.test.js`（注入假客户端，覆盖：成功、重试、响应丢失恢复、同名异内容阻断、readback 失败重试、预算中途耗尽→已领取完成/未领取释放）。

### 确定性路径（代码内常量，测试逐条断言）

```
DriveRoot/my-chatGPT-skills-v2/users/<userId>/<namespace>/events/event-<eventId>.json
DriveRoot/my-chatGPT-skills-v2/users/<userId>/<namespace>/snapshots/<projectionName>-through-<eventSeq>.json
```

**部署检查点**：`RDS2_ARCHIVE_ENABLED=true`（无事件流入，Drive V2 根目录不会产生写入；首次真实写入属 Phase 10 canary）。  
**回滚**：开关关闭。已归档文件不删不改（不可变审计副本）。

---

## Phase 8 — 40 子请求最坏路径证明与可观测性（工作包 8）

### 新增文件

- `services/reliable-drive-sync-worker/test/rds2-budget-worst-case.test.js`：按 §15.2 表逐入口验证，全部使用可注入假客户端统计**真实调用次数**：
  - `/v2/events` 最坏分支 ≤ 10；
  - 投影消费者 10 事件最坏分支 ≤ 20；
  - 恢复器最坏分支 ≤ 30；
  - 归档消费者最坏分支 = 8 对象全部不存在、全部新建、全部 readback → **精确 ≤ 40**，且任何测试路径 > 40 直接失败。
- `services/reliable-drive-sync-worker/src/rds2/metrics.js`：总调用数、按类别调用数、剩余额度、提前停止批次次数；结构化日志。
- `services/reliable-drive-sync-worker/test/rds2-log-redaction.test.js`：静态 + 动态断言日志不含 Bearer、OAuth token、完整 envelope、完整画像、Drive 文件正文。

**部署检查点**：无新部署面；指标随下一阶段部署生效。  
**回滚**：revert commit。

---

## Phase 9 — Skill/插件契约升级（工作包 9，仓库 `C:\Users\27846\my-chatgpt-skills`）

### 任务 9.0 契约盘点（只读，产出冻结清单）

- 只读扫描 `my-chatgpt-skills` 全仓中对 V1 语义的引用（“Drive 已同步”类文案、快照读取路径、receipt 字段假设），产出清单提交至本仓库 `docs/superpowers/plans/v2-skill-contract-inventory.md`，**此清单冻结后才开始改 skills 仓库**。

### 任务 9.1+ 逐 Skill 契约升级（独立 commit）

- 三个状态严格区分的文案修订：`cloud_accepted` ≠ `projection completed` ≠ `Drive delivered`（§21.3）；
- 读请求继续走同一 MCP 工具，指向 V2 投影读取语义；
- 插件重装流程文档更新（`setup-local-clients.ps1` 相关说明如有引用需同步）；
- 每个被改动的 skill 目录附契约测试（skills 仓库现有 `tests/` 结构内新增），验证文案与回执字段一致。

**回滚**：skills 仓库按 commit revert；MCP 插件重装回旧版。

---

## Phase 10 — 端到端验证与发布（工作包 10）

### 任务 10.1 混沌测试（`services/reliable-drive-sync-worker/test/rds2-chaos.test.js`）

按 §16 表逐行构造故障注入：响应丢失、Queue 重复/乱序/丢消息、消费者崩溃（租约过期回收）、投影半途失败回滚、Drive 响应丢失复用原文件、同名异内容阻断、预算耗尽释放租约。每行一个独立测试，先红后绿。

### 任务 10.2 发布序列（每阶段独立进入/退出条件 + 回滚命令）

| # | 阶段 | 进入条件 | 退出条件 | 回滚 |
|---|---|---|---|---|
| 1 | 暗部署 | Phase 0–9 全绿 | Worker 部署成功，开关全关，V1 指标无回归 | `npx wrangler rollback` |
| 2 | 合成用户 canary | 阶段 1 完成 | `RDS2_EVENTS/PROJECT/ARCHIVE/READS_ENABLED=true`；合成用户完成 接收→投影→归档→读取 全链路；40 预算指标达标 | 逐开关关闭 + rollback；V2 表数据保留不删 |
| 3 | algorithm-learning 单域 canary | 阶段 2 观察窗口（≥48h）无 `needs_attention` 积压 | 真实用户单域事件等价性抽检通过；DLQ 为空 | 关事件开关，观察 DLQ 排空 |
| 4 | 本地 MCP/Skill 切换 | 阶段 3 通过 | V2 本地 Outbox 上线；V1 pending 行经用户逐条确认处理（不静默遗弃，§11） | 本地切回 V1 路径，`outbox-v2.sqlite` 保留 |
| 5 | 其余领域逐个启用 | 每域观察窗口独立 | 各域等价抽检通过 | 域级开关（namespace 白名单）回退 |
| 6 | 关闭 V1 写入与 QStash | 阶段 5 稳定观察 + 用户显式授权 | V1 冻结为只读 | **V1 关闭为单向动作，执行前需用户再次独立确认** |

每个阶段执行前单独向用户申请授权；每阶段结束上报指标（接收数、投影延迟、归档成功率、预算快照、DLQ 深度）与 commit/tag SHA。

---

## 验收映射（对应《基线》§21 → 本计划）

| 验收条款 | 覆盖位置 |
|---|---|
| 21.1 重试幂等/冲突确定响应/原子提交/Queue 容错/增量等价/不扫 Drive/归档容错 | Phase 1/2/3/5/7/10 测试 |
| 21.2 ≤40 子请求/成本与历史无关/批上限/无界并发禁令 | Phase 4/5/8 最坏路径测试 |
| 21.3 V1 不变/不迁移/身份校验/日志脱敏/三状态区分 | Phase 0.1/2/3/8/9 + 0.3 受保护路径清单 |
| 21.4 全绿/Node 断言替换/预算测试/canary/回滚命令 | Phase 0.2/8/10 |

## 《基线》§22 Codex 检查清单自检

1. 五表与原子边界 → Phase 2（accept-service 原子性测试）；
2. Queue 仅唤醒器 → Phase 4（消息只含定位信息测试）；
3. 三 ID 相同重试与冲突测试 → Phase 1 冲突矩阵 + Phase 3 ingress；
4. 在线快照全部来自 D1 投影 → Phase 3 read-api（测试断言不触 Drive）；
5. 无 Drive 全历史扫描路径 → Phase 7 精确查找 + Phase 10 混沌测试；
6. 每入口最坏 40 子请求证明 → Phase 8；
7. 六个未提交热修保存 → Phase 0.1；
8. 不迁移/覆盖/删除 V1 → 0.3/0.5 + Phase 10 表；
9. 每域 Reducer 等价测试 → Phase 5/6；
10. 三状态严格区分 → Phase 3/9；
11. 暗部署/canary/DLQ/人工恢复/回滚 → Phase 4（DLQ）/Phase 10；
12. 双仓库契约 → Phase 9。
