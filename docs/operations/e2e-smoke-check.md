# 端到端冒烟验证记录

验证时间：2026-08-12（UTC）

## 已验证边界

1. 本机 MCP Server 启动并暴露 `submit_event`。
2. MCP 事件写入 SQLite Outbox，并在 Worker 约 1.1 秒响应时正确识别 `202`。
3. Worker 将事件持久化到 D1，并成功发布到 QStash。

验证事件：

```text
1aaa296b-9b35-4546-8dbd-8d97d81a9e8d:deployment-smoke:c9a0e044-400d-4bfe-8a99-46e76fbf6659
```

验证时的 D1 状态为 `broker_queued`，有 QStash `broker_message_id`，且 `last_error_code` 为空。

## 待恢复的外部边界

QStash 尚未投递上述消息到 `/v1/sync`；D1 中不存在失败回调通知。不要手工重发 `broker_queued` 的事件，因为发布已被确认，重复发布会破坏不重复投递栅栏。

在 Upstash QStash Console 的 Messages 页面，按 D1 中的 `broker_message_id` 查找消息，并确认：

1. 目标 URL 是 `https://reliable-drive-sync.qiaobingyuan886.workers.dev/v1/sync`。
2. 投递结果、HTTP 响应码与下一次重试时间。
3. Cloudflare 的 `QSTASH_CURRENT_SIGNING_KEY`、`QSTASH_NEXT_SIGNING_KEY` 与该 QStash 项目的 Signing Keys 完全对应。

修复外部投递配置后，QStash 会对已经 `broker_queued` 的消息继续投递；无需修改 D1 或 Drive 中已有文件。
