# Reliable Drive Sync：Windows 部署与接入命令

> 本文不包含任何密钥。密钥只在交互式命令中录入 Cloudflare，不能写入 Git、聊天、截图或 `.env` 文件。

## 0. 两种操作的区别

| 目标 | 是否修改云端 | 使用哪一节 |
| --- | --- | --- |
| 新电脑使用已运行的系统 | 否 | 第 1 节 |
| 修改代码后发布 Worker | 是 | 第 2 节 |

当前云端入口：`https://reliable-drive-sync.qiaobingyuan886.workers.dev/v1/jobs`。

## 1. 新电脑接入已部署系统

前提：将项目目录复制到新电脑的 `C:\ReliableDriveSync`。复制时排除 `node_modules` 和 `dist`；不要携带密钥文件。还需要通过密码管理器安全传递一项 `INGRESS_SHARED_SECRET`。

以普通 PowerShell 执行：

```powershell
$ErrorActionPreference = "Stop"

winget install --id Git.Git -e --source winget
winget install --id OpenJS.NodeJS.LTS -e --source winget

# 安装完成后请关闭并重新打开 PowerShell，再从这里继续。
node --version
corepack enable
corepack prepare pnpm@10.20.0 --activate

Set-Location C:\ReliableDriveSync
pnpm install --frozen-lockfile
pnpm build
pnpm verify:build
pnpm test

# 输入时不回显；输入的是与 Cloudflare INGRESS_SHARED_SECRET 相同的值。
$secureSecret = Read-Host "请输入 INGRESS_SHARED_SECRET" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
try {
  $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  if ([string]::IsNullOrWhiteSpace($secret)) { throw "INGRESS_SHARED_SECRET 不能为空" }

  $outboxDirectory = Join-Path $env:LOCALAPPDATA "ReliableDriveSync"
  New-Item -ItemType Directory -Force -Path $outboxDirectory | Out-Null

  [Environment]::SetEnvironmentVariable("RELIABLE_DRIVE_SYNC_INGRESS_URL", "https://reliable-drive-sync.qiaobingyuan886.workers.dev/v1/jobs", "User")
  [Environment]::SetEnvironmentVariable("RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET", $secret, "User")
  [Environment]::SetEnvironmentVariable("RELIABLE_DRIVE_SYNC_OUTBOX_PATH", (Join-Path $outboxDirectory "outbox.sqlite"), "User")
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  Remove-Variable secret -ErrorAction SilentlyContinue
}

# 完全关闭 Codex 后注册一次 MCP。若配置已存在同名区块，先手动删除旧区块。
$codexDirectory = Join-Path $HOME ".codex"
$codexConfig = Join-Path $codexDirectory "config.toml"
New-Item -ItemType Directory -Force -Path $codexDirectory | Out-Null

@'

[mcp_servers.reliable_drive_sync]
command = "node"
args = ["C:\\ReliableDriveSync\\packages\\mcp-server\\dist\\index.js"]
'@ | Add-Content -LiteralPath $codexConfig
```

完全重启 Codex。以后每次调用 `reliable_drive_sync.submit_event`，事件先写入新电脑本机的 `%LOCALAPPDATA%\ReliableDriveSync\outbox.sqlite`，再提交云端。

## 2. 从任意运维电脑重新部署云端

前提：该电脑有项目代码、Cloudflare 账号权限，以及安全保存的所有密钥。下面命令会更新现有 Worker 和已有 D1 数据库，不会创建新的 Worker 名称。

```powershell
$ErrorActionPreference = "Stop"
Set-Location C:\ReliableDriveSync

corepack enable
corepack prepare pnpm@10.20.0 --activate
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm verify:build

Set-Location .\packages\workers
pnpm exec wrangler login

# 仅应用尚未执行过的 D1 migration；重复执行是安全的。
pnpm exec wrangler d1 migrations apply reliable-drive-sync --remote

# 首次部署、密钥轮换或换账号时执行。每项会隐藏输入内容。
$secretNames = @(
  "INGRESS_SHARED_SECRET",
  "QSTASH_TOKEN",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN"
)

foreach ($name in $secretNames) {
  $secure = Read-Host "请输入 $name（输入不回显；可按 Ctrl+C 中止）" -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ([string]::IsNullOrWhiteSpace($value)) { throw "$name 不能为空" }
    $value | pnpm exec wrangler secret put $name
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    Remove-Variable value -ErrorAction SilentlyContinue
  }
}

pnpm exec wrangler deploy
```

`wrangler.toml` 已包含非敏感配置：Worker 名称、D1 绑定、QStash 地址、同步回调地址，以及 Drive 的两个顶层父文件夹 ID。不要把 OAuth 或 QStash 密钥写进该文件。

## 3. 发布后的快速验证

在 Codex 里让任意 Skill 调用 `reliable_drive_sync.submit_event`。返回以下结果表示 Worker 已接受事件：

```json
{ "accepted": true, "deliveryState": "cloud_accepted" }
```

随后在 Drive 中检查：

```text
事件父文件夹/<sourceSkill>/<userId>/event-*.json
快照父文件夹/<sourceSkill>/<userId>/snapshot-*.json
```

若返回 `pending`，事件仍安全留在本机 Outbox；重启 Codex 或下一次提交事件时会自动补发。
