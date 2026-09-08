# T00 设备绑定控制库证据

更新时间：2026-09-09

实现分支：`feat/unified-submit-event-device-binding`
基线：`4f810094b65d0e9c6fc2d719aa97ddb2becaa7c2`

## 范围

T00 只建立机器本地 `control.sqlite` 的协调层。当前实现只创建
`device_binding` 表，保存 installation、binding epoch/revision、userId 和
credential 引用；不保存业务事件、画像正文、Bearer 明文、DPAPI 明文或网络
回执。网络请求必须发生在事务之外。

公开接口：

```text
openDeviceStore({path}) -> { current(), exclusive(fn), close() }
```

`exclusive` 只接受同步回调：`BEGIN IMMEDIATE` → 回调 → `COMMIT`；任意异常
均 `ROLLBACK`。返回 Promise 的回调返回 `async_in_device_lock`，锁忙在明确的
5 秒等待后返回 `device_busy`。

## 可复现实测

环境：Windows、Node `v26.7.0`、SQLite `node:sqlite`。Node 22 便携运行时在
当前执行环境不可用，不能冒充双版本证据。

命令：

```text
node --test tools/reliable-drive-sync-mcp/test/device-store.test.mjs
```

结果：**6/6 通过**。

覆盖内容：

1. 首次打开只创建独立控制库，绑定记录可在关闭/重新打开后读取；
2. Promise 回调被拒绝并回滚；
3. 同步回调异常不留下半写入行；
4. 两个真实 Node 子进程不能同时进入临界区；
5. 终止持锁进程后，SQLite 由操作系统释放锁，后续进程可立即取得；
6. 启动器从相对工作目录打开控制库时，路径解析与父目录创建稳定。

完整工具回归：

```text
node --test tools/reliable-drive-sync-mcp/test/*.test.mjs
```

结果：**82/82 通过**（包含既有 V2 工具与本任务新增 5 例）。

## 安全证据边界

已证明：

- 锁不是带到期时间的文件锁，活跃进程不会被另一个进程夺取；
- 进程被终止时 SQLite 文件锁由操作系统释放；
- 事务失败不产生半条绑定；
- 测试输出只包含状态码和测试结果，不打印任何合成秘密；
- 控制库 schema 不包含业务正文或明文凭据字段。

尚未证明、因此 **G0 不通过且不得进入 T01**：

- 两个不同 Windows 登录用户的文件 ACL/目录隔离；
- 真实安全输入窗口/私有管道与 DPAPI 往返（T05 才实现安全存储与输入界面）；
- 从正式便携启动器到默认路径的完整链路（当前仅证明控制库 API 的相对路径行为）；
- Node `22.22.2` 的同一套回归（当前机器未提供该可执行文件）。

## G0 解锁所需的人工证据

在两台独立 Windows 登录账户下分别运行同一探针，记录账户 SID、解析后的
控制库绝对路径和 ACL 摘要；不得记录凭据内容。再由 T05 提供私有输入窗口与
DPAPI 加密/解密测试，证明秘密不经过 MCP 参数、模型上下文、stdout、日志或
截图。完成这些证据并获得 `R2-T00-PRE`/`R2-T00-POST` 审核通过后，才能开始
T01。
