# RDS2 Interview Parity Evidence

## Scope

本文件冻结 T12 的 V2 纯 reducer 与 V1 `src/profile-model.js` 的语义边界。V2
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

每页只声明 `session` 与 `review` 的去重键；不把历史 reviews 塞进
`continuation_json`。`buildPage` 在 staged contribution paginator 接线前以稳定
错误拒绝，避免把不完整的贡献集发布为成功画像。

## 测试证据

`test/rds2-interview.test.js` 覆盖 7 个独立场景：apply 开关、版本替换、迟到旧
版本、同版本排序、重复 variant、空变更撤销、有限读计划。完整分代分页与真实
D1 接线由后续集成门负责，当前不宣称已完成。

