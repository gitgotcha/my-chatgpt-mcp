# RDS V2 夜间执行交接（2026-09-07 深夜 → 2026-09-08 晨 Codex 综合审核）

worktree `C:\Users\27846\my-chatgpt-mcp-v2`，分支 `feat/rds2-v2`。
本文件为交接文档（未跟踪保留，不进入任务提交）。

## 1. 各任务业务交付状态与提交 SHA

| 任务 | 状态 | SHA | 业务交付 |
|---|---|---|---|
| G2 关闭 | ✅ 完成 | `ef42303` | 五项 P1 全部修复：P1-1 `5d74784`（同类合并去重）、P1-2 `fffd3fa`（归档清零）、P1-3 `2e83691`+`cd38cf0`（计划形状与键数双上限 + D 类闭集与接线抓力）、P1-4 `3856eff`+`36bc8e6`+`6d8ea0d`（严格 reads 契约 + 两层守卫独立抓力）。变异 1–8 全红。技术债务清单见 f1f3-plan §10.3。 |
| T09 本地可靠队列与确认回执 | ✅ 完成 | `658840d` + 修复 `3c2aead`/`289283c` | `LocalOutboxV2`：`pending → sending → acknowledged/blocked` 全部显式 `BEGIN IMMEDIATE`；sending 带 owner+lease，启动与每次 claim 前回收过期租约；receipt 匹配 attemptedRequestId + 冻结 envelope 的身份/事件 + canonical 引用协议（first-accept 自引用；alias 去重接受 canonical 事件 id）才落 acknowledged；ack 保留 30 天、清理 ≤100 行且不牵连 pending/blocked；纯读不建库。`createDeliveryServiceV2`：send 在事务外，未知结果（断电/回包丢失/confirm 失败）一律保留行退避重放（相同 IDs → already_recorded 结算到原事件）；已确认行本地应答不触网络；flush ≤20 条；定时唤醒自续期（三路径均重排、不重叠、close 竞态安全）。 |
| T10 只读 DTO、Worker 接线与本地配置 | ✅ 完成 | `aaf4c57` | `POST /v2/query`：每操作独立 DTO、全部经 rds2_credentials 鉴权、域白名单 fail-closed；projection.read 一次 D1 batch 读头+行、limit ≤50、响应 ≤256KiB；游标 HMAC（独立密钥）绑定 user+operation+scope+revision、15 分钟过期、revision 变化 → `projection_changed`；event.status 严格恰一目标。队列消费者单消息/按类型预算（投影 24、归档 16）、ack+retry；定时恢复预算 32。本地：五类 V1 读消息 → 冻结 V2 操作映射（profile domain→projectionName、resolve 仅 displayName）、V2 status 显式 schema、WriteVersion=v2 时读走 /v2/query、写走 V2 outbox，V1 默认路径不变；setup 真实写入 WriteVersion/OutboxPath。 |
| T11 通用画像 | ⏸ 前置完成，reducer 待裁定 | `8204736` | 已交付 parity-evidence 文档（V1 模型→V2 行模型逐项映射 + 9 点 Oracle 对齐）与 migration 0007（member 索引）。**阻塞裁定请求**：member 行的增量读改写需要 staged read 按成员键读取，而方案 §2.2 约束「每 rowKind 唯一键数 ≤ 本页事件数」在「每事件多条 observations 指向不同成员」时可被超出（50 事件 × 3 observations → 150 member 键 > 50）。需裁定：member 类读取是否按行类别放宽（仅保留 50 绝对上限），或维持事件数上限（member 聚合改为读侧计算）。未裁定前不实现 member 读改写（不猜测契约）。 |
| T12–T16 | ⏳ 待执行 | — | 见 rev6 计划对应章节。T12/T13 预计受同一裁定影响（多 evidence 域）。 |

## 2. 实际测试命令与结果

| 命令 | 运行时 | 结果 |
|---|---|---|
| `node --test tools/reliable-drive-sync-mcp/test/local-outbox-v2.test.mjs tools/reliable-drive-sync-mcp/test/delivery-service-v2.test.mjs` | Node 22.22.2 | 19/19 |
| 同上 | Node 26.7.0 | 19/19 |
| `node --test tools/reliable-drive-sync-mcp/test/*.test.mjs` | Node 22.22.2 | 71/71 |
| `node --test test/rds2-routes.test.js test/rds2-tasks.test.js test/rds2-io.test.js` | Node 22.22.2（D1 双绑定） | 39/39 |
| `node --test test/*.test.js`（G2 关闭前完整口径） | Node 22.22.2 / Node 26.7.0 | 626/626 双绿 |
| T09 红灯 | Node 22.22.2 | 模块缺失红 → 租约恢复/purge/confirm 失败语义业务红 → 修复绿 |
| T09 修复后（复审两项阻断） | Node 22.22.2 / Node 26.7.0 | 19/19 双绿（新增错关联三红灯 + alias 合法去重 + 唤醒自续期 + close 竞态） |
| `test/rds2-routes.test.js` | Node 22.22.2（D1 双绑定） | 8/8 |
| `tools/test/v2-routing.test.mjs` | Node 22.22.2 | 5/5 |

T10 测试：`test/rds2-routes.test.js` 8 例（双绑定 16 次执行全绿）+ `v2-routing.test.mjs` 5 例。

## 3. 阻塞、技术债务与未验证内容

**阻塞**：无。

**技术债务（不阻断）**：
1. 注入替身只能用转发式对象（`Object.create` 无法访问类私有字段）。
2. T09 的 `send` 是注入点，未做真实 HTTP 集成（T10 已接 `/v2/events` 端点路径，端点尚未在 worker 侧实现——见未验证 3）。
3. V1 与 V2 outbox 并存，WriteVersion 切换策略待验证（配置层已支持）。
4. 变异建议：rowKeys 元素形状层、`plan.reads` 数组层、`plan` 非 null 层各自单独变异。
5. `200-event` 用例 workerd 长跑偶发（seed 阶段 `request_id_conflict`、428ms 快速失败）；首败证据已留档，按节奏只独占复跑一次。

**未验证**：
1. `stdio-bridge` 的 V2 模式为代码接线 + 单元级（v2-routing 5 例），未做真实 MCP stdio 端到端。
2. `/v2/events` 写端点在 worker 侧未实现 HTTP 暴露（V2 写入的 HTTP 形状今晚未在 T10 规格内，端点路径为合理推断，明早确认）。
3. `handleV2Queue`/`handleV2Scheduled` 未跑真实 Workers 运行时（仅单元级 mock batch）。
4. projection.read 的 interview 委托路径数据仍来自 V1 Drive（T12 迁移后替换）。

## 4. 当前工作区状态

- HEAD：`8204736`（T11 前置），之前：`aaf4c57`（T10）← `289283c`/`3c2aead`（T09 修复）← `658840d`（T09）← `ef42303`（G2 关闭）← `7a55cb7`/`6d8ea0d`/`36bc8e6`/`e0fbbf7`/`3856eff`（P1-4）…（完整链见 git log）。
- 工作树：干净；仅三份未跟踪文档（两份审核文档 + 本交接文档）。
- 未 push、未部署、未创建远程资源、未执行远程迁移、未触碰主仓库 Rev4 遗留。

## 5. 明早综合审核重点与待批准远程动作

**审核重点**：
1. T09 `confirm` 的 canonical/alias 核对协议是否符合既有去重协议（重点：alias 收据接受 canonical eventId 而非本地声明——是否与 worker 端 decideIntent 的行为完全对齐）。
2. T10 `projection.read` 的游标协议（HMAC payload 字段集、15 分钟 TTL、revision 绑定）与 §5 的逐字段响应契约。
3. `handleV2Queue` 的 ack/retry 语义与「单消息/预算」约束是否满足 §5.3.2（消费者接线是 T10 新增的生产入口）。
4. interview 两操作委托 V1 的边界（T12 前的临时形态）。

**待批准的远程动作（今晚均未执行）**：
1. `wrangler d1 migrations apply`（0007 及以后的远程迁移，需乔授权）。
2. Worker 部署（wrangler deploy）。
3. RDS2_PROJECTION_QUEUE / RDS2_ARCHIVE_QUEUE 队列绑定与真实创建。
4. push `feat/rds2-v2`。
5. T15 的插件安装与客户端真实切换。

**执行纪律回顾**：未 push/未部署/未动远程；每任务独立提交、显式列文件；文档-only 提交未跑全量；已知 flaky 按纪律处理（首败证据留档）。
