# RDS2 本地发布就绪记录（2026-09-08）

## 已完成

- G2 已关闭；T09、T10、T11、T12、T13 已有独立实现提交。
- T14 预算/故障证明文档已入库：`2026-09-05-rds2-budget-proof.md`。
- T15 技能契约矩阵与护栏测试已入库：`2026-09-05-rds2-skill-contract-matrix.md`。
- T11–T13 parity 文档已更新为“本地实现已交付，远程/大规模门仍待验证”，并明确当前 continuation 的状态大小边界。
- T16 本地配置、Queue/DLQ 声明、V2 开关与 canary/runbook 测试已通过。

## 回归证据

| 运行时 | Worker | Bridge | 命令结果 |
|---|---:|---:|---|
| Node v26.7.0 | 691/691 | 75/75 | 退出码 0 |
| Node v22.22.2 | 691/691 | 75/75 | 退出码 0 |

定向 T11–T16 套件：Node 26 **71/71**、Node 22 **71/71**。其中包含三域分页、staging 读预算、T14 故障分类、T15 源技能契约和 T16 发布门。

## 打包门

本地执行 `npx wrangler@latest deploy --dry-run --config services/reliable-drive-sync-worker/wrangler.toml --outdir .rds2-dry-run` 成功：

- 总上传 312.03 KiB，gzip 63.58 KiB；
- 识别两个 V2 producer（projection/archive）与四个单消息 consumer（含两个 DLQ）；
- 五个 V2 开关默认均为 `false`，白名单为空；
- dry-run 产物仅包含生成说明文件，已删除，不进入提交。

## 仍未执行的动作

以下动作必须单独取得乔的明确确认后才可执行：

1. `git push` 到远程仓库；
2. 创建或修改 Cloudflare Queue/DLQ；
3. 应用远程 D1 migration；
4. 部署 Worker 或启用任一 V2 开关；
5. 运行 `rds2-canary.mjs --remote`、切换本地 MCP 到 V2；
6. 关闭 V1/QStash 路径或恢复每日算法定时任务。

在这些动作获批前，当前状态是“本地代码与测试就绪、远程资源保持不变”。

## 提交锚点

```text
e6b1a81  docs(rds2): record t14 budget and fault proofs
74b31b4  test(rds2): align t15 skill contract guards
c29fc10  docs(rds2): update t11-t13 parity status
214f177  feat(rds2): t13 resume knowledge paged projection
0bd8d1f  feat(rds2): t12 interview paged projection
bf5ef0b  feat(rds2): t11 generic profile paged projection
```

工作树除既有未跟踪审核文档外保持干净；本记录不包含凭据、真实用户数据或远程回执。
