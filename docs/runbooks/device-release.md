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

远程动作（Queue、迁移、部署、公开开关）不属于本任务自动执行范围。

本轮本地候选验证：生产配置保持 V1 写入关闭，同时显式开启动态用户授权和自助注册；限流盐值只从 Wrangler Secret 注入，缺失时注册请求 fail-closed。
