# Google Drive 生产配置设计

## 目标与当前边界

`reliable-drive-sync` 的 Cloudflare Worker、D1 和 QStash 已就绪。此配置阶段只补齐 Worker 写入 Google Drive 所需的长期授权和目录边界；不改变同步协议、队列状态机或本地 MCP。

目标是让同步 Worker 可以在无需人工重复登录的情况下：

1. 将每一条不可变事件 JSON 写入专用的 `events` 目录。
2. 将聚合快照 JSON 写入专用的 `snapshots` 目录。
3. 在后续增加新资料类型时，为其增加独立目录 ID 配置，而不是把文件混在一个目录中。

## 已确认的目录模型

Google Drive 中创建一个人工可读的根目录：

```text
Reliable Drive Sync/
├── events/       <- DRIVE_EVENTS_PARENT_ID
├── snapshots/    <- DRIVE_SNAPSHOTS_PARENT_ID
└── future-xxx/   <- 未来按需增加 DRIVE_FUTURE_XXX_PARENT_ID
```

根目录只用于人工整理，不会由 Worker 直接写入。Worker 只使用两个子目录 ID，因此可以把事件与快照的保留、审计或迁移策略分开。每个 ID 都是普通配置变量而非 Secret；拥有该 ID 本身不能访问 Drive 文件。

新增一种文件类型时，先创建对应子目录并加一个显式变量，再在适配器中将该文件类型映射到该变量。这样目录范围清楚，也不会因“动态目录名”绕过配置审查。

## 授权方案选择

采用 **OAuth 2.0 Web Client + Refresh Token**：

- Cloudflare 仅保存 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REFRESH_TOKEN` 三个 Secret。
- Worker 每次需要时用 refresh token 换取短期 access token；access token 不保存为部署配置。
- 初次授权借助 Google OAuth Playground，使用项目自己的 OAuth Client。Playground 只用于生成授权码和 refresh token，运行时流量仍是 Worker 直接访问 Google OAuth 和 Drive API。

该项目需要列出、读取和写入由用户手工创建的专用目录，因此本版本使用 `https://www.googleapis.com/auth/drive` scope。它比 `drive.file` 宽，但避免 `drive.file` 对“应用创建或用户通过 Picker 选择的文件”的访问边界导致手工创建父目录不可用。只将授权授予专用 Google 账号，并只在该账号 Drive 中创建上述目录。

不选择两种替代方案：

- 只填 `GOOGLE_DRIVE_ACCESS_TOKEN`：约一小时后失效，不能用于无人值守同步。
- Service Account：可把专用目录共享给服务账号，权限边界更窄；但现有 Worker 未实现服务账号 JWT 授权，属于下一期独立功能。

## Google Cloud 配置流程

1. 使用专用 Google 账号创建一个 Google Cloud Project，并启用 Google Drive API。
2. 配置 OAuth consent screen，将这个专用账号加入测试用户（若控制台要求）。
3. 创建 **Web application** 类型的 OAuth Client，并把 OAuth Playground 回调地址 `https://developers.google.com/oauthplayground` 加入 Authorized redirect URIs。
4. 在 OAuth Playground 的设置中选择 “Use your own OAuth credentials”，填入该 Client ID 和 Client Secret；请求上面的 Drive scope，完成授权并交换 refresh token。
5. 不将 OAuth client secret 或 refresh token 粘贴到聊天、Git、`wrangler.toml` 或 `.env.example`；只写入 Cloudflare Workers Secrets。

OAuth consent screen 不能长期停留在 Testing：Google 对外部应用在 Testing 状态下、使用非基础身份 scope 的 refresh token 通常有七天有效期。上线前应在 Google Cloud Console 中将应用切换到 Production；如果 Google 要求额外验证，先停在该步骤，不绕过提示或降低安全性。参见 Google 的 [OAuth for web-server apps](https://developers.google.com/identity/protocols/oauth2/web-server) 与 [OAuth policies](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)。

## Cloudflare 配置模型

在 Worker 的 Settings → Variables and Secrets 中设置：

| 类型 | 变量 | 说明 |
| --- | --- | --- |
| Secret | `GOOGLE_CLIENT_ID` | OAuth Client ID |
| Secret | `GOOGLE_CLIENT_SECRET` | OAuth Client Secret |
| Secret | `GOOGLE_REFRESH_TOKEN` | 长期刷新令牌 |
| Plain text variable | `DRIVE_EVENTS_PARENT_ID` | `events` 文件夹 ID |
| Plain text variable | `DRIVE_SNAPSHOTS_PARENT_ID` | `snapshots` 文件夹 ID |

前述 D1、QStash 和 ingress 变量保持不变。文件夹 ID 也可以在 `wrangler.toml` 的 `[vars]` 中保留为非敏感部署配置；生产值仍以 Cloudflare 已部署变量为准。

## 配置后行为与故障处理

配置缺失（例如未填文件夹 ID 或 OAuth Secret）时，Worker 会把同步暂时判为可重试，不会把已入队事件误标为永久失败。Google OAuth 的 5xx 和 429 同样保留重试机会；明确的 OAuth 4xx 或 Drive 权限错误才会进入 `needs_attention` 并生成通知。

验证顺序：

1. 在 Drive 中确认 `events` 与 `snapshots` 两个空目录存在，复制各自 URL 中的 ID。
2. 写入 Cloudflare 变量和 Secret 后，提交一条新的测试事件。
3. 在 D1 中确认它从 `broker_queued` 最终成为 `synced`。
4. 在 Drive 中确认生成一条事件 JSON 和一个对应快照 JSON。

旧的、在 Drive 尚未配置前留下的安全栅栏记录不会被自动重投；它们保持可审计，后续由受控的内部 remediation/replay 流程处理。

## 安全与验收标准

- Git 工作树、文档、终端输出和聊天中不出现 Client Secret、refresh token 或 access token。
- Cloudflare Secrets 中的三个 OAuth 值可读不可回显；文件夹 ID 仅为普通变量。
- Google 授权只使用专用账号，且 scope 与目录设计一致。
- 一条新事件可端到端进入专用 Drive 文件夹；异常不会丢失事件，也不会把临时配置问题变成永久失败。
