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
- `ACCOUNT_OPERATIONS_ENABLED=false`
- `ACCOUNT_SELF_REGISTER_ENABLED=false`

## 部署后无凭据健康检查

- `POST /v1/jobs` → HTTP 410，返回 `v1_retired`。
- `POST /v2/query` 空请求 → HTTP 400，返回 `invalid_params`。
- `POST /v2/events` 空请求 → HTTP 401，返回 `invalid_credential`。

## 未执行事项

远程合成 canary 尚未执行：当前受控环境未提供合成用户凭据、事件文件和确认变量。不得使用生产密钥猜测、不得把真实用户加入白名单。下一步需通过安全凭据渠道创建或取得合成凭据后，按发布 Runbook §4 执行一次 `--remote --confirm-remote` canary，并观察 Queue/DLQ、`needs_attention`、预算和 Drive readback；在此之前不扩大公开注册或白名单。

本记录不包含任何 token、密码、SQL 参数或 Drive 内容。
