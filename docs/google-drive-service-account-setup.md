# Google Drive 服务账号配置

本指南让已部署的 `reliable-drive-sync` Worker 以 Google Cloud Service Account 的身份写入两个指定 Drive 文件夹。不需要 OAuth Playground、Client Secret 或 Refresh Token。

## 配置完成检查表

- [ ] 只有 `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` 被写入 Cloudflare Secret。
- [ ] `GOOGLE_SERVICE_ACCOUNT_EMAIL`、`DRIVE_EVENTS_PARENT_ID`、`DRIVE_SNAPSHOTS_PARENT_ID` 是 Cloudflare Text variables。
- [ ] Git、聊天、终端输出、文档和截图中没有服务账号 JSON、私钥、OAuth token 或 Client Secret。
- [ ] 服务账号只作为“编辑者”被共享给 `events` 和 `snapshots`，不共享根目录或其他 Drive 内容。
- [ ] 使用全新、非敏感事件验证；D1 job 最终为 `synced`，两个文件夹均出现 JSON。

## 现有文件夹

| 变量 | 值 | 文件夹用途 |
| --- | --- | --- |
| `DRIVE_EVENTS_PARENT_ID` | `1ZZRD4a1Z93NT1OGKbRkLPu13TsHbDsF8` | 一条事件对应一个不可变 JSON |
| `DRIVE_SNAPSHOTS_PARENT_ID` | `1bAokejGSIdn2oLCWPjDgSb3xbiX0r999` | 聚合快照 JSON |

它们是普通 ID，不是凭据；只有获得 Drive 目录共享权限的身份才能使用它们读取或写入文件。

## 1. 创建服务账号和私钥

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，选择 `Reliable Drive Sync` 项目。
2. 进入 **IAM & Admin → Service Accounts**。
3. 点击 **Create service account**，名称填写 `reliable-drive-sync-worker`，点击创建/继续；不需要授予项目 IAM 角色。
4. 在服务账号列表中打开刚创建的账号，进入 **Keys**。
5. 选择 **Add key → Create new key → JSON → Create**。浏览器会下载一个 JSON 文件。
6. 仅在自己的安全界面中打开这个文件，准备其中两个字段：
   - `client_email`：服务账号邮箱。
   - `private_key`：完整 PEM，包括开头、结尾及所有换行。

不要把 JSON 文件上传到仓库、Drive 或聊天。完成 Cloudflare 填写后，用操作系统“回收站”删除下载文件；若怀疑泄漏，直接删除该 Key 并按“轮换私钥”章节操作。

## 2. 仅共享两个 Drive 子目录

服务账号创建后会有一个类似 `reliable-drive-sync-worker@<project>.iam.gserviceaccount.com` 的邮箱。

1. 打开 `events` 文件夹，在右上角选择 **共享**。
2. 添加该服务账号邮箱，角色选择 **编辑者（Editor）**，发送/保存。
3. 打开 `snapshots` 文件夹，重复同样操作。

不要共享 `Reliable Drive Sync` 根目录，也不要共享个人 Drive 的其他文件夹。Worker 会自动读取和写入这两个指定子目录。

## 3. 在 Cloudflare 设置绑定

打开 Cloudflare Dashboard → **Workers & Pages → reliable-drive-sync → Settings → Variables and Secrets**。添加下列四项后保存并部署：

| 类型 | 名称 | 填写值 |
| --- | --- | --- |
| Text | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | JSON 的 `client_email` |
| Secret | `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | JSON 的完整 `private_key` PEM |
| Text | `DRIVE_EVENTS_PARENT_ID` | `1ZZRD4a1Z93NT1OGKbRkLPu13TsHbDsF8` |
| Text | `DRIVE_SNAPSHOTS_PARENT_ID` | `1bAokejGSIdn2oLCWPjDgSb3xbiX0r999` |

保留已有的 D1、QStash、`INGRESS_SHARED_SECRET` 等绑定。不要配置 OAuth Client Secret、Refresh Token 或 `GOOGLE_DRIVE_ACCESS_TOKEN`；服务账号完整配置后会优先使用它。

Cloudflare Secret 保存后不可回显是正常的。不要为“检查是否保存”而覆盖私钥。

## 4. 部署后验证

1. 重新启动 Codex，让本地 MCP 使用当前 Worker ingress 设置。
2. 通过算法学习 Skill 提交一条新的、非敏感测试事件。
3. 在 Cloudflare D1 的 `sync_jobs` 中只查这条新 job：预期先为 `broker_queued`，最后为 `synced`。
4. 分别打开 Drive 的 `events` 和 `snapshots`：应出现新的事件 JSON 与包含该事件的快照 JSON。

不要重放 Drive 配置前遗留的 `dispatching` job；该状态是防止不确定 QStash 投递重复发布的安全栅栏。

如果 job 进入 `needs_attention`，只记录 job ID、状态及非敏感 `last_error_code`。常见原因：服务账号邮箱未共享给某个子目录、私钥不完整或绑定名称拼写错误。不要粘贴任何 Header、私钥或 token 来排错。

## 5. 轮换或撤销私钥

当私钥疑似泄漏，或按组织安全策略轮换时：

1. 在同一服务账号 **Keys** 页面创建一把新的 JSON Key。
2. 将新 JSON 的 `private_key` 替换到 Cloudflare `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` Secret 并部署。
3. 提交一条新的非敏感事件，确认它最终为 `synced` 且两个目录均有新 JSON。
4. 回到 Google Cloud，删除旧 Key；再从回收站移除旧 JSON 下载文件。

始终先验证新 Key，再删除旧 Key，避免同步中断。
