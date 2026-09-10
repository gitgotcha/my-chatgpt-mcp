# RDS V2 生产发布记录

日期：2026-09-09  
Worker：`reliable-drive-sync`  
来源提交：`2820808f8a95a6163d5949bc062f11cf1186d462`  
来源分支：`feat/unified-submit-event-device-binding`  
Wrangler：4.130.0

## 已执行

- GitHub 已推送运行时分支 `feat/unified-submit-event-device-binding`。
- GitHub 已推送技能分支 `resume-knowledge-normalization`。
- 远程 D1 已应用 `0008_rds2_device_accounts.sql`；复核结果为无待应用迁移。
- 已确认四条 Queue/DLQ 存在，两个主队列各有 producer/consumer，两个 DLQ 各有 consumer。
- 已用 `wrangler.production.toml` 完成 dry-run，产物 348.49 KiB（gzip 71.29 KiB）。
- Worker 已部署，版本 ID：`8c6b5e61-cc94-477b-9b63-3e6acd716d79`。

## 生产开关

- `V1_WRITE_ENABLED=false`
- `V1_RETIRED=true`
- `RDS2_WRITE_ENABLED=true`
- `RDS2_QUERY_ENABLED=true`
- `RDS2_PROJECTION_ENABLED=true`
- `RDS2_ARCHIVE_ENABLED=true`
- `RDS2_RECOVERY_ENABLED=true`
- `RDS2_DYNAMIC_USER_AUTH_ENABLED=true`
- `ACCOUNT_OPERATIONS_ENABLED=true`
- `ACCOUNT_SELF_REGISTER_ENABLED=true`

`ACCOUNT_RATE_LIMIT_SALT` is a Wrangler secret and must be present before
deployment. It is intentionally absent from the production TOML and from
all logs. New active users are authorized from the credential-to-user row;
the static allowlist remains only as the fail-closed fallback when the
dynamic flag is disabled.

## 部署后无凭据健康检查

- `POST /v1/jobs` → HTTP 410，返回 `v1_retired`。
- `POST /v2/query` 空请求 → HTTP 400，返回 `invalid_params`。
- `POST /v2/events` 空请求 → HTTP 401，返回 `invalid_credential`。

## 未执行事项

远程合成 canary 尚未执行：当前受控环境未提供合成用户凭据、事件文件和确认变量。不得使用生产密钥猜测、不得把真实用户加入白名单。下一步需通过安全凭据渠道创建或取得合成凭据后，按发布 Runbook §4 执行一次 `--remote --confirm-remote` canary，并观察 Queue/DLQ、`needs_attention`、预算和 Drive readback；在此之前不扩大公开注册或白名单。

本记录不包含任何 token、密码、SQL 参数或 Drive 内容。

## 2026-09-10 自助注册与 V2 全链路复验

- 运行时提交 `80f988d` 已推送到 `feat/unified-submit-event-device-binding`；插件仓库 `my-chatgpt-skills` 已推送至 `bf33941`。
- 先发布移除旧明文变量的配置版本 `e5b67c4f-b86f-4cc4-934b-2619dd28b5fe`，再以 Wrangler Secret 写入 `ACCOUNT_RATE_LIMIT_SALT`，随后正式发布版本 `642f88e7-6adc-4cf0-99c5-e092db1f4365`。
- 生产开关保持：V1 写入关闭、V2 写入/查询/投影/归档/恢复开启、动态用户鉴权开启、账户操作与自助注册开启；静态白名单仍保留为动态鉴权关闭时的回退闸门。
- 合成自助注册复验：`account.register` 返回 HTTP 201，生成 active 用户；随后同一凭据提交 `algorithm.learning.completed` 返回 HTTP 200、`cloudPersistence=d1_committed`。
- 远端 D1 复核：projection、archive_event、archive_delta 三类任务均为 `completed`；事件原件与投影增量均已获得 Drive 文件 ID 和 `delivered_at`；算法投影 revision=1。
- 本次新增合成账号仅用于验收，未写入任何真实用户凭据；凭据只存在于本机进程内，未进入日志或文档。

本增量记录同样不包含 token、密码、事件正文或 Drive 内容。
