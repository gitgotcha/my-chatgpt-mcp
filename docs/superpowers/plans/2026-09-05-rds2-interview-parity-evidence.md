# RDS2 Interview Parity Evidence

## Scope

本文件冻结 T12 的 V2 reducer 与 V1 `src/profile-model.js` 的语义边界。T12
本地分页实现已交付，真实远程消费者仍需后续入口门验证。V2
不读取不存在的 `status` 字段；能力状态只来自 `profileChanges` 的
`status/result/outcome/action` 规范化结果。

## Oracle 映射

| V1 规则 | V2 证据/接口 |
| --- | --- |
| `applyProfileChanges !== true` 不贡献能力 | `reduceInterviewProfile` 复用 `rebuildInterviewProfile` |
| 同 `sessionId` 只保留最高 `reviewVersion` | `latestBySession` 选择器 |
| 同版本按 `completedAt,eventId` 稳定排序 | `compareEvents` |
| passing 需两个 session 且两个 variant | `passingSessionIds` 与 `passingVariantIds` 双集合 |
| 新版本替换旧版本贡献 | 旧 review 不进入 `approved` fold |
| 空 `profileChanges` 撤销旧贡献 | 被选中的新版本不产生 weakness 行 |
| evidenceRefs/confidence/title 逐字段保留 | `changeEvidence`、`evidenceConfidence`、`title` |

## V2 读计划

每页声明 `session`、`review` 以及按需的 `selected_review`/`contribution` 键；
`buildPage` 会把选择结果和贡献行写入 staging，并在分页 continuation 中保留
当前折叠状态。当前实现仍以受控页大小和 continuation 行大小门保护，未把完整
远程重算规模宣称为已验证。

## 测试证据

`test/rds2-interview.test.js` 覆盖 9 个独立场景：apply 开关、版本替换、迟到旧
版本、同版本排序、重复 variant、空变更撤销、有限读计划和两项 `buildPage`
跨页行为。完整分代分页的真实 D1/Queue 接线和大规模行大小证明由 T14/T16
集成门负责。
