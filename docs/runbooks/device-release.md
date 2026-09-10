# RDS2 device-binding release runbook

候选版本由 `tools/reliable-drive-sync-mcp/build-device-release.mjs` 生成，运行时开关默认关闭：

```text
RDS2_QUERY_ENABLED=true
RDS2_WRITE_ENABLED=true
RDS2_DYNAMIC_USER_AUTH_ENABLED=true
ACCOUNT_OPERATIONS_ENABLED=true
ACCOUNT_SELF_REGISTER_ENABLED=true
# ACCOUNT_RATE_LIMIT_SALT: Wrangler secret, required before deploy
```

发布前必须保存并验证 D1、旧 V1 Outbox、V2 Outbox 和设备控制库的恢复副本；必须先暗部署，再迁移，再隔离 canary，最后才可在独立授权后公开开启注册。失败时只关闭新增开关，不删除任何数据，不恢复姓名唯一约束。

远程动作（Queue、迁移、部署、公开开关）默认需要单独授权；本次已获得授权并完成部署，后续变更仍须重新确认。

本轮本地候选验证：生产配置保持 V1 写入关闭，同时显式开启动态用户授权和自助注册；限流盐值只从 Wrangler Secret 注入，缺失时注册请求 fail-closed。

## 已完成的生产复验（2026-09-10）

- `ACCOUNT_RATE_LIMIT_SALT` 已作为 Wrangler Secret 写入，未出现在 TOML、日志或回执中。
- 生产 Worker 已发布版本 `642f88e7-6adc-4cf0-99c5-e092db1f4365`。
- 使用临时合成账号验证 `account.register`（201）→ V2 事件接收（200 / `d1_committed`）→ projection、原始事件归档和增量归档全部完成。
- 合成账号凭据只在本机进程中生成和使用，不纳入文档或聊天记录。
