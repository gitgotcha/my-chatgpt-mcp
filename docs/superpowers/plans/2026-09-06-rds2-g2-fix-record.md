# RDS2 G2 复审修订记录（R1–R7 + 测试覆盖纠正）

- 基线提交：`218ff8f`（G2 全本地链路验收）
- 审核文档：`2026-09-06-rds2-g2-codex-review.md`（7 项：6 P1 + 1 P2）
- 分支：`feat/rds2-v2`（worktree `C:\Users\27846\my-chatgpt-mcp-v2`）
- 边界：只改 G2 实现与必要迁移，未进入 T09/T10，未 push，未部署，未操作真实数据

## 0. 结论

7 项全部修复并提交，另修 3 项测试覆盖纠正（C3、C4、C5）。每项均按
「失败样本 → 红灯 → 修订 → 双 binding 绿 → SHA」闭环，编号保留。

复审方追加的补充方案已执行完毕（见 §6）：补齐 R2 事件数边界与两组场景、
R7 多同名归档、R5 空尾页替换语义与零事件构建、构建专用丢租约测试、C5 同
invocation 预算断言，审核文档入库，临时探针已定点清理。

**本轮有一项实现变更**：R2 新测试暴露「reducer 消费游标只校验冻结目标上界、
未校验本次读取页」的缺口，已修（`4f69982`，可单独回退）。详见 §6.3。

回归（`npm test` 口径）：Node 22.22.2 与 Node 26.7.0 上均为 **worker 552/552、bridge 47/47 通过**。

审核文档 §1–§4 的补测清单已逐条对账：R1/R5/R6/R7 全部覆盖；R2/R3/R4 的全部可达路径均已覆盖，仅「32 条语句上限」在构建路径不可达（见 §3 第 7 条）。

## 1. 提交清单

| 编号 | SHA | 提交标题 | 变更 |
|---|---|---|---|
| G2-R1 | `d1a37fa` | g2-r1 recovery pass dispatches due pending tasks | `tasks/recovery.js`、`tasks/repository.js`、`test/rds2-g2-chain.test.js`、`test/rds2-tasks.test.js` |
| G2-R2 | `4e0f705` | g2-r2 build paging bounded by frozen target and reducer cursor | `projection/builds.js`、`test/rds2-projection-engine.test.js` |
| G2-R3 | `56d0255` | g2-r3 cursor monotonicity and stale task convergence | `migrations/0006…`、`projection/commit.js`、`projection/engine.js`、`test/rds2-projection-engine.test.js` |
| G2-R4 | `5f5849d` | g2-r4 build lease CAS and authoritative completion | `migrations/0006…`、`projection/builds.js`、`test/rds2-projection-engine.test.js` |
| G2-R5 | `8e010ea` | g2-r5 freeze every build page and make replay generation aware | `archive/archiver.js`、`projection/builds.js`、`projection/commit.js`、`test/rds2-archive.test.js` |
| G2-R6 | `07bef42` | g2-r6 elect the learning head with V1's comparator | `projection/algorithm.js`、`test/rds2-algorithm.test.js` |
| G2-R7 | `6db8e64` | g2-r7 fail closed when Drive cannot prove a lookup is complete | `archive/drive-client.js`、`archive/archiver.js`、`test/rds2-archive.test.js` |
| C4 | `c02b2a4` | g2-c4 probe predecessors with a bounded indexed existence query | `projection/engine.js`、`test/rds2-projection-engine.test.js` |
| C3 | `0d5e07e` | g2-c3 the replay comparison asserts the cursor too | `test/rds2-archive.test.js` |
| C5 | `68a5737` | g2-c5 pin per-invocation budget isolation for Drive lookups | `test/rds2-archive.test.js` |
| C5b | `1b931bc` | g2-c5 a new client over the same exhausted io changes nothing | `test/rds2-archive.test.js` |
| R5b | `0852801` | g2-r5 replace the empty-terminator case and cover the zero-event build | `test/rds2-archive.test.js` |
| R2b | `4f69982` | g2-r2 reject a reducer cursor that passes the page it was given | **`projection/builds.js`（实现变更）** |
| R2c | `8e0179a` | g2-r2 cover the event-count boundaries, the cross-user hole and appended events | `test/rds2-projection-engine.test.js` |
| R7b | `ab3e059` | g2-r7 two same-name objects park the task through archiveOne | `test/rds2-archive.test.js` |
| R4b | `dc9b379` | g2-r4 a build owner that loses the lease before the guard commits | `test/rds2-projection-engine.test.js` |
| DOC | `1793e65` | docs(rds2): commit the G2 review document with an acceptance addendum | `docs/…/2026-09-06-rds2-g2-codex-review.md` |
| R2d/R4c/R3b | `fedb44a` | g2 close the remaining R2/R3/R4 supplementary cases | `test/rds2-projection-engine.test.js` |

## 2. 逐项记录

### G2-R1 [P1] 恢复器不派发普通 pending，新事件无法自动启动

- **失败样本**：接受 1 个合法事件后仅调用恢复器 → `considered=0, dispatched=0`，两个任务一直停在 `pending`。
- **红灯**：把 `tasks/recovery.js` + `tasks/repository.js` 回退到 `d1a37fa^`，跑链路与任务测试 → **19 例中 6 例失败**（3 条 G2 链路用例 + R1 ×3）。
- **修订**：到期的 `pending`（`available_at` 已到或为空）与租约过期的任务在同一趟里合并枚举，前者派发、后者回收；去重后每趟上限 4，调用方 `limit` 不得放大该上限；未到 `available_at` 的 pending 不派发。链路测试改为**只由 `recoverOnce` + 它实际发出的 Queue 消息驱动**。
- **双 binding 绿**：SQLite 模拟器与 Miniflare/workerd D1 均通过；全量 532/532。

### G2-R2 [P1] 分页构建漏算事件却提前推进游标

- **失败样本**：6 个事件 + 默认 pageSize，一次 `continueBuild` 返回 `build_activated` 且 `attempts=5`；构建 target=2 后新增第 3 个事件，计数 3 但 cursor 只到 2。
- **红灯**：回退 `projection/builds.js` 到 `4e0f705^` → **22 例中 10 例失败**（R2 ×3、R3、R4 ×3 等）。
- **修订**：完成判定改为 **reducer 的消费游标**（校验前进且落在已取范围内），不再用「读取条数 < pageSize」；页查询以 `event_seq <= target_event_seq` 冻结上界；`pageSize` 校验并封顶 50（默认 50）；中间页与激活页统一 20 行 / 64KiB / 256KiB / 32 语句边界；无进展的 reducer 以 `build_no_progress` 停车。
- **双 binding 绿**：通过。

### G2-R3 [P1] 构建激活后旧任务仍能重算并使游标倒退

- **失败样本**：构建覆盖后的原投影任务再消费 → 重复计数、`lastEventSeq 7→2`、`revision 1→2`。
- **红灯**：回退 `migrations/0006…` + `projection/commit.js` + `projection/engine.js` 到 `56d0255^` → `test/rds2-projection-engine.test.js` **整体失败**（红灯）。
- **修订**：`projectOne` 对 `eventSeq <= last_event_seq` 的任务直接收敛（`already_applied`：不调 reducer、不动 revision、不重复归档）；新增 BEFORE UPDATE 触发在数据库层中止任何游标倒退；提交的 head 更新带上匹配的 `last_event_seq` 谓词。
- **双 binding 绿**：通过。

### G2-R4 [P1] 旧执行者失去租约后仍误报完成；陈旧 base 的构建留存

- **失败样本**：旧 owner 被抢租约后仍返回 `completed`（DB 实况：task=processing、新 owner 持租约、head revision=0、building=1）；构建启动前 base 变化 → 陈旧 build 留存，之后只 defer。
- **红灯**：回退 `migrations/0006…` + `projection/builds.js` 到 `5f5849d^` → **22 例中 7 例失败**（含 R4 ×3）。
- **修订**：`ensureBuild` 的 `building` 标志与 build 插入在**同一个 batch** 内按精确 `baseRevision` 做 CAS（新增触发 `build_requires_building_flag`，CAS 失败整批中止，失败发起者不留半个 build）；build-page 任务携带 `buildId`，遇到已结算构建自行收敛而不是长期持有 processing 租约；base 变化时原子 abort 并释放 `building`，由下一趟从新 head 重新决策；`completed` 必须由 DB 权威状态验证（构建 completed + generation 已切换 + cursor 到冻结 target），否则返回 `retry`/`noop`。
- **双 binding 绿**：通过。

### G2-R5 [P1] 中间构建页未归档，最终摘要也可能丢失

- **失败样本**：4 事件 / pageSize 2，3 次构建调用后 D1 新 generation 有 7 行、`head.summary=null`、`build_package` 数量 0、`replayProjection` 返回 revision 1 但 0 行。
- **红灯**：回退 `archiver.js`/`builds.js`/`commit.js` 到 `8e010ea^` → **12 例中 2 例失败**；本轮补的「单页」「世代切换」2 例同样失败（合计 4 例红灯）。
- **修订**：每个非空页冻结有界 `build_package`（`artifact_hash` 覆盖冻结字节，写入 `rds2_archive_deliveries`）并建自己的归档任务；激活 delta 携带 manifest（`buildId`/`generation`/`pages`/`firstEventSeq`/`lastEventSeq`）与最终 summary；摘要存于 continuation，空终止页不清空；离线重放校验 `kind`/`storageVersion`/`scope`、按 revision 连链、要求 manifest 声明的每一页（同 buildId、同 generation、页码 1..n），只重建**活动 generation**。
- **双 binding 绿**：4 例（多页、单页+乱序、重放对账含 cursor/summary、世代切换 + 缺页/跨 scope/畸形）在两种 binding 上均通过。

### G2-R6 [P2] 算法摘要与专题—题目关系不符合现有模型

- **失败样本**：先收 9/6 的 hash 专题、再收 9/5 的 array 专题，summary 变为 array（V1 应仍为 hash）；daily-plan 无条件替换 `headEventId`；同一题在 hash 与 array 两个专题出现时关系表只剩 hash 一行。
- **红灯**：新增 6 例测试中 **5 例失败**（`currentTopic=array`、eventId 决胜失效、关系行数 1、plan 改写学习头）。
- **修订**：summary 增加全局排序键 `latest`，增量路径与 `buildPage` **同用 V1 比较器 `(observedAt, eventId)`** 选举 `headEventId`/`currentTopic`；新增独立字段 `lastReceivedEventId` 记录接收顺序，不再复用学习头；daily-plan 只更新 `lastReceivedEventId`，plan-only 时 summary 保持 `null`；`topic_problem` 主键改为 `topicProblemRowKey(topic, problemId)`（canonical 数组编码），写入与点查共用同一派生函数。
- **双 binding 绿**：6 例通过；构建结果的 `headEventId`/`currentTopic` 与 V1 oracle（`rebuildAlgorithmProfile`）逐项对齐。

### G2-R7 [P1] Drive 精确查找未确认结果完整就判「没有文件」并上传

- **失败样本**：fake 响应 `{files:[],nextPageToken:"more"}` 被转换为 `[]`，上层走 upload；`fields` 只请求 `files(id,name)`，即便补了分页 token 客户端也看不到。
- **红灯**：新增 7 例测试中 **6 例失败**。
- **修订**：请求显式 `pageSize=2` 与 `nextPageToken,incompleteSearch` 字段；出现 `nextPageToken` 或 `incompleteSearch === true` → `drive_search_incomplete`（fail closed：同一 invocation 内不无界翻页，也不当作「不存在」而上传）；JSON 不可解析 / payload 非对象 / `files` 非数组 / 命中缺 `id` → `drive_response_invalid`；元数据响应 64KiB 上限；归档侧把这些**确定性契约错误** park 为 `needs_attention`（不再作为 `drive_error` 反复重试）；上传后的内容校验仍走既有 `artifact_hash` + guard。
- **双 binding 绿**：7 例通过，失败场景下 upload 调用数为 0。

## 3. 测试覆盖纠正（审核文档 §2）

1. **链路调度**：`test/rds2-g2-chain.test.js` 的 `drainTasks` 只调用 `recoverOnce`，并只消费它实际发出的 Queue 消息；测试私有 SQL 不再是隐藏调度器。
2. **默认 pageSize + reducer 部分消费**：R2「six events build with the default page size」与 R5 多页/单页用例均使用默认 50，暴露「读取 50 / 消费 5」的错配。
3. **重放对账**：不再只断言行数——逐行 value 比较 + summary + revision + 活动 generation；`0d5e07e` 再补 cursor（`last_event_seq` = 冻结 target）与 revision 断言。
4. **事件表前序积压**：新增「50 vs 400 事件积压下读取行数完全一致」与「未追平时返回 `deferred_predecessor`」两例；`projectOne` 的 `COUNT(*)` 范围统计改为 `PREDECESSOR_PROBE_SQL`（`SELECT 1 … LIMIT 1`），并用 `EXPLAIN QUERY PLAN` 断言走 `rds2_events_scope_seq_idx`（两个 binding 实测均为 `SEARCH … USING COVERING INDEX`，无 `SCAN`）。
5. **每 invocation 独立 io**（审核 §2.5）：两条断言合起来覆盖边界。
   - `C5 a spent invocation budget stops Drive calls and only a new invocation gets a fresh one`（`68a5737`）：预算耗尽的 invocation 调 `findExact` 抛 `budget_exhausted`，`lists`/`uploads` 均为 0（调用发生前即被拦下）；另起一个 invocation 从自己的预算开始，只计入它自己的那一次调用。
   - `1b931bc` 补第二条：**同一个 invocation 内新建另一个客户端、但传入同一个已耗尽的 `io`，预算不能恢复**，外发次数仍为 0。换客户端不等于换 invocation。
   - 两者仍**不构成 T14 完整入口预算证明**，只证明预算挂在 invocation 上、不能被调用方置换。
   - 红灯取法：本项是既有契约，回退 R7 前（预 R7 的 `findExact` 同样使用 `io.fetch`）无法打红，故采用**变异测试**——把 `createInvocationIo` 的预算改成模块级共享，模拟「预算泄漏到下一次 invocation」；此时第二次 invocation 继承已耗尽的预算，`findExact` 抛 `budget_exhausted`，`lists` 仍为 0，`not ok 1`。还原每 invocation 独立预算后双 binding 绿。
   - 性质：这是**变异测试证据，不是历史缺陷的回退红灯**；按要求已如实标注，未改写历史提交。
6. **实际新增测试数**：基线 `218ff8f` 的 worker 全量为 **500**，本轮修订后为 **552**，实际新增 **52 个用例**（其中 7 个来自 R2 事件数参数化循环、3 个来自页上限参数化循环）。审核文档记的 48 例是 G2 提交口径（T05–T08 共 45 例 + 链路验收 3 例），两者相加为 **48 + 52 = 100**；此前 79/80 的写法均基于更早的计数，已作废。独立分支断言未计入总量。
7. **审核文档逐条补测清单的对账结论**：R1/R5/R6/R7 的补测清单已逐条覆盖；R2/R3/R4 除下列「不可达/不适用」项外也已覆盖：
   - R2「32 条语句上限」：构建路径单次批最多 29 条（20 行变更 + 守卫 + 2 页包 + 4 激活 + 完成 + 删守卫），**无法从构建路径触达**该上限，故不构造人为用例；上限仍在 `builds.js` 中校验（`commit_batch_too_large`），增量路径的越界拒绝由既有用例覆盖。
   - R4「已完成重放」：由 `R5 a single-page build freezes exactly one package and replays in any order` 与 `R5 offline replay needs every build package…` 覆盖（重放已完成的构建产物）。
7. **范围**：仅 G2 相关文件与必要迁移（0006 新增 `build_requires_building_flag`、游标防倒退触发及所需列）；G1 已修的身份、hash 与预算保护未回退。

## 4. 审核 §4 探针表逐行覆盖映射

| 探针现象（审核实测） | 修复后期望 | 覆盖该现象的测试（文件） |
|---|---|---|
| 新 pending 只调用恢复器 → 0 派发 | 到期 pending 被派发 | `R1 recovery dispatches due pending tasks after acceptance`（rds2-tasks）；`G2: a synthetic algorithm event completes the full local chain`（rds2-g2-chain） |
| 默认页构建 6 事件 → 计数 5 却激活 | 计数 6 才激活 | `R2 six events build with the default page size counts every event`（rds2-projection-engine） |
| 构建 target=2、随后新增第 3 个事件 → 计数 3、cursor 只到 2 | 只消费冻结 target 内事件，cursor 到 target | `R2 a build never reads past its frozen target` |
| 构建覆盖后的原任务再消费 → 重复计数、cursor 倒退 | 直接收敛，不重算、不倒退 | `R3 a stale projection task converges without re-applying its event`；`R3 the head cursor regression is aborted by the database` |
| 4 事件 / page size 2 的离线恢复 → D1 有 7 行、replay 0 行、summary=null | 重放等于实时投影（含 summary），页包齐全 | `R5 offline replay needs every build package and reproduces the live projection`；`R5 a multi-page build freezes every page and the activation references them`；`R5 the last non-empty page reaching the frozen target activates in place`（4 事件 / pageSize 2，manifest `pages=2`、无第三页任务、重放对账）；`R5 a zero-event build activates with an empty manifest and still replays`（rds2-archive） |
| 旧 owner 被抢租约后激活 → 返回 completed，实际 building=1 | 由 DB 权威状态判定，丢租约不谎报 | **`R4 an owner that loses the lease before the guard commits cannot report success`（构建激活路径专用，rds2-projection-engine）**；另附 `R4 a page task whose build is already settled converges itself`、`a stale owner's completion writes zero rows and is not acknowledged`（rds2-archive，已结束构建/归档侧，不能替代本行） |
| 构建启动前 base 变化 → 陈旧 base build 留存、后续只 defer | 原子中止并释放 building，下一趟重新决策 | `R4 ensureBuild refuses a stale base revision atomically`；`R4 a build whose base moved aborts diagnostically and releases the scope` |
| 同题跨专题、迟到旧事件 → 第二关系丢失、全局 latest 倒退 | 两条关系都在，latest 按比较器不退 | `R6 the same problem under two topics keeps both relations`；`R6 a late older event counts but never rewinds the summary head`（rds2-algorithm） |
| Drive 分页：fake 带 nextPageToken 仍返回 [] | fail closed，upload 调用数 0 | `R7 an empty page that carries nextPageToken is refused, never 'not found'`；`R7 an incomplete search never uploads and never marks an artifact delivered`；`R7 two same-name objects park the whole archive task as ambiguous_artifact`（rds2-archive） |

## 5. 回归结果（`npm test` 等价：worker + bridge）

| 运行时 | worker | bridge |
|---|---|---|
| Node 22.22.2（managed） | 552 / 552 通过 | 47 / 47 通过 |
| Node 26.7.0（system） | 552 / 552 通过 | 47 / 47 通过 |

命令：`node --test services/reliable-drive-sync-worker/test/*.js` 与
`node --test tools/reliable-drive-sync-mcp/test/*.mjs`（即根 `package.json` 的
`test:worker` / `test:bridge`）。补充方案全部提交后复跑，两个运行时、两个套件均无失败。

双 binding：`withD1` 让每条 D1 用例在 SQLite 模拟器与 Miniflare/workerd D1 上各跑一遍，全部通过。

## 6. 补充方案执行记录（复审方追加裁定）

| 裁定项 | 执行 | SHA |
|---|---|---|
| 1. R2 事件数边界 0/1/5/6/49/50/51 + 默认页 + 跨用户空洞 + 构建期间追加 | 参数化 7 例 + 2 组场景；测试驱动改为明确上限（40）且超限即失败；播种支持多用户 | `8e0179a` |
| 2. R7 多同名归档 | 经 `archiveOne` 断言 `needs_attention/ambiguous_artifact`、0 上传 0 回读、无交付时间、冻结内容与哈希不变 | `ab3e059` |
| 3. R5 空尾页语义调整 + 零事件构建 | 4 事件/pageSize 2 就地激活（2 页包、manifest `pages=2`、无第三页任务、重放对账）；零事件构建 `pages=0` 独立覆盖 | `0852801` |
| 4. 两个临时探针定点清理 | 确认其有效断言已进正式测试（R3/R5 与 C4）后删除，未提交、未触及其他未跟踪文件 | `1793e65`（同批） |
| 5. 九行探针表映射纠正 | 新增构建激活路径专用丢租约测试；R4 行已标注「已结束构建/归档侧不可替代」 | `dc9b379` |
| 6. 审核文档入库 + 数字纠正 | 原文结论与复现证据原样保留，追加 §5 验收调整说明 | `1793e65` |
| 7. C5 标注 + 同 invocation 断言 | 已标注为变异测试证据；补「同一 invocation 换新客户端不改预算」 | `1b931bc` |
| 追加：审核文档逐条补测对账 | R2 中间页上限（20 行 / 64KiB / 256KiB）、R4 同 scope 双 build、R4 存储失败、R3 重复消息 | `fedb44a` |

### 6.1 红灯与证据性质

| 用例 | 红灯取法 | 结果 |
|---|---|---|
| R2 reducer 越过本次读取页 | 新测试直接暴露实现缺口（无需变异） | 修复前 `continued`，期望 `needs_attention/build_no_progress`；修复后绿 |
| R4 构建激活前丢租约 | 变异：把权威完成判定改回「丢租约也报 `build_activated`」 | 变异下首条断言失败（`not ok 1`）；还原后双 binding 绿 |
| R4 存储失败不当永久暂缓 | 变异：把提交失败的兜底一律改为 park `needs_attention` | 变异下 `needs_attention`（期望 `retry/deferred_commit_failed`）；还原后绿 |
| C5 每 invocation 独立预算 | 变异：预算改模块级共享 | `not ok 1`（`budget_exhausted`）；还原后绿 |
| R5 / R7 / R2 边界与场景 | 既有正确行为，允许首次即绿 | 均双 binding 绿 |

### 6.2 未做之事

- 未构造「人为空尾页」用例（按裁定，该路径不重新开放）。
- 未为九行探针表另写九份独立脚本（按裁定，正式测试断言等价即可）。
- 未放宽任何断言迁就实现。

### 6.3 需要复审注意：本轮唯一的额外实现变更

R2 的新测试暴露了一个实现缺口，已修（`4f69982`，仅 `projection/builds.js` 一处）：

- **缺口**：`continueBuild` 校验 reducer 返回的消费游标时只比较冻结目标上界（`nextSeq <= target + 1`），未比较本次实际交给 reducer 的页范围。reducer 若返回一个「越过本次读取页、但仍在冻结目标内」的游标，引擎会接受它 —— 被跨越的事件从未被读取却被认为已消费，构建照常激活，投影出现空洞。
- **修复**：游标同时受两个上界约束（本次读取页 `lastEventSeq + 1` 与冻结目标 `+ 1`）；部分消费仍然合法（可以小于页长度），越过即 park 为 `build_no_progress`。
- **可回退性**：该提交独立，可用 `git revert 4f69982` 单独撤回；撤回后 `R2 a reducer that claims to have consumed past the page it was handed is refused` 会转红。

### 6.4 工作区状态

- 分支 `feat/rds2-v2`（worktree `C:\Users\27846\my-chatgpt-mcp-v2`），`git status` 干净，无未跟踪残留。
- 未 push、未部署、未进入 T09/T10、未操作真实数据；仍停在 G2 待复审。
