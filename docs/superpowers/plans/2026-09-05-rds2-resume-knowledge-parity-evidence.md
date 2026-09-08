# RDS2 Resume-Knowledge Parity Evidence

## Scope

T13 本地分页实现复用 `src/resume-knowledge-model.js` 作为业务 Oracle，V2 增加
服务端业务去重键和题目/掌握点读计划；真实远程消费者与全量规模门仍待 T14/T16。

## Oracle 映射

| V1 规则 | V2 证据/接口 |
| --- | --- |
| 同用户、同题、同自然日只取最早评分 | `firstScorePerDay` |
| 后续自然日按 `0.6 * new + 0.4 * previous` | `updateMastery` |
| `feedback.issues/issueCategories` 原样进入 recentIssues | `rebuildResumeKnowledgeProfile` |
| 未测试题保持 `untested`，不填 0 分 | `knowledgePointStats` |
| 缺题库不可出题 | `reduceResumeKnowledgeProfile` 返回 `resume_required` |
| 旧题库不得覆盖当前版本 | `questionBank.resumeVersion` 由调用方绑定 |

## 服务端业务键

`businessDedupeKey(event)` 对以下数组做 canonical JSON：

```text
[userId, eventType, questionKey, localDate]
```

该键不是客户端可覆盖字段；客户端 eventKey 仍保留用于审计和幂等追踪。

## V2 读计划

每页按去重后的 `questionKey` 声明 `question`、`mastery`、`first_score` 与
`question_bank` 行读取；`buildPage` 将题库、首评和 mastery 变化写入 staging。
当前 continuation 仍携带折叠所需的题库/评分状态，长度与远程 build 的上界需由
T14 的状态大小门持续约束；不静默截断，也不宣称已完成生产规模证明。

## 测试证据

`test/rds2-resume-knowledge.test.js` 覆盖首评/次日加权、业务键、untested、
`resume_required`、版本绑定、分页 `buildPage` 与有界读计划。
