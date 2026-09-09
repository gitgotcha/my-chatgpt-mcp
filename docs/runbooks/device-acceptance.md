# Device binding acceptance evidence

T09 的自动证据覆盖：Worker 账户入口关闭时零业务写、账户入口预算不超过 20、真实 Node 子进程对设备控制库的互斥与释放。命令：

```text
node --test services/reliable-drive-sync-worker/test/device-acceptance.test.js
node --test tools/reliable-drive-sync-mcp/test/device-multiprocess.test.mjs
```

当前自动证据不等同于 Windows 多用户 ACL 或真实 DPAPI 人工确认。发布前必须在两个独立 Windows 登录用户下完成安全界面解密隔离、重启复用和取消无副作用的人工记录；未完成时保持账户公开注册关闭。

