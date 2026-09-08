# RDS2 T14 预算、规模与故障证明

状态：本地验证完成；未执行远程部署、迁移、Queue 创建或生产切换。

本记录只引用仓库内已经存在的可重复测试与提交，不把历史口头结果当作本轮新测量。所有预算均以一次 invocation 创建的同一个 `createInvocationIo`/budget 为边界，产品硬上限为 40；Cloudflare 50 次外部子请求限制只作为额外安全余量，不作为可用预算。

## 1. 入口预算与 trace

| 场景 | 测试 | 断言 | 结果 |
|---|---|---|---|
| D1、Queue、HTTP 共用一份预算 | `rds2-budget-entrypoints.test.js` / `T14 a normal invocation records every outbound category under one budget` | trace 只有 `d1, queue, http`，不含 payload/credential | 通过 |
| 39 次已用后申请 2 次 | `T14 requesting two calls with only one unit left emits nothing` | 在外发前抛 `budget_exhausted`，底层调用数为 0 | 通过 |
| Queue batch 计费 | `T14 a queue batch charges one unit per message and preserves closed-set trace fields` | 3 条消息计 3 次；trace 字段闭集 | 通过 |
| 构建页规模 | `rds2-scale.test.js` 三项测试 | 100/10,000/100,000 历史的单页读成本恒为 2；50 键边界先计价；第 51 键只消费合法前缀 | 通过 |

trace 只在真实 I/O 包装边界写入；`budget.consume` 本身不被当成外发证据。`batch` 按一次外部调用计费，消息批量上限由各入口另行限制。

## 2. 故障分类

| 类别 | 语义 | 测试 |
|---|---|---|
| A | 正常等待、预算主动不足、前序未就绪 | `rds2-storage-error.test.js` 的 `budget_exhausted keeps the approved A semantics` |
| B | 租约/CAS/顺序竞态，暂缓且不增加真实失败计数 | `F2 lease and CAS conflicts are class B`；`rds2-projection-engine.test.js` 的 out-of-order 用例 |
| C | 未识别或临时存储故障，有限退避并累计 `failure_count` | `rds2-faults.test.js` / `T14 a transient fault is bounded...` |
| D | 稳定契约、大小、游标或形状错误，停车 `needs_attention`，不盲目重试 | `rds2-faults.test.js` / `T14 a deterministic contract fault parks...`；storage-error 闭集分类测试 |
| E | 连收尾预算都不足或收尾本身失败，返回稳定错误，不谎报已持久化 | `rds2-faults.test.js` / `T14 an exhausted close-out budget...`；`rds2-close-out.test.js` |

故障日志只允许脱敏结构化字段（时间、截断 taskId、类别、稳定 code、结果和计数）。原始 SQL、绑定参数、凭据与错误 message 不进入日志。

## 3. 关键业务路径的既有证明

- 接收：`rds2-accept.test.js` 覆盖正常写、同 requestId 重放、event alias、request/event/eventKey 冲突、唯一约束竞态重查、整批回滚和零 I/O 拒绝。
- Queue/恢复：`rds2-tasks.test.js` 覆盖退避门槛、重复消息、过期租约、旧 owner、5 次真实故障停车、4 项恢复预算与 DLQ。
- Drive 归档：`rds2-archive.test.js` 覆盖 OAuth 缓存、先查后传、readback hash、丢响应重查、歧义同名、内容损坏、旧 owner 和重放。
- 查询：`rds2-routes.test.js` 覆盖六类查询、游标越权/过期、版本变化、limit 上限、缺凭据/空白名单 fail-closed，以及读路径不创建任务。

这些套件证明各边界行为；本文件不把它们改称为真实云端流量或生产压测。

## 4. 可重复命令与记录

在 `services/reliable-drive-sync-worker` 目录运行：

```text
node --version
node --test --test-concurrency=1 test/rds2-budget-entrypoints.test.js test/rds2-faults.test.js test/rds2-scale.test.js
node --test --test-concurrency=1 test/rds2-accept.test.js test/rds2-tasks.test.js test/rds2-archive.test.js test/rds2-routes.test.js test/rds2-io.test.js
```

T14 专项本轮结果：**9/9 通过，Node v26.7.0，退出码 0**。提交 `dc5bd4f` 已包含三份专项测试；后续 T11–T13 接线提交分别为 `bf5ef0b`、`0bd8d1f`、`214f177`。

未声称的范围：真实 Cloudflare 生产 binding、真实 Drive、远程 Queue 运行时和完整 HTTP 入口的线上 trace，必须在 T16 获得独立授权后再验证。
