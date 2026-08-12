# 新电脑从零配置 Reliable Drive Sync（Windows）

这份步骤只配置本地 Codex MCP。Cloudflare Worker、D1、QStash 都已在云端运行，**不要**把 QStash Token 或 Cloudflare Secret 复制到新电脑。

## 0. 从当前电脑带走什么

当前 Git 仓库没有配置远程地址，因此先将完整项目目录复制到新电脑，例如解压为 `C:\ReliableDriveSync`。复制时排除 `node_modules` 和 `dist` 以减小体积；它们会由后续命令重新生成。

还需要通过密码管理器或其他安全方式传递一项值：当前 Worker 的 `INGRESS_SHARED_SECRET`。不要通过聊天、邮件正文、Git、截图或 `.env.example` 传递它。

## 1. 安装基础环境

以普通 PowerShell 打开并执行：

```powershell
winget install --id Git.Git -e --source winget
winget install --id OpenJS.NodeJS.LTS -e --source winget
```

安装完成后关闭并重新打开 PowerShell，确认 Node 版本至少为 22：

```powershell
node --version
corepack enable
corepack prepare pnpm@10.20.0 --activate
pnpm --version
```

安装并登录 Codex Desktop。首次启动后关闭 Codex，后续步骤会写入它的本机配置文件。

## 2. 构建项目

项目目录固定为 `C:\ReliableDriveSync` 时执行：

```powershell
Set-Location C:\ReliableDriveSync
pnpm install --frozen-lockfile
pnpm build
pnpm verify:build
```

`pnpm test` 可选，但推荐首次迁移时执行。

```powershell
pnpm test
```

## 3. 设置本地环境变量

先在密码管理器中复制入口密钥到剪贴板，再运行下列命令。脚本不会显示密钥；它把值写入当前 Windows 用户的环境变量。完成后重启 Codex 才会生效。

```powershell
$ingressSecret = Get-Clipboard
if ([string]::IsNullOrWhiteSpace($ingressSecret)) {
  throw "剪贴板没有入口密钥；请从密码管理器复制后重试。"
}

$outboxDirectory = Join-Path $env:LOCALAPPDATA "ReliableDriveSync"
New-Item -ItemType Directory -Force -Path $outboxDirectory | Out-Null
[Environment]::SetEnvironmentVariable(
  "RELIABLE_DRIVE_SYNC_INGRESS_URL",
  "https://reliable-drive-sync.qiaobingyuan886.workers.dev/v1/jobs",
  "User"
)
[Environment]::SetEnvironmentVariable(
  "RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET",
  $ingressSecret,
  "User"
)
[Environment]::SetEnvironmentVariable(
  "RELIABLE_DRIVE_SYNC_OUTBOX_PATH",
  (Join-Path $outboxDirectory "outbox.sqlite"),
  "User"
)
Remove-Variable ingressSecret
```

## 4. 注册本地 MCP 服务

确认 Codex 已关闭后，执行一次：

```powershell
$codexDirectory = Join-Path $HOME ".codex"
$codexConfig = Join-Path $codexDirectory "config.toml"
New-Item -ItemType Directory -Force -Path $codexDirectory | Out-Null

@'

[mcp_servers.reliable_drive_sync]
command = "node"
args = ["C:\\ReliableDriveSync\\packages\\mcp-server\\dist\\index.js"]
'@ | Add-Content -LiteralPath $codexConfig
```

然后启动 Codex，打开 `C:\ReliableDriveSync` 项目。MCP 服务会以 stdio 方式启动并继承第 3 步的用户环境变量；它提供 `submit_event` 工具。

> 仅适用于全新 Codex 配置。如果已经有同名 `[mcp_servers.reliable_drive_sync]` 区块，先删除旧区块再添加，避免 TOML 重复定义。

## 5. 验证

在 Codex 中让助手调用 `submit_event` 提交一个无敏感信息的测试事件。预期结果包含：

```json
{ "accepted": true, "deliveryState": "cloud_accepted" }
```

若没有网络或入口密钥错误，事件仍会保存在 `%LOCALAPPDATA%\ReliableDriveSync\outbox.sqlite`，待下一次成功时重发；这正是本地 Outbox 的兜底作用。

## 常见问题

- `Ingress is not configured`：重启 Codex，检查两个 `RELIABLE_DRIVE_SYNC_INGRESS_*` 用户变量都存在且非空。
- `401`：新电脑上的入口密钥与 Cloudflare 的 `INGRESS_SHARED_SECRET` 不一致。不要猜测，使用安全保存的原值；丢失时在当前电脑轮换密钥，并同步更新每台设备。
- `node` 找不到：重新打开 PowerShell/Codex，确认 `node --version` 有输出。
- 不要在新电脑执行 `wrangler secret put`：那会改动云端密钥，不是迁移本地 MCP 所需步骤。
