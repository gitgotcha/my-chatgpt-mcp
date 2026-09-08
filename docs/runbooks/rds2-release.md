# Reliable Drive Sync V2 发布 Runbook

本 runbook 只描述可审计的发布顺序。当前默认配置是暗部署（V2 五个开关均为 `false`），任何远程资源创建、D1 迁移、Worker 部署、Queue 绑定、Drive 访问或关闭 V1 的动作，都必须在单独的人工确认后执行。本地测试和 dry-run 不会访问真实 Drive。

## 0. 发布记录与停止条件

发布前记录以下事实，不把凭据写入文件、命令行历史、日志或提交：

- `git rev-parse HEAD` 的完整 SHA、当前分支和工作树状态；
- `npx wrangler --version`、Node 版本、测试命令与退出码；
- 四条 Queue 的名称、存在性和 DLQ 绑定；D1 迁移版本；Worker 部署版本；
- 本次开关值、允许的 namespace/userId 白名单、回滚目标版本；
- 每一步的操作者、时间和结果。

出现任一情况立即停止并保留证据：测试失败、dry-run 失败、资源名称不一致、D1 迁移版本不明确、allowlist 为空、凭据缺失、预算超过 40、Drive readback 不一致、`needs_attention` 增长或无法判断状态。不得用猜测或重试掩盖失败。

## 1. 一次性远程前置（需再次确认）

以下命令会改变远程资源，默认不执行。确认后逐条执行并保存输出：

```powershell
npx wrangler queues create rds2-projection
npx wrangler queues create rds2-archive
npx wrangler queues create rds2-projection-dlq
npx wrangler queues create rds2-archive-dlq
npx wrangler d1 migrations apply reliable-drive-sync --remote --config services/reliable-drive-sync-worker/wrangler.toml
```

确认 `wrangler.toml` 中的两个主队列分别指向自己的 DLQ，四个 consumer 的 `max_batch_size = 1`，并确认 V1 原有三条 cron 逐字节保留，V2 使用 `2-57/5 * * * *`。资源创建成功不等于业务已同步；仍需完成后续 canary。

## 2. 本地验证（无远程副作用）

在仓库根目录执行：

```powershell
node --test services/reliable-drive-sync-worker/test/rds2-release-config.test.js
node --test services/reliable-drive-sync-worker/test/rds2-budget-entrypoints.test.js services/reliable-drive-sync-worker/test/rds2-faults.test.js services/reliable-drive-sync-worker/test/rds2-scale.test.js
Push-Location services/reliable-drive-sync-worker
npm test
Pop-Location
```

再做 Worker 打包 dry-run。输出目录必须是本次命令明确指定的新目录；只检查其内容，不删除未知目录：

```powershell
npx wrangler deploy --dry-run --config services/reliable-drive-sync-worker/wrangler.toml --outdir .rds2-dry-run
```

本地 canary 必须显式选择 `--local`，并使用仅用于本地验证的临时凭据和合成 allowlist。成功结果只能表示 `dry_run`，不得声称已写入 D1、Queue 或 Drive：

```powershell
$env:RDS2_CANARY_CREDENTIAL = 'local-only-credential'
$env:RDS2_ALLOWED_USER_IDS = 'synthetic-user'
node tools/reliable-drive-sync-mcp/rds2-canary.mjs --local
```

`--remote`、缺凭据、空 allowlist、未明确用户或缺事件文件必须拒绝。PowerShell 脚本用 `powershell -File` 或 `pwsh -File` 调用；`.ps1` 文件不得交给 Node 解释器。

## 3. 十步发布顺序

1. **本地测试**：记录双运行时可复现的测试数量、版本和退出码；失败即停止。
2. **暗部署**：部署代码但保持 `RDS2_WRITE_ENABLED`、`RDS2_QUERY_ENABLED`、`RDS2_PROJECTION_ENABLED`、`RDS2_ARCHIVE_ENABLED`、`RDS2_RECOVERY_ENABLED` 全为 `false`；V1 路径行为不变。
3. **合成用户准备**：单独初始化合成用户凭据，记录其 userId；不得把真实用户加入白名单。
4. **合成 canary**：按接收→投影→归档→读取逐步打开四个功能开关，每一步先验证关闭时拒绝，再验证打开后只放行合成用户。
5. **单客户端 MCP 切换**：仅在本地显式设置 `RELIABLE_DRIVE_SYNC_WRITE_VERSION=v2` 和独立绝对 Outbox 路径；V2 accepted 后不得回退到 V1。
6. **真实 algorithm canary**：只放行 `algorithm` namespace 与已确认的合成/目标 userId，重复提交一次确认幂等，不扩大白名单。
7. **其余领域**：profile、interview、resume-knowledge 各自通过领域不变量和预算门后再独立启用；不一次性全开。
8. **Skill/插件**：逐个确认读走 `/v2/query`、写走 `/v2/events`，写入失败保持本地 Outbox 状态，不伪造 Drive 已同步。
9. **稳定观察**：至少观察 24 小时的最老等待时长、`needs_attention`、预算最大值、Queue/DLQ、D1 与 Drive readback；任何异常按停止条件处理。
10. **二次确认关闭 V1**：确认 V2 接收、投影、归档、状态查询均通过生产 canary，并逐条处置 V1 pending 后，才可再次确认关闭 V1 接收。关闭是单向发布动作，不能与本地切换同一步执行。

## 4. 远程 canary 命令（需独立确认）

远程模式必须明确提供 URL、事件文件、用户和确认标志；凭据从受控环境变量读取，不放在命令参数中：

```powershell
$env:RDS2_CANARY_CONFIRM = 'YES'
$env:RDS2_CANARY_CREDENTIAL = $env:CANARY_CREDENTIAL_FROM_SECRET_STORE
$env:RDS2_CANARY_URL = $env:CANARY_WORKER_URL_FROM_SECRET_STORE
$env:RDS2_ALLOWED_USER_IDS = 'synthetic-canary-user'
$canaryUserId = 'synthetic-canary-user'
node tools/reliable-drive-sync-mcp/rds2-canary.mjs --remote --user-id $canaryUserId --event-file '.\canary\algorithm-event.json' --confirm-remote
```

输出只允许包含 `requestId`、`eventId`、`jobId`、HTTP/outcome、`cloudPersistence` 和 Drive 异步状态，不得输出 token、密码、SQL、原始 payload 或 Drive 内容。`cloudPersistence: "d1_committed"` 只表示 D1 接收；Drive 仍以后台任务和 readback 为准。

## 5. 回滚与人工恢复

- 未发布：回退到本任务之前的已验证版本；不做破坏性 reset，不覆盖用户 worktree。
- 已发布：恢复上一部署版本并关闭 V2 功能开关；优先停止新增 V2 写入，让现有 V2 任务继续排空。
- 只有消费者本身故障时才暂停对应消费，并保留 D1 Outbox、Queue/DLQ 消息和审计记录；不要把 V2 pending 改投 V1。
- 不执行 `DROP TABLE`、删除 Queue、删除 Drive 文件、覆盖快照或清空白名单。空白名单表示 fail-closed 503。
- `needs_attention` 任务只能通过带审计原因的管理员重放或人工处理恢复；先确认 taskId、scope、attempt/failure_count 和最近错误码，再执行单任务操作。

## 6. 状态解释

`pending` 表示等待认领，`dispatching` 表示已认领待发，`queued` 表示已发 Queue，`processing` 表示消费者已开始，`completed` 表示业务效果已提交，`needs_attention` 表示超过重试阈值或确定性契约错误需要人工处理。Outbox 的 `acknowledged` 只表示本机已核对云端回执；Drive 同步必须依据归档任务状态和 readback 证据判断。
