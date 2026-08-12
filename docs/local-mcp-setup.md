# 本机 MCP 配置

`reliable_drive_sync` 已注册为 Codex 的本机 MCP Server。算法 Skill 将通过它调用 `submit_event`；事件先写入本机 SQLite，再异步进入 Cloudflare。

## 当前电脑

已安装的无密钥启动器：

- `C:\Users\27846\.codex\mcp\reliable-drive-sync.cmd`
- `C:\Users\27846\.codex\config.toml` 中的 `mcp_servers.reliable_drive_sync`

启动器从 Windows 用户环境变量读取配置，因此 `config.toml` 不保存 ingress Secret。

## 新电脑迁移

在安装 Node.js 与构建项目后，以当前 Windows 用户运行以下命令。将第二行中的值替换为 Cloudflare Worker 的 `INGRESS_SHARED_SECRET`；不要把该值提交到 Git 或粘贴到普通文档。

```powershell
setx RELIABLE_DRIVE_SYNC_INGRESS_URL "https://reliable-drive-sync.qiaobingyuan886.workers.dev/v1/jobs"
setx RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET "在此输入与 Worker 完全相同的 Secret"
setx RELIABLE_DRIVE_SYNC_OUTBOX_PATH "$env:LOCALAPPDATA\ReliableDriveSync\outbox.sqlite"
setx RELIABLE_DRIVE_SYNC_NODE_PATH "C:\Program Files\nodejs\node.exe"
```

复制本机启动器到相同位置；若项目目录不同，只修改启动器中 `index.js` 的绝对路径。随后完全退出并重新启动 Codex，使它重新加载 MCP Server 和用户环境变量。

## 运行语义

- `cloud_accepted`：Worker 已把事件写入 D1；Drive 仍由后台完成。
- `pending`：事件已保留在本机 Outbox，后续 Skill 提交或 Codex SessionStart 会自动补发。
- `synced`：仅 D1 状态显示为 `synced` 时，才代表 Drive 事件和快照都已完成读回验证。
